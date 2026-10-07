package server

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"sandbox/internal/core"
)

// Fetch and push are the only git operations that need the GitHub token, so they never run where repository code runs.
// They run in a fresh git container against a scratch git dir whose config is ours: the workspace's .git/config, hooks,
// filters and proxies are never read, and the workspace's objects are borrowed as data through objects/info/alternates.
// Refs and shallow info go in, and fetched packs and refs come out, through a control dir only Go and that container see.

const remoteScript = `set -eu
git init -q --bare "$G"
export GIT_DIR="$G"
cd "$G"
echo "$W/objects" > "$G/objects/info/alternates"
if [ -s "$CTL/refs" ]; then git update-ref --stdin < "$CTL/refs" || true; fi
if [ -s "$CTL/shallow" ]; then cp "$CTL/shallow" "$G/shallow"; fi
case "$OP" in
fetch)
  if [ "$UNSHALLOW" = 1 ] && [ -s "$G/shallow" ]; then deepen=--unshallow; else deepen=; fi
  git fetch $deepen --prune --tags "$URL" "+refs/heads/*:refs/remotes/origin/*"
  git repack -q -a -d -l
  git for-each-ref --format='%(objectname) %(refname)' refs/remotes/origin refs/tags > "$CTL/out-refs"
  mkdir -p "$CTL/packs"
  for f in "$G"/objects/pack/pack-*; do [ -f "$f" ] && cp "$f" "$CTL/packs/"; done
  if [ -s "$G/shallow" ]; then cp "$G/shallow" "$CTL/out-shallow"; else : > "$CTL/out-shallow"; fi
  ;;
push)
  git push "$URL" "$SHA:refs/heads/$BRANCH"
  ;;
esac
`

var (
	objSHARe   = regexp.MustCompile(`^[0-9a-f]{40}([0-9a-f]{24})?$`)
	refLineRe  = regexp.MustCompile(`^([0-9a-f]{40}(?:[0-9a-f]{24})?) (refs/(?:heads|remotes|tags)/[A-Za-z0-9._/@+-]{1,200})$`)
	packNameRe = regexp.MustCompile(`^pack-[0-9a-f]{40}(?:[0-9a-f]{24})?\.(?:pack|idx|rev)$`)
)

// Git config for the token-bearing container: nothing outside our scratch dir is consulted and only https leaves.
func remoteGitEnv(token string) []string {
	env := gitEnv(token, "", "")
	extra := [][2]string{
		{"core.hooksPath", "/dev/null"},
		{"core.alternateRefsCommand", "true"},
		{"fetch.unpackLimit", "1"},
		{"transfer.unpackLimit", "1"},
		{"protocol.allow", "never"},
		{"protocol.https.allow", "always"},
		{"http.sslVerify", "true"},
	}
	count := 0
	for _, kv := range env {
		if strings.HasPrefix(kv, "GIT_CONFIG_COUNT=") {
			fmt.Sscanf(strings.TrimPrefix(kv, "GIT_CONFIG_COUNT="), "%d", &count)
		}
	}
	out := []string{}
	for _, kv := range env {
		if !strings.HasPrefix(kv, "GIT_CONFIG_COUNT=") {
			out = append(out, kv)
		}
	}
	for i, kv := range extra {
		out = append(out, fmt.Sprintf("GIT_CONFIG_KEY_%d=%s", count+i, kv[0]), fmt.Sprintf("GIT_CONFIG_VALUE_%d=%s", count+i, kv[1]))
	}
	return append(out, fmt.Sprintf("GIT_CONFIG_COUNT=%d", count+len(extra)), "GIT_CONFIG_NOSYSTEM=1", "HOME=/tmp")
}

type remoteOp struct {
	Op        string // "fetch" or "push"
	Repo      string // "owner/name", resolved server-side
	SHA       string
	Branch    string
	Unshallow bool
}

// A fresh git container per operation: no capabilities, nothing from the repository running, values passed by name only.
func remoteArgs(workdir, ctl string, env []string) []string {
	args := []string{"run", "--rm",
		"--cap-drop", "ALL", "--security-opt", "no-new-privileges",
		"--pids-limit", "256", "--memory", "1g",
		"-v", workdir + ":/workspace", "-v", ctl + ":/ctl",
		"-e", "W=/workspace/.git", "-e", "CTL=/ctl", "-e", "G=/tmp/g"}
	args = append(args, envNames(env)...)
	return append(args, "--entrypoint", "sh", gitFallbackImage, "-c", remoteScript)
}

