package server

import (
	"archive/zip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"sandbox/internal/core"
)

func projectsHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method != http.MethodGet {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	list, err := core.ListProjects(core.UserOf(r))
	if err != nil {
		core.JSONError(w, err.Error(), 500)
		return
	}
	writeJSON(w, map[string]any{"projects": list})
}

func projectSaveHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method != http.MethodPost {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	var req struct {
		Container string `json:"container"`
		Name      string `json:"name"`
		AsNew     bool   `json:"asNew"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		core.JSONError(w, "invalid request", 400)
		return
	}
	sb, ok := ownedSandbox(w, r, req.Container)
	if !ok {
		return
	}
	if sb.Status == core.StatusDetecting {
		core.JSONError(w, "the files are still being fetched; save again in a moment", 409)
		return
	}
	id := sb.Project
	if req.AsNew {
		id = ""
	}
	name := req.Name
	if strings.TrimSpace(name) == "" {
		name = defaultProjectName(sb.Repo)
	}
	p, err := core.SaveProject(sb.Owner, id, name, sb.Repo, sb.Framework, sb.Workdir)
	if errors.Is(err, core.ErrProjectNotFound) {
		p, err = core.SaveProject(sb.Owner, "", name, sb.Repo, sb.Framework, sb.Workdir)
	}
	if err != nil {
		core.JSONError(w, err.Error(), 400)
		return
	}
	core.UpdateSandbox(sb.Container, func(s *core.Sandbox) { s.Project = p.ID })
	writeJSON(w, p)
}

// "https://github.com/u/shop-api.git" and "project:shop-api" both name "shop-api".
func defaultProjectName(source string) string {
	if i := strings.Index(source, ":"); i >= 0 && !strings.Contains(source, "://") {
		source = source[i+1:]
	}
	source = strings.TrimSuffix(strings.TrimSuffix(source, "/"), ".git")
	if i := strings.LastIndex(source, "/"); i >= 0 {
		source = source[i+1:]
	}
	return source
}

func projectOpenHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method != http.MethodPost {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		core.JSONError(w, "invalid request", 400)
		return
	}
	owner := core.UserOf(r)
	p, err := core.GetProject(owner, req.ID)
	if err != nil {
		core.JSONError(w, "project not found", 404)
		return
	}
	src, err := core.ProjectFiles(owner, p.ID)
	if err != nil {
		core.JSONError(w, "project not found", 404)
		return
	}
	if !engineUp() {
		core.JSONError(w, core.EngineDownMessage(), 503)
		return
	}
	ensureNetwork()
	sb, err := startSandboxFrom(owner, "project:"+p.Name, p.ID, "", false, func(container, workdir string) error {
		core.AddLog(container, "Opening saved project: "+p.Name)
		_, _, err := core.CopyTree(src, workdir, core.ProjectMaxBytes, core.ProjectMaxFiles)
		return err
	})
	if err != nil {
		sandboxStartError(w, err)
		return
	}
	core.MarkProjectOpened(owner, p.ID)
	writeJSON(w, map[string]any{"status": sb.Status, "container": sb.Container, "repo": sb.Repo})
}

func projectDeleteHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method != http.MethodPost {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	var req struct {
		ID string `json:"id"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(&req); err != nil {
		core.JSONError(w, "invalid request", 400)
		return
	}
	if err := core.DeleteProject(core.UserOf(r), req.ID); err != nil {
		core.JSONError(w, "project not found", 404)
		return
	}
	writeJSON(w, map[string]bool{"ok": true})
}

func sandboxStartError(w http.ResponseWriter, err error) {
	code := 400
	if core.IsCapacityError(err) {
		code = 429
	}
	core.JSONError(w, err.Error(), code)
}

// A local folder arrives as a "paths" JSON list followed by one "file" part per path, or as a single "zip" part.
func runUploadHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method != http.MethodPost {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	if !engineUp() {
		core.JSONError(w, core.EngineDownMessage(), 503)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, core.ProjectMaxBytes+(16<<20))
	mr, err := r.MultipartReader()
	if err != nil {
		core.JSONError(w, "expected a multipart upload", 400)
		return
	}
	staging, err := os.MkdirTemp(core.Cfg.WorkDir, "jr-upload-*")
	if err != nil {
		core.JSONError(w, err.Error(), 500)
		return
	}
	keep := false
	defer func() {
		if !keep {
			os.RemoveAll(staging)
		}
	}()

	name, instructions, err := receiveUpload(mr, staging)
	if err != nil {
		core.JSONError(w, err.Error(), 400)
		return
	}
	if strings.TrimSpace(name) == "" {
		name = "local project"
	}
	ensureNetwork()
	keep = true
	sb, err := startSandboxFrom(core.UserOf(r), "local:"+name, "", instructions, false, func(container, workdir string) error {
		defer os.RemoveAll(staging)
		core.AddLog(container, "Using uploaded project: "+name)
		return os.Rename(staging, workdir)
	})
	if err != nil {
		keep = false
		sandboxStartError(w, err)
		return
	}
	writeJSON(w, map[string]any{"status": sb.Status, "container": sb.Container, "repo": sb.Repo})
}

func receiveUpload(mr *multipart.Reader, dst string) (name, instructions string, err error) {
	var paths []string
	next := 0
	got := false
	var total int64
	for {
		part, err := mr.NextPart()
		if err == io.EOF {
			break
		}
		if err != nil {
			return "", "", fmt.Errorf("upload interrupted: %v", err)
		}
		switch part.FormName() {
		case "name":
			name = readField(part)
		case "instructions":
			instructions = readField(part)
		case "paths":
			if err := json.Unmarshal([]byte(readField(part)), &paths); err != nil {
				return "", "", fmt.Errorf("invalid paths list")
			}
			if len(paths) > core.ProjectMaxFiles {
				return "", "", fmt.Errorf("a project can have at most %d files", core.ProjectMaxFiles)
			}
		case "file":
			if next >= len(paths) {
				return "", "", fmt.Errorf("more files than paths")
			}
			rel, ok := uploadPath(paths[next])
			next++
			if !ok {
				continue
			}
			n, err := writeUploaded(dst, rel, part, core.ProjectMaxBytes-total)
			if err != nil {
				return "", "", err
			}
			total += n
			got = true
		case "zip":
			if got {
				return "", "", fmt.Errorf("send either a folder or one zip, not both")
			}
			if err := extractZipPart(part, dst); err != nil {
				return "", "", err
			}
			got = true
			paths, next = nil, 0
		}
		part.Close()
	}
	if !got {
		return "", "", fmt.Errorf("the upload had no files")
	}
	return name, instructions, nil
}

func readField(p *multipart.Part) string {
	b, _ := io.ReadAll(io.LimitReader(p, 1<<20))
	return string(b)
}

// Forward-slash relative paths only; anything absolute, escaping or inside a dependency folder is dropped.
func uploadPath(p string) (string, bool) {
	p = strings.ReplaceAll(p, "\\", "/")
	if p == "" || strings.HasPrefix(p, "/") || strings.Contains(p, ":") || strings.ContainsRune(p, 0) {
		return "", false
	}
	clean := path.Clean(p)
	if clean == "." || clean == ".." || strings.HasPrefix(clean, "../") {
		return "", false
	}
	for _, seg := range strings.Split(clean, "/") {
		if core.SkipDir(seg) {
			return "", false
		}
	}
	return clean, true
}

func writeUploaded(dst, rel string, r io.Reader, budget int64) (int64, error) {
	target := filepath.Join(dst, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(target), 0755); err != nil {
		return 0, err
	}
	f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return 0, err
	}
	n, err := io.Copy(f, io.LimitReader(r, budget+1))
	f.Close()
	if err != nil {
		return n, fmt.Errorf("upload interrupted: %v", err)
	}
	if n > budget {
		return n, fmt.Errorf("project is larger than %d MB", core.ProjectMaxBytes>>20)
	}
	return n, nil
}

