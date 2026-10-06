package server

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"sandbox/internal/builder"
	"sandbox/internal/core"
)

func TestReadmeFromABuild(t *testing.T) {
	prd := &builder.PRD{
		Name: "DebugMate", Tagline: "A live coding tutor", Vision: "Turns a browser into a coach.",
		TargetUsers: "Beginners", CoreLoop: "Write, run, get a hint", Features: []string{"Skill assessment", "Weekly roadmap"},
		Pages: []string{"Home", "Roadmap"}, DataModel: map[string][]string{"Lesson": {"title", "level"}}, Stack: "nextjs",
		AI: &builder.AIPlan{Agents: []builder.AIAgent{{Name: "Hint Coach", Purpose: "Gives the next hint"}}},
	}
	flows := []builder.BuiltWorkflow{{Name: "Generate Hint", Description: "Hint | for the code", Token: "wt_secret_123", Input: map[string]string{"code": "x"}, Output: map[string]string{"hint": "y"}}}
	md := renderReadme(readmeInput{Name: prd.Name, Tagline: prd.Tagline, Repo: "octo/debugmate", StackLabel: "Next.js (React)", Language: "JavaScript",
		Install: "npm install", Start: "npm run dev", Port: 3000, PRD: prd, Flows: flows, Entries: []string{"app/", "lib/", ".env.local", "package.json"}, EnvFile: ".env.local"})
	for _, want := range []string{"# DebugMate", "> A live coding tutor", "## Features", "- Weekly roadmap", "**Generate Hint**", "Hint \\| for the code", "`code`", "Hint Coach", "git clone https://github.com/octo/debugmate.git", "cd debugmate", "npm run dev", "http://localhost:3000", ".env.example", "| Lesson | title, level |", "**Next.js (React)** (JavaScript)", "Built with [Jr Architect]"} {
		if !strings.Contains(md, want) {
			t.Errorf("README misses %q", want)
		}
	}
	if !strings.Contains(md, "stack-Next.js%20%28React%29-3B82F6") {
		t.Error("the stack badge must escape parentheses, or the Markdown image breaks")
	}
	if strings.Contains(md, "wt_secret_123") {
		t.Fatal("a workflow token reached the README")
	}
	if strings.Contains(md, "\n.env.local\n") {
		t.Fatal("the project tree lists the secret file")
	}
}

func TestSecretFilesGetBlankExamples(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, ".env.local"), []byte("# note\nJR_API_BASE=http://host:9000\nJR_WF_HINT_TOKEN=wt_abc\n"), 0644)
	os.WriteFile(filepath.Join(dir, "jr-workflows.json"), []byte(`{"base":"http://h","workflows":{"hint":{"id":"x","token":"wt_def","name":"Hint"}}}`), 0644)
	writeSecretExamples(dir)
	env, _ := os.ReadFile(filepath.Join(dir, ".env.example"))
	if string(env) != "# note\nJR_API_BASE=\nJR_WF_HINT_TOKEN=\n" {
		t.Fatalf(".env.example: %q", env)
	}
	js, _ := os.ReadFile(filepath.Join(dir, "jr-workflows.example.json"))
	if strings.Contains(string(js), "wt_def") || strings.Contains(string(js), "http://h") || !strings.Contains(string(js), `"name": "Hint"`) {
		t.Fatalf("example json: %s", js)
	}
	if generatedRoot("jr-workflows.json") == "" || generatedRoot(".env.local") == "" {
		t.Fatal("secret files must stay out of commits")
	}
}

func TestRepoSlugAndCommandCleanup(t *testing.T) {
	for in, want := range map[string]string{"Coding Tutor Pro!": "coding-tutor-pro", "  ": "jr-architect-app", "Café ✨ App": "caf-app"} {
		if got := repoSlug(in); got != want {
			t.Errorf("repoSlug(%q) = %q, want %q", in, got, want)
		}
	}
	if got := cleanCommand("npm install --prefer-offline --no-audit --no-fund"); got != "npm install" {
		t.Errorf("install: %q", got)
	}
	if got := cleanCommand("HOST=0.0.0.0 PORT=3000 npm start"); got != "npm start" {
		t.Errorf("start: %q", got)
	}
}

