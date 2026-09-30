package main

import (
	"context"
	"embed"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"sandbox/internal/builder"
	"sandbox/internal/core"
	"sandbox/internal/server"
)

// The whole front end in one embedded directory. `all:` is required — plain embed
// skips files starting with "." or "_", and Monaco's build has some.
//
//go:embed all:web
var webAssets embed.FS

// Rooted at web/, so "/css/app.css" maps to "web/css/app.css".
var webFS = mustSub(webAssets, "web")

//go:embed all:builder-template
var builderTemplates embed.FS

func mustSub(f embed.FS, dir string) fs.FS {
	sub, err := fs.Sub(f, dir)
	if err != nil {
		panic("embedded assets are missing: " + err.Error()) // build-time mistake
	}
	return sub
}

// The Node agent service runs as a subprocess so its logs land in one place.
func startAgentService() {
	cmd := exec.Command("node", "server.js")
	cmd.Dir = filepath.Join(".", "agent-services")
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(),
		"ANTHROPIC_API_KEY="+os.Getenv("ANTHROPIC_API_KEY"),
		fmt.Sprintf("AGENT_PORT=%d", core.Cfg.AgentPort),
		// Side effects (docker exec, container write-through) belong to Go; the
		// agent service calls back here for them.
		"HOST_PORT="+core.Cfg.ListenPort(),
		"JR_WORK_DIR="+core.Cfg.WorkDir,
		"JR_INTERNAL_TOKEN="+core.Cfg.InternalToken,
		fmt.Sprintf("JR_LLM_PER_HOUR=%d", core.Cfg.LLMPerHour),
	)
	if err := cmd.Start(); err != nil {
		fmt.Printf("[agent-service] failed to start: %v\n", err)
		fmt.Println("[agent-services] chat panel will be unavailable — run 'cd agent-services && npm install' first")
		return
	}
	fmt.Printf("[agent-service] started (pid %d) on port %d\n", cmd.Process.Pid, core.Cfg.AgentPort)
	go func() {
		if err := cmd.Wait(); err != nil {
			fmt.Printf("[agent-service] exited: %v\n", err)
		}
	}()
}

func loadEnv() {
	file, err := os.Open(".env")
	if err != nil {
		return
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		return
	}

	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		parts := strings.SplitN(line, "=", 2)
		if len(parts) != 2 {
			continue
		}
		key := strings.TrimSpace(parts[0])
		val := strings.TrimSpace(parts[1])
		if (strings.HasPrefix(val, "\"") && strings.HasSuffix(val, "\"")) ||
			(strings.HasPrefix(val, "'") && strings.HasSuffix(val, "'")) {
			val = val[1 : len(val)-1]
		}
		if os.Getenv(key) == "" {
			os.Setenv(key, val)
		}
	}
}

func main() {
	loadEnv()
	cfg, err := core.LoadConfig()
	if err != nil {
		fmt.Println("config error:", err)
		os.Exit(1)
	}
	core.Cfg = cfg
	builder.SetTemplates(builderTemplates)

	core.ReapOrphans()
	if core.EngineUp() {
		core.EnsureSandboxNetwork()
	}
	core.StartJanitor()
	go core.PreheatImages()
	if cfg.SpawnAgent {
		go startAgentService()
	}

	mux := http.NewServeMux()
	server.Routes(mux, webFS)

	srv := &http.Server{
		Addr:              cfg.ListenAddr,
		Handler:           server.Front(mux),
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Graceful shutdown: stop tracked containers so they don't outlive the server.
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
		<-sigCh
		fmt.Println("\nShutting down — stopping sandboxes...")
		core.CleanupAll()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
		os.Exit(0)
	}()

	fmt.Printf("Sandbox server running on http://%s (public: %v, auth: %v)\n", cfg.ListenAddr, cfg.Public(), cfg.AuthEnabled())
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Printf("server error: %v\n", err)
	}
}
