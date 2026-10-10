// Agent Hub API under /agent/hub, plus the token-authenticated n8n endpoints Go forwards from /hooks/agents.
import express from "express";
import { PROVIDER_MODELS, providerHasKey, modelFor } from "../llm.js";
import {
  normalizeDefinition, validateDefinition, buildSystemPrompt, renderGitagentFiles, definitionFromGitagent,
  diffDefinitions, TOOL_CATALOG, MEMORY_MODES, SECTIONS, defaultDefinition,
} from "./definition.js";
import * as store from "./store.js";
import { startRun, prepareRun, drive, resolveApproval, sendCallback, publicRun, checkPublicUrl, privateNetAllowed } from "./runtime.js";
import { draftAgent, refineAgent, followUpQuestions } from "./builder.js";
import * as wf from "./workflows.js";
import { applyBlueprint } from "./blueprint.js";
import * as pg from "./playground.js";

const MAX_ACTIVE_RUNS_PER_USER = 2;
const DRAFT_RUN_TTL = 30 * 60 * 1000;
const HOOK_USER = "hook";

export function publicBase() {
  return (process.env.JR_PUBLIC_ORIGIN || `http://127.0.0.1:${process.env.HOST_PORT || 9000}`).replace(/\/$/, "");
}

// A plausible value for each field, so the n8n template and the test panel start with valid input.
export function sampleFor(schema) {
  if (schema.enum && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case "object": return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, sampleFor(v)]));
    case "array": return [sampleFor(schema.items || { type: "string" })];
    case "number": case "integer": return 1;
    case "boolean": return true;
    default: return schema.description ? `<${schema.description}>` : "example";
  }
}

export function n8nWorkflow(def, token) {
  const url = `${publicBase()}/hooks/agents/${def.id}/run`;
  return {
    name: `Jr-Architect: ${def.identity.name}`,
    nodes: [
      { parameters: {}, id: "trigger", name: "When clicking 'Test workflow'", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0] },
      {
        parameters: {
          method: "POST", url,
          sendHeaders: true,
          headerParameters: { parameters: [{ name: "Authorization", value: `Bearer ${token || "PASTE_YOUR_JR_AGENT_TOKEN"}` }] },
          sendBody: true, specifyBody: "json",
          jsonBody: JSON.stringify({ input: sampleFor(def.inputSchema) }, null, 2),
          options: { timeout: 130000 },
        },
        id: "agent", name: `Run ${def.identity.name}`, type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [240, 0],
      },
      {
        parameters: {
          conditions: { options: { caseSensitive: true, typeValidation: "loose" }, combinator: "and",
            conditions: [{ id: "c1", leftValue: "={{ $json.status }}", rightValue: "completed", operator: { type: "string", operation: "equals" } }] },
        },
        id: "done", name: "Completed?", type: "n8n-nodes-base.if", typeVersion: 2, position: [480, 0],
      },
    ],
    connections: {
      "When clicking 'Test workflow'": { main: [[{ node: `Run ${def.identity.name}`, type: "main", index: 0 }]] },
      [`Run ${def.identity.name}`]: { main: [[{ node: "Completed?", type: "main", index: 0 }]] },
    },
    pinData: {},
  };
}

// Copy-paste calls for the API tab; the token is filled in only right after it is issued.
export function snippets(runUrl, body, token, envVar) {
  const indent = (text, pad) => text.split("\n").join(`\n${pad}`);
  const jsAuth = token ? JSON.stringify(`Bearer ${token}`) : `\`Bearer \${process.env.${envVar}}\``;
  const pyAuth = token ? JSON.stringify(`Bearer ${token}`) : `f"Bearer {os.environ['${envVar}']}"`;
  const curl = `curl -X POST ${runUrl} -H "Authorization: Bearer ${token || `$${envVar}`}" -H "Content-Type: application/json" -d '${JSON.stringify(body).replace(/'/g, "'\\''")}'`;
  const javascript = [
    `const res = await fetch("${runUrl}", {`,
    `  method: "POST",`,
    `  headers: { Authorization: ${jsAuth}, "Content-Type": "application/json" },`,
    `  body: JSON.stringify(${indent(JSON.stringify(body, null, 2), "  ")}),`,
    `});`,
    `const run = await res.json(); // status: completed, awaiting_approval, failed, ...`,
    `console.log(run.status, run.output);`,
  ].join("\n");
  const python = [
    `import os, requests`,
    ``,
    `res = requests.post(`,
    `    "${runUrl}",`,
    `    headers={"Authorization": ${pyAuth}},`,
    `    json=${indent(pyLiteral(body), "    ")},`,
    `    timeout=140,`,
    `)`,
    `run = res.json()  # status: completed, awaiting_approval, failed, ...`,
    `print(run["status"], run.get("output"))`,
  ].join("\n");
  return { curl, javascript, python };
}

