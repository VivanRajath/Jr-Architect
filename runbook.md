# Runbook: Running Jr Architect

This runbook provides step-by-step instructions on how to set up, build, and run the **Jr Architect** sandbox runner environment. It also addresses common command errors and explains how to configure the agent services.

---

## Prerequisites

Before running the project, ensure you have the following installed and running on your system:

1. **Docker Desktop**: Must be running. The application spins up isolated Docker containers for executing cloned repositories.
2. **Go**: Version 1.22+ (preferably 1.25+).
3. **Node.js**: Required for the default AI agent service.
4. **API Keys**: a `GROQ_API_KEY` (free — https://console.groq.com) is enough to power both Build Mode and the IDE coding agent. Anthropic/OpenAI/Gemini keys are optional alternatives for the agent.

---

## Step 1: Environment Configuration

Copy the `.env.example` file to `.env` in the root of the project:

```bash
copy .env.example .env
```

Open `.env` and fill in your API keys:

```env
# AI Provider Keys (add whichever you have)
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...

# Groq keys for Build Mode app generation (one, or several comma-separated for
# higher throughput across the free-tier per-org rate limit)
GROQ_API_KEY=gsk_...
# GROQ_API_KEYS=gsk_a,gsk_b,gsk_c

# Per-provider agent model overrides (optional). The IDE agent auto-selects the
# first provider that has a key, preferring Groq — so a Groq-only setup needs
# none of these. GITCLAW_MODEL can force one model but is ignored if its
# provider has no key.
# AGENT_MODEL_GROQ=groq:llama-3.3-70b-versatile
# AGENT_MODEL_ANTHROPIC=anthropic:claude-sonnet-4-5
# AGENT_MODEL_OPENAI=openai:gpt-4.1
# AGENT_MODEL_GEMINI=google:gemini-2.0-flash
# GITCLAW_MODEL=
```

> [!IMPORTANT]
> A single `GROQ_API_KEY` powers **both** Build Mode and the IDE coding agent — that's the simplest setup. `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY` are optional alternatives for the agent.
>
> The panel's provider dropdown defaults to **Groq** and just overrides the auto-selection. Picking a provider whose key is missing safely falls back to an available one instead of erroring, and if no provider key is set at all the panel shows a clear "configure a key" message rather than crashing the agent service.

---

## Step 2: Install Agent Service Dependencies

The AI coding agent uses a Node.js companion service located in the `agent-services` folder. You must install its dependencies before starting the Go backend:

```bash
cd agent-services
npm install
cd ..
```

---

## Step 3: Run the Project

There are two ways to run the project: using `go run` or compiling a binary.

### Option A: Using `go run` (Development)

To run the project directly from source, run:

```bash
go run .
```

> [!WARNING]
> **Why did `go run main.go` fail?**  
> In Go, if a package consists of multiple source files (in this case `main.go`, `detector.go`, and `gitagentgenerator.go`), running only `go run main.go` compiles `main.go` in isolation. This leads to undefined symbol errors (e.g. `undefined: detectRuntimeConfig`). Using `go run .` tells Go to compile all `.go` files in the current directory.

---

### Option B: Compiling and Running the Binary (Production/Local Execution)

1. **Build the binary:**
   ```bash
   go build -o sandbox-runner.exe .
   ```

2. **Execute the binary:**
   - **In PowerShell:**
     ```powershell
     .\sandbox-runner.exe
     ```
   - **In CMD:**
     ```cmd
     sandbox-runner.exe
     ```

> [!WARNING]
> **Why did running `sandbox-runner.exe` directly fail in PowerShell?**  
> PowerShell does not load executable commands from the current working directory by default for security reasons. You must prefix it with `.\` (i.e. `.\sandbox-runner.exe`) to explicitly tell PowerShell to run it from the current directory.

---

## Step 4: Access the Application

Once the server starts up:
1. It will output `Sandbox server running on http://localhost:9000`.
2. It will automatically build (preheat) the sandbox Docker images in the background if they don't already exist.
3. Open your browser and navigate to: **[http://localhost:9000](http://localhost:9000)**

---

## The AI Agent Panel (streaming)

The agent panel talks to the Node agent service over a WebSocket at `/agent/ws`, which the Go server reverse-proxies to `127.0.0.1:8001`. Responses stream live: text appears token-by-token, and each action the agent takes (edit, run, read, search) shows as its own row. When the agent edits files, the file tree, open editors, and live preview refresh automatically once the turn finishes.

**How to tell it's working:** send a prompt like *"add a comment to the top of README"* — you should see a `write README.md` tool row appear mid-stream, and the file tree/editor update when it completes.

**Asking questions about the repo (code retrieval):** the agent starts each turn already knowing the codebase's shape. At clone time a **repo map** is generated (`knowledge/repo-map.md` — stack, layout, UI entry point; `knowledge/repo-map-full.md` — every file with its exported symbols) and injected/exposed via gitclaw's knowledge loader. The agent also has a **`search_code`** tool (ripgrep-style, no external binary) to find where a symbol or string is defined/used and pull back only the matching `file:line` snippets. So *"summarize the auth flow"* or *"where is the login handled?"* works without you pointing it at files. This is agentic retrieval, not vector RAG — chosen because Groq's free tier has no embeddings API and a tight token budget, and code structure locates things better than semantic similarity. Enable/disable via `AGENT_ALLOWED_TOOLS` (includes `search_code` by default).

**Ask & Edit modes (why it's reliable on free-tier llama-3.3):** `llama-3.3-70b-versatile` is weak at *calling* tools, so neither asking nor editing uses the tool loop — the backend does the tool-work and the model only writes text.
- **Questions** ("summarize…", "where is…", "what does…") → the backend searches the repo, injects the results (and the entry file's contents for overviews), and the model writes a grounded answer.
- **Changes** ("change the theme to dark", "add a footer", "fix…") → the backend picks the right small file(s) — the UI entry and style files first, never library boilerplate like `components/ui/*` — the model returns each changed file's **complete updated contents** in one block, and the **backend overwrites** it and reloads the preview. The model never calls a `write` tool *and* never emits fragile SEARCH/REPLACE patch markers (which `llama-3.3` garbles) — whole-file rewrite is what a weak model does most reliably, and a reply truncated by the output cap simply won't parse (no half-written file is saved). You'll get a summary like `Applied 1 change(s): - app/page.tsx — edited`.

**Intelligent routing (the Orchestrator layer):** routing is automatic and no longer pure keyword-matching. Obvious cases are decided free by heuristics (an edit verb → edit; a question opener like "summarize/where/how" → ask). Genuinely ambiguous messages that change files without an obvious verb — "rebrand the heading", "swap the two buttons", "the hero text should say Launch" — are classified by a one-word **LLM router call**, so they reach Edit mode instead of being answered as a question. You can always override with the **Ask/Edit/Agent dropdown** in the composer. The `[agent] chat …` log shows the chosen `mode=ask` / `mode=edit` / `mode=agent`.

The edit path is the layered pipeline (**Orchestrator → Complexity Classifier → Guardrails → Developer**), and each layer's decision streams into the chat as a step. Its result is a **clickable file list** — click any edited/created file to open a **before/after diff** in a modal. Edit mode only rewrites files small enough to fit the output budget (`WHOLE_FILE_MAX_CHARS`); for a change in a large file, name a specific smaller file or split it into a smaller step. To use the old tool-driven path (only worth it with a strong tool-calling model), set `AGENT_EDIT_STRATEGY=agentic`.

**Summaries don't hedge:** overview questions ("summarize this codespace") feed the model the repo map plus the entry, layout, and README/package files, with an instruction to write a concrete summary now — not to describe what it *would* look at.

> **On matching Cursor/Antigravity:** those use frontier models (Claude/GPT-4-class). On Groq's free tier the only tool-capable model is `llama-3.3-70b-versatile`, which is much weaker — the whole-file design gets it as reliable as it can be for focused, one-file changes, but it won't plan sweeping multi-file refactors. For that, point `AGENT_MODEL_GROQ` at a stronger model your account has, or set `AGENT_MODEL_ANTHROPIC`/`_OPENAI` with a paid key — the agent auto-uses whichever provider has a key.

**If the agent panel shows "Agent service unavailable":**
* The Node service didn't start. Ensure you ran `npm install` in `agent-services` (Step 2), then restart the Go server — it launches the service on `:8001` as a subprocess and logs `[agent-service] started (pid …) on port 8001`.
* The panel automatically falls back to a single-shot REST chat (with "Apply to file" buttons) if the WebSocket can't be established, so partial functionality remains.

**If edits don't reflect in the IDE:** the auto-reload skips open tabs that have **unsaved** changes (to avoid clobbering your work) and shows a toast instead — save or close the tab and it will pick up the agent's version.

**If the agent replies with an error (or nothing):** a failed model call now surfaces in the chat as an error message instead of leaving the panel spinning. The agent is intentionally limited to the core tools (`cli, read, write, memory`); set `AGENT_ALLOWED_TOOLS` to change that.

**`413 Request too large ... tokens per minute (TPM): Limit 12000, Requested 33889`:** Groq's free tier counts input **plus reserved output** against a 12k-tokens/minute limit. The actual prompt here is only ~1.9k tokens — the culprit was the agent stack reserving the model's full 32k output window, so a turn billed ~34k/min. The service now caps output at `AGENT_MAX_OUTPUT_TOKENS` (default 3000) via the model registry, so a turn bills ~input+3000. Raise `AGENT_MAX_OUTPUT_TOKENS` on a paid Groq tier for longer replies. (A large repo `AGENTS.md` is also moved aside as `AGENTS.md.sandbox-bak` to keep the prompt itself small.)

**`tool call validation failed: attempted to call tool 'cli {...}' which was not in request.tools`:** `llama-3.3-70b-versatile` (the tool-capable model on Groq's free tier) intermittently produces a malformed tool call — arguments jammed into the tool name — which Groq rejects. Because it's non-deterministic, the agent **retries the turn on a fresh key** (up to `AGENT_TOOLCALL_RETRIES`, default 2), so it usually recovers within a couple of attempts; the retries also spread across your Groq keys/orgs. If it persists, set `AGENT_MODEL_GROQ` to a steadier tool model your account has (e.g. `groq:meta-llama/llama-4-scout-17b-16e-instruct`).

---

## The Live Preview

The preview waits for your app to actually be up. Right after launching a repo it shows **"Starting your app…"** while dependencies install and the dev server boots, then loads (and auto-opens) once the app's port responds — so you no longer see a dead "connection refused" page from loading too early. If it stays on "Starting…" for a long time, check the **setup logs** / terminal: the app itself may have failed to install or start (that's a container/app issue, not the preview).

**Live reload:** edits you save in the IDE reflect in the preview automatically. Next.js/CRA apps hot-reload in place (containers run with `WATCHPACK_POLLING`/`CHOKIDAR_USEPOLLING` so the in-container watcher sees host-side saves — inotify events don't cross a Docker bind mount on Windows/macOS). Vite and static sites don't hot-reload through the mount, so the preview auto-reloads on save instead. Live reload only applies to **newly created** sandboxes — rebuild/restart to pick up the env vars.

**Locate UI code from the preview:** hover the diamond/code icon floating on the preview to highlight which folder the app's UI lives in (in the file tree); click it to open that file in the editor. The entry file is resolved by `GET /sandbox/entry` (common candidates like `app/page.tsx`, `src/App.tsx`, `index.html`).

---

## Note: the frontend is embedded

`index.html`, `ide.js`, `ide.css`, `ide-agent.js`, and `ide-agent.css` are compiled into the Go binary via `go:embed`. **Any change to those files requires rebuilding** (`go run .` or `go build`) and a **hard-refresh** in the browser (Ctrl+Shift+R) to take effect — a plain reload will serve the previously embedded copy.

---

## Troubleshooting & Notes

* **Docker Errors**: If you get errors about Docker commands, make sure the Docker daemon/Docker Desktop is running on your machine.
* **Terminal shows "Waiting for the sandbox container to start…"**: this is expected right after launching a repo — the container is created asynchronously (after clone + runtime detection), and the terminal now waits for it to be running before attaching a shell instead of failing with "No such container". It attaches automatically once the container is up (or reports a clear message if the container exits or doesn't start within ~2 minutes).
* **Cleanup**: Sandboxes run inside temporary workspace folders on your host filesystem and inside Docker containers. The Go server has a **10-minute Auto-Cleanup** loop that stops and deletes the containers and their temporary workspaces. You can also manually stop sandboxes using the UI.
* **Verifying without the full stack**: the WebSocket transport and Build Mode guards have Go tests — `go test -run 'TestAgentProxyTunnelsWebSocket|TestThirdPartyRefs' .` exercises the reverse-proxy WS tunnel and the local-app import guard without needing Docker or API keys.
