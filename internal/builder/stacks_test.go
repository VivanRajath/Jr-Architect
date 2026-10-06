package builder

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sandbox/internal/detect"
)

// Each template must be recognised by the same scanner that runs cloned repos, on the port its server actually listens on.
func TestEveryStackTemplateIsDetected(t *testing.T) {
	want := map[string]struct {
		stack string
		port  int
	}{
		"vite-react": {"react", 5173}, "express": {"node", 3000}, "bun": {"bun", 3000}, "deno": {"deno", 8000},
		"django": {"django", 8000}, "fastapi": {"python", 8000}, "flask": {"python", 5000}, "go": {"go", 8080},
		"rust": {"rust", 8080}, "java": {"java", 8080}, "dotnet": {"dotnet", 5000}, "php": {"php", 8080},
		"ruby": {"ruby", 9292}, "static": {"static", 8080},
	}
	for _, s := range Stacks {
		if s.ID == "nextjs" {
			continue
		}
		w, ok := want[s.ID]
		if !ok {
			t.Errorf("no expectation for stack %s", s.ID)
			continue
		}
		t.Run(s.ID, func(t *testing.T) {
			dir := t.TempDir()
			if err := Materialise(dir, s.Template); err != nil {
				t.Fatal(err)
			}
			plan, err := detect.Scan(dir)
			if err != nil {
				t.Fatalf("not detected: %v", err)
			}
			svc, ok := plan.Primary()
			if !ok {
				t.Fatal("no primary service")
			}
			if svc.Stack != w.stack || svc.ContainerPort != w.port {
				t.Fatalf("detected %s on %d (start %q), want %s on %d", svc.Stack, svc.ContainerPort, svc.Start, w.stack, w.port)
			}
		})
	}
}

func TestGoTemplateLosesItsSuffix(t *testing.T) {
	dir := t.TempDir()
	if err := Materialise(dir, "go"); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"go.mod", "main.go"} {
		if _, err := os.Stat(filepath.Join(dir, f)); err != nil {
			t.Errorf("%s missing after materialise", f)
		}
	}
}

func TestDetectStack(t *testing.T) {
	cases := map[string][2]string{
		"i want to build a mail writing app in next js": {"nextjs", "JavaScript"},
		"A todo app with React":                         {"vite-react", "JavaScript"},
		"recipe box using Flask":                        {"flask", "Python"},
		"an API dashboard in FastAPI":                   {"fastapi", "Python"},
		"inventory tracker in Go":                       {"go", "Go"},
		"a habit tracker":                               {"", ""},
		"a python app that summarises PDFs":             {"", "Python"},
		"notes app in javascript":                       {"", "JavaScript"},
		"a C# app for invoices":                         {"dotnet", "C#"},
		"build it with Spring Boot":                     {"java", "Java"},
		"a plain html page that converts units":         {"static", "HTML"},
		"let's go build a recipe app":                   {"", ""},
	}
	for prompt, want := range cases {
		stack, lang := DetectStack(prompt)
		if stack != want[0] || lang != want[1] {
			t.Errorf("%q: got (%q, %q), want (%q, %q)", prompt, stack, lang, want[0], want[1])
		}
	}
}

func TestStackQuestionAndAnswer(t *testing.T) {
	all := stackQuestion("")
	if all.ID != "tech_stack" || len(all.Options) != len(Stacks) {
		t.Fatalf("stack question has %d options, want %d", len(all.Options), len(Stacks))
	}
	py := stackQuestion("Python")
	if len(py.Options) != 3 || !strings.Contains(py.Text, "Python") {
		t.Fatalf("python question: %+v", py)
	}
	if stackFromAnswer("Python + Flask") != "flask" || stackFromAnswer("go") != "go" || stackFromAnswer("something else") != "nextjs" {
		t.Error("stack answers do not map back to ids")
	}
}

