package main

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
)

// Layer 1 of the code-agent's retrieval: a "where things are" map generated at
// clone time so the agent starts a turn already knowing the repo's shape instead
// of blindly grepping. Two docs are written under knowledge/ and registered with
// gitclaw's knowledge loader (see knowledge/index.yaml handling in gitclaw):
//
//   knowledge/repo-map.md      always-loaded, SMALL — stack, tree, entry points.
//                              Kept compact on purpose: it rides in every prompt,
//                              and Groq's free tier is token-tight.
//   knowledge/repo-map-full.md on-demand — full file list with exported symbols.
//                              The agent `read`s it only when it needs detail.
//
// Layer 2 (the search_code tool) lives in the agent service; this file is Layer 1.

var repoMapSkipDirs = map[string]bool{
	".git": true, "node_modules": true, "__pycache__": true, ".next": true,
	"vendor": true, ".venv": true, "venv": true, "dist": true, "build": true,
	".gitagent": true, "coverage": true, ".turbo": true, ".cache": true,
	"out": true, "target": true, ".idea": true, ".vscode": true, "knowledge": true,
}

// Extensions we extract symbols from for the full map.
var repoMapSourceExt = map[string]bool{
	".ts": true, ".tsx": true, ".js": true, ".jsx": true, ".mjs": true, ".cjs": true,
	".go": true, ".py": true, ".rb": true, ".php": true, ".java": true, ".rs": true,
	".vue": true, ".svelte": true,
}

// Per-language symbol patterns. Deliberately shallow — this is a locator, not a
// parser; the goal is "which file defines X", which search_code then pinpoints.
var repoMapSymbolPatterns = []*regexp.Regexp{
	// JS/TS top-level exports (function/class/const/interface/type/enum).
	regexp.MustCompile(`(?m)^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)`),
	// Go exported funcs (incl. methods) and types.
	regexp.MustCompile(`(?m)^func\s+(?:\([^)]*\)\s+)?([A-Z][A-Za-z0-9_]*)`),
	regexp.MustCompile(`(?m)^type\s+([A-Z][A-Za-z0-9_]*)`),
	// Python/Ruby def/class.
	regexp.MustCompile(`(?m)^\s*(?:def|class)\s+([A-Za-z_][A-Za-z0-9_]*)`),
}

const (
	repoMapMaxFiles       = 500        // cap total files indexed
	repoMapMaxSymbolsFile = 12         // cap symbols listed per file
	repoMapMaxReadBytes   = 256 * 1024 // don't scan giant/minified files for symbols
)

type repoMapFile struct {
	rel     string
	symbols []string
}

// generateRepoMap writes the knowledge docs described above. Best-effort: the
// caller treats any error as non-fatal (the sandbox still runs without a map).
func generateRepoMap(workdir, stack, framework string) error {
	files, err := collectRepoFiles(workdir)
	if err != nil {
		return err
	}
	knowledgeDir := filepath.Join(workdir, "knowledge")
	if err := os.MkdirAll(knowledgeDir, 0o755); err != nil {
		return err
	}

	compact := buildCompactMap(workdir, stack, framework, files)
	full := buildFullMap(stack, framework, files)

	if err := os.WriteFile(filepath.Join(knowledgeDir, "repo-map.md"), []byte(compact), 0o644); err != nil {
		return err
	}
	if err := os.WriteFile(filepath.Join(knowledgeDir, "repo-map-full.md"), []byte(full), 0o644); err != nil {
		return err
	}
	if err := ensureKnowledgeIndex(knowledgeDir); err != nil {
		return err
	}
	fmt.Printf("[repomap] indexed %d files for %s\n", len(files), filepath.Base(workdir))
	return nil
}

// collectRepoFiles walks the workspace (skipping build/dependency dirs) and
// extracts exported symbols from source files, capped for size.
func collectRepoFiles(root string) ([]repoMapFile, error) {
	var out []repoMapFile
	var walk func(dir, rel string) error
	walk = func(dir, rel string) error {
		if len(out) >= repoMapMaxFiles {
			return nil
		}
		entries, err := os.ReadDir(dir)
		if err != nil {
			return err
		}
		// Deterministic order so the map is stable across runs.
		sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
		for _, e := range entries {
			if len(out) >= repoMapMaxFiles {
				return nil
			}
			name := e.Name()
			childRel := name
			if rel != "" {
				childRel = rel + "/" + name
			}
			if e.IsDir() {
				if repoMapSkipDirs[name] || strings.HasPrefix(name, ".") && name != "." {
					continue
				}
				if err := walk(filepath.Join(dir, name), childRel); err != nil {
					return err
				}
				continue
			}
			out = append(out, repoMapFile{
				rel:     childRel,
				symbols: extractSymbols(filepath.Join(dir, name)),
			})
		}
		return nil
	}
	if err := walk(root, ""); err != nil {
		return nil, err
	}
	return out, nil
}

// extractSymbols returns up to repoMapMaxSymbolsFile symbol names from a source
// file. Returns nil for non-source, oversized, or unreadable files.
func extractSymbols(path string) []string {
	if !repoMapSourceExt[strings.ToLower(filepath.Ext(path))] {
		return nil
	}
	info, err := os.Stat(path)
	if err != nil || info.Size() > repoMapReadCap() {
		return nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return nil
	}
	src := string(data)
	seen := map[string]bool{}
	var syms []string
	for _, re := range repoMapSymbolPatterns {
		for _, m := range re.FindAllStringSubmatch(src, -1) {
			sym := m[1]
			if sym == "" || seen[sym] {
				continue
			}
			seen[sym] = true
			syms = append(syms, sym)
			if len(syms) >= repoMapMaxSymbolsFile {
				return syms
			}
		}
	}
	return syms
}

