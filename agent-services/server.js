import "./models.js";
import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { safeQuery as query } from "./agent-home.js";
import { getModels } from "@mariozechner/pi-ai";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, resolveInside, workspaceRootOf } from "./workspace-fs.js";
import { join, extname, resolve, sep, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import { timingSafeEqual } from "crypto";
import {
  resolvePipelineAgents, personaPreamble, fetchRegistryIndex, findAgent,
  readPipelineManifest, writePipelineManifest, installedAgents,
  loadSkill, loadComplianceRules, listSkills,
  readSpecFile, writeSpecFile, listSkillsDetailed, deleteSkill,
  installedAgentsDetailed, installAgent, fetchAgentDetail, BUILTIN_SKILLS, loadAgentPersona,
  MEMORY_PATHS, classifySlot, assignSlot, overlayPaths, remoteSha,
  KNOWLEDGE_SKILL, SLOT_LABEL,
} from "./registry.js";
import { knowledgeStatus, OVERVIEW_REL } from "./knowledge.js";
import { createHubRouter } from "./hub/routes.js";
import { connectDb } from "./hub/db.js";
import { importHubFiles } from "./hub/import.js";
import { reviewRange, writeAudit, AUDIT_DIR } from "./review.js";
import {
  NO_KEY_MESSAGE, KNOWLEDGE_KEY,
  rotateKey, collectTurn, stripFences, parseJsonLoose,
  AGENT_MAX_OUTPUT_TOKENS, AGENT_TOOLCALL_RETRIES, RETRIABLE_TURN_ERROR, dropRejectedKey, pruneGroqKeys,
  firstAvailableProvider, modelFor, applyKeys, outputCap, providerHasKey,
} from "./llm.js";
import { guardEditBlocks, reviewEditBlocks } from "./guardrails.js";
import { createPlanner } from "./planner.js";
import { classifyCommand, withGuard } from "./command-policy.js";
import * as opengap from "./opengap/index.js";

// ESM has no __dirname; the knowledge worker is spawned by absolute path so the service works regardless of the cwd Go happens to start it from.
const __dirname = dirname(fileURLToPath(import.meta.url));

// Keep the agent service alive when one request's agent loop throws asynchronously.
process.on("unhandledRejection", (err) => {
  console.error("[agent] unhandledRejection:", (err && err.message) || err);
});
process.on("uncaughtException", (err) => {
  console.error("[agent] uncaughtException:", (err && err.message) || err);
});

const app = express();

// Loopback is no boundary under Docker Desktop (host.docker.internal reaches it), so only callers holding Go's token get in.
export function fromJrArch(headers, token = process.env.JR_INTERNAL_TOKEN || "") {
  if (!token) return true;
  const got = Buffer.from(String(headers["x-jr-internal"] || ""));
  const want = Buffer.from(token);
  return got.length === want.length && timingSafeEqual(got, want);
}
app.use((req, res, next) => (fromJrArch(req.headers) ? next() : res.status(403).json({ error: "forbidden" })));
app.use(express.json());

const server = createServer(app);
// Mirrors Go's OriginGuard in case this port is ever reached without going through it.
export function isAllowedOrigin(origin) {
  if (!origin) return true;
  const pub = (process.env.JR_PUBLIC_ORIGIN || "").replace(/\/$/, "").toLowerCase();
  if (pub) return origin.replace(/\/$/, "").toLowerCase() === pub;
  try {
    return ["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname);
  } catch {
    return false;
  }
}
const wss = new WebSocketServer({ server, verifyClient: ({ origin, req }) => isAllowedOrigin(origin) && fromJrArch(req.headers) });

// Active sessions: container -> { dir, stack, owner, wss clients }
const sessions = new Map();

// Go's proxy sets X-Jr-User on every call it forwards; only Go's own calls (token-checked above) come without one.
function mayUse(user, session) {
  return user === undefined || user === "internal" || user === session.owner;
}

// Per-user model calls per hour, set by Go (JR_LLM_PER_HOUR); 0 or unset means no cap.
const llmUse = new Map();
export function allowLLM(user, now = Date.now()) {
  const max = Number(process.env.JR_LLM_PER_HOUR) || 0;
  if (!max || user === undefined || user === "internal") return { ok: true };
  const w = llmUse.get(user);
  if (!w || now - w.start >= 3600_000) {
    if (llmUse.size > 10000) llmUse.clear();
    llmUse.set(user, { start: now, n: 1 });
    return { ok: true };
  }
  if (w.n >= max) return { ok: false, minutes: Math.ceil((w.start + 3600_000 - now) / 60_000) };
  w.n++;
  return { ok: true };
}
const llmLimitMessage = (m) => `hourly AI limit reached, try again in ${m} min`;
const LLM_ROUTES = new Set(["/agent/chat", "/agent/diagnose", "/agent/knowledge", "/agent/guardrail/fix", "/agent/registry/preview"]);
app.use((req, res, next) => {
  if (req.method !== "POST" || !LLM_ROUTES.has(req.path)) return next();
  const r = allowLLM(req.get("x-jr-user"));
  if (!r.ok) return res.status(429).json({ error: llmLimitMessage(r.minutes) });
  next();
});

app.use("/agent/hub", createHubRouter({ allowLLM }));

// Someone else's container reads as unregistered, the same answer as one that does not exist.
app.use((req, res, next) => {
  const container = (req.body && req.body.container) || req.query.container;
  const session = container && sessions.get(container);
  if (session && !mayUse(req.get("x-jr-user"), session)) {
    return res.status(404).json({ error: "sandbox not registered" });
  }
  next();
});


// Restrict the agent to the core coding tools.
const AGENT_ALLOWED_TOOLS = (process.env.AGENT_ALLOWED_TOOLS || "read,write,search_code,shell")
  .split(",").map((s) => s.trim()).filter(Boolean);

// Tools whose completion means files on disk may have changed — used to tell the UI to reload the tree/preview.
const WRITE_TOOLS = new Set(["write", "edit", "create", "shell"]);

// The Go host owns every side effect (docker exec, container write-through).
const HOST_PORT = Number(process.env.HOST_PORT) || 9000;
const HOST_URL = `http://127.0.0.1:${HOST_PORT}`;
// Go's login gate lets these callbacks through on the token it handed this process.
const HOST_HEADERS = { "Content-Type": "application/json", "X-Jr-Internal": process.env.JR_INTERNAL_TOKEN || "" };

// Run a command inside the sandbox container.
async function hostExec(container, command, timeoutMs) {
  const res = await fetch(`${HOST_URL}/terminal/exec`, {
    method: "POST",
    headers: HOST_HEADERS,
    body: JSON.stringify({ container, command, timeoutMs: Number(timeoutMs) || 0 }),
  });
  if (!res.ok) throw new Error(`host exec failed (${res.status})`);
  return res.json();
}

// Edits are written to the host bind-mount, but Docker Desktop's stat cache means the container may never see them.
async function syncToContainer(container, results) {
  if (!container) return;
  const paths = (results || [])
    .filter((r) => r.status === "edited" || r.status === "created")
    .map((r) => r.path);
  if (!paths.length) return;
  try {
    await fetch(`${HOST_URL}/sandbox/sync`, {
      method: "POST",
      headers: HOST_HEADERS,
      body: JSON.stringify({ container, paths }),
    });
  } catch (e) {
    console.error("[sync] container sync failed:", e.message);
  }
}

// gitclaw's built-in write tool writes host-side, so the container needs the same write-through the edit pipeline gets.
function writtenPathFrom(args) {
  if (!args || typeof args !== "object") return null;
  for (const k of ["path", "file_path", "filePath", "file", "filename"]) {
    const v = args[k];
    if (typeof v === "string" && v.trim()) return v.trim().replace(/^\.\//, "");
  }
  return null;
}

// Build a shell tool bound to a container.
// The model proposes a command; classifyCommand and the repo's OpenGAP hooks decide, and "ask" waits for the user over the socket.
function makeShellTool(container, { dir = null, ask = null, user = "" } = {}) {
  return {
    name: "shell",
    description:
      "Run a shell command inside the project's sandbox container, from /workspace. " +
      "Use it for builds, tests, installs, and inspecting the running app. Returns the " +
      "exit code followed by combined stdout/stderr. A non-zero exit code means the " +
      "command failed — read the output before retrying.",
    inputSchema: {
      properties: {
        command: {
          type: "string",
          description: "Shell command to run, e.g. 'npm test' or 'ls -la src'.",
          required: true,
        },
        timeout_ms: {
          type: "number",
          description: "Optional timeout in ms (default 120000, hard cap 600000).",
        },
      },
    },
    handler: async (params) => {
      const command = ((params && params.command) || "").trim();
      if (!command) return "shell: empty command.";
      if (!container) return "shell: this session has no sandbox container bound.";
      let guard = null;
      try { guard = dir && opengap.installed(dir) ? opengap.checkCommandLine(dir, command) : null; } catch { /* no team */ }
      const decision = withGuard(classifyCommand(command), guard);
      let approved = decision.action === "allow";
      if (decision.action === "ask") approved = ask ? (await ask(command, `The agent wants to run this because it ${decision.reason}.`)).approved : false;
      audit({ event: "agent.shell", user, container, action: decision.action, approved, reason: decision.reason, command: command.slice(0, 200) });
      if (decision.action === "deny") return `shell: refused, ${decision.reason}. Do not retry it or try to reach the same result another way.`;
      if (!approved) {
        return ask
          ? "shell: the user declined this command. Continue without it."
          : `shell: not run, because ${decision.reason} and needs the user's approval. Tell the user the exact command so they can run it themselves.`;
      }
      try {
        const r = await hostExec(container, command, params && params.timeout_ms);
        const head = r.timedOut ? `timed out (exit ${r.exitCode})` : `exit ${r.exitCode}`;
        return `$ ${command}
[${head}]
${r.output || "(no output)"}`;
      } catch (e) {
        return `shell: could not run the command (${e.message}).`;
      }
    },
  };
}

const READ_TOOL_MAX_CHARS = 100_000;

// gitclaw's own read/write accept absolute host paths, so agentic turns get these workspace-bound ones.
function makeReadTool(dir) {
  return {
    name: "read",
    description: "Read a project file by its path relative to the repo root. Output is capped at ~100KB.",
    inputSchema: {
      properties: {
        path: { type: "string", description: "Repo-relative path, e.g. 'src/App.tsx'.", required: true },
      },
    },
    handler: async (params) => {
      const rel = params && params.path;
      const abs = resolveInside(dir, rel);
      if (!abs) return `read: ${rel} is outside the project.`;
      try {
        const s = readFileSync(abs, "utf8");
        return s.length > READ_TOOL_MAX_CHARS ? s.slice(0, READ_TOOL_MAX_CHARS) + "\n…(truncated)" : s;
      } catch (e) {
        return `read: ${e.code === "ENOENT" ? "no such file" : e.message}`;
      }
    },
  };
}

function makeWriteTool(dir) {
  return {
    name: "write",
    description: "Create or overwrite a project file by its path relative to the repo root.",
    inputSchema: {
      properties: {
        path: { type: "string", description: "Repo-relative path, e.g. 'src/App.tsx'.", required: true },
        content: { type: "string", description: "The complete new file contents.", required: true },
      },
    },
    handler: async (params) => {
      const rel = params && params.path;
      const abs = resolveInside(dir, rel);
      if (!abs) return `write: ${rel} is outside the project.`;
      const content = String((params && params.content) ?? "");
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content);
        return `Wrote ${Buffer.byteLength(content)} bytes to ${rel}`;
      } catch (e) {
        return `write: ${e.message}`;
      }
    },
  };
}

function agentTools(dir, container, shellOpts = {}) {
  return [makeReadTool(dir), makeWriteTool(dir), makeSearchCodeTool(dir), makeShellTool(container, { dir, ...shellOpts })];
}

// One JSON line per security-relevant agent action; never the full command output, which may hold secrets.
function audit(event) {
  console.log(JSON.stringify({ at: new Date().toISOString(), ...event }));
}

// Layer 2 of code retrieval: the search_code tool
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

// Build a search_code tool bound to a specific workspace dir.
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

// Ask mode: retrieve-then-generate (toolless)

// Clear file-modification intent → agentic/edit path.
const EDIT_INTENT = /\b(add|create|write|edit|change|modif(?:y|ies|ied)|fix|update|refactor|implement|rename|rebrand|relabel|retitle|reword|delete|remove|replace|insert|append|scaffold|install|integrate|rewrite|convert|migrate|set up|setup|wire up)\b/i;

// Imperative "make it look…" verbs.
const EDIT_IMPERATIVE = /\b(make|turn|give|switch|apply|paint|recolou?r|restyle|redesign)\b/i;

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

// Pull a few salient search terms from a question, preferring identifier-like tokens (camelCase / has an uppercase letter) and longer words.
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

// Build the toolless Ask-mode prompt: inject search_code hits for the question's terms as grounding context.
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
  const searchBlock = snippets.length
    ? `Relevant code found by searching the repository${terms.length ? ` for: ${terms.join(", ")}` : ""}:\n\n<search_results>\n${snippets.join("\n")}\n</search_results>\n\n`
    : "";

  // For overview/summary questions, feed the model REAL substance so it can synthesize instead of hedging.
  const isOverview = /\b(summar|overview|understand|explain (?:the|this)|architecture|structure|how does|what is this|what does this|walk me through)\b/i.test(message);
  const overviewPath = firstExistingFile(dir, [OVERVIEW_REL]);
  let contextBlock = "";
  let haveOverview = false;
  if (isOverview) {
    const parts = [];
    const overview = overviewPath ? readFileCapped(join(dir, overviewPath), 6000) : "";
    if (overview) {
      haveOverview = true;
      parts.push(`<file path="${overviewPath}">\n${overview}\n</file>`);
    }
    // With the synthesis in hand only the entry file adds anything; without it, fall back to the old raw-file spread so an un-built workspace still answers.
    const wanted = haveOverview
      ? [firstExistingFile(dir, EDIT_ENTRY_CANDIDATES)]
      : [
          firstExistingFile(dir, ["knowledge/repo-map.md"]),
          firstExistingFile(dir, EDIT_ENTRY_CANDIDATES),
          firstExistingFile(dir, ["app/layout.tsx", "src/app/layout.tsx", "src/main.tsx", "src/index.tsx"]),
          firstExistingFile(dir, ["README.md", "package.json"]),
        ];
    for (const p of wanted.filter((p, i, a) => p && a.indexOf(p) === i)) {
      const body = readFileCapped(join(dir, p), 3000);
      if (body) parts.push(`<file path="${p}">\n${body}\n</file>`);
    }
    if (parts.length) contextBlock = `Key project files:\n\n${parts.join("\n\n")}\n\n`;
  }

  const instruction = isOverview
    ? (haveOverview
        ? `\`${overviewPath}\` above is this repository's own architectural overview, written by the ` +
          `Knowledge agent after reading the codebase. TRUST IT and answer from it. ` +
          `Answer the question directly and concretely, citing real paths. Do NOT hedge, ` +
          `do NOT say you would look at files, do NOT describe your process.`
        : `Write a concrete summary of what this project IS and DOES, using the files above. ` +
          `Cover: what the app does, its stack/framework, the main screens or sections, and how the code is organized. ` +
          `Write it NOW in 4-8 sentences. Do NOT say you would look at files, do NOT say you need more information, ` +
          `do NOT describe your process — just give the summary. Do not invent files or features.`)
    : `Be concrete and answer directly, citing \`file:line\` for specifics. ` +
      `If a needed file isn't shown, name it briefly, but still give your best answer from what's here. Do not invent files or code.`;

  // The Ask persona is the source of truth in .gitagent/skills/ask (built-in fallback if absent).
  const askPersona = skillPersona(dir, "ask");
  return (
    (askPersona ? askPersona + "\n\n" : "") +
    `${searchBlock}${contextBlock}You are answering a question about THIS repository, using the repository map, ` +
    `the file contents, and the search results above. ${instruction}\n\n` +
    `Question: ${message}`
  );
}

