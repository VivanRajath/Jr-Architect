package server

import (
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"sandbox/internal/core"
)

// Used when a sandbox's own image has no git (the static nginx one) or its container is not running.
const gitFallbackImage = "docker.io/alpine/git:latest"

const gitTimeout = 5 * time.Minute

// Paths Jr Architect writes into a workspace; while the repo does not track them they are never committed.
var generatedPaths = []string{".gitagent", "agent.yaml", "knowledge", "INSTRUCTIONS.md", ".env.local", "jr-workflows.json", "node_modules", ".next"}

// The parts of .gitagent/ an OpenGAP team lives in, which belong in the user's repository.
var openGapShared = []string{"agents", "hooks", "DUTIES.md"}

var githubRepoRe = regexp.MustCompile(`^[A-Za-z0-9_.-]{1,100}$`)

// "owner/name", or any https://github.com/owner/name URL, to its owner and name.
func parseGitHubRepo(s string) (string, string, bool) {
	s = strings.TrimSpace(s)
	if !strings.Contains(s, "://") {
		s = "https://github.com/" + s
	}
	u, err := url.Parse(s)
	if err != nil || !strings.EqualFold(u.Host, "github.com") && !strings.EqualFold(u.Host, "www.github.com") {
		return "", "", false
	}
	parts := strings.Split(strings.Trim(u.Path, "/"), "/")
	if len(parts) < 2 {
		return "", "", false
	}
	owner, name := parts[0], strings.TrimSuffix(parts[1], ".git")
	if !githubRepoRe.MatchString(owner) || !githubRepoRe.MatchString(name) || strings.Trim(owner, ".") == "" || strings.Trim(name, ".") == "" {
		return "", "", false
	}
	return owner, name, true
}

// Git config passed through the environment, so the token is never on a command line or in .git/config.
func gitEnv(token, name, email string) []string {
	cfg := [][2]string{
		{"safe.directory", "*"},
		// Empty resets every helper, so the host's own GitHub login is never used for someone's push.
		{"credential.helper", ""},
	}
	if token != "" {
		basic := base64.StdEncoding.EncodeToString([]byte("x-access-token:" + token))
		cfg = append(cfg, [2]string{"http.https://github.com/.extraheader", "AUTHORIZATION: basic " + basic})
	}
	env := []string{"GIT_TERMINAL_PROMPT=0", "GCM_INTERACTIVE=never", "GIT_CONFIG_COUNT=" + strconv.Itoa(len(cfg))}
	for i, kv := range cfg {
		env = append(env, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", i, kv[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", i, kv[1]))
	}
	if name != "" {
		env = append(env, "GIT_AUTHOR_NAME="+name, "GIT_COMMITTER_NAME="+name)
	}
	if email != "" {
		env = append(env, "GIT_AUTHOR_EMAIL="+email, "GIT_COMMITTER_EMAIL="+email)
	}
	return env
}

func envNames(env []string) []string {
	out := make([]string, 0, len(env)*2)
	for _, kv := range env {
		k, _, _ := strings.Cut(kv, "=")
		out = append(out, "-e", k)
	}
	return out
}

// Clones on the host into a fresh, empty workdir; the host's credential helpers are switched off.
func hostClone(container, repo, workdir, branch, token string, full bool) error {
	args := []string{"clone", "--recurse-submodules=no"}
	if !full {
		args = append(args, "--depth", "1", "--single-branch")
	}
	if branch != "" {
		args = append(args, "--branch", branch)
	}
	args = append(args, "--", repo, workdir)
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	c := exec.CommandContext(ctx, "git", args...)
	c.Env = append(os.Environ(), gitEnv(token, "", "")...)
	out, err := c.CombinedOutput()
	if err != nil {
		msg := strings.TrimSpace(redactToken(string(out), token))
		// A revoked or expired token should not stop a public repo from opening.
		if token != "" && authFailure(msg) {
			core.AddLog(container, "GitHub refused your connection; trying as a public repository. Reconnect GitHub in Settings to push.")
			os.RemoveAll(workdir)
			return hostClone(container, repo, workdir, branch, "", true)
		}
		core.AddLog(container, "Failed to clone repo: "+msg)
		if strings.Contains(msg, "could not read Username") || strings.Contains(msg, "Authentication failed") || strings.Contains(msg, "not found") {
			if token == "" {
				return fmt.Errorf("could not clone %s: it may be private. Connect GitHub to open private repositories", repo)
			}
			return fmt.Errorf("could not clone %s: your GitHub account has no access to it", repo)
		}
		return fmt.Errorf("git clone failed: %s", lastLine(msg))
	}
	return nil
}

