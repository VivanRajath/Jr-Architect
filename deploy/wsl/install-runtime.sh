#!/usr/bin/env bash
# Installs or upgrades Jr-Arch as a systemd user service. Run as root: bash install-runtime.sh <repo dir> <linux binary> [user]
set -euo pipefail

SRC="${1:?repo directory (the one with sandbox-images/ and agent-services/)}"
BIN="${2:?jr binary built with GOOS=linux}"
JR_USER="${3:-jrarch}"
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

[ "$(id -u)" = 0 ] || die "run as root: after hardening only root can read /mnt/c"
[ -x /usr/local/lib/jrarch/preflight.sh ] || die "run harden.sh first"
JR_UID=$(id -u "$JR_USER")
HOME_DIR=$(getent passwd "$JR_USER" | cut -d: -f6)
APP="$HOME_DIR/app"
as_user() { sudo -u "$JR_USER" XDG_RUNTIME_DIR="/run/user/$JR_UID" DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$JR_UID/bus" "$@"; }

say "Staging the build in $APP"
as_user systemctl --user stop jrarch.service 2>/dev/null || true
mkdir -p "$APP/agent-services" "$HOME_DIR/jrarch/work"
install -m 755 "$BIN" "$APP/jr"
rm -rf "$APP/sandbox-images" && cp -r "$SRC/sandbox-images" "$APP/"
find "$SRC/agent-services" -maxdepth 1 -type f \( -name '*.js' -o -name '*.mjs' -o -name 'package*.json' \) -exec cp {} "$APP/agent-services/" \;
cp "$SRC/deploy/wsl/wsclient.mjs" "$APP/agent-services/" 2>/dev/null || true
# After hardening the service user cannot read /mnt/c, so its tooling lives beside the app.
rm -rf "$APP/deploy" && mkdir -p "$APP/deploy" && cp "$SRC"/deploy/wsl/*.sh "$SRC"/deploy/wsl/*.mjs "$APP/deploy/"
chown -R "$JR_USER:$JR_USER" "$APP" "$HOME_DIR/jrarch"
(cd "$APP/agent-services" && as_user npm ci --no-audit --no-fund --loglevel=error)

ENV="$HOME_DIR/.config/jrarch/jrarch.env"
if [ ! -f "$ENV" ]; then
  say "Writing $ENV (fresh secrets; edit JR_PUBLIC_ORIGIN and your API keys)"
  mkdir -p "$(dirname "$ENV")"
  rnd() { head -c "$1" /dev/urandom | od -An -tx1 | tr -d ' \n'; }
  cat > "$ENV" <<CONF
# Your Tailscale Funnel address, e.g. https://inspiron.tail1234.ts.net
JR_PUBLIC_ORIGIN=https://CHANGE-ME.ts.net
JR_BETA_CODE=$(rnd 6)
JR_SESSION_SECRET=$(rnd 32)
JR_CONTAINER_CLI=podman
DOCKER_HOST=unix:///run/user/$JR_UID/podman/podman.sock
JR_WORK_DIR=$HOME_DIR/jrarch/work
JR_DISK_CHECK_PATHS=/mnt/c
JR_PREVIEW_MODE=quicktunnel
JR_PREHEAT_IMAGES=node,react,python,builder
JR_MAX_SANDBOXES=2
JR_MAX_PER_USER=1
# GROQ_API_KEY=
CONF
fi
chown -R "$JR_USER:$JR_USER" "$(dirname "$ENV")"
chmod 700 "$(dirname "$ENV")"
chmod 600 "$ENV"

install -m 755 "$SRC/deploy/wsl/status.sh" /usr/local/lib/jrarch/status.sh

say "systemd user unit (starts at boot through linger, refuses to start if hardening is off)"
UNIT_DIR="$HOME_DIR/.config/systemd/user"
mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/jrarch.service" <<UNIT
[Unit]
Description=Jr-Arch
Wants=podman.socket
After=podman.socket

[Service]
WorkingDirectory=%h/app
EnvironmentFile=%h/.config/jrarch/jrarch.env
ExecStartPre=/usr/local/lib/jrarch/preflight.sh
ExecStart=%h/app/jr
Restart=always
RestartSec=10
KillMode=control-group
TimeoutStopSec=30

[Install]
WantedBy=default.target
UNIT
chown -R "$JR_USER:$JR_USER" "$HOME_DIR/.config"
as_user systemctl --user daemon-reload
as_user systemctl --user enable jrarch.service >/dev/null

if grep -q 'CHANGE-ME' "$ENV"; then
  echo "Set JR_PUBLIC_ORIGIN in $ENV, then: systemctl --user start jrarch (as $JR_USER)"
else
  as_user systemctl --user restart jrarch.service
  sleep 5
  as_user systemctl --user --no-pager status jrarch.service | head -5
fi
echo "Beta code: $(grep '^JR_BETA_CODE=' "$ENV" | cut -d= -f2)"
