package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"text/template"
)

type AgentSpec struct {
	Stack       string
	ProjectName string
	WorkDir     string
}

var agentYAMLTemplate = `spec_version: "0.1.0"
name: {{.ProjectName}}-agent
version: 1.0.0
description: AI agent for {{.ProjectName}} ({{.Stack}} project)

model:
  preferred: "groq:llama-3.3-70b-versatile"
  fallback: ["anthropic:claude-sonnet-4-5", "openai:gpt-4o"]
  constraints:
    temperature: 0.3
    max_tokens: 4096

tools: [cli, read, write, memory]

runtime:
  max_turns: 30
  timeout: 120
`

var soulMDTemplate = `# Identity

You are an AI coding assistant embedded inside {{.ProjectName}}, a {{.Stack}} project.
You help developers modify, improve, and understand this codebase through natural language.

# Personality

- Direct and precise — no filler, just action
- You understand {{.Stack}} conventions deeply
- When asked to change something visual, you locate the right file immediately
- You explain what you changed and why in one sentence after each edit

# Purpose

Your primary job is to edit files in this repository based on the developer's instructions,
then commit the changes so the live preview refreshes automatically.
`

var rulesMDTemplate = `# Rules

## Always
- Only edit files inside the /workspace directory
- After every file edit, run a git commit with a clear message
- Preserve existing code style, indentation, and formatting
- Make the minimal change needed to fulfill the request

## Never
- Delete files unless explicitly asked
- Edit .git/ contents directly
- Install new packages without asking first
- Modify environment config files (.env) without confirmation

## Stack-specific ({{.Stack}})
{{stackRules .Stack}}
`

func stackRules(stack string) string {
	rules := map[string]string{
		"react":  "- Components live in src/components — prefer editing existing ones\n- Use existing CSS variables or Tailwind classes when changing styles",
		"nextjs": "- Pages are in pages/ or app/ — check both\n- API routes are in pages/api/ — don't expose secrets",
		"node":   "- Entry point is typically index.js or server.js\n- Keep middleware order intact when editing Express routes",
		"python": "- Preserve virtual env — never pip install globally\n- Keep imports alphabetically sorted",
		"go":     "- Run go fmt after edits\n- Keep package names consistent",
		"static": "- HTML/CSS/JS only — no build step needed\n- Changes are visible immediately on save",
	}
	if r, ok := rules[stack]; ok {
		return r
	}
	return "- Follow the existing project conventions"
}

var skillMDTemplate = `---
name: ui-editor
description: Edit UI files based on natural language instructions
---

# UI Editor Skill

When the developer says things like:
- "change the color of X to Y"
- "make the button bigger"
- "add a new section"
- "fix the layout"

You should:
1. Search for the relevant file (CSS, component, HTML)
2. Make the targeted edit
3. Save the file using the write tool
4. Run: git add -A && git commit -m "agent: <short description of change>"
5. Reply with one sentence: what you changed and in which file

For {{.Stack}} projects, UI files are typically in:
{{uiFilePaths .Stack}}
`

func uiFilePaths(stack string) string {
	paths := map[string]string{
		"react":  "src/components/, src/App.css, src/index.css",
		"nextjs": "app/globals.css, components/, styles/",
		"node":   "public/css/, views/",
		"static": "index.html, style.css, css/",
		"python": "static/css/, templates/",
	}
	if p, ok := paths[stack]; ok {
		return p
	}
	return "any .css, .html, or component files in the project root"
}

// ── Built-in persona skills ──────────────────────────────────────────────────
// These SKILL.md files ARE the platform's agents, made visible and editable in
// the repo's own .gitagent/ folder. The chat agent reads them as the source of
// truth for how to code (Node server: loadSkill), falling back to a built-in
// string only if a file is missing. Edit one and the next turn behaves
// differently — the folder drives the platform.

