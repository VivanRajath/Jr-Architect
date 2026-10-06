// GitAgent registry integration (https://registry.gitagent.sh, open-gitagent/registry).

import { mkdtempSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync, SAFE_GIT, isSafePath } from "./workspace-fs.js";
import { join, resolve, dirname, sep } from "node:path";
import { execFile } from "node:child_process";

export const REGISTRY_INDEX_URL =
  process.env.GITAGENT_REGISTRY_INDEX ||
  "https://raw.githubusercontent.com/open-gitagent/registry/main/index.json";

const INDEX_TTL_MS = 10 * 60 * 1000; // the index changes rarely; cache 10 min
const CLONE_TIMEOUT_MS = Number(process.env.GITAGENT_CLONE_TIMEOUT_MS) || 25000;
const PERSONA_CAP = 1600; // per-section char cap, keeps the prompt under budget

let _indexCache = null;
let _indexAt = 0;

// ── Registry index ───────────────────────────────────────────────────────────

// Fetch and cache the registry index.json. Returns [] on any failure.
export async function fetchRegistryIndex() {
  if (_indexCache && Date.now() - _indexAt < INDEX_TTL_MS) return _indexCache;
  try {
    const res = await fetch(REGISTRY_INDEX_URL, { redirect: "follow" });
    if (!res.ok) throw new Error(`index HTTP ${res.status}`);
    const json = await res.json();
    // index.json is either an array of agents or { agents: [...] }.
    const agents = Array.isArray(json) ? json : Array.isArray(json.agents) ? json.agents : [];
    _indexCache = agents;
    _indexAt = Date.now();
    return agents;
  } catch (e) {
    console.error("[gitagent] could not fetch registry index:", e.message);
    return _indexCache || [];
  }
}

// Look up an agent entry by "author/name" (or "author__name").
export function findAgent(index, ref) {
  const { author, name } = parseRef(ref);
  if (!author || !name) return null;
  const hit = index.find((a) => a.author === author && a.name === name);
  if (hit) return hit;
  return {
    author, name,
    repository: `https://github.com/${author}/${name}`,
    category: "other",
    adapters: ["system-prompt"],
    _synthetic: true,
  };
}

// "shreyas-lyzr/architect" or "shreyas-lyzr__architect" → {author, name}.
function parseRef(ref) {
  const s = String(ref || "").trim().replace(/^registry:/, "");
  const sep = s.includes("__") ? "__" : "/";
  const [author, ...rest] = s.split(sep);
  return { author: author || "", name: rest.join(sep) || "" };
}

// Preview a registry agent WITHOUT installing it.
export async function fetchAgentDetail(entry) {
  const repo = String((entry && entry.repository) || "");
  const m = repo.match(/github\.com\/([^/]+)\/([^/.]+)/);
  if (!m) return { files: {} };
  const [, owner, name] = m;
  const prefix = entry.path ? String(entry.path).replace(/^\/+|\/+$/g, "") + "/" : "";
  const want = ["SOUL.md", "RULES.md", "README.md"];
  const files = {};
  for (const branch of ["main", "master"]) {
    await Promise.all(want.map(async (f) => {
      if (files[f]) return;
      try {
        const url = `https://raw.githubusercontent.com/${owner}/${name}/${branch}/${prefix}${f}`;
        const res = await fetch(url, { redirect: "follow" });
        if (!res.ok) return;
        const text = await res.text();
        files[f] = text.length > PERSONA_CAP ? text.slice(0, PERSONA_CAP) + "\n…(truncated)" : text;
      } catch { /* offline or 404 — leave it out */ }
    }));
    if (Object.keys(files).length) break; // main worked; don't retry master
  }
  return { files };
}

// Slot classification (what a pulled agent becomes)

const DEVELOPER_CATEGORIES = new Set([
  "developer-tools", "developer", "development", "coding", "engineering",
]);

const GUARDRAIL_CATEGORIES = new Set([
  "security", "compliance", "governance", "legal", "policy", "safety",
]);

// Agents that READ the repo and write documentation rather than change code.
const KNOWLEDGE_CATEGORIES = new Set([
  "knowledge", "documentation", "docs", "research", "analysis",
]);

// Words that mean "this agent judges code" rather than "this agent writes code".
const GUARDRAIL_HINT =
  /\b(guard ?rails?|compliance|compliant|polic(?:y|ies)|auditor|governance|security|legal|licen[cs]e|regulatory|privacy|gdpr|hipaa|soc ?2|owasp|safety)\b/i;

// Words that mean "this agent explains the codebase".
const KNOWLEDGE_HINT =
  /\b(knowledge|documentation|docs?|summari[sz]e|summary|onboarding|explain|architecture|codebase map|index(?:er|ing)?|readme)\b/i;

// Decide which pipeline slot a registry entry fills.
export function classifySlot(entry) {
  const category = String((entry && entry.category) || "other").toLowerCase().trim();
  if (KNOWLEDGE_CATEGORIES.has(category)) return { slot: "knowledge", reason: `category "${category}"` };
  if (DEVELOPER_CATEGORIES.has(category)) return { slot: "developer", reason: `category "${category}"` };
  if (GUARDRAIL_CATEGORIES.has(category)) return { slot: "guardrails", reason: `category "${category}"` };

  const tags = Array.isArray(entry && entry.tags) ? entry.tags : [];
  const hay = [entry && entry.name, entry && entry.description, ...tags].filter(Boolean).join(" ");
  const kHit = hay.match(KNOWLEDGE_HINT);
  if (kHit) return { slot: "knowledge", reason: `mentions "${kHit[0].toLowerCase()}"` };
  const hit = hay.match(GUARDRAIL_HINT);
  if (hit) return { slot: "guardrails", reason: `mentions "${hit[0].toLowerCase()}"` };
  return { slot: "developer", reason: category === "other" ? "no guardrail signal" : `category "${category}"` };
}