// JSON value as a Python literal: True/False/None, with strings kept exact.
function pyLiteral(v, pad = "") {
  if (v === null || v === undefined) return "None";
  if (v === true) return "True";
  if (v === false) return "False";
  if (typeof v !== "object") return JSON.stringify(v);
  const inner = `${pad}    `;
  if (Array.isArray(v)) return v.length ? `[\n${v.map((x) => inner + pyLiteral(x, inner)).join(",\n")},\n${pad}]` : "[]";
  const keys = Object.keys(v);
  return keys.length ? `{\n${keys.map((k) => `${inner}${JSON.stringify(k)}: ${pyLiteral(v[k], inner)}`).join(",\n")},\n${pad}}` : "{}";
}

function connectInfo(def, token) {
  const base = `${publicBase()}/hooks/agents/${def.id}`;
  const body = { input: sampleFor(def.inputSchema) };
  return {
    runUrl: `${base}/run`,
    pollUrl: `${base}/runs/{runId}`,
    decisionUrl: `${base}/runs/{runId}/decision`,
    exampleBody: body,
    ...snippets(`${base}/run`, body, token, "JR_AGENT_TOKEN"),
    workflow: n8nWorkflow(def, token),
    localOnly: !process.env.JR_PUBLIC_ORIGIN,
  };
}