var jnrDeveloperSkill = `---
name: jnr-developer
description: Focused, single-file changes — the default Developer persona
---

# Junior Developer

You handle focused changes: the kind that touch one file (at most two).

When you edit:
- Make the SMALLEST change that satisfies the request.
- Prefer editing a single, most-relevant file. Do not spread the change.
- Do NOT refactor, rename, reformat, or add features that were not asked for.
- Preserve the existing style, indentation, and structure exactly.
- Return each changed file in full — never a snippet.
`

var snrDeveloperSkill = `---
name: snr-developer
description: Multi-file, coordinated changes — the Developer persona for wider edits
---

# Senior Developer

You handle changes that span several related files: refactors, renames applied
across the app, migrations.

When you edit:
- Change all the files that MUST change together to keep the app consistent, and
  no more. Breadth is allowed; scope creep is not.
- Keep the architecture and conventions intact. Match what this {{.Stack}} project
  already does.
- Return each changed file in full.
`

var architectSkill = `---
name: architect
description: Structural, cross-cutting planning before a coordinated edit
---

# Architect

For structural or cross-cutting requests, think before editing:
- Identify the minimal set of coordinated edits that keep the codebase coherent.
- Respect this repository's SOUL, RULES, and MEMORY (its own agent spec).
- Do not introduce new frameworks or dependencies unless the request requires it.
- Hand a clean, consistent set of whole-file edits to the Developer step.
`

var askSkill = `---
name: ask
description: Grounded answers about this repository (no file changes)
---

# Ask

Answer questions about this codebase concretely, grounded in the actual files.
- Use the retrieved snippets and the repo map; cite real file paths.
- Answer directly. Do not describe what you WOULD look at — you already have it.
- If something is not in the provided context, say so briefly rather than guessing.
- Never change files in Ask mode.
`

var buildDoctorSkill = `---
name: build-doctor
description: Diagnose container/terminal issues and propose one safe fix
---

# Build Doctor

Read the container and terminal logs and decide whether there is a GENUINE blocker
(failed build, crash, missing dependency, wrong port, syntax error) or just NOISE
(deprecation warnings, npm audit notices, a slow-but-successful install).

- If it is noise or the app actually started, say so — do not invent a fix.
- For a real blocker, propose the SMALLEST safe fix: one shell command, or one file
  edit. Never rewrite lockfiles, never run npm audit fix --force, never delete files.
`

var complianceRulesTemplate = `---
name: compliance
description: Guardrails enforced on every edit (deny wins)
---

# Compliance

These rules are enforced by the Guardrails layer before any edit is applied. The
hard checks (secret detection, protected paths) run in code and always win — this
file documents them and may add more "never" rules.

## Never edit
- .env and any .env.* file
- package-lock.json, yarn.lock, pnpm-lock.yaml, any *.lock file
- anything under .git/

## Never introduce
- API keys, tokens, or private keys committed into source
- Credentials of any kind in plain text
`

var toolsReadmeTemplate = `# Tools

Capabilities the chat agent uses while working in this repo. Declared here so the
agent (and you) can see what it can do; the implementations live in the platform.

- search_code — ripgrep-style search over the repo; returns file:line snippets.
- read_file / write_file — read and whole-file overwrite inside the workspace.
- terminal — run a shell command in the sandbox container.
- diagnose — read container logs and classify errors vs. noise (build doctor).
`

var hooksReadmeTemplate = `# Hooks

Lifecycle points in a sandbox session.

- on-clone — scaffold this .gitagent spec and index the repo map.
- pre-edit — Guardrails check scope and protected paths before an edit is applied.
- post-edit — save the file and reload the live preview.
- on-stuck — if the app is slow to boot, the build doctor runs automatically.
`

var workflowsReadmeTemplate = `# Workflows

The squads a request flows through. Named layers so the engine decides HOW to
code, not just what to answer.

- edit — Orchestrator -> Complexity Classifier (jnr / snr / architect) -> Guardrails
  -> Developer -> Guardrails(apply). The Developer persona comes from skills/.
- ask — retrieve (repo map + search_code) -> grounded answer, toolless.
- doctor — collect logs -> classify -> propose one safe fix (command or edit).
`

