// OpenGAP for the IDE: a repo's .gitagent/ team (agents/*/SOUL.md + RULES.md, hooks/*.yaml, DUTIES.md, agent.yaml) managed and run here.
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, rmSync, statSync, mkdtempSync } from "node:fs";
import { join, dirname, basename, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";
import { readAgents, escalatesTo, escalationCycle, buildFixer, ownsPath, frontMatter, findAgent } from "./agents.js";
import { loadHooks, hookFiles, checkEdit, checkCommand } from "./hooks.js";
import { newLedger, reconcile, compile } from "./context.js";
import { parseYaml } from "./yaml.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const TEMPLATES = join(HERE, "templates");
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const SEALED = ["secret-scan", "no-force-push", "protected-read", "no-sudo"];
const MAX_HOPS = 6;

export const gitagentDir = (dir) => join(dir, ".gitagent");

function readText(p, max = 200000) {
  try { const s = readFileSync(p, "utf8"); return s.length > max ? s.slice(0, max) : s; } catch { return ""; }
}

function writeText(p, content) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content.endsWith("\n") ? content : content + "\n");
}

// The manifest's OpenGAP blocks; a file that does not parse is reported, and defaults apply.
export function readManifest(dir) {
  const file = join(gitagentDir(dir), "agent.yaml");
  const out = { routing: { entry: "auto", default_attempts: 2, classifier_confidence_floor: 0.6, context_budget: 6000 }, tiers: {}, error: null };
  if (!existsSync(file)) return out;
  try {
    const doc = parseYaml(readText(file), "agent.yaml") || {};
    Object.assign(out.routing, doc.routing || {});
    out.tiers = doc.tiers && typeof doc.tiers === "object" ? doc.tiers : {};
  } catch (e) {
    out.error = e.message;
  }
  return out;
}

// Sets routing.<key> in agent.yaml, adding the block when it is missing and keeping everything else as written.
export function setRouting(dir, key, value) {
  if (!["entry", "default_attempts", "classifier_confidence_floor", "context_budget"].includes(key)) throw new Error("unknown routing setting");
  const file = join(gitagentDir(dir), "agent.yaml");
  let text = readText(file);
  const line = `  ${key}: ${value}`;
  if (!/^routing:\s*$/m.test(text)) {
    text = text.replace(/\s*$/, "\n\nrouting:\n") + line + "\n";
  } else {
    const lines = text.split("\n");
    const start = lines.findIndex((l) => /^routing:\s*$/.test(l));
    let end = start + 1;
    while (end < lines.length && (/^\s+/.test(lines[end]) || lines[end] === "")) end++;
    const at = lines.slice(start + 1, end).findIndex((l) => new RegExp(`^\\s+${key}:`).test(l));
    if (at >= 0) lines[start + 1 + at] = line;
    else lines.splice(start + 1, 0, line);
    text = lines.join("\n");
  }
  writeText(file, text);
  return readManifest(dir);
}

// Per-agent model from tiers:, as "provider:name"; null means the caller's default.
export function agentModel(manifest, name) {
  const t = manifest.tiers && manifest.tiers[name];
  const m = t && t.model;
  if (!m) return null;
  if (typeof m === "string") return m.includes(":") ? m : null;
  if (m.provider && m.name) return `${m.provider === "gemini" ? "google" : m.provider}:${m.name}`;
  return null;
}

function agentDetail(dir, a, manifest) {
  const soul = readText(join(a.dir, "SOUL.md"));
  const { meta, body } = frontMatter(soul);
  return {
    name: a.name, role: a.role, priority: a.priority, parallel: a.parallel, owns: a.owns,
    escalatesTo: a.escalatesTo, terminal: a.terminal, fixesBuild: a.fixesBuild, attempts: a.attempts,
    hasRules: a.hasRules, model: agentModel(manifest, a.name),
    source: readText(join(a.dir, ".source")).trim() || null,
    soulPath: `.gitagent/agents/${a.name}/SOUL.md`, rulesPath: `.gitagent/agents/${a.name}/RULES.md`,
    soulBody: body.trim().slice(0, 4000), rules: readText(join(a.dir, "RULES.md")).trim().slice(0, 4000),
    declaredModel: Boolean(meta.model),
    successor: escalatesToSafe(a, dir),
  };
}

