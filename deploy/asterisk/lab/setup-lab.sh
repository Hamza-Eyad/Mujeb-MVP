#!/usr/bin/env bash
# Lab only: Asterisk config for a local softphone (MicroSIP) calling Mujeeb (run as root inside WSL).
# This is a local test bench, not a carrier connection: SIP listens on 127.0.0.1 only, there is one
# softphone account (6001), and no outbound route exists. The optional demo trunk (MUJEEB_LAB_TRUNK below)
# adds a temporary inbound-only registration to a carrier's trial number; it is off by default.
#
# Extensions:
#   100 -> hello-world + Echo()   (call path and audio check, no Mujeeb)
#   300 -> Mujeeb's telephony gateway (npm run telephony), through chan_websocket
#   301 -> the same, for the second synthetic clinic (routes.two-clinics.json)
#
# Prompt: sounds/unavailable.sln16 (rendered once by `npm run lab:render-unavailable`) is installed as
# mujeeb/unavailable: the apology a caller hears when the call to Mujeeb fails.
#
# Secrets are generated on first run and kept outside the repository, readable by root only:
#   /etc/asterisk/lab-softphone-password     MicroSIP account password
#   /etc/asterisk/mujeeb-telephony-password  shared secret = MUJEEB_TELEPHONY_PASSWORD in Mujeeb's .env
# The config files that embed them (pjsip.conf, websocket_client.conf) are root-only too (600): the lab
# Asterisk runs as root. A production host runs Asterisk as its own user: there they are 640 root:asterisk.
#
# Options (environment):
#   MUJEEB_LAB_RECORD=1   record calls to 300 under /var/spool/asterisk/monitor (lab diagnosis only;
#                         synthetic data only). Run again without it to turn recording off.
#   ASTERISK_CONF_DIR=dir write the files to another directory (to review them without touching the lab).
#   MUJEEB_LAB_TRUNK=off|echo|mujeeb
#                         a carrier's demo trunk (plans/2026-11-09-exacall-demo-lab-trunk.md). Temporary: off (the
#                         default) writes exactly the lab without it. echo = a prompt, then the caller's own voice back;
#                         mujeeb = Mujeeb's gateway, the DID exactly as received as the route key. Inbound only.
#                         The trunk's values come from $CONF/lab-trunk.env (root-only, never in the repository):
#                           TRUNK_HOST=  TRUNK_PORT=  TRUNK_USERNAME=  TRUNK_PASSWORD=  TRUNK_PUBLIC_IP= (optional)
#                         The file is not sourced: only those keys are read. After turning it on or off, restart
#                         Asterisk (core restart now): a reload does not add or remove a transport.
# Safe to run again: config files are rewritten, existing secrets are kept.
set -euo pipefail
CONF="${ASTERISK_CONF_DIR:-/etc/asterisk}"
RECORD="${MUJEEB_LAB_RECORD:-0}"
TRUNK="${MUJEEB_LAB_TRUNK:-off}"
TRUNK_FILE="$CONF/lab-trunk.env"
PROMPT="$(cd "$(dirname "$0")" && pwd)/sounds/unavailable.sln16"
fail() { echo "$*" >&2; exit 1; }
case "$TRUNK" in off|echo|mujeeb) ;; *) fail "MUJEEB_LAB_TRUNK must be off, echo or mujeeb (is '$TRUNK')." ;; esac
# Recording is for synthetic lab calls only: calls through the trunk come from real phones.
[ "$TRUNK" = off ] || [ "$RECORD" != "1" ] || fail "MUJEEB_LAB_RECORD=1 is refused while the trunk is on."
mkdir -p "$CONF"
if [ ! -s "$PROMPT" ]; then
  echo "Missing $PROMPT: render it first (npm run lab:render-unavailable)." >&2
  exit 1
fi

