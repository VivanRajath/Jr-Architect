package server

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"

	"sandbox/internal/core"
)

// Endpoints are vars so tests can point them at a fake provider.
var (
	googleAuthURL     = "https://accounts.google.com/o/oauth2/v2/auth"
	googleTokenURL    = "https://oauth2.googleapis.com/token"
	googleUserInfoURL = "https://openidconnect.googleapis.com/v1/userinfo"
	githubAuthURL     = "https://github.com/login/oauth/authorize"
	githubTokenURL    = "https://github.com/login/oauth/access_token"
	githubAPI         = "https://api.github.com"
)

const (
	oauthStateTTL = 10 * time.Minute
	// repo covers private repos and pushing; the rest name and reach the user.
	githubScopes = "repo read:user user:email"
)

var oauthHTTP = &http.Client{Timeout: 15 * time.Second}

// What one sign-in returned, whichever provider it came from.
type oauthIdentity struct {
	Provider string
	Subject  string
	Login    string
	Name     string
	Email    string
	Avatar   string
	Token    string
	Scopes   string
	GitHubID int64
}

func oauthConfigured(p string) bool {
	switch p {
	case "google":
		return core.Cfg.GoogleOAuth()
	case "github":
		return core.Cfg.GitHubOAuth()
	}
	return false
}

// The browser-facing origin: the configured one, else whatever host the request came to.
func requestOrigin(r *http.Request) string {
	if core.Cfg.PublicOrigin != "" {
		return core.Cfg.PublicOrigin
	}
	scheme := "http"
	if r.TLS != nil {
		scheme = "https"
	}
	return scheme + "://" + r.Host
}

func callbackURL(r *http.Request, provider string) string {
	return requestOrigin(r) + "/auth/oauth/" + provider + "/callback"
}

// Only same-site paths, so a crafted next can never bounce a user off-site.
func safeNext(next string) string {
	if !strings.HasPrefix(next, "/") || strings.HasPrefix(next, "//") || strings.HasPrefix(next, "/\\") || strings.ContainsAny(next, "\r\n") {
		return "/"
	}
	return next
}

func oauthCookieName() string {
	if secureCookies() {
		return "__Host-jr_oauth"
	}
	return "jr_oauth"
}

type oauthState struct {
	Provider string `json:"p"`
	Mode     string `json:"m"`
	Nonce    string `json:"n"`
	Next     string `json:"x"`
	User     string `json:"u,omitempty"`
	Exp      int64  `json:"e"`
}

func encodeState(st oauthState) string {
	raw, _ := json.Marshal(st)
	payload := string(raw)
	return base64.RawURLEncoding.EncodeToString(raw) + "." + sign("oauth|"+payload)
}

func decodeState(v string, now time.Time) (oauthState, bool) {
	enc, mac, ok := strings.Cut(v, ".")
	if !ok {
		return oauthState{}, false
	}
	raw, err := base64.RawURLEncoding.DecodeString(enc)
	if err != nil || subtle.ConstantTimeCompare([]byte(sign("oauth|"+string(raw))), []byte(mac)) != 1 {
		return oauthState{}, false
	}
	var st oauthState
	if json.Unmarshal(raw, &st) != nil || now.Unix() > st.Exp {
		return oauthState{}, false
	}
	return st, true
}

// The signed-in user, or LocalUser when the server runs without a login; false means sign in first.
func currentUser(r *http.Request) (string, bool) {
	if !core.Cfg.AuthEnabled() {
		return core.LocalUser, true
	}
	return sessionUser(r)
}

func providersHandler(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, map[string]bool{
		"beta":   core.Cfg.BetaCode != "",
		"google": core.Cfg.GoogleOAuth(),
		"github": core.Cfg.GitHubOAuth(),
	})
}

