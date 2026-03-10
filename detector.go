package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
)

// ---------------------------------------------------------------------------
// detectFromInstructions – accept ANY bash commands from INSTRUCTIONS.md
// ---------------------------------------------------------------------------
// Reads INSTRUCTIONS.md (or the text pasted in the UI).  Every non-blank,
// non-comment line is treated as a shell command.  Commands are joined with
// "&&" to form the Docker startup command.
//
// The image and port are inferred from the commands themselves:
//   npm / node / yarn / pnpm / npx / bun  → sandbox-react  (port varies)
//   python / pip / uvicorn / gunicorn      → sandbox-python
//   go                                     → sandbox-go
//   cargo                                  → sandbox-rust
//   everything else                        → sandbox-node
//
// If a Vite dev server is detected the port defaults to 5173 and --host
// 0.0.0.0 is appended when missing. Next.js dev gets -H 0.0.0.0.
// ---------------------------------------------------------------------------
func detectFromInstructions(path string) (RuntimeConfig, bool) {

	candidates := []string{"INSTRUCTIONS.md", "instructions.md"}

	var content string

	for _, name := range candidates {

		data, err := os.ReadFile(filepath.Join(path, name))

		if err == nil {
			content = string(data)
			break
		}
	}

	if strings.TrimSpace(content) == "" {
		return RuntimeConfig{}, false
	}

	lines := strings.Split(content, "\n")

	var commands []string

	for _, line := range lines {

		trimmed := strings.TrimSpace(line)

		// skip blanks, markdown headers, html-style comments, code fences
		if trimmed == "" ||
			strings.HasPrefix(trimmed, "#") ||
			strings.HasPrefix(trimmed, "//") ||
			strings.HasPrefix(trimmed, "<!--") ||
			strings.HasPrefix(trimmed, "```") {
			continue
		}

		// strip common shell-prompt characters
		trimmed = strings.TrimLeft(trimmed, "$> ")
		trimmed = strings.TrimSpace(trimmed)

		if trimmed == "" {
			continue
		}

		// skip lines that look like prose (contain multiple spaces between words
		// and no obvious command keyword)
		if looksLikeProse(trimmed) {
			continue
		}

		commands = append(commands, trimmed)
	}

	if len(commands) == 0 {
		return RuntimeConfig{}, false
	}

	// ---- Infer image & port from the combined command text ----
	allLower := strings.ToLower(strings.Join(commands, " "))

	image := "sandbox-node" // safe default
	port := 3000

	switch {
	case strings.Contains(allLower, "python") ||
		strings.Contains(allLower, "pip ") ||
		strings.Contains(allLower, "uvicorn") ||
		strings.Contains(allLower, "gunicorn") ||
		strings.Contains(allLower, "flask") ||
		strings.Contains(allLower, "django"):
		image = "sandbox-python"
		if strings.Contains(allLower, "uvicorn") || strings.Contains(allLower, "fastapi") {
			port = 8000
		} else if strings.Contains(allLower, "django") {
			port = 8000
		} else {
			port = 5000
		}

	case strings.Contains(allLower, "go run") ||
		strings.Contains(allLower, "go mod"):
		image = "sandbox-go"
		port = 8080

	case strings.Contains(allLower, "cargo"):
		image = "sandbox-rust"
		port = 8080

	default:
		// Node / React / Next / Vite / Bun
		image = "sandbox-react" // react image has everything node needs + React tooling

		switch {
		case strings.Contains(allLower, "next"):
			port = 3000
		case strings.Contains(allLower, "vite"):
			port = 5173
		case strings.Contains(allLower, "gatsby"):
			port = 8000
		case strings.Contains(allLower, "nuxt"):
			port = 3000
		default:
			port = 3000
		}
	}

	// ---- Normalize dev-server bindings so they listen on 0.0.0.0 ----
	for i, cmd := range commands {
		lower := strings.ToLower(cmd)

		// Vite: append --host 0.0.0.0
		if isViteDevCmd(lower, allLower) && !strings.Contains(lower, "--host") {
			if strings.Contains(lower, "npm run dev") {
				commands[i] = cmd + " -- --host 0.0.0.0"
			} else {
				commands[i] = cmd + " --host 0.0.0.0"
			}
			port = 5173
		}

		// Next.js dev: append -H 0.0.0.0
		if isNextDevCmd(lower, allLower) && !strings.Contains(lower, "-h 0.0.0.0") && !strings.Contains(lower, "hostname") {
			if strings.Contains(lower, "npm run dev") {
				commands[i] = cmd + " -- -H 0.0.0.0"
			} else {
				commands[i] = cmd + " -H 0.0.0.0"
			}
		}

		// CRA / generic React start: HOST=0.0.0.0
		if isReactStartCmd(lower) && !strings.Contains(lower, "host=") {
			commands[i] = "HOST=0.0.0.0 " + cmd
		}
	}

	startupCommand := strings.Join(commands, " && ")

	fmt.Printf("[instructions] image=%s port=%d cmd=%s\n", image, port, startupCommand)

	return RuntimeConfig{
		Image:          image,
		Port:           port,
		StartupCommand: startupCommand,
	}, true
}

