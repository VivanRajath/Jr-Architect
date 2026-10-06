package builder

import (
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"

	"sandbox/internal/core"
	"sandbox/internal/detect"
)

// main injects the embedded copy; tests read the same tree from disk.
func init() { SetTemplates(os.DirFS(filepath.Join("..", ".."))) }

// One stack's scaffold must never pick up another's files.
func TestCopyBuilderTemplateIsolatesStacks(t *testing.T) {
	next := t.TempDir()
	if err := Materialise(next, "nextjs"); err != nil {
		t.Fatalf("nextjs template: %v", err)
	}
	if !core.FileExists(filepath.Join(next, "package.json")) {
		t.Error("nextjs template lost package.json in the restructure")
	}
	if !core.FileExists(filepath.Join(next, "app", "page.tsx")) {
		t.Error("nextjs template lost app/page.tsx")
	}
	if core.FileExists(filepath.Join(next, "manage.py")) {
		t.Error("the django template leaked into a nextjs scaffold")
	}

	dj := t.TempDir()
	if err := Materialise(dj, "django"); err != nil {
		t.Fatalf("django template: %v", err)
	}
	if core.FileExists(filepath.Join(dj, "package.json")) {
		t.Error("the nextjs template leaked into a django scaffold")
	}

	if err := Materialise(t.TempDir(), "cobol"); err == nil {
		t.Error("copyBuilderTemplate accepted a template that does not exist")
	}
}

// golden materialises the Django template and returns its directory.
func golden(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	if err := Materialise(dir, "django"); err != nil {
		t.Fatalf("copyBuilderTemplate: %v", err)
	}
	return dir
}

func read(t *testing.T, dir, rel string) string {
	t.Helper()
	b, err := os.ReadFile(filepath.Join(dir, filepath.FromSlash(rel)))
	if err != nil {
		t.Fatalf("read %s: %v", rel, err)
	}
	return string(b)
}

// The template must boot through the same detection path a cloned repo does.
func TestGoldenDjangoTemplateDetects(t *testing.T) {
	dir := golden(t)

	plan, err := detect.Scan(dir)
	if err != nil {
		t.Fatalf("Scan on the golden template: %v", err)
	}
	svc, _ := plan.Primary()
	if svc.Stack != "django" {
		t.Errorf("Stack = %q, want django", svc.Stack)
	}
	if svc.Framework != "Django" {
		t.Errorf("Framework = %q, want Django", svc.Framework)
	}
	startup := svc.FullCommand()
	for _, want := range []string{
		"pip install -r requirements.txt",
		"export DJANGO_SETTINGS_MODULE=" + detect.SandboxSettingsModule,
		"migrate",
		"runserver 0.0.0.0:8000",
	} {
		if !strings.Contains(startup, want) {
			t.Errorf("startup command missing %q\ngot: %s", want, startup)
		}
	}

	// The generated shim must import the module manage.py actually names.
	shim := read(t, dir, detect.SandboxSettingsModule+".py")
	if !strings.Contains(shim, "from config.settings import *") {
		t.Errorf("shim does not import config.settings:\n%s", shim)
	}
}

