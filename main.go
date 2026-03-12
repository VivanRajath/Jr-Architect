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
	"github.com/gorilla/websocket"
    "github.com/creack/pty"
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
)

func run(cmd string, args ...string) error {
	c := exec.Command(cmd, args...)
	out, err := c.CombinedOutput()
	if err != nil {
		fmt.Println(string(out))
	}
	return err
}

func output(cmd string, args ...string) (string, error) {
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

	// maps image suffix -> subfolder name under sandbox-images/
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
	}

	// iterate in a consistent order
	keys := []string{"static", "node", "python", "go", "java", "php", "ruby", "rust", "dotnet", "deno", "bun", "react"}

	for _, img := range keys {

		imageName := "sandbox-" + img
		folder := imageMap[img]

		out, err := output("docker", "images", "-q", imageName)

		if err == nil && strings.TrimSpace(out) != "" {
			fmt.Printf("%s already exists, skipping\n", imageName)
			continue
		}

		path := "./sandbox-images/" + folder

		fmt.Printf("Building %s from %s\n", imageName, path)

		buildErr := run("docker", "build", "-t", imageName, path)
		if buildErr != nil {
			fmt.Printf("Failed to build %s: %v\n", imageName, buildErr)
		} else {
			fmt.Printf("%s built successfully\n", imageName)
		}
	}

	fmt.Println("Images ready")
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
		fmt.Println("Cloning repo:", repo)

		err := run(
			"git",
			"clone",
			"--depth", "1",
			"--single-branch",
			"--recurse-submodules=no",
			repo,
			workdir,
		)

		if err != nil {
			return err
		}

		// Write INSTRUCTIONS.md AFTER cloning so it doesn't interfere with git.
		if strings.TrimSpace(instructions) != "" {
			err = os.WriteFile(filepath.Join(workdir, "INSTRUCTIONS.md"), []byte(instructions), 0644)
			if err != nil {
				return err
			}
		}

		runtimeConfig, err := detectRuntimeConfig(workdir)

		if err != nil {
			return err
		}

		args := []string{
			"run",
			"-d",
			"--name", container,
			"--memory", "1024m",
			"--cpus", "1",
			"--pids-limit", "100",
			"--cap-drop", "ALL",
			"--security-opt", "no-new-privileges",
			"-p", fmt.Sprintf("0.0.0.0:%d:%d", port, runtimeConfig.Port),
			"-v", fmt.Sprintf("%s:/workspace", abs),
			"-v", fmt.Sprintf("%s/.npm:/root/.npm", os.Getenv("HOME")),
			"-v", fmt.Sprintf("%s/.cache/pip:/root/.cache/pip", os.Getenv("HOME")),
			"-w", "/workspace",
			"-e", fmt.Sprintf("PORT=%d", runtimeConfig.Port),
			"-e", "NEXT_TELEMETRY_DISABLED=1",
			"-e", "CI=1",
			runtimeConfig.Image,
			"sh",
			"-c",
			runtimeConfig.StartupCommand,
		}

		err = run("docker", args...)

		if err != nil {
			return err
		}

		if !waitForServer(port) {
			fmt.Println("Warning: server not ready yet")
			out, _ := output("docker", "logs", "--tail", "50", container)
			fmt.Println("--- Container Logs ---")
			fmt.Println(out)
			fmt.Println("----------------------")
		}

		go func() {

			time.Sleep(10 * time.Minute)

			run("docker", "stop", container)
			run("docker", "rm", container)

			os.RemoveAll(workdir)

			mutex.Lock()
			delete(sandboxes, container)
			mutex.Unlock()

		}()

		return nil
	}

	if mode == "dev" {
		go func() {
			err := setupFunc()
			if err != nil {
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

	err := json.NewDecoder(r.Body).Decode(&req)

	if err != nil {
		jsonError(w, "invalid request", 400)
		return
	}

	// Default mode is "prompt"
	mode := req.Mode
	if mode == "" {
		mode = "prompt"
	}

	sb, err := startSandbox(req.Repo, req.Instructions, mode)

	if err != nil {
		jsonError(w, err.Error(), 500)
		return
	}

	resp := map[string]interface{}{
		"status":    "running",
		"container": sb.Container,
		"url":       fmt.Sprintf("http://127.0.0.1:%d", sb.Port),
		"mode":      mode,
	}

	json.NewEncoder(w).Encode(resp)
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

	run("docker", "stop", container)
	run("docker", "rm", container)

	mutex.Lock()
	delete(sandboxes, container)
	mutex.Unlock()

	json.NewEncoder(w).Encode(map[string]string{"status": "stopped"})
}

func logsHandler(w http.ResponseWriter, r *http.Request) {

	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Content-Type", "text/plain")

	container := strings.TrimPrefix(r.URL.Path, "/logs/")

	out, err := output("docker", "logs", container)

	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}

	fmt.Fprint(w, out)
}

// ── File tree types ──

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

	// Sanitise: resolve and ensure within workdir
	absPath := filepath.Join(sb.Workdir, filepath.FromSlash(filePath))
	absPath = filepath.Clean(absPath)
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
	// Skip large or binary files
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

	absPath := filepath.Join(sb.Workdir, filepath.FromSlash(req.Path))
	absPath = filepath.Clean(absPath)
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

// ── File Create ──

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

	absPath := filepath.Join(sb.Workdir, filepath.FromSlash(req.Path))
	absPath = filepath.Clean(absPath)
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

// ── File Delete ──

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

	absPath := filepath.Join(sb.Workdir, filepath.FromSlash(req.Path))
	absPath = filepath.Clean(absPath)
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

// ── Sandbox Status ──

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

	// Get container status from Docker
	out, err := output("docker", "inspect", "--format", "{{.State.Status}}", sb.Container)
	status := strings.TrimSpace(out)
	if err != nil {
		status = "unknown"
	}

	// If docker says it's running, check if the actual application server is ready yet
	if status == "running" {
		// Use a very short timeout so we don't block the polling request
		// waitForServer waits up to 300 seconds, so we need a different check
		// or we can just send a single HTTP GET request with a short timeout.
		client := http.Client{
			Timeout: 2 * time.Second,
		}
		resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d", sb.Port))
		if err != nil || resp.StatusCode >= 500 {
			status = "starting"
		} else {
			if resp != nil {
				resp.Body.Close()
			}
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

	out, err := output("docker", "exec", req.Container, "sh", "-c", req.Command)
	if err != nil {
		// Still return output even on non-zero exit
		w.Header().Set("Content-Type", "text/plain; charset=utf-8")
		w.WriteHeader(200)
		fmt.Fprint(w, out)
		return
	}
	w.Header().Set("Content-Type", "text/plain; charset=utf-8")
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

// ── Agent Proxy ──

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

//terminal websoket//

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

	ptmx, err := pty.Start(cmd)
	if err != nil {
		conn.WriteMessage(websocket.TextMessage, []byte(err.Error()))
		conn.Close()
		return
	}

	// send container output → browser
	go func() {
		buf := make([]byte, 1024)
		for {
			n, err := ptmx.Read(buf)
			if err != nil {
				break
			}
			conn.WriteMessage(websocket.BinaryMessage, buf[:n])
		}
	}()

	// send browser input → container
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}

		_, err = ptmx.Write(msg)
		if err != nil {
			break
		}
	}

	ptmx.Close()
	conn.Close()
}

func main() {

	go preheatImages()

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