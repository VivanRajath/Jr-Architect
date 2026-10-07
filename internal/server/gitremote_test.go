package server

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"testing"

	"sandbox/internal/core"
)

const ghTestToken = "test-token-SECRET-1234567890"

func TestRemoteGitRunsInAFreshContainerNotTheSandbox(t *testing.T) {
	args := remoteArgs("/w/sandbox-1", "/tmp/ctl", remoteGitEnv(ghTestToken))
	joined := strings.Join(args, " ")
	if args[0] != "run" || !slices.Contains(args, "--rm") || slices.Contains(args, "exec") {
		t.Fatalf("token git must run in a fresh container, got %s", joined)
	}
	if !strings.Contains(joined, "--cap-drop ALL") || !strings.Contains(joined, "no-new-privileges") {
		t.Fatalf("the git container keeps capabilities: %s", joined)
	}
	if strings.Contains(joined, ghTestToken) {
		t.Fatal("the token is on the command line")
	}
	if !strings.Contains(remoteScript, `git init -q --bare "$G"`) || strings.Contains(remoteScript, "--git-dir") {
		t.Fatal("the script must work in its own scratch git dir")
	}
}

func TestRemoteGitEnvShutsOffRepoControlledExecution(t *testing.T) {
	env := strings.Join(remoteGitEnv(ghTestToken), "\n")
	for _, want := range []string{"core.hooksPath\nGIT_CONFIG_VALUE_", "protocol.allow", "GIT_CONFIG_NOSYSTEM=1", "credential.helper"} {
		if !strings.Contains(env, strings.Split(want, "\n")[0]) {
			t.Errorf("missing %s in %s", want, env)
		}
	}
	if strings.Contains(strings.Join(localGitEnv("a", "b").vars, "\n"), "extraheader") {
		t.Fatal("tokenless git env carries an auth header")
	}
}

func TestApplyFetchRefusesBadRefsPacksAndEscapes(t *testing.T) {
	ws := t.TempDir()
	os.MkdirAll(filepath.Join(ws, ".git", "objects", "pack"), 0755)
	ctl := t.TempDir()
	os.MkdirAll(filepath.Join(ctl, "packs"), 0755)
	sha := strings.Repeat("a", 40)
	os.WriteFile(filepath.Join(ctl, "packs", "pack-"+sha+".pack"), []byte("P"), 0644)
	os.WriteFile(filepath.Join(ctl, "packs", "evil.sh"), []byte("x"), 0644)
	refs := sha + " refs/remotes/origin/main\n" + sha + " refs/remotes/origin/../../../hooks/pre-push\n" + "zzz refs/remotes/origin/x\n"
	os.WriteFile(filepath.Join(ctl, "out-refs"), []byte(refs), 0644)
	os.WriteFile(filepath.Join(ctl, "out-shallow"), []byte(sha+"\nnot-a-sha\n"), 0644)
	if err := applyFetch(ws, ctl); err != nil {
		t.Fatal(err)
	}
	if b, _ := os.ReadFile(filepath.Join(ws, ".git", "refs", "remotes", "origin", "main")); strings.TrimSpace(string(b)) != sha {
		t.Fatalf("main not written: %q", b)
	}
	if _, err := os.Stat(filepath.Join(ws, ".git", "hooks", "pre-push")); err == nil {
		t.Fatal("a ref name escaped into hooks")
	}
	if _, err := os.Stat(filepath.Join(ws, ".git", "objects", "pack", "evil.sh")); err == nil {
		t.Fatal("a non-pack file was copied")
	}
	if b, _ := os.ReadFile(filepath.Join(ws, ".git", "shallow")); string(b) != sha+"\n" {
		t.Fatalf("shallow not cleaned: %q", b)
	}

	// A refs dir swapped for a symlink out of the workspace must not receive a write.
	outside := t.TempDir()
	os.RemoveAll(filepath.Join(ws, ".git", "refs"))
	if err := os.Symlink(outside, filepath.Join(ws, ".git", "refs")); err != nil {
		t.Skip("symlinks unavailable:", err)
	}
	if err := writeRef(ws, "refs/remotes/origin/main", sha); err == nil {
		t.Fatal("a ref was written through a symlink out of the workspace")
	}
	if entries, _ := os.ReadDir(outside); len(entries) != 0 {
		t.Fatal("something landed outside the workspace")
	}
}

