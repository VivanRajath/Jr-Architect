package builder

import (
	"encoding/json"
	"fmt"
	"net/http"
	"sort"
	"strings"
	"sync"

	"sandbox/internal/core"
)

// /build/questions

func QuestionsHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}

	var req struct {
		Prompt string `json:"prompt"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil || strings.TrimSpace(req.Prompt) == "" {
		core.JSONError(w, "prompt is required", 400)
		return
	}

	stack, language := DetectStack(req.Prompt)
	questions := ideaQuestions(req.Prompt)
	if stack == "" {
		questions = append([]Question{stackQuestion(language)}, questions...)
	}

	writeJSON(w, map[string]any{"questions": questions, "stack": stack, "stacks": Stacks})
}

const questionsSystem = `You are the founding product designer for the app someone just described. Before anyone writes a spec, you lay out the product decisions that most change what gets built, each as a choice between distinct, well-built directions.

Think first (silently, never output this): what is the person really trying to achieve? What would the best app in this category do that a naive version would not? Where do two great versions of this product diverge?

Ask exactly 4 questions, in this order:
1. kind "experience": the core experience or interaction model (how the user mainly works with the app).
2. kind "ai": how much the app should think for the user and in what way (plan, generate, evaluate, coach, adapt).
3. kind "capability": the capability decision that matters most for THIS domain (content types, depth, tracking, collaboration with themselves over time, etc.).
4. kind "design": the visual and interaction direction, with each option described concretely (mood, palette, layout, density).

Each question:
- Is phrased around this product's users and job ("How should the tutor decide what you learn next?"). A question that fits any app ("What features do you want?", "Who is your audience?") is wrong.
- Has 3 or 4 options. Each option is an ambitious, complete direction: a label of 2-6 words and, in "details" at the same index, one sentence on what the user would actually experience. Options differ in kind, not degree. Never "Other", "Yes" or "No".
- "multi" is true when options can be combined (capabilities, content types, modes), false when they exclude each other (core model, visual direction).
- "recommended" lists the 0-based indexes you would pick for the strongest product.
Never ask about the tech stack, framework, hosting, sign-in, payments, pricing or the app's name.

Return ONLY a JSON array, no prose and no code fences. Shape, shown for a recipe app (write your own for the idea you are given):
[{"id":"cooking_guidance","kind":"experience","text":"How should the app guide you while you cook?","multi":false,"options":["Hands-free cook mode","Smart recipe cards","Live sous-chef"],"details":["Full-screen steps in large type with timers that start themselves","Scannable cards with scaled ingredients, swaps and a shopping list","Ask anything mid-recipe and it adapts the steps to what you have"],"recommended":[0]}]`

// Two attempts at idea-specific questions; a reply cut short or not JSON gets one retry before a fallback built from the idea itself.
func ideaQuestions(prompt string) []Question {
	userMsg := fmt.Sprintf("App idea: %s\n\nLay out the 4 design decisions for this product.", prompt)
	for attempt := 0; attempt < 2; attempt++ {
		raw, err := callGroq(questionsSystem, userMsg, 4000)
		if err != nil {
			break
		}
		var qs []Question
		if json.Unmarshal([]byte(cleanJSONArray(raw)), &qs) != nil {
			continue
		}
		if out := cleanQuestions(qs); len(out) > 0 {
			return out
		}
	}
	return fallbackQuestions(prompt)
}

// Drops empty or stack questions, and keeps details and recommendations aligned with the options they describe.
func cleanQuestions(qs []Question) []Question {
	var out []Question
	for _, q := range qs {
		q.Text = strings.TrimSpace(q.Text)
		if q.Text == "" || q.ID == "tech_stack" {
			continue
		}
		if q.ID == "" {
			q.ID = fmt.Sprintf("q%d", len(out)+1)
		}
		var opts, details []string
		moved := map[int]int{}
		for i, o := range q.Options {
			if o = strings.TrimSpace(o); o == "" {
				continue
			}
			moved[i] = len(opts)
			opts = append(opts, o)
			d := ""
			if i < len(q.Details) {
				d = strings.TrimSpace(q.Details[i])
			}
			details = append(details, d)
		}
		q.Options, q.Details = opts, details
		var rec []int
		for _, i := range q.Recommended {
			if j, ok := moved[i]; ok && (q.Multi || len(rec) == 0) {
				rec = append(rec, j)
			}
		}
		q.Recommended = rec
		out = append(out, q)
		if len(out) == 4 {
			break
		}
	}
	return out
}

// Still design decisions, worded around the idea, for when the model is unreachable.
func fallbackQuestions(prompt string) []Question {
	idea := strings.TrimSpace(prompt)
	if r := []rune(idea); len(r) > 60 {
		idea = string(r[:60]) + "…"
	}
	return []Question{
		{ID: "experience", Kind: "experience", Text: fmt.Sprintf("How should people mainly work with \"%s\"?", idea),
			Options:     []string{"Guided step by step", "Open workspace", "Conversational assistant"},
			Details:     []string{"A clear path with one next action at a time and visible progress", "A dashboard of everything, edited directly with shortcuts", "Describe what you want and the app does it, showing its work"},
			Recommended: []int{0}},
		{ID: "intelligence", Kind: "ai", Multi: true, Text: "What should the app figure out for the user?",
			Options:     []string{"Plans and next steps", "Generates the content", "Reviews and gives feedback", "Adapts to their progress"},
			Details:     []string{"Turns a goal into a concrete plan", "Drafts what the user would otherwise write", "Checks the user's work and explains what to fix", "Changes difficulty and suggestions as the user goes"},
			Recommended: []int{0, 2, 3}},
		{ID: "look_and_feel", Kind: "design", Text: "What should it look and feel like?",
			Options:     []string{"Calm and focused", "Bold and energetic", "Dense and pro"},
			Details:     []string{"Light, airy layout with soft neutrals and one accent", "Vivid accent colours, big type and playful progress moments", "Dark, compact panels with keyboard-first controls"},
			Recommended: []int{0}},
	}
}

// /build/prd

const productSystem = `You are the head of product at a company known for category-defining apps. A founder hands you an idea, often a single vague line; you return the spec for the best app in its category, what a top team would ship after studying every competitor.

Think first (silently, never output this):
1. The user's real goal behind the idea. Someone who wants a "coding tutor" wants to actually become able to build things, not to fill in a text box.
2. The complete journey: first run and onboarding (an assessment or setup), the core loop they repeat, how progress is tracked and celebrated, how they get unstuck, why they come back tomorrow.
3. What the leading apps in this space do well, and the one or two things that would make this one clearly better.
4. Where intelligence creates real value: personalising, planning, generating, evaluating, explaining, adapting.
A short or vague idea is not permission to build something small. Expand it into the full product it deserves. A naive version (one input, one button, one result) is a failure.

The user's design decisions are binding: build exactly the directions they chose.

Return ONLY a JSON object, no code fences and no prose:
{
  "name": "A memorable product name",
  "tagline": "One sentence value proposition",
  "vision": "2-3 sentences: what the app does for the user end to end and why it beats the alternatives",
  "target_users": "Who it is for and what they are trying to achieve",
  "core_loop": "The loop users repeat, as short steps joined by arrows",
  "features": ["8-14 specific, testable user stories. Each names the page, what the user does, what they see and what the app does intelligently. E.g. 'On the Roadmap page the learner sees a week-by-week plan built from their skill check; finishing a lesson unlocks the next step and re-plans the remaining weeks when they are ahead or behind.'"],
  "pages": ["/ - Name: the core working screen and what it shows", "/route - Name: what it shows and lets the user do"],
  "ui_note": "A concrete design direction: palette (named colours or hex), typography, layout and density, signature components (progress rings, timelines, split editors, kanban...), empty states, motion, tone of copy",
  "data_model": {"Entity": ["field", "field"]},
  "edge_cases": ["6-10 situations the app must handle well"],
  "out_of_scope": ["Things not in this version"]
}
Rules:
- 4-7 pages with static routes (no :id or [id]; a detail view is a page that shows the selected item). The first is "/", the screen the user lands in and works in. No landing, hero, pricing, about or sign-up pages anywhere.
- Every feature is something the user does in the app, on a named page.
- data_model has 3-6 entities with the real fields the features need (ids, timestamps, status, scores, relations).
- edge_cases cover the empty first run, vague or wrong input, very long input, the AI being slow or failing, undoing mistakes, and the user leaving the happy path.
- LOCAL ONLY: the app runs in the browser and saves to localStorage. No accounts, OAuth, payments, email or SMS, cloud sync or third-party APIs; turn any such idea into a local action (export a file, a local profile). AI is the exception: it runs on this platform's workflows, so features may use AI freely.
- out_of_scope always includes "User accounts & third-party sign-in", "Sending email or SMS", "Payment processing" and "Any external API, cloud sync, or server backend".`

const aiSystem = `You are the AI architect for an app whose product spec is final. Design the Agent Hub agents and workflows behind its intelligent features, built like a production AI product rather than a demo.

Think first (silently, never output this): which features need a language model (understanding, generating, evaluating, planning, personalising, explaining); the decisions inside them (pass or fail, level, intent, quality, missing information); and what real users will do wrong (vague, empty, off-topic, very long or wrong-language input, unsafe requests, being confidently wrong).

An agent is only for work that needs a language model. The app's own code already handles running or executing code, maths and scores, timers, saving, undo, export, search, filtering and navigation, so never make an agent for those; at most an agent explains or reacts to their results.

Return ONLY a JSON object, no code fences and no prose: {"agents": [...], "workflows": [...]}

Agents: 4-8 strong specialists, each with one job (assessor, planner, generator, grader, explainer, coach, router, critic). Prefer fewer, deeper agents to many thin ones.
{"key": "snake_case", "name": "Readable Name", "purpose": "One sentence", "instructions": "...", "rules": ["..."], "input": {"field": "What it holds"}, "output": {"field": {"type": "text|list|number|yes/no", "description": "..."}}}
- instructions: 120-220 words. Cover its expertise and point of view, the method as numbered steps, the exact output format and length, the quality bar, and how it handles each problem above (state an assumption and continue, fill "clarification", or decline unsafe content politely).
- rules: 3-6 hard constraints.
- input has 1-5 fields; output has 2-6 fields. Use list for anything shown as a list, number for scores, yes/no for decisions. Agents that read free text from the user also output "clarification" (text, empty when not needed).
- A later agent receives earlier agents' outputs by field name, so reuse names on purpose.
Example of the depth expected, from a different app:
{"key": "essay_grader", "name": "Essay Grader", "purpose": "Scores an essay against the assignment and explains the score.", "instructions": "You are a demanding but fair writing teacher. 1. Read the assignment, then the essay. 2. If the essay is empty, off-topic or under 50 words, set meets_bar to no, score to 0 and explain what is missing in clarification. 3. Otherwise score 0-100 on thesis, evidence, structure and style, 25 each. 4. List up to 5 strengths and up to 5 fixes, most important first, each one sentence quoting the passage it refers to. 5. Set meets_bar to yes only when the score is 70 or more. Write feedback in the essay's language, plainly, without flattery.", "rules": ["Never rewrite the essay", "Quote the student's words when criticising them", "No score above 90 without strong evidence"], "input": {"essay": "The student's essay", "assignment": "What was asked"}, "output": {"score": {"type": "number", "description": "0-100"}, "meets_bar": {"type": "yes/no", "description": "Score of 70 or more"}, "strengths": {"type": "list", "description": "One per item"}, "fixes": {"type": "list", "description": "Most important first"}, "clarification": {"type": "text", "description": "Why the essay could not be graded, or empty"}}}

Workflows: 3-6, each powering one feature of the app:
{"key": "snake_case", "name": "Readable name", "description": "What the app gets back", "agents": ["1-4 agent keys run in order"], "approval": false, "used_by": "The page and button or moment that calls it", "branch": {...}}
- Add "branch" when the feature decides between two different follow-ups: {"field": "a yes/no or label output of the chain's agents", "op": "is_true|equals|contains|greater|less", "value": "for equals, contains, greater or less", "label": "Short question, e.g. Passed?", "then": ["agents for the true case"], "else": ["agents for the false case"]}. "then" and "else" name DIFFERENT agents doing different work, and neither repeats an agent already in the chain. A workflow that grades, tests or checks the user's work always branches on its pass or fail field: pass goes to the agent that moves them forward (next step, harder task, praise with what to learn next), fail goes to the agent that coaches them. Routing by intent or level and quality gates branch the same way.
- Build real pipelines: at least half the workflows chain 2-4 agents that each add a step (analyse, then decide or plan, then write or explain), rather than one agent doing everything.
- "approval": true only when a person must check the result before the app uses it.
- Every intelligent feature in the spec is served by a workflow; features that are plain app logic get none.
Example: {"key": "review_essay", "name": "Review essay", "description": "A score and feedback, then either a polished draft or a coaching plan", "agents": ["essay_grader"], "branch": {"field": "meets_bar", "op": "is_true", "label": "Good enough?", "then": ["polisher"], "else": ["writing_coach"]}, "used_by": "Editor page, Submit button"}`

func PRDHandler(w http.ResponseWriter, r *http.Request) {
	core.CORS(w, r)
	if r.Method == http.MethodOptions {
		return
	}

	var req struct {
		Prompt    string            `json:"prompt"`
		Answers   map[string]string `json:"answers"`
		Questions []Question        `json:"questions"`
		Stack     string            `json:"stack"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		core.JSONError(w, "invalid request", 400)
		return
	}

	stackID := req.Stack
	if stackID == "" {
		stackID = stackFromAnswer(req.Answers["tech_stack"])
	}
	stack, _ := StackByID(stackID)

	decisions := decisionsText(req.Questions, req.Answers)
	userMsg := fmt.Sprintf("App idea: %s\n\nThe user's design decisions:\n%s\nTech stack: %s.\n\nWrite the product spec.", req.Prompt, decisions, stack.Label)
	var prd PRD
	if err := askJSON(productSystem, userMsg, 6000, &prd); err != nil {
		core.JSONError(w, "Could not write the PRD: "+err.Error(), 502)
		return
	}
	prd.Stack = stack.ID
	for i, page := range prd.Pages {
		route, rest, _ := strings.Cut(strings.TrimSpace(page), " - ")
		if strings.HasPrefix(route, "/") {
			prd.Pages[i] = strings.TrimSuffix(staticRoute(route)+" - "+rest, " - ")
		}
	}
	// The look and the AI plan both work from the finished spec, so they run side by side.
	spec := prd
	var design *DesignDirection
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		design = designDirection(&spec, decisions)
	}()
	if stack.AI {
		prd.AI = designAI(&prd)
	}
	wg.Wait()
	prd.Design = design
	writeJSON(w, map[string]any{"prd": prd})
}

