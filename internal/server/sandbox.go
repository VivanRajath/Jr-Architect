package server

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"sandbox/internal/core"
	"sandbox/internal/detect"
	"sandbox/internal/gitagent"
)

type Request struct {
	Repo         string `json:"repo"`
	Instructions string `json:"instructions,omitempty"`
	Mode         string `json:"mode,omitempty"`
	AutoApprove  bool   `json:"autoApprove,omitempty"`
}

// Per-service logs land here so a crashed service can still be read.
const logDir = "/tmp/jr"

// Clone and scan only. Nothing is built or started until approveSandbox runs, so a
// three-service monorepo doesn't spend minutes on an image the user didn't want.
func startSandbox(owner, repo, instructions, mode string, autoApprove bool) (core.Sandbox, error) {
	if err := core.ValidateRepoURL(repo); err != nil {
		return core.Sandbox{}, err
	}

	workdir, err := os.MkdirTemp(core.Cfg.WorkDir, "sandbox-*")
	if err != nil {
		return core.Sandbox{}, err
	}
	os.Remove(workdir)

	container := "sandbox-" + filepath.Base(workdir)
	abs, _ := filepath.Abs(workdir)
	sb := core.Sandbox{
		Container: container,
		Repo:      repo,
		Workdir:   abs,
		Status:    core.StatusDetecting,
		Owner:     owner,
	}
	if err := core.AddSandbox(sb, core.Cfg.MaxSandboxes, core.Cfg.MaxPerUser); err != nil {
		return core.Sandbox{}, err
	}
	core.Logf("sandbox", "created %s owner=%s repo=%s", container, owner, repo)

	go func() {
		if err := detectSandbox(container, repo, workdir, instructions); err != nil {
			fmt.Printf("Sandbox detection failed: %v\n", err)
			core.UpdateSandbox(container, func(s *core.Sandbox) {
				s.Status = core.StatusFailed
				s.Error = err.Error()
			})
			return
		}
		if autoApprove {
			go approveSandbox(container, nil)
		}
	}()

	return sb, nil
}

func detectSandbox(container, repo, workdir, instructions string) error {
	core.AddLog(container, "Cloning repo: "+repo)
	err := core.Run(
		container,
		"git", "clone",
		"--depth", "1",
		"--single-branch",
		"--recurse-submodules=no",
		"--", repo, workdir,
	)
	if err != nil {
		core.AddLog(container, "Failed to clone repo: "+err.Error())
		return err
	}
	if n := core.PruneEscapingSymlinks(workdir); n > 0 {
		core.AddLog(container, fmt.Sprintf("Removed %d symlink(s) pointing outside the repo", n))
	}

	if strings.TrimSpace(instructions) != "" {
		if err := os.WriteFile(filepath.Join(workdir, "INSTRUCTIONS.md"), []byte(instructions), 0644); err != nil {
			return err
		}
	}

	core.AddLog(container, "Scanning for services...")
	plan, err := detect.Scan(workdir)
	if err != nil {
		core.AddLog(container, "Detection failed: "+err.Error())
		return err
	}

	for i := range plan.Services {
		plan.Services[i].Install = detect.NormalizeInstall(plan.Services[i].Install)
	}
	plan.NeedsBuild = !core.ImageExists(plan.Image)

	for _, s := range plan.Services {
		core.AddLog(container, fmt.Sprintf("Found %s: %s in %s (port %d)",
			s.Name, s.Framework, dirLabel(s.Dir), s.ContainerPort))
	}
	core.AddLog(container, "Image: "+plan.Image)
	if plan.NeedsBuild {
		core.AddLog(container, "That image is not built yet — approving will build it first.")
	}
	core.AddLog(container, "Waiting for approval before building.")

	primary, _ := plan.Primary()
	core.UpdateSandbox(container, func(s *core.Sandbox) {
		s.Status = core.StatusAwaiting
		s.Plan = &plan
		s.Image = plan.Image
		s.Framework = primary.Framework
	})
	return nil
}

func dirLabel(dir string) string {
	if dir == "" {
		return "the repo root"
	}
	return dir + "/"
}

// Edits the approval UI is allowed to make. Anything else stays as detected.
type serviceEdit struct {
	Name    string  `json:"name"`
	Enabled *bool   `json:"enabled,omitempty"`
	Port    *int    `json:"port,omitempty"`
	Install *string `json:"install,omitempty"`
	Start   *string `json:"start,omitempty"`
}

