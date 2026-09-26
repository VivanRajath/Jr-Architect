package detect

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"

	"sandbox/internal/core"
)

const maxScanDepth = 3

// Scan walks the clone and returns every service it can run, keeping the priority
// order Runtime has always used: explicit instructions, then Lyzr, then the file
// walk, then README keywords.
func Scan(root string) (core.Plan, error) {
	if cfg, ok := detectFromInstructions(root); ok {
		return singlePlan(serviceFromConfig(cfg, "")), nil
	}

	projectDir, subdir := findProjectRoot(root)
	if cfg, ok := detectLyzrRepo(projectDir); ok {
		return singlePlan(serviceFromConfig(cfg, subdir)), nil
	}

	if svcs := walk(root); len(svcs) > 0 {
		return buildPlan(svcs), nil
	}

	if cfg, ok := readDocHint(root); ok {
		return singlePlan(serviceFromConfig(cfg, "")), nil
	}

	return core.Plan{}, errNoRuntime
}

// Breadth-first so a service directory is found before anything nested inside it,
// which is what lets a match swallow its own subtree.
func walk(root string) []core.Service {
	// owner is the toolchain of the nearest enclosing service, so a match can tell
	// a subproject of that service from a separate app.
	type candidate struct{ dir, rel, owner string }
	queue := []candidate{{root, "", ""}}
	var found []core.Service

	for depth := 0; depth <= maxScanDepth && len(queue) > 0; depth++ {
		var next []candidate
		for _, c := range queue {
			owner := c.owner
			if svc, ok := classify(root, c.dir, c.rel); ok {
				// A directory inside a service that runs the same toolchain is part of
				// that project (components, cloud functions), not a second app. A
				// different toolchain is: repos put a Django backend under a JS root.
				if c.owner == "" || core.Toolchain(svc.Stack) != c.owner {
					found = append(found, svc)
				}
				owner = core.Toolchain(svc.Stack)
			}
			if depth == maxScanDepth {
				continue
			}
			entries, err := os.ReadDir(c.dir)
			if err != nil {
				continue
			}
			for _, e := range entries {
				if !e.IsDir() || skipDir(e.Name()) {
					continue
				}
				next = append(next, candidate{filepath.Join(c.dir, e.Name()), joinRel(c.rel, e.Name()), owner})
			}
		}
		queue = next
	}
	return found
}

// classify turns one directory into a service. Django outranks the generic Python
// branch, and a workspace root is deliberately not a service so its members are.
func classify(root, dir, rel string) (core.Service, bool) {
	if core.FileExists(filepath.Join(dir, "manage.py")) {
		return djangoService(root, dir, rel), true
	}

	if core.FileExists(filepath.Join(dir, "package.json")) && !isWorkspaceRoot(dir) {
		pkg, err := readPackageJSON(filepath.Join(dir, "package.json"))
		if err == nil && runnableNode(dir, pkg) {
			return nodeService(dir, rel, pkg), true
		}
	}

	if hasPythonManifest(dir) && runnablePython(dir) {
		return pythonService(dir, rel), true
	}

	for _, m := range simpleStacks {
		if !matchesMarker(dir, m.Marker) {
			continue
		}
		return core.Service{
			Name:          serviceName(rel),
			Dir:           rel,
			Stack:         m.Stack,
			Framework:     m.Framework,
			ContainerPort: m.Port,
			Install:       m.Install,
			Start:         m.Start,
		}, true
	}

	// Only at the root: a stray index.html deeper in a repo is a fixture, not a site.
	if rel == "" && core.FileExists(filepath.Join(dir, "index.html")) {
		return core.Service{
			Name:          serviceName(rel),
			Dir:           rel,
			Stack:         "static",
			Framework:     "Static site",
			ContainerPort: 8080,
			Start:         staticStart(8080),
		}, true
	}

	return core.Service{}, false
}

// sandbox-static is nginx:alpine with no python, and a composite image may have only one of the three.
func staticStart(port int) string {
	p := strconv.Itoa(port)
	return "if command -v nginx >/dev/null; then " +
		"printf 'server { listen " + p + "; root /workspace; index index.html; }\\n' > /etc/nginx/conf.d/default.conf && exec nginx -g 'daemon off;'; " +
		"elif command -v python3 >/dev/null; then exec python3 -m http.server " + p + " --bind 0.0.0.0; " +
		"else exec busybox httpd -f -p " + p + " -h /workspace; fi"
}

