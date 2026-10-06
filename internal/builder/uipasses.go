package builder

import (
	"encoding/json"
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
)

// One screen of a generated app: the shell renders one view at a time and each is written in its own model call.
type viewSpec struct {
	Slug, Route, Name, Desc string
}

const maxViews = 7

var nonSlug = regexp.MustCompile(`[^a-z0-9]+`)

func viewsOf(prd *PRD) []viewSpec {
	views := []viewSpec{{Slug: "home", Route: "/", Name: "Home"}}
	for _, rt := range parsePRDRoutes(prd) {
		name, desc, _ := strings.Cut(rt.name, ":")
		v := viewSpec{Route: rt.route, Name: strings.TrimSpace(name), Desc: strings.TrimSpace(desc)}
		if rt.route == "/" {
			if v.Name != "" {
				views[0].Name = v.Name
			}
			views[0].Desc = v.Desc
			continue
		}
		v.Slug = strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(strings.Trim(rt.route, "/")), "-"), "-")
		if v.Slug == "" || v.Slug == "home" || len(views) == maxViews {
			continue
		}
		if v.Name == "" {
			v.Name = v.Slug
		}
		views = append(views, v)
	}
	return views
}

func (v viewSpec) component() string {
	var b strings.Builder
	for _, part := range strings.Split(v.Slug, "-") {
		if part != "" {
			b.WriteString(strings.ToUpper(part[:1]) + part[1:])
		}
	}
	if b.Len() == 0 || b.String()[0] >= '0' && b.String()[0] <= '9' {
		return "Page" + b.String() + "View"
	}
	return b.String() + "View"
}

func (v viewSpec) file(react bool) string {
	if react {
		return "src/components/app/" + v.component() + ".jsx"
	}
	return "public/view-" + v.Slug + ".js"
}

func (v viewSpec) line(react bool) string {
	what := fmt.Sprintf("%q %s", v.Route, v.Name)
	if v.Desc != "" {
		what += ": " + v.Desc
	}
	if react {
		return fmt.Sprintf("- %s: export function %s({ go }), view %q, %s", v.file(true), v.component(), v.Slug, what)
	}
	return fmt.Sprintf("- %s: App.view(%q, ...), %s", v.file(false), v.Slug, what)
}

// The features and edge cases that mention this view, so a page call carries its own brief instead of the whole PRD.
func viewBrief(prd *PRD, v viewSpec) string {
	words := []string{strings.ToLower(v.Name)}
	if v.Route != "/" {
		words = append(words, strings.ToLower(v.Route))
	}
	var feats []string
	for _, f := range prd.Features {
		lf := strings.ToLower(f)
		for _, w := range words {
			if w != "" && strings.Contains(lf, w) {
				feats = append(feats, f)
				break
			}
		}
	}
	brief := struct {
		App       string              `json:"app"`
		Vision    string              `json:"vision,omitempty"`
		UINote    string              `json:"ui_note,omitempty"`
		DataModel map[string][]string `json:"data_model,omitempty"`
		Features  []string            `json:"features_on_this_page,omitempty"`
		EdgeCases []string            `json:"edge_cases,omitempty"`
	}{prd.Name, prd.Vision, prd.UINote, prd.DataModel, feats, prd.EdgeCases}
	data, _ := json.Marshal(brief)
	return string(data)
}

func clip(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max] + "\n/* (truncated) */"
}

