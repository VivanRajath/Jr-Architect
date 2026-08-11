// Tests for the GitAgent registry integration (pure functions only — no network
// fetch, no git clone). Run: `node --test` in agent-services.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const {
  parseMiniYaml, findAgent, readPipelineManifest, loadAgentPersona, personaPreamble,
  loadRepoRootSpec, resolvePipelineAgents, loadSkill, loadComplianceRules, listSkills,
  resolveSpecPath, readSpecFile, writeSpecFile, listSkillsDetailed, deleteSkill,
  parseFrontmatter, installedAgentsDetailed, classifySlot, assignSlot,
  syncSpecOverlay, overlayPaths, readOverlayBody, upsertManagedBlock,
} = await import("./registry.js");

// A resolved pipeline, as resolvePipelineAgents would hand it to the overlay.
function persona(name, extra = {}) {
  return { name, category: "other", description: "", repository: `https://github.com/${name}`,
    soul: "", rules: "", skill: "", ...extra };
}

// ── Spec overlay: a pulled agent materializes into .gitagent/ ────────────────

test("pulling a guardrail writes its rules and stage into the spec folder", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-overlay-guard-"));
  const out = syncSpecOverlay(dir, {
    developer: null,
    guardrails: [persona("acme/pci-guard", { rules: "Never log a card number." })],
  });
  const p = overlayPaths("acme/pci-guard", "guardrails");
  assert.equal(p.spec, ".gitagent/compliance/acme__pci-guard.md");
  assert.ok(out.written.includes(p.spec), `wrote ${out.written.join(", ")}`);
  assert.ok(out.written.includes(p.workflow));

  // The rules are really in the file — this is what the review stage reads.
  const rules = readFileSync(join(dir, ".gitagent", "compliance", "acme__pci-guard.md"), "utf8");
  assert.match(rules, /Never log a card number/);
  assert.equal(parseFrontmatter(rules).agent, "acme/pci-guard");
  // The file's note to the developer is an HTML comment: visible when you open it,
  // never sent to the reviewer as though it were one of the agent's rules.
  const body = readOverlayBody(dir, "acme/pci-guard", "guardrails");
  assert.match(body, /Never log a card number/);
  assert.ok(!/next review uses your version/.test(body), body);
  // And the workflow doc says where it runs, naming the stage it can block at.
  const flow = readFileSync(join(dir, ".gitagent", "workflows", "acme__pci-guard.md"), "utf8");
  assert.match(flow, /Guardrails \(review\)/);
  assert.match(flow, /deny is final/);
  // RULES.md gains a managed index pointing at both.
  const rulesMd = readFileSync(join(dir, ".gitagent", "RULES.md"), "utf8");
  assert.match(rulesMd, /Pulled registry agents/);
  assert.match(rulesMd, /acme\/pci-guard/);
  assert.match(rulesMd, /compliance\/acme__pci-guard\.md/);
});

test("pulling a developer writes a skill the pipeline actually reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-overlay-dev-"));
  syncSpecOverlay(dir, {
    developer: persona("shreyas-lyzr/architect", { soul: "I am an architect.", skill: "Plan before coding." }),
    guardrails: [],
  });
  const p = overlayPaths("shreyas-lyzr/architect", "developer");
  assert.equal(p.spec, ".gitagent/skills/shreyas-lyzr__architect/SKILL.md");
  const skill = readFileSync(join(dir, ...p.spec.split("/")), "utf8");
  assert.match(skill, /I am an architect/);
  assert.match(skill, /Plan before coding/);
  // It shows in the panel's skill list, tagged with the agent that put it there,
  // and it is NOT mistaken for one the developer wrote by hand.
  const listed = listSkillsDetailed(dir).find((s) => s.slug === "shreyas-lyzr__architect");
  assert.ok(listed, "the pulled skill should be listed");
  assert.equal(listed.agent, "shreyas-lyzr/architect");
  assert.equal(listed.builtin, false);
  // Deleting the file alone would be undone on the next turn — refuse and say so.
  assert.throws(() => deleteSkill(dir, "shreyas-lyzr__architect"), /remove the agent/i);
});

