# Jr Architect

A self-hosted, AI-guided cloud IDE that runs any GitHub repository inside an isolated Docker sandbox and lets you edit it with a built-in coding agent.

Prompt-to-app builders are good at producing a first version. The moment a developer needs a real change, they clone the repo and leave for VS Code, Cursor, or Claude Code, and the builder loses them right when the work gets interesting. Jr Architect closes that gap. It takes a generated repository (or any repository) and opens it in a full cloud IDE, running live, with an AI agent that edits the code in place, so iteration stays in one environment instead of scattering across local tools.



## Contents

- [What it does](#what-it-does)
- [How it works](#how-it-works)
- [The agent design](#the-agent-design)
- [GitAgent integration](#gitagent-integration)
- [Engineering highlights](#engineering-highlights)
- [Modes](#modes)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Documentation](#documentation)

## What it does

- **Sandboxed Docker runtime.** Every repository runs in its own resource-limited container (1 CPU, 1 GB RAM, 100 PIDs, 10-minute auto-cleanup). Unknown code is isolated from the host.
- **Runtime auto-detection.** Paste a GitHub URL and it clones the repo, detects the stack (Node, Python, React, Go, static, and more), installs dependencies, and starts the app with no manual configuration.
- **Monaco editor.** The VS Code editor in the browser, with a file tree, tabs, syntax highlighting, a right-click context menu, and save straight to the sandbox.
- **WebSocket terminal.** A real interactive shell attached to the running container, tunneled through the Go server.
- **Self-healing live preview.** The preview waits for the app to actually boot, then stays in sync as you and the agent edit. Changed files are re-written through the container so the dev server recompiles even across Docker's bind-mount cache boundary, where a plain host-side write would leave the preview stale. No premature connection-refused pages, no manual restarts.
- **AI coding agent.** Three modes: **Ask** (grounded answers about the repo), **Edit** (a layered pipeline that applies changes directly and shows them as clickable before/after diffs with an explicit Apply control), and **Agent** (a tool-driven loop for stronger models).
- **A self-diagnosing IDE.** When the app is slow to boot or the logs show an error, a built-in build doctor reads the container logs, tells a genuine failure from noise, and proposes a single safe fix, applied in one click. The IDE troubleshoots itself.
- **GitAgent standard, end to end.** Every repository becomes its own versioned agent: identity, rules, memory, and a full `skills` / `tools` / `hooks` / `workflows` / `compliance` tree scaffolded at clone time. The built-in developer personas are editable skill files, and community agents from the GitAgent registry plug straight into the edit pipeline. See [GitAgent integration](#gitagent-integration).
- **Build Mode (experimental).** Scaffold a small, fully local app from a plain-language description and run it immediately in the same IDE.

## How it works

A single Go binary serves the entire IDE (embedded with `go:embed`), manages the Docker sandbox lifecycle (`docker run` / `exec`), relays the terminal over WebSocket, and reverse-proxies agent traffic to a small Node companion service. There is no frontend build step and nothing to deploy separately.

```
Browser
   |
   v
Go binary (port 9000)                Node agent service (port 8001)
   - embedded IDE (go:embed)            - Ask / Edit / Agent modes
   - Docker sandbox lifecycle           - repo map + code search (retrieval)
   - WebSocket terminal relay   ----->  - whole-file rewrite (edits)
   - /agent/* reverse proxy
   |
   v
Docker sandbox (cloned repo, CPU/RAM/PID limited, 10-min TTL)
```

When a repository is launched, a **repo map** is generated at clone time (stack, layout, UI entry point, and every file with its exported symbols). That map is injected into the agent so it starts each turn already knowing the shape of the codebase, and a ripgrep-style `search_code` tool lets it pull back only the `file:line` snippets it needs. This is agentic retrieval rather than vector RAG, chosen deliberately: the free tier has no embeddings API and a tight token budget, and for code, structure locates things more precisely than semantic similarity.

## The agent design

One design choice is worth calling out, because it is what makes the agent reliable on a free model.

The default model on the free tier (`llama-3.3-70b-versatile`) is a capable text generator but a weak tool-caller. So the Ask and Edit paths keep the model out of the function-calling loop entirely. The backend does the retrieval and applies the changes; the model only produces text.

- **Ask** searches the repo, injects the results (and the entry file for overview questions), and the model writes a grounded answer. It is instructed to answer concretely, not to describe what it would look at.
- **Edit** runs a layered pipeline, **Orchestrator to Complexity Classifier to Guardrails to Developer**, and streams each layer's decision into the chat as a step. The Orchestrator routes the message (free heuristics for obvious cases, a one-word LLM classifier for genuinely ambiguous ones like "rebrand the heading"). Guardrails block edits to sensitive files and secret injection. The Developer layer returns each changed file's complete updated contents, and the backend overwrites the file and reloads the preview. The result is a clickable file list; click any file to open a before/after diff in a modal.

Whole-file rewrite is used instead of SEARCH/REPLACE patch markers because a weak model garbles fragile patch syntax, and a reply truncated by the output cap simply fails to parse (no half-written file is ever saved). When a stronger provider is configured, the tool-driven Agent loop is available instead (`AGENT_EDIT_STRATEGY=agentic`).

For the reasoning behind each of these decisions, and the trade-offs against frontier-model tools like Cursor and Antigravity, see [ARCHITECTURE.md](ARCHITECTURE.md).

## GitAgent integration

Jr Architect is inspired by Lyzr's **Architect** and is built on the **GitAgent standard**, the open, git-native agent specification from Lyzr Research Labs (registry at [registry.gitagent.sh](https://registry.gitagent.sh)). The premise of GitAgent is simple and powerful: an agent's identity, rules, skills, and memory are plain files committed to a repository, so the agent is versioned and travels with the code. Jr Architect is a runtime for that standard, a GitAgent adapter, so it runs agents defined this way, including agents published to the registry, against a live repository inside the sandbox.

It shows up in three ways.

**Every repository becomes its own agent.** When a repo is cloned, Jr Architect scaffolds a full GitAgent spec grouped under `.gitagent/`, following the standard layout:

```
.gitagent/
  agent.yaml        manifest: model, tools, runtime
  SOUL.md           identity
  RULES.md          must and never rules
  MEMORY.md         durable facts, seeded from the detected stack and a real entry file
  skills/           how this repo is edited: ui-editor, jnr-developer, snr-developer,
                    architect, ask, build-doctor
  compliance/       the guardrails the edit pipeline enforces
  tools/  hooks/  workflows/    the rest of the standard, made explicit
```

Before the agent changes anything, the edit pipeline reads this spec, so edits obey the repository's own memory, rules, and skills. Add "never touch pricing.ts" to `RULES.md` and the next edit respects it. Because the spec lives in git, the repo's agent is versioned with the code, and a repo that commits its own customized spec is never overwritten on re-clone. (The engine also keeps a copy of `agent.yaml` at the repo root, where the git-native runtime reads its manifest.)

**The platform's own agents are editable skills, not hidden prompts.** The built-in developer personas, the Junior and Senior Developer, the Architect, the Ask persona, and the Build Doctor, are real `SKILL.md` files under `.gitagent/skills/`. The chat agent reads them as the source of truth: edit `skills/snr-developer/SKILL.md` and the next multi-file change behaves differently. If a skill file is missing, a built-in default keeps everything working. You can author a new skill from the IDE and it joins the pipeline immediately. There is no separate, invisible system prompt. The folder is the system.

**Install community agents from the registry.** A GitAgent panel in the IDE browses the registry and drops a published agent into a pipeline slot. The edit pipeline has named slots, Developer (rewrites the code) and Guardrails (can block an edit). A registry agent categorized `developer-tools` fills the Developer slot; `security` or `compliance` agents stack into Guardrails. Assigning writes `.gitagent/pipeline.json` and live-clones the agent into the sandbox, so the next edit runs as that agent, including Lyzr's own published agents such as `shreyas-lyzr/architect`.

These layers compose. The repo's own spec is the base identity that always applies; installed skills and registry agents layer on top; guardrails and compliance combine so that a deny always wins, with the hard secret and lockfile checks enforced in code regardless of any file. Jr Architect honors the standard's universal `system-prompt` adapter, which is why any registry agent can drive a slot without new engine code: the agent's persona and rules become the system prompt of the same reliable, toolless edit engine.

An honest note on scope: the `system-prompt` adapter runs an agent's identity, rules, and skills on whatever model you have configured. It makes the agent run and comply, but it does not upgrade the underlying model, so on the free tier the reasoning ceiling is the free model's. Point a stronger provider key at it and it benefits fully.

## Engineering highlights

A short tour of the harder problems this project solves, and how.

- **Reliable editing on a free-tier model.** `llama-3.3-70b-versatile` is a strong text generator but a weak tool-caller, so the Ask and Edit paths keep the model out of the function-calling loop entirely. The backend retrieves and applies; the model only writes text. Whole-file rewrites replace fragile patch syntax, so a reply truncated by the token cap fails to parse instead of corrupting a file.
- **Agentic retrieval instead of vector RAG.** A repo map (stack, layout, entry point, exported symbols) is generated at clone time and injected into every turn, with a ripgrep-style `search_code` tool for `file:line` snippets. Chosen deliberately: the free tier has no embeddings API, and for code, structure locates things more precisely than semantic similarity.
- **A layered edit pipeline modeled as agent squads.** Orchestrator, Complexity Classifier, Guardrails, Developer. Each layer's decision streams into the chat as a step, and the Complexity Classifier selects the Junior or Senior developer skill for the change. The pipeline decides how to code, not just what to answer.
- **A self-diagnosing IDE.** The build doctor reads the container logs, distinguishes a real failure from noise (deprecation warnings, a slow but successful install), and proposes a single safe fix: a command to run, or an edit routed through the guardrailed pipeline. One click applies it.
- **A live preview that survives the Docker boundary.** A dev server inside the container does not reliably see host-side file writes, because a bind mount serves the container a cached view. Jr Architect re-writes each changed file through the container itself, refreshing the exact filesystem layer the dev server reads from and forcing a correct recompile, so an edit shows up in the preview instead of silently going stale.
- **Faster cold starts.** Dependency installs skip npm's audit and funding network round-trips and prefer the mounted package cache, which is what dominated a cold install.
- **Isolation and safety by default.** Every repo runs in a resource-limited container with a short TTL, sensitive paths and secret injection are blocked before any write, and all agent traffic is reverse-proxied through a single Go process.

## Modes

Jr Architect has three entry points, chosen on the landing screen.

- **Prompt Mode.** Paste a URL and get the app running fast, with no IDE. For when you only want to see a repository run.
- **Dev Mode.** The full cloud IDE described above: editor, terminal, live preview, and the agent.
- **Build Mode (experimental).** Scaffolds a small, fully local app from a plain-language description. This is an experiment for exercising the generate-then-edit loop end to end, guarded against third-party integrations, not a general-purpose app builder.

## Getting started

Requires Docker Desktop (running), Go 1.22+, and Node.js.

1. Clone and enter the repository:
   ```bash
   git clone https://github.com/VivanRajath/Jr-Architect.git
   cd Jr-Architect
   ```
2. Copy `.env.example` to `.env` and add a key. A single free `GROQ_API_KEY` (from https://console.groq.com) powers both the agent and Build Mode.
3. Install the agent service dependencies:
   ```bash
   cd agent-services && npm install && cd ..
   ```
4. Run it (Docker Desktop must be running):
   ```bash
   go run .
   ```
   The server starts on port 9000 and launches the agent service on 8001 automatically. Open http://localhost:9000.

Run `go run .`, not `go run main.go`. The package spans several files, and naming one file compiles it in isolation and fails. Full setup, build, and troubleshooting steps are in the [runbook](runbook.md).

## Configuration

The agent auto-selects the first provider that has a key, preferring Groq, so a Groq-only setup needs no extra configuration.

| Variable | Purpose |
| :--- | :--- |
| `GROQ_API_KEY` / `GROQ_API_KEYS` | Groq key, or several comma-separated keys for higher free-tier throughput. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Optional stronger providers for the agent. |
| `AGENT_MAX_OUTPUT_TOKENS` | Caps reserved output so a turn stays under the Groq free-tier limit (default 3000). |
| `AGENT_EDIT_STRATEGY` | Set to `agentic` to route edits through the tool-driven Agent loop instead of the default Edit engine. |
| `AGENT_MODEL_GROQ` / `_ANTHROPIC` / `_OPENAI` / `_GEMINI` | Override the model used per provider. |

The frontend (`index.html`, `ide.js`, `ide.css`, `ide-agent.js`, `ide-agent.css`) is embedded into the Go binary with `go:embed`, so any frontend change requires a rebuild (`go run .` or `go build`) and a browser hard-refresh (Ctrl+Shift+R).

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)**: the end-to-end system design, covering the component breakdown, request lifecycle, runtime detection, the agent pipeline, the API reference, the port and network map, and the security model.
- **[runbook.md](runbook.md)**: step-by-step setup, build, and run instructions, plus troubleshooting for the common errors (Docker, PowerShell execution, Groq rate limits, the agent panel, and live preview).

## Note

Jr Architect is an independent prototype and is not affiliated with any company.

## Author

**Vivan Rajath** ([GitHub](https://github.com/VivanRajath))
