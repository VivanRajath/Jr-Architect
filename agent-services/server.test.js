// Tests for the toolless Ask/Edit machinery. Run: `node --test` in agent-services.
// AGENT_NO_LISTEN keeps importing server.js from binding a port.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_NO_LISTEN = "1";
// Point the registry index at a dead port so no test touches the network: the
// fetch fails, findAgent synthesizes the entry, and a pre-seeded clone is reused.
process.env.GITAGENT_REGISTRY_INDEX = "http://127.0.0.1:1/index.json";
const {
  resolveTurnMode, heuristicMode, extractSearchTerms, parseEditBlocks, applyEditBlocks, gatherEditFiles,
  classifyEditComplexity, guardEditBlocks, buildGuardrailPrompt, reviewEditBlocks,
  applyGuardrailVerdicts, server,
} = await import("./server.js");

// Drive the real routes over HTTP. Calling a route's helpers proves the helpers
// work; only a request proves the route does.
async function withServer(fn) {
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  try { return await fn((path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })); } finally { await new Promise((r) => server.close(r)); }
}

test("POST /agent/gitagent/install pulls an agent and reports what it wrote", async () => {
  const dir = mkdtempSync(join(tmpdir(), "pull-route-"));
  writeFileSync(join(dir, "agent.yaml"), "name: demo\n");
  // A pre-seeded clone: installAgent sees .git and reuses it, so no network.
  mkdirSync(join(dir, ".gitagent", "agents", "acme__guard", ".git"), { recursive: true });
  writeFileSync(join(dir, ".gitagent", "agents", "acme__guard", "RULES.md"), "# Rules\n- No raw SQL.\n");

  const body = await withServer(async (post) => {
    const reg = await post("/agent/register", { container: "c1", workdir: dir, stack: "node" });
    assert.equal(reg.status, 200);
    const res = await post("/agent/gitagent/install", { container: "c1", ref: "acme/guard", slot: "guardrails" });
    const text = await res.text(); // read once — the assert message needs it too
    assert.equal(res.status, 200, `install failed: ${text}`);
    return JSON.parse(text);
  });

  assert.equal(body.ref, "acme/guard");
  assert.equal(body.slot, "guardrails");
  // The pull must have written the agent INTO the spec folder, and said so.
  const wrote = body.files.map((f) => f.path);
  assert.ok(wrote.includes(".gitagent/compliance/acme__guard.md"), wrote.join(", "));
  assert.ok(wrote.includes(".gitagent/workflows/acme__guard.md"));
  assert.match(readFileSync(join(dir, ".gitagent", "compliance", "acme__guard.md"), "utf8"), /No raw SQL/);
  // And the status it returns points the panel at those files.
  assert.deepEqual(body.status.guardrails[0].specFiles,
    [".gitagent/compliance/acme__guard.md", ".gitagent/workflows/acme__guard.md"]);
});

test("applyGuardrailVerdicts blocks only an explicit deny, and names the agent", () => {
  const blocks = [
    { path: "app/page.tsx", content: "a" },
    { path: "app/pay.ts", content: "b" },
    { path: "app/util.ts", content: "c" },
  ];
  const { allowed, blocked } = applyGuardrailVerdicts(blocks, [
    { path: "app/page.tsx", allow: true },
    { path: "app/pay.ts", allow: false, reason: "stores card data in plain text" },
    // app/util.ts has no verdict — silence must not block it
  ], "acme/guard");
  assert.deepEqual(allowed.map((b) => b.path), ["app/page.tsx", "app/util.ts"]);
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].path, "app/pay.ts");
  assert.match(blocked[0].reason, /acme\/guard: stores card data/);
});

test("reviewEditBlocks is a no-op when no guardrail agent is installed", async () => {
  const blocks = [{ path: "a.js", content: "x" }];
  const steps = [];
  // No model call happens on this path — if one did, the test would hang/throw.
  const out = await reviewEditBlocks("/tmp", { enabled: true, guardrails: [] }, "make it dark",
    blocks, "groq:llama-3.3-70b-versatile", (n, d) => steps.push(`${n}:${d}`));
  assert.deepEqual(out, { allowed: blocks, blocked: [] });
  assert.equal(steps.length, 0);
  // An agent that ships no rules and no soul is likewise nothing to enforce.
  const empty = await reviewEditBlocks("/tmp", { enabled: true, guardrails: [{ name: "a/b", rules: "", soul: "" }] },
    "make it dark", blocks, "groq:llama-3.3-70b-versatile", () => {});
  assert.deepEqual(empty.allowed, blocks);
});

