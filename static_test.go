package main

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strings"
	"testing"
)

// The front end used to be five separate //go:embed variables and five
// near-identical handlers, and nothing tested any of it. These tests cover the
// contract the new single embedded web/ directory has to keep.

func get(t *testing.T, path string, origin string) *http.Response {
	t.Helper()
	registerAssetMIMETypes()
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if origin != "" {
		req.Header.Set("Origin", origin)
	}
	rec := httptest.NewRecorder()
	staticHandler().ServeHTTP(rec, req)
	return rec.Result()
}

func TestStaticServesTheShell(t *testing.T) {
	res := get(t, "/", "")
	if res.StatusCode != http.StatusOK {
		t.Fatalf("GET / = %d, want 200", res.StatusCode)
	}
	if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, "text/html") {
		t.Errorf("GET / Content-Type = %q, want text/html", ct)
	}
	body := readAll(t, res)
	// tokens.css must load first: the cascade contract depends on it, and every
	// other stylesheet only consumes what it defines.
	iTokens := strings.Index(body, "/css/tokens.css")
	if iTokens < 0 {
		t.Fatal("index.html does not link /css/tokens.css")
	}
	for _, later := range []string{"/css/app.css", "/css/ide.css", "/css/ide-agent.css"} {
		i := strings.Index(body, later)
		if i < 0 {
			t.Errorf("index.html does not link %s", later)
			continue
		}
		if i < iTokens {
			t.Errorf("%s is linked before tokens.css; tokens must load first", later)
		}
	}
}

// The product claims to be self-hosted and to run offline. It previously pulled
// xterm, its fit addon, the Monaco loader and two webfonts from public CDNs at
// runtime, which made that claim false and put a third-party host on the critical
// path for the editor. This is the regression guard.
func TestNoExternalOriginsInMarkup(t *testing.T) {
	body := readAll(t, get(t, "/", ""))
	// Subresources only. An <a href> to gitagent.sh is a hyperlink the user chooses
	// to follow; a <script src> or <link rel=stylesheet> is a runtime dependency
	// that has to be there for the IDE to work at all.
	external := regexp.MustCompile(`(?is)<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=\s*"(?:https?:)?//[^"]+"`)
	if hits := external.FindAllString(body, -1); len(hits) > 0 {
		t.Errorf("index.html loads subresources from external origins: %v", hits)
	}
}

func TestStaticServesAssets(t *testing.T) {
	cases := []struct {
		path      string
		wantType  string
		mustHave  string
		cacheHard bool
	}{
		{"/css/tokens.css", "text/css", "--fs-md", false},
		{"/css/ide-agent.css", "text/css", "", false},
		{"/js/ide.js", "application/javascript", "", false},
		{"/js/ide-agent.js", "application/javascript", "escapeAttr", false},
		{"/vendor/xterm/xterm.js", "application/javascript", "", true},
		{"/vendor/monaco/vs/loader.js", "application/javascript", "", true},
		{"/vendor/fonts/inter-latin-400-normal.woff2", "font/woff2", "", true},
	}
	for _, c := range cases {
		res := get(t, c.path, "")
		if res.StatusCode != http.StatusOK {
			t.Errorf("GET %s = %d, want 200", c.path, res.StatusCode)
			continue
		}
		if ct := res.Header.Get("Content-Type"); !strings.HasPrefix(ct, c.wantType) {
			t.Errorf("GET %s Content-Type = %q, want %s", c.path, ct, c.wantType)
		}
		// Our own assets are rebuilt into the binary, so they must not be cached;
		// vendored assets are pinned by path and never change under the same URL.
		cc := res.Header.Get("Cache-Control")
		if c.cacheHard && !strings.Contains(cc, "immutable") {
			t.Errorf("GET %s Cache-Control = %q, want immutable", c.path, cc)
		}
		if !c.cacheHard && !strings.Contains(cc, "no-cache") {
			t.Errorf("GET %s Cache-Control = %q, want no-cache", c.path, cc)
		}
		if c.mustHave != "" && !strings.Contains(readAll(t, res), c.mustHave) {
			t.Errorf("GET %s does not contain %q", c.path, c.mustHave)
		}
	}
}