// Stacks whose whole story is "this marker file means this command".
var simpleStacks = []struct {
	Marker, Stack, Framework, Install, Start string
	Port                                     int
}{
	{Marker: "go.mod", Stack: "go", Framework: "Go", Install: "go mod tidy", Start: "go run .", Port: 8080},
	{Marker: "Cargo.toml", Stack: "rust", Framework: "Rust", Install: "cargo fetch", Start: "cargo run", Port: 8080},
	{Marker: "Gemfile", Stack: "ruby", Framework: "Ruby", Install: "bundle install", Start: "bundle exec rackup --host 0.0.0.0 --port 9292", Port: 9292},
	{Marker: "composer.json", Stack: "php", Framework: "PHP", Install: "composer install", Start: "php -S 0.0.0.0:8080", Port: 8080},
	{Marker: "pom.xml", Stack: "java", Framework: "Java (Maven)", Install: "mvn -q -B dependency:go-offline", Start: "mvn -q spring-boot:run", Port: 8080},
	{Marker: "build.gradle", Stack: "java", Framework: "Java (Gradle)", Start: "./gradlew bootRun", Port: 8080},
	{Marker: "deno.json", Stack: "deno", Framework: "Deno", Start: "deno task start", Port: 8000},
	{Marker: "*.csproj", Stack: "dotnet", Framework: ".NET", Install: "dotnet restore", Start: "dotnet run --urls http://0.0.0.0:5000", Port: 5000},
}

// A manifest on its own is not a service — a Django repo keeps requirements.txt at
// the root while the app lives a level down, and claiming the root there would
// swallow the real project.
func runnableNode(dir string, pkg PackageJSON) bool {
	return has(pkg.Scripts, "dev") || has(pkg.Scripts, "start") ||
		core.FileExists(filepath.Join(dir, "server.js")) ||
		core.FileExists(filepath.Join(dir, "index.js"))
}

func runnablePython(dir string) bool {
	for _, n := range []string{"main.py", "app.py", "wsgi.py", "asgi.py", "worker.py", "run.py", "server.py"} {
		if core.FileExists(filepath.Join(dir, n)) {
			return true
		}
	}
	return false
}

func hasPythonManifest(dir string) bool {
	return core.FileExists(filepath.Join(dir, "requirements.txt")) ||
		core.FileExists(filepath.Join(dir, "pyproject.toml")) ||
		core.FileExists(filepath.Join(dir, "Pipfile"))
}

func matchesMarker(dir, marker string) bool {
	if strings.ContainsAny(marker, "*?") {
		m, _ := filepath.Glob(filepath.Join(dir, marker))
		return len(m) > 0
	}
	return core.FileExists(filepath.Join(dir, marker))
}

// A workspace root holds tooling, not an app — its members are the services.
func isWorkspaceRoot(dir string) bool {
	if core.FileExists(filepath.Join(dir, "pnpm-workspace.yaml")) ||
		core.FileExists(filepath.Join(dir, "turbo.json")) ||
		core.FileExists(filepath.Join(dir, "lerna.json")) ||
		core.FileExists(filepath.Join(dir, "nx.json")) {
		return true
	}
	data, err := os.ReadFile(filepath.Join(dir, "package.json"))
	if err != nil {
		return false
	}
	var probe struct {
		Workspaces json.RawMessage `json:"workspaces"`
	}
	if json.Unmarshal(data, &probe) != nil {
		return false
	}
	return len(probe.Workspaces) > 0
}

func djangoService(root, dir, rel string) core.Service {
	p := newDjangoProject(dir, rel)

	var steps []string
	if mod := writeSandboxSettings(p); mod != "" {
		// Exported, not --settings, so migrate, runserver and the terminal agree.
		steps = append(steps, "export DJANGO_SETTINGS_MODULE="+mod)
	}
	// Migrate must not gate the boot — a Postgres-backed repo fails here.
	steps = append(steps, "(python manage.py migrate --noinput || true)")
	steps = append(steps, "python manage.py runserver 0.0.0.0:8000")

	framework := "Django"
	if rel != "" {
		framework = "Django (" + rel + ")"
	}

	return core.Service{
		Name:          serviceName(rel),
		Dir:           rel,
		Stack:         "django",
		Framework:     framework,
		ContainerPort: 8000,
		Install:       djangoInstallCommand(root, p),
		Start:         strings.Join(steps, " && "),
	}
}

