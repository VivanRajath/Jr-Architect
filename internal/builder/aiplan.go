package builder

import (
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"sandbox/internal/core"
)

// The PRD's plan for the app's AI: Agent Hub agents and the workflows the app calls.
type AIPlan struct {
	Agents    []AIAgent    `json:"agents"`
	Workflows []AIWorkflow `json:"workflows"`
}

type AIAgent struct {
	Key          string   `json:"key"`
	Name         string   `json:"name"`
	Purpose      string   `json:"purpose"`
	Instructions string   `json:"instructions,omitempty"`
	Rules        []string `json:"rules,omitempty"`
	// A field is a description, or {"type", "description"} for outputs; Agent Hub reads both.
	Input  map[string]any `json:"input"`
	Output map[string]any `json:"output"`
}

type AIWorkflow struct {
	Key         string    `json:"key"`
	Name        string    `json:"name"`
	Description string    `json:"description,omitempty"`
	Agents      []string  `json:"agents"`
	Approval    bool      `json:"approval,omitempty"`
	UsedBy      string    `json:"used_by,omitempty"`
	Branch      *AIBranch `json:"branch,omitempty"`
}

// An If after the chain: Agent Hub tests Field and runs Then or Else.
type AIBranch struct {
	Field string   `json:"field"`
	Op    string   `json:"op,omitempty"`
	Value string   `json:"value,omitempty"`
	Label string   `json:"label,omitempty"`
	Then  []string `json:"then,omitempty"`
	Else  []string `json:"else,omitempty"`
}

// A workflow Agent Hub created from the plan, with the token the app calls it with.
type BuiltWorkflow struct {
	Key         string            `json:"key"`
	ID          string            `json:"id"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Token       string            `json:"token"`
	Approval    bool              `json:"approval"`
	Input       map[string]string `json:"input"`
	Output      map[string]string `json:"output"`
	// string, list, number or boolean per output field; a list arrives as a JSON array.
	OutputTypes map[string]string `json:"outputTypes,omitempty"`
}

var (
	flowKeyRe   = regexp.MustCompile(`^[a-z][a-z0-9_]{0,30}$`)
	flowIDRe    = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{0,47}$`)
	flowTokenRe = regexp.MustCompile(`^[A-Za-z0-9_-]{8,200}$`)
	fieldRe     = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]{0,39}$`)
)

// Everything here ends up in generated TypeScript and .env.local, so anything that is not a plain identifier is refused.
func validateBuiltWorkflows(flows []BuiltWorkflow) error {
	if len(flows) > 6 {
		return fmt.Errorf("at most 6 workflows per app")
	}
	seen := map[string]bool{}
	for _, f := range flows {
		if !flowKeyRe.MatchString(f.Key) || seen[f.Key] {
			return fmt.Errorf("invalid workflow key %q", f.Key)
		}
		seen[f.Key] = true
		if !flowIDRe.MatchString(f.ID) || !flowTokenRe.MatchString(f.Token) {
			return fmt.Errorf("workflow %s has an invalid id or token", f.Key)
		}
		for k, t := range f.OutputTypes {
			if _, ok := f.Output[k]; !ok || (t != "string" && t != "list" && t != "number" && t != "boolean") {
				return fmt.Errorf("workflow %s has an invalid type %q for %q", f.Key, t, k)
			}
		}
		for _, fields := range []map[string]string{f.Input, f.Output} {
			// A branching chain returns every field its agents produce, so this only stops a runaway plan.
			if len(fields) > 64 {
				return fmt.Errorf("workflow %s has too many fields", f.Key)
			}
			for k := range fields {
				if !fieldRe.MatchString(k) {
					return fmt.Errorf("workflow %s has an invalid field %q", f.Key, k)
				}
			}
		}
	}
	return nil
}

// Where code inside a builder container reaches this server's workflow webhooks.
func apiBaseForContainers() string {
	if core.Cfg.Public() {
		return core.Cfg.PublicOrigin
	}
	host := "host.docker.internal"
	if core.IsPodman() {
		host = "host.containers.internal"
	}
	return "http://" + host + ":" + core.Cfg.ListenPort()
}

// Lets a Linux Docker container resolve host.docker.internal; Docker Desktop and Podman provide their own name.
func hostGatewayArgs() []string {
	if core.IsPodman() || core.Cfg.Public() {
		return nil
	}
	return []string{"--add-host", "host.docker.internal:host-gateway"}
}

func tokenEnv(key string) string { return "JR_WF_" + strings.ToUpper(key) + "_TOKEN" }

func sortedKeys(m map[string]string) []string {
	keys := make([]string, 0, len(m))
	for k := range m {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	return keys
}

func tsShape(fields map[string]string) string {
	return typedShape(fields, nil)
}

// The output's TypeScript shape, e.g. { ingredients: string[]; title: string }.
func typedShape(fields, types map[string]string) string {
	ts := map[string]string{"list": "string[]", "number": "number", "boolean": "boolean"}
	var parts []string
	for _, k := range sortedKeys(fields) {
		t := ts[types[k]]
		if t == "" {
			t = "string"
		}
		parts = append(parts, k+": "+t)
	}
	return "{ " + strings.Join(parts, "; ") + " }"
}

// Shared by every contract: list fields are arrays, read through asList so a plain-text answer still renders.
const listRule = `Fields typed string[] are arrays. Always read them through asList(value), which also accepts newline-separated text, and render each item (e.g. <ol>/<ul> rows); never call .map/.forEach on a raw output field.`

func tsString(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `'`, `\'`, "\n", " ", "\r", " ", "<", `\x3c`)
	return "'" + r.Replace(s) + "'"
}

