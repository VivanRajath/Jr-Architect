package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
	"time"

	"sandbox/internal/core"
)

// A fake Google and GitHub in one server; googleVerified decides what userinfo claims.
func fakeProviders(t *testing.T, googleEmail string, googleVerified bool) *httptest.Server {
	t.Helper()
	mux := http.NewServeMux()
	mux.HandleFunc("/gh/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("code") != "gh-code" || r.Form.Get("client_secret") != "gh-secret" {
			w.WriteHeader(400)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"access_token": "test-github-secret_token", "scope": "repo,read:user,user:email"})
	})
	mux.HandleFunc("/api/user", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer test-github-secret_token" && r.Header.Get("Authorization") != "Bearer test-github-pat" {
			w.WriteHeader(401)
			return
		}
		w.Header().Set("X-OAuth-Scopes", "repo, read:user")
		json.NewEncoder(w).Encode(map[string]interface{}{"id": 42, "login": "octo", "name": "Octo Cat", "avatar_url": "https://a/x.png"})
	})
	mux.HandleFunc("/api/user/emails", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]interface{}{{"email": "other@example.com", "primary": false, "verified": true}, {"email": "octo@example.com", "primary": true, "verified": true}})
	})
	mux.HandleFunc("/api/user/repos", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode([]map[string]interface{}{
			{"full_name": "octo/private-app", "private": true, "default_branch": "main", "html_url": "https://github.com/octo/private-app", "permissions": map[string]bool{"push": true}},
			{"full_name": "octo/notes", "description": "my notes", "private": false, "default_branch": "dev", "html_url": "https://github.com/octo/notes"},
		})
	})
	mux.HandleFunc("/g/token", func(w http.ResponseWriter, r *http.Request) {
		r.ParseForm()
		if r.Form.Get("code") != "g-code" || r.Form.Get("grant_type") != "authorization_code" {
			w.WriteHeader(400)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"access_token": "ya29.google"})
	})
	mux.HandleFunc("/g/userinfo", func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(map[string]interface{}{"sub": "g-123", "email": googleEmail, "email_verified": googleVerified, "name": "Octo G"})
	})
	srv := httptest.NewServer(mux)
	old := []string{googleAuthURL, googleTokenURL, googleUserInfoURL, githubAuthURL, githubTokenURL, githubAPI}
	googleAuthURL, googleTokenURL, googleUserInfoURL = srv.URL+"/g/auth", srv.URL+"/g/token", srv.URL+"/g/userinfo"
	githubAuthURL, githubTokenURL, githubAPI = srv.URL+"/gh/auth", srv.URL+"/gh/token", srv.URL+"/api"
	t.Cleanup(func() {
		srv.Close()
		googleAuthURL, googleTokenURL, googleUserInfoURL, githubAuthURL, githubTokenURL, githubAPI = old[0], old[1], old[2], old[3], old[4], old[5]
	})
	return srv
}

func withOAuthConfig(t *testing.T) {
	t.Helper()
	withAuthConfig(t)
	core.Cfg.BetaCode = ""
	core.Cfg.DataDir = t.TempDir()
	core.Cfg.GitHubClientID, core.Cfg.GitHubClientSecret = "gh-id", "gh-secret"
	core.Cfg.GoogleClientID, core.Cfg.GoogleClientSecret = "g-id", "g-secret"
}

// Runs start then callback like a browser would, returning the callback's response.
func oauthRoundTrip(t *testing.T, h http.Handler, provider, code, startQuery string, cookies ...string) *httptest.ResponseRecorder {
	t.Helper()
	hdr := map[string]string{}
	if len(cookies) > 0 {
		hdr["Cookie"] = strings.Join(cookies, "; ")
	}
	start := do(h, "GET", "/auth/oauth/"+provider+"/start"+startQuery, "", hdr)
	if start.Code != http.StatusFound {
		t.Fatalf("start status %d: %s", start.Code, start.Body.String())
	}
	loc, _ := url.Parse(start.Header().Get("Location"))
	state := loc.Query().Get("state")
	if state == "" || loc.Query().Get("redirect_uri") != "https://jr.example/auth/oauth/"+provider+"/callback" {
		t.Fatalf("authorize redirect is missing state or redirect_uri: %s", loc)
	}
	var stateCookie string
	for _, c := range start.Result().Cookies() {
		if c.Name == "__Host-jr_oauth" {
			stateCookie = c.Name + "=" + c.Value
		}
	}
	if stateCookie == "" {
		t.Fatal("start set no state cookie")
	}
	all := append([]string{stateCookie}, cookies...)
	return do(h, "GET", "/auth/oauth/"+provider+"/callback?code="+code+"&state="+state, "", map[string]string{"Cookie": strings.Join(all, "; ")})
}

