package builder

import (
	"fmt"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"unicode"

	"sandbox/internal/core"
)

type fileProblem struct {
	Path    string
	Problem string
}

func jsLike(p string) bool {
	switch path.Ext(p) {
	case ".js", ".jsx", ".ts", ".tsx", ".mjs":
		return true
	}
	return false
}

// Finds the first unbalanced (), [] or {} in JS/TS, skipping strings, comments and template text; JSX text may hold apostrophes, so ' is not a quote there.
func delimiterProblem(src string, jsx bool) string {
	type open struct {
		ch       byte
		line     int
		template bool
	}
	var stack []open
	line := 1
	pairs := map[byte]byte{')': '(', ']': '[', '}': '{'}
	inTemplate := false
	for i := 0; i < len(src); i++ {
		c := src[i]
		if c == '\n' {
			line++
		}
		if inTemplate {
			switch {
			case c == '\\':
				i++
			case c == '`':
				inTemplate = false
			case c == '$' && i+1 < len(src) && src[i+1] == '{':
				stack = append(stack, open{'{', line, true})
				inTemplate = false
				i++
			}
			continue
		}
		switch c {
		case '/':
			if i+1 < len(src) && src[i+1] == '/' {
				for i < len(src) && src[i] != '\n' {
					i++
				}
				line++
			} else if i+1 < len(src) && src[i+1] == '*' {
				end := strings.Index(src[i+2:], "*/")
				if end < 0 {
					return fmt.Sprintf("a /* comment opened on line %d is never closed", line)
				}
				line += strings.Count(src[i:i+2+end], "\n")
				i += end + 3
			}
		case '"', '\'':
			if c == '\'' && jsx {
				continue
			}
			start := line
			for i++; i < len(src) && src[i] != c; i++ {
				if src[i] == '\\' {
					i++
				} else if src[i] == '\n' {
					return fmt.Sprintf("a string opened on line %d is not closed on that line", start)
				}
			}
		case '`':
			inTemplate = true
		case '(', '[', '{':
			stack = append(stack, open{c, line, false})
		case ')', ']', '}':
			if len(stack) == 0 || stack[len(stack)-1].ch != pairs[c] {
				return fmt.Sprintf("unexpected '%c' on line %d", c, line)
			}
			top := stack[len(stack)-1]
			stack = stack[:len(stack)-1]
			if top.template {
				inTemplate = true
			}
		}
	}
	if inTemplate {
		return "a template string (`...`) is never closed"
	}
	if len(stack) > 0 {
		top := stack[len(stack)-1]
		return fmt.Sprintf("'%c' opened on line %d is never closed", top.ch, top.line)
	}
	return ""
}

var (
	jsxTagRegex      = regexp.MustCompile(`<([A-Z][A-Za-z0-9_]*)[\s/>]`)
	importNamesRegex = regexp.MustCompile(`(?s)import\s+([^;'"]*?)\s+from\s*['"]`)
	declRegex        = regexp.MustCompile(`\b(?:function|class|const|let|var|type|interface|enum)\s+([A-Z][A-Za-z0-9_]*)`)
)

// A capitalised JSX tag that is neither imported nor declared crashes the page at runtime; the usual case is a forgotten icon import.
func undefinedComponents(src string) []string {
	known := map[string]bool{"React": true, "Fragment": true}
	for _, m := range importNamesRegex.FindAllStringSubmatch(src, -1) {
		for _, part := range strings.FieldsFunc(m[1], func(r rune) bool { return unicode.IsSpace(r) || strings.ContainsRune("{},*", r) }) {
			known[part] = true
		}
	}
	for _, m := range declRegex.FindAllStringSubmatch(src, -1) {
		known[m[1]] = true
	}
	var missing []string
	for _, m := range jsxTagRegex.FindAllStringSubmatchIndex(src, -1) {
		// A "<" right after a name is a TypeScript type argument (useState<Recipe[]>, ChangeEvent<HTMLInputElement>), not a tag.
		if m[0] > 0 {
			if c := rune(src[m[0]-1]); unicode.IsLetter(c) || unicode.IsDigit(c) || c == '_' || c == '.' {
				continue
			}
		}
		name := src[m[2]:m[3]]
		if !known[name] && !slices.Contains(missing, name) {
			missing = append(missing, name)
		}
	}
	return missing
}

