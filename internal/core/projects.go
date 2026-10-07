package core

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo/options"
)

// A saved copy of a sandbox's source, kept per user under DataDir/projects so it outlives the sandbox.
type Project struct {
	ID        string    `json:"id" bson:"_id"`
	Name      string    `json:"name" bson:"name"`
	Source    string    `json:"source" bson:"source"`
	Framework string    `json:"framework,omitempty" bson:"framework,omitempty"`
	Bytes     int64     `json:"bytes" bson:"bytes"`
	Files     int       `json:"files" bson:"files"`
	SavedAt   time.Time `json:"savedAt" bson:"savedAt"`
	OpenedAt  time.Time `json:"openedAt,omitzero" bson:"openedAt,omitempty"`
}

// The database copy of a project's metadata; the files themselves stay on this machine's disk.
type projectDoc struct {
	Project `bson:",inline"`
	Owner   string `bson:"owner"`
}

const (
	ProjectMaxBytes    = 200 << 20
	ProjectMaxFiles    = 20000
	MaxProjectsPerUser = 30
)

var ErrProjectNotFound = errors.New("project not found")

// Rebuildable output and dependency folders; saving or uploading them only costs space.
var skipDirs = map[string]bool{
	"node_modules": true, ".venv": true, "venv": true, "__pycache__": true, "target": true,
	".next": true, ".nuxt": true, ".cache": true, ".gradle": true, ".turbo": true,
	".pytest_cache": true, ".mypy_cache": true, ".parcel-cache": true,
}

func SkipDir(name string) bool { return skipDirs[name] }

var projectID = regexp.MustCompile(`^[a-f0-9]{12}$`)

var projectsMu sync.Mutex

// Hashed so a user name never becomes a path.
func projectsRoot(owner string) string {
	sum := sha256.Sum256([]byte(owner))
	return filepath.Join(Cfg.DataDir, "projects", hex.EncodeToString(sum[:8]))
}

func projectDir(owner, id string) (string, error) {
	if !projectID.MatchString(id) {
		return "", ErrProjectNotFound
	}
	return filepath.Join(projectsRoot(owner), id), nil
}

// The folder holding a project's files, ready to copy into a workspace.
func ProjectFiles(owner, id string) (string, error) {
	dir, err := projectDir(owner, id)
	if err != nil {
		return "", err
	}
	if DBEnabled() {
		if _, err := GetProject(owner, id); err != nil {
			return "", err
		}
	} else if _, err := os.Stat(filepath.Join(dir, "meta.json")); err != nil {
		return "", ErrProjectNotFound
	}
	return filepath.Join(dir, "files"), nil
}

func ListProjects(owner string) ([]Project, error) {
	if DBEnabled() {
		return listProjectsDB(owner)
	}
	entries, err := os.ReadDir(projectsRoot(owner))
	if os.IsNotExist(err) {
		return []Project{}, nil
	}
	if err != nil {
		return nil, err
	}
	out := []Project{}
	for _, e := range entries {
		if p, err := GetProject(owner, e.Name()); err == nil {
			out = append(out, p)
		}
	}
	sort.Slice(out, func(i, j int) bool { return lastUsed(out[i]).After(lastUsed(out[j])) })
	return out, nil
}

func lastUsed(p Project) time.Time {
	if p.OpenedAt.After(p.SavedAt) {
		return p.OpenedAt
	}
	return p.SavedAt
}

func GetProject(owner, id string) (Project, error) {
	dir, err := projectDir(owner, id)
	if err != nil {
		return Project{}, err
	}
	if DBEnabled() {
		var d projectDoc
		ctx, cancel := dbctx()
		defer cancel()
		if err := coll(colProjects).FindOne(ctx, bson.M{"_id": id, "owner": owner}).Decode(&d); err != nil {
			if isNoDoc(err) {
				return Project{}, ErrProjectNotFound
			}
			return Project{}, err
		}
		return d.Project, nil
	}
	data, err := os.ReadFile(filepath.Join(dir, "meta.json"))
	if err != nil {
		return Project{}, ErrProjectNotFound
	}
	var p Project
	if err := json.Unmarshal(data, &p); err != nil {
		return Project{}, err
	}
	p.ID = id
	return p, nil
}

func writeProjectMeta(dir, owner string, p Project) error {
	data, _ := json.MarshalIndent(p, "", "  ")
	if err := os.WriteFile(filepath.Join(dir, "meta.json"), data, 0600); err != nil {
		return err
	}
	if !DBEnabled() {
		return nil
	}
	ctx, cancel := dbctx()
	defer cancel()
	_, err := coll(colProjects).ReplaceOne(ctx, bson.M{"_id": p.ID}, projectDoc{Project: p, Owner: owner}, options.Replace().SetUpsert(true))
	return err
}