func sessionFrom(t *testing.T, rec *httptest.ResponseRecorder) string {
	t.Helper()
	for _, c := range rec.Result().Cookies() {
		if c.Name == "__Host-jr_session" && c.Value != "" {
			return c.Name + "=" + c.Value
		}
	}
	t.Fatalf("no session cookie; status %d location %s", rec.Code, rec.Header().Get("Location"))
	return ""
}

func TestProvidersAreListedWithoutASession(t *testing.T) {
	withOAuthConfig(t)
	rec := do(authFront(), "GET", "/auth/providers", "", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"github":true`) || !strings.Contains(rec.Body.String(), `"beta":false`) {
		t.Fatalf("providers: %d %s", rec.Code, rec.Body.String())
	}
}

func TestGitHubLoginLinksTheAccountAndKeepsTheTokenServerSide(t *testing.T) {
	withOAuthConfig(t)
	fakeProviders(t, "", false)
	h := authFront()
	rec := oauthRoundTrip(t, h, "github", "gh-code", "?next=/hub.html")
	if rec.Header().Get("Location") != "/hub.html" {
		t.Fatalf("callback should land on next, got %d %s", rec.Code, rec.Header().Get("Location"))
	}
	session := sessionFrom(t, rec)
	me := do(h, "GET", "/auth/me", "", map[string]string{"Cookie": session})
	body := me.Body.String()
	if !strings.Contains(body, `"login":"octo"`) || !strings.Contains(body, `"canPush":true`) {
		t.Fatalf("me should show the profile and GitHub link: %s", body)
	}
	if strings.Contains(body, "test-github-secret_token") {
		t.Fatal("the GitHub token reached the browser")
	}
	repos := do(h, "GET", "/github/repos?q=notes", "", map[string]string{"Cookie": session})
	if repos.Code != 200 || !strings.Contains(repos.Body.String(), "octo/notes") || strings.Contains(repos.Body.String(), "private-app") {
		t.Fatalf("repos filter: %d %s", repos.Code, repos.Body.String())
	}
}

func TestGoogleLoginJoinsTheSameAccountByVerifiedEmail(t *testing.T) {
	withOAuthConfig(t)
	fakeProviders(t, "octo@example.com", true)
	h := authFront()
	gh := sessionFrom(t, oauthRoundTrip(t, h, "github", "gh-code", ""))
	g := sessionFrom(t, oauthRoundTrip(t, h, "google", "g-code", ""))
	a, _ := parseSession(strings.SplitN(gh, "=", 2)[1], time.Now())
	b, _ := parseSession(strings.SplitN(g, "=", 2)[1], time.Now())
	if a == "" || a != b {
		t.Fatalf("same verified email should be one user: %q vs %q", a, b)
	}
	me := do(h, "GET", "/auth/me", "", map[string]string{"Cookie": g})
	if !strings.Contains(me.Body.String(), `"github":{`) {
		t.Fatalf("a Google sign-in should see the GitHub link: %s", me.Body.String())
	}
}

func TestUnverifiedGoogleEmailNeverMatchesAnAccount(t *testing.T) {
	withOAuthConfig(t)
	fakeProviders(t, "octo@example.com", false)
	h := authFront()
	gh := sessionFrom(t, oauthRoundTrip(t, h, "github", "gh-code", ""))
	g := sessionFrom(t, oauthRoundTrip(t, h, "google", "g-code", ""))
	a, _ := parseSession(strings.SplitN(gh, "=", 2)[1], time.Now())
	b, _ := parseSession(strings.SplitN(g, "=", 2)[1], time.Now())
	if a == b {
		t.Fatal("an unverified email took over another account")
	}
}

func TestGoogleUserConnectsGitHub(t *testing.T) {
	withOAuthConfig(t)
	fakeProviders(t, "someone@else.com", true)
	h := authFront()
	g := sessionFrom(t, oauthRoundTrip(t, h, "google", "g-code", ""))
	if !strings.Contains(do(h, "GET", "/github/status", "", map[string]string{"Cookie": g}).Body.String(), `"connected":false`) {
		t.Fatal("a fresh Google user should have no GitHub link")
	}
	rec := oauthRoundTrip(t, h, "github", "gh-code", "?mode=link&next=/settings.html", g)
	if loc := rec.Header().Get("Location"); loc != "/settings.html?github=connected" {
		t.Fatalf("link should return to settings: %d %s", rec.Code, loc)
	}
	for _, c := range rec.Result().Cookies() {
		if c.Name == "__Host-jr_session" && c.Value != "" {
			t.Fatal("linking must not switch the signed-in user")
		}
	}
	st := do(h, "GET", "/github/status", "", map[string]string{"Cookie": g}).Body.String()
	if !strings.Contains(st, `"connected":true`) || !strings.Contains(st, `"login":"octo"`) {
		t.Fatalf("status after link: %s", st)
	}
}

func TestLinkNeedsASignedInUser(t *testing.T) {
	withOAuthConfig(t)
	rec := do(authFront(), "GET", "/auth/oauth/github/start?mode=link", "", nil)
	if rec.Code != http.StatusFound || !strings.HasPrefix(rec.Header().Get("Location"), "/login?next=") {
		t.Fatalf("anonymous link should go to login: %d %s", rec.Code, rec.Header().Get("Location"))
	}
}

func TestCallbackRejectsAForeignOrMissingState(t *testing.T) {
	withOAuthConfig(t)
	fakeProviders(t, "", false)
	h := authFront()
	rec := do(h, "GET", "/auth/oauth/github/callback?code=gh-code&state=abc", "", nil)
	if rec.Code != http.StatusFound || !strings.HasPrefix(rec.Header().Get("Location"), "/login?error=") {
		t.Fatalf("missing state cookie must fail: %d %s", rec.Code, rec.Header().Get("Location"))
	}
	st := oauthState{Provider: "github", Mode: "login", Nonce: "n1", Next: "/", Exp: time.Now().Add(time.Minute).Unix()}
	rec = do(h, "GET", "/auth/oauth/github/callback?code=gh-code&state=n2", "", map[string]string{"Cookie": "__Host-jr_oauth=" + encodeState(st)})
	if !strings.HasPrefix(rec.Header().Get("Location"), "/login?error=") {
		t.Fatal("a mismatched state must fail")
	}
	st.Exp = time.Now().Add(-time.Minute).Unix()
	if _, ok := decodeState(encodeState(st), time.Now()); ok {
		t.Fatal("an expired state decoded")
	}
	good := encodeState(oauthState{Provider: "github", Nonce: "n", Exp: time.Now().Add(time.Minute).Unix()})
	if _, ok := decodeState(strings.Replace(good, ".", "x.", 1), time.Now()); ok {
		t.Fatal("a tampered state decoded")
	}
}

func TestAllowListGatesOAuthSignIn(t *testing.T) {
	withOAuthConfig(t)
	fakeProviders(t, "", false)
	core.Cfg.OAuthAllow = []string{"@corp.com"}
	rec := oauthRoundTrip(t, authFront(), "github", "gh-code", "")
	if !strings.Contains(rec.Header().Get("Location"), "/login?error=") {
		t.Fatalf("an account off the list signed in: %s", rec.Header().Get("Location"))
	}
	core.Cfg.OAuthAllow = []string{"gh:OCTO"}
	sessionFrom(t, oauthRoundTrip(t, authFront(), "github", "gh-code", ""))
}

func TestSafeNextKeepsRedirectsOnSite(t *testing.T) {
	for in, want := range map[string]string{"/hub.html": "/hub.html", "//evil.com": "/", "https://evil.com": "/", "/\\evil.com": "/", "": "/", "/a\r\nSet-Cookie:x": "/"} {
		if got := safeNext(in); got != want {
			t.Errorf("safeNext(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestPersonalTokenLinksGitHub(t *testing.T) {
	withOAuthConfig(t)
	fakeProviders(t, "", false)
	h := authFront()
	g := sessionFrom(t, oauthRoundTrip(t, h, "google", "g-code", ""))
	bad := do(h, "POST", "/github/token", `{"token":"nope"}`, map[string]string{"Cookie": g, "X-Jr": "1"})
	if bad.Code != 400 {
		t.Fatalf("a rejected token should be a 400, got %d", bad.Code)
	}
	ok := do(h, "POST", "/github/token", `{"token":"test-github-pat"}`, map[string]string{"Cookie": g, "X-Jr": "1"})
	if ok.Code != 200 || !strings.Contains(ok.Body.String(), `"via":"token"`) || strings.Contains(ok.Body.String(), "test-github-pat") {
		t.Fatalf("token link: %d %s", ok.Code, ok.Body.String())
	}
	if do(h, "POST", "/github/disconnect", `{}`, map[string]string{"Cookie": g, "X-Jr": "1"}).Code != 200 {
		t.Fatal("disconnect failed")
	}
	if !strings.Contains(do(h, "GET", "/github/status", "", map[string]string{"Cookie": g}).Body.String(), `"connected":false`) {
		t.Fatal("still connected after disconnect")
	}
}
