package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sandbox/internal/core"
)

func TestFileHandlersRefuseEscapingSymlinks(t *testing.T) {
	base := t.TempDir()
	work := filepath.Join(base, "sandbox-9")
	secret := filepath.Join(base, "host.env")
	os.MkdirAll(work, 0o755)
	os.WriteFile(secret, []byte("GROQ_API_KEY=hunter2"), 0o644)
	if err := os.Symlink(secret, filepath.Join(work, "leak.txt")); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}

	name := "symlink-test"
	core.PutSandbox(core.Sandbox{Owner: core.LocalUser, Container: name, Workdir: work})
	defer core.DeleteSandbox(name)

	rec := httptest.NewRecorder()
	fileReadHandler(rec, httptest.NewRequest(http.MethodGet, "/file?container="+name+"&path=leak.txt", nil))
	if rec.Code != 403 || strings.Contains(rec.Body.String(), "hunter2") {
		t.Fatalf("read through symlink: status %d body %q, want 403 and no secret", rec.Code, rec.Body.String())
	}

	rec = httptest.NewRecorder()
	body := `{"container":"` + name + `","path":"leak.txt","content":"overwritten"}`
	fileSaveHandler(rec, httptest.NewRequest(http.MethodPost, "/file/save", strings.NewReader(body)))
	if rec.Code != 403 {
		t.Fatalf("save through symlink: status %d, want 403", rec.Code)
	}
	if b, _ := os.ReadFile(secret); string(b) != "GROQ_API_KEY=hunter2" {
		t.Fatalf("host file was modified: %q", b)
	}
}

// The up-front check can be raced by the sandbox, so the I/O itself must refuse a directory swapped for an outside link.
func TestRootIORefusesALinkSwappedInAfterTheCheck(t *testing.T) {
	base := t.TempDir()
	work := filepath.Join(base, "sandbox-7")
	outside := filepath.Join(base, "host")
	os.MkdirAll(filepath.Join(work, "src"), 0o755)
	os.MkdirAll(outside, 0o755)
	os.WriteFile(filepath.Join(outside, "secret.env"), []byte("GROQ_API_KEY=hunter2"), 0o644)
	os.WriteFile(filepath.Join(work, "src", "app.js"), []byte("ok"), 0o644)

	abs, ok := core.ResolveInWorkspace(work, "src/secret.env")
	if !ok {
		t.Fatal("the check should pass while src is still a real directory")
	}
	// The swap a racing sandbox would make between the check and the read.
	os.RemoveAll(filepath.Join(work, "src"))
	if err := os.Symlink(outside, filepath.Join(work, "src")); err != nil {
		t.Skipf("symlinks unavailable here: %v", err)
	}

	rec := httptest.NewRecorder()
	root, rel, ok := inRoot(rec, work, abs)
	if !ok {
		t.Fatal("opening the workspace root failed")
	}
	defer root.Close()
	if data, err := root.ReadFile(rel); err == nil {
		t.Fatalf("read through the swapped link returned %q", data)
	}
	if err := root.WriteFile(filepath.Join("src", "planted.txt"), []byte("x"), 0o644); err == nil {
		t.Fatal("write through the swapped link succeeded")
	}
	if _, err := os.Stat(filepath.Join(outside, "planted.txt")); err == nil {
		t.Fatal("a file was created outside the workspace")
	}

	os.Remove(filepath.Join(work, "src"))
	os.MkdirAll(filepath.Join(work, "src"), 0o755)
	os.WriteFile(filepath.Join(work, "src", "app.js"), []byte("ok"), 0o644)
	// Repos use relative links; os.Root refuses absolute targets, which name container paths anyway.
	if err := os.Symlink(filepath.Join("src", "app.js"), filepath.Join(work, "alias.js")); err == nil {
		if data, err := root.ReadFile("alias.js"); err != nil || string(data) != "ok" {
			t.Fatalf("a link that stays inside the workspace should still read: %q %v", data, err)
		}
	}
}

func TestDeleteRefusesTheWorkspaceRoot(t *testing.T) {
	work := filepath.Join(t.TempDir(), "sandbox-8")
	os.MkdirAll(work, 0o755)
	os.WriteFile(filepath.Join(work, "keep.txt"), []byte("x"), 0o644)
	name := "sandbox-rootdel"
	core.PutSandbox(core.Sandbox{Owner: core.LocalUser, Container: name, Workdir: work})
	defer core.DeleteSandbox(name)
	for _, p := range []string{"", ".", "./"} {
		rec := httptest.NewRecorder()
		fileDeleteHandler(rec, httptest.NewRequest(http.MethodPost, "/file/delete", strings.NewReader(`{"container":"`+name+`","path":"`+p+`"}`)))
		if rec.Code != 400 {
			t.Errorf("delete %q = %d, want 400", p, rec.Code)
		}
	}
	if _, err := os.Stat(filepath.Join(work, "keep.txt")); err != nil {
		t.Fatal("the workspace was deleted")
	}
}
