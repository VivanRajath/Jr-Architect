import { test } from "node:test";
import assert from "node:assert/strict";
import { createPlanner } from "./planner.js";

const PLAN = {
  title: "Blue and pink theme", summary: "Swap the palette.",
  changes: [{ file: "public/styles.css", action: "modify", what: "new colours" }, { file: "../etc/passwd", action: "modify", what: "x" }],
  tasks: [{ title: "Recolour", files: ["public/styles.css"] }, { title: "Add footer", files: ["public/index.html", "/abs/path"] }],
  verification: [{ kind: "command", text: "build", command: "npm run build" }, { kind: "command", text: "bad", command: "rm -rf / && echo" }],
  questions: ["Which pink?"],
};

function harness({ planText = JSON.stringify(PLAN), edits = {} } = {}) {
  const events = [];
  const ws = { send: (s) => events.push(JSON.parse(s)) };
  const ran = [];
  const planner = createPlanner({
    collectTurn: async () => ({ text: planText, error: null }),
    parseJsonLoose: (t) => { try { return JSON.parse(t); } catch { return null; } },
    gatherEditFiles: async () => [{ path: "public/styles.css", content: ":root{}", whole: true }],
    runEditPipeline: async (dir, message, model, onStep, container, opts) => {
      ran.push(opts.files);
      const status = edits[opts.files[0]] || "edited";
      return { ok: true, results: [{ path: opts.files[0], status, before: "a", after: "b" }] };
    },
    hostExec: async (c, cmd) => ({ exitCode: 0, output: "ok " + cmd, timedOut: false }),
    readFileCapped: () => "",
    outputBudget: () => 3000,
  });
  return { planner, ws, events, ran };
}

test("normalisePlan keeps only safe paths, safe commands and capped tasks", () => {
  const { planner } = harness();
  const p = planner.normalisePlan(PLAN, "msg", []);
  assert.deepEqual(p.changes.map((c) => c.file), ["public/styles.css"]);
  assert.deepEqual(p.tasks[1].files, ["public/index.html"]);
  assert.equal(p.verification[0].command, "npm run build");
  assert.equal(p.verification[1].kind, "manual", "a destructive command must never be runnable");
  assert.equal(p.questions[0], "Which pink?");
});

test("an unstructured reply still becomes a one-task plan", () => {
  const { planner } = harness();
  const p = planner.normalisePlan(null, "make it pink", ["public/styles.css"]);
  assert.equal(p.tasks.length, 1);
  assert.deepEqual(p.tasks[0].files, ["public/styles.css"]);
});

test("planning waits for review, then proceeds task by task and writes a walkthrough", async () => {
  const { planner, ws, events, ran } = harness();
  await planner.startPlan(ws, { message: "theme", dir: "/w", model: "groq:x", container: "c1", policy: { review: "request" } });
  const plan = events.find((e) => e.type === "artifact" && e.kind === "plan");
  assert.ok(plan && events.some((e) => e.type === "awaiting_review"), "the plan must wait for review");
  assert.equal(ran.length, 0, "nothing runs before Proceed");

  await planner.proceed(ws, { id: plan.id, policy: { terminal: "always" } });
  assert.deepEqual(ran, [["public/styles.css"], ["public/index.html"]]);
  const walk = events.find((e) => e.kind === "walkthrough").walkthrough;
  assert.deepEqual(walk.tasks.map((t) => t.status), ["done", "done"]);
  assert.equal(walk.verification[0].status, "passed");
  const again = events.length;
  await planner.proceed(ws, { id: plan.id, policy: {} });
  assert.ok(events.slice(again).some((e) => e.type === "error"), "a plan runs once");
});

test("always-proceed runs straight after planning; a failed task is reported", async () => {
  const { planner, ws, events } = harness({ edits: { "public/index.html": "not applied (1 of 1 change(s) did not match the file)" } });
  await planner.startPlan(ws, { message: "theme", dir: "/w", model: "groq:x", container: "c1", policy: { review: "always", terminal: "always" } });
  const walk = events.find((e) => e.kind === "walkthrough").walkthrough;
  assert.deepEqual(walk.tasks.map((t) => t.status), ["done", "failed"]);
  assert.match(walk.tasks[1].note, /did not match/);
});

test("a command waits for approval, and Stop declines it", async () => {
  const { planner, ws, events } = harness();
  await planner.startPlan(ws, { message: "theme", dir: "/w", model: "groq:x", container: "c1", policy: { review: "request" } });
  const plan = events.find((e) => e.kind === "plan");
  const run = planner.proceed(ws, { id: plan.id, policy: { terminal: "request" } });
  for (let i = 0; i < 50 && !events.some((e) => e.type === "command_request"); i++) await new Promise((r) => setTimeout(r, 5));
  const req = events.find((e) => e.type === "command_request");
  assert.equal(req.command, "npm run build");
  planner.stop(ws);
  await run;
  const walk = events.find((e) => e.kind === "walkthrough").walkthrough;
  assert.equal(walk.verification[0].status, "skipped");
});

test("review comments produce a revised plan version", async () => {
  const { planner, ws, events } = harness();
  await planner.startPlan(ws, { message: "theme", dir: "/w", model: "groq:x", container: "c1", policy: {} });
  const plan = events.find((e) => e.kind === "plan");
  await planner.revise(ws, { id: plan.id, comments: [{ anchor: "Summary", text: "use a softer pink" }], policy: {} });
  const versions = events.filter((e) => e.kind === "plan").map((e) => e.version);
  assert.deepEqual(versions, [1, 2]);
});

test("tasks on the same file merge, and look-only tasks are dropped", () => {
  const { planner } = harness();
  const p = planner.normalisePlan({ title: "t", tasks: [
    { title: "Locate purple hex codes", files: ["a.css"] }, { title: "Swap background", files: ["a.css"] },
    { title: "Swap buttons", files: ["a.css"] }, { title: "Add footer", files: ["index.html"] },
  ] }, "m", []);
  assert.deepEqual(p.tasks.map((t) => t.files[0]), ["a.css", "index.html"]);
  assert.equal(p.tasks[0].title, "Swap background; Swap buttons");
});

test("a verification command the team's guardrails refuse is not run", async () => {
  const events = [];
  const ws = { send: (s) => events.push(JSON.parse(s)) };
  let ran = false;
  const planner = createPlanner({
    collectTurn: async () => ({ text: JSON.stringify({ title: "t", tasks: [{ title: "x", files: ["a.css"] }], verification: [{ kind: "command", text: "check", command: "npm run build" }] }) }),
    parseJsonLoose: (t) => JSON.parse(t),
    gatherEditFiles: async () => [],
    runEditPipeline: async () => ({ ok: true, results: [{ path: "a.css", status: "edited" }] }),
    hostExec: async () => { ran = true; return { exitCode: 0, output: "" }; },
    readFileCapped: () => "",
    outputBudget: () => 1000,
    checkCommand: () => ({ blocked: [{ hook: "no-exfil", reason: "network" }], warnings: [] }),
  });
  await planner.startPlan(ws, { message: "m", dir: "/w", model: "groq:x", container: "c1", policy: { review: "always", terminal: "always" } });
  const walk = events.find((e) => e.kind === "walkthrough").walkthrough;
  assert.equal(walk.verification[0].status, "blocked");
  assert.equal(ran, false);
});
