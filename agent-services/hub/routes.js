// Agent Hub API under /agent/hub, plus the token-authenticated n8n endpoints Go forwards from /hooks/agents.
import express from "express";
import { PROVIDER_MODELS, providerHasKey } from "../llm.js";
import {
  normalizeDefinition, validateDefinition, buildSystemPrompt, renderGitagentFiles, definitionFromGitagent,
  diffDefinitions, TOOL_CATALOG, MEMORY_MODES, SECTIONS, defaultDefinition,
} from "./definition.js";
import * as store from "./store.js";
import { startRun, prepareRun, drive, resolveApproval, sendCallback, publicRun, checkPublicUrl, privateNetAllowed } from "./runtime.js";
import { draftAgent, refineAgent } from "./builder.js";

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

function connectInfo(def, token) {
  const base = `${publicBase()}/hooks/agents/${def.id}`;
  const body = { input: sampleFor(def.inputSchema) };
  return {
    runUrl: `${base}/run`,
    pollUrl: `${base}/runs/{runId}`,
    decisionUrl: `${base}/runs/{runId}/decision`,
    exampleBody: body,
    curl: `curl -X POST ${base}/run -H "Authorization: Bearer ${token || "$JR_AGENT_TOKEN"}" -H "Content-Type: application/json" -d '${JSON.stringify(body)}'`,
    workflow: n8nWorkflow(def, token),
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
  const mustAgent = (user, id) => {
    const def = store.readAgent(user, id);
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

  r.get("/meta", (req, res) => {
    userOf(req);
    res.json({
      tools: TOOL_CATALOG,
      providers: Object.keys(PROVIDER_MODELS).map((id) => ({ id, model: PROVIDER_MODELS[id], hasKey: providerHasKey(id) })),
      memoryModes: MEMORY_MODES, sections: SECTIONS, blank: defaultDefinition(), publicBase: publicBase(),
      maxAgents: store.MAX_AGENTS_PER_USER,
    });
  });

  r.get("/agents", (req, res) => {
    const user = userOf(req);
    res.json({ agents: store.listAgents(user).map((a) => ({ ...a, definition: summary(a.definition) })) });
  });

  r.post("/agents", async (req, res) => {
    const user = userOf(req);
    const def = await store.createAgent(user, req.body && req.body.definition, (req.body && req.body.message) || "Create agent");
    res.status(201).json({ definition: def, validation: validateDefinition(def) });
  });

  r.get("/agents/:id", (req, res) => {
    const user = userOf(req);
    const def = mustAgent(user, req.params.id);
    const n8n = store.listAgents(user).find((a) => a.definition.id === def.id)?.n8n || null;
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
    const src = mustAgent(user, req.params.id);
    const copy = { ...src, identity: { ...src.identity, name: `${src.identity.name} copy` } };
    res.status(201).json({ definition: await store.createAgent(user, copy, `Duplicate of ${src.id} v${src.version}`) });
  });

  r.get("/agents/:id/versions", async (req, res) => {
    const user = userOf(req);
    mustAgent(user, req.params.id);
    res.json({ versions: await store.listVersions(user, req.params.id) });
  });

  r.get("/agents/:id/versions/:sha", async (req, res) => {
    const user = userOf(req);
    const current = mustAgent(user, req.params.id);
    const old = await store.readVersion(user, req.params.id, req.params.sha);
    res.json({ definition: old, diffFromCurrent: diffDefinitions(current, old) });
  });

  r.post("/agents/:id/versions/:sha/restore", async (req, res) => {
    const user = userOf(req);
    mustAgent(user, req.params.id);
    res.json(await store.restoreVersion(user, req.params.id, req.params.sha));
  });

  r.get("/agents/:id/export", (req, res) => {
    const user = userOf(req);
    const def = mustAgent(user, req.params.id);
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

  r.post("/preview", (req, res) => {
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
    const def = agentId ? mustAgent(user, agentId) : normalizeDefinition(definition);
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
      def = mustAgent(user, agentId);
      run = store.readRun(user, agentId, req.params.runId);
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

  r.get("/agents/:id/runs", (req, res) => {
    const user = userOf(req);
    mustAgent(user, req.params.id);
    res.json({ runs: store.listRuns(user, req.params.id).map(publicRun) });
  });

  r.get("/agents/:id/runs/:runId", (req, res) => {
    const user = userOf(req);
    const run = store.readRun(user, req.params.id, req.params.runId);
    if (!run) throw new HttpError(404, "run not found");
    res.json({ run: publicRun(run) });
  });

  r.delete("/agents/:id/memory", (req, res) => {
    const user = userOf(req);
    mustAgent(user, req.params.id);
    store.clearMemory(user, req.params.id);
    res.json({ cleared: true });
  });

  r.get("/agents/:id/memory", (req, res) => {
    const user = userOf(req);
    mustAgent(user, req.params.id);
    res.json({ notes: store.readMemory(user, req.params.id) });
  });

  r.get("/agents/:id/connect", (req, res) => {
    const user = userOf(req);
    const def = mustAgent(user, req.params.id);
    const n8n = store.listAgents(user).find((a) => a.definition.id === def.id)?.n8n || null;
    res.json({ connected: !!n8n, key: n8n, ...connectInfo(def, "") });
  });

  // The token is shown once; only its hash is kept, so a lost token is replaced, not recovered.
  r.post("/agents/:id/connect", async (req, res) => {
    const user = userOf(req);
    const def = mustAgent(user, req.params.id);
    const token = await store.issueKey(user, def.id);
    res.json({ connected: true, token, ...connectInfo(def, token) });
  });

  r.delete("/agents/:id/connect", async (req, res) => {
    const user = userOf(req);
    mustAgent(user, req.params.id);
    res.json({ revoked: await store.revokeKey(user, req.params.id) });
  });

  // --- n8n: authenticated by the agent's token alone ---

  const hookAuth = (req) => {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get("authorization") || "");
    const who = m && store.resolveKey(m[1], req.params.id);
    if (!who) throw new HttpError(401, "invalid or revoked agent token");
    return who;
  };

  r.post("/hook/:id/run", async (req, res) => {
    const { user, id } = hookAuth(req);
    const def = mustAgent(user, id);
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
      const run = prepareRun(def, input, ctx);
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

  r.get("/hook/:id/runs/:runId", (req, res) => {
    const { user, id } = hookAuth(req);
    const run = store.readRun(user, id, req.params.runId);
    if (!run) throw new HttpError(404, "run not found");
    res.json(publicRun(run));
  });

  r.post("/hook/:id/runs/:runId/decision", async (req, res) => {
    const { user, id } = hookAuth(req);
    const def = mustAgent(user, id);
    const run = store.readRun(user, id, req.params.runId);
    if (!run) throw new HttpError(404, "run not found");
    const approved = !!(req.body && req.body.approved);
    if (approved) spendLLM(user);
    const out = await tracked(user, () => resolveApproval(run, def, { approved, note: req.body && req.body.note }, { user, agentId: id, source: "n8n" }));
    sendCallback(out);
    res.json(publicRun(out));
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
