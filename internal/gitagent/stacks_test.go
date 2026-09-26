package gitagent

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sandbox/internal/core"
)

func monorepoServices() []core.Service {
	return []core.Service{
		{Name: "frontend", Dir: "frontend", Stack: "react", Framework: "Next.js", ContainerPort: 3000, Primary: true},
		{Name: "backend", Dir: "backend", Stack: "django", Framework: "Django", ContainerPort: 8000},
	}
}

func TestStackListPutsPrimaryFirst(t *testing.T) {
	got := stackList("django", monorepoServices())
	if strings.Join(got, ",") != "django,react" {
		t.Errorf("stackList = %v, want django then react", got)
	}
	// A single-stack repo is unchanged.
	if got := stackList("react", monorepoServices()[:1]); len(got) != 1 || got[0] != "react" {
		t.Errorf("stackList = %v, want just react", got)
	}
}

// The whole point: guidance for the half the agent is editing, not only the half
// the preview opens.
func TestPerStackCoversEveryStack(t *testing.T) {
	out := perStack(Rules)([]string{"react", "django"})
	for _, want := range []string{"### react", "### django", "urls.py", "src/components"} {
		if !strings.Contains(out, want) {
			t.Errorf("missing %q in:\n%s", want, out)
		}
	}
	// One stack keeps the old plain output — no headings where there is no choice.
	if strings.Contains(perStack(Rules)([]string{"django"}), "###") {
		t.Error("a single-stack repo got per-stack headings")
	}
}

func TestServicesTableOnlyWhenThereIsAChoice(t *testing.T) {
	if got := ServicesTable(monorepoServices()[:1]); got != "" {
		t.Errorf("single service produced a table: %q", got)
	}
	tbl := ServicesTable(monorepoServices())
	for _, want := range []string{"frontend (preview)", "backend/", "django", "8000"} {
		if !strings.Contains(tbl, want) {
			t.Errorf("missing %q in:\n%s", want, tbl)
		}
	}
}

func TestAgentSpecCarriesEveryStack(t *testing.T) {
	dir := t.TempDir()
	if err := GenerateAgentSpec(dir, "react", monorepoServices()...); err != nil {
		t.Fatal(err)
	}

	rules, err := os.ReadFile(filepath.Join(dir, ".gitagent", "RULES.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(rules), "react + django") {
		t.Errorf("RULES.md does not name both stacks:\n%s", rules)
	}
	if !strings.Contains(string(rules), "urls.py") {
		t.Error("RULES.md carries no Django guidance, so the agent would edit the backend blind")
	}

	mem, err := os.ReadFile(filepath.Join(dir, ".gitagent", "memory", "MEMORY.md"))
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(mem), "## Services") || !strings.Contains(string(mem), "backend/") {
		t.Errorf("MEMORY.md has no services table:\n%s", mem)
	}
}