// The AI plan is its own call so it gets the whole spec and a full token budget; an app still builds without it.
var planDrafts = 2

func designAI(prd *PRD) *AIPlan {
	spec, _ := json.Marshal(prdForCode(prd))
	// Two drafts in parallel on separate keys; the one with more chains and branches wins.
	drafts := make([]*AIPlan, planDrafts)
	var wg sync.WaitGroup
	for i := range drafts {
		wg.Add(1)
		go func(i int) {
			defer wg.Done()
			var p AIPlan
			if err := askJSON(aiSystem, "Product spec:\n"+string(spec)+"\n\nDesign the agents and workflows.", 8000, &p); err != nil {
				core.Logf("builder", "AI plan draft failed: %v", err)
				return
			}
			tidyPlan(&p)
			drafts[i] = &p
		}(i)
	}
	wg.Wait()
	var best *AIPlan
	for _, d := range drafts {
		if d != nil && len(d.Workflows) > 0 && (best == nil || planStrength(d) > planStrength(best)) {
			best = d
		}
	}
	if best == nil {
		return &AIPlan{Agents: []AIAgent{}, Workflows: []AIWorkflow{}}
	}
	plan := *best
	// A plan of one-agent workflows with no decisions gets one more try, told exactly what is missing.
	if critique := planCritique(&plan); critique != "" {
		var better AIPlan
		msg := "Product spec:\n" + string(spec) + "\n\nA previous attempt:\n" + planSummary(&plan) + "\n\nIt is too simple: " + critique + " Design the full plan again, fixing that."
		if err := askJSON(aiSystem, msg, 7000, &better); err == nil {
			if tidyPlan(&better); planStrength(&better) > planStrength(&plan) {
				return &better
			}
		}
	}
	return &plan
}