test("an overlay you edited is never overwritten, and is what the agent runs on", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-overlay-edit-"));
  const agents = { developer: null, guardrails: [persona("acme/guard", { rules: "Upstream rule." })] };
  syncSpecOverlay(dir, agents);

  // The developer tightens the rule in the visible file.
  const rel = overlayPaths("acme/guard", "guardrails").spec;
  const abs = join(dir, ...rel.split("/"));
  writeFileSync(abs, readFileSync(abs, "utf8").replace("Upstream rule.", "My rule: no raw SQL."));

  const again = syncSpecOverlay(dir, agents);
  assert.equal(again.written.length, 0, "a second sync must not touch existing files");
  assert.match(readFileSync(abs, "utf8"), /My rule: no raw SQL/);
  // And it is the edited text — not the clone's — that reaches the pipeline.
  assert.match(readOverlayBody(dir, "acme/guard", "guardrails"), /My rule: no raw SQL/);
  assert.ok(!/Upstream rule/.test(readOverlayBody(dir, "acme/guard", "guardrails")));
});

test("removing an agent takes its files out of the spec, leaving hand-written rules alone", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-overlay-prune-"));
  mkdirSync(join(dir, ".gitagent"), { recursive: true });
  writeFileSync(join(dir, ".gitagent", "RULES.md"), "# Rules\n\nNever touch billing.\n");
  syncSpecOverlay(dir, { developer: null, guardrails: [persona("acme/guard", { rules: "No raw SQL." })] });

  const out = syncSpecOverlay(dir, { developer: null, guardrails: [] });
  assert.ok(out.removed.includes(".gitagent/compliance/acme__guard.md"));
  assert.ok(out.removed.includes(".gitagent/workflows/acme__guard.md"));
  assert.equal(existsSync(join(dir, ".gitagent", "compliance", "acme__guard.md")), false);
  // The author's own rules survive, and the managed block is gone with the agent.
  const rules = readFileSync(join(dir, ".gitagent", "RULES.md"), "utf8");
  assert.match(rules, /Never touch billing/);
  assert.ok(!/Pulled registry agents/.test(rules), rules);
});

test("an agent whose clone failed keeps its files — only removing it prunes them", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-offline-"));
  const agents = { developer: null, guardrails: [persona("acme/guard", { rules: "No raw SQL." })] };
  syncSpecOverlay(dir, agents, [{ ref: "acme/guard", slot: "guardrails" }]);

  // Next turn the network is down: the agent still holds its slot, but resolving
  // it produced no persona. Its rules must survive.
  const out = syncSpecOverlay(dir, { developer: null, guardrails: [] },
    [{ ref: "acme/guard", slot: "guardrails" }]);
  assert.deepEqual(out.removed, []);
  assert.ok(existsSync(join(dir, ".gitagent", "compliance", "acme__guard.md")));
  // …and the index still names it, so the block and the files agree.
  assert.match(readFileSync(join(dir, ".gitagent", "RULES.md"), "utf8"), /acme\/guard/);
});

test("upsertManagedBlock only ever rewrites its own block", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-block-"));
  mkdirSync(join(dir, ".gitagent"), { recursive: true });
  const abs = join(dir, ".gitagent", "RULES.md");
  writeFileSync(abs, "# Rules\n\nHand-written.\n");
  assert.equal(upsertManagedBlock(dir, ".gitagent/RULES.md", "first"), true);
  assert.equal(upsertManagedBlock(dir, ".gitagent/RULES.md", "first"), false, "idempotent");
  upsertManagedBlock(dir, ".gitagent/RULES.md", "second");
  const text = readFileSync(abs, "utf8");
  assert.match(text, /Hand-written/);
  assert.match(text, /second/);
  assert.ok(!/first/.test(text), "the old block must be replaced, not stacked");
});

