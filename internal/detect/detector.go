package detect

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"sandbox/internal/core"
)

// detectFromInstructions – accept ANY bash commands from INSTRUCTIONS.md --------------------------------------------------------------------------- Reads INSTRUCTIONS.md (or the text pasted in the UI).
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

		// skip lines that look like prose (contain multiple spaces between words and no obvious command keyword)
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
		} else if strings.Contains(allLower, "django") || strings.Contains(allLower, "manage.py") {
			image = "sandbox-django"
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

	// The node image has no bun binary; matched as a word so "bundle install" is not caught.
	case bunCommand.MatchString(allLower):
		image = "sandbox-bun"
		port = 3000

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

// looksLikeProse returns true if the line looks like descriptive text rather than a shell command.
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

// readDocHint – scan README/INSTRUCTIONS for runtime keywords (unchanged)
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
			Image:          "sandbox-django",
			Port:           8000,
			StartupCommand: "pip install -r requirements.txt && (python manage.py migrate --noinput || true) && python manage.py runserver 0.0.0.0:8000",
			Framework:      "Django",
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

// Core types

type RuntimeConfig struct {
	Image          string
	Port           int
	StartupCommand string
	Framework      string // human-friendly label shown in the IDE, e.g. "Next.js"
}

type PackageJSON struct {
	Dependencies    map[string]string `json:"dependencies"`
	DevDependencies map[string]string `json:"devDependencies"`
	Scripts         map[string]string `json:"scripts"`
}

// Utility helpers

func readPackageJSON(path string) (PackageJSON, error) {

	var pkg PackageJSON

	data, err := os.ReadFile(path)

	if err != nil {
		return pkg, err
	}

	err = json.Unmarshal(data, &pkg)

	return pkg, err
}

// findProjectRoot – walk up to 3 levels deep looking for project marker files --------------------------------------------------------------------------- Returns (absoluteDir, relativeSubdir).
func findProjectRoot(root string) (string, string) {

	// Marker files, ordered by priority
	markers := []string{
		"package.json",
		"requirements.txt",
		"manage.py",
		"pyproject.toml",
		"Pipfile",
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

// NormalizeInstall speeds up dependency installs in the startup command.
func NormalizeInstall(cmd string) string {
	if strings.Contains(cmd, "npm install") && !strings.Contains(cmd, "--no-audit") {
		cmd = strings.Replace(cmd, "npm install",
			"npm install --prefer-offline --no-audit --no-fund --progress=false --loglevel=error", 1)
	}
	if strings.Contains(cmd, "pip install") && !strings.Contains(cmd, "--no-input") {
		cmd = strings.Replace(cmd, "pip install",
			"pip install --no-input --disable-pip-version-check", 1)
	}
	return cmd
}

// Lyzr Repo detection

func detectLyzrRepo(path string) (RuntimeConfig, bool) {
	isLyzr := false

	if core.FileExists(filepath.Join(path, "workflow.json")) {
		isLyzr = true
	} else if core.FileExists(filepath.Join(path, "response_schemas")) {
		isLyzr = true
	}

	if !isLyzr {
		return RuntimeConfig{}, false
	}

	pkg, err := readPackageJSON(filepath.Join(path, "package.json"))

	// Lyzr apps are Next.js projects.
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
		Framework:      "Next.js (Lyzr App)",
	}, true
}

// FrameworkFromImage gives a friendly framework label for the IDE when a more specific one wasn't set during detection.
func FrameworkFromImage(image string) string {
	switch image {
	case "sandbox-react":
		return "React"
	case "sandbox-node":
		return "Node.js"
	case "sandbox-python":
		return "Python"
	case "sandbox-django":
		return "Django"
	case "sandbox-go":
		return "Go"
	case "sandbox-java":
		return "Java"
	case "sandbox-php":
		return "PHP"
	case "sandbox-ruby":
		return "Ruby"
	case "sandbox-rust":
		return "Rust"
	case "sandbox-dotnet":
		return ".NET"
	case "sandbox-deno":
		return "Deno"
	case "sandbox-bun":
		return "Bun"
	case "sandbox-static":
		return "Static site"
	default:
		return strings.TrimPrefix(image, "sandbox-")
	}
}

var errNoRuntime = errors.New("unable to detect runtime")

var bunCommand = regexp.MustCompile(`\bbunx?\b`)