// MEMORY.md — the durable facts the agent reads before changing anything. Jr
// Architect seeds the basics at clone time from the detected stack + a real entry
// file; the agent (and the developer) append what they learn under Notes.
var memoryMDTemplate = `# Memory — {{.ProjectName}} ({{.Stack}})

Durable facts about this repository. The coding agent reads this file before it
changes anything, so keep it short and true. Jr Architect generated the basics at
clone time; append what you learn under Notes.

## Stack
{{.Stack}}

## Layout
- UI entry point: {{detectEntry .WorkDir}}
- UI files usually live in: {{uiFilePaths .Stack}}
{{stackLayout .Stack}}

## Conventions
{{stackConventions .Stack}}

## Notes
<!-- The agent appends facts it learns here over time. One short, true line each. -->
`

func stackLayout(stack string) string {
	layout := map[string]string{
		"react":  "- Components in src/components — reuse existing ones before adding new\n- Generated UI primitives (src/components/ui/*) are library code — do not edit",
		"nextjs": "- Routes in app/ (app router) or pages/ — check both\n- Generated UI primitives (components/ui/*) are library code — do not edit\n- API routes must not expose secrets",
		"node":   "- Entry is typically server.js or index.js\n- Keep Express middleware order intact",
		"python": "- Entry is typically app.py, main.py, or manage.py\n- Templates in templates/, static assets in static/",
		"go":     "- Entry is the package main func in main.go\n- Multiple .go files compile together (build with `go build .`)",
		"static": "- Plain HTML/CSS/JS — no build step, changes show on save",
	}
	if l, ok := layout[stack]; ok {
		return l
	}
	return "- Follow the existing directory structure"
}

func stackConventions(stack string) string {
	conv := map[string]string{
		"react":  "- Prefer existing CSS variables / Tailwind classes over new styles\n- Match the existing component and prop naming",
		"nextjs": "- Tailwind utility classes; shared vars in app/globals.css\n- Respect the @/ path alias if configured",
		"node":   "- Keep the existing module system (CommonJS vs ESM)\n- Preserve error-handling and logging patterns",
		"python": "- Keep imports sorted; follow PEP 8 spacing\n- Never install packages globally — respect the virtual env",
		"go":     "- Run gofmt conventions (tabs, grouped imports)\n- Keep package names consistent",
		"static": "- Keep markup semantic; reuse existing classes",
	}
	if c, ok := conv[stack]; ok {
		return c
	}
	return "- Preserve the existing code style and formatting"
}

// detectEntry returns the first common UI/entry file that actually exists in the
// cloned repo, so MEMORY.md points the agent at a real file instead of a guess.
func detectEntry(workdir string) string {
	candidates := []string{
		"app/page.tsx", "app/page.jsx", "app/page.js", "src/app/page.tsx",
		"pages/index.tsx", "pages/index.jsx", "pages/index.js",
		"src/App.tsx", "src/App.jsx", "src/App.js", "src/App.vue", "src/App.svelte",
		"src/main.tsx", "src/main.jsx", "src/main.js",
		"index.html", "main.py", "app.py", "server.js", "index.js", "main.go",
	}
	for _, c := range candidates {
		if _, err := os.Stat(filepath.Join(workdir, c)); err == nil {
			return c
		}
	}
	return "(not detected — set this to the file the app renders from)"
}

// maxInjectedDocBytes caps repo-root docs that gitclaw would splice verbatim into
// the agent's system prompt. AI-generated app repos (e.g. Lyzr) ship a very large
// AGENTS.md — 30k+ tokens — which alone busts a free-tier budget (Groq free tier
// is 12k tokens/min), so the very first agent request 413s before it can answer.
const maxInjectedDocBytes = 8000

