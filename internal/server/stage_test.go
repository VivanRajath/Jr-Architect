package server

import (
	"net/http/httptest"
	"strings"
	"testing"

	"sandbox/internal/core"
)

func TestLastLogLineShowsWhatIsHappeningNow(t *testing.T) {
	out := "--- installing app ---\nnpm WARN deprecated x\n\x1b[32madded 1500 packages\x1b[0m in 40s\n\n"
	if got := lastLogLine(out); got != "added 1500 packages in 40s" {
		t.Fatalf("got %q", got)
	}
	if got := lastLogLine("fetching 10%\rfetching 55%\rfetching 90%\n"); got != "fetching 90%" {
		t.Fatalf("progress redraw: got %q", got)
	}
	if got := lastLogLine("--- starting app ---\n"); got != "" {
		t.Fatalf("supervisor markers are not news: got %q", got)
	}
	if got := lastLogLine(strings.Repeat("x", 400)); len(got) > 164 {
		t.Fatalf("long lines are cut, got %d chars", len(got))
	}
}

func TestStageOfCoversEveryStep(t *testing.T) {
	cases := []struct {
		sb     core.Sandbox
		status string
		url    string
		want   string
	}{
		{core.Sandbox{}, core.StatusDetecting, "", "clone"},
		{core.Sandbox{}, core.StatusAwaiting, "", "approve"},
		{core.Sandbox{Stage: "image", Image: "sandbox-react"}, core.StatusBuilding, "", "image"},
		{core.Sandbox{Stage: "generating"}, core.StatusBuilding, "", "generate"},
		{core.Sandbox{Error: "clone failed"}, core.StatusFailed, "", "failed"},
		{core.Sandbox{}, "exited", "", "failed"},
		{core.Sandbox{Port: 3000}, "running", "", "preview"},
		{core.Sandbox{Port: 3000}, "running", "https://x.trycloudflare.com/", "ready"},
		{core.Sandbox{}, "running", "", "ready"},
	}
	for _, c := range cases {
		if got, detail := stageOf(c.sb, c.status, c.url); got != c.want || detail == "" {
			t.Errorf("status %q stage %q: got %q (%q), want %q", c.status, c.sb.Stage, got, detail, c.want)
		}
	}
}

// A Build mode app has no container while its code is written; the status check must say so instead of asking Docker and reporting a stopped sandbox.
func TestGeneratingBuildIsNotReportedAsStopped(t *testing.T) {
	req := httptest.NewRequest("GET", "/sandbox/status?container=builder-build-test-generating", nil)
	sb := core.Sandbox{Container: "builder-build-test-generating", Status: core.StatusBuilding, Stage: "generating", Owner: core.UserOf(req)}
	core.PutSandbox(sb)
	defer core.DeleteSandbox(sb.Container)
	rec := httptest.NewRecorder()
	sandboxStatusHandler(rec, req)
	body := rec.Body.String()
	if rec.Code != 200 || !strings.Contains(body, `"stage":"generate"`) || strings.Contains(body, "failed") {
		t.Fatalf("status %d: %s", rec.Code, body)
	}
}
