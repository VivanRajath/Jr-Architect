package builder

import (
	"os"
	"path/filepath"
	"testing"
)

func TestPageErrorKeepsThePageFileWhenLogsAreQuiet(t *testing.T) {
	if text, file := pageError("ready in 3s\n", "app/nutrition/page.tsx"); text != "" || file != "app/nutrition/page.tsx" {
		t.Fatalf("got %q %q; the page's own file must survive a quiet log", text, file)
	}
}

func TestBodyErrorReadsNextData(t *testing.T) {
	body := `<script id="__NEXT_DATA__">{"props":{},"err":{"name":"TypeError","source":"server","message":"Cannot read properties of undefined (reading \"map\")","stack":"x"}}</script>`
	if got := bodyError(body); got != `Cannot read properties of undefined (reading \"map\")` {
		t.Fatalf("bodyError = %q", got)
	}
	if bodyError("<html>fine</html>") != "" {
		t.Fatal("no error expected")
	}
}

func TestRepairsCannotBreakOtherPages(t *testing.T) {
	dir := t.TempDir()
	os.MkdirAll(filepath.Join(dir, "lib"), 0755)
	os.MkdirAll(filepath.Join(dir, "app", "recipes"), 0755)
	os.WriteFile(filepath.Join(dir, "lib", "data.ts"), []byte("export type Recipe = {}\nexport const seedRecipes = []\nexport function load() {}\n"), 0644)
	os.WriteFile(filepath.Join(dir, "app", "recipes", "page.tsx"), []byte("export default function P() {}"), 0644)
	target := "app/nutrition/page.tsx"

	if r := unsafeRepair(dir, target, GeneratedFile{Path: target, Content: "anything"}); r != "" {
		t.Fatalf("the broken file itself must be writable: %s", r)
	}
	if r := unsafeRepair(dir, target, GeneratedFile{Path: "components/app/New.tsx", Content: "x"}); r != "" {
		t.Fatalf("new files are fine: %s", r)
	}
	if r := unsafeRepair(dir, target, GeneratedFile{Path: "lib/data.ts", Content: "export const seedRecipes = []\nexport function load() {}\n"}); r == "" {
		t.Fatal("dropping the Recipe export must be refused")
	}
	if r := unsafeRepair(dir, target, GeneratedFile{Path: "lib/data.ts", Content: "export type Recipe = {}\nexport const seedRecipes = []\nexport function load() {}\nexport const seedNutrition = []\n"}); r != "" {
		t.Fatalf("adding an export keeps the others working: %s", r)
	}
	if r := unsafeRepair(dir, target, GeneratedFile{Path: "app/recipes/page.tsx", Content: "x"}); r == "" {
		t.Fatal("another page must not be rewritten while fixing this one")
	}
}