function escalatesToSafe(a, dir) {
  try { return escalatesTo(a, readAgents(gitagentDir(dir))); } catch { return null; }
}

function hooksSummary(dir) {
  const gdir = gitagentDir(dir);
  let set;
  try { set = loadHooks(gdir, { reload: true }); } catch (e) { return { error: e.message, files: hookFiles(gdir).map((f) => relative(dir, f).split(sep).join("/")), hooks: [] }; }
  const hooks = [];
  for (const phase of ["pre_edit", "pre_command", "pre_commit", "post_run"]) {
    for (const [name, h] of Object.entries(set[phase] || {})) {
      hooks.push({
        phase, name, severity: h.severity || "block", sealed: SEALED.includes(name), enabled: h.enabled !== false,
        overridable: SEALED.includes(name) ? false : h.overridable !== false, description: h.description || "",
        paths: h.paths || [], commands: h.commands || [], appliesTo: h.applies_to || [], allow: h.allow || [], deny: h.deny || [],
        maxLines: h.max_lines || null,
      });
    }
  }
  return { files: set.files.map((f) => relative(dir, f).split(sep).join("/")), notes: set.notes, hooks, error: null };
}

// What /check finds: mistakes that would otherwise fail silently mid-run.
export function check(dir) {
  const gdir = gitagentDir(dir);
  const problems = [];
  const agents = readAgents(gdir);
  const manifest = readManifest(dir);
  if (manifest.error) problems.push({ level: "error", where: ".gitagent/agent.yaml", what: `does not parse: ${manifest.error}` });
  if (!agents.length) problems.push({ level: "info", where: ".gitagent/agents/", what: "no agents installed yet" });
  for (const a of agents) {
    const where = `agents/${a.name}/SOUL.md`;
    if (!a.role) problems.push({ level: "warn", where, what: "has no role in its front matter, so the router cannot tell what it is for" });
    if (a.escalatesTo && !findAgent(a.escalatesTo, agents)) problems.push({ level: "error", where, what: `escalates to "${a.escalatesTo}", which is not installed` });
    if (!a.hasRules) problems.push({ level: "warn", where: `agents/${a.name}/`, what: "has no RULES.md" });
    const { meta } = frontMatter(readText(join(a.dir, "SOUL.md")));
    if (meta.model) problems.push({ level: "warn", where, what: "declares a model; agents cannot choose their model, so it is ignored (set tiers in agent.yaml)" });
  }
  const cycle = escalationCycle(agents);
  if (cycle) problems.push({ level: "error", where: "escalation", what: `${cycle.join(" → ")} → ${cycle[0]} hands work round in a circle; mark one of them terminal: true` });
  if (agents.length && !agents.some((a) => a.terminal) && !cycle) problems.push({ level: "info", where: "escalation", what: "no agent is terminal; the last one by priority stops and asks you" });
  const entry = manifest.routing.entry;
  if (entry && entry !== "auto" && !findAgent(entry, agents)) problems.push({ level: "error", where: "agent.yaml routing.entry", what: `pins every task to "${entry}", which is not installed` });
  const hs = hooksSummary(dir);
  if (hs.error) problems.push({ level: "error", where: "hooks/", what: `a guard file does not parse, so runs stop: ${hs.error}` });
  for (const f of hookFiles(gdir)) {
    if (/TODO/.test(readText(f))) problems.push({ level: "warn", where: relative(dir, f).split(sep).join("/"), what: "still contains TODOs; a placeholder guard protects nothing" });
  }
  for (const h of hs.hooks) {
    if (!h.sealed && !["protected-paths", "diff-ceiling", "scope-fence", "build-gate", "no-exfil", "destructive", "dep-change", "session-summary"].includes(h.name)
      && !h.paths.length && !h.commands.length) {
      problems.push({ level: "warn", where: `hooks · ${h.name}`, what: "declares no paths or commands, so it never fires" });
    }
    for (const t of h.appliesTo) if (!findAgent(t, agents)) problems.push({ level: "warn", where: `hooks · ${h.name}`, what: `applies to "${t}", which is not installed` });
  }
  return problems;
}

