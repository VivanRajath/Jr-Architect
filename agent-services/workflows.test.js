// Visual workflows: expressions, graph rules, the engine with real agent runs, and the webhook. Run: `node --test`.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_NO_LISTEN = "1";
process.env.JR_HUB_DIR = mkdtempSync(join(tmpdir(), "jr-wf-test-"));
process.env.GROQ_API_KEY = process.env.GROQ_API_KEY || "test-groq-test_placeholder_not_real";
process.env.GITAGENT_REGISTRY_INDEX = "http://127.0.0.1:1/index.json";

const wf = await import("./hub/workflows.js");
const store = await import("./hub/store.js");
const rt = await import("./hub/runtime.js");
const { server } = await import("./server.js");

const USER = "u-flow";
const triage = await store.createAgent(USER, {
  identity: { name: "Triage" }, purpose: "Classify a support email.", instructions: "Pick a category.",
  inputSchema: { type: "object", properties: { email: { type: "string" } }, required: ["email"] },
  outputSchema: { type: "object", properties: { category: { type: "string" }, reply: { type: "string" } }, required: ["category", "reply"] },
});

// Every agent segment submits the next canned answer, as a model calling submit_answer would.
function agentAnswers(answers) {
  const prompts = [];
  rt._setSegmentForTests(async (prompt, _m, _t, tools) => {
    prompts.push(prompt);
    await tools.find((t) => t.name === "submit_answer").handler(answers.shift());
    return { text: "", error: null };
  });
  return prompts;
}

const node = (id, type, config = {}, name) => ({ id, type, name: name || id, position: { x: 0, y: 0 }, config });

function triageFlow() {
  return {
    name: "Support flow",
    nodes: [
      node("t", "trigger", { sample: { email: "hi" } }, "Start"),
      node("a", "agent", { agentId: triage.id, input: { email: "{{ $json.email }}" } }, "Triage"),
      node("i", "if", { path: "category", op: "equals", value: "bug" }, "Is bug?"),
      node("s", "set", { value: { team: "engineering", reply: "{{ $node[\"Triage\"].json.reply }}" } }, "Route to eng"),
      node("p", "approval", { message: "Send billing reply: {{ $json.reply }}" }, "Approve reply"),
      node("o", "output", { value: "{{ $json }}" }, "Result"),
    ],
    edges: [
      { from: "t", port: "main", to: "a" }, { from: "a", port: "main", to: "i" },
      { from: "i", port: "true", to: "s" }, { from: "i", port: "false", to: "p" },
      { from: "s", port: "main", to: "o" }, { from: "p", port: "approved", to: "o" },
    ],
  };
}

test("expressions read paths and never run code", () => {
  const ctx = { json: { a: { b: [1, { c: "x" }] } }, nodes: { Triage: { cat: "bug" } } };
  assert.strictEqual(wf.resolveTemplate("{{ $json.a.b[1].c }}", ctx), "x");
  assert.strictEqual(wf.resolveTemplate('{{ $node["Triage"].json.cat }}', ctx), "bug");
  assert.strictEqual(wf.resolveTemplate("n={{ $json.a.b[0] }}", ctx), "n=1");
  assert.strictEqual(wf.resolveTemplate("{{ constructor.constructor('return 1')() }}", ctx), null);
  assert.strictEqual(wf.resolveTemplate("{{ $json.__proto__ }}", ctx), null);
  assert.ok(wf.testCondition({ path: "a.b[1].c", op: "equals", value: "x" }, ctx));
  assert.ok(wf.testCondition({ path: "$json.a.b", op: "contains", value: "1" }, ctx));
});

test("yes/no conditions match the booleans agents return", () => {
  const ctx = { json: { passed: true, failed: false, word: "yes", label: "beginner" }, nodes: {} };
  assert.ok(wf.testCondition({ path: "passed", op: "equals", value: "yes" }, ctx));
  assert.ok(wf.testCondition({ path: "failed", op: "equals", value: "no" }, ctx));
  assert.ok(wf.testCondition({ path: "passed", op: "not_equals", value: "no" }, ctx));
  assert.ok(wf.testCondition({ path: "word", op: "is_true" }, ctx));
  assert.ok(!wf.testCondition({ path: "failed", op: "is_true" }, ctx));
  assert.ok(wf.testCondition({ path: "label", op: "equals", value: "beginner" }, ctx));
});

