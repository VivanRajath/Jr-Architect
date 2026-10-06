package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"sandbox/internal/core"
)

func asUser(req *http.Request, user string) *http.Request { return core.WithUser(req, user) }

func TestOtherUsersSandboxIsInvisible(t *testing.T) {
	name := "sandbox-own-a"
	core.PutSandbox(core.Sandbox{Container: name, Workdir: t.TempDir(), Owner: "u-a", Status: core.StatusAwaiting})
	defer core.DeleteSandbox(name)

	q := "?container=" + name
	body := `{"container":"` + name + `","path":"x.txt","content":"x","command":"id","from":"a","to":"b","paths":["x"]}`
	cases := []struct {
		name    string
		method  string
		path    string
		body    string
		handler http.HandlerFunc
	}{
		{"files", "GET", "/files" + q, "", filesHandler},
		{"file read", "GET", "/file" + q + "&path=x.txt", "", fileReadHandler},
		{"file save", "POST", "/file/save", body, fileSaveHandler},
		{"file create", "POST", "/file/create", body, fileCreateHandler},
		{"file delete", "POST", "/file/delete", body, fileDeleteHandler},
		{"file rename", "POST", "/file/rename", body, fileRenameHandler},
		{"sync", "POST", "/sandbox/sync", body, sandboxSyncHandler},
		{"status", "GET", "/sandbox/status" + q, "", sandboxStatusHandler},
		{"entry", "GET", "/sandbox/entry" + q, "", sandboxEntryHandler},
		{"plan", "GET", "/run/plan" + q, "", runPlanHandler},
		{"approve", "POST", "/run/approve", body, runApproveHandler},
		{"logs", "GET", "/logs/" + name, "", logsHandler},
		{"stop", "POST", "/stop/" + name, "", stopHandler},
		{"exec", "POST", "/terminal/exec", body, terminalExecHandler},
		{"terminal ws", "GET", "/terminal/ws" + q, "", terminalWSHandler},
	}
	for _, c := range cases {
		rec := httptest.NewRecorder()
		c.handler(rec, asUser(httptest.NewRequest(c.method, c.path, strings.NewReader(c.body)), "u-b"))
		if rec.Code != 404 {
			t.Errorf("%s as another user = %d, want 404", c.name, rec.Code)
		}
	}
	if _, ok := core.GetSandbox(name); !ok {
		t.Fatal("another user's stop request removed the sandbox")
	}

	rec := httptest.NewRecorder()
	runPlanHandler(rec, asUser(httptest.NewRequest("GET", "/run/plan"+q, nil), "u-a"))
	if rec.Code != 200 {
		t.Fatalf("owner reading their plan = %d", rec.Code)
	}
	rec = httptest.NewRecorder()
	runPlanHandler(rec, asUser(httptest.NewRequest("GET", "/run/plan"+q, nil), core.InternalUser))
	if rec.Code != 200 {
		t.Fatalf("agent service reading the plan = %d", rec.Code)
	}
}

func TestSandboxListIsPerUser(t *testing.T) {
	core.PutSandbox(core.Sandbox{Container: "sandbox-list-a", Owner: "u-a"})
	core.PutSandbox(core.Sandbox{Container: "sandbox-list-b", Owner: "u-b"})
	defer core.DeleteSandbox("sandbox-list-a")
	defer core.DeleteSandbox("sandbox-list-b")

	rec := httptest.NewRecorder()
	listHandler(rec, asUser(httptest.NewRequest("GET", "/sandboxes", nil), "u-a"))
	var got map[string]core.Sandbox
	json.Unmarshal(rec.Body.Bytes(), &got)
	if _, ok := got["sandbox-list-a"]; !ok {
		t.Error("owner cannot see their own sandbox")
	}
	if _, ok := got["sandbox-list-b"]; ok {
		t.Error("another user's sandbox leaked into the list")
	}
}

func TestAgentProxyOverwritesSpoofedUser(t *testing.T) {
	var seen, cookie, internal string
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		seen, cookie, internal = r.Header.Get("X-Jr-User"), r.Header.Get("Cookie"), r.Header.Get("X-Jr-Internal")
	}))
	defer backend.Close()
	req := httptest.NewRequest("POST", "/agent/chat", strings.NewReader(`{}`))
	req.Header.Set("X-Jr-User", "u-victim")
	req.Header.Set("X-Jr-Internal", "guess")
	req.Header.Set("Cookie", "jr_session=abc")
	old := core.Cfg.InternalToken
	core.Cfg.InternalToken = "the-real-token-that-only-go-holds-0123456789"
	defer func() { core.Cfg.InternalToken = old }()
	newAgentProxy(backend.URL).ServeHTTP(httptest.NewRecorder(), asUser(req, "u-attacker"))
	if seen != "u-attacker" || cookie != "" || internal != core.Cfg.InternalToken {
		t.Fatalf("backend saw user=%q cookie=%q internal=%q; want the verified user, no cookie and Go's own token", seen, cookie, internal)
	}
}

func TestOnlyRealActivityResetsTheIdleClock(t *testing.T) {
	name := "sandbox-touch"
	stale := time.Now().Add(-10 * time.Minute)
	core.PutSandbox(core.Sandbox{Container: name, Owner: "u-a", Workdir: t.TempDir(), Status: core.StatusAwaiting, LastActive: stale})
	defer core.DeleteSandbox(name)

	sandboxStatusHandler(httptest.NewRecorder(), asUser(httptest.NewRequest("GET", "/sandbox/status?container="+name, nil), "u-a"))
	runPlanHandler(httptest.NewRecorder(), asUser(httptest.NewRequest("GET", "/run/plan?container="+name, nil), "u-a"))
	if sb, _ := core.GetSandbox(name); !sb.LastActive.Equal(stale) {
		t.Fatal("a background poll counted as activity")
	}
	filesHandler(httptest.NewRecorder(), asUser(httptest.NewRequest("GET", "/files?container="+name, nil), "u-a"))
	if sb, _ := core.GetSandbox(name); time.Since(sb.LastActive) > time.Second {
		t.Fatal("opening the file tree did not count as activity")
	}
}
