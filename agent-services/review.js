// Run the repo's own guardrails over a git range instead of an agent's proposed
// edit — same manifest, same packs, same deny-wins semantics, no IDE.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolvePipelineAgents, loadComplianceRules } from "./registry.js";
import { guardEditBlocks, reviewEditBlocks } from "./guardrails.js";
import { modelFor, firstAvailableProvider, toollessAgentHome } from "./llm.js";

// The repo's own compliance file, as an enforcing pack. It used to be injected into
// the writer's prompt only, so a team's own rules had less force than a pulled one.
export const LOCAL_PACK = ".gitagent/compliance";

export function localPack(dir) {
  const text = (loadComplianceRules(dir) || "").trim();
  return text ? { name: LOCAL_PACK, rules: text } : null;
}

const MAX_FILES = Number(process.env.REVIEW_MAX_FILES) || 25;
const MAX_FILE_CHARS = Number(process.env.REVIEW_MAX_FILE_CHARS) || 12000;
export const AUDIT_DIR = ".gitagent/audit";

// Not worth a model's attention, and a lockfile alone would eat the token budget.
const SKIP_REVIEW = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|.*\.min\.(?:js|css)|.*\.(?:png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip))$/i;

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// Files a range touches. Renames report the new path — the one that gets judged.
export function changedFiles(dir, base, head = "HEAD") {
  let out = "";
  try {
    // Three-dot: what head added since it diverged, which is what a PR proposes.
    out = git(dir, ["diff", "--name-status", "--find-renames", `${base}...${head}`]);
  } catch (e) {
    throw new Error(`could not diff ${base}...${head} — ${String(e.message).split("\n")[0]}`);
  }
  const files = [];
  for (const line of out.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const status = parts[0][0];               // A | M | D | R | C
    const path = parts[parts.length - 1];     // renames put the new path last
    if (status === "D") continue;             // nothing to judge in a deletion
    files.push({ path, status });
  }
  return files;
}

// Content AFTER the change, read from the ref so a dirty worktree can't sway it.
function contentAt(dir, head, path) {
  try {
    const body = git(dir, ["show", `${head}:${path}`]);
    return body.length > MAX_FILE_CHARS ? body.slice(0, MAX_FILE_CHARS) + "\n/* …truncated… */" : body;
  } catch {
    // Not in the ref (e.g. head is the working tree) — fall back to disk.
    const abs = join(dir, ...path.split("/"));
    if (!existsSync(abs)) return "";
    try {
      const body = readFileSync(abs, "utf8");
      return body.length > MAX_FILE_CHARS ? body.slice(0, MAX_FILE_CHARS) + "\n/* …truncated… */" : body;
    } catch { return ""; }
  }
}

// The same { path, content } blocks the edit pipeline produces, so the guardrails
// cannot tell a human's commit from an agent's rewrite.
export function blocksForRange(dir, base, head = "HEAD") {
  const files = changedFiles(dir, base, head);
  const skipped = [];
  const blocks = [];
  for (const f of files) {
    if (SKIP_REVIEW.test(f.path)) { skipped.push({ ...f, why: "generated or binary" }); continue; }
    if (blocks.length >= MAX_FILES) { skipped.push({ ...f, why: "over the file cap" }); continue; }
    const content = contentAt(dir, head, f.path);
    if (!content.trim()) { skipped.push({ ...f, why: "empty or unreadable" }); continue; }
    blocks.push({ path: f.path, content, status: f.status });
  }
  return { blocks, skipped, total: files.length };
}