test("buildGuardrailPrompt shows the rules, every file, and asks for JSON verdicts", () => {
  const p = buildGuardrailPrompt(
    [{ name: "acme/guard", text: "Never log a credit card number." }],
    "add payment logging",
    [{ path: "app/pay.ts", content: "console.log(card)" }, { path: "app/ui.tsx", content: "<div/>" }],
  );
  assert.match(p, /acme\/guard/);
  assert.match(p, /Never log a credit card number/);
  assert.match(p, /=== FILE: app\/pay\.ts ===/);
  assert.match(p, /=== FILE: app\/ui\.tsx ===/);
  assert.match(p, /"verdicts"/);
  // Taste is not grounds to block — the reviewer must only enforce the rules.
  assert.match(p, /formatting, and taste are NOT grounds to block/);
});

test("buildGuardrailPrompt truncates a large file to stay inside the token budget", () => {
  const huge = "x".repeat(50000);
  const p = buildGuardrailPrompt([{ name: "a/b", text: "rule" }], "change it", [{ path: "big.js", content: huge }]);
  assert.ok(p.length < 12000, `prompt was ${p.length} chars`);
  assert.match(p, /truncated/);
});

test("resolveTurnMode routes edit intent to edit, questions to ask", () => {
  assert.equal(resolveTurnMode("", "change the ui to dark theme"), "edit");
  assert.equal(resolveTurnMode("", "add a footer component"), "edit");
  assert.equal(resolveTurnMode("", "fix the checkout bug"), "edit");
  // imperative styling command — the case that used to narrate instead of edit
  assert.equal(resolveTurnMode("", "make the ui dark red theme"), "edit");
  assert.equal(resolveTurnMode("", "turn the theme purple"), "edit");
  assert.equal(resolveTurnMode("", "summarize this app"), "ask");
  assert.equal(resolveTurnMode("", "where is login handled?"), "ask");
  // "make" without a style target stays a question
  assert.equal(resolveTurnMode("", "make a summary of the repo"), "ask");
  // "rebrand" is now a recognized edit verb (the case that used to narrate)
  assert.equal(resolveTurnMode("", "rebrand the heading to Re-work"), "edit");
  // explicit client mode always wins
  assert.equal(resolveTurnMode("ask", "add a button"), "ask");
  assert.equal(resolveTurnMode("agent", "summarize"), "agent");
});

test("heuristicMode returns null for genuinely ambiguous messages (→ LLM router)", () => {
  // No edit verb, no question opener → the Orchestrator hands it to the LLM.
  assert.equal(heuristicMode("the hero text should say Launch instead of Start"), null);
  assert.equal(heuristicMode("swap the two buttons in the navbar"), null);
  // Confident cases don't waste an LLM call.
  assert.equal(heuristicMode("summarize this codespace"), "ask");
  assert.equal(heuristicMode("rebrand the title"), "edit");
});

test("classifyEditComplexity picks junior vs senior tiers", () => {
  const junior = classifyEditComplexity("make the header dark", 3);
  assert.equal(junior.tier, "junior");
  assert.ok(junior.maxFiles <= 2);
  const senior = classifyEditComplexity("refactor the theme across all components", 3);
  assert.equal(senior.tier, "senior");
  assert.ok(senior.maxFiles >= 2);
  // multi-file wording but only one candidate file → stays junior
  assert.equal(classifyEditComplexity("refactor everywhere", 1).tier, "junior");
});

test("guardEditBlocks blocks sensitive files and secret injection", () => {
  const blocks = [
    { path: "app/page.tsx", content: "export default function P(){return null}" },
    { path: ".env", content: "X=1" },
    { path: "package-lock.json", content: "{}" },
    { path: "lib/key.ts", content: "const k = 'gsk_abcdefghijklmnopqrstuvwxyz012345'" },
  ];
  const { allowed, blocked } = guardEditBlocks(blocks);
  assert.deepEqual(allowed.map((b) => b.path), ["app/page.tsx"]);
  assert.equal(blocked.length, 3);
  assert.ok(blocked.some((b) => b.path === ".env" && /sensitive/.test(b.reason)));
  assert.ok(blocked.some((b) => b.path === "lib/key.ts" && /secret/.test(b.reason)));
});

