package main

import (
	"context"
	"embed"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/client"
	"github.com/gorilla/websocket"
)

// resolveInWorkspace joins rel to workdir and guarantees the cleaned result
// stays inside workdir. The naive strings.HasPrefix check is unsafe because a
// sibling directory (e.g. "workdir-evil") shares the prefix "workdir"; we
// require an exact match or a path separator boundary.
func resolveInWorkspace(workdir, rel string) (string, bool) {
	abs := filepath.Clean(filepath.Join(workdir, filepath.FromSlash(rel)))
	if abs != workdir && !strings.HasPrefix(abs, workdir+string(os.PathSeparator)) {
		return "", false
	}
	return abs, true
}

// validateRepoURL rejects anything that isn't a plain http(s) URL. This prevents
// git argument injection (a value starting with "-" is read as a flag) and
// local/file:// clones that would reach into the host filesystem.
func validateRepoURL(repo string) error {
	repo = strings.TrimSpace(repo)
	if repo == "" {
		return fmt.Errorf("repo URL is required")
	}
	if strings.HasPrefix(repo, "-") {
		return fmt.Errorf("invalid repo URL")
	}
	u, err := url.Parse(repo)
	if err != nil {
		return fmt.Errorf("invalid repo URL: %w", err)
	}
	if u.Scheme != "http" && u.Scheme != "https" {
		return fmt.Errorf("repo URL must use http or https")
	}
	if u.Host == "" {
		return fmt.Errorf("repo URL must include a host")
	}
	return nil
}

// sandboxCacheMounts returns shared Docker named-volume mounts for package
// caches. Named volumes (not host paths) keep installs fast across sandboxes
// without giving untrusted repo code write access to the host's caches.
func sandboxCacheMounts() []string {
	return []string{
		"-v", "sandbox-npm-cache:/root/.npm",
		"-v", "sandbox-pip-cache:/root/.cache/pip",
	}
}

// dockerRunArgs builds the argument list for `docker run` for a sandbox
// container. Host ports are published on 127.0.0.1 only so sandboxes are never
// exposed to the local network. extraMounts (e.g. cache volumes) are inserted
// before the image name.
func dockerRunArgs(container, memory, cpus string, pids, hostPort, containerPort int, workdir string, env, extraMounts []string, image, startCmd string) []string {
	args := []string{
		"run", "-d",
		"--name", container,
		"--memory", memory,
		"--cpus", cpus,
		"--pids-limit", strconv.Itoa(pids),
		"-p", fmt.Sprintf("127.0.0.1:%d:%d", hostPort, containerPort),
		"-v", fmt.Sprintf("%s:/workspace", workdir),
		"-w", "/workspace",
	}
	for _, e := range env {
		args = append(args, "-e", e)
	}
	args = append(args, extraMounts...)
	args = append(args, image, "sh", "-c", startCmd)
	return args
}

// cleanupAllSandboxes stops and removes every tracked container. Called on
// graceful shutdown so containers don't outlive the server.
func cleanupAllSandboxes() {
	mutex.Lock()
	names := make([]string, 0, len(sandboxes))
	for name := range sandboxes {
		names = append(names, name)
	}
	mutex.Unlock()
	for _, name := range names {
		run("", "docker", "stop", name)
		// Force-remove (-f) so a container that hasn't fully stopped yet — e.g. one
		// still mid `npm install` — is torn down instead of erroring with
		// "container is running". -v also drops the anonymous volumes.
		run("", "docker", "rm", "-f", "-v", name)
	}
}

//go:embed index.html
var staticFiles embed.FS

//go:embed ide.css
var ideCSSFile []byte

//go:embed ide.js
var ideJSFile []byte

//go:embed ide-agent.css
var ideAgentCSSFile []byte

//go:embed ide-agent.js
var ideAgentJSFile []byte

//go:embed all:builder-template
var builderTemplateFS embed.FS

type Request struct {
	Repo         string `json:"repo"`
	Instructions string `json:"instructions,omitempty"`
	Mode         string `json:"mode,omitempty"`
}

type Sandbox struct {
	Container string `json:"container"`
	Port      int    `json:"port"`
	Repo      string `json:"repo"`
	Workdir   string `json:"-"`
	Framework string `json:"framework,omitempty"` // e.g. "Next.js (Lyzr App)"
}

