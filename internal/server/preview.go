package server

import (
	"fmt"
	"net/http"
	"net/http/httputil"
	"net/url"
	"regexp"
	"strings"

	"sandbox/internal/core"
)

// A preview's own cookies stay on its host; a Domain attribute would let it plant cookies on the IDE.
var cookieDomainAttr = regexp.MustCompile(`(?i);\s*domain=[^;]*`)

// Sends p-<token>.<preview domain> to that sandbox's app, ahead of the IDE's login and origin checks.
func PreviewDispatch(ide http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sb, svc, isPreview, ok := core.ResolvePreviewHost(r.Host)
		if !isPreview {
			ide.ServeHTTP(w, r)
			return
		}
		if !ok || svc.HostPort == 0 {
			previewPage(w, http.StatusNotFound, "This preview has expired or never existed.")
			return
		}
		core.Touch(sb.Container)
		previewProxy(r.Host, svc).ServeHTTP(w, r)
	})
}

func previewProxy(publicHost string, svc core.Service) *httputil.ReverseProxy {
	target := &url.URL{Scheme: "http", Host: fmt.Sprintf("127.0.0.1:%d", svc.HostPort)}
	// Dev servers only trust localhost, so the app sees itself addressed the way it would be locally.
	inner := fmt.Sprintf("localhost:%d", svc.ContainerPort)
	public := core.Cfg.PreviewScheme + "://" + publicHost
	return &httputil.ReverseProxy{
		Rewrite: func(pr *httputil.ProxyRequest) {
			pr.SetURL(target)
			pr.SetXForwarded()
			pr.Out.Host = inner
			pr.Out.Header.Set("X-Forwarded-Proto", core.Cfg.PreviewScheme)
			if pr.In.Header.Get("Origin") != "" {
				pr.Out.Header.Set("Origin", "http://"+inner)
			}
			for k := range pr.Out.Header {
				if strings.HasPrefix(strings.ToLower(k), "x-jr-") {
					pr.Out.Header.Del(k)
				}
			}
		},
		ModifyResponse: func(res *http.Response) error {
			if loc := res.Header.Get("Location"); loc != "" {
				res.Header.Set("Location", rewriteLocalURL(loc, svc.ContainerPort, public))
			}
			if cookies := res.Header.Values("Set-Cookie"); len(cookies) > 0 {
				res.Header.Del("Set-Cookie")
				for _, c := range cookies {
					res.Header.Add("Set-Cookie", cookieDomainAttr.ReplaceAllString(c, ""))
				}
			}
			res.Header.Set("X-Robots-Tag", "noindex")
			return nil
		},
		ErrorHandler: func(w http.ResponseWriter, r *http.Request, err error) {
			previewPage(w, http.StatusBadGateway, "The app is not answering yet. It may still be starting, so try again in a moment.")
		},
	}
}

// Absolute redirects to the app's own localhost address are sent back through the preview host.
func rewriteLocalURL(loc string, port int, public string) string {
	u, err := url.Parse(loc)
	if err != nil || u.Host == "" {
		return loc
	}
	switch u.Hostname() {
	case "localhost", "127.0.0.1", "0.0.0.0", "::1":
	default:
		return loc
	}
	if p := u.Port(); p != "" && p != fmt.Sprint(port) {
		return loc
	}
	rest := strings.TrimPrefix(loc, u.Scheme+"://"+u.Host)
	return public + rest
}

func previewPage(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	fmt.Fprintf(w, `<!DOCTYPE html><meta charset="utf-8"><title>Preview</title><body style="font-family:system-ui,sans-serif;padding:2rem;color:#2C1810;background:#F5F2EE"><p>%s</p></body>`, msg)
}
