#!/usr/bin/env bash
# Staging server, stage 3: inbound "carrier" calls into Asterisk with SIPp, from this host (sipp/inbound-call.xml).
# With TRUNK_ENABLED=yes and TRUNK_SIGNALING_IPS=127.0.0.1 in host.env, a call from 127.0.0.1 is identified as the
# trunk. One from --from 127.0.0.2 is not: res_pjsip then logs a NOTICE with the whole From header, which the privacy
# test needs (it must reach remote consoles only, never the journal or a file). Fake providers only (checked).
#
#   simulate-trunk-call.sh [--did D] [--to-user U] [--caller N] [--codec alaw|ulaw|g722] [--calls N] [--from IP]
#                          [--env FILE]
#     --did      Request-URI user, the DID (default 990300, the simulation route in routes.example.json)
#     --to-user  To header user (default: the DID). Differs from --did to test DID_SOURCE=to.
#     --caller   From user: a synthetic number in mobile form (default 0555000123), never a real one
#     --codec    the one codec offered (default alaw)
#     --calls    calls started at once (default 1), each held 20 s unless Asterisk hangs up first
#     --from     local address SIPp sends from (default 127.0.0.1)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../staging/lib.sh
. "$HERE/../../staging/lib.sh"
ENV_FILE=/etc/mujeeb/asterisk-host.env
DID=990300 TO_USER="" CALLER=0555000123 CODEC=alaw CALLS=1 FROM=127.0.0.1
usage() { sed -n '2,15p' "$0"; exit 2; }
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || usage
  case "$1" in
    --did) DID="$2" ;;
    --to-user) TO_USER="$2" ;;
    --caller) CALLER="$2" ;;
    --codec) CODEC="$2" ;;
    --calls) CALLS="$2" ;;
    --from) FROM="$2" ;;
    --env) ENV_FILE="$2" ;;
    *) usage ;;
  esac
  shift 2
done
TO_USER="${TO_USER:-$DID}"
case "$CODEC" in
  alaw) PAYLOAD=8 NAME=PCMA ;;
  ulaw) PAYLOAD=0 NAME=PCMU ;;
  g722) PAYLOAD=9 NAME=G722 ;;
  *) die "--codec must be alaw, ulaw or g722" ;;
esac
for value in "$DID" "$TO_USER" "$CALLER"; do [[ $value =~ ^[A-Za-z0-9+]+$ ]] || die "SIP user parts: letters, digits and + only"; done
[[ $CALLS =~ ^[0-9]+$ ]] && [ "$CALLS" -ge 1 ] || die "--calls must be a positive number"
[[ $FROM =~ ^127\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || die "--from must be a loopback address: simulations stay on this host"
command -v sipp >/dev/null || die "sipp is not installed (bootstrap-host.sh installs sip-tester)"
require_fake_providers
SIP_PORT=5060
if [ -r "$ENV_FILE" ]; then SIP_PORT="$(sed -n 's/^SIP_PORT=//p' "$ENV_FILE" | tail -1 | tr -d '\r')"; SIP_PORT="${SIP_PORT:-5060}"; fi

say "SIPp: $CALLS call(s) from $FROM, DID $DID, To $TO_USER, codec $CODEC (the caller number is synthetic)"
sipp "127.0.0.1:$SIP_PORT" -sf "$HERE/sipp/inbound-call.xml" -i "$FROM" -mi "$FROM" \
  -s "$DID" -key to_user "$TO_USER" -key caller "$CALLER" -key payload "$PAYLOAD" -key codec "$NAME" \
  -m "$CALLS" -l "$CALLS" -r "$CALLS" -rp 1000 -timeout 60s -nostdin -trace_err \
  -error_file "$(mktemp -t sipp-errors.XXXXXX)"
