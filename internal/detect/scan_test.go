package detect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sandbox/internal/core"
)

// The regression that matters most: making detection multi-service must not turn an
// ordinary single-stack repo into several.
func TestScanSingleStackStaysOneService(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "package.json", `{"dependencies":{"next":"14"},"scripts":{"dev":"next dev"}}`)
	write(t, dir, "app/page.tsx", "export default function Page(){return null}")

	plan, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Services) != 1 {
		t.Fatalf("got %d services, want 1: %+v", len(plan.Services), plan.Services)
	}
	if plan.Image != "sandbox-react" {
		t.Errorf("Image = %q, want the prebuilt sandbox-react, not a composite", plan.Image)
	}
	if plan.Services[0].Framework != "Next.js" {
		t.Errorf("Framework = %q", plan.Services[0].Framework)
	}
	if !plan.Services[0].Primary || !plan.Services[0].Enabled {
		t.Error("the only service must be primary and enabled")
	}
}

func TestScanMonorepoFindsBothServices(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "frontend/package.json", `{"dependencies":{"next":"14"},"scripts":{"dev":"next dev"}}`)
	write(t, dir, "backend/manage.py", managePy("config.settings"))
	write(t, dir, "backend/requirements.txt", "django\n")
	write(t, dir, "backend/config/settings.py", "")
	write(t, dir, "backend/config/wsgi.py", "")

	plan, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Services) != 2 {
		t.Fatalf("got %d services, want 2: %+v", len(plan.Services), plan.Services)
	}

	got := map[string]string{}
	for _, s := range plan.Services {
		got[s.Name] = s.Stack
	}
	if got["frontend"] != "react" || got["backend"] != "django" {
		t.Errorf("stacks = %v, want frontend:react backend:django", got)
	}

	// Two toolchains means a merged image, named from the sorted stack list.
	if plan.Image != "sandbox-multi-django-react" {
		t.Errorf("Image = %q, want sandbox-multi-django-react", plan.Image)
	}

	// The preview should land on the UI, not the API.
	p, _ := plan.Primary()
	if p.Name != "frontend" {
		t.Errorf("primary = %q, want frontend", p.Name)
	}
}

// A workspace root holds tooling, not an app.
func TestScanSkipsWorkspaceRoot(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "package.json", `{"workspaces":["apps/*"],"scripts":{"dev":"turbo dev"}}`)
	write(t, dir, "turbo.json", `{"pipeline":{}}`)
	write(t, dir, "apps/web/package.json", `{"dependencies":{"next":"14"},"scripts":{"dev":"next dev"}}`)
	write(t, dir, "apps/api/package.json", `{"scripts":{"start":"node server.js"}}`)

	plan, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	for _, s := range plan.Services {
		if s.Dir == "" {
			t.Fatalf("the workspace root was claimed as a service: %+v", plan.Services)
		}
	}
	if len(plan.Services) != 2 {
		t.Fatalf("got %d services, want 2: %+v", len(plan.Services), plan.Services)
	}
}

// One container cannot give two apps the same port.
func TestScanResolvesPortCollisions(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "admin/package.json", `{"dependencies":{"next":"14"},"scripts":{"dev":"next dev"}}`)
	write(t, dir, "site/package.json", `{"dependencies":{"next":"14"},"scripts":{"dev":"next dev"}}`)

	plan, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Services) != 2 {
		t.Fatalf("got %d services, want 2", len(plan.Services))
	}

	seen := map[int]string{}
	for _, s := range plan.Services {
		if prev, dup := seen[s.ContainerPort]; dup {
			t.Fatalf("%s and %s both bound port %d", prev, s.Name, s.ContainerPort)
		}
		seen[s.ContainerPort] = s.Name
	}

	// The bumped service must actually be told about its new port.
	for _, s := range plan.Services {
		if s.ContainerPort != 3000 && !strings.Contains(s.Start, "-p 3001") {
			t.Errorf("%s moved to %d but its command still says: %s", s.Name, s.ContainerPort, s.Start)
		}
	}
}

// The shape most real Django+JS repos use: the JS app is the repo root and the
// Python half sits in a subdirectory. The root must not swallow it.
func TestScanFindsBackendUnderAJavaScriptRoot(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "package.json", `{"dependencies":{"vite":"5"},"scripts":{"dev":"vite"}}`)
	write(t, dir, "backend/manage.py", managePy("config.settings"))
	write(t, dir, "backend/requirements.txt", "django\n")
	write(t, dir, "backend/config/settings.py", "")
	write(t, dir, "backend/config/wsgi.py", "")

	plan, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Services) != 2 {
		t.Fatalf("got %d services, want 2: %+v", len(plan.Services), plan.Services)
	}
	if plan.Image != "sandbox-multi-django-react" {
		t.Errorf("Image = %q, want sandbox-multi-django-react", plan.Image)
	}
}

