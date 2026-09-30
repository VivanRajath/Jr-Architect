package server

import (
	"encoding/json"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"strings"

	"sandbox/internal/core"
)

type FileNode struct {
	Name     string     `json:"name"`
	Path     string     `json:"path"`
	IsDir    bool       `json:"isDir"`
	Children []FileNode `json:"children,omitempty"`
}

// ResolveInWorkspace is only the up-front check; the I/O goes through os.Root, which resolves every path component
// itself, so a directory swapped for a symlink between the check and the use still cannot lead out of the workspace.
func inRoot(w http.ResponseWriter, workdir, abs string) (*os.Root, string, bool) {
	root, err := os.OpenRoot(workdir)
	if err != nil {
		core.JSONError(w, "workspace not ready", 404)
		return nil, "", false
	}
	rel, err := filepath.Rel(workdir, abs)
	if err != nil {
		root.Close()
		core.JSONError(w, "path outside workspace", 403)
		return nil, "", false
	}
	return root, rel, true
}

func buildFileTree(workdir string) ([]FileNode, error) {
	root, err := os.OpenRoot(workdir)
	if err != nil {
		return nil, err
	}
	defer root.Close()
	fsys := root.FS()
	skip := map[string]bool{
		".git": true, "node_modules": true, "__pycache__": true,
		".next": true, "vendor": true, ".venv": true, "venv": true,
	}
	var walk func(rel string) ([]FileNode, error)
	walk = func(rel string) ([]FileNode, error) {
		dir := rel
		if dir == "" {
			dir = "."
		}
		entries, err := fs.ReadDir(fsys, dir)
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
				node.Children, _ = walk(childRel)
			}
			nodes = append(nodes, node)
		}
		return nodes, nil
	}
	return walk("")
}

func filesHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	containerID := r.URL.Query().Get("container")
	sb, ok := ownedSandbox(w, r, containerID)
	if !ok {
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
		core.JSONError(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(tree)
}

func fileReadHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	containerID := r.URL.Query().Get("container")
	filePath := r.URL.Query().Get("path")
	sb, ok := ownedSandbox(w, r, containerID)
	if !ok {
		return
	}
	absPath, ok := core.ResolveInWorkspace(sb.Workdir, filePath)
	if !ok {
		core.JSONError(w, "path outside workspace", 403)
		return
	}
	root, rel, ok := inRoot(w, sb.Workdir, absPath)
	if !ok {
		return
	}
	defer root.Close()
	info, err := root.Stat(rel)
	if err != nil {
		core.JSONError(w, "file not found", 404)
		return
	}
	if info.IsDir() {
		core.JSONError(w, "path is a directory", 400)
		return
	}
	if info.Size() > 2*1024*1024 {
		core.JSONError(w, "file too large (>2 MB)", 400)
		return
	}
	data, err := root.ReadFile(rel)
	if err != nil {
		core.JSONError(w, "file not found", 404)
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
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	var req FileSaveRequest
	body, _ := io.ReadAll(io.LimitReader(r.Body, 5*1024*1024))
	if err := json.Unmarshal(body, &req); err != nil {
		core.JSONError(w, "invalid JSON", 400)
		return
	}
	sb, ok := ownedSandbox(w, r, req.Container)
	if !ok {
		return
	}
	absPath, ok := core.ResolveInWorkspace(sb.Workdir, req.Path)
	if !ok {
		core.JSONError(w, "path outside workspace", 403)
		return
	}
	root, rel, ok := inRoot(w, sb.Workdir, absPath)
	if !ok {
		return
	}
	defer root.Close()
	if err := root.MkdirAll(filepath.Dir(rel), fs.ModePerm); err != nil {
		core.JSONError(w, err.Error(), 500)
		return
	}
	if err := root.WriteFile(rel, []byte(req.Content), 0644); err != nil {
		core.JSONError(w, err.Error(), 500)
		return
	}
	// Also write it through the container so the dev server actually sees it.
	core.SyncBytes(req.Container, req.Path, []byte(req.Content))
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "saved"})
}

type SyncRequest struct {
	Container string   `json:"container"`
	Paths     []string `json:"paths"`
}

