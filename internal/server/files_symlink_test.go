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