// A matched directory owns its subtree — components are not services.
func TestScanDoesNotDescendIntoAService(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "web/package.json", `{"dependencies":{"next":"14"},"scripts":{"dev":"next dev"}}`)
	write(t, dir, "web/functions/package.json", `{"scripts":{"start":"node index.js"}}`)

	plan, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Services) != 1 {
		t.Fatalf("got %d services, want 1: %+v", len(plan.Services), plan.Services)
	}
}

// A worker has no HTTP port, and must not be handed one.
func TestScanWorkerHasNoPort(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "api/manage.py", managePy("config.settings"))
	write(t, dir, "api/requirements.txt", "django\n")
	write(t, dir, "api/config/settings.py", "")
	write(t, dir, "api/config/wsgi.py", "")
	write(t, dir, "worker/requirements.txt", "celery\n")
	write(t, dir, "worker/worker.py", "print('working')")

	plan, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	var worker core.Service
	for _, s := range plan.Services {
		if s.Name == "worker" {
			worker = s
		}
	}
	if worker.Name == "" {
		t.Fatalf("worker service not found: %+v", plan.Services)
	}
	if worker.ContainerPort != 0 {
		t.Errorf("worker got port %d, want none", worker.ContainerPort)
	}
	if worker.Primary {
		t.Error("a portless worker must never be the preview target")
	}
	if !strings.Contains(worker.Start, "worker.py") {
		t.Errorf("worker start = %q", worker.Start)
	}
}

// A bare manifest is not an app: a Django repo keeps requirements.txt at the root
// while the project lives a level down.
func TestScanIgnoresManifestOnlyRoot(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "requirements.txt", "django\n")
	write(t, dir, "src/manage.py", managePy("config.settings"))
	write(t, dir, "src/config/settings.py", "")
	write(t, dir, "src/config/wsgi.py", "")

	plan, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Services) != 1 || plan.Services[0].Dir != "src" {
		t.Fatalf("want one service in src/, got %+v", plan.Services)
	}
}

// INSTRUCTIONS.md still outranks the walk.
func TestScanInstructionsWin(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "INSTRUCTIONS.md", "npm install\nnpm run dev\n")
	write(t, dir, "backend/manage.py", managePy("config.settings"))

	plan, err := Scan(dir)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Services) != 1 {
		t.Fatalf("got %d services, want 1", len(plan.Services))
	}
	if plan.Services[0].Install != "npm install" {
		t.Errorf("Install = %q, want the install split off from the run command", plan.Services[0].Install)
	}
	if !strings.Contains(plan.Services[0].Start, "npm run dev") {
		t.Errorf("Start = %q", plan.Services[0].Start)
	}
}

func TestSplitInstall(t *testing.T) {
	cases := []struct{ in, install, start string }{
		{"npm install && npm run dev", "npm install", "npm run dev"},
		{"pip install -r r.txt && python app.py", "pip install -r r.txt", "python app.py"},
		{"go mod tidy && go run .", "go mod tidy", "go run ."},
		{"npm start", "", "npm start"},
		// Every step is an install: there is no long-running command to split off.
		{"npm install", "", "npm install"},
		{"pip install -r r.txt && (python manage.py migrate || true) && python manage.py runserver",
			"pip install -r r.txt", "(python manage.py migrate || true) && python manage.py runserver"},
	}
	for _, c := range cases {
		gi, gs := splitInstall(c.in)
		if gi != c.install || gs != c.start {
			t.Errorf("splitInstall(%q) = (%q, %q), want (%q, %q)", c.in, gi, gs, c.install, c.start)
		}
	}
}

// sandbox-static is nginx:alpine with no python, so the start command must not assume one server.
func TestStaticSiteStartWorksWithoutPython(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "index.html"), []byte("<h1>hi</h1>"), 0o644)
	plan, err := Scan(dir)
	if err != nil || len(plan.Services) != 1 {
		t.Fatalf("scan: %v %+v", err, plan)
	}
	start := plan.Services[0].Start
	for _, want := range []string{"command -v nginx", "listen 8080", "root /workspace", "python3 -m http.server 8080", "busybox httpd -f -p 8080"} {
		if !strings.Contains(start, want) {
			t.Errorf("static start lacks %q: %s", want, start)
		}
	}
	svc := plan.Services[0]
	if moved := bindPort(svc, 9090); !strings.Contains(moved, "listen 9090") || strings.Contains(moved, "8080") {
		t.Errorf("port edit did not move every server: %s", moved)
	}
}
