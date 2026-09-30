#!/usr/bin/env bash
# End-to-end check of Jr-Arch on real rootless Podman. Run as the service user after setup-podman.sh: bash validate.sh
set -uo pipefail

APP=${APP:-$HOME/app}
WORK=$HOME/jrarch/work
B=http://127.0.0.1:9000
ORIGIN=http://localhost:9000
REPO_A=${REPO_A:-https://github.com/VivanRajath/React-Portfolio}
REPO_B=${REPO_B:-https://github.com/octocat/Spoon-Knife}
HERE=$(cd "$(dirname "$0")" && pwd)
export XDG_RUNTIME_DIR=/run/user/$(id -u) DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$(id -u)/bus

RESULTS=()
pass() { RESULTS+=("PASS  $*"); echo "  PASS  $*"; }
fail() { RESULTS+=("FAIL  $*"); echo "  FAIL  $*"; }
info() { RESULTS+=("INFO  $*"); echo "  INFO  $*"; }
check() { local name=$1; shift; if "$@" >/dev/null 2>&1; then pass "$name"; else fail "$name"; fi; }
phase() { printf '\n=== %s\n' "$*"; }
json() { python3 -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
print($1)" 2>/dev/null; }

start_server() {
  systemctl --user stop jr-validate 2>/dev/null
  systemctl --user reset-failed jr-validate 2>/dev/null
  cat > "$APP/validate.env" <<ENV
JR_CONTAINER_CLI=podman
DOCKER_HOST=unix://$XDG_RUNTIME_DIR/podman/podman.sock
JR_WORK_DIR=$WORK
JR_PREHEAT_IMAGES=react
JR_PUBLIC_ORIGIN=$ORIGIN
JR_PREVIEW_MODE=quicktunnel
JR_BETA_CODE=validate-code
JR_SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')
JR_MAX_SANDBOXES=2
JR_MAX_PER_USER=1
ENV
  for kv in "$@"; do echo "$kv" >> "$APP/validate.env"; done
  systemd-run --user --unit=jr-validate --collect -p WorkingDirectory="$APP" -p EnvironmentFile="$APP/validate.env" "$APP/jr" >/dev/null
  for _ in $(seq 1 60); do
    code=$(curl -s -o /dev/null -w '%{http_code}' $B/health)
    [ "$code" = 200 ] && return 0
    [ "$code" = 503 ] && [ -n "${ALLOW_503:-}" ] && return 0
    sleep 2
  done
  return 1
}

login() { curl -s -c "$1" -o /dev/null -w '%{http_code}' -X POST -H 'X-Jr: 1' -H 'Content-Type: application/json' -d '{"code":"validate-code"}' $B/auth/login; }
api() { curl -s -b "$1" -X "$2" -H 'X-Jr: 1' -H 'Content-Type: application/json' ${4:+-d "$4"} "$B$3"; }
code() { curl -s -o /dev/null -w '%{http_code}' -b "$1" -X "$2" -H 'X-Jr: 1' -H 'Content-Type: application/json' ${4:+-d "$4"} "$B$3"; }
cookie() { awk '$6=="jr_session"{print $6"="$7}' "$1"; }
status() { api "$1" GET "/sandbox/status?container=$2"; }
workdir() { echo "$WORK/${1#sandbox-}"; }
tunnels() { pgrep -c -x cloudflared || true; }

# Waits until the app answers and its preview tunnel is published.
# A 4th/5th arg keeps another sandbox active meanwhile, so the idle TTL does not reap it mid-test.
wait_running() {
  local jar=$1 c=$2 limit=$3 keepjar=${4:-} keep=${5:-} start=$SECONDS s url
  while [ $((SECONDS - start)) -lt "$limit" ]; do
    [ -n "$keep" ] && api "$keepjar" GET "/files?container=$keep" >/dev/null
    s=$(status "$jar" "$c")
    url=$(echo "$s" | json "d.get('url','')")
    case "$(echo "$s" | json "d.get('status','')")" in
      running) [ -n "$url" ] && { echo "    ready in $((SECONDS - start))s: $url"; return 0; } ;;
      failed) echo "    failed: $(echo "$s" | json "d.get('error','')")"; return 1 ;;
    esac
    [ $(((SECONDS - start) % 60)) -lt 10 ] && echo "    $((SECONDS - start))s: $(echo "$s" | json "d.get('status','')") url=${url:-none}"
    sleep 10
  done
  return 1
}

in_sandbox() { podman exec "$1" sh -c "$2" 2>&1; }

phase "0. clean slate"
# Node resolves "ws" from the script's own directory, so the probe has to sit beside agent-services/node_modules.
cp "$HERE/wsclient.mjs" "$HERE/reload.mjs" "$APP/agent-services/"
WSC="$APP/agent-services/wsclient.mjs"
# The installed service owns :9000; it is paused for the run and restarted at the end.
systemctl --user stop jrarch.service 2>/dev/null
trap 'systemctl --user stop jr-validate 2>/dev/null; systemctl --user is-enabled -q jrarch.service 2>/dev/null && systemctl --user start jrarch.service' EXIT
systemctl --user stop jr-validate 2>/dev/null
podman rm -f -v $(podman ps -aq --filter label=jrarch.sandbox) >/dev/null 2>&1
podman rmi -f sandbox-static >/dev/null 2>&1
mkdir -p "$WORK" && find "$WORK" -mindepth 1 -maxdepth 1 -exec rm -rf {} +
info "podman $(podman --version | awk '{print $3}'), network backend $(podman info --format '{{.Host.NetworkBackend}}'), rootless net $(podman info --format '{{.Host.Slirp4NetNS.Executable}}{{.Host.Pasta.Executable}}' 2>/dev/null)"

phase "1. server on podman"
if start_server; then pass "server started, /health 200 (podman socket + agent)"; else fail "server did not become healthy"; journalctl --user -u jr-validate --no-pager | tail -30; exit 1; fi
info "health: $(curl -s $B/health)"
check "preheated sandbox-react exists (built at startup)" bash -c 'for i in $(seq 1 90); do podman image exists sandbox-react && exit 0; sleep 10; done; exit 1'
check "sandbox-static not preheated (so it must build lazily)" bash -c '! podman image exists sandbox-static'

phase "2. sandbox A: $REPO_A"
JA=$(mktemp) JB=$(mktemp)
[ "$(login "$JA")" = 200 ] && [ "$(login "$JB")" = 200 ] && pass "two testers logged in" || fail "login"
CA=$(api "$JA" POST /run "{\"repo\":\"$REPO_A\",\"autoApprove\":true}" | json "d.get('container','')")
[ -n "$CA" ] && pass "sandbox created: $CA" || fail "sandbox not created"
if wait_running "$JA" "$CA" 1800; then pass "A running with a preview URL (clone, image, npm install, dev server)"; else fail "A never came up"; podman logs --tail 40 "$CA"; fi
SA=$(status "$JA" "$CA")
URL_A=$(echo "$SA" | json "d.get('url','')")
PORT_A=$(echo "$SA" | json "d['services'][0]['port']")
WA=$(workdir "$CA")
check "container is labelled jrarch.sandbox" bash -c "podman ps --filter label=jrarch.sandbox=$CA --format '{{.Names}}' | grep -qx $CA"
check "workdir bind-mounted at /workspace" bash -c "podman inspect $CA --format '{{range .Mounts}}{{.Source}}={{.Destination}} {{end}}' | grep -q '$WA=/workspace'"
check "npm install populated node_modules" test -d "$WA/node_modules/react"
info "node_modules owner on host: $(stat -c %U:%G "$WA/node_modules" 2>/dev/null)"
info "limits in container: mem=$(in_sandbox "$CA" 'cat /sys/fs/cgroup/memory.max') cpu=$(in_sandbox "$CA" 'cat /sys/fs/cgroup/cpu.max') pids=$(in_sandbox "$CA" 'cat /sys/fs/cgroup/pids.max')"
check "memory limit enforced" bash -c "[ \"\$(podman exec $CA cat /sys/fs/cgroup/memory.max)\" != max ]"
check "no-new-privileges set" bash -c "podman exec $CA grep -q 'NoNewPrivs:[[:space:]]*1' /proc/1/status"
check "NET_RAW dropped" bash -c "! podman exec $CA grep CapBnd /proc/1/status | grep -q 00000000a80425fb"
OUT=$(api "$JA" POST /terminal/exec "{\"container\":\"$CA\",\"command\":\"echo JRMARK \$(id -u) \$(node -v)\"}")
echo "$OUT" | grep -q 'JRMARK 0 v' && pass "terminal exec: $(echo "$OUT" | json "d['output'].strip()")" || fail "terminal exec: $OUT"
WS=$(node "$WSC" "ws://127.0.0.1:9000/terminal/ws?container=$CA" "$ORIGIN" "$(cookie "$JA")" $'echo JRMARK\n')
echo "$WS" | grep -q JRMARK && pass "interactive terminal over WebSocket via podman API socket" || fail "terminal websocket: $WS"
check "host -> sandbox on 127.0.0.1:$PORT_A" bash -c "curl -sf -o /dev/null http://127.0.0.1:$PORT_A"
BODY=$(curl -s -m 20 "$URL_A")
echo "$BODY" | grep -q 'id="root"' && pass "preview through Cloudflare quick tunnel serves the CRA app" || fail "preview body: ${BODY:0:200}"
HA=${URL_A#https://}; HA=${HA%/}
WSP=$(node "$WSC" "wss://$HA/ws" "https://$HA")
case "$WSP" in ""|TIMEOUT*|ERROR*|HTTP*) fail "dev-server WebSocket through preview: $WSP" ;; *) pass "dev-server (HMR) WebSocket through preview: ${WSP:0:80}" ;; esac
RL=$(node "$APP/agent-services/reload.mjs" "wss://$HA/ws" "https://$HA" "$B" "$(cookie "$JA")" "$CA" src/App.js)
case "$RL" in RELOADED*) pass "live reload: saving through the IDE rebuilt the app (${RL:0:60})" ;; *) fail "live reload: $RL" ;; esac
check "IDE API is not reachable through the preview host" bash -c "! curl -s -m 10 https://$HA/sandboxes | grep -q 'login required'"
[ "$(code "$JA" POST /run "{\"repo\":\"$REPO_B\"}")" = 429 ] && pass "second sandbox for the same tester -> 429" || fail "per-user limit"

phase "3. sandbox B (other tester, lazy image build): $REPO_B"
CB=$(api "$JB" POST /run "{\"repo\":\"$REPO_B\",\"autoApprove\":true}" | json "d.get('container','')")
if wait_running "$JB" "$CB" 900 "$JA" "$CA"; then pass "B running with a preview URL"; else fail "B never came up"; podman logs --tail 40 "$CB"; fi
check "sandbox-static was built on first use" podman image exists sandbox-static
PORT_B=$(status "$JB" "$CB" | json "d['services'][0]['port']")
[ "$(code "$JB" GET "/sandbox/status?container=$CA")" = 404 ] && pass "tester B gets 404 for A's sandbox" || fail "ownership"
JC=$(mktemp); login "$JC" >/dev/null
GC=$(curl -s -w ' %{http_code}' -b "$JC" -X POST -H 'X-Jr: 1' -H 'Content-Type: application/json' -d "{\"repo\":\"$REPO_B\"}" $B/run | tr -d '
')
case "$GC" in *" 429") pass "third tester while A and B run: global cap (2) -> 429" ;; *) fail "global cap: $GC"; api "$JC" POST "/stop/$(echo "${GC% *}" | json "d.get('container','')")" >/dev/null ;; esac

