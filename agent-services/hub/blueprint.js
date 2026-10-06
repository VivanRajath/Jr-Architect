// Build mode's plan for an app's AI: turns a list of agents and workflows into real Hub agents, wired workflows and webhook tokens.
import { defaultDefinition } from "./definition.js";
import * as store from "./store.js";
import * as wf from "./workflows.js";

export const MAX_BLUEPRINT_AGENTS = 8;
export const MAX_BLUEPRINT_WORKFLOWS = 6;
const MAX_CHAIN = 4;
const MAX_BRANCH_CHAIN = 3;
const KEY_RE = /^[a-z][a-z0-9_]{0,30}$/;

const str = (v, max) => String(v ?? "").trim().slice(0, max);

export const FIELD_TYPES = ["string", "list", "number", "boolean"];

// A field is "list" when the plan says so ({type: "list"}) or its description reads like one ("Array of strings", "list of steps").
function inferType(explicit, desc) {
  const t = String(explicit || "").toLowerCase();
  if (/list|array|\[\]/.test(t)) return "list";
  if (/number|integer|float|int\b/.test(t)) return "number";
  if (/bool|yes\/no/.test(t)) return "boolean";
  if (t) return "string";
  return /\b(array|list)\s+of\b|^\s*(array|list)\b|\[\]/i.test(desc) ? "list" : "string";
}

// {field: description} or {field: {type, description}} from the plan; at most eight fields, each with a usable name.
function fieldsOf(raw, fallback) {
  const fields = {};
  const types = {};
  for (const [k, v] of Object.entries(raw && typeof raw === "object" ? raw : {}).slice(0, 8)) {
    const name = String(k).trim().replace(/[^A-Za-z0-9_]/g, "_").replace(/^(\d)/, "_$1").slice(0, 40);
    if (!name) continue;
    const desc = v && typeof v === "object" ? str(v.description, 200) : str(v, 200);
    fields[name] = desc;
    types[name] = inferType(v && typeof v === "object" ? v.type : "", desc);
  }
  if (Object.keys(fields).length) return { fields, types };
  return { fields: fallback, types: Object.fromEntries(Object.keys(fallback).map((k) => [k, "string"])) };
}

function fieldSchema(type, description) {
  const base = type === "list" ? { type: "array", items: { type: "string" } } : { type: type === "number" || type === "boolean" ? type : "string" };
  return description ? { ...base, description } : base;
}

function schemaOf(fields, types = {}) {
  return {
    type: "object",
    properties: Object.fromEntries(Object.entries(fields).map(([k, d]) => [k, fieldSchema(types[k], d)])),
    required: Object.keys(fields),
  };
}

export function normalizeBlueprint(input) {
  const b = input && typeof input === "object" ? input : {};
  const app = str(b.app, 60) || "App";
  const agents = [];
  for (const a of (Array.isArray(b.agents) ? b.agents : []).slice(0, MAX_BLUEPRINT_AGENTS)) {
    const key = str(a && a.key, 31).toLowerCase();
    if (!KEY_RE.test(key) || agents.some((x) => x.key === key)) continue;
    agents.push({
      key,
      name: str(a.name, 60) || key,
      purpose: str(a.purpose, 500),
      instructions: str(a.instructions, 2000),
      rules: (Array.isArray(a.rules) ? a.rules : []).map((r) => str(r, 200)).filter(Boolean).slice(0, 6),
      ...(() => {
        const inp = fieldsOf(a.input, { text: "The text to work on" });
        const out = fieldsOf(a.output, { result: "The answer" });
        return { input: inp.fields, output: out.fields, outputTypes: out.types };
      })(),
    });
  }
  const workflows = [];
  for (const w of (Array.isArray(b.workflows) ? b.workflows : []).slice(0, MAX_BLUEPRINT_WORKFLOWS)) {
    const key = str(w && w.key, 31).toLowerCase();
    const steps = agentKeys(w && w.agents, agents, [], MAX_CHAIN);
    if (!KEY_RE.test(key) || !steps.length || workflows.some((x) => x.key === key)) continue;
    const branch = branchOf(w.branch, agents, steps);
    workflows.push({ key, name: str(w.name, 60) || key, description: str(w.description, 300), agents: steps, approval: !!w.approval, ...(branch ? { branch } : {}) });
  }
  return { app, agents, workflows };
}

