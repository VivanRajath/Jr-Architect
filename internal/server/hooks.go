package server

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"sandbox/internal/core"
)

const (
	hookPrefix     = "/hooks/agents/"
	wfHookPrefix   = "/hooks/workflows/"
	hookBodyLimit  = 256 << 10
	hooksPerMinute = 30
	// Never a real session user, so hub routes can tell an n8n call from a person.
	hookUser = "hook"
)

var hookLimiter = newMinuteLimiter(hooksPerMinute)

// n8n and other workflow tools call agents here with an agent token; Node checks the token, so no session is needed.
func isHookPath(p string) bool {
	return strings.HasPrefix(p, hookPrefix) || strings.HasPrefix(p, wfHookPrefix)
}

// Where each public hook prefix lands in the agent service.
func hookTarget(p string) (string, bool) {
	switch {
	case strings.HasPrefix(p, hookPrefix):
		return "/agent/hub/hook/", true
	case strings.HasPrefix(p, wfHookPrefix):
		return "/agent/hub/hook-wf/", true
	}
	return "", false
}

func hooksHandler() http.Handler {
	return newHookProxy(fmt.Sprintf("http://127.0.0.1:%d", core.Cfg.AgentPort))
}

func newHookProxy(targetURL string) http.Handler {
	proxy := newAgentProxy(targetURL)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		if !hookLimiter.allow(clientIP(r), time.Now()) {
			core.JSONError(w, "too many agent calls, wait a minute", 429)
			return
		}
		target, ok := hookTarget(r.URL.Path)
		rest := strings.TrimPrefix(strings.TrimPrefix(r.URL.Path, hookPrefix), wfHookPrefix)
		if !ok || rest == "" || strings.Contains(rest, "..") {
			http.NotFound(w, r)
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, hookBodyLimit)
		r.URL.Path = target + rest
		r.URL.RawPath = ""
		if u, err := url.Parse(r.URL.String()); err == nil {
			r.URL = u
		}
		proxy.ServeHTTP(w, core.WithUser(r, hookUser))
	})
}