function wfHookInfo(w, token) {
  const base = `${publicBase()}/hooks/workflows/${w.id}`;
  const trigger = w.nodes.find((n) => n.type === "trigger");
  const body = { input: trigger ? trigger.config.sample : {} };
  return {
    runUrl: `${base}/run`, pollUrl: `${base}/runs/{runId}`, decisionUrl: `${base}/runs/{runId}/decision`, exampleBody: body,
    ...snippets(`${base}/run`, body, token, "JR_WORKFLOW_TOKEN"),
    localOnly: !process.env.JR_PUBLIC_ORIGIN,
  };
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// Express 5 forwards rejected promises, so handlers just throw.
function fail(err, _req, res, _next) {
  const status = err.status || (err.type === "entity.too.large" ? 413 : 500);
  if (status >= 500) console.error("[hub]", err.message);
  res.status(status).json({ error: err.message || "internal error" });
}

export function createHubRouter({ allowLLM }) {
  const r = express.Router();
  const active = new Map();
  const draftRuns = new Map();

  const userOf = (req) => {
    const u = req.get("x-jr-user");
    if (!u || u === HOOK_USER || u === "internal") throw new HttpError(401, "login required");
    return u;
  };
  const spendLLM = (user) => {
    const lim = allowLLM(user);
    if (!lim.ok) throw new HttpError(429, `hourly AI limit reached, try again in ${lim.minutes} min`);
  };
  const mustAgent = async (user, id) => {
    const def = await store.readAgent(user, id);
    if (!def) throw new HttpError(404, "agent not found");
    return def;
  };
  // Bounds how many model loops one person can keep busy at once.
  async function tracked(user, fn) {
    const n = active.get(user) || 0;
    if (n >= MAX_ACTIVE_RUNS_PER_USER) throw new HttpError(429, "two runs are already in progress; wait for one to finish");
    active.set(user, n + 1);
    try { return await fn(); } finally { const m = (active.get(user) || 1) - 1; if (m) active.set(user, m); else active.delete(user); }
  }
  const sweepDrafts = () => { const now = Date.now(); for (const [k, v] of draftRuns) if (v.expires < now) draftRuns.delete(k); };
  const summary = (def) => ({ ...def, validation: validateDefinition(def) });

  r.get("/meta", async (req, res) => {
    userOf(req);
    res.json({
      tools: TOOL_CATALOG,
      providers: [{ id: "auto", model: modelFor(), hasKey: providerHasKey("auto") }, ...Object.keys(PROVIDER_MODELS).map((id) => ({ id, model: PROVIDER_MODELS[id], hasKey: providerHasKey(id) }))],
      memoryModes: MEMORY_MODES, sections: SECTIONS, blank: defaultDefinition(), publicBase: publicBase(),
      maxAgents: store.MAX_AGENTS_PER_USER,
    });
  });

  r.get("/agents", async (req, res) => {
    const user = userOf(req);
    res.json({ agents: (await store.listAgents(user)).map((a) => ({ ...a, definition: summary(a.definition) })) });
  });

  r.post("/agents", async (req, res) => {
    const user = userOf(req);
    const def = await store.createAgent(user, req.body && req.body.definition, (req.body && req.body.message) || "Create agent");
    res.status(201).json({ definition: def, validation: validateDefinition(def) });
  });

  r.get("/agents/:id", async (req, res) => {
    const user = userOf(req);
    const def = await mustAgent(user, req.params.id);
    const n8n = await store.keyInfo(user, def.id);
    res.json({ definition: def, validation: validateDefinition(def), prompt: buildSystemPrompt(def), files: renderGitagentFiles(def), n8n });
  });

  r.put("/agents/:id", async (req, res) => {
    const user = userOf(req);
    const out = await store.saveAgent(user, req.params.id, req.body && req.body.definition, (req.body && req.body.message) || "Update agent");
    res.json({ ...out, validation: validateDefinition(out.definition) });
  });

  r.delete("/agents/:id", async (req, res) => {
    const user = userOf(req);
    if (!(await store.deleteAgent(user, req.params.id))) throw new HttpError(404, "agent not found");
    res.json({ deleted: true });
  });

  r.post("/agents/:id/duplicate", async (req, res) => {
    const user = userOf(req);
    const src = await mustAgent(user, req.params.id);
    const copy = { ...src, identity: { ...src.identity, name: `${src.identity.name} copy` } };
    res.status(201).json({ definition: await store.createAgent(user, copy, `Duplicate of ${src.id} v${src.version}`) });
  });

  r.get("/agents/:id/versions", async (req, res) => {
    const user = userOf(req);
    await mustAgent(user, req.params.id);
    res.json({ versions: await store.listVersions(user, req.params.id) });
  });

  r.get("/agents/:id/versions/:sha", async (req, res) => {
    const user = userOf(req);
    const current = await mustAgent(user, req.params.id);
    const old = await store.readVersion(user, req.params.id, req.params.sha);
    res.json({ definition: old, diffFromCurrent: diffDefinitions(current, old) });
  });

  r.post("/agents/:id/versions/:sha/restore", async (req, res) => {
    const user = userOf(req);
    await mustAgent(user, req.params.id);
    res.json(await store.restoreVersion(user, req.params.id, req.params.sha));
  });

  r.get("/agents/:id/export", async (req, res) => {
    const user = userOf(req);
    const def = await mustAgent(user, req.params.id);
    res.setHeader("Content-Disposition", `attachment; filename="${def.id}.jr-agent.json"`);
    res.json(store.exportBundle(def));
  });

  r.post("/import", async (req, res) => {
    const user = userOf(req);
    const body = req.body || {};
    let def;
    if (body.repo) def = await importFromGitHub(String(body.repo));
    else def = store.definitionFromImport(body.bundle);
    res.status(201).json({ definition: await store.createAgent(user, def, "Import agent") });
  });

  r.post("/preview", async (req, res) => {
    userOf(req);
    const def = normalizeDefinition(req.body && req.body.definition);
    res.json({ definition: def, prompt: buildSystemPrompt(def), validation: validateDefinition(def), files: renderGitagentFiles(def) });
  });

  r.post("/builder", async (req, res) => {
    const user = userOf(req);
    const description = String((req.body && req.body.description) || "").trim();
    if (description.length < 15) throw new HttpError(400, "Describe what the agent should do in a sentence or two.");
    spendLLM(user);
    res.json(await tracked(user, () => draftAgent(description, req.body.provider)));
  });

  r.post("/builder/questions", async (req, res) => {
    const user = userOf(req);
    spendLLM(user);
    res.json(await tracked(user, () => followUpQuestions(req.body && req.body.answers, req.body && req.body.provider)));
  });

  r.post("/refine", async (req, res) => {
    const user = userOf(req);
    const feedback = String((req.body && req.body.feedback) || "").trim();
    if (!feedback) throw new HttpError(400, "Say what to change.");
    spendLLM(user);
    res.json(await tracked(user, () => refineAgent(req.body.definition, feedback, req.body.provider)));
  });

  // A saved agent's runs are recorded; a draft's live only in memory so it can still be approved.
  r.post("/test", async (req, res) => {
    const user = userOf(req);
    const { agentId, definition, input } = req.body || {};
    const def = agentId ? await mustAgent(user, agentId) : normalizeDefinition(definition);
    spendLLM(user);
    const ctx = { user, agentId: agentId ? def.id : null, source: "studio" };
    const run = await tracked(user, () => startRun(def, input, ctx));
    if (!agentId && run.status === "awaiting_approval") {
      sweepDrafts();
      draftRuns.set(run.id, { user, run, def, expires: Date.now() + DRAFT_RUN_TTL });
    }
    res.json({ run: publicRun(run) });
  });

  r.post("/runs/:runId/decision", async (req, res) => {
    const user = userOf(req);
    const { agentId, approved, note } = req.body || {};
    let run; let def; let ctx;
    if (agentId) {
      def = await mustAgent(user, agentId);
      run = await store.readRun(user, agentId, req.params.runId);
      ctx = { user, agentId, source: "studio" };
    } else {
      const d = draftRuns.get(req.params.runId);
      if (d && d.user === user) { run = d.run; def = d.def; ctx = { user, agentId: null, source: "studio" }; }
    }
    if (!run) throw new HttpError(404, "run not found");
    if (approved) spendLLM(user);
    const out = await tracked(user, () => resolveApproval(run, def, { approved: !!approved, note }, ctx));
    if (!agentId && out.status !== "awaiting_approval") draftRuns.delete(out.id);
    sendCallback(out);
    res.json({ run: publicRun(out) });
  });

  r.get("/agents/:id/runs", async (req, res) => {
    const user = userOf(req);
    await mustAgent(user, req.params.id);
    res.json({ runs: (await store.listRuns(user, req.params.id)).map(publicRun) });
  });

  r.get("/agents/:id/runs/:runId", async (req, res) => {
    const user = userOf(req);
    const run = await store.readRun(user, req.params.id, req.params.runId);
    if (!run) throw new HttpError(404, "run not found");
    res.json({ run: publicRun(run) });
  });

  r.delete("/agents/:id/memory", async (req, res) => {
    const user = userOf(req);
    await mustAgent(user, req.params.id);
    await store.clearMemory(user, req.params.id);
    res.json({ cleared: true });
  });

  r.get("/agents/:id/memory", async (req, res) => {
    const user = userOf(req);
    await mustAgent(user, req.params.id);
    res.json({ notes: await store.readMemory(user, req.params.id) });
  });

  r.get("/agents/:id/connect", async (req, res) => {
    const user = userOf(req);
    const def = await mustAgent(user, req.params.id);
    const n8n = await store.keyInfo(user, def.id);
    res.json({ connected: !!n8n, key: n8n, ...connectInfo(def, "") });
  });

  // The token is shown once; only its hash is kept, so a lost token is replaced, not recovered.
  r.post("/agents/:id/connect", async (req, res) => {
    const user = userOf(req);
    const def = await mustAgent(user, req.params.id);
    const token = await store.issueKey(user, def.id);
    res.json({ connected: true, token, ...connectInfo(def, token) });
  });

  r.delete("/agents/:id/connect", async (req, res) => {
    const user = userOf(req);
    await mustAgent(user, req.params.id);
    res.json({ revoked: await store.revokeKey(user, req.params.id) });
  });

  // --- n8n: authenticated by the agent's token alone ---

  const hookAuth = async (req) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "");
    const who = m && await store.resolveKey(m[1], req.params.id);
    if (!who) throw new HttpError(401, "invalid or revoked agent token");
    return who;
  };

  r.post("/hook/:id/run", async (req, res) => {
    const { user, id } = await hookAuth(req);
    const def = await mustAgent(user, id);
    const body = req.body || {};
    const input = body.input !== undefined ? body.input : body;
    let callbackUrl = null;
    if (body.callbackUrl) {
      await checkPublicUrl(String(body.callbackUrl), { allowHttp: privateNetAllowed() }).catch((e) => { throw new HttpError(400, `callbackUrl: ${e.message}`); });
      callbackUrl = String(body.callbackUrl);
    }
    spendLLM(user);
    const ctx = { user, agentId: id, source: "n8n", callbackUrl };
    if (body.wait === false) {
      const run = await prepareRun(def, input, ctx);
      if (run.status === "running") {
        tracked(user, () => drive(run, def, ctx)).then(sendCallback).catch((e) => console.error("[hub] background run failed:", e.message));
      }
      return res.status(202).json({ ...publicRun(run), pollUrl: `${publicBase()}/hooks/agents/${id}/runs/${run.id}` });
    }
    const run = await tracked(user, () => startRun(def, input, ctx));
    res.status(run.status === "awaiting_approval" ? 202 : 200).json({
      ...publicRun(run),
      pollUrl: `${publicBase()}/hooks/agents/${id}/runs/${run.id}`,
      decisionUrl: run.status === "awaiting_approval" ? `${publicBase()}/hooks/agents/${id}/runs/${run.id}/decision` : undefined,
    });
  });

  r.get("/hook/:id/runs/:runId", async (req, res) => {
    const { user, id } = await hookAuth(req);
    const run = await store.readRun(user, id, req.params.runId);
    if (!run) throw new HttpError(404, "run not found");
    res.json(publicRun(run));
  });

  r.post("/hook/:id/runs/:runId/decision", async (req, res) => {
    const { user, id } = await hookAuth(req);
    const def = await mustAgent(user, id);
    const run = await store.readRun(user, id, req.params.runId);
    if (!run) throw new HttpError(404, "run not found");
    const approved = !!(req.body && req.body.approved);
    if (approved) spendLLM(user);
    const out = await tracked(user, () => resolveApproval(run, def, { approved, note: req.body && req.body.note }, { user, agentId: id, source: "n8n" }));
    sendCallback(out);
    res.json(publicRun(out));
  });

  // --- visual workflows ---

  const mustWorkflow = async (user, id) => {
    const w = await wf.readWorkflow(user, id);
    if (!w) throw new HttpError(404, "workflow not found");
    return w;
  };
  const wfCtx = (user, source, extra = {}) => ({ user, source, spendLLM: () => spendLLM(user), ...extra });
  const wfSummary = async (user, w) => ({ ...w, validation: await wf.validateWorkflow(w, user), webhook: await store.keyInfo(user, w.id, "workflow") });

  r.get("/workflows/meta", async (req, res) => {
    userOf(req);
    res.json({ nodeTypes: wf.NODE_TYPES, ifOps: wf.IF_OPS, blank: wf.blankWorkflow(), publicBase: publicBase() });
  });

  r.get("/workflows", async (req, res) => {
    const user = userOf(req);
    res.json({ workflows: await Promise.all((await wf.listWorkflows(user)).map((w) => wfSummary(user, w))) });
  });

  r.post("/workflows", async (req, res) => {
    const user = userOf(req);
    const w = await wf.createWorkflow(user, req.body && req.body.workflow, (req.body && req.body.message) || "Create workflow");
    res.status(201).json({ workflow: await wfSummary(user, w) });
  });

  // Build mode: one call creates an app's agents, their workflows and a webhook token for each workflow.
  r.post("/blueprint", async (req, res) => {
    const user = userOf(req);
    res.status(201).json(await applyBlueprint(user, req.body));
  });

  r.post("/workflows/validate", async (req, res) => {
    const user = userOf(req);
    const w = wf.normalizeWorkflow(req.body && req.body.workflow);
    res.json({ workflow: w, validation: await wf.validateWorkflow(w, user) });
  });

  r.get("/workflows/:id", async (req, res) => {
    const user = userOf(req);
    res.json({ workflow: await wfSummary(user, await mustWorkflow(user, req.params.id)) });
  });

  r.put("/workflows/:id", async (req, res) => {
    const user = userOf(req);
    const out = await wf.saveWorkflow(user, req.params.id, req.body && req.body.workflow, (req.body && req.body.message) || "Update workflow");
    res.json({ changed: out.changed, workflow: await wfSummary(user, out.workflow) });
  });

  r.delete("/workflows/:id", async (req, res) => {
    const user = userOf(req);
    if (!(await wf.deleteWorkflow(user, req.params.id))) throw new HttpError(404, "workflow not found");
    await store.revokeKey(user, req.params.id, "workflow");
    res.json({ deleted: true });
  });

  r.post("/workflows/:id/duplicate", async (req, res) => {
    const user = userOf(req);
    const src = await mustWorkflow(user, req.params.id);
    res.status(201).json({ workflow: await wf.createWorkflow(user, { ...src, name: `${src.name} copy` }, `Duplicate of ${src.id}`) });
  });

  r.get("/workflows/:id/versions", async (req, res) => {
    const user = userOf(req);
    await mustWorkflow(user, req.params.id);
    res.json({ versions: await wf.listWorkflowVersions(user, req.params.id) });
  });

  r.post("/workflows/:id/versions/:sha/restore", async (req, res) => {
    const user = userOf(req);
    await mustWorkflow(user, req.params.id);
    const out = await wf.restoreWorkflowVersion(user, req.params.id, req.params.sha);
    res.json({ changed: out.changed, workflow: await wfSummary(user, out.workflow) });
  });

  // The editor runs what is on the canvas; a saved workflow's runs are kept, an unsaved draft's live in memory.
  r.post("/workflows/run", async (req, res) => {
    const user = userOf(req);
    const { workflowId, workflow, input } = req.body || {};
    const w = workflowId ? await mustWorkflow(user, workflowId) : wf.normalizeWorkflow(workflow);
    if (!workflowId) w.id = "";
    const run = await tracked(user, () => wf.startWorkflowRun(w, input, wfCtx(user, "editor")));
    if (!workflowId && run.status === "awaiting_approval") {
      sweepDrafts();
      draftRuns.set(run.id, { user, run, def: w, expires: Date.now() + DRAFT_RUN_TTL, workflow: true });
    }
    res.json({ run: wf.publicWorkflowRun(run) });
  });

  // The playground keeps a run's essentials with the chat, so the history reads back without the full run record.
  const runForChat = (run) => {
    const p = wf.publicWorkflowRun(run);
    return {
      id: p.id, status: p.status, input: p.input, output: p.output, error: p.error, startedAt: p.startedAt, finishedAt: p.finishedAt,
      log: (p.log || []).slice(-40), pending: p.pending ? { message: p.pending.message || (p.pending.detail && p.pending.detail.summary) || "" } : null,
    };
  };

  r.get("/workflows/:id/playground", async (req, res) => {
    const user = userOf(req);
    const w = await mustWorkflow(user, req.params.id);
    res.json({ info: await pg.describeWorkflow(user, w), messages: await pg.readThread(user, w.id) });
  });

  // A greeting gets the system's answer; anything else runs the saved workflow once.
  r.post("/workflows/:id/playground", async (req, res) => {
    const user = userOf(req);
    const w = await mustWorkflow(user, req.params.id);
    const text = String((req.body && req.body.text) || "").slice(0, 4000);
    const input = req.body && req.body.input && typeof req.body.input === "object" ? req.body.input : null;
    if (!text.trim() && !input) throw new HttpError(400, "type a message first");
    // Field values are defaults from the workflow's examples, so only the typed text decides whether this is a greeting.
    if (pg.isGreeting(text)) {
      const msgs = await pg.appendMessages(user, w.id, { role: "user", text }, { role: "system", text: pg.greetingReply(await pg.describeWorkflow(user, w)) });
      return res.json({ messages: msgs });
    }
    const [userMsg] = await pg.appendMessages(user, w.id, { role: "user", text, input });
    let reply;
    try {
      const run = await tracked(user, () => wf.startWorkflowRun(w, input || { message: text }, wfCtx(user, "playground")));
      reply = { role: "run", run: runForChat(run) };
    } catch (e) {
      reply = { role: "system", error: e.message || String(e) };
    }
    const [botMsg] = await pg.appendMessages(user, w.id, reply);
    res.json({ messages: [userMsg, botMsg] });
  });

  r.post("/workflows/:id/playground/decision", async (req, res) => {
    const user = userOf(req);
    const w = await mustWorkflow(user, req.params.id);
    const { messageId, approved, note } = req.body || {};
    const msg = (await pg.readThread(user, w.id)).find((m) => m.id === messageId && m.role === "run");
    const run = msg && await wf.readWorkflowRun(user, w.id, msg.run.id);
    if (!run) throw new HttpError(404, "that run is no longer available");
    const out = await tracked(user, () => wf.decideWorkflowRun(run, w, { approved: !!approved, note }, wfCtx(user, "playground")));
    wfCallback(out);
    await pg.updateMessage(user, w.id, messageId, { decided: approved ? "approved" : "rejected" });
    const [botMsg] = await pg.appendMessages(user, w.id, { role: "run", run: runForChat(out) });
    res.json({ decided: messageId, message: botMsg });
  });

  r.delete("/workflows/:id/playground", async (req, res) => {
    const user = userOf(req);
    const w = await mustWorkflow(user, req.params.id);
    await pg.clearThread(user, w.id);
    res.json({ ok: true });
  });

  r.post("/workflows/runs/:runId/decision", async (req, res) => {
    const user = userOf(req);
    const { workflowId, approved, note } = req.body || {};
    let run; let w;
    if (workflowId) {
      w = await mustWorkflow(user, workflowId);
      run = await wf.readWorkflowRun(user, workflowId, req.params.runId);
    } else {
      const d = draftRuns.get(req.params.runId);
      if (d && d.user === user && d.workflow) { run = d.run; w = d.def; }
    }
    if (!run) throw new HttpError(404, "run not found");
    const out = await tracked(user, () => wf.decideWorkflowRun(run, w, { approved, note }, wfCtx(user, "editor")));
    if (!workflowId && out.status !== "awaiting_approval") draftRuns.delete(out.id);
    wfCallback(out);
    res.json({ run: wf.publicWorkflowRun(out) });
  });

  r.get("/workflows/:id/runs", async (req, res) => {
    const user = userOf(req);
    await mustWorkflow(user, req.params.id);
    res.json({ runs: (await wf.listWorkflowRuns(user, req.params.id)).map(wf.publicWorkflowRun) });
  });

  r.get("/workflows/:id/runs/:runId", async (req, res) => {
    const user = userOf(req);
    const run = await wf.readWorkflowRun(user, req.params.id, req.params.runId);
    if (!run) throw new HttpError(404, "run not found");
    res.json({ run: wf.publicWorkflowRun(run) });
  });

  r.post("/workflows/:id/connect", async (req, res) => {
    const user = userOf(req);
    const w = await mustWorkflow(user, req.params.id);
    const token = await store.issueKey(user, w.id, "workflow");
    res.json({ token, key: await store.keyInfo(user, w.id, "workflow"), ...wfHookInfo(w, token) });
  });

  r.get("/workflows/:id/connect", async (req, res) => {
    const user = userOf(req);
    const w = await mustWorkflow(user, req.params.id);
    res.json({ key: await store.keyInfo(user, w.id, "workflow"), ...wfHookInfo(w, "") });
  });

  r.delete("/workflows/:id/connect", async (req, res) => {
    const user = userOf(req);
    await mustWorkflow(user, req.params.id);
    res.json({ revoked: await store.revokeKey(user, req.params.id, "workflow") });
  });

  const wfCallback = async (run) => {
    if (!run.callbackUrl || ["running", "awaiting_approval"].includes(run.status)) return;
    try {
      const u = await checkPublicUrl(run.callbackUrl, { allowHttp: privateNetAllowed() });
      await fetch(u.toString(), { method: "POST", headers: { "Content-Type": "application/json" }, redirect: "manual", signal: AbortSignal.timeout(10000), body: JSON.stringify(wf.publicWorkflowRun(run)) });
    } catch (e) { console.error(`[hub] workflow callback for ${run.id} failed: ${e.message}`); }
  };

  const wfHookAuth = async (req) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "");
    const who = m && await store.resolveKey(m[1], req.params.id, "workflow");
    if (!who) throw new HttpError(401, "invalid or revoked workflow token");
    return who;
  };

  r.post("/hook-wf/:id/run", async (req, res) => {
    const { user, id } = await wfHookAuth(req);
    const w = await mustWorkflow(user, id);
    const body = req.body || {};
    const input = body.input !== undefined ? body.input : body;
    if (body.callbackUrl) await checkPublicUrl(String(body.callbackUrl), { allowHttp: privateNetAllowed() }).catch((e) => { throw new HttpError(400, `callbackUrl: ${e.message}`); });
    const run = await tracked(user, () => wf.startWorkflowRun(w, input, wfCtx(user, "webhook")));
    if (body.callbackUrl && run.status === "awaiting_approval") { run.callbackUrl = String(body.callbackUrl); await wf.saveWorkflowRun(user, id, run); }
    res.status(run.status === "awaiting_approval" ? 202 : 200).json({ ...wf.publicWorkflowRun(run), pollUrl: `${publicBase()}/hooks/workflows/${id}/runs/${run.id}` });
  });

  r.get("/hook-wf/:id/runs/:runId", async (req, res) => {
    const { user, id } = await wfHookAuth(req);
    const run = await wf.readWorkflowRun(user, id, req.params.runId);
    if (!run) throw new HttpError(404, "run not found");
    res.json(wf.publicWorkflowRun(run));
  });

  r.post("/hook-wf/:id/runs/:runId/decision", async (req, res) => {
    const { user, id } = await wfHookAuth(req);
    const w = await mustWorkflow(user, id);
    const run = await wf.readWorkflowRun(user, id, req.params.runId);
    if (!run) throw new HttpError(404, "run not found");
    const out = await tracked(user, () => wf.decideWorkflowRun(run, w, { approved: !!(req.body && req.body.approved), note: req.body && req.body.note }, wfCtx(user, "webhook")));
    wfCallback(out);
    res.json(wf.publicWorkflowRun(out));
  });

  r.use(fail);
  return r;
}

