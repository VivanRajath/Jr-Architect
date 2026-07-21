package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// TestSandboxEntryHandler verifies the preview's "locate UI code" endpoint picks
// the most-specific existing UI entry file and returns it as a forward-slash
// workspace-relative path plus its directory.
func TestSandboxEntryHandler(t *testing.T) {
	dir := t.TempDir()
	// A Next.js app-router entry, nested under app/.
	if err := os.MkdirAll(filepath.Join(dir, "app"), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "app", "page.tsx"), []byte("export default function Page(){}"), 0644); err != nil {
		t.Fatal(err)
	}
	// A less-specific candidate that must NOT win over app/page.tsx.
	if err := os.WriteFile(filepath.Join(dir, "index.html"), []byte("<html></html>"), 0644); err != nil {
		t.Fatal(err)
	}

	name := "entry-test"
	mutex.Lock()
	sandboxes[name] = Sandbox{Container: name, Workdir: dir}
	mutex.Unlock()
	defer func() { mutex.Lock(); delete(sandboxes, name); mutex.Unlock() }()

	req := httptest.NewRequest(http.MethodGet, "/sandbox/entry?container="+name, nil)
	rec := httptest.NewRecorder()
	sandboxEntryHandler(rec, req)

	if rec.Code != 200 {
		t.Fatalf("status = %d, want 200 (body=%s)", rec.Code, rec.Body.String())
	}
	var got map[string]string
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatalf("bad json: %v", err)
	}
	if got["path"] != "app/page.tsx" {
		t.Errorf("path = %q, want app/page.tsx", got["path"])
	}
	if got["dir"] != "app" {
		t.Errorf("dir = %q, want app", got["dir"])
	}
}

// TestSandboxEntryHandlerNotFound returns 404 when no known UI entry exists.
func TestSandboxEntryHandlerNotFound(t *testing.T) {
	dir := t.TempDir()
	name := "entry-empty"
	mutex.Lock()
	sandboxes[name] = Sandbox{Container: name, Workdir: dir}
	mutex.Unlock()
	defer func() { mutex.Lock(); delete(sandboxes, name); mutex.Unlock() }()

	req := httptest.NewRequest(http.MethodGet, "/sandbox/entry?container="+name, nil)
	rec := httptest.NewRecorder()
	sandboxEntryHandler(rec, req)
	if rec.Code != 404 {
		t.Errorf("status = %d, want 404", rec.Code)
	}
}
