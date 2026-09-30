package server

import (
	"net/http/httptest"
	"strings"
	"testing"

	"sandbox/internal/builder"
	"sandbox/internal/core"
)

func TestRunAndScaffoldReturn429WhenFull(t *testing.T) {
	old := core.Cfg
	defer func() { core.Cfg = old }()
	core.Cfg = core.DefaultConfig()
	core.Cfg.WorkDir = t.TempDir()
	core.Cfg.MaxSandboxes = 1
	core.Cfg.MaxPerUser = 1

	core.PutSandbox(core.Sandbox{Container: "sandbox-limit-held", Owner: "u-other"})
	defer core.DeleteSandbox("sandbox-limit-held")
	for _, sb := range core.AllSandboxes() {
		if sb.Container != "sandbox-limit-held" {
			t.Skip("another test left sandboxes registered; the cap would count them")
		}
	}

	oldEngine, oldNet := engineUp, ensureNetwork
	engineUp, ensureNetwork = func() bool { return true }, func() {}
	defer func() { engineUp, ensureNetwork = oldEngine, oldNet }()
	rec := httptest.NewRecorder()
	runHandler(rec, asUser(httptest.NewRequest("POST", "/run", strings.NewReader(`{"repo":"https://github.com/a/b"}`)), "u-new"))
	if rec.Code != 429 || !strings.Contains(rec.Body.String(), "capacity") {
		t.Fatalf("/run on a full server = %d %s, want 429", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	builder.ScaffoldHandler(rec, asUser(httptest.NewRequest("POST", "/build/scaffold", strings.NewReader(`{"prd":{"name":"x"}}`)), "u-new"))
	if rec.Code != 429 {
		t.Fatalf("/build/scaffold on a full server = %d %s, want 429", rec.Code, rec.Body.String())
	}
	if len(core.AllSandboxes()) != 1 {
		t.Fatalf("a refused request left %d sandboxes registered", len(core.AllSandboxes()))
	}
}

func TestRunExplainsAStoppedEngine(t *testing.T) {
	oldEngine := engineUp
	engineUp = func() bool { return false }
	defer func() { engineUp = oldEngine }()
	rec := httptest.NewRecorder()
	runHandler(rec, asUser(httptest.NewRequest("POST", "/run", strings.NewReader(`{"repo":"https://github.com/a/b"}`)), "u-new"))
	if rec.Code != 503 || !strings.Contains(rec.Body.String(), "not running") {
		t.Fatalf("/run with the engine down = %d %s, want 503 with a clear reason", rec.Code, rec.Body.String())
	}
}
