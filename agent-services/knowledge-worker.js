// A separate process is the only way the reserved key stays reserved: pi-ai reads
// process.env.GROQ_API_KEY at request time, so one variable and two concurrent
// callers means whoever writes last wins. A mutex would be correct but would make a
// 60-second build block the first thing the user types.
//
// Config as JSON in argv[2]; one JSON result line on stdout; progress on stderr.

import { getModels } from "@mariozechner/pi-ai";
import { buildKnowledge } from "./knowledge.js";

const cfg = (() => {
  try { return JSON.parse(process.argv[2] || "{}"); } catch { return {}; }
})();

// Its own key, so a bigger reservation than a chat turn — still under 12k TPM.
const MAX_OUTPUT = Number(process.env.KNOWLEDGE_MAX_OUTPUT_TOKENS) || 2500;
try {
  for (const m of getModels("groq")) {
    if (m && typeof m.maxTokens === "number" && m.maxTokens > MAX_OUTPUT) m.maxTokens = MAX_OUTPUT;
  }
} catch { /* a provider we don't clamp is not a reason to fail the build */ }

const done = (payload) => {
  process.stdout.write(JSON.stringify(payload) + "\n");
  // Let stdout flush before the loop tears down.
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
