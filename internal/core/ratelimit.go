package core

import (
	"sync"
	"time"
)

type hourWindow struct {
	start time.Time
	n     int
}

var (
	llmMu  sync.Mutex
	llmUse = map[string]*hourWindow{}
)

// Spends one model call from user's hourly budget; the agent service and an unset budget are never limited.
func AllowLLM(user string, now time.Time) (bool, time.Duration) {
	if Cfg.LLMPerHour <= 0 || user == InternalUser {
		return true, 0
	}
	llmMu.Lock()
	defer llmMu.Unlock()
	w, ok := llmUse[user]
	if !ok || now.Sub(w.start) >= time.Hour {
		if len(llmUse) > 10000 {
			llmUse = map[string]*hourWindow{}
		}
		llmUse[user] = &hourWindow{start: now, n: 1}
		return true, 0
	}
	if w.n >= Cfg.LLMPerHour {
		return false, w.start.Add(time.Hour).Sub(now)
	}
	w.n++
	return true, 0
}
