package server

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"sandbox/internal/core"
)

func boolPtr(b bool) *bool { return &b }

func twoServicePlan() core.Plan {
	return core.Plan{
		Stacks: []string{"django", "react"},
		Image:  "sandbox-multi-django-react",
		Services: []core.Service{
			{Name: "frontend", Dir: "frontend", Stack: "react", Framework: "Next.js",
				ContainerPort: 3000, Install: "npm install", Start: "npm run dev -- -H 0.0.0.0",
				Primary: true, Enabled: true},
			{Name: "backend", Dir: "backend", Stack: "django", Framework: "Django",
				ContainerPort: 8000, Install: "pip install -r requirements.txt",
				Start: "python manage.py runserver 0.0.0.0:8000", Enabled: true},
		},
	}
}

// The gate exists so nothing is built until the user says so.
func TestApproveRejectsUnknownContainer(t *testing.T) {
	body := `{"container":"sandbox-does-not-exist","services":[]}`
	req := httptest.NewRequest(http.MethodPost, "/run/approve", strings.NewReader(body))
	w := httptest.NewRecorder()
	runApproveHandler(w, req)

	if w.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404", w.Code)
	}
}

func TestPlanHandlerReportsAwaitingApproval(t *testing.T) {
	plan := twoServicePlan()
	core.PutSandbox(core.Sandbox{Owner: core.LocalUser, Container: "sandbox-plan-test", Status: core.StatusAwaiting, Plan: &plan})
	defer core.DeleteSandbox("sandbox-plan-test")

	req := httptest.NewRequest(http.MethodGet, "/run/plan?container=sandbox-plan-test", nil)
	w := httptest.NewRecorder()
	runPlanHandler(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("status = %d", w.Code)
	}
	var got struct {
		Status string    `json:"status"`
		Plan   core.Plan `json:"plan"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	if got.Status != core.StatusAwaiting {
		t.Errorf("status = %q, want %q", got.Status, core.StatusAwaiting)
	}
	if len(got.Plan.Services) != 2 {
		t.Fatalf("the UI cannot render an approval card without the services: %+v", got.Plan)
	}
	// The card needs the command text to make it editable.
	if got.Plan.Services[0].Start == "" {
		t.Error("service commands were not serialised")
	}
}

// Turning a service off must drop its toolchain too, or the merged image is built for a stack nothing is going to run.
func TestDisablingAServiceShrinksTheImage(t *testing.T) {
	plan := twoServicePlan()
	services := applyEdits(plan.Services, []serviceEdit{{Name: "backend", Enabled: boolPtr(false)}})

	kept := core.Plan{Services: services}.Enabled()
	if len(kept) != 1 || kept[0].Name != "frontend" {
		t.Fatalf("want only the frontend, got %+v", kept)
	}
	if got := core.ImageForStacks(stacksOf(kept)); got != "sandbox-react" {
		t.Errorf("image = %q, want the prebuilt sandbox-react — no composite build needed", got)
	}
}

func TestApplyEditsOverridesPortAndCommand(t *testing.T) {
	port := 4000
	start := "npm run start"
	services := applyEdits(twoServicePlan().Services, []serviceEdit{
		{Name: "frontend", Port: &port, Start: &start},
	})

	if services[0].ContainerPort != 4000 {
		t.Errorf("port = %d, want 4000", services[0].ContainerPort)
	}
	if services[0].Start != start {
		t.Errorf("start = %q, want %q", services[0].Start, start)
	}
	// An untouched service keeps everything it was detected with.
	if services[1].Start != "python manage.py runserver 0.0.0.0:8000" {
		t.Errorf("backend was modified: %q", services[1].Start)
	}
}

// Installs must finish before any server starts, or two npm/pip runs race over the shared cache volumes.
func TestSupervisorInstallsBeforeItStarts(t *testing.T) {
	script := supervisorScript(twoServicePlan().Services)

	lastInstall := strings.LastIndex(script, "pip install")
	firstStart := strings.Index(script, "npm run dev")
	if lastInstall < 0 || firstStart < 0 {
		t.Fatalf("script is missing a step:\n%s", script)
	}
	if lastInstall > firstStart {
		t.Errorf("a server starts before the installs finish:\n%s", script)
	}

	// Servers are backgrounded, installs are not.
	for _, want := range []string{
		"(cd frontend && npm run dev -- -H 0.0.0.0) >> /tmp/jr/frontend.log 2>&1 &",
		"(cd backend && python manage.py runserver 0.0.0.0:8000) >> /tmp/jr/backend.log 2>&1 &",
		"(cd frontend && npm install) >> /tmp/jr/frontend.log 2>&1\n",
	} {
		if !strings.Contains(script, want) {
			t.Errorf("missing %q in:\n%s", want, script)
		}
	}

	// wait keeps the container alive while any one service is still up.
	if !strings.HasSuffix(strings.TrimSpace(script), "wait") {
		t.Errorf("script does not end in wait:\n%s", script)
	}
}

// A root service has nothing to cd into.
func TestSupervisorSkipsCdAtRoot(t *testing.T) {
	script := supervisorScript([]core.Service{
		{Name: "app", Dir: "", Install: "npm install", Start: "npm run dev", Enabled: true, Primary: true},
	})
	if strings.Contains(script, "cd  &&") || strings.Contains(script, "cd &&") {
		t.Errorf("emitted an empty cd:\n%s", script)
	}
	if !strings.Contains(script, "(npm run dev) >> /tmp/jr/app.log 2>&1 &") {
		t.Errorf("root service command is wrong:\n%s", script)
	}
}

func TestLimitsScaleWithServiceCount(t *testing.T) {
	mem1, cpu1, _ := limitsFor(1)
	if mem1 != "1024m" || cpu1 != "1" {
		t.Errorf("single service got %s/%s, want the old 1024m/1", mem1, cpu1)
	}
	mem3, cpu3, _ := limitsFor(3)
	if mem3 != "2304m" || cpu3 != "2" {
		t.Errorf("three services got %s/%s", mem3, cpu3)
	}
	// Capped, so one repo cannot claim the whole machine.
	if mem, _, _ := limitsFor(20); mem != "4096m" {
		t.Errorf("20 services got %s, want the 4096m cap", mem)
	}
}

// The service name reaches a container path, so only detected names are accepted.
func TestServiceLogNameIsValidated(t *testing.T) {
	plan := twoServicePlan()
	core.PutSandbox(core.Sandbox{Owner: core.LocalUser, Container: "sandbox-log-test", Services: plan.Services})
	defer core.DeleteSandbox("sandbox-log-test")

	if !validServiceName("sandbox-log-test", "frontend") {
		t.Error("a real service name was rejected")
	}
	for _, bad := range []string{"../../etc/passwd", "nope", ""} {
		if validServiceName("sandbox-log-test", bad) {
			t.Errorf("accepted %q", bad)
		}
	}
}

func TestSandboxEnvNeverOpensABrowser(t *testing.T) {
	env := strings.Join(sandboxEnv([]core.Service{{Name: "web", ContainerPort: 3000, Primary: true}}), " ")
	if !strings.Contains(env, "BROWSER=none") {
		t.Fatalf("sandbox env %q lets a dev server try to launch a browser", env)
	}
}
