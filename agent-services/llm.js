

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query } from "gitclaw";
import { getModels } from "@mariozechner/pi-ai";

// Map the UI's provider selector to a gitclaw model id. Each is overridable via
// env so operators can point a provider at whatever model their gitclaw build
// supports without a code change.
export const PROVIDER_MODELS = {
  // llama-3.3-70b-versatile is the tool-capable model available on Groq's free
  // tier. It occasionally emits a malformed tool call, which is why the retry
  // below exists. Override with AGENT_MODEL_GROQ.
  groq: process.env.AGENT_MODEL_GROQ || "groq:llama-3.3-70b-versatile",
  anthropic: process.env.AGENT_MODEL_ANTHROPIC || "anthropic:claude-sonnet-4-5",
  openai: process.env.AGENT_MODEL_OPENAI || "openai:gpt-4.1",
  gemini: process.env.AGENT_MODEL_GEMINI || "google:gemini-2.0-flash",
};

// gitclaw/pi-ai throws (and, via an async stream, can crash the whole process) if
// asked to use a provider with no API key. So we only ever hand it a provider we
// know is configured. Env var names mirror pi-ai's getEnvApiKey().
export function providerHasKey(p) {
  switch (p) {
    case "anthropic": return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN);
    case "openai": return !!process.env.OPENAI_API_KEY;
    case "gemini":
    case "google": return !!process.env.GEMINI_API_KEY;
    case "groq": return !!process.env.GROQ_API_KEY;
    default: return false;
  }
}

export const NO_KEY_MESSAGE =
  "No AI provider API key configured. Set GROQ_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) in .env and restart the server.";

// All configured Groq keys: GROQ_API_KEY, GROQ_API_KEY_2..10, and any comma-
// separated GROQ_API_KEYS. Groq's free tier caps tokens-per-minute PER ORG, so
// keys from separate orgs each get their own bucket — round-robining across them
// multiplies usable throughput (it does NOT raise the single-request size limit).
// pi-ai reads process.env.GROQ_API_KEY at request time, so we rotate that var.
const ALL_GROQ_KEYS = (() => {
  const keys = [];
  const add = (v) => { const t = (v || "").trim(); if (t && !keys.includes(t)) keys.push(t); };
  (process.env.GROQ_API_KEYS || "").split(",").forEach(add);
  add(process.env.GROQ_API_KEY);
  for (let i = 2; i <= 10; i++) add(process.env[`GROQ_API_KEY_${i}`]);
  return keys;
})();

// One key is RESERVED for the knowledge builder and taken out of the chat pool.
// See knowledge-worker.js for why it also runs in a separate process.
export const KNOWLEDGE_KEY =
  (process.env.GROQ_KNOWLEDGE_API_KEY || "").trim() ||
  (ALL_GROQ_KEYS.length >= 2 ? ALL_GROQ_KEYS[ALL_GROQ_KEYS.length - 1] : "");

export const GROQ_KEYS = (() => {
  if (!KNOWLEDGE_KEY) return ALL_GROQ_KEYS;
  const rest = ALL_GROQ_KEYS.filter((k) => k !== KNOWLEDGE_KEY);
  if (!rest.length) {
    console.warn("[agent] GROQ_KNOWLEDGE_API_KEY is the only key — chat and knowledge will share it");
    return ALL_GROQ_KEYS;
  }
  return rest;
})();

if (KNOWLEDGE_KEY) {
  console.error(`[agent] reserved 1 Groq key for the knowledge builder · ${GROQ_KEYS.length} left for chat`);
}
// Ensure pi-ai's providerHasKey/getEnvApiKey see a CHAT key: this process's default
// env is what every turn starts from, and the reserved key lives only in the
// knowledge worker's own environment.
if (!GROQ_KEYS.includes(process.env.GROQ_API_KEY) && GROQ_KEYS.length) {
  process.env.GROQ_API_KEY = GROQ_KEYS[0];
}
if (GROQ_KEYS.length > 1) console.error(`[agent] Groq key pool: ${GROQ_KEYS.length} keys (round-robin per turn)`);

// llama-3.3 on Groq intermittently produces a malformed tool call that Groq
// rejects. It's non-deterministic, so re-running the turn on a fresh key usually
// succeeds. We retry ONLY when the turn failed before any output reached the
// caller, so a partial reply is never duplicated.
export const AGENT_TOOLCALL_RETRIES = Number(process.env.AGENT_TOOLCALL_RETRIES) || 2;
export const RETRIABLE_TURN_ERROR = /tool call validation|not in request\.tools|malformed|failed to call a function|failed_generation|adjust your prompt|could not parse|invalid (?:tool|function)|Connection error|rate limit|\b429\b|temporarily|ECONNRESET|fetch failed/i;

let groqCursor = 0;
// Point process.env.GROQ_API_KEY at the next key in the pool before a Groq turn,
// so consecutive requests land on different orgs' TPM buckets.
export function rotateGroqKey(model) {
  if (!model || !model.startsWith("groq:") || GROQ_KEYS.length < 2) return;
  process.env.GROQ_API_KEY = GROQ_KEYS[groqCursor % GROQ_KEYS.length];
  groqCursor++;
}

