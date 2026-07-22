// GitAgent registry integration (https://registry.gitagent.sh, open-gitagent/registry).
//
// The registry is a static, backend-free index: one index.json lists community
// agents, each entry pointing at the agent's OWN github repo. "Installing" an
// agent is literally `git clone <repository>`. Each agent declares `adapters`
// (e.g. ["claude-code","openai","lyzr","system-prompt"]); Jr Architect acts as a
// `system-prompt` adapter, so any agent that supports it can drive a pipeline slot.
//
// This module turns a repo's `.gitagent/pipeline.yaml` (or JSON, or env override)
// into loaded agent personas that thread into the layered edit pipeline:
//   category security/compliance  → Guardrails slot
//   category developer-tools/...  → Developer slot
//
// Everything here is best-effort and non-fatal: any failure (no network, bad
// manifest, clone error) degrades to the built-in personas so edits never break.

import { existsSync, readFileSync, writeFileSync, rmSync, mkdirSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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

// Look up an agent entry by "author/name" (or "author__name"). Falls back to a
// synthetic entry pointing at github.com/<author>/<name> so a not-yet-indexed
// agent can still be installed by reference.
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

// ── Pipeline manifest (.gitagent/pipeline.yaml | .json, or env override) ──────

// Resolve which agents fill which slots for this workspace. Priority:
//   1. `.gitagent/pipeline.(yaml|yml|json)` committed in the opened repo
//   2. env overrides (so a demo works on ANY repo without editing it):
//        GITAGENT_DEVELOPER_AGENT=shreyas-lyzr/architect
//        GITAGENT_GUARDRAIL_AGENTS=author/guard-a,author/guard-b
// Returns { developer: ref|null, guardrails: [ref,…] } or null if nothing is set.
export function readPipelineManifest(dir) {
  const fromFile = readManifestFile(dir);
  if (fromFile) return fromFile;

  const dev = (process.env.GITAGENT_DEVELOPER_AGENT || "").trim();
  const guards = (process.env.GITAGENT_GUARDRAIL_AGENTS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);
  if (!dev && guards.length === 0) return null;
  return { developer: dev || null, guardrails: guards };
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
  if (!devRef && guardrails.length === 0) return null;
  return { developer: devRef, guardrails };
}

// Minimal YAML reader for the tiny pipeline subset: nested maps, scalars, and
// `- ` lists (a list under a key turns that key into an array). Not a general
// YAML parser — just enough for pipeline.yaml.
export function parseMiniYaml(text) {
  const root = {};
  // Each frame tracks the node plus the (parent,key) that created it, so a list
  // item can convert an empty-value key's placeholder map into an array.
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

// Write the workspace's pipeline manifest (as .gitagent/pipeline.json — the reader
// prefers it). Clearing both slots removes the file, so a "reset" in the panel
// truly reverts to the built-in personas. Used by the GitAgent IDE panel.
export function writePipelineManifest(dir, pipeline) {
  const base = join(dir, ".gitagent");
  const file = join(base, "pipeline.json");
  const developer = pipeline && pipeline.developer ? pipeline.developer : null;
  const guardrails = pipeline && Array.isArray(pipeline.guardrails)
    ? pipeline.guardrails.filter(Boolean) : [];
  if (!developer && guardrails.length === 0) {
    try { rmSync(file); } catch { /* nothing to clear */ }
    return;
  }
  mkdirSync(base, { recursive: true });
  const doc = { spec_version: "0.1.0", pipeline: { developer, guardrails } };
  writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
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
// Skips the clone if already present (installed agents are cached on disk).
export async function installAgent(dir, entry) {
  const target = installPath(dir, entry);
  if (existsSync(join(target, ".git")) || existsSync(target)) return target;
  mkdirSync(resolve(dir, AGENTS_DIR), { recursive: true });
  await new Promise((res, rej) => {
    execFile(
      "git",
      ["clone", "--depth", "1", entry.repository, target],
      { timeout: CLONE_TIMEOUT_MS },
      (err) => (err ? rej(err) : res()),
    );
  });
  return target;
}

function readCapped(abs) {
  try {
    const s = readFileSync(abs, "utf8");
    return s.length > PERSONA_CAP ? s.slice(0, PERSONA_CAP) + "\n…(truncated)" : s;
  } catch { return ""; }
}

// Load an installed agent's persona from the gitagent-standard files, honoring an
// optional subdir (`path` in metadata). Falls back to README.md if the agent
// doesn't ship SOUL/RULES. Returns { name, soul, rules, skill } (strings, "" if absent).
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
    soul: soul || fallback,
    rules,
    skill,
  };
}

// ── Repo-root spec (the repository's OWN agent) ──────────────────────────────
//
// Jr Architect scaffolds a gitagent spec for every cloned repo (SOUL.md, RULES.md,
// skills/*/SKILL.md, MEMORY.md — see gitagentgenerator.go). That spec IS the
// repository's own agent: it travels with the code, versioned in git. The edit
// pipeline reads it before changing anything, so edits obey the repo's memory,
// rules, and skills. Applies even when no registry agents are installed.
//
// The spec is grouped under `.gitagent/` (one clear folder in the explorer,
// alongside pipeline.json and installed agents). We read from there first, then
// fall back to the repo root so a standard-pure repo that commits SOUL.md/RULES.md
// at its top level is still honored. Returns null if there is no spec at all.
export function loadRepoRootSpec(dir) {
  const grouped = readSpecFrom(join(dir, ".gitagent"));
  if (grouped) return grouped;
  return readSpecFrom(dir);
}

// Drop a leading `--- … ---` YAML frontmatter block so only the human body of a
// SKILL.md (or RULES.md) goes into the prompt.
function stripFrontmatter(t) {
  if (!t) return "";
  const m = t.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/);
  return (m ? t.slice(m[0].length) : t).trim();
}

