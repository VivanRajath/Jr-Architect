// The Knowledge slot: reading the repo once, properly, so every later turn has
// something real to stand on.
//
// WHY THIS EXISTS
// repomap.go already writes knowledge/repo-map.md at clone time — a file list,
// directory counts and exported symbol names. That is a MAP: it says where things
// are and nothing about what they do. Asked to "summarise this repo", the chat
// agent could only paraphrase a directory listing, because a directory listing was
// all it had. It cannot fix that itself: a chat turn on a shared free-tier key can
// afford maybe 6k characters of context, which is not enough to read a codebase.
//
// So this runs ONCE when the workspace opens, on its OWN API key, and spends a
// budget no chat turn could — ~24k characters of actual source — to write
// knowledge/overview.md: what the project is, how a request flows through it,
// where things live, and what would waste an hour. That document is registered
// always_load, so every later turn starts from it.
//
// IT IS AN AGENT, NOT A SYSTEM PROMPT
// The instructions it follows are .gitagent/skills/knowledge-builder/SKILL.md —
// a real file in the repo, scaffolded by gitagentgenerator.go, editable in the
// panel, versioned in git. Assign a registry agent to the Knowledge slot and its
// overlay SKILL.md replaces it. Nothing here hardcodes what the document says.

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { join, extname, basename } from "node:path";
import { query } from "gitclaw";
import { loadSkill, KNOWLEDGE_SKILL, parseFrontmatter } from "./registry.js";

export const KNOWLEDGE_DIR = "knowledge";
export const OVERVIEW_REL = "knowledge/overview.md";
const INDEX_REL = "knowledge/index.yaml";
const REPO_MAP_REL = "knowledge/repo-map.md";
const FULL_MAP_REL = "knowledge/repo-map-full.md";

// Total characters of repo handed to the model. A chat turn gets ~6k; this gets
// four times that, which is the entire reason for the dedicated key.
const INPUT_BUDGET = Number(process.env.KNOWLEDGE_INPUT_CHARS) || 24000;
const CAP_MAP = 3000;
const CAP_FULL_MAP = 2500;
const CAP_README = 4000;
const CAP_MANIFEST = 1200;
const CAP_FILE = 3500;
const MAX_SOURCE_FILES = 8;

const SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".next", "vendor", ".venv", "venv",
  "dist", "build", ".gitagent", "coverage", ".turbo", ".cache", "out", "target",
  ".idea", ".vscode", "knowledge", "__tests__", "__snapshots__", "testdata",
]);

const SOURCE_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".py", ".rb", ".php",
  ".java", ".rs", ".vue", ".svelte", ".cs", ".kt", ".swift",
]);

// A file whose name says "this is where things start or are wired together".
const CENTRAL_NAME = /^(index|main|app|server|router|routes|api|store|db|database|schema|config|settings|client|handler|handlers|service|services|core|entry)\b/i;
const TEST_PATH = /(^|\/)(tests?|__tests__|spec|e2e|fixtures?|mocks?)(\/|$)|\.(test|spec)\.[a-z]+$/i;
const GENERATED = /(^|\/)(generated|\.generated|migrations?\/\d|dist|build)(\/|$)|\.(min|bundle|generated)\.[a-z]+$/i;

// Same shallow patterns repomap.go uses. Symbol COUNT is the signal here, not the
// names: a file that exports a lot is usually a file that matters.
const SYMBOL_RE = [
  /(?:^|\n)\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|interface|type|enum)\s+[A-Za-z_$]/g,
  /(?:^|\n)func\s+(?:\([^)]*\)\s+)?[A-Z]/g,
  /(?:^|\n)\s*(?:def|class)\s+[A-Za-z_]/g,
];

const README_NAMES = ["README.md", "readme.md", "README.MD", "Readme.md"];
const MANIFESTS = [
  "package.json", "go.mod", "requirements.txt", "pyproject.toml",
  "Cargo.toml", "Gemfile", "composer.json", "pom.xml",
];
const ENTRY_CANDIDATES = [
  "app/page.tsx", "app/page.jsx", "src/app/page.tsx", "pages/index.tsx",
  "src/App.tsx", "src/App.jsx", "src/main.tsx", "src/main.ts", "src/index.tsx",
  "src/index.ts", "src/index.js", "main.go", "cmd/main.go", "main.py", "app.py",
  "server.js", "index.js", "manage.py", "src/main.rs",
];

