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

	// The generated spec files must exist.
	for _, f := range []string{"agent.yaml", "SOUL.md", "RULES.md", filepath.Join("skills", "ui-editor", "SKILL.md")} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("expected generated %s: %v", f, err)
		}
	}
}