// /auth/oauth/<provider>/start and /auth/oauth/<provider>/callback.
func oauthHandler(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/auth/oauth/")
	provider, action, _ := strings.Cut(rest, "/")
	if !oauthConfigured(provider) {
		http.Error(w, "this sign-in method is not set up on this server", http.StatusNotFound)
		return
	}
	switch action {
	case "start":
		oauthStart(w, r, provider)
	case "callback":
		oauthCallback(w, r, provider)
	default:
		http.NotFound(w, r)
	}
}

// mode=link attaches a GitHub account to whoever is signed in; anything else signs in.
func oauthStart(w http.ResponseWriter, r *http.Request, provider string) {
	if r.Method != http.MethodGet {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	mode := "login"
	user := ""
	if r.URL.Query().Get("mode") == "link" {
		if provider != "github" {
			http.Error(w, "only GitHub can be linked", http.StatusBadRequest)
			return
		}
		u, ok := currentUser(r)
		if !ok {
			http.Redirect(w, r, loginURL(r), http.StatusFound)
			return
		}
		mode, user = "link", u
	} else if !core.Cfg.AuthEnabled() {
		http.Redirect(w, r, "/", http.StatusFound)
		return
	}
	b := make([]byte, 16)
	rand.Read(b)
	st := oauthState{Provider: provider, Mode: mode, Nonce: hex.EncodeToString(b), Next: safeNext(r.URL.Query().Get("next")), User: user, Exp: time.Now().Add(oauthStateTTL).Unix()}
	http.SetCookie(w, &http.Cookie{
		Name: oauthCookieName(), Value: encodeState(st), Path: "/", MaxAge: int(oauthStateTTL.Seconds()),
		HttpOnly: true, Secure: secureCookies(), SameSite: http.SameSiteLaxMode,
	})
	q := url.Values{}
	q.Set("client_id", clientID(provider))
	q.Set("redirect_uri", callbackURL(r, provider))
	q.Set("state", st.Nonce)
	target := githubAuthURL
	if provider == "google" {
		target = googleAuthURL
		q.Set("response_type", "code")
		q.Set("scope", "openid email profile")
		q.Set("prompt", "select_account")
	} else {
		q.Set("scope", githubScopes)
		q.Set("allow_signup", "true")
	}
	http.Redirect(w, r, target+"?"+q.Encode(), http.StatusFound)
}

func clientID(provider string) string {
	if provider == "google" {
		return core.Cfg.GoogleClientID
	}
	return core.Cfg.GitHubClientID
}

func oauthFail(w http.ResponseWriter, r *http.Request, st oauthState, msg string) {
	core.Logf("auth", "oauth failed: %s", msg)
	if st.Mode == "link" {
		http.Redirect(w, r, withQuery(st.Next, "github_error", msg), http.StatusFound)
		return
	}
	http.Redirect(w, r, "/login?error="+url.QueryEscape(msg), http.StatusFound)
}

func withQuery(path, key, value string) string {
	sep := "?"
	if strings.Contains(path, "?") {
		sep = "&"
	}
	return path + sep + key + "=" + url.QueryEscape(value)
}

func oauthCallback(w http.ResponseWriter, r *http.Request, provider string) {
	c, err := r.Cookie(oauthCookieName())
	var st oauthState
	ok := err == nil
	if ok {
		st, ok = decodeState(c.Value, time.Now())
	}
	http.SetCookie(w, &http.Cookie{Name: oauthCookieName(), Value: "", Path: "/", MaxAge: -1, HttpOnly: true, Secure: secureCookies(), SameSite: http.SameSiteLaxMode})
	if !ok || st.Provider != provider || subtle.ConstantTimeCompare([]byte(st.Nonce), []byte(r.URL.Query().Get("state"))) != 1 {
		oauthFail(w, r, oauthState{}, "the sign-in expired or was started elsewhere; try again")
		return
	}
	if e := r.URL.Query().Get("error"); e != "" {
		oauthFail(w, r, st, "sign-in was cancelled")
		return
	}
	code := r.URL.Query().Get("code")
	if code == "" {
		oauthFail(w, r, st, "the provider sent no code")
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 30*time.Second)
	defer cancel()
	var id oauthIdentity
	if provider == "google" {
		id, err = googleIdentity(ctx, code, callbackURL(r, provider))
	} else {
		id, err = githubIdentity(ctx, code, callbackURL(r, provider))
	}
	if err != nil {
		oauthFail(w, r, st, err.Error())
		return
	}
	if st.Mode == "link" {
		finishLink(w, r, st, id)
		return
	}
	finishLogin(w, r, st, id)
}

func finishLink(w http.ResponseWriter, r *http.Request, st oauthState, id oauthIdentity) {
	// The user who started the link must still be the one signed in.
	if u, ok := currentUser(r); !ok || u != st.User {
		oauthFail(w, r, st, "you were signed out while connecting GitHub")
		return
	}
	if err := core.SaveGitHub(st.User, githubLink(id, "oauth")); err != nil {
		oauthFail(w, r, st, "could not save the GitHub connection")
		return
	}
	core.ClaimIdentity("github:"+strconv.FormatInt(id.GitHubID, 10), st.User)
	core.Logf("auth", "github linked user=%s login=%s", st.User, id.Login)
	http.Redirect(w, r, withQuery(st.Next, "github", "connected"), http.StatusFound)
}

func finishLogin(w http.ResponseWriter, r *http.Request, st oauthState, id oauthIdentity) {
	if !allowedToSignIn(id) {
		oauthFail(w, r, st, "this account is not on the beta list")
		return
	}
	user, err := core.ResolveUser(id.Provider+":"+id.Subject, id.Email)
	if err != nil {
		oauthFail(w, r, st, "could not create the account")
		return
	}
	now := time.Now()
	core.SaveProfile(core.Profile{ID: user, Provider: id.Provider, Login: id.Login, Name: id.Name, Email: id.Email, Avatar: id.Avatar, LastLogin: now})
	if id.Provider == "github" {
		core.SaveGitHub(user, githubLink(id, "login"))
	}
	setSessionCookie(w, newSessionValue(user, now), int(sessionTTL.Seconds()))
	core.Logf("auth", "oauth login provider=%s user=%s ip=%s", id.Provider, user, clientIP(r))
	http.Redirect(w, r, st.Next, http.StatusFound)
}

func githubLink(id oauthIdentity, via string) core.GitHubLink {
	return core.GitHubLink{ID: id.GitHubID, Login: id.Login, Name: id.Name, Email: id.Email, Avatar: id.Avatar, Scopes: id.Scopes, Via: via, Token: id.Token}
}

// JR_OAUTH_ALLOW entries match an email, an "@domain" or a "gh:login".
func allowedToSignIn(id oauthIdentity) bool {
	if len(core.Cfg.OAuthAllow) == 0 {
		return true
	}
	email := strings.ToLower(id.Email)
	for _, a := range core.Cfg.OAuthAllow {
		switch {
		case strings.HasPrefix(a, "gh:"):
			if id.Provider == "github" && strings.EqualFold(a[3:], id.Login) {
				return true
			}
		case strings.HasPrefix(a, "@"):
			if email != "" && strings.HasSuffix(email, a) {
				return true
			}
		case email != "" && a == email:
			return true
		}
	}
	return false
}

func postForm(ctx context.Context, target string, form url.Values, out interface{}) error {
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, target, strings.NewReader(form.Encode()))
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	res, err := oauthHTTP.Do(req)
	if err != nil {
		return fmt.Errorf("could not reach the sign-in provider")
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if res.StatusCode >= 300 {
		return fmt.Errorf("the provider refused the sign-in (%d)", res.StatusCode)
	}
	return json.Unmarshal(body, out)
}

func getJSON(ctx context.Context, target, token string, out interface{}) (http.Header, error) {
	req, _ := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/json")
	res, err := oauthHTTP.Do(req)
	if err != nil {
		return nil, fmt.Errorf("could not reach the provider")
	}
	defer res.Body.Close()
	body, _ := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if res.StatusCode >= 300 {
		return res.Header, fmt.Errorf("the provider answered %d", res.StatusCode)
	}
	return res.Header, json.Unmarshal(body, out)
}

func googleIdentity(ctx context.Context, code, redirect string) (oauthIdentity, error) {
	var tok struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error"`
	}
	form := url.Values{"code": {code}, "client_id": {core.Cfg.GoogleClientID}, "client_secret": {core.Cfg.GoogleClientSecret}, "redirect_uri": {redirect}, "grant_type": {"authorization_code"}}
	if err := postForm(ctx, googleTokenURL, form, &tok); err != nil {
		return oauthIdentity{}, err
	}
	if tok.AccessToken == "" {
		return oauthIdentity{}, fmt.Errorf("Google did not issue a token")
	}
	var info struct {
		Sub           string `json:"sub"`
		Email         string `json:"email"`
		EmailVerified bool   `json:"email_verified"`
		Name          string `json:"name"`
		Picture       string `json:"picture"`
	}
	if _, err := getJSON(ctx, googleUserInfoURL, tok.AccessToken, &info); err != nil {
		return oauthIdentity{}, err
	}
	if info.Sub == "" {
		return oauthIdentity{}, fmt.Errorf("Google did not say who you are")
	}
	email := info.Email
	// An unverified address could claim someone else's account, so it is never used to match.
	if !info.EmailVerified {
		email = ""
	}
	return oauthIdentity{Provider: "google", Subject: info.Sub, Name: info.Name, Email: email, Avatar: info.Picture}, nil
}