var (
	sandboxes = map[string]Sandbox{}
	mutex     sync.Mutex
	setupLogs = map[string]*strings.Builder{}
	logsMutex sync.Mutex
)

func addLog(container, msg string) {
	logsMutex.Lock()
	defer logsMutex.Unlock()
	if _, ok := setupLogs[container]; !ok {
		setupLogs[container] = &strings.Builder{}
	}
	fmt.Fprintf(setupLogs[container], "[%s] %s\n", time.Now().Format("15:04:05"), msg)
	fmt.Println(msg)
}

func run(container, cmd string, args ...string) error {
	if container != "" {
		addLog(container, fmt.Sprintf("Running: %s %v", cmd, args))
	}
	c := exec.Command(cmd, args...)
	out, err := c.CombinedOutput()
	if err != nil {
		if container != "" {
			addLog(container, fmt.Sprintf("Error: %v\nOutput: %s", err, string(out)))
		} else {
			fmt.Println(string(out))
		}
	}
	return err
}

func output(container, cmd string, args ...string) (string, error) {
	if container != "" {
		addLog(container, fmt.Sprintf("Running: %s %v", cmd, args))
	}
	c := exec.Command(cmd, args...)
	out, err := c.CombinedOutput()
	return string(out), err
}

func corsHeaders(w http.ResponseWriter) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
	w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func getFreePort() (int, error) {
	l, err := net.Listen("tcp", ":0")
	if err != nil {
		return 0, err
	}
	defer l.Close()
	return l.Addr().(*net.TCPAddr).Port, nil
}

func waitForServer(port int) bool {
	client := http.Client{Timeout: 3 * time.Second}
	for i := 0; i < 300; i++ {
		resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d", port))
		if err == nil {
			ready := resp.StatusCode < 500
			resp.Body.Close()
			if ready {
				return true
			}
		}
		time.Sleep(1 * time.Second)
	}
	return false
}

func preheatImages() {
	imageMap := map[string]string{
		"static":  "static-sites",
		"node":    "node",
		"python":  "python",
		"go":      "go",
		"java":    "java",
		"php":     "php",
		"ruby":    "ruby",
		"rust":    "rust",
		"dotnet":  "dotnet",
		"deno":    "deno",
		"bun":     "bun",
		"react":   "react",
		"builder": "builder",
	}
	keys := []string{"static", "node", "python", "go", "java", "php", "ruby", "rust", "dotnet", "deno", "bun", "react", "builder"}
	for _, img := range keys {
		imageName := "sandbox-" + img
		folder := imageMap[img]
		out, err := output("", "docker", "images", "-q", imageName)
		if err == nil && strings.TrimSpace(out) != "" {
			fmt.Printf("%s already exists, skipping\n", imageName)
			continue
		}
		path := "./sandbox-images/" + folder
		fmt.Printf("Building %s from %s\n", imageName, path)
		buildErr := run("", "docker", "build", "-t", imageName, path)
		if buildErr != nil {
			fmt.Printf("Failed to build %s: %v\n", imageName, buildErr)
		} else {
			fmt.Printf("%s built successfully\n", imageName)
		}
	}
	fmt.Println("Images ready")
}

// imageToStack strips the "sandbox-" prefix to get a clean stack name
// e.g. "sandbox-react" -> "react", "sandbox-node" -> "node"
func imageToStack(image string) string {
	return strings.TrimPrefix(image, "sandbox-")
}