func git(t *testing.T, dir string, args ...string) string {
	t.Helper()
	full := append([]string{"-c", "core.hooksPath=" + os.DevNull, "-c", "core.fsmonitor=false", "-c", "protocol.file.allow=always",
		"-c", "user.name=t", "-c", "user.email=t@t", "-c", "init.defaultBranch=main"}, args...)
	c := exec.Command("git", full...)
	c.Dir = dir
	c.Env = append(os.Environ(), "GIT_CONFIG_NOSYSTEM=1", "GIT_CONFIG_GLOBAL="+os.DevNull)
	out, err := c.CombinedOutput()
	if err != nil {
		t.Fatalf("git %v: %v\n%s", args, err, out)
	}
	return strings.TrimSpace(string(out))
}

func slash(p string) string { return filepath.ToSlash(p) }

// A repository that tries every config and hook trick to read the environment of whatever git runs in it.
func plantTraps(t *testing.T, ws, leak string) {
	t.Helper()
	hook := "#!/bin/sh\nenv >> '" + slash(leak) + "/hook-$$'\n"
	hooks := filepath.Join(ws, "evil-hooks")
	os.MkdirAll(hooks, 0755)
	for _, name := range []string{"pre-push", "reference-transaction", "post-checkout", "post-merge", "pre-commit"} {
		os.WriteFile(filepath.Join(ws, ".git", "hooks", name), []byte(hook), 0755)
		os.WriteFile(filepath.Join(hooks, name), []byte(hook), 0755)
	}
	steal := "sh -c 'env >> \"" + slash(leak) + "/cfg-$$\"'"
	cfg := "\n[core]\n\thooksPath = " + slash(hooks) + "\n\tfsmonitor = " + steal + "\n\tsshCommand = " + steal +
		"\n[http]\n\tproxy = http://127.0.0.1:9\n[http \"https://github.com/\"]\n\tproxy = http://127.0.0.1:9\n" +
		"[filter \"x\"]\n\tclean = " + steal + "\n\tsmudge = " + steal + "\n[credential]\n\thelper = !" + steal + "\n"
	f, _ := os.OpenFile(filepath.Join(ws, ".git", "config"), os.O_APPEND|os.O_WRONLY, 0644)
	f.WriteString(cfg)
	f.Close()
	os.WriteFile(filepath.Join(ws, ".gitattributes"), []byte("* filter=x\n"), 0644)
}

