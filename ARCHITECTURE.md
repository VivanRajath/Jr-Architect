# Jr Architect — End-to-End Architecture & Specification

> **Jr Architect** is a self-hosted, AI-augmented cloud IDE that spins up isolated Docker sandbox environments for any Git repository. It auto-detects the runtime stack, launches the app in a container, and gives you a full in-browser IDE — with a file explorer, Monaco code editor, live preview, WebSocket terminal, and an AI coding agent — all from a single binary.

---

## Table of Contents

1. [High-Level Overview](#1-high-level-overview)
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

---

### 3.4 Agent Service — Node.js (`agent-services/server.js`)

A lightweight **Express + WebSocket** server that drives the `gitclaw` agentic execution loop.

| Endpoint | Method | Description |
|---|---|---|
| `/agent/register` | POST | Stores a `container → { dir, stack, clients }` session map entry |
| `/agent/chat` | POST | Single-shot REST chat — streams `gitclaw.query()` and returns full response |
| WebSocket | WS | Persistent connection for streaming agent responses |

**WebSocket protocol:**

```
Client → Server:
  { type: "bind",  container: "sandbox-abc" }          // attach to a sandbox
  { type: "chat",  container: "sandbox-abc", message: "..." }  // send a prompt

Server → Client:
  { type: "thinking"    }        // agent started
  { type: "delta",      content: "partial text..." }   // streaming token
  { type: "tool",       content: "write_file({...})" } // tool invocation
  { type: "file_changed" }       // triggers UI to refresh preview iframe
  { type: "done"        }        // turn complete
  { type: "error",      content: "..." }
```

The `gitclaw` library reads `agent.yaml` from the workspace and runs the full agentic loop (read → think → tool calls → commit → respond).

**Default model:** `anthropic:claude-sonnet-4-6` (overridable via `GITCLAW_MODEL` env var)

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
| **Live Preview** | `<iframe>` pointed at `http://localhost:<dynamic-port>`. Reload button. Status indicator. |
| **File Explorer** | Tree view of the workspace fetched from `/files`. Expand/collapse directories. Click to open files. |
| **Monaco Editor** | Full VS Code-grade editor embedded via CDN. Language auto-detection from file extension. Syntax highlighting. Save with `Ctrl+S` → `POST /file/save`. |
| **Terminal** | xterm.js WebSocket terminal connected to `/terminal/ws`. Full PTY — interactive shells, autocomplete, color output. |
| **Status Bar** | Shows container name, repo URL, sandbox state (cloning / starting / ready). |

---

### 3.7 AI Agent Chat Panel (`ide-agent.js`, `ide-agent.css`)

A collapsible side panel that provides the AI coding assistant UI:

- Connects to the agent service over WebSocket (`/agent/ws` proxied through Go)
- Sends `bind` message on sandbox load to attach to the correct session
- Streams token-by-token responses with a typing indicator
- Shows tool invocations (file reads/writes) in a distinct "tool call" bubble
- Triggers preview iframe reload on `file_changed` events
- Supports dark/light mode toggle

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
| GET | `/status` | `?container=` | `{ container, port, repo, status, url }` |

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

# Agent model override (optional)
GITCLAW_MODEL=anthropic:claude-sonnet-4-6

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
