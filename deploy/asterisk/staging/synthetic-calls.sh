#!/usr/bin/env bash
# Staging server, stage 3: start N synthetic calls into Mujeeb at the same moment (run as root).
# Each call is a Local channel into [synthetic-in] (reachable from the Asterisk CLI only, never from SIP) answered by
# a [synthetic-caller] that says a short phrase, pauses and repeats: turns, barge-ins and concurrency without a phone
# or the carrier. Fake providers only (checked): with real providers every call costs money.
# What it does not prove: real STT accuracy, or the load of real provider connections (plan 3-ز).
#
#   synthetic-calls.sh <calls> <seconds> <pause> [did ...]
#     calls    how many calls to start at once
#     seconds  how long each caller keeps talking
#     pause    seconds of silence after each phrase, 1-10 (shorter than Mujeeb's reply = barge-ins)
#     did      route keys to dial, used in turn (default 990300, the simulation route in routes.example.json)
#
# Example: sudo bash synthetic-calls.sh 5 180 4
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../staging/lib.sh
. "$HERE/../../staging/lib.sh"
if [ $# -lt 3 ]; then
  sed -n '2,14p' "$0"
  exit 2
fi
CALLS="$1" SECONDS_EACH="$2" PAUSE="$3"
shift 3
for n in "$CALLS" "$SECONDS_EACH" "$PAUSE"; do [[ $n =~ ^[0-9]+$ ]] || die "calls, seconds and pause are whole numbers"; done
[ "$PAUSE" -ge 1 ] && [ "$PAUSE" -le 10 ] || die "pause must be 1-10 (Asterisk's silence prompts)"
DIDS=("${@:-990300}")
for did in "${DIDS[@]}"; do [[ $did =~ ^[0-9]+$ ]] || die "route key '$did': digits only ([synthetic-in] matches _X.)"; done
require_root
require_fake_providers
for i in $(seq 0 $((CALLS - 1))); do
  did="${DIDS[$((i % ${#DIDS[@]}))]}"
  asterisk -rx "channel originate Local/${did}@synthetic-in extension talk-${SECONDS_EACH}-${PAUSE}@synthetic-caller" &
done
wait
say "started ${CALLS} synthetic call(s): ${SECONDS_EACH}s each, ${PAUSE}s pauses, route keys ${DIDS[*]}"