func TestUIPathKeepsGeneratedFilesInTheUIFolder(t *testing.T) {
	flask, _ := StackByID("flask")
	php, _ := StackByID("php")
	vite, _ := StackByID("vite-react")
	cases := []struct {
		stack Stack
		in    string
		out   string
		ok    bool
	}{
		{flask, "public/index.html", "public/index.html", true},
		{flask, "public/app.js", "public/app.js", true},
		{flask, "app.py", "", false},
		{flask, "public/jr-workflows.js", "", false},
		{flask, "public/../app.py", "", false},
		{flask, "public/js/app.js", "", false},
		{php, "public/index.html", "index.html", true},
		{php, "api.php", "", false},
		{vite, "src/App.jsx", "src/App.jsx", true},
		{vite, "src/components/List.jsx", "", false},
		{vite, "src/components/app/List.jsx", "src/components/app/List.jsx", true},
		{vite, "src/components/ui/button.tsx", "", false},
		{vite, "src/index.css", "", false},
		{vite, "src/lib/data.js", "src/lib/data.js", true},
		{flask, "public/ui.css", "", false},
		{flask, "public/ui.js", "", false},
		{vite, "src/workflows.js", "", false},
		{vite, "src/main.jsx", "", false},
		{vite, "vite.config.js", "", false},
	}
	for _, c := range cases {
		got, ok := uiPath(c.stack, c.in)
		if got != c.out || ok != c.ok {
			t.Errorf("%s %q: got (%q, %v), want (%q, %v)", c.stack.ID, c.in, got, ok, c.out, c.ok)
		}
	}
}

func TestStackWorkflowClient(t *testing.T) {
	f := sampleFlow()
	for _, id := range []string{"flask", "php", "vite-react"} {
		s, _ := StackByID(id)
		dir := t.TempDir()
		if err := writeStackWorkflowClient(dir, s, []BuiltWorkflow{f}); err != nil {
			t.Fatal(err)
		}
		var cfg struct {
			Base      string
			Workflows map[string]struct{ ID, Token string }
		}
		data, _ := os.ReadFile(filepath.Join(dir, "jr-workflows.json"))
		if err := json.Unmarshal(data, &cfg); err != nil || cfg.Workflows[f.Key].Token != f.Token || cfg.Base == "" {
			t.Fatalf("%s: jr-workflows.json wrong: %s", id, data)
		}
		client := map[string]string{"flask": "public/jr-workflows.js", "php": "jr-workflows.js", "vite-react": "src/workflows.js"}[id]
		js, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(client)))
		if err != nil {
			t.Fatalf("%s: no client at %s", id, client)
		}
		if strings.Contains(string(js), f.Token) {
			t.Fatalf("%s: the token leaked into the browser client", id)
		}
		if !strings.Contains(string(js), s.APIPath) {
			t.Fatalf("%s: client does not call %s", id, s.APIPath)
		}
	}
}

func TestFillStackWritesOnlyTheUIAndStaysRunnable(t *testing.T) {
	defer func(f func(*PRD, []BuiltWorkflow, Stack, func(string)) ([]GeneratedFile, error)) { generateUIFn = f }(generateUIFn)
	generateUIFn = func(*PRD, []BuiltWorkflow, Stack, func(string)) ([]GeneratedFile, error) {
		return []GeneratedFile{
			{Path: "public/index.html", Content: "<h1>Inbox</h1>"},
			{Path: "public/app.js", Content: "window.runWorkflow('summarize_note', {note: 'x'})"},
			{Path: "app.py", Content: "print('hijacked')"},
			{Path: "public/jr-workflows.js", Content: "window.runWorkflow = () => 'fake'"},
		}, nil
	}
	flask, _ := StackByID("flask")
	dir := filepath.Join(t.TempDir(), "w")
	if err := fillStack("", dir, &PRD{Name: "Inbox"}, []BuiltWorkflow{sampleFlow()}, flask); err != nil {
		t.Fatal(err)
	}
	app, _ := os.ReadFile(filepath.Join(dir, "app.py"))
	if strings.Contains(string(app), "hijacked") {
		t.Fatal("generated code overwrote the server")
	}
	client, _ := os.ReadFile(filepath.Join(dir, "public", "jr-workflows.js"))
	if strings.Contains(string(client), "fake") {
		t.Fatal("generated code replaced the workflow client")
	}
	if _, err := os.Stat(filepath.Join(dir, "public", "styles.css")); err != nil {
		t.Fatal("missing styles.css was not stubbed")
	}
	if core, err := os.ReadFile(filepath.Join(dir, "public", "core.js")); err != nil || !strings.Contains(string(core), "window.App = App") || !strings.Contains(string(core), "jr-inbox") {
		t.Fatal("the shared app state was not written")
	}
	plan, err := detect.Scan(dir)
	if err != nil || plan.Services[0].Framework != "Flask" {
		t.Fatalf("filled project not runnable as Flask: %+v %v", plan, err)
	}
}

