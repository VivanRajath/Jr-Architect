package builder

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCleanQuestionsKeepsDetailsAligned(t *testing.T) {
	qs := cleanQuestions([]Question{
		{ID: "tech_stack", Text: "Stack?"},
		{ID: "mode", Text: " How should it teach? ", Options: []string{"Roadmap", " ", "Projects"}, Details: []string{"A weekly plan", "skipped", "Build real apps"}, Recommended: []int{2, 0, 9}},
		{ID: "", Text: "Look?", Multi: true, Options: []string{"Calm", "Bold"}, Recommended: []int{0, 1}},
	})
	if len(qs) != 2 {
		t.Fatalf("got %d questions", len(qs))
	}
	if q := qs[0]; q.Text != "How should it teach?" || len(q.Options) != 2 || q.Details[1] != "Build real apps" || len(q.Recommended) != 1 || q.Recommended[0] != 1 {
		t.Fatalf("question not cleaned: %+v", q)
	}
	if q := qs[1]; q.ID == "" || len(q.Recommended) != 2 {
		t.Fatalf("multi question lost its picks: %+v", q)
	}
}

func TestDecisionsTextUsesQuestionWording(t *testing.T) {
	got := decisionsText([]Question{{ID: "mode", Text: "How should it teach?"}}, map[string]string{"mode": "Roadmap (a weekly plan)", "tech_stack": "Flask", "extra": "dark"})
	if !strings.Contains(got, "How should it teach?\n  Chosen: Roadmap (a weekly plan)") || strings.Contains(got, "Flask") || !strings.Contains(got, "extra: dark") {
		t.Fatalf("decisions text:\n%s", got)
	}
	if !strings.Contains(decisionsText(nil, nil), "strongest") {
		t.Error("no answers should let the model choose")
	}
}

func TestCodeViewLeavesAgentInternalsOut(t *testing.T) {
	raw := `{"name":"Tutor","features":["Learn"],"pages":["/ - Learn"],"edge_cases":["Empty code"],"ai":{"agents":[{"key":"grader","name":"Grader","instructions":"SECRET METHOD","input":{"code":"c"},"output":{"passed":{"type":"yes/no"}}}],"workflows":[{"key":"check","name":"Check answer","description":"Pass or a hint","agents":["grader"],"used_by":"Lesson page, Run","branch":{"field":"passed","op":"is_true","then":[],"else":["hinter"]}}]}}`
	var prd PRD
	if err := json.Unmarshal([]byte(raw), &prd); err != nil {
		t.Fatal(err)
	}
	if prd.AI.Workflows[0].Branch == nil || prd.AI.Workflows[0].Branch.Else[0] != "hinter" {
		t.Fatal("the branch did not survive the PRD round trip")
	}
	view, _ := codePRDJSON(&prd)
	if strings.Contains(view, "SECRET METHOD") || !strings.Contains(view, "Check answer: Pass or a hint (used by Lesson page, Run)") || !strings.Contains(view, "Empty code") {
		t.Fatalf("code view: %s", view)
	}
}

func TestTidyPlanMatchesHubLimits(t *testing.T) {
	ag := func(k string, out ...string) AIAgent {
		o := map[string]any{}
		for _, f := range out {
			o[f] = "x"
		}
		return AIAgent{Key: k, Output: o}
	}
	p := AIPlan{
		Agents: []AIAgent{ag("grader", "passed"), ag("coach", "hint"), ag("next", "lesson"), ag("unused", "y")},
		Workflows: []AIWorkflow{
			{Key: "check", Agents: []string{"grader", "ghost", "grader"}, Branch: &AIBranch{Field: "passed", Then: []string{"next", "grader"}, Else: []string{"next", "coach"}}},
			{Key: "bad_branch", Agents: []string{"coach"}, Branch: &AIBranch{Field: "missing", Then: []string{"next"}}},
			{Key: "check", Agents: []string{"next"}},
			{Key: "empty", Agents: []string{"ghost"}},
		},
	}
	tidyPlan(&p)
	if len(p.Workflows) != 2 || p.Workflows[1].Branch != nil {
		t.Fatalf("workflows %+v", p.Workflows)
	}
	b := p.Workflows[0].Branch
	if len(p.Workflows[0].Agents) != 1 || len(b.Then) != 1 || b.Then[0] != "next" || len(b.Else) != 1 || b.Else[0] != "coach" {
		t.Fatalf("branch %+v", b)
	}
	if len(p.Agents) != 3 {
		t.Fatalf("unused agents kept: %+v", p.Agents)
	}
}

func TestStaticRoute(t *testing.T) {
	for in, want := range map[string]string{"/task/:id": "/task", "/a/[slug]/edit": "/a/edit", "/": "/", "/x/": "/x", "/{id}": "/"} {
		if got := staticRoute(in); got != want {
			t.Errorf("%s: got %s, want %s", in, got, want)
		}
	}
}