func startSandbox(repo string, instructions string, mode string) (Sandbox, error) {
	if err := validateRepoURL(repo); err != nil {
		return Sandbox{}, err
	}

	workdir, err := os.MkdirTemp("", "sandbox-*")
	if err != nil {
		return Sandbox{}, err
	}
	os.Remove(workdir)

	container := "sandbox-" + filepath.Base(workdir)
	port, err := getFreePort()
	if err != nil {
		return Sandbox{}, err
	}

	abs, _ := filepath.Abs(workdir)
	sb := Sandbox{
		Container: container,
		Port:      port,
		Repo:      repo,
		Workdir:   abs,
	}

	mutex.Lock()
	sandboxes[container] = sb
	mutex.Unlock()

	setupFunc := func() error {
		addLog(container, "Cloning repo: "+repo)
		err := run(
			container,
			"git", "clone",
			"--depth", "1",
			"--single-branch",
			"--recurse-submodules=no",
			"--", repo, workdir,
		)
		if err != nil {
			addLog(container, "Failed to clone repo: "+err.Error())
			return err
		}

		if strings.TrimSpace(instructions) != "" {
			err = os.WriteFile(filepath.Join(workdir, "INSTRUCTIONS.md"), []byte(instructions), 0644)
			if err != nil {
				return err
			}
		}

		addLog(container, "Detecting runtime...")
		runtimeConfig, err := detectRuntimeConfig(workdir)
		if err != nil {
			addLog(container, "Runtime detection failed: "+err.Error())
			return err
		}
		addLog(container, fmt.Sprintf("Runtime detected: image=%s, port=%d, cmd=%s", runtimeConfig.Image, runtimeConfig.Port, runtimeConfig.StartupCommand))

		// Record the framework label so the IDE can show what kind of app this is
		// (detection is async, so the sandbox entry is updated here after cloning).
		framework := runtimeConfig.Framework
		if framework == "" {
			framework = frameworkFromImage(runtimeConfig.Image)
		}
		mutex.Lock()
		if s, ok := sandboxes[container]; ok {
			s.Framework = framework
			sandboxes[container] = s
		}
		mutex.Unlock()
		addLog(container, "Framework: "+framework)

		// ── GitAgent spec generation ──
		stack := imageToStack(runtimeConfig.Image)
		if specErr := GenerateAgentSpec(workdir, stack); specErr != nil {
			addLog(container, "Warning: GitAgent spec generation failed: "+specErr.Error())
			// non-fatal — sandbox still runs without agent spec
		} else {
			addLog(container, "GitAgent spec generated for stack: "+stack)
			// Layer 1 of code retrieval: build a repo map so the agent knows the
			// codebase's shape up front. Best-effort — never blocks the sandbox.
			if mapErr := generateRepoMap(workdir, stack, framework); mapErr != nil {
				addLog(container, "Warning: repo map generation failed: "+mapErr.Error())
			} else {
				addLog(container, "Repo map generated (knowledge/repo-map.md)")
			}
			go RegisterWithAgentService(container, abs, stack)
		}

		env := []string{
			fmt.Sprintf("PORT=%d", runtimeConfig.Port),
			"NEXT_TELEMETRY_DISABLED=1",
			"CI=1",
			// Poll the filesystem for changes so the dev server's HMR / fast-refresh
			// picks up edits made through the IDE. On Windows/macOS Docker Desktop,
			// inotify events do NOT cross a bind mount, so a host-side file save is
			// invisible to an event-based watcher inside the container — without
			// polling, the preview never live-reloads. Ignored by tools that don't
			// use these watchers, so it's safe across every stack.
			"CHOKIDAR_USEPOLLING=true", // Vite, CRA/webpack, most chokidar watchers
			"CHOKIDAR_INTERVAL=300",
			"WATCHPACK_POLLING=true", // Next.js (webpack watchpack)
		}
		args := dockerRunArgs(container, "1024m", "1", 100, port, runtimeConfig.Port, abs, env, sandboxCacheMounts(), runtimeConfig.Image, runtimeConfig.StartupCommand)

		addLog(container, "Starting Docker container...")
		err = run(container, "docker", args...)
		if err != nil {
			addLog(container, "Failed to start container: "+err.Error())
			return err
		}

		if !waitForServer(port) {
			addLog(container, "Warning: server not ready yet")
			out, _ := output(container, "docker", "logs", "--tail", "50", container)
			addLog(container, "--- Container Logs ---\n"+out+"\n----------------------")
		} else {
			addLog(container, fmt.Sprintf("Server is ready! The app is running in this url: http://127.0.0.1:%d", port))
		}

		go func() {
			time.Sleep(10 * time.Minute)
			run("", "docker", "stop", container)
			run("", "docker", "rm", "-v", container)
			os.RemoveAll(workdir)
			mutex.Lock()
			delete(sandboxes, container)
			mutex.Unlock()
		}()

		return nil
	}

	// Setup (clone, detect, docker run, wait-for-ready) can take minutes, so it
	// always runs in the background. The handler returns immediately and the
	// frontend polls /sandbox/status and /logs for progress.
	go func() {
		if err := setupFunc(); err != nil {
			fmt.Printf("Sandbox setup failed: %v\n", err)
			mutex.Lock()
			delete(sandboxes, container)
			mutex.Unlock()
			os.RemoveAll(workdir)
		}
	}()

	return sb, nil
}

func runHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}
	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}
	mode := req.Mode
	if mode == "" {
		mode = "prompt"
	}
	sb, err := startSandbox(req.Repo, req.Instructions, mode)
	if err != nil {
		jsonError(w, err.Error(), 400)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "running",
		"container": sb.Container,
		"url":       fmt.Sprintf("http://127.0.0.1:%d", sb.Port),
		"mode":      mode,
	})
}

func listHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	w.Header().Set("Content-Type", "application/json")
	mutex.Lock()
	defer mutex.Unlock()
	json.NewEncoder(w).Encode(sandboxes)
}

func stopHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	container := strings.TrimPrefix(r.URL.Path, "/stop/")
	mutex.Lock()
	_, ok := sandboxes[container]
	mutex.Unlock()
	if !ok {
		jsonError(w, "sandbox not found", 404)
		return
	}
	run("", "docker", "stop", container)
	run("", "docker", "rm", "-v", container)
	mutex.Lock()
	delete(sandboxes, container)
	mutex.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "stopped"})
}

func logsHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "text/plain")
	container := strings.TrimPrefix(r.URL.Path, "/logs/")
	logsMutex.Lock()
	slog := ""
	if b, ok := setupLogs[container]; ok {
		slog = b.String()
	}
	logsMutex.Unlock()
	out, err := output("", "docker", "logs", container)
	if err != nil {
		fmt.Fprint(w, slog+"\n[Error fetching container logs: "+err.Error()+"]")
		return
	}
	fmt.Fprint(w, slog+"\n"+out)
}

type FileNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	IsDir    bool       `json:"isDir"`
	Children []FileNode `json:"children,omitempty"`
}

func buildFileTree(root string) ([]FileNode, error) {
	skip := map[string]bool{
		".git": true, "node_modules": true, "__pycache__": true,
		".next": true, "vendor": true, ".venv": true, "venv": true,
	}
	var walk func(dir, rel string) ([]FileNode, error)
	walk = func(dir, rel string) ([]FileNode, error) {
		entries, err := os.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		var nodes []FileNode
		for _, e := range entries {
			name := e.Name()
			if skip[name] {
				continue
			}
			childRel := rel + "/" + name
			if rel == "" {
				childRel = name
			}
			node := FileNode{Name: name, Path: childRel, IsDir: e.IsDir()}
			if e.IsDir() {
				node.Children, _ = walk(filepath.Join(dir, name), childRel)
			}
			nodes = append(nodes, node)
		}
		return nodes, nil
	}
	return walk(root, "")
}

func filesHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}
	containerID := r.URL.Query().Get("container")
	mutex.Lock()
	sb, ok := sandboxes[containerID]
	mutex.Unlock()
	if !ok {
		jsonError(w, "sandbox not found", 404)
		return
	}
	tree, err := buildFileTree(sb.Workdir)
	if err != nil {
		// The workspace dir is created asynchronously by the clone/scaffold step,
		// so a request that arrives before setup finishes finds no directory yet.
		// Return an empty tree (200) rather than a 500 so the frontend can poll
		// and populate once files appear, instead of throwing on an error object.
		if os.IsNotExist(err) {
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode([]FileNode{})
			return
		}
		jsonError(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tree)
}

func fileReadHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}
	containerID := r.URL.Query().Get("container")
	filePath := r.URL.Query().Get("path")
	mutex.Lock()
	sb, ok := sandboxes[containerID]
	mutex.Unlock()
	if !ok {
		jsonError(w, "sandbox not found", 404)
		return
	}
	absPath, ok := resolveInWorkspace(sb.Workdir, filePath)
	if !ok {
		jsonError(w, "path outside workspace", 403)
		return
	}
	info, err := os.Stat(absPath)
	if err != nil {
		jsonError(w, "file not found", 404)
		return
	}
	if info.IsDir() {
		jsonError(w, "path is a directory", 400)
		return
	}
	if info.Size() > 2*1024*1024 {
		jsonError(w, "file too large (>2 MB)", 400)
		return
	}
	data, err := os.ReadFile(absPath)
	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	w.Write(data)
}