export const KNOWLEDGE_SKILL = "knowledge-builder";

// Human labels for the three slots, in one place so the overlay docs, the index block and the panel can never disagree about what a slot is called.
export const SLOT_LABEL = {
  developer: "Developer",
  guardrails: "Guardrails",
  knowledge: "Knowledge",
};

const SLOT_BLURB = {
  developer: "Developer (rewrites the code)",
  guardrails: "Guardrails (can block an edit)",
  knowledge: "Knowledge (reads the repo at open, writes knowledge/overview.md)",
};

// ── Pipeline manifest (.gitagent/pipeline.yaml | .json, or env override) ──────

// Resolve which agents fill which slots for this workspace.
export function readPipelineManifest(dir) {
  const fromFile = readManifestFile(dir);
  if (fromFile) return fromFile;

  const dev = (process.env.GITAGENT_DEVELOPER_AGENT || "").trim();
  const guards = (process.env.GITAGENT_GUARDRAIL_AGENTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  const knowledge = (process.env.GITAGENT_KNOWLEDGE_AGENT || "").trim();
  if (!dev && !knowledge && guards.length === 0) return null;
  return { developer: dev || null, guardrails: guards, knowledge: knowledge || null, pins: {} };
}

function readManifestFile(dir) {
  const base = join(dir, ".gitagent");
  for (const f of ["pipeline.json"]) {
    const p = join(base, f);
    if (existsSync(p)) {
      try {
        const j = JSON.parse(readFileSync(p, "utf8"));
        return normalizePipeline(j.pipeline || j);
      } catch (e) { console.error("[gitagent] bad pipeline.json:", e.message); }
    }
  }
  for (const f of ["pipeline.yaml", "pipeline.yml"]) {
    const p = join(base, f);
    if (existsSync(p)) {
      try {
        return normalizePipeline(parseMiniYaml(readFileSync(p, "utf8")).pipeline || {});
      } catch (e) { console.error("[gitagent] bad pipeline.yaml:", e.message); }
    }
  }
  return null;
}

// Accept a few shapes for the developer slot: a bare ref, or {senior|architect}.
function normalizePipeline(p) {
  if (!p || typeof p !== "object") return null;
  let developer = null;
  const d = p.developer;
  if (typeof d === "string") developer = d;
  else if (d && typeof d === "object") developer = d.senior || d.architect || d.junior || null;
  const guardrails = []
    .concat(p.guardrails || [])
    .filter((x) => typeof x === "string" && !x.startsWith("builtin:"));
  const devRef = developer && !developer.startsWith("builtin:") ? developer : null;
  const k = typeof p.knowledge === "string" ? p.knowledge : null;
  const knowledge = k && !k.startsWith("builtin:") ? k : null;
  // ref -> commit sha. A manifest written before pinning existed simply has none.
  const pins = {};
  if (p.pins && typeof p.pins === "object") {
    for (const [ref, sha] of Object.entries(p.pins)) {
      if (typeof sha === "string" && /^[0-9a-f]{7,40}$/i.test(sha.trim())) pins[ref] = sha.trim();
    }
  }
  if (!devRef && !knowledge && guardrails.length === 0) return null;
  return { developer: devRef, guardrails, knowledge, pins };
}

// Minimal YAML reader for the tiny pipeline subset: nested maps, scalars, and `- ` lists (a list under a key turns that key into an array).
export function parseMiniYaml(text) {
  const root = {};
  // Each frame tracks the node plus the (parent,key) that created it, so a list item can convert an empty-value key's placeholder map into an array.
  const stack = [{ indent: -1, node: root, parent: null, key: null }];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim()) continue;
    const indent = line.length - line.trimStart().length;
    const body = line.trim();
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const top = stack[stack.length - 1];

    if (body.startsWith("- ")) {
      if (!Array.isArray(top.node)) {
        const arr = [];
        if (top.parent && top.key != null) top.parent[top.key] = arr;
        top.node = arr;
      }
      top.node.push(stripScalar(body.slice(2)));
      continue;
    }

    const m = body.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (val === "") {
      const child = {};
      top.node[key] = child;
      stack.push({ indent, node: child, parent: top.node, key });
    } else {
      top.node[key] = stripScalar(val);
    }
  }
  return root;
}

