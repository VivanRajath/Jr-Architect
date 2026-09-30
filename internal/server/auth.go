package server

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"sandbox/internal/core"
)

const (
	sessionTTL     = 7 * 24 * time.Hour
	loginPerMinute = 10
)

func sign(payload string) string {
	m := hmac.New(sha256.New, core.Cfg.SessionSecret)
	m.Write([]byte(payload))
	return base64.RawURLEncoding.EncodeToString(m.Sum(nil))
}

func newSessionValue(user string, now time.Time) string {
	payload := user + "|" + strconv.FormatInt(now.Add(sessionTTL).Unix(), 10)
	return base64.RawURLEncoding.EncodeToString([]byte(payload)) + "." + sign(payload)
}

func parseSession(value string, now time.Time) (string, bool) {
	enc, mac, ok := strings.Cut(value, ".")
	if !ok {
		return "", false
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil || !hmac.Equal([]byte(sign(string(raw))), []byte(mac)) {
		return "", false
	}
	user, exp, ok := strings.Cut(string(raw), "|")
	expUnix, err := strconv.ParseInt(exp, 10, 64)
	if !ok || err != nil || user == "" || now.Unix() > expUnix {
		return "", false
	}
	return user, true
}

func secureCookies() bool {
	return strings.HasPrefix(core.Cfg.PublicOrigin, "https://")
}

// __Host- makes browsers refuse any copy set with a Domain, so a preview subdomain cannot plant one.
func sessionCookieName() string {
	if secureCookies() {
		return "__Host-jr_session"
	}
	return "jr_session"
}

func sessionUser(r *http.Request) (string, bool) {
	c, err := r.Cookie(sessionCookieName())
	if err != nil {
		return "", false
	}
	return parseSession(c.Value, time.Now())
}

// Host-only (no Domain), so the cookie never reaches p-<token> preview subdomains.
func setSessionCookie(w http.ResponseWriter, value string, maxAge int) {
	http.SetCookie(w, &http.Cookie{
		Name:     sessionCookieName(),
		Value:    value,
		Path:     "/",
		MaxAge:   maxAge,
		HttpOnly: true,
		Secure:   secureCookies(),
		SameSite: http.SameSiteLaxMode,
	})
}

// Behind Caddy on loopback the peer is the proxy, so the last X-Forwarded-For hop is the client.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
		if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
			parts := strings.Split(xff, ",")
			return strings.TrimSpace(parts[len(parts)-1])
		}
	}
	return host
}

type window struct {
	start time.Time
	n     int
}

// Fixed one-minute windows per key; plenty to stop a beta code being guessed.
type minuteLimiter struct {
	mu   sync.Mutex
	max  int
	hits map[string]*window
}

func newMinuteLimiter(max int) *minuteLimiter {
	return &minuteLimiter{max: max, hits: map[string]*window{}}
}

func (l *minuteLimiter) allow(key string, now time.Time) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	w, ok := l.hits[key]
	if !ok || now.Sub(w.start) >= time.Minute {
		if len(l.hits) > 10000 {
			l.hits = map[string]*window{}
		}
		l.hits[key] = &window{start: now, n: 1}
		return true
	}
	w.n++
	return w.n <= l.max
}

var loginLimiter = newMinuteLimiter(loginPerMinute)

func loginHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	if !loginLimiter.allow(clientIP(r), time.Now()) {
		core.JSONError(w, "too many attempts, wait a minute", 429)
		return
	}
	var req struct {
		Code string `json:"code"`
	}
	body, _ := io.ReadAll(io.LimitReader(r.Body, 4096))
	if json.Unmarshal(body, &req) != nil {
		core.JSONError(w, "invalid request", 400)
		return
	}
	want := sha256.Sum256([]byte(core.Cfg.BetaCode))
	got := sha256.Sum256([]byte(strings.TrimSpace(req.Code)))
	if subtle.ConstantTimeCompare(want[:], got[:]) != 1 {
		core.JSONError(w, "that beta code is not right", 401)
		return
	}
	user, ok := sessionUser(r)
	if !ok {
		b := make([]byte, 16)
		rand.Read(b)
		user = "u-" + hex.EncodeToString(b)
	}
	setSessionCookie(w, newSessionValue(user, time.Now()), int(sessionTTL.Seconds()))
	core.Logf("auth", "login user=%s ip=%s", user, clientIP(r))
	writeJSON(w, map[string]string{"status": "ok"})
}

func logoutHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	setSessionCookie(w, "", -1)
	writeJSON(w, map[string]string{"status": "ok"})
}

func meHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]interface{}{"user": core.UserOf(r), "auth": core.Cfg.AuthEnabled()})
}

// Reachable without a session: the login page, what it loads, and the health probe.
func isPublicPath(p string) bool {
	switch p {
	case "/login", "/login.html", "/auth/login", "/health", "/ready", "/css/tokens.css", "/css/login.css", "/js/login.js", "/vendor/fonts/fonts.css":
		return true
	}
	return strings.HasPrefix(p, "/vendor/fonts/")
}

// Only honoured from loopback: the agent service is the one caller that holds the token.
func isInternalCall(r *http.Request) bool {
	tok := r.Header.Get("X-Jr-Internal")
	if tok == "" || core.Cfg.InternalToken == "" {
		return false
	}
	host, _, _ := net.SplitHostPort(r.RemoteAddr)
	if ip := net.ParseIP(host); ip == nil || !ip.IsLoopback() || r.Header.Get("X-Forwarded-For") != "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(tok), []byte(core.Cfg.InternalToken)) == 1
}

func isSafeMethod(m string) bool {
	return m == http.MethodGet || m == http.MethodHead || m == http.MethodOptions
}

// Wraps every route: attaches the user, gates on the session, and demands the X-Jr header on writes.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if isInternalCall(r) {
			next.ServeHTTP(w, core.WithUser(r, core.InternalUser))
			return
		}
		// Agent tokens authenticate these, and a bearer header is no CSRF risk, so they skip the session and X-Jr checks.
		if isHookPath(r.URL.Path) {
			next.ServeHTTP(w, core.WithUser(r, hookUser))
			return
		}
		if !core.Cfg.AuthEnabled() {
			next.ServeHTTP(w, core.WithUser(r, core.LocalUser))
			return
		}
		// A cross-site form or text/plain POST cannot set a custom header without a preflight we never grant.
		if !isSafeMethod(r.Method) && r.Header.Get("X-Jr") == "" {
			core.JSONError(w, "missing X-Jr header", 403)
			return
		}
		if isPublicPath(r.URL.Path) {
			next.ServeHTTP(w, r)
			return
		}
		user, ok := sessionUser(r)
		if !ok {
			if r.Method == http.MethodGet && strings.Contains(r.Header.Get("Accept"), "text/html") {
				http.Redirect(w, r, "/login", http.StatusFound)
				return
			}
			core.JSONError(w, "login required", 401)
			return
		}
		next.ServeHTTP(w, core.WithUser(r, user))
	})
}