type FileSaveRequest struct {
	Container string `json:"container"`
	Path      string `json:"path"`
	Content   string `json:"content"`
}

func fileSaveHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}
	var req FileSaveRequest
	body, _ := io.ReadAll(io.LimitReader(r.Body, 5*1024*1024))
	if err := json.Unmarshal(body, &req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	mutex.Lock()
	sb, ok := sandboxes[req.Container]
	mutex.Unlock()
	if !ok {
		jsonError(w, "sandbox not found", 404)
		return
	}
	absPath, ok := resolveInWorkspace(sb.Workdir, req.Path)
	if !ok {
		jsonError(w, "path outside workspace", 403)
		return
	}
	if err := os.MkdirAll(filepath.Dir(absPath), fs.ModePerm); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	if err := os.WriteFile(absPath, []byte(req.Content), 0644); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "saved"})
}

type FileCreateRequest struct {
	Container string `json:"container"`
	Path      string `json:"path"`
	IsDir     bool   `json:"isDir"`
}

func fileCreateHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}
	var req FileCreateRequest
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024))
	if err := json.Unmarshal(body, &req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	mutex.Lock()
	sb, ok := sandboxes[req.Container]
	mutex.Unlock()
	if !ok {
		jsonError(w, "sandbox not found", 404)
		return
	}
	absPath, ok := resolveInWorkspace(sb.Workdir, req.Path)
	if !ok {
		jsonError(w, "path outside workspace", 403)
		return
	}
	if req.IsDir {
		if err := os.MkdirAll(absPath, fs.ModePerm); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
	} else {
		if err := os.MkdirAll(filepath.Dir(absPath), fs.ModePerm); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
		if err := os.WriteFile(absPath, []byte(""), 0644); err != nil {
			jsonError(w, err.Error(), 500)
			return
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "created"})
}

type FileDeleteRequest struct {
	Container string `json:"container"`
	Path      string `json:"path"`
}

func fileDeleteHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}
	var req FileDeleteRequest
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024))
	if err := json.Unmarshal(body, &req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	mutex.Lock()
	sb, ok := sandboxes[req.Container]
	mutex.Unlock()
	if !ok {
		jsonError(w, "sandbox not found", 404)
		return
	}
	absPath, ok := resolveInWorkspace(sb.Workdir, req.Path)
	if !ok {
		jsonError(w, "path outside workspace", 403)
		return
	}
	if err := os.RemoveAll(absPath); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

func sandboxStatusHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}
	containerID := r.URL.Query().Get("container")
	mutex.Lock()
	sb, ok := sandboxes[containerID]
	mutex.Unlock()
	if !ok {
		jsonError(w, "sandbox not found", 404)
		return
	}
	out, err := output("", "docker", "inspect", "--format", "{{.State.Status}}", sb.Container)
	status := strings.TrimSpace(out)
	if err != nil {
		status = "unknown"
	}
	if status == "running" {
		client := http.Client{Timeout: 2 * time.Second}
		resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d", sb.Port))
		if err != nil {
			status = "starting"
		} else {
			if resp.StatusCode >= 500 {
				status = "starting"
			}
			resp.Body.Close()
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"container": sb.Container,
		"port":      sb.Port,
		"repo":      sb.Repo,
		"status":    status,
		"url":       fmt.Sprintf("http://127.0.0.1:%d", sb.Port),
		"framework": sb.Framework,
	})
}

// uiEntryCandidates are common "main UI" files, most-specific first. The first
// one that exists in the workspace is treated as where the app's UI lives, so the
// IDE can jump straight to it from the preview.
var uiEntryCandidates = []string{
	"app/page.tsx", "app/page.jsx", "app/page.js", "app/page.mdx", // Next.js app router
	"src/app/page.tsx", "src/app/page.jsx", "src/app/page.js",
	"pages/index.tsx", "pages/index.jsx", "pages/index.js", // Next.js pages router
	"src/pages/index.tsx", "src/pages/index.jsx",
	"src/App.tsx", "src/App.jsx", "src/App.js", "src/App.vue", "src/App.svelte", // CRA/Vite/Vue/Svelte
	"src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js",
	"src/index.tsx", "src/index.jsx",
	"app/App.tsx",
	"index.html", "public/index.html", "src/index.html", // static
	"templates/index.html", // flask/django
}

