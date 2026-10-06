package server

import (
	"bytes"
	"context"
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

// What the browser may know about a linked account: never the token.
func githubPublic(gh core.GitHubLink) map[string]interface{} {
	return map[string]interface{}{
		"login": gh.Login, "name": gh.Name, "avatar": gh.Avatar, "via": gh.Via, "linkedAt": gh.LinkedAt,
		"canPush": gh.Via == "token" || strings.Contains(" "+strings.ReplaceAll(gh.Scopes, ",", " ")+" ", " repo "),
	}
}

func githubFor(r *http.Request) (core.GitHubLink, bool) {
	return core.GetGitHub(core.UserOf(r))
}

func requireGitHub(w http.ResponseWriter, r *http.Request) (core.GitHubLink, bool) {
	gh, ok := githubFor(r)
	if !ok {
		core.JSONError(w, "connect GitHub first", 401)
	}
	return gh, ok
}

func decodeBody(w http.ResponseWriter, r *http.Request, v interface{}) bool {
	if r.Method != http.MethodPost {
		core.JSONError(w, "method not allowed", 405)
		return false
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 1<<16)).Decode(v); err != nil {
		core.JSONError(w, "invalid request", 400)
		return false
	}
	return true
}

// Calls the GitHub REST API as the user; GitHub's own message comes back as the error.
func githubCall(ctx context.Context, method, path, token string, body, out interface{}) (int, error) {
	var rd io.Reader
	if body != nil {
		b, _ := json.Marshal(body)
		rd = bytes.NewReader(b)
	}
	req, _ := http.NewRequestWithContext(ctx, method, githubAPI+path, rd)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := oauthHTTP.Do(req)
	if err != nil {
		return 0, fmt.Errorf("could not reach GitHub")
	}
	defer res.Body.Close()
	data, _ := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if res.StatusCode >= 300 {
		var e struct {
			Message string `json:"message"`
			Errors  []struct {
				Message string `json:"message"`
			} `json:"errors"`
		}
		json.Unmarshal(data, &e)
		msg := e.Message
		if len(e.Errors) > 0 && e.Errors[0].Message != "" {
			msg += ": " + e.Errors[0].Message
		}
		if res.StatusCode == 401 {
			msg = "GitHub no longer accepts this connection; reconnect GitHub"
		}
		if msg == "" {
			msg = fmt.Sprintf("GitHub answered %d", res.StatusCode)
		}
		return res.StatusCode, fmt.Errorf("%s", msg)
	}
	if out != nil && len(bytes.TrimSpace(data)) > 0 {
		return res.StatusCode, json.Unmarshal(data, out)
	}
	return res.StatusCode, nil
}

func githubStatusHandler(w http.ResponseWriter, r *http.Request) {
	out := map[string]interface{}{"oauth": core.Cfg.GitHubOAuth(), "connected": false, "collaborator": core.Cfg.GitHubCollaborator}
	if gh, ok := githubFor(r); ok {
		out["connected"] = true
		out["account"] = githubPublic(gh)
	}
	writeJSON(w, out)
}

