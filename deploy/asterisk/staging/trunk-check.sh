#!/usr/bin/env bash
# Staging server, stage 5: is the ExaCall trunk ready? Layers 1-3 here. Layer 4, the gate, is a real call.
# Not part of the periodic health check: the trunk's details may not exist yet, and some carriers never answer OPTIONS.
#
#   trunk-check.sh [--env FILE]
#
# 1. Asterisk loaded it: endpoint exacall, identify addresses = TRUNK_SIGNALING_IPS, the from-trunk dialplan.
# 2. The host firewall matches host.env exactly (firewall-sip.sh --check). The OCI security group cannot be seen from
#    here: compare it by hand in the console.
# 3. Signaling out: "Registered" for TRUNK_AUTH=registration; "Avail" only when TRUNK_QUALIFY=yes (a carrier that
#    ignores OPTIONS shows Unavailable while calls work, so it is skipped by default). Neither proves inbound calls.
# 4. Not here: a call from a phone to the DID in echo mode (README, stage 5). Only that proves routing, identification,
#    the firewall, NAT and audio together.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../staging/lib.sh
. "$HERE/../../staging/lib.sh"
ENV_FILE=/etc/mujeeb/asterisk-host.env
if [ "${1:-}" = --env ] && [ -n "${2:-}" ]; then ENV_FILE="$2"; fi
require_root
[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE"
# shellcheck source=host.env.example
. "$ENV_FILE"
[ "${TRUNK_ENABLED:-no}" = yes ] || die "TRUNK_ENABLED is not yes in $ENV_FILE: no trunk to check"
asterisk -rx 'core show version' >/dev/null 2>&1 || die "Asterisk does not answer"
result=0
layer() { printf '%-34s %s\n' "$1" "$2"; if [ "$2" = FAIL ]; then result=1; fi; }
list() { printf '%s' "$1" | tr ',' '\n' | sed 's/[[:space:]]//g' | grep -v '^$' || true; }
cidr() { case "$1" in */*) echo "$1" ;; *) echo "$1/32" ;; esac; }

# 1. Loaded
loaded=PASS
asterisk -rx 'pjsip show endpoint exacall' | has -E 'Endpoint: +exacall' || { echo "  no endpoint exacall"; loaded=FAIL; }
asterisk -rx 'dialplan show from-trunk' | has "Context 'from-trunk'" || { echo "  no from-trunk dialplan"; loaded=FAIL; }
want="$(for ip in $(list "${TRUNK_SIGNALING_IPS:-}"); do cidr "$ip"; done | sort)"
have="$(asterisk -rx 'pjsip show identifies' | sed -n 's/^ *Match: *\([0-9./]*\).*$/\1/p' | sort)"
[ "$want" = "$have" ] || { echo "  identify addresses differ from TRUNK_SIGNALING_IPS: want [$(tr '\n' ' ' <<< "$want")] have [$(tr '\n' ' ' <<< "$have")]"; loaded=FAIL; }
layer "1. loaded in Asterisk" "$loaded"

# 2. Firewall
if bash "$HERE/../../staging/firewall-sip.sh" --env "$ENV_FILE" --check | sed 's/^/  /'; then layer "2. host firewall" PASS; else layer "2. host firewall" FAIL; fi
echo "  (the OCI network security group: compare it with host.env by hand)"

# 3. Signaling out
if [ "${TRUNK_AUTH:-ip}" = registration ]; then
  if asterisk -rx 'pjsip show registrations' | has 'exacall-registration.*Registered'; then layer "3. registration" PASS; else layer "3. registration" FAIL; fi
else
  layer "3. registration" "SKIP (ip trunk)"
fi
if [ "${TRUNK_QUALIFY:-no}" = yes ]; then
  if asterisk -rx 'pjsip show contacts' | has -E 'exacall/.*Avail'; then layer "3. OPTIONS (qualify)" PASS; else layer "3. OPTIONS (qualify)" FAIL; fi
else
  layer "3. OPTIONS (qualify)" "SKIP (TRUNK_QUALIFY=no)"
fi

echo
echo "4. The gate: call the DID from a phone with INBOUND_MODE=echo (README, stage 5). During the call:"
echo "     asterisk -rx 'core show channels verbose'    (the PJSIP/exacall channel and its codec)"
echo "     asterisk -rx 'pjsip show channelstats'       (RTP packets both ways, loss)"
exit "$result"
