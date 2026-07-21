// Tests for the toolless Ask/Edit machinery. Run: `node --test` in agent-services.
// AGENT_NO_LISTEN keeps importing server.js from binding a port.
import { test } from "node:test";
import assert from "node:assert";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.AGENT_NO_LISTEN = "1";
const {
  resolveTurnMode, extractSearchTerms, parseEditBlocks, applyEditBlocks, gatherEditFiles,
} = await import("./server.js");

test("resolveTurnMode routes edit intent to edit, questions to ask", () => {
  assert.equal(resolveTurnMode("", "change the ui to dark theme"), "edit");
  assert.equal(resolveTurnMode("", "add a footer component"), "edit");
  assert.equal(resolveTurnMode("", "fix the checkout bug"), "edit");
  assert.equal(resolveTurnMode("", "summarize this app"), "ask");
  assert.equal(resolveTurnMode("", "where is login handled?"), "ask");
  // explicit client mode always wins
  assert.equal(resolveTurnMode("ask", "add a button"), "ask");
  assert.equal(resolveTurnMode("agent", "summarize"), "agent");
});

test("extractSearchTerms drops stopwords and prefers identifiers", () => {
  const terms = extractSearchTerms("where is the AuthProvider signIn defined");
  assert.ok(terms.includes("AuthProvider"));
  assert.ok(terms.includes("signIn"));
  assert.ok(!terms.includes("defined")); // code-generic stopword
});

test("parseEditBlocks parses SEARCH/REPLACE blocks", () => {
  const reply = [
    "<file>app/page.tsx</file>",
    "<<<<<<< SEARCH",
    "old line",
    "=======",
    "new line",
    ">>>>>>> REPLACE",
  ].join("\n");
  const blocks = parseEditBlocks(reply);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].path, "app/page.tsx");
  assert.equal(blocks[0].search, "old line");
  assert.equal(blocks[0].replace, "new line");
});

test("applyEditBlocks edits an existing file", () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-apply-"));
  mkdirSync(join(dir, "app"), { recursive: true });
  writeFileSync(join(dir, "app", "page.tsx"), 'return <div className="bg-white">Hi</div>\n');
  const blocks = parseEditBlocks(
    '<file>app/page.tsx</file>\n<<<<<<< SEARCH\nreturn <div className="bg-white">Hi</div>\n=======\nreturn <div className="bg-gray-900">Hi</div>\n>>>>>>> REPLACE',
  );
  const results = applyEditBlocks(dir, blocks);
  assert.equal(results[0].status, "edited");
  assert.ok(readFileSync(join(dir, "app", "page.tsx"), "utf8").includes("bg-gray-900"));
});

test("applyEditBlocks creates a new file on empty SEARCH", () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-new-"));
  const blocks = parseEditBlocks("<file>theme.ts</file>\n<<<<<<< SEARCH\n\n=======\nexport const dark = true\n>>>>>>> REPLACE");
  const results = applyEditBlocks(dir, blocks);
  assert.equal(results[0].status, "created");
  assert.ok(readFileSync(join(dir, "theme.ts"), "utf8").includes("dark = true"));
});

test("applyEditBlocks rejects path traversal outside the workspace", () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-evil-"));
  const blocks = parseEditBlocks("<file>../../etc/x</file>\n<<<<<<< SEARCH\n\n=======\nhacked\n>>>>>>> REPLACE");
  const results = applyEditBlocks(dir, blocks);
  assert.match(results[0].status, /rejected/);
});

test("applyEditBlocks reports when SEARCH text is not found", () => {
  const dir = mkdtempSync(join(tmpdir(), "edit-miss-"));
  writeFileSync(join(dir, "a.js"), "const x = 1\n");
  const blocks = parseEditBlocks("<file>a.js</file>\n<<<<<<< SEARCH\nconst y = 2\n=======\nconst y = 3\n>>>>>>> REPLACE");
  const results = applyEditBlocks(dir, blocks);
  assert.match(results[0].status, /not found/);
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
