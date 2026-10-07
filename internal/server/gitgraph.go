package server

import (
	"net/http"
	"regexp"
	"strconv"
	"strings"

	"sandbox/internal/core"
)

// One commit as the IDE's Git Graph draws it.
type graphCommit struct {
	Hash    string   `json:"hash"`
	Short   string   `json:"short"`
	Parents []string `json:"parents"`
	Author  string   `json:"author"`
	Date    string   `json:"date"`
	Subject string   `json:"subject"`
	Refs    []string `json:"refs,omitempty"`
}

const graphSep = "\x1f"

var shaRe = regexp.MustCompile(`^[0-9a-f]{7,40}$`)

// Parses `git log --format=%H<sep>%P<sep>%an<sep>%aI<sep>%s<sep>%D`.
func parseGraphLog(out string) []graphCommit {
	commits := []graphCommit{}
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r", ""), "\n") {
		f := strings.Split(line, graphSep)
		if len(f) < 6 || !shaRe.MatchString(f[0]) {
			continue
		}
		c := graphCommit{Hash: f[0], Short: f[0][:7], Author: f[2], Date: f[3], Subject: f[4], Parents: []string{}}
		for _, p := range strings.Fields(f[1]) {
			if shaRe.MatchString(p) {
				c.Parents = append(c.Parents, p)
			}
		}
		for _, r := range strings.Split(f[5], ", ") {
			if r = strings.TrimSpace(r); r != "" {
				c.Refs = append(c.Refs, r)
			}
		}
		commits = append(commits, c)
	}
	return commits
}

// GET /github/log?container=&limit= — the commit graph across all branches, newest first.
func githubLogHandler(w http.ResponseWriter, r *http.Request) {
	sb, ok := ownedSandbox(w, r, r.URL.Query().Get("container"))
	if !ok {
		return
	}
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	if limit <= 0 || limit > 500 {
		limit = 200
	}
	env := localGitEnv("", "")
	if out, err := runGit(sb, env, "rev-parse", "--is-inside-work-tree"); err != nil || strings.TrimSpace(out) != "true" {
		writeJSON(w, map[string]any{"repo": false, "commits": []graphCommit{}})
		return
	}
	format := strings.Join([]string{"%H", "%P", "%an", "%aI", "%s", "%D"}, graphSep)
	out, err := runGit(sb, env, "log", "--all", "--date-order", "-n", strconv.Itoa(limit), "--format="+format)
	if err != nil && !strings.Contains(out, "does not have any commits") {
		core.JSONError(w, err.Error(), 502)
		return
	}
	head, _ := runGit(sb, env, "rev-parse", "HEAD")
	branch, _ := runGit(sb, env, "branch", "--show-current")
	shallow, _ := runGit(sb, env, "rev-parse", "--is-shallow-repository")
	writeJSON(w, map[string]any{
		"repo": true, "commits": parseGraphLog(out), "head": strings.TrimSpace(head), "branch": strings.TrimSpace(branch),
		"shallow": strings.TrimSpace(shallow) == "true",
	})
}

var graphPathRe = regexp.MustCompile(`^[^\x00-\x1f]{1,400}$`)

// GET /github/show?container=&hash=[&path=] — a commit's files, or one file's before/after for a diff.
func githubShowHandler(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	sb, ok := ownedSandbox(w, r, q.Get("container"))
	if !ok {
		return
	}
	hash := q.Get("hash")
	if !shaRe.MatchString(hash) {
		core.JSONError(w, "not a commit hash", 400)
		return
	}
	env := localGitEnv("", "")
	if path := q.Get("path"); path != "" {
		if !graphPathRe.MatchString(path) || strings.HasPrefix(path, "-") || strings.Contains(path, "..") {
			core.JSONError(w, "not a file path", 400)
			return
		}
		after, err := runGit(sb, env, "show", hash+":"+path)
		if err != nil {
			after = ""
		}
		before, err := runGit(sb, env, "show", hash+"^:"+path)
		if err != nil {
			before = ""
		}
		writeJSON(w, map[string]any{"path": path, "before": capText(before), "after": capText(after)})
		return
	}
	meta, err := runGit(sb, env, "show", "-s", "--format=%H%n%an <%ae>%n%aI%n%B", hash)
	if err != nil {
		core.JSONError(w, err.Error(), 404)
		return
	}
	stat, _ := runGit(sb, env, "show", "--format=", "--name-status", "--no-renames", hash)
	files := []map[string]string{}
	for _, line := range strings.Split(strings.ReplaceAll(stat, "\r", ""), "\n") {
		code, path, ok := strings.Cut(line, "\t")
		if !ok || path == "" {
			continue
		}
		files = append(files, map[string]string{"status": strings.TrimSpace(code), "path": path})
	}
	lines := strings.SplitN(strings.ReplaceAll(meta, "\r", ""), "\n", 4)
	for len(lines) < 4 {
		lines = append(lines, "")
	}
	writeJSON(w, map[string]any{"hash": lines[0], "author": lines[1], "date": lines[2], "message": strings.TrimSpace(lines[3]), "files": files})
}

// Diffs in the browser stay small; a huge file is shown truncated rather than not at all.
func capText(s string) string {
	if len(s) > 200000 {
		return s[:200000] + "\n… (truncated)"
	}
	return s
}

// POST /github/unshallow {container} — fetches the full history of a shallow clone so the graph has something to draw.
func githubUnshallowHandler(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Container string `json:"container"`
	}
	if !decodeBody(w, r, &req) {
		return
	}
	sb, ok := ownedSandbox(w, r, req.Container)
	if !ok {
		return
	}
	gh, _ := githubFor(r)
	st, err := readGitState(sb, "", false)
	if err != nil || !st.Repo {
		core.JSONError(w, "this workspace is not a git repository", 400)
		return
	}
	repo := boundRepo(sb, st.GitHub)
	if repo == "" {
		core.JSONError(w, "this workspace has no GitHub remote to load history from", 400)
		return
	}
	if out, err := fetchFor(sb, gh.Token, repo, true); err != nil {
		msg := err.Error()
		if authFailure(out) {
			msg = "GitHub refused the fetch; connect GitHub to load the history of a private repository"
		}
		core.JSONError(w, msg, 502)
		return
	}
	writeJSON(w, map[string]string{"status": "ok"})
}