// Load a built-in persona skill's body from the repo's own .gitagent/skills/. This
// is the SOURCE OF TRUTH for how a squad behaves (jnr-developer, snr-developer,
// architect, ask, build-doctor). Returns "" if the file is absent so the caller
// can fall back to its hardcoded default.
export function loadSkill(dir, name) {
  return stripFrontmatter(readCapped(join(dir, ".gitagent", "skills", name, "SKILL.md")));
}

// Load the repo's compliance rules (.gitagent/compliance/RULES.md). These document
// and may ADD to the code-enforced guardrails (deny always wins in code). "" if none.
export function loadComplianceRules(dir) {
  return stripFrontmatter(readCapped(join(dir, ".gitagent", "compliance", "RULES.md")));
}

// List the built-in + user-authored skills present under .gitagent/skills.
export function listSkills(dir) {
  const base = join(dir, ".gitagent", "skills");
  if (!existsSync(base)) return [];
  try {
    return readdirSync(base).filter((d) => existsSync(join(base, d, "SKILL.md")));
  } catch { return []; }
}

// Read a gitagent spec (SOUL/RULES/MEMORY + first skill) out of one directory.
function readSpecFrom(base) {
  const soul = readCapped(join(base, "SOUL.md"));
  const rules = readCapped(join(base, "RULES.md"));
  const memory = readCapped(join(base, "MEMORY.md"));
  let skill = "";
  const skillsDir = join(base, "skills");
  if (existsSync(skillsDir)) {
    try {
      const first = readdirSync(skillsDir).find((d) =>
        existsSync(join(skillsDir, d, "SKILL.md")));
      if (first) skill = readCapped(join(skillsDir, first, "SKILL.md"));
    } catch { /* ignore */ }
  }
  if (!soul && !rules && !memory && !skill) return null;
  return { soul, rules, memory, skill };
}

// ── Orchestration: manifest → installed, loaded personas for the pipeline ─────

// Resolve the workspace's pipeline: read the manifest, install each referenced
// agent (live git clone), and load its persona. `onStep(name, detail)` streams
// progress into the chat. Best-effort: a failed agent is skipped, not fatal.
// Returns { developer: persona|null, guardrails: [persona,…], enabled: bool }.
export async function resolvePipelineAgents(dir, onStep) {
  const step = (d) => { if (onStep) onStep("GitAgent", d); };

  // The repository's OWN agent (root spec) always applies, manifest or not.
  const root = loadRepoRootSpec(dir);
  if (root) step("reading repo-root spec (SOUL/RULES/SKILL/MEMORY)");

  const manifest = readPipelineManifest(dir);
  if (!manifest) return { root, developer: null, guardrails: [], enabled: !!root };

  const index = await fetchRegistryIndex();

  const install = async (ref) => {
    const entry = findAgent(index, ref);
    if (!entry) { step(`skip ${ref} (not found)`); return null; }
    try {
      const at = await installAgent(dir, entry);
      return loadAgentPersona(at, entry);
    } catch (e) {
      step(`skip ${ref} (${e.message})`);
      return null;
    }
  };

  let developer = null;
  if (manifest.developer) {
    step(`installing developer · ${manifest.developer}`);
    developer = await install(manifest.developer);
    if (developer) step(`developer → ${developer.name}`);
  }

  const guardrails = [];
  for (const ref of manifest.guardrails) {
    step(`installing guardrail · ${ref}`);
    const g = await install(ref);
    if (g) { guardrails.push(g); step(`guardrail → ${g.name}`); }
  }

  return { root, developer, guardrails, enabled: !!(root || developer || guardrails.length) };
}

// Compose the persona preamble injected ahead of the Developer prompt. Layers, in
// order: (1) the repository's OWN root spec — its memory, identity, skill, rules —
// which always applies; (2) an installed registry developer agent, if any; (3)
// guardrail rules (root RULES + registry guardrails). Empty when nothing is active.
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
