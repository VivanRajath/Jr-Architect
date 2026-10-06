package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"sandbox/internal/core"
)

func TestBuilderRoutesSpendTheHourlyBudget(t *testing.T) {
	old := core.Cfg
	defer func() { core.Cfg = old }()
	core.Cfg = core.DefaultConfig()
	core.Cfg.LLMPerHour = 2

	calls := 0
	h := llmLimited(func(w http.ResponseWriter, r *http.Request) { calls++ })
	for i := 0; i < 3; i++ {
		rec := httptest.NewRecorder()
		h(rec, asUser(httptest.NewRequest("POST", "/build/prd", nil), "u-budget"))
		if i == 2 && (rec.Code != 429 || !strings.Contains(rec.Body.String(), "hourly AI limit")) {
			t.Fatalf("third call = %d %s, want 429", rec.Code, rec.Body.String())
		}
	}
	if calls != 2 {
		t.Fatalf("handler ran %d times, want 2", calls)
	}
	h(httptest.NewRecorder(), asUser(httptest.NewRequest("POST", "/build/prd", nil), core.InternalUser))
	if calls != 3 {
		t.Fatal("the agent service's own calls must not be limited")
	}
	if ok, _ := core.AllowLLM("u-budget", time.Now().Add(61*time.Minute)); !ok {
		t.Fatal("the budget did not refill after an hour")
	}
}