func planStrength(p *AIPlan) int {
	n := 0
	for _, w := range p.Workflows {
		if w.Branch != nil {
			n += 2
		}
		if len(w.Agents) > 1 {
			n++
		}
	}
	return n
}

func planCritique(p *AIPlan) string {
	if len(p.Workflows) == 0 {
		return ""
	}
	branches, chains := 0, 0
	for _, w := range p.Workflows {
		if w.Branch != nil {
			branches++
		}
		if len(w.Agents) > 1 {
			chains++
		}
	}
	var issues []string
	if branches == 0 {
		issues = append(issues, "no workflow branches, although the product makes decisions (grading, routing, quality gates)")
	}
	if chains*2 < len(p.Workflows) {
		issues = append(issues, fmt.Sprintf("only %d of %d workflows chain more than one agent", chains, len(p.Workflows)))
	}
	if len(issues) == 0 {
		return ""
	}
	return strings.Join(issues, "; ") + "."
}

// The plan's shape without the long instructions, small enough to send back with the spec.
func planSummary(p *AIPlan) string {
	var b strings.Builder
	for _, a := range p.Agents {
		var out []string
		for k := range a.Output {
			out = append(out, k)
		}
		sort.Strings(out)
		fmt.Fprintf(&b, "agent %s: %s -> %s\n", a.Key, a.Purpose, strings.Join(out, ", "))
	}
	for _, w := range p.Workflows {
		fmt.Fprintf(&b, "workflow %s: %s (%s)\n", w.Key, strings.Join(w.Agents, " -> "), w.UsedBy)
	}
	return b.String()
}

