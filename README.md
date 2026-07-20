# Jr Architect

Jr Architect is a sandbox-based development environment that automatically runs GitHub repositories.This was Inspired by Architect by Lyzr not a viable product just a Learning product. The goal of the project was to run Apps built by Architect by Lyzr and stress test them and also  simulate a lightweight AI-assisted developer workspace that can analyze a repository, determine how to run it, and execute the application inside an isolated sandbox which I think would be an extension of Architect.

This project is built as an experimental developer tool and side project inspired by modern AI-assisted coding environments.

## Overview

Modern repositories often require manual setup before running. Developers usually need to inspect project structure, install dependencies, and determine correct run commands.

Jr Architect simplifies this workflow by automatically performing these steps.

### Workflow:

User provides GitHub Repository URL
        ↓
Repository is cloned
        ↓
Project structure is analyzed
        ↓
Run instructions are generated or detected
        ↓
Application runs inside sandbox
        ↓
Preview or development environment is provided

## Features

### Repository Execution
Runs public GitHub repositories inside a sandbox environment.
*   Accepts GitHub repository URLs
*   Automatically clones repositories
*   Detects project structure
*   Executes application based on detected commands

### Dual Execution Modes

#### Prompt Mode
Prompt mode focuses on simple execution.
1.  Clone repository
2.  Detect instructions
3.  Run application automatically
4.  Show output preview
This mode hides the IDE and prioritizes quick execution.

#### Dev Mode
Dev mode behaves like a lightweight cloud IDE.
*   Repository cloned and loaded
*   Monaco editor interface
*   Background sandbox execution
*   Live preview of the application
*   Interactive development environment

### AI Agent (Agentic)
The IDE ships with a built-in coding agent that works *inside* the running sandbox — not a chat sidebar that only suggests code.
*   **Live streaming** — responses stream token-by-token over a WebSocket (`/agent/ws`), reverse-proxied through the Go server so it shares the IDE's origin.
*   **Visible tool use** — every action the agent takes renders as its own row (edit, run, read, search, delete) with the target file/command, so you can watch it work.
*   **Self-updating IDE** — when the agent edits files, the file tree, open editor tabs, and the live preview refresh automatically at the end of the turn (unsaved edits in open tabs are never clobbered).
*   **Provider selector** — Anthropic (default), OpenAI, or Gemini, mapped to a model per provider.
*   **Graceful fallback** — if the streaming socket can't connect, it falls back to a single-shot REST chat with "Apply to file" buttons.

### Build Mode
Describe an app in plain language and Jr Architect scaffolds a working, **fully-local** Next.js app (no backend, no third-party services). It answers a few clarifying questions, generates a PRD, then generates and runs the app in a sandbox. Generated apps persist user data in the browser (`localStorage`) and are guarded against pulling in third-party integrations (Gmail, OAuth, Stripe, external APIs) — ideal for local tools like a resume builder, invoice generator, or habit tracker.

## Instruction System

Jr Architect supports an instruction-driven execution system. Repositories may include a file named: `INSTRUCTIONS.md`. Each line in the file is interpreted as a shell command.

**Example:**
```bash
npm install
npm run dev
```

If the file exists, the sandbox will execute the commands sequentially. If it does not exist, Jr Architect attempts to infer run commands automatically.

## Project Architecture

The system follows a modular architecture:
User Interface → Repository Manager → Instruction Detector → Sandbox Runner → Execution Environment → Live Preview / IDE

### Main components:

| Component | Description |
| :--- | :--- |
| **Repository Manager** | Handles cloning and repository access |
| **Instruction Detector** | Reads instructions or detects run commands |
| **Sandbox Runner** | Executes commands inside sandbox |
| **Execution Environment** | Isolated environment for running apps |
| **Preview System** | Displays running application |

## Sandbox Execution

Applications run inside a controlled sandbox environment.
Responsibilities of the sandbox:
*   Execute repository commands
*   Isolate runtime processes
*   Capture logs
*   Prevent system interference

The sandbox is designed to safely run unknown repositories.

## Supported Project Types

Jr Architect attempts to detect common project structures.

| Project Type | Detection File |
| :--- | :--- |
| Node.js | package.json |
| Python | requirements.txt |
| Go | go.mod |
| Java | pom.xml |

Based on these files, the system generates run commands automatically.

## Example Workflow

User provides repository: `https://github.com/example/project`

Execution process:
1. Clone repository
2. Check for `INSTRUCTIONS.md`
   - **If found:** execute commands
   - **Else:** detect project type
3. Install dependencies
4. Start application
5. Display preview

## Setup

1.  Clone the repository:
    ```bash
    git clone https://github.com/VivanRajath/Jr-Architect.git
    cd Jr-Architect
    ```
2.  Copy `.env.example` to `.env` and set the keys you have (e.g. `ANTHROPIC_API_KEY` for the AI agent, `GROQ_API_KEY` / `GROQ_API_KEYS` for Build Mode).
3.  Install the AI agent service dependencies (needed for the agent panel):
    ```bash
    cd agent-services && npm install && cd ..
    ```
4.  Run the application (Docker Desktop must be running):
    ```bash
    go run .
    ```
    The Go server starts on port `9000` and launches the Node agent service on `8001` automatically.

> **Note:** the frontend (`index.html`, `ide.js`, `ide.css`, `ide-agent.js`, `ide-agent.css`) is embedded into the Go binary with `go:embed`, so any frontend change requires a rebuild (`go run .` / `go build`) and a browser hard-refresh.

## Goals of the Project

This project explores ideas around:
*   AI assisted development environments
*   Automated repository execution
*   Sandbox based application testing
*   Developer productivity tools

The goal is experimentation and learning rather than building a commercial product.

## Future Improvements

*   Automatic run command detection using AI
*   Container based sandboxing
*   Resource isolation
*   Multi-language runtime support
*   Agent based repository analysis
*   Automated environment setup

## Footnote

This project is developed purely as a side project and is not intended to be a commercially viable product. The name “Jr Architect” is simply a placeholder, inspired by “Architect” by Lyzr, and does not imply any official association.

All repositories that are cloned or used by Jr Architect are publicly available on GitHub (github.com).

## Author

**Vivan Rajath**

[GitHub](https://github.com/VivanRajath)