// A fake GitHub: "taken" already exists, "ghost" is not a user.
func fakeRepoAPI(t *testing.T) (*[]string, func()) {
	calls := []string{}
	mux := http.NewServeMux()
	mux.HandleFunc("/user/repos", func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		json.NewDecoder(r.Body).Decode(&body)
		name := body["name"].(string)
		calls = append(calls, "create "+name)
		if name == "taken" || name == "taken-2" {
			w.WriteHeader(422)
			json.NewEncoder(w).Encode(map[string]any{"message": "Repository creation failed.", "errors": []map[string]string{{"message": "name already exists on this account"}}})
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"full_name": "octo/" + name, "html_url": "https://github.com/octo/" + name, "clone_url": "https://github.com/octo/" + name + ".git"})
	})
	mux.HandleFunc("/users/", func(w http.ResponseWriter, r *http.Request) {
		u := strings.TrimPrefix(r.URL.Path, "/users/")
		if u == "ghost" {
			w.WriteHeader(404)
			return
		}
		json.NewEncoder(w).Encode(map[string]string{"login": u})
	})
	mux.HandleFunc("/repos/", func(w http.ResponseWriter, r *http.Request) {
		calls = append(calls, r.Method+" "+r.URL.Path)
		w.WriteHeader(201)
		w.Write([]byte("{}"))
	})
	srv := httptest.NewServer(mux)
	old := githubAPI
	githubAPI = srv.URL
	return &calls, func() { githubAPI = old; srv.Close() }
}

func TestCreateRepoTriesTheNextFreeName(t *testing.T) {
	calls, done := fakeRepoAPI(t)
	defer done()
	gh := core.GitHubLink{Login: "octo", Token: "t"}
	got, err := createRepo(context.Background(), gh, publishOpts{Name: "taken", AutoName: true})
	if err != nil || got.FullName != "octo/taken-3" {
		t.Fatalf("auto name: %+v %v (%v)", got, err, *calls)
	}
	if _, err := createRepo(context.Background(), gh, publishOpts{Name: "taken"}); err == nil || !strings.Contains(err.Error(), "already exists") {
		t.Fatalf("a manual publish must not rename silently: %v", err)
	}
}

func TestCollaboratorMustExistBeforeTheInvite(t *testing.T) {
	calls, done := fakeRepoAPI(t)
	defer done()
	gh := core.GitHubLink{Login: "octo", Token: "t"}
	if _, err := inviteCollaborator(context.Background(), gh, "octo", "app", "ghost"); err == nil {
		t.Fatal("invited an account that does not exist")
	}
	for _, c := range *calls {
		if strings.Contains(c, "collaborators") {
			t.Fatal("sent an invite for a missing account")
		}
	}
	if _, err := inviteCollaborator(context.Background(), gh, "octo", "app", "jr-architect"); err != nil {
		t.Fatal(err)
	}
	if last := (*calls)[len(*calls)-1]; last != "PUT /repos/octo/app/collaborators/jr-architect" {
		t.Fatalf("invite call: %s", last)
	}
}

func TestPrefsDefaultOnAndSave(t *testing.T) {
	withOAuthConfig(t)
	if p := core.GetPrefs("u-9"); !p.AutoPush || !p.PrivateRepos || !p.AddCollaborator {
		t.Fatalf("defaults: %+v", p)
	}
	core.SavePrefs("u-9", core.Prefs{AutoPush: false, PrivateRepos: true})
	if p := core.GetPrefs("u-9"); p.AutoPush || p.AddCollaborator || !p.PrivateRepos {
		t.Fatalf("saved: %+v", p)
	}
}
