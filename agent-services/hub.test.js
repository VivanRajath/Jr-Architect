// Agent Hub: definition, git-backed store, runtime enforcement and the HTTP surface. Run: `node --test`.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_NO_LISTEN = "1";
process.env.JR_HUB_DIR = mkdtempSync(join(tmpdir(), "jr-hub-test-"));
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "gsk_test_placeholder_not_real";
process.env.GITAGENT_REGISTRY_INDEX = "http://127.0.0.1:1/index.json";

const def = await import("./hub/definition.js");
const store = await import("./hub/store.js");
const rt = await import("./hub/runtime.js");
const builder = await import("./hub/builder.js");
const { server } = await import("./server.js");

const sample = () => def.normalizeDefinition({
  identity: { name: "Support Triage" },
  purpose: "Classify a support email and draft a reply.",
  instructions: "Read the email. Pick a category. Draft a short reply.",
  tools: ["repo.read", "not.a.tool"],
  permissions: { repos: ["acme/app"] },
  guardrails: { rules: ["Never promise refunds."], blockedTerms: ["internal-only"] },
  inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  outputSchema: { type: "object", properties: { category: { type: "string", enum: ["bug", "billing"] }, reply: { type: "string" } }, required: ["category", "reply"] },
});

// Each segment is a list of moves a model would make: function calls ({fn, args}) or a text reply ({text}) or an error.
function scriptSegments(segments) {
  const seen = [];
  rt._setSegmentForTests(async (prompt, _model, _max, tools, control) => {
    seen.push({ prompt, names: tools.map((t) => t.name), results: [] });
    const moves = segments.shift() || [];
    let text = "";
    for (const m of moves) {
      if (control.done) break;
      if (m.error) return { text: "", error: m.error };
      if (m.text) { text += m.text; continue; }
      const tool = tools.find((t) => t.name === m.fn);
      seen[seen.length - 1].results.push(tool ? await tool.handler(m.args || {}) : `no such function ${m.fn}`);
    }
    return { text, error: null };
  });
  return seen;
}

const answer = (args) => ({ fn: "submit_answer", args });

// A GitHub contents API reply, so repo.read runs without the network.
rt._setFetchForTests(async () => new Response(JSON.stringify([{ type: "file", path: "README.md", size: 10 }]), { status: 200, headers: { "content-type": "application/json" } }));

test("normalize drops unknown tools and keeps the schema subset", () => {
  const d = sample();
  assert.deepStrictEqual(d.tools, [{ id: "repo.read" }]);
  assert.deepStrictEqual(d.outputSchema.required, ["category", "reply"]);
  const odd = def.normalizeDefinition({ inputSchema: { type: "object", properties: { "bad key!": { type: "string" }, ok: { type: "weird" } }, required: ["missing"] } });
  assert.deepStrictEqual(Object.keys(odd.inputSchema.properties), ["ok"]);
  assert.strictEqual(odd.inputSchema.properties.ok.type, "string");
  assert.deepStrictEqual(odd.inputSchema.required, []);
});

test("validation catches tools without permissions and approval that is only words", () => {
  const v = def.validateDefinition({ ...sample(), permissions: { repos: [] } });
  assert.ok(v.errors.some((e) => /Reading GitHub needs/.test(e.message)));
  const w = def.validateDefinition({ ...sample(), instructions: "Ask for human approval before sending." });
  assert.ok(w.warnings.some((e) => e.section === "humanInTheLoop"));
});

test("the system prompt is derived from the definition", () => {
  const p = def.buildSystemPrompt(sample());
  assert.match(p, /You are Support Triage/);
  assert.match(p, /Never promise refunds/);
  assert.match(p, /category \(string, required\) one of \["bug","billing"\]/);
});

test("gitagent files round-trip, and a plain gitagent imports", () => {
  const files = def.renderGitagentFiles(sample());
  assert.match(files["agent.yaml"], /spec_version/);
  assert.deepStrictEqual(def.definitionFromGitagent(files).guardrails, sample().guardrails);
  const plain = def.definitionFromGitagent({ "agent.yaml": "name: reviewer\ndescription: Reviews PRs\nmodel:\n  preferred: anthropic:claude\n", "SOUL.md": "# Reviewer\nBe kind.", "RULES.md": "- No force pushes\n" });
  assert.strictEqual(plain.identity.name, "reviewer");
  assert.strictEqual(plain.model.provider, "anthropic");
  assert.deepStrictEqual(plain.guardrails.rules, ["No force pushes"]);
});

