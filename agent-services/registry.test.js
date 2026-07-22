// Tests for the GitAgent registry integration (pure functions only — no network
// fetch, no git clone). Run: `node --test` in agent-services.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  parseMiniYaml, findAgent, readPipelineManifest, loadAgentPersona, personaPreamble,
  loadRepoRootSpec, resolvePipelineAgents, loadSkill, loadComplianceRules, listSkills,
} = await import("./registry.js");

test("parseMiniYaml reads the pipeline subset (nested maps + lists)", () => {
  const y = [
    "spec_version: 0.1.0",
    "pipeline:",
    "  developer: shreyas-lyzr/architect",
    "  guardrails:",
    "    - acme/strict-guard",
    "    - shreyas-lyzr/architect",
  ].join("\n");
  const doc = parseMiniYaml(y);
  assert.equal(doc.spec_version, "0.1.0");
  assert.equal(doc.pipeline.developer, "shreyas-lyzr/architect");
  assert.deepEqual(doc.pipeline.guardrails, ["acme/strict-guard", "shreyas-lyzr/architect"]);
});

test("findAgent resolves an indexed entry and synthesizes an unindexed one", () => {
  const index = [
    { author: "shreyas-lyzr", name: "architect", repository: "https://github.com/shreyas-lyzr/architect", category: "developer-tools", adapters: ["system-prompt"] },
  ];
  const hit = findAgent(index, "shreyas-lyzr/architect");
  assert.equal(hit.category, "developer-tools");
  // "author__name" form also works
  assert.equal(findAgent(index, "shreyas-lyzr__architect").name, "architect");
  // unindexed → synthetic entry pointing at the github repo
  const syn = findAgent(index, "someone/new-agent");
  assert.equal(syn.repository, "https://github.com/someone/new-agent");
  assert.ok(syn._synthetic);
});

test("readPipelineManifest reads a committed .gitagent/pipeline.yaml", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-man-"));
  mkdirSync(join(dir, ".gitagent"), { recursive: true });
  writeFileSync(
    join(dir, ".gitagent", "pipeline.yaml"),
    "pipeline:\n  developer: shreyas-lyzr/architect\n  guardrails:\n    - acme/guard\n",
  );
  const m = readPipelineManifest(dir);
  assert.equal(m.developer, "shreyas-lyzr/architect");
  assert.deepEqual(m.guardrails, ["acme/guard"]);
});

test("readPipelineManifest drops builtin: refs and returns null when empty", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-builtin-"));
  mkdirSync(join(dir, ".gitagent"), { recursive: true });
  writeFileSync(
    join(dir, ".gitagent", "pipeline.json"),
    JSON.stringify({ pipeline: { developer: "builtin:jnr-developer", guardrails: ["builtin:secret-sentinel"] } }),
  );
  assert.equal(readPipelineManifest(dir), null);
});

test("readPipelineManifest falls back to env overrides", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-env-"));
  const prevD = process.env.GITAGENT_DEVELOPER_AGENT;
  const prevG = process.env.GITAGENT_GUARDRAIL_AGENTS;
  process.env.GITAGENT_DEVELOPER_AGENT = "shreyas-lyzr/architect";
  process.env.GITAGENT_GUARDRAIL_AGENTS = "a/one, b/two";
  try {
    const m = readPipelineManifest(dir);
    assert.equal(m.developer, "shreyas-lyzr/architect");
    assert.deepEqual(m.guardrails, ["a/one", "b/two"]);
  } finally {
    if (prevD === undefined) delete process.env.GITAGENT_DEVELOPER_AGENT; else process.env.GITAGENT_DEVELOPER_AGENT = prevD;
    if (prevG === undefined) delete process.env.GITAGENT_GUARDRAIL_AGENTS; else process.env.GITAGENT_GUARDRAIL_AGENTS = prevG;
  }
});

test("loadAgentPersona reads SOUL/RULES, and falls back to README", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-persona-"));
  const a = join(dir, "shreyas-lyzr__architect");
  mkdirSync(a, { recursive: true });
  writeFileSync(join(a, "SOUL.md"), "I am the architect.");
  writeFileSync(join(a, "RULES.md"), "Never touch package-lock.json.");
  const p = loadAgentPersona(a, { author: "shreyas-lyzr", name: "architect", category: "developer-tools" });
  assert.equal(p.name, "shreyas-lyzr/architect");
  assert.match(p.soul, /architect/);
  assert.match(p.rules, /Never touch/);

  const dir2 = mkdtempSync(join(tmpdir(), "gitagent-readme-"));
  const b = join(dir2, "x__y");
  mkdirSync(b, { recursive: true });
  writeFileSync(join(b, "README.md"), "Fallback description.");
  const p2 = loadAgentPersona(b, { author: "x", name: "y", category: "other" });
  assert.match(p2.soul, /Fallback/);
  assert.equal(p2.rules, "");
});

