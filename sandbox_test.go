package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestValidateRepoURL(t *testing.T) {
	valid := []string{
		"https://github.com/VivanRajath/React-Portfolio",
		"http://example.com/repo.git",
	}
	for _, u := range valid {
		if err := validateRepoURL(u); err != nil {
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
		if err := validateRepoURL(u); err == nil {
			t.Errorf("expected %q to be rejected", u)
		}
	}
}

func TestResolveInWorkspace(t *testing.T) {
	work := filepath.Clean(filepath.Join(os.TempDir(), "sandbox-abc"))

	// Inside the workspace -> allowed.
	if _, ok := resolveInWorkspace(work, "src/app.js"); !ok {
		t.Error("expected in-workspace path to be allowed")
	}

	// Parent traversal -> rejected.
	if _, ok := resolveInWorkspace(work, "../../etc/passwd"); ok {
		t.Error("expected parent traversal to be rejected")
	}

	// Sibling directory sharing the name prefix -> rejected (the bug this fixes).
	if _, ok := resolveInWorkspace(work, "../sandbox-abcEVIL/secret"); ok {
		t.Error("expected sibling-prefix path to be rejected")
	}
}

func TestParseGeneratedFiles(t *testing.T) {
	// Well-formed array -> all files.
	whole := `[{"path":"a.ts","content":"1"},{"path":"b.ts","content":"2"}]`
	if got := parseGeneratedFiles(whole); len(got) != 2 {
		t.Errorf("well-formed: expected 2 files, got %d", len(got))
	}

	// Truncated mid-array (model hit token limit) -> salvage the complete prefix.
	truncated := `[{"path":"a.ts","content":"1"},{"path":"b.ts","content":"export const x = [`
	got := parseGeneratedFiles(truncated)
	if len(got) != 1 || got[0].Path != "a.ts" {
		t.Errorf("truncated: expected 1 salvaged file (a.ts), got %+v", got)
	}

	// Garbage -> no files.
	if got := parseGeneratedFiles("not json at all"); len(got) != 0 {
		t.Errorf("garbage: expected 0 files, got %d", len(got))
	}
}

func TestParsePRDRoutes(t *testing.T) {
	prd := &PRD{Pages: []string{
		"/ - Home",
		"/dashboard - Dashboard",
		"/settings/ - Settings", // trailing slash normalized
		"Just a page name",      // no leading slash -> skipped
		"/dashboard - Dupe",     // duplicate route -> skipped
	}}
	routes := parsePRDRoutes(prd)
	if len(routes) != 3 {
		t.Fatalf("expected 3 routes, got %d: %+v", len(routes), routes)
	}
	want := map[string]string{
		"/":          "app/page.tsx",
		"/dashboard": "app/dashboard/page.tsx",
		"/settings":  "app/settings/page.tsx",
	}
	for _, rt := range routes {
		if want[rt.route] != rt.file {
			t.Errorf("route %q -> file %q, want %q", rt.route, rt.file, want[rt.route])
		}
	}
}

func TestCleanJSONArray(t *testing.T) {
	cases := map[string]string{
		"```json\n[{\"a\":1}]\n```": `[{"a":1}]`,
		"Sure! Here:\n[{\"a\":1}]":  `[{"a":1}]`,
		"[{\"a\":1}]":               `[{"a":1}]`,
	}
	for in, want := range cases {
		if got := cleanJSONArray(in); got != want {
			t.Errorf("cleanJSONArray(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGroqPoolReserveRotatesAndThrottles(t *testing.T) {
	p := &groqPool{
		keys:     []*groqKey{{key: "a", label: "a"}, {key: "b", label: "b"}},
		tpm:      10000,
		headroom: 1.0,
	}
	// Two reservations of 6000 must land on different keys (neither key fits two).
	k1, err := p.reserve(6000)
	if err != nil {
		t.Fatalf("reserve 1: %v", err)
	}
	k2, err := p.reserve(6000)
	if err != nil {
		t.Fatalf("reserve 2: %v", err)
	}
	if k1 == k2 {
		t.Errorf("expected reservations to spread across keys, both got %s", k1.label)
	}
	// A refund frees budget back up on that key.
	k1.reconcile(6000, 0)
	k1.mu.Lock()
	used := k1.used
	k1.mu.Unlock()
	if used != 0 {
		t.Errorf("expected used=0 after full refund, got %d", used)
	}
}

func TestPostProcessBareUseClient(t *testing.T) {
	// The model emitted an unquoted `use client;` after the imports (invalid).
	in := "import Card from '@/components/ui/Card';\n\nuse client;\n\nexport function Dashboard() { return null }"
	out := postProcessCode(in, "components/app/Dashboard.tsx")

	if strings.Contains(out, "\nuse client;") || strings.HasPrefix(out, "use client;") {
		t.Errorf("bare `use client;` was not removed:\n%s", out)
	}
	if !strings.HasPrefix(out, `"use client";`) {
		t.Errorf("expected proper directive at line 1, got:\n%s", out)
	}
	// The correct directive must appear exactly once.
	if n := strings.Count(out, `"use client"`); n != 1 {
		t.Errorf("expected exactly one \"use client\" directive, got %d", n)
	}
	// A properly-quoted directive already present must be left untouched (not duplicated).
	already := "\"use client\";\nimport x from 'y';\nexport function C(){return null}"
	if got := postProcessCode(already, "components/app/C.tsx"); strings.Count(got, `"use client"`) != 1 {
		t.Errorf("existing directive should not be duplicated:\n%s", got)
	}
}

func TestNormalizeUIImports(t *testing.T) {
	cases := map[string]string{
		// default import + capitalized path -> named import + lowercase path
		`import Card from '@/components/ui/Card';`:     `import { Card } from '@/components/ui/card';`,
		`import Button from "@/components/ui/Button";`: `import { Button } from "@/components/ui/button";`,
		// already-correct named import is left intact
		`import { Input } from '@/components/ui/input';`: `import { Input } from '@/components/ui/input';`,
		// named import with capitalized path -> path lowercased, stays named
		`import { Badge } from '@/components/ui/Badge';`: `import { Badge } from '@/components/ui/badge';`,
	}
	for in, want := range cases {
		if got := normalizeUIImports(in); got != want {
			t.Errorf("normalizeUIImports(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPostProcessNormalizesBrokenCardImport(t *testing.T) {
	// The exact failing import from the build log.
	in := "import Card from '@/components/ui/Card';\nexport function X(){ return null }"
	out := postProcessCode(in, "components/app/X.tsx")
	if !strings.Contains(out, `import { Card } from '@/components/ui/card';`) {
		t.Errorf("broken Card import was not normalized:\n%s", out)
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
		if got := imageToStack(in); got != want {
			t.Errorf("imageToStack(%q) = %q, want %q", in, got, want)
		}
	}
}