test("the graph drops impossible edges and flags missing pieces", () => {
  const w = wf.normalizeWorkflow({ nodes: [node("t", "trigger"), node("o", "output"), node("i", "if")],
    edges: [{ from: "o", to: "t" }, { from: "i", port: "maybe", to: "o" }, { from: "t", port: "main", to: "i" }, { from: "t", port: "main", to: "i" }] });
  assert.deepStrictEqual(w.edges, [{ from: "t", port: "main", to: "i" }]);
  const v = wf.validateWorkflow(w, USER);
  assert.ok(v.errors.some((e) => /field to test/.test(e.message)));
  const noTrigger = wf.validateWorkflow({ nodes: [node("a", "agent", { agentId: "missing-agent" })] }, USER);
  assert.ok(noTrigger.errors.some((e) => /exactly one Trigger/.test(e.message)));
  assert.ok(noTrigger.errors.some((e) => /does not exist/.test(e.message)));
});

test("a run follows the true branch through a real agent run", async () => {
  agentAnswers([{ category: "bug", reply: "We are fixing it." }]);
  const run = await wf.startWorkflowRun(triageFlow(), { email: "App crashes" }, { user: USER });
  assert.strictEqual(run.status, "completed");
  assert.deepStrictEqual(run.output, { team: "engineering", reply: "We are fixing it." });
  assert.strictEqual(run.nodes.i.port, "true");
  assert.strictEqual(run.nodes.p, undefined, "the false branch never ran");
  assert.ok(run.nodes.a.agentRunId, "the agent node links to its agent run");
});

test("the false branch pauses at the approval node and resumes on a decision", async () => {
  agentAnswers([{ category: "billing", reply: "Refund on its way." }]);
  const run = await wf.startWorkflowRun(triageFlow(), { email: "Charged twice" }, { user: USER });
  assert.strictEqual(run.status, "awaiting_approval");
  assert.strictEqual(run.pending.message, "Send billing reply: Refund on its way.");
  const done = await wf.decideWorkflowRun(run, triageFlow(), { approved: true, note: "ok" }, { user: USER });
  assert.strictEqual(done.status, "completed");
  assert.strictEqual(done.output.approved, true);
  assert.strictEqual(done.output.reply, "Refund on its way.");
});

test("an approval inside the agent pauses the whole workflow", async () => {
  await store.saveAgent(USER, triage.id, { ...store.readAgent(USER, triage.id), humanInTheLoop: { approveOutput: true } });
  agentAnswers([{ category: "bug", reply: "Held for review." }]);
  const run = await wf.startWorkflowRun(triageFlow(), { email: "crash" }, { user: USER });
  assert.strictEqual(run.status, "awaiting_approval");
  assert.strictEqual(run.pending.kind, "agent");
  const done = await wf.decideWorkflowRun(run, triageFlow(), { approved: true }, { user: USER });
  assert.strictEqual(done.status, "completed");
  assert.strictEqual(done.output.reply, "Held for review.");
  await store.saveAgent(USER, triage.id, { ...store.readAgent(USER, triage.id), humanInTheLoop: { approveOutput: false } });
});

test("an agent that rejects its input fails the node, not the server", async () => {
  const flow = triageFlow();
  flow.nodes[1].config.input = { subject: "no email given" };
  const run = await wf.startWorkflowRun(flow, {}, { user: USER });
  assert.strictEqual(run.status, "failed");
  assert.strictEqual(run.failedNode, "a");
  assert.match(run.error, /Triage: agent run rejected/);
});