function readCapped(abs, cap) {
  try {
    const s = readFileSync(abs, "utf8");
    return s.length > cap ? s.slice(0, cap) + "\n…(truncated)" : s;
  } catch {
    return "";
  }
}

function firstExisting(dir, names) {
  for (const n of names) if (existsSync(join(dir, ...n.split("/")))) return n;
  return "";
}

// package.json is mostly noise for this purpose; the dependency and script names
// are the part that says what the project is built out of.
function summarizeManifest(rel, raw) {
  if (!rel.endsWith("package.json")) return raw.slice(0, CAP_MANIFEST);
  try {
    const j = JSON.parse(raw);
    const keys = (o) => Object.keys(o || {}).join(", ");
    return [
      j.name ? `name: ${j.name}` : "",
      j.description ? `description: ${j.description}` : "",
      `dependencies: ${keys(j.dependencies) || "(none)"}`,
      `devDependencies: ${keys(j.devDependencies) || "(none)"}`,
      `scripts: ${keys(j.scripts) || "(none)"}`,
    ].filter(Boolean).join("\n").slice(0, CAP_MANIFEST);
  } catch {
    return raw.slice(0, CAP_MANIFEST);
  }
}

// Walk the repo and score every source file, cheaply and without a model. Score is
// a sum of three signals: a name that reads like an entry point, how much the file
// exports, and how shallow it sits. Tests, generated output and vendored code score
// nothing — they teach the reader least per token.
export function rankSourceFiles(dir, limit = MAX_SOURCE_FILES) {
  const found = [];
  const walk = (abs, rel, depth) => {
    if (depth > 4 || found.length > 800) return;
    let entries;
    try { entries = readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(join(abs, e.name), childRel, depth + 1);
        continue;
      }
      if (!SOURCE_EXT.has(extname(e.name).toLowerCase())) continue;
      if (TEST_PATH.test(childRel) || GENERATED.test(childRel)) continue;
      let size = 0;
      try { size = statSync(join(abs, e.name)).size; } catch { continue; }
      if (size === 0 || size > 200 * 1024) continue;   // empty, or a bundle
      found.push({ rel: childRel, abs: join(abs, e.name), size, depth });
    }
  };
  walk(dir, "", 0);

  for (const f of found) {
    let symbols = 0;
    try {
      const src = readFileSync(f.abs, "utf8");
      for (const re of SYMBOL_RE) symbols += (src.match(re) || []).length;
    } catch { /* unreadable — it just scores 0 for symbols */ }
    f.score =
      (CENTRAL_NAME.test(basename(f.rel).replace(/\.[a-z]+$/i, "")) ? 40 : 0) +
      Math.min(symbols, 25) * 2 +
      Math.max(0, 12 - f.depth * 4) +
      // Very small files carry little; very large ones cost the whole budget.
      (f.size > 500 && f.size < 30000 ? 8 : 0);
  }
  found.sort((a, b) => b.score - a.score || a.rel.localeCompare(b.rel));
  return found.slice(0, limit);
}

// Everything the builder gets to read, already capped to the budget. Pure apart
// from the filesystem, so it can be tested against a fixture repo with no model.
export function gatherKnowledgeInputs(dir) {
  const sections = [];
  let spent = 0;
  const add = (label, path, body) => {
    const text = String(body || "").trim();
    if (!text) return;
    if (spent + text.length > INPUT_BUDGET) return;
    spent += text.length;
    sections.push({ label, path, text });
  };

  add("Static repo map (already generated — do not repeat it)", REPO_MAP_REL,
    readCapped(join(dir, ...REPO_MAP_REL.split("/")), CAP_MAP));

  // The complete file list. Without it the model cites plausible-sounding files
  // that do not exist ("morgan.js", "utils.js") because nothing told it otherwise.
  add("Complete file list — the ONLY paths that exist. Cite no others", FULL_MAP_REL,
    readCapped(join(dir, ...FULL_MAP_REL.split("/")), CAP_FULL_MAP));

  const readme = firstExisting(dir, README_NAMES);
  if (readme) add("README", readme, readCapped(join(dir, readme), CAP_README));

  for (const m of MANIFESTS) {
    const abs = join(dir, m);
    if (!existsSync(abs)) continue;
    add("Manifest", m, summarizeManifest(m, readCapped(abs, CAP_MANIFEST * 4)));
  }

  const entry = firstExisting(dir, ENTRY_CANDIDATES);
  if (entry) add("Entry point", entry, readCapped(join(dir, ...entry.split("/")), CAP_FILE));

  for (const f of rankSourceFiles(dir)) {
    if (f.rel === entry) continue;
    add("Source", f.rel, readCapped(f.abs, CAP_FILE));
  }

  return { sections, chars: spent, files: sections.length };
}

