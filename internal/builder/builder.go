package builder

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"sandbox/internal/core"
	"sandbox/internal/gitagent"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// Build history (in-memory)

type BuildRecord struct {
	ID        string    `json:"id"`
	AppName   string    `json:"appName"`
	Prompt    string    `json:"prompt"`
	PRD       *PRD      `json:"prd"`
	Container string    `json:"container,omitempty"`
	URL       string    `json:"url,omitempty"`
	Status    string    `json:"status"` // "building" | "ready" | "error"
	CreatedAt time.Time `json:"createdAt"`
	Owner     string    `json:"-"`
	// Where the finished app was pushed: GitHubStatus is "pushing", "pushed" or "failed".
	GitHub       string          `json:"github,omitempty"`
	GitHubStatus string          `json:"githubStatus,omitempty"`
	GitHubError  string          `json:"githubError,omitempty"`
	Flows        []BuiltWorkflow `json:"-"`
}

// Set by the server: runs once a build's files are in place, to push the app to the owner's GitHub.
var OnReady func(owner, container, buildID string, prd *PRD, flows []BuiltWorkflow)

func SetBuildGitHub(buildID, status, url, errMsg string) {
	updateBuildRecord(buildID, func(r *BuildRecord) {
		r.GitHubStatus, r.GitHubError = status, errMsg
		if url != "" {
			r.GitHub = url
		}
	})
}

// The build that produced a container, so publishing it later can still use its PRD and workflows.
func RecordForContainer(container string) (BuildRecord, bool) {
	buildHistMu.Lock()
	defer buildHistMu.Unlock()
	for _, r := range buildHistory {
		if r.Container == container {
			return r, true
		}
	}
	return BuildRecord{}, false
}

var (
	buildHistory []BuildRecord
	buildHistMu  sync.Mutex
)

func addBuildRecord(r BuildRecord) {
	buildHistMu.Lock()
	defer buildHistMu.Unlock()
	buildHistory = append([]BuildRecord{r}, buildHistory...) // newest first
	if len(buildHistory) > 20 {
		buildHistory = buildHistory[:20]
	}
}

func updateBuildRecord(id string, fn func(*BuildRecord)) {
	buildHistMu.Lock()
	defer buildHistMu.Unlock()
	for i := range buildHistory {
		if buildHistory[i].ID == id {
			fn(&buildHistory[i])
			return
		}
	}
}

// Groq API client — multi-key pool with TPM headroom throttling Groq's free tier enforces a per-organization tokens-per-minute (TPM) limit and counts input + output tokens toward the same budget.

const groqEndpoint = "https://api.groq.com/openai/v1/chat/completions"
const groqModel = "openai/gpt-oss-120b"

type groqMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type groqRequest struct {
	Model       string        `json:"model"`
	Messages    []groqMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens"`
	// gpt-oss charges reasoning against max_tokens, so keep it low or the answer truncates.
	ReasoningEffort string `json:"reasoning_effort,omitempty"`
}

type groqResponse struct {
	Choices []struct {
		Message struct {
			Content string `json:"content"`
		} `json:"message"`
	} `json:"choices"`
	Usage struct {
		PromptTokens     int `json:"prompt_tokens"`
		CompletionTokens int `json:"completion_tokens"`
		TotalTokens      int `json:"total_tokens"`
	} `json:"usage"`
	Error *struct {
		Message string `json:"message"`
	} `json:"error,omitempty"`
}

// groqKey tracks one API key's rolling-window token usage.
type groqKey struct {
	key           string
	label         string
	mu            sync.Mutex
	windowStart   time.Time
	used          int       // tokens charged in the current 60s window
	cooldownUntil time.Time // set when this org returns 429
	// The org's per-request token cap, learned from a "Request too large" reply; orgs on different tiers differ.
	limit int
	// Set when Groq refused the key for its daily token quota.
	dailyOut bool
}

type groqPool struct {
	keys     []*groqKey
	tpm      int     // per-key tokens-per-minute limit
	headroom float64 // fraction of tpm we actually allow (e.g. 0.85)
	rr       uint64  // round-robin cursor
}

var (
	groqPoolMu   sync.Mutex
	groqPoolInst *groqPool
)

func getGroqPool() *groqPool {
	groqPoolMu.Lock()
	defer groqPoolMu.Unlock()
	if groqPoolInst == nil {
		groqPoolInst = buildGroqPool()
	}
	return groqPoolInst
}

// Rebuilds the pool from the environment on next use, after a key is saved or removed in Settings.
func ResetGroqPool() {
	groqPoolMu.Lock()
	groqPoolInst = nil
	groqPoolMu.Unlock()
}

func buildGroqPool() *groqPool {
	// The user's saved Groq keys if any, else the .env ones.
	raw := core.ProviderKeys("groq")

	seen := map[string]bool{}
	var keys []*groqKey
	for _, k := range raw {
		if seen[k] {
			continue
		}
		seen[k] = true
		keys = append(keys, &groqKey{key: k, label: fmt.Sprintf("groq-key#%d", len(keys)+1)})
	}

	tpm := 12000
	if v := strings.TrimSpace(os.Getenv("GROQ_TPM")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			tpm = n
		}
	}
	headroom := 0.85
	if v := strings.TrimSpace(os.Getenv("GROQ_TPM_HEADROOM")); v != "" {
		if f, err := strconv.ParseFloat(v, 64); err == nil && f > 0 && f <= 1 {
			headroom = f
		}
	}
	return &groqPool{keys: keys, tpm: tpm, headroom: headroom}
}

func (p *groqPool) budget() int { return int(float64(p.tpm) * p.headroom) }

