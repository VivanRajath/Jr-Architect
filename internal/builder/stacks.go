package builder

import (
	"regexp"
	"strings"
)

// One stack Build mode can generate: a template under builder-template/ and how its UI is written.
type Stack struct {
	ID       string `json:"id"`
	Label    string `json:"label"`
	Language string `json:"language"`
	Template string `json:"-"`
	UI       string `json:"ui"` // "nextjs", "react" or "vanilla"
	UIDir    string `json:"-"`  // where generated UI files go; "" is the project root
	APIPath  string `json:"-"`  // how the browser reaches the template's workflow endpoint
	AI       bool   `json:"ai"` // false when the stack has no server to hold workflow tokens
	pattern  *regexp.Regexp
}

const workflowRoute = "/api/workflows/"

// Order matters: the first match wins, so frameworks come before the languages they are written in.
var Stacks = []Stack{
	{ID: "nextjs", Label: "Next.js (React)", Language: "JavaScript", Template: "nextjs", UI: "nextjs", AI: true, pattern: regexp.MustCompile(`(?i)\bnext\s?\.?\s?js\b|\bnextjs\b`)},
	{ID: "vite-react", Label: "React + Vite", Language: "JavaScript", Template: "vite-react", UI: "react", UIDir: "src", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\breact\b|\bvite\b`)},
	{ID: "express", Label: "Node.js + Express", Language: "JavaScript", Template: "express", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\bexpress(\.?js)?\b`)},
	{ID: "bun", Label: "Bun", Language: "JavaScript", Template: "bun", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\bbun\b`)},
	{ID: "deno", Label: "Deno", Language: "JavaScript", Template: "deno", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\bdeno\b`)},
	{ID: "django", Label: "Django", Language: "Python", Template: "django", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\bdjango\b`)},
	{ID: "fastapi", Label: "Python + FastAPI", Language: "Python", Template: "fastapi", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\bfast\s?api\b`)},
	{ID: "flask", Label: "Python + Flask", Language: "Python", Template: "flask", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\bflask\b`)},
	{ID: "go", Label: "Go", Language: "Go", Template: "go", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\bgolang\b|\b(in|with|using|on)\s+go\b`)},
	{ID: "rust", Label: "Rust", Language: "Rust", Template: "rust", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\brust\b`)},
	{ID: "java", Label: "Java + Spring Boot", Language: "Java", Template: "java", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\bspring(\s?boot)?\b|\bjava\b`)},
	{ID: "dotnet", Label: ".NET (C#)", Language: "C#", Template: "dotnet", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\.net\b|\bdotnet\b|\bc#|\basp\.net\b`)},
	{ID: "php", Label: "PHP", Language: "PHP", Template: "php", UI: "vanilla", UIDir: "", APIPath: "/api.php?workflow=", AI: true, pattern: regexp.MustCompile(`(?i)\bphp\b|\blaravel\b`)},
	{ID: "ruby", Label: "Ruby + Sinatra", Language: "Ruby", Template: "ruby", UI: "vanilla", UIDir: "public", APIPath: workflowRoute, AI: true, pattern: regexp.MustCompile(`(?i)\bruby\b|\bsinatra\b|\brails\b`)},
	{ID: "static", Label: "Static HTML, CSS & JS", Language: "HTML", Template: "static", UI: "vanilla", UIDir: "", AI: false, pattern: regexp.MustCompile(`(?i)\bstatic\s+(site|html|page)\b|\bplain\s+html\b|\bvanilla\s+(js|javascript)\b|\bhtml\s*(,|and|/)\s*css\b`)},
}

// A language named without a framework narrows the stack question instead of answering it.
var languageHints = []struct {
	language string
	pattern  *regexp.Regexp
}{
	{"Python", regexp.MustCompile(`(?i)\bpython\b`)},
	{"JavaScript", regexp.MustCompile(`(?i)\b(javascript|typescript|node(\.?js)?)\b`)},
}

func StackByID(id string) (Stack, bool) {
	for _, s := range Stacks {
		if s.ID == id {
			return s, true
		}
	}
	return Stack{}, false
}

// The stack the prompt names, else the language it names (empty when it names neither).
func DetectStack(prompt string) (stack, language string) {
	for _, s := range Stacks {
		if s.pattern.MatchString(prompt) {
			return s.ID, s.Language
		}
	}
	for _, h := range languageHints {
		if h.pattern.MatchString(prompt) {
			return "", h.language
		}
	}
	return "", ""
}

// Asked first whenever the prompt does not name a stack; the options are the labels the UI maps back to IDs.
func stackQuestion(language string) Question {
	var options []string
	for _, s := range Stacks {
		if language == "" || s.Language == language {
			options = append(options, s.Label)
		}
	}
	text := "Which tech stack should it use?"
	if language != "" {
		text = "Which " + language + " stack should it use?"
	}
	return Question{ID: "tech_stack", Text: text, Options: options}
}

// The answer to the stack question is a label; anything unrecognised falls back to Next.js.
func stackFromAnswer(answer string) string {
	a := strings.TrimSpace(answer)
	for _, s := range Stacks {
		if strings.EqualFold(s.Label, a) || strings.EqualFold(s.ID, a) {
			return s.ID
		}
	}
	if id, _ := DetectStack(a); id != "" {
		return id
	}
	return "nextjs"
}
