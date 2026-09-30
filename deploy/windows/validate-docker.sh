#!/usr/bin/env bash
# End-to-end check of Jr-Arch on Docker Desktop (the default JR_CONTAINER_CLI), run from Git Bash in the repo root.
# Usage: CLOUDFLARED=/path/to/cloudflared.exe WORK=/path/to/workdir bash deploy/windows/validate-docker.sh
set -uo pipefail

REPO=$(pwd)
WORK=${WORK:?set WORK to an empty scratch directory}
CLOUDFLARED=${CLOUDFLARED:?set CLOUDFLARED to cloudflared.exe}
PORT=9200 AGENT=8201
B=http://127.0.0.1:$PORT ORIGIN=http://localhost:$PORT
REPO_A=https://github.com/VivanRajath/React-Portfolio REPO_B=https://github.com/octocat/Spoon-Knife
P=0 F=0
pass() { echo "  PASS  $*"; P=$((P+1)); }
fail() { echo "  FAIL  $*"; F=$((F+1)); }
info() { echo "  INFO  $*"; }
phase() { printf '\n=== %s\n' "$*"; }
json() { python -c "import sys,json
try: d=json.load(sys.stdin)
except Exception: d={}
print($1)" 2>/dev/null; }
login() { curl -s -c "$1" -o /dev/null -w '%{http_code}' -X POST -H 'X-Jr: 1' -H 'Content-Type: application/json' -d '{"code":"docker-validate"}' $B/auth/login; }
api() { curl -s -b "$1" -X "$2" -H 'X-Jr: 1' -H 'Content-Type: application/json' ${4:+-d "$4"} "$B$3"; }
code() { curl -s -o /dev/null -w '%{http_code}' -b "$1" -X "$2" -H 'X-Jr: 1' -H 'Content-Type: application/json' ${4:+-d "$4"} "$B$3"; }
cookie() { awk '$6=="jr_session"{print $6"="$7}' "$1"; }
status() { api "$1" GET "/sandbox/status?container=$2"; }
workdir() { echo "$WORK/${1#sandbox-}"; }
tunnels() { tasklist //FI "IMAGENAME eq cloudflared.exe" 2>/dev/null | grep -c cloudflared.exe; }

JR_PID=""
start_jr() {
  (cd "$REPO" && env JR_LISTEN_ADDR=127.0.0.1:$PORT AGENT_PORT=$AGENT JR_PUBLIC_ORIGIN=$ORIGIN JR_PREVIEW_MODE=quicktunnel \
    JR_CLOUDFLARED="$CLOUDFLARED" JR_BETA_CODE=docker-validate JR_SESSION_SECRET=$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n') \
    JR_WORK_DIR="$WORK" JR_PREHEAT_IMAGES=react JR_MAX_SANDBOXES=2 JR_MAX_PER_USER=1 ./jr-docker-test.exe >> "$WORK/../jr-docker.log" 2>&1 &
    echo $! > "$WORK/../jr.pid")
  JR_PID=$(cat "$WORK/../jr.pid")
  for _ in $(seq 1 90); do [ "$(curl -s -o /dev/null -w '%{http_code}' $B/ready)" = 200 ] && return 0; sleep 2; done
  return 1
}
# Kills jr and its agent child together, the way a crash takes the whole process tree down.
# $! is the MSYS env wrapper, not jr.exe, so the listener on the port is what gets killed.
kill_jr() {
  local p
  for p in $(netstat -ano | awk -v a="127.0.0.1:$PORT" '$2 == a && $4 == "LISTENING" {print $5}' | sort -u); do
    taskkill //F //T //PID "$p" >/dev/null 2>&1
  done
  sleep 2
}
wait_running() {
  local jar=$1 c=$2 limit=$3 keepjar=${4:-} keep=${5:-} start=$SECONDS s url
  while [ $((SECONDS - start)) -lt "$limit" ]; do
    [ -n "$keep" ] && api "$keepjar" GET "/files?container=$keep" >/dev/null
    s=$(status "$jar" "$c"); url=$(echo "$s" | json "d.get('url') or ''")
    case "$(echo "$s" | json "d.get('status','')")" in
      running) [ -n "$url" ] && { echo "    ready in $((SECONDS - start))s"; return 0; } ;;
      failed) echo "    failed: $(echo "$s" | json "d.get('error','')")"; return 1 ;;
    esac
    sleep 10
  done
  return 1
}

phase "0. clean slate on Docker Desktop"
docker version --format 'engine {{.Server.Version}}' || { echo "Docker is not running"; exit 1; }
docker rm -f -v $(docker ps -aq --filter label=jrarch.sandbox) >/dev/null 2>&1
docker rmi -f sandbox-react sandbox-static >/dev/null 2>&1
rm -rf "$WORK" && mkdir -p "$WORK" && : > "$WORK/../jr-docker.log"
go build -o jr-docker-test.exe . || { echo "build failed"; exit 1; }
cp deploy/wsl/wsclient.mjs deploy/wsl/reload.mjs agent-services/
trap 'kill_jr; rm -f agent-services/wsclient.mjs agent-services/reload.mjs jr-docker-test.exe' EXIT

