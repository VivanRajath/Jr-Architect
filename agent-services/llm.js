// Providers, keys, and a single buffered turn.

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeQuery as query } from "./agent-home.js";
import { getModels } from "@mariozechner/pi-ai";

// UI provider selector -> gitclaw model id, each overridable by env.
export const PROVIDER_MODELS = {
  groq: process.env.AGENT_MODEL_GROQ || "groq:openai/gpt-oss-120b",
  anthropic: process.env.AGENT_MODEL_ANTHROPIC || "anthropic:claude-sonnet-4-5",
  openai: process.env.AGENT_MODEL_OPENAI || "openai:gpt-4.1",
  gemini: process.env.AGENT_MODEL_GEMINI || "google:gemini-2.0-flash",
};

// pi-ai crashes the process if handed a provider with no key, so never offer one.
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
const ALL_GROQ_KEYS = (() => {
  const keys = [];
  const add = (v) => { const t = (v || "").trim(); if (t && !keys.includes(t)) keys.push(t); };
  (process.env.GROQ_API_KEYS || "").split(",").forEach(add);
  add(process.env.GROQ_API_KEY);
  for (let i = 2; i <= 10; i++) add(process.env[`GROQ_API_KEY_${i}`]);
  return keys;
})();

// One key is reserved for the knowledge builder — see knowledge-worker.js.
export let KNOWLEDGE_KEY =
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

// A model can intermittently emit a tool call Groq rejects; retrying on a fresh key usually works.
export const AGENT_TOOLCALL_RETRIES = Number(process.env.AGENT_TOOLCALL_RETRIES) || 2;
export const RETRIABLE_TURN_ERROR = /tool call validation|tool choice is none|not in request\.tools|malformed|failed to call a function|failed_generation|adjust your prompt|could not parse|invalid (?:tool|function)|Connection error|rate limit|\b429\b|temporarily|ECONNRESET|fetch failed/i;

const REJECTED_KEY = /\b401\b|invalid api key|incorrect api key/i;

// A key the provider rejects leaves the pool for the rest of the process, so one stale .env line cannot fail every other turn.
export function dropRejectedKey(model, error) {
  if (!model || !model.startsWith("groq:") || !REJECTED_KEY.test(String(error || ""))) return false;
  const i = GROQ_KEYS.indexOf(process.env.GROQ_API_KEY);
  if (i < 0 || GROQ_KEYS.length < 2) return false;
  GROQ_KEYS.splice(i, 1);
  process.env.GROQ_API_KEY = GROQ_KEYS[0];
  console.error(`[agent] dropped a Groq key the provider rejected (401) · ${GROQ_KEYS.length} left`);
  return true;
}

// Checks every configured key once at startup (each goes only to Groq) and keeps the ones that work.
export async function pruneGroqKeys(fetchImpl = fetch) {
  const all = [...new Set([...GROQ_KEYS, KNOWLEDGE_KEY].filter(Boolean))];
  if (all.length < 2) return { kept: all.length, dropped: 0 };
  const status = await Promise.all(all.map((k) => fetchImpl("https://api.groq.com/openai/v1/models", {
    headers: { Authorization: `Bearer ${k}` }, signal: AbortSignal.timeout(10000),
  }).then((r) => r.status).catch(() => 0)));
  // Only a definite 401 condemns a key; a network failure proves nothing.
  const dead = new Set(all.filter((_, i) => status[i] === 401));
  if (!dead.size || dead.size === all.length) {
    if (dead.size) console.error("[agent] every Groq key was rejected (401); check GROQ_API_KEY in .env");
    return { kept: all.length - dead.size, dropped: 0 };
  }
  for (let i = GROQ_KEYS.length - 1; i >= 0; i--) if (dead.has(GROQ_KEYS[i])) GROQ_KEYS.splice(i, 1);
  if (dead.has(KNOWLEDGE_KEY)) KNOWLEDGE_KEY = GROQ_KEYS.length >= 2 ? GROQ_KEYS.pop() : "";
  if (!GROQ_KEYS.length && KNOWLEDGE_KEY) GROQ_KEYS.push(KNOWLEDGE_KEY);
  if (!GROQ_KEYS.includes(process.env.GROQ_API_KEY)) process.env.GROQ_API_KEY = GROQ_KEYS[0];
  console.error(`[agent] dropped ${dead.size} Groq key(s) that the provider rejected (401); ${GROQ_KEYS.length} left for chat${KNOWLEDGE_KEY ? ", 1 for the knowledge builder" : ""}. Remove them from .env.`);
  return { kept: GROQ_KEYS.length + (KNOWLEDGE_KEY && !GROQ_KEYS.includes(KNOWLEDGE_KEY) ? 1 : 0), dropped: dead.size };
}

let groqCursor = 0;
// Land consecutive requests on different orgs' TPM buckets.
export function rotateGroqKey(model) {
  if (!model || !model.startsWith("groq:") || GROQ_KEYS.length < 2) return;
  process.env.GROQ_API_KEY = GROQ_KEYS[groqCursor % GROQ_KEYS.length];
  groqCursor++;
}

// Groq's 12k TPM counts input PLUS reserved output, so pi-ai's 32000 default bills a small prompt as ~34k and 413s.
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

// gitclaw hard-reads <dir>/agent.yaml, so a turn against an unscaffolded repo dies with ENOENT.
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
    if (!text && error && dropRejectedKey(model, error)) { attempt--; continue; }
    if (!text && error && attempt < AGENT_TOOLCALL_RETRIES && RETRIABLE_TURN_ERROR.test(error)) continue;
    return { text, error };
  }
}

// Provider errors in words a person can act on; the raw text stays at the end for debugging.
export function friendlyModelError(raw) {
  const msg = String(raw || "the model returned nothing");
  if (/\b401\b|invalid api key|incorrect api key|unauthori[sz]ed/i.test(msg)) return `The AI provider rejected this server's API key. Put a valid key in .env (for example GROQ_API_KEY) and restart. (${msg.slice(0, 80)})`;
  if (/\b429\b|rate limit|too many requests|tokens per minute/i.test(msg)) return "The AI provider is rate-limiting this server. Wait a minute and try again.";
  if (/\b413\b|too large|context length|maximum context/i.test(msg)) return "The request was too large for the model. Shorten the instructions, knowledge or input and try again.";
  if (/\b404\b|model .*not (found|exist)|does not exist/i.test(msg)) return `That model is not available with this server's key. Pick another model in the Model section. (${msg.slice(0, 80)})`;
  if (/connection error|fetch failed|ECONNRESET|ETIMEDOUT|ENOTFOUND/i.test(msg)) return "Could not reach the AI provider. Check the internet connection and try again.";
  return msg.slice(0, 200);
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
