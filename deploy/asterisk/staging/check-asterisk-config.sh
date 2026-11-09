#!/usr/bin/env bash
# Staging server: check an Asterisk configuration directory against the staging plan's invariants
# (plans/2026-11-02-phase-4-oracle-staging.md). setup-asterisk.sh runs it on what it generated, before anything
# is installed, and again on /etc/asterisk afterwards. It also runs anywhere bash runs, to review a generated
# directory.
#
#   check-asterisk-config.sh [config dir]      (default /etc/asterisk)
#
# Invariants:
# - explicit module list (autoload = no), and none of: CDR/CEL backends, ARI/Stasis, recording apps,
#   anonymous or From-user endpoint identification, a SIP registrar, REFER;
# - CDR, CEL, AMI, the HTTP server and ARI switched off in their own files too;
# - the only persistent log is "messages => warning,error": no notice (res_pjsip's "No matching endpoint found"
#   prints the whole From header, i.e. the caller's number), no verbose, no security log, no syslog channel;
#   no queue log;
# - no recording or spying application, and the only Dial() goes to Mujeeb's gateway: no outbound route;
# - the DID reaches Mujeeb as received (no substring, FILTER or REPLACE on it);
# - every endpoint is the trunk (exacall), in context from-trunk, with direct_media = no; no "anonymous" section;
# - Mujeeb's gateway is reached on loopback only;
# - on Linux, the files holding secrets are not world-readable.
# Exit 0 with CONFIG_CHECK_OK, or 1 with one VIOLATION line per problem.
set -euo pipefail
DIR="${1:-/etc/asterisk}"
DIR="${DIR%/}"
fail=0
bad() { echo "VIOLATION: $*"; fail=1; }
# grep -q for pipelines: reads all its input, so the writer never gets SIGPIPE, which pipefail would report as a failure.
has() { [ "$(grep -c "$@")" != 0 ]; }
# A config file without comments, blank lines or surrounding blanks.
lines() { sed -e 's/;.*$//' -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//' -e 's/\r$//' "$DIR/$1" | grep -v '^$' || true; }
# The lines of one [section] of a file, from lines().
section() { lines "$1" | awk -v s="[$2]" '/^\[/ { on = ($0 == s); next } on'; }

for name in asterisk.conf modules.conf logger.conf pjsip.conf extensions.conf rtp.conf websocket_client.conf \
  chan_websocket.conf cdr.conf cel.conf manager.conf http.conf ari.conf; do
  [ -s "$DIR/$name" ] || bad "$name is missing or empty"
done
if [ "$fail" = 1 ]; then exit 1; fi

# ── modules.conf ─────────────────────────────────────────────────────────
lines modules.conf | has -Ex 'autoload[[:space:]]*=[[:space:]]*no' || bad "modules.conf: autoload must be no"
if lines modules.conf | has -E '^autoload[[:space:]]*=[[:space:]]*yes'; then bad "modules.conf: autoload = yes"; fi
forbidden='^(load|preload|require|preload-require)[[:space:]]*=[[:space:]]*(cdr_|cel_|res_ari|res_stasis|app_mixmonitor|app_monitor|app_record|app_chanspy|res_pjsip_endpoint_identifier_anonymous|res_pjsip_endpoint_identifier_user|res_pjsip_registrar|res_pjsip_refer|res_pjsip_one_touch_record_info|res_pjsip_history|chan_sip|app_originate|app_system)'
while IFS= read -r line; do bad "modules.conf: forbidden module: $line"; done < <(lines modules.conf | grep -E "$forbidden" || true)

# ── switched off in their own files ──────────────────────────────────────
section cdr.conf general | has -Ex 'enable[[:space:]]*=[[:space:]]*no' || bad "cdr.conf: [general] enable must be no"
section cel.conf general | has -Ex 'enable[[:space:]]*=[[:space:]]*no' || bad "cel.conf: [general] enable must be no"
for f in manager.conf http.conf ari.conf; do
  section "$f" general | has -Ex 'enabled[[:space:]]*=[[:space:]]*no' || bad "$f: [general] enabled must be no"
done

# ── logger.conf ──────────────────────────────────────────────────────────
section logger.conf general | has -Ex 'queue_log[[:space:]]*=[[:space:]]*no' || bad "logger.conf: queue_log must be no"
messages_seen=0
while IFS= read -r line; do
  name="$(printf '%s' "$line" | sed -E 's/[[:space:]]*=>.*$//')"
  levels="$(printf '%s' "$line" | sed -E 's/^[^=]*=>[[:space:]]*//; s/[[:space:]]//g')"
  case "$name" in
    messages)
      messages_seen=1
      for level in $(printf '%s' "$levels" | tr ',' ' '); do
        case "$level" in warning|error) ;; *) bad "logger.conf: messages must be warning,error only (has '$level')" ;; esac
      done ;;
    console) ;;
    *) bad "logger.conf: log channel not allowed: '$name' (only messages => warning,error, and console)" ;;
  esac
