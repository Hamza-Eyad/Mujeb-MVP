#!/usr/bin/env bash
# Staging server: write Asterisk's configuration for the ExaCall trunk and Mujeeb's gateway (run as root).
# Plan: plans/2026-11-02-phase-4-oracle-staging.md. The local lab has its own script (deploy/asterisk/lab/setup-lab.sh).
#
#   setup-asterisk.sh [--env FILE] [--conf-dir DIR] [--restart] [--force]
#     --env FILE      host values (default /etc/mujeeb/asterisk-host.env; start from host.env.example)
#     --conf-dir DIR  write to DIR instead of /etc/asterisk: review mode. Nothing else on the host changes (no users,
#                     ownership, sounds, service or reload); the shared secret is generated inside DIR.
#     --restart       restart Asterisk instead of reloading it: needed after a module, port, address or transport
#                     change. Refused while calls are up (or when that cannot be told), unless --force.
#
# What the configuration guarantees (check-asterisk-config.sh enforces it before anything is installed):
# - an explicit module list (autoload = no): no CDR/CEL backend, no AMI, ARI or HTTP server, no SIP registrar,
#   no anonymous or From-user identification: only the trunk's addresses (or its registration) identify a call;
# - no recording and no outbound route: the only Dial() goes to Mujeeb's gateway;
# - the persistent log holds warnings and errors only. NOTICE carries the caller's number (res_pjsip prints the whole
#   From header in "No matching endpoint found") and verbose carries the dialplan and `pjsip set logger` traffic: they
#   reach remote consoles only. The service's stdout goes to /dev/null (asterisk.service): in 22.11.0, -m does not
#   mute the daemon's own console;
# - the DID reaches Mujeeb exactly as received: routes.json decides, and an unknown DID hears the apology.
#
# On the host, the previous /etc/asterisk is archived first and put back if the reload or the checks fail.
# Safe to run again: files are rewritten, the shared secret is kept.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
# shellcheck source=../../staging/lib.sh
. "$HERE/../../staging/lib.sh"
PROMPT="$HERE/../lab/sounds/unavailable.sln16"
ENV_FILE=/etc/mujeeb/asterisk-host.env
CONF=/etc/asterisk
RESTART=0
FORCE=0
usage() { sed -n '2,13p' "$0"; exit 2; }
while [ $# -gt 0 ]; do
  case "$1" in
    --env) [ $# -ge 2 ] || usage; ENV_FILE="$2"; shift 2 ;;
    --conf-dir) [ $# -ge 2 ] || usage; CONF="${2%/}"; shift 2 ;;
    --restart) RESTART=1; shift ;;
    --force) FORCE=1; shift ;;
    *) usage ;;
  esac
done
LIVE=0
if [ "$CONF" = /etc/asterisk ]; then LIVE=1; fi

[ -r "$ENV_FILE" ] || die "cannot read $ENV_FILE (start from host.env.example)"
# shellcheck source=host.env.example
. "$ENV_FILE"
SIP_PORT="${SIP_PORT:-5060}" RTP_START="${RTP_START:-10000}" RTP_END="${RTP_END:-10199}"
INBOUND_MODE="${INBOUND_MODE:-echo}" DID_SOURCE="${DID_SOURCE:-ruri}" DIAL_TIMEOUT="${DIAL_TIMEOUT:-10}"
TRUNK_ENABLED="${TRUNK_ENABLED:-no}" TRUNK_AUTH="${TRUNK_AUTH:-ip}" TRUNK_HOST="${TRUNK_HOST:-}" TRUNK_PORT="${TRUNK_PORT:-5060}"
TRUNK_TRANSPORT="${TRUNK_TRANSPORT:-udp}" TRUNK_CODECS="${TRUNK_CODECS:-g722,alaw,ulaw}" TRUNK_QUALIFY="${TRUNK_QUALIFY:-no}"
TRUNK_SIGNALING_IPS="${TRUNK_SIGNALING_IPS:-}" TRUNK_MEDIA_IPS="${TRUNK_MEDIA_IPS:-}"
TRUNK_SECRETS_FILE="${TRUNK_SECRETS_FILE:-/etc/mujeeb/exacall-trunk.env}"
GATEWAY_URI="${GATEWAY_URI:-ws://127.0.0.1:8790/media}" GATEWAY_USERNAME="${GATEWAY_USERNAME:-asterisk}"