// Apply the user's edits, then build and run. nil edits means take the plan as-is.
func approveSandbox(container string, edits []serviceEdit) error {
	sb, ok := core.GetSandbox(container)
	if !ok {
		return fmt.Errorf("sandbox not found")
	}
	if sb.Plan == nil {
		return fmt.Errorf("nothing detected for this sandbox yet")
	}

	plan := *sb.Plan
	plan.Services = applyEdits(plan.Services, edits)

	services := plan.Enabled()
	if len(services) == 0 {
		return fmt.Errorf("no services are enabled")
	}

	// Dropping services can drop a whole toolchain, so the image is recomputed.
	plan.Stacks = stacksOf(services)
	plan.Image = core.ImageForStacks(plan.Stacks)

	var ports []core.PortMap
	for i := range services {
		if services[i].ContainerPort == 0 {
			continue
		}
		host, err := core.FreePort()
		if err != nil {
			return err
		}
		services[i].HostPort = host
		ports = append(ports, core.PortMap{Host: host, Container: services[i].ContainerPort})
	}

	primary := primaryOf(services)
	core.UpdateSandbox(container, func(s *core.Sandbox) {
		s.Status = core.StatusBuilding
		s.Services = services
		s.Image = plan.Image
		s.Port = primary.HostPort
		s.Framework = primary.Framework
		s.Plan = &plan
	})

	go func() {
		if err := launch(container, sb.Workdir, plan, services, ports); err != nil {
			core.AddLog(container, "Sandbox failed to start: "+err.Error())
			core.UpdateSandbox(container, func(s *core.Sandbox) {
				s.Status = core.StatusFailed
				s.Error = err.Error()
			})
		}
	}()
	return nil
}

func launch(container, workdir string, plan core.Plan, services []core.Service, ports []core.PortMap) error {
	stack := plan.Stacks[0]
	if p := primaryOf(services); p.Stack != "" {
		stack = p.Stack
	}
	if specErr := gitagent.GenerateAgentSpec(workdir, stack, services...); specErr != nil {
		core.AddLog(container, "Warning: GitAgent spec generation failed: "+specErr.Error())
	} else {
		core.AddLog(container, "GitAgent spec generated for stack: "+stack)
		if mapErr := gitagent.GenerateRepoMap(workdir, stack, primaryOf(services).Framework, services...); mapErr != nil {
			core.AddLog(container, "Warning: repo map generation failed: "+mapErr.Error())
		} else {
			core.AddLog(container, "Repo map generated (knowledge/repo-map.md)")
		}
		go gitagent.RegisterWithAgentService(container, workdir, stack, ownerOf(container))
	}

	core.UpdateSandbox(container, func(s *core.Sandbox) { s.Stage = "image" })
	if err := core.EnsureImage(container, plan.Image); err != nil {
		core.AddLog(container, "Failed to prepare the sandbox image: "+err.Error())
		return err
	}

	memory, cpus, pids := limitsFor(len(services))
	args := core.RunArgs(container, memory, cpus, pids, ports, workdir,
		sandboxEnv(services), core.CacheMounts(), plan.Image, supervisorScript(services))

	core.AddLog(container, fmt.Sprintf("Starting Docker container with %d service(s)...", len(services)))
	if err := core.Run(container, core.CLI(), args...); err != nil {
		core.AddLog(container, "Failed to start container: "+err.Error())
		return err
	}
	// Reaped while the image built: the container just started belongs to nobody.
	if _, ok := core.GetSandbox(container); !ok {
		core.Run("", core.CLI(), "rm", "-f", "-v", container)
		return nil
	}
	core.UpdateSandbox(container, func(s *core.Sandbox) { s.Stage = "container" })
	// The tunnel comes up while dependencies install, instead of adding its own wait at the end.
	core.OpenPreviews(container)

	primary := primaryOf(services)
	if primary.HostPort == 0 {
		core.AddLog(container, "No service serves HTTP — nothing to preview, but the terminal is live.")
	} else if !core.WaitForServer(primary.HostPort) {
		core.AddLog(container, "Warning: server not ready yet")
		out, _ := core.Output(container, core.CLI(), "logs", "--tail", "50", container)
		core.AddLog(container, "--- Container Logs ---\n"+out+"\n----------------------")
	} else {
		core.AddLog(container, "Server is ready! Open the preview to see the app.")
	}

	core.UpdateSandbox(container, func(s *core.Sandbox) {
		s.Status = core.StatusRunning
		s.LastActive = time.Now()
	})
	return nil
}

