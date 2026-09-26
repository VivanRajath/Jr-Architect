#!/usr/bin/env bash
# Rootless Podman for Jr-Arch on Ubuntu (WSL or bare metal). Run as root: bash setup-podman.sh [user]
set -euo pipefail

JR_USER="${1:-jrarch}"
MIN_FREE_GB="${MIN_FREE_GB:-8}"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "run as root (sudo bash $0 $JR_USER)"
command -v apt-get >/dev/null || die "this script expects Ubuntu/Debian (apt-get not found)"

free_gb=$(df -BG --output=avail / | tail -1 | tr -dc 0-9)
# Under WSL / is a sparse virtual disk that reports ~1TB; the Windows drive holding it is the real limit.
if [ -d /mnt/c ]; then
  win_gb=$(df -BG --output=avail /mnt/c | tail -1 | tr -dc 0-9)
  [ "$win_gb" -lt "$free_gb" ] && free_gb=$win_gb
fi
[ "$free_gb" -ge "$MIN_FREE_GB" ] || die "only ${free_gb}GB free, need at least ${MIN_FREE_GB}GB (images and sandbox workdirs live here)"
say "Disk: ${free_gb}GB free"

# The Podman API socket is a systemd user unit, so WSL has to boot with systemd.
if [ "$(ps -p 1 -o comm=)" != "systemd" ]; then
  if ! grep -qs '^systemd=true' /etc/wsl.conf; then
    printf '[boot]\nsystemd=true\n' >> /etc/wsl.conf
  fi
  die "systemd is not PID 1. It is now enabled in /etc/wsl.conf: run 'wsl --terminate <distro>' from Windows, then rerun this script"
fi

# Rootless Podman silently drops --memory/--cpus/--pids-limit on cgroup v1, which would leave sandboxes unbounded.
if [ "$(stat -fc %T /sys/fs/cgroup)" != "cgroup2fs" ]; then
  die "cgroup v2 is required for sandbox resource limits. On WSL add this to %USERPROFILE%\\.wslconfig on Windows:
    [wsl2]
    kernelCommandLine = cgroup_no_v1=all systemd.unified_cgroup_hierarchy=1
then run 'wsl --shutdown' and rerun this script"
fi

# WSL mounts / private, which breaks some rootless mount propagation; make it shared on every boot.
cat > /etc/systemd/system/jrarch-rshared.service <<'UNIT'
[Unit]
Description=Make / a shared mount for rootless Podman
DefaultDependencies=no
Before=user.slice

[Service]
Type=oneshot
ExecStart=/bin/mount --make-rshared /

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now jrarch-rshared.service >/dev/null

say "Installing Podman and helpers"
apt-get update -qq
DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
  podman uidmap passt slirp4netns fuse-overlayfs dbus-user-session \
  git curl ca-certificates nodejs npm >/dev/null

# Distro Node can be too old for agent-services, so fall back to the official Node 22 LTS tarball, checksum-verified.
node_major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$node_major" -lt 20 ]; then
  say "Node $node_major is too old, installing Node 22 LTS from nodejs.org"
  case "$(dpkg --print-architecture)" in amd64) narch=x64 ;; arm64) narch=arm64 ;; *) die "no Node build for $(dpkg --print-architecture)" ;; esac
  base=https://nodejs.org/dist/latest-v22.x
  sums=$(curl -fsSL "$base/SHASUMS256.txt")
  file=$(echo "$sums" | awk -v a="linux-$narch.tar.xz" '$2 ~ a"$" {print $2; exit}')
  [ -n "$file" ] || die "could not find a Node 22 build for linux-$narch"
  curl -fsSL -o "/tmp/$file" "$base/$file"
  (cd /tmp && echo "$sums" | grep " $file\$" | sha256sum -c -) || die "Node download failed its checksum"
  tar -xJf "/tmp/$file" -C /usr/local --strip-components=1
  rm -f "/tmp/$file"
  hash -r
  node_major=$(node -p 'process.versions.node.split(".")[0]')
fi
[ "$node_major" -ge 20 ] || die "Node $node_major is still too old for agent-services"
echo "Node $(node --version)"

say "Service user: $JR_USER"
id "$JR_USER" >/dev/null 2>&1 || useradd -m -s /bin/bash "$JR_USER"
JR_UID=$(id -u "$JR_USER")
grep -q "^$JR_USER:" /etc/subuid || usermod --add-subuids 100000-165535 "$JR_USER"
grep -q "^$JR_USER:" /etc/subgid || usermod --add-subgids 100000-165535 "$JR_USER"

# Rootless --cpus needs the cpu controller delegated to user sessions; memory and pids usually are already.
mkdir -p /etc/systemd/system/user@.service.d
printf '[Service]\nDelegate=cpu cpuset io memory pids\n' > /etc/systemd/system/user@.service.d/delegate.conf
systemctl daemon-reload

say "Starting $JR_USER's user session and the Podman socket"
loginctl enable-linger "$JR_USER"
systemctl restart "user@${JR_UID}.service"
for _ in $(seq 1 30); do [ -S "/run/user/$JR_UID/bus" ] && break; sleep 1; done
[ -S "/run/user/$JR_UID/bus" ] || die "the user session for $JR_USER did not start"
as_user() {
  sudo -u "$JR_USER" XDG_RUNTIME_DIR="/run/user/$JR_UID" \
    DBUS_SESSION_BUS_ADDRESS="unix:path=/run/user/$JR_UID/bus" "$@"
}
as_user systemctl --user enable --now podman.socket >/dev/null
SOCK="/run/user/$JR_UID/podman/podman.sock"
for _ in $(seq 1 10); do [ -S "$SOCK" ] && break; sleep 1; done
[ -S "$SOCK" ] || die "podman.socket did not create $SOCK"

say "Installing cloudflared"
arch=$(dpkg --print-architecture)
if ! command -v cloudflared >/dev/null; then
  curl -fsSL -o /usr/local/bin/cloudflared "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-${arch}"
  chmod +x /usr/local/bin/cloudflared
fi
cloudflared --version

say "Verifying"
as_user podman info --format 'rootless={{.Host.Security.Rootless}} network={{.Host.NetworkBackend}} cgroups={{.Host.CgroupsVersion}} controllers={{.Host.CgroupControllers}}'
as_user podman ps >/dev/null && echo "podman ps: ok"
as_user podman run --rm docker.io/library/alpine:3 echo "podman run: ok"
[ "$(as_user curl -s --unix-socket "$SOCK" http://d/_ping)" = "OK" ] || die "the API socket did not answer /_ping"
echo "API socket: ok"

cat <<ENV

Setup complete. Add these to Jr-Arch's environment (.env or the systemd unit):

  JR_CONTAINER_CLI=podman
  DOCKER_HOST=unix://$SOCK
  JR_WORK_DIR=/home/$JR_USER/jrarch/work
  JR_PREHEAT_IMAGES=node,react,python,builder

Images are built by Jr-Arch itself at startup (JR_PREHEAT_IMAGES) or on first use.
ENV
