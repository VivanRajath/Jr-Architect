package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
)

// ─────────────────────────────────────────────
//  Build history (in-memory)
// ─────────────────────────────────────────────

type BuildRecord struct {
	ID        string    `json:"id"`
	AppName   string    `json:"appName"`
	Prompt    string    `json:"prompt"`
	PRD       *PRD      `json:"prd"`
	Container string    `json:"container,omitempty"`
	URL       string    `json:"url,omitempty"`
	Status    string    `json:"status"` // "building" | "ready" | "error"
	CreatedAt time.Time `json:"createdAt"`
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

// ─────────────────────────────────────────────
//  Groq API client — multi-key pool with TPM headroom throttling
// ─────────────────────────────────────────────
//
// Groq's free tier enforces a per-organization tokens-per-minute (TPM) limit and
// counts input + output tokens toward the same budget. A single whole-app code
// generation can need ~18k tokens, which exceeds a 12k TPM org cap — so a lone
// request 429s no matter how many keys you have (one request uses one key).
//
// Two mechanisms make it work:
//   1. Code generation is chunked (see generateCode) so each call fits under one
//      org's per-minute budget.
//   2. This pool round-robins across every configured key, tracks each key's
//      rolling-window usage against tpm*headroom, and cools a key down on 429 —
//      spreading load across orgs and self-throttling instead of failing.

const groqEndpoint = "https://api.groq.com/openai/v1/chat/completions"
const groqModel = "llama-3.3-70b-versatile"

type groqMessage struct {
	Role    string `json:"role"`
	Content string `json:"content"`
}

type groqRequest struct {
	Model       string        `json:"model"`
	Messages    []groqMessage `json:"messages"`
	Temperature float64       `json:"temperature"`
	MaxTokens   int           `json:"max_tokens"`
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
}

type groqPool struct {
	keys     []*groqKey
	tpm      int     // per-key tokens-per-minute limit
	headroom float64 // fraction of tpm we actually allow (e.g. 0.85)
	rr       uint64  // round-robin cursor
}

var (
	groqPoolOnce sync.Once
	groqPoolInst *groqPool
)

func getGroqPool() *groqPool {
	groqPoolOnce.Do(func() { groqPoolInst = buildGroqPool() })
	return groqPoolInst
}

func buildGroqPool() *groqPool {
	var raw []string
	// GROQ_API_KEYS (comma-separated) plus GROQ_API_KEY and GROQ_API_KEY_2..10.
	if v := strings.TrimSpace(os.Getenv("GROQ_API_KEYS")); v != "" {
		for _, k := range strings.Split(v, ",") {
			if k = strings.TrimSpace(k); k != "" {
				raw = append(raw, k)
			}
		}
	}
	if v := strings.TrimSpace(os.Getenv("GROQ_API_KEY")); v != "" {
		raw = append(raw, v)
	}
	for i := 2; i <= 10; i++ {
		if v := strings.TrimSpace(os.Getenv(fmt.Sprintf("GROQ_API_KEY_%d", i))); v != "" {
			raw = append(raw, v)
		}
	}

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

// reserve picks a key with room in its current window for estTokens and charges
// it. If no key has room, it waits until the earliest key frees up, then retries.
func (p *groqPool) reserve(estTokens int) (*groqKey, error) {
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
			return nil, fmt.Errorf("groq rate-limit: no key with %d-token headroom available within timeout", estTokens)
		}
		time.Sleep(wait)
	}
}