// Built-in instructions, used only when the skill file is missing (a repo that
// committed its own .gitagent without one). The real prompt is the SKILL.md that
// gitagentgenerator.go scaffolds — this is the safety net, not the source.
const FALLBACK_PERSONA = `You are the Knowledge Builder. Read the repository below and write
knowledge/overview.md with these sections, in order: "## What this is",
"## How it works", "## Where things live", "## Conventions", "## Gotchas",
"## Key files". Ground every claim in a file you were actually shown, cite paths
in backticks, and prefer short and true over long and padded.`;

// The prompt is persona + evidence. The persona comes from the repo; this function
// only assembles it, which is what keeps the agent replaceable.
export function buildKnowledgePrompt(persona, inputs, projectName) {
  const body = inputs.sections
    .map((s) => `=== ${s.label}: ${s.path} ===\n${s.text}\n=== END ===`)
    .join("\n\n");
  return (
    `${persona || FALLBACK_PERSONA}\n\n` +
    `--- REPOSITORY: ${projectName || "(unnamed)"} ---\n\n${body}\n\n` +
    `--- END REPOSITORY ---\n\n` +
    `Write the document now. Output ONLY the markdown, starting with "# ". ` +
    `No preamble, no code fences around the whole document, no closing summary.`
  );
}

// Strip the things a weak model wraps around a document even when told not to.
function cleanDocument(text) {
  let t = String(text || "").trim();
  const fenced = t.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```$/);
  if (fenced) t = fenced[1].trim();
  // Drop any chatter before the first heading.
  const h = t.indexOf("# ");
  if (h > 0 && !t.slice(0, h).includes("\n#")) t = t.slice(h);
  return t.trim();
}

// The sections the built-in prompt asks for. Used to tell a partial document from
// a complete one so a retry can name exactly what is missing.
const WANTED_SECTIONS = [
  "What this is", "How it works", "Where things live",
  "Conventions", "Gotchas", "Key files",
];

export function missingSections(text) {
  const t = String(text || "");
  return WANTED_SECTIONS.filter((s) => !new RegExp(`^#{1,3}\\s+${s}\\b`, "im").test(t));
}

// A path in backticks that does not exist. The document is loaded into EVERY later
// turn, so an invented file is not a cosmetic error — it becomes a fact the coding
// agent then acts on, searching for a file that was never there. The skill file
// forbids it; this is what makes that rule checkable instead of aspirational.
const PATH_LIKE = /`([A-Za-z0-9_@.\-/]+)`/g;
// A real file extension, not "anything after a dot" — `process.stdout`, `res.end`
// and `req.url` are JavaScript expressions the model quotes constantly, and
// treating them as missing files made the check cry wolf.
const HAS_EXT =
  /\.(js|jsx|mjs|cjs|ts|tsx|go|py|rb|php|java|rs|vue|svelte|cs|kt|swift|css|scss|sass|html|json|md|mdx|ya?ml|toml|txt|sh|sql|env|lock|prisma|graphql|proto)$/i;

