package core

import (
	"errors"
	"sync"
	"time"
)

// Status values a sandbox moves through. Nothing is built until Approved.
const (
	StatusDetecting = "detecting"
	StatusAwaiting  = "awaiting-approval"
	StatusBuilding  = "building"
	StatusRunning   = "running"
	StatusFailed    = "failed"
)

type Sandbox struct {
	Container string `json:"container"`
	// The primary service's host port, so single-service callers are unaffected.
	Port      int       `json:"port"`
	Repo      string    `json:"repo"`
	Workdir   string    `json:"-"`
	Framework string    `json:"framework,omitempty"`
	Status    string    `json:"status,omitempty"`
	Image     string    `json:"image,omitempty"`
	Services  []Service `json:"services,omitempty"`
	Plan      *Plan     `json:"plan,omitempty"`
	Error     string    `json:"error,omitempty"`
	Owner     string    `json:"-"`
	CreatedAt time.Time `json:"createdAt"`
	// Bumped by any request that touches the sandbox; the idle TTL counts from here.
	LastActive time.Time `json:"-"`
	// Names the preview host; never the container name, which is guessable.
	PreviewToken string `json:"-"`
	// Filled in for responses only.
	URL string `json:"url,omitempty"`
}

// The service the preview opens, or false when nothing serves HTTP.
func (s Sandbox) PrimaryService() (Service, bool) {
	for _, svc := range s.Services {
		if svc.Primary {
			return svc, true
		}
	}
	return Service{}, false
}

var (
	sandboxes = map[string]Sandbox{}
	mutex     sync.Mutex
)

var (
	ErrAtCapacity = errors.New("the beta is at capacity right now, please try again in a few minutes")
	ErrUserLimit  = errors.New("you already have a sandbox running, stop it before starting another")
	ErrLowDisk    = errors.New("the server is low on disk space right now, please try again later")
)

// Swapped in tests; -1 means the platform cannot say.
var DiskFreeMB = diskFreeMB

// The tightest of the workdir and JR_DISK_CHECK_PATHS; -1 when none of them can be measured.
func LowestFreeDiskMB() int64 {
	lowest := int64(-1)
	for _, p := range append([]string{Cfg.WorkDir}, Cfg.DiskCheckPaths...) {
		if free := DiskFreeMB(p); free >= 0 && (lowest < 0 || free < lowest) {
			lowest = free
		}
	}
	return lowest
}

// Counts and inserts under one lock, so simultaneous requests cannot both take the last slot.
func AddSandbox(sb Sandbox, maxTotal, maxPerUser int) error {
	if Cfg.MinFreeDiskMB > 0 {
		if free := LowestFreeDiskMB(); free >= 0 && free < Cfg.MinFreeDiskMB {
			return ErrLowDisk
		}
	}
	mutex.Lock()
	defer mutex.Unlock()
	total, mine := 0, 0
	for _, s := range sandboxes {
		if s.Status == StatusFailed {
			continue
		}
		total++
		if s.Owner == sb.Owner {
			mine++
		}
	}
	if maxPerUser > 0 && mine >= maxPerUser {
		return ErrUserLimit
	}
	if maxTotal > 0 && total >= maxTotal {
		return ErrAtCapacity
	}
	now := time.Now()
	if sb.CreatedAt.IsZero() {
		sb.CreatedAt = now
	}
	sb.LastActive = now
	if sb.PreviewToken == "" {
		sb.PreviewToken = NewPreviewToken()
	}
	sandboxes[sb.Container] = sb
	return nil
}

func IsCapacityError(err error) bool {
	return errors.Is(err, ErrAtCapacity) || errors.Is(err, ErrUserLimit) || errors.Is(err, ErrLowDisk)
}

func PutSandbox(sb Sandbox) {
	mutex.Lock()
	defer mutex.Unlock()
	sandboxes[sb.Container] = sb
}

func GetSandbox(container string) (Sandbox, bool) {
	mutex.Lock()
	defer mutex.Unlock()
	sb, ok := sandboxes[container]
	return sb, ok
}

// Applies fn to the stored entry, so a concurrent reader never sees a half-update.
func UpdateSandbox(container string, fn func(*Sandbox)) {
	mutex.Lock()
	defer mutex.Unlock()
	if sb, ok := sandboxes[container]; ok {
		fn(&sb)
		sandboxes[container] = sb
	}
}

func DeleteSandbox(container string) {
	mutex.Lock()
	defer mutex.Unlock()
	delete(sandboxes, container)
}

// A copy keyed by container, which is the shape the front end expects from /sandboxes.
func SandboxMap() map[string]Sandbox {
	mutex.Lock()
	defer mutex.Unlock()
	out := make(map[string]Sandbox, len(sandboxes))
	for k, v := range sandboxes {
		out[k] = v
	}
	return out
}

func AllSandboxes() []Sandbox {
	mutex.Lock()
	defer mutex.Unlock()
	out := make([]Sandbox, 0, len(sandboxes))
	for _, sb := range sandboxes {
		out = append(out, sb)
	}
	return out
}

func CleanupAll() {
	for _, sb := range AllSandboxes() {
		Reap(sb, "shutdown")
	}
}
