package core

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// Real rootless Podman only: JR_PODMAN_IT=1 inside the WSL/Linux service account, otherwise skipped.
func requirePodman(t *testing.T) {
	t.Helper()
	if os.Getenv("JR_PODMAN_IT") != "1" {
		t.Skip("set JR_PODMAN_IT=1 to run against real podman")
	}
	if _, err := exec.LookPath("podman"); err != nil {
		t.Skip("podman not installed")
	}
	old := Cfg
	Cfg = DefaultConfig()
	Cfg.ContainerCLI = "podman"
	Cfg.WorkDir = t.TempDir()
	t.Cleanup(func() { Cfg = old })
}

func TestPodmanAcceptsEveryRunFlag(t *testing.T) {
	requirePodman(t)
	name := "jr-it-flags"
	docker("rm", "-f", "-v", name)
	dir := filepath.Join(Cfg.WorkDir, "sandbox-424242")
	os.MkdirAll(dir, 0o755)
	os.WriteFile(filepath.Join(dir, "hello.txt"), []byte("hi"), 0o644)

	args := RunArgs(name, "256m", "1", 64, []PortMap{{Host: 45123, Container: 8080}}, dir,
		[]string{"CI=1"}, nil, "docker.io/library/alpine:3", "sleep 300")
	if out, err := Output("", CLI(), args...); err != nil {
		t.Fatalf("podman rejected RunArgs: %v\n%s", err, out)
	}
	defer docker("rm", "-f", "-v", name)

	checks := map[string]string{
		"cat /sys/fs/cgroup/memory.max":  "268435456",
		"cat /sys/fs/cgroup/pids.max":    "64",
		"cat /workspace/hello.txt":       "hi",
		"grep NoNewPrivs /proc/1/status": "1",
		"ulimit -n":                      "65536",
	}
	for cmd, want := range checks {
		res := ExecInContainer(name, cmd, 0)
		if res.ExitCode != 0 || !strings.Contains(res.Output, want) {
			t.Errorf("%s = %q (exit %d), want %q", cmd, res.Output, res.ExitCode, want)
		}
	}
	if out, _ := docker("ps", "--filter", "label="+SandboxLabel+"="+name, "--format", "{{.Names}}"); strings.TrimSpace(out) != name {
		t.Errorf("label filter found %q", out)
	}

	SyncFile(name, filepath.Join(dir, "hello.txt"), "synced.txt")
	if res := ExecInContainer(name, "cat /workspace/synced.txt", 0); res.Output != "hi" {
		t.Errorf("SyncFile through podman exec wrote %q", res.Output)
	}

	PutSandbox(Sandbox{Container: name, Workdir: dir, Image: "docker.io/library/alpine:3"})
	// A directory owned by a non-root container user maps to a subuid the host account cannot empty directly.
	ExecInContainer(name, "adduser -D -u 1234 app && su app -c 'mkdir /workspace/appdir && touch /workspace/appdir/f'", 0)
	Reap(Sandbox{Container: name, Workdir: dir}, "integration test")
	if _, err := docker("container", "inspect", name); err == nil {
		t.Error("Reap left the container behind")
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Error("Reap left the workdir (with a subuid-owned file) behind")
	}
}

func TestPodmanSkipsTheSharedNetwork(t *testing.T) {
	requirePodman(t)
	old := sandboxNetwork
	defer func() { sandboxNetwork = old }()
	sandboxNetwork = ""
	EnsureSandboxNetwork()
	if sandboxNetwork != "" {
		t.Fatalf("podman got network %q", sandboxNetwork)
	}
	if _, err := docker("network", "exists", SandboxNetwork); err == nil {
		t.Fatal("a docker-style shared bridge was created under podman")
	}
}