// Installs run one at a time — concurrent npm/pip would race over the shared cache
// volumes — then every server starts in parallel and the container lives as long as
// any of them does.
func supervisorScript(services []core.Service) string {
	var b strings.Builder
	b.WriteString("mkdir -p " + logDir + "\n")

	for _, s := range services {
		if s.Install == "" {
			continue
		}
		fmt.Fprintf(&b, "echo '--- installing %s ---' | tee -a %s\n", s.Name, serviceLog(s))
		fmt.Fprintf(&b, "(%s) >> %s 2>&1\n", cd(s, s.Install), serviceLog(s))
	}

	for _, s := range services {
		fmt.Fprintf(&b, "echo '--- starting %s ---' | tee -a %s\n", s.Name, serviceLog(s))
		fmt.Fprintf(&b, "(%s) >> %s 2>&1 &\n", cd(s, s.Start), serviceLog(s))
	}

	// Mirror every service's output to the container log so `docker logs` still works.
	fmt.Fprintf(&b, "tail -n +1 -F %s/*.log &\n", logDir)
	b.WriteString("wait\n")
	return b.String()
}

func cd(s core.Service, cmd string) string {
	if s.Dir == "" {
		return cmd
	}
	return "cd " + s.Dir + " && " + cmd
}

func serviceLog(s core.Service) string {
	return logDir + "/" + s.Name + ".log"
}

func sandboxEnv(services []core.Service) []string {
	env := []string{
		"NEXT_TELEMETRY_DISABLED=1",
		"CI=1",
	}
	env = append(env, core.WatcherEnv()...)
	env = append(env, core.HeadlessEnv...)
	if p := primaryOf(services); p.ContainerPort != 0 {
		env = append(env, fmt.Sprintf("PORT=%d", p.ContainerPort))
	}
	return env
}

// A three-service repo cannot live inside one service's budget.
func limitsFor(n int) (string, string, int) {
	mem := 768 * n
	if mem > 4096 {
		mem = 4096
	}
	if mem < 1024 {
		mem = 1024
	}
	cpus := "1"
	if n > 1 {
		cpus = "2"
	}
	return fmt.Sprintf("%dm", mem), cpus, 100 * n
}

func applyEdits(services []core.Service, edits []serviceEdit) []core.Service {
	byName := map[string]serviceEdit{}
	for _, e := range edits {
		byName[e.Name] = e
	}
	out := make([]core.Service, 0, len(services))
	for _, s := range services {
		if e, ok := byName[s.Name]; ok {
			if e.Enabled != nil {
				s.Enabled = *e.Enabled
			}
			if e.Port != nil && *e.Port >= 0 && *e.Port < 65536 {
				s.ContainerPort = *e.Port
			}
			if e.Install != nil {
				s.Install = *e.Install
			}
			if e.Start != nil {
				s.Start = *e.Start
			}
		}
		out = append(out, s)
	}
	return out
}

func stacksOf(services []core.Service) []string {
	seen := map[string]bool{}
	var out []string
	for _, s := range services {
		if s.Stack == "" || seen[s.Stack] {
			continue
		}
		seen[s.Stack] = true
		out = append(out, s.Stack)
	}
	return out
}

// The enabled primary, or the first thing that serves HTTP once it was disabled.
func primaryOf(services []core.Service) core.Service {
	for _, s := range services {
		if s.Primary {
			return s
		}
	}
	for _, s := range services {
		if s.ContainerPort != 0 {
			return s
		}
	}
	if len(services) > 0 {
		return services[0]
	}
	return core.Service{}
}

func runHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	var req Request
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		core.JSONError(w, "invalid request", 400)
		return
	}
	mode := req.Mode
	if mode == "" {
		mode = "prompt"
	}
	sb, err := startSandbox(core.UserOf(r), req.Repo, req.Instructions, mode, req.AutoApprove)
	if err != nil {
		code := 400
		if core.IsCapacityError(err) {
			code = 429
		}
		core.JSONError(w, err.Error(), code)
		return
	}
	writeJSON(w, map[string]interface{}{
		"status":    sb.Status,
		"container": sb.Container,
		"mode":      mode,
	})
}

// The clone runs in the background, so the UI polls here for the plan to approve.
func runPlanHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	sb, ok := ownedSandbox(w, r, r.URL.Query().Get("container"))
	if !ok {
		return
	}
	resp := map[string]interface{}{"container": sb.Container, "status": sb.Status, "repo": sb.Repo}
	if sb.Plan != nil {
		resp["plan"] = sb.Plan
	}
	if sb.Error != "" {
		resp["error"] = sb.Error
	}
	writeJSON(w, resp)
}

func runApproveHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	var req struct {
		Container string        `json:"container"`
		Services  []serviceEdit `json:"services"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		core.JSONError(w, "invalid request", 400)
		return
	}
	if _, ok := ownedSandbox(w, r, req.Container); !ok {
		return
	}
	if err := approveSandbox(req.Container, req.Services); err != nil {
		core.JSONError(w, err.Error(), 400)
		return
	}
	sb, _ := core.GetSandbox(req.Container)
	writeJSON(w, map[string]interface{}{
		"status":    sb.Status,
		"container": sb.Container,
		"image":     sb.Image,
		"services":  sb.Services,
		"url":       core.PrimaryPreviewURL(sb),
	})
}

func listHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	user := core.UserOf(r)
	mine := map[string]core.Sandbox{}
	for name, sb := range core.SandboxMap() {
		if core.CanUse(user, sb.Owner) {
			sb.URL = core.PrimaryPreviewURL(sb)
			mine[name] = sb
		}
	}
	writeJSON(w, mine)
}

func ownerOf(container string) string {
	sb, _ := core.GetSandbox(container)
	return sb.Owner
}

// 404 for someone else's sandbox too, so ownership never reveals that a name exists.
func ownedSandbox(w http.ResponseWriter, r *http.Request, container string) (core.Sandbox, bool) {
	sb, ok := core.GetSandbox(container)
	if !ok || !core.CanUse(core.UserOf(r), sb.Owner) {
		core.JSONError(w, "sandbox not found", 404)
		return core.Sandbox{}, false
	}
	if !passivePoll(r.URL.Path) {
		core.Touch(container)
	}
	return sb, true
}

// The IDE polls these on a timer, so they say nothing about whether anyone is still there.
func passivePoll(path string) bool {
	return path == "/sandbox/status" || path == "/run/plan" || strings.HasPrefix(path, "/logs/")
}

func stopHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method != http.MethodPost {
		core.JSONError(w, "method not allowed", 405)
		return
	}
	container := strings.TrimPrefix(r.URL.Path, "/stop/")
	sb, ok := ownedSandbox(w, r, container)
	if !ok {
		return
	}
	core.Reap(sb, "stopped by owner")
	writeJSON(w, map[string]string{"status": "stopped"})
}

func logsHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	w.Header().Set("Content-Type", "text/plain")
	container := strings.TrimPrefix(r.URL.Path, "/logs/")
	if _, ok := ownedSandbox(w, r, container); !ok {
		return
	}
	slog, _ := core.LogsFor(container)

	// One service's log, which survives that service crashing.
	if svc := r.URL.Query().Get("service"); svc != "" {
		if !validServiceName(container, svc) {
			core.JSONError(w, "unknown service", 404)
			return
		}
		out, err := core.Output("", core.CLI(), "exec", container, "cat", logDir+"/"+svc+".log")
		if err != nil {
			fmt.Fprint(w, slog+"\n[no output from "+svc+" yet]")
			return
		}
		fmt.Fprint(w, out)
		return
	}

	out, err := core.Output("", core.CLI(), "logs", container)
	if err != nil {
		fmt.Fprint(w, slog+"\n[Error fetching container logs: "+err.Error()+"]")
		return
	}
	fmt.Fprint(w, slog+"\n"+out)
}

// The name goes into a container path, so only names we detected are accepted.
func validServiceName(container, name string) bool {
	sb, ok := core.GetSandbox(container)
	if !ok {
		return false
	}
	for _, s := range sb.Services {
		if s.Name == name {
			return true
		}
	}
	return false
}

func sandboxStatusHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	sb, ok := ownedSandbox(w, r, r.URL.Query().Get("container"))
	if !ok {
		return
	}

	status := sb.Status
	switch status {
	case core.StatusDetecting, core.StatusAwaiting, core.StatusBuilding, core.StatusFailed:
		// Pre-Docker states are authoritative on their own.
	default:
		out, err := core.Output("", core.CLI(), "inspect", "--format", "{{.State.Status}}", sb.Container)
		status = strings.TrimSpace(out)
		if err != nil {
			status = "unknown"
		}
		if status == "running" && !portAnswers(sb.Port) {
			status = "starting"
		}
	}

	services := make([]map[string]interface{}, 0, len(sb.Services))
	for _, s := range sb.Services {
		entry := map[string]interface{}{
			"name": s.Name, "dir": s.Dir, "stack": s.Stack,
			"framework": s.Framework, "port": s.HostPort, "primary": s.Primary,
		}
		if s.HostPort != 0 {
			entry["url"] = core.ServicePreviewURL(sb, s)
			entry["ready"] = portAnswers(s.HostPort)
		}
		services = append(services, entry)
	}

	url := core.PrimaryPreviewURL(sb)
	stage, detail := stageOf(sb, status, url)
	writeJSON(w, map[string]interface{}{
		"container": sb.Container,
		"port":      sb.Port,
		"repo":      sb.Repo,
		"status":    status,
		"stage":     stage,
		"detail":    detail,
		"url":       url,
		"framework": sb.Framework,
		"image":     sb.Image,
		"services":  services,
		"error":     sb.Error,
	})
}

var ansiEscape = regexp.MustCompile(`\x1b\[[0-9;?]*[A-Za-z]`)

// The newest meaningful line of a log, so the UI can say what is happening right now.
func lastLogLine(out string) string {
	lines := strings.Split(ansiEscape.ReplaceAllString(out, ""), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		// npm redraws progress with \r, so only the text after the last one is current.
		l := lines[i]
		if j := strings.LastIndex(l, "\r"); j >= 0 {
			l = l[j+1:]
		}
		if l = strings.TrimSpace(l); l != "" && !strings.HasPrefix(l, "--- ") {
			if len(l) > 160 {
				l = l[:160] + "…"
			}
			return l
		}
	}
	return ""
}

// Install versus start comes from the supervisor's marker in the primary service's log.
func appPhase(sb core.Sandbox) (string, string) {
	p, ok := sb.PrimaryService()
	if !ok && len(sb.Services) > 0 {
		p = sb.Services[0]
	}
	if p.Name != "" {
		if out, err := core.Output("", core.CLI(), "exec", sb.Container, "tail", "-n", "40", serviceLog(p)); err == nil {
			if strings.Contains(out, "--- starting") {
				return "start", lastLogLine(out)
			}
			// npm and pip run quietly here, so silence usually just means the download is still going.
			if line := lastLogLine(out); line != "" {
				return "install", line
			}
			return "install", "Downloading and installing packages, usually 1 to 3 minutes on a first run"
		}
	}
	out, _ := core.Output("", core.CLI(), "logs", "--tail", "20", sb.Container)
	return "start", lastLogLine(out)
}

// One step name the UI can show, with the line of output that explains it.
func stageOf(sb core.Sandbox, status, url string) (string, string) {
	switch status {
	case core.StatusDetecting:
		return "clone", "Cloning the repository and looking for services"
	case core.StatusAwaiting:
		return "approve", "Review what was found, then start it"
	case core.StatusFailed, "exited", "dead", "unknown":
		msg := sb.Error
		if msg == "" {
			msg = "The sandbox stopped. Open the logs to see why."
		}
		return "failed", msg
	case core.StatusBuilding:
		if sb.Stage != "container" {
			return "image", "Preparing the " + strings.TrimPrefix(sb.Image, "sandbox-") + " runtime (the first build of a new kind of project takes a few minutes)"
		}
		return appPhase(sb)
	case "starting":
		return appPhase(sb)
	}
	if sb.Port == 0 {
		return "ready", "Running; this project serves no web page to preview"
	}
	if url == "" {
		return "preview", "Opening the public preview link"
	}
	return "ready", "Your app is live"
}

func portAnswers(port int) bool {
	if port == 0 {
		return false
	}
	client := http.Client{Timeout: 2 * time.Second}
	resp, err := client.Get(fmt.Sprintf("http://127.0.0.1:%d", port))
	if err != nil {
		return false
	}
	defer resp.Body.Close()
	return resp.StatusCode < 500
}

// sandboxEntryHandler returns the best-guess "main UI" file for a sandbox as a
// workspace-relative path (forward slashes, matching the file-tree paths) plus
// its directory, so the preview's "locate UI code" control can open/reveal it.
func sandboxEntryHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}
	containerID := r.URL.Query().Get("container")
	sb, ok := ownedSandbox(w, r, containerID)
	if !ok {
		return
	}
	// Look inside the requested service's directory first, then the repo root.
	roots := []string{""}
	if name := r.URL.Query().Get("service"); name != "" {
		for _, s := range sb.Services {
			if s.Name == name && s.Dir != "" {
				roots = append([]string{s.Dir}, roots...)
			}
		}
	} else if p, ok := sb.PrimaryService(); ok && p.Dir != "" {
		roots = append([]string{p.Dir}, roots...)
	}

	for _, root := range roots {
		for _, c := range core.UIEntryCandidates {
			rel := c
			if root != "" {
				rel = root + "/" + c
			}
			p := filepath.Join(sb.Workdir, filepath.FromSlash(rel))
			if st, err := os.Stat(p); err == nil && !st.IsDir() {
				dir := ""
				if i := strings.LastIndex(rel, "/"); i >= 0 {
					dir = rel[:i]
				}
				writeJSON(w, map[string]string{"path": rel, "dir": dir})
				return
			}
		}
	}
	core.JSONError(w, "no UI entry file found yet", 404)
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}