function stripScalar(s) {
  return s.replace(/^["']|["']$/g, "").trim();
}

// Write the workspace's pipeline manifest (as .gitagent/pipeline.json — the reader prefers it).
export function writePipelineManifest(dir, pipeline) {
  const base = join(dir, ".gitagent");
  const file = join(base, "pipeline.json");
  const developer = pipeline && pipeline.developer ? pipeline.developer : null;
  const knowledge = pipeline && pipeline.knowledge ? pipeline.knowledge : null;
  const guardrails = pipeline && Array.isArray(pipeline.guardrails)
    ? pipeline.guardrails.filter(Boolean) : [];
  if (!developer && !knowledge && guardrails.length === 0) {
    try { rmSync(file); } catch { /* nothing to clear */ }
    return;
  }
  mkdirSync(base, { recursive: true });
  // knowledge is written only when a community agent holds the slot; absent means the built-in knowledge-builder, which is the default.
  const p = { developer, guardrails };
  if (knowledge) p.knowledge = knowledge;
  // Drop pins for refs that left the pipeline — a commit nobody can trace back to a rule is noise.
  const live = new Set([developer, knowledge, ...guardrails].filter(Boolean));
  const pins = {};
  for (const [ref, sha] of Object.entries((pipeline && pipeline.pins) || {})) {
    if (live.has(ref) && sha) pins[ref] = sha;
  }
  if (Object.keys(pins).length) p.pins = pins;
  writeFileSync(file, JSON.stringify({ spec_version: "0.1.0", pipeline: p }, null, 2) + "\n");
}

// Put one agent into a slot, keeping the rest of the pipeline as it is.
export function assignSlot(dir, ref, slot, pin) {
  const cur = readPipelineManifest(dir) || { developer: null, guardrails: [], knowledge: null, pins: {} };
  const guardrails = (cur.guardrails || []).filter(Boolean).filter((r) => r !== ref);
  let developer = cur.developer === ref ? null : cur.developer || null;
  let knowledge = cur.knowledge === ref ? null : cur.knowledge || null;

  // The agent is out of every slot by the lines above; now put it in exactly one.
  if (slot === "guardrails") guardrails.push(ref);
  else if (slot === "knowledge") knowledge = ref;
  else developer = ref;

  const pins = { ...(cur.pins || {}) };
  if (pin) pins[ref] = pin;
  const pipeline = { developer, guardrails, knowledge, pins };
  writePipelineManifest(dir, pipeline);
  return pipeline;
}

// List agents already cloned into <workspace>/.gitagent/agents as "author/name".
export function installedAgents(dir) {
  const base = join(dir, AGENTS_DIR);
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base)
      .filter((d) => d.includes("__"))
      .map((d) => { const [a, ...r] = d.split("__"); return `${a}/${r.join("__")}`; });
  } catch { return []; }
}

// ── Install (git clone) + persona load ───────────────────────────────────────

const AGENTS_DIR = ".gitagent/agents";

function installPath(dir, entry) {
  return resolve(dir, AGENTS_DIR, `${entry.author}__${entry.name}`);
}

// Clone the agent's repo into <workspace>/.gitagent/agents/<author>__<name>.
function gitIn(cwd, args) {
  return new Promise((res, rej) => {
    execFile("git", [...SAFE_GIT, ...args], { cwd, timeout: CLONE_TIMEOUT_MS }, (err, stdout) =>
      err ? rej(err) : res(String(stdout).trim()));
  });
}

// The commit a clone landed on, "" if it can't be read.
export async function headSha(target) {
  try { return await gitIn(target, ["rev-parse", "HEAD"]); } catch { return ""; }
}

// Upstream's current HEAD, without cloning. Used to spot a pack that moved.
export async function remoteSha(repository) {
  try {
    const out = await gitIn(process.cwd(), ["ls-remote", repository, "HEAD"]);
    return (out.split(/\s+/)[0] || "").trim();
  } catch { return ""; }
}

// Clone the agent into <workspace>/.gitagent/agents/<author>__<name>, at `pin` if one is given.
export async function installAgent(dir, entry, pin) {
  const target = installPath(dir, entry);
  if (existsSync(join(target, ".git"))) {
    const at = await headSha(target);
    if (!pin || at === pin) return { path: target, sha: at };
    rmSync(target, { recursive: true, force: true });
  } else if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(resolve(dir, AGENTS_DIR), { recursive: true });
  // Checkout runs outside the bind mount, where the sandbox cannot rewrite .git/config mid-install.
  const staging = mkdtempSync(join(tmpdir(), "jr-agent-clone-"));
  const cloned = join(staging, "repo");
  try {
    await gitIn(staging, ["clone", "--depth", "1", entry.repository, cloned]);
    if (pin) {
      // A --depth 1 clone has only the tip, so an older commit has to be fetched explicitly before it can be checked out.
      await gitIn(cloned, ["fetch", "--depth", "1", "origin", pin]);
      await gitIn(cloned, ["checkout", "--detach", "FETCH_HEAD"]);
    }
    if (!isSafePath(target)) throw new Error("install path leaves the workspace");
    cpSync(cloned, target, { recursive: true, verbatimSymlinks: true });
  } catch (e) {
    rmSync(target, { recursive: true, force: true });
    throw e;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  return { path: target, sha: await headSha(target) };
}

function readCapped(abs) {
  try {
    const s = readFileSync(abs, "utf8");
    return s.length > PERSONA_CAP ? s.slice(0, PERSONA_CAP) + "\n…(truncated)" : s;
  } catch { return ""; }
}

// Load an installed agent's persona from the gitagent-standard files, honoring an optional subdir (`path` in metadata).
export function loadAgentPersona(installDir, entry) {
  const root = entry && entry.path ? join(installDir, entry.path) : installDir;
  const soul = readCapped(join(root, "SOUL.md"));
  const rules = readCapped(join(root, "RULES.md"));
  let skill = "";
  const skillsDir = join(root, "skills");
  if (existsSync(skillsDir)) {
    try {
      const first = readdirSync(skillsDir).find((d) =>
        existsSync(join(skillsDir, d, "SKILL.md")));
      if (first) skill = readCapped(join(skillsDir, first, "SKILL.md"));
    } catch { /* ignore */ }
  }
  const fallback = (!soul && !rules && !skill) ? readCapped(join(root, "README.md")) : "";
  return {
    name: entry ? `${entry.author}/${entry.name}` : "agent",
    category: entry ? entry.category : "other",
    description: (entry && entry.description) || "",
    repository: (entry && entry.repository) || "",
    soul: soul || fallback,
    rules,
    skill,
  };
}

// Repo-root spec (the repository's OWN agent)
export function loadRepoRootSpec(dir) {
  const grouped = readSpecFrom(join(dir, ".gitagent"));
  if (grouped) return grouped;
  return readSpecFrom(dir);
}

// Drop a leading `--- … ---` YAML frontmatter block so only the human body of a SKILL.md (or RULES.md) goes into the prompt.
function stripFrontmatter(t) {
  if (!t) return "";
  const m = t.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? t.slice(m[0].length) : t).trim();
}

