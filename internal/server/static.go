package server

import (
	"io/fs"
	"mime"
	"net/http"
	"strings"
)

func RegisterAssetMIMETypes() {
	for ext, typ := range map[string]string{
		".html":  "text/html; charset=utf-8",
		".css":   "text/css; charset=utf-8",
		".js":    "application/javascript; charset=utf-8",
		".json":  "application/json",
		".map":   "application/json",
		".svg":   "image/svg+xml",
		".woff2": "font/woff2",
		".ttf":   "font/ttf",
	} {
		_ = mime.AddExtensionType(ext, typ)
	}
}

// http.FileServer already maps "/" to index.html and 404s a missing path; the only
// thing added here is the caching policy.
// The front end FS is injected by main, which owns the //go:embed of web/.
func StaticHandler(webFS fs.FS) http.Handler {
	files := http.FileServer(http.FS(webFS))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Our assets are compiled in, so a stale cache would shadow a rebuild.
		// Vendored ones are version-pinned by path and never change under a URL.
		if strings.HasPrefix(r.URL.Path, "/vendor/") {
			w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		} else {
			w.Header().Set("Cache-Control", "no-cache")
		}
		files.ServeHTTP(w, r)
	})
}