func nodeService(dir, rel string, pkg PackageJSON) core.Service {
	svc := core.Service{Name: serviceName(rel), Dir: rel, Stack: "react", ContainerPort: 3000}

	switch {
	case has(pkg.Dependencies, "next"):
		svc.Framework, svc.Start = "Next.js", "npm run dev -- -H 0.0.0.0"
	case has(pkg.DevDependencies, "vite"), has(pkg.Dependencies, "vite"):
		svc.Framework, svc.Start, svc.ContainerPort = "React (Vite)", "npm run dev -- --host 0.0.0.0", 5173
	case has(pkg.Dependencies, "react") && has(pkg.Scripts, "dev"):
		svc.Framework, svc.Start, svc.ContainerPort = "React (Vite)", "npm run dev -- --host 0.0.0.0", 5173
	case has(pkg.Dependencies, "react") && has(pkg.Scripts, "start"):
		svc.Framework, svc.Start = "React (CRA)", "HOST=0.0.0.0 npm start"
	case has(pkg.Scripts, "dev"):
		svc.Stack, svc.Framework, svc.Start = "node", "Node.js", "npm run dev"
	case has(pkg.Scripts, "start"):
		svc.Stack, svc.Framework, svc.Start = "node", "Node.js", "HOST=0.0.0.0 npm start"
	case core.FileExists(filepath.Join(dir, "server.js")):
		svc.Stack, svc.Framework, svc.Start = "node", "Node.js", "node server.js"
	case core.FileExists(filepath.Join(dir, "index.js")):
		svc.Stack, svc.Framework, svc.Start = "node", "Node.js", "node index.js"
	default:
		svc.Stack, svc.Framework, svc.Start = "node", "Node.js", "npm start"
	}

	svc.Install = "npm install"
	if !core.FileExists(filepath.Join(dir, "package-lock.json")) &&
		core.FileExists(filepath.Join(dir, "pnpm-lock.yaml")) {
		svc.Install = "corepack enable && pnpm install"
	}
	return svc
}

func pythonService(dir, rel string) core.Service {
	svc := core.Service{
		Name:      serviceName(rel),
		Dir:       rel,
		Stack:     "python",
		Framework: "Python",
		Install:   "pip install -r requirements.txt",
	}
	if !core.FileExists(filepath.Join(dir, "requirements.txt")) {
		svc.Install = "pip install ."
	}

	body, _ := os.ReadFile(filepath.Join(dir, "requirements.txt"))
	txt := strings.ToLower(string(body))

	switch {
	case strings.Contains(txt, "fastapi"):
		svc.Framework, svc.ContainerPort = "FastAPI", 8000
		svc.Start = "uvicorn " + uvicornTarget(dir) + " --host 0.0.0.0 --port 8000"
	case strings.Contains(txt, "flask"):
		svc.Framework, svc.ContainerPort = "Flask", 5000
		svc.Start = "python " + firstExisting(dir, "app.py", "main.py", "wsgi.py")
	default:
		// No web framework in the manifest: a worker, so it gets no port.
		svc.Start = "python " + firstExisting(dir, "main.py", "app.py", "worker.py", "run.py")
	}
	return svc
}

func uvicornTarget(dir string) string {
	for _, c := range []struct{ file, target string }{
		{"main.py", "main:app"}, {"app.py", "app:app"}, {"app/main.py", "app.main:app"},
	} {
		if core.FileExists(filepath.Join(dir, filepath.FromSlash(c.file))) {
			return c.target
		}
	}
	return "main:app"
}

func firstExisting(dir string, names ...string) string {
	for _, n := range names {
		if core.FileExists(filepath.Join(dir, n)) {
			return n
		}
	}
	return names[0]
}

func has[V any](m map[string]V, key string) bool {
	_, ok := m[key]
	return ok
}

// The directory name is the service name; nested paths keep their parent so two
// dirs called "api" stay distinguishable.
func serviceName(rel string) string {
	if rel == "" {
		return "app"
	}
	return strings.ReplaceAll(rel, "/", "-")
}

func buildPlan(svcs []core.Service) core.Plan {
	sort.SliceStable(svcs, func(i, j int) bool {
		di, dj := depth(svcs[i].Dir), depth(svcs[j].Dir)
		if di != dj {
			return di < dj
		}
		return svcs[i].Dir < svcs[j].Dir
	})

	assignPorts(svcs)

	best := -1
	for i := range svcs {
		svcs[i].Enabled = true
		if svcs[i].ContainerPort == 0 {
			continue
		}
		if best < 0 || webRank(svcs[i]) < webRank(svcs[best]) {
			best = i
		}
	}
	if best < 0 {
		best = 0
	}
	if len(svcs) > 0 {
		svcs[best].Primary = true
	}

	stacks := uniqueStacks(svcs)
	return core.Plan{Services: svcs, Stacks: stacks, Image: core.ImageForStacks(stacks)}
}