func githubIdentity(ctx context.Context, code, redirect string) (oauthIdentity, error) {
	var tok struct {
		AccessToken string `json:"access_token"`
		Scope       string `json:"scope"`
		Error       string `json:"error_description"`
	}
	form := url.Values{"code": {code}, "client_id": {core.Cfg.GitHubClientID}, "client_secret": {core.Cfg.GitHubClientSecret}, "redirect_uri": {redirect}}
	if err := postForm(ctx, githubTokenURL, form, &tok); err != nil {
		return oauthIdentity{}, err
	}
	if tok.AccessToken == "" {
		if tok.Error != "" {
			return oauthIdentity{}, fmt.Errorf("GitHub: %s", tok.Error)
		}
		return oauthIdentity{}, fmt.Errorf("GitHub did not issue a token")
	}
	id, err := githubUser(ctx, tok.AccessToken)
	if err != nil {
		return oauthIdentity{}, err
	}
	id.Scopes = tok.Scope
	return id, nil
}

// Reads the account behind a token, with its primary verified email.
func githubUser(ctx context.Context, token string) (oauthIdentity, error) {
	var u struct {
		ID        int64  `json:"id"`
		Login     string `json:"login"`
		Name      string `json:"name"`
		AvatarURL string `json:"avatar_url"`
	}
	hdr, err := getJSON(ctx, githubAPI+"/user", token, &u)
	if err != nil {
		return oauthIdentity{}, fmt.Errorf("GitHub rejected the token")
	}
	if u.ID == 0 {
		return oauthIdentity{}, fmt.Errorf("GitHub did not say who you are")
	}
	var emails []struct {
		Email    string `json:"email"`
		Primary  bool   `json:"primary"`
		Verified bool   `json:"verified"`
	}
	email := ""
	if _, err := getJSON(ctx, githubAPI+"/user/emails", token, &emails); err == nil {
		for _, e := range emails {
			if e.Primary && e.Verified {
				email = e.Email
			}
		}
	}
	return oauthIdentity{
		Provider: "github", Subject: strconv.FormatInt(u.ID, 10), GitHubID: u.ID, Login: u.Login, Name: u.Name,
		Email: email, Avatar: u.AvatarURL, Token: token, Scopes: hdr.Get("X-OAuth-Scopes"),
	}, nil
}