test("personaPreamble composes developer identity + guardrail rules, empty when disabled", () => {
  assert.equal(personaPreamble({ enabled: false }), "");
  const pre = personaPreamble({
    enabled: true,
    developer: { name: "shreyas-lyzr/architect", soul: "I am the architect.", rules: "Keep changes minimal.", skill: "" },
    guardrails: [{ name: "acme/guard", rules: "Never edit auth files." }],
  });
  assert.match(pre, /running as the "shreyas-lyzr\/architect" agent/);
  assert.match(pre, /I am the architect/);
  assert.match(pre, /ADDITIONAL GUARDRAILS/);
  assert.match(pre, /Never edit auth files/);
});

test("loadRepoRootSpec reads the repo's own root gitagent spec, null when absent", () => {
  const empty = mkdtempSync(join(tmpdir(), "gitagent-root-empty-"));
  assert.equal(loadRepoRootSpec(empty), null);

  const dir = mkdtempSync(join(tmpdir(), "gitagent-root-"));
  writeFileSync(join(dir, "SOUL.md"), "I am the repo agent.");
  writeFileSync(join(dir, "RULES.md"), "## Never\n- Never edit pricing.ts");
  writeFileSync(join(dir, "MEMORY.md"), "UI entry: app/page.tsx");
  mkdirSync(join(dir, "skills", "ui-editor"), { recursive: true });
  writeFileSync(join(dir, "skills", "ui-editor", "SKILL.md"), "How to edit UI here.");
  const spec = loadRepoRootSpec(dir);
  assert.match(spec.soul, /repo agent/);
  assert.match(spec.rules, /pricing\.ts/);
  assert.match(spec.memory, /app\/page\.tsx/);
  assert.match(spec.skill, /edit UI/);
});

test("loadRepoRootSpec reads the grouped .gitagent/ layout (preferred over root)", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-grouped-"));
  mkdirSync(join(dir, ".gitagent", "skills", "ui-editor"), { recursive: true });
  writeFileSync(join(dir, ".gitagent", "SOUL.md"), "I am the grouped repo agent.");
  writeFileSync(join(dir, ".gitagent", "MEMORY.md"), "UI entry: app/page.tsx");
  writeFileSync(join(dir, ".gitagent", "skills", "ui-editor", "SKILL.md"), "How to edit UI here.");
  // A stray root SOUL.md must be ignored once .gitagent/ has a spec.
  writeFileSync(join(dir, "SOUL.md"), "stale root soul");
  const spec = loadRepoRootSpec(dir);
  assert.match(spec.soul, /grouped repo agent/);
  assert.match(spec.memory, /app\/page\.tsx/);
  assert.match(spec.skill, /edit UI/);
});

test("personaPreamble puts the repo-root spec as the base layer", () => {
  const pre = personaPreamble({
    enabled: true,
    root: { soul: "Repo identity.", rules: "Never edit pricing.ts", memory: "UI entry: app/page.tsx", skill: "Edit CSS in globals." },
    developer: null,
    guardrails: [],
  });
  assert.match(pre, /this repository's own agent/);
  assert.match(pre, /REPO MEMORY/);
  assert.match(pre, /app\/page\.tsx/);
  assert.match(pre, /REPO RULES/);
  assert.match(pre, /pricing\.ts/);
});

test("loadSkill / loadComplianceRules / listSkills read the .gitagent standard layout", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-skills-"));
  mkdirSync(join(dir, ".gitagent", "skills", "snr-developer"), { recursive: true });
  mkdirSync(join(dir, ".gitagent", "skills", "ask"), { recursive: true });
  mkdirSync(join(dir, ".gitagent", "compliance"), { recursive: true });
  writeFileSync(
    join(dir, ".gitagent", "skills", "snr-developer", "SKILL.md"),
    "---\nname: snr-developer\ndescription: multi-file\n---\n\n# Senior Developer\nChange all related files.",
  );
  writeFileSync(join(dir, ".gitagent", "skills", "ask", "SKILL.md"), "# Ask\nAnswer grounded.");
  writeFileSync(join(dir, ".gitagent", "compliance", "RULES.md"), "# Compliance\nNever edit .env");

  const snr = loadSkill(dir, "snr-developer");
  assert.match(snr, /Senior Developer/);
  assert.ok(!/^---/.test(snr), "frontmatter should be stripped");
  assert.equal(loadSkill(dir, "does-not-exist"), "");
  assert.match(loadComplianceRules(dir), /Never edit \.env/);
  assert.deepEqual(listSkills(dir).sort(), ["ask", "snr-developer"]);
});

test("resolvePipelineAgents applies the root spec even with no manifest (no network)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-rootonly-"));
  writeFileSync(join(dir, "SOUL.md"), "I am the repo agent.");
  writeFileSync(join(dir, "MEMORY.md"), "Stack: nextjs");
  const out = await resolvePipelineAgents(dir, null);
  assert.equal(out.enabled, true);
  assert.equal(out.developer, null);
  assert.ok(out.root && /repo agent/.test(out.root.soul));
});
