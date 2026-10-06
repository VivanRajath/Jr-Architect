package server

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"sandbox/internal/core"
)

// Goes through Cloudflare's real edge, so it only runs with JR_LIVE_CLOUDFLARED=<path to cloudflared>.
func TestQuickTunnelPreviewThroughCloudflare(t *testing.T) {
	bin := os.Getenv("JR_LIVE_CLOUDFLARED")
	if bin == "" {
		t.Skip("set JR_LIVE_CLOUDFLARED to run against Cloudflare")
	}
	withAuthConfig(t)
	core.Cfg.PreviewDomain = ""
	core.Cfg.PreviewMode = "quicktunnel"
	core.Cfg.PreviewScheme = "https"
	core.Cfg.Cloudflared = bin

	up := websocket.Upgrader{CheckOrigin: func(r *http.Request) bool { return true }}
	app := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/ws" {
			c, err := up.Upgrade(w, r, nil)
			if err == nil {
				mt, m, _ := c.ReadMessage()
				c.WriteMessage(mt, m)
				c.Close()
			}
			return
		}
		fmt.Fprintf(w, "app saw host=%s", r.Host)
	}))
	defer app.Close()
	var appPort int
	fmt.Sscan(app.URL[strings.LastIndex(app.URL, ":")+1:], &appPort)

	ln, _ := net.Listen("tcp", "127.0.0.1:0")
	core.Cfg.ListenAddr = ln.Addr().String()
	mux := http.NewServeMux()
	Routes(mux, nil)
	go http.Serve(ln, Front(mux))
	defer ln.Close()

	name := "sandbox-live"
	core.PutSandbox(core.Sandbox{Container: name, Owner: "u-a", Port: appPort, PreviewToken: core.NewPreviewToken(), Status: core.StatusRunning,
		Services: []core.Service{{Name: "web", HostPort: appPort, ContainerPort: 3000, Primary: true}}})
	defer core.Reap(core.Sandbox{Container: name}, "test done")

	core.OpenPreviews(name)
	var url string
	for i := 0; i < 90 && url == ""; i++ {
		time.Sleep(time.Second)
		sb, _ := core.GetSandbox(name)
		url = core.PrimaryPreviewURL(sb)
	}
	if url == "" {
		t.Fatal("no tunnel URL within 90s")
	}
	t.Logf("preview at %s", url)

	var body string
	for i := 0; i < 20; i++ {
		res, err := http.Get(url)
		if err != nil {
			t.Logf("attempt %d: %v", i, err)
		} else {
			t.Logf("attempt %d: %d", i, res.StatusCode)
		}
		if err == nil {
			b, _ := io.ReadAll(res.Body)
			res.Body.Close()
			if res.StatusCode == 200 {
				body = string(b)
				break
			}
		}
		time.Sleep(2 * time.Second)
	}
	if body != "app saw host=localhost:3000" {
		t.Fatalf("through the edge the app answered %q", body)
	}

	host := strings.TrimSuffix(strings.TrimPrefix(url, "https://"), "/")
	c, _, err := websocket.DefaultDialer.Dial("wss://"+host+"/ws", http.Header{"Origin": {"https://" + host}})
	if err != nil {
		t.Fatalf("websocket through the edge: %v", err)
	}
	defer c.Close()
	c.WriteMessage(websocket.TextMessage, []byte("hmr"))
	if _, m, err := c.ReadMessage(); err != nil || string(m) != "hmr" {
		t.Fatalf("websocket echo = %q %v", m, err)
	}

	res, err := http.Get("https://" + host + "/sandboxes")
	if err == nil {
		b, _ := io.ReadAll(res.Body)
		res.Body.Close()
		if strings.Contains(string(b), "login required") {
			t.Fatal("a preview host reached the IDE's API")
		}
	}
}
