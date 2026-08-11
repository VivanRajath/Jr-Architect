import express from "express";
import { WebSocketServer } from "ws";
import { createServer } from "http";
import { query } from "gitclaw";
import { getModels } from "@mariozechner/pi-ai";
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync } from "fs";
import { join, extname, resolve, sep, dirname } from "path";
import { fileURLToPath } from "url";
import { spawn } from "child_process";
import {
  resolvePipelineAgents, personaPreamble, fetchRegistryIndex, findAgent,
  readPipelineManifest, writePipelineManifest, installedAgents,
  loadSkill, loadComplianceRules, listSkills,
  readSpecFile, writeSpecFile, listSkillsDetailed, deleteSkill,
  installedAgentsDetailed, installAgent, fetchAgentDetail, BUILTIN_SKILLS,
  MEMORY_PATHS, classifySlot, assignSlot, overlayPaths,
  KNOWLEDGE_SKILL, SLOT_LABEL,
} from "./registry.js";
import { knowledgeStatus, OVERVIEW_REL } from "./knowledge.js";
// The engine now lives in its own modules so it can run with no HTTP at all —
// see review.js, which drives the identical guardrails over a pull request.
import {
  PROVIDER_MODELS, providerHasKey, NO_KEY_MESSAGE, KNOWLEDGE_KEY,
  rotateGroqKey, collectTurn, stripFences, parseJsonLoose,
  AGENT_MAX_OUTPUT_TOKENS, AGENT_TOOLCALL_RETRIES, RETRIABLE_TURN_ERROR,
  firstAvailableProvider, modelFor,
} from "./llm.js";
import {
  guardEditBlocks, buildGuardrailPrompt, applyGuardrailVerdicts, reviewEditBlocks,
} from "./guardrails.js";

// ESM has no __dirname; the knowledge worker is spawned by absolute path so the
// service works regardless of the cwd Go happens to start it from.
const __dirname = dirname(fileURLToPath(import.meta.url));

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
const EDIT_INTENT = /\b(add|create|write|edit|change|modif(?:y|ies|ied)|fix|update|refactor|implement|rename|rebrand|relabel|retitle|reword|delete|remove|replace|insert|append|scaffold|install|integrate|rewrite|convert|migrate|set up|setup|wire up)\b/i;

// Imperative "make it look…" verbs. On their own these are ambiguous ("make a
// summary" is a question), so they only count as an edit when paired with a
// style/UI target — e.g. "make the ui dark red", "turn the theme purple".
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

  // For overview/summary questions, feed the model REAL substance so it can
  // synthesize instead of hedging.
  //
  // knowledge/overview.md is the good answer when it exists: the Knowledge agent
  // already read ~24k characters of this repo on its own key and wrote the
  // synthesis. Leading with it is both BETTER and CHEAPER than the old fallback —
  // four raw files at 3k each spent the whole budget on material the model then
  // had to summarise under pressure, which is exactly why summaries were thin.
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
    // With the synthesis in hand only the entry file adds anything; without it,
    // fall back to the old raw-file spread so an un-built workspace still answers.
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

  // The Ask persona is the source of truth in .gitagent/skills/ask (built-in
  // fallback if absent).
  const askPersona = skillPersona(dir, "ask");
  return (
    (askPersona ? askPersona + "\n\n" : "") +
    `${searchBlock}${contextBlock}You are answering a question about THIS repository, using the repository map, ` +
    `the file contents, and the search results above. ${instruction}\n\n` +
    `Question: ${message}`
  );
}

// Decide the turn's mode. An explicit client mode wins; otherwise auto-detect:
// clear file-modification intent → "edit", else "ask". "agent" forces the legacy
// tool-driven path (only useful with a strong tool-calling model).
//   "ask"   — toolless Q&A (retrieve-then-generate)
//   "edit"  — toolless code change (generate SEARCH/REPLACE, backend applies)
//   "agent" — legacy agentic loop (model calls tools itself)
// Confident question openers — clearly read-only, so no LLM router call needed.
const ASK_OPENER = /^\s*(what|why|how|where|which|who|when|whose|is|are|was|were|does|do|did|should|would|explain|summar(?:y|ise|ize|ising|izing)|describe|overview|list|walk me|tell me|show me|give me (?:a|an) (?:summary|overview|explanation))\b/i;