export function status(dir) {
  const gdir = gitagentDir(dir);
  const agents = readAgents(gdir);
  const manifest = readManifest(dir);
  return {
    installed: agents.length > 0,
    agents: agents.map((a) => agentDetail(dir, a, manifest)),
    routing: manifest.routing, tiers: manifest.tiers,
    duties: readText(join(gdir, "DUTIES.md")).slice(0, 20000),
    guards: hooksSummary(dir),
    problems: check(dir),
    buildFixer: (buildFixer(agents) || {}).name || null,
  };
}

// Scaffolds the default team, duties and guards; never overwrites what the user already has.
export function init(dir) {
  const gdir = gitagentDir(dir);
  const wrote = [];
  const copy = (src, dest) => {
    if (existsSync(dest)) return;
    writeText(dest, readText(src));
    wrote.push(relative(dir, dest).split(sep).join("/"));
  };
  for (const a of readdirSync(join(TEMPLATES, "agents"))) {
    for (const f of ["SOUL.md", "RULES.md"]) copy(join(TEMPLATES, "agents", a, f), join(gdir, "agents", a, f));
  }
  copy(join(TEMPLATES, "DUTIES.md"), join(gdir, "DUTIES.md"));
  copy(join(TEMPLATES, "hooks", "hooks.yaml"), join(gdir, "hooks", "hooks.yaml"));
  if (!/^routing:/m.test(readText(join(gdir, "agent.yaml")))) {
    setRouting(dir, "entry", "auto");
    setRouting(dir, "default_attempts", 2);
    setRouting(dir, "classifier_confidence_floor", 0.6);
    setRouting(dir, "context_budget", 6000);
    wrote.push(".gitagent/agent.yaml (routing)");
  }
  return wrote;
}

const yamlList = (xs) => `[${xs.map((x) => JSON.stringify(String(x))).join(", ")}]`;

// Writes an agent folder from the form: front matter is generated here, so a bad value can never break the file.
export function saveAgent(dir, spec) {
  const name = String(spec.name || "").trim().toLowerCase();
  if (!NAME_RE.test(name)) throw new Error("use lowercase letters, numbers and dashes for the agent name");
  const adir = join(gitagentDir(dir), "agents", name);
  const owns = (spec.owns || []).map((g) => String(g).trim()).filter(Boolean).slice(0, 30);
  const lines = ["---", `name: ${name}`, `role: ${JSON.stringify(String(spec.role || "").slice(0, 200))}`, `priority: ${Math.max(0, Math.min(999, Number(spec.priority) || 50))}`];
  if (owns.length) lines.push(`owns: ${yamlList(owns)}`);
  lines.push(`parallel: ${spec.parallel === true}`);
  if (spec.terminal) lines.push("terminal: true");
  else if (spec.escalatesTo && NAME_RE.test(spec.escalatesTo)) lines.push(`escalates_to: ${spec.escalatesTo}`);
  if (spec.fixesBuild) lines.push("fixes_build: true");
  if (spec.attempts) lines.push(`attempts: ${Math.max(1, Math.min(5, Number(spec.attempts) || 2))}`);
  lines.push("---", "");
  const body = String(spec.soulBody || `# ${name}\n\n${spec.role || ""}`).replace(/^---[\s\S]*?---\s*/, "").trim();
  writeText(join(adir, "SOUL.md"), lines.join("\n") + body + "\n");
  if (spec.rules != null) writeText(join(adir, "RULES.md"), String(spec.rules).trim() || `# Rules — ${name}\n\n## Must\n\n## Must not\n`);
  else if (!existsSync(join(adir, "RULES.md"))) writeText(join(adir, "RULES.md"), `# Rules — ${name}\n\n## Must\n\n- Keep changes to what was asked.\n\n## Must not\n\n- Touch files outside its scope.\n`);
  return name;
}

export function deleteAgent(dir, name) {
  if (!NAME_RE.test(name)) throw new Error("not an agent name");
  const adir = join(gitagentDir(dir), "agents", name);
  if (!existsSync(adir)) throw new Error("no such agent");
  rmSync(adir, { recursive: true, force: true });
}

// Files the panel may edit directly; guard YAML must parse before it is saved.
export function saveFile(dir, rel, content) {
  const ok = /^(DUTIES\.md|hooks\/[a-z0-9._-]+\.ya?ml|agents\/[a-z0-9-]+\/(SOUL|RULES)\.md)$/.test(rel);
  if (!ok) throw new Error("that file is not part of the OpenGAP folder");
  if (/\.ya?ml$/.test(rel)) {
    const doc = parseYaml(String(content), rel);
    if (doc && (typeof doc !== "object" || Array.isArray(doc))) throw new Error(`${rel}: expected a mapping of hook phases at the top level`);
  }
  writeText(join(gitagentDir(dir), ...rel.split("/")), String(content));
}