// sandboxEntryHandler returns the best-guess "main UI" file for a sandbox as a
// workspace-relative path (forward slashes, matching the file-tree paths) plus
// its directory, so the preview's "locate UI code" control can open/reveal it.
func sandboxEntryHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}
	containerID := r.URL.Query().Get("container")
	mutex.Lock()
	sb, ok := sandboxes[containerID]
	mutex.Unlock()
	if !ok {
		jsonError(w, "sandbox not found", 404)
		return
	}
	for _, c := range uiEntryCandidates {
		p := filepath.Join(sb.Workdir, filepath.FromSlash(c))
		if st, err := os.Stat(p); err == nil && !st.IsDir() {
			dir := ""
			if i := strings.LastIndex(c, "/"); i >= 0 {
				dir = c[:i]
			}
			w.Header().Set("Content-Type", "application/json")
			json.NewEncoder(w).Encode(map[string]string{"path": c, "dir": dir})
			return
		}
	}
	jsonError(w, "no UI entry file found yet", 404)
}

type TerminalExecRequest struct {
	Container string `json:"container"`
	Command   string `json:"command"`
}

func terminalExecHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}
	var req TerminalExecRequest
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024))
	if err := json.Unmarshal(body, &req); err != nil {
		jsonError(w, "invalid JSON", 400)
		return
	}
	mutex.Lock()
	_, ok := sandboxes[req.Container]
	mutex.Unlock()
	if !ok {
		jsonError(w, "sandbox not found", 404)
		return
	}
	out, err := output("", "docker", "exec", req.Container, "sh", "-c", req.Command)
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
	if err != nil {
		w.WriteHeader(200)
	}
	fmt.Fprint(w, out)
}

func ideCSSHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(ideCSSFile)
}

func ideJSHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(ideJSFile)
}

func ideAgentCSSHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "text/css")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(ideAgentCSSFile)
}

func ideAgentJSHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/javascript")
	w.Header().Set("Cache-Control", "no-cache")
	w.Write(ideAgentJSFile)
}

func agentProxyHandler() http.Handler {
	return newAgentProxy("http://127.0.0.1:8001")
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
		corsHeaders(w)
		jsonError(w, "Agent service unavailable: "+err.Error(), 502)
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		corsHeaders(w)
		if r.Method == http.MethodOptions {
			return
		}
		proxy.ServeHTTP(w, r)
	})
}

func indexHandler(w http.ResponseWriter, r *http.Request) {
	data, err := staticFiles.ReadFile("index.html")
	if err != nil {
		http.Error(w, "UI missing", 500)
		return
	}
	w.Header().Set("Content-Type", "text/html")
	w.Write(data)
}

var wsUpgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		origin := r.Header.Get("Origin")
		if origin == "" {
			return true // non-browser client (e.g. CLI); no CSRF surface
		}
		u, err := url.Parse(origin)
		if err != nil {
			return false
		}
		host := u.Hostname()
		return host == "127.0.0.1" || host == "localhost" || host == "::1"
	},
}

// waitForContainerRunning blocks until the named Docker container exists and is
// running, or the timeout elapses. It streams a friendly notice to the terminal
// while waiting so the panel doesn't look dead. Returns false on timeout or if
// the container has already exited/died.
func waitForContainerRunning(ctx context.Context, cli *client.Client, name string, conn *websocket.Conn, timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	notified := false
	for {
		info, err := cli.ContainerInspect(ctx, name)
		if err == nil && info.State != nil {
			if info.State.Running {
				return true
			}
			if info.State.Status == "exited" || info.State.Status == "dead" {
				conn.WriteMessage(websocket.TextMessage, []byte("\r\n\x1b[31m[sandbox container exited before the shell could attach — check the setup logs]\x1b[0m\r\n"))
				return false
			}
		}
		if time.Now().After(deadline) {
			return false
		}
		if !notified {
			conn.WriteMessage(websocket.TextMessage, []byte("\x1b[90mWaiting for the sandbox container to start…\x1b[0m\r\n"))
			notified = true
		}
		select {
		case <-ctx.Done():
			return false
		case <-time.After(500 * time.Millisecond):
		}
	}
}