// Fast heuristic router. Returns "edit" | "ask" | null, where null means "not
// obvious — ask the model" (handled by decideMode). Kept as a pure function so
// it's unit-testable and free (no LLM call) for the common, unambiguous cases.
function heuristicMode(message) {
  const m = (message || "").trim();
  if (!m) return "ask";
  // Obvious change: an edit verb, or an imperative styling command that names a
  // style/UI target ("make the ui dark red") — but not a bare "make a summary".
  if (EDIT_INTENT.test(m) || (EDIT_IMPERATIVE.test(m) && EDIT_STYLE_INTENT.test(m))) return "edit";
  // Obvious question.
  if (ASK_OPENER.test(m)) return "ask";
  return null;
}

// Sync router used by tests and as the confident fast-path. Ambiguous messages
// default to the safe read-only Ask mode here; decideMode() upgrades them with
// the LLM Orchestrator at request time.
function resolveTurnMode(explicit, message) {
  if (explicit === "ask" || explicit === "edit" || explicit === "agent") return explicit;
  const mode = heuristicMode(message) || "ask";
  if (mode === "edit" && process.env.AGENT_EDIT_STRATEGY === "agentic") return "agent";
  return mode;
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
// Editing needs a write, but llama-3.3 can't reliably CALL a write tool — and it
// also can't reliably quote exact lines + emit conflict markers (SEARCH/REPLACE
// garbles into unparseable junk). So the model never calls a tool AND never
// patches: the backend picks the right small file(s), the model returns each
// changed file's COMPLETE new contents in one clean block, and the backend
// overwrites. Whole-file rewrite is what a weak model does most reliably, and the
// closing delimiter doubles as a truncation guard (a cut-off reply won't parse).

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
// Library/generated boilerplate is never a good edit target even when a keyword
// search matches it — e.g. shadcn's components/ui/*.tsx contain words like
// "theme"/"color" but aren't where YOUR page's look is controlled.
const EDIT_SKIP_PATH = /(?:^|\/)(?:components\/ui|node_modules|\.next|dist|build|out|coverage|vendor|\.git)\//i;
const EDIT_MAX_FILES = 5;      // how many files to *show* the model as context
const EDIT_MAX_FILE_CHARS = 7000;
// A file we're willing to have the model rewrite whole. Kept under the output
// budget (AGENT_MAX_OUTPUT_TOKENS ≈ 3000 tokens ≈ ~9k chars) so a full rewrite
// can't get truncated. Sized so a real themed globals.css / index.css (where a
// "neon" or accent palette actually lives) is editable, not just tiny config
// files — the old 4200 cap silently dropped the CSS and left only a small
// tailwind.config, which the model then returned unchanged ("0 changes").
const WHOLE_FILE_MAX_CHARS = 6000;
const EDIT_MAX_EDITABLE = 3;   // don't offer more than this many rewritable files

// ── Layered agentic edit pipeline (gitagent standard) ────────────────────────
// The gitagent "repo-sandbox-agent" spec routes a code request through squads:
//   Orchestrator → Complexity Classifier → Guardrails → Developer.
// We mirror that here as explicit layers so the engine *decides how to code*
// (scope, safety) instead of just answering. Each layer's decision is streamed
// to the chat as a step, so the pipeline reads as agentic.

// Layer: Complexity Classifier (the "Code Editor Squad" tiered dispatch).
// junior = one focused file; senior = a few related files (multi-file wording).
function classifyEditComplexity(message, availableFiles) {
  const senior = /\b(refactor|across|every|all (?:the )?(?:files|pages|components)|multiple files|throughout|whole app|entire app|everywhere|migrate)\b/i.test(message);
  if (senior && availableFiles > 1) {
    return { tier: "senior", maxFiles: Math.min(EDIT_MAX_EDITABLE, availableFiles), label: "senior dev · multi-file change" };
  }
  return { tier: "junior", maxFiles: Math.min(2, availableFiles), label: "junior dev · focused change" };
}


// Layer: Guardrails (registry agents). The regex guard above is the code-level
// floor — fixed rules, no model. This is the part a pulled guardrail agent
// actually drives: it sees the rewrite the Developer produced and can DENY it.
// Without this pass an installed guardrail agent is only advice in the writer's
// own prompt, which a weak model ignores; here its verdict is enforced in code.

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

// Choose which files to hand the model for an edit. Priority is deliberate: the
// UI entry and style files come FIRST (they're the real targets for page/look
// changes), and keyword-matched files only fill the remaining slots — so a search
// hit on library boilerplate (e.g. components/ui/chart.tsx matching "theme")
// can't crowd out the file you actually meant. Each file is tagged `whole` if it's
// small enough to safely rewrite in full.
async function gatherEditFiles(dir, message) {
  const chosen = [];
  const add = (p) => {
    if (!p || chosen.includes(p)) return;
    if (EDIT_SKIP_PATH.test(p)) return;              // never edit library boilerplate
    if (!existsSync(join(dir, p))) return;
    if (chosen.length >= EDIT_MAX_FILES) return;
    chosen.push(p);
  };

  // 1. The UI entry point — the most common target for a UI/page change.
  add(firstExistingFile(dir, EDIT_ENTRY_CANDIDATES));
  // 2. Style files, for look-and-feel requests.
  if (EDIT_STYLE_INTENT.test(message)) {
    for (const c of EDIT_STYLE_CANDIDATES) add(c);
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

  return chosen.map((p) => {
    const content = readFileCapped(join(dir, p), EDIT_MAX_FILE_CHARS);
    const whole = content.length > 0 && content.length <= WHOLE_FILE_MAX_CHARS && !content.includes("…truncated…");
    return { path: p, content, whole };
  });
}

// The whole-file rewrite prompt. Input files and expected output use the SAME
// delimiter, so the weak model mirrors the format correctly (the old bug: showing
// `<file path=...>` but asking for `<file>path</file>` made it copy the wrong one).
// Built-in fallbacks for the persona skills that now live (source of truth) in the
// repo's .gitagent/skills/. If a skill file is missing, these keep behavior stable.
const SKILL_FALLBACK = {
  "jnr-developer": "You are the Junior Developer. Make the smallest, most focused change that satisfies the request; prefer a single file; do not refactor, rename, or add anything not asked for.",
  "snr-developer": "You are the Senior Developer. The change spans a few related files; update all that must change together to keep the app consistent, keep the architecture intact, and do not expand scope.",
  "ask": "Answer concretely and grounded in the actual files; cite real file paths; do not describe what you would look at; never change files in Ask mode.",
  "build-doctor": "Classify the logs as a real blocker vs. noise; for a real blocker propose the smallest safe fix (one command or one edit); never rewrite lockfiles, run npm audit fix --force, or delete files.",
};

// Resolve a persona: the repo's own .gitagent/skills/<name>/SKILL.md wins (source
// of truth — edit it and behavior changes), else the built-in fallback string.
function skillPersona(dir, name) {
  return loadSkill(dir, name) || SKILL_FALLBACK[name] || "";
}

function buildEditPrompt(files, message, cls, persona) {
  const wrap = (f) => `=== FILE: ${f.path} ===\n${f.content}\n=== END FILE ===`;
  const fileBlocks = files.map(wrap).join("\n\n");
  const scopeLine = cls && cls.tier === "junior"
    ? `- Scope: this is a FOCUSED change — edit the single most relevant file (at most ${files.length}).\n`
    : `- Scope: edit only the file(s) that must change to satisfy the request.\n`;
  return (
    (persona || "") +
    `You are the Developer layer of a coding agent. You DO the edit — you never ` +
    `describe it. Here are the current files:\n\n${fileBlocks}\n\n` +
    `Apply the requested change by returning, for EACH file you change, its COMPLETE ` +
    `updated contents wrapped EXACTLY like the files above:\n\n` +
    `=== FILE: relative/path ===\n{the ENTIRE file, with your change applied}\n=== END FILE ===\n\n` +
    `Rules:\n` +
    `- Return the WHOLE file, not a snippet — include every line, changed or not.\n` +
    `- Change ONLY what the request asks for; keep everything else exactly as-is.\n` +
    `- Do NOT invent features, extra options, comments, or placeholder content.\n` +
    scopeLine +
    `- Only edit files shown above. Do not touch any other file.\n` +
    `- NEVER answer with prose like "I would…" or "First I would look at…". ` +
    `If you cannot produce the file, output nothing.\n` +
    `- Output ONLY FILE blocks — no explanation, no code fences.\n\n` +
    `Change requested: ${message}`
  );
}


// Parse whole-file blocks out of the model's reply. Accepts the `=== FILE: … ===`
// delimiter we ask for, and also the `<file path="…">…</file>` form the model
// tends to fall back to. A block only counts if it's properly CLOSED — so a reply
// truncated by the output cap simply won't parse (no half-written file gets saved).
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
  const reA = /={3,}\s*FILE:\s*(.+?)\s*={3,}\s*\r?\n([\s\S]*?)\r?\n?={3,}\s*END\s*FILE\s*={3,}/gi;
  let m;
  while ((m = reA.exec(text)) !== null) push(m[1], m[2]);
  const reB = /<file\s+path=["']([^"']+)["']\s*>\r?\n([\s\S]*?)\r?\n?<\/file>/gi;
  while ((m = reB.exec(text)) !== null) push(m[1], m[2]);
  return blocks;
}

// Apply whole-file blocks to disk. Path-safe (stays inside dir). Only overwrites
// files we actually showed the model (or brand-new files) — so a hallucinated
// path can't clobber unrelated code. Returns per-file status for the summary.
function applyEditBlocks(dir, blocks, offered) {
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
    try {
      const prev = existed ? readFileSync(abs, "utf8") : null;
      const next = b.content.endsWith("\n") ? b.content : b.content + "\n";
      if (prev !== null && prev === next) {
        results.push({ path: b.path, status: "unchanged" });
        continue;
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


// LLM Orchestrator: classify an ambiguous message as "edit" vs "ask" with a
// single cheap toolless call. This is what makes routing intelligent beyond the
// keyword heuristic — "rebrand the heading" or "swap the hero copy" have no edit
// verb but clearly change files. Any failure falls back to the safe Ask mode.
async function classifyIntentLLM(message, dir, model) {
  const prompt =
    `You route messages for a coding agent. Decide whether the user wants to CHANGE ` +
    `files in the project (rename, rebrand, restyle, add, remove, fix, reword, move ` +
    `things) or just get an ANSWER (explain, summarize, locate, understand — no file ` +
    `changes).\nReply with exactly one word: edit OR ask.\n\nMessage: ${message}`;
  try {
    const { text } = await collectTurn({
      prompt, dir, model, replaceBuiltinTools: true, allowedTools: [],
      constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
    }, model);
    return /\bedit\b/i.test(text || "") ? "edit" : "ask";
  } catch {
    return "ask";
  }
}

// The Orchestrator layer. Explicit UI mode wins; then the free heuristic; then,
// for genuinely ambiguous messages, the LLM classifier. Applies the agentic
// escape hatch for edits.
async function decideMode(explicit, message, dir, model) {
  if (explicit === "ask" || explicit === "edit" || explicit === "agent") return explicit;
  let mode = heuristicMode(message);
  if (mode === null) mode = await classifyIntentLLM(message, dir, model);
  if (mode === "edit" && process.env.AGENT_EDIT_STRATEGY === "agentic") return "agent";
  return mode;
}

// The layered edit pipeline (gitagent squads): Orchestrator → Classifier →
// Guardrails → Developer → Guardrails(apply). `onStep(name, detail)` receives each
// layer's decision so callers can stream it. Returns a structured outcome; the
// model never calls a tool, so it can't garble a call — the layers do the work.
async function runEditPipeline(dir, message, model, onStep) {
  const step = (name, detail) => { if (onStep) onStep(name, detail); };

  // Orchestrator already routed us here (mode=edit).
  step("Orchestrator", "route → edit");

  // Gather candidate files, keep the ones small enough to rewrite whole.
  const gathered = await gatherEditFiles(dir, message);
  const whole = gathered.filter((f) => f.whole);
  // Relevant files we found but can't rewrite whole on the free tier — surfaced
  // in the summary so a "0 changes" result names the real target instead of the
  // useless "try rephrasing".
  const tooLarge = gathered.filter((f) => !f.whole).map((f) => f.path);
  if (whole.length === 0) {
    return { ok: false, reason: gathered.length ? "too-large" : "not-found", tooLarge };
  }

  // Complexity Classifier — decides how many files the Developer may rewrite.
  const cls = classifyEditComplexity(message, whole.length);
  step("Classifier", cls.label);
  const editable = whole.slice(0, cls.maxFiles);

  // GitAgent registry — if this workspace declares a pipeline (.gitagent/pipeline
  // .yaml or env override), install the referenced registry agents (live clone)
  // and let them drive the Developer/Guardrails slots. No manifest → built-ins.
  let agents = { enabled: false };
  try {
    agents = await resolvePipelineAgents(dir, onStep);
  } catch (e) {
    step("GitAgent", `registry unavailable (${e.message}) · using built-ins`);
  }

  // Developer persona comes from the repo's own .gitagent/skills/ (source of
  // truth): the Complexity Classifier's tier selects jnr vs snr; the skill file
  // supplies the text (built-in fallback if the file is absent). Compliance rules
  // from .gitagent/compliance/ layer on top; a registry agent overlays via
  // personaPreamble. Deny always wins (code-enforced guards run regardless).
  const tierSkill = cls.tier === "senior" ? "snr-developer" : "jnr-developer";
  const devText = skillPersona(dir, tierSkill);
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
  const devLabel = agents.developer ? ` as ${agents.developer.name}` : ` · skills/${tierSkill}`;
  step("Developer", `editing ${editable.map((f) => f.path).join(", ")}${devLabel}`);
  const { text, error } = await collectTurn({
    prompt: buildEditPrompt(editable, message, cls, persona),
    dir,
    model,
    replaceBuiltinTools: true,
    allowedTools: [],
    constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
  }, model);
  if (error && !text) return { ok: false, reason: "error", error };

  const blocks = parseEditBlocks(text);
  if (blocks.length === 0) return { ok: false, reason: "no-blocks", text };

  // Guardrails (apply) — refuse sensitive files / secret injection. Code-level,
  // no model involved, so it holds even when the provider is down.
  const { allowed, blocked } = guardEditBlocks(blocks);
  if (blocked.length) step("Guardrails", `blocked ${blocked.length} unsafe edit(s)`);

  // Then the installed guardrail agents get the last word on what survived: they
  // read the actual rewrite and may deny it. Deny wins — nothing they reject is
  // written, regardless of what the Developer (or its persona) wanted.
  const reviewed = await reviewEditBlocks(dir, agents, message, allowed, model, step);
  blocked.push(...reviewed.blocked);

  const results = applyEditBlocks(dir, reviewed.allowed, editable);
  for (const b of blocked) results.push({ path: b.path, status: `blocked by guardrails (${b.reason})` });
  return { ok: true, results, cls, tooLarge };
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
    if (out.reason === "no-blocks") return { text: out.text || "No changes were produced.", changed: false, error: null };
  }
  const changed = out.results.filter((r) => r.status === "edited" || r.status === "created");
  // When nothing changed, if we found a relevant file too large to rewrite (e.g.
  // the themed globals.css a recolor actually needs), name it — that's far more
  // useful than a generic "try rephrasing".
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
async function runEditModeWS(ws, dir, message, model) {
  const out = await runEditPipeline(dir, message, model, (name, detail) => {
    ws.send(JSON.stringify({ type: "tool", content: `${name}(${detail})` }));
  });
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
    }));
    ws.send(JSON.stringify({ type: "edit_summary", files }));
  } else {
    ws.send(JSON.stringify({ type: "delta", content: text }));
  }
  ws.send(JSON.stringify({ type: "complete", content: "" }));
}