func repoMapReadCap() int64 { return repoMapMaxReadBytes }

// buildCompactMap is the always-loaded doc. Keep it small.
func buildCompactMap(workdir, stack, framework string, files []repoMapFile) string {
	var b strings.Builder
	b.WriteString("# Repository Map\n\n")
	if framework != "" {
		b.WriteString(fmt.Sprintf("**Framework:** %s  \n", framework))
	}
	b.WriteString(fmt.Sprintf("**Stack:** %s  \n", stack))
	b.WriteString(fmt.Sprintf("**Indexed files:** %d\n\n", len(files)))

	// Entry point (reuse the preview's UI-entry detection).
	if entry := firstExistingEntry(workdir); entry != "" {
		b.WriteString(fmt.Sprintf("**Main UI entry:** `%s`\n\n", entry))
	}

	b.WriteString("## Top-level layout\n\n")
	b.WriteString(topLevelLayout(files))

	b.WriteString("\n## How to explore this repo\n\n")
	b.WriteString("- Use the `search_code` tool to find where a symbol, function, or string is defined or used — prefer it over reading whole files.\n")
	b.WriteString("- `read` `knowledge/repo-map-full.md` for the complete file list with exported symbols per file.\n")
	b.WriteString("- When asked to summarize, start from the entry point above and follow imports; cite `path:line` for specifics.\n")
	return b.String()
}

// topLevelLayout summarizes each top-level directory as "dir/ — N files" plus a
// few notable entries, and lists notable root files. Compact by design.
func topLevelLayout(files []repoMapFile) string {
	dirCounts := map[string]int{}
	var rootFiles []string
	dirOrder := []string{}
	for _, f := range files {
		if i := strings.IndexByte(f.rel, '/'); i >= 0 {
			top := f.rel[:i]
			if dirCounts[top] == 0 {
				dirOrder = append(dirOrder, top)
			}
			dirCounts[top]++
		} else {
			rootFiles = append(rootFiles, f.rel)
		}
	}
	sort.Strings(dirOrder)
	var b strings.Builder
	for _, d := range dirOrder {
		b.WriteString(fmt.Sprintf("- `%s/` — %d files\n", d, dirCounts[d]))
	}
	if len(rootFiles) > 0 {
		sort.Strings(rootFiles)
		if len(rootFiles) > 20 {
			rootFiles = rootFiles[:20]
		}
		b.WriteString("- root: `" + strings.Join(rootFiles, "`, `") + "`\n")
	}
	return b.String()
}

// buildFullMap is the on-demand doc: every indexed file, with its symbols.
func buildFullMap(stack, framework string, files []repoMapFile) string {
	var b strings.Builder
	b.WriteString("# Repository Map (full)\n\n")
	b.WriteString(fmt.Sprintf("Stack: %s. Framework: %s. %d files.\n\n", stack, framework, len(files)))
	b.WriteString("Each entry is a file path followed by its top-level exported symbols (best-effort). Use `search_code` to locate exact lines.\n\n")
	for _, f := range files {
		if len(f.symbols) > 0 {
			b.WriteString(fmt.Sprintf("- `%s` — %s\n", f.rel, strings.Join(f.symbols, ", ")))
		} else {
			b.WriteString(fmt.Sprintf("- `%s`\n", f.rel))
		}
	}
	return b.String()
}

// firstExistingEntry returns the first uiEntryCandidates path that exists, as a
// forward-slash workspace-relative path (empty if none).
func firstExistingEntry(workdir string) string {
	for _, c := range uiEntryCandidates {
		if _, err := os.Stat(filepath.Join(workdir, filepath.FromSlash(c))); err == nil {
			return c
		}
	}
	return ""
}

// ensureKnowledgeIndex registers the two repo-map docs with gitclaw's knowledge
// loader. gitclaw reads knowledge/index.yaml: entries with always_load:true are
// injected into the prompt, others are listed for on-demand `read`. If the repo
// already ships an index.yaml we append our entries (unless already present)
// rather than clobber the repo's own knowledge.
func ensureKnowledgeIndex(knowledgeDir string) error {
	path := filepath.Join(knowledgeDir, "index.yaml")
	ourEntries := "" +
		"  - path: repo-map.md\n" +
		"    always_load: true\n" +
		"  - path: repo-map-full.md\n" +
		"    priority: high\n" +
		"    tags: [structure, files, symbols]\n"

	existing, err := os.ReadFile(path)
	if err != nil {
		// No index yet — create one.
		return os.WriteFile(path, []byte("entries:\n"+ourEntries), 0o644)
	}
	if strings.Contains(string(existing), "repo-map.md") {
		return nil // already registered (idempotent re-run)
	}
	text := string(existing)
	if idx := strings.Index(text, "entries:"); idx >= 0 {
		// Insert our entries right after the "entries:" line.
		nl := strings.IndexByte(text[idx:], '\n')
		if nl < 0 {
			text += "\n" + ourEntries
		} else {
			at := idx + nl + 1
			text = text[:at] + ourEntries + text[at:]
		}
		return os.WriteFile(path, []byte(text), 0o644)
	}
	// Unexpected shape — append a fresh entries block.
	return os.WriteFile(path, []byte(text+"\nentries:\n"+ourEntries), 0o644)
}
