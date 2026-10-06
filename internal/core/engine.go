package core

import (
	"context"
	"os/exec"
	"sync"
	"time"
)

var engineCache struct {
	sync.Mutex
	at time.Time
	up bool
}

// Whether the container engine answers; cached briefly so a burst of requests costs one probe.
func EngineUp() bool {
	engineCache.Lock()
	defer engineCache.Unlock()
	if !engineCache.at.IsZero() && time.Since(engineCache.at) < 10*time.Second {
		return engineCache.up
	}
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	defer cancel()
	engineCache.up = exec.CommandContext(ctx, CLI(), "info").Run() == nil
	engineCache.at = time.Now()
	return engineCache.up
}

// What to tell someone whose engine is down, in terms of the tool they actually run.
func EngineDownMessage() string {
	if IsPodman() {
		return "Podman is not answering, so sandboxes cannot start. Check `podman info` on the server."
	}
	return "Docker is not running, so sandboxes cannot start. Start Docker Desktop, wait until it says it is running, then try again."
}
