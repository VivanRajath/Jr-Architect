package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestGenerateRepoMap verifies the clone-time repo map: it indexes source files,
// extracts symbols, writes the always-loaded + on-demand docs, and registers them
// in knowledge/index.yaml — while skipping dependency dirs.
func TestGenerateRepoMap(t *testing.T) {
	dir := t.TempDir()
	write := func(rel, content string) {
		p := filepath.Join(dir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(p), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	// A Next.js-ish app entry with an exported component.
	write("app/page.tsx", "export default function HomePage() { return null }\nexport const metadata = {}\n")
	write("lib/auth.ts", "export function signIn() {}\nexport class TokenStore {}\n")
	// A dependency file that MUST be skipped.
	write("node_modules/react/index.js", "module.exports = {}\n")

	if err := generateRepoMap(dir, "react", "Next.js (Lyzr App)"); err != nil {
		t.Fatalf("generateRepoMap: %v", err)
	}

	compact, err := os.ReadFile(filepath.Join(dir, "knowledge", "repo-map.md"))
	if err != nil {
		t.Fatalf("repo-map.md not written: %v", err)
	}
	full, err := os.ReadFile(filepath.Join(dir, "knowledge", "repo-map-full.md"))
	if err != nil {
		t.Fatalf("repo-map-full.md not written: %v", err)
	}
	index, err := os.ReadFile(filepath.Join(dir, "knowledge", "index.yaml"))
	if err != nil {
		t.Fatalf("index.yaml not written: %v", err)
	}

	compactStr, fullStr, indexStr := string(compact), string(full), string(index)

	// Entry point detected and shown in the compact map.
	if !strings.Contains(compactStr, "app/page.tsx") {
		t.Errorf("compact map missing UI entry app/page.tsx:\n%s", compactStr)
	}
	// Framework surfaced.
	if !strings.Contains(compactStr, "Next.js (Lyzr App)") {
		t.Errorf("compact map missing framework label")
	}
	// Symbols extracted into the full map.
	for _, want := range []string{"signIn", "TokenStore", "HomePage"} {
		if !strings.Contains(fullStr, want) {
			t.Errorf("full map missing symbol %q:\n%s", want, fullStr)
		}
	}
	// node_modules must not be indexed.
	if strings.Contains(fullStr, "node_modules") {
		t.Errorf("full map should not include node_modules")
	}
	// Both docs registered with the knowledge loader.
	if !strings.Contains(indexStr, "repo-map.md") || !strings.Contains(indexStr, "always_load: true") {
		t.Errorf("index.yaml missing always-loaded repo-map.md:\n%s", indexStr)
	}
	if !strings.Contains(indexStr, "repo-map-full.md") {
		t.Errorf("index.yaml missing repo-map-full.md")
	}
}

// TestEnsureKnowledgeIndexPreservesExisting verifies we append to a repo's own
// knowledge/index.yaml rather than clobbering it, and that re-running is a no-op.
func TestEnsureKnowledgeIndexPreservesExisting(t *testing.T) {
	dir := t.TempDir()
	kd := filepath.Join(dir, "knowledge")
	if err := os.MkdirAll(kd, 0o755); err != nil {
		t.Fatal(err)
	}
	existing := "entries:\n  - path: house-style.md\n    always_load: true\n"
	if err := os.WriteFile(filepath.Join(kd, "index.yaml"), []byte(existing), 0o644); err != nil {
		t.Fatal(err)
	}

	if err := ensureKnowledgeIndex(kd); err != nil {
		t.Fatal(err)
	}
	out1, _ := os.ReadFile(filepath.Join(kd, "index.yaml"))
	s := string(out1)
	if !strings.Contains(s, "house-style.md") {
		t.Errorf("existing entry was clobbered:\n%s", s)
	}
	if !strings.Contains(s, "repo-map.md") {
		t.Errorf("repo-map entry not appended:\n%s", s)
	}

	// Idempotent: a second run must not duplicate our entries.
	if err := ensureKnowledgeIndex(kd); err != nil {
		t.Fatal(err)
	}
	out2, _ := os.ReadFile(filepath.Join(kd, "index.yaml"))
	if strings.Count(string(out2), "repo-map.md") != 1 {
		t.Errorf("re-run duplicated repo-map.md entry:\n%s", string(out2))
	}
}
