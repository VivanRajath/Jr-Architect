package builder

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func sampleFlow() BuiltWorkflow {
	return BuiltWorkflow{Key: "summarize_note", ID: "summarize-note", Name: "Summarize note", Description: "Short summary", Token: "jrw_abc_summarize-note_0123456789",
		Input: map[string]string{"note": "The note"}, Output: map[string]string{"summary": "Summary"}}
}

func TestValidateBuiltWorkflowsRefusesUnsafeValues(t *testing.T) {
	if err := validateBuiltWorkflows([]BuiltWorkflow{sampleFlow()}); err != nil {
		t.Fatal(err)
	}
	bad := []func(*BuiltWorkflow){
		func(f *BuiltWorkflow) { f.Key = "Bad-Key" },
		func(f *BuiltWorkflow) { f.ID = "../etc" },
		func(f *BuiltWorkflow) { f.Token = "tok\nJR_API_BASE=http://evil" },
		func(f *BuiltWorkflow) { f.Input = map[string]string{"a b": ""} },
		func(f *BuiltWorkflow) { f.Output = map[string]string{"x'); alert(1); //": ""} },
	}
	for i, mutate := range bad {
		f := sampleFlow()
		mutate(&f)
		if err := validateBuiltWorkflows([]BuiltWorkflow{f}); err == nil {
			t.Errorf("case %d accepted", i)
		}
	}
	if err := validateBuiltWorkflows([]BuiltWorkflow{sampleFlow(), sampleFlow()}); err == nil {
		t.Error("duplicate keys accepted")
	}
}

func TestWriteWorkflowClient(t *testing.T) {
	dir := t.TempDir()
	f := sampleFlow()
	f.Description = "It's <script> time"
	if err := writeWorkflowClient(dir, []BuiltWorkflow{f}); err != nil {
		t.Fatal(err)
	}
	env, _ := os.ReadFile(filepath.Join(dir, ".env.local"))
	if !strings.Contains(string(env), "JR_WF_SUMMARIZE_NOTE_TOKEN="+f.Token) || !strings.Contains(string(env), "JR_API_BASE=http") {
		t.Fatalf(".env.local missing the base or token:\n%s", env)
	}
	route, _ := os.ReadFile(filepath.Join(dir, "app", "api", "workflows", "[key]", "route.ts"))
	if strings.Contains(string(route), f.Token) {
		t.Fatal("the token leaked into the route source")
	}
	if !strings.Contains(string(route), "'summarize-note'") || !strings.Contains(string(route), "/hooks/workflows/") {
		t.Fatalf("route does not call the workflow:\n%s", route)
	}
	lib, _ := os.ReadFile(filepath.Join(dir, "lib", "workflows.ts"))
	if !strings.Contains(string(lib), "export function runWorkflow") || strings.Contains(string(lib), "<script>") {
		t.Fatalf("lib/workflows.ts is wrong or unescaped:\n%s", lib)
	}
	if !strings.Contains(string(lib), `It\'s`) {
		t.Error("quotes in descriptions are not escaped")
	}
}

func TestReservedPathsAndContract(t *testing.T) {
	for _, p := range []string{"lib/workflows.ts", "app/api/workflows/[key]/route.ts", "app/api/other/route.ts"} {
		if !reservedPath(p) {
			t.Errorf("%s should be reserved", p)
		}
	}
	if reservedPath("lib/data.ts") || reservedPath("app/page.tsx") {
		t.Error("ordinary app files are reserved")
	}
	if workflowContract(nil) != "" {
		t.Error("an app without workflows got a contract")
	}
	c := workflowContract([]BuiltWorkflow{sampleFlow()})
	if !strings.Contains(c, `runWorkflow("summarize_note", { note: string })`) || !strings.Contains(c, "{ summary: string }") {
		t.Fatalf("contract does not describe the call:\n%s", c)
	}
}

func TestTypedOutputs(t *testing.T) {
	f := sampleFlow()
	f.Output = map[string]string{"title": "", "ingredients": "", "minutes": ""}
	f.OutputTypes = map[string]string{"title": "string", "ingredients": "list", "minutes": "number"}
	if err := validateBuiltWorkflows([]BuiltWorkflow{f}); err != nil {
		t.Fatal(err)
	}
	if got := typedShape(f.Output, f.OutputTypes); got != "{ ingredients: string[]; minutes: number; title: string }" {
		t.Fatalf("shape %q", got)
	}
	c := workflowContract([]BuiltWorkflow{f})
	if !strings.Contains(c, "ingredients: string[]") || !strings.Contains(c, "asList") {
		t.Fatalf("contract does not teach list handling:\n%s", c)
	}
	bad := f
	bad.OutputTypes = map[string]string{"title": "html"}
	if validateBuiltWorkflows([]BuiltWorkflow{bad}) == nil {
		t.Error("an unknown field type was accepted")
	}
	dir := t.TempDir()
	if err := writeWorkflowClient(dir, []BuiltWorkflow{f}); err != nil {
		t.Fatal(err)
	}
	lib, _ := os.ReadFile(filepath.Join(dir, "lib", "workflows.ts"))
	if !strings.Contains(string(lib), "export function asList") {
		t.Error("lib/workflows.ts has no asList helper")
	}
}

func TestPRDAcceptsTypedOutputs(t *testing.T) {
	raw := `{"name":"Cookbook","ai":{"agents":[{"key":"chef","name":"Chef","input":{"dish":"Dish"},"output":{"title":"Recipe name","steps":{"type":"list","description":"One per item"}}}],"workflows":[]}}`
	var prd PRD
	if err := json.Unmarshal([]byte(raw), &prd); err != nil {
		t.Fatal(err)
	}
	if _, ok := prd.AI.Agents[0].Output["steps"].(map[string]any); !ok {
		t.Fatal("typed output field was not kept")
	}
}

func TestBranchingWorkflowsMayReturnManyFields(t *testing.T) {
	f := sampleFlow()
	f.Output = map[string]string{}
	for i := 0; i < 30; i++ {
		f.Output[fmt.Sprintf("field_%d", i)] = ""
	}
	if err := validateBuiltWorkflows([]BuiltWorkflow{f}); err != nil {
		t.Fatalf("a 30-field branching workflow was refused: %v", err)
	}
	for i := 30; i < 70; i++ {
		f.Output[fmt.Sprintf("field_%d", i)] = ""
	}
	if validateBuiltWorkflows([]BuiltWorkflow{f}) == nil {
		t.Fatal("a runaway 70-field workflow was accepted")
	}
}
