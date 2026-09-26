package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"
)

func stubProbes(t *testing.T, docker, agent bool, disk int64) {
	t.Helper()
	d, a, f := dockerUp, agentUp, freeDiskMB
	dockerUp = func() bool { return docker }
	agentUp = func() bool { return agent }
	freeDiskMB = func() int64 { return disk }
	t.Cleanup(func() { dockerUp, agentUp, freeDiskMB = d, a, f })
}

func TestHealthIsPublicAndReportsDependencies(t *testing.T) {
	withAuthConfig(t)
	h := authFront()
	cases := []struct {
		docker, agent bool
		disk          int64
		code          int
	}{
		{true, true, 50000, 200},
		{true, true, -1, 200},
		{false, true, 50000, 503},
		{true, false, 50000, 503},
		{true, true, 100, 503},
	}
	for _, c := range cases {
		stubProbes(t, c.docker, c.agent, c.disk)
		rec := do(h, "GET", "/health", "", nil)
		var body map[string]interface{}
		json.Unmarshal(rec.Body.Bytes(), &body)
		if rec.Code != c.code || body["docker"] != c.docker || body["agent"] != c.agent {
			t.Errorf("docker=%v agent=%v disk=%d: %d %s, want %d", c.docker, c.agent, c.disk, rec.Code, rec.Body.String(), c.code)
		}
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
