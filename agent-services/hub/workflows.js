// Visual workflows: nodes wired on a canvas, run by this engine; agent nodes go through the same Hub runtime as any other run.
import * as fs from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { git, withLock, readJSON, writeJSON, userDir, readAgent, readRun as readAgentRun } from "./store.js";
import { slugify, bumpPatch } from "./definition.js";
import { hasDb, col, objectId, trimRuns, saveRunDoc, readRunDoc, listRunDocs } from "./db.js";
import { startRun, resolveApproval, checkPublicUrl, privateNetAllowed } from "./runtime.js";

export const MAX_WORKFLOWS_PER_USER = Number(process.env.JR_HUB_MAX_WORKFLOWS) || (process.env.JR_PUBLIC_ORIGIN ? 25 : 500);
const MAX_NODES = 40;
const MAX_EDGES = 80;
const MAX_EXECUTIONS = 50;
const RUN_DEADLINE_MS = 5 * 60 * 1000;
const MAX_RUNS_KEPT = 40;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const NODE_ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const RUN_RE = /^w-[a-f0-9]{16}$/;

// Every node type the canvas offers, with the output ports it can fire.
export const NODE_TYPES = {
  trigger: { label: "Trigger", outputs: ["main"], description: "Starts the workflow: by hand from the editor, or from a webhook call (for example from n8n)." },
  agent: { label: "Agent", outputs: ["main"], description: "Runs one of your Hub agents with its own tools, permissions and guardrails." },
  if: { label: "If", outputs: ["true", "false"], description: "Sends the item down the true or false branch." },
  set: { label: "Set fields", outputs: ["main"], description: "Builds a new JSON object from earlier results." },
  approval: { label: "Human approval", outputs: ["approved", "rejected"], description: "Pauses until a person approves or rejects." },
  http: { label: "HTTP request", outputs: ["main"], description: "Calls a public HTTPS URL, for example a Slack webhook." },
  output: { label: "Output", outputs: [], description: "The workflow's result, returned to whoever started it." },
};
export const IF_OPS = ["equals", "not_equals", "contains", "exists", "not_exists", "greater", "less", "is_true"];

const str = (v, max = 2000) => (typeof v === "string" ? v : v == null ? "" : String(v)).slice(0, max);
const num = (v, d) => (Number.isFinite(Number(v)) ? Math.round(Number(v)) : d);
const clampJSON = (v, maxBytes = 16 * 1024) => {
  try { return Buffer.byteLength(JSON.stringify(v ?? null)) <= maxBytes ? v : null; } catch { return null; }
};

function normalizeConfig(type, c = {}) {
  switch (type) {
    case "trigger": return { mode: c.mode === "webhook" ? "webhook" : "manual", sample: clampJSON(c.sample) ?? {} };
    case "agent": return { agentId: ID_RE.test(c.agentId || "") ? c.agentId : "", input: clampJSON(c.input) ?? "{{ $json }}" };
    case "if": return { path: str(c.path, 200), op: IF_OPS.includes(c.op) ? c.op : "equals", value: str(c.value, 500) };
    case "set": return { value: clampJSON(c.value) ?? {} };
    case "approval": return { message: str(c.message, 1000) || "Approve to continue" };
    case "http": return {
      method: c.method === "GET" ? "GET" : "POST", url: str(c.url, 1000),
      body: clampJSON(c.body) ?? "{{ $json }}", headers: clampJSON(c.headers) ?? {},
    };
    case "output": return { value: clampJSON(c.value) ?? "{{ $json }}" };
    default: return {};
  }
}

export function blankWorkflow(name = "New workflow") {
  return {
    apiVersion: 1, id: "", version: "0.1.0", name, description: "",
    nodes: [
      { id: "trigger", type: "trigger", name: "Start", position: { x: 80, y: 200 }, config: normalizeConfig("trigger", { sample: { task: "Describe the task" } }) },
      { id: "output", type: "output", name: "Result", position: { x: 520, y: 200 }, config: normalizeConfig("output") },
    ],
    edges: [{ from: "trigger", port: "main", to: "output" }],
  };
}

