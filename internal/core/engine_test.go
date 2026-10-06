package core

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

func TestPodmanConfig(t *testing.T) {
	clearJREnv(t)
	t.Setenv("JR_CONTAINER_CLI", "podman")
	t.Setenv("JR_PREHEAT_IMAGES", "node, sandbox-react,builder")
	c, err := LoadConfig()
	if err != nil {
		t.Fatal(err)
	}
	if c.ContainerCLI != "podman" || strings.Join(c.PreheatImages, ",") != "node,react,builder" {
		t.Fatalf("cli=%q preheat=%v", c.ContainerCLI, c.PreheatImages)
	}
	for env, v := range map[string]string{"JR_CONTAINER_CLI": "nerdctl", "JR_PREHEAT_IMAGES": "cobol"} {
		clearJREnv(t)
		t.Setenv(env, v)
		if _, err := LoadConfig(); err == nil {
			t.Errorf("%s=%s should be refused", env, v)
		}
	}
}

func TestContainerCallsUseTheConfiguredCLI(t *testing.T) {
	old := Cfg
	defer func() { Cfg = old }()
	Cfg.ContainerCLI = "podman"
	if CLI() != "podman" || !IsPodman() {
		t.Fatal("CLI() does not follow the config")
	}
	literal := regexp.MustCompile(`(Run|Output|Command|CommandContext)\([^)]*"docker",`)
	for _, dir := range []string{".", "../server", "../builder"} {
		files, _ := filepath.Glob(filepath.Join(dir, "*.go"))
		for _, f := range files {
			if strings.HasSuffix(f, "_test.go") {
				continue
			}
			b, _ := os.ReadFile(f)
			if m := literal.Find(b); m != nil {
				t.Errorf("%s runs the docker binary directly: %s", f, m)
			}
		}
	}
}

func TestPodmanSkipsTheDockerNetworkAndCleansWithUnshare(t *testing.T) {
	calls := stubDocker(t)
	work := withWorkDir(t)
	Cfg.ContainerCLI = "podman"
	old := sandboxNetwork
	defer func() { sandboxNetwork = old }()
	sandboxNetwork = ""
	EnsureSandboxNetwork()
	if len(*calls) != 0 || sandboxNetwork != "" {
		t.Fatalf("podman should not create a docker network: %v", *calls)
	}
	dir := filepath.Join(work, "sandbox-77")
	os.MkdirAll(dir, 0o755)
	f := filepath.Join(dir, "locked")
	os.WriteFile(f, nil, 0o644)
	RemoveWorkdir(dir, "sandbox-node")
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Fatal("workdir left behind")
	}
}

func TestLowDiskRefusesNewSandboxes(t *testing.T) {
	resetRegistry(t)
	withWorkDir(t)
	oldDisk := DiskFreeMB
	defer func() { DiskFreeMB = oldDisk }()
	Cfg.MinFreeDiskMB = 5120
	DiskFreeMB = func(string) int64 { return 4000 }
	if err := AddSandbox(Sandbox{Container: "d1", Owner: "a"}, 6, 1); err != ErrLowDisk || !IsCapacityError(err) {
		t.Fatalf("low disk = %v, want ErrLowDisk", err)
	}
	DiskFreeMB = func(string) int64 { return 9000 }
	if err := AddSandbox(Sandbox{Container: "d1", Owner: "a"}, 6, 1); err != nil {
		t.Fatal(err)
	}
	DiskFreeMB = func(string) int64 { return -1 }
	if err := AddSandbox(Sandbox{Container: "d2", Owner: "b"}, 6, 1); err != nil {
		t.Fatalf("unknown free space must not block: %v", err)
	}
}

func TestEveryBaseImageIsFullyQualified(t *testing.T) {
	qualified := regexp.MustCompile(`^(docker\.io|mcr\.microsoft\.com)/`)
	for _, b := range basePriority {
		if !qualified.MatchString(b.Image) {
			t.Errorf("compose base %q is a short name podman will not resolve", b.Image)
		}
	}
	dirs, _ := os.ReadDir(filepath.Join("..", "..", "sandbox-images"))
	for _, d := range dirs {
		b, err := os.ReadFile(filepath.Join("..", "..", "sandbox-images", d.Name(), "Dockerfile"))
		if err != nil {
			continue
		}
		for _, line := range strings.Split(string(b), "\n") {
			if from, ok := strings.CutPrefix(strings.TrimSpace(line), "FROM "); ok && !qualified.MatchString(from) {
				t.Errorf("sandbox-images/%s: %q is a short name", d.Name(), from)
			}
		}
	}
	if df := CompositeDockerfile([]string{"ruby"}); !strings.Contains(df, "FROM docker.io/library/ruby") {
		t.Errorf("composite base not qualified:\n%s", df)
	}
}

func TestDiskFloorUsesTheTightestPath(t *testing.T) {
	withWorkDir(t)
	old := DiskFreeMB
	defer func() { DiskFreeMB = old }()
	Cfg.DiskCheckPaths = []string{"/mnt/c", "/unmeasurable"}
	DiskFreeMB = func(p string) int64 {
		switch p {
		case "/mnt/c":
			return 3000
		case "/unmeasurable":
			return -1
		}
		return 900000
	}
	if got := LowestFreeDiskMB(); got != 3000 {
		t.Fatalf("lowest = %d, want the Windows drive's 3000", got)
	}
	resetRegistry(t)
	Cfg.MinFreeDiskMB = 5120
	if err := AddSandbox(Sandbox{Container: "w1", Owner: "a"}, 6, 1); err != ErrLowDisk {
		t.Fatalf("a full Windows drive behind a sparse WSL disk must still refuse: %v", err)
	}
}
