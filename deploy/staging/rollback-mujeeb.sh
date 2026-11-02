#!/usr/bin/env bash
# Staging server: go back to the previous release of Mujeeb (run as root). Same guard and watch as deploy-mujeeb.sh.
#
#   rollback-mujeeb.sh [--force]
#     --force  go on while calls are up, or when that cannot be told
#
# The previous release is /opt/mujeeb/previous (set by each successful deploy). After a successful rollback the two
# swap, so running it again goes forward. If the previous release fails its watch, the current one is put back.
# Without a previous release it changes nothing.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
FORCE=0
case "${1:-}" in
  "") ;;
  --force) FORCE=1 ;;
  *) sed -n '2,5p' "$0"; exit 2 ;;
esac
require_root
TARGET="$(readlink -e "$PREVIOUS" 2>/dev/null || true)"
CUR="$(readlink -e "$CURRENT" 2>/dev/null || true)"
[ -n "$TARGET" ] && [ -f "$TARGET/.complete" ] || die "no previous release to go back to: nothing changed"
[ "$TARGET" != "$CUR" ] || die "the previous release is the current one: nothing changed"
take_lock
guard_no_calls "$FORCE"
switch_to "$TARGET"
say "rolling back from $(revision_of "$CUR") to $(revision_of "$TARGET")"
if restart_and_watch; then
  ln -sfn "$CUR" "$PREVIOUS"
  say "ROLLBACK_OK: running $(revision_of "$TARGET") (previous: $(revision_of "$CUR"))"
  exit 0
fi
say "$(revision_of "$TARGET") failed its watch: putting $(revision_of "$CUR") back"
switch_to "$CUR"
if restart_and_watch; then die "rollback failed; $(revision_of "$CUR") is running again"; fi
systemctl stop "$SERVICE" || true
die "rollback failed and $(revision_of "$CUR") did not start again: $SERVICE is stopped (callers hear the apology)"