export function normalizeWorkflow(input) {
  const w = input && typeof input === "object" ? input : {};
  const nodes = [];
  const names = new Set();
  for (const n of (Array.isArray(w.nodes) ? w.nodes : []).slice(0, MAX_NODES)) {
    if (!n || !NODE_TYPES[n.type] || !NODE_ID_RE.test(n.id || "") || nodes.some((x) => x.id === n.id)) continue;
    let name = str(n.name, 60).trim() || NODE_TYPES[n.type].label;
    for (let i = 2; names.has(name); i++) name = `${str(n.name, 55).trim() || NODE_TYPES[n.type].label} ${i}`;
    names.add(name);
    nodes.push({
      id: n.id, type: n.type, name,
      position: { x: num(n.position && n.position.x, 0), y: num(n.position && n.position.y, 0) },
      config: normalizeConfig(n.type, n.config),
    });
  }
  const edges = [];
  for (const e of (Array.isArray(w.edges) ? w.edges : []).slice(0, MAX_EDGES)) {
    const from = nodes.find((n) => n.id === (e && e.from));
    const to = nodes.find((n) => n.id === (e && e.to));
    const port = str(e && e.port, 20) || "main";
    if (!from || !to || from.id === to.id || to.type === "trigger" || !NODE_TYPES[from.type].outputs.includes(port)) continue;
    if (edges.some((x) => x.from === from.id && x.port === port && x.to === to.id)) continue;
    edges.push({ from: from.id, port, to: to.id });
  }
  return {
    apiVersion: 1,
    id: ID_RE.test(w.id || "") ? w.id : "",
    version: /^\d+\.\d+\.\d+$/.test(w.version || "") ? w.version : "0.1.0",
    name: str(w.name, 80).trim() || "New workflow",
    description: str(w.description, 400),
    nodes, edges,
  };
}

export async function validateWorkflow(wIn, user) {
  const w = normalizeWorkflow(wIn);
  const errors = [];
  const warnings = [];
  const at = (node, message) => ({ node: node && node.id, message: node ? `${node.name}: ${message}` : message });
  const triggers = w.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) errors.push(at(null, "A workflow needs exactly one Trigger."));
  for (const n of w.nodes) {
    const c = n.config;
    if (n.type === "agent") {
      if (!c.agentId) errors.push(at(n, "choose an agent."));
      else if (user && !(await readAgent(user, c.agentId))) errors.push(at(n, `agent ${c.agentId} does not exist.`));
    }
    if (n.type === "if" && !c.path) errors.push(at(n, "set the field to test, for example $json.status."));
    if (n.type === "http") {
      if (!/^https:\/\//i.test(c.url) && !(privateNetAllowed() && /^http:\/\//i.test(c.url)) && !/^\{\{/.test(c.url)) errors.push(at(n, "the URL must start with https://."));
    }
    if (n.type !== "trigger" && !w.edges.some((e) => e.to === n.id)) warnings.push(at(n, "nothing is connected to its input, so it never runs."));
    if (NODE_TYPES[n.type].outputs.length && n.type !== "output" && !w.edges.some((e) => e.from === n.id)) {
      if (n.type !== "trigger" || w.nodes.length > 1) warnings.push(at(n, "its output goes nowhere."));
    }
  }
  if (!w.nodes.some((n) => n.type === "output")) warnings.push(at(null, "No Output node: callers get the last node's result."));
  if (hasCycle(w)) warnings.push(at(null, `The workflow has a loop; a run stops after ${MAX_EXECUTIONS} node executions.`));
  return { ok: errors.length === 0, errors, warnings };
}

function hasCycle(w) {
  const state = {};
  const visit = (id) => {
    if (state[id] === 1) return true;
    if (state[id] === 2) return false;
    state[id] = 1;
    for (const e of w.edges.filter((x) => x.from === id)) if (visit(e.to)) return true;
    state[id] = 2;
    return false;
  };
  return w.nodes.some((n) => visit(n.id));
}

// --- expressions: {{ $json.a.b }}, {{ $json.items[0] }}, {{ $node["Name"].json.x }}, {{ $now }}; paths only, never code ---

function readPath(root, path) {
  let cur = root;
  const re = /\.([A-Za-z_$][\w$-]*)|\[(\d+)\]|\[["']([^"'\]]+)["']\]/gy;
  let m;
  re.lastIndex = 0;
  while (re.lastIndex < path.length && (m = re.exec(path))) {
    const key = m[1] ?? (m[2] !== undefined ? Number(m[2]) : m[3]);
    if (cur == null || typeof cur !== "object" || !Object.prototype.hasOwnProperty.call(cur, key)) return undefined;
    cur = cur[key];
  }
  return re.lastIndex === path.length || path === "" ? cur : undefined;
}

