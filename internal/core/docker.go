package core

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
)

// Anonymous per-sandbox volumes: a cache shared between testers would let one poison another's installs.
func CacheMounts() []string {
	return []string{
		"-v", "/root/.npm",
		"-v", "/root/.cache/pip",
	}
}

// The container engine binary; podman accepts every docker argument used here.
func CLI() string { return Cfg.ContainerCLI }

func IsPodman() bool { return Cfg.ContainerCLI == "podman" }

// Sandboxes share this bridge with inter-container traffic off, so one tester's app cannot reach another's.
const SandboxNetwork = "jr-sandbox"

// Empty until EnsureSandboxNetwork succeeds; RunArgs then leaves containers on Docker's default bridge.
var sandboxNetwork = ""

// Dropped because nothing a repo installs or serves needs them, and each widens what a hostile repo can try.
var droppedCaps = []string{"NET_RAW", "MKNOD", "SYS_CHROOT", "AUDIT_WRITE", "SETFCAP"}

// Called before each start: if the engine was down at boot, the isolated network is created now instead of never.
func EnsureNetworkBeforeRun() {
	if sandboxNetwork == "" && !IsPodman() {
		EnsureSandboxNetwork()
	}
}

func EnsureSandboxNetwork() {
	if IsPodman() {
		Logf("docker", "podman: each rootless container gets its own network namespace, no shared bridge needed")
		return
	}
	if _, err := docker("network", "inspect", SandboxNetwork); err != nil {
		if out, err := docker("network", "create", "--driver", "bridge",
			"-o", "com.docker.network.bridge.enable_icc=false", SandboxNetwork); err != nil {
			Logf("docker", "could not create %s, sandboxes stay on the default bridge: %v %s", SandboxNetwork, err, strings.TrimSpace(out))
			return
		}
	}
	sandboxNetwork = SandboxNetwork
}

// Dev servers that open a browser crash in a sandbox: under Podman on WSL, is-wsl finds no /.dockerenv and spawns powershell.exe.
var HeadlessEnv = []string{"BROWSER=none"}

// inotify does not cross a Docker Desktop bind mount, so watchers poll there; native Linux needs no polling.
func WatcherEnv() []string {
	if runtime.GOOS == "linux" {
		return nil
	}
	return []string{"CHOKIDAR_USEPOLLING=true", "CHOKIDAR_INTERVAL=300", "WATCHPACK_POLLING=true"}
}

// One entry per service that serves HTTP.
type PortMap struct {
	Host      int `json:"host"`
	Container int `json:"container"`
}

// Host ports are published on 127.0.0.1 only, never the local network.
func RunArgs(container, memory, cpus string, pids int, ports []PortMap, workdir string, env, extraMounts []string, image, startCmd string) []string {
	args := []string{
		"run", "-d",
		"--name", container,
		"--label", SandboxLabel + "=" + container,
		"--memory", memory,
		"--cpus", cpus,
		"--pids-limit", strconv.Itoa(pids),
		"--security-opt", "no-new-privileges",
		"--ulimit", "nofile=65536:65536",
		"-v", fmt.Sprintf("%s:/workspace", workdir),
		"-w", "/workspace",
	}
	for _, c := range droppedCaps {
		args = append(args, "--cap-drop", c)
	}
	if sandboxNetwork != "" {
		args = append(args, "--network", sandboxNetwork)
	}
	for _, p := range ports {
		args = append(args, "-p", fmt.Sprintf("127.0.0.1:%d:%d", p.Host, p.Container))
	}
	for _, e := range env {
		args = append(args, "-e", e)
	}
	args = append(args, extraMounts...)
	args = append(args, image, "sh", "-c", startCmd)
	return args
}

// Each image and its build context under sandbox-images/, shared by PreheatImages
// and EnsureImage so the two can't disagree.
var Images = []struct{ Image, Dir string }{
	{"sandbox-static", "static-sites"},
	{"sandbox-node", "node"},
	{"sandbox-python", "python"},
	{"sandbox-django", "django"},
	{"sandbox-go", "go"},
	{"sandbox-java", "java"},
	{"sandbox-php", "php"},
	{"sandbox-ruby", "ruby"},
	{"sandbox-rust", "rust"},
	{"sandbox-dotnet", "dotnet"},
	{"sandbox-deno", "deno"},
	{"sandbox-bun", "bun"},
	{"sandbox-react", "react"},
	{"sandbox-builder", "builder"},
}

func ImageBuildDir(image string) string {
	for _, e := range Images {
		if e.Image == image {
			return "./sandbox-images/" + e.Dir
		}
	}
	return ""
}

func ImageExists(image string) bool {
	out, err := Output("", CLI(), "images", "-q", image)
	return err == nil && strings.TrimSpace(out) != ""
}

// Nil means every image; JR_PREHEAT_IMAGES narrows it, and the rest build the first time a repo needs them.
func PreheatImages() {
	if !EngineUp() {
		fmt.Println("Skipping sandbox image builds: " + EngineDownMessage() + " Images build on first use once it is up; Agent Hub and Workflows work without it.")
		return
	}
	want := map[string]bool{}
	for _, name := range Cfg.PreheatImages {
		want["sandbox-"+name] = true
	}
	for _, e := range Images {
		if Cfg.PreheatImages != nil && !want[e.Image] {
			continue
		}
		if ImageExists(e.Image) {
			fmt.Printf("%s already exists, skipping\n", e.Image)
			continue
		}
		path := "./sandbox-images/" + e.Dir
		fmt.Printf("Building %s from %s\n", e.Image, path)
		if err := Run("", CLI(), "build", "-t", e.Image, path); err != nil {
			fmt.Printf("Failed to build %s: %v\n", e.Image, err)
		} else {
			fmt.Printf("%s built successfully\n", e.Image)
		}
	}
	fmt.Println("Images ready")
}

// These images are local-only, so a missing one makes `docker run` fail pulling a
// name no registry has. Build it here instead.
func EnsureImage(container, image string) error {
	if ImageExists(image) {
		return nil
	}
	if IsComposite(image) {
		_, err := EnsureComposite(container, StacksFromImage(image))
		return err
	}
	dir := ImageBuildDir(image)
	if dir == "" {
		return fmt.Errorf("no build context for image %s", image)
	}
	AddLog(container, fmt.Sprintf("Image %s is not built yet — building from %s (first run only, this can take a few minutes)...", image, dir))
	if err := Run(container, CLI(), "build", "-t", image, dir); err != nil {
		return fmt.Errorf("could not build %s: %w", image, err)
	}
	AddLog(container, "Image "+image+" is ready")
	return nil
}

func ImageToStack(image string) string {
	return strings.TrimPrefix(image, "sandbox-")
}

// A host-side write does not reliably reach the container's view of a bind mount
// on Docker Desktop, so write the bytes back through the container instead.
func SyncFile(container, hostAbsPath, relPath string) {
	if data, err := os.ReadFile(hostAbsPath); err == nil {
		SyncBytes(container, relPath, data)
	}
}

// Writes data to /workspace/<relPath> inside the container; callers read it through os.Root first.
func SyncBytes(container, relPath string, data []byte) {
	if container == "" || relPath == "" {
		return
	}
	cp := "/workspace/" + strings.TrimPrefix(filepath.ToSlash(relPath), "/")
	// The path goes in as $0 so no shell quoting can misread it.
	c := exec.Command(CLI(), "exec", "-i", container, "sh", "-c", `cat > "$0"`, cp)
	c.Stdin = strings.NewReader(string(data))
	_ = c.Run()
}
