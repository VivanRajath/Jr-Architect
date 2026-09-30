// Executes a Hub agent: the model calls functions, and every call goes through handlers that enforce the definition.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeQuery as query } from "../agent-home.js";
import {
  parseJsonLoose, PROVIDER_MODELS, providerHasKey, rotateGroqKey, AGENT_TOOLCALL_RETRIES, RETRIABLE_TURN_ERROR, friendlyModelError, dropRejectedKey,
} from "../llm.js";
import { GUARD_SECRET } from "../guardrails.js";
import {
  normalizeDefinition, buildSystemPrompt, validateAgainstSchema, validateDefinition, TOOL_CATALOG,
} from "./definition.js";
import { readMemory, appendMemory, saveRun, newRunId } from "./store.js";

const TOOL_RESULT_CHARS = 4000;
const MAX_INPUT_BYTES = 32 * 1024;
const FETCH_BYTES = 200 * 1024;

// An empty agent dir that allows a multi-turn tool loop; the only tools are the ones passed per segment.
let _home = null;
function hubAgentHome() {
  if (_home) return _home;
  _home = mkdtempSync(join(tmpdir(), "jr-hub-home-"));
  writeFileSync(join(_home, "agent.yaml"), 'spec_version: "0.1.0"\nname: jr-hub-runtime\nversion: 1.0.0\ndescription: Runs Agent Hub agents.\ntools: []\nruntime:\n  max_turns: 12\n');
  return _home;
}

// One model conversation with native function calling; handlers decide what really happens, and control.done ends it early.
async function realSegment(prompt, model, maxTokens, tools, control) {
  const ac = new AbortController();
  control.stop = () => ac.abort();
  let text = "";
  let error = null;
  try {
    for await (const msg of query({
      prompt, dir: hubAgentHome(), model, replaceBuiltinTools: true, tools,
      allowedTools: tools.map((t) => t.name), constraints: { maxTokens }, abortController: ac,
    })) {
      if (msg.type === "delta" && msg.deltaType !== "thinking") text += msg.content;
      else if (msg.type === "system" && msg.subtype === "error") error = msg.content || error;
      else if (msg.type === "assistant" && msg.stopReason === "error") error = msg.errorMessage || error;
      if (control.done) break;
    }
  } catch (e) {
    if (!control.done) error = e.message || String(e);
  }
  if (control.done) ac.abort();
  return { text, error };
}

// Swapped in tests: (prompt, model, maxTokens, tools, control) => { text, error }, calling tool handlers as a model would.
let segment = realSegment;
let fetchImpl = (...a) => fetch(...a);
export function _setSegmentForTests(fn) { segment = fn || realSegment; }
export function _setFetchForTests(fn) { fetchImpl = fn; }

export function modelIdFor(def) {
  const p = def.model.provider;
  if (def.model.name) return def.model.name.includes(":") ? def.model.name : `${p === "gemini" ? "google" : p}:${def.model.name}`;
  return PROVIDER_MODELS[p];
}

// Private networks are only reachable when this is a local, single-user install.
export function privateNetAllowed() {
  return !process.env.JR_PUBLIC_ORIGIN || process.env.JR_HUB_ALLOW_PRIVATE_NET === "1";
}

export function isPrivateAddress(ip) {
  if (isIP(ip) === 4) {
    const [a, b] = ip.split(".").map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 198 && (b === 18 || b === 19)) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith("::ffff:")) return isPrivateAddress(v.slice(7));
  return v === "::" || v === "::1" || v.startsWith("fc") || v.startsWith("fd") || v.startsWith("fe8") || v.startsWith("fe9") ||
    v.startsWith("fea") || v.startsWith("feb") || v.startsWith("ff");
}

// Resolves the host and refuses internal addresses, so an allowed name cannot point the server at itself.
export async function checkPublicUrl(raw, { allowHttp = false } = {}) {
  let u;
  try { u = new URL(raw); } catch { throw new Error("not a valid URL"); }
  if (u.protocol !== "https:" && !(allowHttp && u.protocol === "http:")) throw new Error("only https URLs are allowed");
  if (u.username || u.password) throw new Error("URLs with credentials are not allowed");
  if (privateNetAllowed()) return u;
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addrs = isIP(host) ? [{ address: host }] : await lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`${host} resolves to a private address`);
  return u;
}