phase "4. networking (from inside A unless noted)"
IP_B=$(in_sandbox "$CB" 'hostname -i' | awk '{print $1}')
probe() { in_sandbox "$CA" "curl -s -o /dev/null -m 6 -w '%{http_code}' $1 || echo unreachable"; }
info "sandbox -> internet (https://example.com): $(probe https://example.com)"
info "host -> sandbox B (127.0.0.1:$PORT_B): $(curl -s -o /dev/null -m 6 -w '%{http_code}' http://127.0.0.1:$PORT_B)"
info "sandbox A -> B's published port via 127.0.0.1:$PORT_B: $(probe http://127.0.0.1:$PORT_B)"
info "sandbox A -> B's published port via host.containers.internal:$PORT_B: $(probe http://host.containers.internal:$PORT_B)"
info "sandbox A -> B's container address $IP_B:80: $(probe http://$IP_B:80)"
info "sandbox A -> Jr-Arch API 127.0.0.1:9000: $(probe http://127.0.0.1:9000/health)"
info "sandbox A -> Jr-Arch API host.containers.internal:9000: $(probe http://host.containers.internal:9000/health)"
info "sandbox A -> agent 127.0.0.1:8001: $(probe http://127.0.0.1:8001/agent/health)"
info "preview tunnel -> sandbox: covered by the preview checks above"

