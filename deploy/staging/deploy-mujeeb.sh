#!/usr/bin/env bash
# Staging server: deploy one commit of Mujeeb as the telephony gateway service (run as root).
#
#   deploy-mujeeb.sh <full commit sha> [--force] [--check]
#     --force  go on while calls are up (they are cut and the callers hear the apology), or when that cannot be told
#     --check  run `npm run check` on the server before switching (always done on the first deploy)
#
# 1. One deploy at a time (lock).
# 2. No live call: Asterisk channels and connections to the gateway, both. "Cannot tell" counts as "calls may be up".
# 3. Build in a new release directory: fetch exactly that commit, npm ci --ignore-scripts, build, prune dev
#    dependencies. A failed build changes nothing: no switch, no restart.
# 4. Switch /opt/mujeeb/current atomically and restart.
# 5. Watch: listening on 127.0.0.1 within 10 s, then 30 s with the same process, the config line, no error.
# 6. On failure: back to the previous release, restarted and watched the same way; exit 1 either way. Without a
#    previous release (or if that fails too), the service is stopped: callers hear Asterisk's apology.
# Keeps the current, the previous and the newest other release. The repository URL comes from
# /etc/mujeeb/deploy.env (bootstrap-host.sh); the commit must be on GitHub (pushed).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
usage() { sed -n '2,7p' "$0"; exit 2; }
SHA="${1:-}"
[ $# -ge 1 ] && shift
[[ $SHA =~ ^[0-9a-f]{40}$ ]] || usage
FORCE=0 CHECK=0
for arg in "$@"; do
  case "$arg" in --force) FORCE=1 ;; --check) CHECK=1 ;; *) usage ;; esac
done

require_root
[ -r "$DEPLOY_ENV" ] || die "missing $DEPLOY_ENV: run bootstrap-host.sh first"
MUJEEB_REPO_URL="$(sed -n 's/^MUJEEB_REPO_URL=//p' "$DEPLOY_ENV" | tail -1)"
[ -n "$MUJEEB_REPO_URL" ] || die "MUJEEB_REPO_URL is empty in $DEPLOY_ENV"
[ -r "$MUJEEB_ENV" ] || die "missing $MUJEEB_ENV (start from deploy/staging/mujeeb.env.example)"
command -v npm >/dev/null || die "npm not found: run bootstrap-host.sh first"
take_lock
guard_no_calls "$FORCE"

REL="$RELEASES/$SHA"
if [ ! -L "$CURRENT" ]; then CHECK=1; fi
if [ -f "$REL/.complete" ]; then
  say "release $SHA already built: reusing it"
else
  TMP="$REL.partial"
  trap 'rm -rf "$TMP"' EXIT
  rm -rf "$TMP"
  install -d -m 755 "$TMP"
  say "fetching $SHA"
  git -C "$TMP" init -q
  git -C "$TMP" remote add origin "$MUJEEB_REPO_URL"
  git -C "$TMP" fetch -q --depth 1 origin "$SHA" || die "cannot fetch $SHA from $MUJEEB_REPO_URL (pushed?): nothing changed"
  git -C "$TMP" -c advice.detachedHead=false checkout -q FETCH_HEAD
  [ "$(git -C "$TMP" rev-parse HEAD)" = "$SHA" ] || die "the fetched commit is not $SHA: nothing changed"
  say "building (npm ci --ignore-scripts, build$([ "$CHECK" = 1 ] && echo ', npm run check'), prune)"
  export npm_config_cache=/var/cache/mujeeb-npm
  # Chained with &&: set -e does not apply inside a command on the left of ||.
  (
    cd "$TMP" &&
      npm ci --ignore-scripts --no-audit --no-fund &&
      npm run build &&
      { [ "$CHECK" = 0 ] || npm run check; } &&
      npm prune --omit=dev --ignore-scripts --no-audit --no-fund
  ) || die "build failed: nothing was switched or restarted"
  rm -rf "$TMP/.git"
  echo "$SHA" > "$TMP/REVISION"
  touch "$TMP/.complete"
  chown -R root:root "$TMP"
  chmod -R go-w "$TMP"
  mv "$TMP" "$REL"
  trap - EXIT
fi

PREV="$(readlink -e "$CURRENT" 2>/dev/null || true)"
switch_to "$REL"
say "switched to $SHA; restarting"
if restart_and_watch; then
  if [ -n "$PREV" ] && [ "$PREV" != "$REL" ]; then ln -sfn "$PREV" "$PREVIOUS"; fi
  prune_releases
  say "DEPLOY_OK $SHA (previous: $([ -n "$PREV" ] && revision_of "$PREV" || echo none))"
  exit 0
fi

if [ -n "$PREV" ] && [ "$PREV" != "$REL" ] && [ -f "$PREV/.complete" ]; then
  say "deploy of $SHA failed: rolling back to $(revision_of "$PREV")"
  switch_to "$PREV"
  if restart_and_watch; then die "deploy of $SHA failed; rolled back to $(revision_of "$PREV"), which is running"; fi
fi
systemctl stop "$SERVICE" || true
die "deploy of $SHA failed and no working previous release could be started: $SERVICE is stopped (callers hear the apology)"