phase "1. server on Docker (default JR_CONTAINER_CLI)"
start_jr && pass "server up, /ready 200 (docker engine + agent)" || { fail "server not ready"; tail -20 "$WORK/../jr-docker.log"; exit 1; }
for _ in $(seq 1 60); do docker image inspect sandbox-react >/dev/null 2>&1 && break; sleep 10; done
docker image inspect sandbox-react >/dev/null 2>&1 && pass "sandbox-react rebuilt from the current Dockerfile at startup" || fail "sandbox-react not built"
docker image inspect sandbox-static >/dev/null 2>&1 && fail "sandbox-static should not be preheated" || pass "sandbox-static not preheated"
grep -q "jr-sandbox" <(docker network ls --format '{{.Name}}') && pass "jr-sandbox network exists" || fail "jr-sandbox network missing"
docker network inspect jr-sandbox --format '{{index .Options "com.docker.network.bridge.enable_icc"}}' | grep -q false && pass "jr-sandbox has inter-container traffic off" || fail "icc not disabled"

phase "2. sandbox A: $REPO_A"
JA=$(mktemp) JB=$(mktemp) JC=$(mktemp)
[ "$(login "$JA")" = 200 ] && [ "$(login "$JB")" = 200 ] && pass "two testers logged in" || fail "login"
CA=$(api "$JA" POST /run "{\"repo\":\"$REPO_A\",\"autoApprove\":true}" | json "d.get('container','')")
[ -n "$CA" ] && pass "sandbox created: $CA" || fail "no sandbox"
wait_running "$JA" "$CA" 1800 && pass "A running with a preview URL (clone, npm install, dev server, tunnel)" || { fail "A never came up"; docker logs --tail 30 "$CA"; }
SA=$(status "$JA" "$CA"); URL_A=$(echo "$SA" | json "d.get('url') or ''"); PORT_A=$(echo "$SA" | json "d['services'][0]['port']")
HA=${URL_A#https://}; HA=${HA%/}
[ -d "$(workdir "$CA")/node_modules/react" ] && pass "npm install populated node_modules" || fail "node_modules missing"
I=$(docker inspect "$CA" --format '{{.HostConfig.SecurityOpt}} {{.HostConfig.CapDrop}} {{.HostConfig.Memory}} {{.HostConfig.NetworkMode}} {{index .Config.Labels "jrarch.sandbox"}}')
info "container: $I"
for want in no-new-privileges NET_RAW jr-sandbox "$CA"; do echo "$I" | grep -q -- "$want" && pass "hardening present: $want" || fail "missing: $want"; done
OUT=$(api "$JA" POST /terminal/exec "{\"container\":\"$CA\",\"command\":\"echo JRMARK \$(node -v)\"}")
echo "$OUT" | grep -q 'JRMARK v' && pass "terminal exec" || fail "terminal exec: $OUT"
WS=$(node agent-services/wsclient.mjs "ws://127.0.0.1:$PORT/terminal/ws?container=$CA" "$ORIGIN" "$(cookie "$JA")" $'echo JRMARK\n')
echo "$WS" | grep -q JRMARK && pass "interactive terminal over WebSocket (Docker Engine SDK)" || fail "terminal websocket: $WS"
curl -sf -o /dev/null "http://127.0.0.1:$PORT_A" && pass "host -> sandbox on 127.0.0.1:$PORT_A" || fail "host -> sandbox"
curl -s -m 20 "$URL_A" | grep -q 'id="root"' && pass "preview through Cloudflare serves the app" || fail "preview"
HMR=$(node agent-services/wsclient.mjs "wss://$HA/ws" "https://$HA")
case "$HMR" in *'"type"'*) pass "dev-server WebSocket through preview" ;; *) fail "preview websocket: $HMR" ;; esac
RL=$(node agent-services/reload.mjs "wss://$HA/ws" "https://$HA" "$B" "$(cookie "$JA")" "$CA" src/App.js)
case "$RL" in RELOADED*) pass "live reload after saving through the IDE" ;; *) fail "live reload: $RL" ;; esac
curl -s -m 10 "https://$HA/sandboxes" | grep -q 'login required' && fail "preview host reached the IDE API" || pass "preview host does not expose the IDE API"
[ "$(code "$JA" POST /run "{\"repo\":\"$REPO_B\"}")" = 429 ] && pass "second sandbox for the same tester -> 429" || fail "per-user limit"

phase "3. sandbox B (lazy image build), isolation"
CB=$(api "$JB" POST /run "{\"repo\":\"$REPO_B\",\"autoApprove\":true}" | json "d.get('container','')")
wait_running "$JB" "$CB" 900 "$JA" "$CA" && pass "B running (static site)" || { fail "B never came up"; docker logs --tail 20 "$CB"; }
docker image inspect sandbox-static >/dev/null 2>&1 && pass "sandbox-static built on first use" || fail "lazy build"
[ "$(code "$JB" GET "/sandbox/status?container=$CA")" = 404 ] && pass "tester B gets 404 for A's sandbox" || fail "ownership"
[ "$(code "$JC" GET /sandboxes)" = 401 ] && pass "no session -> 401" || fail "auth gate"
login "$JC" >/dev/null
G=$(curl -s -w ' %{http_code}' -b "$JC" -X POST -H 'X-Jr: 1' -H 'Content-Type: application/json' -d "{\"repo\":\"$REPO_B\"}" $B/run | tr -d '\n')
case "$G" in *" 429") pass "global cap (2) -> 429" ;; *) fail "global cap: $G" ;; esac
IP_B=$(docker inspect "$CB" --format '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}')
probe() { docker exec "$CA" sh -c "curl -s -o /dev/null -m 6 -w '%{http_code}' $1 || true"; }
info "sandbox -> internet: $(probe https://example.com)"
[ "$(probe "http://$IP_B:8080")" = 000 ] && pass "sandbox A cannot reach B at $IP_B:8080 (icc off)" || fail "A reached B directly"
# host.docker.internal reaches the host's loopback on Docker Desktop, so these check what a sandbox can do there, not whether it connects.
info "sandbox -> Jr-Arch public /health via host.docker.internal: $(probe "http://host.docker.internal:$PORT/health") (public by design)"
[ "$(probe "http://host.docker.internal:$PORT/sandboxes")" = 401 ] && pass "sandbox gets 401 from the Jr-Arch API (no session)" || fail "sandbox used the Jr-Arch API"
[ "$(docker exec "$CA" sh -c "curl -s -o /dev/null -m 6 -w '%{http_code}' -X POST -H 'X-Jr: 1' -H 'X-Jr-Internal: guess' -H 'Content-Type: application/json' -d '{}' http://host.docker.internal:$PORT/terminal/exec || true")" = 401 ] && pass "sandbox cannot pass as Go's agent (guessed token -> 401)" || fail "guessed internal token accepted"
[ "$(probe "http://host.docker.internal:$AGENT/agent/health")" = 403 ] && pass "sandbox gets 403 from the agent without Go's token" || fail "sandbox used the agent directly"
[ "$(docker exec "$CA" sh -c "curl -s -o /dev/null -m 6 -w '%{http_code}' -X POST -H 'x-jr-user: internal' -H 'Content-Type: application/json' -d '{\"container\":\"$CB\",\"message\":\"hi\"}' http://host.docker.internal:$AGENT/agent/chat || true")" = 403 ] && pass "sandbox cannot drive the agent on another sandbox" || fail "agent chat on another sandbox accepted"
info "sandbox -> B's published port via host.docker.internal: $(probe "http://host.docker.internal:$(status "$JB" "$CB" | json "d['services'][0]['port']")")"

phase "4. destroy and cleanup"
for pair in "$JA $CA" "$JB $CB"; do
  set -- $pair
  api "$1" POST "/stop/$2" >/dev/null
  docker container inspect "$2" >/dev/null 2>&1 && fail "container $2 left" || pass "container $2 removed"
  [ -e "$(workdir "$2")" ] && fail "workdir of $2 left" || pass "workdir of $2 removed"
done
sleep 3
[ -z "$(docker ps -aq --filter label=jrarch.sandbox)" ] && pass "no labelled containers left" || fail "labelled containers left"
[ "$(tunnels)" = 0 ] && pass "no cloudflared processes left" || fail "cloudflared still running"
info "dangling volumes: $(docker volume ls -qf dangling=true | wc -l)"

phase "5. crash and restart recovery"
docker run -d --name jr-orphan --label jrarch.sandbox=jr-orphan sandbox-node sleep 600 >/dev/null
mkdir -p "$WORK/sandbox-999999" && echo x > "$WORK/sandbox-999999/f"
kill_jr
[ "$(curl -s -o /dev/null -w '%{http_code}' -m 3 $B/health)" = 000 ] && pass "server process tree killed" || fail "server survived the kill"
start_jr && pass "server restarted and ready" || fail "restart"
docker container inspect jr-orphan >/dev/null 2>&1 && fail "orphaned container survived restart" || pass "orphaned labelled container removed at startup"
[ -e "$WORK/sandbox-999999" ] && fail "orphaned workdir survived restart" || pass "orphaned workdir removed at startup"

printf '\n=== RESULTS: %d passed, %d failed\n' "$P" "$F"
[ "$F" = 0 ]