func redactToken(s, token string) string {
	if token == "" {
		return s
	}
	s = strings.ReplaceAll(s, token, "***")
	return strings.ReplaceAll(s, base64.StdEncoding.EncodeToString([]byte("x-access-token:"+token)), "***")
}

// Git falls back to a username prompt when GitHub refuses the token, so that is what a bad token looks like.
func authFailure(out string) bool {
	for _, s := range []string{"could not read Username", "Authentication failed", "Invalid username or password", "returned error: 401", "returned error: 403", "Permission to ", "denied to"} {
		if strings.Contains(out, s) {
			return true
		}
	}
	return false
}

func lastLine(s string) string {
	lines := strings.Split(strings.TrimSpace(s), "\n")
	return strings.TrimSpace(lines[len(lines)-1])
}

var (
	noGitMu sync.Mutex
	noGit   = map[string]bool{}
)

// Git config for git that runs where repository code runs: it can never carry a token, which only remoteGitEnv adds.
// A struct, not a slice, so a []string from gitEnv(token, ...) cannot be passed where this is expected.
type localEnv struct{ vars []string }

func localGitEnv(name, email string) localEnv { return localEnv{gitEnv("", name, email)} }

// Runs tokenless git against the workspace inside the sandbox, so a repo's hooks or config never execute on the host.
func runGit(sb core.Sandbox, env localEnv, args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	noGitMu.Lock()
	skipExec := noGit[sb.Container]
	noGitMu.Unlock()
	if !skipExec {
		cmd := append([]string{"exec", "-i", "-w", "/workspace"}, envNames(env.vars)...)
		cmd = append(append(cmd, sb.Container, "git"), args...)
		c := exec.CommandContext(ctx, core.CLI(), cmd...)
		c.Env = append(os.Environ(), env.vars...)
		out, err := c.CombinedOutput()
		if err == nil || !execUnavailable(string(out)) {
			return string(out), wrapGitErr(err, string(out), ctx)
		}
		noGitMu.Lock()
		noGit[sb.Container] = true
		noGitMu.Unlock()
	}
	cmd := append([]string{"run", "--rm", "-i", "-v", sb.Workdir + ":/workspace", "-w", "/workspace"}, envNames(env.vars)...)
	cmd = append(append(cmd, "--entrypoint", "git", gitFallbackImage), args...)
	c := exec.CommandContext(ctx, core.CLI(), cmd...)
	c.Env = append(os.Environ(), env.vars...)
	out, err := c.CombinedOutput()
	return string(out), wrapGitErr(err, string(out), ctx)
}

// The container is gone or has no git binary, as opposed to git itself failing.
func execUnavailable(out string) bool {
	for _, s := range []string{"executable file not found", "is not running", "No such container", "OCI runtime exec failed"} {
		if strings.Contains(out, s) {
			return true
		}
	}
	return false
}

func wrapGitErr(err error, out string, ctx context.Context) error {
	if err == nil {
		return nil
	}
	if errors.Is(ctx.Err(), context.DeadlineExceeded) {
		return fmt.Errorf("git timed out")
	}
	if msg := lastLine(out); msg != "" {
		return errors.New(msg)
	}
	return err
}

type gitChange struct {
	Path   string `json:"path"`
	Status string `json:"status"`
}