var importSpecRegex = regexp.MustCompile(`(?m)(?:\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*)['"]([^'"]+)['"]`)

// Where an "@/..." import points, and which packages the template installs.
type importRules struct {
	aliasRoot string
	packages  map[string]bool
}

func resolves(workdir, rel string) bool {
	return resolvedFile(workdir, rel) != ""
}

// The file an import resolves to, or "".
func resolvedFile(workdir, rel string) string {
	rel = path.Clean(rel)
	for _, cand := range []string{rel, rel + ".js", rel + ".jsx", rel + ".ts", rel + ".tsx", rel + "/index.js", rel + "/index.jsx", rel + "/index.ts", rel + "/index.tsx"} {
		abs := filepath.Join(workdir, filepath.FromSlash(cand))
		if info, err := os.Stat(abs); err == nil && !info.IsDir() {
			return abs
		}
	}
	return ""
}

var (
	namedImportRegex = regexp.MustCompile(`import\s+(?:type\s+)?(?:[A-Za-z_$][\w$]*\s*,\s*)?\{([^}]*)\}\s*from\s*['"]([^'"]+)['"]`)
	exportDeclRegex  = regexp.MustCompile(`\bexport\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?:function\*?|const|let|var|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)`)
	exportListRegex  = regexp.MustCompile(`\bexport\s+(?:type\s+)?\{([^}]*)\}`)
)

// The names a module exports; ok is false when it re-exports another module, so its full list is unknown.
func exportedNames(src string) (map[string]bool, bool) {
	if strings.Contains(src, "export *") {
		return nil, false
	}
	names := map[string]bool{}
	for _, m := range exportDeclRegex.FindAllStringSubmatch(src, -1) {
		names[m[1]] = true
	}
	for _, m := range exportListRegex.FindAllStringSubmatch(src, -1) {
		for _, part := range strings.Split(m[1], ",") {
			f := strings.Fields(part)
			if len(f) > 0 {
				names[f[len(f)-1]] = true
			}
		}
	}
	return names, true
}

// Named imports from the app's own files that those files do not export, which build as undefined and crash at runtime.
func missingExports(workdir, file, src string, rules importRules) []string {
	var out []string
	for _, m := range namedImportRegex.FindAllStringSubmatch(src, -1) {
		spec := m[2]
		var rel string
		switch {
		case strings.HasPrefix(spec, "@/"):
			rel = rules.aliasRoot + spec[2:]
		case strings.HasPrefix(spec, "./"), strings.HasPrefix(spec, "../"):
			rel = path.Join(path.Dir(file), spec)
		default:
			continue
		}
		target := resolvedFile(workdir, rel)
		data, err := os.ReadFile(target)
		if target == "" || err != nil {
			continue
		}
		exports, ok := exportedNames(string(data))
		if !ok {
			continue
		}
		var missing []string
		for _, part := range strings.Split(m[1], ",") {
			f := strings.Fields(strings.TrimPrefix(strings.TrimSpace(part), "type "))
			if len(f) > 0 && !exports[f[0]] {
				missing = append(missing, f[0])
			}
		}
		if len(missing) > 0 {
			out = append(out, fmt.Sprintf("imports { %s } from %q, which does not export them; export them there or change the import", strings.Join(missing, ", "), spec))
		}
	}
	return out
}

