package core

import (
	"os"
	"path/filepath"
	"testing"
)

func TestValidateRepoURL(t *testing.T) {
	valid := []string{
		"https://github.com/VivanRajath/React-Portfolio",
		"http://example.com/repo.git",
	}
	for _, u := range valid {
		if err := ValidateRepoURL(u); err != nil {
			t.Errorf("expected %q to be valid, got: %v", u, err)
		}
	}

	invalid := []string{
		"",                       // empty
		"--upload-pack=/bin/sh",  // argument injection
		"file:///etc/passwd",     // local filesystem
		"git@github.com:foo/bar", // ssh, not http(s)
		"ftp://example.com/repo", // wrong scheme
		"not a url",              // no scheme/host
	}
	for _, u := range invalid {
		if err := ValidateRepoURL(u); err == nil {
			t.Errorf("expected %q to be rejected", u)
		}
	}
}

func TestResolveInWorkspace(t *testing.T) {
	work := filepath.Clean(filepath.Join(os.TempDir(), "sandbox-abc"))

	// Inside the workspace -> allowed.
	if _, ok := ResolveInWorkspace(work, "src/app.js"); !ok {
		t.Error("expected in-workspace path to be allowed")
	}

	// Parent traversal -> rejected.
	if _, ok := ResolveInWorkspace(work, "../../etc/passwd"); ok {
		t.Error("expected parent traversal to be rejected")
	}

	// Sibling directory sharing the name prefix -> rejected (the bug this fixes).
	if _, ok := ResolveInWorkspace(work, "../sandbox-abcEVIL/secret"); ok {
		t.Error("expected sibling-prefix path to be rejected")
	}
}

func TestImageToStack(t *testing.T) {
	cases := map[string]string{
		"sandbox-react":   "react",
		"sandbox-node":    "node",
		"sandbox-builder": "builder",
		"react":           "react", // no prefix -> unchanged
	}
	for in, want := range cases {
		if got := ImageToStack(in); got != want {
			t.Errorf("ImageToStack(%q) = %q, want %q", in, got, want)
		}
	}
}

// Symlinks need Developer Mode or admin on Windows, so those runs skip rather than fail.
func symlinkOrSkip(t *testing.T, target, link string) {
	t.Helper()
	if err := os.Symlink(target, link); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}
}

func TestResolveInWorkspaceSymlinks(t *testing.T) {
	base := t.TempDir()
	work := filepath.Join(base, "sandbox-1")
	outside := filepath.Join(base, "secret")
	os.MkdirAll(filepath.Join(work, "src"), 0o755)
	os.MkdirAll(outside, 0o755)
	os.WriteFile(filepath.Join(outside, ".env"), []byte("KEY=1"), 0o644)
	os.WriteFile(filepath.Join(work, "src", "a.js"), []byte("x"), 0o644)

	symlinkOrSkip(t, filepath.Join(outside, ".env"), filepath.Join(work, "leak"))
	symlinkOrSkip(t, outside, filepath.Join(work, "dir"))
	symlinkOrSkip(t, filepath.Join(outside, "missing"), filepath.Join(work, "dangling"))
	symlinkOrSkip(t, filepath.Join(work, "src", "a.js"), filepath.Join(work, "alias"))

	for _, rel := range []string{"leak", "dir/.env", "dir/new.txt", "dangling"} {
		if _, ok := ResolveInWorkspace(work, rel); ok {
			t.Errorf("%s: expected an escaping symlink to be refused", rel)
		}
	}
	for _, rel := range []string{"src/a.js", "alias", "src/new/file.txt"} {
		if _, ok := ResolveInWorkspace(work, rel); !ok {
			t.Errorf("%s: expected an in-workspace path to be allowed", rel)
		}
	}

	if n := PruneEscapingSymlinks(work); n != 3 {
		t.Errorf("pruned %d links, want 3 (leak, dir, dangling)", n)
	}
	if _, err := os.Lstat(filepath.Join(work, "alias")); err != nil {
		t.Error("an in-workspace link should survive pruning")
	}
	if _, err := os.Stat(filepath.Join(outside, ".env")); err != nil {
		t.Error("pruning must remove the link, never its target")
	}
}
