package detect

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sandbox/internal/core"
)

// managePy is the stock Django manage.py, trimmed to the part detection reads.
func managePy(settings string) string {
	return `#!/usr/bin/env python
import os
import sys

def main():
    os.environ.setdefault('DJANGO_SETTINGS_MODULE', '` + settings + `')
    from django.core.management import execute_from_command_line
    execute_from_command_line(sys.argv)

if __name__ == '__main__':
    main()
`
}

func write(t *testing.T, dir, rel, body string) {
	t.Helper()
	p := filepath.Join(dir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(p), 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(p, []byte(body), 0644); err != nil {
		t.Fatal(err)
	}
}

func TestDjangoSettingsModule(t *testing.T) {
	cases := map[string]string{
		managePy("config.settings"):            "config.settings",
		managePy("mysite.settings.production"): "mysite.settings.production",
		// Double quotes, as newer django-admin emits.
		`os.environ.setdefault("DJANGO_SETTINGS_MODULE", "shop.settings")`: "shop.settings",
		// Extra whitespace around the separator.
		`os.environ.setdefault('DJANGO_SETTINGS_MODULE' ,  'a.b')`: "a.b",
		// Not a Django manage.py at all.
		"print('hello')": "",
	}
	for src, want := range cases {
		if got := DjangoSettingsModule(src); got != want {
			t.Errorf("DjangoSettingsModule(%.40q) = %q, want %q", src, got, want)
		}
	}
}

// The module is often not <projectname>.settings — find it by contents, not name.
func TestFindSettingsPackage(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "manage.py", "print('no settings module named here')")
	write(t, dir, "blog/models.py", "")   // an ordinary app — must not win
	write(t, dir, "core/settings.py", "") // has settings.py ...
	write(t, dir, "core/wsgi.py", "")     // ... and wsgi.py, so this is the config package
	write(t, dir, "blog/templates/x.html", "")

	if got := findSettingsPackage(dir); got != "core.settings" {
		t.Errorf("findSettingsPackage = %q, want core.settings", got)
	}
}

// Import then override — the other order shadows the overrides and still 400s.
func TestSandboxSettingsSource(t *testing.T) {
	src := sandboxSettingsSource("config.settings")

	imp := strings.Index(src, "from config.settings import *")
	hosts := strings.Index(src, `ALLOWED_HOSTS = ["*"]`)
	if imp < 0 {
		t.Fatal("generated settings never imports the app's own module")
	}
	if hosts < 0 {
		t.Fatal("generated settings does not override ALLOWED_HOSTS")
	}
	if imp > hosts {
		t.Error("the star-import comes after the overrides — it would shadow them")
	}
	if !strings.Contains(src, "DEBUG = True") {
		t.Error("generated settings does not force DEBUG on")
	}
	// The SECRET_KEY fallback must only fill a gap, never replace a real key.
	if !strings.Contains(src, `if not globals().get("SECRET_KEY")`) {
		t.Error("SECRET_KEY fallback is unconditional")
	}
}

func TestWriteSandboxSettings(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "manage.py", managePy("config.settings"))
	p := newDjangoProject(dir, "")

	if got := writeSandboxSettings(p); got != SandboxSettingsModule {
		t.Fatalf("writeSandboxSettings = %q, want %q", got, SandboxSettingsModule)
	}
	body, err := os.ReadFile(filepath.Join(dir, SandboxSettingsModule+".py"))
	if err != nil {
		t.Fatalf("generated module not written: %v", err)
	}
	if !strings.Contains(string(body), "from config.settings import *") {
		t.Error("generated module does not import the detected settings")
	}

	// Nothing to star-import means no shim, not a module that crashes on import.
	if got := writeSandboxSettings(djangoProject{Dir: dir}); got != "" {
		t.Errorf("writeSandboxSettings with no settings module = %q, want empty", got)
	}
}

