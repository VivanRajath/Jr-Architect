import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  changedFiles, blocksForRange, writeAudit, localPack, reviewRange, LOCAL_PACK, AUDIT_DIR,
} from "./review.js";
import { guardEditBlocks, applyGuardrailVerdicts } from "./guardrails.js";

// A real git repository, because the whole point of this module is that it reads a
// diff. Faking git here would test nothing that matters.
function repo() {
  const dir = mkdtempSync(join(tmpdir(), "jr-review-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  const put = (rel, body) => {
    const abs = join(dir, ...rel.split("/"));
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, body);
  };
  git("init", "-q");
  git("config", "user.email", "t@t.t");
  git("config", "user.name", "T");
  return { dir, git, put };
}

function commitAll(r, msg) {
  r.git("add", "-A");
  r.git("commit", "-qm", msg);
}

test("changedFiles reads a range and ignores deletions", () => {
  const r = repo();
  r.put("a.js", "export const a = 1;\n");
  r.put("gone.js", "export const g = 1;\n");
  commitAll(r, "base");

  r.put("b.js", "export const b = 2;\n");
  r.put("a.js", "export const a = 99;\n");
  execFileSync("git", ["rm", "-q", "gone.js"], { cwd: r.dir });
  commitAll(r, "change");

  const files = changedFiles(r.dir, "HEAD~1").map((f) => f.path).sort();
  assert.deepEqual(files, ["a.js", "b.js"], "a deleted file has no content to judge");
});

test("blocksForRange judges the content AFTER the change", () => {
  const r = repo();
  r.put("a.js", "old\n");
  commitAll(r, "base");
  r.put("a.js", "new\n");
  commitAll(r, "change");

  const { blocks } = blocksForRange(r.dir, "HEAD~1");
  assert.equal(blocks.length, 1);
  assert.match(blocks[0].content, /new/);
  assert.doesNotMatch(blocks[0].content, /old/);
});

test("blocksForRange reads the ref, not a dirty worktree", () => {
  const r = repo();
  r.put("a.js", "committed\n");
  commitAll(r, "base");
  r.put("a.js", "changed\n");
  commitAll(r, "change");
  // Someone's editor has unsaved junk in the file. A verdict must not depend on it.
  r.put("a.js", "LOCAL SCRATCH\n");

  const { blocks } = blocksForRange(r.dir, "HEAD~1");
  assert.match(blocks[0].content, /changed/);
  assert.doesNotMatch(blocks[0].content, /SCRATCH/);
});

test("lockfiles and binaries are skipped rather than burned on the token budget", () => {
  const r = repo();
  r.put("seed.txt", "x\n");
  commitAll(r, "base");
  r.put("package-lock.json", '{"lockfileVersion":3}\n');
  r.put("logo.png", "not really a png\n");
  r.put("src/real.js", "export const real = 1;\n");
  commitAll(r, "change");

  const { blocks, skipped } = blocksForRange(r.dir, "HEAD~1");
  assert.deepEqual(blocks.map((b) => b.path), ["src/real.js"]);
  assert.deepEqual(skipped.map((s) => s.path).sort(), ["logo.png", "package-lock.json"]);
});

// ── The repo's own rules are enforced, not just injected ─────────────────────

test("localPack turns the repo's committed compliance file into an enforcing pack", () => {
  const r = repo();
  r.put(".gitagent/compliance/RULES.md", "---\nname: compliance\n---\n\n# Compliance\n\n## Never\n- Log a password.\n");
  assert.equal(localPack(r.dir).name, LOCAL_PACK);
  assert.match(localPack(r.dir).rules, /Log a password/);
});

test("a repo with no compliance file has no local pack", () => {
  assert.equal(localPack(repo().dir), null);
});

// ── The code floor still gates with no model and no network ──────────────────

test("the code floor denies a secret and a protected path with no provider at all", () => {
  const { blocked } = guardEditBlocks([
    { path: "src/ok.js", content: "export const a = 1;\n" },
    { path: ".env", content: "X=1\n" },
    { path: "src/leak.js", content: "const k = 'gsk_abcdefghijklmnopqrstuvwxyz012345';\n" },
  ]);
  assert.deepEqual(blocked.map((b) => b.path).sort(), [".env", "src/leak.js"]);
});

// ── Evidence must not overstate what happened ────────────────────────────────

test("a review with no pack records 'unreviewed', never 'allow'", async () => {
  const r = repo();
  r.put("a.js", "old\n");
  commitAll(r, "base");
  r.put("a.js", "new\n");
  commitAll(r, "change");

  // No .gitagent/compliance, no manifest — nothing can have looked at this file.
  const res = await reviewRange({ dir: r.dir, base: "HEAD~1" });
  assert.equal(res.ok, true, "nothing was denied, so the gate passes");
  assert.equal(res.reviewed, false);
  assert.equal(res.verdicts[0].decision, "unreviewed",
    "logging this as 'allow' would read as proof of a check that never ran");
  assert.match(res.verdicts[0].reason, /no compliance pack/);
});

test("writeAudit appends JSONL and never rewrites history", () => {
  const r = repo();
  const rel = writeAudit(r.dir, [{ file: "a.js", decision: "deny", reason: "first" }]);
  assert.equal(rel, `${AUDIT_DIR}/${new Date().toISOString().slice(0, 10)}.jsonl`);
  writeAudit(r.dir, [{ file: "b.js", decision: "allow" }]);

  const lines = readFileSync(join(r.dir, ...rel.split("/")), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "the second write appends, it does not replace");
  assert.equal(JSON.parse(lines[0]).reason, "first");
  assert.equal(JSON.parse(lines[1]).file, "b.js");
});

test("reviewRange refuses a directory that is not a git repository", async () => {
  const dir = mkdtempSync(join(tmpdir(), "jr-not-git-"));
  await assert.rejects(() => reviewRange({ dir, base: "main" }), /not a git repository/);
});

test("reviewRange reports a bad ref instead of silently passing", async () => {
  const r = repo();
  r.put("a.js", "x\n");
  commitAll(r, "base");
  await assert.rejects(() => reviewRange({ dir: r.dir, base: "no-such-ref" }), /could not diff/);
});

// ── Deny semantics carry over unchanged from the IDE path ────────────────────

test("only an explicit allow:false denies — a dropped verdict row does not", () => {
  const blocks = [{ path: "a.js", content: "" }, { path: "b.js", content: "" }];
  const out = applyGuardrailVerdicts(blocks, [{ path: "a.js", allow: false, reason: "raw SQL" }], "pack");
  assert.deepEqual(out.blocked.map((b) => b.path), ["a.js"]);
  assert.deepEqual(out.allowed.map((b) => b.path), ["b.js"], "silence is not a denial");
  assert.match(out.blocked[0].reason, /pack: raw SQL/);
});