// Load a built-in persona skill's body from the repo's own .gitagent/skills/.
export function loadSkill(dir, name) {
  return stripFrontmatter(readCapped(join(dir, ".gitagent", "skills", name, "SKILL.md")));
}

// Load the repo's OWN compliance rules from .gitagent/compliance/.
export function loadComplianceRules(dir) {
  const base = join(dir, ".gitagent", "compliance");
  const files = [];
  if (existsSync(base)) {
    try {
      files.push(...readdirSync(base)
        .filter((f) => f.endsWith(".md") && !isOverlayFile(join(base, f)))
        .sort((a, b) => (a === "RULES.md" ? -1 : b === "RULES.md" ? 1 : a.localeCompare(b))));
    } catch { /* unreadable — no compliance rules */ }
  }
  return files
    .map((f) => stripFrontmatter(readCapped(join(base, f))))
    .filter(Boolean)
    .join("\n\n");
}

// List the built-in + user-authored skills present under .gitagent/skills.
export function listSkills(dir) {
  const base = join(dir, ".gitagent", "skills");
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base).filter((d) => existsSync(join(base, d, "SKILL.md")));
  } catch { return []; }
}

// Spec authoring (the GitAgent panel's read/write surface)

// The skills scaffolded by gitagentgenerator.go.
export const BUILTIN_SKILLS = [
  "ui-editor", "jnr-developer", "snr-developer", "architect", "ask", "build-doctor",
  // The default Knowledge-slot agent. A real skill file, not a hidden prompt.
  "knowledge-builder",
];

// Files the panel may read and write. Anything under .gitagent/ with a text extension, plus the root agent.yaml the git-native runtime reads its manifest from.
const EDITABLE_EXT = /\.(md|ya?ml|json|txt)$/i;

// Resolve a caller-supplied relative path to an absolute path inside the workspace, or null if it escapes the allowed subtree.
export function resolveSpecPath(dir, rel) {
  const clean = String(rel || "").trim().replace(/\\/g, "/").replace(/^\/+/, "");
  if (!clean || clean.includes("\0") || !EDITABLE_EXT.test(clean)) return null;
  const abs = resolve(dir, clean);
  const root = resolve(dir);
  // resolve() collapses "..", so a path that escaped no longer has the root as its prefix.
  if (abs !== root && !abs.startsWith(root + sep)) return null;
  const inSpec = abs.startsWith(resolve(dir, ".gitagent") + sep);
  const isRootManifest = abs === resolve(dir, "agent.yaml");
  return inSpec || isRootManifest ? abs : null;
}

// Read a spec file. Returns { path, exists, content } — a missing file is not an error, it just means the panel offers to create it.
export function readSpecFile(dir, rel) {
  const abs = resolveSpecPath(dir, rel);
  if (!abs) return null;
  if (!existsSync(abs)) return { path: rel, exists: false, content: "" };
  return { path: rel, exists: true, content: readFileSync(abs, "utf8") };
}

// Write a spec file, creating parent directories.
export function writeSpecFile(dir, rel, content) {
  const abs = resolveSpecPath(dir, rel);
  if (!abs) throw new Error("path is not an editable part of the agent spec");
  mkdirSync(dirname(abs), { recursive: true });
  const body = String(content ?? "");
  writeFileSync(abs, body);
  const norm = String(rel).replace(/\\/g, "/");
  if (norm === ".gitagent/agent.yaml") writeFileSync(resolve(dir, "agent.yaml"), body);
  else if (norm === "agent.yaml") {
    mkdirSync(resolve(dir, ".gitagent"), { recursive: true });
    writeFileSync(resolve(dir, ".gitagent", "agent.yaml"), body);
  }
  return { path: rel, exists: true, content: body };
}

// Pull `name:`/`description:` out of a SKILL.md frontmatter block so the panel can list skills with a human summary instead of bare slugs.
export function parseFrontmatter(text) {
  const m = String(text || "").match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return {};
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (kv) out[kv[1]] = stripScalar(kv[2]);
  }
  return out;
}

// Skills with enough detail to render a list: slug, description, whether it is one of the scaffolded personas, and the path to open in the editor.
export function listSkillsDetailed(dir) {
  const base = join(dir, ".gitagent", "skills");
  return listSkills(dir).map((slug) => {
    let fm = {};
    try { fm = parseFrontmatter(readFileSync(join(base, slug, "SKILL.md"), "utf8")); }
    catch { /* unreadable — fall back to the slug alone */ }
    return {
      slug,
      description: fm.description || "",
      builtin: BUILTIN_SKILLS.includes(slug),
      // Materialized by a pulled registry agent — editable like any other skill, but owned by the pipeline slot that put it there.
      agent: fm.source === OVERLAY_SOURCE ? fm.agent || slug : "",
      path: `.gitagent/skills/${slug}/SKILL.md`,
    };
  });
}