test("diff lists only the fields that changed", () => {
  const a = sample();
  const b = { ...a, guardrails: { ...a.guardrails, rules: [...a.guardrails.rules, "Keep replies under 120 words."] } };
  const d = def.diffDefinitions(a, b);
  assert.strictEqual(d.length, 1);
  assert.strictEqual(d[0].path, "guardrails.rules");
});

test("every save is a git version, and a version restores", async () => {
  const user = "u-store";
  const created = await store.createAgent(user, sample());
  assert.strictEqual(created.id, "support-triage");
  assert.strictEqual(created.version, "0.1.0");
  const same = await store.saveAgent(user, created.id, created);
  assert.strictEqual(same.changed, false);
  const edited = await store.saveAgent(user, created.id, { ...created, purpose: "Only classify." }, "Narrow the purpose");
  assert.strictEqual(edited.definition.version, "0.1.1");
  const versions = await store.listVersions(user, created.id);
  assert.deepStrictEqual(versions.map((v) => v.version), ["0.1.1", "0.1.0"]);
  const restored = await store.restoreVersion(user, created.id, versions[1].sha);
  assert.strictEqual(restored.definition.purpose, sample().purpose);
  assert.strictEqual(restored.definition.version, "0.1.2");
  assert.strictEqual(store.readAgent("u-other", created.id), null, "another user never sees it");
});

