package builder

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"sandbox/internal/core"
)

var missingUIImport = regexp.MustCompile(`imports "@/components/ui/([a-z0-9-]+)" but no such file exists`)

// A component file the template lacks, written so the page still compiles: button-like names wrap Button, the rest render their children in a div.
func uiShim(names []string) string {
	var b strings.Builder
	b.WriteString("\"use client\";\n\n// Stand-in written by Build mode for a component this app's template does not include; replace it in the IDE if it needs more.\nimport * as React from \"react\";\nimport { cn } from \"@/lib/utils\";\nimport { Button as BaseButton } from \"./button\";\n\n")
	for _, n := range names {
		if strings.Contains(n, "Button") || strings.Contains(n, "Toggle") {
			fmt.Fprintf(&b, "export function %s(props: any) {\n  return <BaseButton variant=\"ghost\" size={props.children ? \"default\" : \"icon\"} {...props} />;\n}\n\n", n)
			continue
		}
		fmt.Fprintf(&b, "export function %s({ className, children, ...props }: any) {\n  return <div className={cn(className)} {...props}>{children}</div>;\n}\n\n", n)
	}
	return b.String()
}

// After repair, imports of UI components that still do not exist get stand-ins instead of breaking the build.
func shimMissingUI(container, workdir string, written []string, rules *importRules) {
	if rules == nil {
		return
	}
	names := map[string][]string{}
	for _, p := range findProblems(workdir, written, true, rules) {
		m := missingUIImport.FindStringSubmatch(p.Problem)
		if m == nil {
			continue
		}
		src, _ := os.ReadFile(filepath.Join(workdir, filepath.FromSlash(p.Path)))
		for _, im := range namedImportRegex.FindAllStringSubmatch(string(src), -1) {
			if im[2] != "@/components/ui/"+m[1] {
				continue
			}
			for _, part := range strings.Split(im[1], ",") {
				if f := strings.Fields(strings.TrimPrefix(strings.TrimSpace(part), "type ")); len(f) > 0 && !contains(names[m[1]], f[0]) {
					names[m[1]] = append(names[m[1]], f[0])
				}
			}
		}
	}
	for file, list := range names {
		rel := path.Join(rules.aliasRoot+"components/ui", file+".tsx")
		if err := writeFile(workdir, rel, uiShim(list)); err == nil {
			core.AddLog(container, fmt.Sprintf("Added a stand-in for %s (%s), which the template does not include.", rel, strings.Join(list, ", ")))
		}
	}
}

var (
	// A source path in Next.js dev output: "./app/cook/page.tsx", "app/cook/page.tsx (12:5)", "components/app/X.tsx:3:1".
	errorFileRegex = regexp.MustCompile(`(?:^|[\s(./])((?:app|components|lib)/[\w\-/\[\]().]+?\.(?:tsx|ts|jsx|js))`)
	ansiCodes      = regexp.MustCompile(`\x1b\[[0-9;]*m`)
)

// The error lines Next.js printed since the page was requested, and the app file they point at.
func pageError(logs, fallback string) (string, string) {
	lines := strings.Split(ansiCodes.ReplaceAllString(logs, ""), "\n")
	start := -1
	for i, l := range lines {
		if strings.Contains(l, "⨯") || strings.Contains(l, "Error:") || strings.Contains(l, "Failed to compile") || strings.Contains(l, "Module not found") {
			start = i
			break
		}
	}
	if start < 0 {
		return "", fallback
	}
	end := start + 14
	if end > len(lines) {
		end = len(lines)
	}
	text := strings.TrimSpace(strings.Join(lines[start:end], "\n"))
	file := fallback
	for _, l := range lines[start:end] {
		if m := errorFileRegex.FindStringSubmatch(l); m != nil && !strings.HasPrefix(m[1], "components/ui/") && !strings.HasPrefix(m[1], "components/blocks/") {
			file = m[1]
			break
		}
	}
	return text, file
}

var pageClient = &http.Client{Timeout: 90 * time.Second}

// The status and the start of the body; status 0 means the page did not answer in time (still compiling, usually).
func pageStatus(port int, route string) (int, string) {
	res, err := pageClient.Get(fmt.Sprintf("http://127.0.0.1:%d%s", port, route))
	if err != nil {
		return 0, ""
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 512<<10))
	return res.StatusCode, string(body)
}

// Next.js puts a server error's message in the page's __NEXT_DATA__, which helps when the container log has nothing.
var nextErrRegex = regexp.MustCompile(`"err":\{[^{}]*?"message":"((?:[^"\\]|\\.){1,600})"`)

func bodyError(body string) string {
	if m := nextErrRegex.FindStringSubmatch(body); m != nil {
		return strings.ReplaceAll(m[1], `\n`, "\n")
	}
	return ""
}

