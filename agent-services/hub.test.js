// Agent Hub: definition, git-backed store, runtime enforcement and the HTTP surface. Run: `node --test`.
import { test, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_NO_LISTEN = "1";
process.env.JR_HUB_DIR = mkdtempSync(join(tmpdir(), "jr-hub-test-"));
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "test-groq-test_placeholder_not_real";
process.env.GITAGENT_REGISTRY_INDEX = "http://127.0.0.1:1/index.json";

// With MONGODB_TEST_URI set, the same tests run against MongoDB in a throwaway database.
const testDb = process.env.MONGODB_TEST_URI ? await import("./hub/db.js") : null;
if (testDb) {
  await testDb.connectDb(process.env.MONGODB_TEST_URI, `jr_test_${process.pid}`);
  after(() => testDb.dropDb());
}

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
  assert.strictEqual(await store.readAgent("u-other", created.id), null, "another user never sees it");
});

test("an n8n token is bound to one agent and dies on revoke", async () => {
  const user = "u-keys";
  const a = await store.createAgent(user, sample());
  const token = await store.issueKey(user, a.id);
  assert.deepStrictEqual(await store.resolveKey(token, a.id), { user, id: a.id });
  assert.strictEqual(await store.resolveKey(token, "other-agent"), null);
  assert.strictEqual(await store.resolveKey(token.slice(0, -1) + (token.endsWith("0") ? "1" : "0"), a.id), null);
  await store.revokeKey(user, a.id);
  assert.strictEqual(await store.resolveKey(token, a.id), null);
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

test("a model that invents a tool is told which ones exist and recovers", async () => {
  const invented = { error: "Tool call validation failed: attempted to call tool 'memory.load' which was not in request.tools" };
  const seen = scriptSegments([[invented], [invented], [answer({ category: "bug", reply: "ok" })]]);
  const run = await rt.startRun(sample(), { email: "bug" }, { user: "u-rt" });
  assert.strictEqual(run.status, "completed", JSON.stringify(run.error));
  assert.ok(!seen[0].prompt.includes("does not exist"));
  assert.match(seen[1].prompt, /called "memory\.load", which does not exist\. The only functions you can call are: repo_read, submit_answer/);
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
  // A missing required field is rejected; a number where text is expected is converted, not rejected.
  const run = await rt.startRun(sample(), { subject: "hi" }, { user: "u-rt" });
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
  scriptSegments([[answer({ category: "bug", reply: "use key AKIAIOSFODNN7EXAMPLE" })]]);
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

test("a Build mode blueprint creates agents, a wired workflow and a token that runs it", async () => {
  await withServer(async (call) => {
    const carol = { "X-Jr-User": "u-carol" };
    const plan = {
      app: "Note Helper",
      agents: [
        { key: "summarizer", name: "Note Summarizer", purpose: "Summarize a note.", input: { note: "The note" }, output: { summary: "Short summary" } },
        { key: "tagger", name: "Note Tagger", purpose: "Tag a summary.", input: { summary: "A summary", note: "The note", style: "Tag style" }, output: { tags: "Comma separated tags" } },
        { key: "unused", name: "Unused", purpose: "Never wired.", input: { x: "" }, output: { y: "" } },
        { key: "Bad Key!", name: "Dropped" },
      ],
      workflows: [{ key: "summarize_and_tag", name: "Summarize and tag", agents: ["summarizer", "tagger", "missing"] }, { key: "empty", agents: ["nope"] }],
    };
    const out = await call("POST", "/agent/hub/blueprint", plan, carol);
    assert.strictEqual(out.status, 201);
    assert.deepStrictEqual(out.body.agents.map((a) => a.key), ["summarizer", "tagger"], "only agents a workflow uses are created");
    assert.strictEqual(out.body.workflows.length, 1);
    const flow = out.body.workflows[0];
    assert.deepStrictEqual(Object.keys(flow.input), ["note", "style"], "a field no agent produces becomes workflow input");
    assert.deepStrictEqual(Object.keys(flow.output), ["summary", "tags"], "the app gets every field produced on the way");
    assert.match(flow.token, /_/);

    const saved = (await call("GET", `/agent/hub/workflows/${flow.id}`, undefined, carol)).body.workflow;
    assert.ok(saved.validation.ok, JSON.stringify(saved.validation.errors));
    const tagger = saved.nodes.find((n) => n.name === "Note Tagger");
    assert.deepStrictEqual(tagger.config.input, { summary: "{{ $json.summary }}", note: '{{ $node["Start"].json.note }}', style: '{{ $node["Start"].json.style }}' });

    scriptSegments([[answer({ summary: "Buy milk" })], [answer({ tags: "errands" })]]);
    const ran = await call("POST", `/agent/hub/hook-wf/${flow.id}/run`, { input: { note: "remember to buy milk", style: "short" } }, { "X-Jr-User": "hook", Authorization: `Bearer ${flow.token}` });
    assert.strictEqual(ran.status, 200, JSON.stringify(ran.body));
    assert.strictEqual(ran.body.status, "completed");
    assert.strictEqual(ran.body.output.tags, "errands");
    assert.strictEqual(ran.body.output.summary, "Buy milk");

    assert.strictEqual((await call("POST", "/agent/hub/blueprint", { agents: [], workflows: [] }, carol)).status, 400);
  });
});

test("a blueprint workflow can branch on a field an agent produced", async () => {
  await withServer(async (call) => {
    const erin = { "X-Jr-User": "u-erin" };
    const plan = {
      app: "Tutor",
      agents: [
        { key: "grader", name: "Grader", purpose: "Grade code.", input: { code: "Code", task: "Task" }, output: { passed: { type: "yes/no" }, feedback: "Feedback" } },
        { key: "next_lesson", name: "Next Lesson", purpose: "Pick the next lesson.", input: { feedback: "Feedback" }, output: { lesson: "Lesson" } },
        { key: "hinter", name: "Hint Giver", purpose: "Give a hint.", input: { feedback: "Feedback", task: "Task" }, output: { hint: "Hint" } },
      ],
      workflows: [{ key: "check_answer", name: "Check answer", agents: ["grader"], branch: { field: "passed", op: "is_true", then: ["next_lesson"], else: ["hinter", "grader"] } }],
    };
    const out = await call("POST", "/agent/hub/blueprint", plan, erin);
    assert.strictEqual(out.status, 201, JSON.stringify(out.body));
    const flow = out.body.workflows[0];
    assert.deepStrictEqual(Object.keys(flow.input).sort(), ["code", "task"]);
    assert.deepStrictEqual(Object.keys(flow.output).sort(), ["feedback", "hint", "lesson", "passed"]);
    assert.strictEqual(flow.outputTypes.passed, "boolean");
    const saved = (await call("GET", `/agent/hub/workflows/${flow.id}`, undefined, erin)).body.workflow;
    assert.ok(saved.validation.ok, JSON.stringify(saved.validation.errors));
    assert.strictEqual(saved.nodes.filter((n) => n.type === "agent").length, 3, "an agent already on the path is not repeated");
    const hinter = saved.nodes.find((n) => n.name === "Hint Giver");
    assert.strictEqual(hinter.config.input.task, '{{ $node["Start"].json.task }}');

    scriptSegments([[answer({ passed: false, feedback: "Off by one" })], [answer({ hint: "Check the loop bound" })]]);
    const ran = await call("POST", `/agent/hub/hook-wf/${flow.id}/run`, { input: { code: "for i in range(10)", task: "Print 1 to 10" } }, { "X-Jr-User": "hook", Authorization: `Bearer ${flow.token}` });
    assert.strictEqual(ran.body.status, "completed", JSON.stringify(ran.body));
    assert.strictEqual(ran.body.output.hint, "Check the loop bound");
    assert.strictEqual(ran.body.output.feedback, "Off by one");
    assert.ok(!ran.body.output.lesson, "the other branch never ran");
  });
});

test("blueprint keeps list fields as arrays, so a recipe's ingredients come back as a list", async () => {
  await withServer(async (call) => {
    const dana = { "X-Jr-User": "u-dana" };
    const plan = {
      app: "Cookbook",
      agents: [{ key: "chef", name: "Recipe Writer", purpose: "Write a recipe.", input: { dish: "Dish name" },
        output: { title: { type: "text", description: "Recipe name" }, ingredients: "Array of strings", steps: { type: "list", description: "One step per item" }, minutes: { type: "number" } } }],
      workflows: [{ key: "write_recipe", name: "Write recipe", agents: ["chef"] }],
    };
    const out = await call("POST", "/agent/hub/blueprint", plan, dana);
    assert.strictEqual(out.status, 201, JSON.stringify(out.body));
    const flow = out.body.workflows[0];
    assert.deepStrictEqual(flow.outputTypes, { title: "string", ingredients: "list", steps: "list", minutes: "number" });
    const agent = (await call("GET", `/agent/hub/agents/${out.body.agents[0].id}`, undefined, dana)).body.definition;
    assert.strictEqual(agent.outputSchema.properties.ingredients.type, "array");
    assert.strictEqual(agent.outputSchema.properties.minutes.type, "number");

    scriptSegments([[answer({ title: "Sambar", ingredients: ["toor dal", "tamarind"], steps: ["Cook dal", "Add tamarind"], minutes: 40 })]]);
    const ran = await call("POST", `/agent/hub/hook-wf/${flow.id}/run`, { input: { dish: "sambar" } }, { "X-Jr-User": "hook", Authorization: `Bearer ${flow.token}` });
    assert.strictEqual(ran.body.status, "completed", JSON.stringify(ran.body));
    assert.deepStrictEqual(ran.body.output.ingredients, ["toor dal", "tamarind"]);
  });
});

test("the workflow playground explains itself, answers greetings and keeps its chat", async () => {
  await withServer(async (call) => {
    const fay = { "X-Jr-User": "u-fay" };
    const node = (id, type, name, config) => ({ id, type, name, position: { x: 0, y: 0 }, config });
    const echo = await call("POST", "/agent/hub/workflows", { workflow: { name: "Echo planner", description: "Plans a dinner", nodes: [
      node("trigger", "trigger", "Start", { mode: "webhook", sample: { message: "Plan a dinner", servings: "4" } }),
      node("set", "set", "Plan", { value: { reply: "Plan for {{ $json.message }}", steps: ["Shop", "Cook"] } }),
      node("output", "output", "Result", { value: "{{ $json }}" }),
    ], edges: [{ from: "trigger", port: "main", to: "set" }, { from: "set", port: "main", to: "output" }] } }, fay);
    const id = echo.body.workflow.id;

    const open = await call("GET", `/agent/hub/workflows/${id}/playground`, undefined, fay);
    assert.strictEqual(open.body.info.name, "Echo planner");
    assert.strictEqual(open.body.info.mainField, "message");
    assert.deepStrictEqual(open.body.info.inputs.map((i) => i.name), ["message", "servings"]);
    assert.deepStrictEqual(open.body.messages, []);

    const hi = await call("POST", `/agent/hub/workflows/${id}/playground`, { text: "hii", input: { message: "hii", servings: "4" } }, fay);
    assert.strictEqual(hi.status, 200, JSON.stringify(hi.body));
    assert.deepStrictEqual(hi.body.messages.map((m) => m.role), ["user", "system"]);
    assert.match(hi.body.messages[1].text, /playground for "Echo planner"\. Plans a dinner/);
    assert.match(hi.body.messages[1].text, /servings/);
    assert.strictEqual((await call("GET", `/agent/hub/workflows/${id}/runs`, undefined, fay)).body.runs.length, 0, "a greeting does not run the workflow");

    const ran = await call("POST", `/agent/hub/workflows/${id}/playground`, { text: "Diwali dinner", input: { message: "Diwali dinner", servings: "4" } }, fay);
    const reply = ran.body.messages[1];
    assert.strictEqual(reply.role, "run");
    assert.strictEqual(reply.run.status, "completed");
    assert.deepStrictEqual(reply.run.output, { reply: "Plan for Diwali dinner", steps: ["Shop", "Cook"] });

    const again = await call("GET", `/agent/hub/workflows/${id}/playground`, undefined, fay);
    assert.strictEqual(again.body.messages.length, 4, "the chat is kept on the server");
    assert.strictEqual((await call("GET", `/agent/hub/workflows/${id}/playground`, undefined, { "X-Jr-User": "u-other" })).status, 404, "another user cannot open it");

    const gate = await call("POST", "/agent/hub/workflows", { workflow: { name: "Publish", nodes: [
      node("trigger", "trigger", "Start", { mode: "webhook", sample: { text: "Hello" } }),
      node("approval", "approval", "Approve", { message: "Publish this?" }),
      node("output", "output", "Result", { value: { published: "{{ $json.text }}" } }),
    ], edges: [{ from: "trigger", port: "main", to: "approval" }, { from: "approval", port: "approved", to: "output" }] } }, fay);
    const gid = gate.body.workflow.id;
    const info = (await call("GET", `/agent/hub/workflows/${gid}/playground`, undefined, fay)).body.info;
    assert.ok(info.approval && info.steps.includes("A person approves the result"));
    const paused = (await call("POST", `/agent/hub/workflows/${gid}/playground`, { text: "Spring menu", input: { text: "Spring menu" } }, fay)).body.messages[1];
    assert.strictEqual(paused.run.status, "awaiting_approval");
    assert.strictEqual(paused.run.pending.message, "Publish this?");
    const decided = await call("POST", `/agent/hub/workflows/${gid}/playground/decision`, { messageId: paused.id, approved: true }, fay);
    assert.strictEqual(decided.body.message.run.status, "completed", JSON.stringify(decided.body));
    assert.deepStrictEqual(decided.body.message.run.output, { published: "Spring menu" });
    const thread = (await call("GET", `/agent/hub/workflows/${gid}/playground`, undefined, fay)).body.messages;
    assert.strictEqual(thread.find((m) => m.id === paused.id).decided, "approved");

    assert.strictEqual((await call("DELETE", `/agent/hub/workflows/${gid}/playground`, undefined, fay)).status, 200);
    assert.deepStrictEqual((await call("GET", `/agent/hub/workflows/${gid}/playground`, undefined, fay)).body.messages, []);
  });
});

test("the playground reads a branching workflow back as steps", async () => {
  const { describeWorkflow, greetingReply, isGreeting } = await import("./hub/playground.js");
  const n = (id, type, name, config = {}) => ({ id, type, name, config });
  const w = { id: "check", name: "Check answer", description: "", nodes: [
    n("t", "trigger", "Start", { sample: { code: "print(1)", task: "Print one" } }), n("g", "agent", "Grader"), n("b", "if", "Passed?"),
    n("x", "agent", "Next Lesson"), n("h", "agent", "Hint Giver"), n("o1", "output", "Result"), n("o2", "output", "Result 2"),
  ], edges: [{ from: "t", port: "main", to: "g" }, { from: "g", port: "main", to: "b" }, { from: "b", port: "true", to: "x" }, { from: "b", port: "false", to: "h" },
    { from: "x", port: "main", to: "o1" }, { from: "h", port: "main", to: "o2" }] };
  const info = await describeWorkflow("u-desc", w);
  assert.deepStrictEqual(info.steps, ["Grader", "Passed?: if yes, Next Lesson; if no, Hint Giver"]);
  assert.deepStrictEqual(info.agents.map((a) => a.name), ["Grader", "Next Lesson", "Hint Giver"]);
  assert.strictEqual(info.mainField, "task", "a message-like field is the main one even when it is not first");
  assert.match(greetingReply(info), /Grader → Passed\?: if yes, Next Lesson; if no, Hint Giver/);
  for (const g of ["hi", "Hii!", "hello", "hey there".slice(0, 3), "Good morning", "what can you do?", "help"]) assert.ok(isGreeting(g), g);
  for (const g of ["hi, plan a dinner for 4", "hello world app idea", "print('hi')"]) assert.ok(!isGreeting(g), g);
});

test("values from an earlier agent are converted to what the next agent declares", async () => {
  const { coerceToSchema } = await import("./hub/definition.js");
  const schema = { type: "object", properties: {
    can_adapt: { type: "string" }, servings: { type: "number" }, ok: { type: "boolean" }, steps: { type: "array", items: { type: "string" } }, notes: { type: "string" },
  } };
  assert.deepStrictEqual(coerceToSchema({ can_adapt: true, servings: "4", ok: "yes", steps: "- Chop\n- Fry", notes: ["a", "b"] }, schema),
    { can_adapt: "true", servings: 4, ok: true, steps: ["Chop", "Fry"], notes: "a\nb" });
  assert.deepStrictEqual(coerceToSchema({ servings: "lots", ok: "maybe" }, schema), { servings: "lots", ok: "maybe" }, "an ambiguous value is left for the check to reject");

  await withServer(async (call) => {
    const gus = { "X-Jr-User": "u-gus" };
    const plan = {
      app: "Kitchen",
      agents: [
        { key: "assessor", name: "Adaptation Assessor", purpose: "Decide.", input: { issue: "Issue" }, output: { can_adapt: { type: "yes/no" }, reason: "Why" } },
        { key: "explainer", name: "Explanation Explainer", purpose: "Explain.", input: { can_adapt: "Whether it adapts", reason: "Why" }, output: { explanation: "Text" } },
      ],
      workflows: [{ key: "adapt", name: "Adapt", agents: ["assessor", "explainer"] }],
    };
    const out = await call("POST", "/agent/hub/blueprint", plan, gus);
    assert.strictEqual(out.status, 201, JSON.stringify(out.body));
    const explainer = (await call("GET", `/agent/hub/agents/${out.body.agents[1].id}`, undefined, gus)).body.definition;
    assert.strictEqual(explainer.inputSchema.properties.can_adapt.type, "boolean", "a new app's input takes the producer's type");

    // An agent built before this fix declares text; the boolean an earlier agent sends must still get through.
    explainer.inputSchema.properties.can_adapt = { type: "string", description: "Whether it adapts" };
    assert.strictEqual((await call("PUT", `/agent/hub/agents/${explainer.id}`, { definition: explainer }, gus)).status, 200);
    scriptSegments([[answer({ can_adapt: true, reason: "No dairy" })], [answer({ explanation: "Use oat milk" })]]);
    const flow = out.body.workflows[0];
    const ran = await call("POST", `/agent/hub/hook-wf/${flow.id}/run`, { input: { issue: "Lactose" } }, { "X-Jr-User": "hook", Authorization: `Bearer ${flow.token}` });
    assert.strictEqual(ran.body.status, "completed", JSON.stringify(ran.body));
    assert.strictEqual(ran.body.output.explanation, "Use oat milk");
  });
});

test("Build mode's placeholder samples are not offered as examples", async () => {
  const { describeWorkflow } = await import("./hub/playground.js");
  const w = { id: "x", name: "X", nodes: [{ id: "t", type: "trigger", name: "Start", config: { sample: { user_input: "Example user_input", servings: "4" } } }], edges: [] };
  assert.deepStrictEqual((await describeWorkflow("u-x", w)).inputs, [{ name: "user_input", example: "" }, { name: "servings", example: "4" }]);
});

test("API snippets keep the body exact in curl, JavaScript and Python", async () => {
  const { snippets } = await import("./hub/routes.js");
  const body = { input: { note: "it's true", ok: true, none: null } };
  const blank = snippets("https://x.test/hooks/agents/a/run", body, "", "JR_AGENT_TOKEN");
  const q = "'" + String.fromCharCode(92) + "''";
  assert.ok(blank.curl.includes(`-d '{"input":{"note":"it${q}s true","ok":true,"none":null}}'`));
  assert.ok(blank.javascript.includes("process.env.JR_AGENT_TOKEN"));
  assert.ok(blank.python.includes(`"note": "it's true"`) && blank.python.includes(`"ok": True`) && blank.python.includes(`"none": None`));
  const filled = snippets("https://x.test/run", body, "jrk_secret", "JR_AGENT_TOKEN");
  for (const s of Object.values(filled)) assert.ok(s.includes("Bearer jrk_secret"));
});