// Runs remoteScript with the given env; swapped in tests to run against a local remote without a container engine.
var runRemoteScript = func(ctx context.Context, workdir, ctl string, env []string) (string, error) {
	c := exec.CommandContext(ctx, core.CLI(), remoteArgs(workdir, ctl, env)...)
	c.Env = append(os.Environ(), env...)
	out, err := c.CombinedOutput()
	return string(out), err
}

func githubURL(repo string) (string, error) {
	owner, name, ok := parseGitHubRepo(repo)
	if !ok {
		return "", fmt.Errorf("not a GitHub repository")
	}
	return "https://github.com/" + owner + "/" + name + ".git", nil
}

// The repository this sandbox may push to: the server's record first, the clone URL next, the workspace's origin last.
func boundRepo(sb core.Sandbox, origin string) string {
	if sb.GitHub != "" {
		return sb.GitHub
	}
	if o, n, ok := parseGitHubRepo(sb.Repo); ok && strings.Contains(sb.Repo, "github.com") {
		return o + "/" + n
	}
	return origin
}

// Lists the workspace's refs with tokenless git in the sandbox; swapped in tests.
var listWorkspaceRefs = func(sb core.Sandbox) (string, error) {
	return runGit(sb, localGitEnv("", ""), "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes", "refs/tags")
}

// The workspace's refs, re-validated here before the token container sees them.
func workspaceRefs(sb core.Sandbox) string {
	out, err := listWorkspaceRefs(sb)
	if err != nil {
		return ""
	}
	var b strings.Builder
	for _, line := range strings.Split(out, "\n") {
		if m := refLineRe.FindStringSubmatch(strings.TrimSpace(line)); m != nil && !strings.Contains(m[2], "..") {
			fmt.Fprintf(&b, "update %s %s\n", m[2], m[1])
		}
	}
	return b.String()
}

// Shallow boundaries as plain hashes; anything else in the file is dropped.
func cleanShallow(data []byte) string {
	var b strings.Builder
	sc := bufio.NewScanner(strings.NewReader(string(data)))
	for sc.Scan() {
		if s := strings.TrimSpace(sc.Text()); objSHARe.MatchString(s) {
			b.WriteString(s + "\n")
		}
	}
	return b.String()
}

func readShallow(workdir string) string {
	root, err := os.OpenRoot(workdir)
	if err != nil {
		return ""
	}
	defer root.Close()
	info, err := root.Lstat(".git/shallow")
	if err != nil || !info.Mode().IsRegular() {
		return ""
	}
	data, err := root.ReadFile(".git/shallow")
	if err != nil {
		return ""
	}
	return cleanShallow(data)
}

// Runs one fetch or push for sb with token, never inside sb's container.
func secureRemoteGit(sb core.Sandbox, token string, op remoteOp) (string, error) {
	url, err := githubURL(op.Repo)
	if err != nil {
		return "", err
	}
	if op.Op == "push" && (!objSHARe.MatchString(op.SHA) || !validBranch(op.Branch)) {
		return "", fmt.Errorf("invalid push target")
	}
	ctl, err := os.MkdirTemp("", "jr-git-")
	if err != nil {
		return "", err
	}
	defer os.RemoveAll(ctl)
	if err := os.WriteFile(filepath.Join(ctl, "refs"), []byte(workspaceRefs(sb)), 0600); err != nil {
		return "", err
	}
	if err := os.WriteFile(filepath.Join(ctl, "shallow"), []byte(readShallow(sb.Workdir)), 0600); err != nil {
		return "", err
	}
	env := append(remoteGitEnv(token), "OP="+op.Op, "URL="+url, "SHA="+op.SHA, "BRANCH="+op.Branch, "UNSHALLOW="+boolFlag(op.Unshallow))
	ctx, cancel := context.WithTimeout(context.Background(), gitTimeout)
	defer cancel()
	out, err := runRemoteScript(ctx, sb.Workdir, ctl, env)
	out = redactToken(out, token)
	if err != nil {
		if errors.Is(ctx.Err(), context.DeadlineExceeded) {
			return out, fmt.Errorf("git timed out")
		}
		if msg := lastLine(out); msg != "" {
			return out, errors.New(msg)
		}
		return out, err
	}
	if op.Op == "fetch" {
		if err := applyFetch(sb.Workdir, ctl); err != nil {
			return out, fmt.Errorf("could not store what was fetched: %w", err)
		}
	} else if err := writeRef(sb.Workdir, "refs/remotes/origin/"+op.Branch, op.SHA); err != nil {
		return out, err
	}
	return out, nil
}

