package builder

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"
	"time"

	"sandbox/internal/core"
)

// Set by the server package: starts a sandbox whose workdir fill populates, then scans and launches it like any repo.
var Launch func(owner, label string, fill func(container, workdir string) error) (string, error)

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

// Builds a non-Next.js stack: the template is copied and the UI generated inside the sandbox's own fill step, so the IDE, logs and status work as for any repo.
func scaffoldStack(w http.ResponseWriter, r *http.Request, prd *PRD, flows []BuiltWorkflow, stack Stack) {
	if !stack.AI && len(flows) > 0 {
		core.JSONError(w, stack.Label+" has no server to hold workflow tokens; pick another stack for an app with AI", 400)
		return
	}
	if Launch == nil {
		core.JSONError(w, "the sandbox launcher is not available", 500)
		return
	}
	owner := core.UserOf(r)
	buildID := fmt.Sprintf("build-%d", time.Now().UnixMilli())
	container, err := Launch(owner, "generated:"+prd.Name, func(container, workdir string) error {
		err := fillStack(container, workdir, prd, flows, stack)
		if err == nil && OnReady != nil {
			go OnReady(owner, container, buildID, prd, flows)
		}
		return err
	})
	if err != nil {
		code := 400
		if core.IsCapacityError(err) {
			code = 429
		}
		core.JSONError(w, err.Error(), code)
		return
	}
	addBuildRecord(BuildRecord{ID: buildID, AppName: prd.Name, PRD: prd, Container: container, Status: "ready", CreatedAt: time.Now(), Owner: owner, Flows: flows})
	writeJSON(w, map[string]any{"status": "scaffolding", "container": container, "build_id": buildID, "stack": stack.ID})
}

func fillStack(container, workdir string, prd *PRD, flows []BuiltWorkflow, stack Stack) error {
	core.AddLog(container, fmt.Sprintf("Copying the %s template...", stack.Label))
	if err := Materialise(workdir, stack.Template); err != nil {
		return err
	}
	if err := installDesignSystem(workdir, stack, prd); err != nil {
		return fmt.Errorf("installing the UI kit failed: %w", err)
	}
	if stack.AI {
		if err := writeStackWorkflowClient(workdir, stack, flows); err != nil {
			return fmt.Errorf("writing the workflow client failed: %w", err)
		}
		if len(flows) > 0 {
			core.AddLog(container, fmt.Sprintf("Connected %d Agent Hub workflow(s) through %s.", len(flows), strings.TrimSuffix(stack.APIPath, "/")))
		}
	}

	if err := writeAppState(workdir, stack, prd); err != nil {
		return fmt.Errorf("writing the app state failed: %w", err)
	}
	if stack.UI == "react" {
		if err := writeReactFrame(workdir, prd); err != nil {
			return fmt.Errorf("writing the app frame failed: %w", err)
		}
	}
	files, err := generateUIFn(prd, flows, stack, func(msg string) { core.AddLog(container, msg) })
	if err != nil {
		core.AddLog(container, "UI generation failed, keeping the template page: "+err.Error())
	}
	write := func(f GeneratedFile) (string, bool) {
		rel, ok := uiPath(stack, f.Path)
		if !ok {
			core.AddLog(container, "Skipping disallowed path: "+f.Path)
			return "", false
		}
		abs := filepath.Join(workdir, filepath.FromSlash(rel))
		content := f.Content
		if path.Ext(rel) == ".jsx" {
			var fixed []string
			if content, fixed = fixIconImports(content); len(fixed) > 0 {
				core.AddLog(container, "Replaced icons lucide-react does not have in "+rel+": "+strings.Join(fixed, ", "))
			}
		}
		if os.MkdirAll(filepath.Dir(abs), 0755) != nil || os.WriteFile(abs, []byte(content), 0644) != nil {
			return "", false
		}
		core.AddLog(container, "Wrote: "+rel)
		return rel, true
	}
	var written []string
	for _, f := range files {
		if rel, ok := write(f); ok {
			written = append(written, rel)
		}
	}
	if len(written) > 0 {
		system := vanillaUISystem(stack)
		var rules *importRules
		if stack.UI == "react" {
			system = reactUISystem
			rules = &importRules{aliasRoot: "src/", packages: reactPackages}
		}
		written = checkAndRepair(container, workdir, system, written, stack.UI == "react", rules, write)
		shimMissingUI(container, workdir, written, rules)
	}
	ensureUIFiles(workdir, stack)
	core.AddLog(container, "Starting the app: detecting how to run it...")
	return nil
}