phase "5. tunnel process dies while the sandbox runs"
before=$(tunnels)
OLD_URL=$(status "$JA" "$CA" | json "d.get('url','')")
pkill -o -x cloudflared
code_after=000 NEW_URL=""
for _ in $(seq 1 24); do
  sleep 5
  api "$JB" GET "/files?container=$CB" >/dev/null
  NEW_URL=$(status "$JA" "$CA" | json "d.get('url','')")
  [ -n "$NEW_URL" ] && [ "$NEW_URL" != "$OLD_URL" ] && code_after=$(curl -s -o /dev/null -m 15 -w '%{http_code}' "$NEW_URL") && [ "$code_after" = 200 ] && break
done
info "cloudflared before=$before after=$(tunnels); old $OLD_URL -> new ${NEW_URL:-none} answers $code_after"
[ "$code_after" = 200 ] && pass "preview replaced after its tunnel process exited" || fail "preview stays dead after its tunnel process exited ($code_after)"

phase "6. destroy"
for pair in "$JA $CA" "$JB $CB"; do
  set -- $pair
  api "$1" POST "/stop/$2" >/dev/null
  check "stop $2: container removed" bash -c "! podman container exists $2"
  check "stop $2: workdir removed" test ! -e "$(workdir "$2")"
done
sleep 3
check "no labelled containers left" bash -c "[ -z \"\$(podman ps -aq --filter label=jrarch.sandbox)\" ]"
check "no cloudflared processes left" bash -c "[ \"\$(pgrep -c -x cloudflared)\" = 0 ]"
info "volumes left: $(podman volume ls --format '{{.Name}}' | tr '\n' ' ') (named caches are expected)"
check "no anonymous volumes left" bash -c "! podman volume ls --format '{{.Name}}' | grep -Eq '^[0-9a-f]{64}$'"
info "networks: $(podman network ls --format '{{.Name}}' | tr '\n' ' ')"
info "work dir now holds: $(ls -A "$WORK" | tr '\n' ' ')"