// Cap the model's *output* reservation. Groq's free-tier 12k tokens-per-minute
// limit counts input PLUS reserved output, so pi-ai's default 32000 reservation
// makes even a small prompt bill as ~34k tokens/min and 413. The per-request
// `constraints: { maxTokens }` route is ignored by this pi-agent-core build; the
// mechanism that sticks is the model registry, so we lower it once at startup.
export const AGENT_MAX_OUTPUT_TOKENS = Number(process.env.AGENT_MAX_OUTPUT_TOKENS) || 3000;
try {
  let capped = 0;
  for (const m of getModels("groq")) {
    if (m && typeof m.maxTokens === "number" && m.maxTokens > AGENT_MAX_OUTPUT_TOKENS) {
      m.maxTokens = AGENT_MAX_OUTPUT_TOKENS;
      capped++;
    }
  }
  console.error(`[agent] capped Groq output reservation to ${AGENT_MAX_OUTPUT_TOKENS} tokens on ${capped} model(s) (keeps a turn under Groq's 12k TPM)`);
} catch (e) {
  console.error("[agent] could not cap Groq output reservation:", e.message);
}

// First configured provider, preferring Groq (the free-tier default).
export function firstAvailableProvider() {
  return ["groq", "anthropic", "openai", "gemini"].find(providerHasKey) || null;
}

// Resolve the model string for a request. Never returns a keyless provider's
// model, so the agent loop can't crash on a missing key.
export function modelFor(uiProvider) {
  const explicit = (process.env.GITCLAW_MODEL || "").trim();
  if (explicit && providerHasKey(explicit.split(":")[0])) return explicit;

  if (uiProvider && providerHasKey(uiProvider) && PROVIDER_MODELS[uiProvider]) {
    return PROVIDER_MODELS[uiProvider];
  }

  const avail = firstAvailableProvider();
  return avail ? PROVIDER_MODELS[avail] : PROVIDER_MODELS.groq;
}

// gitclaw treats the `dir` it is given as the agent home and HARD-READS
// <dir>/agent.yaml — a turn against a repository that was never scaffolded fails
// with ENOENT before it reaches the model. Inside the IDE that never showed,
// because gitagentgenerator.go writes agent.yaml at clone time.
//
// For a TOOLLESS turn the agent home is not the workspace: no tool reads a file
// from it, and everything the model sees is already in the prompt. So we hand it a
// minimal throwaway home rather than writing agent.yaml into someone's repository
// during a review.
//
// This is also the correct semantics for a compliance verdict. If the home were the
// repo, gitclaw would splice that repo's knowledge docs and memory into the prompt,
// and the same diff could be judged differently depending on what happened to be in
// knowledge/. A verdict must depend on the rules and the diff, and nothing else.
let _toollessHome = null;
export function toollessAgentHome() {
  if (_toollessHome) return _toollessHome;
  _toollessHome = mkdtempSync(join(tmpdir(), "jr-agent-home-"));
  writeFileSync(join(_toollessHome, "agent.yaml"), [
    'spec_version: "0.1.0"',
    "name: jr-architect-toolless",
    "version: 1.0.0",
    "description: Ephemeral agent home for a toolless turn. Holds no rules and no memory.",
    "tools: []",
    "runtime:",
    "  max_turns: 1",
    "",
  ].join("\n"));
  return _toollessHome;
}

// Buffered (non-streaming) turn: collect the full reply text, with a retry on a
// fresh key for the transient failures above. Used by every non-streaming path.
export async function collectTurn(queryOptions, model) {
  for (let attempt = 0; ; attempt++) {
    rotateGroqKey(model);
    let text = "";
    let error = null;
    try {
      for await (const msg of query(queryOptions)) {
        if (msg.type === "delta" && msg.deltaType !== "thinking") text += msg.content;
        else if (msg.type === "system" && msg.subtype === "error") error = msg.content || error;
        else if (msg.type === "assistant" && msg.stopReason === "error") error = msg.errorMessage || error;
      }
    } catch (err) {
      error = err.message || String(err);
    }
    if (!text && error && attempt < AGENT_TOOLCALL_RETRIES && RETRIABLE_TURN_ERROR.test(error)) continue;
    return { text, error };
  }
}

// If the model wrapped a body in a ```lang … ``` fence, strip it.
export function stripFences(body) {
  const t = body.replace(/^\s+|\s+$/g, "");
  const m = t.match(/^```[^\n]*\r?\n([\s\S]*?)\r?\n?```$/);
  return m ? m[1] : body;
}

// Pull the first {...} object out of a reply. Weak models wrap JSON in prose or
// fences no matter how firmly you ask them not to.
export function parseJsonLoose(text) {
  if (!text) return null;
  const body = stripFences(text);
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(body.slice(start, end + 1));
  } catch {
    return null;
  }
}
