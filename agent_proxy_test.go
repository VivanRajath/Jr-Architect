package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// TestAgentProxyTunnelsWebSocket proves the claim that the Go reverse proxy in
// front of the Node agent service tunnels a WebSocket upgrade end-to-end — the
// transport the streaming agent panel depends on. A stub backend stands in for
// agent-services/server.js and emits the same frame sequence the real service
// does; we dial through newAgentProxy and assert the whole stream round-trips.
func TestAgentProxyTunnelsWebSocket(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}

	// Stub agent backend: on a "chat" message, stream the real protocol.
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/ws" {
			t.Errorf("backend got unexpected path %q (proxy should preserve it)", r.URL.Path)
		}
		c, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer c.Close()
		for {
			_, data, err := c.ReadMessage()
			if err != nil {
				return
			}
			var in map[string]string
			_ = json.Unmarshal(data, &in)
			if in["type"] != "chat" {
				continue
			}
			send := func(typ, content string) {
				b, _ := json.Marshal(map[string]string{"type": typ, "content": content})
				_ = c.WriteMessage(websocket.TextMessage, b)
			}
			send("thinking", "")
			send("delta", "Editing ")
			send("tool", `write({"path":"app/page.tsx"})`)
			send("file_changed", "")
			send("message_end", "")
			send("complete", "")
			return
		}
	}))
	defer backend.Close()

	// Front the stub with the actual production proxy code.
	front := httptest.NewServer(newAgentProxy(backend.URL))
	defer front.Close()

	wsURL := "ws" + strings.TrimPrefix(front.URL, "http") + "/agent/ws"
	c, resp, err := websocket.DefaultDialer.Dial(wsURL, nil)
	if err != nil {
		t.Fatalf("ws dial through proxy failed: %v (resp=%v) — reverse proxy did not tunnel the upgrade", err, resp)
	}
	defer c.Close()

	if err := c.WriteMessage(websocket.TextMessage, []byte(`{"type":"chat","container":"x","message":"hi"}`)); err != nil {
		t.Fatalf("write through proxy failed: %v", err)
	}

	_ = c.SetReadDeadline(time.Now().Add(5 * time.Second))
	var types []string
	for {
		_, data, err := c.ReadMessage()
		if err != nil {
			break
		}
		var m map[string]string
		if err := json.Unmarshal(data, &m); err != nil {
			t.Fatalf("frame was not JSON: %q", data)
		}
		types = append(types, m["type"])
		if m["type"] == "complete" {
			break
		}
	}

	got := strings.Join(types, ",")
	want := "thinking,delta,tool,file_changed,message_end,complete"
	if got != want {
		t.Fatalf("stream through proxy = %q, want %q", got, want)
	}
}
