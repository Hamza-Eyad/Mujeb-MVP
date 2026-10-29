#!/usr/bin/env bash
# Lab only: Asterisk config for a local softphone (MicroSIP) calling Mujeeb (run as root inside WSL).
# This is a local test bench, not a carrier connection: SIP listens on 127.0.0.1 only, there is one
# softphone account (6001), and no outbound route exists.
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
# Safe to run again: config files are rewritten, existing secrets are kept.
set -euo pipefail
CONF="${ASTERISK_CONF_DIR:-/etc/asterisk}"
RECORD="${MUJEEB_LAB_RECORD:-0}"
PROMPT="$(cd "$(dirname "$0")" && pwd)/sounds/unavailable.sln16"
mkdir -p "$CONF"
if [ ! -s "$PROMPT" ]; then
  echo "Missing $PROMPT: render it first (npm run lab:render-unavailable)." >&2
  exit 1
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

cat > "$CONF/logger.conf" <<'EOF'
[general]
dateformat = %F %T.%3q

[logfiles]
full => notice,warning,error,verbose(3),dtmf
EOF

cat > "$CONF/rtp.conf" <<'EOF'
[general]
rtpstart = 10000
rtpend = 10100
EOF

private_file "$CONF/pjsip.conf" <<EOF
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
} > "$CONF/extensions.conf"

if [ "$CONF" = "/etc/asterisk" ]; then
  mkdir -p /var/log/asterisk /var/spool/asterisk/monitor /var/lib/asterisk/sounds/mujeeb
  install -m 644 "$PROMPT" /var/lib/asterisk/sounds/mujeeb/unavailable.sln16
  : > /var/log/asterisk/full
fi
echo "CONFIG_OK ($CONF, recording: $([ "$RECORD" = "1" ] && echo on || echo off))"
echo "softphone: server=127.0.0.1:5070 user=6001 password: sudo cat $CONF/lab-softphone-password"
echo "Mujeeb .env: MUJEEB_TELEPHONY_PASSWORD = sudo cat $CONF/mujeeb-telephony-password"
