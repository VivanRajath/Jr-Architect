package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"sandbox/internal/core"
)

// Swaps in a public, auth-on config for one test and puts the old one back.
func withAuthConfig(t *testing.T) {
	t.Helper()
	old := core.Cfg
	core.Cfg = core.DefaultConfig()
	core.Cfg.PublicOrigin = "https://jr.example"
	core.Cfg.PreviewDomain = "jr.example"
	core.Cfg.PreviewScheme = "https"
	core.Cfg.BetaCode = "open-sesame"
	core.Cfg.SessionSecret = []byte(strings.Repeat("k", 32))
	loginLimiter = newMinuteLimiter(loginPerMinute)
	t.Cleanup(func() { core.Cfg = old })
}

func authFront() http.Handler {
	mux := http.NewServeMux()
	Routes(mux, fstest.MapFS{
		"index.html":     {Data: []byte("<html>ide</html>")},
		"login.html":     {Data: []byte("<html>login</html>")},
		"css/tokens.css": {Data: []byte(":root{}")},
	})
	return Front(mux)
}

func do(h http.Handler, method, path, body string, hdr map[string]string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, path, strings.NewReader(body))
	req.RemoteAddr = "127.0.0.1:40000"
	for k, v := range hdr {
		req.Header.Set(k, v)
	}
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	return rec
}

func loginCookie(t *testing.T, h http.Handler) string {
	t.Helper()
	rec := do(h, "POST", "/auth/login", `{"code":"open-sesame"}`, map[string]string{"X-Jr": "1"})
	if rec.Code != 200 {
		t.Fatalf("login status %d: %s", rec.Code, rec.Body.String())
	}
	c := rec.Result().Cookies()
	if len(c) != 1 || c[0].Name != "__Host-jr_session" || !c[0].HttpOnly || !c[0].Secure || c[0].Domain != "" {
		t.Fatalf("session cookie must be HttpOnly, Secure and host-only: %+v", c)
	}
	return c[0].Name + "=" + c[0].Value
}

func TestAuthOffLeavesLocalDevOpen(t *testing.T) {
	old := core.Cfg
	core.Cfg = core.DefaultConfig()
	defer func() { core.Cfg = old }()
	h := authFront()
	if rec := do(h, "GET", "/sandboxes", "", nil); rec.Code != 200 {
		t.Fatalf("local /sandboxes = %d, want 200", rec.Code)
	}
	if rec := do(h, "GET", "/auth/me", "", nil); !strings.Contains(rec.Body.String(), `"user":"local"`) {
		t.Fatalf("local user = %s", rec.Body.String())
	}
}

func TestAuthGatesEverythingButLogin(t *testing.T) {
	withAuthConfig(t)
	h := authFront()

	if rec := do(h, "GET", "/", "", map[string]string{"Accept": "text/html"}); rec.Code != 302 || rec.Header().Get("Location") != "/login" {
		t.Fatalf("page without session: %d %q, want redirect to /login", rec.Code, rec.Header().Get("Location"))
	}
	for _, p := range []string{"/sandboxes", "/files?container=x", "/terminal/ws?container=x", "/agent/registry"} {
		if rec := do(h, "GET", p, "", nil); rec.Code != 401 {
			t.Errorf("%s without session = %d, want 401", p, rec.Code)
		}
	}
	for _, p := range []string{"/login", "/css/tokens.css"} {
		if rec := do(h, "GET", p, "", nil); rec.Code != 200 {
			t.Errorf("%s should be public, got %d", p, rec.Code)
		}
	}

	cookie := loginCookie(t, h)
	if rec := do(h, "GET", "/sandboxes", "", map[string]string{"Cookie": cookie}); rec.Code != 200 {
		t.Fatalf("/sandboxes with session = %d", rec.Code)
	}
	if rec := do(h, "GET", "/auth/me", "", map[string]string{"Cookie": cookie}); !strings.Contains(rec.Body.String(), `"user":"u-`) {
		t.Fatalf("me = %s", rec.Body.String())
	}
}

