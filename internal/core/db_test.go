package core

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
)

// Runs against a real MongoDB only when MONGODB_TEST_URI is set; each run gets its own throwaway database.
func withTestDB(t *testing.T) {
	t.Helper()
	uri := os.Getenv("MONGODB_TEST_URI")
	if uri == "" {
		t.Skip("MONGODB_TEST_URI not set")
	}
	old := Cfg
	Cfg.DataDir = t.TempDir()
	Cfg.SessionSecret = []byte(strings.Repeat("s", 32))
	name := "jr_test_" + randomHex(6)
	if err := OpenDB(uri, name); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		mdb.Drop(context.Background())
		CloseDB()
		Cfg = old
	})
}

func TestDBUsersIdentitiesAndGitHub(t *testing.T) {
	withTestDB(t)
	u, err := ResolveUser("github:1", "Ada@Example.com")
	if err != nil || !strings.HasPrefix(u, "u-") {
		t.Fatalf("resolve: %q %v", u, err)
	}
	if again, _ := ResolveUser("google:9", "ada@example.com"); again != u {
		t.Fatalf("same verified email should map to the same user, got %s and %s", u, again)
	}
	if ok, _ := ClaimIdentity("github:1", "u-someone-else"); ok {
		t.Fatal("an identity owned by one user was claimed by another")
	}
	if err := SaveProfile(Profile{ID: u, Provider: "github", Login: "ada", Name: "Ada"}); err != nil {
		t.Fatal(err)
	}
	p, ok := GetProfile(u)
	if !ok || p.Login != "ada" || p.CreatedAt.IsZero() {
		t.Fatalf("profile: %+v %v", p, ok)
	}
	if err := SavePrefs(u, Prefs{AutoPush: false, PrivateRepos: true}); err != nil {
		t.Fatal(err)
	}
	if pr := GetPrefs(u); pr.AutoPush || !pr.PrivateRepos {
		t.Fatalf("prefs: %+v", pr)
	}
	if err := SaveGitHub(u, GitHubLink{Login: "ada", Token: "test-github-token"}); err != nil {
		t.Fatal(err)
	}
	if gh, ok := GetGitHub(u); !ok || gh.Token != "test-github-token" {
		t.Fatalf("github: %+v %v", gh, ok)
	}
	var raw bson.M
	coll(colUsers).FindOne(context.Background(), bson.M{"_id": u}).Decode(&raw)
	if b, _ := json.Marshal(raw); strings.Contains(string(b), "test-github-token") {
		t.Fatal("the GitHub token is stored in plain text")
	}
	RemoveGitHub(u)
	if _, ok := GetGitHub(u); ok {
		t.Fatal("link survived removal")
	}
	RecordBetaUser("u-beta")
	if bp, ok := GetProfile("u-beta"); !ok || bp.Provider != "beta" {
		t.Fatalf("beta user not recorded: %+v", bp)
	}
}

func TestDBProjectsAndKeys(t *testing.T) {
	withTestDB(t)
	src := t.TempDir()
	writeTree(t, src, map[string]string{"index.html": "<h1>hi</h1>"})
	p, err := SaveProject("alice", "", "Demo", "build", "static", src)
	if err != nil {
		t.Fatal(err)
	}
	if list, _ := ListProjects("alice"); len(list) != 1 || list[0].ID != p.ID {
		t.Fatalf("list: %+v", list)
	}
	if list, _ := ListProjects("bob"); len(list) != 0 {
		t.Fatal("another user sees the project")
	}
	if _, err := ProjectFiles("alice", p.ID); err != nil {
		t.Fatal(err)
	}
	if err := DeleteProject("alice", p.ID); err != nil {
		t.Fatal(err)
	}
	if _, err := GetProject("alice", p.ID); err != ErrProjectNotFound {
		t.Fatalf("deleted project still found: %v", err)
	}

	if err := writeSavedKeys(map[string][]string{"groq": {"test-groq-a", "test-groq-b"}}); err != nil {
		t.Fatal(err)
	}
	if k := readSavedKeys()["groq"]; len(k) != 2 || k[0] != "test-groq-a" {
		t.Fatalf("keys: %v", k)
	}
	writeSavedKeys(map[string][]string{"groq": {"test-groq-b"}})
	if k := readSavedKeys()["groq"]; len(k) != 1 || k[0] != "test-groq-b" {
		t.Fatalf("removed key came back: %v", k)
	}
}

func TestDBImportsExistingFilesOnce(t *testing.T) {
	withTestDB(t)
	writeJSONFile(identitiesFile(), map[string]string{"github:7": "u-old"})
	writeJSONFile(filepath.Join(userRoot("u-old"), "profile.json"), Profile{ID: "u-old", Provider: "github", Login: "old", CreatedAt: time.Now()})
	meta := filepath.Join(projectsRoot("u-old"), "abcdefabcdef", "meta.json")
	writeJSONFile(meta, Project{ID: "abcdefabcdef", Name: "Old app"})
	if err := ImportFilesToDB(); err != nil {
		t.Fatal(err)
	}
	if p, ok := GetProfile("u-old"); !ok || p.Login != "old" {
		t.Fatalf("profile not imported: %+v", p)
	}
	if u, _ := ResolveUser("github:7", ""); u != "u-old" {
		t.Fatalf("identity not imported: %s", u)
	}
	if list, _ := ListProjects("u-old"); len(list) != 1 || list[0].Name != "Old app" {
		t.Fatalf("project not imported: %+v", list)
	}
	if first, _ := markOnce("files-import"); first {
		t.Fatal("the import would run twice")
	}
}