// Reads a gitagent from GitHub over raw.githubusercontent.com: owner/repo, a github.com URL, or one with /tree/<branch>/<path>.
export async function importFromGitHub(ref) {
  const m = /^(?:https?:\/\/github\.com\/)?([\w.-]+)\/([\w.-]+?)(?:\.git)?(?:\/tree\/([\w.\-/]+?))?\/?$/.exec(ref.trim());
  if (!m) throw new HttpError(400, "use owner/repo or a github.com URL");
  const [, owner, repo, tree] = m;
  const [branchGuess, ...rest] = (tree || "").split("/");
  const branches = tree ? [branchGuess] : ["main", "master"];
  const sub = rest.join("/");
  for (const branch of branches) {
    const base = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${sub ? sub + "/" : ""}`;
    const get = async (f) => {
      const res = await fetch(base + f, { signal: AbortSignal.timeout(10000) }).catch(() => null);
      return res && res.ok ? (await res.text()).slice(0, 200_000) : null;
    };
    const manifest = await get("agent.yaml");
    if (!manifest) continue;
    const [soul, rules] = await Promise.all([get("SOUL.md"), get("RULES.md")]);
    try {
      return definitionFromGitagent({ "agent.yaml": manifest, "SOUL.md": soul || "", "RULES.md": rules || "" });
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }
  throw new HttpError(404, "no agent.yaml found there (checked main and master)");
}
