// The knowledge builder runs in its OWN process. That is not tidiness — it is the
// only way the dedicated key is actually dedicated.
//
// pi-ai reads process.env.GROQ_API_KEY at request time, which is why server.js
// rotates that single variable before each turn (rotateGroqKey). One variable and
// two concurrent callers means whoever writes last wins: a knowledge build kicked
// off at open would silently steal the chat turn's key, or vice versa. The
// alternative — a mutex around the swap — is correct but makes a 60-second build
// block the first thing the user types.
//
// A child process has its own environment. The reserved key lives here and nowhere
// else, gets its own untouched tokens-per-minute bucket, and no amount of chat
// traffic can interfere with it or it with them.
//
// Contract: read JSON config from argv[2], write one JSON result line to stdout,
// exit 0 either way. Progress lines go to stderr, which the parent logs.

import { getModels } from "@mariozechner/pi-ai";
import { buildKnowledge } from "./knowledge.js";

const cfg = (() => {
  try { return JSON.parse(process.argv[2] || "{}"); } catch { return {}; }
})();

// This process has a whole key to itself, so it can reserve a far larger output
// than a chat turn (server.js clamps those to 3000 to stay under a SHARED budget).
// Still capped: input runs ~6k tokens, so 2500 out keeps one call under 12k TPM.
const MAX_OUTPUT = Number(process.env.KNOWLEDGE_MAX_OUTPUT_TOKENS) || 2500;
try {
  for (const m of getModels("groq")) {
    if (m && typeof m.maxTokens === "number" && m.maxTokens > MAX_OUTPUT) m.maxTokens = MAX_OUTPUT;
  }
} catch { /* a provider we don't clamp is not a reason to fail the build */ }

const done = (payload) => {
  process.stdout.write(JSON.stringify(payload) + "\n");
  // Let stdout flush before the event loop is torn down.
  process.exitCode = 0;
};

try {
  const out = await buildKnowledge({
    dir: cfg.dir,
    model: cfg.model,
    agent: cfg.agent,
    maxTokens: MAX_OUTPUT,
    onStep: (m) => process.stderr.write(`[knowledge] ${m}\n`),
  });
  done(out);
} catch (e) {
  done({ ok: false, reason: "crashed", error: e && e.message ? e.message : String(e) });
}