func importProblems(workdir, file, src string, rules importRules) []string {
	var out []string
	seen := map[string]bool{}
	for _, m := range importSpecRegex.FindAllStringSubmatch(src, -1) {
		spec := m[1]
		if seen[spec] {
			continue
		}
		seen[spec] = true
		var rel string
		switch {
		case strings.HasPrefix(spec, "@/"):
			rel = rules.aliasRoot + spec[2:]
		case strings.HasPrefix(spec, "./"), strings.HasPrefix(spec, "../"):
			rel = path.Join(path.Dir(file), spec)
		default:
			if !rules.packages[moduleRoot(spec)] {
				out = append(out, fmt.Sprintf("imports the package %q, which is not installed; use only the listed packages", spec))
			}
			continue
		}
		if !resolves(workdir, rel) {
			out = append(out, fmt.Sprintf("imports %q but no such file exists; write that file or change the import", spec))
		}
	}
	return append(out, missingExports(workdir, file, src, rules)...)
}

func findProblems(workdir string, written []string, jsx bool, rules *importRules) []fileProblem {
	var out []fileProblem
	for _, rel := range written {
		if !jsLike(rel) {
			continue
		}
		data, err := os.ReadFile(filepath.Join(workdir, filepath.FromSlash(rel)))
		if err != nil {
			continue
		}
		src := string(data)
		if p := delimiterProblem(src, jsx && (strings.HasSuffix(rel, "x"))); p != "" {
			out = append(out, fileProblem{rel, "syntax error: " + p})
		}
		if jsx && (strings.HasSuffix(rel, ".jsx") || strings.HasSuffix(rel, ".tsx")) {
			if missing := undefinedComponents(src); len(missing) > 0 {
				out = append(out, fileProblem{rel, fmt.Sprintf("uses <%s> but never imports or defines it (icons come from \"lucide-react\")", strings.Join(missing, ">, <"))})
			}
		}
		if effectCallsWorkflow(src) {
			out = append(out, fileProblem{rel, "runs an AI workflow from useEffect, which repeats it on every change and floods the AI; run it only from a user action (a button, a form submit, sending a message) and remove that effect"})
		}
		if rules != nil {
			for _, p := range importProblems(workdir, rel, src, *rules) {
				out = append(out, fileProblem{rel, p})
			}
		}
	}
	return out
}

// One file's problems, its content, and what each of its local imports really exports, so the fix can use existing names.
func repairMessage(workdir, file string, problems []fileProblem, rules *importRules) string {
	var b strings.Builder
	fmt.Fprintf(&b, "%s has problems that stop the app from building. Fix every one and return ONLY a JSON array with the corrected %s (full content), plus any new file it needs.\n\nProblems:\n", file, file)
	for _, p := range problems {
		fmt.Fprintf(&b, "- %s\n", p.Problem)
	}
	data, _ := os.ReadFile(filepath.Join(workdir, filepath.FromSlash(file)))
	if rules != nil {
		var lines []string
		seen := map[string]bool{}
		for _, m := range importSpecRegex.FindAllStringSubmatch(string(data), -1) {
			spec := m[1]
			var rel string
			switch {
			case strings.HasPrefix(spec, "@/"):
				rel = rules.aliasRoot + spec[2:]
			case strings.HasPrefix(spec, "./"), strings.HasPrefix(spec, "../"):
				rel = path.Join(path.Dir(file), spec)
			default:
				continue
			}
			target := resolvedFile(workdir, rel)
			if target == "" || seen[target] || strings.Contains(spec, "components/ui/") {
				continue
			}
			seen[target] = true
			src, _ := os.ReadFile(target)
			if names, ok := exportedNames(string(src)); ok {
				list := make([]string, 0, len(names))
				for n := range names {
					list = append(list, n)
				}
				slices.Sort(list)
				lines = append(lines, fmt.Sprintf("- %s exports: %s", spec, strings.Join(list, ", ")))
			}
		}
		if len(lines) > 0 {
			b.WriteString("\nWhat this file's local imports export (use these names; data that is missing can be defined in this file instead):\n" + strings.Join(lines, "\n") + "\n")
		}
	}
	fmt.Fprintf(&b, "\n=== %s ===\n%s\n", file, data)
	return b.String()
}