// Builds the UI in passes: the shell, shared data and home view first, then every other view in parallel.
func generateUIPasses(prd *PRD, flows []BuiltWorkflow, stack Stack, system string, log func(string)) ([]GeneratedFile, error) {
	react := stack.UI == "react"
	views := viewsOf(prd)
	spec, err := codePRDJSON(prd)
	if err != nil {
		return nil, err
	}
	var list []string
	for _, v := range views {
		list = append(list, v.line(react))
	}
	contract := uiWorkflowContract(stack, flows)
	brief := designBrief(prd.Design)
	nav := "top"
	if prd.Design != nil {
		nav = prd.Design.Navigation
	}
	if nav == "none" && len(views) > 1 {
		nav = "top"
	}

	var first string
	if react {
		first = fmt.Sprintf(`PRD:
%s

The server is %s and already exists; you only write the UI.

APP STRUCTURE (follow exactly):
- src/lib/store.js already exists (never write it): import { useAppStore } from "@/lib/store.js"; const [state, update] = useAppStore(); update((s) => ({ ...s, items: [...] })) saves to localStorage and re-renders every view. Its starting state is the "seed" export of src/lib/data.js.
- src/lib/data.js: export const seed = { one key per collection the features need, each with 4-8 realistic items, plus settings }; also export constants.
- src/components/app/AppFrame.jsx already exists (never write it): it is the app's navigation and frame. src/App.jsx is only: const [view, setView] = useState("home"); return <AppFrame view={view} setView={setView}>{the current view, given go={setView}}</AppFrame>. Import every view exactly as listed, including the ones written later.
Views:
%s

Write ONLY these files now: src/lib/data.js, src/App.jsx, %s and the src/components/app/* components it uses. The other views are written next.%s`,
			spec, stack.Label, strings.Join(list, "\n"), views[0].file(true), screenPlan(prd, "/")+brief+contract)
	} else {
		scripts := []string{"ui.js"}
		if stack.AI {
			scripts = append(scripts, "jr-workflows.js")
		}
		scripts = append(scripts, "core.js", "app.js")
		for _, v := range views {
			scripts = append(scripts, "view-"+v.Slug+".js")
		}
		first = fmt.Sprintf(`PRD:
%s

The server is %s and already exists; you only write the UI.

APP STRUCTURE (follow exactly):
- core.js already exists (never write it). It defines window.App: App.state is the app's data, loaded from localStorage over window.SEED; App.update(fnOrPartial, quiet) saves it and re-renders the current view unless quiet is true; App.go("name") opens a view ("home" is the first); App.view(name, { title, render(el, App) }) registers a view that draws itself into el; App.on(event, fn) and App.emit(event, data) are a small event bus, and "change" fires after every update. Never define or replace App.seed, App.update, App.view, App.go or App.state, and never touch localStorage yourself.
- public/index.html: the shell. Head: viewport meta, link "ui.css" then "styles.css". Before </body> load these scripts in this order as plain <script src> tags: %s. Start from this body frame for the design direction's navigation (fill in the name and one link per view with href "#/name", data-view-link="name" and a different fitting icon; never hide the navigation on phones):
%s
- public/styles.css: small additions for this app only.
- public/app.js: window.SEED = { one key per collection the features need, each with 4-8 realistic items, plus settings } and shared helper functions. Every key a view reads must be in SEED.
Views:
%s

Write ONLY these files now: public/index.html, public/styles.css, public/app.js and %s. The other views are written next.%s`,
			spec, stack.Label, strings.Join(scripts, ", "), vanillaShell(nav), strings.Join(list, "\n"), views[0].file(false), screenPlan(prd, "/")+brief+contract)
	}
	log("Generating the app shell, shared data and the " + views[0].Name + " view...")
	files, err := generateFiles(system, first, "index.html", "App.jsx")
	if err != nil {
		return nil, err
	}
	shared := ""
	var done []string
	for _, f := range files {
		done = append(done, f.Path)
		if strings.HasSuffix(f.Path, "lib/data.js") || strings.HasSuffix(f.Path, "app.js") && !strings.HasSuffix(f.Path, "core.js") {
			shared += fmt.Sprintf("%s:\n%s\n", f.Path, clip(f.Content, 6000))
		}
	}

	results := make([][]GeneratedFile, len(views))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 3)
	for i, v := range views[1:] {
		wg.Add(1)
		go func(i int, v viewSpec) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			log("Generating the " + v.Name + " view...")
			msg := fmt.Sprintf(`App brief:
%s

Already written (use them, never rewrite them): %s

%s
Write ONLY this view now, plus any components it needs (name their files after the view):
%s
It is one screen of the app, rich and complete: every feature for this page working against the shared state, real empty states, and loading and error states for AI calls. It renders inside the shell already written, so match the home view's visual language.%s`,
				viewBrief(prd, v), strings.Join(done, ", "), shared, v.line(react), screenPlan(prd, v.Route)+brief+contract)
			out, err := generateFiles(system, msg, path.Base(v.file(react)))
			if err != nil {
				log("The " + v.Name + " view could not be generated (" + err.Error() + "); it gets a placeholder you can build in the IDE.")
				out = append(out, stubView(v, react))
			}
			results[i+1] = out
		}(i, v)
	}
	wg.Wait()
	if !hasFile(files, views[0].file(react)) {
		files = append(files, stubView(views[0], react))
	}
	for _, r := range results {
		files = append(files, r...)
	}
	return files, nil
}

