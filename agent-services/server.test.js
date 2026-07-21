// Tests for the toolless Ask/Edit machinery. Run: `node --test` in agent-services.
// AGENT_NO_LISTEN keeps importing server.js from binding a port.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_NO_LISTEN = "1";
const {
  resolveTurnMode, heuristicMode, extractSearchTerms, parseEditBlocks, applyEditBlocks, gatherEditFiles,
  classifyEditComplexity, guardEditBlocks,
} = await import("./server.js");

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
