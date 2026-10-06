package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"time"

	"github.com/gorilla/websocket"
)

// TestAgentProxyTunnelsWebSocket proves the claim that the Go reverse proxy in front of the Node agent service tunnels a WebSocket upgrade end-to-end.
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

func TestAgentProxyBlocksInternalRoutes(t *testing.T) {
	var hits []string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits = append(hits, r.URL.Path)
	}))
	defer backend.Close()
	front := httptest.NewServer(newAgentProxy(backend.URL))
	defer front.Close()

	for _, p := range []string{"/agent/register", "/agent/register/", "/agent//register", "/agent/Register", "/agent/x/../register", "/agent/keys", "/agent/Keys/"} {
		resp, err := http.Post(front.URL+p, "application/json", strings.NewReader(`{"container":"x","workdir":"/"}`))
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode == 200 {
			t.Errorf("%s: status 200, want it refused", p)
		}
	}
	resp, err := http.Post(front.URL+"/agent/chat", "application/json", strings.NewReader(`{}`))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if strings.Join(hits, ",") != "/agent/chat" {
		t.Fatalf("backend saw %v, want only /agent/chat", hits)
	}
}