test("extractSearchTerms drops stopwords and prefers identifiers", () => {
  const terms = extractSearchTerms("where is the AuthProvider signIn defined");
  assert.ok(terms.includes("AuthProvider"));
  assert.ok(terms.includes("signIn"));
  assert.ok(!terms.includes("defined")); // code-generic stopword
});

test("parseEditBlocks parses whole-file blocks (both formats)", () => {
  const reply = [
    "=== FILE: app/page.tsx ===",
    "export default function Page(){ return <div/> }",
    "=== END FILE ===",
    "",
    '<file path="app/globals.css">',
    "body{color:white}",
    "</file>",
  ].join("\n");
  const blocks = parseEditBlocks(reply);
  assert.equal(blocks.length, 2);
  assert.equal(blocks[0].path, "app/page.tsx");
  assert.ok(blocks[0].content.includes("export default"));
  assert.equal(blocks[1].path, "app/globals.css");
  assert.ok(blocks[1].content.includes("color:white"));
});

test("parseEditBlocks ignores a truncated (unclosed) block", () => {
  // No closing "=== END FILE ===" → the reply was cut off by the output cap.
  const reply = "=== FILE: app/page.tsx ===\nexport default function Page(){ return <div";
  assert.equal(parseEditBlocks(reply).length, 0);
});

test("parseEditBlocks strips a code fence around the body", () => {
  const reply = "=== FILE: a.ts ===\n```ts\nexport const x = 1\n```\n=== END FILE ===";
  const blocks = parseEditBlocks(reply);
  assert.equal(blocks[0].content.trim(), "export const x = 1");
});

test("applyEditBlocks overwrites an offered file with its new contents", () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-apply-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "page.tsx"), 'return <div className="bg-white">Hi</div>\n');
  const blocks = parseEditBlocks(
    '=== FILE: app/page.tsx ===\nreturn <div className="bg-gray-900">Hi</div>\n=== END FILE ===',
  );
  const results = applyEditBlocks(dir, blocks, [{ path: "app/page.tsx" }]);
  assert.equal(results[0].status, "edited");
  assert.ok(readFileSync(join(dir, "app", "page.tsx"), "utf8").includes("bg-gray-900"));
});

test("applyEditBlocks creates a brand-new file", () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-new-"));
  const blocks = parseEditBlocks("=== FILE: theme.ts ===\nexport const dark = true\n=== END FILE ===");
  const results = applyEditBlocks(dir, blocks, []);
  assert.equal(results[0].status, "created");
  assert.ok(readFileSync(join(dir, "theme.ts"), "utf8").includes("dark = true"));
});

test("applyEditBlocks rejects path traversal outside the workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-evil-"));
  const blocks = parseEditBlocks("=== FILE: ../../etc/x ===\nhacked\n=== END FILE ===");
  const results = applyEditBlocks(dir, blocks, []);
  assert.match(results[0].status, /rejected/);
});

test("applyEditBlocks won't clobber an existing file it wasn't offered", () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-guard-"));
  writeFileSync(join(dir, "a.js"), "const x = 1\n");
  const blocks = parseEditBlocks("=== FILE: a.js ===\nconst x = 99\n=== END FILE ===");
  const results = applyEditBlocks(dir, blocks, [{ path: "b.js" }]);
  assert.match(results[0].status, /not offered/);
  assert.ok(readFileSync(join(dir, "a.js"), "utf8").includes("const x = 1"));
});

test("gatherEditFiles includes the UI entry and style files for a theme change", async () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-gather-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "page.tsx"), "export default function Page(){return null}\n");
  writeFileSync(join(dir, "app", "globals.css"), "body{color:black}\n");
  const files = await gatherEditFiles(dir, "change the ui to dark theme");
  const paths = files.map((f) => f.path);
  assert.ok(paths.includes("app/page.tsx"));
  assert.ok(paths.includes("app/globals.css"));
});