test("HTTP nodes send the resolved body, and a loop is cut off", async () => {
  const calls = [];
  wf._setWorkflowFetchForTests(async (url, init) => { calls.push({ url, init }); return new Response('{"ok":true}', { status: 200 }); });
  const flow = { nodes: [node("t", "trigger"), node("h", "http", { url: "https://hooks.example.com/x", body: { text: "New: {{ $json.title }}" } }), node("o", "output")],
    edges: [{ from: "t", port: "main", to: "h" }, { from: "h", port: "main", to: "o" }] };
  const run = await wf.startWorkflowRun(flow, { title: "bug 7" }, { user: USER });
  assert.strictEqual(run.status, "completed");
  assert.deepStrictEqual(JSON.parse(calls[0].init.body), { text: "New: bug 7" });
  assert.deepStrictEqual(run.output.body, { ok: true });

  const loop = { nodes: [node("t", "trigger"), node("s", "set", { value: "{{ $json }}" })], edges: [{ from: "t", port: "main", to: "s" }, { from: "s", port: "main", to: "s" }] };
  assert.strictEqual(wf.normalizeWorkflow(loop).edges.length, 1, "a self-edge is dropped");
  const two = { nodes: [node("t", "trigger"), node("a", "set", { value: "{{ $json }}" }), node("b", "set", { value: "{{ $json }}" })],
    edges: [{ from: "t", port: "main", to: "a" }, { from: "a", port: "main", to: "b" }, { from: "b", port: "main", to: "a" }] };
  const looped = await wf.startWorkflowRun(two, {}, { user: USER });
  assert.strictEqual(looped.status, "failed");
  assert.match(looped.error, /node executions/);
});

test("on a public server an HTTP node cannot reach private addresses", async () => {
  process.env.JR_PUBLIC_ORIGIN = "https://jr.example";
  try {
    const flow = { nodes: [node("t", "trigger"), node("h", "http", { url: "https://127.0.0.1/admin" })], edges: [{ from: "t", port: "main", to: "h" }] };
    const run = await wf.startWorkflowRun(flow, {}, { user: USER });
    assert.strictEqual(run.status, "failed");
    assert.match(run.error, /private address/);
  } finally {
    delete process.env.JR_PUBLIC_ORIGIN;
  }
});

test("saves are git versions, and the webhook needs a workflow token", async () => {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  const call = (method, path, body, headers = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    method, headers: { "Content-Type": "application/json", ...headers }, body: body === undefined ? undefined : JSON.stringify(body),
  }).then(async (r) => ({ status: r.status, body: await r.json() }));
  try {
    const me = { "X-Jr-User": USER };
    const made = await call("POST", "/agent/hub/workflows", { workflow: triageFlow() }, me);
    assert.strictEqual(made.status, 201);
    const id = made.body.workflow.id;
    assert.strictEqual(made.body.workflow.validation.ok, true);
    const flow = made.body.workflow;
    flow.nodes.find((n) => n.id === "o").position = { x: 900, y: 50 };
    const saved = await call("PUT", `/agent/hub/workflows/${id}`, { workflow: flow, message: "Move result" }, me);
    assert.strictEqual(saved.body.workflow.version, "0.1.1");
    const versions = await call("GET", `/agent/hub/workflows/${id}/versions`, undefined, me);
    assert.deepStrictEqual(versions.body.versions.map((v) => v.version), ["0.1.1", "0.1.0"]);
    assert.strictEqual((await call("GET", `/agent/hub/workflows/${id}`, undefined, { "X-Jr-User": "u-other" })).status, 404);

    const agentToken = (await call("POST", `/agent/hub/agents/${triage.id}/connect`, undefined, me)).body.token;
    const refused = await call("POST", `/agent/hub/hook-wf/${id}/run`, { input: { email: "x" } }, { Authorization: `Bearer ${agentToken}` });
    assert.strictEqual(refused.status, 401, "an agent token cannot start a workflow");

    const { token } = (await call("POST", `/agent/hub/workflows/${id}/connect`, undefined, me)).body;
    assert.match(token, /^jrw_/);
    agentAnswers([{ category: "bug", reply: "Fixing." }]);
    const ran = await call("POST", `/agent/hub/hook-wf/${id}/run`, { input: { email: "crash" } }, { Authorization: `Bearer ${token}` });
    assert.strictEqual(ran.status, 200);
    assert.strictEqual(ran.body.status, "completed");
    assert.ok(!("queue" in ran.body) && !("byName" in ran.body));
    const runs = await call("GET", `/agent/hub/workflows/${id}/runs`, undefined, me);
    assert.strictEqual(runs.body.runs[0].id, ran.body.id);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
