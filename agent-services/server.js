import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { query } from "gitclaw";
import { getModels } from "@mariozechner/pi-ai";
import { readFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname } from "path";

// Keep the agent service alive if a single request's agent loop throws
// asynchronously — e.g. a provider/key error surfaced from a background stream
// rather than through the awaited iterator. Without these, one bad turn becomes
// an unhandled rejection that tears down the whole process and kills the chat
// panel for the rest of the session. Log and keep serving.
process.on("unhandledRejection", (err) => {
  console.error("[agent] unhandledRejection:", (err && err.message) || err);
});
process.on("uncaughtException", (err) => {
  console.error("[agent] uncaughtException:", (err && err.message) || err);
});

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Active sessions: container -> { dir, stack, wss clients }
const sessions = new Map();

// Map the UI's provider selector to a gitclaw model id. Each is overridable via
// env so operators can point a provider at whatever model their gitclaw build
// supports without a code change.
const PROVIDER_MODELS = {
  // llama-3.3-70b-versatile is the tool-capable model available on Groq's free
  // tier. It occasionally emits a malformed tool call ("cli {json}" as the
  // function NAME) that Groq rejects with "tool call ... not in request.tools" —
  // this is intermittent (the model samples differently each run), so the WS
  // handler retries the turn on a fresh key when it fails before producing output.
  // Override with AGENT_MODEL_GROQ (e.g. groq:meta-llama/llama-4-scout-17b-16e-instruct
  // if your account has it — Llama 4 is steadier at tool calls).
  groq: process.env.AGENT_MODEL_GROQ || "groq:llama-3.3-70b-versatile",
  anthropic: process.env.AGENT_MODEL_ANTHROPIC || "anthropic:claude-sonnet-4-5",
  openai: process.env.AGENT_MODEL_OPENAI || "openai:gpt-4.1",
  gemini: process.env.AGENT_MODEL_GEMINI || "google:gemini-2.0-flash",
};

// gitclaw/pi-ai throws (and, via an async stream, can crash the whole process)
// if asked to use a provider with no API key. So we only ever hand it a provider
// we know is configured. Env var names mirror pi-ai's getEnvApiKey().
function providerHasKey(p) {
  switch (p) {
    case "anthropic": return !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_OAUTH_TOKEN);
    case "openai": return !!process.env.OPENAI_API_KEY;
    case "gemini":
    case "google": return !!process.env.GEMINI_API_KEY;
    case "groq": return !!process.env.GROQ_API_KEY;
    default: return false;
  }
}

const NO_KEY_MESSAGE =
  "No AI provider API key configured. Set GROQ_API_KEY (or ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) in .env and restart the server.";

// All configured Groq keys: GROQ_API_KEY, GROQ_API_KEY_2..10, and any comma-
// separated GROQ_API_KEYS. Groq's free tier caps tokens-per-minute PER ORG, so
// keys from separate orgs each get their own bucket — round-robining across them
// multiplies usable throughput (it does NOT raise the single-request size limit).
// pi-ai reads process.env.GROQ_API_KEY at request time, so we rotate that var.
const GROQ_KEYS = (() => {
  const keys = [];
  const add = (v) => { const t = (v || "").trim(); if (t && !keys.includes(t)) keys.push(t); };
  (process.env.GROQ_API_KEYS || "").split(",").forEach(add);
  add(process.env.GROQ_API_KEY);
  for (let i = 2; i <= 10; i++) add(process.env[`GROQ_API_KEY_${i}`]);
  return keys;
})();
// Ensure pi-ai's providerHasKey/getEnvApiKey see a key even if only the numbered
// or comma-separated forms were set.
if (!process.env.GROQ_API_KEY && GROQ_KEYS.length) process.env.GROQ_API_KEY = GROQ_KEYS[0];
if (GROQ_KEYS.length > 1) console.log(`[agent] Groq key pool: ${GROQ_KEYS.length} keys (round-robin per turn)`);