// Generated files may only land in the stack's UI folder, never on the server code, the design system or the workflow client.
func uiPath(stack Stack, p string) (string, bool) {
	p = path.Clean(strings.TrimPrefix(strings.ReplaceAll(p, "\\", "/"), "/"))
	if p == "." || strings.HasPrefix(p, "../") || strings.Contains(p, "/../") {
		return "", false
	}
	// The model is always told to write under public/ (or src/); PHP and static sites serve from the project root.
	if stack.UI == "vanilla" {
		p = strings.TrimPrefix(p, "public/")
		if strings.Contains(p, "/") || !strings.HasSuffix(p, ".html") && !strings.HasSuffix(p, ".css") && !strings.HasSuffix(p, ".js") {
			return "", false
		}
		if p == "jr-workflows.js" || p == "ui.css" || p == "ui.js" || p == "core.js" {
			return "", false
		}
		if stack.UIDir == "" {
			return p, true
		}
		return stack.UIDir + "/" + p, true
	}
	switch {
	case p == "src/App.jsx", p == "src/lib/data.js":
		return p, true
	case strings.HasPrefix(p, "src/components/app/") && path.Ext(p) == ".jsx" && !strings.Contains(strings.TrimPrefix(p, "src/components/app/"), "/") && p != "src/components/app/AppFrame.jsx":
		return p, true
	}
	return "", false
}

// The template page links these, so a reply that skipped one still leaves a page that loads.
func ensureUIFiles(workdir string, stack Stack) {
	if stack.UI != "vanilla" {
		return
	}
	for _, name := range []string{"app.js", "styles.css"} {
		p := filepath.Join(workdir, filepath.FromSlash(path.Join(stack.UIDir, name)))
		if _, err := os.Stat(p); os.IsNotExist(err) {
			os.WriteFile(p, []byte(""), 0644)
		}
	}
}

// jr-workflows.json holds the server's view (base URL and tokens); the browser only gets a runWorkflow function.
func writeStackWorkflowClient(workdir string, stack Stack, flows []BuiltWorkflow) error {
	type entry struct {
		ID    string `json:"id"`
		Token string `json:"token"`
		Name  string `json:"name"`
	}
	cfg := struct {
		Note      string           `json:"_note"`
		Base      string           `json:"base"`
		Workflows map[string]entry `json:"workflows"`
	}{
		Note:      "Generated by Jr Architect Build mode. Replace or revoke tokens in Agent Hub > Workflows > Webhook.",
		Base:      apiBaseForContainers(),
		Workflows: map[string]entry{},
	}
	meta := map[string]any{}
	for _, f := range flows {
		cfg.Workflows[f.Key] = entry{ID: f.ID, Token: f.Token, Name: f.Name}
		meta[f.Key] = map[string]any{"name": f.Name, "description": f.Description, "input": tsShape(f.Input), "output": typedShape(f.Output, f.OutputTypes)}
	}
	data, _ := json.MarshalIndent(cfg, "", "  ")
	if err := os.WriteFile(filepath.Join(workdir, "jr-workflows.json"), data, 0644); err != nil {
		return err
	}
	metaJSON, _ := json.Marshal(meta)
	call := fmt.Sprintf(`function runWorkflow(key, input) {
  // Identical calls already running share one request; a busy Agent Hub (429) is retried after a short wait.
  const inFlight = runWorkflow.inFlight || (runWorkflow.inFlight = new Map());
  const id = key + ':' + JSON.stringify(input || {});
  if (inFlight.has(id)) return inFlight.get(id);
  const call = (async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        const res = await fetch(%q + encodeURIComponent(key), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(input || {}),
        });
        if (res.status === 429 && attempt < 3) {
          await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
          continue;
        }
        const data = await res.json().catch(() => null);
        if (!data || !data.status) {
          console.error('[workflow] ' + key + ' failed:', (data && data.error) || 'HTTP ' + res.status);
          return { status: 'failed', output: {}, error: (data && data.error) || 'HTTP ' + res.status };
        }
        if (data.status === 'failed') console.error('[workflow] ' + key + ' failed:', data.error);
        return { ...data, output: data.output || {} };
      } catch {
        return { status: 'failed', output: {}, error: 'Could not reach the app server' };
      }
    }
  })().finally(() => inFlight.delete(id));
  inFlight.set(id, call);
  return call;
}`, stack.APIPath)
	header := "// Generated by Jr Architect Build mode: runWorkflow(key, input) calls this app's own server, which holds the workflow tokens.\n"
	asList := `function asList(value) {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(/\r?\n/).map((s) => s.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').trim()).filter(Boolean);
}`
	var rel, body string
	if stack.UI == "react" {
		rel = "src/workflows.js"
		body = header + "export const WORKFLOWS = " + string(metaJSON) + ";\n\n// A list field as an array, whether the agent sent an array or newline-separated text.\nexport " + asList + "\n\nexport " + call + "\n"
	} else {
		rel = path.Join(stack.UIDir, "jr-workflows.js")
		body = header + "window.JR_WORKFLOWS = " + string(metaJSON) + ";\n\n// A list field as an array, whether the agent sent an array or newline-separated text.\nwindow.asList = " + asList + ";\n\nwindow.runWorkflow = " + call + ";\n"
	}
	abs := filepath.Join(workdir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		return err
	}
	return os.WriteFile(abs, []byte(body), 0644)
}

