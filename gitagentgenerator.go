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
  preferred: "anthropic:claude-sonnet-4-6"
  fallback: ["openai:gpt-4o"]
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

func GenerateAgentSpec(workdir string, stack string) error {
	projectName := filepath.Base(workdir)
	projectName = strings.ReplaceAll(projectName, " ", "-")

	spec := AgentSpec{
		Stack:       stack,
		ProjectName: projectName,
		WorkDir:     workdir,
	}

	funcMap := template.FuncMap{
		"stackRules":  stackRules,
		"uiFilePaths": uiFilePaths,
	}

	files := map[string]string{
		"agent.yaml": agentYAMLTemplate,
		"SOUL.md":    soulMDTemplate,
		"RULES.md":   rulesMDTemplate,
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

		destPath := filepath.Join(workdir, filename)
		if err := os.WriteFile(destPath, buf.Bytes(), 0644); err != nil {
			return fmt.Errorf("write error for %s: %w", filename, err)
		}
	}

	// Write skills/ui-editor/SKILL.md
	skillDir := filepath.Join(workdir, "skills", "ui-editor")
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