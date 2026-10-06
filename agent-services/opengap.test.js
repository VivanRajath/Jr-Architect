import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import * as og from "./opengap/index.js";

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), "og-test-"));
  mkdirSync(join(dir, "public"), { recursive: true });
  mkdirSync(join(dir, ".gitagent"), { recursive: true });
  writeFileSync(join(dir, ".gitagent", "agent.yaml"), 'spec_version: "0.1.0"\nname: demo-agent\n');
  writeFileSync(join(dir, "public", "styles.css"), ".a { color: orange; }\n");
  writeFileSync(join(dir, "server.js"), "app.listen(3000);\n");
  return dir;
}

// A pipeline stub: edits succeed unless the content would trip a guard, which is checked through the real hooks.
function runner({ classify = { tier: "junior-dev", confidence: 0.9 }, content = "/* changed */\n" } = {}) {
  const calls = [];
  return {
    calls,
    r: og.createRunner({
      gatherEditFiles: async () => [{ path: "public/styles.css", whole: true }, { path: "server.js", whole: true }],
      runEditPipeline: async (dir, task, model, onStep, container, opts) => {
        calls.push({ agent: opts.agentName, files: opts.files });
        const path = opts.files && opts.files[0];
        if (!path) return { ok: false, reason: "no-blocks" };
        const g = opts.guard(path, "", content);
        if (g.blocked.length) return { ok: true, results: [{ path, status: `blocked by guardrails (${g.blocked.map((b) => b.hook).join(", ")})` }] };
        return { ok: true, results: [{ path, status: "edited", before: "", after: content }] };
      },
      collectTurn: async () => ({ text: JSON.stringify(classify) }),
      parseJsonLoose: (t) => JSON.parse(t),
      parseEditBlocks: () => [],
      providerHasKey: () => true,
      outputBudget: () => 1000,
    }),
  };
}

test("init scaffolds the default team without overwriting, and check finds nothing wrong", () => {
  const dir = workspace();
  const wrote = og.init(dir);
  assert.ok(wrote.includes(".gitagent/agents/ui-editor/SOUL.md"));
  assert.ok(wrote.includes(".gitagent/hooks/hooks.yaml"));
  writeFileSync(join(dir, ".gitagent", "DUTIES.md"), "my duties\n");
  assert.deepEqual(og.init(dir), [], "a second init writes nothing");
  assert.equal(readFileSync(join(dir, ".gitagent", "DUTIES.md"), "utf8"), "my duties\n");
  const st = og.status(dir);
  assert.deepEqual(st.agents.map((a) => a.name), ["build-doctor", "junior-dev", "ui-editor", "senior-dev"]);
  assert.equal(st.problems.filter((p) => p.level === "error").length, 0);
  assert.ok(st.guards.hooks.some((h) => h.name === "secret-scan" && h.sealed));
  assert.equal(st.routing.entry, "auto");
});

test("saveAgent writes valid front matter; check catches a missing successor and a cycle", () => {
  const dir = workspace();
  og.init(dir);
  og.saveAgent(dir, { name: "reviewer", role: "Reviews diffs", priority: 30, owns: ["**/*.test.js"], escalatesTo: "nobody-here" });
  let st = og.status(dir);
  const rev = st.agents.find((a) => a.name === "reviewer");
  assert.deepEqual(rev.owns, ["**/*.test.js"]);
  assert.ok(st.problems.some((p) => p.level === "error" && /nobody-here/.test(p.what)));
  og.saveAgent(dir, { name: "a1", role: "x", priority: 60, escalatesTo: "a2" });
  og.saveAgent(dir, { name: "a2", role: "y", priority: 61, escalatesTo: "a1" });
  st = og.status(dir);
  assert.ok(st.problems.some((p) => /round in a circle/.test(p.what)));
  assert.throws(() => og.saveAgent(dir, { name: "Bad Name" }), /lowercase/);
  og.deleteAgent(dir, "a1");
  assert.ok(!existsSync(join(dir, ".gitagent", "agents", "a1")));
});

