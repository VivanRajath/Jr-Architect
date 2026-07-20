import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { query } from "gitclaw";
import { getModels } from "@mariozechner/pi-ai";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "fs";
import { join, extname, resolve, sep } from "path";

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
  const searchBlock = snippets.length
    ? `Relevant code found by searching the repository${terms.length ? ` for: ${terms.join(", ")}` : ""}:\n\n<search_results>\n${snippets.join("\n")}\n</search_results>\n\n`
    : "";

  // For overview/summary questions, inject the actual UI entry file so the model
  // can describe real code instead of guessing from the map alone.
  let entryBlock = "";
  if (/\b(summar|overview|understand|explain|architecture|structure|how does|what is this|walk me through)\b/i.test(message)) {
    const entry = firstExistingFile(dir, EDIT_ENTRY_CANDIDATES);
    if (entry) {
      const body = readFileCapped(join(dir, entry), 3500);
      if (body) entryBlock = `Contents of the main UI entry \`${entry}\`:\n\n<file path="${entry}">\n${body}\n</file>\n\n`;
    }
  }

  return (
    `${searchBlock}${entryBlock}You are answering a question about THIS repository. Use the repository map already in your context, the file contents, and the search results above. ` +
    `Be concrete: cite \`file:line\` for specifics. If a file you need isn't shown, name it and say what you'd look for. Do not invent files or code.\n\n` +
    `Question: ${message}`
  );
}

// Decide the turn's mode. An explicit client mode wins; otherwise auto-detect:
// clear file-modification intent → "edit", else "ask". "agent" forces the legacy
// tool-driven path (only useful with a strong tool-calling model).
//   "ask"   — toolless Q&A (retrieve-then-generate)
//   "edit"  — toolless code change (generate SEARCH/REPLACE, backend applies)
//   "agent" — legacy agentic loop (model calls tools itself)
function resolveTurnMode(explicit, message) {
  if (explicit === "ask" || explicit === "edit" || explicit === "agent") return explicit;
  if (EDIT_INTENT.test(message)) {
    return process.env.AGENT_EDIT_STRATEGY === "agentic" ? "agent" : "edit";
  }
  return "ask";
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

// ── Edit mode: generate-then-apply (toolless code changes) ───────────────────
// Editing needs a write, but llama-3.3 can't reliably CALL a write tool. So the
// model never calls a tool: the backend reads the relevant files, asks the model
// to reply with SEARCH/REPLACE blocks (plain text it's good at), then parses and
// applies them itself. Mirror of Ask mode, for changes instead of questions.

const EDIT_ENTRY_CANDIDATES = [
  "app/page.tsx", "app/page.jsx", "app/page.js", "src/app/page.tsx",
  "pages/index.tsx", "pages/index.jsx", "src/pages/index.tsx",
  "src/App.tsx", "src/App.jsx", "src/App.js", "src/main.tsx", "src/main.jsx",
  "src/index.tsx", "index.html", "public/index.html",
];
// Files most likely targeted by look-and-feel changes.
const EDIT_STYLE_CANDIDATES = [
  "app/globals.css", "src/app/globals.css", "styles/globals.css", "src/globals.css",
  "src/index.css", "src/App.css", "app/layout.tsx", "src/app/layout.tsx",
  "tailwind.config.ts", "tailwind.config.js",
];
const EDIT_STYLE_INTENT = /\b(theme|dark|light|colou?r|style|styling|css|font|background|ui|layout|design|spacing|padding|margin)\b/i;
const EDIT_MAX_FILES = 4;
const EDIT_MAX_FILE_CHARS = 5000;

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

// Choose which files to hand the model for an edit: files matching the request's
// search terms, plus the UI entry, plus style files for look-and-feel requests.
async function gatherEditFiles(dir, message) {
  const chosen = [];
  const add = (p) => {
    if (p && !chosen.includes(p) && existsSync(join(dir, p)) && chosen.length < EDIT_MAX_FILES) chosen.push(p);
  };

  // 1. Files that mention the request's key terms.
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
  // 2. The UI entry point (common target for "change the UI").
  add(firstExistingFile(dir, EDIT_ENTRY_CANDIDATES));
  // 3. Style files for look-and-feel requests.
  if (EDIT_STYLE_INTENT.test(message)) {
    for (const c of EDIT_STYLE_CANDIDATES) add(c);
  }

  return chosen.map((p) => ({ path: p, content: readFileCapped(join(dir, p), EDIT_MAX_FILE_CHARS) }));
}

// The generate-then-apply prompt. Strict format so parsing is reliable.
function buildEditPrompt(files, message) {
  const fileBlocks = files
    .map((f) => `<file path="${f.path}">\n${f.content}\n</file>`)
    .join("\n\n");
  return (
    `You are editing THIS repository. Current contents of the relevant files:\n\n${fileBlocks}\n\n` +
    `Apply the requested change by replying with ONE OR MORE edit blocks in EXACTLY this format and NOTHING else:\n\n` +
    `<file>relative/path</file>\n<<<<<<< SEARCH\n{lines copied verbatim from the file above}\n=======\n{replacement lines}\n>>>>>>> REPLACE\n\n` +
    `Rules:\n` +
    `- SEARCH must match the file contents EXACTLY, including indentation.\n` +
    `- Keep each block minimal — only the lines that change, with a little surrounding context if needed to be unique.\n` +
    `- You may output multiple blocks across multiple files.\n` +
    `- To create a NEW file, use an empty SEARCH section.\n` +
    `- Output ONLY edit blocks. No prose, no explanation, no code fences.\n\n` +
    `Change requested: ${message}`
  );
}

// Parse Aider-style SEARCH/REPLACE blocks out of the model's reply.
function parseEditBlocks(text) {
  const blocks = [];
  const re = /<file>\s*(.+?)\s*<\/file>\s*<{3,}\s*SEARCH\s*\r?\n([\s\S]*?)\r?\n?={3,}\s*\r?\n([\s\S]*?)\r?\n?>{3,}\s*REPLACE/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    blocks.push({ path: m[1].trim(), search: m[2], replace: m[3] });
  }
  return blocks;
}