// One retry when the call fails or the reply lacks the file the pass exists to write.
func generateFiles(system, msg string, want ...string) ([]GeneratedFile, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		raw, err := callGroq(system, msg, genChunkTokens())
		if err != nil {
			lastErr = err
			continue
		}
		files := parseGeneratedFiles(cleanJSONArray(raw))
		for _, f := range files {
			for _, w := range want {
				if path.Base(f.Path) == w {
					return files, nil
				}
			}
		}
		lastErr = fmt.Errorf("the reply did not include %s", strings.Join(want, " or "))
	}
	return nil, lastErr
}

func hasFile(files []GeneratedFile, p string) bool {
	for _, f := range files {
		if strings.TrimPrefix(path.Clean("/"+f.Path), "/") == p {
			return true
		}
	}
	return false
}

func stubView(v viewSpec, react bool) GeneratedFile {
	note := v.Name + " is not built yet. Open the IDE and ask the coding agent to build it."
	if react {
		return GeneratedFile{Path: v.file(true), Content: fmt.Sprintf("export function %s() {\n  return <div className=\"p-8 text-sm text-muted-foreground\">%s</div>;\n}\n", v.component(), note)}
	}
	return GeneratedFile{Path: v.file(false), Content: fmt.Sprintf("App.view(%q, {\n  title: %q,\n  render(el) {\n    el.innerHTML = '<div class=\"card\"><p class=\"muted\">' + %q + '</p></div>';\n  },\n});\n", v.Slug, v.Name, note)}
}