test("loadComplianceRules reads the repo's own rule files and skips pulled overlays", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-compliance-"));
  mkdirSync(join(dir, ".gitagent", "compliance"), { recursive: true });
  writeFileSync(join(dir, ".gitagent", "compliance", "RULES.md"), "Never edit .env");
  writeFileSync(join(dir, ".gitagent", "compliance", "a11y.md"), "Keep contrast AA.");
  syncSpecOverlay(dir, { developer: null, guardrails: [persona("acme/guard", { rules: "No raw SQL." })] });
  const text = loadComplianceRules(dir);
  assert.match(text, /Never edit \.env/);
  assert.match(text, /Keep contrast AA/);
  // The pulled agent's rules go in through personaPreamble; sending them here too
  // would spend the token budget twice for the same enforcement.
  assert.ok(!/No raw SQL/.test(text), text);
});

test("a pulled skill never stands in for the repo's own root spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-rootskill-"));
  mkdirSync(join(dir, ".gitagent", "skills", "ui-editor"), { recursive: true });
  writeFileSync(join(dir, ".gitagent", "SOUL.md"), "This repo's agent.");
  writeFileSync(join(dir, ".gitagent", "skills", "ui-editor", "SKILL.md"), "# UI editor\nEdit the UI.");
  // "aaa__agent" sorts ahead of "ui-editor" — the root spec must still be ours.
  syncSpecOverlay(dir, { developer: persona("aaa/agent", { skill: "Rewrite everything." }), guardrails: [] });
  const root = loadRepoRootSpec(dir);
  assert.match(root.skill, /Edit the UI/);
  assert.ok(!/Rewrite everything/.test(root.skill));
});

test("classifySlot sends a code agent to Developer and a policy agent to Guardrails", () => {
  // The curated category wins outright — gstack-agent is developer-tools but
  // tagged "code-review", and it must NOT be mistaken for a reviewer.
  assert.equal(classifySlot({ category: "developer-tools", tags: ["code-review", "plan-review"] }).slot, "developer");
  assert.equal(classifySlot({ category: "developer-tools", description: "design, audit, and refine agents" }).slot, "developer");

  // Guardrail categories, straight from the live registry.
  assert.equal(classifySlot({ category: "compliance" }).slot, "guardrails");
  assert.equal(classifySlot({ category: "governance" }).slot, "guardrails");
  assert.equal(classifySlot({ category: "security" }).slot, "guardrails");

  // A generic category falls back to the tag/description signal.
  assert.equal(classifySlot({ category: "other", tags: ["policy", "firewall"] }).slot, "guardrails");
  assert.equal(classifySlot({ category: "productivity", description: "SEO and copywriting" }).slot, "developer");

  // Nothing declared at all (a synthetic entry for an unindexed repo) → Developer.
  assert.equal(classifySlot({}).slot, "developer");
  // The reason is human-readable, so the panel can explain the assignment.
  assert.match(classifySlot({ category: "compliance" }).reason, /compliance/);
});

test("assignSlot fills one slot without disturbing the rest, and one agent holds one slot", () => {
  const dir = mkdtempSync(join(tmpdir(), "ga-slot-"));
  mkdirSync(join(dir, ".gitagent"), { recursive: true });

  let p = assignSlot(dir, "acme/dev", "developer");
  assert.deepEqual(p, { developer: "acme/dev", guardrails: [], knowledge: null });

  // A second pull adds a guardrail and leaves the developer alone.
  p = assignSlot(dir, "acme/guard", "guardrails");
  assert.equal(p.developer, "acme/dev");
  assert.deepEqual(p.guardrails, ["acme/guard"]);

  // Persisted, so the next edit turn reads it.
  const saved = JSON.parse(readFileSync(join(dir, ".gitagent", "pipeline.json"), "utf8"));
  assert.equal(saved.pipeline.developer, "acme/dev");

  // Re-pulling the same guardrail doesn't duplicate it.
  p = assignSlot(dir, "acme/guard", "guardrails");
  assert.deepEqual(p.guardrails, ["acme/guard"]);

  // Moving the developer into Guardrails takes it out of Developer — otherwise
  // it would write code and then review its own work.
  p = assignSlot(dir, "acme/dev", "guardrails");
  assert.equal(p.developer, null);
  assert.deepEqual(p.guardrails, ["acme/guard", "acme/dev"]);
});

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