// zip.Reader needs random access, so the archive is spooled to disk first.
func extractZipPart(part io.Reader, dst string) error {
	tmp, err := os.CreateTemp(core.Cfg.WorkDir, "jr-upload-*.zip")
	if err != nil {
		return err
	}
	defer os.Remove(tmp.Name())
	defer tmp.Close()
	size, err := io.Copy(tmp, io.LimitReader(part, core.ProjectMaxBytes+1))
	if err != nil {
		return fmt.Errorf("upload interrupted: %v", err)
	}
	if size > core.ProjectMaxBytes {
		return fmt.Errorf("zip is larger than %d MB", core.ProjectMaxBytes>>20)
	}
	zr, err := zip.NewReader(tmp, size)
	if err != nil {
		return fmt.Errorf("not a valid zip file")
	}
	return extractZip(zr, dst)
}

func extractZip(zr *zip.Reader, dst string) error {
	prefix := commonTopDir(zr.File)
	var total int64
	count := 0
	for _, f := range zr.File {
		if f.FileInfo().IsDir() || !f.Mode().IsRegular() {
			continue
		}
		rel, ok := uploadPath(strings.TrimPrefix(f.Name, prefix))
		if !ok {
			continue
		}
		count++
		if count > core.ProjectMaxFiles {
			return fmt.Errorf("a project can have at most %d files", core.ProjectMaxFiles)
		}
		rc, err := f.Open()
		if err != nil {
			return fmt.Errorf("could not read %s from the zip", f.Name)
		}
		n, err := writeUploaded(dst, rel, rc, core.ProjectMaxBytes-total)
		rc.Close()
		if err != nil {
			return err
		}
		total += n
	}
	if count == 0 {
		return fmt.Errorf("the zip had no files")
	}
	return nil
}

// "repo-main/" when every entry sits under it, as GitHub's zip downloads do.
func commonTopDir(files []*zip.File) string {
	top := ""
	for _, f := range files {
		name := strings.ReplaceAll(f.Name, "\\", "/")
		i := strings.Index(name, "/")
		if i < 0 {
			if f.FileInfo().IsDir() {
				continue
			}
			return ""
		}
		if top == "" {
			top = name[:i+1]
		} else if name[:i+1] != top {
			return ""
		}
	}
	return top
}