// Agent Hub's blueprint limits, applied here too so the plan the user reviews is the one that gets built.
const (
	maxPlanAgents    = 8
	maxPlanWorkflows = 6
	maxChain         = 4
	maxBranchChain   = 3
)

func tidyPlan(p *AIPlan) {
	byKey := map[string]AIAgent{}
	for _, a := range p.Agents {
		if _, dup := byKey[a.Key]; a.Key != "" && !dup {
			byKey[a.Key] = a
		}
	}
	pick := func(list, taken []string, max int) []string {
		var out []string
		for _, k := range list {
			if _, ok := byKey[k]; ok && !contains(out, k) && !contains(taken, k) && len(out) < max {
				out = append(out, k)
			}
		}
		return out
	}
	used := map[string]bool{}
	seen := map[string]bool{}
	var flows []AIWorkflow
	for _, f := range p.Workflows {
		f.Agents = pick(f.Agents, nil, maxChain)
		if f.Key == "" || seen[f.Key] || len(f.Agents) == 0 || len(flows) == maxPlanWorkflows {
			continue
		}
		if b := f.Branch; b != nil {
			b.Then = pick(b.Then, f.Agents, maxBranchChain)
			b.Else = pick(b.Else, append(append([]string{}, f.Agents...), b.Then...), maxBranchChain)
			if !producedBy(byKey, f.Agents, b.Field) || len(b.Then)+len(b.Else) == 0 {
				f.Branch = nil
			}
		}
		all := append([]string{}, f.Agents...)
		if f.Branch != nil {
			all = append(append(all, f.Branch.Then...), f.Branch.Else...)
		}
		n := len(used)
		for _, k := range all {
			if !used[k] {
				n++
			}
		}
		if n > maxPlanAgents {
			continue
		}
		for _, k := range all {
			used[k] = true
		}
		seen[f.Key] = true
		flows = append(flows, f)
	}
	var agents []AIAgent
	for _, a := range p.Agents {
		if used[a.Key] {
			agents = append(agents, a)
			delete(used, a.Key)
		}
	}
	p.Agents, p.Workflows = agents, flows
	if p.Agents == nil {
		p.Agents = []AIAgent{}
	}
	if p.Workflows == nil {
		p.Workflows = []AIWorkflow{}
	}
}

