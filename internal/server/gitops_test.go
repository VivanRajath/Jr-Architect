package server

import (
	"strings"
	"testing"

	"sandbox/internal/core"
)

func TestParseGitHubRepo(t *testing.T) {
	cases := map[string]string{
		"octo/app":                              "octo/app",
		"https://github.com/octo/app":           "octo/app",
		"https://github.com/octo/app.git":       "octo/app",
		"https://github.com/octo/app/tree/main": "octo/app",
		"https://gitlab.com/octo/app":           "",
		"https://github.com/octo":               "",
		"https://github.com/../etc":             "",
		"https://github.com/octo/a b":           "",
	}
	for in, want := range cases {
		o, n, ok := parseGitHubRepo(in)
		got := ""
		if ok {
			got = o + "/" + n
		}
		if got != want {
			t.Errorf("parseGitHubRepo(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestGitEnvKeepsTheTokenOutOfArgsAndHelpers(t *testing.T) {
	env := gitEnv("tok123", "Octo", "o@x.com")
	joined := strings.Join(env, "\n")
	if !strings.Contains(joined, "GIT_CONFIG_KEY_1=credential.helper\nGIT_CONFIG_VALUE_1=\n") {
		t.Fatalf("host credential helpers must be reset: %s", joined)
	}
	if !strings.Contains(joined, "http.https://github.com/.extraheader") || strings.Contains(joined, "tok123") {
		t.Fatalf("the token should only appear base64'd in a github-scoped header: %s", joined)
	}
	for _, a := range envNames(env) {
		if strings.Contains(a, "=") {
			t.Fatalf("docker args must name variables only, got %q", a)
		}
	}
	if r := redactToken("fatal: https://x-access-token:tok123@github.com", "tok123"); strings.Contains(r, "tok123") {
		t.Fatalf("token not redacted: %s", r)
	}
}

func TestParseStatusHidesGeneratedFiles(t *testing.T) {
	out := "## main...origin/main [ahead 2, behind 1]\n M src/app.ts\n?? agent.yaml\n?? .gitagent/SOUL.md\n?? .env.local\n?? src/new.ts\nD  old.txt\nR  a.txt -> b.txt\nUU merge.txt\n"
	st := parseStatus(out)
	if st.Branch != "main" || st.Upstream != "origin/main" || st.Ahead != 2 || st.Behind != 1 {
		t.Fatalf("branch info: %+v", st)
	}
	want := map[string]string{"src/app.ts": "modified", "src/new.ts": "added", "old.txt": "deleted", "b.txt": "renamed", "merge.txt": "conflict"}
	if len(st.Changes) != len(want) {
		t.Fatalf("changes: %+v", st.Changes)
	}
	for _, c := range st.Changes {
		if want[c.Path] != c.Status {
			t.Errorf("%s: got %s want %s", c.Path, c.Status, want[c.Path])
		}
	}
	spec := strings.Join(addPathspec(st), " ")
	for _, p := range []string{":(exclude)agent.yaml", ":(exclude).gitagent/SOUL.md", ":(exclude).env.local"} {
		if !strings.Contains(spec, p) {
			t.Errorf("pathspec %q misses %s", spec, p)
		}
	}
	if strings.Count(spec, ":(exclude).gitagent/SOUL.md") != 1 {
		t.Errorf("Jr Architect's own spec files should each be excluded once: %s", spec)
	}
	team := parseStatus("## main\n?? .gitagent/agents/reviewer/SOUL.md\n?? .gitagent/hooks/hooks.yaml\n?? .gitagent/DUTIES.md\n?? .gitagent/.session/run.json\n")
	if len(team.Changes) != 3 || len(team.Ignored) != 1 || team.Ignored[0] != ".gitagent/.session" {
		t.Errorf("an OpenGAP team is committed and run transcripts are not: %+v", team)
	}
	if st := parseStatus("## No commits yet on main\n?? index.html\n"); st.Branch != "main" || len(st.Changes) != 1 {
		t.Fatalf("fresh repo: %+v", st)
	}
}

func TestValidBranch(t *testing.T) {
	for _, b := range []string{"main", "feature/login", "jr/fix-1.2"} {
		if !validBranch(b) {
			t.Errorf("%q should be valid", b)
		}
	}
	for _, b := range []string{"-f", "a..b", "x.lock", "a b", "/a", "a/", "", "a//b", "$(id)"} {
		if validBranch(b) {
			t.Errorf("%q should be refused", b)
		}
	}
}

func TestGitHubTokensAreSealedAtRest(t *testing.T) {
	withOAuthConfig(t)
	if err := core.SaveGitHub("u-1", core.GitHubLink{Login: "octo", Token: "test-github-plain"}); err != nil {
		t.Fatal(err)
	}
	gh, ok := core.GetGitHub("u-1")
	if !ok || gh.Token != "test-github-plain" {
		t.Fatalf("round trip: %+v %v", gh, ok)
	}
	if _, ok := core.GetGitHub("u-2"); ok {
		t.Fatal("another user sees the link")
	}
	core.Cfg.SessionSecret = []byte(strings.Repeat("z", 32))
	if _, ok := core.GetGitHub("u-1"); ok {
		t.Fatal("a different secret opened the token")
	}
}

func TestCloneTokenOnlyForGitHubURLs(t *testing.T) {
	withOAuthConfig(t)
	core.SaveGitHub("u-1", core.GitHubLink{Login: "octo", Token: "test-github-x"})
	if cloneToken("u-1", "https://github.com/octo/app") != "test-github-x" {
		t.Fatal("expected the token for a github.com URL")
	}
	for _, repo := range []string{"https://evil.com/github.com/octo/app", "https://gitlab.com/octo/app"} {
		if cloneToken("u-1", repo) != "" {
			t.Fatalf("token offered to %s", repo)
		}
	}
	if cloneToken("u-2", "https://github.com/octo/app") != "" {
		t.Fatal("token offered to a user without a link")
	}
}