test("an n8n token is bound to one agent and dies on revoke", async () => {
  const user = "u-keys";
  const a = await store.createAgent(user, sample());
  const token = await store.issueKey(user, a.id);
  assert.deepStrictEqual(store.resolveKey(token, a.id), { user, id: a.id });
  assert.strictEqual(store.resolveKey(token, "other-agent"), null);
  assert.strictEqual(store.resolveKey(token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"), a.id), null);
  await store.revokeKey(user, a.id);
  assert.strictEqual(store.resolveKey(token, a.id), null);
});

test("only the agent's own tools are offered, and a bad answer is repaired once", async () => {
  const seen = scriptSegments([[answer({ category: "other", reply: "hi" }), answer({ category: "bug", reply: "Thanks, we are on it." })]]);
  const run = await rt.startRun(sample(), { email: "It crashes" }, { user: "u-rt" });
  assert.deepStrictEqual(seen[0].names, ["repo_read", "submit_answer"]);
  assert.match(seen[0].results[0], /^Rejected: \$\.category should be one of/);
  assert.strictEqual(run.status, "completed");
  assert.deepStrictEqual(run.output, { category: "bug", reply: "Thanks, we are on it." });
  assert.ok(run.steps.some((s) => s.kind === "repair"));
});

test("a tool call runs through the runtime and its result reaches the model", async () => {
  const seen = scriptSegments([[{ fn: "repo_read", args: { repo: "acme/app" } }, { fn: "repo_read", args: { repo: "evil/other" } }, answer({ category: "bug", reply: "ok" })]]);
  const run = await rt.startRun(sample(), { email: "bug" }, { user: "u-rt" });
  assert.match(seen[0].results[0], /README\.md/);
  assert.match(seen[0].results[1], /not an allowed repository/);
  assert.strictEqual(run.status, "completed");
});

test("the step budget stops a tool loop", async () => {
  const d = def.normalizeDefinition({ ...sample(), runtime: { maxSteps: 1 } });
  const seen = scriptSegments([[{ fn: "repo_read", args: { repo: "acme/app" } }, { fn: "repo_read", args: { repo: "acme/app" } }, answer({ category: "bug", reply: "ok" })]]);
  const run = await rt.startRun(d, { email: "bug" }, { user: "u-rt" });
  assert.match(seen[0].results[1], /No steps left/);
  assert.strictEqual(run.status, "completed");
});

test("a text answer counts, and a stray function-call error is retried", async () => {
  scriptSegments([[{ error: "Tool choice is none, but model called a tool" }], [{ text: '{"answer": {"category": "billing", "reply": "Looking into it."}}' }]]);
  const run = await rt.startRun(sample(), { email: "charged twice" }, { user: "u-rt" });
  assert.strictEqual(run.status, "completed");
  assert.strictEqual(run.output.category, "billing");
  assert.ok(run.steps.some((s) => /Retrying/.test(s.detail)));
});

test("runtime rejects bad input before any model call", async () => {
  const seen = scriptSegments([]);
  const run = await rt.startRun(sample(), { email: 42 }, { user: "u-rt" });
  assert.strictEqual(run.status, "rejected");
  assert.strictEqual(seen.length, 0);
  const blocked = await rt.startRun(sample(), { email: "see internal-only doc" }, { user: "u-rt" });
  assert.strictEqual(blocked.status, "rejected");
});

test("a guarded tool pauses for a human, and the decision resumes the run", async () => {
  const d = def.normalizeDefinition({ ...sample(), humanInTheLoop: { approveTools: ["repo.read"] } });
  scriptSegments([[{ fn: "repo_read", args: { repo: "acme/app" } }, answer({ category: "bug", reply: "too early" })]]);
  const run = await rt.startRun(d, { email: "bug" }, { user: "u-rt" });
  assert.strictEqual(run.status, "awaiting_approval");
  assert.strictEqual(run.pendingApproval.tool, "repo.read");
  const seen = scriptSegments([[answer({ category: "bug", reply: "ok" })]]);
  const done = await rt.resolveApproval(run, d, { approved: false, note: "not needed" }, { user: "u-rt" });
  assert.strictEqual(done.status, "completed");
  assert.strictEqual(done.output.reply, "ok");
  assert.match(seen[0].prompt, /A human rejected the repo\.read call: not needed/);
});

test("output approval holds the answer until a person approves it", async () => {
  const d = def.normalizeDefinition({ ...sample(), humanInTheLoop: { approveOutput: true } });
  scriptSegments([[answer({ category: "billing", reply: "Checking your invoice." })]]);
  const run = await rt.startRun(d, { email: "charged twice" }, { user: "u-rt" });
  assert.strictEqual(run.status, "awaiting_approval");
  const done = await rt.resolveApproval(run, d, { approved: true }, { user: "u-rt" });
  assert.strictEqual(done.status, "completed");
  assert.strictEqual(done.output.category, "billing");
});

test("a secret in the output is blocked", async () => {
  scriptSegments([[answer({ category: "bug", reply: "use key gsk_abcdefghijklmnopqrstuvwxyz123" })]]);
  const run = await rt.startRun(sample(), { email: "x" }, { user: "u-rt" });
  assert.strictEqual(run.status, "blocked");
});

test("repo.read enforces the repository allowlist without touching the network", async () => {
  await assert.rejects(rt.TOOL_IMPL["repo.read"]({ repo: "someone/else" }, sample(), {}), /not an allowed repository/);
});

test("private addresses are recognised", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "172.20.0.1", "192.168.1.1", "169.254.169.254", "::1", "fd00::1", "::ffff:127.0.0.1"]) {
    assert.ok(rt.isPrivateAddress(ip), ip);
  }
  for (const ip of ["1.1.1.1", "140.82.112.3", "2606:4700::1111"]) assert.ok(!rt.isPrivateAddress(ip), ip);
  assert.ok(rt.domainAllowed("api.example.com", ["example.com"]));
  assert.ok(!rt.domainAllowed("example.com.evil.net", ["example.com"]));
});

test("Improve replaces only known sections and returns a diff", () => {
  const out = builder.applyChanges(sample(), { guardrails: { rules: ["Never promise refunds.", "Ask before anything destructive."] }, secretField: "x", tools: ["shell.exec"] }, "Stricter", []);
  assert.deepStrictEqual(out.proposed.tools, []);
  assert.ok(!("secretField" in out.proposed));
  assert.ok(out.diff.some((d) => d.path === "guardrails.rules"));
});

