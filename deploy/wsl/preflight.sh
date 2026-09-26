#!/usr/bin/env bash
# Refuses to let Jr-Arch start unless every hardening control is actually in force. Runs as the service user.
set -uo pipefail

bad=0
ok() { printf 'ok    %s\n' "$*"; }
no() { printf 'FAIL  %s\n' "$*" >&2; bad=1; }

[ "$(stat -fc %T /sys/fs/cgroup)" = "cgroup2fs" ] && ok "cgroup v2" || no "cgroup v1: sandbox limits would be ignored"

if ls /proc/sys/fs/binfmt_misc/WSLInterop* >/dev/null 2>&1; then
  no "Windows interop is registered: a process here could launch Windows programs"
else
  ok "Windows interop off"
fi

case ":$PATH:" in *:/mnt/*) no "PATH still contains Windows directories" ;; *) ok "no Windows PATH" ;; esac

# Windows drives are the 9p/drvfs mounts; /mnt/wsl only carries a shared resolv.conf.
while read -r _ mnt fstype opts _; do
  case "$fstype:$opts" in 9p:*drvfs*|drvfs:*) ;; *) continue ;; esac
  if ls "$mnt" >/dev/null 2>&1; then no "Windows drive $mnt is readable by $(id -un)"; else ok "Windows drive $mnt not readable"; fi
done < /proc/mounts

# WSLg bridges X11/Wayland, audio and the clipboard to the Windows desktop.
if ls /mnt/wslg/.X11-unix/X* /mnt/wslg/runtime-dir/wayland-* >/dev/null 2>&1; then
  no "WSLg display sockets exist (set guiApplications=false in .wslconfig)"
else
  ok "no WSLg display bridge"
fi

[ -e /run/jrarch/egress.ok ] && ok "egress firewall loaded this boot" || no "egress firewall not loaded (/run/jrarch/egress.ok missing)"

conf="$HOME/.config/containers/containers.conf"
if grep -qs 'allow_host_loopback=false' "$conf" && grep -qs 'slirp4netns' "$conf"; then
  ok "sandboxes cannot reach the host's loopback"
else
  no "$conf does not pin slirp4netns with allow_host_loopback=false"
fi

sock="${XDG_RUNTIME_DIR:-/run/user/$(id -u)}/podman/podman.sock"
[ -S "$sock" ] && ok "podman socket" || no "podman socket missing at $sock"

if id -nG | grep -qwE 'sudo|admin|wheel'; then no "$(id -un) is a sudoer"; else ok "not a sudoer"; fi

exit $bad
