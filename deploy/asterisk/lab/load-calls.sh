#!/usr/bin/env bash
# Lab only: start N synthetic calls into Mujeeb at the same moment (run as root inside WSL).
# Each call is a [lab-caller] channel (setup-lab.sh) dialing a lab extension: it says a short phrase,
# pauses, and repeats, so turns, barge-ins and concurrency happen without a softphone.
#
#   load-calls.sh <calls> <seconds> <pause> [extension ...]
#     calls       how many calls to start at once
#     seconds     how long each caller keeps talking
#     pause       seconds of silence after each phrase, 1-10 (shorter than Mujeeb's reply = barge-ins)
#     extension   lab extensions to dial, used in turn (default 300). Example: 300 301 → 300, 301, 300, 301
#
# Example: sudo bash load-calls.sh 5 180 4            five calls to 300 for three minutes
#          sudo bash load-calls.sh 4 180 4 300 301    four calls, two per clinic (routes.two-clinics.json)
set -euo pipefail
if [ $# -lt 3 ]; then
  sed -n '2,13p' "$0"
  exit 2
fi
CALLS="$1" SECONDS_EACH="$2" PAUSE="$3"
shift 3
EXTENSIONS=("${@:-300}")
for i in $(seq 0 $((CALLS - 1))); do
  ext="${EXTENSIONS[$((i % ${#EXTENSIONS[@]}))]}"
  asterisk -rx "channel originate Local/${ext}@lab extension talk-${SECONDS_EACH}-${PAUSE}@lab-caller" &
done
wait
echo "started ${CALLS} call(s): ${SECONDS_EACH}s each, ${PAUSE}s pauses, extensions ${EXTENSIONS[*]}"