func TestTokenNeverReachesRepositoryControlledCode(t *testing.T) {
	if _, err := exec.LookPath("sh"); err != nil {
		t.Skip("needs sh")
	}
	if _, err := exec.LookPath("git"); err != nil {
		t.Skip("needs git")
	}
	base := t.TempDir()
	remote, ws, other, leak := filepath.Join(base, "remote.git"), filepath.Join(base, "sandbox-1"), filepath.Join(base, "other"), filepath.Join(base, "leak")
	os.MkdirAll(leak, 0755)
	git(t, base, "init", "-q", "--bare", remote)
	git(t, base, "clone", "-q", "file://"+slash(remote), ws)
	os.WriteFile(filepath.Join(ws, "a.txt"), []byte("one\n"), 0644)
	git(t, ws, "add", "-A")
	git(t, ws, "commit", "-q", "-m", "first")
	plantTraps(t, ws, leak)

	sb := core.Sandbox{Container: "sandbox-1", Workdir: ws, Repo: "https://github.com/octo/app"}
	oldList, oldRun := listWorkspaceRefs, runRemoteScript
	t.Cleanup(func() { listWorkspaceRefs, runRemoteScript = oldList, oldRun })
	listWorkspaceRefs = func(core.Sandbox) (string, error) {
		return git(t, ws, "for-each-ref", "--format=%(objectname) %(refname)", "refs/heads", "refs/remotes", "refs/tags"), nil
	}
	// The same script, run by sh on this machine against a file:// remote instead of in a container against GitHub.
	runRemoteScript = func(ctx context.Context, workdir, ctl string, env []string) (string, error) {
		c := exec.CommandContext(ctx, "sh", "-c", remoteScript)
		c.Dir = t.TempDir()
		c.Env = append(append(os.Environ(), env...), "W="+slash(filepath.Join(workdir, ".git")), "CTL="+slash(ctl), "G="+slash(filepath.Join(t.TempDir(), "g")),
			"URL=file://"+slash(remote), "GIT_CONFIG_PARAMETERS='protocol.file.allow'='always'", "GIT_CONFIG_GLOBAL="+os.DevNull)
		out, err := c.CombinedOutput()
		return string(out), err
	}

	head := git(t, ws, "rev-parse", "HEAD")
	if out, err := secureRemoteGit(sb, ghTestToken, remoteOp{Op: "push", Repo: "octo/app", SHA: head, Branch: "main"}); err != nil {
		t.Fatalf("push: %v\n%s", err, out)
	}
	if got := git(t, base, "--git-dir="+remote, "rev-parse", "refs/heads/main"); got != head {
		t.Fatalf("remote has %s, want %s", got, head)
	}

	// Someone else pushes; a fetch must bring their commit in without running anything from the workspace.
	git(t, base, "clone", "-q", "file://"+slash(remote), other)
	os.WriteFile(filepath.Join(other, "b.txt"), []byte("two\n"), 0644)
	git(t, other, "add", "-A")
	git(t, other, "commit", "-q", "-m", "second")
	git(t, other, "push", "-q", "origin", "HEAD:refs/heads/main")
	want := git(t, other, "rev-parse", "HEAD")
	if out, err := fetchFor(sb, ghTestToken, "octo/app", false); err != nil {
		t.Fatalf("fetch: %v\n%s", err, out)
	}
	if got := git(t, ws, "rev-parse", "refs/remotes/origin/main"); got != want {
		t.Fatalf("origin/main is %s, want %s", got, want)
	}
	git(t, ws, "cat-file", "-e", want+"^{commit}")

	entries, _ := os.ReadDir(leak)
	for _, e := range entries {
		b, _ := os.ReadFile(filepath.Join(leak, e.Name()))
		if strings.Contains(string(b), ghTestToken) || strings.Contains(string(b), "extraheader") {
			t.Fatalf("repository-controlled code saw the token via %s", e.Name())
		}
	}
	if runtime.GOOS != "windows" && len(entries) != 0 {
		t.Fatalf("repository-controlled code ran during fetch/push: %v", entries)
	}

	// Control: the old way, git with the token in its environment inside the workspace, must trip the traps; otherwise this test proves nothing.
	c := exec.Command("git", "push", "-q", "origin", "HEAD:refs/heads/control")
	c.Dir = ws
	c.Env = append(append(os.Environ(), gitEnv(ghTestToken, "", "")...), "GIT_CONFIG_PARAMETERS='protocol.file.allow'='always'", "GIT_CONFIG_GLOBAL="+os.DevNull)
	c.CombinedOutput()
	caught := false
	entries, _ = os.ReadDir(leak)
	for _, e := range entries {
		b, _ := os.ReadFile(filepath.Join(leak, e.Name()))
		caught = caught || strings.Contains(string(b), "extraheader")
	}
	if !caught {
		t.Fatal("the traps did not catch the old in-workspace push, so they prove nothing about the new path")
	}
}

func TestPushTargetComesFromTheServerRecord(t *testing.T) {
	if got := boundRepo(core.Sandbox{GitHub: "me/app", Repo: "https://github.com/me/app"}, "evil/elsewhere"); got != "me/app" {
		t.Fatalf("server record lost to origin: %s", got)
	}
	if got := boundRepo(core.Sandbox{Repo: "https://github.com/me/app.git"}, "evil/elsewhere"); got != "me/app" {
		t.Fatalf("clone URL lost to origin: %s", got)
	}
	if got := boundRepo(core.Sandbox{Repo: "My saved project"}, "me/app"); got != "me/app" {
		t.Fatalf("a reopened project should fall back to its origin: %s", got)
	}
	if _, err := secureRemoteGit(core.Sandbox{}, ghTestToken, remoteOp{Op: "push", Repo: "me/app", SHA: "HEAD", Branch: "main"}); err == nil {
		t.Fatal("a symbolic push target was accepted")
	}
	if _, err := secureRemoteGit(core.Sandbox{}, ghTestToken, remoteOp{Op: "fetch", Repo: "https://evil.com/me/app"}); err == nil {
		t.Fatal("a non-GitHub remote was accepted")
	}
}