if [ "$TRUNK" != off ]; then
  [ -r "$TRUNK_FILE" ] || fail "Missing $TRUNK_FILE (TRUNK_HOST, TRUNK_PORT, TRUNK_USERNAME, TRUNK_PASSWORD lines)."
  chmod 600 "$TRUNK_FILE"
  trunk_value() { # key: the last KEY=value line, without CR or surrounding blanks
    sed -n "s/^$1=//p" "$TRUNK_FILE" | tail -1 | tr -d '\r' | sed 's/^[[:space:]]*//; s/[[:space:]]*$//'
  }
  TRUNK_HOST="$(trunk_value TRUNK_HOST)"
  TRUNK_PORT="$(trunk_value TRUNK_PORT)"
  TRUNK_PORT="${TRUNK_PORT:-5060}"
  TRUNK_USERNAME="$(trunk_value TRUNK_USERNAME)"
  TRUNK_PASSWORD="$(trunk_value TRUNK_PASSWORD)"
  TRUNK_PUBLIC_IP="$(trunk_value TRUNK_PUBLIC_IP)"
  [[ $TRUNK_HOST =~ ^[A-Za-z0-9.-]+$ ]] || fail "TRUNK_HOST must be a host name or an IPv4 address."
  [[ $TRUNK_PORT =~ ^[0-9]{1,5}$ ]] && [ "$TRUNK_PORT" -ge 1 ] && [ "$TRUNK_PORT" -le 65535 ] \
    || fail "TRUNK_PORT is not a port number."
  [[ $TRUNK_USERNAME =~ ^[A-Za-z0-9._+-]+$ ]] || fail "TRUNK_USERNAME: letters, digits, . _ + - only."
  [ -n "$TRUNK_PASSWORD" ] || fail "TRUNK_PASSWORD is empty."
  if [ -n "$TRUNK_PUBLIC_IP" ]; then
    [[ $TRUNK_PUBLIC_IP =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || fail "TRUNK_PUBLIC_IP must be an IPv4 address."
  fi
  # ';' starts a comment in Asterisk's config files: escape it.
  TRUNK_PASSWORD_CONF="${TRUNK_PASSWORD//;/\\;}"
fi

secret() { # file, bytes
  if [ ! -s "$1" ]; then
    (umask 077 && openssl rand -hex "$2" > "$1")
  fi
  chmod 600 "$1"
  tr -d '\r\n' < "$1"
}
PASS="$(secret "$CONF/lab-softphone-password" 8)"
GWPASS="$(secret "$CONF/mujeeb-telephony-password" 16)"

private_file() { # path; content on stdin. Mode 600 before any content is written, even over an existing file.
  install -m 600 /dev/null "$1"
  cat > "$1"
}

cat > "$CONF/modules.conf" <<'EOF'
[modules]
autoload = yes
EOF

if [ "$TRUNK" = off ]; then
  cat > "$CONF/logger.conf" <<'EOF'
[general]
dateformat = %F %T.%3q

[logfiles]
full => notice,warning,error,verbose(3),dtmf
EOF
else
  # Trunk on: real callers' numbers reach the dialplan (verbose) and res_pjsip's notices. The file keeps warnings
  # and errors only, which carry no number; the rest goes to remote consoles (sudo asterisk -rvvv) only.
  cat > "$CONF/logger.conf" <<'EOF'
[general]
dateformat = %F %T.%3q
queue_log = no

[logfiles]
messages => warning,error
console => notice,warning,error,verbose
EOF
fi

cat > "$CONF/rtp.conf" <<'EOF'
[general]
rtpstart = 10000
rtpend = 10100
EOF

{
  cat <<EOF
; Lab only. Loopback transport: nothing outside this PC can reach it.
[transport-udp]
type = transport
protocol = udp
; 5070, not 5060: with WSL mirrored networking, Windows and Ubuntu share ports, and MicroSIP holds 5060.
bind = 127.0.0.1:5070

[6001]
type = endpoint
context = lab
disallow = all
allow = g722,ulaw
auth = 6001-auth
aors = 6001
direct_media = no
; WSL mirrored mode gives Ubuntu the same LAN IP as Windows, so the softphone's advertised LAN address
; loops back into Ubuntu. Send media/signaling to where packets actually come from (127.0.0.1) instead.
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes

[6001-auth]
type = auth
auth_type = userpass
username = 6001
password = ${PASS}

[6001]
type = aor
max_contacts = 1
remove_existing = yes
EOF
  if [ "$TRUNK" != off ]; then
    cat <<EOF

; -- Demo trunk (MUJEEB_LAB_TRUNK, plans/2026-11-09-exacall-demo-lab-trunk.md). Temporary, lab only. --
; Values from lab-trunk.env, never from the repository. Inbound only: no dialplan dials out through it.
; Its own transport on every address: the registration and the calls go through the home router. Port 5080, not
; 5060: Windows and Ubuntu share ports in mirrored mode, and MicroSIP holds 5060.
[transport-trunk]
type = transport
protocol = udp
bind = 0.0.0.0:5080
EOF
    if [ -n "$TRUNK_PUBLIC_IP" ]; then
      cat <<EOF
; TRUNK_PUBLIC_IP: advertise the home's public address in SIP and SDP (only if calls or audio do not arrive).
external_signaling_address = ${TRUNK_PUBLIC_IP}
external_media_address = ${TRUNK_PUBLIC_IP}
local_net = 10.0.0.0/8
local_net = 172.16.0.0/12
local_net = 192.168.0.0/16
local_net = 127.0.0.0/8
EOF
    fi
    cat <<EOF

[exacall]
type = endpoint
transport = transport-trunk
context = from-trunk
disallow = all
allow = g722,alaw,ulaw
direct_media = no
rtp_symmetric = yes
force_rport = yes
rewrite_contact = yes
trust_id_inbound = yes
send_pai = no
send_rpid = no
dtmf_mode = rfc4733
media_encryption = no
outbound_auth = exacall-auth
aors = exacall

[exacall]
type = aor
contact = sip:${TRUNK_HOST}:${TRUNK_PORT}
; OPTIONS every 25 s keep the router's NAT mapping open, as MicroSIP's keep-alive does. A carrier that ignores
; OPTIONS shows Unavailable; inbound calls are not affected.
qualify_frequency = 25

; Inbound calls are identified by the registration's line parameter, or else by the carrier's address
; (the host name is resolved once, when this file loads).
[exacall]
type = identify
endpoint = exacall
match = ${TRUNK_HOST}

[exacall-auth]
type = auth
auth_type = userpass
username = ${TRUNK_USERNAME}
password = ${TRUNK_PASSWORD_CONF}

; A 401/403 stops the retries (the default): a wrong password must not keep knocking on the carrier.
[exacall-registration]
type = registration
transport = transport-trunk
outbound_auth = exacall-auth
server_uri = sip:${TRUNK_HOST}:${TRUNK_PORT}
client_uri = sip:${TRUNK_USERNAME}@${TRUNK_HOST}
contact_user = ${TRUNK_USERNAME}
expiration = 300
retry_interval = 60
max_retries = 10000
line = yes
endpoint = exacall
EOF
  fi
} | private_file "$CONF/pjsip.conf"

# One WebSocket per call to Mujeeb (per_call_config). username/password arrive as HTTP Basic auth and must
# match MUJEEB_TELEPHONY_USERNAME / MUJEEB_TELEPHONY_PASSWORD; the port is MUJEEB_TELEPHONY_PORT.
private_file "$CONF/websocket_client.conf" <<EOF
[mujeeb]
type = websocket_client
connection_type = per_call_config
uri = ws://127.0.0.1:8790/media
protocols = media
username = asterisk
password = ${GWPASS}
connection_timeout = 1000
reconnect_interval = 500
reconnect_attempts = 2
tls_enabled = no
EOF

cat > "$CONF/chan_websocket.conf" <<'EOF'
[global]
control_message_format = json
EOF

if [ "$RECORD" = "1" ]; then
  # Lab diagnosis: the caller leg (what Mujeeb's STT receives), the agent leg and the mix, 16 kHz WAV.
  RECORDING_LINES=' same => n,Set(REC=/var/spool/asterisk/monitor/mujeeb-${STRFTIME(${EPOCH},,%Y%m%d-%H%M%S)}-${UNIQUEID})
 same => n,MixMonitor(${REC}-mix.wav16,r(${REC}-caller.wav16)t(${REC}-agent.wav16))'
else
  RECORDING_LINES=' same => n,NoOp(no recording)'
fi

# The dialplan contract with Mujeeb (DIALPLAN_VARIABLES in src/adapters/telephony/asterisk/asterisk-ws-transport.ts):
# inherited (__) variables arrive in MEDIA_START, never in the WebSocket URL; c(slin16) is the audio format
# Mujeeb expects; n = do not answer until Mujeeb sends ANSWER (after its session exists).
#
# When the call to Mujeeb fails (measured on 22.11.0, plans/2026-10-28-phase-4-step-2-lab.md item 3):
# - Dial(..., g) returns to the dialplan only while the caller is still on the line. A caller hang-up never
#   returns here.
# - Before an answer: CHANUNAVAIL (gateway down, HTTP 401/503, connection dropped) or NOANSWER (Mujeeb refused
#   the call, or did not answer within the timeout).
# - After an answer, every end looks the same (DIALSTATUS=ANSWER, HANGUPCAUSE=16): a HANGUP command, a clean
#   close, a dropped connection, a crashed process. The cause cannot tell a failure from a normal end.
# - So Mujeeb never ends a call normally through its WebSocket leg: any return here is a failure, and the
#   caller hears the apology. A future normal end must hang up the caller's own channel (call control),
#   which never returns here.
{
  cat <<'EOF'
[general]
static = yes
writeprotect = yes

[lab]
exten => 100,1,Answer()
 same => n,Playback(hello-world)
 same => n,Echo()
 same => n,Hangup()

; Mujeeb: the same contract the production dialplan will use (only the number differs).
exten => 300,1,Gosub(mujeeb-call,s,1(${EXTEN}))
 same => n,Hangup()

; A second synthetic clinic (two-clinic tests, config/telephony/routes.two-clinics.json). With the default
; routes it has no route, so the caller hears the apology.
exten => 301,1,Gosub(mujeeb-call,s,1(${EXTEN}))
 same => n,Hangup()

; Anything else: hang up. No outbound dialing exists in this lab.
exten => _X.,1,Hangup()

; One call to Mujeeb. ARG1: the dialed number (Mujeeb's route key).
[mujeeb-call]
exten => s,1,Set(__MUJEEB_DID=${ARG1})
 same => n,Set(__MUJEEB_CALLER=${CALLERID(num)})
 same => n,Set(__MUJEEB_CALL_ID=${UNIQUEID})
EOF
  printf '%s\n' "$RECORDING_LINES"
  cat <<'EOF'
 same => n,Dial(WebSocket/mujeeb/c(slin16)f(json)n,10,g)
 same => n,Verbose(1,mujeeb: call not completed - dialstatus=${DIALSTATUS} hangupcause=${HANGUPCAUSE})
 same => n,Answer()
 same => n,Playback(mujeeb/unavailable)
 same => n,Hangup()

; Synthetic caller for lab load tests (load-calls.sh); no softphone can reach this context. The extension
; describes the call: talk-<seconds>-<pause> says a short phrase, stays silent <pause> seconds (1-10), and
; repeats for about <seconds>, then hangs up. Fake STT turns the phrase's energy into a canned Arabic
; utterance. The pause plays silence frames, as a phone does: Wait() would send no audio at all.
[lab-caller]
exten => _talk-X.,1,Set(TALK_SECONDS=${CUT(EXTEN,-,2)})
 same => n,Set(TALK_PAUSE=${CUT(EXTEN,-,3)})
 same => n,Set(TALK_END=$[${EPOCH} + ${TALK_SECONDS}])
 same => n(loop),Playback(tt-weasels)
 same => n,Playback(silence/${TALK_PAUSE})
 same => n,GotoIf($[${EPOCH} < ${TALK_END}]?loop)
 same => n,Hangup()
EOF
  if [ "$TRUNK" != off ]; then
    if [ "$TRUNK" = echo ]; then HANDLER='Goto(trunk-echo,s,1)'; else HANDLER='Gosub(mujeeb-call,s,1(${EXTEN}))'; fi
    cat <<'EOF'

; -- Demo trunk (MUJEEB_LAB_TRUNK). Temporary, lab only. --
; Calls from the carrier (endpoint exacall). The DID is ${EXTEN} exactly as received: for a registration trunk,
; usually the account name. Mujeeb's routes file decides; an unknown DID hears the apology. The Verbose line shows
; what arrived (on remote consoles only: logger.conf keeps no verbose in a file while the trunk is on).
[from-trunk]
EOF
    for pattern in '_[0-9a-zA-Z+].' s; do
      printf 'exten => %s,1,Verbose(1,trunk: exten=${EXTEN} to=${PJSIP_HEADER(read,To)})\n' "$pattern"
      printf ' same => n,%s\n same => n,Hangup()\n' "$HANDLER"
    done
    cat <<'EOF'
exten => i,1,Hangup()

; The line without Mujeeb: a prompt, then the caller's own voice back.
[trunk-echo]
exten => s,1,Answer()
 same => n,Playback(hello-world)
 same => n,Echo()
 same => n,Hangup()
EOF
  fi
} > "$CONF/extensions.conf"

if [ "$CONF" = "/etc/asterisk" ]; then
  mkdir -p /var/log/asterisk /var/spool/asterisk/monitor /var/lib/asterisk/sounds/mujeeb
  install -m 644 "$PROMPT" /var/lib/asterisk/sounds/mujeeb/unavailable.sln16
  : > /var/log/asterisk/full
fi
echo "CONFIG_OK ($CONF, recording: $([ "$RECORD" = "1" ] && echo on || echo off), trunk: $TRUNK)"
if [ "$TRUNK" != off ]; then
  echo "trunk: restart Asterisk (core restart now), then: pjsip show registrations. Turn the carrier account off in MicroSIP."
fi
echo "softphone: server=127.0.0.1:5070 user=6001 password: sudo cat $CONF/lab-softphone-password"
echo "Mujeeb .env: MUJEEB_TELEPHONY_PASSWORD = sudo cat $CONF/mujeeb-telephony-password"
