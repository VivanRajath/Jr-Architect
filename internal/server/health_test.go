package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"sandbox/internal/core"
)

func stubProbes(t *testing.T, docker, agent bool, disk int64) {
	t.Helper()
	d, a, f := dockerUp, agentUp, freeDiskMB
	dockerUp = func() bool { return docker }
	agentUp = func() bool { return agent }
	freeDiskMB = func() int64 { return disk }
	t.Cleanup(func() { dockerUp, agentUp, freeDiskMB = d, a, f })
}

func TestHealthIsLivenessAndReadyIsCapacity(t *testing.T) {
	withAuthConfig(t)
	core.Cfg.MinFreeDiskMB = 5120
	core.Cfg.MaxSandboxes = 2
	h := authFront()
	cases := []struct {
		name          string
		docker, agent bool
		disk          int64
		ready         int
		reason        string
	}{
		{"all good", true, true, 50000, 200, ""},
		{"disk unknown", true, true, -1, 200, ""},
		{"engine down", false, true, 50000, 503, "container engine"},
		{"agent down", true, false, 50000, 503, "agent service"},
		{"below the disk floor", true, true, 4000, 503, "free-disk floor"},
	}
	for _, c := range cases {
		stubProbes(t, c.docker, c.agent, c.disk)
		if rec := do(h, "GET", "/health", "", nil); rec.Code != 200 {
			t.Errorf("%s: /health = %d, liveness must not depend on capacity or dependencies", c.name, rec.Code)
		}
		rec := do(h, "GET", "/ready", "", nil)
		if rec.Code != c.ready || !strings.Contains(rec.Body.String(), c.reason) {
			t.Errorf("%s: /ready = %d %s, want %d mentioning %q", c.name, rec.Code, rec.Body.String(), c.ready, c.reason)
		}
	}

	stubProbes(t, true, true, 50000)
	core.PutSandbox(core.Sandbox{Container: "sandbox-ready-1", Owner: "u"})
	core.PutSandbox(core.Sandbox{Container: "sandbox-ready-2", Owner: "v"})
	defer core.DeleteSandbox("sandbox-ready-1")
	defer core.DeleteSandbox("sandbox-ready-2")
	if rec := do(h, "GET", "/ready", "", nil); rec.Code != 503 || !strings.Contains(rec.Body.String(), "capacity") {
		t.Errorf("full server: /ready = %d %s", rec.Code, rec.Body.String())
	}
	if rec := do(h, "GET", "/health", "", nil); rec.Code != 200 {
		t.Errorf("full server: /health = %d", rec.Code)
	}
}

func TestRequestLogKeepsWebSocketsWorking(t *testing.T) {
	withAuthConfig(t)
	srv := httptest.NewServer(RequestLog(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := wsUpgrader.Upgrade(w, r, nil)
		if err != nil {
			t.Errorf("upgrade through the log wrapper failed: %v", err)
			return
		}
		c.WriteMessage(websocket.TextMessage, []byte("hi"))
		c.Close()
	})))
	defer srv.Close()
	c, _, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), http.Header{"Origin": {"https://jr.example"}})
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if _, msg, err := c.ReadMessage(); err != nil || string(msg) != "hi" {
		t.Fatalf("read = %q %v", msg, err)
	}
}