export function readFile(dir, rel) {
  if (!/^(DUTIES\.md|agent\.yaml|hooks\/[a-z0-9._-]+\.ya?ml|agents\/[a-z0-9-]+\/(SOUL|RULES)\.md)$/.test(rel)) throw new Error("that file is not part of the OpenGAP folder");
  return readText(join(gitagentDir(dir), ...rel.split("/")));
}

// Adds a guard from the panel's form to hooks/hooks.yaml (the user's own file, which loads last).
export function addGuard(dir, g) {
  const name = String(g.name || "").trim().toLowerCase();
  if (!NAME_RE.test(name) || SEALED.includes(name)) throw new Error("pick a new lowercase guard name");
  const phase = g.phase === "pre_command" ? "pre_command" : "pre_edit";
  const severity = ["block", "warn", "checkpoint"].includes(g.severity) ? g.severity : "block";
  const items = (g.items || []).map((s) => String(s).trim()).filter(Boolean).slice(0, 40);
  if (!items.length) throw new Error(phase === "pre_edit" ? "list at least one path glob" : "list at least one command");
  const block = [`  - name: ${name}`, `    description: ${JSON.stringify(String(g.description || "Added in the IDE").slice(0, 200))}`, `    severity: ${severity}`, `    overridable: true`,
    `    ${phase === "pre_edit" ? "paths" : "commands"}: ${yamlList(items)}`];
  const applies = (g.appliesTo || []).filter((n) => NAME_RE.test(n));
  if (applies.length) block.push(`    applies_to: ${yamlList(applies)}`);
  const file = join(gitagentDir(dir), "hooks", "hooks.yaml");
  let text = readText(file);
  const header = new RegExp(`^${phase}:\\s*$`, "m");
  if (header.test(text)) text = text.replace(header, `${phase}:\n${block.join("\n")}`);
  else text = text.replace(/\s*$/, `\n\n${phase}:\n${block.join("\n")}\n`);
  parseYaml(text, "hooks/hooks.yaml");
  writeText(file, text);
}

// Turns an overridable guard on or off with `enabled:`; sealed guards ignore this in the engine as well.
export function toggleGuard(dir, name, enabled) {
  if (SEALED.includes(name)) throw new Error(`${name} is sealed and cannot be switched off`);
  const file = join(gitagentDir(dir), "hooks", "hooks.yaml");
  const lines = readText(file).split("\n");
  const at = lines.findIndex((l) => new RegExp(`^\\s*-\\s*name:\\s*${name}\\s*$`).test(l));
  if (at < 0) throw new Error("that guard is not in hooks/hooks.yaml");
  const indent = (lines[at].match(/^(\s*)-/) || ["", "  "])[1] + "  ";
  let end = at + 1;
  while (end < lines.length && lines[end].startsWith(indent)) end++;
  const existing = lines.slice(at + 1, end).findIndex((l) => /^\s*enabled:/.test(l));
  if (existing >= 0) lines.splice(at + 1 + existing, 1);
  if (!enabled) lines.splice(at + 1, 0, `${indent}enabled: false`);
  const text = lines.join("\n");
  parseYaml(text, "hooks/hooks.yaml");
  writeText(file, text);
}