// sandboxSyncHandler re-syncs files the agent edited directly on disk (the
// auto-apply path writes host-side and never hits /file/save) into the container,
// so the live preview reflects the change.
func sandboxSyncHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	var req SyncRequest
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024))
	if err := json.Unmarshal(body, &req); err != nil {
		core.JSONError(w, "invalid JSON", 400)
		return
	}
	sb, ok := ownedSandbox(w, r, req.Container)
	if !ok {
		return
	}
	root, err := os.OpenRoot(sb.Workdir)
	if err != nil {
		core.JSONError(w, "workspace not ready", 404)
		return
	}
	defer root.Close()
	for _, p := range req.Paths {
		abs, ok := core.ResolveInWorkspace(sb.Workdir, p)
		if !ok {
			continue
		}
		rel, err := filepath.Rel(sb.Workdir, abs)
		if err != nil {
			continue
		}
		if data, err := root.ReadFile(rel); err == nil {
			core.SyncBytes(req.Container, p, data)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "synced"})
}

type FileCreateRequest struct {
	Container string `json:"container"`
	Path      string `json:"path"`
	IsDir     bool   `json:"isDir"`
}

func fileCreateHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	var req FileCreateRequest
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024))
	if err := json.Unmarshal(body, &req); err != nil {
		core.JSONError(w, "invalid JSON", 400)
		return
	}
	sb, ok := ownedSandbox(w, r, req.Container)
	if !ok {
		return
	}
	absPath, ok := core.ResolveInWorkspace(sb.Workdir, req.Path)
	if !ok {
		core.JSONError(w, "path outside workspace", 403)
		return
	}
	root, rel, ok := inRoot(w, sb.Workdir, absPath)
	if !ok {
		return
	}
	defer root.Close()
	if req.IsDir {
		if err := root.MkdirAll(rel, fs.ModePerm); err != nil {
			core.JSONError(w, err.Error(), 500)
			return
		}
	} else {
		if err := root.MkdirAll(filepath.Dir(rel), fs.ModePerm); err != nil {
			core.JSONError(w, err.Error(), 500)
			return
		}
		if err := root.WriteFile(rel, []byte(""), 0644); err != nil {
			core.JSONError(w, err.Error(), 500)
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
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	var req FileDeleteRequest
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024))
	if err := json.Unmarshal(body, &req); err != nil {
		core.JSONError(w, "invalid JSON", 400)
		return
	}
	sb, ok := ownedSandbox(w, r, req.Container)
	if !ok {
		return
	}
	absPath, ok := core.ResolveInWorkspace(sb.Workdir, req.Path)
	if !ok {
		core.JSONError(w, "path outside workspace", 403)
		return
	}
	root, rel, ok := inRoot(w, sb.Workdir, absPath)
	if !ok {
		return
	}
	defer root.Close()
	// An empty path resolves to the workspace itself, which a caller never gets to delete.
	if rel == "." {
		core.JSONError(w, "cannot delete the workspace root", 400)
		return
	}
	if err := root.RemoveAll(rel); err != nil {
		core.JSONError(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "deleted"})
}

type FileRenameRequest struct {
	Container string `json:"container"`
	From      string `json:"from"`
	To        string `json:"to"`
}

// fileRenameHandler moves/renames a file or folder within the workspace. Both
// paths are resolved inside the workspace, so neither side can escape it.
func fileRenameHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	var req FileRenameRequest
	body, _ := io.ReadAll(io.LimitReader(r.Body, 1*1024*1024))
	if err := json.Unmarshal(body, &req); err != nil {
		core.JSONError(w, "invalid JSON", 400)
		return
	}
	if strings.TrimSpace(req.From) == "" || strings.TrimSpace(req.To) == "" {
		core.JSONError(w, "from and to required", 400)
		return
	}
	sb, ok := ownedSandbox(w, r, req.Container)
	if !ok {
		return
	}
	fromAbs, ok1 := core.ResolveInWorkspace(sb.Workdir, req.From)
	toAbs, ok2 := core.ResolveInWorkspace(sb.Workdir, req.To)
	if !ok1 || !ok2 {
		core.JSONError(w, "path outside workspace", 403)
		return
	}
	root, fromRel, ok := inRoot(w, sb.Workdir, fromAbs)
	if !ok {
		return
	}
	defer root.Close()
	toRel, err := filepath.Rel(sb.Workdir, toAbs)
	if err != nil || fromRel == "." || toRel == "." {
		core.JSONError(w, "path outside workspace", 403)
		return
	}
	if _, err := root.Lstat(toRel); err == nil {
		core.JSONError(w, "destination already exists", 409)
		return
	}
	if err := root.MkdirAll(filepath.Dir(toRel), fs.ModePerm); err != nil {
		core.JSONError(w, err.Error(), 500)
		return
	}
	if err := root.Rename(fromRel, toRel); err != nil {
		core.JSONError(w, err.Error(), 500)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"status": "renamed"})
}
