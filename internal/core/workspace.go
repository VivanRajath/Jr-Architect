package core

import (
	"fmt"
	"io/fs"
	"net/url"
	"os"
	"path/filepath"
	"strings"
)

// Refuses paths that leave workdir lexically or through a symlink, since sandbox code can plant links to host files.
func ResolveInWorkspace(workdir, rel string) (string, bool) {
	abs := filepath.Clean(filepath.Join(workdir, filepath.FromSlash(rel)))
	if !within(workdir, abs) {
		return "", false
	}
	root, err := filepath.EvalSymlinks(workdir)
	if err != nil {
		if os.IsNotExist(err) {
			return abs, true // not cloned yet, so there is nothing to follow
		}
		return "", false
	}
	if real, ok := realLocation(abs); !ok || !within(root, real) {
		return "", false
	}
	return abs, true
}

// A sibling dir ("workdir-evil") shares the prefix, so require a separator boundary.
func within(root, p string) bool {
	root = strings.TrimSuffix(root, string(os.PathSeparator))
	return p == root || strings.HasPrefix(p, root+string(os.PathSeparator))
}

// Real path of p via its deepest existing ancestor; false when a link on the way dangles.
func realLocation(p string) (string, bool) {
	var rest []string
	for cur := p; ; {
		if r, err := filepath.EvalSymlinks(cur); err == nil {
			return filepath.Join(append([]string{r}, rest...)...), true
		}
		if _, err := os.Lstat(cur); err == nil {
			return "", false
		}
		parent := filepath.Dir(cur)
		if parent == cur {
			return "", false
		}
		rest = append([]string{filepath.Base(cur)}, rest...)
		cur = parent
	}
}

// Deletes symlinks that resolve outside workdir, so host-side readers never meet one right after a clone.
func PruneEscapingSymlinks(workdir string) int {
	root, err := filepath.EvalSymlinks(workdir)
	if err != nil {
		return 0
	}
	removed := 0
	filepath.WalkDir(workdir, func(p string, d fs.DirEntry, err error) error {
		if err != nil || d.Type()&fs.ModeSymlink == 0 {
			return nil
		}
		if real, ok := realLocation(p); !ok || !within(root, real) {
			if os.Remove(p) == nil {
				removed++
			}
		}
		return nil
	})
	return removed
}

// Rejects git argument injection (a leading "-") and file:// clones of the host.
func ValidateRepoURL(repo string) error {
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

func FileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// Common "main UI" files, most-specific first.
var UIEntryCandidates = []string{
	"app/page.tsx", "app/page.jsx", "app/page.js", "app/page.mdx", // Next.js app router
	"src/app/page.tsx", "src/app/page.jsx", "src/app/page.js",
	"pages/index.tsx", "pages/index.jsx", "pages/index.js", // Next.js pages router
	"src/pages/index.tsx", "src/pages/index.jsx",
	"src/App.tsx", "src/App.jsx", "src/App.js", "src/App.vue", "src/App.svelte", // CRA/Vite/Vue/Svelte
	"src/main.tsx", "src/main.jsx", "src/main.ts", "src/main.js",
	"src/index.tsx", "src/index.jsx",
	"app/App.tsx",
	"index.html", "public/index.html", "src/index.html", // static
	"templates/index.html", "templates/home.html", "templates/base.html", // flask/django
}