export function evalExpr(expr, ctx) {
  const e = String(expr).trim();
  if (e === "$now") return new Date().toISOString();
  let m = /^\$(json|input)((?:\.[A-Za-z_$][\w$-]*|\[\d+\]|\[["'][^"'\]]+["']\])*)$/.exec(e);
  if (m) return readPath(ctx.json, m[2]);
  m = /^\$node\[["']([^"'\]]+)["']\]\.json((?:\.[A-Za-z_$][\w$-]*|\[\d+\]|\[["'][^"'\]]+["']\])*)$/.exec(e);
  if (m) return Object.prototype.hasOwnProperty.call(ctx.nodes, m[1]) ? readPath(ctx.nodes[m[1]], m[2]) : undefined;
  return undefined;
}

// A string that is exactly one expression keeps the value's type; mixed text is interpolated; objects are resolved deeply.
export function resolveTemplate(tpl, ctx, depth = 0) {
  if (depth > 8) return null;
  if (typeof tpl === "string") {
    const whole = /^\s*\{\{([^{}]+)\}\}\s*$/.exec(tpl);
    if (whole) return evalExpr(whole[1], ctx) ?? null;
    return tpl.replace(/\{\{([^{}]+)\}\}/g, (_, x) => {
      const v = evalExpr(x, ctx);
      return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(tpl)) return tpl.slice(0, 200).map((v) => resolveTemplate(v, ctx, depth + 1));
  if (tpl && typeof tpl === "object") return Object.fromEntries(Object.entries(tpl).slice(0, 100).map(([k, v]) => [k, resolveTemplate(v, ctx, depth + 1)]));
  return tpl;
}

// Agents return yes/no fields as booleans, while plans compare them with "yes" or "no".
const yesNo = (x) => (typeof x === "boolean" ? String(x) : /^(yes|no)$/i.test(String(x ?? "")) ? String(/^yes$/i.test(String(x))) : String(x ?? ""));

export function testCondition(cfg, ctx) {
  const path = cfg.path.trim();
  const expr = path.startsWith("{{") ? path.replace(/^\{\{|\}\}$/g, "") : path.startsWith("$") ? path : `$json.${path}`;
  const v = evalExpr(expr, ctx);
  const want = resolveTemplate(cfg.value, ctx);
  switch (cfg.op) {
    case "exists": return v !== undefined && v !== null && v !== "";
    case "not_exists": return v === undefined || v === null || v === "";
    case "is_true": return v === true || /^(true|yes)$/i.test(String(v ?? ""));
    case "contains": return Array.isArray(v) ? v.map(String).includes(String(want)) : String(v ?? "").toLowerCase().includes(String(want).toLowerCase());
    case "greater": return Number(v) > Number(want);
    case "less": return Number(v) < Number(want);
    case "not_equals": return yesNo(v) !== yesNo(want);
    default: return yesNo(v) === yesNo(want);
  }
}

// --- storage: MongoDB when configured, else one git repository per user holding <id>.json per workflow ---

const wfRoot = (user) => join(userDir(user), "workflows");
const wfState = (user, id) => join(userDir(user), "wfstate", id);

function assertId(id) {
  if (!ID_RE.test(String(id || ""))) throw Object.assign(new Error("invalid workflow id"), { status: 400 });
}

async function ensureRepo(user) {
  const root = wfRoot(user);
  if (fs.existsSync(join(root, ".git"))) return root;
  fs.mkdirSync(root, { recursive: true });
  await git(root, ["init", "-q", "-b", "main"]);
  return root;
}

function wfFromDoc(doc) {
  const n = normalizeWorkflow(doc.workflow);
  n.id = doc.slug;
  return n;
}

export async function readWorkflow(user, id) {
  assertId(id);
  if (hasDb()) {
    const doc = await col("workflows").findOne({ owner: user, slug: id });
    return doc ? wfFromDoc(doc) : null;
  }
  const w = readJSON(join(wfRoot(user), `${id}.json`), null);
  if (!w) return null;
  const n = normalizeWorkflow(w);
  n.id = id;
  return n;
}

export async function listWorkflows(user) {
  if (hasDb()) {
    const docs = await col("workflows").find({ owner: user }).sort({ updatedAt: -1 }).toArray();
    return docs.map((d) => ({ ...wfFromDoc(d), updatedAt: d.updatedAt.getTime() }));
  }
  let files = [];
  try { files = fs.readdirSync(wfRoot(user)).filter((f) => f.endsWith(".json")); } catch { return []; }
  const out = [];
  for (const f of files) {
    const id = f.slice(0, -5);
    if (!ID_RE.test(id)) continue;
    const w = await readWorkflow(user, id);
    if (w) out.push({ ...w, updatedAt: fs.statSync(join(wfRoot(user), f)).mtimeMs });
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function commit(user, id, w, message, isNew) {
  const msg = String(message).replace(/\s+/g, " ").slice(0, 100);
  if (hasDb()) {
    const now = new Date();
    if (isNew) await col("workflows").insertOne({ owner: user, slug: id, version: w.version, workflow: w, createdAt: now, updatedAt: now });
    else await col("workflows").updateOne({ owner: user, slug: id }, { $set: { version: w.version, workflow: w, updatedAt: now } });
    await col("workflow_versions").insertOne({ owner: user, slug: id, version: w.version, message: msg, workflow: w, createdAt: now });
    return;
  }
  const root = await ensureRepo(user);
  writeJSON(join(root, `${id}.json`), w);
  await git(root, ["add", "--", `${id}.json`]);
  await git(root, ["commit", "-q", "-m", `${id}: ${msg} (v${w.version})`, "--", `${id}.json`]);
}

async function slugTaken(user, id) {
  if (hasDb()) return !!(await col("workflows").findOne({ owner: user, slug: id }, { projection: { _id: 1 } }));
  return fs.existsSync(join(wfRoot(user), `${id}.json`));
}

export async function createWorkflow(user, input, message = "Create workflow") {
  const count = hasDb() ? await col("workflows").countDocuments({ owner: user }) : (await listWorkflows(user)).length;
  if (count >= MAX_WORKFLOWS_PER_USER) throw Object.assign(new Error(`You can keep up to ${MAX_WORKFLOWS_PER_USER} workflows; delete one first.`), { status: 409 });
  const w = normalizeWorkflow(input && input.nodes ? input : { ...blankWorkflow(), ...(input || {}), nodes: blankWorkflow().nodes, edges: blankWorkflow().edges });
  return withLock(wfRoot(user), async () => {
    let id = slugify(w.name);
    for (let i = 2; await slugTaken(user, id); i++) id = `${slugify(w.name).slice(0, 44)}-${i}`;
    w.id = id;
    w.version = "0.1.0";
    await commit(user, id, w, message, true);
    return w;
  });
}

export async function saveWorkflow(user, id, input, message = "Update workflow") {
  assertId(id);
  return withLock(wfRoot(user), async () => {
    const current = await readWorkflow(user, id);
    if (!current) throw Object.assign(new Error("workflow not found"), { status: 404 });
    const w = normalizeWorkflow(input);
    w.id = id;
    w.version = current.version;
    if (JSON.stringify(w) === JSON.stringify(current)) return { workflow: current, changed: false };
    w.version = bumpPatch(current.version);
    await commit(user, id, w, message, false);
    return { workflow: w, changed: true };
  });
}

export async function deleteWorkflow(user, id) {
  assertId(id);
  return withLock(wfRoot(user), async () => {
    if (hasDb()) {
      const { deletedCount } = await col("workflows").deleteOne({ owner: user, slug: id });
      if (!deletedCount) return false;
      await Promise.all([
        col("workflow_versions").deleteMany({ owner: user, slug: id }),
        col("runs").deleteMany({ owner: user, scope: "workflow", scopeId: id }),
        col("playground_threads").deleteMany({ owner: user, workflow: id }),
      ]);
      return true;
    }
    const f = join(wfRoot(user), `${id}.json`);
    if (!fs.existsSync(f)) return false;
    await git(wfRoot(user), ["rm", "-q", "--", `${id}.json`]);
    await git(wfRoot(user), ["commit", "-q", "-m", `${id}: delete`]);
    fs.rmSync(wfState(user, id), { recursive: true, force: true });
    return true;
  });
}

export async function listWorkflowVersions(user, id) {
  assertId(id);
  if (hasDb()) {
    const docs = await col("workflow_versions").find({ owner: user, slug: id }, { projection: { workflow: 0 } }).sort({ createdAt: -1 }).limit(50).toArray();
    return docs.map((d) => ({ sha: d._id.toHexString(), at: d.createdAt.getTime(), message: d.message, version: d.version }));
  }
  if (!fs.existsSync(join(wfRoot(user), ".git"))) return [];
  const out = await git(wfRoot(user), ["log", "-n", "50", "--format=%H%x09%at%x09%s", "--", `${id}.json`]);
  return out.trim().split("\n").filter(Boolean).map((l) => {
    const [sha, at, subject] = l.split("\t");
    const m = subject.match(/\(v(\d+\.\d+\.\d+)\)$/);
    return { sha, at: Number(at) * 1000, message: subject.replace(/^[^:]+:\s*/, "").replace(/\s*\(v[\d.]+\)$/, ""), version: m ? m[1] : "" };
  });
}

export async function restoreWorkflowVersion(user, id, sha) {
  assertId(id);
  if (!/^[a-f0-9]{7,40}$/.test(String(sha || ""))) throw Object.assign(new Error("invalid version"), { status: 400 });
  let old;
  if (hasDb()) {
    const _id = objectId(sha);
    const doc = _id && await col("workflow_versions").findOne({ _id, owner: user, slug: id });
    if (!doc) throw Object.assign(new Error("version not found"), { status: 404 });
    old = doc.workflow;
  } else {
    old = JSON.parse(await git(wfRoot(user), ["show", `${sha}:${id}.json`]));
  }
  return saveWorkflow(user, id, old, `Restore v${old.version}`);
}

export async function saveWorkflowRun(user, id, run) {
  if (hasDb()) {
    await saveRunDoc(user, "workflow", id, run);
    await trimRuns(user, "workflow", id, MAX_RUNS_KEPT);
    return;
  }
  const dir = join(wfState(user, id), "runs");
  writeJSON(join(dir, `${run.id}.json`), run);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return; }
  if (files.length > MAX_RUNS_KEPT) {
    files.map((f) => ({ f, t: fs.statSync(join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t)
      .slice(0, files.length - MAX_RUNS_KEPT).forEach(({ f }) => fs.rmSync(join(dir, f), { force: true }));
  }
}

export async function readWorkflowRun(user, id, runId) {
  assertId(id);
  if (!RUN_RE.test(String(runId || ""))) return null;
  if (hasDb()) return readRunDoc(user, "workflow", id, runId);
  return readJSON(join(wfState(user, id), "runs", `${runId}.json`), null);
}

export async function listWorkflowRuns(user, id, limit = 20) {
  assertId(id);
  if (hasDb()) return (await listRunDocs(user, "workflow", id, limit)).map(summaryRun);
  let files = [];
  try { files = fs.readdirSync(join(wfState(user, id), "runs")).filter((f) => f.endsWith(".json")); } catch { return []; }
  return files.map((f) => readJSON(join(wfState(user, id), "runs", f), null)).filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt).slice(0, limit).map(summaryRun);
}

export function summaryRun(r) {
  const { queue, ...rest } = r;
  return rest;
}

// --- engine ---

let httpFetch = (...a) => fetch(...a);
export function _setWorkflowFetchForTests(fn) { httpFetch = fn || ((...a) => fetch(...a)); }

async function callHttp(cfg, ctx) {
  const url = String(resolveTemplate(cfg.url, ctx) || "");
  const u = await checkPublicUrl(url, { allowHttp: privateNetAllowed() });
  const headers = { "User-Agent": "Jr-Architect-Workflow" };
  for (const [k, v] of Object.entries(resolveTemplate(cfg.headers, ctx) || {})) {
    if (/^[A-Za-z0-9-]{1,60}$/.test(k) && !/^(host|cookie|x-jr.*)$/i.test(k)) headers[k] = String(v).slice(0, 2000);
  }
  const init = { method: cfg.method, headers, redirect: "manual", signal: AbortSignal.timeout(20000) };
  if (cfg.method === "POST") {
    const body = resolveTemplate(cfg.body, ctx);
    init.body = typeof body === "string" ? body : JSON.stringify(body);
    headers["Content-Type"] = typeof body === "string" ? "text/plain" : "application/json";
  }
  const res = await httpFetch(u.toString(), init);
  const text = (await res.text()).slice(0, 50_000);
  let body = text;
  try { body = JSON.parse(text); } catch { /* not JSON */ }
  if (res.status >= 400) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
  return { status: res.status, body };
}

function newRun(w, input, source) {
  return {
    id: "w-" + randomBytes(8).toString("hex"), workflowId: w.id || null, workflowVersion: w.version, source,
    status: "running", startedAt: Date.now(), finishedAt: null, input, output: null, error: null,
    nodes: {}, byName: {}, queue: [], pending: null, executions: 0, log: [],
  };
}

function note(run, text) {
  run.log.push({ at: Date.now(), text: String(text).slice(0, 500) });
  if (run.log.length > 200) run.log.shift();
}

async function persist(run, ctx) {
  if (ctx.user && run.workflowId && ctx.persist !== false) await saveWorkflowRun(ctx.user, run.workflowId, run);
}

async function finishRun(run, status, fields, ctx) {
  Object.assign(run, { status, finishedAt: Date.now(), pending: null, queue: [] }, fields);
  note(run, status === "completed" ? "Workflow finished" : `Workflow ${status}: ${fields.error || ""}`);
  await persist(run, ctx);
  return run;
}

function enqueue(run, w, node, port, output) {
  for (const e of w.edges.filter((x) => x.from === node.id && x.port === port)) run.queue.push({ nodeId: e.to, input: output, from: node.name });
}

function nodeDone(run, w, node, port, output) {
  const rec = run.nodes[node.id];
  Object.assign(rec, { status: "success", finishedAt: Date.now(), port, output: clampJSON(output, 64 * 1024) ?? { note: "output too large to show" } });
  run.byName[node.name] = output;
  note(run, `${node.name} → ${port}`);
  if (node.type === "output") run.output = output;
  run.lastOutput = output;
  enqueue(run, w, node, port, output);
}

// Runs queued nodes until the queue empties, a node pauses for a human, or something fails.
export async function continueRun(run, wIn, ctx) {
  const w = normalizeWorkflow(wIn);
  const deadline = run.startedAt + RUN_DEADLINE_MS;
  while (run.queue.length) {
    if (Date.now() > deadline) return finishRun(run, "failed", { error: "the workflow ran longer than 5 minutes" }, ctx);
    if (++run.executions > MAX_EXECUTIONS) return finishRun(run, "failed", { error: `stopped after ${MAX_EXECUTIONS} node executions (is there a loop?)` }, ctx);
    const { nodeId, input } = run.queue.shift();
    const node = w.nodes.find((n) => n.id === nodeId);
    if (!node) continue;
    const exprCtx = { json: input, nodes: run.byName };
    run.nodes[node.id] = { status: "running", startedAt: Date.now(), input: clampJSON(input, 64 * 1024), runs: ((run.nodes[node.id] && run.nodes[node.id].runs) || 0) + 1 };
    await persist(run, ctx);
    try {
      const c = node.config;
      switch (node.type) {
        case "trigger": nodeDone(run, w, node, "main", input); break;
        case "set": nodeDone(run, w, node, "main", resolveTemplate(c.value, exprCtx)); break;
        case "output": nodeDone(run, w, node, "main", resolveTemplate(c.value, exprCtx)); break;
        case "if": nodeDone(run, w, node, testCondition(c, exprCtx) ? "true" : "false", input); break;
        case "http": {
          if (ctx.dryHttp) throw new Error("HTTP nodes are skipped in this run");
          nodeDone(run, w, node, "main", await callHttp(c, exprCtx));
          break;
        }
        case "approval": {
          const message = String(resolveTemplate(c.message, exprCtx) || "Approve to continue");
          run.nodes[node.id].status = "waiting";
          run.pending = { nodeId: node.id, kind: "approval", message, input };
          run.status = "awaiting_approval";
          note(run, `${node.name} is waiting for approval`);
          await persist(run, ctx);
          return run;
        }
        case "agent": {
          const def = await readAgent(ctx.user, c.agentId);
          if (!def) throw new Error(`agent ${c.agentId} does not exist`);
          if (ctx.spendLLM) ctx.spendLLM();
          const agentInput = resolveTemplate(c.input, exprCtx);
          note(run, `${node.name} runs agent ${def.identity.name} v${def.version}`);
          const ar = await startRun(def, agentInput, { user: ctx.user, agentId: def.id, source: "workflow" });
          run.nodes[node.id].agentRunId = ar.id;
          const r = await agentOutcome(run, w, node, ar, ctx);
          if (r) return r;
          break;
        }
        default: throw new Error(`unknown node type ${node.type}`);
      }
    } catch (e) {
      Object.assign(run.nodes[node.id], { status: "error", finishedAt: Date.now(), error: String(e.message || e).slice(0, 500) });
      return finishRun(run, "failed", { error: `${node.name}: ${e.message || e}`, failedNode: node.id }, ctx);
    }
  }
  if (run.output === null && run.lastOutput !== undefined) run.output = run.lastOutput;
  return finishRun(run, "completed", {}, ctx);
}

// Maps an agent run onto the node: completed continues, a pause pauses the workflow, anything else fails it.
async function agentOutcome(run, w, node, ar, ctx) {
  run.nodes[node.id].agentStatus = ar.status;
  run.nodes[node.id].agentSteps = (ar.steps || []).slice(-12);
  if (ar.status === "completed") { nodeDone(run, w, node, "main", ar.output); return null; }
  if (ar.status === "awaiting_approval") {
    run.nodes[node.id].status = "waiting";
    run.pending = { nodeId: node.id, kind: "agent", agentRunId: ar.id, message: ar.pendingApproval && ar.pendingApproval.summary, detail: ar.pendingApproval };
    run.status = "awaiting_approval";
    note(run, `${node.name} is waiting for approval inside the agent`);
    await persist(run, ctx);
    return run;
  }
  throw new Error(`agent run ${ar.status}: ${ar.error || "no output"}`);
}

export async function startWorkflowRun(wIn, input, ctx) {
  const w = normalizeWorkflow(wIn);
  const run = newRun(w, input, ctx.source || "editor");
  const v = await validateWorkflow(w, ctx.user);
  if (!v.ok) return finishRun(run, "failed", { error: v.errors.map((e) => e.message).join("; ") }, ctx);
  const trigger = w.nodes.find((n) => n.type === "trigger");
  run.queue.push({ nodeId: trigger.id, input: input ?? trigger.config.sample });
  note(run, "Workflow started");
  await persist(run, ctx);
  return continueRun(run, w, ctx);
}

export async function decideWorkflowRun(run, wIn, decision, ctx) {
  const w = normalizeWorkflow(wIn);
  const p = run.pending;
  if (run.status !== "awaiting_approval" || !p) throw Object.assign(new Error("this run is not waiting for approval"), { status: 409 });
  const node = w.nodes.find((n) => n.id === p.nodeId);
  if (!node) return finishRun(run, "failed", { error: "the paused node was removed from the workflow" }, ctx);
  const approved = !!decision.approved;
  const noteText = String(decision.note || "").slice(0, 500);
  note(run, `${node.name}: ${approved ? "approved" : "rejected"}${noteText ? ` (${noteText})` : ""}`);
  run.pending = null;
  run.status = "running";
  if (p.kind === "approval") {
    nodeDone(run, w, node, approved ? "approved" : "rejected", { ...(p.input && typeof p.input === "object" && !Array.isArray(p.input) ? p.input : { value: p.input }), approved, note: noteText });
    return continueRun(run, w, ctx);
  }
  const ar = await readAgentRun(ctx.user, node.config.agentId, p.agentRunId);
  const def = await readAgent(ctx.user, node.config.agentId);
  if (!ar || !def) return finishRun(run, "failed", { error: "the agent run or agent no longer exists" }, ctx);
  if (approved && ctx.spendLLM) ctx.spendLLM();
  const out = await resolveApproval(ar, def, { approved, note: noteText }, { user: ctx.user, agentId: def.id, source: "workflow" });
  try {
    const r = await agentOutcome(run, w, node, out, ctx);
    if (r) return r;
  } catch (e) {
    Object.assign(run.nodes[node.id], { status: "error", finishedAt: Date.now(), error: e.message });
    return finishRun(run, "failed", { error: `${node.name}: ${e.message}`, failedNode: node.id }, ctx);
  }
  return continueRun(run, w, ctx);
}

export function publicWorkflowRun(run) {
  const { queue, byName, lastOutput, ...rest } = run;
  return rest;
}
