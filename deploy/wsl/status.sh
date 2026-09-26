#!/bin/sh
# What status.ps1 shows from inside the distro; a file, because PowerShell 5.1 mangles quoted inline scripts.
export XDG_RUNTIME_DIR=/run/user/$(id -u)
[ -S "$XDG_RUNTIME_DIR/podman/podman.sock" ] && echo "podman    : socket up" || echo "podman    : socket missing"
echo "jrarch    : $(systemctl --user is-active jrarch.service)"
echo "health    : $(curl -s -m 5 http://127.0.0.1:9000/health || echo unreachable)"
echo "ready     : $(curl -s -m 10 http://127.0.0.1:9000/ready || echo unreachable)"
