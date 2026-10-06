package builder

import (
	_ "embed"
	"regexp"
	"strings"
)

// The icons lucide-react 0.378 (the version the templates pin) exports; regenerate this list when that pin moves.
//
//go:embed lucide-icons.txt
var lucideList string

var lucideIcons = func() map[string]bool {
	m := map[string]bool{}
	for _, n := range strings.Fields(lucideList) {
		m[n] = true
	}
	return m
}()

// Names models reach for that lucide spells differently.
var iconSynonyms = map[string]string{
	"Spinner": "Loader2", "Loading": "Loader2", "Robot": "Bot", "Close": "X", "Cross": "X", "Delete": "Trash2", "Remove": "Trash2",
	"Success": "CheckCircle", "Error": "AlertCircle", "Warning": "AlertTriangle", "Danger": "AlertTriangle", "Question": "HelpCircle",
	"Dashboard": "LayoutDashboard", "Analytics": "BarChart3", "Graph": "LineChart", "Idea": "Lightbulb", "Magic": "Wand2",
	"AI": "Sparkles", "Ai": "Sparkles", "Gear": "Settings", "Cog": "Settings", "Profile": "User", "Account": "User", "Team": "Users",
	"Note": "StickyNote", "Notes": "NotebookPen", "Document": "FileText", "Achievement": "Award", "Fire": "Flame",
	"Progress": "TrendingUp", "Stats": "BarChart3", "Statistics": "BarChart3", "Brain": "BrainCircuit", "Lesson": "BookOpen", "Course": "GraduationCap",
	"Learn": "GraduationCap", "Coach": "MessageSquare", "Chat": "MessageSquare", "Roadmap": "Map", "Goal": "Target", "Streak": "Flame",
}

var lucideImport = regexp.MustCompile(`import\s*\{([^}]*)\}\s*from\s*["']lucide-react["']`)

// An existing icon for a name lucide does not export: a known synonym, the name without trailing digits or an "Icon" suffix, else Circle.
func realIcon(name string) string {
	if lucideIcons[name] {
		return name
	}
	trimmed := strings.TrimRight(strings.TrimSuffix(name, "Icon"), "0123456789")
	for _, try := range []string{iconSynonyms[name], iconSynonyms[trimmed], trimmed} {
		if try != "" && lucideIcons[try] {
			return try
		}
	}
	if strings.Contains(name, "Spin") || strings.Contains(name, "Load") {
		return "Loader2"
	}
	return "Circle"
}

// Rewrites imports of icons lucide-react does not export into aliases of ones it does, so one invented name cannot fail the build.
func fixIconImports(src string) (string, []string) {
	var fixed []string
	out := lucideImport.ReplaceAllStringFunc(src, func(stmt string) string {
		m := lucideImport.FindStringSubmatch(stmt)
		parts := strings.Split(m[1], ",")
		changed := false
		for i, p := range parts {
			f := strings.Fields(p)
			if len(f) == 0 {
				continue
			}
			orig, local := f[0], f[0]
			if len(f) == 3 && f[1] == "as" {
				local = f[2]
			}
			if lucideIcons[orig] || len(f) != 1 && len(f) != 3 {
				continue
			}
			parts[i] = " " + realIcon(orig) + " as " + local
			fixed = append(fixed, orig)
			changed = true
		}
		if !changed {
			return stmt
		}
		return "import {" + strings.Join(parts, ",") + " } from \"lucide-react\""
	})
	return out, fixed
}