func terminalWSHandler(w http.ResponseWriter, r *http.Request) {
	containerName := r.URL.Query().Get("container")
	mutex.Lock()
	_, ok := sandboxes[containerName]
	mutex.Unlock()
	if !ok {
		http.Error(w, "sandbox not found", 404)
		return
	}
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}
	defer conn.Close()

	// Talk to the Docker Engine API directly instead of shelling out to
	// `docker exec` through a local PTY. On Windows the CLI-over-ConPTY path was
	// unreliable (docker.exe does its own raw-mode/IsTerminal handling that
	// fights the ConPTY wrapper, so keystrokes never reached the shell). The
	// Engine API's exec-attach hijack gives us a raw bidirectional TTY stream
	// that behaves identically on Windows, macOS and Linux.
	cli, err := client.NewClientWithOpts(client.FromEnv, client.WithAPIVersionNegotiation())
	if err != nil {
		addLog(containerName, "terminal docker client failed: "+err.Error())
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nFailed to reach Docker: "+err.Error()+"\r\n"))
		return
	}
	defer cli.Close()

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// The sandbox is registered in our map the instant /run begins, but the Docker
	// container is created asynchronously (after clone + runtime detection). A
	// terminal opened during that window would hit "No such container", so wait for
	// the container to be running before exec'ing a shell.
	if !waitForContainerRunning(ctx, cli, containerName, conn, 120*time.Second) {
		conn.WriteMessage(websocket.TextMessage, []byte("\r\n\x1b[31m[sandbox did not start in time — reload the page to retry]\x1b[0m\r\n"))
		return
	}

	// Interactive login shell. Tty:true gives a real TTY inside the container so
	// prompts and character echo work. Prefer bash with a working-directory
	// prompt (\w) so `cd` visibly changes the path like VS Code; fall back to sh
	// with a $PWD prompt on slim images that lack bash (plain dash shows only a
	// bare "$" with no path, which made cd look like it did nothing).
	execResp, err := cli.ContainerExecCreate(ctx, containerName, container.ExecOptions{
		Tty:          true,
		AttachStdin:  true,
		AttachStdout: true,
		AttachStderr: true,
		WorkingDir:   "/workspace",
		Env:          []string{"TERM=xterm-256color"},
		// Probe for bash with the redirect scoped to the probe only — do NOT
		// redirect bash's own stderr, or its prompt (written to stderr) vanishes
		// and the terminal looks dead. bash gives a \w (working-dir) prompt so
		// `cd` visibly changes the path; sh is the fallback with a $PWD prompt.
		Cmd: []string{"sh", "-c",
			"if command -v bash >/dev/null 2>&1; then export PS1='\\w \\$ '; exec bash --norc -i; else export PS1='$PWD $ '; exec sh -i; fi"},
	})
	if err != nil {
		addLog(containerName, "terminal exec create failed: "+err.Error())
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nFailed to start shell: "+err.Error()+"\r\n"))
		return
	}

	att, err := cli.ContainerExecAttach(ctx, execResp.ID, container.ExecAttachOptions{Tty: true})
	if err != nil {
		addLog(containerName, "terminal exec attach failed: "+err.Error())
		conn.WriteMessage(websocket.TextMessage, []byte("\r\nFailed to attach shell: "+err.Error()+"\r\n"))
		return
	}
	defer att.Close()

	// exec output → websocket. With Tty:true the hijacked stream is a single raw
	// byte stream (no stdout/stderr multiplexing header), so we forward it as-is.
	go func() {
		buf := make([]byte, 4096)
		for {
			n, rerr := att.Reader.Read(buf)
			if n > 0 {
				if werr := conn.WriteMessage(websocket.BinaryMessage, buf[:n]); werr != nil {
					break
				}
			}
			if rerr != nil {
				break
			}
		}
		conn.Close() // unblock the read loop below
	}()

	// websocket → exec stdin. Binary frames carry keystrokes; text frames carry
	// resize events ({"type":"resize","cols":N,"rows":N}) so column-aware output
	// (ls, line wrapping) matches the visible terminal size.