func GenerateAgentSpec(workdir string, stack string) error {
	projectName := filepath.Base(workdir)
	projectName = strings.ReplaceAll(projectName, " ", "-")

	// gitclaw injects repo-root AGENTS.md / DUTIES.md straight into the system
	// prompt. Move oversized ones aside (kept as *.sandbox-bak — nothing is
	// deleted) so the agent prompt stays small; our generated SOUL.md/RULES.md
	// already give the agent its guidance.
	for _, name := range []string{"AGENTS.md", "DUTIES.md"} {
		p := filepath.Join(workdir, name)
		if info, err := os.Stat(p); err == nil && !info.IsDir() && info.Size() > maxInjectedDocBytes {
			bak := p + ".sandbox-bak"
			_ = os.Remove(bak) // tolerate a re-run
			if err := os.Rename(p, bak); err == nil {
				fmt.Printf("[gitagent] moved large %s (%d bytes) aside to keep the agent prompt within the model token budget\n", name, info.Size())
			}
		}
	}

	spec := AgentSpec{
		Stack:       stack,
		ProjectName: projectName,
		WorkDir:     workdir,
	}

	funcMap := template.FuncMap{
		"stackRules":       stackRules,
		"uiFilePaths":      uiFilePaths,
		"stackLayout":      stackLayout,
		"stackConventions": stackConventions,
		"detectEntry":      detectEntry,
	}

	// The repo's own agent spec lives under .gitagent/ so it shows up as one clear
	// folder in the IDE explorer (next to pipeline.json and any installed registry
	// agents) instead of scattering SOUL.md/RULES.md/etc. loose among the repo's
	// own files. The Node edit pipeline reads it from here (registry.js
	// loadRepoRootSpec looks in .gitagent/ first, then the repo root).
	specDir := filepath.Join(workdir, ".gitagent")
	if err := os.MkdirAll(specDir, 0755); err != nil {
		return fmt.Errorf("failed to create .gitagent dir: %w", err)
	}

	files := map[string]string{
		"agent.yaml": agentYAMLTemplate,
		"SOUL.md":    soulMDTemplate,
		"RULES.md":   rulesMDTemplate,
	}

	// MEMORY.md is the repo's living knowledge — seed it only if it doesn't
	// already exist, so a repo's own memory (or notes learned across turns)
	// is never clobbered on a re-clone.
	if _, err := os.Stat(filepath.Join(specDir, "MEMORY.md")); os.IsNotExist(err) {
		memTmpl, err := template.New("MEMORY.md").Funcs(funcMap).Parse(memoryMDTemplate)
		if err != nil {
			return fmt.Errorf("memory template parse error: %w", err)
		}
		var memBuf bytes.Buffer
		if err := memTmpl.Execute(&memBuf, spec); err != nil {
			return fmt.Errorf("memory template execute error: %w", err)
		}
		if err := os.WriteFile(filepath.Join(specDir, "MEMORY.md"), memBuf.Bytes(), 0644); err != nil {
			return fmt.Errorf("write error for MEMORY.md: %w", err)
		}
	}

	for filename, tmplStr := range files {
		tmpl, err := template.New(filename).Funcs(funcMap).Parse(tmplStr)
		if err != nil {
			return fmt.Errorf("template parse error for %s: %w", filename, err)
		}

		var buf bytes.Buffer
		if err := tmpl.Execute(&buf, spec); err != nil {
			return fmt.Errorf("template execute error for %s: %w", filename, err)
		}

		destPath := filepath.Join(specDir, filename)
		if err := os.WriteFile(destPath, buf.Bytes(), 0644); err != nil {
			return fmt.Errorf("write error for %s: %w", filename, err)
		}

		// The engine (gitclaw) treats the REPO ROOT as the agent home and hard-reads
		// its manifest from <root>/agent.yaml — it uses .gitagent/ for its own session
		// runtime, not for the manifest. So the grouped spec lives in .gitagent/ (what
		// the developer sees), but agent.yaml must ALSO exist at the root or every chat
		// turn throws ENOENT on load. SOUL/RULES/skills stay grouped: gitclaw reads
		// those optionally, and our edit pipeline injects them from .gitagent/ anyway.
		if filename == "agent.yaml" {
			if err := os.WriteFile(filepath.Join(workdir, "agent.yaml"), buf.Bytes(), 0644); err != nil {
				return fmt.Errorf("write error for root agent.yaml: %w", err)
			}
		}
	}

	// Write .gitagent/skills/ui-editor/SKILL.md
	skillDir := filepath.Join(specDir, "skills", "ui-editor")
	if err := os.MkdirAll(skillDir, 0755); err != nil {
		return fmt.Errorf("failed to create skills dir: %w", err)
	}

	skillTmpl, err := template.New("skill").Funcs(funcMap).Parse(skillMDTemplate)
	if err != nil {
		return fmt.Errorf("skill template parse error: %w", err)
	}

	var skillBuf bytes.Buffer
	if err := skillTmpl.Execute(&skillBuf, spec); err != nil {
		return fmt.Errorf("skill template execute error: %w", err)
	}

	skillPath := filepath.Join(skillDir, "SKILL.md")
	if err := os.WriteFile(skillPath, skillBuf.Bytes(), 0644); err != nil {
		return fmt.Errorf("write error for SKILL.md: %w", err)
	}

	// The rest of the GitAgent standard layout: the built-in persona skills (the
	// platform's own agents), plus compliance / tools / hooks / workflows. Each is
	// seeded only if absent, so a repo that commits its own customized .gitagent
	// spec (source of truth, versioned in git) is never clobbered on a re-clone.
	standardFiles := map[string]string{
		"skills/jnr-developer/SKILL.md": jnrDeveloperSkill,
		"skills/snr-developer/SKILL.md": snrDeveloperSkill,
		"skills/architect/SKILL.md":     architectSkill,
		"skills/ask/SKILL.md":           askSkill,
		"skills/build-doctor/SKILL.md":  buildDoctorSkill,
		"compliance/RULES.md":           complianceRulesTemplate,
		"tools/README.md":               toolsReadmeTemplate,
		"hooks/README.md":               hooksReadmeTemplate,
		"workflows/README.md":           workflowsReadmeTemplate,
	}
	for rel, tmplStr := range standardFiles {
		dest := filepath.Join(specDir, filepath.FromSlash(rel))
		if _, err := os.Stat(dest); err == nil {
			continue // keep a repo's committed customization
		}
		if err := os.MkdirAll(filepath.Dir(dest), 0755); err != nil {
			return fmt.Errorf("failed to create dir for %s: %w", rel, err)
		}
		tmpl, err := template.New(rel).Funcs(funcMap).Parse(tmplStr)
		if err != nil {
			return fmt.Errorf("template parse error for %s: %w", rel, err)
		}
		var buf bytes.Buffer
		if err := tmpl.Execute(&buf, spec); err != nil {
			return fmt.Errorf("template execute error for %s: %w", rel, err)
		}
		if err := os.WriteFile(dest, buf.Bytes(), 0644); err != nil {
			return fmt.Errorf("write error for %s: %w", rel, err)
		}
	}

	fmt.Printf("[gitagent] spec generated for %s (stack: %s)\n", projectName, stack)
	return nil
}

// RegisterWithAgentService tells the Node agent service about the new sandbox
// Call this after GenerateAgentSpec succeeds
func RegisterWithAgentService(container string, workdir string, stack string) error {
	payload := map[string]string{
		"container": container,
		"workdir":   workdir,
		"stack":     stack,
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return err
	}

	resp, err := http.Post(
		"http://127.0.0.1:8001/agent/register",
		"application/json",
		bytes.NewReader(body),
	)
	if err != nil {
		return fmt.Errorf("agent service not reachable: %w", err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		return fmt.Errorf("agent service returned %d", resp.StatusCode)
	}

	fmt.Printf("[gitagent] registered container=%s with agent service\n", container)
	return nil
}