func TestViewsOfPlansOneViewPerPage(t *testing.T) {
	prd := &PRD{Pages: []string{"/ - Sandbox: the editor", "/progress - Learning Roadmap: weekly plan", "/task/:id - Task Detail", "/2fa - Codes"}}
	views := viewsOf(prd)
	if len(views) != 4 || views[0].Slug != "home" || views[0].Name != "Sandbox" || views[1].Name != "Learning Roadmap" || views[1].Desc != "weekly plan" {
		t.Fatalf("views %+v", views)
	}
	if views[2].Slug != "task" || views[2].component() != "TaskView" || views[3].component() != "Page2faView" {
		t.Fatalf("names %+v %s %s", views[2], views[2].component(), views[3].component())
	}
	if views[1].file(true) != "src/components/app/ProgressView.jsx" || views[1].file(false) != "public/view-progress.js" {
		t.Fatal("view files")
	}
	stub := stubView(views[1], false)
	if !hasFile([]GeneratedFile{stub}, "public/view-progress.js") || !strings.Contains(stub.Content, `App.view("progress"`) {
		t.Fatalf("stub %+v", stub)
	}
	brief := viewBrief(&PRD{Name: "T", Features: []string{"On the Learning Roadmap page you see weeks", "On the Sandbox page you code"}}, views[1])
	if !strings.Contains(brief, "you see weeks") || strings.Contains(brief, "you code") {
		t.Fatalf("brief %s", brief)
	}
}

func TestFixIconImports(t *testing.T) {
	src := "import { Search, Spinner, Plus as Add, Trash3, Wizardry } from \"lucide-react\";\nimport { X } from 'lucide-react';\n"
	out, fixed := fixIconImports(src)
	if len(fixed) != 3 || !strings.Contains(out, "Loader2 as Spinner") || !strings.Contains(out, "Trash as Trash3") || !strings.Contains(out, "Circle as Wizardry") || !strings.Contains(out, "Plus as Add") {
		t.Fatalf("fixed %v:\n%s", fixed, out)
	}
	if !strings.Contains(out, "import { X } from 'lucide-react'") {
		t.Fatal("a valid import was rewritten")
	}
}

func TestPlanCritique(t *testing.T) {
	flat := AIPlan{Agents: []AIAgent{{Key: "a", Output: map[string]any{"x": ""}}}, Workflows: []AIWorkflow{{Key: "one", Agents: []string{"a"}}, {Key: "two", Agents: []string{"a"}}}}
	if c := planCritique(&flat); !strings.Contains(c, "no workflow branches") || !strings.Contains(c, "only 0 of 2") {
		t.Fatalf("critique %q", c)
	}
	rich := AIPlan{Workflows: []AIWorkflow{{Key: "one", Agents: []string{"a", "b"}, Branch: &AIBranch{Field: "x"}}, {Key: "two", Agents: []string{"a"}}}}
	if c := planCritique(&rich); c != "" || planStrength(&rich) <= planStrength(&flat) {
		t.Fatalf("a branching, chained plan was criticised: %q", c)
	}
	if !strings.Contains(planSummary(&flat), "workflow one: a") {
		t.Fatal(planSummary(&flat))
	}
}

func TestDataShape(t *testing.T) {
	src := "export interface Recipe {\n  id: string\n  minutes: number\n}\n\nexport const recipes: Recipe[] = [\n  { id: '1', minutes: 30 },\n]\nconst hidden = 1\nexport const defaultSettings = { units: 'metric' }\nexport type Unit = 'g' | 'oz'"
	got := dataShape(src)
	for _, want := range []string{"export interface Recipe {\n  id: string\n  minutes: number\n}", "export const recipes: Recipe[] = ...", "export const defaultSettings = ...", "export type Unit = ..."} {
		if !strings.Contains(got, want) {
			t.Fatalf("missing %q in:\n%s", want, got)
		}
	}
	if strings.Contains(got, "hidden") || strings.Contains(got, "'1'") {
		t.Fatalf("values leaked into the shape:\n%s", got)
	}
}

func TestPagesExportOnlyTheirDefault(t *testing.T) {
	page := postProcessCode("\"use client\";\nexport const metadata = {};\nexport function RecipeCard() { return null }\nexport default function Recipes() { return null }\n", "app/recipes/page.tsx")
	if strings.Contains(page, "export function RecipeCard") || strings.Contains(page, "export function Recipes") || !strings.Contains(page, "export default function Recipes") || !strings.Contains(page, "export const metadata") {
		t.Fatalf("page exports:\n%s", page)
	}
	comp := postProcessCode("export default function Card() { return null }\n", "components/app/Card.tsx")
	if !strings.Contains(comp, "export function Card") || !strings.Contains(comp, "export default Card") {
		t.Fatalf("component exports:\n%s", comp)
	}
}