// Picks a key with room in its current window for estTokens and charges it, skipping keys whose org refuses a request of need tokens.
func (p *groqPool) reserveFor(estTokens, need int) (*groqKey, error) {
	if len(p.keys) == 0 {
		return nil, fmt.Errorf("no Groq API key configured (set GROQ_API_KEY)")
	}
	budget := p.budget()
	if estTokens > budget {
		estTokens = budget // clamp: retry on a fresh window rather than spin forever
	}

	deadline := time.Now().Add(3 * time.Minute)
	for {
		now := time.Now()
		var soonest time.Time
		n := len(p.keys)
		start := int(atomic.AddUint64(&p.rr, 1))
		for i := 0; i < n; i++ {
			k := p.keys[(start+i)%n]
			k.mu.Lock()
			if now.Sub(k.windowStart) >= time.Minute {
				k.windowStart = now
				k.used = 0
			}
			if need > 0 && k.limit > 0 && k.limit < need {
				k.mu.Unlock()
				continue
			}
			ready := now.After(k.cooldownUntil)
			if ready && k.used+estTokens <= budget {
				k.used += estTokens
				k.mu.Unlock()
				return k, nil
			}
			avail := k.windowStart.Add(time.Minute)
			if !ready && k.cooldownUntil.After(avail) {
				avail = k.cooldownUntil
			}
			if soonest.IsZero() || avail.Before(soonest) {
				soonest = avail
			}
			k.mu.Unlock()
		}
		wait := time.Until(soonest)
		if wait <= 0 {
			wait = 500 * time.Millisecond
		}
		if time.Now().Add(wait).After(deadline) {
			if p.allDailyOut() {
				return nil, fmt.Errorf("every Groq key has used today's free token quota; add another key in Settings or try again later")
			}
			return nil, fmt.Errorf("groq rate-limit: no key with %d-token headroom available within timeout", estTokens)
		}
		time.Sleep(wait)
	}
}

// reconcile adjusts a key's window usage once actual token counts are known (the reservation used an estimate).
func (k *groqKey) reconcile(reserved, actual int) {
	k.mu.Lock()
	defer k.mu.Unlock()
	k.used += actual - reserved
	if k.used < 0 {
		k.used = 0
	}
}

// penalize takes a key out of rotation until the org's rate window resets.
func (k *groqKey) penalize(retryAfter time.Duration) {
	if retryAfter <= 0 {
		retryAfter = 60 * time.Second
	}
	k.mu.Lock()
	defer k.mu.Unlock()
	k.cooldownUntil = time.Now().Add(retryAfter)
}

func estimateTokens(s string) int { return len(s)/4 + 8 } // ~4 chars/token

func (p *groqPool) allDailyOut() bool {
	for _, k := range p.keys {
		k.mu.Lock()
		out := k.dailyOut && time.Now().Before(k.cooldownUntil)
		k.mu.Unlock()
		if !out {
			return false
		}
	}
	return len(p.keys) > 0
}

// The largest request some key can take: 0 when a key's limit is still unknown (it may take anything).
func (p *groqPool) largestLimit() int {
	most := 0
	for _, k := range p.keys {
		k.mu.Lock()
		l := k.limit
		k.mu.Unlock()
		if l == 0 {
			return 0
		}
		if l > most {
			most = l
		}
	}
	return most
}

var groqTooLarge = regexp.MustCompile(`Limit (\d+), Requested (\d+)`)

func parseRetryAfter(h string) time.Duration {
	if h = strings.TrimSpace(h); h == "" {
		return 0
	}
	if secs, err := strconv.ParseFloat(h, 64); err == nil && secs > 0 {
		return time.Duration(secs * float64(time.Second))
	}
	return 0
}

func callGroq(systemPrompt, userPrompt string, maxTokens int) (string, error) {
	return callGroqEffort(systemPrompt, userPrompt, maxTokens, "low")
}

// Planning calls reason harder; gpt-oss spends that reasoning from maxTokens.
func callGroqEffort(systemPrompt, userPrompt string, maxTokens int, effort string) (string, error) {
	pool := getGroqPool()
	if len(pool.keys) == 0 {
		return "", fmt.Errorf("GROQ_API_KEY not set in environment")
	}
	estTotal := estimateTokens(systemPrompt) + estimateTokens(userPrompt) + maxTokens
	need := 0
	build := func() ([]byte, error) {
		return json.Marshal(groqRequest{
			Model: groqModel,
			Messages: []groqMessage{
				{Role: "system", Content: systemPrompt},
				{Role: "user", Content: userPrompt},
			},
			Temperature:     0.7,
			MaxTokens:       maxTokens,
			ReasoningEffort: effort,
		})
	}
	body, err := build()
	if err != nil {
		return "", err
	}

	maxAttempts := 5 + len(pool.keys)
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		key, err := pool.reserveFor(estTotal, need)
		if err != nil {
			return "", err
		}

		req, err := http.NewRequest("POST", groqEndpoint, bytes.NewReader(body))
		if err != nil {
			key.reconcile(estTotal, 0)
			return "", err
		}
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Authorization", "Bearer "+key.key)

		client := &http.Client{Timeout: 120 * time.Second}
		resp, err := client.Do(req)
		if err != nil {
			key.reconcile(estTotal, 0) // refund on transport failure
			lastErr = fmt.Errorf("groq request failed: %w", err)
			continue
		}
		respBody, readErr := io.ReadAll(resp.Body)
		resp.Body.Close()
		if readErr != nil {
			key.reconcile(estTotal, 0)
			lastErr = readErr
			continue
		}

		if resp.StatusCode == http.StatusTooManyRequests {
			wait := parseRetryAfter(resp.Header.Get("Retry-After"))
			lastErr = fmt.Errorf("groq rate limited (429) on %s", key.label)
			// A key out of its daily tokens sits out until Groq says it resets, so no request waits on it again today.
			if strings.Contains(string(respBody), "per day") {
				if wait < time.Minute {
					wait = 30 * time.Minute
				}
				key.mu.Lock()
				key.dailyOut = true
				key.mu.Unlock()
				core.Logf("builder", "%s has used its daily Groq tokens; resting it for %s", key.label, wait.Round(time.Minute))
			}
			key.penalize(wait)
			continue // reserveFor picks another key or waits for a reset
		}

		var gr groqResponse
		if err := json.Unmarshal(respBody, &gr); err != nil {
			key.reconcile(estTotal, 0)
			return "", fmt.Errorf("failed to parse groq response: %w", err)
		}
		if gr.Error != nil {
			key.reconcile(estTotal, 0)
			if m := groqTooLarge.FindStringSubmatch(gr.Error.Message); m != nil {
				limit, _ := strconv.Atoi(m[1])
				requested, _ := strconv.Atoi(m[2])
				key.mu.Lock()
				key.limit = limit
				key.mu.Unlock()
				need = requested
				lastErr = fmt.Errorf("groq error: %s", gr.Error.Message)
				// Another org may take the request as it is; if none can, the output reservation shrinks to fit the largest.
				if most := pool.largestLimit(); most != 0 && most < requested {
					cut := requested - most + 64
					if maxTokens-cut < 1000 {
						return "", lastErr
					}
					maxTokens -= cut
					estTotal -= cut
					need = most
					if body, err = build(); err != nil {
						return "", err
					}
				}
				continue
			}
			if strings.Contains(strings.ToLower(gr.Error.Message), "rate limit") {
				key.penalize(0) // some rate-limit errors arrive as 200 with an error body
				lastErr = fmt.Errorf("groq error: %s", gr.Error.Message)
				continue
			}
			return "", fmt.Errorf("groq error: %s", gr.Error.Message)
		}
		if len(gr.Choices) == 0 {
			key.reconcile(estTotal, 0)
			return "", fmt.Errorf("groq returned no choices")
		}
		if gr.Usage.TotalTokens > 0 {
			key.reconcile(estTotal, gr.Usage.TotalTokens)
		}
		return gr.Choices[0].Message.Content, nil
	}
	if lastErr == nil {
		lastErr = fmt.Errorf("groq request failed after %d attempts", maxAttempts)
	}
	return "", lastErr
}