// Generated code never edits these; they are written from the workflows Agent Hub created.
func reservedPath(p string) bool {
	return p == "lib/workflows.ts" || p == "lib/utils.ts" || p == "lib/use-stored.ts" || p == "app/globals.css" || p == "app/layout.tsx" || p == "components/app/app-shell.tsx" ||
		strings.HasPrefix(p, "app/api/") || strings.HasPrefix(p, "components/ui/") || strings.HasPrefix(p, "components/blocks/")
}

func writeWorkflowClient(workdir string, flows []BuiltWorkflow) error {
	var keys, entries, routes []string
	for _, f := range flows {
		keys = append(keys, tsString(f.Key))
		entries = append(entries, fmt.Sprintf("  %s: { name: %s, description: %s, approval: %t, input: %s, output: %s },",
			f.Key, tsString(f.Name), tsString(f.Description), f.Approval, tsString(tsShape(f.Input)), tsString(typedShape(f.Output, f.OutputTypes))))
		routes = append(routes, fmt.Sprintf("  %s: { id: %s, tokenEnv: %s },", f.Key, tsString(f.ID), tsString(tokenEnv(f.Key))))
	}

	lib := `// Generated by Jr Architect Build mode. The workflows live in Agent Hub; edit them there and this app uses the new version.
export type WorkflowKey = ` + strings.Join(keys, " | ") + `;

export const WORKFLOWS = {
` + strings.Join(entries, "\n") + `
} as const;

export type WorkflowResult<T = Record<string, string>> = {
  status: 'completed' | 'awaiting_approval' | 'failed';
  output: T;
  error?: string;
};

// A list field as an array, whether the agent sent an array or newline-separated text.
export function asList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)));
  if (typeof value !== 'string' || !value.trim()) return [];
  return value.split(/\r?\n/).map((s) => s.replace(/^\s*(?:[-*\u2022]|\d+[.)])\s+/, '').trim()).filter(Boolean);
}

// Runs one workflow through this app's own /api route, which holds the token.
// Identical calls already running share one request, so a re-render or a double click cannot flood Agent Hub.
const inFlight = new Map<string, Promise<WorkflowResult<any>>>();

export function runWorkflow<T = Record<string, string>>(key: WorkflowKey, input: Record<string, string>): Promise<WorkflowResult<T>> {
  const id = key + ':' + JSON.stringify(input);
  const running = inFlight.get(id);
  if (running) return running as Promise<WorkflowResult<T>>;
  const call = callWorkflow<T>(key, input).finally(() => inFlight.delete(id));
  inFlight.set(id, call);
  return call;
}

async function callWorkflow<T>(key: WorkflowKey, input: Record<string, string>): Promise<WorkflowResult<T>> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch('/api/workflows/' + key, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(input),
      });
      // Agent Hub runs two workflows at a time; a busy answer is retried after a short wait.
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
        continue;
      }
      const data = await res.json().catch(() => null);
      if (!data || !data.status) {
        console.error('[workflow] ' + key + ' failed:', (data && data.error) || 'HTTP ' + res.status);
        return { status: 'failed', output: {} as T, error: (data && data.error) || 'HTTP ' + res.status };
      }
      if (data.status === 'failed') console.error('[workflow] ' + key + ' failed:', data.error);
      return { ...data, output: data.output ?? ({} as T) } as WorkflowResult<T>;
    } catch {
      return { status: 'failed', output: {} as T, error: 'Could not reach the app server' };
    }
  }
}
`
	route := `import { NextResponse } from 'next/server';

// Runs a Jr Architect workflow on the server so its token never reaches the browser.
const FLOWS: Record<string, { id: string; tokenEnv: string }> = {
` + strings.Join(routes, "\n") + `
};

export async function POST(req: Request, { params }: { params: { key: string } }) {
  const flow = FLOWS[params.key];
  if (!flow) {
    console.log('[workflow] ' + params.key + ': unknown workflow (check lib/workflows.ts and .env.local)');
    return NextResponse.json({ status: 'failed', error: 'Unknown workflow' }, { status: 404 });
  }
  const started = Date.now();
  const base = process.env.JR_API_BASE;
  const token = process.env[flow.tokenEnv];
  if (!base || !token) return NextResponse.json({ status: 'failed', error: 'JR_API_BASE or this workflow\'s token is missing from .env.local' }, { status: 500 });
  const input = await req.json().catch(() => ({}));
  try {
    const res = await fetch(base + '/hooks/workflows/' + flow.id + '/run', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token },
      body: JSON.stringify({ input }),
      cache: 'no-store',
    });
    const run = await res.json().catch(() => ({}));
    console.log('[workflow] ' + params.key + ' -> ' + (run.status || res.status) + ' in ' + (Date.now() - started) + 'ms' + (run.error ? ': ' + run.error : ''));
    return NextResponse.json({ status: run.status || 'failed', output: run.output, error: run.error }, { status: res.ok ? 200 : res.status });
  } catch (e) {
    console.log('[workflow] ' + params.key + ': could not reach ' + base + ' (' + (e as Error).message + ')');
    return NextResponse.json({ status: 'failed', error: 'Could not reach Jr Architect at ' + base }, { status: 502 });
  }
}
`
	env := []string{
		"# Jr Architect Build mode: where this app's workflows run, and one token per workflow (replace or revoke them in Agent Hub > Workflows > Webhook).",
		"JR_API_BASE=" + apiBaseForContainers(),
	}
	for _, f := range flows {
		env = append(env, tokenEnv(f.Key)+"="+f.Token)
	}

	files := map[string]string{
		"lib/workflows.ts":                 lib,
		"app/api/workflows/[key]/route.ts": route,
		".env.local":                       strings.Join(env, "\n") + "\n",
	}
	for rel, body := range files {
		abs := filepath.Join(workdir, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0755); err != nil {
			return err
		}
		perm := os.FileMode(0644)
		if rel == ".env.local" {
			perm = 0600
		}
		if err := os.WriteFile(abs, []byte(body), perm); err != nil {
			return err
		}
	}
	return nil
}

// Tells the code generator exactly which AI calls exist, so AI features call real workflows instead of faking results.
func workflowContract(flows []BuiltWorkflow) string {
	if len(flows) == 0 {
		return ""
	}
	var lines []string
	for _, f := range flows {
		lines = append(lines, fmt.Sprintf(`- runWorkflow("%s", %s) -> result.output: %s. %s`, f.Key, tsShape(f.Input), typedShape(f.Output, f.OutputTypes), f.Description))
	}
	return `

AI WORKFLOWS (this app's real AI features; never fake their results with mock data):
lib/workflows.ts already exists; do NOT generate it or anything under app/api/. Import it with: import { runWorkflow, asList } from "@/lib/workflows";
` + strings.Join(lines, "\n") + `
Call runWorkflow from an event handler in a client component: show a loading state on the button, await the call, then
if result.status === "completed" use the result.output fields; if "awaiting_approval" show "Waiting for approval in Agent Hub"; if "failed" show result.error.
Save useful results to localStorage like the rest of the app's data.
` + listRule + `
This is the ONE exception to the no-network rule: runWorkflow calls the app's own server route. Never call fetch yourself and never call an AI provider directly.`
}
