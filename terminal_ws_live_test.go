package main

import (
	"net/http"
	"net/http/httptest"
	"os/exec"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestTerminalWSLive exercises the REAL terminalWSHandler against a REAL
// container over a REAL websocket — the exact path the browser uses. Guarded
// behind -run because it needs Docker; run with:
//
//	go test -run TestTerminalWSLive -v .
func TestTerminalWSLive(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping docker-backed live terminal test in -short mode")
	}
	if err := exec.Command("docker", "version").Run(); err != nil {
		t.Skip("docker not available; skipping live terminal test")
	}
	if err := exec.Command("docker", "image", "inspect", "sandbox-node:latest").Run(); err != nil {
		t.Skip("sandbox-node:latest image not present; skipping live terminal test")
	}
	name := "ws-live-verify"
	_ = exec.Command("docker", "rm", "-f", name).Run()
	if out, err := exec.Command("docker", "run", "-d", "--name", name,
		"sandbox-node:latest", "sh", "-c", "sleep 120").CombinedOutput(); err != nil {
		t.Fatalf("docker run: %v: %s", err, out)
	}
	defer exec.Command("docker", "rm", "-f", name).Run()

	// Register it the way runHandler would, so the handler's lookup succeeds.
	mutex.Lock()
	sandboxes[name] = Sandbox{Container: name, Port: 0, Repo: "test", Workdir: "/tmp"}
	mutex.Unlock()
	defer func() { mutex.Lock(); delete(sandboxes, name); mutex.Unlock() }()

	srv := httptest.NewServer(http.HandlerFunc(terminalWSHandler))
	defer srv.Close()

	wsURL := "ws" + strings.TrimPrefix(srv.URL, "http") + "/terminal/ws?container=" + name
	c, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial failed: %v (resp=%v)", err, resp)
	}
	defer c.Close()

	// Collect everything the handler sends, tagging frame type so we can tell
	// whether an error came back as an (invisible-to-browser) text frame.
	var got strings.Builder
	var sawText bool
	done := make(chan struct{})
	go func() {
		for {
			mt, data, rerr := c.ReadMessage()
			if rerr != nil {
				break
			}
			if mt == websocket.TextMessage {
				sawText = true
			}
			got.Write(data)
		}
		close(done)
	}()

	// Send a resize (text frame) then type "pwd\r" as binary keystrokes.
	time.Sleep(600 * time.Millisecond)
	_ = c.WriteMessage(websocket.TextMessage, []byte(`{"type":"resize","cols":120,"rows":30}`))
	time.Sleep(200 * time.Millisecond)
	_ = c.WriteMessage(websocket.BinaryMessage, []byte("cd /tmp\r"))
	time.Sleep(400 * time.Millisecond)
	_ = c.WriteMessage(websocket.BinaryMessage, []byte("pwd\r"))
	time.Sleep(600 * time.Millisecond)

	out := got.String()
	t.Logf("frame-text-seen=%v", sawText)
	t.Logf("handler output %q", out)

	if sawText {
		t.Errorf("handler sent a TEXT frame (an error message the browser would swallow): %q", out)
	}
	if !strings.Contains(out, "/tmp") {
		t.Errorf("expected pwd output '/tmp' — terminal not functional. got %q", out)
	}
	if !strings.Contains(out, "cd /tmp") {
		t.Errorf("expected keystroke echo 'cd /tmp' — input not reaching shell. got %q", out)
	}
}
