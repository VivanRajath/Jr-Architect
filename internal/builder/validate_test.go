package builder

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestDelimiterProblem(t *testing.T) {
	ok := []struct {
		src string
		jsx bool
	}{
		{"const a = (b) => ({ c: [1, 2] });", false},
		{"const s = `x ${y({ z: 1 })} w`; // done)", false},
		{"/* ( [ { */ const a = 1;", false},
		{"<p>Don't panic (yet)</p>", true},
		{`const s = "a ) b";`, false},
		{"const s = 'a ) b';", false},
	}
	for _, c := range ok {
		if p := delimiterProblem(c.src, c.jsx); p != "" {
			t.Errorf("%q flagged: %s", c.src, p)
		}
	}
	bad := map[string]string{
		`onClick={() => setS((s) => ({ ...s, a: 1 })))}`: "unexpected ')'",
		"function f() {\n  return (1;\n}":                "unexpected '}'",
		"const a = [1, 2;":                               "never closed",
		"const s = `open":                                "template",
	}
	for src, want := range bad {
		if p := delimiterProblem(src, true); !strings.Contains(p, want) {
			t.Errorf("%q: got %q, want it to mention %q", src, p, want)
		}
	}
}

func TestImportProblems(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "src", "components", "ui"), 0755)
	os.WriteFile(filepath.Join(dir, "src", "components", "ui", "button.tsx"), []byte("const Button = () => null;\nexport { Button, buttonVariants as variants };"), 0644)
	os.WriteFile(filepath.Join(dir, "src", "workflows.js"), []byte("export async function runWorkflow() {}\nexport function asList() {}"), 0644)
	src := `import { Button } from "@/components/ui/button";
import { SEED } from "@/lib/data";
import { runWorkflow } from "./workflows.js";
import { Inbox } from "lucide-react";
import axios from "axios";`
	got := importProblems(dir, "src/App.jsx", src, importRules{aliasRoot: "src/", packages: reactPackages})
	joined := strings.Join(got, "\n")
	if len(got) != 2 || !strings.Contains(joined, `"@/lib/data"`) || !strings.Contains(joined, `"axios"`) {
		t.Fatalf("got %v, want the missing data file and the uninstalled package", got)
	}
	os.MkdirAll(filepath.Join(dir, "src", "lib"), 0755)
	os.WriteFile(filepath.Join(dir, "src", "lib", "data.js"), []byte("export const recipes = [];\nexport type Recipe = {};"), 0644)
	got = importProblems(dir, "src/App.jsx", `import { recipes, pantryItems, type Recipe } from "@/lib/data";
import { variants as v } from "@/components/ui/button";`, importRules{aliasRoot: "src/", packages: reactPackages})
	if len(got) != 1 || !strings.Contains(got[0], "{ pantryItems }") {
		t.Fatalf("got %v, want only the missing pantryItems export", got)
	}
}

func TestFindProblemsSkipsNonCode(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<p>(</p>"), 0644)
	os.WriteFile(filepath.Join(dir, "app.js"), []byte("render((1);"), 0644)
	got := findProblems(dir, []string{"index.html", "app.js"}, false, nil)
	if len(got) != 1 || got[0].Path != "app.js" {
		t.Fatalf("got %+v", got)
	}
}

func TestUndefinedComponents(t *testing.T) {
	src := `import { Button } from "@/components/ui/button";
import { Inbox, Plus as Add } from "lucide-react";
import Thing from "./thing";
function Row() { return null; }
const Panel = () => null;
export default function App() {
  return <><Button><Add /></Button><Inbox className="x" /><Row/><Panel /><Thing /><Settings /><Dialog open /><div /></>;
}`
	got := undefinedComponents(src)
	if strings.Join(got, ",") != "Settings,Dialog" {
		t.Fatalf("got %v, want [Settings Dialog]", got)
	}
	typed := "type Recipe = { id: string };\nconst [r, setR] = useState<Recipe[]>([]);\nconst on = (e: React.ChangeEvent<HTMLSelectElement>) => setR([]);\nconst m = new Map<string, Recipe>();\nreturn <Card><Recipe /></Card>;"
	if got := undefinedComponents(typed); strings.Join(got, ",") != "Card" {
		t.Fatalf("type arguments were taken for tags: %v", got)
	}
}

func TestRepairMessageListsWhatImportsExport(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "lib"), 0755)
	os.MkdirAll(filepath.Join(dir, "app"), 0755)
	os.WriteFile(filepath.Join(dir, "lib", "data.ts"), []byte("export const recipes = [];\nexport interface Recipe { id: string }"), 0644)
	os.WriteFile(filepath.Join(dir, "app", "page.tsx"), []byte("import { steps } from \"@/lib/data\";"), 0644)
	msg := repairMessage(dir, "app/page.tsx", []fileProblem{{"app/page.tsx", "imports { steps } from \"@/lib/data\", which does not export them"}}, &importRules{})
	if !strings.Contains(msg, "@/lib/data exports: Recipe, recipes") || !strings.Contains(msg, "=== app/page.tsx ===") {
		t.Fatalf("repair message:\n%s", msg)
	}
}

func TestEffectCallsWorkflow(t *testing.T) {
	flood := `const fetchSpotlight = async () => {
    const result = await runWorkflow("spotlight_content", { location });
  };
  useEffect(() => {
    if (location) fetchSpotlight();
  }, [location]);`
	if !effectCallsWorkflow(flood) {
		t.Fatal("missed an effect that reaches runWorkflow through a helper")
	}
	direct := "useEffect(() => { runWorkflow(\"x\", {}) }, [])"
	if !effectCallsWorkflow(direct) {
		t.Fatal("missed a direct call")
	}
	ok := `async function plan() { await runWorkflow("plan", {}) }
  useEffect(() => { const saved = localStorage.getItem("x"); }, []);
  return <Button onClick={plan}>Plan</Button>;`
	if effectCallsWorkflow(ok) {
		t.Fatal("flagged a workflow that only runs on click")
	}
}