// The plain-HTML brief; the script and stylesheet order matters because app.js uses window.ui and window.runWorkflow.
func vanillaUISystem(stack Stack) string {
	scripts := `"ui.js", then "jr-workflows.js", then "app.js"`
	if !stack.AI {
		scripts = `"ui.js", then "app.js"`
	}
	return `You write the browser UI of a web app in plain HTML, CSS and JavaScript (no frameworks, no build step, no npm packages, no CDNs, no external fonts).
Return ONLY a JSON array of {"path": "...", "content": "..."} objects, no prose and no code fences. The app is written over several requests and each one says which files to write:
- public/index.html: the UI shell with navigation and <main id="view">. In <head>: <meta name="viewport" content="width=device-width, initial-scale=1">, then link "ui.css" and then "styles.css". It loads ` + scripts + `, then core.js, app.js and the view files, as plain <script src> tags in that order.
- public/styles.css: only styles for classes you invent. Never restyle the kit's classes (.app, .app-header, .layout, .sidebar, .nav-item, .card, .btn, .input and the rest) and never hard-code colours; use the kit tokens such as hsl(var(--primary)), hsl(var(--muted-foreground)), hsl(var(--border)) and hsl(var(--card)).
- public/app.js: the starting data as window.SEED = {...} and shared helpers.
- public/view-<name>.js: one screen each, registered with App.view(name, { title, render(el, App) }); render builds the screen into el from App.state and wires every control.
Rules:
- The app IS the working tool. No landing page, no marketing copy, no "Get started" buttons.
- All data lives in App.state (core.js loads it from localStorage over window.SEED) and changes only through App.update, which saves it. update re-renders the view, so while the user types keep the draft in a variable and update on submit, or pass true as the second argument.
- Use relative URLs only. Never call fetch yourself.
- Escape user text before putting it in innerHTML (or use textContent).` + designRules + kitReference
}

var reactUISystem = `You write the UI of a React 18 app that runs under Vite with Tailwind CSS and shadcn/ui. JavaScript with JSX, function components and hooks, no TypeScript.
Return ONLY a JSON array of {"path": "...", "content": "..."} objects, no prose and no code fences. Write:
- src/App.jsx: export default function App. src/main.jsx already renders it, imports the theme CSS and mounts the Toaster; do not write main.jsx or any CSS file.
- src/components/app/*.jsx for the app's own components (one component per file, named exports).
- src/lib/data.js for seed data and constants.
Rules:
- Import only from "react", "lucide-react" and "@/..." paths (the @ alias points at src). No other packages, no CDNs.
- The page IS the working tool. No landing page, no marketing copy. Every control does something real.
- All data lives in the shared store: const [state, update] = useAppStore() from "@/lib/store.js" (already written; it saves to localStorage and starts from the "seed" export of src/lib/data.js). Never call localStorage yourself.
- Never call fetch yourself. Run AI workflows only from a user action (a button, a form submit, sending a message), never in useEffect or on every keystroke.` + designRules + blocksReference + shadcnReference("JSX", "@/")

// What the model may call for AI, in the shape of this stack's client.
func uiWorkflowContract(stack Stack, flows []BuiltWorkflow) string {
	if len(flows) == 0 {
		return "\n\nThis app has no AI workflows; do not fake AI features."
	}
	call := "window.runWorkflow"
	how := "jr-workflows.js (already written, do not generate it) defines window.runWorkflow and window.asList."
	if stack.UI == "react" {
		call = "runWorkflow"
		how = `src/workflows.js already exists (do not generate it): import { runWorkflow, asList } from "@/workflows.js".`
	}
	var lines []string
	for _, f := range flows {
		lines = append(lines, fmt.Sprintf(`- %s("%s", %s) resolves to { status, output: %s, error }. %s`, call, f.Key, tsShape(f.Input), typedShape(f.Output, f.OutputTypes), f.Description))
	}
	return "\n\nAI WORKFLOWS (the app's real AI features; never fake their results):\n" + how + "\n" + strings.Join(lines, "\n") +
		`
Call them from a click handler: show a loading state on the button (ui.busy in plain HTML, a spinner icon in React), await the call, then
if status is "completed" use the output fields and confirm with a toast; if "awaiting_approval" show "Waiting for approval in Agent Hub"; if "failed" show the error in a destructive toast.
Present AI output in its own card with a Sparkles icon and a Copy button where it makes sense.
Save useful results to localStorage with the rest of the data.
` + listRule
}

// The packages the Vite template installs; anything else would fail the build.
var reactPackages = map[string]bool{"react": true, "react-dom": true, "lucide-react": true, "clsx": true, "class-variance-authority": true, "tailwind-merge": true}

// Swapped in tests so the file handling can be checked without a model call.
var generateUIFn = generateUI

func generateUI(prd *PRD, flows []BuiltWorkflow, stack Stack, log func(string)) ([]GeneratedFile, error) {
	system := vanillaUISystem(stack)
	if stack.UI == "react" {
		system = reactUISystem
	}
	return generateUIPasses(prd, flows, stack, system, log)
}