// Remove a user-authored skill. Built-in personas are refused.
export function deleteSkill(dir, slug) {
  const clean = String(slug || "").trim();
  // One path segment, no traversal. Underscores and dots are allowed because a pulled agent's skill dir is "<author>__<name>" and repo names carry both.
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(clean) || clean.includes("..")) {
    throw new Error("invalid skill name");
  }
  if (BUILTIN_SKILLS.includes(clean)) throw new Error(`"${clean}" is a built-in persona — edit it instead of deleting it`);
  const target = join(dir, ".gitagent", "skills", clean);
  if (!existsSync(target)) throw new Error(`skill "${clean}" not found`);
  // A pulled agent's skill belongs to its pipeline slot: deleting the file alone would just have it rewritten on the next turn.
  if (isOverlayFile(join(target, "SKILL.md"))) {
    throw new Error(`"${clean}" belongs to a pulled registry agent — remove the agent from the Registry tab to drop it`);
  }
  rmSync(target, { recursive: true, force: true });
}

// Installed registry agents with the spec files each one actually ships.
export function installedAgentsDetailed(dir) {
  return installedAgents(dir).map((ref) => {
    const { author, name } = parseRef(ref);
    const relDir = `${AGENTS_DIR}/${author}__${name}`;
    const absDir = resolve(dir, relDir);
    const files = ["SOUL.md", "RULES.md", "agent.yaml", "README.md"]
      .filter((f) => existsSync(join(absDir, f)))
      .map((f) => `${relDir}/${f}`);
    return { ref, path: relDir, files };
  });
}

// The standard's full layout puts durable memory in memory/MEMORY.md.
export const MEMORY_PATHS = ["memory/MEMORY.md", "MEMORY.md"];

function readMemory(base) {
  for (const rel of MEMORY_PATHS) {
    const text = readCapped(join(base, ...rel.split("/")));
    if (text) return text;
  }
  return "";
}

// Read a gitagent spec (SOUL/RULES/MEMORY + first skill) out of one directory.
function readSpecFrom(base) {
  const soul = readCapped(join(base, "SOUL.md"));
  const rules = readCapped(join(base, "RULES.md"));
  const memory = readMemory(base);
  let skill = "";
  const skillsDir = join(base, "skills");
  if (existsSync(skillsDir)) {
    try {
      // Skip a pulled agent's overlay skill.
      const first = readdirSync(skillsDir).find((d) =>
        existsSync(join(skillsDir, d, "SKILL.md")) && !isOverlayFile(join(skillsDir, d, "SKILL.md")));
      if (first) skill = readCapped(join(skillsDir, first, "SKILL.md"));
    } catch { /* ignore */ }
  }
  if (!soul && !rules && !memory && !skill) return null;
  return { soul, rules, memory, skill };
}

// Spec overlay: a pulled agent shows up INSIDE .gitagent/

export const OVERLAY_SOURCE = "gitagent-registry-agent";
const OVERLAY_CAP = 3200; // an overlay carries several sections; cap above PERSONA_CAP
const BLOCK_START = `<!-- gitagent:pulled-agents:start — managed by Jr Architect, edited on pull/remove -->`;
const BLOCK_END = `<!-- gitagent:pulled-agents:end -->`;

function refSlug(ref) {
  const { author, name } = parseRef(ref);
  return `${author}__${name}`;
}

// Where a pulled agent's spec lands, by slot.
export function overlayPaths(ref, slot) {
  const slug = refSlug(ref);
  return {
    // Guardrails are rules, so they land in compliance/.
    spec: slot === "guardrails"
      ? `.gitagent/compliance/${slug}.md`
      : `.gitagent/skills/${slug}/SKILL.md`,
    workflow: `.gitagent/workflows/${slug}.md`,
  };
}

function absOf(dir, rel) {
  return join(dir, ...rel.split("/"));
}

// True if this file was written by the overlay (frontmatter carries our source marker).
function isOverlayFile(abs) {
  try {
    return parseFrontmatter(readFileSync(abs, "utf8")).source === OVERLAY_SOURCE;
  } catch { return false; }
}

function overlayFrontmatter(ref, slot, description) {
  return [
    "---",
    `name: ${refSlug(ref)}`,
    `description: ${String(description || "").replace(/\n/g, " ").slice(0, 200)}`,
    `agent: ${ref}`,
    `slot: ${slot}`,
    `source: ${OVERLAY_SOURCE}`,
    "---",
    "",
  ].join("\n");
}

// The Developer overlay carries the agent's WHOLE contribution.
function developerOverlayDoc(persona) {
  const ref = persona.name;
  const parts = [
    overlayFrontmatter(ref, "developer", persona.description || `Developer persona pulled from ${ref}`, persona.sha),
    `# ${ref} — Developer`,
    "",
    // A comment, not prose: readOverlayBody strips it, so this guidance never reaches the model as if it were part of the agent's persona.
    "<!--",
    "Pulled from the GitAgent registry. This file is what the Developer stage reads",
    "before it rewrites any code, so editing it changes the next edit. The upstream",
    `copy is untouched in .gitagent/agents/${refSlug(ref)}/ if you want to diff.`,
    "-->",
  ];
  if (persona.soul) parts.push("", "## Identity", "", persona.soul.trim());
  if (persona.rules) parts.push("", "## Rules", "", persona.rules.trim());
  if (persona.skill) parts.push("", "## Skill", "", persona.skill.trim());
  if (!persona.soul && !persona.rules && !persona.skill) {
    parts.push("", "## Skill", "",
      `_${ref} ships no SOUL.md, RULES.md or skills/. Write how it should code here._`);
  }
  return parts.join("\n") + "\n";
}

