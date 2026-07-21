# Jr Architect

Jr Architect is a self-hosted, AI-guided cloud IDE. You paste a GitHub URL and it clones the repository, detects the runtime stack, and runs the app inside an isolated Docker sandbox, giving you a full in-browser development environment: a file explorer, a Monaco code editor, a live preview, and a real terminal. It can also scaffold a brand new app from a plain-language description.

The AI coding agent is a first-class feature of the IDE, not a chat box bolted onto the side. It reads the repository, decides how to answer or how to change the code, applies edits directly to the workspace, and refreshes the editor and preview so you see the result immediately.

This is an experimental developer tool and learning project. The name "Jr Architect" is a placeholder and does not imply any official association.

## Overview

Running an unfamiliar repository usually means inspecting the project layout, installing dependencies, and figuring out the right commands. Jr Architect does that work for you and then hands you a workspace you can actually build in.

The flow is:

1. You provide a GitHub repository URL, or a description of an app you want.
2. The repository is cloned into an isolated workspace (or a new app is generated).
3. The project structure is analyzed and the runtime stack is detected.
4. Run instructions are detected or generated.
5. The application starts inside a Docker sandbox.
6. A live preview and, in Dev Mode, a full IDE are provided.

## The Three Modes

Jr Architect has three top-level modes, selected on the landing screen.

### Prompt Mode

Prompt Mode is for a quick run. You give it a repository URL and it clones, detects instructions, starts the application, and shows the output preview. The IDE is hidden so you get to a running app as fast as possible. Use this when you only want to see a repository running.

### Dev Mode

Dev Mode turns the sandbox into a full cloud IDE. The repository is cloned and loaded, the app runs in the background, and you get:

- A file explorer with a right-click context menu (new file, new folder, rename, delete, copy path, and "Ask AI about this file"), styled after VS Code.
- A Monaco editor with syntax highlighting, tabs, and save to the sandbox.
- A live preview that waits for the app to actually be ready before loading, then reloads automatically as you edit.
- A WebSocket terminal attached to the container, with a full interactive shell.
- The built-in AI coding agent (described below).

Use this when you want to read, edit, and iterate on a project.

### Build Mode

Build Mode scaffolds a working app from a plain-language description. You describe what you want, it asks a few clarifying questions, generates a short product spec, then generates the app and runs it in a sandbox. Generated apps are fully local: they persist data in the browser and are guarded against pulling in third-party services such as OAuth, payment providers, or external APIs. This is well suited to local tools like a resume builder, an invoice generator, or a habit tracker.

## The AI Agent and Its Prompt Modes

Inside Dev Mode, the agent panel is a live agentic stream. Responses stream in as they are produced, and each action the agent takes appears as its own row so you can watch it work. When the agent changes files, the file tree, open editors, and live preview refresh at the end of the turn, and unsaved changes in open tabs are never overwritten.

The agent runs your message in one of three prompt modes. An Orchestrator decides which mode fits your message, and you can override it with the Ask, Edit, or Agent dropdown in the composer.

### Ask

Ask handles questions about the repository, for example "summarize this codespace", "where is login handled", or "what does this component do". The backend does the retrieval: it searches the code, gathers the repository map and the key files, and gives the model a grounded, tool-free prompt. The model only has to write the answer. Summaries describe the real code and do not hedge or narrate a process.

### Edit

Edit handles changes, for example "make the UI dark red", "rebrand the heading to Re-work", or "add a footer". It runs a layered engine modeled on the gitagent standard:

1. Orchestrator: routes the message to editing.
2. Complexity Classifier: decides how much scope the change needs and how many files may be rewritten.
3. Guardrails: refuses edits to sensitive or generated files and blocks any attempt to introduce a secret.
4. Developer: rewrites the relevant file or files in full and applies the change to disk.

Each layer's decision streams into the chat as a step, so the work reads as a real engine rather than a chat reply. The result is shown as a clickable list of changed files. Click any file to open a before-and-after diff.

### Agent

Agent is the original tool-driven loop, where the model calls the read, write, and search tools itself. It is only reliable with a strong tool-calling model, so it is opt-in.

### Why the modes exist

The default model on the free tier is a capable text model but a weak tool-caller. Ask and Edit deliberately keep the model out of the function-calling path: the backend does the tool work and the model only generates text, which is what it does well. That is what makes questions and edits reliable without a premium model. If you configure a stronger provider, you can lean on Agent mode for open-ended, multi-file work.

## Instruction System

A repository can include an `INSTRUCTIONS.md` file. Each line is run as a shell command, in order.

```bash
npm install
npm run dev
```

If the file is present, the sandbox runs those commands. If it is not, Jr Architect detects the stack and infers the run commands.

## Supported Project Types

Jr Architect detects common stacks and generates run commands automatically.

| Project type | Detection file |
| :--- | :--- |
| Node.js | package.json |
| Python | requirements.txt |
| Go | go.mod |
| Java | pom.xml |

Sandbox images also cover React, Next.js, Vite, static sites, PHP, Ruby, Rust, .NET, Deno, and Bun. See ARCHITECTURE.md for the full list.

## Architecture at a Glance

A single Go binary serves the embedded IDE on port 9000, manages the Docker sandbox lifecycle, and reverse-proxies agent traffic. It launches a Node agent service on port 8001 that runs the Ask, Edit, and Agent prompt modes. Each sandbox is a resource-limited Docker container with the cloned workspace mounted in. Full detail is in ARCHITECTURE.md.

## Setup

1. Clone the repository:
   ```bash
   git clone https://github.com/VivanRajath/Jr-Architect.git
   cd Jr-Architect
   ```
2. Copy `.env.example` to `.env` and set the keys you have. A single `GROQ_API_KEY` (free from the Groq console) powers both the AI agent and Build Mode. Several comma-separated keys in `GROQ_API_KEYS` raise throughput against the free-tier per-organization limit. `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, and `GEMINI_API_KEY` are optional stronger providers for the agent.
3. Install the agent service dependencies:
   ```bash
   cd agent-services && npm install && cd ..
   ```
4. Run the application (Docker Desktop must be running):
   ```bash
   go run .
   ```
   The Go server starts on port 9000 and launches the Node agent service on port 8001 automatically. Open http://localhost:9000.

> Note: the frontend (`index.html`, `ide.js`, `ide.css`, `ide-agent.js`, `ide-agent.css`) is embedded into the Go binary with `go:embed`, so any frontend change requires a rebuild (`go run .` or `go build`) and a browser hard-refresh.

## Configuration

The agent auto-selects the first provider that has a key, preferring Groq, so a Groq-only setup needs no extra configuration. Useful environment variables:

| Variable | Purpose |
| :--- | :--- |
| `GROQ_API_KEY` / `GROQ_API_KEYS` | Groq key, or several comma-separated keys for higher throughput. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` | Optional stronger providers for the agent. |
| `AGENT_MAX_OUTPUT_TOKENS` | Caps the model's reserved output so a turn stays under the Groq free-tier limit (default 3000). |
| `AGENT_EDIT_STRATEGY` | Set to `agentic` to route edits through the tool-driven Agent loop instead of the layered Edit engine. |

## Goals

This project explores AI-guided development environments, automated repository execution, safe sandboxing of unknown code, and developer productivity. It is built for experimentation and learning, not as a commercial product.

## Footnote

All repositories cloned or run by Jr Architect are publicly available on GitHub. The name is a placeholder inspired by the idea of an assistant that helps you architect and run software, and implies no official association.

## Author

**Vivan Rajath**

[GitHub](https://github.com/VivanRajath)