func boolFlag(b bool) string {
	if b {
		return "1"
	}
	return "0"
}

// Copies fetched packs, remote-tracking refs and shallow info into the workspace through os.Root, so a planted symlink cannot redirect a write.
func applyFetch(workdir, ctl string) error {
	root, err := os.OpenRoot(workdir)
	if err != nil {
		return err
	}
	defer root.Close()
	packs, _ := os.ReadDir(filepath.Join(ctl, "packs"))
	for _, p := range packs {
		if !packNameRe.MatchString(p.Name()) || !p.Type().IsRegular() {
			continue
		}
		data, err := os.ReadFile(filepath.Join(ctl, "packs", p.Name()))
		if err != nil {
			return err
		}
		dst := ".git/objects/pack/" + p.Name()
		if _, err := root.Lstat(dst); err == nil {
			continue
		}
		if err := root.MkdirAll(".git/objects/pack", 0755); err != nil {
			return err
		}
		if err := root.WriteFile(dst, data, 0444); err != nil {
			return err
		}
	}
	refs, err := os.ReadFile(filepath.Join(ctl, "out-refs"))
	if err != nil {
		return err
	}
	keep := map[string]bool{}
	for _, line := range strings.Split(string(refs), "\n") {
		m := refLineRe.FindStringSubmatch(strings.TrimSpace(line))
		if m == nil || strings.Contains(m[2], "..") {
			continue
		}
		keep[m[2]] = true
		if err := writeRef(workdir, m[2], m[1]); err != nil {
			return err
		}
	}
	// Prune loose remote-tracking refs the remote no longer has.
	if sub, err := root.OpenRoot(".git/refs/remotes/origin"); err == nil {
		fs.WalkDir(sub.FS(), ".", func(p string, d fs.DirEntry, err error) error {
			if err == nil && d.Type().IsRegular() && !keep["refs/remotes/origin/"+p] {
				sub.Remove(p)
			}
			return nil
		})
		sub.Close()
	}
	shallow, err := os.ReadFile(filepath.Join(ctl, "out-shallow"))
	if err != nil {
		return nil
	}
	if s := cleanShallow(shallow); s != "" {
		return root.WriteFile(".git/shallow", []byte(s), 0644)
	}
	if err := root.Remove(".git/shallow"); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return err
	}
	return nil
}

// Writes one loose ref; a loose ref takes precedence over a packed one of the same name.
func writeRef(workdir, ref, sha string) error {
	if !objSHARe.MatchString(sha) || strings.Contains(ref, "..") || !strings.HasPrefix(ref, "refs/") {
		return fmt.Errorf("invalid ref")
	}
	root, err := os.OpenRoot(workdir)
	if err != nil {
		return err
	}
	defer root.Close()
	p := ".git/" + ref
	if err := root.MkdirAll(path.Dir(p), 0755); err != nil {
		return err
	}
	return root.WriteFile(p, []byte(sha+"\n"), 0644)
}

// Shared by status, pull and the graph: fetch for sb, tolerating a workspace with no GitHub remote.
func fetchFor(sb core.Sandbox, token, repo string, unshallow bool) (string, error) {
	start := time.Now()
	out, err := secureRemoteGit(sb, token, remoteOp{Op: "fetch", Repo: repo, Unshallow: unshallow})
	core.Logf("github", "fetch container=%s repo=%s ok=%v took=%s", sb.Container, repo, err == nil, time.Since(start).Round(time.Millisecond))
	return out, err
}