// Register a sandbox dir after Jr Architect clones + generates agent spec
// The scaffolded spec lives under .gitagent/ (grouped, visible in the explorer),
// but a standard-pure repo may commit agent.yaml at its root. Accept either.
function agentSpecPresent(dir) {
  return existsSync(join(dir, ".gitagent", "agent.yaml")) || existsSync(join(dir, "agent.yaml"));
}

// ── Knowledge slot ───────────────────────────────────────────────────────────
//
// Runs once when the workspace opens. Spawned as a child process so the reserved
// key lives in an environment no chat turn can reach — see knowledge-worker.js for
// why a mutex would not do.

// Per-workspace build state, so the panel can show what is happening without the
// build having to finish first. Keyed by directory, not container: reopening the
// same workspace should not rebuild what is already there.
const knowledgeState = new Map();

function knowledgeStateFor(dir) {
  return knowledgeState.get(dir) || { status: "idle" };
}

function runKnowledgeBuild(dir, { agent, force } = {}) {
  const cur = knowledgeStateFor(dir);
  if (cur.status === "building") return cur;              // already in flight
  if (!force && knowledgeStatus(dir).exists) {
    // A workspace that already carries the document does not rebuild on open —
    // the file is committed knowledge, and a repo may well ship a better one than
    // we would generate. Press Rebuild to override.
    const st = { status: "ready", skipped: "already built" };
    knowledgeState.set(dir, st);
    return st;
  }
  if (!firstAvailableProvider()) {
    const st = { status: "failed", error: "no AI provider key configured" };
    knowledgeState.set(dir, st);
    return st;
  }

  const model = modelFor("groq");
  const startedAt = Date.now();
  knowledgeState.set(dir, { status: "building", startedAt, agent: agent || KNOWLEDGE_SKILL });

  const env = { ...process.env };
  // The reserved key, and only here. Absent it the worker inherits the chat key
  // and simply competes — degraded, not broken.
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
  const { container, workdir, stack } = req.body;
  if (!container || !workdir) {
    return res.status(400).json({ error: "container and workdir required" });
  }
  sessions.set(container, { dir: workdir, stack: stack || "unknown", clients: new Set() });
  console.log(`[agent] registered container=${container} dir=${workdir} stack=${stack}`);
  // Respond first. The build takes ~30-60s and must never hold up the sandbox —
  // Go calls this in a goroutine at clone time and ignores the body.
  res.json({ status: "registered" });
  try {
    const manifest = readPipelineManifest(workdir);
    runKnowledgeBuild(workdir, { agent: (manifest && manifest.knowledge) || undefined });
  } catch (e) {
    console.error("[knowledge] could not start the build:", e.message);
  }
});