func listProjectsDB(owner string) ([]Project, error) {
	ctx, cancel := dbctx()
	defer cancel()
	cur, err := coll(colProjects).Find(ctx, bson.M{"owner": owner})
	if err != nil {
		return nil, err
	}
	var docs []projectDoc
	if err := cur.All(ctx, &docs); err != nil {
		return nil, err
	}
	out := make([]Project, 0, len(docs))
	for _, d := range docs {
		out = append(out, d.Project)
	}
	sort.Slice(out, func(i, j int) bool { return lastUsed(out[i]).After(lastUsed(out[j])) })
	return out, nil
}

// Copies src into a project; an empty id makes a new one, an existing id is replaced in place.
func SaveProject(owner, id, name, source, framework, src string) (Project, error) {
	projectsMu.Lock()
	defer projectsMu.Unlock()

	p := Project{Name: cleanProjectName(name), Source: source, Framework: framework}
	if id != "" {
		old, err := GetProject(owner, id)
		if err != nil {
			return Project{}, err
		}
		p.ID, p.OpenedAt = id, old.OpenedAt
	} else {
		existing, _ := ListProjects(owner)
		if len(existing) >= MaxProjectsPerUser {
			return Project{}, fmt.Errorf("you already have %d saved projects; delete one first", MaxProjectsPerUser)
		}
		p.ID = newProjectID()
	}

	root := projectsRoot(owner)
	if err := os.MkdirAll(root, 0700); err != nil {
		return Project{}, err
	}
	staging, err := os.MkdirTemp(root, ".save-*")
	if err != nil {
		return Project{}, err
	}
	defer os.RemoveAll(staging)

	files := filepath.Join(staging, "files")
	bytes, count, err := CopyTree(src, files, ProjectMaxBytes, ProjectMaxFiles)
	if err != nil {
		return Project{}, err
	}
	p.Bytes, p.Files, p.SavedAt = bytes, count, time.Now()
	if err := writeProjectMeta(staging, owner, p); err != nil {
		return Project{}, err
	}

	dir := filepath.Join(root, p.ID)
	if err := os.RemoveAll(dir); err != nil {
		return Project{}, err
	}
	if err := os.Rename(staging, dir); err != nil {
		return Project{}, err
	}
	return p, nil
}

func MarkProjectOpened(owner, id string) {
	projectsMu.Lock()
	defer projectsMu.Unlock()
	if p, err := GetProject(owner, id); err == nil {
		p.OpenedAt = time.Now()
		dir, _ := projectDir(owner, id)
		writeProjectMeta(dir, owner, p)
	}
}

func DeleteProject(owner, id string) error {
	projectsMu.Lock()
	defer projectsMu.Unlock()
	if _, err := GetProject(owner, id); err != nil {
		return err
	}
	if DBEnabled() {
		ctx, cancel := dbctx()
		defer cancel()
		if _, err := coll(colProjects).DeleteOne(ctx, bson.M{"_id": id, "owner": owner}); err != nil {
			return err
		}
	}
	dir, _ := projectDir(owner, id)
	return os.RemoveAll(dir)
}

func newProjectID() string {
	b := make([]byte, 6)
	rand.Read(b)
	return hex.EncodeToString(b)
}

func cleanProjectName(name string) string {
	name = strings.TrimSpace(strings.Map(func(r rune) rune {
		if r < 32 || r == 127 {
			return -1
		}
		return r
	}, name))
	if r := []rune(name); len(r) > 80 {
		name = string(r[:80])
	}
	if name == "" {
		name = "Untitled project"
	}
	return name
}

// Regular files only: symlinks and devices never leave the workspace, and dependency folders are skipped.
func CopyTree(src, dst string, maxBytes int64, maxFiles int) (int64, int, error) {
	var total int64
	count := 0
	err := filepath.WalkDir(src, func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		rel, _ := filepath.Rel(src, p)
		target := filepath.Join(dst, rel)
		if d.IsDir() {
			if p != src && SkipDir(d.Name()) {
				return filepath.SkipDir
			}
			return os.MkdirAll(target, 0755)
		}
		if !d.Type().IsRegular() {
			return nil
		}
		info, err := d.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		count++
		if total > maxBytes {
			return fmt.Errorf("project is larger than %d MB (dependency folders excluded)", maxBytes>>20)
		}
		if count > maxFiles {
			return fmt.Errorf("project has more than %d files", maxFiles)
		}
		return copyFile(p, target, info.Mode())
	})
	return total, count, err
}

func copyFile(src, dst string, mode fs.FileMode) error {
	in, err := os.Open(src)
	if err != nil {
		return err
	}
	defer in.Close()
	perm := fs.FileMode(0644)
	if mode&0111 != 0 {
		perm = 0755
	}
	out, err := os.OpenFile(dst, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, perm)
	if err != nil {
		return err
	}
	if _, err := io.Copy(out, in); err != nil {
		out.Close()
		return err
	}
	return out.Close()
}
