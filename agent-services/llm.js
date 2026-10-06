// Providers, keys, and a single buffered turn.

import "./models.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { safeQuery as query } from "./agent-home.js";
import { getModels } from "@mariozechner/pi-ai";

// The strongest model each provider offers for agent and coding work, and a quick one for short helper turns; env overrides either.
export const MODEL_TIERS = {
  groq: { code: process.env.AGENT_MODEL_GROQ || "groq:openai/gpt-oss-120b", fast: process.env.AGENT_MODEL_GROQ_FAST || "groq:openai/gpt-oss-120b" },
  anthropic: { code: process.env.AGENT_MODEL_ANTHROPIC || "anthropic:claude-opus-5-5", fast: process.env.AGENT_MODEL_ANTHROPIC_FAST || "anthropic:claude-haiku-4-5" },
  openai: { code: process.env.AGENT_MODEL_OPENAI || "openai:gpt-5.2", fast: process.env.AGENT_MODEL_OPENAI_FAST || "openai:gpt-5-mini" },
  gemini: { code: process.env.AGENT_MODEL_GEMINI || "google:gemini-2.5-pro", fast: process.env.AGENT_MODEL_GEMINI_FAST || "google:gemini-2.5-flash" },
};
export const PROVIDER_MODELS = Object.fromEntries(Object.entries(MODEL_TIERS).map(([p, t]) => [p, t.code]));

const PROVIDER_ENV = { groq: "GROQ_API_KEY", anthropic: "ANTHROPIC_API_KEY", openai: "OPENAI_API_KEY", gemini: "GEMINI_API_KEY" };
// Keys the user saved in Settings beat the server's own; among them the strongest provider wins.
const USER_ORDER = ["anthropic", "openai", "gemini", "groq"];
// The server's .env keys are the fallback, Groq (the free tier) first.
const SYSTEM_ORDER = ["groq", "anthropic", "openai", "gemini"];
const userProviders = new Set();

const providerOfModel = (model) => { const p = String(model || "").split(":")[0]; return p === "google" ? "gemini" : p; };

// pi-ai crashes the process if handed a provider with no key, so never offer one.
export function providerHasKey(p) {
  switch (p) {
    case "auto": return !!firstAvailableProvider();
    case "anthropic": return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN);
    case "openai": return !!process.env.OPENAI_API_KEY;
    case "gemini":
    case "google": return !!process.env.GEMINI_API_KEY;
    case "groq": return !!process.env.GROQ_API_KEY;
    default: return false;
  }
}

export const NO_KEY_MESSAGE =
  "No AI provider API key configured. Paste one in Settings (/settings.html), or set GROQ_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) in .env and restart.";

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

// Every provider rotates through its own pool; the Groq one is GROQ_KEYS itself.
export const POOLS = { groq: GROQ_KEYS, anthropic: [], openai: [], gemini: [] };
for (const p of ["anthropic", "openai", "gemini"]) if (process.env[PROVIDER_ENV[p]]) POOLS[p].push(process.env[PROVIDER_ENV[p]].trim());
// The server's own keys, restored when the user removes all of theirs for a provider.
const SYSTEM_POOLS = Object.fromEntries(Object.entries(POOLS).map(([p, keys]) => [p, [...keys]]));

// A model can intermittently emit a tool call Groq rejects; retrying on a fresh key usually works.
export const AGENT_TOOLCALL_RETRIES = Number(process.env.AGENT_TOOLCALL_RETRIES) || 2;
export const RETRIABLE_TURN_ERROR = /tool call validation|tool choice is none|not in request\.tools|malformed|failed to call a function|failed_generation|adjust your prompt|could not parse|invalid (?:tool|function)|Connection error|rate limit|\b429\b|temporarily|ECONNRESET|fetch failed/i;

const REJECTED_KEY = /\b401\b|invalid api key|incorrect api key/i;