// The joins that rot first when someone edits one file and forgets the others.
func TestGoldenDjangoTemplateIsWiredUp(t *testing.T) {
	dir := golden(t)

	// manage.py names a settings module that exists on disk.
	mod := detect.DjangoSettingsModule(read(t, dir, "manage.py"))
	if mod != "config.settings" {
		t.Fatalf("manage.py settings module = %q, want config.settings", mod)
	}
	if !core.FileExists(filepath.Join(dir, filepath.FromSlash(strings.ReplaceAll(mod, ".", "/")+".py"))) {
		t.Errorf("manage.py points at %s, which has no file", mod)
	}

	settings := read(t, dir, "config/settings.py")
	// ROOT_URLCONF, WSGI_APPLICATION and ASGI_APPLICATION each name a real module.
	for _, ref := range []string{"config.urls", "config.wsgi", "config.asgi"} {
		if !strings.Contains(settings, ref) {
			t.Errorf("settings.py never references %s", ref)
		}
		if !core.FileExists(filepath.Join(dir, filepath.FromSlash(strings.ReplaceAll(ref, ".", "/")+".py"))) {
			t.Errorf("settings.py references %s, which has no file", ref)
		}
	}

	// Every non-django app in INSTALLED_APPS is a real package in the template.
	for _, app := range installedLocalApps(settings) {
		if !core.FileExists(filepath.Join(dir, app, "__init__.py")) {
			t.Errorf("INSTALLED_APPS lists %q, but %s/__init__.py does not exist", app, app)
		}
		if !core.FileExists(filepath.Join(dir, app, "apps.py")) {
			t.Errorf("app %q has no apps.py", app)
		}
		// No migration means no tables, and the first ORM call 500s.
		if !core.FileExists(filepath.Join(dir, app, "migrations", "0001_initial.py")) {
			t.Errorf("app %q ships no initial migration", app)
		}
	}

	// config/urls.py includes the app's urls, and the app namespaces them.
	if !strings.Contains(read(t, dir, "config/urls.py"), `include("core.urls")`) {
		t.Error("config/urls.py does not include core.urls")
	}
	coreURLs := read(t, dir, "core/urls.py")
	if !strings.Contains(coreURLs, `app_name = "core"`) {
		t.Error("core/urls.py sets no app_name — {% url 'core:index' %} would fail")
	}

	// Every view routed in urls.py is defined in views.py.
	views := read(t, dir, "core/views.py")
	for _, name := range routedViews(coreURLs) {
		if !strings.Contains(views, "def "+name+"(") {
			t.Errorf("core/urls.py routes views.%s, which is not defined in views.py", name)
		}
	}

	// Every {% url 'core:x' %} in a template resolves to a route named x.
	tmpl := read(t, dir, "core/templates/core/index.html")
	for _, name := range templateURLNames(tmpl) {
		if !strings.Contains(coreURLs, `name="`+name+`"`) {
			t.Errorf("index.html reverses 'core:%s', which core/urls.py does not define", name)
		}
	}

	// Every render() target exists.
	for _, path := range renderedTemplates(views) {
		if !core.FileExists(filepath.Join(dir, "core", "templates", filepath.FromSlash(path))) &&
			!core.FileExists(filepath.Join(dir, "templates", filepath.FromSlash(path))) {
			t.Errorf("views.py renders %q, which no template file provides", path)
		}
	}

	// A POST form without csrf_token is a 403 the first time anyone clicks it.
	forms := strings.Count(tmpl, `method="post"`)
	tokens := strings.Count(tmpl, "{% csrf_token %}")
	if forms == 0 {
		t.Error("index.html has no POST form — the template stops demonstrating the write path")
	}
	if tokens < forms {
		t.Errorf("%d POST form(s) but only %d csrf_token — each one needs its own", forms, tokens)
	}

	// base.html is the shell; index.html must extend it rather than restate it.
	if !strings.Contains(tmpl, `{% extends "base.html" %}`) {
		t.Error("index.html does not extend base.html")
	}
	base := read(t, dir, "templates/base.html")
	if !strings.Contains(base, "{% block content %}") {
		t.Error("base.html defines no content block")
	}
	// base.html loads a stylesheet that has to exist under a STATICFILES_DIRS root.
	if strings.Contains(base, "css/app.css") && !core.FileExists(filepath.Join(dir, "static", "css", "app.css")) {
		t.Error("base.html loads static css/app.css, which is missing from static/")
	}
}

var (
	installedAppsRe = regexp.MustCompile(`(?s)INSTALLED_APPS\s*=\s*\[(.*?)\]`)
	quotedRe        = regexp.MustCompile(`["']([^"']+)["']`)
	routeViewRe     = regexp.MustCompile(`views\.(\w+)`)
	templateURLRe   = regexp.MustCompile(`\{%\s*url\s+['"]core:(\w+)['"]`)
	renderRe        = regexp.MustCompile(`["']([\w/]+\.html)["']`)
)

// INSTALLED_APPS entries that belong to this repo rather than to Django.
func installedLocalApps(settings string) []string {
	m := installedAppsRe.FindStringSubmatch(settings)
	if len(m) < 2 {
		return nil
	}
	var apps []string
	for _, q := range quotedRe.FindAllStringSubmatch(m[1], -1) {
		name := q[1]
		if strings.HasPrefix(name, "django.") || strings.Contains(name, ".") {
			continue
		}
		apps = append(apps, name)
	}
	return apps
}

func routedViews(urls string) []string {
	var out []string
	for _, m := range routeViewRe.FindAllStringSubmatch(urls, -1) {
		out = append(out, m[1])
	}
	return out
}

func templateURLNames(tmpl string) []string {
	var out []string
	for _, m := range templateURLRe.FindAllStringSubmatch(tmpl, -1) {
		out = append(out, m[1])
	}
	return out
}

func renderedTemplates(views string) []string {
	var out []string
	for _, m := range renderRe.FindAllStringSubmatch(views, -1) {
		out = append(out, m[1])
	}
	return out
}