// Apply parsed blocks to disk. Path-safe (stays inside dir). Exact match first,
// then a whitespace-tolerant fallback. Returns per-block status for the summary.
function applyEditBlocks(dir, blocks) {
  const root = resolve(dir);
  const results = [];
  for (const b of blocks) {
    const abs = resolve(dir, b.path);
    if (abs !== root && !abs.startsWith(root + sep)) {
      results.push({ path: b.path, status: "rejected (outside workspace)" });
      continue;
    }
    // New file: empty SEARCH.
    if (b.search.trim() === "") {
      try {
        writeFileSync(abs, b.replace);
        results.push({ path: b.path, status: "created" });
      } catch (e) {
        results.push({ path: b.path, status: "error: " + e.message });
      }
      continue;
    }
    let content;
    try {
      content = readFileSync(abs, "utf8");
    } catch {
      results.push({ path: b.path, status: "file not found" });
      continue;
    }
    if (content.includes(b.search)) {
      writeFileSync(abs, content.replace(b.search, b.replace));
      results.push({ path: b.path, status: "edited" });
      continue;
    }
    // Whitespace-tolerant fallback: match ignoring leading/trailing space per line.
    const norm = (s) => s.split(/\r?\n/).map((l) => l.trim()).join("\n");
    const idx = norm(content).indexOf(norm(b.search));
    if (idx >= 0 && norm(b.search).length > 0) {
      // Rebuild by locating the first line of SEARCH in the raw content.
      const firstLine = b.search.split(/\r?\n/).find((l) => l.trim());
      const pos = firstLine ? content.indexOf(firstLine.trim()) : -1;
      if (pos >= 0) {
        const lineStart = content.lastIndexOf("\n", pos) + 1;
        const searchLineCount = b.search.split(/\r?\n/).length;
        const after = content.slice(lineStart).split(/\r?\n/);
        const tail = after.slice(searchLineCount).join("\n");
        writeFileSync(abs, content.slice(0, lineStart) + b.replace + (tail ? "\n" + tail : ""));
        results.push({ path: b.path, status: "edited (fuzzy)" });
        continue;
      }
    }
    results.push({ path: b.path, status: "SEARCH text not found — skipped" });
  }
  return results;
}