// A key the provider rejects leaves the pool for the rest of the process, so one stale .env line cannot fail every other turn.
export function dropRejectedKey(model, error) {
  const p = providerOfModel(model);
  const pool = POOLS[p];
  if (!pool || !REJECTED_KEY.test(String(error || ""))) return false;
  const i = pool.indexOf(process.env[PROVIDER_ENV[p]]);
  if (i < 0 || pool.length < 2) return false;
  pool.splice(i, 1);
  process.env[PROVIDER_ENV[p]] = pool[0];
  console.error(`[agent] dropped a ${p} key the provider rejected (401) · ${pool.length} left`);
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

function setPool(p, list) {
  const keys = [...new Set((Array.isArray(list) ? list : [list]).map((k) => String(k || "").trim()).filter(Boolean))].slice(0, 20);
  POOLS[p].splice(0, POOLS[p].length, ...keys);
  if (keys.length) process.env[PROVIDER_ENV[p]] = keys[0];
  else delete process.env[PROVIDER_ENV[p]];
}

// Go sends {keys: {provider: [the user's saved keys]}}; an empty list falls back to the server's own. A flat {GROQ_API_KEY: "..."} map also works.
export function applyKeys(body) {
  if (!body || typeof body !== "object") return;
  if (body.keys && typeof body.keys === "object") {
    for (const p of Object.keys(PROVIDER_ENV)) {
      const mine = Array.isArray(body.keys[p]) ? body.keys[p].filter(Boolean) : [];
      setPool(p, mine.length ? mine : SYSTEM_POOLS[p]);
      if (mine.length) userProviders.add(p); else userProviders.delete(p);
    }
    return;
  }
  for (const [p, name] of Object.entries(PROVIDER_ENV)) if (name in body) setPool(p, body[name]);
}

// Go starts this process with the keys Settings holds, already merged over the .env ones.
try { if (process.env.JR_PROVIDER_KEYS) applyKeys({ keys: JSON.parse(process.env.JR_PROVIDER_KEYS) }); } catch { console.error("[agent] JR_PROVIDER_KEYS is not valid JSON; using the .env keys"); }

const cursors = {};
// Consecutive requests land on different keys, which for Groq means different orgs' TPM buckets.
export function rotateKey(model) {
  const p = providerOfModel(model);
  const pool = POOLS[p];
  if (!pool || pool.length < 2) return;
  cursors[p] = (cursors[p] || 0) + 1;
  process.env[PROVIDER_ENV[p]] = pool[cursors[p] % pool.length];
}
export const rotateGroqKey = rotateKey;

// Groq's TPM cap needs a small output reservation; hosted reasoning models spend thinking from the same budget, so they get more room.
export function outputCap(model, wanted = AGENT_MAX_OUTPUT_TOKENS) {
  return providerOfModel(model) === "groq" ? wanted : Math.max(wanted, Number(process.env.AGENT_MAX_OUTPUT_TOKENS_HOSTED) || 16000);
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

// Providers in the order a request should try them.
export function providerOrder() {
  const user = USER_ORDER.filter((p) => userProviders.has(p) && providerHasKey(p));
  return [...user, ...SYSTEM_ORDER.filter((p) => !user.includes(p) && providerHasKey(p))];
}

export function firstAvailableProvider() {
  return providerOrder()[0] || null;
}

// Never returns a keyless provider's model; no provider (or "auto") means the best one available.
export function modelFor(uiProvider, tier = "code") {
  const explicit = (process.env.GITCLAW_MODEL || "").trim();
  if (explicit && providerHasKey(providerOfModel(explicit))) return explicit;
  const p = uiProvider && uiProvider !== "auto" && MODEL_TIERS[uiProvider] && providerHasKey(uiProvider) ? uiProvider : firstAvailableProvider() || "groq";
  return MODEL_TIERS[p][tier] || MODEL_TIERS[p].code;
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
  if (/\b401\b|invalid api key|incorrect api key|unauthori[sz]ed/i.test(msg)) return `The AI provider rejected this server's API key. Paste a valid one in Settings, or fix it in .env and restart. (${msg.slice(0, 80)})`;
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
