import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  gatherKnowledgeInputs, buildKnowledgePrompt, looksLikeDocument,
  knowledgeStatus, rankSourceFiles, OVERVIEW_REL, invalidPaths, missingSections,
} from "./knowledge.js";
import { classifySlot, assignSlot, readPipelineManifest, overlayPaths, BUILTIN_SKILLS } from "./registry.js";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "jr-knowledge-"));
  const put = (rel, body) => {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };
  put("knowledge/repo-map.md", "# Repository Map\n\n**Stack:** node\n- `src/` — 4 files\n");
  put("README.md", "# Ledger\n\nA small double-entry bookkeeping tool.\n");
  put("package.json", JSON.stringify({
    name: "ledger", description: "bookkeeping",
    dependencies: { react: "18", zod: "3" },
    devDependencies: { vitest: "1" },
    scripts: { dev: "vite", test: "vitest" },
  }));
  put("src/index.ts", "export function main() { return boot(); }\nexport const VERSION = '1';\n");
  put("src/store.ts", "export class Store {}\nexport const db = 1;\nexport function save() {}\nexport function load() {}\n");
  put("src/components/Button.tsx", "export function Button() { return null; }\n");
  put("src/store.test.ts", "export const shouldBeSkipped = 1;\n");
  put("dist/bundle.js", "export const generated = 1;\n");
  put("node_modules/dep/index.js", "export const vendored = 1;\n");
  return dir;
}

// ── Input gathering ──────────────────────────────────────────────────────────

test("gatherKnowledgeInputs collects the map, README, manifest and real source", () => {
  const dir = fixture();
  const { sections } = gatherKnowledgeInputs(dir);
  const paths = sections.map((s) => s.path);

  assert.ok(paths.includes("knowledge/repo-map.md"), "the static map grounds the build");
  assert.ok(paths.includes("README.md"));
  assert.ok(paths.includes("package.json"));
  assert.ok(paths.some((p) => p.startsWith("src/")), "at least one real source file");
});

test("gatherKnowledgeInputs skips tests, build output and dependencies", () => {
  const { sections } = gatherKnowledgeInputs(fixture());
  const paths = sections.map((s) => s.path);
  assert.ok(!paths.includes("src/store.test.ts"), "a test file teaches least per token");
  assert.ok(!paths.some((p) => p.startsWith("dist/")));
  assert.ok(!paths.some((p) => p.startsWith("node_modules/")));
});

test("package.json is reduced to names, not pasted whole", () => {
  const { sections } = gatherKnowledgeInputs(fixture());
  const pkg = sections.find((s) => s.path === "package.json");
  assert.ok(pkg.text.includes("dependencies: react, zod"));
  assert.ok(pkg.text.includes("scripts: dev, test"));
  assert.ok(!pkg.text.includes('"18"'), "version strings are noise for this purpose");
});

test("the input budget is respected", () => {
  const dir = fixture();
  // A file far larger than the whole budget must not be able to blow it.
  mkdirSync(join(dir, "src"), { recursive: true });
  writeFileSync(join(dir, "src", "huge.ts"), "export const x = 1;\n".repeat(20000));
  const { chars } = gatherKnowledgeInputs(dir);
  assert.ok(chars <= 24000, `gathered ${chars} chars, over budget`);
});

test("rankSourceFiles prefers central, export-heavy files", () => {
  const ranked = rankSourceFiles(fixture(), 5).map((f) => f.rel);
  assert.ok(ranked.indexOf("src/index.ts") < ranked.indexOf("src/components/Button.tsx"),
    "an entry-named file outranks a leaf component");
});

// ── Prompt ───────────────────────────────────────────────────────────────────

test("the prompt carries the persona verbatim — it is the SKILL.md, not a constant", () => {
  const persona = "# My Custom Builder\nOnly ever write two sentences.";
  const prompt = buildKnowledgePrompt(persona, gatherKnowledgeInputs(fixture()), "ledger");
  assert.ok(prompt.startsWith(persona), "the repo's skill file leads the prompt");
  assert.ok(prompt.includes("=== README: README.md ==="));
  assert.ok(prompt.includes("ledger"));
});

// ── Output validation ────────────────────────────────────────────────────────

test("looksLikeDocument rejects a model that describes its process instead of writing", () => {
  assert.equal(looksLikeDocument("I would start by looking at the package.json and then..."), false);
  assert.equal(looksLikeDocument(""), false);
  assert.equal(looksLikeDocument("# Overview\n\nToo short."), false, "no sections, no substance");
});

test("looksLikeDocument accepts a real document", () => {
  const doc = "# Ledger\n\n## What this is\n" + "A bookkeeping tool. ".repeat(20) +
    "\n\n## How it works\n" + "Entries flow through `src/store.ts`. ".repeat(10) +
    "\n\n## Where things live\n`src/` holds it all.\n\n## Gotchas\nNone found.\n";
  assert.equal(looksLikeDocument(doc), true);
});

// ── Status ───────────────────────────────────────────────────────────────────

