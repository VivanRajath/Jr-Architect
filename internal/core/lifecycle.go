package core

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

// Every container we start carries this label, so a restart can find what it orphaned.
const SandboxLabel = "jrarch.sandbox"

// Which server started a container, so a second Jr Architect on the same machine never removes the first one's sandboxes.
const InstanceLabel = "jrarch.instance"

// Stable per data folder and port: a restart of the same server recognises its own containers.
func InstanceID() string {
	dir, _ := filepath.Abs(Cfg.DataDir)
	sum := sha256.Sum256([]byte(dir + "|" + Cfg.ListenPort()))
	return hex.EncodeToString(sum[:6])
}

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
		for tick := 1; ; tick++ {
			time.Sleep(janitorEvery)
			ReapExpired(time.Now())
			// Walking node_modules is the costly part, so sizes are checked every other minute.
			if tick%4 == 0 {
				ReapOversized()
			}
		}
	}()
}

// Swapped in tests. Regular files only, so a link cannot make a sandbox look bigger or smaller than it is.
var workdirSizeMB = func(dir string) int64 {
	var total int64
	filepath.WalkDir(dir, func(_ string, d fs.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, e := d.Info(); e == nil {
				total += info.Size()
			}
		}
		return nil
	})
	return total >> 20
}

// The storage pools cap every sandbox together; this stops one tester from filling the pool for the rest.
func ReapOversized() int {
	if Cfg.MaxSandboxDiskMB <= 0 {
		return 0
	}
	n := 0
	for _, sb := range AllSandboxes() {
		if sb.Workdir == "" {
			continue
		}
		if mb := workdirSizeMB(sb.Workdir); mb > Cfg.MaxSandboxDiskMB {
			Reap(sb, fmt.Sprintf("disk: workdir %dMB over the %dMB limit", mb, Cfg.MaxSandboxDiskMB))
			n++
		}
	}
	return n
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

// At startup nothing is registered, so this server's containers (and unlabelled ones from older versions) are orphans; another server's are left alone, with their workspaces.
func ReapOrphans() {
	containers := 0
	inUse := map[string]bool{}
	me := InstanceID()
	if out, err := docker("ps", "-a", "--filter", "label="+SandboxLabel, "--format", `{{.ID}} {{.Label "`+InstanceLabel+`"}}`); err == nil {
		for _, line := range strings.Split(strings.TrimSpace(out), "\n") {
			f := strings.Fields(line)
			if len(f) == 0 {
				continue
			}
			if len(f) > 1 && f[1] != me {
				if src, err := docker("inspect", "--format", `{{range .Mounts}}{{if eq .Destination "/workspace"}}{{.Source}}{{end}}{{end}}`, f[0]); err == nil && strings.TrimSpace(src) != "" {
					inUse[filepath.Base(filepath.FromSlash(strings.ReplaceAll(strings.TrimSpace(src), "\\", "/")))] = true
				}
				continue
			}
			docker("rm", "-f", "-v", f[0])
			containers++
		}
	}
	dirs := 0
	entries, _ := os.ReadDir(Cfg.WorkDir)
	for _, e := range entries {
		if e.IsDir() && workspaceDirName.MatchString(e.Name()) && !inUse[e.Name()] {
			RemoveWorkdir(filepath.Join(Cfg.WorkDir, e.Name()), "")
			dirs++
		}
	}
	Logf("sandbox", "startup cleanup removed %d container(s) and %d workdir(s)", containers, dirs)
}
