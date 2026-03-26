import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { query } from "gitclaw";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const app = express();
app.use(express.json());

const server = createServer(app);
const wss = new WebSocketServer({ server });

// Active sessions: container -> { dir, stack, wss clients }
const sessions = new Map();

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
  const { container, message } = req.body;
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

  let fullResponse = "";
  try {
    for await (const msg of query({
      prompt: message,
      dir: session.dir,
      model: process.env.GITCLAW_MODEL || "anthropic:claude-sonnet-4-6",
    })) {
      if (msg.type === "delta") fullResponse += msg.content;
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

    const { type, container, message } = payload;

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

      ws.send(JSON.stringify({ type: "thinking", content: "" }));

      try {
        for await (const msg of query({
          prompt: message,
          dir: session.dir,
          model: process.env.GITCLAW_MODEL || "anthropic:claude-sonnet-4-6",
        })) {
          if (msg.type === "delta") {
            ws.send(JSON.stringify({ type: "delta", content: msg.content }));
          } else if (msg.type === "tool_use") {
            ws.send(JSON.stringify({
              type: "tool",
              content: `${msg.toolName}(${JSON.stringify(msg.args)})`,
            }));
          } else if (msg.type === "tool_result") {
            // File was written — notify UI to reload preview
            ws.send(JSON.stringify({ type: "file_changed", content: "" }));
          } else if (msg.type === "assistant") {
            ws.send(JSON.stringify({ type: "done", content: "" }));
          }
        }
      } catch (err) {
        console.error("[agent] stream error:", err);
        ws.send(JSON.stringify({ type: "error", content: err.message }));
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