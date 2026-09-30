package server

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// An n8n call carries no session and no X-Jr header; it must still reach Node, as the hook user, on the hub path.
func TestHookReachesTheHubWithoutASession(t *testing.T) {
	withAuthConfig(t)
	var gotPath, gotUser, gotAuth string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		gotPath, gotUser, gotAuth = r.URL.Path, r.Header.Get("X-Jr-User"), r.Header.Get("Authorization")
		w.Write([]byte(`{"status":"completed"}`))
	}))
	defer backend.Close()
	hookLimiter = newMinuteLimiter(hooksPerMinute)

	h := RequireAuth(newHookProxy(backend.URL))
	rec := do(h, "POST", "/hooks/agents/triage/run", `{"input":{}}`, map[string]string{
		"Authorization": "Bearer jrk_x", "X-Jr-User": "u-someone-else",
	})
	if rec.Code != 200 {
		t.Fatalf("status %d: %s", rec.Code, rec.Body.String())
	}
	if gotPath != "/agent/hub/hook/triage/run" || gotUser != "hook" || gotAuth != "Bearer jrk_x" {
		t.Fatalf("backend saw path=%q user=%q auth=%q", gotPath, gotUser, gotAuth)
	}
}

func TestHookExemptionDoesNotOpenTheAgentAPI(t *testing.T) {
	withAuthConfig(t)
	h := authFront()
	if rec := do(h, "POST", "/agent/hub/agents", `{}`, map[string]string{"X-Jr": "1"}); rec.Code != 401 {
		t.Fatalf("/agent/hub without a session = %d, want 401", rec.Code)
	}
	if rec := do(h, "GET", "/hub.html", "", map[string]string{"Accept": "text/html"}); rec.Code != http.StatusFound {
		t.Fatalf("/hub.html without a session = %d, want a redirect to login", rec.Code)
	}
}

func TestHookRefusesTraversalAndFloods(t *testing.T) {
	withAuthConfig(t)
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.Write([]byte(`{}`)) }))
	defer backend.Close()
	h := newHookProxy(backend.URL)
	hookLimiter = newMinuteLimiter(hooksPerMinute)
	if rec := do(h, "POST", "/hooks/agents/a/../../register", `{}`, nil); rec.Code != 404 {
		t.Fatalf("traversal = %d, want 404", rec.Code)
	}
	hookLimiter = newMinuteLimiter(2)
	defer func() { hookLimiter = newMinuteLimiter(hooksPerMinute) }()
	codes := []int{}
	for i := 0; i < 3; i++ {
		codes = append(codes, do(h, "POST", "/hooks/agents/a/run", `{}`, nil).Code)
	}
	if codes[2] != 429 {
		t.Fatalf("third call in a minute = %v, want 429 last", codes)
	}
}