readLoop:
	for {
		mt, msg, rerr := conn.ReadMessage()
		if rerr != nil {
			break
		}
		switch mt {
		case websocket.BinaryMessage:
			if _, werr := att.Conn.Write(msg); werr != nil {
				break readLoop
			}
		case websocket.TextMessage:
			var ev struct {
				Type string `json:"type"`
				Cols uint   `json:"cols"`
				Rows uint   `json:"rows"`
			}
			if json.Unmarshal(msg, &ev) == nil && ev.Type == "resize" && ev.Cols > 0 && ev.Rows > 0 {
				_ = cli.ContainerExecResize(ctx, execResp.ID, container.ResizeOptions{Height: ev.Rows, Width: ev.Cols})
			}
		}
	}
}

// startAgentService launches the Node.js agent service as a subprocess.
// It reads ANTHROPIC_API_KEY from the environment and passes it through.
// Stdout/stderr are piped to Go's stdout so logs appear in one place.
func startAgentService() {
	agentDir := filepath.Join(".", "agent-services")
	cmd := exec.Command("node", "server.js")
	cmd.Dir = agentDir
	cmd.Stdout = os.Stdout
	cmd.Stderr = os.Stderr
	cmd.Env = append(os.Environ(),
		"ANTHROPIC_API_KEY="+os.Getenv("ANTHROPIC_API_KEY"),
		"AGENT_PORT=8001",
	)
	if err := cmd.Start(); err != nil {
		fmt.Printf("[agent-service] failed to start: %v\n", err)
		fmt.Println("[agent-services] chat panel will be unavailable — run 'cd agent-services && npm install' first")
		return
	}
	fmt.Printf("[agent-service] started (pid %d) on port 8001\n", cmd.Process.Pid)
	// Wait in background so we can log if it exits unexpectedly
	go func() {
		if err := cmd.Wait(); err != nil {
			fmt.Printf("[agent-service] exited: %v\n", err)
		}
	}()
}

func loadEnv() {
	file, err := os.Open(".env")
	if err != nil {
		return // Ignore if file doesn't exist
	}
	defer file.Close()

	data, err := io.ReadAll(file)
	if err != nil {
		return
	}

	lines := strings.Split(string(data), "\n")
	for _, line := range lines {
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
	go preheatImages()
	go startAgentService()

	http.HandleFunc("/ide.css", ideCSSHandler)
	http.HandleFunc("/ide.js", ideJSHandler)
	http.HandleFunc("/ide-agent.css", ideAgentCSSHandler)
	http.HandleFunc("/ide-agent.js", ideAgentJSHandler)
	http.HandleFunc("/", indexHandler)
	http.HandleFunc("/run", runHandler)
	http.HandleFunc("/sandboxes", listHandler)
	http.HandleFunc("/stop/", stopHandler)
	http.HandleFunc("/logs/", logsHandler)
	http.HandleFunc("/files", filesHandler)
	http.HandleFunc("/file", fileReadHandler)
	http.HandleFunc("/file/save", fileSaveHandler)
	http.HandleFunc("/file/create", fileCreateHandler)
	http.HandleFunc("/file/delete", fileDeleteHandler)
	http.HandleFunc("/terminal/exec", terminalExecHandler)
	http.HandleFunc("/sandbox/status", sandboxStatusHandler)
	http.HandleFunc("/sandbox/entry", sandboxEntryHandler)
	http.Handle("/agent/", agentProxyHandler())
	http.HandleFunc("/terminal/ws", terminalWSHandler)

	// Builder endpoints
	http.HandleFunc("/build/questions", buildQuestionsHandler)
	http.HandleFunc("/build/prd", buildPRDHandler)
	http.HandleFunc("/build/scaffold", buildScaffoldHandler)
	http.HandleFunc("/build/history", buildHistoryHandler)

	srv := &http.Server{
		Addr:              "127.0.0.1:9000",
		ReadHeaderTimeout: 10 * time.Second,
	}

	// Graceful shutdown: stop tracked containers so they don't outlive the server.
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, os.Interrupt, syscall.SIGTERM)
		<-sigCh
		fmt.Println("\nShutting down — stopping sandboxes...")
		cleanupAllSandboxes()
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		srv.Shutdown(ctx)
		os.Exit(0)
	}()

	fmt.Println("Sandbox server running on http://127.0.0.1:9000")
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		fmt.Printf("server error: %v\n", err)
	}
}