// reconcile adjusts a key's window usage once actual token counts are known
// (the reservation used an estimate). Pass actual=0 to refund a failed request.
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
	pool := getGroqPool()
	if len(pool.keys) == 0 {
		return "", fmt.Errorf("GROQ_API_KEY not set in environment")
	}
	estTotal := estimateTokens(systemPrompt) + estimateTokens(userPrompt) + maxTokens

	body, err := json.Marshal(groqRequest{
		Model: groqModel,
		Messages: []groqMessage{
			{Role: "system", Content: systemPrompt},
			{Role: "user", Content: userPrompt},
		},
		Temperature: 0.7,
		MaxTokens:   maxTokens,
	})
	if err != nil {
		return "", err
	}

	const maxAttempts = 5
	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		key, err := pool.reserve(estTotal)
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
			key.penalize(parseRetryAfter(resp.Header.Get("Retry-After")))
			lastErr = fmt.Errorf("groq rate limited (429) on %s", key.label)
			continue // reserve() picks another key or waits for a reset
		}

		var gr groqResponse
		if err := json.Unmarshal(respBody, &gr); err != nil {
			key.reconcile(estTotal, 0)
			return "", fmt.Errorf("failed to parse groq response: %w", err)
		}
		if gr.Error != nil {
			key.reconcile(estTotal, 0)
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

// ─────────────────────────────────────────────
//  Data structures
// ─────────────────────────────────────────────

type Question struct {
	ID      string   `json:"id"`
	Text    string   `json:"text"`
	Options []string `json:"options,omitempty"` // curated choices shown as chips
	Multi   bool     `json:"multi,omitempty"`   // allow multiple chip selections
}

type PRD struct {
	Name        string              `json:"name"`
	Tagline     string              `json:"tagline"`
	TargetUsers string              `json:"target_users"`
	Features    []string            `json:"features"`
	Pages       []string            `json:"pages"`
	UINote      string              `json:"ui_note"`
	DataModel   map[string][]string `json:"data_model"`
	OutOfScope  []string            `json:"out_of_scope"`
}

type GeneratedFile struct {
	Path    string `json:"path"`
	Content string `json:"content"`
}

// ─────────────────────────────────────────────
//  /build/questions
// ─────────────────────────────────────────────

func buildQuestionsHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}

	var req struct {
		Prompt string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Prompt) == "" {
		jsonError(w, "prompt is required", 400)
		return
	}

	system := `You are a product discovery assistant for a no-code app builder called Jr Architect.
The user is always building a FUNCTIONAL, INTERACTIVE WEB APPLICATION (a tool they actively use), never a marketing site or landing page. Your questions must clarify how the TOOL works — its inputs, actions, data, and screens — not marketing concerns like branding funnels, pricing, or "getting started" flows.
The app is 100% LOCAL and self-contained: it runs entirely in the browser, saves data in the browser (localStorage), and connects to NO third-party services — no Gmail, Google, sign-in/OAuth providers, Stripe/payments, email/SMS, cloud storage, or external APIs. Do NOT ask about integrations, authentication, payments, sending email, or connecting external accounts. Focus every question on the tool's own inputs, actions, screens, and the data the user enters and saves locally.
Given a user's app idea, generate exactly 7 short, friendly clarifying questions to understand their needs better.
Return ONLY a valid JSON array of objects with these fields:
  - "id": snake_case identifier
  - "text": the question string (concise, friendly)
  - "options": an array of 3-5 curated, specific answer choices tailored to the question (NOT generic options like Yes/No unless truly binary)
  - "multi": true if the user might reasonably select multiple options, false for single-select
No preamble, no explanation, no markdown fences — raw JSON array only.
Example:
[{
  "id": "users",
  "text": "Who are the primary users of this app?",
  "options": ["Developers & teams", "Small business owners", "Students", "General consumers"],
  "multi": false
}]`

	userMsg := fmt.Sprintf("App idea: %s\n\nGenerate 7 clarifying questions.", req.Prompt)

	raw, err := callGroq(system, userMsg, 800)
	if err != nil {
		jsonError(w, "AI call failed: "+err.Error(), 502)
		return
	}

	// Strip potential markdown fences
	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	raw = strings.TrimSpace(raw)

	var questions []Question
	if err := json.Unmarshal([]byte(raw), &questions); err != nil {
		// Fallback: return default questions
		questions = defaultQuestions()
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"questions": questions})
}

func defaultQuestions() []Question {
	return []Question{
		{ID: "users", Text: "Who are the primary users of this app?"},
		{ID: "auth", Text: "Should users need to sign in?"},
		{ID: "name", Text: "What should the app be called?"},
		{ID: "pages", Text: "What are the main pages or views you need?"},
		{ID: "brand", Text: "Any color scheme or visual style preferences?"},
		{ID: "mobile", Text: "Does it need to be mobile-friendly?"},
		{ID: "data", Text: "Real database, or mock data to start with?"},
	}
}

// ─────────────────────────────────────────────
//  /build/prd
// ─────────────────────────────────────────────

func buildPRDHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}

	var req struct {
		Prompt  string            `json:"prompt"`
		Answers map[string]string `json:"answers"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		jsonError(w, "invalid request", 400)
		return
	}

	answersText := ""
	for k, v := range req.Answers {
		if strings.TrimSpace(v) != "" {
			answersText += fmt.Sprintf("- %s: %s\n", k, v)
		}
	}

	system := `You are a senior product manager at a top-tier tech company.
You are always specifying a FUNCTIONAL, INTERACTIVE WEB APPLICATION — a tool the user actively operates — NOT a marketing site, landing page, or brochure.
Generate a concise, structured Product Requirements Document (PRD) as a JSON object.
Return ONLY valid JSON — no markdown fences, no preamble, no explanation.
The JSON must exactly match this schema:
{
  "name": "App name",
  "tagline": "One-sentence value proposition",
  "target_users": "Who uses this app",
  "features": ["Feature 1 as a user story", "Feature 2..."],
  "pages": ["/route - Page Name", "/other - Other Page"],
  "ui_note": "Color palette, visual style, tone notes",
  "data_model": {
    "EntityName": ["field1", "field2", "field3"]
  },
  "out_of_scope": ["Thing not in v1", "Another excluded thing"]
}
FRAMING RULES (critical):
- The FIRST page MUST be the core working tool at route "/", e.g. "/ - Email Generator" — never "/ - Landing" or "/ - Home splash". The user lands directly in the usable app.
- Features must be functional user stories about USING the tool ("User types a topic and generates a draft email"), NOT marketing actions ("User clicks Get Started" or "User views pricing").
- Do NOT include marketing pages: no landing/hero, pricing, about, testimonials, sign-up funnels, or "Get Started" flows.
- The data_model describes the real entities the tool creates or manipulates.
LOCAL-ONLY RULES (critical — this app never talks to a server):
- The app is FULLY LOCAL and self-contained: it runs entirely in the browser, saves the user's data in the browser (localStorage), and connects to NO third-party services. Never specify a feature that needs Gmail, Google, OAuth/sign-in providers, Stripe/payments, email/SMS sending, cloud storage, analytics, or any external API.
- If the idea implies such an integration, reinterpret it as a LOCAL action instead. Examples: "email my resume" -> "download/export the resume as a PDF/file"; "sign in" -> "a local profile saved in the browser"; "sync to the cloud" -> "save locally and export/import a JSON file".
- ALWAYS include these exact entries in out_of_scope (in addition to any others): "User accounts & third-party sign-in", "Sending email or SMS", "Payment processing", "Any external API, cloud sync, or server backend".
Keep features as user stories (max 8). Keep data_model to 2-4 entities. Keep it concise but complete.`

	userMsg := fmt.Sprintf("App idea: %s\n\nUser's answers:\n%s\n\nGenerate the PRD for a functional web app (the user lands directly in the working tool, not a landing page).", req.Prompt, answersText)

	raw, err := callGroq(system, userMsg, 2000)
	if err != nil {
		jsonError(w, "AI call failed: "+err.Error(), 502)
		return
	}

	raw = strings.TrimSpace(raw)
	raw = strings.TrimPrefix(raw, "```json")
	raw = strings.TrimPrefix(raw, "```")
	raw = strings.TrimSuffix(raw, "```")
	raw = strings.TrimSpace(raw)

	var prd PRD
	if err := json.Unmarshal([]byte(raw), &prd); err != nil {
		jsonError(w, "Failed to parse PRD from AI response: "+err.Error(), 500)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{"prd": prd})
}

// ─────────────────────────────────────────────
//  /build/scaffold
// ─────────────────────────────────────────────

func buildScaffoldHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	if r.Method == http.MethodOptions {
		return
	}

	var req struct {
		PRD *PRD `json:"prd"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || req.PRD == nil {
		jsonError(w, "prd is required", 400)
		return
	}

	prd := req.PRD

	// Create temp workdir
	workdir, err := os.MkdirTemp("", "builder-*")
	if err != nil {
		jsonError(w, "failed to create workdir: "+err.Error(), 500)
		return
	}
	workdir, _ = filepath.Abs(workdir)

	buildID := fmt.Sprintf("build-%d", time.Now().UnixMilli())
	rec := BuildRecord{
		ID:        buildID,
		AppName:   prd.Name,
		PRD:       prd,
		Status:    "building",
		CreatedAt: time.Now(),
	}
	addBuildRecord(rec)

	// Immediately return the build ID so the frontend can start polling
	port, err := getFreePort()
	if err != nil {
		jsonError(w, "failed to get port: "+err.Error(), 500)
		return
	}

	container := "builder-" + buildID
	sb := Sandbox{
		Container: container,
		Port:      port,
		Repo:      "generated:" + prd.Name,
		Workdir:   workdir,
	}
	mutex.Lock()
	sandboxes[container] = sb
	mutex.Unlock()

	// Return immediately — scaffold happens async
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":    "scaffolding",
		"container": container,
		"build_id":  buildID,
		"url":       fmt.Sprintf("http://127.0.0.1:%d", port),
	})

	// Async: copy template, generate code, start container
	go func() {
		if err := scaffoldAndRun(workdir, container, port, prd, buildID); err != nil {
			fmt.Printf("Scaffold error for %s: %v\n", buildID, err)
			updateBuildRecord(buildID, func(r *BuildRecord) {
				r.Status = "error"
			})
			addLog(container, "Scaffold failed: "+err.Error())
			mutex.Lock()
			delete(sandboxes, container)
			mutex.Unlock()
			os.RemoveAll(workdir)
		}
	}()
}

func scaffoldAndRun(workdir, container string, port int, prd *PRD, buildID string) error {
	addLog(container, "Copying Next.js template...")

	// Copy embedded builder-template to workdir
	if err := copyBuilderTemplate(workdir); err != nil {
		return fmt.Errorf("template copy failed: %w", err)
	}
	addLog(container, "Template copied.")

	// Generate code from PRD via Groq
	addLog(container, "Generating app code with Groq AI...")
	files, err := generateCode(prd)
	if err != nil {
		return fmt.Errorf("code generation failed: %w", err)
	}
	addLog(container, fmt.Sprintf("Generated %d files.", len(files)))

	// Write generated files (only allowed paths)
	allowedDirs := []string{"app/", "components/app/", "lib/", "public/"}
	for _, f := range files {
		if !isAllowedPath(f.Path, allowedDirs) {
			addLog(container, fmt.Sprintf("Skipping disallowed path: %s", f.Path))
			continue
		}
		absPath := filepath.Join(workdir, filepath.FromSlash(f.Path))
		if err := os.MkdirAll(filepath.Dir(absPath), fs.ModePerm); err != nil {
			addLog(container, "mkdir error: "+err.Error())
			continue
		}
		processedContent := postProcessCode(f.Content, f.Path)
		if refs := thirdPartyRefs(processedContent); len(refs) > 0 {
			addLog(container, fmt.Sprintf("WARNING: %s references non-local dependencies (%s) — the app is meant to be fully local; this may break the build.", f.Path, strings.Join(refs, ", ")))
		}
		if err := os.WriteFile(absPath, []byte(processedContent), 0644); err != nil {
			addLog(container, "write error for "+f.Path+": "+err.Error())
		} else {
			addLog(container, "Wrote: "+f.Path)
		}
	}

	// Fix 3: Ensure @tailwind directives are present in globals.css
	ensureTailwindDirectives(workdir)
	// Guarantee the :root design tokens exist so styled components keep their
	// colors even if the model dropped them when regenerating globals.css.
	ensureDesignTokens(workdir)
	addLog(container, "Tailwind directives and design tokens verified in globals.css.")

	// Update app name in layout.tsx metadata
	updateAppMetadata(workdir, prd)

	// Fix 1: Use the preheated sandbox-builder image instead of sandbox-react.
	// /opt/builder-deps has node_modules pre-installed — copy them in for instant startup.
	addLog(container, "Starting Docker sandbox (preheated builder image)...")
	const builderImage = "sandbox-builder"
	const builderPort = 3000
	// The startup command copies pre-installed node_modules then launches Next.js dev server.
	// Parentheses ensure npm run dev always runs regardless of which install path was taken.
	// Note the trailing "/." on the source: ./node_modules already exists (it's the
	// anonymous-volume mount point), so we copy the *contents* into it. Copying the
	// directory itself would nest it as ./node_modules/node_modules and `next` would
	// not be found on PATH.
	const builderStartCmd = "(cp -r /opt/builder-deps/node_modules/. ./node_modules/ 2>/dev/null || npm install --no-audit --no-fund) && npm run dev -- -H 0.0.0.0"

	stack := imageToStack(builderImage)
	if specErr := GenerateAgentSpec(workdir, stack); specErr != nil {
		addLog(container, "Warning: agent spec generation failed: "+specErr.Error())
	} else {
		go RegisterWithAgentService(container, workdir, stack)
	}

	env := []string{
		fmt.Sprintf("PORT=%d", builderPort),
		"NEXT_TELEMETRY_DISABLED=1",
		"CI=1",
		// Poll the filesystem so Next.js fast-refresh sees edits made through the
		// IDE — inotify events don't cross a Docker bind mount on Windows/macOS, so
		// without polling a saved file never reaches the in-container watcher and
		// the live preview won't update.
		"CHOKIDAR_USEPOLLING=true",
		"CHOKIDAR_INTERVAL=300",
		"WATCHPACK_POLLING=true",
	}
	// The anonymous volume at /workspace/node_modules keeps node_modules on a
	// fast native Docker volume instead of the bind-mounted /workspace. On
	// Windows/macOS, copying the ~hundreds of preheated packages into the bind
	// mount takes minutes (and blocks `npm run dev` behind the `&&`); on a native
	// volume it takes seconds. The volume is removed with `docker rm -v`.
	mounts := []string{
		"-v", "sandbox-npm-cache:/root/.npm",
		"-v", "/workspace/node_modules",
	}
	args := dockerRunArgs(container, "1536m", "1.5", 200, port, builderPort, workdir, env, mounts, builderImage, builderStartCmd)

	if err := run(container, "docker", args...); err != nil {
		return fmt.Errorf("docker run failed: %w", err)
	}

	if !waitForServer(port) {
		addLog(container, "Warning: server not ready yet — check logs")
	} else {
		addLog(container, fmt.Sprintf("App is ready at http://127.0.0.1:%d", port))
	}

	updateBuildRecord(buildID, func(r *BuildRecord) {
		r.Status = "ready"
		r.Container = container
		r.URL = fmt.Sprintf("http://127.0.0.1:%d", port)
	})

	// Auto-cleanup after 30 minutes (longer for generated apps)
	go func() {
		time.Sleep(30 * time.Minute)
		run("", "docker", "stop", container)
		run("", "docker", "rm", "-v", container)
		os.RemoveAll(workdir)
		mutex.Lock()
		delete(sandboxes, container)
		mutex.Unlock()
	}()

	return nil
}

// ─────────────────────────────────────────────
//  Code generation via Groq
// ─────────────────────────────────────────────

const groqCodeGenSystemPrompt = `You are an expert Next.js 14 developer using the App Router, TypeScript, and Tailwind CSS.
Given a PRD, generate production-quality Next.js application files.

RULES:
1. Return ONLY a valid JSON array of file objects: [{"path": "...", "content": "..."}]
2. No markdown fences, no preamble, no explanation — raw JSON array only
3. Only generate files in these directories: app/, components/app/, lib/
4. Use Tailwind CSS classes only — no inline styles (except for CSS variables)
5. Base UI components are pre-built and MUST be imported EXACTLY as shown (named imports, lowercase paths):
     import { Button } from "@/components/ui/button"
     import { Input } from "@/components/ui/input"
     import { Textarea } from "@/components/ui/textarea"
     import { Badge } from "@/components/ui/badge"
     import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from "@/components/ui/card"
   NEVER use default imports for these (no "import Button from ..."). NEVER capitalize the file path (it is "button", not "Button"). These are the ONLY files in @/components/ui/* — do not import any other ui component.
6. Import shared data/types from @/lib/data
7. Keep each file under 250 lines
8. Use "use client" directive only for components with interactivity
9. Make the UI beautiful, modern, and responsive
10. The app is 100% CLIENT-SIDE and LOCAL. Make ZERO network calls of any kind — no fetch, axios, or XMLHttpRequest; no external APIs; no third-party services (Gmail, Google, Stripe/payments, sign-in/OAuth providers, email/SMS, analytics, remote fonts or CDNs). The ONLY packages you may import are: react, react-dom, next (including next/link, next/image, next/navigation), lucide-react, clsx, class-variance-authority, tailwind-merge, and local "@/..." imports. Importing ANY other package breaks the build — never do it.
10b. PERSIST the user's data LOCALLY with window.localStorage so their work survives a page reload (this is what makes the tool genuinely useful, e.g. a resume builder that keeps the resume). Seed initial state from @/lib/data on first load, then read/write localStorage. Guard every localStorage access for SSR safety: read inside a useEffect (or check typeof window !== "undefined"), and write in an effect that depends on the state. Any component using localStorage/hooks must be a client component ("use client" at line 1).
11. Always replace app/page.tsx and lib/data.ts
12. Generate components/app/ files for complex UI pieces
13. Apply brand colors via Tailwind classes: bg-[var(--brand-600)], text-[var(--brand-500)], etc.
14. Ensure all pages are valid Next.js App Router pages (default export as async/sync React component)
15. CRITICAL: app/globals.css MUST start with exactly these three lines before any other content:
    @tailwind base;
    @tailwind components;
    @tailwind utilities;
    Without these lines, NO Tailwind classes will work. Always include them.
16. Update app/globals.css :root section after the @tailwind directives to set brand color palette CSS variables
17. NEVER import page components (e.g. app/some-route/page.tsx) directly into other files. If you need a reusable component (like a list, form, card, or dashboard section), ALWAYS create it as a separate file inside components/app/ (e.g. components/app/JournalEntries.tsx) and import it from there. Files in app/ should only contain page layouts and route entry points.
18. Always use path alias imports starting with @/ to refer to project files (e.g. @/components/app/JournalEntries, @/lib/data, @/components/ui/button). Avoid using relative imports (like ./journal-entries or ../components/...) which easily break when paths change.
19. Never import useClient from 'react' or call useClient(). To make a component a client component, simply place the "use client"; directive at the very top of the file (on line 1) before any imports.
20. app/globals.css MUST KEEP the full :root design-token block. Never remove these variables (only add or recolor them): --brand-50 through --brand-900, --bg, --surface, --surface2, --border, --text, --text2, --text3, --radius. Every component depends on them; removing them makes the whole app render uncolored.

QUALITY BAR — the app must be the WORKING TOOL, not a marketing page:
- app/page.tsx (the home page "/") MUST BE the actual functional application, usable immediately. Do NOT build a marketing/landing splash with a "Get Started" hero. For an email-generating app, the home page itself shows the form (inputs + generate button) and the generated result — no extra click to "get started".
- EVERY button must DO something. A button must either (a) have an onClick wired to React state that visibly changes the UI, or (b) be a real navigation link using next/link, e.g. <Link href="/dashboard"><Button>Open</Button></Link> pointing at a route you actually generate. NEVER render a <Button> with no onClick and no surrounding <Link> — a dead button is a bug.
- Implement the primary action fully client-side: mark the file "use client", hold form state with useState, and on submit compute and render a plausible mock result immediately (no API calls). The user must see something happen on click.
- Give every page real structure: a header/nav bar, a page title, and content in Tailwind grid/flex with generous spacing (p-6/gap-6), rounded cards, and shadows. Never output a bare centered <h1> on an empty page.
- Use the brand palette richly: bg-[var(--brand-600)] buttons, colored badges, var(--surface) cards on a var(--bg) page, var(--text)/var(--text2) for hierarchy.
- Populate the UI with plausible mock data from @/lib/data so screens look full and alive.`

// genChunkTokens caps each generation call's output. Input (~system+PRD) runs
// ~3k tokens, so 6k output keeps a call near ~9k total — comfortably under a 12k
// TPM org cap with headroom. Override with GROQ_GEN_MAX_TOKENS if your keys allow.
func genChunkTokens() int {
	if v := strings.TrimSpace(os.Getenv("GROQ_GEN_MAX_TOKENS")); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			return n
		}
	}
	return 6000
}

// generateCode builds the app in several small Groq calls instead of one giant
// request. A whole-app generation needs ~18k tokens (input+output), which busts
// a 12k TPM org limit; splitting into a foundation call plus small page batches
// keeps every call under the cap and lets the key pool spread them across orgs.
func generateCode(prd *PRD) ([]GeneratedFile, error) {
	prdJSON, err := json.MarshalIndent(prd, "", "  ")
	if err != nil {
		return nil, err
	}

	maxTok := genChunkTokens()
	byPath := map[string]GeneratedFile{}
	var order []string
	add := func(files []GeneratedFile) {
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

	// Call 1 — foundation: shared data, global styles, home page (+ its components).
	foundationMsg := fmt.Sprintf(`PRD:
%s

Generate ONLY these foundation files now (return a JSON array):
- lib/data.ts — all mock data and TypeScript types matching the data_model, exported for reuse
- app/globals.css — the three @tailwind directives first, then :root brand colors from ui_note
- app/page.tsx — the home page ("/"). This IS the working app: it must contain the primary tool (inputs + a wired primary button + client-side useState that shows a mock result on click). Do NOT make it a "Get Started" landing splash. Add "use client" at line 1.
- any components/app/* used by the home page

Every button must have a working onClick (state change) or be wrapped in a next/link <Link> to a real route — no dead buttons. Do NOT generate other route pages yet. Make it visually stunning with mock data.`, string(prdJSON))

	raw, err := callGroq(groqCodeGenSystemPrompt, foundationMsg, maxTok)
	if err != nil {
		return nil, err
	}
	add(parseGeneratedFiles(cleanJSONArray(raw)))

	// Subsequent calls — remaining route pages in small batches so each call stays
	// under one org's per-minute budget.
	var otherRoutes []prdRoute
	for _, rt := range parsePRDRoutes(prd) {
		if rt.file == "app/page.tsx" {
			continue // home page already generated in the foundation call
		}
		otherRoutes = append(otherRoutes, rt)
	}

	const batchSize = 2
	for i := 0; i < len(otherRoutes); i += batchSize {
		end := i + batchSize
		if end > len(otherRoutes) {
			end = len(otherRoutes)
		}
		var lines []string
		for _, rt := range otherRoutes[i:end] {
			lines = append(lines, fmt.Sprintf("- %s (route %s — %s)", rt.file, rt.route, rt.name))
		}
		pageMsg := fmt.Sprintf(`PRD:
%s

Already generated — import from these, do NOT redefine them: %s

Generate ONLY these route pages now, plus any components/app/* they need (return a JSON array):
%s

Reuse types and mock data by importing from @/lib/data. Match the styling already set in app/globals.css.`, string(prdJSON), strings.Join(order, ", "), strings.Join(lines, "\n"))

		raw, err := callGroq(groqCodeGenSystemPrompt, pageMsg, maxTok)
		if err != nil {
			// A failed batch must not kill the whole app — keep what we have and
			// let the route render 404 rather than aborting the build.
			continue
		}
		add(parseGeneratedFiles(cleanJSONArray(raw)))
	}

	if len(byPath) == 0 {
		return nil, fmt.Errorf("no valid files parsed from AI response")
	}

	files := make([]GeneratedFile, 0, len(order))
	for _, p := range order {
		files = append(files, byPath[p])
	}
	return files, nil
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
		route = strings.TrimRight(route, "/")
		if route == "" {
			route = "/"
		}
		if seen[route] {
			continue
		}
		seen[route] = true
		routes = append(routes, prdRoute{route: route, name: name, file: routeToFile(route)})
	}
	return routes
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

// parseGeneratedFiles decodes the JSON array of files. If the response is
// truncated (the model hit its token limit mid-array) or has trailing junk, it
// falls back to decoding element-by-element and keeps every complete object,
// so a partial response still yields a working app instead of failing the build.
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

// ─────────────────────────────────────────────
//  Template copy from embedded FS
// ─────────────────────────────────────────────

func copyBuilderTemplate(destDir string) error {
	return fs.WalkDir(builderTemplateFS, "builder-template", func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}

		// Compute destination path by stripping "builder-template/" prefix
		rel := strings.TrimPrefix(path, "builder-template")
		rel = strings.TrimPrefix(rel, "/")
		if rel == "" {
			return nil // skip root dir itself
		}
		dest := filepath.Join(destDir, filepath.FromSlash(rel))

		if d.IsDir() {
			return os.MkdirAll(dest, fs.ModePerm)
		}

		data, err := builderTemplateFS.ReadFile(path)
		if err != nil {
			return err
		}
		if err := os.MkdirAll(filepath.Dir(dest), fs.ModePerm); err != nil {
			return err
		}
		return os.WriteFile(dest, data, 0644)
	})
}

// ─────────────────────────────────────────────
//  Helpers
// ─────────────────────────────────────────────

// allowedImportModules are the ONLY external packages installed in the builder
// template (see builder-template/package.json). Anything else is a third-party
// dependency that both breaks the build (it isn't installed) and violates the
// "fully local app" guarantee — so we detect and surface it.
var allowedImportModules = map[string]bool{
	"react": true, "react-dom": true, "next": true,
	"lucide-react": true, "clsx": true,
	"class-variance-authority": true, "tailwind-merge": true,
}

var (
	importFromRegex    = regexp.MustCompile(`(?m)\bfrom\s+['"]([^'"]+)['"]`)
	externalFetchRegex = regexp.MustCompile(`(?i)\bfetch\s*\(\s*['"` + "`" + `]https?://`)
)

// moduleRoot reduces an import specifier to its package root so that
// "next/link" -> "next" and "@scope/pkg/sub" -> "@scope/pkg".
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

// thirdPartyRefs returns any evidence that a generated file reaches outside the
// local, self-contained app: imports of non-allowlisted packages, or fetch calls
// to an external http(s) URL. Local imports ("@/…", "./…", "../…") are fine.
func thirdPartyRefs(content string) []string {
	var found []string
	seen := map[string]bool{}
	for _, m := range importFromRegex.FindAllStringSubmatch(content, -1) {
		spec := m[1]
		if strings.HasPrefix(spec, "@/") || strings.HasPrefix(spec, "./") || strings.HasPrefix(spec, "../") {
			continue
		}
		if allowedImportModules[moduleRoot(spec)] {
			continue
		}
		if !seen["import "+spec] {
			seen["import "+spec] = true
			found = append(found, "import '"+spec+"'")
		}
	}
	if externalFetchRegex.MatchString(content) && !seen["fetch"] {
		seen["fetch"] = true
		found = append(found, "fetch() to an external URL")
	}
	return found
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

// ensureTailwindDirectives guarantees that app/globals.css always begins with
// the three @tailwind directives required for Tailwind CSS to work. If the AI
// generated a globals.css that omits them, this adds them back as a prefix.
func ensureTailwindDirectives(workdir string) {
	path := filepath.Join(workdir, "app", "globals.css")
	data, err := os.ReadFile(path)
	if err != nil {
		return // file may not exist yet, that's fine
	}
	content := string(data)
	if strings.Contains(content, "@tailwind base") {
		return // already present
	}
	header := "@tailwind base;\n@tailwind components;\n@tailwind utilities;\n\n"
	os.WriteFile(path, []byte(header+content), 0644)
}

// baseDesignTokens is the fallback palette/typography every styled component in
// the template depends on (var(--brand-*), var(--surface), var(--text), …).
const baseDesignTokens = `/* jr-architect base tokens — fallbacks; any :root the app adds later overrides these */
:root {
  --brand-50:#f0f9ff;--brand-100:#e0f2fe;--brand-200:#bae6fd;--brand-300:#7dd3fc;--brand-400:#38bdf8;--brand-500:#0ea5e9;--brand-600:#0284c7;--brand-700:#0369a1;--brand-800:#075985;--brand-900:#0c4a6e;
  --radius:0.625rem;
  --bg:#f8fafc;--surface:#ffffff;--surface2:#f1f5f9;--border:#e2e8f0;
  --text:#0f172a;--text2:#475569;--text3:#94a3b8;
  --font-inter:'Inter',system-ui,sans-serif;--font-mono:'JetBrains Mono','Fira Code',monospace;
}
`

// ensureDesignTokens guarantees the CSS design tokens exist in globals.css. The
// model frequently regenerates globals.css without the :root token block, which
// makes every component that uses var(--brand-*)/var(--surface)/var(--text)
// render uncolored ("black and white"). We inject the fallbacks right after the
// @tailwind directives; any :root the app defines later wins via the cascade.
func ensureDesignTokens(workdir string) {
	path := filepath.Join(workdir, "app", "globals.css")
	data, err := os.ReadFile(path)
	if err != nil {
		return
	}
	content := string(data)
	if strings.Contains(content, "jr-architect base tokens") {
		return // already injected
	}
	// If the essential tokens the components depend on are all present, leave it.
	if strings.Contains(content, "--surface:") &&
		strings.Contains(content, "--brand-600:") &&
		strings.Contains(content, "--text:") {
		return
	}
	marker := "@tailwind utilities;"
	if idx := strings.Index(content, marker); idx >= 0 {
		at := idx + len(marker)
		content = content[:at] + "\n\n" + baseDesignTokens + content[at:]
	} else {
		content = baseDesignTokens + "\n" + content
	}
	os.WriteFile(path, []byte(content), 0644)
}

// normalizeUIImports rewrites @/components/ui/* imports to the exact form the
// template exposes: lowercase (case-sensitive) file paths and named imports.
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

	// UI import normalizers. The template's ui components are NAMED exports in
	// lowercase files (@/components/ui/button, …), but the model often writes
	// `import Card from '@/components/ui/Card'` (default import + capitalized path),
	// which fails to resolve on the case-sensitive container and renders nothing.
	uiImportPathRegex    = regexp.MustCompile(`(@/components/ui/)([A-Za-z][A-Za-z0-9_-]*)`)
	uiDefaultImportRegex = regexp.MustCompile(`import\s+([A-Za-z][A-Za-z0-9_]*)\s+from\s+(['"]@/components/ui/[a-z][a-z0-9_-]*['"])`)
	// bareUseClientRegex matches an UNQUOTED `use client;` directive on its own
	// line (invalid — must be the string literal "use client"). The [ \t] class
	// (not \s) keeps the match on a single line so we don't swallow neighbours.
	// It deliberately does not match the correct `"use client";` (starts with a quote).
	bareUseClientRegex = regexp.MustCompile(`(?mi)^[ \t]*use[ \t]+client[ \t]*;?[ \t]*\r?$`)
)

func postProcessCode(content string, filename string) string {
	// A. Clean up hallucinated useClient calls & imports, and the bare
	// `use client;` directive (unquoted, often placed after imports). All three
	// signal the model intended a client component; we strip them and re-add the
	// correct `"use client";` at line 1 in step 3.
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

	// 1b. Normalize @/components/ui/* imports: lowercase the (case-sensitive) path
	// and convert default imports to named ones so the styled base components
	// actually resolve and render.
	content = normalizeUIImports(content)

	// 2. Convert export default function/class to named + default
	// This makes components importable as both named and default imports
	if defaultExportRegex.MatchString(content) {
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

	// 3. Auto-inject "use client" if React hooks are used, or if useClient was cleaned up
	// BUT ONLY if the file doesn't define an async component (since async functions aren't allowed in client components)
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

// ─────────────────────────────────────────────
//  /build/history
// ─────────────────────────────────────────────

func buildHistoryHandler(w http.ResponseWriter, r *http.Request) {
	corsHeaders(w)
	buildHistMu.Lock()
	defer buildHistMu.Unlock()
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(buildHistory)
}
