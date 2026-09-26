package server

import (
	"bufio"
	"context"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	"github.com/docker/docker/client"

	"sandbox/internal/core"
)

const minFreeDiskMB = 1024

// Swapped in tests; each answers within a few seconds so a hung dependency cannot hang the probe.
var (
	dockerUp = func() bool {
		cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
		if err != nil {
			return false
		}
		defer cli.Close()
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		_, err = cli.Ping(ctx)
		return err == nil
	}
	agentUp = func() bool {
		c := http.Client{Timeout: 3 * time.Second}
		res, err := c.Get(fmt.Sprintf("http://127.0.0.1:%d/agent/health", core.Cfg.AgentPort))
		if err != nil {
			return false
		}
		res.Body.Close()
		return res.StatusCode == 200
	}
	freeDiskMB = core.LowestFreeDiskMB
)

// Public on purpose: uptime monitors call it without a session. It reports counts, never names.
func healthHandler(w http.ResponseWriter, r *http.Request) {
	running := 0
	for _, sb := range core.AllSandboxes() {
		if sb.Status != core.StatusFailed {
			running++
		}
	}
	d, a, disk := dockerUp(), agentUp(), freeDiskMB()
	ok := d && a && (disk < 0 || disk >= minFreeDiskMB)
	status := "ok"
	if !ok {
		status = "degraded"
		w.WriteHeader(http.StatusServiceUnavailable)
	}
	writeJSON(w, map[string]interface{}{
		"status": status, "docker": d, "agent": a, "diskFreeMB": disk,
		"sandboxes": running, "maxSandboxes": core.Cfg.MaxSandboxes,
	})
}

type loggedResponse struct {
	http.ResponseWriter
	code int
}

func (l *loggedResponse) WriteHeader(code int) {
	l.code = code
	l.ResponseWriter.WriteHeader(code)
}

// The terminal and preview sockets hijack the connection, so the wrapper has to pass that through.
func (l *loggedResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	l.code = http.StatusSwitchingProtocols
	return http.NewResponseController(l.ResponseWriter).Hijack()
}

func (l *loggedResponse) Flush()                      { http.NewResponseController(l.ResponseWriter).Flush() }
func (l *loggedResponse) Unwrap() http.ResponseWriter { return l.ResponseWriter }

// Writes, socket upgrades and failures; the page assets and timer polls would drown them out.
func RequestLog(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		lw := &loggedResponse{ResponseWriter: w, code: 200}
		next.ServeHTTP(lw, r)
		upgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
		if r.Method == http.MethodGet && !upgrade && lw.code < 400 {
			return
		}
		core.Logf("http", "%s %s host=%s user=%s status=%d dur=%s", r.Method, r.URL.Path, r.Host, core.UserOf(r), lw.code, time.Since(start).Round(time.Millisecond))
	})
}
