package core

import (
	"errors"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// Without a build context the sandbox dies pulling a name no registry has.
func TestEverySandboxImageHasABuildContext(t *testing.T) {
	for _, e := range Images {
		dir := ImageBuildDir(e.Image)
		if dir == "" {
			t.Errorf("%s has no build dir", e.Image)
			continue
		}
		if !FileExists(filepath.Join("..", "..", "sandbox-images", e.Dir, "Dockerfile")) {
			t.Errorf("%s points at %s, which has no Dockerfile", e.Image, dir)
		}
	}
	if ImageBuildDir("sandbox-django") == "" {
		t.Error("sandbox-django is not registered in Images")
	}
	if ImageBuildDir("sandbox-nope") != "" {
		t.Error("imageBuildDir invented a build context for an unknown image")
	}
}

// Every service that serves HTTP needs its own published port, and none of them may
// escape the loopback interface.
func TestRunArgsPublishesEveryPortOnLoopback(t *testing.T) {
	ports := []PortMap{{Host: 54001, Container: 3000}, {Host: 54002, Container: 8000}}
	args := RunArgs("c1", "1536m", "2", 200, ports, "/tmp/wd", []string{"CI=1"}, nil, "sandbox-multi-django-react", "sleep 1")

	joined := strings.Join(args, " ")
	for _, want := range []string{"-p 127.0.0.1:54001:3000", "-p 127.0.0.1:54002:8000"} {
		if !strings.Contains(joined, want) {
			t.Errorf("missing %q in: %s", want, joined)
		}
	}
	if strings.Count(joined, "-p ") != len(ports) {
		t.Errorf("expected exactly %d published ports: %s", len(ports), joined)
	}
	if strings.Contains(joined, "-p 0.0.0.0") {
		t.Error("a port was published to the local network")
	}
	// No service ports at all is valid: a worker-only repo still gets a terminal.
	if got := RunArgs("c2", "1024m", "1", 100, nil, "/tmp/wd", nil, nil, "sandbox-node", "sleep 1"); strings.Contains(strings.Join(got, " "), "-p ") {
		t.Error("published a port for a sandbox with no HTTP services")
	}
}

func TestRunArgsHardensEveryContainer(t *testing.T) {
	old := sandboxNetwork
	defer func() { sandboxNetwork = old }()
	sandboxNetwork = ""
	args := strings.Join(RunArgs("c1", "1g", "1", 100, nil, "/w", nil, nil, "img", "true"), " ")
	for _, want := range []string{"--security-opt no-new-privileges", "--cap-drop NET_RAW", "--cap-drop MKNOD", "--ulimit nofile="} {
		if !strings.Contains(args, want) {
			t.Errorf("missing %q in %s", want, args)
		}
	}
	if strings.Contains(args, "--network") || strings.Contains(args, "--privileged") || strings.Contains(args, "docker.sock") {
		t.Errorf("unexpected flag in %s", args)
	}
	sandboxNetwork = SandboxNetwork
	if args := strings.Join(RunArgs("c1", "1g", "1", 100, nil, "/w", nil, nil, "img", "true"), " "); !strings.Contains(args, "--network jr-sandbox") {
		t.Errorf("sandbox network not applied: %s", args)
	}
}

func TestEnsureSandboxNetworkCreatesAnIsolatedBridgeOnce(t *testing.T) {
	calls := stubDocker(t)
	old := sandboxNetwork
	defer func() { sandboxNetwork = old }()
	docker = func(args ...string) (string, error) {
		*calls = append(*calls, strings.Join(args, " "))
		if args[1] == "inspect" {
			return "", errors.New("no such network")
		}
		return "", nil
	}
	EnsureSandboxNetwork()
	if sandboxNetwork != SandboxNetwork || len(*calls) != 2 || !strings.Contains((*calls)[1], "enable_icc=false") {
		t.Fatalf("calls = %v, network = %q", *calls, sandboxNetwork)
	}

	sandboxNetwork = ""
	docker = func(args ...string) (string, error) { return "", errors.New("docker is down") }
	EnsureSandboxNetwork()
	if sandboxNetwork != "" {
		t.Fatal("a failed create must fall back to the default bridge")
	}
}

func TestWatcherPollingOnlyOffLinux(t *testing.T) {
	polls := len(WatcherEnv()) > 0
	if polls == (runtime.GOOS == "linux") {
		t.Fatalf("GOOS=%s polling=%v", runtime.GOOS, polls)
	}
}

// A named volume is shared by every container that mounts it, so caches must be anonymous (and go with rm -v).
func TestCachesAreNeverSharedBetweenSandboxes(t *testing.T) {
	m := CacheMounts()
	for i := 0; i+1 < len(m); i += 2 {
		if m[i] == "-v" && strings.Contains(m[i+1], ":") {
			t.Errorf("cache mount %q is a named volume shared across sandboxes", m[i+1])
		}
	}
	b, _ := os.ReadFile(filepath.Join("..", "builder", "builder.go"))
	if strings.Contains(string(b), "-cache:/") {
		t.Error("the builder still mounts a shared named cache volume")
	}
}
