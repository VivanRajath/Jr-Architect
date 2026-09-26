#!/usr/bin/env bash
# Attacks the host from inside a sandbox and reports what got through. Run as the service user.
# Usage: LAN_IP=<windows LAN ip> ROUTER_IP=<router ip> bash adversarial.sh [existing sandbox container]
set -uo pipefail
export XDG_RUNTIME_DIR=/run/user/$(id -u)

ATTACKER=${1:-}
LAN_IP=${LAN_IP:-}
ROUTER_IP=${ROUTER_IP:-}
WSL_IP=$(ip -4 -o addr show eth0 | awk '{print $4}' | cut -d/ -f1)
WIN_GW=$(ip -4 route show default | awk '{print $3}')
DNS_IP=$(awk '/^nameserver/{print $2; exit}' /etc/resolv.conf)
IMAGE=${IMAGE:-sandbox-react}
FLAGS=(--security-opt no-new-privileges --cap-drop NET_RAW --cap-drop MKNOD --cap-drop SYS_CHROOT
       --cap-drop AUDIT_WRITE --cap-drop SETFCAP --memory 512m --pids-limit 100 --label jrarch.sandbox=jr-probe)

PASSED=0 FAILED=0
blocked() { # name, command that must fail inside the attacker
  if podman exec "$ATTACKER" sh -c "$2" >/dev/null 2>&1; then echo "  FAIL  reachable: $1"; FAILED=$((FAILED+1)); else echo "  PASS  blocked: $1"; PASSED=$((PASSED+1)); fi
}
works() { # name, command that must succeed inside the attacker
  if podman exec "$ATTACKER" sh -c "$2" >/dev/null 2>&1; then echo "  PASS  works: $1"; PASSED=$((PASSED+1)); else echo "  FAIL  broken: $1"; FAILED=$((FAILED+1)); fi
}
host_denied() { # name, command that must fail for the service user itself (a post-escape position)
  if sh -c "$2" >/dev/null 2>&1; then echo "  FAIL  host allows: $1"; FAILED=$((FAILED+1)); else echo "  PASS  host denies: $1"; PASSED=$((PASSED+1)); fi
}
# A bare TCP connect: services like SMB or DNS never answer HTTP, and curl would call them unreachable.
tcp() { local h=${1%:*} p=${1##*:}; echo "node -e \"const s=require('net').connect($p,'$h');s.on('connect',()=>process.exit(0));s.on('error',()=>process.exit(1));setTimeout(()=>process.exit(1),5000)\""; }

# Canaries make "blocked" mean something: a service is listening there, the sandbox just cannot reach it.
python3 -m http.server 47999 --bind 0.0.0.0 >/dev/null 2>&1 & CANARY_ALL=$!
python3 -m http.server 47998 --bind 127.0.0.1 >/dev/null 2>&1 & CANARY_LO=$!
cleanup() { podman rm -f -v jr-probe-a jr-probe-b >/dev/null 2>&1; kill "$CANARY_ALL" "$CANARY_LO" 2>/dev/null; }
trap cleanup EXIT
podman rm -f -v jr-probe-a jr-probe-b >/dev/null 2>&1
podman run -d --name jr-probe-b "${FLAGS[@]}" -p 127.0.0.1:47002:8080 "$IMAGE" \
  node -e "require('http').createServer((q,s)=>s.end('B')).listen(8080)" >/dev/null
if [ -z "$ATTACKER" ]; then
  ATTACKER=jr-probe-a
  podman run -d --name jr-probe-a "${FLAGS[@]}" -p 127.0.0.1:47001:8080 "$IMAGE" sleep 900 >/dev/null
fi
sleep 3
B_IP=$(podman exec jr-probe-b hostname -i | awk '{print $1}')
echo "attacker=$ATTACKER wsl=$WSL_IP windows-via-wsl=$WIN_GW dns=$DNS_IP lan=${LAN_IP:-?} router=${ROUTER_IP:-?} neighbour=$B_IP"

echo "== normal development must keep working"
works "DNS lookup" "getent hosts registry.npmjs.org"
works "public HTTP" "curl -sf -o /dev/null -m 15 http://example.com/"
works "public HTTPS" "curl -sf -o /dev/null -m 15 https://registry.npmjs.org/"
works "npm registry fetch" "npm view left-pad version --registry https://registry.npmjs.org/"
if podman image exists sandbox-python; then
  if podman run --rm "${FLAGS[@]}" sandbox-python pip install --no-cache-dir --quiet --target /tmp/p six >/dev/null 2>&1; then
    echo "  PASS  works: pip install in a hardened python sandbox"; PASSED=$((PASSED+1))
  else echo "  FAIL  broken: pip install in a hardened python sandbox"; FAILED=$((FAILED+1)); fi
fi

echo "== canary services on the WSL host (listening, so a block is a real block)"
curl -sf -o /dev/null "http://$WSL_IP:47999/" && curl -sf -o /dev/null http://127.0.0.1:47998/ && echo "  (canaries answer from the host itself)"
for h in 10.0.2.2 host.containers.internal "$WSL_IP"; do
  blocked "host service on all interfaces via $h:47999" "$(tcp "$h:47999")"
  blocked "host loopback-only service via $h:47998" "$(tcp "$h:47998")"
done

echo "== Jr-Arch and its agent (meaningful while jrarch.service runs)"
curl -s -o /dev/null -m 3 http://127.0.0.1:9000/health && echo "  (Jr-Arch is listening)" || echo "  (Jr-Arch is not running: these only prove the loopback isolation)"
for h in 127.0.0.1 10.0.2.2 host.containers.internal "$WSL_IP"; do
  blocked "Jr-Arch API at $h:9000" "$(tcp "$h:9000")"
  blocked "agent at $h:8001" "$(tcp "$h:8001")"
done

echo "== another sandbox"
for h in 127.0.0.1 10.0.2.2 host.containers.internal "$WSL_IP"; do
  blocked "neighbour's published port $h:47002" "$(tcp "$h:47002")"
done
blocked "neighbour's own address $B_IP:8080" "$(tcp "$B_IP:8080")"

echo "== WSL host, Windows host, LAN, router, link-local"
blocked "WSL host $WSL_IP:22" "$(tcp "$WSL_IP:22")"
blocked "WSL DNS listener $DNS_IP over HTTP" "$(tcp "$DNS_IP:80")"
for p in 135 445 3389 80; do blocked "Windows host $WIN_GW:$p" "$(tcp "$WIN_GW:$p")"; done
if [ -n "$LAN_IP" ]; then for p in 135 445 80; do blocked "Windows LAN address $LAN_IP:$p" "$(tcp "$LAN_IP:$p")"; done; fi
if [ -n "$ROUTER_IP" ]; then for p in 80 443 53; do blocked "router $ROUTER_IP:$p" "$(tcp "$ROUTER_IP:$p")"; done; fi
blocked "cloud metadata 169.254.169.254:80" "$(tcp 169.254.169.254:80)"

echo "== runtime controls and Windows, from inside the sandbox"
blocked "a container engine socket" "ls /run/podman/podman.sock /var/run/docker.sock /run/user/*/podman/podman.sock"
blocked "DOCKER_HOST in the environment" "env | grep -q DOCKER_HOST"
blocked "the Windows drive" "ls /mnt/c"
blocked "mounting a filesystem" "mount -t tmpfs none /tmp"
blocked "gaining privileges (NoNewPrivs off)" "grep -q 'NoNewPrivs:[[:space:]]*0' /proc/1/status"
blocked "running a Windows program" "printf 'MZ\\220\\000' > /tmp/x.exe && chmod +x /tmp/x.exe && /tmp/x.exe"

echo "== from the service user itself (where a container escape would land)"
host_denied "listing /mnt/c" "ls /mnt/c"
host_denied "reading a Windows file" "head -c1 /mnt/c/Windows/win.ini"
host_denied "running cmd.exe" "/mnt/c/Windows/System32/cmd.exe /c echo pwned"
host_denied "Windows directories on PATH" "echo \"\$PATH\" | grep -q /mnt/"
host_denied "sudo" "sudo -n true"
if df -BM --output=avail /mnt/c >/dev/null 2>&1; then echo "  PASS  disk floor can still measure /mnt/c ($(df -BM --output=avail /mnt/c | tail -1 | tr -d ' '))"; PASSED=$((PASSED+1)); else echo "  FAIL  /mnt/c free space unreadable: the disk floor is blind"; FAILED=$((FAILED+1)); fi

printf '\n%d passed, %d failed\n' "$PASSED" "$FAILED"
[ "$FAILED" = 0 ]