// A personal access token, for servers without a GitHub OAuth app or for fine-grained access.
func githubTokenHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Token string `json:"token"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	tok := strings.TrimSpace(req.Token)
	if tok == "" || len(tok) > 255 || strings.ContainsAny(tok, " \r\n\t") {
		core.JSONError(w, "paste a GitHub token", 400)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	id, err := githubUser(ctx, tok)
	if err != nil {
		core.JSONError(w, "GitHub rejected that token", 400)
		return
	}
	user := core.UserOf(r)
	link := githubLink(id, "token")
	if err := core.SaveGitHub(user, link); err != nil {
		core.JSONError(w, "could not save the token", 500)
		return
	}
	core.ClaimIdentity("github:"+strconv.FormatInt(id.GitHubID, 10), user)
	core.Logf("github", "token linked user=%s login=%s", user, id.Login)
	writeJSON(w, map[string]interface{}{"connected": true, "account": githubPublic(link)})
}

func githubDisconnectHandler(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	if err := core.RemoveGitHub(core.UserOf(r)); err != nil {
		core.JSONError(w, "could not disconnect", 500)
		return
	}
	writeJSON(w, map[string]bool{"connected": false})
}

type repoSummary struct {
	FullName      string `json:"fullName"`
	Description   string `json:"description,omitempty"`
	Private       bool   `json:"private"`
	DefaultBranch string `json:"defaultBranch"`
	URL           string `json:"url"`
	PushedAt      string `json:"pushedAt,omitempty"`
	Language      string `json:"language,omitempty"`
	CanPush       bool   `json:"canPush"`
}

func githubReposHandler(w http.ResponseWriter, r *http.Request) {
	gh, ok := requireGitHub(w, r)
	if !ok {
		return
	}
	page, _ := strconv.Atoi(r.URL.Query().Get("page"))
	if page < 1 || page > 50 {
		page = 1
	}
	var raw []struct {
		FullName      string `json:"full_name"`
		Description   string `json:"description"`
		Private       bool   `json:"private"`
		DefaultBranch string `json:"default_branch"`
		HTMLURL       string `json:"html_url"`
		PushedAt      string `json:"pushed_at"`
		Language      string `json:"language"`
		Permissions   struct {
			Push bool `json:"push"`
		} `json:"permissions"`
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	path := fmt.Sprintf("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member&page=%d", page)
	if _, err := githubCall(ctx, http.MethodGet, path, gh.Token, nil, &raw); err != nil {
		core.JSONError(w, err.Error(), 502)
		return
	}
	q := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	repos := []repoSummary{}
	for _, x := range raw {
		if q != "" && !strings.Contains(strings.ToLower(x.FullName+" "+x.Description), q) {
			continue
		}
		repos = append(repos, repoSummary{x.FullName, x.Description, x.Private, x.DefaultBranch, x.HTMLURL, x.PushedAt, x.Language, x.Permissions.Push})
	}
	writeJSON(w, map[string]interface{}{"repos": repos, "more": len(raw) == 100, "page": page})
}

func githubBranchesHandler(w http.ResponseWriter, r *http.Request) {
	gh, ok := requireGitHub(w, r)
	if !ok {
		return
	}
	owner, name, valid := parseGitHubRepo(r.URL.Query().Get("repo"))
	if !valid {
		core.JSONError(w, "not a GitHub repository", 400)
		return
	}
	var raw []struct {
		Name string `json:"name"`
	}
	ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
	defer cancel()
	if _, err := githubCall(ctx, http.MethodGet, "/repos/"+owner+"/"+name+"/branches?per_page=100", gh.Token, nil, &raw); err != nil {
		core.JSONError(w, err.Error(), 502)
		return
	}
	names := make([]string, 0, len(raw))
	for _, b := range raw {
		names = append(names, b.Name)
	}
	writeJSON(w, map[string]interface{}{"branches": names})
}

// The commit identity: the GitHub account, with its noreply address when no email is public.
func commitIdentity(gh core.GitHubLink) (string, string) {
	name := gh.Name
	if name == "" {
		name = gh.Login
	}
	email := gh.Email
	if email == "" {
		email = fmt.Sprintf("%d+%s@users.noreply.github.com", gh.ID, gh.Login)
	}
	return name, email
}

func readGitState(sb core.Sandbox, token string, fetch bool) (gitState, error) {
	env := gitEnv(token, "", "")
	if out, err := runGit(sb, env, "rev-parse", "--is-inside-work-tree"); err != nil || strings.TrimSpace(out) != "true" {
		return gitState{Repo: false, Changes: []gitChange{}}, nil
	}
	remote, _ := runGit(sb, env, "remote", "get-url", "origin")
	remote = strings.TrimSpace(remote)
	if strings.Contains(remote, "fatal") || strings.Contains(remote, "error") {
		remote = ""
	}
	if fetch && remote != "" {
		if out, err := runGit(sb, env, "fetch", "--prune", "origin"); err != nil {
			if authFailure(out) {
				return gitState{}, fmt.Errorf("GitHub refused the fetch; reconnect GitHub in Settings")
			}
			return gitState{}, fmt.Errorf("fetch failed: %s", redactToken(err.Error(), token))
		}
	}
	out, err := runGit(sb, env, "status", "--porcelain=v1", "-b", "-uall")
	if err != nil {
		return gitState{}, err
	}
	st := parseStatus(out)
	st.Remote = remote
	if o, n, ok := parseGitHubRepo(remote); ok {
		st.GitHub = o + "/" + n
	}
	if head, err := runGit(sb, env, "log", "-1", "--format=%h %s"); err == nil {
		st.Head = strings.TrimSpace(head)
	}
	return st, nil
}

func githubSyncStatusHandler(w http.ResponseWriter, r *http.Request) {
	sb, ok := ownedSandbox(w, r, r.URL.Query().Get("container"))
	if !ok {
		return
	}
	gh, connected := githubFor(r)
	st, err := readGitState(sb, gh.Token, r.URL.Query().Get("fetch") == "1")
	if err != nil {
		core.JSONError(w, err.Error(), 502)
		return
	}
	out := map[string]interface{}{"state": st, "connected": connected, "oauth": core.Cfg.GitHubOAuth()}
	if connected {
		out["account"] = githubPublic(gh)
	}
	writeJSON(w, out)
}

// A sandbox the caller owns whose files are on disk, plus their GitHub link.
func gitTarget(w http.ResponseWriter, r *http.Request, container string) (core.Sandbox, core.GitHubLink, bool) {
	gh, ok := requireGitHub(w, r)
	if !ok {
		return core.Sandbox{}, gh, false
	}
	sb, ok := ownedSandbox(w, r, container)
	if !ok {
		return sb, gh, false
	}
	if sb.Status == core.StatusDetecting {
		core.JSONError(w, "the files are still being fetched", 409)
		return sb, gh, false
	}
	return sb, gh, true
}

func githubPullHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Container string `json:"container"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	sb, gh, ok := gitTarget(w, r, req.Container)
	if !ok {
		return
	}
	name, email := commitIdentity(gh)
	env := gitEnv(gh.Token, name, email)
	out, err := runGit(sb, env, "pull", "--rebase", "--autostash", "--no-edit")
	if err != nil {
		// Leave the workspace as it was rather than half-rebased.
		runGit(sb, env, "rebase", "--abort")
		msg := redactToken(err.Error(), gh.Token)
		if strings.Contains(out, "CONFLICT") {
			msg = "the remote changes conflict with yours; commit or discard yours, then pull again"
		} else if authFailure(out) {
			msg = "GitHub refused the pull; reconnect GitHub in Settings"
		}
		core.JSONError(w, msg, 409)
		return
	}
	core.Logf("github", "pull container=%s user=%s", sb.Container, sb.Owner)
	st, _ := readGitState(sb, gh.Token, false)
	writeJSON(w, map[string]interface{}{"state": st, "output": strings.TrimSpace(redactToken(out, gh.Token))})
}