// The Knowledge overlay is the prompt the knowledge builder runs.
function knowledgeOverlayDoc(persona) {
  const ref = persona.name;
  const parts = [
    overlayFrontmatter(ref, "knowledge", persona.description || `Knowledge builder pulled from ${ref}`, persona.sha),
    `# ${ref} — Knowledge`,
    "",
    "<!--",
    "Pulled from the GitAgent registry and assigned to the Knowledge slot. This file",
    "is the prompt that runs once when the workspace opens, on its own dedicated API",
    "key, to write knowledge/overview.md. Editing it changes the next build — press",
    "Rebuild in the GitAgent panel to run it again without reopening the sandbox.",
    "-->",
  ];
  if (persona.soul) parts.push("", "## Identity", "", persona.soul.trim());
  if (persona.rules) parts.push("", "## Rules", "", persona.rules.trim());
  if (persona.skill) parts.push("", "## Skill", "", persona.skill.trim());
  if (!persona.soul && !persona.rules && !persona.skill) {
    parts.push("", "## Skill", "",
      `_${ref} ships no SOUL.md, RULES.md or skills/. Write what it should read and write here._`);
  }
  return parts.join("\n") + "\n";
}

// The Guardrail overlay carries the rules the review stage enforces, verbatim.
function guardrailOverlayDoc(persona) {
  const ref = persona.name;
  const body = (persona.rules || persona.soul || "").trim();
  return [
    overlayFrontmatter(ref, "guardrails", persona.description || `Guardrail rules pulled from ${ref}`, persona.sha),
    `# ${ref} — Guardrail`,
    "",
    "<!--",
    "These are the rules the Guardrails review stage enforces on every edit: each",
    "rewritten file is read against them and denied file-by-file. A deny is final —",
    "the file is not written. Edit this file and the next review uses your version.",
    "-->",
    "",
    body || `_${ref} ships no RULES.md. Write the rules it should enforce here._`,
    "",
  ].join("\n");
}

// A short doc placed in workflows/ saying where this agent runs.
function workflowOverlayDoc(persona, slot) {
  const ref = persona.name;
  const slug = refSlug(ref);
  const paths = overlayPaths(ref, slot);
  const stage = slot === "guardrails"
    ? [
        "Runs at **Guardrails (review)**. After the Developer produces the rewrite, this",
        "agent reads every changed file and answers allow/deny per file. A deny is final:",
        `the file is never written. Its rules are in \`${paths.spec}\`.`,
      ]
    : slot === "knowledge"
    ? [
        "Runs **once when the workspace opens**, before any chat turn, on a dedicated API",
        "key so it never competes with the editor for the rate limit. It reads the repo and",
        `writes \`knowledge/overview.md\`, which is then loaded into every later turn. Its`,
        `prompt is \`${paths.spec}\`. It writes only under knowledge/ — it never edits code.`,
      ]
    : [
        "Runs at **Developer**. Its identity, rules and skill are injected ahead of the",
        `rewrite — see \`${paths.spec}\`. It cannot skip the guardrail stages: the`,
        "code-level checks and any installed guardrail agent still get the last word.",
      ];
  return [
    overlayFrontmatter(ref, slot, `Where ${ref} runs in the edit pipeline`, persona.sha),
    `# ${ref} — ${SLOT_LABEL[slot] || "Developer"} stage`,
    "",
    slot === "knowledge"
      ? "Open workspace → Knowledge build → knowledge/overview.md → loaded into every later turn"
      : "Orchestrator → Classifier → Guardrails(scope) → Developer → Guardrails(apply) → Guardrails(review)",
    "",
    ...stage,
    "",
    "## Source",
    "",
    `- registry ref: \`${ref}\``,
    persona.repository ? `- repository: ${persona.repository}` : "- repository: (not in the index)",
    `- upstream clone: \`.gitagent/agents/${slug}/\``,
    `- assigned by: \`.gitagent/pipeline.json\``,
    "",
  ].join("\n");
}

// Create an overlay file only if it is absent.
function writeIfAbsent(dir, rel, content) {
  const abs = absOf(dir, rel);
  if (existsSync(abs)) return false;
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  return true;
}

// Every overlay file currently on disk, so a removed agent's files can be pruned.
function listOverlayFiles(dir) {
  const out = [];
  const scanFlat = (relDir) => {
    const base = absOf(dir, relDir);
    if (!existsSync(base)) return;
    try {
      for (const f of readdirSync(base)) {
        if (f.endsWith(".md") && isOverlayFile(join(base, f))) out.push(`${relDir}/${f}`);
      }
    } catch { /* unreadable — nothing to prune */ }
  };
  scanFlat(".gitagent/compliance");
  scanFlat(".gitagent/workflows");
  const skills = absOf(dir, ".gitagent/skills");
  if (existsSync(skills)) {
    try {
      for (const d of readdirSync(skills)) {
        const f = join(skills, d, "SKILL.md");
        if (existsSync(f) && isOverlayFile(f)) out.push(`.gitagent/skills/${d}/SKILL.md`);
      }
    } catch { /* ignore */ }
  }
  return out;
}