// One append-only line per decision, so "which pack, which version, which file,
// when" stays answerable after the run.
export function writeAudit(dir, records) {
  if (!records.length) return null;
  const day = new Date().toISOString().slice(0, 10);
  const rel = `${AUDIT_DIR}/${day}.jsonl`;
  const abs = join(dir, ...rel.split("/"));
  mkdirSync(join(dir, ...AUDIT_DIR.split("/")), { recursive: true });
  appendFileSync(abs, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  return rel;
}

function headSha(dir, head) {
  try { return git(dir, ["rev-parse", "--short", head]).trim(); } catch { return ""; }
}

// Printing and exit codes are the CLI's job, so this stays usable from a server.
export async function reviewRange({ dir, base, head = "HEAD", message, onStep } = {}) {
  const step = (name, detail) => { if (onStep) onStep(name, detail); };
  const root = resolve(dir || ".");
  if (!existsSync(join(root, ".git"))) throw new Error(`${root} is not a git repository`);

  const { blocks, skipped, total } = blocksForRange(root, base, head);
  step("Diff", `${total} changed file(s) · ${blocks.length} to review · ${skipped.length} skipped`);
  if (!blocks.length) {
    return { ok: true, verdicts: [], denied: [], skipped, total, agents: null };
  }

  // Same manifest and clone-and-materialise path the IDE uses.
  let agents = { enabled: false, guardrails: [] };
  try {
    agents = await resolvePipelineAgents(root, onStep);
  } catch (e) {
    step("GitAgent", `registry unavailable (${e.message}) · code-level guards only`);
  }

  // Tier 1 — the code floor. No model, so it holds with no network and no keys.
  const floor = guardEditBlocks(blocks);
  if (floor.blocked.length) step("Guardrails", `code floor denied ${floor.blocked.length} file(s)`);

  // Tier 2 — the repo's own rules first, then pulled packs. Enforced identically.
  let reviewed = { allowed: floor.allowed, blocked: [], reviewed: false, why: "" };
  const own = localPack(root);
  if (own) step("Guardrails", `loaded the repo's own rules · ${LOCAL_PACK}`);
  const packs = [
    ...(own ? [own] : []),
    ...(agents.guardrails || []).filter((g) => (g.rules || g.soul || "").trim()),
  ];
  agents = { ...agents, guardrails: packs };
  if (!packs.length) {
    reviewed.why = "no compliance pack assigned";
    step("Guardrails", "no compliance pack assigned · code floor only");
  } else if (!firstAvailableProvider()) {
    reviewed.why = "no provider key configured";
    step("Guardrails", "no provider key · code floor only");
  } else {
    // Ephemeral agent home, not the repo under review — see toollessAgentHome().
    reviewed = await reviewEditBlocks(
      toollessAgentHome(), agents,
      message || `Reviewing the changes in ${base}...${head}`,
      floor.allowed, modelFor("groq"), step,
    );
  }

  const denied = [...floor.blocked, ...reviewed.blocked];
  const sha = headSha(root, head);
  const at = new Date().toISOString();
  // pack@sha, so a record says WHICH version of a rule set produced the verdict.
  const packNames = packs.map((p) => (p.sha ? `${p.name}@${p.sha.slice(0, 7)}` : p.name));
  const unpinned = packs.filter((p) => p.sha && !p.pin).map((p) => p.name);
  if (unpinned.length) step("Guardrails", `unpinned pack(s): ${unpinned.join(", ")}`);

  // A file that only went through because the review could not run is "unreviewed",
  // never "allow" — the gate still passes, but the evidence says what happened.
  const passDecision = reviewed.reviewed ? "allow" : "unreviewed";
  const verdicts = [
    ...reviewed.allowed.map((b) => ({
      path: b.path,
      decision: passDecision,
      reason: reviewed.reviewed ? "" : (reviewed.why || "the guardrail review did not run"),
    })),
    ...denied.map((b) => ({ path: b.path, decision: "deny", reason: b.reason || "" })),
  ].sort((a, b) => a.path.localeCompare(b.path));

  const auditPath = writeAudit(root, verdicts.map((v) => ({
    at, base, head, commit: sha,
    packs: packNames,
    file: v.path,
    decision: v.decision,
    reason: v.reason || undefined,
  })));

  return {
    ok: denied.length === 0,
    reviewed: reviewed.reviewed,
    verdicts, denied, skipped, total,
    packs: packNames,
    unpinned,
    commit: sha,
    auditPath,
  };
}