// ── Spec authoring (the GitAgent panel's read/write surface) ─────────────────

test("resolveSpecPath confines edits to the agent spec", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-guard-"));
  // Allowed: anything textual under .gitagent/, plus the root manifest.
  assert.ok(resolveSpecPath(dir, ".gitagent/SOUL.md"));
  assert.ok(resolveSpecPath(dir, ".gitagent/skills/ui-editor/SKILL.md"));
  assert.ok(resolveSpecPath(dir, ".gitagent/compliance/RULES.md"));
  assert.ok(resolveSpecPath(dir, "agent.yaml"));
  // Refused: traversal, absolute paths, source code, secrets, non-text files.
  assert.equal(resolveSpecPath(dir, "../../etc/passwd.md"), null);
  assert.equal(resolveSpecPath(dir, ".gitagent/../../escape.md"), null);
  assert.equal(resolveSpecPath(dir, "src/index.js"), null);
  assert.equal(resolveSpecPath(dir, ".env"), null);
  assert.equal(resolveSpecPath(dir, "README.md"), null);
  assert.equal(resolveSpecPath(dir, ".gitagent/logo.png"), null);
  assert.equal(resolveSpecPath(dir, ""), null);
});

test("readSpecFile / writeSpecFile round-trip, and mirror agent.yaml to the root", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-rw-"));
  // A file that doesn't exist yet reads as empty rather than erroring, so the
  // panel can offer to create it.
  const missing = readSpecFile(dir, ".gitagent/RULES.md");
  assert.equal(missing.exists, false);
  assert.equal(missing.content, "");

  writeSpecFile(dir, ".gitagent/RULES.md", "# Rules\nNever touch pricing.ts\n");
  const back = readSpecFile(dir, ".gitagent/RULES.md");
  assert.equal(back.exists, true);
  assert.match(back.content, /Never touch pricing\.ts/);

  // The runtime reads its manifest from <root>/agent.yaml while the developer
  // edits .gitagent/agent.yaml — the two must not drift.
  writeSpecFile(dir, ".gitagent/agent.yaml", "model: groq\n");
  assert.match(readFileSync(join(dir, "agent.yaml"), "utf8"), /model: groq/);
  writeSpecFile(dir, "agent.yaml", "model: anthropic\n");
  assert.match(readFileSync(join(dir, ".gitagent", "agent.yaml"), "utf8"), /model: anthropic/);

  assert.throws(() => writeSpecFile(dir, "../escape.md", "x"), /not an editable part/);
});

test("parseFrontmatter and listSkillsDetailed surface a skill's description", () => {
  assert.deepEqual(
    parseFrontmatter("---\nname: ask\ndescription: Grounded answers\n---\n\n# Ask\n"),
    { name: "ask", description: "Grounded answers" },
  );
  assert.deepEqual(parseFrontmatter("# No frontmatter here"), {});

  const dir = mkdtempSync(join(tmpdir(), "gitagent-skills-"));
  mkdirSync(join(dir, ".gitagent", "skills", "ask"), { recursive: true });
  mkdirSync(join(dir, ".gitagent", "skills", "my-linter"), { recursive: true });
  writeFileSync(join(dir, ".gitagent", "skills", "ask", "SKILL.md"),
    "---\nname: ask\ndescription: Grounded answers\n---\n\n# Ask\n");
  writeFileSync(join(dir, ".gitagent", "skills", "my-linter", "SKILL.md"), "# My linter\n");

  const detailed = listSkillsDetailed(dir).sort((a, b) => a.slug.localeCompare(b.slug));
  assert.deepEqual(detailed[0], {
    slug: "ask", description: "Grounded answers", builtin: true,
    // "" because this one was scaffolded, not written by a pulled registry agent.
    agent: "",
    path: ".gitagent/skills/ask/SKILL.md",
  });
  // A user-authored skill without frontmatter still lists, just without a summary.
  assert.equal(detailed[1].slug, "my-linter");
  assert.equal(detailed[1].builtin, false);
  assert.equal(detailed[1].description, "");
});