phase "7. failed clone cleans up"
CF=$(api "$JA" POST /run '{"repo":"https://github.com/octocat/this-repo-does-not-exist-jrarch","autoApprove":true}' | json "d.get('container','')")
sleep 15
[ "$(status "$JA" "$CF" | json "d.get('status','')")" = failed ] && pass "missing repo -> status failed" || fail "failed clone status"
check "failed clone started no container" bash -c "! podman container exists $CF"
api "$JA" POST "/stop/$CF" >/dev/null
check "failed sandbox workdir removed on stop" test ! -e "$(workdir "$CF")"

phase "8. startup reaper on real podman"
podman run -d --name jr-orphan --label jrarch.sandbox=jr-orphan docker.io/library/alpine:3 sleep 600 >/dev/null
mkdir -p "$WORK/sandbox-999999" && podman unshare sh -c "touch '$WORK/sandbox-999999/owned-by-subuid' && chown 1000:1000 '$WORK/sandbox-999999/owned-by-subuid'"
info "orphan file owner on host: $(stat -c %u "$WORK/sandbox-999999/owned-by-subuid")"
start_server || fail "restart"
check "orphaned labelled container removed at startup" bash -c "! podman container exists jr-orphan"
check "orphaned workdir with subuid-owned files removed (podman unshare)" test ! -e "$WORK/sandbox-999999"

phase "9. disk floor (simulated with an impossible floor, nothing is filled)"
ALLOW_503=1 start_server JR_MIN_FREE_DISK_MB=99999999 JR_DISK_CHECK_PATHS=/mnt/c || fail "restart with disk floor"
[ "$(curl -s -o /dev/null -w '%{http_code}' $B/health)" = 200 ] && pass "/health (liveness) stays 200 below the floor" || fail "/health went down for a capacity problem"
H=$(curl -s -w ' %{http_code}' $B/ready | tr -d '
')
info "ready under the floor: $H"
case "$H" in *"free-disk floor"*" 503") pass "/ready reports 503 with the disk-floor reason" ;; *) fail "/ready below the floor: $H" ;; esac
WIN=$(df -BM --output=avail /mnt/c | tail -1 | tr -dc 0-9)
POOL=$(df -BM --output=avail "$WORK" | tail -1 | tr -dc 0-9)
# The server reports the tightest checked path: the workdir pool when there is one, else the Windows drive.
WANT=$(( POOL < WIN ? POOL : WIN ))
HD=$(echo "${H% *}" | json "d.get('diskFreeMB')")
[ -n "$HD" ] && [ $((HD - WANT)) -le 64 ] && [ $((WANT - HD)) -le 64 ] && pass "disk check reports the tightest real limit (${HD}MB; pool ${POOL}MB, Windows ${WIN}MB), not the sparse WSL disk" || fail "disk check reported ${HD}MB, expected ~${WANT}MB (pool ${POOL}MB, Windows ${WIN}MB)"
login "$JA" >/dev/null
R=$(curl -s -w ' %{http_code}' -b "$JA" -X POST -H 'X-Jr: 1' -H 'Content-Type: application/json' -d "{\"repo\":\"$REPO_B\"}" $B/run | tr -d '
')
echo "$R" | grep -q 'low on disk.* 429$' && pass "new sandbox below the floor -> 429 ($R)" || fail "disk floor: $R"
check "nothing was created below the floor" bash -c "[ -z \"\$(ls -A $WORK | grep -v jr-agent-homes)\" ]"

systemctl --user stop jr-validate
printf '\n=== RESULTS\n'
printf '%s\n' "${RESULTS[@]}"
printf '\n%d passed, %d failed\n' "$(printf '%s\n' "${RESULTS[@]}" | grep -c '^PASS')" "$(printf '%s\n' "${RESULTS[@]}" | grep -c '^FAIL')"
