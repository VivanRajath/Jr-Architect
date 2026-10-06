package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"sandbox/internal/core"
)

func TestSweeperAcceptsOnlyReposThisServerPublished(t *testing.T) {
	withOAuthConfig(t)
	core.Cfg.GitHubCollaborator, core.Cfg.GitHubCollaboratorToken = "jr-architect", "collab-token"
	accepted := []string{}
	mux := http.NewServeMux()
	mux.HandleFunc("/user/repository_invitations", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer collab-token" {
			w.WriteHeader(401)
			return
		}
		json.NewEncoder(w).Encode([]map[string]any{
			{"id": 1, "repository": map[string]string{"full_name": "octo/DebugMate"}},
			{"id": 2, "repository": map[string]string{"full_name": "stranger/anything"}},
		})
	})
	mux.HandleFunc("/user/repository_invitations/", func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPatch {
			accepted = append(accepted, strings.TrimPrefix(r.URL.Path, "/user/repository_invitations/"))
		}
		w.WriteHeader(204)
	})
	srv := httptest.NewServer(mux)
	defer srv.Close()
	old := githubAPI
	githubAPI = srv.URL
	defer func() { githubAPI = old }()

	rememberPublished("octo/debugmate")
	if n := acceptPendingInvites(); n != 1 || len(accepted) != 1 || accepted[0] != "1" {
		t.Fatalf("accepted %v (n=%d); only the published repo's invitation should be", accepted, n)
	}
}
