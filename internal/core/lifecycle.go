package core

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Every container we start carries this label, so a restart can find what it orphaned.
const SandboxLabel = "jrarch.sandbox"

const (
	// A failed sandbox stays long enough for its owner to read why.
	failedGrace  = 5 * time.Minute
	janitorEvery = 30 * time.Second
)

// Only directories os.MkdirTemp made for us; anything else under WorkDir is left alone.
var workspaceDirName = regexp.MustCompile(`^(sandbox|builder)-\d+$`)

// Swapped out in tests so reaping can be checked without a Docker daemon.
var docker = func(args ...string) (string, error) { return Output("", CLI(), args...) }

// Records owner activity; the idle TTL counts from the latest touch.
func Touch(container string) {
	mutex.Lock()
	defer mutex.Unlock()
	if sb, ok := sandboxes[container]; ok {
		sb.LastActive = time.Now()
		sandboxes[container] = sb
	}
}

// Why sb should go at now, or "" to keep it. Builds in progress are only bounded by the max lifetime.
func expiry(sb Sandbox, now time.Time, idle, max time.Duration) string {
	if !sb.CreatedAt.IsZero() && now.Sub(sb.CreatedAt) > max {
		return "max lifetime"
	}
	idleFor := now.Sub(sb.LastActive)
	switch sb.Status {
	case StatusFailed:
		if idleFor > failedGrace {
			return "failed"
		}
	case StatusRunning, StatusAwaiting:
		if idleFor > idle {
			return "idle"
		}
	}
	return ""
}

func ReapExpired(now time.Time) int {
	n := 0
	for _, sb := range AllSandboxes() {
		if why := expiry(sb, now, Cfg.IdleTTL, Cfg.MaxTTL); why != "" {
			Reap(sb, why)
			n++
		}
	}
	return n
}

func StartJanitor() {
	go func() {
		for range time.Tick(janitorEvery) {
			ReapExpired(time.Now())
		}
	}()
}

// Removes the container, its anonymous volumes, its workdir, its logs and its registry entry.
func Reap(sb Sandbox, reason string) {
	Logf("sandbox", "reaping %s owner=%s reason=%s age=%s", sb.Container, sb.Owner, reason, time.Since(sb.CreatedAt).Round(time.Second))
	docker("rm", "-f", "-v", sb.Container)
	RemoveWorkdir(sb.Workdir, sb.Image)
	DeleteSandbox(sb.Container)
	CloseTunnels(sb.Container)
	DropLogs(sb.Container)
}

func isWorkspaceDir(dir string) bool {
	if dir == "" {
		return false
	}
	clean := filepath.Clean(dir)
	return filepath.Dir(clean) == filepath.Clean(Cfg.WorkDir) && workspaceDirName.MatchString(filepath.Base(clean))
}

// Container root leaves root-owned files a non-root server cannot unlink, so those go from inside a container.
func RemoveWorkdir(dir, image string) {
	if !isWorkspaceDir(dir) {
		if dir != "" {
			Logf("sandbox", "not removing %s: not a workspace under %s", dir, Cfg.WorkDir)
		}
		return
	}
	if os.RemoveAll(dir) == nil {
		return
	}
	if IsPodman() {
		// Files a non-root process made in the container belong to a subordinate uid only the user namespace can delete.
		docker("unshare", "rm", "-rf", dir)
	} else if image == "" || IsComposite(image) {
		image = anyLocalImage()
	}
	if image != "" && !IsPodman() {
		docker("run", "--rm", "--network", "none", "-v", dir+":/w", "--entrypoint", "sh", image,
			"-c", "rm -rf /w/* /w/.[!.]* /w/..?*")
	}
	if err := os.RemoveAll(dir); err != nil {
		Logf("sandbox", "could not remove %s: %v", dir, err)
	}
}

func anyLocalImage() string {
	for _, e := range Images {
		if ImageExists(e.Image) {
			return e.Image
		}
	}
	return ""
}

// At startup nothing is registered, so every labelled container and every workspace dir is an orphan.
func ReapOrphans() {
	containers := 0
	if out, err := docker("ps", "-aq", "--filter", "label="+SandboxLabel); err == nil {
		for _, id := range strings.Fields(out) {
			docker("rm", "-f", "-v", id)
			containers++
		}
	}
	dirs := 0
	entries, _ := os.ReadDir(Cfg.WorkDir)
	for _, e := range entries {
		if e.IsDir() && workspaceDirName.MatchString(e.Name()) {
			RemoveWorkdir(filepath.Join(Cfg.WorkDir, e.Name()), "")
			dirs++
		}
	}
	Logf("sandbox", "startup cleanup removed %d container(s) and %d workdir(s)", containers, dirs)
}