// looksLikeProse returns true if the line looks like descriptive text rather
// than a shell command. Heuristic: if the line has 5+ words and none of them
// look like a command keyword, it's probably prose.
func looksLikeProse(line string) bool {
	words := strings.Fields(line)
	if len(words) < 5 {
		return false
	}

	cmdKeywords := []string{
		"npm", "npx", "yarn", "pnpm", "bun",
		"node", "python", "pip", "go", "cargo",
		"uvicorn", "gunicorn", "flask", "django",
		"java", "mvn", "gradle", "dotnet",
		"ruby", "gem", "bundle", "rails",
		"docker", "make", "cmake", "sh", "bash",
		"cd", "mkdir", "rm", "cp", "mv", "cat",
		"curl", "wget", "git", "apt", "brew",
		"export", "set", "env", "source",
		"next", "vite", "react-scripts", "gatsby",
	}

	first := strings.ToLower(words[0])
	for _, kw := range cmdKeywords {
		if first == kw {
			return false
		}
	}

	return true
}

func isViteDevCmd(lower, allLower string) bool {
	if !strings.Contains(allLower, "vite") {
		return false
	}
	return strings.Contains(lower, "run dev") ||
		strings.Contains(lower, "vite dev") ||
		lower == "vite" ||
		strings.HasPrefix(lower, "vite ")
}

func isNextDevCmd(lower, allLower string) bool {
	if !strings.Contains(allLower, "next") {
		return false
	}
	return strings.Contains(lower, "run dev") ||
		strings.Contains(lower, "next dev") ||
		strings.HasPrefix(lower, "next dev")
}

func isReactStartCmd(lower string) bool {
	return strings.Contains(lower, "npm start") ||
		strings.Contains(lower, "npm run start") ||
		strings.Contains(lower, "yarn start") ||
		strings.Contains(lower, "pnpm start") ||
		strings.Contains(lower, "react-scripts start")
}

// ---------------------------------------------------------------------------
// readDocHint – scan README/INSTRUCTIONS for runtime keywords (unchanged)
// ---------------------------------------------------------------------------
func readDocHint(path string) (RuntimeConfig, bool) {

	candidates := []string{"README.md", "readme.md", "INSTRUCTIONS.md", "instructions.md"}

	var content string
	for _, name := range candidates {
		data, err := os.ReadFile(filepath.Join(path, name))
		if err == nil {
			content = strings.ToLower(string(data))
			break
		}
	}

	if content == "" {
		return RuntimeConfig{}, false
	}

	switch {
	case strings.Contains(content, "next.js") || strings.Contains(content, "nextjs"):
		return RuntimeConfig{
			Image:          "sandbox-react",
			Port:           3000,
			StartupCommand: "npm install && npm run dev -- -H 0.0.0.0",
		}, true

	case strings.Contains(content, "vite"):
		return RuntimeConfig{
			Image:          "sandbox-react",
			Port:           5173,
			StartupCommand: "npm install && npm run dev -- --host 0.0.0.0",
		}, true

	case strings.Contains(content, "react"):
		return RuntimeConfig{
			Image:          "sandbox-react",
			Port:           3000,
			StartupCommand: "npm install && HOST=0.0.0.0 npm start",
		}, true

	case strings.Contains(content, "vue"):
		return RuntimeConfig{
			Image:          "sandbox-node",
			Port:           5173,
			StartupCommand: "npm install && npm run dev -- --host 0.0.0.0",
		}, true

	case strings.Contains(content, "fastapi"):
		return RuntimeConfig{
			Image:          "sandbox-python",
			Port:           8000,
			StartupCommand: "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000",
		}, true

	case strings.Contains(content, "flask"):
		return RuntimeConfig{
			Image:          "sandbox-python",
			Port:           5000,
			StartupCommand: "pip install -r requirements.txt && python app.py",
		}, true

	case strings.Contains(content, "django"):
		return RuntimeConfig{
			Image:          "sandbox-python",
			Port:           8000,
			StartupCommand: "pip install -r requirements.txt && python manage.py runserver 0.0.0.0:8000",
		}, true

	case strings.Contains(content, "python"):
		return RuntimeConfig{
			Image:          "sandbox-python",
			Port:           5000,
			StartupCommand: "pip install -r requirements.txt && python main.py",
		}, true

	case strings.Contains(content, "node") || strings.Contains(content, "express"):
		return RuntimeConfig{
			Image:          "sandbox-node",
			Port:           3000,
			StartupCommand: "npm install && HOST=0.0.0.0 npm start",
		}, true

	case strings.Contains(content, "golang") || strings.Contains(content, "go module"):
		return RuntimeConfig{
			Image:          "sandbox-go",
			Port:           8080,
			StartupCommand: "go mod tidy && go run .",
		}, true

	case strings.Contains(content, "rust") || strings.Contains(content, "cargo"):
		return RuntimeConfig{
			Image:          "sandbox-rust",
			Port:           8080,
			StartupCommand: "cargo run",
		}, true
	}

	return RuntimeConfig{}, false
}

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

