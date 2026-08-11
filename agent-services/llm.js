// Providers, keys, and a single buffered turn. Knows nothing about editing,
// guardrails or the IDE, so a turn can run with no HTTP anywhere.

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { query } from "gitclaw";
import { getModels } from "@mariozechner/pi-ai";

// UI provider selector -> gitclaw model id, each overridable by env.
export const PROVIDER_MODELS = {
  groq: process.env.AGENT_MODEL_GROQ || "groq:llama-3.3-70b-versatile",
  anthropic: process.env.AGENT_MODEL_ANTHROPIC || "anthropic:claude-sonnet-4-5",
  openai: process.env.AGENT_MODEL_OPENAI || "openai:gpt-4.1",
  gemini: process.env.AGENT_MODEL_GEMINI || "google:gemini-2.0-flash",
};

// pi-ai crashes the process if handed a provider with no key, so never offer one.
// Names mirror pi-ai's getEnvApiKey().
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

// Groq's TPM cap is per ORG, so keys from separate orgs each get their own bucket.
// pi-ai reads process.env.GROQ_API_KEY at request time, hence the rotation below.
const ALL_GROQ_KEYS = (() => {
  const keys = [];
  const add = (v) => { const t = (v || "").trim(); if (t && !keys.includes(t)) keys.push(t); };
  (process.env.GROQ_API_KEYS || "").split(",").forEach(add);
  add(process.env.GROQ_API_KEY);
  for (let i = 2; i <= 10; i++) add(process.env[`GROQ_API_KEY_${i}`]);
  return keys;
})();

// One key is reserved for the knowledge builder — see knowledge-worker.js.
export const KNOWLEDGE_KEY =
  (process.env.GROQ_KNOWLEDGE_API_KEY || "").trim() ||
  (ALL_GROQ_KEYS.length >= 2 ? ALL_GROQ_KEYS[ALL_GROQ_KEYS.length - 1] : "");

export const GROQ_KEYS = (() => {
  if (!KNOWLEDGE_KEY) return ALL_GROQ_KEYS;
  const rest = ALL_GROQ_KEYS.filter((k) => k !== KNOWLEDGE_KEY);
  // Reserving the only key would leave the chat with none; share it and say so.
  if (!rest.length) {
    console.warn("[agent] GROQ_KNOWLEDGE_API_KEY is the only key — chat and knowledge will share it");
    return ALL_GROQ_KEYS;
  }
  return rest;
})();

if (KNOWLEDGE_KEY) {
  console.error(`[agent] reserved 1 Groq key for the knowledge builder · ${GROQ_KEYS.length} left for chat`);
}
// The default env must hold a CHAT key; the reserved one lives only in the worker.
if (!GROQ_KEYS.includes(process.env.GROQ_API_KEY) && GROQ_KEYS.length) {
  process.env.GROQ_API_KEY = GROQ_KEYS[0];
}
if (GROQ_KEYS.length > 1) console.error(`[agent] Groq key pool: ${GROQ_KEYS.length} keys (round-robin per turn)`);

// llama-3.3 intermittently emits a tool call Groq rejects; retrying on a fresh key
// usually works. Only retried before any output escaped, so nothing is duplicated.
export const AGENT_TOOLCALL_RETRIES = Number(process.env.AGENT_TOOLCALL_RETRIES) || 2;
export const RETRIABLE_TURN_ERROR = /tool call validation|not in request\.tools|malformed|failed to call a function|failed_generation|adjust your prompt|could not parse|invalid (?:tool|function)|Connection error|rate limit|\b429\b|temporarily|ECONNRESET|fetch failed/i;

let groqCursor = 0;
// Land consecutive requests on different orgs' TPM buckets.
export function rotateGroqKey(model) {
  if (!model || !model.startsWith("groq:") || GROQ_KEYS.length < 2) return;
  process.env.GROQ_API_KEY = GROQ_KEYS[groqCursor % GROQ_KEYS.length];
  groqCursor++;
}

// Groq's 12k TPM counts input PLUS reserved output, so pi-ai's 32000 default bills
// a small prompt as ~34k and 413s. Per-request constraints are ignored by this
// build; lowering the model registry once at startup is what actually sticks.
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

// Never returns a keyless provider's model.
export function modelFor(uiProvider) {
  const explicit = (process.env.GITCLAW_MODEL || "").trim();
  if (explicit && providerHasKey(explicit.split(":")[0])) return explicit;

  if (uiProvider && providerHasKey(uiProvider) && PROVIDER_MODELS[uiProvider]) {
    return PROVIDER_MODELS[uiProvider];
  }

  const avail = firstAvailableProvider();
  return avail ? PROVIDER_MODELS[avail] : PROVIDER_MODELS.groq;
}

// gitclaw hard-reads <dir>/agent.yaml, so a turn against an unscaffolded repo dies
// with ENOENT. A toolless turn needs no workspace, so hand it a throwaway home
// instead of writing into someone's repo — and a verdict then depends only on the
// rules and the diff, not on whatever sits in that repo's knowledge/.
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

// Buffered turn: the full reply text, retried on a fresh key per the regex above.
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

// Weak models wrap JSON in prose or fences however firmly you ask them not to.
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
