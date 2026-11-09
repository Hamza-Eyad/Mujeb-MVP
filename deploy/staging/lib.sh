# Shared by the staging scripts (sourced, not run): paths, logging, the live-call guard and the post-restart watch.
# Bash, on the Ubuntu staging server, as root. Plan: plans/2026-11-02-phase-4-oracle-staging.md (3-و).
# shellcheck shell=bash

MUJEEB_HOME=/opt/mujeeb
RELEASES="$MUJEEB_HOME/releases"
CURRENT="$MUJEEB_HOME/current"
PREVIOUS="$MUJEEB_HOME/previous"
MUJEEB_ENV=/etc/mujeeb/mujeeb.env
# shellcheck disable=SC2034 # used by the scripts that source this file (bootstrap-host.sh, deploy-mujeeb.sh)
DEPLOY_ENV=/etc/mujeeb/deploy.env
SERVICE=mujeeb-telephony
LOCK_FILE=/run/lock/mujeeb-deploy.lock
KEEP_RELEASES=3
export PATH="/opt/node/current/bin:$PATH"

say() {
  echo "[$(basename "$0")] $*"
  if command -v logger >/dev/null; then logger -t mujeeb-deploy -- "$*" || true; fi
}
die() {
  echo "[$(basename "$0")] ERROR: $*" >&2
  if command -v logger >/dev/null; then logger -t mujeeb-deploy -p user.err -- "$*" || true; fi
  exit 1
}
require_root() { [ "$(id -u)" = 0 ] || die "run as root"; }
# grep -q for pipelines: reads all its input, so the writer never gets SIGPIPE, which pipefail would report as a failure.
has() { [ "$(grep -c "$@")" != 0 ]; }

# One value from Mujeeb's env file (KEY=value lines, as systemd reads them), or the default.
env_value() { # key default
  local value=""
  if [ -r "$MUJEEB_ENV" ]; then value="$(sed -n "s/^$1=//p" "$MUJEEB_ENV" | tail -1 | tr -d '\r')"; fi
  printf '%s' "${value:-$2}"
}
gateway_port() { env_value MUJEEB_TELEPHONY_PORT 8790; }

# Scripts that place calls (simulation, synthetic load) run with fake providers only: a real provider costs money
# per call, and paid tests need their own approval (plan, stage 7 and decision ق8).
require_fake_providers() {
  local key
  for key in MUJEEB_LLM_PROVIDER MUJEEB_STT_PROVIDER MUJEEB_TTS_PROVIDER; do
    [ "$(env_value "$key" unset)" = fake ] || die "$key is not 'fake' in $MUJEEB_ENV: refusing to place test calls on paid providers"
  done
}

take_lock() {
  exec 9>"$LOCK_FILE"
  flock -n 9 || die "another deploy or rollback is running"
}

# Live call legs = Asterisk channels + established connections to Mujeeb's gateway. Prints the number, or fails when
# it cannot tell (Asterisk down, no answer): callers treat "cannot tell" as "calls may be up".
live_calls() {
  local out channels sockets
  out="$(asterisk -rx 'core show channels count' 2>/dev/null)" || return 1
  channels="$(printf '%s\n' "$out" | sed -n 's/^\([0-9][0-9]*\) active channels\{0,1\}$/\1/p')"
  [ -n "$channels" ] || return 1
  sockets="$(ss -Htn state established "( sport = :$(gateway_port) )")" || return 1
  echo $((channels + $(printf '%s' "$sockets" | grep -c . || true)))
}

# Refuses to go on while calls are up, or when it cannot tell, unless forced (1). A restart cuts every call, and the
# code has no drain (plan 3-و): this guard is the only protection.
guard_no_calls() { # force
  local n
  if ! n="$(live_calls)"; then
    [ "$1" = 1 ] || die "cannot tell whether calls are up (is Asterisk running?): refusing. --force overrides."
    say "WARNING: cannot tell whether calls are up; going on because of --force"
    return 0
  fi
  if [ "$n" -gt 0 ]; then
    [ "$1" = 1 ] || die "$n live call leg(s): refusing, they would be cut. Retry when idle, or --force."
    say "WARNING: cutting $n live call leg(s) because of --force (callers hear the apology)"
  fi
}

switch_to() { ln -sfn "$1" "$CURRENT.new" && mv -T "$CURRENT.new" "$CURRENT"; }
revision_of() { cat "$1/REVISION" 2>/dev/null || basename "$1"; }

# Restarts the service and watches it: listening on 127.0.0.1 within 10 s, then 30 s with the same process (no crash
# loop), the app.config line logged, and no "Configuration error" or "Fatal" since the restart.
restart_and_watch() {
  local since port pid i journal
  since="$(date '+%Y-%m-%d %H:%M:%S')"
  port="$(gateway_port)"
  # A release that crash-loops hits StartLimitBurst (5 in 60 s) within the watch, and systemd then refuses every start,
  # the rollback's included: clear the failed state and the start-limit counter first.
  systemctl reset-failed "$SERVICE" 2>/dev/null || true
  systemctl restart "$SERVICE" || { say "watch: restart failed"; return 1; }
  for i in $(seq 1 20); do
    if ss -Hltn "( sport = :$port )" | has "127\.0\.0\.1:$port"; then break; fi
    if [ "$i" = 20 ]; then say "watch: not listening on 127.0.0.1:$port after 10 s"; return 1; fi
    sleep 0.5
  done
  pid="$(systemctl show -p MainPID --value "$SERVICE")"
  [ "${pid:-0}" != 0 ] || { say "watch: no main process"; return 1; }
  for i in $(seq 1 30); do
    sleep 1
    systemctl is-active --quiet "$SERVICE" || { say "watch: service stopped after ${i}s"; return 1; }
    [ "$(systemctl show -p MainPID --value "$SERVICE")" = "$pid" ] || { say "watch: process replaced after ${i}s (crash loop?)"; return 1; }
  done
  journal="$(journalctl -u "$SERVICE" --since "$since" -o cat --no-pager)"
  printf '%s\n' "$journal" | has '"event":"app.config"' || { say "watch: no app.config line since the restart"; return 1; }
  if printf '%s\n' "$journal" | has -E 'Configuration error|Fatal'; then say "watch: configuration or fatal error logged"; return 1; fi
  say "watch: OK (pid $pid stable for 30 s, listening on 127.0.0.1:$port)"
}

# Keeps the current and previous releases, and the newest others, up to KEEP_RELEASES in all.
prune_releases() {
  local cur prev kept=0 dir
  cur="$(readlink -e "$CURRENT" 2>/dev/null || true)"
  prev="$(readlink -e "$PREVIOUS" 2>/dev/null || true)"
  [ -z "$cur" ] || kept=$((kept + 1))
  if [ -n "$prev" ] && [ "$prev" != "$cur" ]; then kept=$((kept + 1)); fi
  while IFS= read -r dir; do
    if [ "$dir" = "$cur" ] || [ "$dir" = "$prev" ]; then continue; fi
    if [ "$kept" -lt "$KEEP_RELEASES" ]; then
      kept=$((kept + 1))
    else
      say "removing old release $(revision_of "$dir")"
      rm -rf -- "$dir"
    fi
  done < <(find "$RELEASES" -mindepth 1 -maxdepth 1 -type d -printf '%T@ %p\n' | sort -rn | cut -d' ' -f2-)
}