test("deleteSkill removes a user skill and refuses a built-in persona", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-del-"));
  mkdirSync(join(dir, ".gitagent", "skills", "my-linter"), { recursive: true });
  mkdirSync(join(dir, ".gitagent", "skills", "snr-developer"), { recursive: true });
  writeFileSync(join(dir, ".gitagent", "skills", "my-linter", "SKILL.md"), "# Mine\n");
  writeFileSync(join(dir, ".gitagent", "skills", "snr-developer", "SKILL.md"), "# Senior\n");

  deleteSkill(dir, "my-linter");
  assert.deepEqual(listSkills(dir), ["snr-developer"]);
  // Deleting a built-in would silently change how the pipeline codes.
  assert.throws(() => deleteSkill(dir, "snr-developer"), /built-in persona/);
  assert.throws(() => deleteSkill(dir, "../../etc"), /invalid skill name/);
  assert.throws(() => deleteSkill(dir, "never-created"), /not found/);
});

test("installedAgentsDetailed lists cloned agents with the spec files they ship", () => {
  const dir = mkdtempSync(join(tmpdir(), "gitagent-inst-"));
  const agent = join(dir, ".gitagent", "agents", "shreyas-lyzr__architect");
  mkdirSync(agent, { recursive: true });
  writeFileSync(join(agent, "SOUL.md"), "I am the architect.");
  writeFileSync(join(agent, "README.md"), "docs");

  const [entry] = installedAgentsDetailed(dir);
  assert.equal(entry.ref, "shreyas-lyzr/architect");
  assert.equal(entry.path, ".gitagent/agents/shreyas-lyzr__architect");
  assert.deepEqual(entry.files, [
    ".gitagent/agents/shreyas-lyzr__architect/SOUL.md",
    ".gitagent/agents/shreyas-lyzr__architect/README.md",
  ]);
});

test("loadRepoRootSpec reads memory from the standard memory/ dir, and falls back", () => {
  // The standard's full layout: memory/MEMORY.md.
  const std = mkdtempSync(join(tmpdir(), "gitagent-mem-std-"));
  mkdirSync(join(std, ".gitagent", "memory"), { recursive: true });
  writeFileSync(join(std, ".gitagent", "SOUL.md"), "I am the agent.");
  writeFileSync(join(std, ".gitagent", "memory", "MEMORY.md"), "UI entry: app/page.tsx");
  assert.match(loadRepoRootSpec(std).memory, /app\/page\.tsx/);

  // A repo scaffolded before the move keeps its memory at the spec root — it
  // must still be read, or that repo silently loses everything it learned.
  const legacy = mkdtempSync(join(tmpdir(), "gitagent-mem-legacy-"));
  mkdirSync(join(legacy, ".gitagent"), { recursive: true });
  writeFileSync(join(legacy, ".gitagent", "SOUL.md"), "I am the agent.");
  writeFileSync(join(legacy, ".gitagent", "MEMORY.md"), "Legacy: pricing.ts is off limits");
  assert.match(loadRepoRootSpec(legacy).memory, /pricing\.ts/);

  // With both present the standard location wins, so a leftover root copy can
  // never shadow the file the generator migrated to.
  const both = mkdtempSync(join(tmpdir(), "gitagent-mem-both-"));
  mkdirSync(join(both, ".gitagent", "memory"), { recursive: true });
  writeFileSync(join(both, ".gitagent", "SOUL.md"), "I am the agent.");
  writeFileSync(join(both, ".gitagent", "memory", "MEMORY.md"), "current memory");
  writeFileSync(join(both, ".gitagent", "MEMORY.md"), "stale memory");
  assert.match(loadRepoRootSpec(both).memory, /current memory/);
});