func TestAuthRejectsBadCodesAndLimitsGuessing(t *testing.T) {
	withAuthConfig(t)
	h := authFront()
	for i := 0; i < loginPerMinute; i++ {
		if rec := do(h, "POST", "/auth/login", `{"code":"nope"}`, map[string]string{"X-Jr": "1"}); rec.Code != 401 || len(rec.Result().Cookies()) != 0 {
			t.Fatalf("wrong code attempt %d: %d", i, rec.Code)
		}
	}
	if rec := do(h, "POST", "/auth/login", `{"code":"open-sesame"}`, map[string]string{"X-Jr": "1"}); rec.Code != 429 {
		t.Fatalf("attempt past the limit = %d, want 429", rec.Code)
	}
}

func TestAuthRejectsForgedAndExpiredSessions(t *testing.T) {
	withAuthConfig(t)
	now := time.Now()
	good := newSessionValue("u-1", now)
	if u, ok := parseSession(good, now); !ok || u != "u-1" {
		t.Fatal("a fresh session should parse")
	}
	if _, ok := parseSession(good, now.Add(sessionTTL+time.Minute)); ok {
		t.Fatal("an expired session was accepted")
	}
	enc, mac, _ := strings.Cut(good, ".")
	forged := newSessionValue("u-2", now)
	fEnc, _, _ := strings.Cut(forged, ".")
	for _, v := range []string{fEnc + "." + mac, enc + ".AAAA", enc, "", "x.y"} {
		if _, ok := parseSession(v, now); ok {
			t.Errorf("forged session %q accepted", v)
		}
	}
	core.Cfg.SessionSecret = []byte(strings.Repeat("z", 32))
	if _, ok := parseSession(good, now); ok {
		t.Fatal("a session signed with another secret was accepted")
	}
}

func TestAuthRequiresCSRFHeaderOnWrites(t *testing.T) {
	withAuthConfig(t)
	h := authFront()
	cookie := loginCookie(t, h)
	rec := do(h, "POST", "/stop/x", "", map[string]string{"Cookie": cookie, "Content-Type": "text/plain"})
	if rec.Code != 403 {
		t.Fatalf("write without X-Jr = %d, want 403", rec.Code)
	}
	if rec := do(h, "GET", "/stop/x", "", map[string]string{"Cookie": cookie}); rec.Code != 405 {
		t.Fatalf("GET /stop = %d, want 405 so a link cannot stop a sandbox", rec.Code)
	}
	if rec := do(h, "POST", "/stop/x", "", map[string]string{"Cookie": cookie, "X-Jr": "1"}); rec.Code != 404 {
		t.Fatalf("authorised stop of a missing sandbox = %d, want 404", rec.Code)
	}
}

func TestInternalTokenOnlyFromLoopback(t *testing.T) {
	withAuthConfig(t)
	core.Cfg.InternalToken = strings.Repeat("t", 64)
	h := authFront()
	good := map[string]string{"X-Jr-Internal": core.Cfg.InternalToken}
	if rec := do(h, "GET", "/sandboxes", "", good); rec.Code != 200 {
		t.Fatalf("loopback call with the token = %d, want 200", rec.Code)
	}
	if rec := do(h, "GET", "/sandboxes", "", map[string]string{"X-Jr-Internal": "wrong"}); rec.Code != 401 {
		t.Fatalf("wrong token = %d, want 401", rec.Code)
	}
	proxied := map[string]string{"X-Jr-Internal": core.Cfg.InternalToken, "X-Forwarded-For": "203.0.113.9"}
	if rec := do(h, "GET", "/sandboxes", "", proxied); rec.Code != 401 {
		t.Fatalf("token arriving through the public proxy = %d, want 401", rec.Code)
	}
	req := httptest.NewRequest("GET", "/sandboxes", nil)
	req.RemoteAddr = "203.0.113.9:5555"
	req.Header.Set("X-Jr-Internal", core.Cfg.InternalToken)
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != 401 {
		t.Fatalf("token from a remote peer = %d, want 401", rec.Code)
	}
}