func producedBy(byKey map[string]AIAgent, chain []string, field string) bool {
	for _, k := range chain {
		if _, ok := byKey[k].Output[field]; ok {
			return true
		}
	}
	return false
}

func contains(list []string, s string) bool {
	for _, v := range list {
		if v == s {
			return true
		}
	}
	return false
}

var planEffort = "medium"

// One retry when the reply is cut short or is not the JSON asked for.
func askJSON(system, msg string, maxTokens int, into any) error {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ {
		raw, err := callGroqEffort(system, msg, maxTokens, planEffort)
		if err != nil {
			return err
		}
		if lastErr = json.Unmarshal([]byte(cleanJSONObject(raw)), into); lastErr == nil {
			return nil
		}
	}
	return fmt.Errorf("the model's reply was not valid JSON (%v)", lastErr)
}

func cleanJSONObject(raw string) string {
	start, end := strings.Index(raw, "{"), strings.LastIndex(raw, "}")
	if start < 0 || end <= start {
		return raw
	}
	return raw[start : end+1]
}

// Each answered question with the user's choice, in the order they were asked.
func decisionsText(qs []Question, answers map[string]string) string {
	var b strings.Builder
	seen := map[string]bool{"tech_stack": true}
	for _, q := range qs {
		if a := strings.TrimSpace(answers[q.ID]); a != "" && !seen[q.ID] {
			fmt.Fprintf(&b, "- %s\n  Chosen: %s\n", q.Text, a)
			seen[q.ID] = true
		}
	}
	var rest []string
	for id := range answers {
		if !seen[id] && strings.TrimSpace(answers[id]) != "" {
			rest = append(rest, id)
		}
	}
	sort.Strings(rest)
	for _, id := range rest {
		fmt.Fprintf(&b, "- %s: %s\n", id, strings.TrimSpace(answers[id]))
	}
	if b.Len() == 0 {
		return "(none given: choose the strongest directions yourself)\n"
	}
	return b.String()
}

