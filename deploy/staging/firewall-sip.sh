#!/usr/bin/env bash
# Staging server, stage 5: allow SIP and RTP from ExaCall's addresses only (run as root).
# Reads TRUNK_SIGNALING_IPS, TRUNK_MEDIA_IPS, TRUNK_TRANSPORT, SIP_PORT, RTP_START and RTP_END from host.env.
# The rules live in their own chain, MUJEEB-SIP, jumped to from INPUT just above its first REJECT rule (a rule after
# it never matches). That REJECT is what keeps everything else closed: Oracle's images ship it, bootstrap-host.sh adds
# it where they do not, and this script refuses to run without it. Empty address lists give an empty chain.
# The provider's firewall (the OCI network security group, or Skyline's portal Firewall) must allow the same
# addresses: this script can neither see nor change it.
#
#   firewall-sip.sh [--env FILE] [--check]
#     --check  change nothing: compare the live rules with host.env and exit 1 on any difference
#              (trunk-check.sh, layer 2)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
ENV_FILE=/etc/mujeeb/asterisk-host.env
CHECK=0
while [ $# -gt 0 ]; do
  case "$1" in
    --env) [ $# -ge 2 ] || die "--env needs a file"; ENV_FILE="$2"; shift 2 ;;
    --check) CHECK=1; shift ;;
    *) sed -n '2,11p' "$0"; exit 2 ;;
  esac
done
require_root
[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE"
# shellcheck source=../asterisk/staging/host.env.example
. "$ENV_FILE"
SIP_PORT="${SIP_PORT:-5060}" RTP_START="${RTP_START:-10000}" RTP_END="${RTP_END:-10199}" TRUNK_TRANSPORT="${TRUNK_TRANSPORT:-udp}"
CHAIN=MUJEEB-SIP
list() { printf '%s' "$1" | tr ',' '\n' | sed 's/[[:space:]]//g' | grep -v '^$' || true; }
cidr() { case "$1" in */*) echo "$1" ;; *) echo "$1/32" ;; esac; }

# The chain's rules exactly as `iptables -S` prints them.
expected() {
  local ip
  for ip in $(list "${TRUNK_SIGNALING_IPS:-}"); do
    echo "-A $CHAIN -s $(cidr "$ip") -p udp -m udp --dport $SIP_PORT -j ACCEPT"
    if [ "$TRUNK_TRANSPORT" = tcp ]; then echo "-A $CHAIN -s $(cidr "$ip") -p tcp -m tcp --dport $SIP_PORT -j ACCEPT"; fi
  done
  for ip in $(list "${TRUNK_MEDIA_IPS:-}"); do
    echo "-A $CHAIN -s $(cidr "$ip") -p udp -m udp --dport $RTP_START:$RTP_END -j ACCEPT"
  done
}
# Line numbers of the jump to our chain and of the first REJECT in INPUT (0 when absent).
positions() {
  iptables -L INPUT --line-numbers -n | awk -v c="$CHAIN" '
    $2 == c && !j { j = $1 } $2 == "REJECT" && !r { r = $1 } END { print (j ? j : 0), (r ? r : 0) }'
}

if [ "$CHECK" = 1 ]; then
  ok=1
  if ! iptables -S "$CHAIN" >/dev/null 2>&1; then
    echo "MISSING: chain $CHAIN (run firewall-sip.sh)"
    ok=0
  else
    diff <(expected | sort) <(iptables -S "$CHAIN" | grep '^-A' | sort) >/dev/null || {
      echo "DIFFERENT: $CHAIN does not match $ENV_FILE"
      diff <(expected | sort) <(iptables -S "$CHAIN" | grep '^-A' | sort) | sed 's/^/  /' || true
      ok=0
    }
    read -r jump reject < <(positions)
    if [ "$jump" = 0 ]; then echo "MISSING: INPUT does not jump to $CHAIN"; ok=0
    elif [ "$reject" != 0 ] && [ "$jump" -gt "$reject" ]; then echo "WRONG ORDER: the jump to $CHAIN is below REJECT"; ok=0; fi
  fi
  read -r _ reject < <(positions)
  if [ "$reject" = 0 ]; then echo "MISSING: INPUT has no REJECT, so it accepts everything (run bootstrap-host.sh)"; ok=0; fi
  # Nothing else may open the SIP port or the RTP range to any source.
  if iptables -S INPUT | grep -E -- "--dport ($SIP_PORT|$RTP_START:$RTP_END)( |$)" | has -v -- ' -s '; then
    echo "OPEN: an INPUT rule accepts SIP or RTP from any address"
    ok=0
  fi
  if [ "$ok" = 1 ]; then echo "FIREWALL_OK ($(expected | grep -c . || true) rule(s) in $CHAIN)"; exit 0; fi
  exit 1
fi

read -r _ reject < <(positions)
[ "$reject" != 0 ] || die "INPUT has no REJECT rule, so it accepts everything: run bootstrap-host.sh first"
iptables -N "$CHAIN" 2>/dev/null || true
iptables -F "$CHAIN"
while IFS= read -r rule; do
  read -ra args <<< "$rule"
  iptables "${args[@]}"
done < <(expected)
read -r jump reject < <(positions)
if [ "$jump" != 0 ] && [ "$reject" != 0 ] && [ "$jump" -gt "$reject" ]; then
  iptables -D INPUT -j "$CHAIN"
  jump=0
  read -r _ reject < <(positions)
fi
if [ "$jump" = 0 ]; then
  if [ "$reject" != 0 ]; then iptables -I INPUT "$reject" -j "$CHAIN"; else iptables -A INPUT -j "$CHAIN"; fi
fi
if command -v netfilter-persistent >/dev/null; then
  netfilter-persistent save >/dev/null
else
  iptables-save > /etc/iptables/rules.v4
fi
say "firewall: $(expected | grep -c . || true) rule(s) in $CHAIN, saved. Check: firewall-sip.sh --check"