// Replace (or remove) the managed block in a spec file, leaving every hand-written line alone.
export function upsertManagedBlock(dir, rel, body) {
  const abs = absOf(dir, rel);
  const had = existsSync(abs);
  const current = had ? readFileSync(abs, "utf8") : "";
  const block = body ? `${BLOCK_START}\n${body.trim()}\n${BLOCK_END}` : "";
  const re = new RegExp(`\\n*${escapeRe(BLOCK_START)}[\\s\\S]*?${escapeRe(BLOCK_END)}\\n*`, "g");
  const stripped = current.replace(re, "\n\n").replace(/\n{3,}$/, "\n");
  let next;
  if (!block) next = stripped.trimEnd() + (stripped.trim() ? "\n" : "");
  else next = `${stripped.trimEnd()}${stripped.trim() ? "\n\n" : ""}${block}\n`;
  if (next === current) return false;
  if (!had && !body) return false; // nothing to write and nothing to clean up
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, next);
  return true;
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// The managed index lists what the pipeline ASSIGNS, so an agent whose clone failed this turn is still named.
function indexBlock(assigned) {
  if (!assigned.length) return "";
  const lines = [
    "## Pulled registry agents",
    "",
    "Agents pulled from the GitAgent registry that are live in this repo's pipeline.",
    "Their rules apply on top of everything above. Remove one from the Registry tab",
    "and its files below disappear with it.",
    "",
  ];
  for (const { ref, slot } of assigned) {
    const p = overlayPaths(ref, slot);
    lines.push(
      `- **${ref}** → ${SLOT_BLURB[slot] || SLOT_BLURB.developer}`,
      `  - rules in effect: \`${p.spec}\``,
      `  - where it runs: \`${p.workflow}\``,
    );
  }
  return lines.join("\n");
}

// Reconcile .gitagent/ with the resolved pipeline.
export function syncSpecOverlay(dir, agents, declared) {
  const active = [];
  if (agents && agents.developer) active.push({ persona: agents.developer, slot: "developer" });
  for (const g of (agents && agents.guardrails) || []) active.push({ persona: g, slot: "guardrails" });
  if (agents && agents.knowledge) active.push({ persona: agents.knowledge, slot: "knowledge" });

  // What holds a slot: the manifest when we were given it, otherwise whatever resolved.
  const assigned = declared || active.map((a) => ({ ref: a.persona.name, slot: a.slot }));

  const written = [];
  const removed = [];
  const keep = new Set();
  for (const { ref, slot } of assigned) {
    const p = overlayPaths(ref, slot);
    keep.add(p.spec);
    keep.add(p.workflow);
  }

  for (const { persona, slot } of active) {
    const p = overlayPaths(persona.name, slot);
    const doc = slot === "guardrails" ? guardrailOverlayDoc(persona)
      : slot === "knowledge" ? knowledgeOverlayDoc(persona)
      : developerOverlayDoc(persona);
    if (writeIfAbsent(dir, p.spec, doc)) written.push(p.spec);
    if (writeIfAbsent(dir, p.workflow, workflowOverlayDoc(persona, slot))) written.push(p.workflow);
    // The file now exists either way, so the persona can point at it — this is the path the panel links to and the developer edits.
    persona.specPath = p.spec;
    persona.workflowPath = p.workflow;
  }

  for (const stale of listOverlayFiles(dir)) {
    if (keep.has(stale)) continue;
    // A skill overlay owns its directory; the others are single files.
    const target = stale.endsWith("/SKILL.md")
      ? absOf(dir, stale.slice(0, -"/SKILL.md".length))
      : absOf(dir, stale);
    try { rmSync(target, { recursive: true, force: true }); removed.push(stale); }
    catch { /* already gone */ }
  }

  const block = indexBlock(assigned);
  for (const rel of [".gitagent/RULES.md", ".gitagent/workflows/README.md"]) {
    try { if (upsertManagedBlock(dir, rel, block)) written.push(rel); }
    catch { /* a read-only spec file is not worth failing a pull over */ }
  }
  return { written, removed };
}

// Read an overlay's body (frontmatter stripped).
export function readOverlayBody(dir, ref, slot) {
  const abs = absOf(dir, overlayPaths(ref, slot).spec);
  if (!existsSync(abs)) return "";
  try {
    const raw = readFileSync(abs, "utf8");
    // HTML comments are the file's notes to the developer ("edit this and the next review changes").
    const body = stripFrontmatter(raw).replace(/<!--[\s\S]*?-->/g, "").replace(/\n{3,}/g, "\n\n").trim();
    return body.length > OVERLAY_CAP ? body.slice(0, OVERLAY_CAP) + "\n…(truncated)" : body;
  } catch { return ""; }
}

// Once an overlay exists it is the single authority for that agent.
function applyOverlay(dir, persona, slot) {
  const body = readOverlayBody(dir, persona.name, slot);
  if (!body) return persona;
  const p = overlayPaths(persona.name, slot);
  if (slot === "guardrails") return { ...persona, soul: "", skill: "", rules: body, specPath: p.spec };
  return { ...persona, soul: "", rules: "", skill: body, specPath: p.spec };
}

// ── Orchestration: manifest → installed, loaded personas for the pipeline ─────

