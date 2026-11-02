#!/usr/bin/env bash
# Staging server (Oracle, Ubuntu 24.04, x86_64): prepare the host once, from a checkout of the repository (run as
# root). Safe to run again. It opens no port, creates no cloud resource and installs no secret.
#
#   sudo bash deploy/staging/bootstrap-host.sh
#
# - packages: git, curl, xz-utils, unattended-upgrades (security updates, no automatic reboot), iptables-persistent,
#   and the stage 3 test tools sip-tester (SIPp) and shellcheck;
# - SSH: keys only, no root login. Refused if the calling user has no authorized key; validated with sshd -t first;
# - journald: persistent, 1 GB cap, 14 days, no copy to /var/log/syslog (one store, one retention period);
# - system users mujeeb and asterisk (no login); /opt/mujeeb, /etc/mujeeb, /var/lib/mujeeb/logs (files kept 30 days);
# - Node.js 24, pinned version and SHA-256 (the build fails if the download differs), in /opt/node;
# - /etc/mujeeb/deploy.env: MUJEEB_REPO_URL, from this checkout's origin (no URL is written in the scripts);
# - mujeeb-telephony.service and the health-check timer installed. Nothing is started: no release exists yet.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
# shellcheck source=lib.sh
. "$HERE/lib.sh"
NODE_VERSION=24.22.2
NODE_SHA256=48cc0e21e048790e54c0cf5749c2725005313d652651c40b7a21feb9697aaf75
export DEBIAN_FRONTEND=noninteractive

require_root
# shellcheck source=/dev/null
. /etc/os-release
[ "${ID:-}" = ubuntu ] && [ "${VERSION_ID:-}" = 24.04 ] || die "Ubuntu 24.04 expected (this is ${PRETTY_NAME:-unknown})"
[ "$(uname -m)" = x86_64 ] || die "x86_64 expected: the pinned Node.js build is linux-x64"

say "packages"
echo 'iptables-persistent iptables-persistent/autosave_v4 boolean false' | debconf-set-selections
echo 'iptables-persistent iptables-persistent/autosave_v6 boolean false' | debconf-set-selections
apt-get update -q
apt-get install -y -q git curl ca-certificates xz-utils unattended-upgrades iptables-persistent logrotate sip-tester shellcheck

say "security updates without automatic reboot"
cat > /etc/apt/apt.conf.d/52mujeeb-unattended-upgrades <<'EOF'
// Staging: install security updates daily, never reboot on our behalf (a reboot drops calls).
APT::Periodic::Update-Package-Lists "1";
APT::Periodic::Unattended-Upgrade "1";
Unattended-Upgrade::Automatic-Reboot "false";
EOF

say "SSH: keys only, no root login"
admin="${SUDO_USER:-}"
[ -n "$admin" ] && [ "$admin" != root ] || die "run with sudo from your own account, so its SSH key can be checked"
admin_home="$(getent passwd "$admin" | cut -d: -f6)"
[ -s "$admin_home/.ssh/authorized_keys" ] || die "$admin has no ~/.ssh/authorized_keys: refusing to turn passwords off"
cat > /etc/ssh/sshd_config.d/50-mujeeb.conf <<'EOF'
# Staging: keys only, no root login (bootstrap-host.sh). sshd keeps the first value it reads: 50 comes before 60-cloudimg.
PasswordAuthentication no
KbdInteractiveAuthentication no
PermitRootLogin no
EOF
sshd -t || { rm -f /etc/ssh/sshd_config.d/50-mujeeb.conf; die "sshd rejected the settings: removed them, SSH unchanged"; }
# Ubuntu 24.04 starts sshd from ssh.socket: reload it if it runs; new connections read the settings anyway.
systemctl try-reload-or-restart ssh

say "journald: 1 GB, 14 days, not copied to syslog"
install -d /etc/systemd/journald.conf.d
cat > /etc/systemd/journald.conf.d/50-mujeeb.conf <<'EOF'
# Staging (bootstrap-host.sh): the journal is the only store for service logs, with one retention period.
[Journal]
Storage=persistent
SystemMaxUse=1G
MaxRetentionSec=14day
ForwardToSyslog=no
EOF
systemctl restart systemd-journald

say "users and directories"
id mujeeb >/dev/null 2>&1 || useradd --system --home-dir /var/lib/mujeeb --shell /usr/sbin/nologin mujeeb
id asterisk >/dev/null 2>&1 || useradd --system --home-dir /var/lib/asterisk --shell /usr/sbin/nologin asterisk
install -d -m 755 /opt/mujeeb "$RELEASES" /opt/node
install -d -m 750 -o root -g mujeeb /etc/mujeeb
install -d -m 750 -o mujeeb -g mujeeb /var/lib/mujeeb /var/lib/mujeeb/logs
cat > /etc/tmpfiles.d/mujeeb.conf <<'EOF'
# Staging: Mujeeb's turn logs (turns-YYYY-MM-DD.jsonl) are deleted after 30 days.
d /var/lib/mujeeb/logs 0750 mujeeb mujeeb 30d
EOF
systemd-tmpfiles --create /etc/tmpfiles.d/mujeeb.conf

say "Node.js $NODE_VERSION"
node_dir="/opt/node/node-v$NODE_VERSION-linux-x64"
if [ ! -x "$node_dir/bin/node" ] || [ "$("$node_dir/bin/node" --version)" != "v$NODE_VERSION" ]; then
  tarball="$(mktemp -d)/node.tar.xz"
  curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-x64.tar.xz" -o "$tarball"
  echo "$NODE_SHA256  $tarball" | sha256sum -c - || die "Node.js download does not match the pinned SHA-256"
  rm -rf "$node_dir"
  tar -xJf "$tarball" -C /opt/node
  rm -rf "$(dirname "$tarball")"
fi
ln -sfn "$node_dir" /opt/node/current
say "node $(/opt/node/current/bin/node --version), npm $(/opt/node/current/bin/npm --version)"

say "deploy source"
url="$(git -C "$REPO" remote get-url origin)"
[[ $url =~ ^https:// ]] || die "origin must be an https URL the server can read without credentials (is: $url)"
printf '# Written by bootstrap-host.sh from the checkout it ran from.\nMUJEEB_REPO_URL=%s\n' "$url" > "$DEPLOY_ENV"
chmod 644 "$DEPLOY_ENV"

say "services (installed, not started)"
install -m 644 "$HERE/systemd/mujeeb-telephony.service" /etc/systemd/system/
install -m 644 "$HERE/systemd/mujeeb-healthcheck.service" /etc/systemd/system/
install -m 644 "$HERE/systemd/mujeeb-healthcheck.timer" /etc/systemd/system/
systemctl daemon-reload
systemctl enable mujeeb-telephony >/dev/null 2>&1

say "BOOTSTRAP_OK. Firewall untouched (INPUT below): no SIP or RTP port is open."
iptables -S INPUT
say "Next (README): build-asterisk.sh, setup-asterisk.sh, /etc/mujeeb/mujeeb.env and routes.json, deploy-mujeeb.sh."