// Rebuild on demand — after editing the builder's SKILL.md, or after the repo has
// changed enough that the overview is stale.
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

  // Edit mode: the layered pipeline (Orchestrator → Classifier → Guardrails →
  // Developer), buffered into a single summary for the REST fallback.
  if (mode === "edit") {
    const out = await runEditPipeline(session.dir, message, model, null);
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

// ── Build doctor: diagnose container/terminal issues and propose a fix ────────
// This is what makes Jr Architect an intelligent IDE rather than a passive one.
// When the app is slow to boot or the terminal shows errors, the frontend sends
// the recent container logs here. The model classifies real errors vs. noise
// (deprecation warnings, audit notices, a slow-but-successful install) and, for a
// genuine blocker, proposes ONE fix: a shell command to run in the sandbox, or a
// file edit routed through the guardrailed edit pipeline. Nothing is applied here
// — the UI shows the proposal with a one-click Apply/Run (the user chose "propose,
// one-click apply"), so a weak free-tier model can't silently break the repo.

// Pull a JSON object out of a model reply that may be fenced or wrapped in prose.

function buildDiagnosePrompt(stack, logs) {
  // Keep only the tail — the failure is almost always at the end, and the free
  // tier has a tight token budget.
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
    constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
  }, model);

  if (error && !text) return res.status(502).json({ error });

  const parsed = parseJsonLoose(text);
  if (!parsed) {
    // Model didn't return usable JSON — treat as "nothing actionable" rather than
    // surfacing a scary error, but pass the raw note through for context.
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

// ── GitAgent registry panel ──────────────────────────────────────────────────
// Powers the IDE's GitAgent panel: browse the registry, see which agents fill
// the Developer/Guardrails slots for this workspace, and swap them.

// Browse the registry index (community agents). Each row carries the slot it
// would take, so the panel can label the button with what pulling it will do
// instead of duplicating the classification in the frontend.
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

// The repo's own spec files, in the order the panel presents them. Each is a real
// file in the workspace — editing one changes how the next turn behaves.
const SPEC_FILES = [
  { key: "soul", path: ".gitagent/SOUL.md", label: "Identity",
    hint: "Who this agent is. Injected first, ahead of every edit." },
  { key: "rules", path: ".gitagent/RULES.md", label: "Rules",
    hint: "Must / Never rules. \"Never\" items are hard limits the agent may not cross." },
  // memory/MEMORY.md is the standard's full layout; resolveMemoryPath() below
  // falls back to a legacy root MEMORY.md so the card always points at the file
  // the agent will actually read.
  { key: "memory", path: ".gitagent/memory/MEMORY.md", label: "Memory",
    hint: "Durable facts about this project the agent reads before changing anything." },
  { key: "compliance", path: ".gitagent/compliance/RULES.md", label: "Guardrails",
    hint: "Compliance rules layered onto the code-enforced guardrails. A deny always wins." },
  { key: "manifest", path: ".gitagent/agent.yaml", label: "Manifest",
    hint: "Model, tools, and runtime. Mirrored to the repo root, where the runtime reads it." },
];

// Point the Memory card at the file the agent will actually read: the standard
// memory/MEMORY.md, or a legacy root MEMORY.md in a repo scaffolded before the
// move. Editing the wrong one would look like it worked and change nothing.
function resolveMemoryPath(dir) {
  for (const rel of MEMORY_PATHS) {
    if (existsSync(join(dir, ".gitagent", ...rel.split("/")))) return `.gitagent/${rel}`;
  }
  return `.gitagent/${MEMORY_PATHS[0]}`; // neither exists — offer to create the standard one
}

// Compose the pipeline status for a workspace: the assigned agents (enriched from
// the index), whether each is cloned to disk, and the repo's own spec — the files
// that define its agent plus the skills that drive the pipeline.
async function gitagentStatus(dir) {
  const index = await fetchRegistryIndex();
  const manifest = readPipelineManifest(dir) || { developer: null, guardrails: [] };
  const installed = new Set(installedAgents(dir));
  const pins = manifest.pins || {};
  const enrich = (ref, slot) => {
    const e = findAgent(index, ref) || {};
    const p = overlayPaths(ref, slot);
    return {
      ref, slot,
      pin: pins[ref] || "",
      category: e.category || "other",
      description: e.description || "",
      repository: e.repository || "",
      installed: installed.has(ref),
      // Where this agent lives inside the spec folder. Present only once the
      // overlay is materialized, so the panel links to files that really exist.
      specFiles: [p.spec, p.workflow].filter((rel) => existsSync(join(dir, ...rel.split("/")))),
    };
  };
  // The Knowledge slot always has an occupant: a pulled registry agent if one is
  // assigned, otherwise the built-in knowledge-builder skill. It is shown as an
  // agent either way — the built-in is a SKILL.md in this repo, not a hidden
  // prompt, so "open it and edit it" is true for both.
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
    // The repo's own .gitagent/skills/ — the built-in personas plus any the user
    // authored. These drive the chat agent directly (source of truth).
    skills: listSkillsDetailed(dir),
    builtinSkills: BUILTIN_SKILLS,
    // The identity/rules/memory files, with a presence flag so the panel can
    // offer to create one that a hand-written repo never scaffolded.
    spec: SPEC_FILES.map((f) => {
      const path = f.key === "memory" ? resolveMemoryPath(dir) : f.path;
      return { ...f, path, exists: existsSync(join(dir, ...path.split("/"))) };
    }),
    // Community agents already cloned into this workspace, whether or not they
    // currently hold a slot — so an installed agent can be inspected and reused.
    installedAgents: installedAgentsDetailed(dir),
  };
}

