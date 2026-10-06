package builder

import (
	"encoding/json"
	"net/http/httptest"
	"testing"

	"sandbox/internal/core"
)

func TestBuildHistoryIsPerUser(t *testing.T) {
	addBuildRecord(BuildRecord{ID: "build-a", Owner: "u-a"})
	addBuildRecord(BuildRecord{ID: "build-b", Owner: "u-b"})
	rec := httptest.NewRecorder()
	HistoryHandler(rec, core.WithUser(httptest.NewRequest("GET", "/build/history", nil), "u-a"))
	var got []BuildRecord
	json.Unmarshal(rec.Body.Bytes(), &got)
	ids := map[string]bool{}
	for _, r := range got {
		ids[r.ID] = true
	}
	if !ids["build-a"] || ids["build-b"] {
		t.Fatalf("u-a saw %v, want only build-a", ids)
	}
}