// The parts of the PRD the UI is built from; agent internals stay out so each generation call fits one Groq key's per-minute budget.
type codeView struct {
	Name        string              `json:"name"`
	Tagline     string              `json:"tagline,omitempty"`
	Vision      string              `json:"vision,omitempty"`
	TargetUsers string              `json:"target_users,omitempty"`
	CoreLoop    string              `json:"core_loop,omitempty"`
	Features    []string            `json:"features"`
	Pages       []string            `json:"pages"`
	UINote      string              `json:"ui_note,omitempty"`
	DataModel   map[string][]string `json:"data_model,omitempty"`
	EdgeCases   []string            `json:"edge_cases,omitempty"`
	AIFeatures  []string            `json:"ai_features,omitempty"`
	Look        string              `json:"look,omitempty"`
}

func prdForCode(prd *PRD) codeView {
	v := codeView{Name: prd.Name, Tagline: prd.Tagline, Vision: prd.Vision, TargetUsers: prd.TargetUsers, CoreLoop: prd.CoreLoop,
		Features: prd.Features, Pages: prd.Pages, UINote: prd.UINote, DataModel: prd.DataModel, EdgeCases: prd.EdgeCases}
	if prd.Design != nil {
		v.Look = prd.Design.Concept
	}
	if prd.AI != nil {
		for _, f := range prd.AI.Workflows {
			v.AIFeatures = append(v.AIFeatures, strings.TrimSpace(fmt.Sprintf("%s: %s (used by %s)", f.Name, f.Description, f.UsedBy)))
		}
	}
	return v
}

func codePRDJSON(prd *PRD) (string, error) {
	data, err := json.Marshal(prdForCode(prd))
	return string(data), err
}
