package server

import (
	"fmt"
	"io/fs"
	"net/http"
	"strings"
	"time"

	"sandbox/internal/builder"
	"sandbox/internal/core"
)

// The whole HTTP surface in one place. webFS is the embedded front end, injected by main.
func Routes(mux *http.ServeMux, webFS fs.FS) {
	RegisterAssetMIMETypes()

	// Registered on "/" so it picks up everything the API routes don't claim.
	mux.Handle("/", StaticHandler(webFS))

	mux.HandleFunc("/login", func(w http.ResponseWriter, r *http.Request) {
		http.ServeFileFS(w, r, webFS, "login.html")
	})
	mux.HandleFunc("/auth/login", loginHandler)
	mux.HandleFunc("/auth/logout", logoutHandler)
	mux.HandleFunc("/auth/me", meHandler)
	mux.HandleFunc("/auth/providers", providersHandler)
	mux.HandleFunc("/auth/oauth/", oauthHandler)
	mux.HandleFunc("/health", healthHandler)
	mux.HandleFunc("/ready", readyHandler)

	mux.HandleFunc("/run", runHandler)
	mux.HandleFunc("/run/plan", runPlanHandler)
	mux.HandleFunc("/run/approve", runApproveHandler)
	mux.HandleFunc("/run/upload", runUploadHandler)
	mux.HandleFunc("/sandboxes", listHandler)
	mux.HandleFunc("/stop/", stopHandler)
	mux.HandleFunc("/logs/", logsHandler)

	mux.HandleFunc("/files", filesHandler)
	mux.HandleFunc("/file", fileReadHandler)
	mux.HandleFunc("/file/save", fileSaveHandler)
	mux.HandleFunc("/file/create", fileCreateHandler)
	mux.HandleFunc("/file/delete", fileDeleteHandler)
	mux.HandleFunc("/file/rename", fileRenameHandler)

	mux.HandleFunc("/sandbox/status", sandboxStatusHandler)
	mux.HandleFunc("/sandbox/sync", sandboxSyncHandler)
	mux.HandleFunc("/sandbox/entry", sandboxEntryHandler)

	mux.HandleFunc("/terminal/exec", terminalExecHandler)
	mux.HandleFunc("/terminal/ws", terminalWSHandler)
	mux.Handle("/agent/", agentProxyHandler())
	mux.Handle(hookPrefix, hooksHandler())
	mux.Handle(wfHookPrefix, hooksHandler())

	builder.Launch = launchGenerated
	builder.OnReady = autoPushBuild
	mux.HandleFunc("/build/questions", llmLimited(builder.QuestionsHandler))
	mux.HandleFunc("/build/prd", llmLimited(builder.PRDHandler))
	mux.HandleFunc("/build/scaffold", llmLimited(builder.ScaffoldHandler))
	mux.HandleFunc("/build/history", builder.HistoryHandler)

	mux.HandleFunc("/projects", projectsHandler)
	mux.HandleFunc("/projects/save", projectSaveHandler)
	mux.HandleFunc("/projects/open", projectOpenHandler)
	mux.HandleFunc("/projects/delete", projectDeleteHandler)

	mux.HandleFunc("/github/status", githubStatusHandler)
	mux.HandleFunc("/github/token", githubTokenHandler)
	mux.HandleFunc("/github/disconnect", githubDisconnectHandler)
	mux.HandleFunc("/github/repos", githubReposHandler)
	mux.HandleFunc("/github/branches", githubBranchesHandler)
	mux.HandleFunc("/github/sync", githubSyncStatusHandler)
	mux.HandleFunc("/github/pull", githubPullHandler)
	mux.HandleFunc("/github/push", githubPushHandler)
	mux.HandleFunc("/github/publish", githubPublishHandler)
	mux.HandleFunc("/github/prefs", githubPrefsHandler)
	mux.HandleFunc("/github/log", githubLogHandler)
	mux.HandleFunc("/github/show", githubShowHandler)
	mux.HandleFunc("/github/unshallow", githubUnshallowHandler)

	mux.HandleFunc("/settings/keys", keysHandler)
	mux.HandleFunc("/settings/keys/test", llmLimited(keyTestHandler))
}

// Each call spends from the user's hourly model budget, which the Groq keys are shared across.
func llmLimited(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions {
			h(w, r)
			return
		}
		if ok, wait := core.AllowLLM(core.UserOf(r), time.Now()); !ok {
			core.JSONError(w, fmt.Sprintf("hourly AI limit reached, try again in %d min", int(wait.Minutes())+1), 429)
			return
		}
		h(w, r)
	}
}

// Everything the listener serves, in the order a request meets it.
func Front(mux http.Handler) http.Handler {
	return PreviewDispatch(OriginGuard(RequireAuth(RequestLog(mux))))
}

// Writes and WebSocket upgrades from a foreign Origin (a preview subdomain included) never reach a handler.
func OriginGuard(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		origin := r.Header.Get("Origin")
		upgrade := strings.EqualFold(r.Header.Get("Upgrade"), "websocket")
		if origin != "" && (upgrade || !isSafeMethod(r.Method)) && !core.IsAllowedOrigin(origin) {
			core.Logf("origin", "refused %s %s from %s", r.Method, r.URL.Path, origin)
			core.JSONError(w, "origin not allowed", 403)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// Build mode's non-Next.js stacks run through the same pipeline as a cloned repo, approved automatically.
func launchGenerated(owner, label string, fill func(container, workdir string) error) (string, error) {
	if !engineUp() {
		return "", fmt.Errorf("%s", core.EngineDownMessage())
	}
	ensureNetwork()
	sb, err := startSandboxFrom(owner, label, "", "", true, fill)
	return sb.Container, err
}