type RuntimeConfig struct {
	Image          string
	Port           int
	StartupCommand string
}

type PackageJSON struct {
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
	Scripts         map[string]string `json:"scripts"`
}

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func readPackageJSON(path string) (PackageJSON, error) {

	var pkg PackageJSON

	data, err := os.ReadFile(path)

	if err != nil {
		return pkg, err
	}

	err = json.Unmarshal(data, &pkg)

	return pkg, err
}

// ---------------------------------------------------------------------------
// findProjectRoot – walk up to 3 levels deep looking for project marker files
// ---------------------------------------------------------------------------
// Returns (absoluteDir, relativeSubdir).  When the project is at the repo
// root, relativeSubdir is "".
func findProjectRoot(root string) (string, string) {

	// Marker files, ordered by priority
	markers := []string{
		"package.json",
		"requirements.txt",
		"go.mod",
		"Cargo.toml",
		"pom.xml",
		"build.gradle",
		"Gemfile",
		"composer.json",
		"*.csproj",
	}

	// Check root first
	for _, m := range markers {
		matches, _ := filepath.Glob(filepath.Join(root, m))
		if len(matches) > 0 {
			return root, ""
		}
	}

	// Walk up to 3 levels deep, breadth-first-ish
	type candidate struct {
		dir string
		rel string
	}

	queue := []candidate{}

	entries, err := os.ReadDir(root)
	if err != nil {
		return root, ""
	}

	for _, e := range entries {
		if e.IsDir() && !strings.HasPrefix(e.Name(), ".") && e.Name() != "node_modules" && e.Name() != "__pycache__" {
			queue = append(queue, candidate{
				dir: filepath.Join(root, e.Name()),
				rel: e.Name(),
			})
		}
	}

	for depth := 1; depth <= 3 && len(queue) > 0; depth++ {
		var next []candidate

		for _, c := range queue {
			for _, m := range markers {
				matches, _ := filepath.Glob(filepath.Join(c.dir, m))
				if len(matches) > 0 {
					fmt.Printf("[findProjectRoot] found %s at %s\n", m, c.rel)
					return c.dir, c.rel
				}
			}

			// queue children for next depth
			if depth < 3 {
				sub, err := os.ReadDir(c.dir)
				if err != nil {
					continue
				}
				for _, s := range sub {
					if s.IsDir() && !strings.HasPrefix(s.Name(), ".") && s.Name() != "node_modules" && s.Name() != "__pycache__" {
						next = append(next, candidate{
							dir: filepath.Join(c.dir, s.Name()),
							rel: filepath.Join(c.rel, s.Name()),
						})
					}
				}
			}
		}

		queue = next
	}

	return root, ""
}