test("guards: add, toggle, sealed ones cannot be switched off, bad YAML is refused", () => {
  const dir = workspace();
  og.init(dir);
  og.addGuard(dir, { name: "keep-payments-safe", phase: "pre_edit", severity: "block", items: ["payments/**"] });
  assert.ok(og.status(dir).guards.hooks.some((h) => h.name === "keep-payments-safe"));
  og.toggleGuard(dir, "diff-ceiling", false);
  assert.equal(og.status(dir).guards.hooks.find((h) => h.name === "diff-ceiling").enabled, false);
  og.toggleGuard(dir, "diff-ceiling", true);
  assert.equal(og.status(dir).guards.hooks.find((h) => h.name === "diff-ceiling").enabled, true);
  assert.throws(() => og.toggleGuard(dir, "secret-scan", false), /sealed/);
  assert.throws(() => og.saveFile(dir, "hooks/extra.yaml", "- just a list"), /mapping/);
  assert.throws(() => og.saveFile(dir, "../outside.md", "x"), /not part/);
});

test("setRouting edits one value and keeps the rest of agent.yaml", () => {
  const dir = workspace();
  og.init(dir);
  og.setRouting(dir, "classifier_confidence_floor", 0.75);
  const text = readFileSync(join(dir, ".gitagent", "agent.yaml"), "utf8");
  assert.match(text, /name: demo-agent/);
  assert.equal(og.readManifest(dir).routing.classifier_confidence_floor, 0.75);
  assert.throws(() => og.setRouting(dir, "evil", 1), /unknown/);
});

test("routing: @name anywhere, then ownership, then the classifier", async () => {
  const dir = workspace();
  og.init(dir);
  const { r, calls } = runner();
  let res = await r.runTask(dir, "make the header pink @senior-dev", {});
  assert.equal(res.run.route.agent, "senior-dev");
  assert.equal(res.run.task, "make the header pink");
  const only = og.createRunner({
    gatherEditFiles: async () => [{ path: "public/styles.css", whole: true }],
    runEditPipeline: async (d, t, m, s, c, opts) => ({ ok: true, results: [{ path: opts.files[0], status: "edited" }] }),
    collectTurn: async () => ({ text: "{}" }), parseJsonLoose: () => ({}), parseEditBlocks: () => [], providerHasKey: () => true, outputBudget: () => 1,
  });
  res = await only.runTask(dir, "change colours", {});
  assert.equal(res.run.route.agent, "ui-editor", "ui-editor owns the only file involved");
  res = await r.runTask(dir, "rename the config loader", {});
  assert.equal(res.run.route.agent, "junior-dev", "the classifier picks when nobody owns all the files");
  assert.equal(calls.length, 2);
});

test("a low-confidence classification goes one step up", async () => {
  const dir = workspace();
  og.init(dir);
  const { r } = runner({ classify: { tier: "junior-dev", confidence: 0.2 } });
  const res = await r.runTask(dir, "refactor everything", {});
  assert.equal(res.run.route.agent, "senior-dev");
});

test("out-of-scope work is handed off sideways at once, with a brief", async () => {
  const dir = workspace();
  og.init(dir);
  const { r, calls } = runner();
  const events = [];
  const res = await r.runTask(dir, "@ui-editor change the port in server.js", { onEvent: (e) => events.push(e) });
  assert.equal(calls[0].agent, "junior-dev", "ui-editor never ran a model call on a file it does not own");
  const handoff = events.find((e) => e.kind === "handoff");
  assert.equal(handoff.from, "ui-editor");
  assert.match(handoff.brief, /## Task \(unmodified\)/);
  assert.match(handoff.brief, /outside ui-editor's scope/);
  assert.equal(res.run.outcome, "done");
  assert.equal(og.listRuns(dir).length, 1);
});

test("a sealed guard stops the run instead of escalating", async () => {
  const dir = workspace();
  og.init(dir);
  const { r, calls } = runner({ content: "const k = 'AKIAIOSFODNN7EXAMPLE';\n" });
  const events = [];
  const res = await r.runTask(dir, "@junior-dev add the stripe key to server.js", { onEvent: (e) => events.push(e) });
  assert.equal(res.run.outcome, "stopped");
  assert.equal(calls.length, 1, "no retry and no escalation past a sealed guard");
  assert.match(events.find((e) => e.kind === "stop").detail, /secret-scan/);
});