type prRequest struct {
	Title string `json:"title"`
	Body  string `json:"body"`
	Base  string `json:"base"`
}

func githubPushHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Container string     `json:"container"`
		Message   string     `json:"message"`
		Branch    string     `json:"branch"`
		PR        *prRequest `json:"pr"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	sb, gh, ok := gitTarget(w, r, req.Container)
	if !ok {
		return
	}
	if req.Branch != "" && !validBranch(req.Branch) {
		core.JSONError(w, "that branch name is not valid", 400)
		return
	}
	name, email := commitIdentity(gh)
	env := gitEnv(gh.Token, name, email)
	st, err := readGitState(sb, gh.Token, false)
	if err != nil {
		core.JSONError(w, err.Error(), 502)
		return
	}
	if !st.Repo || st.GitHub == "" {
		core.JSONError(w, "this workspace is not linked to a GitHub repository; publish it first", 400)
		return
	}
	fail := func(step string, err error) {
		core.JSONError(w, step+": "+redactToken(err.Error(), gh.Token), 502)
	}
	if req.Branch != "" && req.Branch != st.Branch {
		if _, err := runGit(sb, env, "checkout", "-B", req.Branch); err != nil {
			fail("could not switch branch", err)
			return
		}
		st.Branch = req.Branch
	}
	committed := false
	if len(st.Changes) > 0 {
		msg := strings.TrimSpace(req.Message)
		if msg == "" {
			msg = "Update from Jr Architect"
		}
		if _, err := runGit(sb, env, append([]string{"add", "-A"}, addPathspec(st)...)...); err != nil {
			fail("could not stage the changes", err)
			return
		}
		if _, err := runGit(sb, env, "commit", "-m", msg); err != nil {
			fail("could not commit", err)
			return
		}
		committed = true
	} else if st.Ahead == 0 && req.Branch == "" {
		core.JSONError(w, "nothing to push: no changes and no unpushed commits", 400)
		return
	}
	if st.Branch == "" {
		core.JSONError(w, "the workspace is not on a branch; name one to push to", 400)
		return
	}
	if out, err := runGit(sb, env, "push", "-u", "origin", "HEAD:refs/heads/"+st.Branch); err != nil {
		msg := redactToken(err.Error(), gh.Token)
		if strings.Contains(out, "rejected") || strings.Contains(out, "fetch first") || strings.Contains(out, "non-fast-forward") {
			msg = "GitHub has newer commits on " + st.Branch + "; pull first, then push"
		} else if authFailure(out) {
			msg = "GitHub refused the push to " + st.GitHub + ": your account has no write access there, or the connection expired. Reconnect GitHub in Settings, or push to a new branch on a fork"
		}
		core.JSONError(w, msg, 409)
		return
	}
	core.Logf("github", "push container=%s user=%s repo=%s branch=%s", sb.Container, sb.Owner, st.GitHub, st.Branch)
	out := map[string]interface{}{"committed": committed, "branch": st.Branch, "repo": st.GitHub}
	if req.PR != nil {
		owner, repo, _ := parseGitHubRepo(st.GitHub)
		title := strings.TrimSpace(req.PR.Title)
		if title == "" {
			title = strings.TrimSpace(req.Message)
		}
		if title == "" {
			title = "Changes from Jr Architect"
		}
		base := req.PR.Base
		if base == "" {
			var info struct {
				DefaultBranch string `json:"default_branch"`
			}
			ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
			githubCall(ctx, http.MethodGet, "/repos/"+owner+"/"+repo, gh.Token, nil, &info)
			cancel()
			base = info.DefaultBranch
		}
		var pr struct {
			HTMLURL string `json:"html_url"`
			Number  int    `json:"number"`
		}
		ctx, cancel := context.WithTimeout(r.Context(), 20*time.Second)
		defer cancel()
		_, err := githubCall(ctx, http.MethodPost, "/repos/"+owner+"/"+repo+"/pulls", gh.Token,
			map[string]string{"title": title, "head": st.Branch, "base": base, "body": req.PR.Body}, &pr)
		if err != nil {
			out["prError"] = err.Error()
		} else {
			out["prUrl"] = pr.HTMLURL
			out["prNumber"] = pr.Number
		}
	}
	st, _ = readGitState(sb, gh.Token, false)
	out["state"] = st
	writeJSON(w, out)
}

// The token for cloning repo, when it is on GitHub and the user linked an account.
func cloneToken(owner, repo string) string {
	if _, _, ok := parseGitHubRepo(repo); !ok {
		return ""
	}
	if u, err := url.Parse(repo); err != nil || !strings.EqualFold(u.Host, "github.com") {
		return ""
	}
	gh, ok := core.GetGitHub(owner)
	if !ok {
		return ""
	}
	return gh.Token
}