// Buffered (non-streaming) turn: collect the full reply text, with the same
// transient-failure retry on a fresh key. Used by Edit mode.
async function collectTurn(queryOptions, model) {
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

// Run one Edit-mode turn over a WebSocket: gather files → ask for SEARCH/REPLACE
// → apply → report. The model never calls a tool, so it can't garble a call.
async function runEditModeWS(ws, dir, message, model) {
  const files = await gatherEditFiles(dir, message);
  if (files.length === 0) {
    ws.send(JSON.stringify({ type: "delta", content: "I couldn't find the files to change for that request. Try naming a file or feature, e.g. \"make the header in app/page.tsx dark\"." }));
    ws.send(JSON.stringify({ type: "complete", content: "" }));
    return;
  }
  const { text, error } = await collectTurn({
    prompt: buildEditPrompt(files, message),
    dir,
    model,
    replaceBuiltinTools: true,
    allowedTools: [],
    constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
  }, model);

  if (error && !text) {
    ws.send(JSON.stringify({ type: "error", content: error }));
    ws.send(JSON.stringify({ type: "complete", content: "" }));
    return;
  }

  const blocks = parseEditBlocks(text);
  if (blocks.length === 0) {
    // Model didn't follow the format — surface its text so the turn isn't silent.
    ws.send(JSON.stringify({ type: "delta", content: text || "No changes were produced." }));
    ws.send(JSON.stringify({ type: "complete", content: "" }));
    return;
  }

  const results = applyEditBlocks(dir, blocks);
  const changed = results.filter((r) => r.status === "edited" || r.status === "edited (fuzzy)" || r.status === "created");
  if (changed.length > 0) ws.send(JSON.stringify({ type: "file_changed", content: "" }));

  const summary =
    `Applied ${changed.length} change(s):\n` +
    results.map((r) => `- \`${r.path}\` — ${r.status}`).join("\n") +
    (changed.length ? "\n\nThe preview will reload with your changes." : "\n\nNo edits matched — the model's SEARCH text didn't line up with the file. Try rephrasing or naming the exact file.");
  ws.send(JSON.stringify({ type: "delta", content: summary }));
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

  // Edit mode: generate-then-apply, return a summary of what changed.
  if (mode === "edit") {
    const files = await gatherEditFiles(session.dir, message);
    if (files.length === 0) {
      return res.json({ response: "I couldn't find the files to change for that request. Name a file or feature and try again." });
    }
    const { text, error } = await collectTurn({
      prompt: buildEditPrompt(files, message),
      dir: session.dir,
      model,
      replaceBuiltinTools: true,
      allowedTools: [],
      constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
    }, model);
    if (error && !text) return res.status(502).json({ error });
    const blocks = parseEditBlocks(text);
    if (blocks.length === 0) return res.json({ response: text || "No changes were produced." });
    const results = applyEditBlocks(session.dir, blocks);
    const changed = results.filter((r) => r.status.startsWith("edited") || r.status === "created");
    return res.json({
      response: `Applied ${changed.length} change(s):\n` + results.map((r) => `- ${r.path} — ${r.status}`).join("\n"),
      file_changed: changed.length > 0,
    });
  }

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
      } else if (mode === "edit") {
        // Toolless generate-then-apply: the model outputs edits, the backend
        // writes them — so llama-3.3 never has to call a tool.
        await runEditModeWS(ws, session.dir, message, model);
      } else {
        // Legacy agentic path: the model drives cli/read/write/search_code itself
        // (only reliable with a strong tool-calling model).
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

export {
  makeSearchCodeTool, resolveTurnMode, extractSearchTerms, buildAskPrompt,
  parseEditBlocks, applyEditBlocks, gatherEditFiles, buildEditPrompt,
};

// Skip binding a port when imported for tests (AGENT_NO_LISTEN=1).
if (!process.env.AGENT_NO_LISTEN) {
  const PORT = process.env.AGENT_PORT || 8001;
  server.listen(PORT, () => {
    console.log(`[agent-service] running on port ${PORT}`);
  });
}