// Data structures

type Question struct {
	ID      string   `json:"id"`
	Text    string   `json:"text"`
	Kind    string   `json:"kind,omitempty"` // experience, ai, capability, design or stack
	Options []string `json:"options,omitempty"`
	// One sentence per option, at the same index, on what choosing it means for the user.
	Details     []string `json:"details,omitempty"`
	Multi       bool     `json:"multi,omitempty"`
	Recommended []int    `json:"recommended,omitempty"`
}

type PRD struct {
	Name        string              `json:"name"`
	Tagline     string              `json:"tagline"`
	Vision      string              `json:"vision,omitempty"`
	TargetUsers string              `json:"target_users"`
	CoreLoop    string              `json:"core_loop,omitempty"`
	Features    []string            `json:"features"`
	Pages       []string            `json:"pages"`
	UINote      string              `json:"ui_note"`
	DataModel   map[string][]string `json:"data_model"`
	EdgeCases   []string            `json:"edge_cases,omitempty"`
	OutOfScope  []string            `json:"out_of_scope"`
	Design      *DesignDirection    `json:"design,omitempty"`
	AI          *AIPlan             `json:"ai,omitempty"`
	Stack       string              `json:"stack,omitempty"`
}

type GeneratedFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// /build/scaffold

// The Next.js dev server's port inside every builder container.
const builderPort = 3000

func ScaffoldHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}

	var req struct {
		PRD       *PRD            `json:"prd"`
		Workflows []BuiltWorkflow `json:"workflows"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PRD == nil {
		core.JSONError(w, "prd is required", 400)
		return
	}
	if err := validateBuiltWorkflows(req.Workflows); err != nil {
		core.JSONError(w, err.Error(), 400)
		return
	}

	prd := req.PRD
	flows := req.Workflows
	if stack, ok := StackByID(prd.Stack); ok && stack.ID != "nextjs" {
		scaffoldStack(w, r, prd, flows, stack)
		return
	}

	port, err := core.FreePort()
	if err != nil {
		core.JSONError(w, "failed to get port: "+err.Error(), 500)
		return
	}
	workdir, err := os.MkdirTemp(core.Cfg.WorkDir, "builder-*")
	if err != nil {
		core.JSONError(w, "failed to create workdir: "+err.Error(), 500)
		return
	}
	workdir, _ = filepath.Abs(workdir)

	buildID := fmt.Sprintf("build-%d", time.Now().UnixMilli())
	container := "builder-" + buildID
	sb := core.Sandbox{
		Container: container,
		Port:      port,
		Repo:      "generated:" + prd.Name,
		Workdir:   workdir,
		Owner:     core.UserOf(r),
		// Building until the container runs, so the status check never asks Docker about a container that does not exist yet.
		Status: core.StatusBuilding,
		Stage:  "generating",
		Services: []core.Service{{Name: "app", Stack: "builder", Framework: "nextjs",
			ContainerPort: builderPort, HostPort: port, Primary: true, Enabled: true}},
	}
	// The slot is taken before anything is recorded, so a full server leaves no half-made build behind.
	if err := core.AddSandbox(sb, core.Cfg.MaxSandboxes, core.Cfg.MaxPerUser); err != nil {
		os.RemoveAll(workdir)
		core.JSONError(w, err.Error(), 429)
		return
	}
	core.EnsureNetworkBeforeRun()
	addBuildRecord(BuildRecord{
		ID:        buildID,
		AppName:   prd.Name,
		PRD:       prd,
		Status:    "building",
		CreatedAt: time.Now(),
		Owner:     sb.Owner,
	})

	// Return immediately — scaffold happens async
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "scaffolding",
		"container": container,
		"build_id":  buildID,
		"url":       previewURLOf(container),
	})

	// Async: copy template, generate code, start container
	go func() {
		if err := scaffoldAndRun(workdir, container, port, prd, flows, buildID); err != nil {
			fmt.Printf("Scaffold error for %s: %v\n", buildID, err)
			updateBuildRecord(buildID, func(r *BuildRecord) {
				r.Status = "error"
			})
			core.AddLog(container, "Scaffold failed: "+err.Error())
			core.UpdateSandbox(container, func(s *core.Sandbox) {
				s.Status = core.StatusFailed
				s.Error = err.Error()
				s.LastActive = time.Now()
			})
		}
	}()
}

func previewURLOf(container string) string {
	sb, _ := core.GetSandbox(container)
	return core.PrimaryPreviewURL(sb)
}

func scaffoldAndRun(workdir, container string, port int, prd *PRD, flows []BuiltWorkflow, buildID string) error {
	core.AddLog(container, "Copying Next.js template...")

	// Copy embedded builder-template to workdir
	if err := Materialise(workdir, "nextjs"); err != nil {
		return fmt.Errorf("template copy failed: %w", err)
	}
	if err := writeNextShell(workdir, prd); err != nil {
		return fmt.Errorf("writing the app shell failed: %w", err)
	}
	core.AddLog(container, "Template copied and the app shell laid out.")

	if len(flows) > 0 {
		if err := writeWorkflowClient(workdir, flows); err != nil {
			return fmt.Errorf("writing the workflow client failed: %w", err)
		}
		core.AddLog(container, fmt.Sprintf("Connected %d Agent Hub workflow(s) through app/api/workflows.", len(flows)))
	}

	// Generate code from PRD via Groq
	core.AddLog(container, "Generating app code with Groq AI...")
	files, err := generateCode(prd, flows)
	if err != nil {
		return fmt.Errorf("code generation failed: %w", err)
	}
	core.AddLog(container, fmt.Sprintf("Generated %d files.", len(files)))

	// Write generated files (only allowed paths), then repair syntax slips and broken imports before the container starts.
	allowedDirs := []string{"app/", "components/app/", "lib/", "public/"}
	write := func(f GeneratedFile) (string, bool) {
		if reservedPath(f.Path) {
			core.AddLog(container, "Keeping the template's file, skipping: "+f.Path)
			return "", false
		}
		if !isAllowedPath(f.Path, allowedDirs) {
			core.AddLog(container, fmt.Sprintf("Skipping disallowed path: %s", f.Path))
			return "", false
		}
		absPath := filepath.Join(workdir, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(absPath), fs.ModePerm); err != nil {
			core.AddLog(container, "mkdir error: "+err.Error())
			return "", false
		}
		processedContent := postProcessCode(f.Content, f.Path)
		if strings.HasSuffix(f.Path, ".tsx") || strings.HasSuffix(f.Path, ".jsx") {
			var fixed []string
			if processedContent, fixed = fixIconImports(processedContent); len(fixed) > 0 {
				core.AddLog(container, "Replaced icons lucide-react does not have in "+f.Path+": "+strings.Join(fixed, ", "))
			}
		}
		if err := os.WriteFile(absPath, []byte(processedContent), 0644); err != nil {
			core.AddLog(container, "write error for "+f.Path+": "+err.Error())
			return "", false
		}
		core.AddLog(container, "Wrote: "+f.Path)
		return f.Path, true
	}
	var written []string
	for _, f := range files {
		if rel, ok := write(f); ok {
			written = append(written, rel)
		}
	}
	nextPackages := map[string]bool{"next": true}
	for k := range allowedImportModules {
		nextPackages[k] = true
	}
	rules := &importRules{packages: nextPackages}
	written = checkAndRepair(container, workdir, groqCodeGenSystemPrompt, written, true, rules, write)
	shimMissingUI(container, workdir, written, rules)

	appendTheme(filepath.Join(workdir, "app", "globals.css"), prd)
	core.AddLog(container, "shadcn/ui theme applied.")

	// Update app name in layout.tsx metadata
	updateAppMetadata(workdir, prd)

	// Fix 1: Use the preheated sandbox-builder image instead of sandbox-react.
	core.AddLog(container, "Starting Docker sandbox (preheated builder image)...")
	const builderImage = "sandbox-builder"
	// node_modules lives in one shared volume, filled from the image once per dependency version instead of copying 380 MB on every build.
	const builderStartCmd = `flock /workspace/node_modules/.jr-lock sh -c '[ "$(cat node_modules/.jr-deps 2>/dev/null)" = "` + builderDepsVersion + `" ] || { find node_modules -mindepth 1 -maxdepth 1 ! -name .jr-lock -exec rm -rf {} + ; cp -r /opt/builder-deps/node_modules/. ./node_modules/ && echo ` + builderDepsVersion + ` > node_modules/.jr-deps; }' && npm run dev -- -H 0.0.0.0`

	stack := core.ImageToStack(builderImage)
	if specErr := gitagent.GenerateAgentSpec(workdir, stack); specErr != nil {
		core.AddLog(container, "Warning: agent spec generation failed: "+specErr.Error())
	} else {
		owner := ""
		if sb, ok := core.GetSandbox(container); ok {
			owner = sb.Owner
		}
		go gitagent.RegisterWithAgentService(container, workdir, stack, owner)
	}

	env := []string{
		fmt.Sprintf("PORT=%d", builderPort),
		"NEXT_TELEMETRY_DISABLED=1",
		"CI=1",
	}
	env = append(env, core.WatcherEnv()...)
	env = append(env, core.HeadlessEnv...)
	// A named volume shared by every builder keeps node_modules on fast native storage and fills it only once.
	mounts := []string{
		"-v", "/root/.npm",
		"-v", builderModulesVolume + ":/workspace/node_modules",
	}
	if len(flows) > 0 {
		mounts = append(mounts, hostGatewayArgs()...)
	}
	args := core.RunArgs(container, "1536m", "1.5", 200, []core.PortMap{{Host: port, Container: builderPort}}, workdir, env, mounts, builderImage, builderStartCmd)

	if err := core.EnsureImage(container, builderImage); err != nil {
		return err
	}
	if err := core.Run(container, core.CLI(), args...); err != nil {
		return fmt.Errorf("docker run failed: %w", err)
	}
	if _, ok := core.GetSandbox(container); !ok {
		core.Run("", core.CLI(), "rm", "-f", "-v", container)
		return nil
	}
	core.UpdateSandbox(container, func(s *core.Sandbox) { s.Stage = "container" })
	core.OpenPreviews(container)

	// Once the dev server answers, every page is opened and any that errors is repaired from its real error.
	if waitForAnswer(port, 3*time.Minute) {
		healPages(container, workdir, port, prd, groqCodeGenSystemPrompt, rules, write)
	}
	if !waitForHome(port, 2*time.Minute) {
		core.AddLog(container, "The app is up but its home page still shows an error; open the IDE to see it and fix it with the coding agent.")
	} else {
		core.AddLog(container, "App is ready. Open the preview to see it.")
	}

	updateBuildRecord(buildID, func(r *BuildRecord) {
		r.Status = "ready"
		r.Container = container
		r.URL = previewURLOf(container)
		r.Flows = flows
	})
	if OnReady != nil {
		owner := ""
		if sb, ok := core.GetSandbox(container); ok {
			owner = sb.Owner
		}
		go OnReady(owner, container, buildID, prd, flows)
	}
	core.UpdateSandbox(container, func(s *core.Sandbox) {
		s.Status = core.StatusRunning
		s.LastActive = time.Now()
	})

	return nil
}

// The shared node_modules volume for builder containers; bump the version whenever sandbox-images/builder/package.json changes.
const (
	builderModulesVolume = "jr-builder-node-modules"
	builderDepsVersion   = "next-14.2.3-1"
)

// Code generation via Groq

var groqCodeGenSystemPrompt = `You are an expert Next.js 14 developer using the App Router, TypeScript, and Tailwind CSS.
Given a PRD, generate production-quality Next.js application files.

RULES:
1. Return ONLY a valid JSON array of file objects: [{"path": "...", "content": "..."}]
2. No markdown fences, no preamble, no explanation — raw JSON array only
3. Only generate files in these directories: app/, components/app/, lib/
4. Use Tailwind CSS classes only — no inline styles (except for CSS variables)
5. Use the pre-built shadcn/ui components listed below; never write your own button, card, input, dialog or tabs.
6. Import shared data/types from @/lib/data
7. Keep each file under 250 lines
8. Use "use client" directive only for components with interactivity
9. Follow the DESIGN rules and the app's DESIGN DIRECTION; the result must look made for this app's subject and work at 375px wide
10. The app is 100% CLIENT-SIDE and LOCAL. Make ZERO network calls of any kind — no fetch, axios, or XMLHttpRequest; no external APIs; no third-party services (Gmail, Google, Stripe/payments, sign-in/OAuth providers, email/SMS, analytics, remote fonts or CDNs). The ONLY packages you may import are: react, react-dom, next (including next/link, next/image, next/navigation), lucide-react, clsx, class-variance-authority, tailwind-merge, and local "@/..." imports. Importing ANY other package breaks the build — never do it.
10b. PERSIST the user's data with useStored from @/lib/use-stored (already exists, never write it): const [recipes, setRecipes] = useStored("recipes", seedRecipes), where the initial value is the matching seed export of @/lib/data, so every screen starts full and the user's changes survive a reload. Never start a list from an empty array and never touch localStorage yourself. Components using hooks are client components ("use client" at line 1).
11. Always replace app/page.tsx and lib/data.ts
12. Generate components/app/ files for complex UI pieces
13. Colours come only from the theme classes (bg-background, bg-card, bg-muted, text-muted-foreground, bg-primary, border...). The theme is already set; never write app/globals.css or app/layout.tsx.
14. Ensure all pages are valid Next.js App Router pages (default export as async/sync React component). A page.tsx exports nothing but its default component; any other component goes in components/app/
17. NEVER import page components (e.g. app/some-route/page.tsx) directly into other files. If you need a reusable component (like a list, form, card, or dashboard section), ALWAYS create it as a separate file inside components/app/ (e.g. components/app/JournalEntries.tsx) and import it from there. Files in app/ should only contain page layouts and route entry points.
18. Always use path alias imports starting with @/ to refer to project files (e.g. @/components/app/JournalEntries, @/lib/data, @/components/ui/button). Avoid using relative imports (like ./journal-entries or ../components/...) which easily break when paths change.
19. Never import useClient from 'react' or call useClient(). To make a component a client component, simply place the "use client"; directive at the very top of the file (on line 1) before any imports.

QUALITY BAR — the app must be the WORKING TOOL, not a marketing page:
- app/page.tsx (the home page "/") MUST BE the actual functional application, usable immediately. Do NOT build a marketing/landing splash with a "Get Started" hero. For an email-generating app, the home page itself shows the form (inputs + generate button) and the generated result — no extra click to "get started".
- EVERY button must DO something. A button must either (a) have an onClick wired to React state that visibly changes the UI, or (b) be a real navigation link using next/link, e.g. <Link href="/dashboard"><Button>Open</Button></Link> pointing at a route you actually generate. NEVER render a <Button> with no onClick and no surrounding <Link> — a dead button is a bug.
- Implement the primary action fully client-side: mark the file "use client", hold form state with useState, and on submit compute and render a plausible mock result immediately (no API calls). The user must see something happen on click.
- app/layout.tsx already puts every page inside the app shell with its navigation: never import or render AppShell. A page returns <Page title description actions={header buttons}>...</Page> built from the LAYOUT BLOCKS below, following its SCREEN PLAN. Never output a bare centered <h1> on an empty page.
- Run AI workflows only from a user action (a button, a form submit, sending a message). Never call runWorkflow in useEffect, on render, on every keystroke or on a timer.
- Populate the UI with plausible mock data from @/lib/data so screens look full and alive.` + designRules + blocksReference + shadcnReference("TSX", "@/")

// genChunkTokens caps each generation call's output.
func genChunkTokens() int {
	if v := strings.TrimSpace(os.Getenv("GROQ_GEN_MAX_TOKENS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 6000
}

// generateCode builds the app in several small Groq calls instead of one giant request.
func generateCode(prd *PRD, flows []BuiltWorkflow) ([]GeneratedFile, error) {
	prdJSON, err := codePRDJSON(prd)
	if err != nil {
		return nil, err
	}

	maxTok := genChunkTokens()
	var mu sync.Mutex
	byPath := map[string]GeneratedFile{}
	var order []string
	add := func(files []GeneratedFile) {
		mu.Lock()
		defer mu.Unlock()
		for _, f := range files {
			if strings.TrimSpace(f.Path) == "" {
				continue
			}
			if _, ok := byPath[f.Path]; !ok {
				order = append(order, f.Path)
			}
			byPath[f.Path] = f
		}
	}

	// Call 1: the data on its own, so the seed is rich and every later call can see its real shape.
	dataMsg := fmt.Sprintf(`PRD:
%s

Generate ONLY lib/data.ts now (return a JSON array with that one file):
- An exported TypeScript interface for every entity, with every field the features show or filter by (for a recipe: cook time, servings, difficulty, cuisine, tags, ingredients with amounts, numbered steps).
- Exported seed arrays with 6-8 rich, specific, realistic records each (real names, real amounts, varied values), plus exported defaults for settings or the current session if the features need them.
- Export every collection the pages will need; nothing else in the file.`, prdJSON)
	if raw, err := callGroq(groqCodeGenSystemPrompt, dataMsg, maxTok); err == nil {
		add(parseGeneratedFiles(cleanJSONArray(raw)))
	}
	dataNote := ""
	if f, ok := byPath["lib/data.ts"]; ok {
		dataNote = "\n\nlib/data.ts already exists; import from it and use these exact names and fields (add new data inside your own files, never import a name it does not export):\n" + dataShape(f.Content)
	}
	shellNote := "\n\nThe app shell and its navigation are already around every page (app/layout.tsx): never import or render AppShell. The navigation links to: " + routeList(prd) + "; link only to these routes."

	// Call 2: the home page and its components, which set the visual language the other pages follow.
	foundationMsg := fmt.Sprintf(`PRD:
%s

Generate ONLY these files now (return a JSON array):
- app/page.tsx: the home page ("/"). It IS the working app and the most useful screen. "use client" at line 1; export only the default component.
- any components/app/* it needs.
Every button must have a working onClick (state change) or be wrapped in a next/link <Link> to one of the routes above. Do NOT generate other route pages yet.%s%s%s%s%s`, prdJSON, screenPlan(prd, "/"), shellNote, dataNote, designBrief(prd.Design), workflowContract(flows))
	raw, err := callGroq(groqCodeGenSystemPrompt, foundationMsg, maxTok)
	if err != nil {
		return nil, err
	}
	add(parseGeneratedFiles(cleanJSONArray(raw)))
	mu.Lock()
	done := append([]string(nil), order...)
	mu.Unlock()

	// Then every other page in its own call, three at a time.
	var wg sync.WaitGroup
	sem := make(chan struct{}, 3)
	for _, rt := range parsePRDRoutes(prd) {
		if rt.file == "app/page.tsx" {
			continue
		}
		wg.Add(1)
		go func(rt prdRoute) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			name, desc, _ := strings.Cut(rt.name, ":")
			brief := viewBrief(prd, viewSpec{Route: rt.route, Name: strings.TrimSpace(name), Desc: strings.TrimSpace(desc)})
			pageMsg := fmt.Sprintf(`App brief:
%s

Already generated (import from these, never redefine them): %s

Generate ONLY %s (route %s: %s), plus any components/app/* it needs, named after this page (return a JSON array). "use client" at line 1 if it uses state; export only the default component. Match the home page's visual language.%s%s%s%s%s`,
				brief, strings.Join(done, ", "), rt.file, rt.route, rt.name, screenPlan(prd, rt.route), shellNote, dataNote, designBrief(prd.Design), workflowContract(flows))
			// One retry; a page that still fails gets a placeholder, so its navigation link never leads to a 404.
			files, err := generateFiles(groqCodeGenSystemPrompt, pageMsg, "page.tsx")
			if err != nil {
				files = []GeneratedFile{placeholderPage(rt, err)}
			}
			add(files)
		}(rt)
	}
	wg.Wait()

	if len(byPath) == 0 {
		return nil, fmt.Errorf("no valid files parsed from AI response")
	}
	files := make([]GeneratedFile, 0, len(order))
	for _, p := range order {
		files = append(files, byPath[p])
	}
	return files, nil
}

var exportLineRegex = regexp.MustCompile(`(?m)^export\s+(?:const|let|function|type|interface|enum)\s+[A-Za-z_$][\w$]*[^\n]*`)

// The data file's types in full and its other exports as one line each: enough to use it correctly at a fraction of its size.
func dataShape(src string) string {
	var out []string
	lines := strings.Split(src, "\n")
	for i := 0; i < len(lines); i++ {
		l := lines[i]
		if strings.HasPrefix(l, "export interface") || strings.HasPrefix(l, "export type") && strings.HasSuffix(strings.TrimSpace(l), "{") {
			block := []string{l}
			for i+1 < len(lines) && !strings.HasPrefix(lines[i], "}") {
				i++
				block = append(block, lines[i])
			}
			out = append(out, strings.Join(block, "\n"))
			continue
		}
		if exportLineRegex.MatchString(l) {
			if j := strings.Index(l, "="); j > 0 {
				l = strings.TrimSpace(l[:j]) + " = ..."
			}
			out = append(out, l)
		}
	}
	return strings.Join(out, "\n")
}

// A page that could not be generated: it says so in the app and points at the IDE instead of breaking the navigation.
func placeholderPage(rt prdRoute, cause error) GeneratedFile {
	name, _, _ := strings.Cut(rt.name, ":")
	why := "The AI could not write this page during the build."
	if strings.Contains(cause.Error(), "quota") || strings.Contains(cause.Error(), "rate") {
		why = "The AI ran out of tokens while writing this page."
	}
	return GeneratedFile{Path: rt.file, Content: fmt.Sprintf(`"use client";

import { Construction } from "lucide-react";
import { Page } from "@/components/blocks";
import { EmptyState } from "@/components/ui/empty-state";

export default function PlaceholderPage() {
  return (
    <Page title={%s}>
      <EmptyState icon={<Construction />} title="This page is not built yet" description={%s} />
    </Page>
  );
}
`, jsQuote(strings.TrimSpace(name)), jsQuote(why+" Open the IDE and ask the coding agent to build it."))}
}

// The PRD's routes as "/path (Name)" for the shell's navigation.
func routeList(prd *PRD) string {
	var out []string
	for _, rt := range parsePRDRoutes(prd) {
		name, _, _ := strings.Cut(rt.name, ":")
		out = append(out, fmt.Sprintf("%s (%s)", rt.route, strings.TrimSpace(name)))
	}
	if len(out) == 0 {
		return "/ (Home)"
	}
	return strings.Join(out, ", ")
}

// prdRoute is a route parsed from a PRD "pages" entry like "/dashboard - Dashboard".
type prdRoute struct {
	route string // e.g. "/dashboard"
	name  string // e.g. "Dashboard"
	file  string // e.g. "app/dashboard/page.tsx"
}

func parsePRDRoutes(prd *PRD) []prdRoute {
	var routes []prdRoute
	seen := map[string]bool{}
	for _, p := range prd.Pages {
		p = strings.TrimSpace(p)
		route, name := p, ""
		if idx := strings.Index(p, " - "); idx >= 0 {
			route = strings.TrimSpace(p[:idx])
			name = strings.TrimSpace(p[idx+3:])
		}
		if !strings.HasPrefix(route, "/") {
			continue // not a route spec — the home page covers it
		}
		route = staticRoute(route)
		if seen[route] {
			continue
		}
		seen[route] = true
		routes = append(routes, prdRoute{route: route, name: name, file: routeToFile(route)})
	}
	return routes
}

// Generated pages are static files, so parameter segments like :id, [id] or {id} are dropped.
func staticRoute(route string) string {
	var parts []string
	for _, seg := range strings.Split(route, "/") {
		if seg != "" && !strings.ContainsAny(seg[:1], ":[{*") {
			parts = append(parts, seg)
		}
	}
	return "/" + strings.Join(parts, "/")
}

func routeToFile(route string) string {
	clean := strings.Trim(route, "/")
	if clean == "" {
		return "app/page.tsx"
	}
	return "app/" + clean + "/page.tsx"
}

// cleanJSONArray strips markdown fences and any leading prose before the array.
func cleanJSONArray(raw string) string {
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	raw = strings.TrimSpace(raw)
	if idx := strings.Index(raw, "["); idx > 0 {
		raw = raw[idx:]
	}
	return raw
}

// parseGeneratedFiles decodes the JSON array of files.
func parseGeneratedFiles(raw string) []GeneratedFile {
	// Fast path: a well-formed array.
	var files []GeneratedFile
	if err := json.Unmarshal([]byte(raw), &files); err == nil {
		return files
	}

	// Tolerant path: stream objects, stopping at the first incomplete one.
	dec := json.NewDecoder(strings.NewReader(raw))
	if _, err := dec.Token(); err != nil { // consume opening '['
		return nil
	}
	var salvaged []GeneratedFile
	for dec.More() {
		var f GeneratedFile
		if err := dec.Decode(&f); err != nil {
			break // truncated or malformed from here on — keep what we have
		}
		salvaged = append(salvaged, f)
	}
	return salvaged
}

// Template copy from embedded FS

// Set by main, which owns the //go:embed of builder-template/.
var templateFS fs.FS

func SetTemplates(fsys fs.FS) { templateFS = fsys }

// Templates are namespaced by stack, so one never leaks into another's scaffold.
func Materialise(destDir, template string) error {
	root := "builder-template/" + template
	if _, err := fs.Stat(templateFS, root); err != nil {
		return fmt.Errorf("no golden template named %q", template)
	}
	return fs.WalkDir(templateFS, root, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		rel := strings.TrimPrefix(path, root)
		rel = strings.TrimPrefix(rel, "/")
		// Go sources and go.mod would join this module (or split it) if stored under their real names.
		rel = strings.TrimSuffix(rel, ".jrtmpl")
		if rel == "" {
			return nil // skip root dir itself
		}
		dest := filepath.Join(destDir, filepath.FromSlash(rel))

		if d.IsDir() {
			return os.MkdirAll(dest, fs.ModePerm)
		}

		data, err := fs.ReadFile(templateFS, path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), fs.ModePerm); err != nil {
			return err
		}
		return os.WriteFile(dest, data, 0644)
	})
}

// Helpers

// allowedImportModules are the ONLY external packages installed in the builder template (see builder-template/nextjs/package.json).
var allowedImportModules = map[string]bool{
	"react": true, "react-dom": true, "next": true,
	"lucide-react": true, "clsx": true,
	"class-variance-authority": true, "tailwind-merge": true,
}

// moduleRoot reduces an import specifier to its package root so that "next/link" -> "next" and "@scope/pkg/sub" -> "@scope/pkg".
func moduleRoot(spec string) string {
	if strings.HasPrefix(spec, "@") {
		if parts := strings.SplitN(spec, "/", 3); len(parts) >= 2 {
			return parts[0] + "/" + parts[1]
		}
		return spec
	}
	if i := strings.Index(spec, "/"); i >= 0 {
		return spec[:i]
	}
	return spec
}

func isAllowedPath(p string, allowedDirs []string) bool {
	// Prevent path traversal
	if strings.Contains(p, "..") {
		return false
	}
	for _, dir := range allowedDirs {
		if strings.HasPrefix(p, dir) {
			return true
		}
	}
	// Allow exact replacements of root-level template files
	allowed := map[string]bool{
		"app/page.tsx":    true,
		"app/globals.css": true,
		"app/layout.tsx":  true,
		"lib/data.ts":     true,
		"lib/utils.ts":    true,
	}
	return allowed[p]
}

func updateAppMetadata(workdir string, prd *PRD) {
	layoutPath := filepath.Join(workdir, "app", "layout.tsx")
	data, err := os.ReadFile(layoutPath)
	if err != nil {
		return
	}
	updated := strings.ReplaceAll(string(data), `title: "App"`, fmt.Sprintf(`title: "%s"`, prd.Name))
	updated = strings.ReplaceAll(updated, `description: "Built with Jr Architect"`,
		fmt.Sprintf(`description: "%s"`, prd.Tagline))
	os.WriteFile(layoutPath, []byte(updated), 0644)
}

// normalizeUIImports rewrites @/components/ui/* imports to the exact form the template exposes: lowercase (case-sensitive) file paths and named imports.
func normalizeUIImports(content string) string {
	content = uiImportPathRegex.ReplaceAllStringFunc(content, func(m string) string {
		sub := uiImportPathRegex.FindStringSubmatch(m)
		return sub[1] + strings.ToLower(sub[2])
	})
	content = uiDefaultImportRegex.ReplaceAllString(content, "import { $1 } from $2")
	return content
}

var (
	linkRegex           = regexp.MustCompile(`(?i)import\s*\{\s*Link\s*\}\s*from\s*(['"]next/link['"])`)
	imageRegex          = regexp.MustCompile(`(?i)import\s*\{\s*Image\s*\}\s*from\s*(['"]next/image['"])`)
	defaultExportRegex  = regexp.MustCompile(`export\s+default\s+(function|class)\s+([A-Za-z0-9_]+)`)
	useClientCheckRegex = regexp.MustCompile(`(?i)"use client"|'use client'`)
	hooksRegex          = regexp.MustCompile(`\buse(State|Effect|Ref|Context|Memo|Callback|Reducer|Transition|DeferredValue)\b`)

	// useClient hallucination cleaners
	useClientImportRegex = regexp.MustCompile(`(?i)import\s*\{\s*useClient\s*\}\s*from\s*['"]react['"];?`)
	useClientCallRegex   = regexp.MustCompile(`\buseClient\(\);?`)

	// UI import normalizers.
	uiImportPathRegex    = regexp.MustCompile(`(@/components/ui/)([A-Za-z][A-Za-z0-9_-]*)`)
	uiDefaultImportRegex = regexp.MustCompile(`import\s+([A-Za-z][A-Za-z0-9_]*)\s+from\s+(['"]@/components/ui/[a-z][a-z0-9_-]*['"])`)
	// bareUseClientRegex matches an UNQUOTED `use client;` directive on its own line (invalid — must be the string literal "use client").
	bareUseClientRegex = regexp.MustCompile(`(?mi)^[ \t]*use[ \t]+client[ \t]*;?[ \t]*\r?$`)
)

var (
	pageNamedExport    = regexp.MustCompile(`(?m)^export\s+((?:async\s+)?function|const|let|class)\s+([A-Za-z_$][\w$]*)`)
	pageExportsAllowed = map[string]bool{"metadata": true, "generateMetadata": true, "viewport": true, "dynamic": true, "revalidate": true, "generateStaticParams": true, "runtime": true}
)

func postProcessCode(content string, filename string) string {
	// A. Clean up hallucinated useClient calls & imports, and the bare `use client;` directive (unquoted, often placed after imports).
	hasUseClientHallucination := false
	if useClientImportRegex.MatchString(content) || useClientCallRegex.MatchString(content) {
		hasUseClientHallucination = true
		content = useClientImportRegex.ReplaceAllString(content, "")
		content = useClientCallRegex.ReplaceAllString(content, "")
	}
	if bareUseClientRegex.MatchString(content) {
		hasUseClientHallucination = true
		content = bareUseClientRegex.ReplaceAllString(content, "")
	}

	// 1. Fix next/link and next/image imports to be default imports
	content = linkRegex.ReplaceAllString(content, "import Link from $1")
	content = imageRegex.ReplaceAllString(content, "import Image from $1")

	// 1b. Normalize @/components/ui/* imports.
	content = normalizeUIImports(content)

	// 2. Convert export default function/class to named + default, so components import either way; a Next.js page may export only its default.
	isPage := strings.HasPrefix(filename, "app/") && (path.Base(filename) == "page.tsx" || path.Base(filename) == "page.jsx")
	if isPage {
		content = pageNamedExport.ReplaceAllStringFunc(content, func(m string) string {
			name := pageNamedExport.FindStringSubmatch(m)[2]
			if pageExportsAllowed[name] {
				return m
			}
			return strings.TrimPrefix(m, "export ")
		})
	}
	if !isPage && defaultExportRegex.MatchString(content) {
		matches := defaultExportRegex.FindStringSubmatch(content)
		if len(matches) >= 3 {
			kind := matches[1]
			name := matches[2]
			// Replace "export default function Name" with "export function Name"
			oldStr := fmt.Sprintf("export default %s %s", kind, name)
			newStr := fmt.Sprintf("export %s %s", kind, name)
			content = strings.Replace(content, oldStr, newStr, 1)

			// Append export default at the end
			content += fmt.Sprintf("\nexport default %s;\n", name)
		}
	}

	// 3. Add "use client" when React hooks are used, unless the file defines an async component.
	ext := filepath.Ext(filename)
	if ext == ".tsx" || ext == ".ts" || ext == ".jsx" || ext == ".js" {
		isAsyncPage := regexp.MustCompile(`async\s+function`).MatchString(content)
		needsClient := (hooksRegex.MatchString(content) || hasUseClientHallucination) && !isAsyncPage
		if needsClient && !useClientCheckRegex.MatchString(content) {
			content = "\"use client\";\n" + content
		}
	}

	return content
}

// /build/history

func HistoryHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	buildHistMu.Lock()
	defer buildHistMu.Unlock()
	user := core.UserOf(r)
	mine := []BuildRecord{}
	for _, rec := range buildHistory {
		if core.CanUse(user, rec.Owner) {
			mine = append(mine, rec)
		}
	}
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(mine)
}