func TestStaticMissingPathIs404(t *testing.T) {
	if res := get(t, "/does-not-exist.js", ""); res.StatusCode != http.StatusNotFound {
		t.Errorf("GET a missing asset = %d, want 404", res.StatusCode)
	}
}

// tokens.css is the only file allowed to DEFINE a custom property. When another
// stylesheet declares one, the palette silently forks and the two copies drift —
// which is exactly how --accent-soft came to be used in ide.css and defined only
// in the landing page's inline block.
func TestOnlyTokensFileDefinesTokens(t *testing.T) {
	decl := regexp.MustCompile(`(?m)^\s*(--[a-zA-Z0-9-]+)\s*:`)
	entries, err := fs.ReadDir(webFS, "css")
	if err != nil {
		t.Fatalf("read css dir: %v", err)
	}
	for _, e := range entries {
		if e.Name() == "tokens.css" || !strings.HasSuffix(e.Name(), ".css") {
			continue
		}
		b, err := fs.ReadFile(webFS, "css/"+e.Name())
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		for _, m := range decl.FindAllStringSubmatch(string(b), -1) {
			t.Errorf("%s defines %s — tokens belong in tokens.css", e.Name(), m[1])
		}
	}
}

// Every var(--x) must resolve to something tokens.css declares. A token that is
// referenced but never defined falls back silently and renders "nearly right",
// which is why --bg1 survived in two rules for as long as it did.
func TestNoUndefinedTokens(t *testing.T) {
	// --depth is set per file-tree row at runtime by ide.js, not in CSS.
	runtimeSet := map[string]bool{"--depth": true}

	tokens, err := fs.ReadFile(webFS, "css/tokens.css")
	if err != nil {
		t.Fatalf("read tokens.css: %v", err)
	}
	defined := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\s*(--[a-zA-Z0-9-]+)\s*:`).FindAllStringSubmatch(string(tokens), -1) {
		defined[m[1]] = true
	}

	use := regexp.MustCompile(`var\(\s*(--[a-zA-Z0-9-]+)`)
	comment := regexp.MustCompile(`(?s)/\*.*?\*/`)
	entries, _ := fs.ReadDir(webFS, "css")
	for _, e := range entries {
		if !strings.HasSuffix(e.Name(), ".css") {
			continue
		}
		b, err := fs.ReadFile(webFS, "css/"+e.Name())
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		// Comments explain the tokens that were removed, so strip them first.
		src := comment.ReplaceAllString(string(b), "")
		for _, m := range use.FindAllStringSubmatch(src, -1) {
			if !defined[m[1]] && !runtimeSet[m[1]] {
				t.Errorf("%s uses %s, which tokens.css does not define", e.Name(), m[1])
			}
		}
	}
}

// The type and radius scales exist to stop values drifting back in. A raw pixel
// font-size or radius in a stylesheet means someone bypassed them.
func TestNoRawTypeOrRadiusValues(t *testing.T) {
	raw := regexp.MustCompile(`(?:font-size|border-radius):\s*[0-9.]+px\s*[;}!]`)
	entries, _ := fs.ReadDir(webFS, "css")
	for _, e := range entries {
		if e.Name() == "tokens.css" || !strings.HasSuffix(e.Name(), ".css") {
			continue
		}
		b, _ := fs.ReadFile(webFS, "css/"+e.Name())
		for _, m := range raw.FindAllString(string(b), -1) {
			t.Errorf("%s: %q — use a --fs-* / --r-* token", e.Name(), strings.TrimSpace(m))
		}
	}
}

func readAll(t *testing.T, res *http.Response) string {
	t.Helper()
	defer res.Body.Close()
	var sb strings.Builder
	buf := make([]byte, 32*1024)
	for {
		n, err := res.Body.Read(buf)
		sb.Write(buf[:n])
		if err != nil {
			break
		}
	}
	return sb.String()
}