// The longest the page check may run, so a slow or stubborn app never keeps the build window waiting.
const healBudget = 6 * time.Minute

// Opens every page of the running app; a page that errors gets its real error and a repair call, for two rounds.
func healPages(container, workdir string, port int, prd *PRD, system string, rules *importRules, write func(GeneratedFile) (string, bool)) {
	deadline := time.Now().Add(healBudget)
	tried := map[string]int{}
	for round := 0; round < 2; round++ {
		fixed := false
		for _, rt := range parsePRDRoutes(prd) {
			if time.Now().After(deadline) {
				core.AddLog(container, "Stopped checking pages: the time for repairs is used up. Open the IDE to fix anything left.")
				return
			}
			since := time.Now().Add(-time.Second).UTC().Format(time.RFC3339)
			status, body := pageStatus(port, rt.route)
			if status != 0 && status < 500 {
				continue
			}
			if status == 0 {
				// A first compile on a bind mount can take longer than the check; that is slowness, not a bug.
				core.AddLog(container, rt.route+" is still compiling; skipped.")
				continue
			}
			logs, _ := core.Output("", core.CLI(), "logs", "--since", since, container)
			text, file := pageError(logs, rt.file)
			if text == "" {
				text = bodyError(body)
			}
			// Without the real error a repair is a guess, and guesses rewrite shared files and break other pages.
			if text == "" || file == "" {
				core.AddLog(container, rt.route+" shows a server error with no message; left for the IDE.")
				continue
			}
			if tried[file] >= 2 {
				continue
			}
			tried[file]++
			core.AddLog(container, fmt.Sprintf("%s fails when opened; fixing %s", rt.route, file))
			raw, err := callGroq(system, repairMessage(workdir, file, []fileProblem{{file, "the running app shows this error when " + rt.route + " is opened:\n" + text}}, rules), genChunkTokens())
			if err != nil {
				core.AddLog(container, "Could not repair "+file+": "+err.Error())
				return
			}
			for _, f := range parseGeneratedFiles(cleanJSONArray(raw)) {
				if reason := unsafeRepair(workdir, file, f); reason != "" {
					core.AddLog(container, "Kept "+f.Path+": "+reason)
					continue
				}
				if _, ok := write(f); ok {
					fixed = true
				}
			}
		}
		if !fixed {
			return
		}
		// Next.js recompiles on change; give it a moment before checking again.
		time.Sleep(4 * time.Second)
	}
}

var exportNameRegex = regexp.MustCompile(`(?m)^\s*export\s+(?:default\s+)?(?:async\s+)?(?:const|let|var|function|class|type|interface|enum)\s+([A-Za-z_$][\w$]*)`)

func exportNames(src string) map[string]bool {
	out := map[string]bool{}
	for _, m := range exportNameRegex.FindAllStringSubmatch(src, -1) {
		out[m[1]] = true
	}
	return out
}

// A repair may rewrite the broken file and add new files; another existing file may only change if it keeps every export, so no other page loses an import.
func unsafeRepair(workdir, target string, f GeneratedFile) string {
	if f.Path == target {
		return ""
	}
	old, err := os.ReadFile(filepath.Join(workdir, filepath.FromSlash(f.Path)))
	if err != nil {
		return ""
	}
	if strings.HasPrefix(f.Path, "app/") && strings.HasSuffix(f.Path, "/page.tsx") || f.Path == "app/page.tsx" || f.Path == "app/layout.tsx" {
		return "another page is not rewritten while fixing " + target
	}
	now := exportNames(f.Content)
	missing := []string{}
	for name := range exportNames(string(old)) {
		if !now[name] {
			missing = append(missing, name)
		}
	}
	if len(missing) > 0 {
		sort.Strings(missing)
		return "the rewrite dropped exports other files use (" + strings.Join(missing, ", ") + ")"
	}
	return ""
}

// True once the home page renders without a server error, within limit.
func waitForHome(port int, limit time.Duration) bool {
	client := http.Client{Timeout: 30 * time.Second}
	for deadline := time.Now().Add(limit); time.Now().Before(deadline); time.Sleep(2 * time.Second) {
		if res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d", port)); err == nil {
			res.Body.Close()
			if res.StatusCode < 500 {
				return true
			}
		}
	}
	return false
}

// True once the dev server answers anything at all, even an error page.
func waitForAnswer(port int, limit time.Duration) bool {
	client := http.Client{Timeout: 5 * time.Second}
	for deadline := time.Now().Add(limit); time.Now().Before(deadline); time.Sleep(2 * time.Second) {
		if res, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d", port)); err == nil {
			res.Body.Close()
			return true
		}
	}
	return false
}