func TestDesignSystemIsInstalledPerStack(t *testing.T) {
	vite, _ := StackByID("vite-react")
	dir := t.TempDir()
	if err := Materialise(dir, vite.Template); err != nil {
		t.Fatal(err)
	}
	if err := installDesignSystem(dir, vite, &PRD{UINote: "Calm purple accents"}); err != nil {
		t.Fatal(err)
	}
	for _, f := range []string{"src/components/ui/button.tsx", "src/components/ui/dialog.tsx", "src/lib/utils.ts", "tailwind.config.ts"} {
		if _, err := os.Stat(filepath.Join(dir, filepath.FromSlash(f))); err != nil {
			t.Errorf("vite app is missing %s", f)
		}
	}
	css, _ := os.ReadFile(filepath.Join(dir, "src", "index.css"))
	if !strings.Contains(string(css), "--muted-foreground") || !strings.Contains(string(css), "262.1 83.3% 57.8%") {
		t.Error("vite theme is missing the shadcn tokens or the violet accent")
	}

	php, _ := StackByID("php")
	dir = t.TempDir()
	if err := installDesignSystem(dir, php, &PRD{UINote: "minimal and neutral"}); err != nil {
		t.Fatal(err)
	}
	kit, err := os.ReadFile(filepath.Join(dir, "ui.css"))
	if err != nil || !strings.Contains(string(kit), ".btn-outline") || strings.Contains(string(kit), "design direction") {
		t.Error("php kit missing, or a neutral note still got an accent")
	}
	if _, err := os.Stat(filepath.Join(dir, "ui.js")); err != nil {
		t.Error("php kit is missing ui.js")
	}
}

func TestThemeCSS(t *testing.T) {
	if themeCSS(&PRD{}) != "" || themeCSS(&PRD{UINote: "clean and minimal"}) != "" {
		t.Error("no colour words should keep the neutral theme")
	}
	if !strings.Contains(themeCSS(&PRD{UINote: "Ocean blue, calm"}), "221.2 83.2% 53.3%") || !strings.Contains(themeCSS(&PRD{UINote: "Warm orange tones"}), "24.6 95% 53.1%") {
		t.Error("colour words did not pick their shadcn theme")
	}
	cookbook := &PRD{UINote: "blue", Design: &DesignDirection{Navigation: "top", HeadingFont: "serif", Radius: "large",
		Light: &Palette{Background: "#fbf6ee", Foreground: "#2b2118", Card: "#ffffff", Muted: "#f1e8db", MutedForeground: "#7a6a58", Primary: "#c2410c", Accent: "#fde7d3", Border: "#e8dccb"}}}
	css := themeCSS(cookbook)
	if !strings.Contains(css, "--background: 36.9 61.9% 95.9%") || !strings.Contains(css, "Iowan Old Style") || !strings.Contains(css, "--radius: 1.25rem") || strings.Contains(css, "221.2 83.2%") {
		t.Fatalf("the design direction did not become the theme:\n%s", css)
	}
	if !strings.Contains(css, "--primary-foreground: 0.0 0.0% 100.0%") {
		t.Errorf("text on a dark orange primary should be white:\n%s", css)
	}
	unreadable := &PRD{UINote: "blue", Design: &DesignDirection{Light: &Palette{Background: "#ffffff", Foreground: "#eeeeee", Card: "#ffffff", Muted: "#fafafa", MutedForeground: "#dddddd", Primary: "#2563eb", Accent: "#dbeafe", Border: "#e5e7eb"}}}
	if css := themeCSS(unreadable); !strings.Contains(css, "221.2 83.2% 53.3%") {
		t.Errorf("an unreadable palette should fall back to the accent theme:\n%s", css)
	}
}

func TestPromptsCarryTheDesignSystem(t *testing.T) {
	flask, _ := StackByID("flask")
	static, _ := StackByID("static")
	if p := vanillaUISystem(flask); !strings.Contains(p, "jr-workflows.js") || !strings.Contains(p, "data-icon") || !strings.Contains(p, "375px") {
		t.Error("plain-HTML prompt lacks the kit, the workflow client or the responsive rule")
	}
	if strings.Contains(vanillaUISystem(static), "jr-workflows.js") {
		t.Error("static sites have no workflow client to load")
	}
	if !strings.Contains(reactUISystem, "@/components/ui/tabs") || !strings.Contains(groqCodeGenSystemPrompt, "@/components/ui/dialog") {
		t.Error("React prompts do not list the shadcn components")
	}
	if strings.Contains(groqCodeGenSystemPrompt, "--brand-600") {
		t.Error("the Next.js prompt still steers towards the old brand palette")
	}
}