export function domainAllowed(host, domains) {
  const h = host.toLowerCase();
  return domains.some((d) => h === d || h.endsWith("." + d));
}

async function boundedText(res) {
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    chunks.push(value);
    if (size >= FETCH_BYTES) { reader.cancel().catch(() => {}); break; }
  }
  return Buffer.concat(chunks).toString("utf8").slice(0, FETCH_BYTES);
}

// Redirects are followed by hand so each hop is checked against the allowlist and the private-address rule.
async function guardedGet(url, isAllowed, headers = {}) {
  let current = url;
  for (let hop = 0; hop < 4; hop++) {
    const u = await checkPublicUrl(current);
    if (!isAllowed(u)) throw new Error(`${u.hostname} is not an allowed domain for this agent`);
    const res = await fetchImpl(u.toString(), { redirect: "manual", headers: { "User-Agent": "Jr-Architect-Agent", ...headers }, signal: AbortSignal.timeout(15000) });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      current = new URL(res.headers.get("location"), u).toString();
      continue;
    }
    return { status: res.status, type: res.headers.get("content-type") || "", text: await boundedText(res) };
  }
  throw new Error("too many redirects");
}

function htmlToText(html) {
  return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/\s+/g, " ").trim();
}

const GH_HOSTS = new Set(["api.github.com", "raw.githubusercontent.com"]);