// llama-3.3 on Groq intermittently produces a malformed tool call that Groq
// rejects. It's non-deterministic (the model samples differently each run), so
// re-running the turn on a fresh key usually succeeds. We retry ONLY when the
// turn failed before any output reached the client, so a partial reply is never
// duplicated. Total attempts = AGENT_TOOLCALL_RETRIES + 1.
const AGENT_TOOLCALL_RETRIES = Number(process.env.AGENT_TOOLCALL_RETRIES) || 2;
const RETRIABLE_TURN_ERROR = /tool call validation|not in request\.tools|malformed|failed to call a function|failed_generation|adjust your prompt|could not parse|invalid (?:tool|function)|Connection error|rate limit|\b429\b|temporarily|ECONNRESET|fetch failed/i;

let groqCursor = 0;
// Point process.env.GROQ_API_KEY at the next key in the pool before a Groq turn,
// so consecutive agent requests land on different orgs' TPM buckets.
function rotateGroqKey(model) {
  if (!model || !model.startsWith("groq:") || GROQ_KEYS.length < 2) return;
  process.env.GROQ_API_KEY = GROQ_KEYS[groqCursor % GROQ_KEYS.length];
  groqCursor++;
}

// Restrict the agent to the core coding tools. gitclaw otherwise injects extra
// built-ins (capture_photo, task_tracker, skill_learner) plus a system prompt
// that pushes the model through skill/task rituals — noise that bloats the
// request and derails smaller models (e.g. Groq's llama-3.3-70b) so they never
// get around to answering. Override with AGENT_ALLOWED_TOOLS if needed.
const AGENT_ALLOWED_TOOLS = (process.env.AGENT_ALLOWED_TOOLS || "cli,read,write,memory,search_code")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Tools whose completion means files on disk may have changed — used to tell the
// UI to reload the tree/preview. Reads and memory ops don't touch the workspace.
const WRITE_TOOLS = new Set(["write", "edit", "create", "cli"]);

// ── Layer 2 of code retrieval: the search_code tool ──────────────────────────
// A ripgrep-style code search implemented in pure JS (no external binary, works
// on Windows/macOS/Linux). The agent calls it to find where a symbol/string is
// defined or used and pulls back only the matching lines — the token-frugal
// alternative to reading whole files, which matters on Groq's 12k TPM tier.
const SEARCH_SKIP_DIRS = new Set([
  ".git", "node_modules", "__pycache__", ".next", "vendor", ".venv", "venv",
  "dist", "build", ".gitagent", "coverage", ".turbo", ".cache", "out", "target",
  ".idea", ".vscode",
]);
const SEARCH_TEXT_EXT = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".go", ".py", ".rb", ".php",
  ".java", ".rs", ".vue", ".svelte", ".css", ".scss", ".sass", ".html", ".json",
  ".md", ".mdx", ".yaml", ".yml", ".txt", ".sh", ".sql", ".toml", ".prisma",
]);
const SEARCH_MAX_FILE_BYTES = 512 * 1024;
const SEARCH_MAX_RESULTS_DEFAULT = 20;
const SEARCH_MAX_RESULTS_CAP = 50;