# ── Validate host.env ────────────────────────────────────────────────────
one_of() { # variable name, allowed values...
  local name="$1" value="${!1}"
  shift
  for allowed in "$@"; do [ "$value" != "$allowed" ] || return 0; done
  die "$name must be one of: $* (is '$value')"
}
is_ipv4() {
  [[ $1 =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  local octet
  for octet in "${BASH_REMATCH[@]:1}"; do [ "$octet" -le 255 ] || return 1; done
}
is_net() { # an IPv4 address, or a range a.b.c.d/n
  local ip="${1%/*}"
  is_ipv4 "$ip" || return 1
  [ "$ip" = "$1" ] || { [[ ${1#*/} =~ ^[0-9]{1,2}$ ]] && [ "${1#*/}" -le 32 ]; }
}
is_port() { [[ $1 =~ ^[0-9]{1,5}$ ]] && [ "$1" -ge 1 ] && [ "$1" -le 65535 ]; }
list() { printf '%s' "$1" | tr ',' '\n' | sed 's/[[:space:]]//g' | grep -v '^$' || true; }

is_ipv4 "${PUBLIC_IP:-}" || die "PUBLIC_IP must be this server's public IPv4 address"
is_net "${LOCAL_NET:-}" || die "LOCAL_NET must be the VCN range, e.g. 10.0.0.0/16"
for port in SIP_PORT TRUNK_PORT RTP_START RTP_END; do is_port "${!port}" || die "$port is not a port number"; done
[ "$RTP_START" -lt "$RTP_END" ] || die "RTP_START must be below RTP_END"
one_of INBOUND_MODE echo mujeeb
one_of DID_SOURCE ruri to
one_of TRUNK_ENABLED yes no
one_of TRUNK_AUTH ip registration
one_of TRUNK_TRANSPORT udp tcp
one_of TRUNK_QUALIFY yes no
[ -n "$(list "$TRUNK_CODECS")" ] || die "TRUNK_CODECS is empty"
for codec in $(list "$TRUNK_CODECS"); do
  case "$codec" in g722|alaw|ulaw) ;; *) die "TRUNK_CODECS: unsupported codec '$codec' (g722, alaw, ulaw)" ;; esac
done
for ip in $(list "$TRUNK_SIGNALING_IPS") $(list "$TRUNK_MEDIA_IPS"); do is_net "$ip" || die "not an IPv4 address or range: $ip"; done
[[ $GATEWAY_URI =~ ^ws://(127\.0\.0\.1|localhost|\[::1\]):[0-9]+/ ]] || die "GATEWAY_URI must point at loopback (DECISIONS A19)"
[[ $GATEWAY_USERNAME =~ ^[A-Za-z0-9._-]+$ ]] || die "GATEWAY_USERNAME: letters, digits, . _ - only"
[[ $DIAL_TIMEOUT =~ ^[0-9]+$ ]] || die "DIAL_TIMEOUT must be whole seconds"
# The Dial timeout must leave Mujeeb its answer timeout (STT connection, two attempts) plus a margin (A19).
answer_ms="$(env_value MUJEEB_TELEPHONY_ANSWER_TIMEOUT_MS 7000)"
[ $((DIAL_TIMEOUT * 1000)) -ge $((answer_ms + 2000)) ] \
  || die "DIAL_TIMEOUT (${DIAL_TIMEOUT} s) must be at least 2 s above Mujeeb's answer timeout (${answer_ms} ms)"
TRUNK_USERNAME="" TRUNK_PASSWORD=""
if [ "$TRUNK_ENABLED" = yes ]; then
  if [ "$TRUNK_AUTH" = ip ] && [ -z "$(list "$TRUNK_SIGNALING_IPS")" ]; then die "TRUNK_AUTH=ip needs TRUNK_SIGNALING_IPS"; fi
  if [ "$TRUNK_AUTH" = registration ] || [ "$TRUNK_QUALIFY" = yes ]; then
    [[ $TRUNK_HOST =~ ^[A-Za-z0-9.-]+$ ]] || die "TRUNK_HOST (a host name or address) is needed for registration and OPTIONS"
  fi
  if [ "$TRUNK_AUTH" = registration ]; then
    [ -r "$TRUNK_SECRETS_FILE" ] || die "cannot read $TRUNK_SECRETS_FILE (TRUNK_USERNAME= and TRUNK_PASSWORD= lines)"
    TRUNK_USERNAME="$(sed -n 's/^TRUNK_USERNAME=//p' "$TRUNK_SECRETS_FILE" | tail -1 | tr -d '\r')"
    TRUNK_PASSWORD="$(sed -n 's/^TRUNK_PASSWORD=//p' "$TRUNK_SECRETS_FILE" | tail -1 | tr -d '\r')"
    [ -n "$TRUNK_USERNAME" ] && [ -n "$TRUNK_PASSWORD" ] || die "$TRUNK_SECRETS_FILE needs TRUNK_USERNAME and TRUNK_PASSWORD"
    [[ $TRUNK_USERNAME =~ ^[A-Za-z0-9._+-]+$ ]] || die "TRUNK_USERNAME has characters a SIP URI cannot carry as is"
  fi
fi

if [ "$LIVE" = 1 ]; then
  require_root
  [ -x /usr/sbin/asterisk ] || die "Asterisk is not installed: run deploy/asterisk/lab/build-asterisk.sh first"
  id asterisk >/dev/null 2>&1 || die "no asterisk user: run deploy/staging/bootstrap-host.sh first"
  [ -s "$PROMPT" ] || die "missing $PROMPT"
fi
mkdir -p "$CONF"

# ── The shared secret with Mujeeb (MUJEEB_TELEPHONY_PASSWORD), generated once ──
random_hex() { od -An -N"$1" -tx1 /dev/urandom | tr -d ' \n'; }
if [ ! -s "$CONF/mujeeb-telephony-password" ]; then (umask 077 && random_hex 16 > "$CONF/mujeeb-telephony-password"); fi
GWPASS="$(tr -d '\r\n' < "$CONF/mujeeb-telephony-password")"

# ── Generate into a private temporary directory ──────────────────────────
OUT="$(mktemp -d)"
trap 'rm -rf "$OUT"' EXIT
HEADER="; Staging server. Generated by deploy/asterisk/staging/setup-asterisk.sh from $ENV_FILE: change that file and re-run."

cat > "$OUT/asterisk.conf" <<EOF
$HEADER
[options]
; The service starts as asterisk already (asterisk.service). These keep Asterisk off root if it is ever started by hand.
runuser = asterisk
rungroup = asterisk
verbose = 0
debug = 0
EOF

cat > "$OUT/modules.conf" <<EOF
$HEADER
[modules]
; Explicit list. Dependencies follow each module's .requires in Asterisk 22.11.0 (dnsmgr and http are core).
autoload = no

; Core resources
load = res_timing_timerfd.so
load = res_sorcery_config.so
load = res_sorcery_memory.so
load = res_sorcery_astdb.so
load = res_pjproject.so

; SIP: the trunk only. Not loaded on purpose: res_pjsip_endpoint_identifier_anonymous and _user (a call is
; identified by the trunk's address or registration, never by its From user), res_pjsip_registrar, res_pjsip_refer.
load = res_pjsip.so
load = res_pjsip_session.so
load = res_pjsip_pubsub.so
load = chan_pjsip.so
load = res_pjsip_sdp_rtp.so
load = res_pjsip_endpoint_identifier_ip.so
load = res_pjsip_outbound_registration.so
load = res_pjsip_outbound_authenticator_digest.so
load = res_pjsip_authenticator_digest.so
load = res_pjsip_caller_id.so
load = res_pjsip_diversion.so
load = res_pjsip_nat.so
load = res_pjsip_header_funcs.so
; pjsip set logger on|off: diagnosis on a remote console only (see logger.conf)
load = res_pjsip_logger.so
load = res_rtp_asterisk.so

; Mujeeb's gateway: one WebSocket per call
load = res_http_websocket.so
load = res_websocket_client.so
load = chan_websocket.so

; Codecs and sound formats. codec_resample: 8 kHz lines <-> slin16 for Mujeeb. Core sounds are GSM.
load = codec_g722.so
load = codec_alaw.so
load = codec_ulaw.so
load = codec_a_mu.so
load = codec_gsm.so
load = codec_resample.so
load = format_sln.so
load = format_gsm.so
load = format_pcm.so

; Dialplan. bridge_simple joins the caller and Mujeeb's WebSocket leg.
load = pbx_config.so
load = app_dial.so
load = app_playback.so
load = app_echo.so
load = app_stack.so
load = app_verbose.so
load = func_callerid.so
load = func_cut.so
load = bridge_simple.so

; The CLI command "channel originate", used by synthetic-calls.sh (stage 3 load tests). CLI only: there is no AMI.
load = res_clioriginate.so
EOF

cat > "$OUT/logger.conf" <<EOF
$HEADER
[general]
dateformat = %F %T.%3q
; No call queues here, and a queue log would keep caller numbers.
queue_log = no

[logfiles]
; The only persistent Asterisk log: warnings and errors, which carry no caller number. Absent on purpose: notice
; (res_pjsip's "No matching endpoint found" prints the whole From header), verbose (dialplan steps with caller IDs,
; and \`pjsip set logger\` traffic), the security log (its AccountID is the From user), and any syslog channel.
messages => warning,error
; Live diagnosis on remote consoles (asterisk -r) only. The daemon's own stdout goes to /dev/null (asterisk.service).
console => notice,warning,error,verbose
EOF

for off in "cdr.conf enable" "cel.conf enable" "manager.conf enabled" "http.conf enabled" "ari.conf enabled"; do
  printf '%s\n[general]\n%s = no\n' "$HEADER" "${off#* }" > "$OUT/${off%% *}"
done

cat > "$OUT/rtp.conf" <<EOF
$HEADER
[general]
rtpstart = $RTP_START
rtpend = $RTP_END
; Learn the remote media address from the first packets and drop packets from anywhere else (the default).
strictrtp = yes
icesupport = no
EOF

transports="udp"
if [ "$TRUNK_TRANSPORT" = tcp ]; then transports="udp tcp"; fi
{
  echo "$HEADER"
  cat <<EOF
[global]
type = global
user_agent = Mujeeb
EOF
  for t in $transports; do
    cat <<EOF

; NAT on OCI: the VM has a private address behind a 1:1 public address. Loopback is local too (stage 3 simulation).
[transport-$t]
type = transport
protocol = $t
bind = 0.0.0.0:$SIP_PORT
external_media_address = $PUBLIC_IP
external_signaling_address = $PUBLIC_IP
local_net = $LOCAL_NET
local_net = 127.0.0.0/8
EOF
  done
  if [ "$TRUNK_ENABLED" = yes ]; then
    qualify=0
    if [ "$TRUNK_QUALIFY" = yes ]; then qualify=60; fi
    cat <<EOF

; The ExaCall trunk ($TRUNK_AUTH). Inbound only: no dialplan dials out through it.
[exacall]
type = endpoint
transport = transport-$TRUNK_TRANSPORT
context = from-trunk
disallow = all
allow = $(list "$TRUNK_CODECS" | paste -sd, -)
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
trust_id_inbound = yes
send_pai = no
send_rpid = no
dtmf_mode = rfc4733
media_encryption = no
aors = exacall
EOF
    if [ "$TRUNK_AUTH" = registration ]; then echo "outbound_auth = exacall-auth"; fi
    printf '\n[exacall]\ntype = aor\n'
    if [ -n "$TRUNK_HOST" ]; then printf 'contact = sip:%s:%s\n' "$TRUNK_HOST" "$TRUNK_PORT"; fi
    printf 'qualify_frequency = %s\n' "$qualify"
    if [ -n "$(list "$TRUNK_SIGNALING_IPS")" ]; then
      printf '\n[exacall]\ntype = identify\nendpoint = exacall\n'
      for ip in $(list "$TRUNK_SIGNALING_IPS"); do printf 'match = %s\n' "$ip"; done
    fi
    if [ "$TRUNK_AUTH" = registration ]; then
      cat <<EOF

[exacall-auth]
type = auth
auth_type = userpass
username = $TRUNK_USERNAME
password = $TRUNK_PASSWORD

[exacall-registration]
type = registration
transport = transport-$TRUNK_TRANSPORT
outbound_auth = exacall-auth
server_uri = sip:$TRUNK_HOST:$TRUNK_PORT
client_uri = sip:$TRUNK_USERNAME@$TRUNK_HOST
contact_user = $TRUNK_USERNAME
expiration = 300
retry_interval = 60
forbidden_retry_interval = 600
max_retries = 10000
; Inbound calls on this registration are identified by its line parameter, as well as by address.
line = yes
endpoint = exacall
EOF
    fi
  fi
} > "$OUT/pjsip.conf"

cat > "$OUT/websocket_client.conf" <<EOF
$HEADER
; One WebSocket per call to Mujeeb (per_call_config). username/password arrive as HTTP Basic auth and must match
; MUJEEB_TELEPHONY_USERNAME / MUJEEB_TELEPHONY_PASSWORD. Loopback only, so no TLS (DECISIONS A19).
[mujeeb]
type = websocket_client
connection_type = per_call_config
uri = $GATEWAY_URI
protocols = media
username = $GATEWAY_USERNAME
password = $GWPASS
connection_timeout = 1000
reconnect_interval = 500
reconnect_attempts = 2
tls_enabled = no
EOF

printf '%s\n[global]\ncontrol_message_format = json\n' "$HEADER" > "$OUT/chan_websocket.conf"

# The dialplan. Static parts are quoted here-docs (Asterisk's ${...} stays literal); @NAME@ placeholders are filled in.
case "$INBOUND_MODE" in
  echo) HANDLER='Goto(echo-test,s,1)' ;;
  mujeeb) HANDLER='Gosub(mujeeb-call,s,1(${DID}))' ;;
esac
{
  echo "$HEADER"
  cat <<'EOF'
[general]
static = yes
writeprotect = yes

[globals]

; Calls from the trunk (endpoint exacall). The DID is read once and passed on exactly as received: Mujeeb's
; routes.json is the only routing table, and Mujeeb refuses a DID it does not know (the caller hears the apology).
[from-trunk]
EOF
  if [ "$DID_SOURCE" = ruri ]; then
    for pattern in _X. _+X.; do
      printf 'exten => %s,1,Set(DID=${EXTEN})\n same => n,%s\n same => n,Hangup()\n' "$pattern" "$HANDLER"
    done
  else
    # The user part of the To header: "Name" <sip:USER@host>;tag=... -> USER. A tel: URI is not parsed (stage 5
    # records what ExaCall sends).
    for pattern in '_[0-9a-zA-Z+].' s; do
      printf 'exten => %s,1,Set(TO_URI=${PJSIP_HEADER(read,To)})\n same => n,Set(TO_URI=${CUT(TO_URI,@,1)})\n same => n,Set(DID=${CUT(TO_URI,:,2)})\n same => n,%s\n same => n,Hangup()\n' "$pattern" "$HANDLER"
    done
  fi
  cat <<'EOF'
exten => i,1,Hangup()

; Line check without Mujeeb (INBOUND_MODE=echo): a prompt, then the caller's own voice back.
[echo-test]
exten => s,1,Answer()
 same => n,Playback(hello-world)
 same => n,Echo()
 same => n,Hangup()

; One call to Mujeeb: the lab's contract (deploy/asterisk/lab/README.md; DIALPLAN_VARIABLES in
; src/adapters/telephony/asterisk/asterisk-ws-transport.ts). ARG1 = the DID as received = Mujeeb's route key.
; Inherited (__) variables arrive in MEDIA_START, never in the WebSocket URL. n = no answer until Mujeeb sends ANSWER.
; Any return from Dial with the caller still on the line is a failure (A19): the caller hears the apology. The
; warning line carries no number.
[mujeeb-call]
exten => s,1,Set(__MUJEEB_DID=${ARG1})
 same => n,Set(__MUJEEB_CALLER=${CALLERID(num)})
 same => n,Set(__MUJEEB_CALL_ID=${UNIQUEID})
 same => n,Dial(WebSocket/mujeeb/c(slin16)f(json)n,@DIAL_TIMEOUT@,g)
 same => n,Log(WARNING,mujeeb: call not completed - dialstatus=${DIALSTATUS} hangupcause=${HANGUPCAUSE} call_id=${UNIQUEID})
 same => n,Answer()
 same => n,Playback(mujeeb/unavailable)
 same => n,Hangup()

; Synthetic calls for stage 3 load tests (synthetic-calls.sh), from the Asterisk CLI only: no endpoint uses these
; contexts. Always Mujeeb, whatever INBOUND_MODE is.
[synthetic-in]
exten => _X.,1,Gosub(mujeeb-call,s,1(${EXTEN}))
 same => n,Hangup()

; The synthetic caller: talk-<seconds>-<pause> says a short phrase, stays silent <pause> seconds (1-10) and repeats
; for about <seconds>. The pause plays silence frames, as a phone does (Wait() would send no audio at all).
[synthetic-caller]
exten => _talk-X.,1,Set(TALK_SECONDS=${CUT(EXTEN,-,2)})
 same => n,Set(TALK_PAUSE=${CUT(EXTEN,-,3)})
 same => n,Set(TALK_END=$[${EPOCH} + ${TALK_SECONDS}])
 same => n(loop),Playback(tt-weasels)
 same => n,Playback(silence/${TALK_PAUSE})
 same => n,GotoIf($[${EPOCH} < ${TALK_END}]?loop)
 same => n,Hangup()
EOF
} | sed "s/@DIAL_TIMEOUT@/$DIAL_TIMEOUT/" > "$OUT/extensions.conf"

# The modes they are installed with (pjsip.conf and websocket_client.conf hold secrets): the check below refuses
# world-readable files, and the generated ones follow the caller's umask (022 on a fresh server).
chmod 640 "$OUT"/*.conf
bash "$HERE/check-asterisk-config.sh" "$OUT" >/dev/null || {
  bash "$HERE/check-asterisk-config.sh" "$OUT" || true
  die "the generated configuration failed its checks: nothing was installed"
}
SUMMARY="mode=$INBOUND_MODE did_source=$DID_SOURCE trunk=$TRUNK_ENABLED/$TRUNK_AUTH/$TRUNK_TRANSPORT codecs=$TRUNK_CODECS qualify=$TRUNK_QUALIFY"

if [ "$LIVE" = 0 ]; then
  cp "$OUT"/*.conf "$CONF"/
  echo "CONFIG_OK (review: $CONF; $SUMMARY)"
  exit 0
fi

# ── Install on the host ──────────────────────────────────────────────────
STAMP="$(date +%Y%m%d-%H%M%S)"
BACKUP="/var/backups/mujeeb-asterisk/etc-asterisk-$STAMP.tgz"
install -d -m 700 /var/backups/mujeeb-asterisk
tar -czf "$BACKUP" -C /etc asterisk
for file in "$OUT"/*.conf; do install -m 640 -o root -g asterisk "$file" "$CONF/$(basename "$file")"; done
chown root:asterisk "$CONF/mujeeb-telephony-password"
chmod 640 "$CONF/mujeeb-telephony-password"
install -d -m 755 /var/lib/asterisk/sounds/mujeeb
install -m 644 "$PROMPT" /var/lib/asterisk/sounds/mujeeb/unavailable.sln16
for dir in /var/lib/asterisk /var/log/asterisk /var/spool/asterisk; do
  install -d "$dir"
  chown -R asterisk:asterisk "$dir"
done
cat > /etc/logrotate.d/mujeeb-asterisk <<'EOF'
# Staging: Asterisk's only persistent log (warnings and errors), 14 days.
/var/log/asterisk/messages {
    daily
    rotate 14
    missingok
    notifempty
    compress
    delaycompress
    su asterisk asterisk
    create 0640 asterisk asterisk
    postrotate
        /usr/sbin/asterisk -rx 'logger reload' >/dev/null 2>&1 || true
    endscript
}
EOF
install -m 644 "$HERE/asterisk.service" /etc/systemd/system/asterisk.service
systemctl daemon-reload
systemctl enable asterisk >/dev/null 2>&1

apply() {
  if ! systemctl is-active --quiet asterisk; then
    systemctl start asterisk
  elif [ "$RESTART" = 1 ]; then
    guard_no_calls "$FORCE"
    systemctl restart asterisk
  else
    asterisk -rx 'core reload' >/dev/null
  fi
}
verify() {
  local i
  for i in $(seq 1 30); do
    if asterisk -rx 'core show version' >/dev/null 2>&1; then break; fi
    if [ "$i" = 30 ]; then say "verify: Asterisk does not answer"; return 1; fi
    sleep 1
  done
  asterisk -rx 'dialplan show from-trunk' | has "Context 'from-trunk'" || { say "verify: no from-trunk dialplan"; return 1; }
  asterisk -rx 'module show like chan_websocket' | has -E '^1 modules? loaded' || { say "verify: chan_websocket not loaded"; return 1; }
  if [ "$TRUNK_ENABLED" = yes ]; then
    asterisk -rx 'pjsip show endpoint exacall' | has -E 'Endpoint: +exacall' || { say "verify: no exacall endpoint"; return 1; }
  fi
  bash "$HERE/check-asterisk-config.sh" /etc/asterisk
}
if apply && verify; then
  say "CONFIG_OK (/etc/asterisk; $SUMMARY; previous config: $BACKUP)"
  say "If SIP_PORT, PUBLIC_IP, LOCAL_NET, the transport or the module list changed, run again with --restart when idle."
  say "Mujeeb's MUJEEB_TELEPHONY_PASSWORD: sudo cat /etc/asterisk/mujeeb-telephony-password"
else
  say "the new configuration failed: restoring $BACKUP"
  mv /etc/asterisk "/etc/asterisk.failed-$STAMP"
  tar -xzf "$BACKUP" -C /etc
  apply || true
  die "configuration not applied; the previous one is back (the failed one is in /etc/asterisk.failed-$STAMP)"
fi