// Two apps in one container cannot both hold :3000, so later claimants move up.
func assignPorts(svcs []core.Service) {
	taken := map[int]bool{}
	for i := range svcs {
		if svcs[i].ContainerPort == 0 {
			continue
		}
		want := svcs[i].ContainerPort
		for taken[want] {
			want++
		}
		taken[want] = true
		if want != svcs[i].ContainerPort {
			svcs[i].Start = bindPort(svcs[i], want)
			svcs[i].ContainerPort = want
		}
	}
}

// Rewrite the port the start command binds to. Each family names it differently,
// and PORT alone is not enough — Vite and runserver both ignore it.
func bindPort(svc core.Service, port int) string {
	p := strconv.Itoa(port)
	start := svc.Start

	switch {
	case strings.Contains(start, "runserver"):
		return strings.Replace(start, "0.0.0.0:8000", "0.0.0.0:"+p, 1)
	case strings.Contains(start, "uvicorn"):
		return strings.Replace(start, "--port 8000", "--port "+p, 1)
	case strings.Contains(start, "--host 0.0.0.0") && !strings.Contains(start, "--port"):
		return start + " --port " + p
	case strings.Contains(start, "-H 0.0.0.0") && !strings.Contains(start, "-p "):
		return start + " -p " + p
	case strings.Contains(start, "php -S"):
		return strings.Replace(start, "0.0.0.0:8080", "0.0.0.0:"+p, 1)
	case start == staticStart(8080):
		return staticStart(port)
	case strings.Contains(start, "http.server"):
		return strings.Replace(start, "http.server 8080", "http.server "+p, 1)
	case strings.Contains(start, "--urls"):
		return strings.Replace(start, ":5000", ":"+p, 1)
	}
	return "PORT=" + p + " " + start
}

// Lower sorts first: the preview should open a real UI, not an API.
func webRank(s core.Service) int {
	switch {
	case strings.HasPrefix(s.Framework, "Next.js"), strings.HasPrefix(s.Framework, "React"):
		return 0
	case strings.HasPrefix(s.Framework, "Django"):
		return 1
	case s.Stack == "static":
		return 2
	default:
		return 3
	}
}

func depth(rel string) int {
	if rel == "" {
		return 0
	}
	return strings.Count(rel, "/") + 1
}

func uniqueStacks(svcs []core.Service) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range svcs {
		if s.Stack == "" || seen[s.Stack] {
			continue
		}
		seen[s.Stack] = true
		out = append(out, s.Stack)
	}
	sort.Strings(out)
	return out
}

func singlePlan(svc core.Service) core.Plan {
	svc.Primary = true
	svc.Enabled = true
	stacks := uniqueStacks([]core.Service{svc})
	return core.Plan{Services: []core.Service{svc}, Stacks: stacks, Image: core.ImageForStacks(stacks)}
}

// The legacy detectors hand back one composed command; split it so the multi-service
// runner can still install everything before starting anything.
func serviceFromConfig(cfg RuntimeConfig, subdir string) core.Service {
	install, start := splitInstall(cfg.StartupCommand)
	framework := cfg.Framework
	if framework == "" {
		framework = FrameworkFromImage(cfg.Image)
	}
	return core.Service{
		Name:          serviceName(filepath.ToSlash(subdir)),
		Dir:           filepath.ToSlash(subdir),
		Stack:         core.ImageToStack(cfg.Image),
		Framework:     framework,
		ContainerPort: cfg.Port,
		Install:       install,
		Start:         start,
	}
}

// Only the leading install steps move; everything from the first non-install step
// onward is the command that has to keep running.
func splitInstall(cmd string) (string, string) {
	parts := strings.Split(cmd, " && ")
	cut := 0
	for cut < len(parts) && isInstallStep(parts[cut]) {
		cut++
	}
	if cut == 0 || cut == len(parts) {
		return "", cmd
	}
	return strings.Join(parts[:cut], " && "), strings.Join(parts[cut:], " && ")
}

func isInstallStep(step string) bool {
	s := strings.ToLower(strings.TrimSpace(step))
	for _, p := range []string{"npm install", "npm ci", "pnpm install", "yarn install", "pip install",
		"bundle install", "composer install", "dotnet restore", "go mod tidy", "cargo fetch",
		"corepack enable", "sed -i"} {
		if strings.HasPrefix(s, p) {
			return true
		}
	}
	return false
}