// Build a search_code tool bound to a specific workspace dir. Returned in the
// gitclaw SDK-tool shape ({name, description, inputSchema, handler}).
function makeSearchCodeTool(dir) {
  return {
    name: "search_code",
    description:
      "Search the repository's source for a text string or regular expression. " +
      "Returns ranked file:line matches, each with a one-line snippet. Prefer this " +
      "over reading whole files when locating where a symbol, function, or string " +
      "is defined or used. Case-insensitive.",
    inputSchema: {
      properties: {
        query: {
          type: "string",
          description: "Text or JS regular expression to find (e.g. a function name, symbol, or literal).",
          required: true,
        },
        max_results: {
          type: "number",
          description: `Max matches to return (default ${SEARCH_MAX_RESULTS_DEFAULT}, hard cap ${SEARCH_MAX_RESULTS_CAP}).`,
        },
      },
    },
    handler: async (params) => {
      const q = ((params && params.query) || "").trim();
      if (!q) return "search_code: empty query.";
      const limit = Math.min(
        Math.max(1, Number(params && params.max_results) || SEARCH_MAX_RESULTS_DEFAULT),
        SEARCH_MAX_RESULTS_CAP,
      );
      // Treat query as a regex; on invalid pattern fall back to a literal match.
      let re;
      try {
        re = new RegExp(q, "i");
      } catch {
        re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      }
      const hits = [];
      const walk = (abs, rel) => {
        if (hits.length >= limit) return;
        let entries;
        try {
          entries = readdirSync(abs, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          if (hits.length >= limit) return;
          const childAbs = join(abs, e.name);
          const childRel = rel ? rel + "/" + e.name : e.name;
          if (e.isDirectory()) {
            if (SEARCH_SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
            walk(childAbs, childRel);
          } else {
            if (!SEARCH_TEXT_EXT.has(extname(e.name).toLowerCase())) continue;
            let st;
            try {
              st = statSync(childAbs);
            } catch {
              continue;
            }
            if (st.size > SEARCH_MAX_FILE_BYTES) continue;
            let content;
            try {
              content = readFileSync(childAbs, "utf8");
            } catch {
              continue;
            }
            const lines = content.split(/\r?\n/);
            for (let i = 0; i < lines.length; i++) {
              if (re.test(lines[i])) {
                hits.push(`${childRel}:${i + 1}: ${lines[i].trim().slice(0, 200)}`);
                if (hits.length >= limit) return;
              }
            }
          }
        }
      };
      walk(dir, "");
      if (hits.length === 0) return `No matches for /${q}/i in the repository.`;
      return `Found ${hits.length} match(es) for /${q}/i:\n` + hits.join("\n");
    },
  };
}

// ── Ask mode: retrieve-then-generate (toolless) ──────────────────────────────
// llama-3.3 is weak at function-calling, so *questions* about the repo don't go
// through the agentic tool loop (where it garbles calls). Instead the backend
// does the retrieval — repo map (already always-loaded via knowledge) + a
// server-side search_code on the question's key terms — and hands the model a
// plain, toolless prompt. The model only has to WRITE an answer, which it does
// well. Edits still use the agentic path (writing files needs the write tool).

// Clear file-modification intent → agentic/edit path. Everything else defaults
// to the safe, reliable read-only Ask mode. Deliberately excludes ambiguous
// verbs like "make"/"generate"/"build" (as in "make a summary").
const EDIT_INTENT = /\b(add|create|write|edit|change|modif(?:y|ies|ied)|fix|update|refactor|implement|rename|delete|remove|replace|insert|append|scaffold|install|integrate|rewrite|convert|migrate|set up|setup|wire up)\b/i;

const ASK_STOPWORDS = new Set([
  "the", "a", "an", "of", "to", "in", "on", "is", "are", "and", "or", "how", "what",
  "where", "why", "who", "does", "do", "did", "this", "that", "these", "those",
  "code", "file", "files", "repo", "repository", "project", "app", "application",
  "summarize", "summary", "explain", "explanation", "tell", "me", "about", "show",
  "which", "for", "with", "it", "its", "use", "used", "using", "can", "you", "give",
  "please", "there", "here", "was", "were", "has", "have", "into", "from", "then",
  "work", "works", "working", "understand", "overview", "describe", "list", "all",
  // code-generic words that would return noisy matches if searched literally
  "function", "functions", "method", "methods", "class", "classes", "variable",
  "component", "components", "const", "let", "var", "import", "export", "return",
  "defined", "definition", "handler", "handlers", "called", "call", "calls",
  "value", "values", "data", "type", "types", "page", "pages", "when", "does",
]);

// Pull a few salient search terms from a question, preferring identifier-like
// tokens (camelCase / has an uppercase letter) and longer words.
function extractSearchTerms(message) {
  const words = message.match(/[A-Za-z_][A-Za-z0-9_]{2,}/g) || [];
  const seen = new Set();
  const uniq = [];
  for (const w of words) {
    const lw = w.toLowerCase();
    if (ASK_STOPWORDS.has(lw) || seen.has(w)) continue;
    seen.add(w);
    uniq.push(w);
  }
  const score = (w) => w.length + (/[A-Z]/.test(w.slice(1)) ? 6 : 0) + (/_/.test(w) ? 3 : 0);
  uniq.sort((a, b) => score(b) - score(a));
  return uniq.slice(0, 4);
}

// Build the toolless Ask-mode prompt: inject search_code hits for the question's
// terms as grounding context. The repo map is already in the model's context via
// gitclaw's always-loaded knowledge doc, so we only add the question-specific bits.
async function buildAskPrompt(dir, message) {
  const terms = extractSearchTerms(message);
  const tool = makeSearchCodeTool(dir);
  const snippets = [];
  const seenLines = new Set();
  for (const term of terms) {
    if (snippets.length >= 18) break;
    let res;
    try {
      res = await tool.handler({ query: term, max_results: 6 });
    } catch {
      continue;
    }
    if (!res || res.startsWith("No matches")) continue;
    for (const line of res.split("\n").slice(1)) {
      if (!line.trim() || seenLines.has(line)) continue;
      seenLines.add(line);
      snippets.push(line);
      if (snippets.length >= 18) break;
    }
  }
  const context = snippets.length
    ? `Relevant code found by searching the repository${terms.length ? ` for: ${terms.join(", ")}` : ""}:\n\n<search_results>\n${snippets.join("\n")}\n</search_results>\n\n`
    : "";
  return (
    `${context}You are answering a question about THIS repository. Use the repository map already in your context and the search results above. ` +
    `Be concrete: cite \`file:line\` for specifics. If a file you need isn't shown, name it and say what you'd look for. Do not invent files or code.\n\n` +
    `Question: ${message}`
  );
}

// Decide Ask vs agentic. An explicit client mode ("ask"/"agent") wins; otherwise
// auto-detect from the message. AGENT_ASK_MODE=off disables Ask mode entirely.
function resolveTurnMode(explicit, message) {
  if (process.env.AGENT_ASK_MODE === "off") return "agent";
  if (explicit === "ask" || explicit === "agent") return explicit;
  return EDIT_INTENT.test(message) ? "agent" : "ask";
}

// Shared stream+retry loop for one turn. Streams delta/tool/file_changed frames,
// retries a transient pre-output failure on a fresh key, and always ends with a
// single `complete`. Works for both agentic (tools) and Ask (toolless) turns.
async function streamTurn(ws, queryOptions, model) {
  let streamedAny = false;
  let attempt = 0;
  while (true) {
    rotateGroqKey(model);
    let turnError = null;
    try {
      for await (const msg of query(queryOptions)) {
        if (msg.type === "delta") {
          if (msg.deltaType === "thinking") continue;
          streamedAny = true;
          ws.send(JSON.stringify({ type: "delta", content: msg.content }));
        } else if (msg.type === "tool_use") {
          streamedAny = true;
          ws.send(JSON.stringify({ type: "tool", content: `${msg.toolName}(${JSON.stringify(msg.args)})` }));
        } else if (msg.type === "tool_result") {
          if (WRITE_TOOLS.has(msg.toolName)) ws.send(JSON.stringify({ type: "file_changed", content: "" }));
        } else if (msg.type === "assistant") {
          if (msg.stopReason === "error") turnError = msg.errorMessage || "The model returned an error.";
          else ws.send(JSON.stringify({ type: "message_end", content: "" }));
        } else if (msg.type === "system") {
          if (msg.subtype === "error") {
            console.error(`[agent] LLM error (${msg.metadata?.provider || "?"}/${msg.metadata?.model || "?"}): ${msg.content}`);
            turnError = msg.content || "The AI request failed.";
          } else {
            console.log(`[agent] ${msg.subtype || "system"}`);
          }
        }
      }
    } catch (err) {
      console.error("[agent] stream error:", err);
      turnError = err.message || String(err);
    }

    if (turnError && !streamedAny && attempt < AGENT_TOOLCALL_RETRIES && RETRIABLE_TURN_ERROR.test(turnError)) {
      attempt++;
      console.log(`[agent] retrying turn (attempt ${attempt + 1}/${AGENT_TOOLCALL_RETRIES + 1}) after: ${String(turnError).slice(0, 100)}`);
      continue;
    }
    if (turnError) ws.send(JSON.stringify({ type: "error", content: turnError }));
    break;
  }
  ws.send(JSON.stringify({ type: "complete", content: "" }));
}

// Cap the model's *output* reservation. Groq's free-tier 12k tokens-per-minute
// (TPM) limit counts input PLUS reserved output (max_completion_tokens). pi-ai
// otherwise reserves Math.min(model.maxTokens, 32000) = 32000 for Groq, so even a
// ~1.8k-token prompt is billed as ~33.9k tokens/min and gets a 413 — that, not
// prompt size, was the real cause of the "Requested 33889" error.
//
// The clean per-request `constraints: { maxTokens }` route below is IGNORED by
// this pi-agent-core build (its _runLoop rebuilds the model config from a fixed
// field whitelist that omits maxTokens). The mechanism that actually sticks is
// the model registry: getModels returns shared objects, and pi-ai's output
// reservation reads model.maxTokens — so we lower it once at startup. Raise
// AGENT_MAX_OUTPUT_TOKENS if you move to a higher Groq tier.
const AGENT_MAX_OUTPUT_TOKENS = Number(process.env.AGENT_MAX_OUTPUT_TOKENS) || 3000;
try {
  let capped = 0;
  for (const m of getModels("groq")) {
    if (m && typeof m.maxTokens === "number" && m.maxTokens > AGENT_MAX_OUTPUT_TOKENS) {
      m.maxTokens = AGENT_MAX_OUTPUT_TOKENS;
      capped++;
    }
  }
  console.log(`[agent] capped Groq output reservation to ${AGENT_MAX_OUTPUT_TOKENS} tokens on ${capped} model(s) (keeps a turn under Groq's 12k TPM)`);
} catch (e) {
  console.error("[agent] could not cap Groq output reservation:", e.message);
}

// First configured provider, preferring Groq (the free-tier default).
export function firstAvailableProvider() {
  return ["groq", "anthropic", "openai", "gemini"].find(providerHasKey) || null;
}

// Resolve the model string for a request. Priority:
//   1. GITCLAW_MODEL, but only if its provider actually has a key
//   2. the provider chosen in the UI, if it has a key
//   3. the first provider that has a key (Groq preferred)
// Never returns a keyless provider's model, so the agent loop can't crash on a
// missing key — a request with no configured provider is rejected up front.
export function modelFor(uiProvider) {
  const explicit = (process.env.GITCLAW_MODEL || "").trim();
  if (explicit && providerHasKey(explicit.split(":")[0])) return explicit;

  if (uiProvider && providerHasKey(uiProvider) && PROVIDER_MODELS[uiProvider]) {
    return PROVIDER_MODELS[uiProvider];
  }

  const avail = firstAvailableProvider();
  return avail ? PROVIDER_MODELS[avail] : PROVIDER_MODELS.groq;
}

// Register a sandbox dir after Jr Architect clones + generates agent spec
app.post("/agent/register", (req, res) => {
  const { container, workdir, stack } = req.body;
  if (!container || !workdir) {
    return res.status(400).json({ error: "container and workdir required" });
  }
  sessions.set(container, { dir: workdir, stack: stack || "unknown", clients: new Set() });
  console.log(`[agent] registered container=${container} dir=${workdir} stack=${stack}`);
  res.json({ status: "registered" });
});

// REST fallback for single-shot prompts
app.post("/agent/chat", async (req, res) => {
  const { container, message, provider } = req.body;
  if (!container || !message) {
    return res.status(400).json({ error: "container and message required" });
  }

  const session = sessions.get(container);
  if (!session) {
    return res.status(404).json({ error: "sandbox not registered" });
  }

  const agentYaml = join(session.dir, "agent.yaml");
  if (!existsSync(agentYaml)) {
    return res.status(400).json({ error: "agent.yaml not found — run gitagent_generator first" });
  }

  if (!firstAvailableProvider()) {
    return res.status(400).json({ error: NO_KEY_MESSAGE });
  }

  const model = modelFor(provider);
  const mode = resolveTurnMode(req.body.mode, message);
  // Ask mode does retrieval up front and runs toolless; agentic drives tools.
  const queryOptions = mode === "ask"
    ? {
        prompt: await buildAskPrompt(session.dir, message),
        dir: session.dir,
        model,
        replaceBuiltinTools: true,
        allowedTools: [],
        constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
      }
    : {
        prompt: message,
        dir: session.dir,
        model,
        allowedTools: AGENT_ALLOWED_TOOLS,
        tools: [makeSearchCodeTool(session.dir)],
        constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
      };
  let fullResponse = "";
  let errText = "";
  // Same transient-failure retry as the WS path (buffered, so no partial-reply
  // concern): re-run on a fresh key until we get output or exhaust attempts.
  for (let attempt = 0; ; attempt++) {
    rotateGroqKey(model);
    fullResponse = "";
    errText = "";
    try {
      for await (const msg of query(queryOptions)) {
        if (msg.type === "delta" && msg.deltaType !== "thinking") fullResponse += msg.content;
        else if (msg.type === "system" && msg.subtype === "error") errText = msg.content || errText;
        else if (msg.type === "assistant" && msg.stopReason === "error") errText = msg.errorMessage || errText;
      }
    } catch (err) {
      errText = err.message || String(err);
    }
    if (!fullResponse && errText && attempt < AGENT_TOOLCALL_RETRIES && RETRIABLE_TURN_ERROR.test(errText)) {
      console.log(`[agent] REST retry (attempt ${attempt + 2}/${AGENT_TOOLCALL_RETRIES + 1}) after: ${String(errText).slice(0, 100)}`);
      continue;
    }
    if (!fullResponse && errText) {
      return res.status(502).json({ error: errText });
    }
    return res.json({ response: fullResponse });
  }
});

// WebSocket — one connection per sandbox session
// Client sends: { type: "chat", container: "...", message: "..." }
// Server streams back: { type: "delta"|"done"|"tool"|"error", content: "..." }
wss.on("connection", (ws) => {
  let boundContainer = null;

  ws.on("message", async (raw) => {
    let payload;
    try {
      payload = JSON.parse(raw.toString());
    } catch {
      ws.send(JSON.stringify({ type: "error", content: "invalid JSON" }));
      return;
    }

    const { type, container, message, provider } = payload;

    if (type === "bind") {
      boundContainer = container;
      const session = sessions.get(container);
      if (!session) {
        ws.send(JSON.stringify({ type: "error", content: "sandbox not registered" }));
        return;
      }
      session.clients.add(ws);
      ws.send(JSON.stringify({ type: "ready", content: `bound to ${container}` }));
      return;
    }

    if (type === "chat") {
      const targetContainer = container || boundContainer;
      const session = sessions.get(targetContainer);

      if (!session) {
        ws.send(JSON.stringify({ type: "error", content: "sandbox not registered" }));
        return;
      }

      const agentYaml = join(session.dir, "agent.yaml");
      if (!existsSync(agentYaml)) {
        ws.send(JSON.stringify({ type: "error", content: "agent.yaml missing — generate spec first" }));
        return;
      }

      if (!firstAvailableProvider()) {
        ws.send(JSON.stringify({ type: "error", content: NO_KEY_MESSAGE }));
        ws.send(JSON.stringify({ type: "complete", content: "" }));
        return;
      }

      const model = modelFor(provider);
      const mode = resolveTurnMode(payload.mode, message);
      console.log(`[agent] chat container=${targetContainer} model=${model} mode=${mode}`);
      ws.send(JSON.stringify({ type: "thinking", content: "" }));

      if (mode === "ask") {
        // Toolless retrieve-then-generate: reliable on weak-tool-calling models.
        const askPrompt = await buildAskPrompt(session.dir, message);
        await streamTurn(ws, {
          prompt: askPrompt,
          dir: session.dir,
          model,
          replaceBuiltinTools: true, // no built-in tools…
          allowedTools: [],          // …and nothing survives the filter → toolless
          constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
        }, model);
      } else {
        // Agentic path: the model drives cli/read/write/search_code itself.
        await streamTurn(ws, {
          prompt: message,
          dir: session.dir,
          model,
          allowedTools: AGENT_ALLOWED_TOOLS,
          tools: [makeSearchCodeTool(session.dir)],
          constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
        }, model);
      }
    }
  });

  ws.on("close", () => {
    if (boundContainer) {
      const session = sessions.get(boundContainer);
      if (session) session.clients.delete(ws);
    }
  });
});

export { makeSearchCodeTool, resolveTurnMode, extractSearchTerms, buildAskPrompt };

// Skip binding a port when imported for tests (AGENT_NO_LISTEN=1).
if (!process.env.AGENT_NO_LISTEN) {
  const PORT = process.env.AGENT_PORT || 8001;
  server.listen(PORT, () => {
    console.log(`[agent-service] running on port ${PORT}`);
  });
}