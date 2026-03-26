package main

import (
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
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/creack/pty"
	"github.com/gorilla/websocket"
)

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
	w.Header().Set("Content-Type", "application/json")
}

func jsonError(w http.ResponseWriter, msg string, code int) {
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
	for i := 0; i < 300; i++ {
		resp, err := http.Get(fmt.Sprintf("http://127.0.0.1:%d", port))
		if err == nil && resp.StatusCode < 500 {
			return true
		}
		time.Sleep(1 * time.Second)
	}
	return false
}

func preheatImages() {
	imageMap := map[string]string{
		"static": "static-sites",
		"node":   "node",
		"python": "python",
		"go":     "go",
		"java":   "java",
		"php":    "php",
		"ruby":   "ruby",
		"rust":   "rust",
		"dotnet": "dotnet",
		"deno":   "deno",
		"bun":    "bun",
		"react":  "react",
	}
	keys := []string{"static", "node", "python", "go", "java", "php", "ruby", "rust", "dotnet", "deno", "bun", "react"}
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
			repo, workdir,
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

		// ── GitAgent spec generation ──
		stack := imageToStack(runtimeConfig.Image)
		if specErr := GenerateAgentSpec(workdir, stack); specErr != nil {
			addLog(container, "Warning: GitAgent spec generation failed: "+specErr.Error())
			// non-fatal — sandbox still runs without agent spec
		} else {
			addLog(container, "GitAgent spec generated for stack: "+stack)
			go RegisterWithAgentService(container, abs, stack)
		}

		args := []string{
			"run", "-d",
			"--name", container,
			"--memory", "1024m",
			"--cpus", "1",
			"--pids-limit", "100",
			"-p", fmt.Sprintf("0.0.0.0:%d:%d", port, runtimeConfig.Port),
			"-v", fmt.Sprintf("%s:/workspace", abs),
			"-v", fmt.Sprintf("%s/.npm:/root/.npm", os.Getenv("HOME")),
			"-v", fmt.Sprintf("%s/.cache/pip:/root/.cache/pip", os.Getenv("HOME")),
			"-w", "/workspace",
			"-e", fmt.Sprintf("PORT=%d", runtimeConfig.Port),
			"-e", "NEXT_TELEMETRY_DISABLED=1",
			"-e", "CI=1",
			runtimeConfig.Image,
			"sh", "-c", runtimeConfig.StartupCommand,
		}

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
			addLog(container, "Server is ready!")
		}

		go func() {
			time.Sleep(10 * time.Minute)
			run("", "docker", "stop", container)
			run("", "docker", "rm", container)
			os.RemoveAll(workdir)
			mutex.Lock()
			delete(sandboxes, container)
			mutex.Unlock()
		}()

		return nil
	}

	if mode == "dev" {
		go func() {
			if err := setupFunc(); err != nil {
				fmt.Printf("Sandbox setup failed: %v\n", err)
			}
		}()
		return sb, nil
	}

	err = setupFunc()
	if err != nil {
		mutex.Lock()
		delete(sandboxes, container)
		mutex.Unlock()
		os.RemoveAll(workdir)
		return Sandbox{}, err
	}

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
		jsonError(w, err.Error(), 500)
		return
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "running",
		"container": sb.Container,
		"url":       fmt.Sprintf("http://127.0.0.1:%d", sb.Port),
		"mode":      mode,
	})
}

func listHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	mutex.Lock()
	defer mutex.Unlock()
	json.NewEncoder(w).Encode(sandboxes)
}

func stopHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	container := strings.TrimPrefix(r.URL.Path, "/stop/")
	run("", "docker", "stop", container)
	run("", "docker", "rm", container)
	mutex.Lock()
	delete(sandboxes, container)
	mutex.Unlock()
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
		jsonError(w, err.Error(), 500)
		return
	}
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
	absPath := filepath.Clean(filepath.Join(sb.Workdir, filepath.FromSlash(filePath)))
	if !strings.HasPrefix(absPath, sb.Workdir) {
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
	absPath := filepath.Clean(filepath.Join(sb.Workdir, filepath.FromSlash(req.Path)))
	if !strings.HasPrefix(absPath, sb.Workdir) {
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
	absPath := filepath.Clean(filepath.Join(sb.Workdir, filepath.FromSlash(req.Path)))
	if !strings.HasPrefix(absPath, sb.Workdir) {
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
	absPath := filepath.Clean(filepath.Join(sb.Workdir, filepath.FromSlash(req.Path)))
	if !strings.HasPrefix(absPath, sb.Workdir) {
		jsonError(w, "path outside workspace", 403)
		return
	}
	if err := os.RemoveAll(absPath); err != nil {
		jsonError(w, err.Error(), 500)
		return
	}
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
		if err != nil || resp.StatusCode >= 500 {
			status = "starting"
		} else if resp != nil {
			resp.Body.Close()
		}
	}
	json.NewEncoder(w).Encode(map[string]interface{}{
		"container": sb.Container,
		"port":      sb.Port,
		"repo":      sb.Repo,
		"status":    status,
		"url":       fmt.Sprintf("http://127.0.0.1:%d", sb.Port),
	})
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
	target, _ := url.Parse("http://127.0.0.1:8001")
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
	CheckOrigin: func(r *http.Request) bool { return true },
}

func terminalWSHandler(w http.ResponseWriter, r *http.Request) {
	container := r.URL.Query().Get("container")
	mutex.Lock()
	_, ok := sandboxes[container]
	mutex.Unlock()
	if !ok {
		http.Error(w, "sandbox not found", 404)
		return
	}
	conn, err := wsUpgrader.Upgrade(w, r, nil)
	if err != nil {
		return
	}

	cmd := exec.Command("docker", "exec", "-it", container, "sh")
	entry, err := pty.Start(cmd)
	if err != nil {
		addLog(container, "PTY start failed, using fallback: "+err.Error())
		fcmd := exec.Command("docker", "exec", "-it", container, "sh")
		stdin, _ := fcmd.StdinPipe()
		stdout, _ := fcmd.StdoutPipe()
		stderr, _ := fcmd.StderrPipe()
		if err := fcmd.Start(); err != nil {
			addLog(container, "Fallback shell start failed: "+err.Error())
			conn.Close()
			return
		}
		go func() {
			buf := make([]byte, 1024)
			for {
				n, err := stdout.Read(buf)
				if err != nil {
					break
				}
				conn.WriteMessage(websocket.BinaryMessage, buf[:n])
			}
		}()
		go func() {
			buf := make([]byte, 1024)
			for {
				n, err := stderr.Read(buf)
				if err != nil {
					break
				}
				conn.WriteMessage(websocket.BinaryMessage, buf[:n])
			}
		}()
		for {
			_, msg, err := conn.ReadMessage()
			if err != nil {
				break
			}
			stdin.Write(msg)
		}
		fcmd.Process.Kill()
		conn.Close()
		return
	}

	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := entry.Read(buf)
			if err != nil {
				break
			}
			conn.WriteMessage(websocket.BinaryMessage, buf[:n])
		}
	}()
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		if _, err = entry.Write(msg); err != nil {
			break
		}
	}
	entry.Close()
	conn.Close()
}

// startAgentService launches the Node.js agent service as a subprocess.
// It reads ANTHROPIC_API_KEY from the environment and passes it through.
// Stdout/stderr are piped to Go's stdout so logs appear in one place.
func startAgentService() {
	agentDir := filepath.Join(".", "agent-service")
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
		fmt.Println("[agent-service] chat panel will be unavailable — run 'cd agent-service && npm install' first")
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

func main() {
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
	http.Handle("/agent/", agentProxyHandler())
	http.HandleFunc("/terminal/ws", terminalWSHandler)

	fmt.Println("Sandbox server running on http://localhost:9000")
	http.ListenAndServe(":9000", nil)
}