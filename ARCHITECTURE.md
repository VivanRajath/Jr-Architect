# Jr Architect — End-to-End Architecture & Specification

> **Jr Architect** is a self-hosted, AI-augmented cloud IDE that spins up isolated Docker sandbox environments for any Git repository. It auto-detects the runtime stack, launches the app in a container, and gives you a full in-browser IDE — with a file explorer, Monaco code editor, live preview, WebSocket terminal, and an AI coding agent — all from a single binary.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
1a. [Product Modes: Prompt, Dev, and Build](#product-modes-prompt-dev-and-build)
2. [System Architecture Diagram](#2-system-architecture-diagram)
3. [Component Breakdown](#3-component-breakdown)
   - [Go Core Server (`main.go`)](#31-go-core-server-maingo)
   - [Runtime Detector (`detector.go`)](#32-runtime-detector-detectorgog)
   - [GitAgent Generator (`gitagentgenerator.go`)](#33-gitagent-generator-gitagentgeneratorgog)
   - [Agent Service — Node.js (`agent-services/server.js`)](#34-agent-service--nodejs-agent-servicesserverjs)
   - [Agent Service — Python (`agent/main.py`)](#35-agent-service--python-agentmainpy)
   - [Frontend IDE (`index.html`, `ide.js`, `ide.css`)](#36-frontend-ide-indexhtml-idejs-idecss)
   - [AI Agent Chat Panel (`ide-agent.js`, `ide-agent.css`)](#37-ai-agent-chat-panel-ide-agentjs-ide-agentcss)
   - [Docker Sandbox Images (`sandbox-images/`)](#38-docker-sandbox-images-sandbox-images)
4. [Request Lifecycle — End to End](#4-request-lifecycle--end-to-end)
5. [Runtime Detection Logic](#5-runtime-detection-logic)
6. [GitAgent Spec Generation](#6-gitagent-spec-generation)
7. [API Reference](#7-api-reference)
8. [Port & Network Map](#8-port--network-map)
9. [Technology Specifications](#9-technology-specifications)
10. [Configuration & Environment](#10-configuration--environment)
11. [Supported Stacks](#11-supported-stacks)
12. [Security Model](#12-security-model)
13. [Sandbox Lifecycle](#13-sandbox-lifecycle)

---

## 1. High-Level Overview

```
User Browser
    │
    ▼
┌─────────────────────────────────┐
│  Go Binary  (port 9000)         │  ← Single static binary, embeds all UI
│  - HTTP REST API                │
│  - WebSocket terminal relay     │
│  - Static file serving          │
│  - Docker lifecycle management  │
│  - Proxies /agent/* → port 8001 │
└───────┬─────────────────────────┘
        │ docker run / exec
        ▼
┌────────────────────────────────────────────────┐
│  Docker Sandbox Container                      │
│  Image: sandbox-{node|python|react|go|...}     │
│  Volume: /workspace  (cloned repo)             │
│  Port: dynamic (mapped from host)              │
│  Limits: 1 CPU, 1 GB RAM, 100 PIDs            │
│  TTL: 10 minutes auto-cleanup                  │
└────────────────────────────────────────────────┘
        │
        │ /agent/*  (reverse proxy)
        ▼
┌────────────────────────────────────────────────┐
│  Agent Service  (port 8001)                    │
│  Option A: Node.js + gitclaw (WebSocket + REST)│
│  Option B: Python FastAPI + multi-provider AI  │
└────────────────────────────────────────────────┘
```

---

## Product Modes: Prompt, Dev, and Build

Jr Architect is an agent-guided cloud IDE. The landing screen offers three top-level modes (selected via `setMode()` in `index.html`), and the AI agent inside Dev Mode further routes each message into one of three prompt modes.

### Top-level modes

| Mode | What it does | IDE shown |
|---|---|---|
| **Prompt** | Quick run. Clone the repo, detect or infer run commands, start the app, show the preview. Optimized for getting to a running app fast. | No |
| **Dev** | Full cloud IDE over the running sandbox: file explorer, Monaco editor, live preview, WebSocket terminal, and the AI agent. | Yes |
| **Build** | Scaffold a new, fully local app from a plain-language description. Clarifying questions, then a short spec, then generation and a live run. Generated apps persist to the browser and are guarded against third-party integrations. | Yes (after generation) |

Prompt and Dev share the repo input and the same clone plus detect plus run path; they differ only in whether the IDE is revealed. Build swaps the repo input for a description field and drives the multi-step generator in `builder.go`.

### Agent prompt modes (inside Dev Mode)

The agent decides how to handle a message through the Orchestrator layer (`decideMode()` in `agent-services/server.js`), and the user can override it with the Ask, Edit, or Agent dropdown in the composer.

| Prompt mode | For | How it runs |
|---|---|---|
| **Ask** | Questions about the repo ("summarize this codespace", "where is X") | Toolless retrieve-then-generate. The backend searches the code, gathers the repo map and key files, and gives the model a grounded prompt. The model only writes the answer. |
| **Edit** | Code changes ("make the UI dark red", "rebrand the heading", "add a footer") | The layered engine: Orchestrator, Complexity Classifier, Guardrails, Developer. The Developer stage rewrites whole files and the backend applies them. The result is a clickable file list that opens a before/after diff. |
| **Agent** | Open-ended, multi-file work with a strong tool-calling model | The original tool-driven loop where the model calls read/write/search itself. Opt-in via the dropdown or `AGENT_EDIT_STRATEGY=agentic`. |

The Orchestrator routes with free heuristics for the obvious cases (an edit verb goes to Edit, a question opener goes to Ask) and falls back to a single-word LLM classification for genuinely ambiguous messages such as "rebrand the heading" or "swap the two buttons", which change files without an obvious verb. See section 3.4 for the implementation.

---

## 2. System Architecture Diagram

```
                          ┌────────────────────────────────────────────────────────┐
                          │                   USER BROWSER                         │
                          │                                                         │
                          │  ┌──────────────┐  ┌──────────────┐  ┌─────────────┐ │
                          │  │  Sandbox UI  │  │   IDE Panel  │  │  AI Chat    │ │
                          │  │  (index.html)│  │  (ide.js)    │  │(ide-agent.js│ │
                          │  └──────┬───────┘  └──────┬───────┘  └──────┬──────┘ │
                          └─────────┼─────────────────┼─────────────────┼─────────┘
                                    │ HTTP/WS          │ HTTP/WS         │ WS
                                    ▼                  ▼                 ▼
          ┌─────────────────────────────────────────────────────────────────────────┐
          │                    Go Core Server  :9000                                 │
          │                                                                          │
          │  POST /run            → clone repo, detect runtime, start container      │
          │  GET  /list           → list active sandboxes                            │
          │  POST /stop/:id       → stop & remove container                          │
          │  GET  /logs/:id       → setup + container logs                           │
          │  GET  /status         → container health check                           │
          │  GET  /files          → file tree of /workspace                         │
          │  GET  /file           → read single file                                 │
          │  POST /file/save      → write file to /workspace                         │
          │  POST /file/create    → create file or directory                         │
          │  POST /file/delete    → delete file or directory                         │
          │  POST /terminal/exec  → one-shot exec inside container                  │
          │  WS   /terminal/ws    → interactive PTY shell (xterm.js ↔ docker exec)  │
          │  ANY  /agent/*        → reverse proxy → Agent Service :8001              │
          │  GET  /               → embedded index.html                              │
          │  GET  /ide.js         → embedded Monaco IDE JS                           │
          │  GET  /ide.css        → embedded Monaco IDE CSS                          │
          │  GET  /ide-agent.js   → embedded AI agent chat JS                        │
          │  GET  /ide-agent.css  → embedded AI agent chat CSS                       │
          └─────────┬────────────────────────────────────────────────────────────────┘
                    │ docker run/exec/stop/logs
                    ▼
          ┌────────────────────────────────────────────────────┐
          │               Docker Engine                        │
          │                                                    │
          │  sandbox-static   (nginx)       → port 80          │
          │  sandbox-node     (Node 20)     → port 3000        │
          │  sandbox-react    (Node+Vite)   → port 3000/5173   │
          │  sandbox-python   (Python 3.12) → port 5000/8000   │
          │  sandbox-go       (Go 1.22)     → port 8080        │
          │  sandbox-java     (Java 21)     → port 8080        │
          │  sandbox-php      (PHP 8.3)     → port 80          │
          │  sandbox-ruby     (Ruby 3.3)    → port 3000        │
          │  sandbox-rust     (Rust 1.78)   → port 8080        │
          │  sandbox-dotnet   (.NET 8)      → port 5000        │
          │  sandbox-deno     (Deno 1.44)   → port 8000        │
          │  sandbox-bun      (Bun 1.1)     → port 3000        │
          └────────────────────────────────────────────────────┘
                    │                      │
          ┌─────────┘                      └──────────────┐
          ▼                                               ▼
┌───────────────────────┐               ┌────────────────────────────────────┐
│  Agent Service :8001  │               │    GitAgent Spec (per sandbox)     │
│  (Node.js + gitclaw)  │               │    /workspace/agent.yaml           │
│                       │               │    /workspace/SOUL.md              │
│  POST /agent/register │               │    /workspace/RULES.md             │
│  POST /agent/chat     │               │    /workspace/skills/ui-editor/    │
│  WS   /agent/ws       │               │         SKILL.md                  │
│                       │               └────────────────────────────────────┘
│  — or —               │
│  Python FastAPI        │
│  (agent/main.py)       │
│  POST /agent/chat      │
│  POST /agent/suggest   │
│  GET  /agent/providers │
│  GET  /agent/health    │
└───────────────────────┘
```

---

## 3. Component Breakdown

### 3.1 Go Core Server (`main.go`)

The single entry point and orchestrator of the entire system. Compiled to a **single static binary** (`jr-architect.exe` / `sandbox-runner.exe`).

| Responsibility | Details |
|---|---|
| **Static embedding** | `index.html`, `ide.js`, `ide.css`, `ide-agent.js`, `ide-agent.css` are embedded at compile-time using Go's `//go:embed` directive. No separate file serving needed. |
| **Sandbox management** | Maintains an in-memory `map[string]Sandbox` of all active sandboxes, protected by a `sync.Mutex`. |
| **Docker orchestration** | Calls `docker run` with resource limits (1 CPU, 1 GB RAM, 100 PIDs), volume mounts, and port mappings. Calls `docker exec` for terminal and one-shot commands. |
| **Image preheating** | On startup, calls `preheatImages()` which checks if all 12 sandbox images exist locally. Builds any missing ones from `./sandbox-images/<name>/`. |
| **Agent service launch** | Starts the Node.js agent service (`agent-services/server.js`) as a subprocess, piping its stdout/stderr to the Go process's stdout. |
| **Reverse proxy** | All requests to `/agent/*` are forwarded to `http://127.0.0.1:8001` via `httputil.NewSingleHostReverseProxy`. |
| **WebSocket PTY** | For `/terminal/ws`, upgrades to WebSocket, spawns `docker exec -it <container> sh` using `github.com/creack/pty`, and bidirectionally relays raw bytes. Falls back to stdin/stdout pipes if PTY fails. |
| **Auto-cleanup** | Each sandbox has a 10-minute TTL goroutine that runs `docker stop`, `docker rm`, and `os.RemoveAll` on the workspace temp dir. |

**Key data structures:**

```go
type Sandbox struct {
    Container string  // Docker container name, e.g. "sandbox-abc123"
    Port      int     // Host port dynamically allocated via net.Listen(":0")
    Repo      string  // Original GitHub URL
    Workdir   string  // Absolute path to temp dir (/workspace volume mount)
}

type RuntimeConfig struct {
    Image          string  // e.g. "sandbox-react"
    Port           int     // Internal container port
    StartupCommand string  // Shell command run on container start
}
```

---

### 3.2 Runtime Detector (`detector.go`)

Automatically determines which Docker image and startup command to use for any given repository. Uses a **4-tier priority system**:

| Priority | Method | Description |
|---|---|---|
| 1 (Highest) | `detectFromInstructions()` | Reads `INSTRUCTIONS.md` or pasted instructions. Parses non-prose lines as shell commands, infers image from command keywords. |
| 2 | `detectLyzrRepo()` | Detects Lyzr Apps repos by presence of `workflow.json` or `response_schemas/`. Forces Next.js runtime. |
| 3 | File-based detection | Reads `package.json`, `requirements.txt`, `go.mod`, `Cargo.toml`, `pom.xml`, `Gemfile`, `composer.json`, `*.csproj`, `index.html` to pick the right image. |
| 4 (Fallback) | `readDocHint()` | Scans README/INSTRUCTIONS for framework keywords (next.js, vite, flask, django, etc.) |

It also runs `findProjectRoot()` which walks up to **3 directory levels deep** to locate the actual project root in cases where the repo has a nested structure.

Dev server normalization is automatic:
- **Vite**: appends `--host 0.0.0.0` (or `-- --host 0.0.0.0` to `npm run dev`)
- **Next.js**: appends `-H 0.0.0.0`
- **CRA/React**: prepends `HOST=0.0.0.0`

---

### 3.3 GitAgent Generator (`gitagentgenerator.go`)

After a repo is cloned and its runtime is detected, this module **generates a structured AI agent specification** directly inside the workspace:

| File | Purpose |
|---|---|
| `agent.yaml` | Declares model preferences (`claude-sonnet-4-6`, fallback `gpt-4o`), allowed tools, runtime constraints (30 turns, 120s timeout) |
| `SOUL.md` | Agent identity and personality definition, tailored to the detected stack |
| `RULES.md` | Behavioral guardrails: always commit after edits, never delete files without asking, stack-specific rules |
| `skills/ui-editor/SKILL.md` | A skill definition that tells the agent how to handle UI editing requests, with stack-specific file path hints |

All files are generated from **Go text/template** strings with a `FuncMap` providing `stackRules()` and `uiFilePaths()` helpers.

After generation, `RegisterWithAgentService()` notifies the Node.js agent service via `POST /agent/register` with the container name, workdir path, and stack.

**Token-budget guard:** gitclaw splices repo-root `AGENTS.md` / `DUTIES.md` verbatim into the agent's system prompt. AI-generated app repos (e.g. Lyzr) ship a very large `AGENTS.md` (30k+ tokens), which alone exceeds a free-tier budget — Groq's free tier caps at 12k tokens/minute, so the first agent request `413`s before it can answer. `GenerateAgentSpec()` moves any such doc over `maxInjectedDocBytes` (8 KB) aside to `*.sandbox-bak` (kept, not deleted). gitclaw's base prompt is only ~600 tokens, so with our small generated `SOUL.md`/`RULES.md` the agent request stays well within budget.

---

### 3.4 Agent Service — Node.js (`agent-services/server.js`)

A lightweight **Express + WebSocket** server that drives the `gitclaw` agentic execution loop.

| Endpoint | Method | Description |
|---|---|---|
| `/agent/register` | POST | Stores a `container → { dir, stack, clients }` session map entry |
| `/agent/chat` | POST | Single-shot REST chat — streams `gitclaw.query()` and returns full response (used as a fallback when the WebSocket can't be established) |
| `/agent/ws` | WS | **Primary path.** Persistent connection that streams the agent's work live |

**WebSocket protocol:**

```
Client → Server:
  { type: "bind",  container: "sandbox-abc" }                       // attach to a sandbox
  { type: "chat",  container: "sandbox-abc", message: "...",        // send a prompt
                   provider: "groq", mode: "auto" }                 //   provider selects the model;
                                                                    //   mode is auto | ask | edit | agent

Server → Client:
  { type: "ready"       }        // bind acknowledged
  { type: "thinking"    }        // agent started
  { type: "delta",       content: "partial text..." }   // streaming token
  { type: "tool",        content: "Classifier(junior dev)" }        // a layer step, or a tool call
  { type: "file_changed" }       // a file was written this turn
  { type: "edit_summary", files: [ { path, status, before, after } ] } // clickable result of an edit turn
  { type: "message_end" }        // soft boundary between the agent's assistant messages (turn continues)
  { type: "complete"    }        // DEFINITIVE end of turn, the generator drained
  { type: "error",       content: "..." }
```

The `tool` frame carries both real tool invocations (Agent mode) and the layered pipeline's step decisions (Edit mode), so the same UI row renders "Orchestrator", "Classifier", "Guardrails", and "Developer" as the engine works. The `edit_summary` frame replaces the plain text summary for Edit turns: each file row is clickable and opens a before/after diff (`showDiffModal()` in `ide.js`) built from the `before`/`after` fields.

> **Why `message_end` + `complete` instead of a single `done`:** a multi-step agent emits several `assistant` messages in one turn (think → tool → think → …). The old code sent `done` on each, so the UI finalized prematurely. `message_end` is now the soft per-message boundary (the UI just closes the current bubble), and `complete` — sent once, after `gitclaw.query()`'s generator drains — is the only end-of-turn signal the UI acts on (reload tree/editors/preview, re-enable input).

The `gitclaw` library reads `agent.yaml` from the workspace and runs the full agentic loop (read → think → tool calls → commit → respond).

**Model selection:** `modelFor(provider)` resolves the model from the UI's provider dropdown (`groq` | `anthropic` | `openai` | `gemini`) but **only ever returns a provider that actually has an API key in the environment** (`providerHasKey()` mirrors pi-ai's env var names). Resolution order: `GITCLAW_MODEL` (if its provider has a key) → the selected provider (if it has a key) → the first configured provider, **preferring Groq**. If no provider is configured, the request is rejected up front with a clear message instead of letting the agent loop crash. This is why a machine with only `GROQ_API_KEY` runs the agent on `groq:llama-3.3-70b-versatile` with no extra config — the tool-capable model on Groq's free tier. Per-provider defaults are overridable via `AGENT_MODEL_GROQ` / `AGENT_MODEL_ANTHROPIC` / `AGENT_MODEL_OPENAI` / `AGENT_MODEL_GEMINI`.

**Transient tool-call failures & retry:** `llama-3.3-70b-versatile` intermittently emits a malformed tool call (arguments serialized into the function *name*, e.g. `cli {json}`), which Groq rejects with `tool call ... not in request.tools`. Because it's non-deterministic, the WS and REST handlers **retry the turn on a fresh key** (`AGENT_TOOLCALL_RETRIES`, default 2) — but only when the failure occurred **before any output reached the client**, tracked by `streamedAny`, so a partial reply is never duplicated. Each attempt calls `rotateGroqKey()` so retries land on a different org. The same loop also covers `Connection error` / `429` / `fetch failed`. If a Groq account has it, `groq:meta-llama/llama-4-scout-17b-16e-instruct` is steadier and can be set via `AGENT_MODEL_GROQ`.

**Output-token cap (Groq 12k TPM):** Groq's free tier counts input **plus reserved output** against its 12,000 tokens-per-minute limit, and pi-ai otherwise reserves the model's full output window (`min(model.maxTokens, 32000)` = 32000 for Groq). That alone billed every turn at ~34k/min and returned `413 Requested 33889` — the prompt (~1.9k tokens) was never the problem. pi-agent-core drops per-request `constraints.maxTokens` (its loop config uses a fixed field whitelist), so the service caps output at the **model-registry** level instead: at startup it lowers `getModels("groq")` entries' `maxTokens` to `AGENT_MAX_OUTPUT_TOKENS` (default 3000), which pi-ai reads for the reservation. A turn then bills ~input+3000, well under 12k.

The service also installs `unhandledRejection` / `uncaughtException` handlers so a single failing turn (e.g. an async provider error) logs and keeps the service alive rather than terminating the whole process.

**Code retrieval (agentic RAG, no embeddings):** the agent knows the codebase through two layers rather than a vector store — a deliberate choice given Groq's free tier has **no embeddings API** and a tight token budget, and given code has structure (tree, symbols, imports) that beats semantic similarity for locating things.

- **Layer 1 — repo map (`repomap.go`, at clone time).** After the agent spec is generated, `generateRepoMap()` walks the workspace (skipping `node_modules`/build dirs), extracts top-level exported symbols per source file, and writes two docs under `knowledge/` that gitclaw's knowledge loader picks up via `knowledge/index.yaml`: `repo-map.md` (`always_load: true` — small: stack, framework, top-level layout, UI entry point; rides in every prompt) and `repo-map-full.md` (on-demand — full file list with symbols; the agent `read`s it only when it needs detail). If the repo already ships an `index.yaml`, our entries are appended, not clobbered, and re-runs are idempotent.
- **Layer 2 — `search_code` tool (`agent-services/server.js`).** A ripgrep-style search implemented in pure JS (no external binary; cross-platform), passed to `query()` as an SDK tool bound to the session dir and enabled via `allowedTools`. The agent calls it to find where a symbol/string is defined or used and gets back only ranked `file:line` snippets (capped) — the token-frugal alternative to reading whole files. Case-insensitive; a query is tried as a regex, falling back to a literal match.
- **Deferred — Layer 3 (vector embeddings).** Only worth adding for semantic search that structure can't answer; needs a local embedding model (Groq can't do it) and more tokens. Not built.

**Toolless modes (the core reliability fix):** agentic retrieval/editing needs the model to reliably *call* tools, and `llama-3.3-70b-versatile` is weak at function-calling (it garbles calls → `tool call validation failed` / `Failed to call a function`). So the default paths **never let the model call a tool**. The backend does the tool-work and the model only generates text, which it does well.

**Orchestrator routing (`decideMode()`):** an explicit client `mode` (`ask` / `edit` / `agent` from the composer dropdown) always wins. Otherwise the Orchestrator routes intelligently. `heuristicMode()` decides the obvious cases for free: an edit verb (`EDIT_INTENT`, which includes `rename`/`rebrand`/`relabel`) or an imperative styling command that names a style target (`EDIT_IMPERATIVE` + `EDIT_STYLE_INTENT`, e.g. "make the ui dark red") routes to Edit, and a question opener (`ASK_OPENER`, e.g. "summarize" / "where" / "how") routes to Ask. For a genuinely ambiguous message that changes files without an obvious verb ("rebrand the heading", "swap the two buttons"), it falls back to `classifyIntentLLM()`, a single one-word toolless call that returns `edit` or `ask`. Only ambiguous messages pay for that call, and any failure falls back to the safe read-only Ask mode. The synchronous `resolveTurnMode()` is retained for tests and as the confident fast-path.

- **ask** (questions) — `buildAskPrompt()` pulls salient terms, runs `search_code` server-side, and injects `file:line` hits. For overview questions it also injects real substance (the repo map plus the entry, layout, and README/package files) with an instruction to write a concrete summary now and not to hedge or narrate a process. It then calls the model with `replaceBuiltinTools: true` + `allowedTools: []` → **zero tools**. The model writes a grounded answer. Streams via `streamTurn()`.
- **edit** (changes) — a **layered agentic pipeline** modelled on the [gitagent](https://github.com/VivanRajath/gitagent-hackathon) standard's tiered dispatch (`runEditPipeline`): **Orchestrator** (routes here — `EDIT_INTENT`, or an imperative styling command like "make the ui dark red" via `EDIT_IMPERATIVE` + `EDIT_STYLE_INTENT`) → **Complexity Classifier** (`classifyEditComplexity` — junior/single-file vs senior/multi-file, bounding how many files may change) → **Guardrails** (`guardEditBlocks` — refuses edits to `.env`/lockfiles/`.git` and blocks secret injection) → **Developer** (the whole-file rewrite below). Each layer's decision is streamed to the chat as a step, so the engine reads as agentic instead of chatting. The Developer stage is generate-then-apply, **whole-file rewrite**. `gatherEditFiles()` picks the relevant files *UI entry + style files first, then search-term matches, skipping library boilerplate via `EDIT_SKIP_PATH` (e.g. `components/ui/*`)* and tags each `whole` if it's small enough (`WHOLE_FILE_MAX_CHARS`) to rewrite in full within the output budget. `buildEditPrompt()` shows those files and the expected reply in the **same** `=== FILE: path ===` delimiter (so the weak model mirrors the format instead of confusing input vs output) and asks for each changed file's COMPLETE new contents. `parseEditBlocks()` extracts the whole-file blocks (accepts the `=== FILE ===` form and the `<file path="…">…</file>` fallback, strips code fences; an *unclosed* block from a truncated reply won't parse, so no half-written file is saved); `applyEditBlocks()` overwrites (path-safe: rejects anything resolving outside the workspace, and won't clobber an existing file that wasn't offered to the model). Buffered via `collectTurn()`, then a `file_changed` and a structured `edit_summary` frame are sent. The summary is a clickable file list in the chat; clicking an edited or created file opens a before/after diff (the pipeline carries each file's `before`/`after` for this). So llama-3.3 never calls `write` and never emits fragile patch markers. Whole-file rewrite is capped to small files; large-file or multi-file refactors need a stronger model (`AGENT_MODEL_*`).
- **agent** (legacy) — the original tool-driven loop (`streamTurn()` with tools). Only reliable with a strong tool-calling model; opt in with `AGENT_EDIT_STRATEGY=agentic` or an explicit `mode: "agent"`.

Both toolless modes are covered by `agent-services/server.test.js` (`node --test`). This is the same insight as Ask mode extended to writes: keep the model out of the function-calling path it's bad at.

**Tool scope & error surfacing:** the agent is restricted to the core coding tools (`allowedTools: cli, read, write, memory, search_code`, overridable via `AGENT_ALLOWED_TOOLS`). gitclaw otherwise injects extra built-ins (`capture_photo`, `task_tracker`, `skill_learner`) plus a system prompt that pushes the model through skill/task rituals — noise that bloats the request and derails smaller models (Groq's llama-3.3-70b would loop on bookkeeping and never answer). gitclaw reports a failed model call as a `{type:"system", subtype:"error"}` message (and as an `assistant` message with `stopReason:"error"`); the server maps **both** to a client `error` frame, so a failed call shows the reason instead of the panel spinning forever. Chain-of-thought (`deltaType:"thinking"`) deltas are dropped, and only workspace-mutating tools (`write`/`edit`/`create`/`cli`) trigger a `file_changed`.

---

### 3.5 Agent Service — Python (`agent/main.py`)

An alternative agent backend implemented as a **FastAPI** service. This is the legacy/fallback AI layer.

| Endpoint | Method | Description |
|---|---|---|
| `/agent/chat` | POST | Chat with AI, optionally with project file tree + currently open file as context |
| `/agent/suggest` | POST | Get AI suggestions for a specific file with an instruction |
| `/agent/providers` | GET | List configured AI providers and the default |
| `/agent/health` | GET | Health check with available providers |

**Multi-provider support** (via `providers.py`): Reads API keys from `.env` in the project root. Falls back gracefully — whichever key is present becomes the default provider.

**Context injection:** When `container` is provided in a chat request, the agent fetches the live file tree from the Go backend (`GET /files?container=...`) and injects it as structured context into the prompt.

**File change extraction:** Parses AI responses for `File: path/to/file` + code block patterns and returns `file_changes[]` so the frontend can apply them.

---

### 3.6 Frontend IDE (`index.html`, `ide.js`, `ide.css`)

The main UI is a single-page application embedded in the Go binary. It provides:

| Panel | Features |
|---|---|
| **Sandbox Launcher** | Input fields for GitHub repo URL and optional instructions. Mode selector (dev / prompt). One-click launch. Real-time setup log streaming via polling `/logs/:id`. |
| **Live Preview** | `<iframe>` pointed at `http://localhost:<dynamic-port>`. **Readiness-aware:** the dev server in a fresh sandbox isn't up for a while (npm install + build), so the preview waits for the app to report `running` (status polling only returns `running` once the app's port actually answers), shows a "Starting your app…" state until then, and loads/auto-opens the iframe once ready instead of showing a dead connection error. **Live reload:** containers run with polling watchers (`WATCHPACK_POLLING`, `CHOKIDAR_USEPOLLING`) so Next.js fast-refresh / CRA HMR pick up IDE edits despite inotify not crossing the Docker bind mount; for non-HMR stacks (Vite, static) the preview auto-reloads on save (a full reload re-reads files from disk). **Locate UI code:** a floating control on the preview — hover reveals the app's UI file's folder in the tree, click opens it in the editor (entry file resolved by `GET /sandbox/entry`). Reload button, open-in-new-tab, status indicator. |
| **File Explorer** | Tree view of the workspace fetched from `/files`. Expand/collapse directories. Click to open files. |
| **Monaco Editor** | Full VS Code-grade editor embedded via CDN. Language auto-detection from file extension. Syntax highlighting. Save with `Ctrl+S` → `POST /file/save`. |
| **Terminal** | xterm.js WebSocket terminal connected to `/terminal/ws`. Full PTY — interactive shells, autocomplete, color output. |
| **Status Bar** | Shows container name, repo URL, sandbox state (cloning / starting / ready). |

---

### 3.7 AI Agent Chat Panel (`ide-agent.js`, `ide-agent.css`)

A collapsible side panel that provides the AI coding assistant UI. It is a **live agentic stream**, not a request/response chatbot:

- Connects to the agent service over a persistent WebSocket (`/agent/ws`, reverse-proxied through the Go server; the upgrade is tunnelled transparently, so the stream shares the IDE's origin).
- Reuses one socket across turns; sends `bind` only when the active sandbox changes, then `chat` with the selected `provider` and `mode` (auto, ask, edit, or agent from the composer dropdown).
- Composer: a multi-line auto-growing textarea (Enter sends, Shift+Enter for a newline), a prompt-mode dropdown, and a provider dropdown.
- Streams tokens into the assistant bubble as they arrive; renders **each tool call or layer step as its own row**, producing an interleaved transcript (text, step, text).
- Renders the `edit_summary` frame as a clickable file list; clicking an edited or created file opens a Monaco before/after diff modal (`showDiffModal()` in `ide.js`).
- The file explorer has a VS Code style right-click context menu (`showContextMenu()` in `ide.js`): new file, new folder, rename (via `POST /file/rename`), delete, copy path, and "Ask AI about this file", which opens the panel and pre-fills a question.
- On end of turn (`complete`), reflects the agent's filesystem changes back into the IDE automatically: **refreshes the file tree, reloads open editor tabs from disk** (without clobbering unsaved user edits), and **reloads the live preview** if it's open. Changed paths are collected from write-like tool calls and from the `edit_summary` during the turn.
- Only one turn streams at a time — the input is disabled while the agent works and re-enabled on `complete`/`error`.
- Falls back to the single-shot REST endpoint (`POST /agent/chat`, with "Apply to …" buttons) if the WebSocket can't be established, so the panel degrades gracefully.
- All streamed model/file content is HTML-escaped before the lightweight markdown pass (no markup injection).

---

### 3.8 Docker Sandbox Images (`sandbox-images/`)

Each subdirectory contains a `Dockerfile` that builds a pre-configured, isolated execution environment:

| Image | Base | Default Port | Stack |
|---|---|---|---|
| `sandbox-static` | `nginx:alpine` | 80 | HTML/CSS/JS static sites |
| `sandbox-node` | `node:20-alpine` | 3000 | Node.js, Express, generic JS |
| `sandbox-react` | `node:20-alpine` | 3000/5173 | React, Next.js, Vite, Nuxt |
| `sandbox-python` | `python:3.12-slim` | 5000/8000 | Flask, FastAPI, Django |
| `sandbox-go` | `golang:1.22-alpine` | 8080 | Go modules |
| `sandbox-java` | `eclipse-temurin:21-alpine` | 8080 | Java/Maven/Gradle |
| `sandbox-php` | `php:8.3-apache` | 80 | PHP/Composer |
| `sandbox-ruby` | `ruby:3.3-alpine` | 3000 | Ruby/Rails/Sinatra |
| `sandbox-rust` | `rust:1.78-slim` | 8080 | Cargo/Actix/Axum |
| `sandbox-dotnet` | `.NET 8 SDK` | 5000 | C#/ASP.NET |
| `sandbox-deno` | `denoland/deno:1.44` | 8000 | Deno |
| `sandbox-bun` | `oven/bun:1.1` | 3000 | Bun runtime |

**Resource limits (enforced at `docker run`):**
- Memory: `1024m`
- CPUs: `1`
- PID limit: `100`

**Volume mounts:**
- `/workspace` → cloned repo temp dir (read/write)
- `~/.npm` → npm cache (speeds up installs)
- `~/.cache/pip` → pip cache (speeds up installs)

---

## 4. Request Lifecycle — End to End

```
1. User enters GitHub URL in the launcher UI
         │
         ▼
2. POST /run  { repo, instructions, mode }
         │
         ▼
3. Go allocates a random temp dir + free port
   → docker pull / image check (preheat already done)
         │
         ▼
4. git clone <repo> → temp dir (depth 1, no submodules)
         │
         ▼
5. If instructions provided → write INSTRUCTIONS.md to workdir
         │
         ▼
6. detectRuntimeConfig(workdir)
   → Returns: { Image, Port, StartupCommand }
         │
         ▼
7. GenerateAgentSpec(workdir, stack)
   → Writes agent.yaml, SOUL.md, RULES.md, skills/
         │
         ▼
8. go RegisterWithAgentService(container, workdir, stack)
   → POST http://localhost:8001/agent/register
         │
         ▼
9. docker run -d --name <container>
              --memory 1024m --cpus 1 --pids-limit 100
              -p 0.0.0.0:<hostPort>:<containerPort>
              -v <workdir>:/workspace
              -v ~/.npm:/root/.npm
              -v ~/.cache/pip:/root/.cache/pip
              -w /workspace
              -e PORT=<port>
              <image>
              sh -c "<StartupCommand>"
         │
         ▼
10. waitForServer(port) — polls for up to 300s
         │
         ▼
11. Return { status, container, url, mode } to browser
         │
         ▼
12. Browser opens IDE panel + loads live preview iframe
         │
         ▼
13. 10 minute TTL goroutine fires:
    docker stop → docker rm → os.RemoveAll(workdir)
```

---

## 5. Runtime Detection Logic

```
detectRuntimeConfig(workdir)
├── detectFromInstructions()       ← highest priority
│   └── Parse INSTRUCTIONS.md / pasted text
│       Filter prose, join commands with &&
│       Infer image from keywords
│
├── findProjectRoot()              ← may descend up to 3 levels
│   └── Look for: package.json, requirements.txt, go.mod,
│       Cargo.toml, pom.xml, build.gradle, Gemfile, *.csproj
│
├── detectLyzrRepo()               ← workflow.json / response_schemas/
│
├── File-based detection
│   ├── package.json → detectNodeFramework()
│   │   ├── next       → sandbox-react, port 3000
│   │   ├── vite       → sandbox-react, port 5173
│   │   ├── react      → sandbox-react, port 3000/5173
│   │   └── generic    → sandbox-node,  port 3000
│   ├── requirements.txt → detectPython()
│   │   ├── fastapi  → sandbox-python, port 8000
│   │   ├── flask    → sandbox-python, port 5000
│   │   └── django   → sandbox-python, port 8000
│   ├── go.mod       → sandbox-go,     port 8080
│   ├── Cargo.toml   → sandbox-rust,   port 8080
│   └── index.html   → sandbox-static, port 80
│
└── readDocHint()                  ← README keyword fallback
```

---

## 6. GitAgent Spec Generation

When a sandbox is created, Jr Architect writes an agent specification into the cloned workspace. This enables the AI agent to understand:

- **Who it is**: personality, identity, communication style (SOUL.md)
- **What it can do**: tools (`cli`, `read`, `write`, `memory`)
- **What rules to follow**: always commit changes, never delete without asking (RULES.md)
- **How to handle UI edits**: file paths for CSS, components, templates by stack (skills/ui-editor/SKILL.md)
- **Model preferences**: `claude-sonnet-4-6` preferred, `gpt-4o` as fallback (agent.yaml)

---

## 7. API Reference

### Sandbox Management

| Method | Path | Body / Params | Response |
|---|---|---|---|
| POST | `/run` | `{ repo, instructions?, mode? }` | `{ status, container, url, mode }` |
| GET | `/list` | — | `{ [container]: Sandbox }` |
| POST | `/stop/:container` | — | `{ status: "stopped" }` |
| GET | `/logs/:container` | — | Plain text log |
| GET | `/status` | `?container=` | `{ container, port, repo, status, url, framework }` |
| GET | `/sandbox/entry` | `?container=` | `{ path, dir }` — best-guess main UI file for the preview's "locate UI code" control |

### File Operations

| Method | Path | Body / Params | Response |
|---|---|---|---|
| GET | `/files` | `?container=` | `FileNode[]` (recursive tree) |
| GET | `/file` | `?container=&path=` | Raw file content (text/plain) |
| POST | `/file/save` | `{ container, path, content }` | `{ status: "saved" }` |
| POST | `/file/create` | `{ container, path, isDir }` | `{ status: "created" }` |
| POST | `/file/delete` | `{ container, path }` | `{ status: "deleted" }` |

### Terminal & IDE

| Method | Path | Description |
|---|---|---|
| POST | `/terminal/exec` | `{ container, command }` → one-shot exec |
| WS | `/terminal/ws?container=` | Interactive PTY shell |
| GET | `/ide.js` | Monaco IDE JavaScript bundle |
| GET | `/ide.css` | Monaco IDE styles |
| GET | `/ide-agent.js` | AI chat panel JS |
| GET | `/ide-agent.css` | AI chat panel CSS |

### Agent Service (proxied)

| Method | Path | Description |
|---|---|---|
| POST | `/agent/register` | Register a new sandbox with the agent |
| POST | `/agent/chat` | Single-shot AI chat |
| WS | `/agent/ws` | Streaming AI chat over WebSocket |
| POST | `/agent/suggest` | Get suggestions for a specific file |
| GET | `/agent/providers` | List AI provider availability |
| GET | `/agent/health` | Agent service health check |

---

## 8. Port & Network Map

| Service | Port | Protocol | Description |
|---|---|---|---|
| Go Core Server | `9000` | HTTP / WS | Main entry point for all requests |
| Agent Service (Node.js) | `8001` | HTTP / WS | AI agent backend (internal only) |
| Sandbox Containers | `dynamic` | HTTP | Apps run on randomly assigned host ports (typically 10000–65000) |

All sandbox ports are bound to `0.0.0.0:<port>` on the host and mapped to the container's internal port.

---

## 9. Technology Specifications

### Go Backend

| Item | Value |
|---|---|
| Language | Go 1.25 |
| Module | `sandbox` |
| Key dependencies | `github.com/gorilla/websocket v1.5.3`, `github.com/creack/pty v1.1.24` |
| Build output | Single static binary (`sandbox-runner.exe`) |
| Embed | `index.html`, `ide.js`, `ide.css`, `ide-agent.js`, `ide-agent.css` |

### Agent Service (Node.js)

| Item | Value |
|---|---|
| Runtime | Node.js (ESM modules) |
| Framework | Express 4 + `ws` WebSocket server |
| AI library | `gitclaw` (agentic execution loop) |
| Default model | `anthropic:claude-sonnet-4-6` |

### Agent Service (Python)

| Item | Value |
|---|---|
| Runtime | Python 3.x |
| Framework | FastAPI + uvicorn |
| HTTP client | `httpx` (async) |
| Config | `python-dotenv` (`.env` file) |
| AI providers | Anthropic, OpenAI (multi-provider, key-based) |

### Frontend

| Item | Value |
|---|---|
| Editor | Monaco Editor (VS Code engine, CDN) |
| Terminal | xterm.js + xterm-addon-fit |
| Styling | Vanilla CSS (no framework) |
| Transport | Fetch API + native WebSocket |

---

## 10. Configuration & Environment

Copy `.env.example` to `.env` in the project root:

```env
# AI Provider Keys (add whichever you have)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Agent model override (optional) — global default for every provider
GITCLAW_MODEL=anthropic:claude-sonnet-4-6

# Per-provider model overrides (optional) — map the UI's provider selector to a
# gitclaw model id. The agent auto-selects the first provider that has a key,
# preferring Groq, so with only GROQ_API_KEY set it uses the Groq model below.
AGENT_MODEL_GROQ=groq:llama-3.3-70b-versatile
AGENT_MODEL_ANTHROPIC=anthropic:claude-sonnet-4-5
AGENT_MODEL_OPENAI=openai:gpt-4.1
AGENT_MODEL_GEMINI=google:gemini-2.0-flash

# Go backend URL for Python agent (default: http://127.0.0.1:9000)
GO_BACKEND_URL=http://127.0.0.1:9000

# Agent service port (default: 8001)
AGENT_PORT=8001
```

**Required for full functionality:**
- **Docker Desktop** must be running
- At least one AI provider key in `.env` for the AI agent features

---

## 11. Supported Stacks

| Stack | Auto-Detected By | Image | Internal Port |
|---|---|---|---|
| Static HTML/CSS/JS | `index.html` at root | `sandbox-static` | 80 |
| Node.js / Express | `package.json` + `server.js` / `index.js` | `sandbox-node` | 3000 |
| React (CRA) | `react` in dependencies, `start` script | `sandbox-react` | 3000 |
| React (Vite) | `vite` in devDependencies | `sandbox-react` | 5173 |
| Next.js | `next` in dependencies | `sandbox-react` | 3000 |
| Vue / Nuxt | README keyword `vue` | `sandbox-node` | 5173 |
| Flask | `flask` in requirements.txt | `sandbox-python` | 5000 |
| FastAPI | `fastapi` in requirements.txt | `sandbox-python` | 8000 |
| Django | `manage.py` presence | `sandbox-python` | 8000 |
| Go | `go.mod` presence | `sandbox-go` | 8080 |
| Rust | `Cargo.toml` presence | `sandbox-rust` | 8080 |
| Java (Maven) | `pom.xml` presence | `sandbox-java` | 8080 |
| Java (Gradle) | `build.gradle` presence | `sandbox-java` | 8080 |
| PHP | `composer.json` presence | `sandbox-php` | 80 |
| Ruby / Rails | `Gemfile` presence | `sandbox-ruby` | 3000 |
| .NET / C# | `*.csproj` presence | `sandbox-dotnet` | 5000 |
| Deno | INSTRUCTIONS keyword | `sandbox-deno` | 8000 |
| Bun | INSTRUCTIONS keyword | `sandbox-bun` | 3000 |
| Lyzr Apps | `workflow.json` / `response_schemas/` | `sandbox-react` | 3000 |

Lyzr Apps are recognized by `detectLyzrRepo()` and run as **Next.js** projects (installs deps, runs the Next.js dev server bound to `0.0.0.0`). The detected framework is carried on `RuntimeConfig.Framework` → `Sandbox.Framework`, surfaced via `/sandbox/status`, and shown in the IDE as a badge next to the repo name (e.g. "Next.js (Lyzr App)"). Other stacks get a friendly label from `frameworkFromImage()`.

---

## 12. Security Model

| Concern | Mitigation |
|---|---|
| **Container isolation** | Each repo runs in its own Docker container with strict resource limits (CPU, RAM, PIDs) |
| **Filesystem isolation** | Only `/workspace` is mounted; host filesystem is not accessible |
| **Path traversal** | All file API endpoints validate that the resolved absolute path starts with `sb.Workdir` before any read/write |
| **Resource exhaustion** | `--memory 1024m`, `--cpus 1`, `--pids-limit 100` enforced at container start |
| **Auto-cleanup** | Containers are automatically stopped and removed after 10 minutes; workspace temp dirs are deleted |
| **No credentials in code** | API keys loaded from `.env` file, never hardcoded |
| **CORS** | All API endpoints return `Access-Control-Allow-Origin: *` (suitable for local development) |

---

## 13. Sandbox Lifecycle

```
[REQUESTED]
     │  POST /run
     ▼
[CLONING]      git clone --depth 1 <repo>
     │
     ▼
[DETECTING]    detectRuntimeConfig()
     │
     ▼
[SPECIFYING]   GenerateAgentSpec() → agent.yaml, SOUL.md, RULES.md, skills/
     │
     ▼
[STARTING]     docker run -d ...
     │
     ▼
[WAITING]      waitForServer() — polls HTTP for up to 300s
     │
     ▼
[READY]        iframe loads, IDE opens, AI agent binds
     │
     │  (10 minutes)
     ▼
[EXPIRED]      docker stop → docker rm → cleanup workdir
               OR user clicks Stop button → POST /stop/:container
```

---

*Jr Architect — Built with Go, Docker, Monaco Editor, xterm.js, and gitclaw.*