type gitState struct {
	Repo     bool        `json:"repo"`
	Remote   string      `json:"remote,omitempty"`
	GitHub   string      `json:"github,omitempty"`
	Branch   string      `json:"branch,omitempty"`
	Upstream string      `json:"upstream,omitempty"`
	Ahead    int         `json:"ahead"`
	Behind   int         `json:"behind"`
	Changes  []gitChange `json:"changes"`
	Ignored  []string    `json:"ignored,omitempty"`
	Head     string      `json:"head,omitempty"`
}

var aheadRe = regexp.MustCompile(`ahead (\d+)`)
var behindRe = regexp.MustCompile(`behind (\d+)`)

// Parses `git status --porcelain=v1 -b`, leaving out untracked paths Jr Architect generated.
func parseStatus(out string) gitState {
	st := gitState{Repo: true, Changes: []gitChange{}}
	for _, line := range strings.Split(strings.ReplaceAll(out, "\r", ""), "\n") {
		if len(line) < 3 {
			continue
		}
		if strings.HasPrefix(line, "## ") {
			head := line[3:]
			info := ""
			if i := strings.Index(head, " ["); i >= 0 {
				head, info = head[:i], head[i:]
			}
			if b, up, ok := strings.Cut(head, "..."); ok {
				st.Branch, st.Upstream = b, up
			} else {
				st.Branch = strings.TrimPrefix(head, "No commits yet on ")
			}
			if m := aheadRe.FindStringSubmatch(info); m != nil {
				st.Ahead, _ = strconv.Atoi(m[1])
			}
			if m := behindRe.FindStringSubmatch(info); m != nil {
				st.Behind, _ = strconv.Atoi(m[1])
			}
			continue
		}
		code, path := line[:2], strings.TrimSpace(line[3:])
		if _, to, ok := strings.Cut(path, " -> "); ok {
			path = to
		}
		path = strings.Trim(path, `"`)
		if root := generatedRoot(path); code == "??" && root != "" {
			if !slices.Contains(st.Ignored, root) {
				st.Ignored = append(st.Ignored, root)
			}
			continue
		}
		st.Changes = append(st.Changes, gitChange{Path: path, Status: statusWord(code)})
	}
	return st
}

// The generated path that path is, or sits under; "" when Jr Architect did not write it.
func generatedRoot(path string) string {
	path = strings.TrimSuffix(path, "/")
	// An OpenGAP team is the user's to commit; only Jr Architect's own spec files and run transcripts stay out.
	if rest, ok := strings.CutPrefix(path, ".gitagent/"); ok {
		for _, shared := range openGapShared {
			if rest == shared || strings.HasPrefix(rest, shared+"/") {
				return ""
			}
		}
		first, _, _ := strings.Cut(rest, "/")
		return ".gitagent/" + first
	}
	for _, g := range generatedPaths {
		if path == g || strings.HasPrefix(path, g+"/") {
			return g
		}
	}
	return ""
}

func statusWord(code string) string {
	switch {
	case code == "??":
		return "added"
	case strings.Contains(code, "U") || code == "AA" || code == "DD":
		return "conflict"
	case strings.Contains(code, "D"):
		return "deleted"
	case strings.Contains(code, "R"):
		return "renamed"
	case strings.Contains(code, "A"):
		return "added"
	}
	return "modified"
}

// The pathspec for `git add`: everything except generated paths that are still untracked.
func addPathspec(st gitState) []string {
	spec := []string{"--", "."}
	for _, p := range st.Ignored {
		spec = append(spec, ":(exclude)"+p)
	}
	return spec
}

var safeBranchRe = regexp.MustCompile(`^[A-Za-z0-9._/-]{1,100}$`)

// A branch name git accepts and that cannot be read as an option.
func validBranch(b string) bool {
	return safeBranchRe.MatchString(b) && !strings.HasPrefix(b, "-") && !strings.HasPrefix(b, "/") &&
		!strings.HasSuffix(b, "/") && !strings.HasSuffix(b, ".lock") && !strings.Contains(b, "..") && !strings.Contains(b, "//")
}