test("Builder turns a plain-English request into a normalized suggestion", async () => {
  builder._setBuilderTurnForTests(async () => ({ text: "Here you go:\n```json\n" + JSON.stringify({
    definition: { identity: { name: "Mail Triage" }, purpose: "Triage mail", tools: ["email.send"], humanInTheLoop: { approveOutput: true } },
    explanations: { tools: "Sending is done by n8n.", bogus: "x" }, edgeCases: ["Empty email"], questions: [],
  }) + "\n```", error: null }));
  const s = await builder.draftAgent("I want an agent that triages support emails and asks before sending", "groq");
  assert.strictEqual(s.definition.identity.name, "Mail Triage");
  assert.deepStrictEqual(s.definition.tools, []);
  assert.strictEqual(s.definition.humanInTheLoop.approveOutput, true);
  assert.deepStrictEqual(Object.keys(s.explanations), ["tools"]);
});

async function withServer(fn) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const call = (method, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try { return await fn(call); } finally { await new Promise((r) => server.close(r)); }
}

test("the hub API is per user, and the hook needs the agent's token", async () => {
  await withServer(async (call) => {
    const alice = { "X-Jr-User": "u-alice" };
    assert.strictEqual((await call("GET", "/agent/hub/agents")).status, 401, "no user, no hub");
    assert.strictEqual((await call("GET", "/agent/hub/agents", undefined, { "X-Jr-User": "hook" })).status, 401);
    const made = await call("POST", "/agent/hub/agents", { definition: sample() }, alice);
    assert.strictEqual(made.status, 201);
    const id = made.body.definition.id;
    assert.strictEqual((await call("GET", `/agent/hub/agents/${id}`, undefined, { "X-Jr-User": "u-bob" })).status, 404);
    assert.strictEqual((await call("GET", "/agent/hub/agents/..%2F..%2Fetc", undefined, alice)).status, 400);

    const noToken = await call("POST", `/agent/hub/hook/${id}/run`, { input: { email: "x" } }, { "X-Jr-User": "hook" });
    assert.strictEqual(noToken.status, 401);
    const conn = await call("POST", `/agent/hub/agents/${id}/connect`, undefined, alice);
    assert.match(conn.body.token, /^jrk_/);
    assert.strictEqual(conn.body.workflow.nodes[1].type, "n8n-nodes-base.httpRequest");

    scriptSegments([[answer({ category: "bug", reply: "On it." })]]);
    const ran = await call("POST", `/agent/hub/hook/${id}/run`, { input: { email: "it broke" } }, { "X-Jr-User": "hook", Authorization: `Bearer ${conn.body.token}` });
    assert.strictEqual(ran.status, 200);
    assert.strictEqual(ran.body.status, "completed");
    assert.ok(!("transcript" in ran.body), "the transcript never leaves the server");
    const polled = await call("GET", `/agent/hub/hook/${id}/runs/${ran.body.id}`, undefined, { Authorization: `Bearer ${conn.body.token}` });
    assert.strictEqual(polled.body.output.reply, "On it.");

    await call("DELETE", `/agent/hub/agents/${id}/connect`, undefined, alice);
    const revoked = await call("POST", `/agent/hub/hook/${id}/run`, { input: { email: "x" } }, { Authorization: `Bearer ${conn.body.token}` });
    assert.strictEqual(revoked.status, 401);
  });
});

test("follow-up questions come from the answers, with a fallback when the model fails", async () => {
  const prompts = [];
  builder._setBuilderTurnForTests(async (p) => { prompts.push(p); return { text: '{"questions":[{"q":"Which categories should it use?","options":["bug","billing","other"]},{"q":"x"}]}', error: null }; });
  const out = await builder.followUpQuestions([{ q: "What does your agent need to do?", a: "Sort support emails" }], "groq");
  assert.match(prompts[0], /Sort support emails/);
  assert.deepStrictEqual(out.questions.map((q) => q.q), ["Which categories should it use?"]);
  assert.strictEqual(out.fallback, false);
  builder._setBuilderTurnForTests(async () => ({ text: "", error: "401 Invalid API Key" }));
  const fb = await builder.followUpQuestions([{ q: "a", a: "b" }], "groq");
  assert.strictEqual(fb.fallback, true);
  assert.ok(fb.questions.length >= 2);
});

test("provider errors are explained in plain words", async () => {
  const { friendlyModelError } = await import("./llm.js");
  assert.match(friendlyModelError("401 Invalid API Key"), /rejected this server's API key/);
  assert.match(friendlyModelError("429 Rate limit reached"), /rate-limiting/);
  assert.strictEqual(friendlyModelError("something odd"), "something odd");
});