export function invalidPaths(dir, text) {
  const bad = new Set();
  for (const m of String(text || "").matchAll(PATH_LIKE)) {
    const p = m[1];
    // Only judge things that actually look like a path in this repo. A token like
    // `combined`, `:method` or `npm install` is prose, not a claim about a file.
    if (!p.includes("/") && !HAS_EXT.test(p)) continue;
    if (p.startsWith("-") || p.startsWith("http")) continue;
    // A bare package name (`express`, `debug`) is a dependency, not a repo path.
    if (!p.includes("/") && !existsSync(join(dir, p))) {
      if (HAS_EXT.test(p)) bad.add(p);
      continue;
    }
    if (p.includes("/") && !existsSync(join(dir, ...p.split("/")))) bad.add(p);
  }
  return [...bad];
}

// A document must actually be a document. A model that answers "I would start by
// looking at…" produces something worse than no file at all, because it would then
// be loaded into every later turn as if it were fact.
export function looksLikeDocument(text) {
  const t = String(text || "").trim();
  if (t.length < 400) return false;
  if (!t.startsWith("#")) return false;
  const headings = (t.match(/^##\s+/gm) || []).length;
  return headings >= 3;
}

export function knowledgeStatus(dir) {
  const abs = join(dir, ...OVERVIEW_REL.split("/"));
  if (!existsSync(abs)) return { exists: false, path: OVERVIEW_REL };
  try {
    const raw = readFileSync(abs, "utf8");
    const fm = parseFrontmatter(raw);
    return {
      exists: true,
      path: OVERVIEW_REL,
      bytes: Buffer.byteLength(raw),
      builtAt: fm.built_at || "",
      agent: fm.agent || "",
      model: fm.model || "",
      sources: Number(fm.sources) || 0,
      // Paths the document cites that do not exist. Surfaced rather than hidden:
      // this file is loaded into every turn, so a reader deserves to know which
      // parts of it were not verifiable.
      unverified: (fm.unverified_paths || "").split(",").map((s) => s.trim()).filter(Boolean),
    };
  } catch {
    return { exists: true, path: OVERVIEW_REL, bytes: 0 };
  }
}

// Register the document with the knowledge loader so it rides in every turn.
// Mirrors ensureKnowledgeIndex in repomap.go: splice into an existing index rather
// than clobber a repo's own knowledge, and no-op if we are already listed.
function ensureIndexed(dir) {
  const abs = join(dir, ...INDEX_REL.split("/"));
  const entry = "  - path: overview.md\n    always_load: true\n";
  if (!existsSync(abs)) {
    mkdirSync(join(dir, KNOWLEDGE_DIR), { recursive: true });
    writeFileSync(abs, "entries:\n" + entry);
    return;
  }
  const text = readFileSync(abs, "utf8");
  if (text.includes("overview.md")) return;
  const i = text.indexOf("entries:");
  if (i < 0) { writeFileSync(abs, text + "\nentries:\n" + entry); return; }
  const nl = text.indexOf("\n", i);
  writeFileSync(abs, nl < 0 ? text + "\n" + entry : text.slice(0, nl + 1) + entry + text.slice(nl + 1));
}

function writeDocument(dir, body, meta) {
  mkdirSync(join(dir, KNOWLEDGE_DIR), { recursive: true });
  const front = [
    "---",
    `built_at: ${new Date().toISOString()}`,
    `agent: ${meta.agent || KNOWLEDGE_SKILL}`,
    `model: ${meta.model || ""}`,
    `sources: ${meta.sources || 0}`,
    ...(meta.invented && meta.invented.length
      ? [`unverified_paths: ${meta.invented.join(", ")}`] : []),
    "generator: jr-architect-knowledge-builder",
    "---",
    "",
  ].join("\n");
  writeFileSync(join(dir, ...OVERVIEW_REL.split("/")), front + body + "\n");
  ensureIndexed(dir);
}

// Run the build. `model` is a gitclaw model string; the caller is responsible for
// having put the dedicated key in the environment (see knowledge-worker.js — it
// runs in its own process precisely so that key is never shared with a chat turn).
export async function buildKnowledge({ dir, model, agent, maxTokens, onStep } = {}) {
  const step = (m) => { if (onStep) onStep(m); };
  if (!dir || !existsSync(dir)) return { ok: false, reason: "no-workspace" };

  // The prompt is a file in the repo. That is the whole point.
  const persona = loadSkill(dir, agent || KNOWLEDGE_SKILL) || FALLBACK_PERSONA;
  step(persona === FALLBACK_PERSONA ? "using the built-in prompt (no SKILL.md found)" : "reading skills/knowledge-builder/SKILL.md");

  const inputs = gatherKnowledgeInputs(dir);
  if (!inputs.sections.length) return { ok: false, reason: "nothing-to-read" };
  step(`read ${inputs.files} sources · ${inputs.chars} chars`);

  const basePrompt = buildKnowledgePrompt(persona, inputs, basename(dir));

  // llama-3.3 is non-deterministic about long structured output: the same prompt
  // produces a complete document one run and stops after four sections the next,
  // or answers with prose about what it WOULD do. server.js already retries chat
  // turns for the same reason. Retrying here is cheap — the builder owns its key,
  // so a second call competes with nothing — and each retry names what was wrong,
  // which is far more effective than repeating the same request.
  const attempts = Math.max(1, (Number(process.env.KNOWLEDGE_RETRIES) || 2) + 1);
  const faults = (d) => missingSections(d).length + invalidPaths(dir, d).length;
  let best = "";
  let error = null;

  for (let i = 0; i < attempts; i++) {
    const prompt = i === 0 ? basePrompt : correctionFor(basePrompt, best, invalidPaths(dir, best));
    if (i > 0) {
      const why = best
        ? [
            missingSections(best).length ? `missing: ${missingSections(best).join(", ")}` : "",
            invalidPaths(dir, best).length ? `invented: ${invalidPaths(dir, best).join(", ")}` : "",
          ].filter(Boolean).join(" · ")
        : "no usable document";
      step(`retry ${i} — ${why}`);
    }

    let text = "";
    try {
      for await (const msg of query({
        prompt,
        dir,
        model,
        // Toolless, like every other path here: the model only has to write.
        replaceBuiltinTools: true,
        allowedTools: [],
        constraints: { maxTokens: maxTokens || 2500 },
      })) {
        if (msg.type === "delta" && msg.deltaType !== "thinking") text += msg.content;
        else if (msg.type === "system" && msg.subtype === "error") error = msg.content || error;
        else if (msg.type === "assistant" && msg.stopReason === "error") error = msg.errorMessage || error;
      }
    } catch (e) {
      error = e.message || String(e);
    }

    const doc = cleanDocument(text);
    // Keep the best attempt: a later run that comes back worse must not lose a
    // good earlier one. "Better" means fewer missing sections AND fewer invented paths.
    if (looksLikeDocument(doc) && (!best || faults(doc) < faults(best))) {
      best = doc;
      error = null;
    }
    if (best && faults(best) === 0) break;
  }

  if (!looksLikeDocument(best)) {
    return { ok: false, reason: error ? "model-error" : "not-a-document", error, chars: best.length };
  }

  const gaps = missingSections(best);
  const invented = invalidPaths(dir, best);
  writeDocument(dir, best, {
    agent: agent || KNOWLEDGE_SKILL, model, sources: inputs.files, invented,
  });
  const note = [
    gaps.length ? `missing: ${gaps.join(", ")}` : "",
    invented.length ? `unverified paths: ${invented.join(", ")}` : "",
  ].filter(Boolean).join(" · ");
  step(note ? `wrote ${OVERVIEW_REL} (${note})` : `wrote ${OVERVIEW_REL}`);
  return {
    ok: true, path: OVERVIEW_REL, bytes: Buffer.byteLength(best),
    sources: inputs.files, missing: gaps, invented,
  };
}

// A retry that just repeats the request usually repeats the failure. Naming the
// specific gap — and handing back what it already wrote — is what actually moves it.
function correctionFor(basePrompt, previous, invented = []) {
  const gaps = missingSections(previous);
  if (!previous) {
    return basePrompt + `\n\nYour last reply was not a document. Output ONLY markdown, ` +
      `starting with "# ", with every "##" section listed above. No commentary.`;
  }
  return (
    basePrompt +
    `\n\n--- YOUR PREVIOUS DRAFT (incomplete) ---\n${previous}\n--- END DRAFT ---\n\n` +
    `That draft is missing: ${gaps.join(", ")}. Output the COMPLETE document again — ` +
    `keep the sections you already wrote, and add the missing ones. Markdown only.`
  );
}
