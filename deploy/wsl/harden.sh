#!/usr/bin/env bash
# Locks the jrarch WSL distro down for public use. Run as root after setup-podman.sh: bash harden.sh [user]
set -euo pipefail

JR_USER="${1:-jrarch}"
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }

[ "$(id -u)" = 0 ] || die "run as root"
id "$JR_USER" >/dev/null 2>&1 || die "user $JR_USER does not exist; run setup-podman.sh first"
JR_UID=$(id -u "$JR_USER")
if id -nG "$JR_USER" | grep -qwE 'sudo|admin|wheel'; then die "$JR_USER must not be a sudoer"; fi

say "WSL: no Windows interop, no Windows PATH, C: mounted root-only"
# umask 077 with uid 0 makes every /mnt/<drive> path root-only; statfs on the mount point still works for the disk floor.
cat > /etc/wsl.conf <<CONF
[boot]
systemd=true

[interop]
enabled=false
appendWindowsPath=false

[automount]
enabled=true
options="metadata,uid=0,gid=0,umask=077"

[user]
default=$JR_USER
CONF

say "Podman: slirp4netns without a route to the host's loopback"
cfg="/home/$JR_USER/.config/containers"
mkdir -p "$cfg"
cat > "$cfg/containers.conf" <<CONF
[network]
default_rootless_network_cmd = "slirp4netns"

[engine]
network_cmd_options = ["allow_host_loopback=false", "enable_ipv6=false"]
CONF
chown -R "$JR_USER:$JR_USER" "/home/$JR_USER/.config"

say "Egress firewall for everything $JR_USER runs, sandboxes included"
mkdir -p /usr/local/lib/jrarch
cat > /usr/local/lib/jrarch/egress.sh <<'SCRIPT'
#!/bin/sh
# Rootless sandbox traffic leaves through slirp4netns as the service user, so an owner match covers every container.
set -eu
JR_UID=$(id -u "${1:-jrarch}")
DNS=$(awk '/^nameserver/ && $2 ~ /^[0-9.]+$/ {print $2}' /etc/resolv.conf | paste -sd, -)
[ -n "$DNS" ] || { echo "no IPv4 nameserver in /etc/resolv.conf" >&2; exit 1; }
# The WSL kernel has no nft fib module, so the host's own addresses are listed explicitly.
LOCAL=$(ip -4 -o addr show | awk '{split($4, a, "/"); if (a[1] !~ /^127\./) print a[1]}' | paste -sd, -)
nft -f - <<RULES
table inet jrarch_egress
delete table inet jrarch_egress
table inet jrarch_egress {
  set private4 {
    type ipv4_addr; flags interval
    elements = { 0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12,
                 192.0.0.0/24, 192.0.2.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24,
                 203.0.113.0/24, 224.0.0.0/3 }
  }
  set private6 {
    type ipv6_addr; flags interval
    elements = { ::/128, ::1/128, ::ffff:0:0/96, 64:ff9b::/96, fc00::/7, fe80::/10, ff00::/8 }
  }
  chain out {
    type filter hook output priority 0; policy accept;
    meta skuid != $JR_UID accept
    oif "lo" ip daddr 127.0.0.0/8 accept
    oif "lo" ip6 daddr ::1 accept
    ip daddr { $DNS } meta l4proto { udp, tcp } th dport 53 accept
    ip daddr @private4 counter reject
    ip6 daddr @private6 counter reject
    ip daddr { ${LOCAL:-127.0.0.1} } counter reject
  }
}
RULES
mkdir -p /run/jrarch
nft list table inet jrarch_egress >/dev/null && touch /run/jrarch/egress.ok
SCRIPT
chmod 755 /usr/local/lib/jrarch/egress.sh

cat > /etc/systemd/system/jrarch-harden.service <<UNIT
[Unit]
Description=Jr-Arch egress firewall and interop lockout
After=systemd-binfmt.service network.target
Before=systemd-user-sessions.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/bin/sh -c 'for f in /proc/sys/fs/binfmt_misc/WSLInterop*; do [ -e "\$f" ] && echo -1 > "\$f"; done; true'
ExecStart=/usr/local/lib/jrarch/egress.sh $JR_USER

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable jrarch-harden.service >/dev/null 2>&1
systemctl restart jrarch-harden.service || { journalctl -u jrarch-harden.service --no-pager | tail -8; die "the egress firewall did not load"; }

say "Preflight that the runtime runs before every start"
install -m 755 "$(dirname "$0")/preflight.sh" /usr/local/lib/jrarch/preflight.sh

cat <<DONE

Hardening written. It only fully applies after the distro restarts. From Windows run:
  wsl --terminate <this distro's name>
then check it as $JR_USER:
  /usr/local/lib/jrarch/preflight.sh
DONE