test("knowledgeStatus reports absence, then reads the frontmatter back", () => {
  const dir = fixture();
  assert.equal(knowledgeStatus(dir).exists, false);

  mkdirSync(join(dir, "knowledge"), { recursive: true });
  writeFileSync(join(dir, ...OVERVIEW_REL.split("/")),
    "---\nbuilt_at: 2026-08-08T00:00:00.000Z\nagent: acme/doc-agent\nmodel: groq:llama\nsources: 7\n---\n\n# X\n");

  const st = knowledgeStatus(dir);
  assert.equal(st.exists, true);
  assert.equal(st.agent, "acme/doc-agent");
  assert.equal(st.sources, 7);
  assert.equal(st.builtAt, "2026-08-08T00:00:00.000Z");
});

// ── The knowledge slot ───────────────────────────────────────────────────────

test("knowledge-builder is a built-in skill, so the panel shows it as an agent", () => {
  assert.ok(BUILTIN_SKILLS.includes("knowledge-builder"));
});

test("classifySlot routes documentation agents to the knowledge slot", () => {
  assert.equal(classifySlot({ category: "documentation" }).slot, "knowledge");
  assert.equal(classifySlot({ category: "knowledge" }).slot, "knowledge");
  assert.equal(
    classifySlot({ category: "other", description: "Summarizes a codebase for onboarding" }).slot,
    "knowledge",
  );
  // A curated developer category still wins over prose that mentions docs.
  assert.equal(
    classifySlot({ category: "developer-tools", description: "writes docs and code" }).slot,
    "developer",
  );
  // And a real guardrail is not stolen by the knowledge hint.
  assert.equal(classifySlot({ category: "security" }).slot, "guardrails");
});

test("knowledge overlays land in skills/, like any other prompt", () => {
  assert.equal(overlayPaths("acme/doc-agent", "knowledge").spec,
    ".gitagent/skills/acme__doc-agent/SKILL.md");
  assert.equal(overlayPaths("acme/guard", "guardrails").spec,
    ".gitagent/compliance/acme__guard.md");
});

test("an agent holds exactly one slot — moving it to knowledge clears the others", () => {
  const dir = fixture();
  assignSlot(dir, "acme/x", "developer");
  assert.equal(readPipelineManifest(dir).developer, "acme/x");

  assignSlot(dir, "acme/x", "knowledge");
  const m = readPipelineManifest(dir);
  assert.equal(m.knowledge, "acme/x");
  assert.equal(m.developer, null, "it must not both write code and document it");
  assert.deepEqual(m.guardrails, []);
});

test("a v0.1 manifest with no knowledge key still reads", () => {
  const dir = fixture();
  mkdirSync(join(dir, ".gitagent"), { recursive: true });
  writeFileSync(join(dir, ".gitagent", "pipeline.json"),
    JSON.stringify({ spec_version: "0.1.0", pipeline: { developer: "a/b", guardrails: ["c/d"] } }));
  const m = readPipelineManifest(dir);
  assert.equal(m.developer, "a/b");
  assert.deepEqual(m.guardrails, ["c/d"]);
  assert.equal(m.knowledge, null);
});

test("the manifest stays clean when the built-in holds the knowledge slot", () => {
  const dir = fixture();
  assignSlot(dir, "acme/x", "developer");
  const raw = readFileSync(join(dir, ".gitagent", "pipeline.json"), "utf8");
  assert.ok(!raw.includes("knowledge"),
    "the default needs no entry — only a pulled agent is named");
  assert.ok(existsSync(join(dir, ".gitagent", "pipeline.json")));
});

// ── Grounding checks ─────────────────────────────────────────────────────────
// The document is loaded into EVERY later turn, so a file it invents becomes a
// fact the coding agent then acts on. These are what make "cite only real files"
// a check rather than a wish.

test("invalidPaths catches a cited file that does not exist", () => {
  const dir = fixture();
  const doc = "See `src/index.ts` and `src/nope.ts`, plus `src/components/Button.tsx`.";
  assert.deepEqual(invalidPaths(dir, doc), ["src/nope.ts"]);
});

test("invalidPaths does not cry wolf over expressions or bare packages", () => {
  const dir = fixture();
  // These are the things a model quotes constantly. Flagging them would make the
  // signal useless: `process.stdout` was reported as a missing file before the
  // extension list was narrowed to real source extensions.
  const doc = "Writes to `process.stdout` via `res.end`, using `react` and `:method`, run `npm install`.";
  assert.deepEqual(invalidPaths(dir, doc), []);
});

test("invalidPaths accepts a directory, not just a file", () => {
  const dir = fixture();
  assert.deepEqual(invalidPaths(dir, "Tests live in `src/components`."), []);
});

test("missingSections names exactly what a partial draft is short of", () => {
  const partial = "# X\n## What this is\na\n## How it works\nb\n## Where things live\nc\n";
  assert.deepEqual(missingSections(partial), ["Conventions", "Gotchas", "Key files"]);
  const full = partial + "## Conventions\nd\n## Gotchas\nNone found\n## Key files\n- `a`\n";
  assert.deepEqual(missingSections(full), []);
});