// Each tool re-checks its permission here; the prompt only describes them.
export const TOOL_IMPL = {
  async "repo.read"(args, def) {
    const repo = String(args.repo || "").trim().replace(/^https?:\/\/github\.com\//, "").replace(/\.git$/, "");
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error("repo must look like owner/name");
    const allowed = def.permissions.repos;
    if (!allowed.includes("*") && !allowed.some((r) => r.toLowerCase() === repo.toLowerCase())) throw new Error(`${repo} is not an allowed repository for this agent`);
    const path = String(args.path || "").replace(/^\/+/, "").replace(/\.\.+/g, "");
    const url = `https://api.github.com/repos/${repo}/contents/${path.split("/").map(encodeURIComponent).join("/")}`;
    const res = await guardedGet(url, (u) => GH_HOSTS.has(u.hostname), { Accept: "application/vnd.github+json" });
    if (res.status === 404) throw new Error(`${repo}/${path} was not found (private repositories are not readable)`);
    if (res.status !== 200) throw new Error(`GitHub answered ${res.status}`);
    const body = JSON.parse(res.text);
    if (Array.isArray(body)) return body.slice(0, 200).map((e) => `${e.type === "dir" ? "dir " : "file"} ${e.path}${e.type === "file" ? ` (${e.size} bytes)` : ""}`).join("\n");
    if (body.encoding === "base64" && body.content) return Buffer.from(body.content, "base64").toString("utf8");
    if (body.download_url) return (await guardedGet(body.download_url, (u) => GH_HOSTS.has(u.hostname))).text;
    throw new Error("that path is not a readable file");
  },
  async "web.fetch"(args, def) {
    const res = await guardedGet(String(args.url || ""), (u) => domainAllowed(u.hostname, def.permissions.domains));
    const text = /html/i.test(res.type) ? htmlToText(res.text) : res.text;
    return `HTTP ${res.status}\n${text}`;
  },
  async "memory.save"(args, def, ctx) {
    if (def.memory.mode !== "persistent" || !ctx.agentId) throw new Error("persistent memory is not enabled for this agent");
    const note = String(args.note || "").trim();
    if (!note) throw new Error("note is empty");
    if (GUARD_SECRET.test(note)) throw new Error("refused: the note looks like it contains a secret");
    appendMemory(ctx.user, ctx.agentId, note, def.memory.maxNotes);
    return "saved";
  },
};

// Literal terms only: a user-supplied regex could stall the whole service.
export function guardText(text, def) {
  const s = String(text || "");
  if (def.guardrails.blockSecrets && GUARD_SECRET.test(s)) return "contains what looks like a secret or API key";
  const low = s.toLowerCase();
  const term = def.guardrails.blockedTerms.find((t) => t && low.includes(t.toLowerCase()));
  return term ? `contains the blocked term "${term}"` : null;
}

// Function names must be plain identifiers for the providers, so repo.read is offered as repo_read.
export const fnName = (toolId) => toolId.replace(/\./g, "_");

function toGcSchema(schema) {
  const props = {};
  for (const [k, v] of Object.entries(schema.properties || {})) {
    props[k] = { type: v.type === "integer" ? "number" : v.type, description: [v.description, v.enum ? `one of ${JSON.stringify(v.enum)}` : ""].filter(Boolean).join(" ") };
  }
  return { properties: props, required: schema.required || [] };
}

function protocolPrompt(def, notes) {
  return [
    buildSystemPrompt(def),
    notes.length ? `## Memory from earlier runs\n${notes.map((n) => `- ${n.note}`).join("\n")}` : "",
    "## How to work",
    def.tools.length ? "Use the functions you were given when you need information; each result comes back to you." : "Work from the input and your instructions.",
    `The only functions that exist are: ${[...def.tools.map((t) => fnName(t.id)), "submit_answer"].join(", ")}.`,
    "When you are done, call submit_answer exactly once with your final result. Never invent tool results.",
  ].filter(Boolean).join("\n\n");
}

function transcriptText(run) {
  return run.transcript.map((t) => `### ${t.role}\n${t.content}`).join("\n\n");
}

function step(run, kind, detail, extra = {}) {
  run.steps.push({ at: Date.now(), kind, detail: String(detail).slice(0, 2000), ...extra });
}

// Checks the input before any model call, so a bad n8n payload fails fast and cheaply.
export function checkInput(def, input) {
  if (Buffer.byteLength(JSON.stringify(input ?? null)) > MAX_INPUT_BYTES) return ["input is larger than 32 KB"];
  const errs = validateAgainstSchema(input, def.inputSchema);
  const blocked = guardText(JSON.stringify(input), def);
  if (blocked) errs.push(`input ${blocked}`);
  return errs;
}

export function newRun(def, input, ctx) {
  return {
    id: newRunId(), agentId: ctx.agentId || null, agentVersion: def.version, source: ctx.source || "test",
    status: "running", startedAt: Date.now(), finishedAt: null, input, output: null, error: null,
    steps: [], pendingApproval: null, callbackUrl: ctx.callbackUrl || null, stepsUsed: 0,
    definition: ctx.agentId ? null : def, transcript: [{ role: "INPUT", content: JSON.stringify(input, null, 2) }],
  };
}

function persist(run, ctx) {
  if (ctx.agentId && ctx.user) saveRun(ctx.user, ctx.agentId, run);
}

function finish(run, status, fields, ctx) {
  Object.assign(run, { status, finishedAt: Date.now(), pendingApproval: null }, fields);
  step(run, status, status === "completed" ? "Run finished" : fields.error || status);
  persist(run, ctx);
  return run;
}

function pause(run, approval, ctx) {
  run.status = "awaiting_approval";
  run.pendingApproval = { ...approval, requestedAt: Date.now() };
  step(run, "approval", approval.summary);
  persist(run, ctx);
  return run;
}

// A model that answers in text instead of calling submit_answer still counts; an {"answer": ...} wrapper is unwrapped.
export function answerFromText(text, def) {
  const t = String(text || "").trim();
  if (!t) return undefined;
  if (def.runtime.outputFormat !== "json") return t;
  const obj = parseJsonLoose(t);
  if (obj && typeof obj === "object" && "answer" in obj && Object.keys(obj).length <= 2) return obj.answer;
  return obj || t;
}

function checkOutput(def, output) {
  if (def.runtime.outputFormat === "json") {
    let v = output;
    if (typeof v === "string") { const p = parseJsonLoose(v); if (p) v = p; }
    const errs = validateAgainstSchema(v, def.outputSchema);
    return { value: v, errs };
  }
  return { value: typeof output === "string" ? output : JSON.stringify(output, null, 2), errs: [] };
}

async function runTool(run, def, action, ctx) {
  let result;
  try {
    result = String(await TOOL_IMPL[action.tool](action.args, def, ctx)).slice(0, TOOL_RESULT_CHARS);
    const blocked = guardText(result, def);
    if (blocked) result = `[withheld by guardrail: the result ${blocked}]`;
    step(run, "tool_result", `${action.tool} returned ${result.length} chars`);
  } catch (e) {
    result = `ERROR: ${e.message}`;
    step(run, "tool_error", `${action.tool}: ${e.message}`);
  }
  run.transcript.push({ role: `TOOL ${action.tool} ${JSON.stringify(action.args).slice(0, 300)}`, content: result });
  return result;
}

// The functions offered for one segment. Every handler goes through the runtime, so the definition is enforced whatever the model asks.
function segmentTools(run, def, ctx, control, state) {
  const stop = () => { control.done = true; if (control.stop) control.stop(); };
  const tools = def.tools.map((t) => ({
    name: fnName(t.id),
    description: TOOL_CATALOG[t.id].description,
    inputSchema: { properties: Object.fromEntries(Object.entries(TOOL_CATALOG[t.id].args).map(([k, d]) => [k, { type: "string", description: d }])), required: [] },
    handler: async (args) => {
      if (control.done) return "The run has stopped. Do nothing else.";
      const action = { tool: t.id, args: args && typeof args === "object" ? args : {} };
      if (run.stepsUsed >= def.runtime.maxSteps) {
        step(run, "blocked", `Refused ${t.id}: the ${def.runtime.maxSteps}-step budget is used up`);
        return "No steps left. Call submit_answer now with what you have.";
      }
      run.stepsUsed++;
      step(run, "tool", `${t.id} ${JSON.stringify(action.args).slice(0, 300)}`);
      if (def.humanInTheLoop.approveTools.includes(t.id)) {
        state.pause = { type: "tool", tool: t.id, args: action.args, summary: `Approve ${t.id} ${JSON.stringify(action.args).slice(0, 160)}` };
        stop();
        return "This call is waiting for human approval. Stop now.";
      }
      return runTool(run, def, action, ctx);
    },
  }));
  const structured = def.runtime.outputFormat === "json" && def.outputSchema.type === "object";
  tools.push({
    name: "submit_answer",
    description: "Submit your final result. Call this exactly once, when you are done.",
    inputSchema: structured ? toGcSchema(def.outputSchema) : { properties: { answer: { type: "string", description: "Your final answer" } }, required: ["answer"] },
    handler: async (args) => {
      if (control.done) return "The run has stopped.";
      const { value, errs } = checkOutput(def, structured ? args : args && args.answer);
      if (errs.length && !state.repaired) {
        state.repaired = true;
        step(run, "repair", `Answer did not match the output schema: ${errs.slice(0, 3).join("; ")}`);
        return `Rejected: ${errs.join("; ")}. Call submit_answer again with the fields corrected.`;
      }
      state.answer = { value, errs };
      stop();
      return "Received. You are done.";
    },
  });
  return tools;
}

function settle(run, def, value, errs, ctx) {
  if (errs.length) return finish(run, "failed", { error: `output does not match the schema: ${errs.slice(0, 3).join("; ")}`, output: value }, ctx);
  const blocked = guardText(typeof value === "string" ? value : JSON.stringify(value), def);
  if (blocked) return finish(run, "blocked", { error: `guardrail: the output ${blocked}` }, ctx);
  if (def.humanInTheLoop.approveOutput) {
    run.output = value;
    return pause(run, { type: "output", output: value, summary: "Approve the agent's final output" }, ctx);
  }
  return finish(run, "completed", { output: value }, ctx);
}

// Runs (or resumes) one model conversation, then settles on an answer, a pause for a human, or a failure.
export async function drive(run, defIn, ctx) {
  const def = normalizeDefinition(defIn);
  const model = modelIdFor(def);
  if (!providerHasKey(def.model.provider)) return finish(run, "failed", { error: `no API key for ${def.model.provider}` }, ctx);
  const notes = def.memory.mode === "persistent" && ctx.agentId ? readMemory(ctx.user, ctx.agentId) : [];
  // One budget for the whole call, retries included, so n8n never waits past the configured timeout.
  const deadline = Date.now() + def.runtime.timeoutSeconds * 1000;

  for (let attempt = 0; ; attempt++) {
    // Rebuilt each attempt, so a retry resumes from the tool results already recorded instead of calling them again.
    const resume = run.transcript.length > 1 ? "\n\nContinue from here: use the results above instead of calling those functions again." : "";
    const prompt = `${protocolPrompt(def, notes)}\n\n## Conversation so far\n${transcriptText(run)}${resume}`;
    const control = { done: false, stop: null };
    const state = { repaired: false, answer: null, pause: null };
    step(run, "model", attempt ? `Retrying the model call (${attempt})` : "Thinking");
    rotateGroqKey(model);
    let timer;
    const timeout = new Promise((r) => { timer = setTimeout(() => r({ timeout: true }), Math.max(1000, deadline - Date.now())); });
    const res = await Promise.race([segment(prompt, model, def.model.maxOutputTokens, segmentTools(run, def, ctx, control, state), control), timeout]);
    clearTimeout(timer);
    if (res.timeout) {
      control.done = true;
      if (control.stop) control.stop();
      if (!state.answer && !state.pause) return finish(run, "failed", { error: `timed out after ${def.runtime.timeoutSeconds}s` }, ctx);
    }
    if (state.pause) return pause(run, state.pause, ctx);
    if (state.answer) return settle(run, def, state.answer.value, state.answer.errs, ctx);
    const text = res.text || "";
    const fromText = answerFromText(text, def);
    if (fromText !== undefined) {
      run.transcript.push({ role: "AGENT", content: text.slice(0, 4000) });
      const { value, errs } = checkOutput(def, fromText);
      return settle(run, def, value, errs, ctx);
    }
    const err = res.error || "the model returned nothing";
    if (res.error && dropRejectedKey(model, res.error)) { attempt--; continue; }
    if (attempt < AGENT_TOOLCALL_RETRIES && (RETRIABLE_TURN_ERROR.test(err) || !res.error)) continue;
    return finish(run, "failed", { error: friendlyModelError(err) }, ctx);
  }
}

// Validates and records the run without calling a model, so a caller can hand back its id before it finishes.
export function prepareRun(defIn, input, ctx) {
  const def = normalizeDefinition(defIn);
  const run = newRun(def, input, ctx);
  const v = validateDefinition(def);
  if (!v.ok) return finish(run, "failed", { error: `Finish the agent first: ${v.errors.map((e) => e.message).join(" ")}` }, ctx);
  const inputErrs = checkInput(def, input);
  if (inputErrs.length) return finish(run, "rejected", { error: `input rejected: ${inputErrs.join("; ")}` }, ctx);
  step(run, "start", `Running ${def.identity.name} v${def.version}`);
  persist(run, ctx);
  return run;
}

export async function startRun(defIn, input, ctx) {
  const run = prepareRun(defIn, input, ctx);
  return run.status === "running" ? drive(run, defIn, ctx) : run;
}

// A human decision resumes a paused run: an approved tool executes, an approved output completes.
export async function resolveApproval(run, defIn, decision, ctx) {
  const def = normalizeDefinition(defIn);
  const p = run.pendingApproval;
  if (run.status !== "awaiting_approval" || !p) throw Object.assign(new Error("this run is not waiting for approval"), { status: 409 });
  const note = String(decision.note || "").slice(0, 500);
  step(run, "decision", `${decision.approved ? "Approved" : "Rejected"}${note ? `: ${note}` : ""}`, { by: ctx.source || "user" });
  run.pendingApproval = null;
  run.status = "running";
  if (p.type === "output") {
    return decision.approved ? finish(run, "completed", { output: run.output }, ctx) : finish(run, "rejected", { error: `output rejected by a human${note ? `: ${note}` : ""}` }, ctx);
  }
  if (decision.approved) await runTool(run, def, { tool: p.tool, args: p.args }, ctx);
  else run.transcript.push({ role: "RUNTIME", content: `A human rejected the ${p.tool} call${note ? `: ${note}` : ""}. Do not retry it; continue without it.` });
  return drive(run, def, ctx);
}

// Tells n8n (a Wait node's resume URL) how a paused run ended.
export async function sendCallback(run) {
  if (!run.callbackUrl || ["running", "awaiting_approval"].includes(run.status)) return;
  try {
    const u = await checkPublicUrl(run.callbackUrl, { allowHttp: privateNetAllowed() });
    await fetchImpl(u.toString(), {
      method: "POST", headers: { "Content-Type": "application/json" }, redirect: "manual", signal: AbortSignal.timeout(10000),
      body: JSON.stringify(publicRun(run)),
    });
  } catch (e) {
    console.error(`[hub] callback for ${run.id} failed: ${e.message}`);
  }
}

// What leaves the server: no transcript, no copy of the definition.
export function publicRun(run) {
  const { transcript, definition, callbackUrl, ...rest } = run;
  return rest;
}