func TestDjangoInstallCommand(t *testing.T) {
	t.Run("requirements beside manage.py wins over the root", func(t *testing.T) {
		dir := t.TempDir()
		write(t, dir, "requirements.txt", "black\n")
		write(t, dir, "api/manage.py", managePy("config.settings"))
		write(t, dir, "api/requirements.txt", "django\n")
		p := newDjangoProject(filepath.Join(dir, "api"), "api")

		if got := djangoInstallCommand(dir, p); got != "pip install -r requirements.txt" {
			t.Errorf("got %q", got)
		}
	})

	// The install runs from the service directory, so a root manifest is "../".
	t.Run("falls back to the root manifest", func(t *testing.T) {
		dir := t.TempDir()
		write(t, dir, "requirements.txt", "django\n")
		write(t, dir, "api/manage.py", managePy("config.settings"))
		p := newDjangoProject(filepath.Join(dir, "api"), "api")

		if got := djangoInstallCommand(dir, p); got != "pip install -r ../requirements.txt" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("prefers a dev requirements file over base", func(t *testing.T) {
		dir := t.TempDir()
		write(t, dir, "manage.py", managePy("config.settings"))
		write(t, dir, "requirements/base.txt", "django\n")
		write(t, dir, "requirements/dev.txt", "-r base.txt\n")
		p := newDjangoProject(dir, "")

		if got := djangoInstallCommand(dir, p); got != "pip install -r requirements/dev.txt" {
			t.Errorf("got %q", got)
		}
	})

	t.Run("pyproject installs the project", func(t *testing.T) {
		dir := t.TempDir()
		write(t, dir, "manage.py", managePy("config.settings"))
		write(t, dir, "pyproject.toml", "[project]\nname='x'\n")
		p := newDjangoProject(dir, "")

		if got := djangoInstallCommand(dir, p); got != "pip install ." {
			t.Errorf("got %q", got)
		}
	})

	t.Run("no manifest installs nothing", func(t *testing.T) {
		dir := t.TempDir()
		write(t, dir, "manage.py", managePy("config.settings"))
		p := newDjangoProject(dir, "")

		if got := djangoInstallCommand(dir, p); got != "" {
			t.Errorf("got %q, want empty — the image already ships Django", got)
		}
	})
}

func TestDjangoServiceStartupCommand(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "requirements.txt", "django==5.0\n")
	write(t, dir, "backend/manage.py", managePy("config.settings"))
	write(t, dir, "backend/config/settings.py", "ALLOWED_HOSTS = ['example.com']\n")
	write(t, dir, "backend/config/wsgi.py", "")

	plan, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	if len(plan.Services) != 1 {
		t.Fatalf("got %d services, want 1: %+v", len(plan.Services), plan.Services)
	}
	svc := plan.Services[0]

	if plan.Image != "sandbox-django" {
		t.Errorf("Image = %q, want sandbox-django", plan.Image)
	}
	if svc.ContainerPort != 8000 {
		t.Errorf("Port = %d, want 8000", svc.ContainerPort)
	}
	if svc.Framework != "Django (backend)" {
		t.Errorf("Framework = %q, want Django (backend)", svc.Framework)
	}
	if svc.Dir != "backend" {
		t.Errorf("Dir = %q, want backend", svc.Dir)
	}
	// Kept separate from Start, and relative to the service dir it runs in.
	if svc.Install != "pip install -r ../requirements.txt" {
		t.Errorf("Install = %q", svc.Install)
	}

	// Order is the whole point.
	want := []string{
		"export DJANGO_SETTINGS_MODULE=" + SandboxSettingsModule,
		"(python manage.py migrate --noinput || true)",
		"python manage.py runserver 0.0.0.0:8000",
	}
	at := -1
	for _, w := range want {
		i := strings.Index(svc.Start, w)
		if i < 0 {
			t.Fatalf("start command missing %q\ngot: %s", w, svc.Start)
		}
		if i < at {
			t.Errorf("%q is out of order in: %s", w, svc.Start)
		}
		at = i
	}

	// A failed migration must not stop the server from starting.
	if !strings.Contains(svc.Start, "|| true") {
		t.Error("migrate is not allowed to fail — a Postgres-backed repo would never boot")
	}

	// Beside manage.py, whose directory is sys.path[0] — not at the clone root.
	if !core.FileExists(filepath.Join(dir, "backend", SandboxSettingsModule+".py")) {
		t.Error("sandbox settings module was not written beside manage.py")
	}
	if core.FileExists(filepath.Join(dir, SandboxSettingsModule+".py")) {
		t.Error("sandbox settings module leaked into the clone root")
	}
	// The repo's own settings file is left exactly as it was.
	own, _ := os.ReadFile(filepath.Join(dir, "backend", "config", "settings.py"))
	if string(own) != "ALLOWED_HOSTS = ['example.com']\n" {
		t.Errorf("the repo's own settings.py was modified: %q", string(own))
	}
}

// A Django repo must not fall through to the generic Python branch.
func TestDetectRuntimeConfigPicksDjango(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "requirements.txt", "Django>=4.2\ngunicorn\n")
	write(t, dir, "manage.py", managePy("mysite.settings"))
	write(t, dir, "mysite/settings.py", "")
	write(t, dir, "mysite/wsgi.py", "")

	plan, err := Scan(dir)
	if err != nil {
		t.Fatalf("Scan: %v", err)
	}
	svc, _ := plan.Primary()
	if svc.Stack != "django" {
		t.Fatalf("Stack = %q, want django", svc.Stack)
	}
	if !strings.Contains(svc.FullCommand(), "migrate") {
		t.Errorf("no migrate step: %s", svc.FullCommand())
	}
	// The agent guidance keyed to this stack name lives in internal/gitagent.
}

// INSTRUCTIONS.md still outranks detection, but lands on the Django image.
func TestInstructionsRouteDjangoToItsImage(t *testing.T) {
	dir := t.TempDir()
	write(t, dir, "INSTRUCTIONS.md", "pip install -r requirements.txt\npython manage.py runserver 0.0.0.0:8000\n")

	cfg, ok := detectFromInstructions(dir)
	if !ok {
		t.Fatal("detectFromInstructions declined")
	}
	if cfg.Image != "sandbox-django" {
		t.Errorf("Image = %q, want sandbox-django", cfg.Image)
	}
	if cfg.Port != 8000 {
		t.Errorf("Port = %d, want 8000", cfg.Port)
	}
}

func TestFrameworkFromDjangoImage(t *testing.T) {
	if got := FrameworkFromImage("sandbox-django"); got != "Django" {
		t.Errorf("FrameworkFromImage = %q, want Django", got)
	}
}