// Known agent keys in order, each at most once per path, and none already used earlier on it.
function agentKeys(list, agents, taken, max) {
  const out = [];
  for (const k of Array.isArray(list) ? list : []) {
    const key = str(k, 31).toLowerCase();
    if (agents.some((a) => a.key === key) && !out.includes(key) && !taken.includes(key)) out.push(key);
  }
  return out.slice(0, max);
}

// After the main chain, an If node tests one field an agent produced and sends the item down the "then" or "else" agents.
function branchOf(raw, agents, steps) {
  if (!raw || typeof raw !== "object") return null;
  const field = str(raw.field, 40);
  const producer = [...steps].reverse().find((k) => field in agents.find((a) => a.key === k).output);
  if (!producer) return null;
  const then = agentKeys(raw.then, agents, steps, MAX_BRANCH_CHAIN);
  const otherwise = agentKeys(raw.else, agents, [...steps, ...then], MAX_BRANCH_CHAIN);
  if (!then.length && !otherwise.length) return null;
  const value = str(raw.value, 100);
  const op = wf.IF_OPS.includes(raw.op) ? raw.op : value ? "equals" : "is_true";
  return { field, producer, op, value, then, else: otherwise, label: str(raw.label, 60) };
}

// Every path the item can take through the workflow, as agent keys in order.
export function pathsOf(spec) {
  if (!spec.branch) return [spec.agents];
  return [[...spec.agents, ...spec.branch.then], [...spec.agents, ...spec.branch.else]];
}

// The workflow asks for every field an agent needs that no earlier agent produces.
function workflowInputs(steps) {
  const inputs = { ...steps[0].input };
  const produced = new Set(Object.keys(steps[0].output));
  for (const a of steps.slice(1)) {
    for (const [k, d] of Object.entries(a.input)) if (!produced.has(k) && !(k in inputs)) inputs[k] = d;
    for (const k of Object.keys(a.output)) produced.add(k);
  }
  return inputs;
}

// A field comes from the agent just before, else the latest earlier agent that produced it, else the workflow's input.
function inputTemplate(steps, i) {
  return Object.fromEntries(Object.keys(steps[i].input).map((k) => {
    if (i === 0 || k in steps[i - 1].output) return [k, `{{ $json.${k} }}`];
    for (let j = i - 2; j >= 0; j--) if (k in steps[j].output) return [k, `{{ $node["${steps[j].name}"].json.${k} }}`];
    return [k, `{{ $node["Start"].json.${k} }}`];
  }));
}

// What the app gets back: every field any agent on the path produced, the latest producer winning.
function outputOf(steps) {
  const output = {};
  const types = {};
  const value = {};
  for (const a of steps) {
    for (const k of Object.keys(a.output)) {
      output[k] = a.output[k];
      types[k] = a.outputTypes[k];
      value[k] = `{{ $node["${a.name}"].json.${k} }}`;
    }
  }
  return { output, types, value };
}

function mergedInputs(spec, byKey) {
  return Object.assign({}, ...pathsOf(spec).map((p) => workflowInputs(p.map((k) => byKey[k]))));
}

function mergedOutputs(spec, byKey) {
  const output = {};
  const types = {};
  for (const p of pathsOf(spec)) {
    const o = outputOf(p.map((k) => byKey[k]));
    Object.assign(output, o.output);
    Object.assign(types, o.types);
  }
  return { output, types };
}

