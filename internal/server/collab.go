package server

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"sandbox/internal/core"
)

// The collaborator account accepts invitations to repos this server published; any other invitation is left alone.
const collabSweepEvery = 5 * time.Minute

var (
	publishedMu sync.Mutex
	collabReady bool
)

func publishedFile() string { return filepath.Join(core.Cfg.DataDir, "published-repos.json") }

func readPublished() map[string]time.Time {
	m := map[string]time.Time{}
	if data, err := os.ReadFile(publishedFile()); err == nil {
		json.Unmarshal(data, &m)
	}
	return m
}

// Remembers a repo this server created, so its invitation is recognised later.
func rememberPublished(fullName string) {
	publishedMu.Lock()
	defer publishedMu.Unlock()
	m := readPublished()
	m[strings.ToLower(fullName)] = time.Now()
	data, _ := json.MarshalIndent(m, "", "  ")
	os.MkdirAll(filepath.Dir(publishedFile()), 0700)
	tmp := publishedFile() + ".tmp"
	if os.WriteFile(tmp, data, 0600) == nil {
		os.Rename(tmp, publishedFile())
	}
}

func isPublished(fullName string) bool {
	publishedMu.Lock()
	defer publishedMu.Unlock()
	_, ok := readPublished()[strings.ToLower(fullName)]
	return ok
}

// Checks the token really belongs to the collaborator, then sweeps pending invitations on a timer.
func StartCollaboratorSweeper() {
	if core.Cfg.GitHubCollaborator == "" || core.Cfg.GitHubCollaboratorToken == "" {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		var me struct {
			Login string `json:"login"`
		}
		_, err := githubCall(ctx, http.MethodGet, "/user", core.Cfg.GitHubCollaboratorToken, nil, &me)
		cancel()
		if err != nil || !strings.EqualFold(me.Login, core.Cfg.GitHubCollaborator) {
			core.Logf("github", "JR_GITHUB_COLLABORATOR_TOKEN is not a token for @%s (got %q, %v); invitations will not be accepted automatically", core.Cfg.GitHubCollaborator, me.Login, err)
			return
		}
		collabReady = true
		core.Logf("github", "@%s accepts invitations to published repos automatically", me.Login)
		for {
			acceptPendingInvites()
			time.Sleep(collabSweepEvery)
		}
	}()
}

// Accepts every pending invitation to a repo this server published; returns how many it accepted.
func acceptPendingInvites() int {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	var invites []struct {
		ID         int64 `json:"id"`
		Repository struct {
			FullName string `json:"full_name"`
		} `json:"repository"`
	}
	if _, err := githubCall(ctx, http.MethodGet, "/user/repository_invitations?per_page=100", core.Cfg.GitHubCollaboratorToken, nil, &invites); err != nil {
		core.Logf("github", "listing invitations failed: %v", err)
		return 0
	}
	n := 0
	for _, inv := range invites {
		if !isPublished(inv.Repository.FullName) {
			continue
		}
		if err := acceptInvite(ctx, inv.ID); err != nil {
			core.Logf("github", "accepting the invitation to %s failed: %v", inv.Repository.FullName, err)
			continue
		}
		core.Logf("github", "@%s joined %s", core.Cfg.GitHubCollaborator, inv.Repository.FullName)
		n++
	}
	return n
}

func acceptInvite(ctx context.Context, id int64) error {
	_, err := githubCall(ctx, http.MethodPatch, fmt.Sprintf("/user/repository_invitations/%d", id), core.Cfg.GitHubCollaboratorToken, nil, nil)
	return err
}

// Right after an invite, accept it at once instead of waiting for the next sweep.
func acceptInviteNow(ctx context.Context, inviteID int64) bool {
	if !collabReady || inviteID == 0 {
		return false
	}
	return acceptInvite(ctx, inviteID) == nil
}
