// Headless review: run this repository's own guardrails over a diff, with no IDE.
//
// THE POINT
// Until now a pulled compliance pack only had force while someone had the IDE open
// and typed into a chat box. That makes it a suggestion — the agent gets blocked
// and the human typing the same line does not. A rule that only applies when a
// developer is watching is not compliance.
//
// This module runs the IDENTICAL pipeline against a git range instead of an agent's
// proposed edit: same `.gitagent/pipeline.json`, same pulled packs, same code-level
// floor, same model review, same deny-wins semantics. The only thing that changes
// is where the "proposed content" comes from — a diff rather than a rewrite.
//
// That is what makes `.gitagent/` a property of the REPOSITORY rather than of a
// session: clone the repo anywhere, run this, and the same rules apply.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { resolvePipelineAgents, loadComplianceRules } from "./registry.js";
import { guardEditBlocks, reviewEditBlocks } from "./guardrails.js";
import { modelFor, firstAvailableProvider, toollessAgentHome } from "./llm.js";

// The repo's OWN rules, as an enforcing pack.
//
// `.gitagent/compliance/RULES.md` was only ever injected into the Developer's
// prompt — advice the writer could ignore, with nothing checking afterwards. Only
// PULLED packs reached the review stage and could actually deny. That is backwards:
// the rules a team wrote and committed themselves should have at least as much
// force as one they downloaded. Here they get exactly the same force.
export const LOCAL_PACK = ".gitagent/compliance";

export function localPack(dir) {
  const text = (loadComplianceRules(dir) || "").trim();
  return text ? { name: LOCAL_PACK, rules: text } : null;
}

const MAX_FILES = Number(process.env.REVIEW_MAX_FILES) || 25;
const MAX_FILE_CHARS = Number(process.env.REVIEW_MAX_FILE_CHARS) || 12000;
export const AUDIT_DIR = ".gitagent/audit";

// Reviewing a lockfile or a minified bundle costs the whole token budget and
// teaches nothing. The tier-1 guard refuses to let an AGENT touch these; for a
// human diff they are simply not worth a model's attention.
const SKIP_REVIEW = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|go\.sum|Cargo\.lock|.*\.min\.(?:js|css)|.*\.(?:png|jpe?g|gif|svg|ico|woff2?|ttf|pdf|zip))$/i;

function git(dir, args) {
  return execFileSync("git", args, { cwd: dir, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
}

// The files a range touches, with their status. Renames report the new path,
// which is the one whose content gets judged.
export function changedFiles(dir, base, head = "HEAD") {
  let out = "";
  try {
    // Three-dot: what HEAD added since it diverged from base, not everything that
    // happened on base meanwhile. That is what a pull request actually proposes.
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

// The content a reviewer must judge is the content AFTER the change. Read it from
// the ref rather than the worktree so a dirty checkout can't change the verdict.
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

// Turn a diff into the same { path, content } blocks the edit pipeline produces,
// so the guardrails cannot tell the difference between an agent's rewrite and a
// human's commit. That is the whole trick.
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

// Append one line per decision to .gitagent/audit/<date>.jsonl.
//
// A denial that only ever appears in a chat summary is friction; a denial that
// lands in a committed, append-only file is EVIDENCE. This is the half that makes
// the compliance story purchasable: "which pack, which version, which rule, which
// file, when" is answerable, and the answer is a git diff.
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

// Run the repo's guardrails over a range. Returns a structured result; printing and
// exit codes are the CLI's job, so this stays usable from a server too.
export async function reviewRange({ dir, base, head = "HEAD", message, onStep } = {}) {
  const step = (name, detail) => { if (onStep) onStep(name, detail); };
  const root = resolve(dir || ".");
  if (!existsSync(join(root, ".git"))) throw new Error(`${root} is not a git repository`);

  const { blocks, skipped, total } = blocksForRange(root, base, head);
  step("Diff", `${total} changed file(s) · ${blocks.length} to review · ${skipped.length} skipped`);
  if (!blocks.length) {
    return { ok: true, verdicts: [], denied: [], skipped, total, agents: null };
  }

  // Same manifest, same packs, same clone-and-materialise path the IDE uses.
  let agents = { enabled: false, guardrails: [] };
  try {
    agents = await resolvePipelineAgents(root, onStep);
  } catch (e) {
    step("GitAgent", `registry unavailable (${e.message}) · code-level guards only`);
  }

  // Tier 1 — the code floor. No model, so it holds with no network and no keys.
  const floor = guardEditBlocks(blocks);
  if (floor.blocked.length) step("Guardrails", `code floor denied ${floor.blocked.length} file(s)`);

  // Tier 2 — the packs. The repo's own committed rules go FIRST, then anything
  // pulled from the registry. Both are enforced identically.
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
    // The agent home for the review turn is an ephemeral one, NOT the repository
    // under review — see toollessAgentHome(). The rules come from the packs and the
    // content comes from the diff; nothing else may influence a verdict.
    reviewed = await reviewEditBlocks(
      toollessAgentHome(), agents,
      message || `Reviewing the changes in ${base}...${head}`,
      floor.allowed, modelFor("groq"), step,
    );
  }

  const denied = [...floor.blocked, ...reviewed.blocked];
  const sha = headSha(root, head);
  const at = new Date().toISOString();
  const packNames = packs.map((p) => p.name);

  // A file the packs genuinely cleared is "allow". A file that went through only
  // because the review could not run is "unreviewed" — the exit code still passes
  // (that is what fail-open means) but the evidence says so plainly.
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
    commit: sha,
    auditPath,
  };
}
