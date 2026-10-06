package core

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func writeTree(t *testing.T, root string, files map[string]string) {
	t.Helper()
	for rel, body := range files {
		p := filepath.Join(root, filepath.FromSlash(rel))
		os.MkdirAll(filepath.Dir(p), 0755)
		if err := os.WriteFile(p, []byte(body), 0644); err != nil {
			t.Fatal(err)
		}
	}
}

func TestCopyTreeSkipsDependencyFolders(t *testing.T) {
	src, dst := t.TempDir(), filepath.Join(t.TempDir(), "out")
	writeTree(t, src, map[string]string{"app.js": "x", "src/a.js": "yy", "node_modules/big/i.js": "zzz", "api/.venv/lib.py": "q"})
	n, files, err := CopyTree(src, dst, 1<<20, 100)
	if err != nil {
		t.Fatal(err)
	}
	if files != 2 || n != 3 {
		t.Fatalf("copied %d files / %d bytes, want 2 / 3", files, n)
	}
	if _, err := os.Stat(filepath.Join(dst, "node_modules")); !os.IsNotExist(err) {
		t.Fatal("node_modules was copied")
	}
}

func TestCopyTreeEnforcesLimits(t *testing.T) {
	src := t.TempDir()
	writeTree(t, src, map[string]string{"a": "12345", "b": "12345"})
	if _, _, err := CopyTree(src, filepath.Join(t.TempDir(), "o"), 6, 100); err == nil || !strings.Contains(err.Error(), "larger") {
		t.Fatalf("size limit not enforced: %v", err)
	}
	if _, _, err := CopyTree(src, filepath.Join(t.TempDir(), "o"), 100, 1); err == nil {
		t.Fatal("file limit not enforced")
	}
}

func TestProjectLifecycle(t *testing.T) {
	old := Cfg
	defer func() { Cfg = old }()
	Cfg.DataDir = t.TempDir()
	src := t.TempDir()
	writeTree(t, src, map[string]string{"main.go": "package main"})

	p, err := SaveProject("alice", "", "  shop\x00-api ", "https://github.com/a/shop-api", "go", src)
	if err != nil {
		t.Fatal(err)
	}
	if p.Name != "shop-api" || p.Files != 1 {
		t.Fatalf("saved %+v", p)
	}
	if list, _ := ListProjects("bob"); len(list) != 0 {
		t.Fatal("another user can see the project")
	}
	writeTree(t, src, map[string]string{"extra.go": "package main"})
	again, err := SaveProject("alice", p.ID, "shop-api", "x", "go", src)
	if err != nil || again.ID != p.ID || again.Files != 2 {
		t.Fatalf("resave: %+v %v", again, err)
	}
	if list, _ := ListProjects("alice"); len(list) != 1 {
		t.Fatalf("resave made a second project: %d", len(list))
	}
	if _, err := ProjectFiles("alice", "../../etc"); err == nil {
		t.Fatal("path-like id accepted")
	}
	if err := DeleteProject("bob", p.ID); err == nil {
		t.Fatal("another user deleted the project")
	}
	if err := DeleteProject("alice", p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := GetProject("alice", p.ID); err == nil {
		t.Fatal("project still there after delete")
	}
}

func TestDetectProvider(t *testing.T) {
	for key, want := range map[string]string{"gsk_": "groq", "sk-ant-": "anthropic", "sk-proj-": "openai", "AIza": "gemini"} {
		if p, ok := DetectProvider(key); !ok || p.ID != want {
			t.Errorf("%s: got %q, want %q", key, p.ID, want)
		}
	}
	if _, ok := DetectProvider("hello"); ok {
		t.Error("unknown key detected as a provider")
	}
}

func TestSavedKeysBeatEnvAndFallBack(t *testing.T) {
	old := Cfg
	defer func() { Cfg = old; systemKeys = nil }()
	Cfg.DataDir = t.TempDir()
	t.Setenv("GROQ_API_KEY", "test-groq-from_env_000000")
	t.Setenv("GROQ_API_KEYS", "")
	t.Setenv("OPENAI_API_KEY", "")
	t.Setenv("ANTHROPIC_API_KEY", "")
	t.Setenv("GEMINI_API_KEY", "")
	systemKeys = nil
	LoadSavedKeys()
	if err := AddSavedKey("groq", "test-groq-mine_1111111111"); err != nil {
		t.Fatal(err)
	}
	if err := AddSavedKey("anthropic", "test-anthropic-mine-123456789"); err != nil {
		t.Fatal(err)
	}
	if k := ProviderKeys("groq"); len(k) != 1 || k[0] != "test-groq-mine_1111111111" || os.Getenv("GROQ_API_KEY") != k[0] {
		t.Fatalf("saved Groq key did not replace the .env one: %v", k)
	}
	if info, _ := os.Stat(filepath.Join(Cfg.DataDir, "keys.json")); info == nil {
		t.Fatal("keys.json not written")
	}
	for _, s := range KeyStates() {
		if strings.Contains(s.Masked, "3456789") {
			t.Fatal("key state leaks the key")
		}
	}
	if err := RemoveSavedKey("groq", KeyID("test-groq-mine_1111111111")); err != nil {
		t.Fatal(err)
	}
	if k := ProviderKeys("groq"); len(k) != 1 || k[0] != "test-groq-from_env_000000" {
		t.Fatalf("removing the saved key did not fall back to .env: %v", k)
	}
}
