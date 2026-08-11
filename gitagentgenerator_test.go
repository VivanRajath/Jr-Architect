package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// TestGenerateAgentSpecMovesLargeInjectedDocs verifies the fix for the Groq 413
// "request too large" failure: a repo's oversized AGENTS.md (which gitclaw would
// splice verbatim into the agent's system prompt) is moved aside so the agent
// request stays within the model's token budget, while small docs are kept.
func TestGenerateAgentSpecMovesLargeInjectedDocs(t *testing.T) {
	dir := t.TempDir()

	bigContent := strings.Repeat("A", maxInjectedDocBytes+1000)
	if err := os.WriteFile(filepath.Join(dir, "AGENTS.md"), []byte(bigContent), 0644); err != nil {
		t.Fatal(err)
	}
	// A small DUTIES.md should be left in place (under the threshold).
	if err := os.WriteFile(filepath.Join(dir, "DUTIES.md"), []byte("# tiny"), 0644); err != nil {
		t.Fatal(err)
	}

	if err := GenerateAgentSpec(dir, "react"); err != nil {
		t.Fatalf("GenerateAgentSpec: %v", err)
	}

	// The large AGENTS.md must be moved aside (kept, not deleted).
	if _, err := os.Stat(filepath.Join(dir, "AGENTS.md")); !os.IsNotExist(err) {
		t.Errorf("large AGENTS.md should have been moved aside, but it is still present")
	}
	bak, err := os.ReadFile(filepath.Join(dir, "AGENTS.md.sandbox-bak"))
	if err != nil {
		t.Fatalf("expected AGENTS.md.sandbox-bak to exist: %v", err)
	}
	if string(bak) != bigContent {
		t.Errorf("backup content differs from original AGENTS.md")
	}

	// The small DUTIES.md must be untouched.
	if _, err := os.Stat(filepath.Join(dir, "DUTIES.md")); err != nil {
		t.Errorf("small DUTIES.md should have been left in place: %v", err)
	}

	// The generated spec files must exist, grouped under .gitagent/ following the
	// GitAgent standard layout (manifest, identity, rules, memory, skills, and the
	// tools/hooks/workflows/compliance dirs).
	for _, f := range []string{
		"agent.yaml", "SOUL.md", "RULES.md",
		filepath.Join("memory", "MEMORY.md"),
		filepath.Join("skills", "ui-editor", "SKILL.md"),
		filepath.Join("skills", "jnr-developer", "SKILL.md"),
		filepath.Join("skills", "snr-developer", "SKILL.md"),
		filepath.Join("skills", "architect", "SKILL.md"),
		filepath.Join("skills", "ask", "SKILL.md"),
		filepath.Join("skills", "build-doctor", "SKILL.md"),
		filepath.Join("compliance", "RULES.md"),
		filepath.Join("tools", "README.md"),
		filepath.Join("hooks", "README.md"),
		filepath.Join("workflows", "README.md"),
	} {
		if _, err := os.Stat(filepath.Join(dir, ".gitagent", f)); err != nil {
			t.Errorf("expected generated .gitagent/%s: %v", f, err)
		}
	}

	// agent.yaml must ALSO exist at the repo root: the engine (gitclaw) hard-reads
	// its manifest from <root>/agent.yaml, so without this every chat turn ENOENTs.
	if _, err := os.Stat(filepath.Join(dir, "agent.yaml")); err != nil {
		t.Errorf("expected root agent.yaml for the engine manifest: %v", err)
	}
}

// The gitagent standard's full layout keeps durable memory in memory/MEMORY.md.
// A repo scaffolded before that move has one at the spec root, and its contents
// are the repo's accumulated knowledge — it must be carried over, not discarded
// and not left behind as a second copy the agent might read instead.
func TestGenerateAgentSpecMigratesLegacyMemory(t *testing.T) {
	dir := t.TempDir()
	specDir := filepath.Join(dir, ".gitagent")
	if err := os.MkdirAll(specDir, 0755); err != nil {
		t.Fatal(err)
	}
	const learned = "UI entry: app/page.tsx\nNotes: the header lives in Nav.tsx"
	if err := os.WriteFile(filepath.Join(specDir, "MEMORY.md"), []byte(learned), 0644); err != nil {
		t.Fatal(err)
	}

	if err := GenerateAgentSpec(dir, "nextjs"); err != nil {
		t.Fatalf("GenerateAgentSpec: %v", err)
	}

	moved, err := os.ReadFile(filepath.Join(specDir, "memory", "MEMORY.md"))
	if err != nil {
		t.Fatalf("expected memory/MEMORY.md after migration: %v", err)
	}
	if string(moved) != learned {
		t.Errorf("memory contents lost in the move:\n got: %q\nwant: %q", moved, learned)
	}
	if _, err := os.Stat(filepath.Join(specDir, "MEMORY.md")); !os.IsNotExist(err) {
		t.Error("the legacy root MEMORY.md should be removed, not left as a stale second copy")
	}
}