// prefixSubdir prepends "cd <subdir> && " to a startup command when the
// project root is in a subdirectory.
func prefixSubdir(cmd, subdir string) string {
	if subdir == "" {
		return cmd
	}
	// Use forward slashes for the Docker Linux container
	subdir = strings.ReplaceAll(subdir, "\\", "/")
	return fmt.Sprintf("cd %s && %s", subdir, cmd)
}

// ---------------------------------------------------------------------------
// Node framework detection (unchanged logic, called from detectRuntimeConfig)
// ---------------------------------------------------------------------------

func detectNodeFramework(path string, pkg PackageJSON) RuntimeConfig {

	// Detect Next.js
	if _, ok := pkg.Dependencies["next"]; ok {
		return RuntimeConfig{
			Image:          "sandbox-react",
			Port:           3000,
			StartupCommand: "npm install && npm run dev -- -H 0.0.0.0",
		}
	}

	// Detect Vite
	if _, ok := pkg.DevDependencies["vite"]; ok {
		return RuntimeConfig{
			Image:          "sandbox-react",
			Port:           5173,
			StartupCommand: "npm install && npm run dev -- --host 0.0.0.0",
		}
	}
	if _, ok := pkg.Dependencies["vite"]; ok {
		return RuntimeConfig{
			Image:          "sandbox-react",
			Port:           5173,
			StartupCommand: "npm install && npm run dev -- --host 0.0.0.0",
		}
	}

	// Detect React
	if _, ok := pkg.Dependencies["react"]; ok {

		// Vite / modern React
		if _, ok := pkg.Scripts["dev"]; ok {
			return RuntimeConfig{
				Image:          "sandbox-react",
				Port:           5173,
				StartupCommand: "npm install && npm run dev -- --host 0.0.0.0",
			}
		}

		// CRA / default start
		if _, ok := pkg.Scripts["start"]; ok {
			return RuntimeConfig{
				Image:          "sandbox-react",
				Port:           3000,
				StartupCommand: "npm install && HOST=0.0.0.0 npm start",
			}
		}
	}

	// Generic Node dev script
	if _, ok := pkg.Scripts["dev"]; ok {
		return RuntimeConfig{
			Image:          "sandbox-node",
			Port:           3000,
			StartupCommand: "npm install && npm run dev -- --host 0.0.0.0",
		}
	}

	if _, ok := pkg.Scripts["start"]; ok {
		return RuntimeConfig{
			Image:          "sandbox-node",
			Port:           3000,
			StartupCommand: "npm install && HOST=0.0.0.0 npm start",
		}
	}

	if fileExists(filepath.Join(path, "server.js")) {
		return RuntimeConfig{
			Image:          "sandbox-node",
			Port:           3000,
			StartupCommand: "npm install && node server.js",
		}
	}

	if fileExists(filepath.Join(path, "index.js")) {
		return RuntimeConfig{
			Image:          "sandbox-node",
			Port:           3000,
			StartupCommand: "npm install && node index.js",
		}
	}

	return RuntimeConfig{
		Image:          "sandbox-node",
		Port:           3000,
		StartupCommand: "npm install && npm start",
	}
}

// ---------------------------------------------------------------------------
// Python detection (unchanged)
// ---------------------------------------------------------------------------

func detectPython(path string) RuntimeConfig {

	req := filepath.Join(path, "requirements.txt")

	if fileExists(req) {

		content, _ := os.ReadFile(req)

		txt := string(content)

		if strings.Contains(txt, "fastapi") {

			return RuntimeConfig{
				Image:          "sandbox-python",
				Port:           8000,
				StartupCommand: "pip install -r requirements.txt && uvicorn main:app --host 0.0.0.0 --port 8000",
			}
		}

		if strings.Contains(txt, "flask") {

			return RuntimeConfig{
				Image:          "sandbox-python",
				Port:           5000,
				StartupCommand: "pip install -r requirements.txt && python app.py",
			}
		}
	}

	if fileExists(filepath.Join(path, "manage.py")) {

		return RuntimeConfig{
			Image:          "sandbox-python",
			Port:           8000,
			StartupCommand: "pip install -r requirements.txt && python manage.py runserver 0.0.0.0:8000",
		}
	}

	return RuntimeConfig{
		Image:          "sandbox-python",
		Port:           5000,
		StartupCommand: "pip install -r requirements.txt && python main.py",
	}
}

// ---------------------------------------------------------------------------
// Lyzr Repo detection
// ---------------------------------------------------------------------------