// Resolve the workspace's pipeline: read the manifest, install each referenced agent (live git clone), and load its persona.
export async function resolvePipelineAgents(dir, onStep) {
  const step = (d) => { if (onStep) onStep("GitAgent", d); };

  // The repository's OWN agent (root spec) always applies, manifest or not.
  const root = loadRepoRootSpec(dir);
  if (root) step("reading repo-root spec (SOUL/RULES/SKILL/MEMORY)");

  const manifest = readPipelineManifest(dir);
  if (!manifest) {
    // No pipeline — still reconcile, so clearing the last slot takes that agent's files out of .gitagent/ instead of leaving rules behind that nothing runs.
    const none = { root, developer: null, guardrails: [], knowledge: null, enabled: !!root };
    try {
      const sync = syncSpecOverlay(dir, none, []);
      if (sync.removed.length) step(`spec pruned · ${sync.removed.join(", ")}`);
    } catch { /* nothing to prune */ }
    return none;
  }

  const index = await fetchRegistryIndex();

  const pins = manifest.pins || {};
  const install = async (ref, slot) => {
    const entry = findAgent(index, ref);
    if (!entry) { step(`skip ${ref} (not found)`); return null; }
    const pin = pins[ref] || "";
    try {
      const { path: at, sha } = await installAgent(dir, entry, pin);
      // Unpinned means "whatever upstream is today", which for a compliance pack is a rule that can change with no diff and no review.
      if (!pin) step(`${ref} is UNPINNED · running ${sha.slice(0, 7) || "unknown"}`);
      else {
        const upstream = await remoteSha(entry.repository);
        if (upstream && upstream !== pin) {
          step(`${ref} pinned ${pin.slice(0, 7)} · upstream moved to ${upstream.slice(0, 7)}`);
        }
      }
      const persona = applyOverlay(dir, loadAgentPersona(at, entry), slot);
      // The overlay in .gitagent/ wins over the clone when it exists, so a rule the developer edited there is the rule that actually runs.
      return { ...persona, sha, pin };
    } catch (e) {
      step(`skip ${ref} (${e.message})`);
      return null;
    }
  };

  let developer = null;
  if (manifest.developer) {
    step(`installing developer · ${manifest.developer}`);
    developer = await install(manifest.developer, "developer");
    if (developer) step(`developer → ${developer.name}`);
  }

  const guardrails = [];
  for (const ref of manifest.guardrails) {
    step(`installing guardrail · ${ref}`);
    const g = await install(ref, "guardrails");
    if (g) { guardrails.push(g); step(`guardrail → ${g.name}`); }
  }

  // The knowledge agent does not take part in an edit turn — it runs once at open.
  let knowledge = null;
  if (manifest.knowledge) {
    step(`installing knowledge · ${manifest.knowledge}`);
    knowledge = await install(manifest.knowledge, "knowledge");
    if (knowledge) step(`knowledge → ${knowledge.name}`);
  }

  const agents = {
    root, developer, guardrails, knowledge, pins,
    enabled: !!(root || developer || guardrails.length || knowledge),
  };

  // Reflect the pipeline into the spec folder: write what is missing, prune what left.
  const declared = [
    ...(manifest.developer ? [{ ref: manifest.developer, slot: "developer" }] : []),
    ...manifest.guardrails.map((ref) => ({ ref, slot: "guardrails" })),
    ...(manifest.knowledge ? [{ ref: manifest.knowledge, slot: "knowledge" }] : []),
  ];
  try {
    const sync = syncSpecOverlay(dir, agents, declared);
    if (sync.written.length) step(`spec updated · ${sync.written.join(", ")}`);
    if (sync.removed.length) step(`spec pruned · ${sync.removed.join(", ")}`);
  } catch (e) {
    step(`spec sync skipped (${e.message})`);
  }

  return agents;
}

// Compose the persona preamble injected ahead of the Developer prompt.
export function personaPreamble(agents) {
  if (!agents || !agents.enabled) return "";
  const parts = [];

  // (1) The repository's own agent (root spec). Read before changing anything.
  const root = agents.root;
  if (root) {
    parts.push(
      `You are this repository's own agent, defined by the gitagent spec committed ` +
      `at its root. Read it before changing anything and obey it.`,
    );
    if (root.memory) parts.push(`--- REPO MEMORY (facts about this project) ---\n${root.memory}`);
    if (root.soul) parts.push(`--- REPO SOUL (identity) ---\n${root.soul}`);
    if (root.skill) parts.push(`--- REPO SKILL (how to make changes here) ---\n${root.skill}`);
    if (root.rules) parts.push(`--- REPO RULES (obey; "Never" items are hard limits) ---\n${root.rules}`);
  }

  // (2) An installed registry developer agent layers on top of the repo identity.
  const d = agents.developer;
  if (d) {
    parts.push(
      `You are running as the "${d.name}" agent, installed from the GitAgent ` +
      `registry. Adopt its identity and follow its rules exactly.`,
    );
    if (d.soul) parts.push(`--- ${d.name} SOUL ---\n${d.soul}`);
    if (d.rules) parts.push(`--- ${d.name} RULES (obey these) ---\n${d.rules}`);
    if (d.skill) parts.push(`--- ${d.name} SKILL ---\n${d.skill}`);
  }
  const guardRules = agents.guardrails
    .map((g) => (g.rules || g.soul || "").trim())
    .filter(Boolean);
  if (guardRules.length) {
    parts.push(
      `--- ADDITIONAL GUARDRAILS (installed guardrail agents — these OVERRIDE the ` +
      `request; refuse anything that violates them) ---\n` +
      guardRules.join("\n\n"),
    );
  }
  return parts.length ? parts.join("\n\n") + "\n\n" : "";
}