done < <(section logger.conf logfiles)
[ "$messages_seen" = 1 ] || bad "logger.conf: no messages => warning,error channel"

# ── extensions.conf ──────────────────────────────────────────────────────
allowed_contexts=' general globals from-trunk echo-test mujeeb-call synthetic-in synthetic-caller '
while IFS= read -r ctx; do
  case "$allowed_contexts" in *" $ctx "*) ;; *) bad "extensions.conf: unexpected context [$ctx]" ;; esac
done < <(lines extensions.conf | sed -n 's/^\[\([^]]*\)\].*$/\1/p')
while IFS= read -r line; do bad "extensions.conf: recording, spying or outbound application: $line"; done \
  < <(lines extensions.conf | grep -iE 'mixmonitor|[(,]monitor\(|record\(|chanspy|extenspy|originate\(|system\(|queue\(|page\(' || true)
dials=0
while IFS= read -r line; do
  dials=$((dials + 1))
  printf '%s' "$line" | has -E 'Dial\(WebSocket/mujeeb/c\(slin16\)f\(json\)n,[0-9]+,g\)$' \
    || bad "extensions.conf: the only Dial allowed is Dial(WebSocket/mujeeb/c(slin16)f(json)n,<timeout>,g): $line"
done < <(lines extensions.conf | grep -i 'dial(' || true)
[ "$dials" -ge 1 ] || bad "extensions.conf: no Dial to Mujeeb's gateway"
lines extensions.conf | has -Fx 'exten => s,1,Set(__MUJEEB_DID=${ARG1})' || bad "extensions.conf: mujeeb-call must set __MUJEEB_DID=\${ARG1} unchanged"
while IFS= read -r line; do bad "extensions.conf: the DID must reach Mujeeb as received: $line"; done \
  < <(lines extensions.conf | grep -E 'EXTEN:|DID:|FILTER\(|REPLACE\(' || true)

# ── pjsip.conf ───────────────────────────────────────────────────────────
pjsip_sections() { # name|type|context|direct_media per section
  lines pjsip.conf | awk '
    function flush() { if (name != "") print name "|" type "|" ctx "|" dm }
    /^\[/ { flush(); name = $0; sub(/^\[/, "", name); sub(/\].*$/, "", name); type = ""; ctx = ""; dm = ""; next }
    /=/ {
      k = $0; v = $0; sub(/=.*$/, "", k); sub(/^[^=]*=/, "", v)
      gsub(/[[:space:]]/, "", k); gsub(/^[[:space:]]+|[[:space:]]+$/, "", v)
      if (k == "type") type = v; else if (k == "context") ctx = v; else if (k == "direct_media") dm = v
    }
    END { flush() }'
}
transports=0
while IFS='|' read -r name type ctx dm; do
  [ "$name" != anonymous ] || bad "pjsip.conf: an [anonymous] section exists"
  case "$type" in
    endpoint)
      [ "$name" = exacall ] || bad "pjsip.conf: endpoint '$name' (only the trunk endpoint 'exacall' is allowed)"
      [ "$ctx" = from-trunk ] || bad "pjsip.conf: endpoint '$name' context is '$ctx' (must be from-trunk)"
      [ "$dm" = no ] || bad "pjsip.conf: endpoint '$name' must set direct_media = no" ;;
    transport) transports=$((transports + 1)) ;;
  esac
done < <(pjsip_sections)
[ "$transports" -ge 1 ] || bad "pjsip.conf: no transport"
for key in external_media_address external_signaling_address local_net; do
  lines pjsip.conf | has -E "^${key}[[:space:]]*=[[:space:]]*[0-9]" || bad "pjsip.conf: transports need $key (NAT on OCI)"
done

# ── rtp.conf, websocket_client.conf ──────────────────────────────────────
section rtp.conf general | has -Ex 'strictrtp[[:space:]]*=[[:space:]]*yes' || bad "rtp.conf: strictrtp must be yes"
lines websocket_client.conf | has -E '^uri[[:space:]]*=[[:space:]]*ws://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+/' \
  || bad "websocket_client.conf: Mujeeb's gateway must be on loopback (DECISIONS A19)"

# ── permissions (only meaningful on Linux) ───────────────────────────────
if [ "$(uname -s)" = Linux ]; then
  for name in pjsip.conf websocket_client.conf mujeeb-telephony-password; do
    [ -e "$DIR/$name" ] || continue
    mode="$(stat -c %a "$DIR/$name")"
    case "$mode" in *0) ;; *) bad "$name is readable by every user (mode $mode)" ;; esac
  done
fi

if [ "$fail" = 1 ]; then exit 1; fi
echo "CONFIG_CHECK_OK ($DIR)"