// Copies only Markdown and YAML from a cloned pack, so installing an agent can never bring code into the workspace.
function copyTextTree(src, dest, depth = 0) {
  if (depth > 4) return 0;
  let n = 0;
  for (const e of readdirSync(src, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    const s = join(src, e.name), d = join(dest, e.name);
    if (e.isDirectory()) n += copyTextTree(s, d, depth + 1);
    else if (/\.(md|ya?ml)$/i.test(e.name) && statSync(s).size < 200000) { writeText(d, readText(s)); n++; }
  }
  return n;
}

// Installs agents (a folder with SOUL.md, or an agents/ folder of them) and guards from a git repository.
export async function addFromGit(dir, { url, as, kind = "agent" }, gitClone) {
  if (!/^https:\/\/[\w.-]+\/[\w./-]+$/.test(String(url || ""))) throw new Error("use an https git URL");
  const tmp = mkdtempSync(join(tmpdir(), "opengap-"));
  try {
    await gitClone(url, tmp);
    const pack = parseYamlSafe(readText(join(tmp, "gitagent.yaml")));
    if (pack && (pack.model || (pack.spec && pack.spec.model))) throw new Error("this pack declares a model; an agent may not choose where your code is sent, so it was refused");
    const gdir = gitagentDir(dir);
    const installed = [];
    if (kind === "guard") {
      const from = existsSync(join(tmp, "hooks")) ? join(tmp, "hooks") : tmp;
      for (const f of readdirSync(from).filter((n) => /\.ya?ml$/i.test(n) && n !== "gitagent.yaml")) {
        const text = readText(join(from, f));
        parseYaml(text, f);
        const target = (as && NAME_RE.test(as) ? as : f.replace(/\.ya?ml$/i, "")).replace(/^hooks$/, basename(url).replace(/\.git$/, "")) + ".yaml";
        if (target === "hooks.yaml") throw new Error("a pulled guard file may not replace your own hooks.yaml");
        writeText(join(gdir, "hooks", target), text);
        installed.push(`hooks/${target}`);
      }
    } else if (existsSync(join(tmp, "SOUL.md"))) {
      const name = (as && NAME_RE.test(as) ? as : basename(url).replace(/\.git$/, "").toLowerCase().replace(/[^a-z0-9-]/g, "-")).slice(0, 40);
      copyTextTree(tmp, join(gdir, "agents", name));
      writeText(join(gdir, "agents", name, ".source"), url);
      installed.push(name);
    } else if (existsSync(join(tmp, "agents"))) {
      for (const a of readdirSync(join(tmp, "agents"), { withFileTypes: true })) {
        if (!a.isDirectory() || !NAME_RE.test(a.name) || !existsSync(join(tmp, "agents", a.name, "SOUL.md"))) continue;
        copyTextTree(join(tmp, "agents", a.name), join(gdir, "agents", a.name));
        writeText(join(gdir, "agents", a.name, ".source"), url);
        installed.push(a.name);
      }
    }
    if (!installed.length) throw new Error(kind === "guard" ? "no YAML guard files found in that repository" : "no SOUL.md found: an OpenGAP agent is a folder with SOUL.md (and RULES.md)");
    return installed;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function parseYamlSafe(text) {
  try { return text ? parseYaml(text, "gitagent.yaml") : null; } catch { return null; }
}

// The run engine. deps: gatherEditFiles, runEditPipeline, collectTurn, parseJsonLoose, parseEditBlocks, providerHasKey, outputBudget.
export function createRunner(deps) {
  const { gatherEditFiles, runEditPipeline, collectTurn, parseJsonLoose } = deps;

  function persona(dir, agent, brief) {
    const gdir = gitagentDir(dir);
    const { body } = frontMatter(readText(join(agent.dir, "SOUL.md")));
    const rules = readText(join(agent.dir, "RULES.md"));
    const duties = readText(join(gdir, "DUTIES.md"));
    return [
      `You are the "${agent.name}" agent of this repository's OpenGAP team.${agent.role ? ` Role: ${agent.role}.` : ""}`,
      body.trim().slice(0, 2500),
      rules ? `RULES (must / must not):\n${rules.trim().slice(0, 2000)}` : "",
      duties ? `TEAM DUTIES (excerpt):\n${duties.trim().slice(0, 1200)}` : "",
      brief ? `HANDOFF BRIEF — you were handed this task by another agent; read it before you start:\n${brief}` : "",
    ].filter(Boolean).join("\n\n");
  }

  async function classify(dir, agents, task, files, model) {
    const roster = agents.map((a) => `- ${a.name} (priority ${a.priority}${a.fixesBuild ? ", fixes builds" : ""}): ${a.role || "no role"}; owns ${a.owns.length ? a.owns.join(", ") : "anything"}`).join("\n");
    const prompt = `Route a coding task to one agent. Agents claim work by the SHAPE of the task, never the language of the repo; lowest priority first among those whose scope fits.\n\nAgents:\n${roster}\n\nFiles likely involved: ${files.join(", ") || "unknown"}\n\nTask: ${task}\n\nReply with only JSON: {"tier": "<agent name>", "confidence": 0.0-1.0, "reason": "one short sentence"}`;
    const { text } = await collectTurn({ prompt, dir, model, replaceBuiltinTools: true, allowedTools: [], constraints: { maxTokens: 600 } }, model);
    const out = parseJsonLoose(text) || {};
    const pick = findAgent(String(out.tier || ""), agents);
    return pick ? { agent: pick, confidence: Math.max(0, Math.min(1, Number(out.confidence) || 0)), reason: String(out.reason || "").slice(0, 200) } : null;
  }

  // Picks the first agent: @name, routing.entry, file ownership, then the classifier with its confidence floor.
  async function route(dir, agents, manifest, task, files, model) {
    // "@ui-editor make it pink" or "make it pink @ui-editor": a named, installed agent takes it without a model call.
    const at = [...task.matchAll(/(^|\s)@([a-z0-9][a-z0-9-]*)\b/g)].find((m) => findAgent(m[2], agents));
    if (at) return { agent: findAgent(at[2], agents), how: "you named it", task: task.replace(at[0], " ").replace(/\s+/g, " ").trim() };
    const entry = manifest.routing.entry;
    if (entry && entry !== "auto" && findAgent(entry, agents)) return { agent: findAgent(entry, agents), how: "routing.entry pins every task to it", task };
    const scoped = agents.filter((a) => a.owns.length);
    if (files.length) {
      const owner = scoped.find((a) => files.every((f) => ownsPath(a, f)));
      if (owner) return { agent: owner, how: `it owns ${files.join(", ")}`, task };
    }
    try {
      const c = await classify(dir, agents, task, files, model);
      if (c) {
        const floor = Number(manifest.routing.classifier_confidence_floor) || 0.6;
        if (c.confidence < floor) {
          const up = escalatesTo(c.agent, agents);
          if (up) return { agent: findAgent(up, agents), how: `classifier picked ${c.agent.name} at ${c.confidence.toFixed(2)}, under the ${floor} floor, so one step up`, task, confidence: c.confidence };
        }
        return { agent: c.agent, how: c.reason || "classifier", confidence: c.confidence, task };
      }
    } catch { /* falls through to the degraded fallback */ }
    const fallback = findAgent(manifest.routing.degraded_fallback, agents) || agents[agents.length - 1];
    return { agent: fallback, how: "could not classify; the last agent by priority takes it", task };
  }

  // One task through the team: route, attempts per agent, escalation with a compiled brief, until done or a terminal agent stops.
  async function runTask(dir, rawTask, { model, container, onStep, onEvent, files: hinted } = {}) {
    const gdir = gitagentDir(dir);
    const agents = readAgents(gdir);
    const manifest = readManifest(dir);
    const hooks = loadHooks(gdir, { reload: true });
    const emit = (e) => { if (onEvent) onEvent({ ...e, at: Date.now() }); };
    const id = `${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(2).toString("hex")}`;
    const gathered = hinted && hinted.length ? hinted : (await gatherEditFiles(dir, rawTask.replace(/(^|\s)@[a-z0-9-]+\b/g, " "))).filter((f) => f.whole).map((f) => f.path).slice(0, 4);
    const r = await route(dir, agents, manifest, rawTask, gathered, model);
    const task = r.task;
    emit({ kind: "route", agent: r.agent.name, how: r.how, confidence: r.confidence ?? null, files: gathered });
    const ledger = newLedger(task);
    const events = [];
    const record = (e) => { events.push(e); emit(e); };
    const allResults = [];
    let agent = r.agent;
    let reason = null;
    let hops = 0;
    let outcome = "stopped";
    let sealedStop = null;

    while (agent && hops < MAX_HOPS) {
      hops++;
      const attempts = agent.attempts || Number(manifest.routing.default_attempts) || 2;
      const inScope = gathered.filter((f) => ownsPath(agent, f));
      // DUTIES: a task that names a file outside the agent's scope is handed off sideways at once, not attempted.
      const namedOutside = agent.owns.length ? namedFiles(task).filter((f) => !ownsPath(agent, f)) : [];
      const offered = agent.owns.length ? inScope : gathered;
      const agentModel_ = agentModel(manifest, agent.name) || model;
      let done = false;
      if (namedOutside.length || (agent.owns.length && !offered.length && gathered.length)) {
        const outside = namedOutside.length ? namedOutside : gathered;
        reconcile(ledger, { tier: agent.name, claims: { approach: "nothing attempted: out of scope" }, observed: { reason: `${outside.join(", ")} is outside ${agent.name}'s scope (${agent.owns.join(", ")})` }, status: "handoff" });
        record({ kind: "result", agent: agent.name, attempt: 0, status: "out-of-scope", detail: `${outside.join(", ")} is outside its scope` });
      } else {
        for (let n = 1; n <= attempts && !done; n++) {
          const brief = ledger.failed.length || ledger.artifacts.length ? compile(ledger, { to: agent.name, reason, budget: Number(manifest.routing.context_budget) || 6000 }) : "";
          record({ kind: "attempt", agent: agent.name, attempt: n, of: attempts, model: agentModel_, brief: brief || null });
          const guard = (path, before, after) => {
            const v = checkEdit(path, { before, after }, agent.name, hooks);
            return { blocked: v.blocked || [], warnings: v.warnings || [] };
          };
          let out;
          try {
            out = await runEditPipeline(dir, task, agentModel_, onStep, container, { files: offered.length ? offered : undefined, persona: persona(dir, agent, brief), agentName: agent.name, guard });
          } catch (e) {
            out = { ok: false, reason: "error", error: e.message };
          }
          const results = (out && out.results) || [];
          allResults.push(...results);
          const touched = results.filter((x) => x.status === "edited" || x.status === "created").map((x) => x.path);
          const blocked = results.filter((x) => /^blocked/.test(x.status));
          if (touched.length) {
            reconcile(ledger, { tier: agent.name, claims: { completed: [{ what: task, files: touched }] }, observed: { touched }, status: "done" });
            record({ kind: "result", agent: agent.name, attempt: n, status: "done", files: touched });
            done = true;
            outcome = "done";
          } else {
            const why = blocked.length ? blocked.map((b) => b.status).join("; ") : out && out.reason === "no-blocks" ? "the model returned no edit" : out && out.error ? out.error : results.map((x) => `${x.path}: ${x.status}`).join("; ") || "nothing changed";
            reconcile(ledger, { tier: agent.name, claims: { approach: `attempt ${n}: edit ${offered.join(", ") || "the relevant files"}` }, observed: { reason: why }, status: "failed" });
            record({ kind: "result", agent: agent.name, attempt: n, status: blocked.length ? "blocked" : "failed", detail: why });
            reason = why;
            // A sealed guard refuses every agent alike, so retrying or escalating only spends tokens.
            const sealedHit = blocked.length && blocked.every((b) => SEALED.some((name) => b.status.includes(name)));
            if (sealedHit) {
              sealedStop = `a sealed guardrail refused this (${blocked.map((b) => b.status.replace(/^blocked by guardrails \(|\)$/g, "")).join(", ")}); no agent can get past it`;
              break;
            }
          }
        }
      }
      if (done) break;
      if (sealedStop) {
        record({ kind: "stop", agent: agent.name, detail: sealedStop });
        break;
      }
      const next = escalatesTo(agent, agents);
      if (!next) {
        record({ kind: "stop", agent: agent.name, detail: agent.terminal ? `${agent.name} is terminal: it stops and asks you rather than looping` : "no agent left to hand to" });
        break;
      }
      reason = `${agent.name} could not finish: ${ledger.failed.length ? ledger.failed[ledger.failed.length - 1].why : "out of scope"}`;
      const brief = compile(ledger, { to: next, reason, budget: Number(manifest.routing.context_budget) || 6000 });
      record({ kind: "handoff", from: agent.name, to: next, reason, brief });
      agent = findAgent(next, agents);
    }
    const run = { id, task, outcome, route: { agent: r.agent.name, how: r.how }, events, ledger, brief: compile(ledger, { budget: 3000 }), at: new Date().toISOString() };
    try { writeText(join(gdir, ".session", `${id}.json`), JSON.stringify(run, null, 2)); } catch { /* the record is best effort */ }
    emit({ kind: "end", outcome, id, brief: run.brief });
    return { ok: outcome === "done", results: allResults, run };
  }

  // Six checks against one agent, cheapest first; nothing is written to the repo.
  async function smoke(dir, name, model) {
    const gdir = gitagentDir(dir);
    const agents = readAgents(gdir);
    const agent = findAgent(name, agents);
    const steps = [];
    const add = (id, ok, detail) => steps.push({ id, ok, detail });
    if (!agent) { add("files", false, "not installed"); return steps; }
    const { meta } = frontMatter(readText(join(agent.dir, "SOUL.md")));
    add("files", Boolean(meta.name || agent.role), agent.role ? `SOUL.md parses · ${agent.role}` : "SOUL.md has no front matter role");
    const succ = escalatesTo(agent, agents);
    const cyc = escalationCycle(agents);
    add("routing", !(cyc && cyc.includes(agent.name)) && !(agent.escalatesTo && !findAgent(agent.escalatesTo, agents)), agent.terminal ? "terminal: stops and asks you" : succ ? `escalates to ${succ}` : "no successor");
    try { const h = loadHooks(gdir, { reload: true }); add("guards", true, `${h.files.length} guard file(s) load`); } catch (e) { add("guards", false, e.message); }
    const m = agentModel(readManifest(dir), agent.name) || model;
    const provider = String(m).split(":")[0];
    add("key", deps.providerHasKey(provider === "google" ? "gemini" : provider), `${provider} key ${deps.providerHasKey(provider === "google" ? "gemini" : provider) ? "is set" : "is missing"}`);
    try {
      const { text, error } = await collectTurn({ prompt: 'Reply with only this JSON: {"ok": true}', dir, model: m, replaceBuiltinTools: true, allowedTools: [], constraints: { maxTokens: 300 } }, m);
      add("model", Boolean(parseJsonLoose(text)), parseJsonLoose(text) ? `${m} answers JSON` : `${m}: ${error || "no JSON back"}`);
    } catch (e) { add("model", false, e.message); }
    try {
      const prompt = `${persona(dir, agent, "")}\n\nFile:\n=== FILE: demo.css ===\n.btn { color: orange; }\n=== END FILE ===\n\nReturn an EDIT block that changes orange to blue:\n=== EDIT: demo.css ===\n<<<<<<< SEARCH\n...\n=======\n...\n>>>>>>> REPLACE\n=== END EDIT ===`;
      const { text } = await collectTurn({ prompt, dir, model: m, replaceBuiltinTools: true, allowedTools: [], constraints: { maxTokens: deps.outputBudget(m, prompt) } }, m);
      const blocks = deps.parseEditBlocks(text || "");
      add("edits", blocks.length > 0, blocks.length ? "returned a valid EDIT block with the agent's real prompt" : "answered without an EDIT block; this model cannot drive the agent");
    } catch (e) { add("edits", false, e.message); }
    return steps;
  }

  return { runTask, smoke, route };
}

// Paths the task names outright, like "server.js" or "public/app.css".
function namedFiles(task) {
  return [...new Set((String(task).match(/[\w./-]+\.[a-z0-9]{1,6}\b/gi) || []).map((x) => x.replace(/^\.\//, "")).filter((x) => !/^\d+(\.\d+)+$/.test(x)))];
}

// A shell command line split into argv the way the guards expect; each && / ; / | segment is checked on its own.
export function checkCommandLine(dir, line) {
  const hooks = loadHooks(gitagentDir(dir), { reload: true });
  const blocked = [];
  const warnings = [];
  for (const segment of String(line).split(/&&|\|\||;|\|/)) {
    const argv = (segment.match(/"[^"]*"|'[^']*'|\S+/g) || []).map((t) => t.replace(/^["']|["']$/g, ""));
    if (!argv.length) continue;
    const v = checkCommand(argv, null, hooks);
    blocked.push(...(v.blocked || []));
    warnings.push(...(v.warnings || []));
  }
  return { blocked, warnings };
}

// The last runs' records, newest first, for the Runs tab.
export function listRuns(dir, limit = 15) {
  const sdir = join(gitagentDir(dir), ".session");
  if (!existsSync(sdir)) return [];
  return readdirSync(sdir).filter((f) => f.endsWith(".json")).sort().reverse().slice(0, limit).map((f) => {
    try { return JSON.parse(readText(join(sdir, f), 400000)); } catch { return null; }
  }).filter(Boolean);
}

export function installed(dir) {
  return readAgents(gitagentDir(dir)).length > 0;
}

export { compile, newLedger };