// A repo that already has memory/MEMORY.md keeps it: re-cloning must never
// clobber knowledge the agent (or the developer) accumulated across turns.
func TestGenerateAgentSpecPreservesExistingMemory(t *testing.T) {
	dir := t.TempDir()
	memDir := filepath.Join(dir, ".gitagent", "memory")
	if err := os.MkdirAll(memDir, 0755); err != nil {
		t.Fatal(err)
	}
	const existing = "Never touch pricing.ts — learned the hard way."
	if err := os.WriteFile(filepath.Join(memDir, "MEMORY.md"), []byte(existing), 0644); err != nil {
		t.Fatal(err)
	}

	if err := GenerateAgentSpec(dir, "nextjs"); err != nil {
		t.Fatalf("GenerateAgentSpec: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(memDir, "MEMORY.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != existing {
		t.Errorf("existing memory was overwritten:\n got: %q\nwant: %q", got, existing)
	}
}

func TestNormalizeInstall(t *testing.T) {
	cases := map[string]string{
		"npm install && npm run dev -- -H 0.0.0.0":         "npm install --prefer-offline --no-audit --no-fund --progress=false --loglevel=error && npm run dev -- -H 0.0.0.0",
		"pip install -r requirements.txt && python app.py": "pip install --no-input --disable-pip-version-check -r requirements.txt && python app.py",
		"go mod tidy && go run .":                          "go mod tidy && go run .", // untouched
	}
	for in, want := range cases {
		if got := normalizeInstall(in); got != want {
			t.Errorf("normalizeInstall(%q)\n got  %q\n want %q", in, got, want)
		}
	}
	// Idempotent: already-flagged command is left alone.
	flagged := "npm install --no-audit && npm run dev"
	if got := normalizeInstall(flagged); got != flagged {
		t.Errorf("normalizeInstall should be idempotent, got %q", got)
	}
}

// The knowledge builder is an AGENT, not a hidden system prompt: its instructions
// must land in the repo as a skill file the developer can open, edit and commit.
// If this file stops being scaffolded, knowledge.js silently falls back to a
// built-in string and editing the panel stops changing anything.
func TestGenerateAgentSpecScaffoldsKnowledgeBuilder(t *testing.T) {
	dir := t.TempDir()
	if err := GenerateAgentSpec(dir, "node"); err != nil {
		t.Fatalf("GenerateAgentSpec: %v", err)
	}

	path := filepath.Join(dir, ".gitagent", "skills", "knowledge-builder", "SKILL.md")
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("expected %s to exist: %v", path, err)
	}
	got := string(body)

	// Frontmatter, so listSkillsDetailed can show it with a description.
	if !strings.HasPrefix(got, "---\nname: knowledge-builder\n") {
		t.Errorf("SKILL.md must open with name: knowledge-builder frontmatter, got:\n%.80s", got)
	}
	// The document's shape is the contract knowledge.js validates against
	// (looksLikeDocument requires >= 3 "## " headings).
	for _, section := range []string{
		"## What this is", "## How it works", "## Where things live",
		"## Conventions", "## Gotchas", "## Key files",
	} {
		if !strings.Contains(got, section) {
			t.Errorf("SKILL.md does not ask for the %q section", section)
		}
	}
	// The whole point: it must not just restate the static map.
	if !strings.Contains(got, "repo-map.md") {
		t.Error("SKILL.md should tell the agent not to repeat the static repo map")
	}
}

// A repo that commits its own customised knowledge-builder must keep it across a
// re-clone, like every other file in the standard layout.
func TestGenerateAgentSpecKeepsCustomKnowledgeBuilder(t *testing.T) {
	dir := t.TempDir()
	custom := "---\nname: knowledge-builder\n---\n\nOnly ever write one sentence.\n"
	skillDir := filepath.Join(dir, ".gitagent", "skills", "knowledge-builder")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(custom), 0644); err != nil {
		t.Fatal(err)
	}

	if err := GenerateAgentSpec(dir, "node"); err != nil {
		t.Fatalf("GenerateAgentSpec: %v", err)
	}

	got, err := os.ReadFile(filepath.Join(skillDir, "SKILL.md"))
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != custom {
		t.Error("a committed knowledge-builder was overwritten by the scaffold")
	}
}
