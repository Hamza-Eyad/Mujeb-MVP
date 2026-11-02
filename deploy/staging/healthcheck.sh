#!/usr/bin/env bash
# Staging server health, every 5 minutes (mujeeb-healthcheck.timer, as root). The server only: no carrier check here
# (trunk-check.sh, run by hand, covers ExaCall: its details may not exist yet, and some carriers ignore OPTIONS).
# Prints one JSON line, which the journal keeps, and exits 1 when any check fails.
#
# Checks: both services active; the gateway listens on 127.0.0.1 only; no AMI/HTTP/ARI port; disk below 80%; at least
# 10% memory available; and the quick privacy invariants: transcripts off, Asterisk's stdout to /dev/null, no
# recording, no CDR/CEL file or module. The full scan is privacy-scan.sh.
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
checks=""
failed=""
check() { # name, then a command: true = pass
  local name="$1"
  shift
  if "$@" >/dev/null 2>&1; then checks="$checks\"$name\":true,"; else checks="$checks\"$name\":false,"; failed="$failed\"$name\","; fi
}
port="$(gateway_port)"
gateway_loopback_only() {
  local listeners
  listeners="$(ss -Hltn "( sport = :$port )" | awk '{print $4}')"
  [ -n "$listeners" ] && ! printf '%s\n' "$listeners" | has -v "^127\.0\.0\.1:$port$"
}
no_admin_ports() { [ -z "$(ss -Hltn '( sport = :5038 or sport = :8088 or sport = :8089 )')" ]; }
disk_ok() { [ "$(df -P / | awk 'NR == 2 { sub("%", "", $5); print $5 }')" -lt 80 ]; }
memory_ok() { awk '/^MemTotal:/ { t = $2 } /^MemAvailable:/ { a = $2 } END { exit !(a * 10 >= t) }' /proc/meminfo; }
transcripts_off() { [ "$(env_value MUJEEB_LOG_TRANSCRIPTS false)" = false ]; }
asterisk_stdout_null() { [ "$(systemctl show asterisk -p StandardOutput --value)" = null ]; }
no_files_in() { local dir; for dir in "$@"; do [ ! -d "$dir" ] || [ -z "$(find "$dir" -type f -print -quit)" ] || return 1; done; }
no_modules_like() { asterisk -rx "module show like $1" | has -E '^0 modules? loaded'; }

check asterisk_active systemctl is-active --quiet asterisk
check mujeeb_active systemctl is-active --quiet "$SERVICE"
check gateway_loopback_only gateway_loopback_only
check no_admin_ports no_admin_ports
check disk_below_80 disk_ok
check memory_10_percent memory_ok
check transcripts_off transcripts_off
check asterisk_stdout_null asterisk_stdout_null
check no_recordings no_files_in /var/spool/asterisk/monitor /var/spool/asterisk/recording /var/spool/asterisk/outgoing
check no_cdr_cel_files no_files_in /var/log/asterisk/cdr-csv /var/log/asterisk/cdr-custom /var/log/asterisk/cel-custom
check no_cdr_modules no_modules_like cdr_
check no_cel_modules no_modules_like cel_

restarts="$(systemctl show -p NRestarts --value "$SERVICE" 2>/dev/null || echo null)"
ok=true
if [ -n "$failed" ]; then ok=false; fi
printf '{"event":"staging.healthcheck","ok":%s,"mujeeb_restarts":%s,"failed":[%s],"checks":{%s}}\n' \
  "$ok" "${restarts:-null}" "${failed%,}" "${checks%,}"
[ "$ok" = true ]
