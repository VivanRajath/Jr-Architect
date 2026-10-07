// Planning mode, after Google Antigravity: research, an Implementation Plan and Task List to review, execution task by task, verification, and a Walkthrough.
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";

const MAX_TASKS = 8;
const MAX_FILES_PER_TASK = 3;
const PLAN_CONTEXT_CHARS = 14000;
const COMMAND_WAIT_MS = 10 * 60 * 1000;
// Verification commands are short checks, never installs or anything destructive.
const SAFE_COMMAND = /^(?!.*(?:\brm\s+-rf\b|\bsudo\b|>\s*\/|\bcurl\b.*\|\s*sh|\bmkfs\b|\bdd\s+if=|:\(\)\s*\{))[\w@./:= ,'"()\-+*?[\]$&|;<>]{1,300}$/;

const newId = (p) => `${p}-${randomBytes(5).toString("hex")}`;

export function createPlanner(deps) {
  const { collectTurn, parseJsonLoose, gatherEditFiles, runEditPipeline, hostExec, readFileCapped, outputBudget } = deps;
  // planId → { plan, message, model, dir, container, version, status }
  const plans = new Map();

  const send = (ws, obj) => { try { ws.send(JSON.stringify(obj)); } catch { /* socket gone */ } };

  function repoOverview(dir) {
    const overview = join(dir, "knowledge", "overview.md");
    return existsSync(overview) ? readFileCapped(overview, 2500) : "";
  }

  function planPrompt(message, files, overview, previous, comments) {
    const fileBlocks = files.map((f) => `=== ${f.path} ===\n${f.content}`).join("\n\n");
    const revise = previous
      ? `\nThis is a REVISION. The previous plan was:\n${JSON.stringify(previous)}\n\nThe user reviewed it and left these comments; address every one:\n${comments.map((c) => `- on "${c.anchor || "the plan"}": ${c.text}`).join("\n")}\n`
      : "";
    return (
      `You are the planning layer of a coding agent, working like Google Antigravity's Planning mode. ` +
      `Read the request and the project files, then write an implementation plan the user will review before any code changes.\n\n` +
      (overview ? `Project overview:\n${overview}\n\n` : "") +
      `Relevant files:\n${fileBlocks || "(none found)"}\n` +
      revise +
      `\nReply with ONLY one JSON object, no prose, in this shape:\n` +
      `{"title": "short title of the change",\n` +
      ` "summary": "2-3 sentences: what will change and why",\n` +
      ` "changes": [{"file": "relative/path", "action": "modify|new|delete", "what": "the concrete change in this file"}],\n` +
      ` "tasks": [{"title": "one concrete step", "files": ["relative/path"]}],\n` +
      ` "verification": [{"kind": "command|manual", "text": "what to check", "command": "a short read-only check, e.g. npm run build, only when kind is command"}],\n` +
      ` "questions": ["only if something is genuinely ambiguous"]}\n\n` +
      `Rules: use real paths from the files above (or new paths for new files); at most ${MAX_TASKS} tasks; each task touches at most ${MAX_FILES_PER_TASK} files; ` +
      `every task must CHANGE files (never "locate", "review" or "check" tasks; checks go in verification); put all changes to the same file in ONE task; a small request is usually 1-2 tasks; ` +
      `order tasks so each builds on the last; keep scope to exactly what was asked; for colour or theme changes, change stylesheet variables and colour values.\n\n` +
      `Request: ${message}`
    );
  }

  // Keeps only what the executor can act on, so a sloppy plan can never write outside the task's files.
  function normalisePlan(raw, message, fallbackFiles) {
    const clean = (s, n = 400) => String(s || "").replace(/\s+/g, " ").trim().slice(0, n);
    const okPath = (p) => typeof p === "string" && p && !p.startsWith("/") && !p.includes("..") && p.length < 200;
    const plan = {
      title: clean(raw && raw.title, 120) || clean(message, 120),
      summary: clean(raw && raw.summary, 800),
      changes: [], tasks: [], verification: [], questions: [],
    };
    for (const c of (raw && raw.changes) || []) {
      if (!okPath(c.file)) continue;
      const action = ["modify", "new", "delete"].includes(c.action) ? c.action : "modify";
      plan.changes.push({ file: c.file.replace(/^\.\//, ""), action, what: clean(c.what) });
    }
    for (const t of ((raw && raw.tasks) || []).slice(0, MAX_TASKS)) {
      const files = (t.files || []).filter(okPath).map((p) => p.replace(/^\.\//, "")).slice(0, MAX_FILES_PER_TASK);
      if (!clean(t.title)) continue;
      plan.tasks.push({ id: newId("t"), title: clean(t.title, 200), files, status: "pending" });
    }
    for (const v of ((raw && raw.verification) || []).slice(0, 4)) {
      const command = v.kind === "command" && SAFE_COMMAND.test(String(v.command || "").trim()) ? String(v.command).trim() : "";
      plan.verification.push({ id: newId("v"), kind: command ? "command" : "manual", text: clean(v.text, 300), command, status: "pending" });
    }
    plan.questions = ((raw && raw.questions) || []).map((q) => clean(q, 300)).filter(Boolean).slice(0, 4);
    // Look-only tasks change nothing, and tasks on exactly the same files become one, so a one-file change costs one model call.
    const doing = plan.tasks.filter((t) => !(t.files.length && /^(locate|find|review|check|inspect|identify|verify|test)\b/i.test(t.title)));
    const merged = [];
    for (const t of doing.length ? doing : plan.tasks.slice(0, 1)) {
      const key = [...t.files].sort().join("|");
      const same = key && merged.find((m) => [...m.files].sort().join("|") === key);
      if (same) same.title = `${same.title}; ${t.title}`.slice(0, 400);
      else merged.push(t);
    }
    plan.tasks = merged;
    // A plan the model could not structure still gets one task, so the request is never dropped.
    if (!plan.tasks.length) {
      const files = plan.changes.map((c) => c.file).slice(0, MAX_FILES_PER_TASK);
      plan.tasks.push({ id: newId("t"), title: plan.title, files: files.length ? files : fallbackFiles.slice(0, 2), status: "pending" });
    }
    return plan;
  }

  async function draftPlan({ message, dir, model, previous, comments, onStep }) {
    onStep("Research", "reading the project");
    const gathered = await gatherEditFiles(dir, message);
    let budget = PLAN_CONTEXT_CHARS;
    const files = [];
    for (const f of gathered) {
      if (budget <= 0) break;
      const content = f.content.slice(0, Math.min(budget, 6000));
      budget -= content.length;
      files.push({ path: f.path, content });
    }
    onStep("Research", `${files.length} file(s): ${files.map((f) => f.path).join(", ") || "none"}`);
    onStep("Planner", previous ? "revising the plan from your comments" : "writing the implementation plan");
    const prompt = planPrompt(message, files, repoOverview(dir), previous, comments || []);
    const { text, error } = await collectTurn({
      prompt, dir, model, replaceBuiltinTools: true, allowedTools: [],
      constraints: { maxTokens: outputBudget(model, prompt) },
    }, model);
    if (!text && error) throw new Error(error);
    return normalisePlan(parseJsonLoose(text), message, files.map((f) => f.path));
  }

  // Chat in Planning mode: plan, then wait for review unless the policy says always proceed.
  async function startPlan(ws, { message, dir, model, container, policy }) {
    const step = (n, d) => send(ws, { type: "tool", content: `${n}(${d})` });
    let plan;
    try {
      plan = await draftPlan({ message, dir, model, onStep: step });
    } catch (e) {
      send(ws, { type: "error", content: `Planning failed: ${e.message}` });
      send(ws, { type: "complete", content: "" });
      return;
    }
    const id = newId("plan");
    const entry = { id, plan, message, model, dir, container, version: 1, status: "review" };
    plans.set(id, entry);
    send(ws, { type: "artifact", kind: "plan", id, version: 1, plan });
    send(ws, { type: "artifact", kind: "tasks", id, tasks: plan.tasks });
    if (policy && policy.review === "always") {
      await execute(ws, entry, policy);
      return;
    }
    send(ws, { type: "awaiting_review", id });
    send(ws, { type: "complete", content: "" });
  }

  async function revise(ws, { id, comments, policy }) {
    const entry = plans.get(id);
    if (!entry || entry.status !== "review") {
      send(ws, { type: "error", content: "That plan is no longer open for review." });
      send(ws, { type: "complete", content: "" });
      return;
    }
    const step = (n, d) => send(ws, { type: "tool", content: `${n}(${d})` });
    try {
      entry.plan = await draftPlan({ message: entry.message, dir: entry.dir, model: entry.model, previous: entry.plan, comments, onStep: step });
    } catch (e) {
      send(ws, { type: "error", content: `Revising the plan failed: ${e.message}` });
      send(ws, { type: "complete", content: "" });
      return;
    }
    entry.version++;
    send(ws, { type: "artifact", kind: "plan", id, version: entry.version, plan: entry.plan });
    send(ws, { type: "artifact", kind: "tasks", id, tasks: entry.plan.tasks });
    if (policy && policy.review === "always") {
      await execute(ws, entry, policy);
      return;
    }
    send(ws, { type: "awaiting_review", id });
    send(ws, { type: "complete", content: "" });
  }

  async function proceed(ws, { id, policy }) {
    const entry = plans.get(id);
    if (!entry || entry.status !== "review") {
      send(ws, { type: "error", content: "That plan was already run or has expired." });
      send(ws, { type: "complete", content: "" });
      return;
    }
    await execute(ws, entry, policy || {});
  }

  // Runs each task through the edit pipeline restricted to its files, then the verification, then writes the walkthrough.
  async function execute(ws, entry, policy) {
    entry.status = "running";
    entry.cancelled = false;
    ws.__jrRunning = entry;
    const { plan } = entry;
    const changed = [];
    const updateTasks = () => send(ws, { type: "artifact_update", kind: "tasks", id: entry.id, tasks: plan.tasks });
    const contextFor = (task) => {
      const notes = plan.changes.filter((c) => task.files.includes(c.file)).map((c) => `- ${c.file} (${c.action}): ${c.what}`).join("\n");
      return `${entry.message}\n\nYou are carrying out one step of an approved plan ("${plan.title}").\nThis step: ${task.title}\n${notes ? `Planned changes for these files:\n${notes}\n` : ""}Make only this step's changes.`;
    };

    for (const task of plan.tasks) {
      if (entry.cancelled) { task.status = "skipped"; continue; }
      task.status = "running";
      updateTasks();
      try {
        const out = await runEditPipeline(entry.dir, contextFor(task), entry.model, (n, d) => send(ws, { type: "tool", content: `${n}(${d})` }), entry.container, { files: task.files });
        const results = (out && out.results) || [];
        const ok = results.some((r) => r.status === "edited" || r.status === "created");
        task.status = ok ? "done" : "failed";
        task.note = ok ? "" : (out && out.reason === "no-blocks" ? "the model returned no edit" : results.map((r) => `${r.path}: ${r.status}`).join("; ") || (out && out.error) || out.reason || "nothing changed");
        if (results.length) {
          send(ws, { type: "file_changed", content: "" });
          send(ws, { type: "edit_summary", files: results.map((r) => ({ path: r.path, status: r.status, before: r.before ?? null, after: r.after ?? null, denial: r.denial ?? null, proposed: r.proposed ?? null })) });
        }
        for (const r of results) if (r.status === "edited" || r.status === "created") changed.push({ path: r.path, status: r.status, task: task.title });
      } catch (e) {
        task.status = "failed";
        task.note = e.message;
      }
      updateTasks();
    }

    for (const v of plan.verification) {
      if (entry.cancelled) { v.status = "skipped"; continue; }
      // Without a running sandbox there is nowhere to run a check, so it becomes one for the user.
      if (v.kind !== "command" || !entry.container) { v.status = "manual"; continue; }
      let approved = policy.terminal === "always";
      if (!approved) {
        v.status = "awaiting";
        send(ws, { type: "command_request", id: v.id, planId: entry.id, command: v.command, why: v.text });
        approved = await waitForDecision(ws, v.id);
      }
      if (!approved) { v.status = "skipped"; continue; }
      // The team's command guardrails apply to verification too; a checkpoint counts as approved here because the user just approved it.
      const guard = deps.checkCommand ? deps.checkCommand(entry.dir, v.command) : null;
      if (guard && guard.blocked.length) {
        v.status = "blocked";
        v.output = guard.blocked.map((b) => `${b.hook}: ${b.reason}`).join("\n");
        send(ws, { type: "command_result", id: v.id, status: v.status, output: v.output });
        continue;
      }
      send(ws, { type: "tool", content: `Verify(${v.command})` });
      try {
        const r = await hostExec(entry.container, v.command, 180000);
        v.status = r.exitCode === 0 && !r.timedOut ? "passed" : "failed";
        v.output = String(r.output || "").slice(-1500);
      } catch (e) {
        v.status = "failed";
        v.output = e.message;
      }
      send(ws, { type: "command_result", id: v.id, status: v.status, output: v.output });
    }

    entry.status = entry.cancelled ? "stopped" : "done";
    ws.__jrRunning = null;
    send(ws, {
      type: "artifact", kind: "walkthrough", id: entry.id,
      walkthrough: {
        title: plan.title, summary: plan.summary, stopped: !!entry.cancelled,
        tasks: plan.tasks.map((t) => ({ title: t.title, status: t.status, note: t.note || "" })),
        changed, verification: plan.verification.map((v) => ({ text: v.text, command: v.command, status: v.status, output: v.output || "" })),
      },
    });
    send(ws, { type: "complete", content: "" });
  }

  const pending = new WeakMap();
  function waitForDecision(ws, id) {
    return new Promise((resolve) => {
      const map = pending.get(ws) || new Map();
      pending.set(ws, map);
      const timer = setTimeout(() => { map.delete(id); resolve(false); }, COMMAND_WAIT_MS);
      map.set(id, (ok) => { clearTimeout(timer); map.delete(id); resolve(!!ok); });
    });
  }

  // Any caller holding a connection can ask the user about one command; the answer is keyed to this connection and id only.
  function requestApproval(ws, command, why) {
    const id = "c-" + randomBytes(6).toString("hex");
    send(ws, { type: "command_request", id, command, why });
    return waitForDecision(ws, id).then((approved) => ({ id, approved }));
  }

  function decide(ws, { id, approved }) {
    const fn = pending.get(ws) && pending.get(ws).get(id);
    if (fn) fn(approved);
  }

  // Stop: the current task finishes, the rest are skipped, and any command waiting for approval is declined.
  function stop(ws) {
    if (ws.__jrRunning) ws.__jrRunning.cancelled = true;
    const map = pending.get(ws);
    if (map) for (const fn of [...map.values()]) fn(false);
  }

  return { startPlan, revise, proceed, decide, stop, requestApproval, normalisePlan, _plans: plans };
}