function workflowFor(spec, agentsByKey, ids) {
  const main = spec.agents.map((k) => agentsByKey[k]);
  const nodes = [{ id: "trigger", type: "trigger", name: "Start", position: { x: 80, y: 200 }, config: { mode: "webhook", sample: Object.fromEntries(Object.keys(mergedInputs(spec, agentsByKey)).map((k) => [k, `Example ${k}`])) } }];
  const edges = [];
  // Lays agents out left to right on one row, fed from `from` on `port`; returns the last node's id.
  const chain = (steps, offset, row, from, port, prefix) => {
    let prev = from;
    let p = port;
    steps.slice(offset).forEach((a, j) => {
      const i = offset + j;
      const id = `${prefix}${j + 1}`;
      nodes.push({ id, type: "agent", name: a.name, position: { x: 80 + (i + 1 + (prefix === "agent-" ? 0 : 1)) * 280, y: row }, config: { agentId: ids[a.key], input: inputTemplate(steps, i) } });
      edges.push({ from: prev, port: p, to: id });
      prev = id;
      p = "main";
    });
    return { last: prev, port: p };
  };
  let end = chain(main, 0, 200, "trigger", "main", "agent-");
  if (spec.approval) {
    nodes.push({ id: "approval", type: "approval", name: "Approve", position: { x: 80 + (main.length + 1) * 280, y: 200 }, config: { message: `Approve the result of ${spec.name}` } });
    edges.push({ from: end.last, port: end.port, to: "approval" });
    end = { last: "approval", port: "approved" };
  }
  const finish = (steps, from, port, id, row) => {
    nodes.push({ id, type: "output", name: id === "output" ? "Result" : `Result (${id === "output-then" ? "yes" : "no"})`, position: { x: 80 + (steps.length + 2) * 280, y: row }, config: { value: outputOf(steps).value } });
    edges.push({ from, port, to: id });
  };
  if (!spec.branch) {
    finish(main, end.last, end.port, "output", 200);
    return { name: spec.name, description: spec.description, nodes, edges };
  }
  const b = spec.branch;
  const producer = agentsByKey[b.producer];
  const ifX = 80 + (main.length + (spec.approval ? 2 : 1)) * 280;
  nodes.push({ id: "branch", type: "if", name: b.label || `Check ${b.field}`, position: { x: ifX, y: 200 }, config: { path: `$node["${producer.name}"].json.${b.field}`, op: b.op, value: b.value } });
  edges.push({ from: end.last, port: end.port, to: "branch" });
  for (const [side, keys, row] of [["then", b.then, 60], ["else", b.else, 340]]) {
    const steps = [...main, ...keys.map((k) => agentsByKey[k])];
    const tail = chain(steps, main.length, row, "branch", side === "then" ? "true" : "false", `${side}-`);
    finish(steps, tail.last, tail.port, `output-${side}`, row);
  }
  return { name: spec.name, description: spec.description, nodes, edges };
}

// Creates everything for one app. A failure part-way leaves what was already created in the Hub, where it can be edited or deleted.
export async function applyBlueprint(user, input) {
  const plan = normalizeBlueprint(input);
  if (!plan.workflows.length) throw Object.assign(new Error("the plan has no workflow that uses one of its agents"), { status: 400 });
  const provider = "auto";
  const used = new Set(plan.workflows.flatMap((w) => pathsOf(w).flat()));
  // An input fed by an earlier agent's output takes that output's type (yes/no, number or list), so the values pass straight through.
  const producedTypes = {};
  for (const a of plan.agents) for (const [k, t] of Object.entries(a.outputTypes)) if (t !== "string" || !producedTypes[k]) producedTypes[k] = t;
  const ids = {};
  const agents = [];
  for (const a of plan.agents.filter((x) => used.has(x.key))) {
    const d = defaultDefinition(a.name);
    d.identity.description = a.purpose;
    d.identity.tags = ["build-mode", plan.app.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 30)].filter(Boolean);
    d.purpose = a.purpose;
    d.instructions = a.instructions;
    d.guardrails.rules = a.rules;
    d.model.provider = provider === "google" ? "gemini" : provider;
    d.inputSchema = schemaOf(a.input, Object.fromEntries(Object.keys(a.input).map((k) => [k, producedTypes[k] || "string"])));
    d.outputSchema = schemaOf(a.output, a.outputTypes);
    const created = await store.createAgent(user, d, `Created by Build mode for ${plan.app}`);
    ids[a.key] = created.id;
    agents.push({ key: a.key, id: created.id, name: created.identity.name });
  }
  const byKey = Object.fromEntries(plan.agents.map((a) => [a.key, a]));
  const workflows = [];
  for (const spec of plan.workflows) {
    const created = await wf.createWorkflow(user, workflowFor(spec, byKey, ids), `Created by Build mode for ${plan.app}`);
    const token = await store.issueKey(user, created.id, "workflow");
    const out = mergedOutputs(spec, byKey);
    workflows.push({
      key: spec.key, id: created.id, name: created.name, description: spec.description, token, approval: spec.approval,
      input: mergedInputs(spec, byKey), output: out.output, outputTypes: out.types,
    });
  }
  return { app: plan.app, agents, workflows };
}