func TestGeneratedShellLinksOnlyRealPages(t *testing.T) {
	prd := &PRD{Name: `Chef "Ana" </script>`, Pages: []string{"/ - Today: what to cook", "/recipes - Recipe Library", "/meal-plan - Meal Plan", "/settings - Settings"},
		Design: &DesignDirection{Navigation: "bottom", BrandIcon: "ChefHat"}}
	dir := t.TempDir()
	if err := writeNextShell(dir, prd); err != nil {
		t.Fatal(err)
	}
	src, _ := os.ReadFile(filepath.Join(dir, "components", "app", "app-shell.tsx"))
	s := string(src)
	for _, want := range []string{`href: "/recipes", label: "Recipe Library", icon: BookOpen`, `href: "/meal-plan", label: "Meal Plan", icon: UtensilsCrossed`, `href: "/", label: "Today", icon: Home`, `brandIcon={ChefHat}`, `variant="bottom"`, `\x3c/script\x3e`} {
		if !strings.Contains(s, want) {
			t.Fatalf("missing %q in:\n%s", want, s)
		}
	}
	if strings.Contains(s, "</script>") || strings.Contains(s, "/search") {
		t.Fatalf("unsafe or invented content:\n%s", s)
	}
	if err := writeReactFrame(dir, prd); err != nil {
		t.Fatal(err)
	}
	frame, _ := os.ReadFile(filepath.Join(dir, "src", "components", "app", "AppFrame.jsx"))
	if !strings.Contains(string(frame), `href: "recipes"`) || !strings.Contains(string(frame), "onNavigate={setView}") {
		t.Fatalf("react frame:\n%s", frame)
	}
	if navIcon("/zzz", "Things") != "LayoutGrid" || !lucideIcons[navIcon("/pantry", "Pantry")] {
		t.Fatal("nav icons")
	}
	plan := screenPlan(&PRD{Design: &DesignDirection{Screens: []ScreenPlan{{Route: "/recipes/:id", Layout: "gallery", Sections: []string{"FilterBar: cuisine chips"}}}}}, "/recipes")
	if !strings.Contains(plan, "Layout: gallery") || !strings.Contains(plan, "FilterBar: cuisine chips") {
		t.Fatalf("screen plan: %q", plan)
	}
}

func TestPageErrorFindsTheFailingFile(t *testing.T) {
	logs := " GET /cook 200 in 50ms\n\x1b[31m ⨯\x1b[39m ./app/cook/page.tsx\nModule not found: Can't resolve '@/components/ui/icon-button'\n  3 | import { IconButton } from \"@/components/ui/icon-button\";\n GET /cook 500 in 900ms\n"
	text, file := pageError(logs, "app/cook/page.tsx")
	if file != "app/cook/page.tsx" || !strings.Contains(text, "Can't resolve '@/components/ui/icon-button'") {
		t.Fatalf("file %q text %q", file, text)
	}
	runtime := " ⨯ TypeError: Cannot read properties of undefined (reading 'map')\n    at RecipeList (./components/app/RecipeList.tsx:14:22)\n"
	if _, file := pageError(runtime, "app/recipes/page.tsx"); file != "components/app/RecipeList.tsx" {
		t.Fatalf("runtime error file %q", file)
	}
	if text, _ := pageError(" GET / 200 in 20ms\n", "app/page.tsx"); text != "" {
		t.Fatal("a clean log reported an error")
	}
}

func TestShimMissingUI(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "app", "cook"), 0755)
	os.MkdirAll(filepath.Join(dir, "components", "ui"), 0755)
	os.WriteFile(filepath.Join(dir, "components", "ui", "button.tsx"), []byte("export function Button() { return null }"), 0644)
	os.WriteFile(filepath.Join(dir, "app", "cook", "page.tsx"), []byte("import { IconButton, Toolbar } from \"@/components/ui/icon-button\";\nexport default function P() { return <Toolbar><IconButton /></Toolbar> }"), 0644)
	shimMissingUI("", dir, []string{"app/cook/page.tsx"}, &importRules{packages: map[string]bool{}})
	shim, err := os.ReadFile(filepath.Join(dir, "components", "ui", "icon-button.tsx"))
	if err != nil || !strings.Contains(string(shim), "export function IconButton(props: any)") || !strings.Contains(string(shim), "export function Toolbar(") {
		t.Fatalf("shim: %v\n%s", err, shim)
	}
	if left := findProblems(dir, []string{"app/cook/page.tsx"}, true, &importRules{packages: map[string]bool{}}); len(left) != 0 {
		t.Fatalf("problems remain: %+v", left)
	}
}

func TestPlaceholderPage(t *testing.T) {
	f := placeholderPage(prdRoute{route: "/pantry", name: "Pantry: what you have", file: "app/pantry/page.tsx"}, fmt.Errorf("every Groq key has used today's free token quota"))
	if f.Path != "app/pantry/page.tsx" || !strings.Contains(f.Content, `title={"Pantry"}`) || !strings.Contains(f.Content, "ran out of tokens") || !strings.Contains(f.Content, "export default function") {
		t.Fatalf("placeholder:\n%s", f.Content)
	}
}