// Two rounds of: find syntax slips and broken imports, repair each file in its own call (several at once), write what comes back through the same path filter.
func checkAndRepair(container, workdir, system string, written []string, jsx bool, rules *importRules, write func(GeneratedFile) (string, bool)) []string {
	for round := 0; round < 2; round++ {
		problems := findProblems(workdir, written, jsx, rules)
		if len(problems) == 0 {
			return written
		}
		var files []string
		byFile := map[string][]fileProblem{}
		for _, p := range problems {
			core.AddLog(container, fmt.Sprintf("Fixing %s: %s", p.Path, p.Problem))
			if _, ok := byFile[p.Path]; !ok {
				files = append(files, p.Path)
			}
			byFile[p.Path] = append(byFile[p.Path], p)
		}
		var mu sync.Mutex
		var wg sync.WaitGroup
		sem := make(chan struct{}, 3)
		for _, file := range files {
			wg.Add(1)
			go func(file string) {
				defer wg.Done()
				sem <- struct{}{}
				defer func() { <-sem }()
				raw, err := callGroq(system, repairMessage(workdir, file, byFile[file], rules), genChunkTokens())
				if err != nil {
					core.AddLog(container, "Could not repair "+file+": "+err.Error())
					return
				}
				mu.Lock()
				defer mu.Unlock()
				for _, f := range parseGeneratedFiles(cleanJSONArray(raw)) {
					if rel, ok := write(f); ok && !slices.Contains(written, rel) {
						written = append(written, rel)
					}
				}
			}(file)
		}
		wg.Wait()
	}
	if left := findProblems(workdir, written, jsx, rules); len(left) > 0 {
		core.AddLog(container, fmt.Sprintf("%d problem(s) remain; open the IDE and ask the coding agent to fix them.", len(left)))
	}
	return written
}

var (
	funcDeclRegex  = regexp.MustCompile(`(?:function\s+([A-Za-z_$][\w$]*)\s*\(|(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>)`)
	useEffectRegex = regexp.MustCompile(`\buse(?:Layout)?Effect\s*\(`)
)

// The text of the brace block that starts at or after from, or "" when there is none.
func braceBlock(src string, from int) string {
	start := strings.IndexByte(src[from:], '{')
	if start < 0 {
		return ""
	}
	start += from
	depth := 0
	for i := start; i < len(src); i++ {
		switch src[i] {
		case '{':
			depth++
		case '}':
			if depth--; depth == 0 {
				return src[start : i+1]
			}
		}
	}
	return src[start:]
}

func callsAny(body string, names map[string]bool) bool {
	for n := range names {
		if regexp.MustCompile(`\b` + regexp.QuoteMeta(n) + `\s*\(`).MatchString(body) {
			return true
		}
	}
	return false
}

// An effect that reaches runWorkflow directly or through the file's own functions.
func effectCallsWorkflow(src string) bool {
	if !strings.Contains(src, "runWorkflow") {
		return false
	}
	callers := map[string]bool{"runWorkflow": true}
	for round := 0; round < 3; round++ {
		grew := false
		for _, m := range funcDeclRegex.FindAllStringSubmatchIndex(src, -1) {
			name := ""
			if m[2] >= 0 {
				name = src[m[2]:m[3]]
			} else if m[4] >= 0 {
				name = src[m[4]:m[5]]
			}
			if name == "" || callers[name] {
				continue
			}
			if callsAny(braceBlock(src, m[1]), callers) {
				callers[name] = true
				grew = true
			}
		}
		if !grew {
			break
		}
	}
	for _, m := range useEffectRegex.FindAllStringIndex(src, -1) {
		if callsAny(braceBlock(src, m[1]), callers) {
			return true
		}
	}
	return false
}
