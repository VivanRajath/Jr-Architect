package server

import (
	"archive/zip"
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestUploadPath(t *testing.T) {
	ok := map[string]string{"src/a.js": "src/a.js", `b\c.txt`: "b/c.txt", "./x/../y": "y"}
	for in, want := range ok {
		if got, good := uploadPath(in); !good || got != want {
			t.Errorf("%q: got %q %v, want %q", in, got, good, want)
		}
	}
	for _, bad := range []string{"", "/etc/passwd", "../x", "a/../../x", "C:/x", "node_modules/a.js", "api/.venv/x"} {
		if _, good := uploadPath(bad); good {
			t.Errorf("%q accepted", bad)
		}
	}
}

func TestExtractZipStripsTopDirAndRefusesEscapes(t *testing.T) {
	var buf bytes.Buffer
	zw := zip.NewWriter(&buf)
	for name, body := range map[string]string{"repo-main/app.py": "print(1)", "repo-main/../evil": "x", "repo-main/node_modules/x.js": "y"} {
		w, _ := zw.Create(name)
		w.Write([]byte(body))
	}
	zw.Close()
	zr, err := zip.NewReader(bytes.NewReader(buf.Bytes()), int64(buf.Len()))
	if err != nil {
		t.Fatal(err)
	}
	dst := t.TempDir()
	if err := extractZip(zr, dst); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(dst, "app.py")); err != nil {
		t.Fatal("top-level folder was not stripped")
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(dst), "evil")); err == nil {
		t.Fatal("zip entry escaped the destination")
	}
	if _, err := os.Stat(filepath.Join(dst, "node_modules")); err == nil {
		t.Fatal("node_modules extracted")
	}
}

func TestDefaultProjectName(t *testing.T) {
	for in, want := range map[string]string{"https://github.com/u/shop-api.git": "shop-api", "project:blog": "blog", "local:my app": "my app", "generated:Kanban": "Kanban"} {
		if got := defaultProjectName(in); got != want {
			t.Errorf("%q: got %q, want %q", in, got, want)
		}
	}
}