func detectLyzrRepo(path string) (RuntimeConfig, bool) {
	isLyzr := false

	if fileExists(filepath.Join(path, "workflow.json")) {
		isLyzr = true
	} else if fileExists(filepath.Join(path, "response_schemas")) {
		isLyzr = true
	} else if fileExists(filepath.Join(path, "next.config.js")) {
		isLyzr = true
	}

	pkg, err := readPackageJSON(filepath.Join(path, "package.json"))
	if err == nil {
		if _, ok := pkg.Dependencies["next"]; ok {
			isLyzr = true
		}
	}

	if !isLyzr {
		return RuntimeConfig{}, false
	}

	startupCommand := "npm install --no-audit --no-fund && npx next dev -H 0.0.0.0"
	if err == nil {
		if _, ok := pkg.Scripts["dev"]; ok {
			startupCommand = "sed -i 's/-p [0-9]*//g' package.json && npm install --no-audit --no-fund && npm run dev -- -H 0.0.0.0"
		}
	}

	return RuntimeConfig{
		Image:          "sandbox-react",
		Port:           3000,
		StartupCommand: startupCommand,
	}, true
}

// ---------------------------------------------------------------------------
// detectRuntimeConfig – main entry point
// ---------------------------------------------------------------------------
// Priority order:
//  1. Explicit user instructions (INSTRUCTIONS.md or pasted text)
//  2. Lyzr Apps repository detection
//  3. File-based detection at discovered project root (may be nested)
//  4. README/INSTRUCTIONS keyword hints (fallback)
// ---------------------------------------------------------------------------
func detectRuntimeConfig(path string) (RuntimeConfig, error) {

	// ---- 1. Explicit instructions take highest priority ----
	if cfg, ok := detectFromInstructions(path); ok {
		fmt.Println("Runtime detected from INSTRUCTIONS commands")
		return cfg, nil
	}

	// ---- 2. Find the actual project root (may be nested) ----
	projectDir, subdir := findProjectRoot(path)

	if subdir != "" {
		fmt.Printf("Project root found in subdirectory: %s\n", subdir)
	}

	// ---- Lyzr Repository Detection ----
	if cfg, ok := detectLyzrRepo(projectDir); ok {
		fmt.Println("Runtime detected as Lyzr project")
		cfg.StartupCommand = prefixSubdir(cfg.StartupCommand, subdir)
		return cfg, nil
	}

	// ---- 3. File-based detection ----

	if fileExists(filepath.Join(projectDir, "package.json")) {

		pkg, err := readPackageJSON(filepath.Join(projectDir, "package.json"))

		if err == nil {
			cfg := detectNodeFramework(projectDir, pkg)
			cfg.StartupCommand = prefixSubdir(cfg.StartupCommand, subdir)
			return cfg, nil
		}
	}

	if fileExists(filepath.Join(projectDir, "requirements.txt")) {
		cfg := detectPython(projectDir)
		cfg.StartupCommand = prefixSubdir(cfg.StartupCommand, subdir)
		return cfg, nil
	}

	if fileExists(filepath.Join(projectDir, "go.mod")) {
		cfg := RuntimeConfig{
			Image:          "sandbox-go",
			Port:           8080,
			StartupCommand: "go mod tidy && go run .",
		}
		cfg.StartupCommand = prefixSubdir(cfg.StartupCommand, subdir)
		return cfg, nil
	}

	if fileExists(filepath.Join(projectDir, "Cargo.toml")) {
		cfg := RuntimeConfig{
			Image:          "sandbox-rust",
			Port:           8080,
			StartupCommand: "cargo run",
		}
		cfg.StartupCommand = prefixSubdir(cfg.StartupCommand, subdir)
		return cfg, nil
	}

	if fileExists(filepath.Join(projectDir, "index.html")) {
		cfg := RuntimeConfig{
			Image:          "sandbox-static",
			Port:           80,
			StartupCommand: "nginx -g \"daemon off;\"",
		}
		cfg.StartupCommand = prefixSubdir(cfg.StartupCommand, subdir)
		return cfg, nil
	}

	// ---- 4. Fallback: README/INSTRUCTIONS keyword matching ----
	if hint, ok := readDocHint(path); ok {
		fmt.Println("Runtime detected from README/INSTRUCTIONS keyword match")
		return hint, nil
	}

	return RuntimeConfig{}, fmt.Errorf("unable to detect runtime")
}