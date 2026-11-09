#!/usr/bin/env bash
# Staging server: look for caller numbers, ID-like numbers and transcripts everywhere a log or a file can keep them.
# Prints a count per place and pattern, never a value. Exit 1 when anything is found or a place cannot be read.
# Run it after every stage that places calls (plan 3-هـ); stage 3 proves it with a planted leak first.
#
#   privacy-scan.sh [--since "YYYY-MM-DD HH:MM:SS"] [--root DIR] [--journal-file FILE]
#     --since         journal window (default: everything the journal keeps)
#     --root DIR      prefix for every path: a fixture tree instead of / (tests)
#     --journal-file  scan this file instead of journalctl (tests, or a saved export)
#
# Places:
# - the journal of asterisk, mujeeb-telephony and mujeeb-healthcheck: stdout and stderr both;
# - Asterisk's log directory, rotated .gz files included (its CDR/CEL subdirectories must hold no file at all);
# - Mujeeb's turn logs;
# - /var/log/syslog* and /var/log/messages*, in case something writes there despite ForwardToSyslog=no;
# - Asterisk's recording, call-file and voicemail directories, which must hold no file at all.
# Patterns:
# - mobile: a Saudi mobile in any common form (+9665…, 009665…, 9665…, 05…). Masked numbers (•••••••567) do not match;
# - id_like: ten digits starting with 1 or 2 (national ID / iqama form). Digits next to a dot are excluded, so
#   Asterisk call IDs such as 1762070000.12 do not match. So are epoch seconds after "UTC (": the kernel writes
#   "rtc-efi: setting system clock to ... UTC (1794...)" to syslog at every boot. Any other hit is looked at by hand;
# - transcript: the user_text, assistant_text or text fields of Mujeeb's logs (text_chars does not match).
set -euo pipefail
export LC_ALL=C.UTF-8
SINCE="" ROOT="" JOURNAL_FILE=""
while [ $# -gt 0 ]; do
  [ $# -ge 2 ] || { sed -n '2,23p' "$0"; exit 2; }
  case "$1" in
    --since) SINCE="$2" ;;
    --root) ROOT="${2%/}" ;;
    --journal-file) JOURNAL_FILE="$2" ;;
    *) sed -n '2,23p' "$0"; exit 2 ;;
  esac
  shift 2
done
PAT_MOBILE='(?<![0-9])(?:\+966|00966|966|0)5[0-9]{8}(?![0-9])'
PAT_ID='(?<![0-9.])(?<!UTC \()[12][0-9]{9}(?![0-9.])'
PAT_TEXT='"(?:user_text|assistant_text|text)"\s*:'
TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT
found=0

count() { grep -cP -- "$1" "$TMP" || true; } # grep -c prints 0 (exit 1) when nothing matches
report() { # place
  local mobile id_like transcript
  mobile="$(count "$PAT_MOBILE")" id_like="$(count "$PAT_ID")" transcript="$(count "$PAT_TEXT")"
  printf '%-44s mobile=%-4s id_like=%-4s transcript=%s\n' "$1" "$mobile" "$id_like" "$transcript"
  if [ "$mobile$id_like$transcript" != 000 ]; then found=1; fi
}
# Every regular file under a directory (or matching a name pattern in it) into $TMP, .gz files decompressed.
collect() { # dir [name pattern]
  : > "$TMP"
  [ -d "$1" ] || return 0
  local file
  while IFS= read -r -d '' file; do
    case "$file" in
      *.gz) gzip -dc -- "$file" >> "$TMP" 2>/dev/null || { echo "UNREADABLE: $file"; found=1; } ;;
      *) cat -- "$file" >> "$TMP" 2>/dev/null || { echo "UNREADABLE: $file"; found=1; } ;;
    esac
  done < <(if [ -n "${2:-}" ]; then find "$1" -maxdepth 1 -type f -name "$2" -print0; else find "$1" -type f -print0; fi)
}
no_files() { # place, dirs...
  local place="$1" n=0 dir
  shift
  for dir in "$@"; do
    if [ -d "$dir" ]; then n=$((n + $(find "$dir" -type f | wc -l))); fi
  done
  printf '%-44s files=%s\n' "$place" "$n"
  if [ "$n" != 0 ]; then found=1; fi
}

# The journal: both streams of the three units.
if [ -n "$JOURNAL_FILE" ]; then
  cat -- "$JOURNAL_FILE" > "$TMP" || { echo "UNREADABLE: $JOURNAL_FILE"; exit 1; }
elif command -v journalctl >/dev/null; then
  journalctl -u asterisk -u mujeeb-telephony -u mujeeb-healthcheck ${SINCE:+--since "$SINCE"} -o cat --no-pager > "$TMP" \
    || { echo "UNREADABLE: the journal"; exit 1; }
else
  echo "UNREADABLE: no journalctl here (use --journal-file)"
  exit 1
fi
report "journal (asterisk, mujeeb-telephony, healthcheck)"

AST_LOG="$ROOT/var/log/asterisk"
: > "$TMP"
if [ -d "$AST_LOG" ]; then
  while IFS= read -r -d '' file; do
    case "$file" in
      *.gz) gzip -dc -- "$file" >> "$TMP" 2>/dev/null || { echo "UNREADABLE: $file"; found=1; } ;;
      *) cat -- "$file" >> "$TMP" 2>/dev/null || { echo "UNREADABLE: $file"; found=1; } ;;
    esac
  done < <(find "$AST_LOG" -type f -not -path "*/cdr-*" -not -path "*/cel-*" -print0)
fi
report "$AST_LOG (CDR/CEL folders: below)"
collect "$ROOT/var/lib/mujeeb/logs"
report "$ROOT/var/lib/mujeeb/logs"
collect "$ROOT/var/log" 'syslog*'
report "$ROOT/var/log/syslog*"
collect "$ROOT/var/log" 'messages*'
report "$ROOT/var/log/messages*"
no_files "recordings, call files, voicemail" "$ROOT/var/spool/asterisk/monitor" "$ROOT/var/spool/asterisk/recording" \
  "$ROOT/var/spool/asterisk/outgoing" "$ROOT/var/spool/asterisk/voicemail"
no_files "CDR / CEL files" "$AST_LOG/cdr-csv" "$AST_LOG/cdr-custom" "$AST_LOG/cel-custom"

if [ "$found" = 1 ]; then
  echo "PRIVACY_SCAN_FOUND: see the counts above (values are not printed; find them with grep -P on the place named)"
  exit 1
fi
echo "PRIVACY_SCAN_OK"