// Create a new skill in the repo's own .gitagent/skills/<slug>/SKILL.md so it
// shows in the folder and can drive the agent. Intertwined with the registry: a
// local skill and an installed registry agent both compose through the pipeline.
app.post("/agent/skill", (req, res) => {
  const { container, name, description, body, overwrite } = req.body || {};
  const session = sessions.get(container);
  if (!session) return res.status(404).json({ error: "sandbox not registered" });
  const slug = String(name || "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!slug) return res.status(400).json({ error: "a skill name is required" });
  try {
    const skillDir = join(session.dir, ".gitagent", "skills", slug);
    const file = join(skillDir, "SKILL.md");
    // Creating is the default; the panel's skill editor passes overwrite to save
    // an existing one, so a typo'd new skill can't silently clobber a persona.
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

// Delete a user-authored skill. Built-in personas are refused by deleteSkill —
// removing one would quietly change how the pipeline codes.
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

// ── Spec files (identity, rules, memory, guardrails, manifest) ────────────────
// The panel edits the repo's own agent in place. Paths are confined to
// .gitagent/ (plus the root agent.yaml) by resolveSpecPath.

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

// Preview a registry agent before installing it: the index entry plus its spec
// files read straight from GitHub. Lets a user see what an agent will inject
// before handing it a slot.
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

// Pull an agent from the registry: clone it AND put it to work. The slot comes
// from the registry's own metadata via classifySlot (a compliance agent guards,
// a developer-tools agent writes), so pulling is one click and the next edit
// already runs through it. Pass `slot` to override, or `slot: "none"` to clone
// without assigning — for reading an agent's files before trusting it.
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
    // Pin at pull time. Without this the pack is "whatever upstream is today" and
    // the rules can change with no diff and no review.
    if (slot) assignSlot(session.dir, pulled, slot, sha);

    // Resolving the pipeline is what writes the agent INTO .gitagent/: its rules
    // become a real file under compliance/ or skills/, its stage is documented in
    // workflows/, and RULES.md gains a managed index. Without this the folder
    // would still read as the untouched scaffold while the pipeline ran the agent.
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
      // The files the pull created or removed, so the panel can say what changed
      // in the folder instead of leaving the user to go find it.
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

// Assign agents to slots: writes .gitagent/pipeline.json, installs (live clone)
// the referenced agents, and returns the new status plus install steps.
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
      const mode = await decideMode(payload.mode, message, session.dir, model);
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
        // (only reliable with a strong tool-calling model). It still runs as the
        // installed agent — the persona is the same one the Edit pipeline uses,
        // so switching the composer to "Agent" doesn't silently drop it.
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
  // Re-exported from llm.js / guardrails.js so existing callers and tests keep
  // importing them from here while the engine lives in its own modules.
  firstAvailableProvider, modelFor,
  makeSearchCodeTool, resolveTurnMode, heuristicMode, extractSearchTerms, buildAskPrompt,
  parseEditBlocks, applyEditBlocks, gatherEditFiles, buildEditPrompt,
  classifyEditComplexity, guardEditBlocks, buildGuardrailPrompt,
  reviewEditBlocks, applyGuardrailVerdicts,
  // Exported so tests can drive the routes over real HTTP. A route can break in
  // ways calling its helpers never shows — a shadowed binding, a bad status code —
  // and those only surface by actually making the request.
  server,
};

// Skip binding a port when imported for tests (AGENT_NO_LISTEN=1).
if (!process.env.AGENT_NO_LISTEN) {
  const PORT = process.env.AGENT_PORT || 8001;
  // Bind loopback explicitly. `server.listen(PORT)` with no host binds 0.0.0.0,
  // which exposed this service to the local network — and it can read and write
  // any registered workspace and spend your provider API keys, with no auth of
  // any kind. The Go host binds 127.0.0.1:9000 and reverse-proxies /agent/* here,
  // so nothing legitimate ever needed an external interface.
  // AGENT_HOST is an explicit opt-out for anyone deliberately running it remotely.
  const HOST = process.env.AGENT_HOST || "127.0.0.1";
  server.listen(PORT, HOST, () => {
    console.log(`[agent-service] running on ${HOST}:${PORT}`);
  });
}