// Decide the turn's mode. An explicit client mode wins; otherwise auto-detect: clear file-modification intent → "edit", else "ask".
const ASK_OPENER = /^\s*(what|why|how|where|which|who|when|whose|is|are|was|were|does|do|did|should|would|explain|summar(?:y|ise|ize|ising|izing)|describe|overview|list|walk me|tell me|show me|give me (?:a|an) (?:summary|overview|explanation))\b/i;

// Fast heuristic router. Returns "edit" | "ask" | null, where null means "not obvious — ask the model" (handled by decideMode).
function heuristicMode(message) {
  const m = (message || "").trim();
  if (!m) return "ask";
  // Obvious change: an edit verb, or an imperative styling command that names a style/UI target ("make the ui dark red").
  if (EDIT_INTENT.test(m) || (EDIT_IMPERATIVE.test(m) && EDIT_STYLE_INTENT.test(m))) return "edit";
  // Obvious question.
  if (ASK_OPENER.test(m)) return "ask";
  return null;
}

// Shared stream+retry loop for one turn.
async function streamTurn(ws, queryOptions, model, container) {
  let streamedAny = false;
  let attempt = 0;
  let pendingWrite = null;
  while (true) {
    rotateKey(model);
    let turnError = null;
    try {
      for await (const msg of query(queryOptions)) {
        if (msg.type === "delta") {
          if (msg.deltaType === "thinking") continue;
          streamedAny = true;
          ws.send(JSON.stringify({ type: "delta", content: msg.content }));
        } else if (msg.type === "tool_use") {
          streamedAny = true;
          if (WRITE_TOOLS.has(msg.toolName)) pendingWrite = writtenPathFrom(msg.args);
          ws.send(JSON.stringify({ type: "tool", content: `${msg.toolName}(${JSON.stringify(msg.args)})` }));
        } else if (msg.type === "tool_result") {
          if (WRITE_TOOLS.has(msg.toolName)) {
            if (pendingWrite) await syncToContainer(container, [{ path: pendingWrite, status: "edited" }]);
            pendingWrite = null;
            ws.send(JSON.stringify({ type: "file_changed", content: "" }));
          }
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

    if (turnError && !streamedAny && dropRejectedKey(model, turnError)) continue;
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

// Edit mode: generate-then-apply (toolless code changes)

const EDIT_ENTRY_CANDIDATES = [
  "app/page.tsx", "app/page.jsx", "app/page.js", "src/app/page.tsx",
  "pages/index.tsx", "pages/index.jsx", "src/pages/index.tsx",
  "src/App.tsx", "src/App.jsx", "src/App.js", "src/main.tsx", "src/main.jsx",
  "src/index.tsx", "index.html", "public/index.html",
];
// Files most likely targeted by look-and-feel changes.
const EDIT_STYLE_CANDIDATES = [
  "app/globals.css", "src/app/globals.css", "styles/globals.css", "src/globals.css",
  "src/index.css", "src/App.css", "src/styles.css",
  "public/styles.css", "public/style.css", "public/css/styles.css", "public/css/style.css", "public/app.css",
  "styles.css", "style.css", "css/styles.css", "css/style.css", "static/styles.css", "static/css/styles.css",
  "tailwind.config.ts", "tailwind.config.js", "app/layout.tsx", "src/app/layout.tsx",
];
// Colour and theme requests are answered by stylesheets first, before markup.
const EDIT_COLOR_INTENT = /\b(colou?rs?|theme|palette|dark|light|accent|primary|brand|orange|blue|pink|red|green|purple|violet|yellow|teal|cyan|indigo|gr[ae]y|black|white|gradient|background)\b/i;
// Data, lockfiles, generated specs and examples never answer a UI request, even when a search word matches them.
const EDIT_NOT_TARGET = /(?:^|\/)(?:package-lock\.json|yarn\.lock|pnpm-lock\.yaml|[^/]*\.example\.[^/]+|\.env[^/]*|jr-workflows[^/]*\.json|agent\.yaml|INSTRUCTIONS\.md|(?:public\/)?ui\.(?:css|js))$|^(?:\.gitagent|knowledge)\//i;
const EDIT_STYLE_INTENT = /\b(theme|dark|light|colou?r|style|styling|css|font|background|ui|layout|design|spacing|padding|margin)\b/i;
// Library and generated boilerplate is never a good edit target, even when a keyword search matches it.
const EDIT_SKIP_PATH = /(?:^|\/)(?:components\/ui|node_modules|\.next|dist|build|out|coverage|vendor|\.git)\//i;
const EDIT_MAX_FILES = 5;      // how many files to *show* the model as context
// Files are shown in full up to this size; the model patches them with SEARCH/REPLACE, so size no longer has to fit in the reply.
const EDIT_MAX_FILE_CHARS = 24000;
const EDIT_TOTAL_CHARS = 30000;
// Small enough that a whole-file rewrite is also acceptable.
const WHOLE_FILE_MAX_CHARS = 6000;
const EDIT_MAX_EDITABLE = 3;   // don't offer more than this many rewritable files

// Layered agentic edit pipeline (gitagent standard)

// Layer: Complexity Classifier (the "Code Editor Squad" tiered dispatch).
function classifyEditComplexity(message, availableFiles) {
  const senior = /\b(refactor|across|every|all (?:the )?(?:files|pages|components)|multiple files|throughout|whole app|entire app|everywhere|migrate)\b/i.test(message);
  if (senior && availableFiles > 1) {
    return { tier: "senior", maxFiles: Math.min(EDIT_MAX_EDITABLE, availableFiles), label: "senior dev · multi-file change" };
  }
  return { tier: "junior", maxFiles: Math.min(2, availableFiles), label: "junior dev · focused change" };
}


// Layer: Guardrails (registry agents). The regex guard above is the code-level floor — fixed rules, no model.

// Read a file, truncating to maxChars (keeps the request under the token budget).
function readFileCapped(abs, maxChars) {
  try {
    const s = readFileSync(abs, "utf8");
    return s.length > maxChars ? s.slice(0, maxChars) + "\n/* …truncated… */" : s;
  } catch {
    return "";
  }
}

// First of `candidates` that exists under dir (forward-slash relative path).
function firstExistingFile(dir, candidates) {
  for (const c of candidates) {
    if (existsSync(join(dir, c))) return c;
  }
  return "";
}

// Choose which files to hand the model for an edit.
async function gatherEditFiles(dir, message) {
  const chosen = [];
  const named = new Set((message.match(/[\w./-]+\.[a-z0-9]{1,6}\b/gi) || []).map((x) => x.replace(/^\.\//, "")));
  const add = (p) => {
    if (!p || chosen.includes(p)) return;
    if (EDIT_SKIP_PATH.test(p)) return;              // never edit library boilerplate
    if (EDIT_NOT_TARGET.test(p) && !named.has(p)) return;
    if (!existsSync(join(dir, p))) return;
    if (chosen.length >= EDIT_MAX_FILES) return;
    chosen.push(p);
  };

  // 0. Files the user named always come first.
  for (const n of named) add(n);
  const colour = EDIT_COLOR_INTENT.test(message);
  // 1. For colour and theme changes the stylesheets lead; otherwise the UI entry point does.
  if (colour) {
    for (const c of EDIT_STYLE_CANDIDATES) add(c);
    for (const c of findStylesheets(dir)) add(c);
    add(firstExistingFile(dir, EDIT_ENTRY_CANDIDATES));
  } else {
    add(firstExistingFile(dir, EDIT_ENTRY_CANDIDATES));
    if (EDIT_STYLE_INTENT.test(message)) {
      for (const c of EDIT_STYLE_CANDIDATES) add(c);
    }
  }
  // 3. Fill any remaining slots with files that mention the request's key terms.
  const tool = makeSearchCodeTool(dir);
  for (const term of extractSearchTerms(message)) {
    if (chosen.length >= EDIT_MAX_FILES) break;
    let res;
    try {
      res = await tool.handler({ query: term, max_results: 8 });
    } catch {
      continue;
    }
    if (!res || res.startsWith("No matches")) continue;
    for (const line of res.split("\n").slice(1)) {
      const p = line.split(":")[0];
      if (p) add(p);
    }
  }

  let budget = EDIT_TOTAL_CHARS;
  return chosen.map((p) => {
    const content = readFileCapped(join(dir, p), Math.min(EDIT_MAX_FILE_CHARS, Math.max(budget, 0)));
    const complete = content.length > 0 && !content.includes("…truncated…");
    budget -= content.length;
    // Every complete file can be patched; only small ones may also be rewritten whole.
    return { path: p, content, whole: complete, small: complete && content.length <= WHOLE_FILE_MAX_CHARS };
  });
}

// A plan task's files: existing ones in full, missing ones offered as new files to create.
function readTaskFiles(dir, paths) {
  let budget = EDIT_TOTAL_CHARS;
  return paths.filter((p) => !EDIT_SKIP_PATH.test(p)).map((p) => {
    const abs = join(dir, p);
    if (!existsSync(abs)) return { path: p, content: "(new file: it does not exist yet; create it with a FILE block)", whole: true, small: true, isNew: true };
    const content = readFileCapped(abs, Math.min(EDIT_MAX_FILE_CHARS, Math.max(budget, 0)));
    budget -= content.length;
    const complete = content.length > 0 && !content.includes("…truncated…");
    return { path: p, content, whole: complete, small: complete && content.length <= WHOLE_FILE_MAX_CHARS };
  });
}

// Stylesheets in the project, shallow first, without libraries or build output.
function findStylesheets(dir, limit = 6) {
  const out = [];
  const walk = (rel, depth) => {
    if (depth > 3 || out.length >= limit) return;
    let ents = [];
    try { ents = readdirSync(join(dir, rel), { withFileTypes: true }); } catch { return; }
    ents.sort((a, b) => Number(a.isDirectory()) - Number(b.isDirectory()) || a.name.localeCompare(b.name));
    for (const e of ents) {
      if (out.length >= limit) return;
      const p = rel ? `${rel}/${e.name}` : e.name;
      if (e.name.startsWith(".") || EDIT_SKIP_PATH.test(p + "/") || /^(node_modules|dist|build|out|vendor|components)$/.test(e.name)) continue;
      if (e.isDirectory()) walk(p, depth + 1);
      else if (/\.(css|scss)$/i.test(e.name)) out.push(p);
    }
  };
  walk("", 0);
  return out;
}

// The whole-file rewrite prompt.
const SKILL_FALLBACK = {
  "jnr-developer": "You are the Junior Developer. Make the smallest, most focused change that satisfies the request; prefer a single file; do not refactor, rename, or add anything not asked for.",
  "snr-developer": "You are the Senior Developer. The change spans a few related files; update all that must change together to keep the app consistent, keep the architecture intact, and do not expand scope.",
  "ask": "Answer concretely and grounded in the actual files; cite real file paths; do not describe what you would look at; never change files in Ask mode.",
  "build-doctor": "Classify the logs as a real blocker vs. noise; for a real blocker propose the smallest safe fix (one command or one edit); never rewrite lockfiles, run npm audit fix --force, or delete files.",
};

// Resolve a persona: the repo's own .gitagent/skills/<name>/SKILL.md wins (source of truth.
function skillPersona(dir, name) {
  return loadSkill(dir, name) || SKILL_FALLBACK[name] || "";
}

function buildEditPrompt(files, message, cls, persona, strict = false) {
  const wrap = (f) => `=== FILE: ${f.path} ===\n${f.content}\n=== END FILE ===`;
  const fileBlocks = files.map(wrap).join("\n\n");
  const scopeLine = cls && cls.tier === "junior"
    ? `- Scope: a focused change. Edit the fewest files that satisfy the request (at most ${files.length}). For colours and themes, change the stylesheet's colour variables and colour values rather than the markup.\n`
    : `- Scope: edit every file that must change together to satisfy the request, and nothing else.\n`;
  return (
    (persona ? persona + "\n\n" : "") +
    `You are the Developer layer of a coding agent. You DO the edit; you never describe it. ` +
    `Here are the current files:\n\n${fileBlocks}\n\n` +
    `Return your change as EDIT blocks. Each SEARCH must copy lines EXACTLY as they appear in the file ` +
    `(same spacing), and be just long enough to be unique:\n\n` +
    `=== EDIT: relative/path ===\n<<<<<<< SEARCH\n{exact existing lines}\n=======\n{replacement lines}\n>>>>>>> REPLACE\n=== END EDIT ===\n\n` +
    `One EDIT block may hold several SEARCH/REPLACE pairs. To create a NEW file, use:\n` +
    `=== FILE: relative/path ===\n{entire contents}\n=== END FILE ===\n\n` +
    `Rules:\n` +
    `- Change ONLY what the request asks for; keep everything else as it is.\n` +
    `- Do NOT invent features, extra options, comments, or placeholder content.\n` +
    scopeLine +
    `- Only edit files shown above.\n` +
    `- Output ONLY EDIT/FILE blocks: no explanation, no code fences around the blocks.\n` +
    (strict ? `- Think briefly. Start your answer with "=== EDIT:" right away.\n` : "") +
    `\nChange requested: ${message}`
  );
}

// Groq bills input plus reserved output against the key's tokens-per-minute (8k on the free tier for the big models), so the reply gets what the prompt leaves.
const GROQ_REQUEST_TOKENS = Number(process.env.GROQ_EDIT_REQUEST_TOKENS) || 7600;
function editOutputBudget(model, prompt) {
  if (!String(model || "").startsWith("groq:")) return outputCap(model);
  // The engine adds its own system prompt and the repo's agent spec, roughly 1.5k tokens.
  const inputTokens = Math.ceil(prompt.length / 3.4) + 1500;
  return Math.max(1500, Math.min(6000, GROQ_REQUEST_TOKENS - inputTokens));
}

// "Limit 8000, Requested 8130": the room the next try has, given what this one reserved.
function roomAfter413(error, reserved) {
  const m = /Limit\s+(\d+),\s*Requested\s+(\d+)/i.exec(String(error || ""));
  if (!m) return null;
  const limit = Number(m[1]), requested = Number(m[2]);
  return limit - (requested - reserved) - 150;
}


// Parse whole-file blocks out of the model's reply.
function parseEditBlocks(text) {
  const blocks = [];
  const seen = new Set();
  const push = (path, body) => {
    const p = (path || "").trim().replace(/^["']|["']$/g, "");
    const content = stripFences(body);
    if (!p || seen.has(p) || !content.trim()) return;
    seen.add(p);
    blocks.push({ path: p, content });
  };
  const reE = /={3,}\s*EDIT:\s*(.+?)\s*={3,}\s*\r?\n([\s\S]*?)={3,}\s*END\s*EDIT\s*={3,}/gi;
  let e;
  while ((e = reE.exec(text)) !== null) {
    const path = (e[1] || "").trim().replace(/^["'`]|["'`]$/g, "");
    const hunks = [];
    const reH = /<{5,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n?={5,}\s*\r?\n([\s\S]*?)\r?\n?>{5,}\s*REPLACE/g;
    let h;
    while ((h = reH.exec(e[2])) !== null) hunks.push({ search: h[1], replace: h[2] });
    if (path && hunks.length && !seen.has(path)) {
      seen.add(path);
      blocks.push({ path, hunks });
    }
  }
  const reA = /={3,}\s*FILE:\s*(.+?)\s*={3,}\s*\r?\n([\s\S]*?)\r?\n?={3,}\s*END\s*FILE\s*={3,}/gi;
  let m;
  while ((m = reA.exec(text)) !== null) push(m[1], m[2]);
  const reB = /<file\s+path=["']([^"']+)["']\s*>\r?\n([\s\S]*?)\r?\n?<\/file>/gi;
  while ((m = reB.exec(text)) !== null) push(m[1], m[2]);
  return blocks;
}

// Apply whole-file blocks to disk. Path-safe (stays inside dir).
function applyEditBlocks(dir, blocks, offered, guard) {
  const root = resolve(dir);
  const known = new Set((offered || []).map((f) => f.path));
  const results = [];
  for (const b of blocks) {
    const abs = resolve(dir, b.path);
    if (abs !== root && !abs.startsWith(root + sep)) {
      results.push({ path: b.path, status: "rejected (outside workspace)" });
      continue;
    }
    const existed = existsSync(abs);
    if (existed && known.size && !known.has(b.path)) {
      results.push({ path: b.path, status: "skipped (not offered for edit)" });
      continue;
    }
    if (b.hunks && !existed) {
      results.push({ path: b.path, status: "skipped (edit for a file that does not exist)" });
      continue;
    }
    try {
      const prev = existed ? readFileSync(abs, "utf8") : null;
      let next;
      if (b.hunks) {
        const patched = applyHunks(prev, b.hunks);
        if (patched.failed.length) {
          results.push({ path: b.path, status: `not applied (${patched.failed.length} of ${b.hunks.length} change(s) did not match the file)` });
          continue;
        }
        next = patched.text;
      } else {
        next = b.content.endsWith("\n") ? b.content : b.content + "\n";
      }
      if (prev !== null && prev === next) {
        results.push({ path: b.path, status: "unchanged" });
        continue;
      }
      // OpenGAP guardrails run at the harness level on the final content, so no persona can talk its way past them.
      if (guard) {
        const g = guard(b.path, prev, next);
        if (g && g.blocked && g.blocked.length) {
          results.push({
            path: b.path, status: `blocked by guardrails (${g.blocked.map((x) => x.hook).join(", ")})`,
            denial: { pack: "OpenGAP hooks", why: g.blocked.map((x) => x.reason).join(" "), tier: "floor", rulePath: ".gitagent/hooks/hooks.yaml", answerable: false },
            proposed: next.length <= 120000 ? next : null, before: prev && prev.length <= 60000 ? prev : null,
          });
          continue;
        }
      }
      writeFileSync(abs, next);
      // Carry before/after so the UI can show a diff on click (cap the payload).
      const small = (s) => (s != null && s.length <= 60000);
      results.push({
        path: b.path,
        status: existed ? "edited" : "created",
        before: small(prev) ? (prev || "") : null,
        after: small(next) ? next : null,
      });
    } catch (e) {
      results.push({ path: b.path, status: "error: " + e.message });
    }
  }
  return results;
}


// Applies SEARCH/REPLACE hunks in order; a hunk that matches nowhere is reported, never guessed at.
function applyHunks(text, hunks) {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let out = text.replace(/\r\n/g, "\n");
  const failed = [];
  for (const h of hunks) {
    const search = h.search.replace(/\r\n/g, "\n");
    const replace = h.replace.replace(/\r\n/g, "\n");
    if (!search.trim()) { failed.push(h); continue; }
    if (out.includes(search)) {
      out = out.replace(search, () => replace);
      continue;
    }
    // Models often get indentation wrong: match line by line on trimmed text, keep the file's indentation.
    const lines = out.split("\n");
    const want = search.split("\n").map((l) => l.trim());
    while (want.length && !want[want.length - 1]) want.pop();
    let at = -1;
    for (let i = 0; i + want.length <= lines.length && at < 0; i++) {
      if (want.every((w, j) => lines[i + j].trim() === w)) at = i;
    }
    if (at < 0) { failed.push(h); continue; }
    const indent = (lines[at].match(/^\s*/) || [""])[0];
    const firstIndent = (search.split("\n")[0].match(/^\s*/) || [""])[0];
    const repl = replace.split("\n").map((l) => (l.startsWith(firstIndent) ? indent + l.slice(firstIndent.length) : l));
    lines.splice(at, want.length, ...repl);
    out = lines.join("\n");
  }
  return { text: eol === "\n" ? out : out.replace(/\n/g, eol), failed };
}

// LLM Orchestrator: classify an ambiguous message as "edit" vs "ask" with a single cheap toolless call.
async function classifyIntentLLM(message, dir, model) {
  const prompt =
    `You route messages for a coding agent. Decide whether the user wants to CHANGE ` +
    `files in the project (rename, rebrand, restyle, add, remove, fix, reword, move ` +
    `things) or just get an ANSWER (explain, summarize, locate, understand — no file ` +
    `changes).\nReply with exactly one word: edit OR ask.\n\nMessage: ${message}`;
  try {
    const { text } = await collectTurn({
      prompt, dir, model, replaceBuiltinTools: true, allowedTools: [],
      constraints: { maxTokens: outputCap(model) },
    }, model);
    return /\bedit\b/i.test(text || "") ? "edit" : "ask";
  } catch {
    return "ask";
  }
}

// The Orchestrator layer. Explicit UI mode wins; then the free heuristic; then, for genuinely ambiguous messages, the LLM classifier.
async function decideMode(explicit, message, dir, model) {
  if (explicit === "ask" || explicit === "edit" || explicit === "agent") return explicit;
  let mode = heuristicMode(message);
  if (mode === null) mode = await classifyIntentLLM(message, dir, model);
  if (mode === "edit" && process.env.AGENT_EDIT_STRATEGY === "agentic") return "agent";
  return mode;
}

// The layered edit pipeline (gitagent squads): Orchestrator → Classifier → Guardrails → Developer → Guardrails(apply).
async function runEditPipeline(dir, message, model, onStep, container, opts = {}) {
  const step = (name, detail) => { if (onStep) onStep(name, detail); };

  // Orchestrator already routed us here (mode=edit).
  step("Orchestrator", opts.files ? `task → ${opts.files.join(", ") || "search"}` : "route → edit");

  // Gather candidate files, keep the ones small enough to rewrite whole.
  const gathered = opts.files && opts.files.length ? readTaskFiles(dir, opts.files) : await gatherEditFiles(dir, message);
  const whole = gathered.filter((f) => f.whole);
  // Relevant files we found but can't rewrite whole on the free tier.
  const tooLarge = gathered.filter((f) => !f.whole).map((f) => f.path);
  if (whole.length === 0) {
    return { ok: false, reason: gathered.length ? "too-large" : "not-found", tooLarge };
  }

  // Complexity Classifier — decides how many files the Developer may rewrite; a plan's task already names its files.
  const cls = opts.files && opts.files.length
    ? { tier: whole.length > 1 ? "senior" : "junior", maxFiles: whole.length, label: `plan step · ${whole.length} file(s)` }
    : classifyEditComplexity(message, whole.length);
  step("Classifier", cls.label);
  const editable = whole.slice(0, cls.maxFiles);

  // GitAgent registry — if this workspace declares a pipeline (.gitagent/pipeline .yaml or env override), install the referenced registry agents (live clone) and let them drive the Developer/Guardrails slots.
  let agents = { enabled: false };
  try {
    agents = await resolvePipelineAgents(dir, onStep);
  } catch (e) {
    step("GitAgent", `registry unavailable (${e.message}) · using built-ins`);
  }

  // Developer persona comes from the repo's own .gitagent/skills/ (source of truth).
  const tierSkill = cls.tier === "senior" ? "snr-developer" : "jnr-developer";
  // An OpenGAP agent brings its own SOUL, RULES and handoff brief.
  const devText = opts.persona || skillPersona(dir, tierSkill);
  const compliance = loadComplianceRules(dir);
  const persona = [
    devText,
    personaPreamble(agents),
    compliance ? `ADDITIONAL COMPLIANCE RULES (deny always wins):\n${compliance}` : "",
  ].filter(Boolean).join("\n\n");

  // Guardrails (pre) — scope is bounded to files we chose and showed the model.
  const guardNote = agents.enabled && agents.guardrails.length
    ? ` · +${agents.guardrails.length} registry guardrail(s)` : "";
  const complianceNote = compliance ? " · compliance rules loaded" : "";
  step("Guardrails", `scope ok · ${editable.length} file(s)${guardNote}${complianceNote}`);

  // Developer — produce the whole-file rewrite, driven by the tier's skill.
  const devLabel = opts.agentName ? ` as ${opts.agentName}` : agents.developer ? ` as ${agents.developer.name}` : ` · skills/${tierSkill}`;
  step("Developer", `editing ${editable.map((f) => f.path).join(", ")}${devLabel}`);
  const ask = async (files, strict) => {
    const prompt = buildEditPrompt(files, message, cls, persona, strict);
    let maxTokens = editOutputBudget(model, prompt);
    let res = await collectTurn({ prompt, dir, model, replaceBuiltinTools: true, allowedTools: [], constraints: { maxTokens } }, model);
    // A 413 says exactly how much room there is; retry once with that, if it still leaves space to answer.
    const room = !res.text && roomAfter413(res.error, maxTokens);
    if (room && room >= 1200 && room < maxTokens) {
      maxTokens = room;
      res = await collectTurn({ prompt, dir, model, replaceBuiltinTools: true, allowedTools: [], constraints: { maxTokens } }, model);
    }
    return res;
  };
  let { text, error } = await ask(editable, false);
  if (error && !text && /\b413\b|too large/i.test(error) && editable.length > 1) {
    step("Developer", `request too large · retrying with ${editable[0].path} only`);
    ({ text, error } = await ask(editable.slice(0, 1), true));
  }
  if (error && !text) return { ok: false, reason: "error", error };

  let blocks = parseEditBlocks(text);
  if (blocks.length === 0) {
    // An empty or unparseable reply is usually a reasoning model spending its whole budget thinking: retry once, shorter.
    step("Developer", `retrying with ${editable[0].path} only`);
    ({ text, error } = await ask(editable.slice(0, 1), true));
    blocks = parseEditBlocks(text || "");
    if (blocks.length === 0) return { ok: false, reason: "no-blocks", text: error ? "" : text, tried: editable.map((f) => f.path) };
  }

  // Guardrails (apply) — refuse sensitive files / secret injection.
  const { allowed, blocked } = guardEditBlocks(blocks);
  if (blocked.length) step("Guardrails", `blocked ${blocked.length} unsafe edit(s)`);

  // Then the installed guardrail agents get the last word on what survived: they read the actual rewrite and may deny it.
  const reviewed = await reviewEditBlocks(dir, agents, message, allowed, model, step);
  blocked.push(...reviewed.blocked);

  const results = applyEditBlocks(dir, reviewed.allowed, editable, opts.guard);
  await syncToContainer(container, results);
  for (const b of blocked) {
    results.push({
      path: b.path,
      status: `blocked by guardrails (${b.reason})`,
      // A denial is answerable, so it has to carry enough to answer it: which pack, which rule, where that rule lives, and the content that was refused.
      denial: {
        pack: b.pack || "",
        why: b.why || b.reason || "",
        tier: b.tier || "pack",
        rulePath: rulePathFor(dir, b.pack),
        // Only the tier-2 review can be argued with; the code floor is fixed.
        answerable: b.tier !== "floor",
      },
      proposed: b.content != null && b.content.length <= 120000 ? b.content : null,
      before: existsSync(join(dir, ...b.path.split("/"))) ? readFileCapped(join(dir, ...b.path.split("/")), 60000) : null,
    });
  }
  return { ok: true, results, cls, tooLarge };
}

// Where a pack's rules live, so the panel can open them.
function rulePathFor(dir, pack) {
  if (!pack || pack === "code floor") return "";
  if (pack.startsWith(".gitagent/")) return ".gitagent/compliance/RULES.md";
  const rel = overlayPaths(pack, "guardrails").spec;
  return existsSync(join(dir, ...rel.split("/"))) ? rel : "";
}

// Build the human summary + changed-flag from a pipeline result.
function summarizeEdit(out) {
  if (!out.ok) {
    if (out.reason === "too-large") {
      const names = (out.tooLarge || []).slice(0, 4).map((p) => `\`${p}\``).join(", ");
      return { text: `The file(s) for that change are too large to rewrite safely on the free tier${names ? ` (${names})` : ""}. Name a specific smaller file, or split the change into a smaller step.`, changed: false, error: null };
    }
    if (out.reason === "not-found") return { text: "I couldn't find the files to change for that request. Try naming a file or feature, e.g. \"make the header in app/page.tsx dark\".", changed: false, error: null };
    if (out.reason === "error") return { text: "", changed: false, error: out.error };
    if (out.reason === "no-blocks") {
      const files = (out.tried || []).map((p) => `\`${p}\``).join(", ");
      const said = out.text && !/^\s*$/.test(out.text) ? `\n\nThe model answered without an edit:\n${out.text.slice(0, 600)}` : "";
      return { text: `I couldn't get an edit back from the model${files ? ` for ${files}` : ""}. Try again, name the exact file (for example \`public/styles.css\`), or pick a stronger model in the provider menu.${said}`, changed: false, error: null };
    }
  }
  const changed = out.results.filter((r) => r.status === "edited" || r.status === "created");
  // When nothing changed, name any relevant file that was too large to rewrite.
  const bigHint = (!changed.length && out.tooLarge && out.tooLarge.length)
    ? ` The change likely lives in ${out.tooLarge.slice(0, 3).map((p) => `\`${p}\``).join(", ")}, which is too large to rewrite whole on the free tier — try naming a smaller file or splitting the change.`
    : "";
  const summary =
    `Applied ${changed.length} change(s):\n` +
    out.results.map((r) => `- \`${r.path}\` — ${r.status}`).join("\n") +
    (changed.length ? "\n\nThe preview will reload with your changes." : `\n\nNo files changed.${bigHint || " Try rephrasing, or name the exact file to edit."}`);
  return { text: summary, changed: changed.length > 0, error: null };
}

// Run the layered edit pipeline over a WebSocket, streaming each layer as a step.
async function runEditModeWS(ws, dir, message, model, container) {
  const out = await runCodingTask(dir, message, model, (name, detail) => {
    ws.send(JSON.stringify({ type: "tool", content: `${name}(${detail})` }));
  }, container, { onEvent: (e) => ws.send(JSON.stringify({ type: "og", event: e })) });
  // A team run that changed nothing still ends with a record of who tried what.
  if (out && out.run && !out.results.length) {
    ws.send(JSON.stringify({ type: "delta", content: `No files changed. ${out.run.outcome === "stopped" ? "The team stopped and needs you: see the workflow card above." : ""}` }));
    ws.send(JSON.stringify({ type: "complete", content: "" }));
    return;
  }
  const { text, changed, error } = summarizeEdit(out);
  if (error) {
    ws.send(JSON.stringify({ type: "error", content: error }));
    ws.send(JSON.stringify({ type: "complete", content: "" }));
    return;
  }
  if (changed) ws.send(JSON.stringify({ type: "file_changed", content: "" }));
  // Structured, clickable summary: each file row can open a before/after diff.
  if (out.ok && out.results) {
    const files = out.results.map((r) => ({
      path: r.path,
      status: r.status,
      before: r.before ?? null,
      after: r.after ?? null,
      denial: r.denial ?? null,
      proposed: r.proposed ?? null,
    }));
    ws.send(JSON.stringify({ type: "edit_summary", files }));
  } else {
    ws.send(JSON.stringify({ type: "delta", content: text }));
  }
  ws.send(JSON.stringify({ type: "complete", content: "" }));
}


// Registers a sandbox dir once Jr Architect has cloned it and generated its agent spec.
function agentSpecPresent(dir) {
  return existsSync(join(dir, ".gitagent", "agent.yaml")) || existsSync(join(dir, "agent.yaml"));
}

// Knowledge slot

// Per-workspace build state, so the panel can show what is happening without the build having to finish first.
const knowledgeState = new Map();

function knowledgeStateFor(dir) {
  return knowledgeState.get(dir) || { status: "idle" };
}

function runKnowledgeBuild(dir, { agent, force } = {}) {
  const cur = knowledgeStateFor(dir);
  if (cur.status === "building") return cur;              // already in flight
  if (!force && knowledgeStatus(dir).exists) {
    // A workspace that already carries the document does not rebuild on open.
    const st = { status: "ready", skipped: "already built" };
    knowledgeState.set(dir, st);
    return st;
  }
  if (!firstAvailableProvider()) {
    const st = { status: "failed", error: "no AI provider key configured" };
    knowledgeState.set(dir, st);
    return st;
  }

  const model = modelFor();
  const startedAt = Date.now();
  knowledgeState.set(dir, { status: "building", startedAt, agent: agent || KNOWLEDGE_SKILL });

  const env = { ...process.env };
  // The reserved key, and only here. Absent it the worker inherits the chat key and simply competes — degraded, not broken.
  if (KNOWLEDGE_KEY) env.GROQ_API_KEY = KNOWLEDGE_KEY;

  const child = spawn(
    process.execPath,
    [join(__dirname, "knowledge-worker.js"), JSON.stringify({ dir, model, agent })],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );

  let out = "";
  child.stdout.on("data", (b) => { out += b.toString(); });
  child.stderr.on("data", (b) => process.stderr.write(b));
  child.on("error", (e) => {
    knowledgeState.set(dir, { status: "failed", error: e.message, startedAt });
  });
  child.on("close", () => {
    let result = null;
    try { result = JSON.parse(out.trim().split("\n").pop() || "{}"); } catch { /* no usable line */ }
    if (result && result.ok) {
      knowledgeState.set(dir, {
        status: "ready", startedAt, tookMs: Date.now() - startedAt,
        sources: result.sources, bytes: result.bytes,
      });
      console.log(`[knowledge] built ${result.path} from ${result.sources} sources in ${Date.now() - startedAt}ms`);
    } else {
      const error = (result && (result.error || result.reason)) || "the build produced no document";
      knowledgeState.set(dir, { status: "failed", error, startedAt });
      console.error("[knowledge] build failed:", error);
    }
  });

  return knowledgeStateFor(dir);
}

app.post("/agent/register", (req, res) => {
  const { container, workdir, stack, owner } = req.body;
  if (!container || !workdir) {
    return res.status(400).json({ error: "container and workdir required" });
  }
  if (workspaceRootOf(workdir) !== resolve(workdir)) {
    return res.status(400).json({ error: "workdir is not a sandbox workspace" });
  }
  sessions.set(container, { dir: workdir, stack: stack || "unknown", owner: owner || "", clients: new Set() });
  console.log(`[agent] registered container=${container} dir=${workdir} stack=${stack}`);
  // Respond first. The build takes ~30-60s and must never hold up the sandbox — Go calls this in a goroutine at clone time and ignores the body.
  res.json({ status: "registered" });
  try {
    const manifest = readPipelineManifest(workdir);
    runKnowledgeBuild(workdir, { agent: (manifest && manifest.knowledge) || undefined });
  } catch (e) {
    console.error("[knowledge] could not start the build:", e.message);
  }
});

// Rebuild on demand — after editing the builder's SKILL.md, or after the repo has changed enough that the overview is stale.
app.get("/agent/health", (_req, res) => res.json({ ok: true, sessions: sessions.size }));

// Go calls this directly after Settings saves a key; its proxy refuses the path from browsers.
app.post("/agent/keys", (req, res) => {
  applyKeys(req.body);
  res.json({ ok: true });
});

app.post("/agent/knowledge", (req, res) => {
  const { container } = req.body || {};
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  const manifest = readPipelineManifest(session.dir);
  const state = runKnowledgeBuild(session.dir, {
    agent: (manifest && manifest.knowledge) || undefined,
    force: true,
  });
  res.json({ state, doc: knowledgeStatus(session.dir) });
});

// Poll target while a build is in flight.
app.get("/agent/knowledge", (req, res) => {
  const session = sessions.get(req.query.container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  res.json({ state: knowledgeStateFor(session.dir), doc: knowledgeStatus(session.dir) });
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

  if (!agentSpecPresent(session.dir)) {
    return res.status(400).json({ error: "agent.yaml not found — run gitagent_generator first" });
  }

  if (!firstAvailableProvider()) {
    return res.status(400).json({ error: NO_KEY_MESSAGE });
  }

  const model = modelFor(provider);
  const mode = await decideMode(req.body.mode, message, session.dir, model);

  // Edit mode: the layered pipeline (Orchestrator → Classifier → Guardrails → Developer), buffered into a single summary for the REST fallback.
  if (mode === "edit") {
    const out = await runEditPipeline(session.dir, message, model, null, container);
    const { text, changed, error } = summarizeEdit(out);
    if (error) return res.status(502).json({ error });
    return res.json({ response: text, file_changed: changed });
  }

  // Ask mode does retrieval up front and runs toolless; agentic drives tools.
  const queryOptions = mode === "ask"
    ? {
        prompt: await buildAskPrompt(session.dir, message),
        dir: session.dir,
        model,
        replaceBuiltinTools: true,
        allowedTools: [],
        constraints: { maxTokens: outputCap(model) },
      }
    : {
        prompt: message,
        dir: session.dir,
        model,
        replaceBuiltinTools: true,
        allowedTools: AGENT_ALLOWED_TOOLS,
        tools: agentTools(session.dir, container, { user: req.get("x-jr-user") || "" }),
        constraints: { maxTokens: outputCap(model) },
      };
  let fullResponse = "";
  let errText = "";
  let pendingWrite = null;
  // Same transient-failure retry as the WS path (buffered, so no partial-reply concern): re-run on a fresh key until we get output or exhaust attempts.
  for (let attempt = 0; ; attempt++) {
    rotateKey(model);
    fullResponse = "";
    errText = "";
    try {
      for await (const msg of query(queryOptions)) {
        if (msg.type === "delta" && msg.deltaType !== "thinking") fullResponse += msg.content;
        else if (msg.type === "tool_use" && WRITE_TOOLS.has(msg.toolName)) pendingWrite = writtenPathFrom(msg.args);
        else if (msg.type === "tool_result" && WRITE_TOOLS.has(msg.toolName)) {
          if (pendingWrite) await syncToContainer(container, [{ path: pendingWrite, status: "edited" }]);
          pendingWrite = null;
        }
        else if (msg.type === "system" && msg.subtype === "error") errText = msg.content || errText;
        else if (msg.type === "assistant" && msg.stopReason === "error") errText = msg.errorMessage || errText;
      }
    } catch (err) {
      errText = err.message || String(err);
    }
    if (!fullResponse && errText && dropRejectedKey(model, errText)) { attempt--; continue; }
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

// Build doctor: diagnose container/terminal issues and propose a fix

// Pull a JSON object out of a model reply that may be fenced or wrapped in prose.

function buildDiagnosePrompt(stack, logs) {
  // Keep only the tail — the failure is almost always at the end, and the free tier has a tight token budget.
  const tail = String(logs || "").slice(-4000);
  return (
    `You are the build doctor for a ${stack || "web"} app running in a sandbox. ` +
    `Below are the most recent container/terminal logs. Decide whether there is a ` +
    `GENUINE blocking problem (the app failed to build, crashed, a port is wrong, a ` +
    `dependency is missing, a syntax/compile error) or just NOISE that needs no fix ` +
    `(npm deprecation warnings, "npm audit" vulnerability notices, a slow but ` +
    `successful install, informational logs).\n\n` +
    `Reply with ONLY a JSON object, no prose, in exactly this shape:\n` +
    `{"severity":"error|warning|ok","summary":"<=12 words","cause":"one sentence",` +
    `"fix":{"kind":"command|edit|none","command":"<shell to run in the app dir, if kind=command>",` +
    `"file":"<repo-relative path, if kind=edit>","instruction":"<plain-language edit to make, if kind=edit>"}}\n\n` +
    `Rules: if it is just noise or the app actually started, use severity "ok" or ` +
    `"warning" and fix.kind "none". Never propose "npm audit fix --force" or anything ` +
    `that rewrites lockfiles or deletes files. Prefer the smallest safe fix. Keep any ` +
    `command a single line.\n\n--- LOGS ---\n${tail}\n--- END LOGS ---`
  );
}

app.post("/agent/diagnose", async (req, res) => {
  const { container, logs } = req.body;
  if (!container) return res.status(400).json({ error: "container required" });
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  if (!firstAvailableProvider()) return res.status(400).json({ error: NO_KEY_MESSAGE });

  const model = modelFor(req.body.provider);
  // The build-doctor persona is the source of truth in .gitagent/skills/build-doctor.
  const doctorPersona = skillPersona(session.dir, "build-doctor");
  const { text, error } = await collectTurn({
    prompt: (doctorPersona ? doctorPersona + "\n\n" : "") + buildDiagnosePrompt(session.stack, logs),
    dir: session.dir,
    model,
    replaceBuiltinTools: true,
    allowedTools: [],
    constraints: { maxTokens: outputCap(model) },
  }, model);

  if (error && !text) return res.status(502).json({ error });

  const parsed = parseJsonLoose(text);
  if (!parsed) {
    // Model didn't return usable JSON — treat as "nothing actionable" rather than surfacing a scary error, but pass the raw note through for context.
    return res.json({ severity: "ok", summary: "No actionable issue detected", cause: "", fix: { kind: "none" }, raw: (text || "").slice(0, 400) });
  }
  const fix = parsed.fix && typeof parsed.fix === "object" ? parsed.fix : { kind: "none" };
  res.json({
    severity: ["error", "warning", "ok"].includes(parsed.severity) ? parsed.severity : "warning",
    summary: String(parsed.summary || "").slice(0, 200),
    cause: String(parsed.cause || "").slice(0, 400),
    fix: {
      kind: ["command", "edit", "none"].includes(fix.kind) ? fix.kind : "none",
      command: String(fix.command || "").slice(0, 300),
      file: String(fix.file || "").slice(0, 200),
      instruction: String(fix.instruction || "").slice(0, 400),
    },
  });
});

// GitAgent registry panel

// Browse the registry index (community agents).
app.get("/agent/registry", async (_req, res) => {
  const index = await fetchRegistryIndex();
  res.json({
    agents: index.map((a) => {
      const { slot, reason } = classifySlot(a);
      return {
        ref: `${a.author}/${a.name}`,
        name: a.name,
        author: a.author,
        category: a.category || "other",
        description: a.description || "",
        tags: a.tags || [],
        adapters: a.adapters || [],
        repository: a.repository || "",
        slot,
        slotReason: reason,
      };
    }),
  });
});

// The repo's own spec files, in the order the panel presents them.
const SPEC_FILES = [
  { key: "soul", path: ".gitagent/SOUL.md", label: "Identity",
    hint: "Who this agent is. Injected first, ahead of every edit." },
  { key: "rules", path: ".gitagent/RULES.md", label: "Rules",
    hint: "Must / Never rules. \"Never\" items are hard limits the agent may not cross." },
  // memory/MEMORY.md is the standard's full layout.
  { key: "memory", path: ".gitagent/memory/MEMORY.md", label: "Memory",
    hint: "Durable facts about this project the agent reads before changing anything." },
  { key: "compliance", path: ".gitagent/compliance/RULES.md", label: "Guardrails",
    hint: "Compliance rules layered onto the code-enforced guardrails. A deny always wins." },
  { key: "manifest", path: ".gitagent/agent.yaml", label: "Manifest",
    hint: "Model, tools, and runtime. Mirrored to the repo root, where the runtime reads it." },
];

// Point the Memory card at the file the agent will actually read.
function resolveMemoryPath(dir) {
  for (const rel of MEMORY_PATHS) {
    if (existsSync(join(dir, ".gitagent", ...rel.split("/")))) return `.gitagent/${rel}`;
  }
  return `.gitagent/${MEMORY_PATHS[0]}`; // neither exists — offer to create the standard one
}

// Compose the pipeline status for a workspace.
const DRIFT_TTL_MS = 10 * 60 * 1000;
const driftCache = new Map(); // ref -> { at, sha }

async function driftFor(pins, index) {
  const out = {};
  for (const [ref, pin] of Object.entries(pins)) {
    const hit = driftCache.get(ref);
    let upstream = hit && Date.now() - hit.at < DRIFT_TTL_MS ? hit.sha : null;
    if (upstream === null) {
      const entry = findAgent(index, ref);
      upstream = entry ? await remoteSha(entry.repository) : "";
      driftCache.set(ref, { at: Date.now(), sha: upstream });
    }
    if (upstream && upstream !== pin) out[ref] = upstream;
  }
  return out;
}

// that define its agent plus the skills that drive the pipeline.
async function gitagentStatus(dir) {
  const index = await fetchRegistryIndex();
  const manifest = readPipelineManifest(dir) || { developer: null, guardrails: [] };
  const installed = new Set(installedAgents(dir));
  const pins = manifest.pins || {};
  // Drift is a network call per pack, so it is cached and refreshed lazily rather than blocking every status poll.
  const drift = await driftFor(pins, index);
  const enrich = (ref, slot) => {
    const e = findAgent(index, ref) || {};
    const p = overlayPaths(ref, slot);
    return {
      ref, slot,
      pin: pins[ref] || "",
      // Unpinned means the rules can change with no diff and no review; drifted means they already have.
      unpinned: installed.has(ref) && !pins[ref],
      drifted: drift[ref] || "",
      category: e.category || "other",
      description: e.description || "",
      repository: e.repository || "",
      installed: installed.has(ref),
      // Where this agent lives inside the spec folder.
      specFiles: [p.spec, p.workflow].filter((rel) => existsSync(join(dir, ...rel.split("/")))),
    };
  };
  // The Knowledge slot always has an occupant: a pulled registry agent if one is assigned, otherwise the built-in knowledge-builder skill.
  const kRef = manifest.knowledge || null;
  const knowledge = kRef ? enrich(kRef, "knowledge") : {
    ref: KNOWLEDGE_SKILL,
    slot: "knowledge",
    builtin: true,
    category: "knowledge",
    description: "Reads the repo when the workspace opens and writes knowledge/overview.md",
    repository: "",
    installed: true,
    specFiles: [`.gitagent/skills/${KNOWLEDGE_SKILL}/SKILL.md`]
      .filter((rel) => existsSync(join(dir, ...rel.split("/")))),
  };

  return {
    enabled: !!(manifest.developer || (manifest.guardrails || []).length),
    developer: manifest.developer ? enrich(manifest.developer, "developer") : null,
    guardrails: (manifest.guardrails || []).map((r) => enrich(r, "guardrails")),
    knowledge,
    // What the Knowledge slot has actually produced, and whether it is running.
    knowledgeDoc: knowledgeStatus(dir),
    knowledgeState: knowledgeStateFor(dir),
    // The repo's own .gitagent/skills/ — the built-in personas plus any the user authored.
    skills: listSkillsDetailed(dir),
    builtinSkills: BUILTIN_SKILLS,
    // The identity/rules/memory files, with a presence flag so the panel can offer to create one that a hand-written repo never scaffolded.
    spec: SPEC_FILES.map((f) => {
      const path = f.key === "memory" ? resolveMemoryPath(dir) : f.path;
      return { ...f, path, exists: existsSync(join(dir, ...path.split("/"))) };
    }),
    // Community agents already cloned into this workspace, whether or not they currently hold a slot — so an installed agent can be inspected and reused.
    installedAgents: installedAgentsDetailed(dir),
  };
}

// Create a new skill in the repo's own .gitagent/skills/<slug>/SKILL.md so it shows in the folder and can drive the agent.
app.post("/agent/skill", (req, res) => {
  const { container, name, description, body, overwrite } = req.body || {};
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  const slug = String(name || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return res.status(400).json({ error: "a skill name is required" });
  try {
    const skillDir = join(session.dir, ".gitagent", "skills", slug);
    const file = join(skillDir, "SKILL.md");
    // Creating is the default; the panel's skill editor passes overwrite to save an existing one, so a typo'd new skill can't silently clobber a persona.
    if (existsSync(file) && !overwrite) {
      return res.status(409).json({ error: `skill "${slug}" already exists` });
    }
    mkdirSync(skillDir, { recursive: true });
    const content =
      `---\nname: ${slug}\ndescription: ${String(description || "").replace(/\n/g, " ").slice(0, 200) || "Custom skill"}\n---\n\n` +
      `# ${slug}\n\n${String(body || "").trim() || "Describe when this skill applies and how the agent should behave."}\n`;
    writeFileSync(file, content);
    res.json({
      status: overwrite ? "saved" : "created",
      slug,
      skills: listSkillsDetailed(session.dir),
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Delete a user-authored skill. Built-in personas are refused by deleteSkill — removing one would quietly change how the pipeline codes.
app.delete("/agent/skill", (req, res) => {
  const { container, slug } = req.body || {};
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  try {
    deleteSkill(session.dir, slug);
    res.json({ status: "deleted", slug, skills: listSkillsDetailed(session.dir) });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Spec files (identity, rules, memory, guardrails, manifest)

app.get("/agent/gitagent/file", (req, res) => {
  const session = sessions.get(req.query.container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  try {
    const file = readSpecFile(session.dir, req.query.path);
    if (!file) return res.status(400).json({ error: "path is not part of the agent spec" });
    res.json(file);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/agent/gitagent/file", (req, res) => {
  const { container, path: rel, content } = req.body || {};
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  try {
    const file = writeSpecFile(session.dir, rel, content);
    res.json({ status: "saved", ...file });
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

// Preview a registry agent before installing it: the index entry plus its spec files read straight from GitHub.
app.get("/agent/registry/agent", async (req, res) => {
  const ref = String(req.query.ref || "");
  try {
    const index = await fetchRegistryIndex();
    const entry = findAgent(index, ref);
    if (!entry) return res.status(404).json({ error: `no agent "${ref}"` });
    const detail = await fetchAgentDetail(entry);
    const { slot, reason } = classifySlot(entry);
    res.json({
      ref: `${entry.author}/${entry.name}`,
      slot,
      slotReason: reason,
      category: entry.category || "other",
      description: entry.description || "",
      repository: entry.repository || "",
      adapters: entry.adapters || [],
      tags: entry.tags || [],
      synthetic: !!entry._synthetic,
      files: detail.files,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Answering a denial

// Fix it: hand the refused content and the exact rule back to the Developer, then re-review the result.
app.post("/agent/guardrail/fix", async (req, res) => {
  const { container, path: rel, proposed, why, pack, provider } = req.body || {};
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  if (!rel || !proposed) return res.status(400).json({ error: "path and proposed content are required" });
  if (!firstAvailableProvider()) return res.status(400).json({ error: NO_KEY_MESSAGE });

  const model = modelFor(provider);
  const steps = [];
  const step = (n, d) => steps.push(`${n}: ${d}`);
  try {
    const prompt =
      `A guardrail refused this file. Rewrite it so it satisfies the rule.\n\n` +
      `RULE THAT REFUSED IT (${pack || "guardrail"}): ${why}\n\n` +
      `=== FILE: ${rel} ===\n${String(proposed).slice(0, 12000)}\n=== END FILE ===\n\n` +
      `Return the COMPLETE corrected file wrapped exactly as above. Change only what ` +
      `the rule requires — keep every other line as it is. No prose, no fences.`;

    step("Developer", `rewriting ${rel} to satisfy ${pack || "the guardrail"}`);
    const { text, error } = await collectTurn({
      prompt, dir: session.dir, model,
      replaceBuiltinTools: true, allowedTools: [],
      constraints: { maxTokens: outputCap(model) },
    }, model);
    if (error && !text) return res.status(502).json({ error, steps });

    const blocks = parseEditBlocks(text).filter((b) => b.path === rel);
    if (!blocks.length) return res.json({ ok: false, reason: "no-blocks", steps });

    // The rewrite gets the same scrutiny as the original — a fix that is itself a violation must not slip through just because it came from a retry.
    const agents = await resolvePipelineAgents(session.dir, step).catch(() => ({ guardrails: [] }));
    const floor = guardEditBlocks(blocks);
    if (floor.blocked.length) {
      return res.json({ ok: false, reason: "still-denied", denial: floor.blocked[0].why, steps });
    }
    const reviewed = await reviewEditBlocks(session.dir, agents, `Fixing: ${why}`, floor.allowed, model, step);
    if (reviewed.blocked.length) {
      return res.json({ ok: false, reason: "still-denied", denial: reviewed.blocked[0].why, steps });
    }

    const results = applyEditBlocks(session.dir, reviewed.allowed, blocks);
    await syncToContainer(container, results);
    step("Guardrails", "approved · applied");
    res.json({ ok: true, results, steps });
  } catch (e) {
    res.status(500).json({ error: e.message, steps });
  }
});

// Override: apply the refused content anyway, with a reason on the record.
app.post("/agent/guardrail/override", async (req, res) => {
  const { container, path: rel, proposed, reason, pack, why } = req.body || {};
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  if (!rel || proposed == null) return res.status(400).json({ error: "path and proposed content are required" });
  const note = String(reason || "").trim();
  // An unexplained override is indistinguishable from no guardrail at all.
  if (note.length < 8) return res.status(400).json({ error: "a reason is required (at least 8 characters)" });

  try {
    const results = applyEditBlocks(session.dir, [{ path: rel, content: String(proposed) }], []);
    const applied = results.find((r) => r.status === "edited" || r.status === "created");
    if (!applied) return res.status(400).json({ error: results[0] ? results[0].status : "could not write the file" });
    await syncToContainer(container, results);

    writeAudit(session.dir, [{
      at: new Date().toISOString(),
      file: rel,
      decision: "override",
      pack: pack || "",
      denied_for: why || "",
      reason: note,
    }]);
    res.json({ ok: true, results, audit: `${AUDIT_DIR}/${new Date().toISOString().slice(0, 10)}.jsonl` });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Pin a pack at the commit it is currently running, so its rules stop being "whatever upstream is today" and start being a reviewable version.
app.post("/agent/gitagent/pin", async (req, res) => {
  const { container, ref } = req.body || {};
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  try {
    const entry = findAgent(await fetchRegistryIndex(), ref);
    if (!entry) return res.status(404).json({ error: `no agent "${ref}"` });
    const { sha } = await installAgent(session.dir, entry);
    if (!sha) return res.status(400).json({ error: "could not read the installed commit" });

    const cur = readPipelineManifest(session.dir);
    const slot = cur && cur.knowledge === ref ? "knowledge"
      : cur && cur.developer === ref ? "developer"
      : "guardrails";
    assignSlot(session.dir, ref, slot, sha);
    res.json({ ok: true, pin: sha, status: await gitagentStatus(session.dir) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// What WOULD this pack have done to your last N commits?
app.post("/agent/registry/preview", async (req, res) => {
  const { container, ref, commits } = req.body || {};
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  const n = Math.min(Math.max(Number(commits) || 10, 1), 50);

  try {
    const entry = findAgent(await fetchRegistryIndex(), ref);
    if (!entry) return res.status(404).json({ error: `no agent "${ref}"` });

    const { path: at, sha } = await installAgent(session.dir, entry);
    const persona = loadAgentPersona(at, entry);
    const rules = (persona.rules || persona.soul || "").trim();
    if (!rules) {
      return res.json({ ref, ok: true, unusable: "this agent ships no RULES.md or SOUL.md to enforce" });
    }

    const steps = [];
    const out = await reviewRange({
      dir: session.dir,
      base: `HEAD~${n}`,
      head: "HEAD",
      message: `Would ${ref} have allowed these changes?`,
      packs: [{ name: `${entry.author}/${entry.name}`, rules, sha, pin: sha }],
      audit: false,
      onStep: (name, detail) => steps.push(`${name}: ${detail}`),
    });
    res.json({ ref: `${entry.author}/${entry.name}`, commits: n, sha, steps, ...out });
  } catch (e) {
    // A shallow clone has no HEAD~10; say so rather than reporting a clean pass.
    const msg = /could not diff/.test(e.message)
      ? `this workspace has fewer than ${n} commits to replay`
      : e.message;
    res.status(400).json({ error: msg });
  }
});

// Pull an agent from the registry: clone it AND put it to work.
app.post("/agent/gitagent/install", async (req, res) => {
  const { container, ref, slot: wanted } = req.body || {};
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  try {
    const index = await fetchRegistryIndex();
    const entry = findAgent(index, ref);
    if (!entry) return res.status(404).json({ error: `no agent "${ref}"` });
    const { sha } = await installAgent(session.dir, entry);

    const auto = classifySlot(entry);
    const slot = wanted === "developer" || wanted === "guardrails" || wanted === "knowledge" ? wanted
      : wanted === "none" ? null
      : auto.slot;
    const reason = slot === auto.slot ? auto.reason : "you chose this slot";
    // The canonical ref, which may differ in case/spacing from what was typed.
    const pulled = `${entry.author}/${entry.name}`;
    // Pin at pull time. Without this the pack is "whatever upstream is today" and the rules can change with no diff and no review.
    if (slot) assignSlot(session.dir, pulled, slot, sha);

    // Resolving the pipeline is what writes the agent INTO .gitagent/.
    const files = [];
    if (slot) {
      try {
        await resolvePipelineAgents(session.dir, (_n, d) => {
          const m = /^spec (updated|pruned) · (.+)$/.exec(d);
          if (m) files.push(...m[2].split(", ").map((p) => ({ path: p, action: m[1] })));
        });
      } catch (e) {
        console.error("[gitagent] spec sync after pull failed:", e.message);
      }
    }

    res.json({
      status: await gitagentStatus(session.dir),
      ref: pulled,
      slot,
      slotReason: reason,
      auto: !wanted,
      // The files the pull created or removed, so the panel can say what changed in the folder instead of leaving the user to go find it.
      files,
    });
  } catch (e) {
    res.status(500).json({ error: `clone failed: ${e.message}` });
  }
});

// Read the current pipeline assignment for a workspace.
app.get("/agent/gitagent", async (req, res) => {
  const session = sessions.get(req.query.container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  try {
    res.json(await gitagentStatus(session.dir));
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Assign agents to slots: writes .gitagent/pipeline.json, installs (live clone) the referenced agents, and returns the new status plus install steps.
app.post("/agent/gitagent", async (req, res) => {
  const { container, developer, guardrails } = req.body;
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  try {
    writePipelineManifest(session.dir, {
      developer: developer || null,
      guardrails: Array.isArray(guardrails) ? guardrails : [],
    });
    const steps = [];
    await resolvePipelineAgents(session.dir, (name, detail) => steps.push(`${name}: ${detail}`));
    res.json({ status: await gitagentStatus(session.dir), steps });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Clones a pack for OpenGAP add-agent/add-guard with prompts and the host's credential helpers switched off.
function gitClone(url, dest) {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("git", ["clone", "--depth", "1", "--", url, dest], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "credential.helper", GIT_CONFIG_VALUE_0: "" },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let err = "";
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => child.kill(), 60000);
    child.on("close", (code) => { clearTimeout(timer); code === 0 ? resolveP() : rejectP(new Error(`git clone failed: ${err.trim().split("\n").pop() || code}`)); });
  });
}

const ogRunner = opengap.createRunner({
  gatherEditFiles, runEditPipeline, collectTurn, parseJsonLoose, parseEditBlocks, providerHasKey,
  outputBudget: (model, prompt) => editOutputBudget(model, prompt),
});

// The coding entry point: an installed OpenGAP team routes the task; otherwise the built-in pipeline edits directly.
async function runCodingTask(dir, message, model, onStep, container, opts = {}) {
  if (opengap.installed(dir)) {
    return ogRunner.runTask(dir, message, { model, container, onStep, onEvent: opts.onEvent, files: opts.files });
  }
  return runEditPipeline(dir, message, model, onStep, container, opts);
}

function ogSession(req, res) {
  const container = (req.body && req.body.container) || req.query.container;
  const session = sessions.get(container);
  if (!session) { res.status(404).json({ error: "sandbox not registered" }); return null; }
  return session;
}

const ogRoute = (fn) => async (req, res) => {
  const session = ogSession(req, res);
  if (!session) return;
  try {
    const out = await fn(session, req);
    res.json(out === undefined ? opengap.status(session.dir) : out);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
};

app.get("/agent/opengap", ogRoute((s) => opengap.status(s.dir)));
app.post("/agent/opengap/init", ogRoute((s) => { const wrote = opengap.init(s.dir); return { ...opengap.status(s.dir), wrote }; }));
app.post("/agent/opengap/agent", ogRoute((s, req) => { opengap.saveAgent(s.dir, req.body.agent || {}); }));
app.post("/agent/opengap/agent/delete", ogRoute((s, req) => { opengap.deleteAgent(s.dir, String(req.body.name || "")); }));
app.get("/agent/opengap/file", ogRoute((s, req) => ({ path: req.query.path, content: opengap.readFile(s.dir, String(req.query.path || "")) })));
app.post("/agent/opengap/file", ogRoute((s, req) => { opengap.saveFile(s.dir, String(req.body.path || ""), String(req.body.content ?? "")); }));
app.post("/agent/opengap/routing", ogRoute((s, req) => { opengap.setRouting(s.dir, String(req.body.key || ""), req.body.value); }));
app.post("/agent/opengap/guard", ogRoute((s, req) => { opengap.addGuard(s.dir, req.body.guard || {}); }));
app.post("/agent/opengap/guard/toggle", ogRoute((s, req) => { opengap.toggleGuard(s.dir, String(req.body.name || ""), req.body.enabled !== false); }));
app.post("/agent/opengap/add", ogRoute(async (s, req) => {
  let url = req.body.url;
  // A registry reference ("author/agent") resolves to its repository, so registry agents can join the team too.
  if (!url && req.body.ref) {
    const entry = findAgent(await fetchRegistryIndex(), String(req.body.ref));
    if (!entry || !entry.repository) throw new Error("that agent is not in the registry");
    url = entry.repository;
  }
  const installedNames = await opengap.addFromGit(s.dir, { url, as: req.body.as, kind: req.body.kind === "guard" ? "guard" : "agent" }, gitClone);
  return { ...opengap.status(s.dir), installedNames };
}));
app.get("/agent/opengap/runs", ogRoute((s) => ({ runs: opengap.listRuns(s.dir) })));
app.post("/agent/opengap/smoke", ogRoute(async (s, req) => {
  const r = allowLLM(req.get("x-jr-user"));
  if (!r.ok) throw new Error(llmLimitMessage(r.minutes));
  return { steps: await ogRunner.smoke(s.dir, String(req.body.name || ""), modelFor(req.body.provider)) };
}));

const planner = createPlanner({
  collectTurn, parseJsonLoose, gatherEditFiles, hostExec, readFileCapped,
  checkCommand: (dir, command) => (opengap.installed(dir) ? opengap.checkCommandLine(dir, command) : null),
  // Plan steps go through the OpenGAP team when one is installed, so its routing and guardrails apply to them too.
  runEditPipeline: (dir, message, model, onStep, container, opts) => runCodingTask(dir, message, model, onStep, container, { ...opts, onEvent: opts && opts.onEvent }),
  outputBudget: (model, prompt) => editOutputBudget(model, prompt),
});

// WebSocket: one connection per sandbox session.
wss.on("connection", (ws, req) => {
  let boundContainer = null;
  const user = req.headers["x-jr-user"];
  const sessionFor = (c) => {
    const s = sessions.get(c);
    return s && mayUse(user, s) ? s : undefined;
  };

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
      const session = sessionFor(container);
      if (session) boundContainer = container;
      if (!session) {
        ws.send(JSON.stringify({ type: "error", content: "sandbox not registered" }));
        return;
      }
      session.clients.add(ws);
      ws.send(JSON.stringify({ type: "ready", content: `bound to ${container}` }));
      return;
    }

    if (type === "stop") {
      planner.stop(ws);
      return;
    }
    if (type === "command_decision") {
      planner.decide(ws, payload);
      return;
    }
    if (type === "plan_review" || type === "plan_proceed") {
      const quota = allowLLM(user);
      if (!quota.ok) {
        ws.send(JSON.stringify({ type: "error", content: llmLimitMessage(quota.minutes) }));
        ws.send(JSON.stringify({ type: "complete", content: "" }));
        return;
      }
      const entry = planner._plans.get(payload.id);
      if (!entry || !sessionFor(entry.container)) {
        ws.send(JSON.stringify({ type: "error", content: "That plan is not available any more; ask again." }));
        ws.send(JSON.stringify({ type: "complete", content: "" }));
        return;
      }
      if (type === "plan_review") await planner.revise(ws, { id: payload.id, comments: (payload.comments || []).slice(0, 30), policy: payload.policy });
      else await planner.proceed(ws, { id: payload.id, policy: payload.policy });
      return;
    }

    if (type === "chat") {
      const quota = allowLLM(user);
      if (!quota.ok) {
        ws.send(JSON.stringify({ type: "error", content: llmLimitMessage(quota.minutes) }));
        return;
      }
      const targetContainer = container || boundContainer;
      const session = sessionFor(targetContainer);

      if (!session) {
        ws.send(JSON.stringify({ type: "error", content: "sandbox not registered" }));
        return;
      }

      if (!agentSpecPresent(session.dir)) {
        ws.send(JSON.stringify({ type: "error", content: "agent.yaml missing — generate spec first" }));
        return;
      }

      if (!firstAvailableProvider()) {
        ws.send(JSON.stringify({ type: "error", content: NO_KEY_MESSAGE }));
        ws.send(JSON.stringify({ type: "complete", content: "" }));
        return;
      }

      const model = modelFor(provider);
      // Planning and Fast are the Antigravity modes; a plain question in either is still just answered.
      let mode;
      if (payload.mode === "plan" || payload.mode === "fast") {
        const route = await decideMode("auto", message, session.dir, model);
        mode = route === "ask" ? "ask" : payload.mode === "plan" ? "plan" : "edit";
      } else {
        mode = await decideMode(payload.mode, message, session.dir, model);
      }
      console.log(`[agent] chat container=${targetContainer} model=${model} mode=${mode}`);
      ws.send(JSON.stringify({ type: "thinking", content: "" }));

      if (mode === "plan") {
        await planner.startPlan(ws, { message, dir: session.dir, model, container: targetContainer, policy: payload.policy });
      } else if (mode === "ask") {
        // Toolless retrieve-then-generate: reliable on weak-tool-calling models.
        const askPrompt = await buildAskPrompt(session.dir, message);
        await streamTurn(ws, {
          prompt: askPrompt,
          dir: session.dir,
          model,
          replaceBuiltinTools: true, // no built-in tools…
          allowedTools: [],          // …and nothing survives the filter → toolless
          constraints: { maxTokens: outputCap(model) },
        }, model, targetContainer);
      } else if (mode === "edit") {
        // Toolless generate-then-apply: the model outputs edits, the backend writes them — so the model never has to call a tool.
        await runEditModeWS(ws, session.dir, message, model, targetContainer);
      } else {
        // Legacy agentic path: the model drives shell/read/write/search_code itself (only reliable with a strong tool-calling model).
        let agents = { enabled: false };
        try {
          agents = await resolvePipelineAgents(session.dir, (n, d) =>
            ws.send(JSON.stringify({ type: "tool", content: `${n}(${d})` })));
        } catch { /* built-ins */ }
        const preamble = personaPreamble(agents);
        await streamTurn(ws, {
          prompt: preamble ? `${preamble}--- USER REQUEST ---\n${message}` : message,
          dir: session.dir,
          model,
          replaceBuiltinTools: true,
          allowedTools: AGENT_ALLOWED_TOOLS,
          tools: agentTools(session.dir, targetContainer, { user, ask: (command, why) => planner.requestApproval(ws, command, why) }),
          constraints: { maxTokens: outputCap(model) },
        }, model, targetContainer);
      }
    }
  });

  ws.on("close", () => {
    planner.stop(ws);
    if (boundContainer) {
      const session = sessions.get(boundContainer);
      if (session) session.clients.delete(ws);
    }
  });
});

// For tests; server lets them drive the routes over real HTTP.
export {
  makeShellTool, makeReadTool, makeWriteTool, writtenPathFrom, heuristicMode, extractSearchTerms,
  parseEditBlocks, applyEditBlocks, applyHunks, gatherEditFiles, classifyEditComplexity, buildEditPrompt, editOutputBudget, roomAfter413, runEditPipeline, planner, server,
};

// Skip binding a port when imported for tests (AGENT_NO_LISTEN=1).
if (!process.env.AGENT_NO_LISTEN) {
  const PORT = process.env.AGENT_PORT || 8001;
  // Bind loopback explicitly.
  const HOST = process.env.AGENT_HOST || "127.0.0.1";
  pruneGroqKeys().catch((e) => console.error("[agent] could not check the Groq keys:", e.message));
  // With MONGODB_URI set, the hub must reach the database before it serves anything, or saves would land in the wrong store.
  try {
    if (await connectDb()) {
      const counts = await importHubFiles();
      if (counts) console.log(`[agent-service] imported ${counts.agents} agents, ${counts.workflows} workflows and ${counts.runs} runs into MongoDB`);
      console.log("[agent-service] using MongoDB");
    }
  } catch (e) {
    console.error("[agent-service] database error:", e.message);
    process.exit(1);
  }
  server.listen(PORT, HOST, () => {
    console.log(`[agent-service] running on ${HOST}:${PORT}`);
  });
}