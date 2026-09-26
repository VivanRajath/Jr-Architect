package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/websocket"

	"sandbox/internal/core"
)

func TestIsAllowedOriginByMode(t *testing.T) {
	old := core.Cfg
	defer func() { core.Cfg = old }()

	core.Cfg = core.DefaultConfig()
	if !core.IsAllowedOrigin("http://127.0.0.1:9000") || core.IsAllowedOrigin("https://jr.example") {
		t.Fatal("local mode should allow loopback only")
	}
	core.Cfg.PublicOrigin = "https://jr.example"
	for o, want := range map[string]bool{
		"https://jr.example":          true,
		"https://JR.example/":         true,
		"http://127.0.0.1:9000":       false,
		"https://p-abc.jr.example":    false,
		"https://jr.example.evil.com": false,
		"http://jr.example":           false,
	} {
		if got := core.IsAllowedOrigin(o); got != want {
			t.Errorf("public IsAllowedOrigin(%q) = %v, want %v", o, got, want)
		}
	}
}

func TestOriginGuardBlocksForeignWritesAndUpgrades(t *testing.T) {
	withAuthConfig(t)
	var reached int
	h := OriginGuard(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { reached++ }))
	cases := []struct {
		method, origin string
		upgrade        bool
		pass           bool
	}{
		{"POST", "https://p-abc.jr.example", false, false},
		{"GET", "https://p-abc.jr.example", true, false},
		{"POST", "https://jr.example", false, true},
		{"GET", "https://jr.example", true, true},
		{"GET", "https://p-abc.jr.example", false, true},
		{"POST", "", false, true},
	}
	for _, c := range cases {
		reached = 0
		req := httptest.NewRequest(c.method, "/agent/ws", nil)
		if c.origin != "" {
			req.Header.Set("Origin", c.origin)
		}
		if c.upgrade {
			req.Header.Set("Upgrade", "websocket")
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if (reached == 1) != c.pass {
			t.Errorf("%s origin=%q upgrade=%v: reached=%d, want pass=%v", c.method, c.origin, c.upgrade, reached, c.pass)
		}
	}
}

func TestTerminalUpgraderAcceptsThePublicOrigin(t *testing.T) {
	withAuthConfig(t)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if c, err := wsUpgrader.Upgrade(w, r, nil); err == nil {
			c.Close()
		}
	}))
	defer srv.Close()
	url := "ws" + strings.TrimPrefix(srv.URL, "http")
	if _, _, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": {"https://jr.example"}}); err != nil {
		t.Fatalf("public origin refused: %v", err)
	}
	if _, _, err := websocket.DefaultDialer.Dial(url, http.Header{"Origin": {"https://p-x.jr.example"}}); err == nil {
		t.Fatal("a preview origin opened the terminal socket")
	}
}
