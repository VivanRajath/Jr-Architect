package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// corsHeaders used to send `Access-Control-Allow-Origin: *` on every handler.
// This API has no authentication, so that let any website the developer happened
// to visit call these endpoints cross-origin AND READ THE RESPONSE — enumerate
// sandboxes, read workspace files, write workspace files. These tests pin the
// replacement: echo an allowlisted loopback origin, or send nothing.
func TestCORSOnlyEchoesLoopbackOrigins(t *testing.T) {
	cases := []struct {
		name   string
		origin string
		want   string // expected Access-Control-Allow-Origin, "" for absent
	}{
		{"no origin is same-origin or a CLI", "", ""},
		{"loopback by IP", "http://127.0.0.1:9000", "http://127.0.0.1:9000"},
		{"loopback by name", "http://localhost:5173", "http://localhost:5173"},
		{"loopback over IPv6", "http://[::1]:9000", "http://[::1]:9000"},
		{"a hostile site", "https://evil.example", ""},
		{"a prefix-matching lookalike", "https://localhost.evil.example", ""},
		{"a suffix-matching lookalike", "https://evil-127.0.0.1.example", ""},
		{"garbage", "://not a url", ""},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, "/sandboxes", nil)
			if c.origin != "" {
				req.Header.Set("Origin", c.origin)
			}
			rec := httptest.NewRecorder()
			corsHeaders(rec, req)

			got := rec.Header().Get("Access-Control-Allow-Origin")
			if got != c.want {
				t.Errorf("Access-Control-Allow-Origin = %q, want %q", got, c.want)
			}
			if got == "*" {
				t.Error("wildcard CORS is never correct on an unauthenticated API")
			}
			// Vary must always be set, or a cached response for one origin can be
			// served to another and the check above becomes decorative.
			if v := rec.Header().Get("Vary"); v != "Origin" {
				t.Errorf("Vary = %q, want Origin", v)
			}
		})
	}
}

// The WebSocket upgrade check and the CORS layer share isLoopbackOrigin, so they
// cannot disagree about what "local" means.
func TestWebSocketOriginCheckMatchesCORS(t *testing.T) {
	allowed := []string{"http://127.0.0.1:9000", "http://localhost:9000", "https://[::1]:9000"}
	denied := []string{"https://evil.example", "https://localhost.evil.example", "http://10.0.0.5:9000"}

	for _, o := range allowed {
		req := httptest.NewRequest(http.MethodGet, "/terminal/ws", nil)
		req.Header.Set("Origin", o)
		if !wsUpgrader.CheckOrigin(req) {
			t.Errorf("CheckOrigin(%q) = false, want true", o)
		}
	}
	for _, o := range denied {
		req := httptest.NewRequest(http.MethodGet, "/terminal/ws", nil)
		req.Header.Set("Origin", o)
		if wsUpgrader.CheckOrigin(req) {
			t.Errorf("CheckOrigin(%q) = true, want false", o)
		}
	}

	// An absent Origin is a non-browser client (a CLI, curl) with no CSRF surface,
	// so the upgrade is allowed — this differs from the CORS path on purpose,
	// where an absent Origin simply needs no headers.
	if !wsUpgrader.CheckOrigin(httptest.NewRequest(http.MethodGet, "/terminal/ws", nil)) {
		t.Error("CheckOrigin with no Origin = false, want true")
	}
}
