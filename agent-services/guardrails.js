

import { collectTurn, parseJsonLoose, AGENT_MAX_OUTPUT_TOKENS } from "./llm.js";

// ── Tier 1: the code floor (no model) ────────────────────────────────────────
// Fixed rules that hold even when every provider is down. This is the difference
// between a guardrail and a suggestion.

export const GUARD_SENSITIVE_PATH = /(?:^|\/)(?:\.env(?:\..*)?|.*\.lock|package-lock\.json|yarn\.lock|pnpm-lock\.yaml)$|(?:^|\/)\.git\//i;
export const GUARD_SECRET = /sk-[A-Za-z0-9]{16,}|gsk_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{20,}|-----BEGIN [A-Z ]*PRIVATE KEY-----/;

// Partition parsed edit blocks into what's safe to apply and what to refuse.
export function guardEditBlocks(blocks) {
  const allowed = [];
  const blocked = [];
  for (const b of blocks) {
    if (GUARD_SENSITIVE_PATH.test(b.path)) { blocked.push({ ...b, reason: "sensitive/generated file" }); continue; }
    if (GUARD_SECRET.test(b.content)) { blocked.push({ ...b, reason: "would introduce a secret" }); continue; }
    allowed.push(b);
  }
  return { allowed, blocked };
}

// ── Tier 2: the pulled packs (model review) ──────────────────────────────────
// The regex floor above is fixed. This is the part an installed guardrail agent
// actually drives: it sees the proposed content and can DENY it. Without this pass
// a pulled pack is only advice inside the writer's own prompt, which a weak model
// ignores; here its verdict is enforced in code.

const GUARD_REVIEW_FILE_CHARS = Number(process.env.GITAGENT_GUARDRAIL_FILE_CHARS) || 1200;
const GUARD_REVIEW_TOTAL_CHARS = Number(process.env.GITAGENT_GUARDRAIL_TOTAL_CHARS) || 5000;
// A guardrail that can't be reached must not silently wedge the IDE, so the
// default is fail-open with a visible warning. Set GITAGENT_GUARDRAIL_FAIL=closed
// for a workspace where an unreviewed edit is worse than no edit — CI sets this.
const GUARD_FAIL_CLOSED = process.env.GITAGENT_GUARDRAIL_FAIL === "closed";

export function buildGuardrailPrompt(rules, message, blocks) {
  let budget = GUARD_REVIEW_TOTAL_CHARS;
  const shown = blocks.map((b) => {
    const cap = Math.max(0, Math.min(GUARD_REVIEW_FILE_CHARS, budget));
    budget -= cap;
    const body = b.content.length > cap ? b.content.slice(0, cap) + "\n/* …truncated… */" : b.content;
    return `=== FILE: ${b.path} ===\n${body}\n=== END ===`;
  }).join("\n\n");

  return (
    `You are the GUARDRAIL reviewer for this repository. You do not write code. ` +
    `You decide whether each proposed file change may be applied.\n\n` +
    `--- RULES YOU ENFORCE ---\n` +
    rules.map((r) => `[${r.name}]\n${r.text}`).join("\n\n") +
    `\n--- END RULES ---\n\n` +
    `The user asked: "${String(message).slice(0, 300)}"\n\n` +
    `Below is the proposed new content of each file. Judge ONLY against the rules ` +
    `above. Style preferences, formatting, and taste are NOT grounds to block — ` +
    `block only a real violation of a stated rule.\n\n${shown}\n\n` +
    `Reply with ONLY a JSON object, no prose:\n` +
    `{"verdicts":[{"path":"<exact path above>","allow":true|false,"reason":"<=15 words, required when allow is false"}]}\n` +
    `Omit nothing: include one verdict per file.`
  );
}

// Turn the reviewer's verdicts into the { allowed, blocked } split. Pure, so the
// deny logic is testable without a model. A file with no verdict is ALLOWED —
// silence is not a denial, and a model that drops a row from its JSON must not
// take an unrelated file down with it.
export function applyGuardrailVerdicts(blocks, verdicts, names) {
  const denied = new Map();
  for (const v of verdicts) {
    if (!v || v.allow !== false) continue;                  // only an explicit false denies
    denied.set(String(v.path || "").trim(), String(v.reason || "violates a guardrail rule").slice(0, 160));
  }
  const allowed = [];
  const blocked = [];
  for (const b of blocks) {
    const reason = denied.get(b.path);
    if (reason) blocked.push({ ...b, reason: `${names}: ${reason}` });
    else allowed.push(b);
  }
  return { allowed, blocked };
}

// Run the guardrail agents over the parsed blocks. Returns the same
// { allowed, blocked } shape as guardEditBlocks so the caller merges them freely.
// `reviewed` says whether a verdict was actually obtained. A caller that records
// evidence MUST distinguish "a pack looked at this and allowed it" from "nothing
// looked at this and we let it through" — an audit trail that logs the second as
// the first is worse than no audit trail, because it reads as proof of a check
// that never happened.
export async function reviewEditBlocks(dir, agents, message, blocks, model, step) {
  const rules = ((agents && agents.guardrails) || [])
    .map((g) => ({ name: g.name, text: (g.rules || g.soul || "").trim() }))
    .filter((g) => g.text);
  if (!rules.length || !blocks.length) {
    return { allowed: blocks, blocked: [], reviewed: false, why: "no pack assigned" };
  }

  const names = rules.map((r) => r.name).join(", ");
  step("Guardrails", `reviewing ${blocks.length} file(s) as ${names}`);

  const { text, error } = await collectTurn({
    prompt: buildGuardrailPrompt(rules, message, blocks),
    dir,
    model,
    replaceBuiltinTools: true,
    allowedTools: [],
    constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
  }, model);

  const parsed = (error && !text) ? null : parseJsonLoose(text);
  const verdicts = parsed && Array.isArray(parsed.verdicts) ? parsed.verdicts : null;
  if (!verdicts) {
    const why = error ? error.slice(0, 80) : "no usable verdict";
    if (GUARD_FAIL_CLOSED) {
      step("Guardrails", `review failed (${why}) · blocking (fail-closed)`);
      return {
        allowed: [],
        blocked: blocks.map((b) => ({ ...b, reason: `guardrail review unavailable (${why})` })),
        reviewed: false, why,
      };
    }
    step("Guardrails", `review failed (${why}) · applying unreviewed`);
    return { allowed: blocks, blocked: [], reviewed: false, why };
  }

  const out = applyGuardrailVerdicts(blocks, verdicts, names);
  step("Guardrails", out.blocked.length ? `denied ${out.blocked.length} file(s)` : "approved");
  return { ...out, reviewed: true };
}
