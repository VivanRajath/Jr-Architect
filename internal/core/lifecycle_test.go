package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func stubDocker(t *testing.T) *[]string {
	t.Helper()
	var calls []string
	old := docker
	docker = func(args ...string) (string, error) {
		calls = append(calls, strings.Join(args, " "))
		if args[0] == "ps" {
			return "abc123\ndef456\n", nil
		}
		return "", nil
	}
	t.Cleanup(func() { docker = old })
	return &calls
}

func withWorkDir(t *testing.T) string {
	t.Helper()
	old := Cfg
	Cfg = DefaultConfig()
	Cfg.WorkDir = t.TempDir()
	t.Cleanup(func() { Cfg = old })
	return Cfg.WorkDir
}

func TestExpiryRules(t *testing.T) {
	now := time.Now()
	idle, max := 15*time.Minute, 45*time.Minute
	cases := []struct {
		name string
		sb   Sandbox
		want string
	}{
		{"fresh running", Sandbox{Status: StatusRunning, CreatedAt: now.Add(-20 * time.Minute), LastActive: now.Add(-time.Minute)}, ""},
		{"idle running", Sandbox{Status: StatusRunning, CreatedAt: now.Add(-20 * time.Minute), LastActive: now.Add(-16 * time.Minute)}, "idle"},
		{"active but too old", Sandbox{Status: StatusRunning, CreatedAt: now.Add(-46 * time.Minute), LastActive: now}, "max lifetime"},
		{"idle awaiting approval", Sandbox{Status: StatusAwaiting, CreatedAt: now.Add(-16 * time.Minute), LastActive: now.Add(-16 * time.Minute)}, "idle"},
		{"long build is not idle", Sandbox{Status: StatusBuilding, CreatedAt: now.Add(-30 * time.Minute), LastActive: now.Add(-30 * time.Minute)}, ""},
		{"long clone is not idle", Sandbox{Status: StatusDetecting, CreatedAt: now.Add(-20 * time.Minute), LastActive: now.Add(-20 * time.Minute)}, ""},
		{"failed within grace", Sandbox{Status: StatusFailed, CreatedAt: now, LastActive: now.Add(-time.Minute)}, ""},
		{"failed past grace", Sandbox{Status: StatusFailed, CreatedAt: now, LastActive: now.Add(-6 * time.Minute)}, "failed"},
	}
	for _, c := range cases {
		if got := expiry(c.sb, now, idle, max); got != c.want {
			t.Errorf("%s: expiry = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestReapExpiredRemovesContainerWorkdirAndEntry(t *testing.T) {
	calls := stubDocker(t)
	work := withWorkDir(t)
	resetRegistry(t)
	dir := filepath.Join(work, "sandbox-123")
	os.MkdirAll(filepath.Join(dir, "src"), 0o755)
	old := time.Now().Add(-time.Hour)
	PutSandbox(Sandbox{Container: "sandbox-123", Workdir: dir, Status: StatusRunning, CreatedAt: old, LastActive: old})
	PutSandbox(Sandbox{Container: "sandbox-456", Status: StatusRunning, CreatedAt: time.Now(), LastActive: time.Now()})
	AddLog("sandbox-123", "hello")

	if n := ReapExpired(time.Now()); n != 1 {
		t.Fatalf("reaped %d, want 1", n)
	}
	if _, ok := GetSandbox("sandbox-123"); ok {
		t.Error("expired sandbox still registered")
	}
	if _, ok := GetSandbox("sandbox-456"); !ok {
		t.Error("an active sandbox was reaped")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("workdir was not removed")
	}
	if _, ok := LogsFor("sandbox-123"); ok {
		t.Error("logs were not dropped")
	}
	if len(*calls) != 1 || (*calls)[0] != "rm -f -v sandbox-123" {
		t.Errorf("docker calls = %v", *calls)
	}
}

func TestRemoveWorkdirRefusesAnythingButAWorkspace(t *testing.T) {
	stubDocker(t)
	work := withWorkDir(t)
	keep := []string{work, filepath.Join(work, "sandbox-abc"), filepath.Join(work, "other-1"), filepath.Join(t.TempDir(), "sandbox-1")}
	for _, d := range keep {
		os.MkdirAll(d, 0o755)
		RemoveWorkdir(d, "")
		if _, err := os.Stat(d); err != nil {
			t.Errorf("%s was removed but is not a workspace", d)
		}
	}
	RemoveWorkdir("", "")
}

func TestReapOrphansAtStartup(t *testing.T) {
	calls := stubDocker(t)
	work := withWorkDir(t)
	for _, d := range []string{"sandbox-111", "builder-222", "sandbox-notdigits", "jr-agent-homes"} {
		os.MkdirAll(filepath.Join(work, d), 0o755)
	}
	ReapOrphans()
	for d, gone := range map[string]bool{"sandbox-111": true, "builder-222": true, "sandbox-notdigits": false, "jr-agent-homes": false} {
		_, err := os.Stat(filepath.Join(work, d))
		if gone != os.IsNotExist(err) {
			t.Errorf("%s: removed=%v, want %v", d, os.IsNotExist(err), gone)
		}
	}
	want := []string{"ps -aq --filter label=jrarch.sandbox", "rm -f -v abc123", "rm -f -v def456"}
	if strings.Join(*calls, "|") != strings.Join(want, "|") {
		t.Errorf("docker calls = %v, want %v", *calls, want)
	}
}

func TestTouchBumpsLastActive(t *testing.T) {
	resetRegistry(t)
	PutSandbox(Sandbox{Container: "t1"})
	Touch("t1")
	if sb, _ := GetSandbox("t1"); time.Since(sb.LastActive) > time.Second {
		t.Fatal("Touch did not record activity")
	}
	Touch("missing")
}

func TestRunArgsLabelsTheContainer(t *testing.T) {
	args := strings.Join(RunArgs("sandbox-9", "1g", "1", 100, nil, "/w", nil, nil, "img", "true"), " ")
	if !strings.Contains(args, "--label jrarch.sandbox=sandbox-9") {
		t.Fatalf("container is not labelled: %s", args)
	}
}

func TestOversizedSandboxIsReaped(t *testing.T) {
	stubDocker(t)
	work := withWorkDir(t)
	resetRegistry(t)
	old := workdirSizeMB
	defer func() { workdirSizeMB = old }()
	big, small := filepath.Join(work, "sandbox-900"), filepath.Join(work, "sandbox-901")
	os.MkdirAll(big, 0o755)
	os.MkdirAll(small, 0o755)
	workdirSizeMB = func(dir string) int64 {
		if dir == big {
			return 5000
		}
		return 400
	}
	PutSandbox(Sandbox{Container: "sandbox-900", Workdir: big, Status: StatusRunning})
	PutSandbox(Sandbox{Container: "sandbox-901", Workdir: small, Status: StatusRunning})

	Cfg.MaxSandboxDiskMB = 0
	if ReapOversized() != 0 {
		t.Fatal("no limit configured, nothing should be reaped")
	}
	Cfg.MaxSandboxDiskMB = 3072
	if n := ReapOversized(); n != 1 {
		t.Fatalf("reaped %d, want the one over the limit", n)
	}
	if _, ok := GetSandbox("sandbox-900"); ok {
		t.Error("the oversized sandbox is still registered")
	}
	if _, ok := GetSandbox("sandbox-901"); !ok {
		t.Error("a sandbox under the limit was reaped")
	}
}

func TestWorkdirSizeCountsRegularFilesOnly(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.bin"), make([]byte, 3<<20), 0o644)
	os.MkdirAll(filepath.Join(dir, "sub"), 0o755)
	os.WriteFile(filepath.Join(dir, "sub", "b.bin"), make([]byte, 2<<20), 0o644)
	if got := workdirSizeMB(dir); got != 5 {
		t.Fatalf("size = %dMB, want 5", got)
	}
}
