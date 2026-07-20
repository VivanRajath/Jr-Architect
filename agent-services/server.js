import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { query } from "gitclaw";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

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
const AGENT_ALLOWED_TOOLS = (process.env.AGENT_ALLOWED_TOOLS || "cli,read,write,memory")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Tools whose completion means files on disk may have changed — used to tell the
// UI to reload the tree/preview. Reads and memory ops don't touch the workspace.
const WRITE_TOOLS = new Set(["write", "edit", "create", "cli"]);

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

  let fullResponse = "";
  let errText = "";
  const model = modelFor(provider);
  rotateGroqKey(model);
  try {
    for await (const msg of query({
      prompt: message,
      dir: session.dir,
      model,
      allowedTools: AGENT_ALLOWED_TOOLS,
    })) {
      if (msg.type === "delta" && msg.deltaType !== "thinking") fullResponse += msg.content;
      else if (msg.type === "system" && msg.subtype === "error") errText = msg.content || errText;
      else if (msg.type === "assistant" && msg.stopReason === "error") errText = msg.errorMessage || errText;
    }
    if (!fullResponse && errText) {
      return res.status(502).json({ error: errText });
    }
    res.json({ response: fullResponse });
  } catch (err) {
    console.error("[agent] query error:", err);
    res.status(500).json({ error: err.message });
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
      rotateGroqKey(model);
      console.log(`[agent] chat container=${targetContainer} model=${model}`);
      ws.send(JSON.stringify({ type: "thinking", content: "" }));

      try {
        for await (const msg of query({
          prompt: message,
          dir: session.dir,
          model,
          allowedTools: AGENT_ALLOWED_TOOLS,
        })) {
          if (msg.type === "delta") {
            // Stream only the visible answer; don't leak chain-of-thought.
            if (msg.deltaType === "thinking") continue;
            ws.send(JSON.stringify({ type: "delta", content: msg.content }));
          } else if (msg.type === "tool_use") {
            ws.send(JSON.stringify({
              type: "tool",
              content: `${msg.toolName}(${JSON.stringify(msg.args)})`,
            }));
          } else if (msg.type === "tool_result") {
            // Only a workspace-mutating tool means the UI needs to reload.
            if (WRITE_TOOLS.has(msg.toolName)) {
              ws.send(JSON.stringify({ type: "file_changed", content: "" }));
            }
          } else if (msg.type === "assistant") {
            // A failed model call still arrives as an assistant message with
            // stopReason "error" — surface it instead of ending silently.
            if (msg.stopReason === "error") {
              ws.send(JSON.stringify({ type: "error", content: msg.errorMessage || "The model returned an error." }));
            }
            // Soft boundary between the agent's assistant messages within one
            // turn (a multi-step agent emits several). NOT the end of the turn.
            ws.send(JSON.stringify({ type: "message_end", content: "" }));
          } else if (msg.type === "system") {
            // gitclaw reports LLM failures as system/error messages — WITHOUT
            // handling these the panel would just spin forever on a failed call.
            if (msg.subtype === "error") {
              console.error(`[agent] LLM error (${msg.metadata?.provider || "?"}/${msg.metadata?.model || "?"}): ${msg.content}`);
              ws.send(JSON.stringify({ type: "error", content: msg.content || "The AI request failed." }));
            } else {
              console.log(`[agent] ${msg.subtype || "system"}`);
            }
          }
        }
        // Definitive end-of-turn: the agent's generator has drained. The UI waits
        // for this to finalize (reload tree/editors/preview, re-enable input).
        ws.send(JSON.stringify({ type: "complete", content: "" }));
      } catch (err) {
        console.error("[agent] stream error:", err);
        ws.send(JSON.stringify({ type: "error", content: err.message }));
        ws.send(JSON.stringify({ type: "complete", content: "" }));
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

const PORT = process.env.AGENT_PORT || 8001;
server.listen(PORT, () => {
  console.log(`[agent-service] running on port ${PORT}`);
});