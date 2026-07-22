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
		"agent.yaml", "SOUL.md", "RULES.md", "MEMORY.md",
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

func TestNormalizeInstall(t *testing.T) {
	cases := map[string]string{
		"npm install && npm run dev -- -H 0.0.0.0":     "npm install --prefer-offline --no-audit --no-fund --progress=false --loglevel=error && npm run dev -- -H 0.0.0.0",
		"pip install -r requirements.txt && python app.py": "pip install --no-input --disable-pip-version-check -r requirements.txt && python app.py",
		"go mod tidy && go run .":                       "go mod tidy && go run .", // untouched
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
