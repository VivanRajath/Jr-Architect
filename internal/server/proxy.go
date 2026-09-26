package server

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"path"
	"strings"

	"sandbox/internal/core"
)

// Only Go calls these, straight on the loopback port; /agent/register takes an arbitrary host workdir.
var internalAgentPaths = map[string]bool{"/agent/register": true}

func agentProxyHandler() http.Handler {
	return newAgentProxy(fmt.Sprintf("http://127.0.0.1:%d", core.Cfg.AgentPort))
}

// newAgentProxy reverse-proxies /agent/* (REST and the /agent/ws WebSocket) to
// the Node agent service. httputil.ReverseProxy transparently tunnels the
// WebSocket upgrade, so the streaming agent stream reaches the browser through
// the same origin as the IDE. Split out from agentProxyHandler so tests can
// point it at a stub backend.
func newAgentProxy(targetURL string) http.Handler {
	target, _ := url.Parse(targetURL)
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		core.CORS(w, r)
		core.JSONError(w, "Agent service unavailable: "+err.Error(), 502)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		core.CORS(w, r)
		if r.Method == http.MethodOptions {
			return
		}
		if internalAgentPaths[strings.ToLower(path.Clean(r.URL.Path))] {
			http.NotFound(w, r)
			return
		}
		// Node trusts this header for ownership, so a client-supplied copy never survives.
		r.Header.Set("X-Jr-User", core.UserOf(r))
		r.Header.Del("X-Jr-Internal")
		r.Header.Del("Cookie")
		proxy.ServeHTTP(w, r)
	})
}