// The shared state every view reads and writes, written by the server so the model cannot break it.
func writeAppState(workdir string, stack Stack, prd *PRD) error {
	key := "jr-" + strings.Trim(nonSlug.ReplaceAllString(strings.ToLower(prd.Name), "-"), "-")
	var rel, body string
	if stack.UI == "react" {
		rel = "src/lib/store.js"
		body = fmt.Sprintf(`// Shared app state: one object saved to localStorage and shared by every view.
import { useSyncExternalStore } from "react";
import * as data from "./data.js";

const KEY = %q;
const seed = data.seed || {};
const listeners = new Set();
let state = load();

function load() {
  try {
    const saved = JSON.parse(localStorage.getItem(KEY));
    if (saved && typeof saved === "object") return { ...seed, ...saved };
  } catch {}
  return JSON.parse(JSON.stringify(seed));
}

export function getState() {
  return state;
}

export function update(change) {
  const next = typeof change === "function" ? change(state) : { ...state, ...change };
  if (!next || next === state) return;
  state = next;
  try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
  listeners.forEach((l) => l());
}

export function resetState() {
  update(JSON.parse(JSON.stringify(seed)));
}

export function useAppStore() {
  const s = useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, getState);
  return [s, update];
}
`, key)
	} else {
		rel = path.Join(stack.UIDir, "core.js")
		body = fmt.Sprintf(`// Shared app state and a hash router: app.js sets window.SEED and every view-*.js registers a view.
(function () {
  const KEY = %q;
  const views = {};
  const copy = (v) => JSON.parse(JSON.stringify(v || {}));
  let state = null;
  let handlers = {};
  let viewHandlers = {};
  let rendering = false;
  // The first read loads the saved data over window.SEED, so a key added to the seed later still appears.
  function load(initial) {
    const base = copy(initial || window.SEED);
    try {
      const saved = JSON.parse(localStorage.getItem(KEY));
      state = saved && typeof saved === "object" ? { ...base, ...saved } : base;
    } catch {
      state = base;
    }
  }
  const App = window.App || {};
  const api = {
    seed(initial) { load(initial); },
    update(change, quiet) {
      if (!state) load();
      const next = typeof change === "function" ? change(state) : { ...state, ...change };
      if (next && typeof next === "object") state = next;
      try { localStorage.setItem(KEY, JSON.stringify(state)); } catch {}
      api.emit("change", state);
      if (!quiet) api.render();
    },
    // Handlers added while a view renders last until the next render, so re-rendering never stacks them.
    on(event, fn) {
      const set = rendering ? viewHandlers : handlers;
      (set[event] = set[event] || []).push(fn);
    },
    emit(event, data) {
      [...(handlers[event] || []), ...(viewHandlers[event] || [])].forEach((fn) => {
        try { fn(data, App); } catch (e) { console.error(e); }
      });
    },
    reset() { localStorage.removeItem(KEY); load(); api.render(); },
    view(name, def) { views[name] = def; },
    current() { return location.hash.replace(/^#\/?/, "").split("?")[0] || "home"; },
    go(name) {
      const hash = name === "home" ? "#/" : "#/" + name;
      if (location.hash === hash) api.render(); else location.hash = hash;
    },
    render() {
      const el = document.getElementById("view");
      const name = views[api.current()] ? api.current() : "home";
      if (!el || !views[name]) return;
      el.innerHTML = "";
      viewHandlers = {};
      rendering = true;
      try {
        views[name].render(el, App);
      } catch (e) {
        console.error(e);
        el.innerHTML = '<div class="card"><p>This view hit an error: ' + String(e.message || e).replace(/[<>&]/g, "") + "</p></div>";
      } finally {
        rendering = false;
      }
      document.querySelectorAll("[data-view-link]").forEach((a) => {
        const on = a.dataset.viewLink === name;
        a.classList.toggle("active", on);
        if (on) a.setAttribute("aria-current", "page"); else a.removeAttribute("aria-current");
      });
      if (views[name].title) document.title = views[name].title;
    },
  };
  // Generated code may add helpers to App but cannot replace these.
  for (const [name, fn] of Object.entries(api)) Object.defineProperty(App, name, { value: fn, writable: false, enumerable: true });
  Object.defineProperty(App, "state", {
    get() { if (!state) load(); return state; },
    set(v) { if (v && typeof v === "object") state = v; },
    enumerable: true,
  });
  window.App = App;
  window.addEventListener("hashchange", () => api.render());
  document.addEventListener("DOMContentLoaded", () => api.render());
})();
`, key)
	}
	abs := filepath.Join(workdir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
		return err
	}
	return os.WriteFile(abs, []byte(body), 0644)
}

// The plain-HTML frame for each navigation style, using the kit's shell classes.
func vanillaShell(nav string) string {
	brand := `<div class="brand"><span class="brand-mark"><i data-icon="book"></i></span>App name</div><div class="spacer"></div>header buttons`
	switch nav {
	case "sidebar":
		return `  <div class="app">
    <header class="app-header"><div class="container">` + brand + `</div></header>
    <main class="app-main"><div class="container layout">
      <aside class="sidebar"><a class="nav-item" href="#/" data-view-link="home"><i data-icon="home"></i>Label</a> ...</aside>
      <div id="view"></div>
    </div></main>
  </div>`
	case "bottom":
		return `  <div class="app has-bottomnav">
    <header class="app-header"><div class="container">` + brand + `</div></header>
    <main class="app-main"><div class="container"><div id="view"></div></div></main>
    <nav class="bottomnav"><a href="#/" data-view-link="home"><i data-icon="home"></i><span>Label</span></a> ...</nav>
  </div>`
	case "none":
		return `  <div class="app">
    <header class="app-header"><div class="container">` + brand + `</div></header>
    <main class="app-main"><div class="container"><div id="view"></div></div></main>
  </div>`
	}
	return `  <div class="app">
    <header class="app-header">
      <div class="container">` + brand + `</div>
      <div class="container"><nav class="topnav"><a href="#/" data-view-link="home"><i data-icon="home"></i>Label</a> ...</nav></div>
    </header>
    <main class="app-main"><div class="container"><div id="view"></div></div></main>
  </div>`
}
