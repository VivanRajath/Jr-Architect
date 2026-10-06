package main

import (
	"io/fs"
	"testing"

	"sandbox/internal/builder"
)

// The embeds live here because //go:embed only reaches below its own directory.
func TestEmbeddedAssetsAreWiredUp(t *testing.T) {
	for _, p := range []string{"index.html", "css/tokens.css", "js/ide.js"} {
		if _, err := fs.Stat(webFS, p); err != nil {
			t.Errorf("web/%s is not in the embedded front end: %v", p, err)
		}
	}

	for _, p := range []string{"builder-template/nextjs/package.json", "builder-template/django/manage.py"} {
		if _, err := fs.Stat(builderTemplates, p); err != nil {
			t.Errorf("%s is not in the embedded templates: %v", p, err)
		}
	}

	// main is the only caller that injects them, so a missed call is a nil FS.
	builder.SetTemplates(builderTemplates)
	dir := t.TempDir()
	if err := builder.Materialise(dir, "django"); err != nil {
		t.Errorf("scaffolding from the embedded templates failed: %v", err)
	}
}
