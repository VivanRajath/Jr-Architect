# Verifying the container-boundary fixes

Three defects were fixed in the working tree. This is how to run the project and
what to watch for so you can tell each fix actually holds — not just that the
build is green.

| # | Defect | Fix |
|---|--------|-----|
| 1 | Agent file writes reached the container only because the *browser* called `/sandbox/sync`. | The agent service writes every change through the container itself, before it reports the change to anyone. |
| 2 | In `agent` mode the model's shell (`cli`) ran on the **host**, in the untrusted clone. | `cli` is out; a `shell` tool runs `docker exec` inside the sandbox container. |
| 3 | `/terminal/exec` had no timeout, no output cap, and returned 200 on failure. | `core.ExecInContainer` — bounded time and output, real exit code, JSON result. |

---

## Before you start

- **Docker Desktop must be running.** Fixes 1 and 3 are unobservable without it, and one of the Go tests skips itself when Docker is absent.
- `npm install` has been run in `agent-services/`.
- At least one provider key is set (`GROQ_API_KEY` or `ANTHROPIC_API_KEY`) in `.env` — the agent paths need it.

## Run it

```powershell
go run .
```

Not `go run main.go` — that compiles one file in isolation and never links `internal/`.

`web/js/*` is compiled in via `go:embed`, so any frontend change needs a **rebuild plus a hard refresh** (Ctrl+Shift+R). If you're checking fix 3's UI half and the doctor still behaves the old way, that's the reason nine times out of ten.

**On startup, observe:**

```
[agent-service] started (pid …) on port 8001
Sandbox server running on http://127.0.0.1:9000
```

If the agent service line is missing, everything below that involves the agent will fail for an unrelated reason.

Then open http://localhost:9000 and launch a sandbox on any Node/Next repo.

---

## Check 3 first — bounded exec

Do this one first: it needs no model, no keys, and it's the primitive the other
two ride on.

Get a container name:

```powershell
Invoke-RestMethod http://127.0.0.1:9000/sandboxes
```

Then, with `$c` set to one of those names:

```powershell
$body = @{ container = $c; command = "exit 7" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9000/terminal/exec -ContentType application/json -Body $body
```

**Observe:**

- `exitCode` is **7**, not 0. This is the whole point of the fix — before, a failing command was indistinguishable from a successful one.
- `command = "pwd"` returns `/workspace`, not a host path. The `-w /workspace` is what puts the agent in the right place.
- `command = "sleep 5"` with `timeoutMs = 2000` returns `timedOut: true` and `exitCode: 124` after ~2s — **not** after 5s, and not never.
- `command = "yes | head -c 2000000"` returns `truncated: true`, and the output you get back is the **tail**, opening with `…[output truncated]…`. Tail matters: a build failure's message is at the end.
- `command = "   "` returns HTTP **400**, not a 200 with an empty body.

**Failure signals:** any of these hanging past ~2 minutes, or a 200 with an
empty body, means the handler is not going through `core.ExecInContainer`.

### The UI half

In the IDE, get the build doctor to propose a command fix (easiest: launch a repo
with a broken install so the logs show an error), then click **Run in terminal**.

**Observe:**

- On a command that fails, the toast says **Command failed** and the output block ends with `[exit N]`.
- The button reads **Retry** and is **clickable**. It used to disable itself precisely when you'd want to retry.
- On success the button reads **Ran** and is disabled.

---

## Check 1 — the container write-through

This is the fix that matters most, and the browser will lie to you about it if
you only test in the IDE — the old code path worked *there*. Test the REST path,
which had no browser to save it.

With the sandbox running and its dev server up (preview showing the app):

```powershell
$body = @{ container = $c; message = "change the heading text to VERIFY-ONE" } | ConvertTo-Json
Invoke-RestMethod -Method Post -Uri http://127.0.0.1:9000/agent/chat -ContentType application/json -Body $body
```

Note: **no browser involved** — no WebSocket, no `file_changed` frame, nothing
calling `/sandbox/sync`.

**Observe, in this order:**

1. The response reports the file as edited.
2. In the Go console, the sandbox's dev server logs a **recompile** within a second or two (`compiling /`, `hmr update`, or your stack's equivalent).
3. `curl http://127.0.0.1:<sandbox port>` — or opening it in a browser — serves the **new** text.

Step 2 is the actual signal. Step 3 can pass by accident on a stack that doesn't
cache aggressively; a recompile in the log means the container genuinely saw the
write.

**Failure signal:** the file changed on disk (check the editor or `type` the
file) but the served page still shows the old text and nothing recompiled. That
is the original bug, back.

Also worth confirming, since these were separate code paths:

- **Guardrail fix** — get a pack to deny an edit, click **Fix**, watch for the same recompile.
- **Guardrail override** — same, via **Override** with a reason.
- **Agent mode** — see below.

### Double-check the browser path didn't regress

Do a normal edit through the chat panel in the IDE.

**Observe:** the preview updates exactly as it did before. The browser no longer
sends `/sandbox/sync` — `revealChangesInPreview()` only reloads now — so if the
preview updates, the server-side sync is doing the work. If it *stopped*
updating, the server-side sync isn't firing on that path.

Watch for **one** recompile per edit, not two. Two means something is still
double-syncing.

---

## Check 2 — the agent's shell is inside the container

Agent mode is opt-in:

```powershell
$env:AGENT_EDIT_STRATEGY = "agentic"
go run .
```

Then in the chat panel ask something that forces a shell call — *"run `pwd` and
`ls -la`, then tell me what you see"*.

**Observe:**

- The tool step in the chat reads `shell(...)`, **not** `cli(...)`.
- `pwd` returns `/workspace`.
- `ls` shows the repo as the container sees it. Compare with the host workdir — if you see Windows paths, `C:\Users\...`, or `AppData\Local\Temp\`, the shell escaped the container and the fix is not in effect.
- Ask it to run `hostname` — it should be the container id, not your machine name.

**Also observe:** if the agent writes a file in this mode, the preview still
recompiles. That's the `write`-tool sync path (`writtenPathFrom`), which is
separate from the edit-pipeline sync and easy to miss.

**Negative check:** in the agent's tool list, `cli` should be absent. If a model
still tries to call `cli`, it will be rejected as an unknown tool rather than
silently running on your machine — that rejection is the correct behaviour, not
a regression.

---

## Automated tests

```powershell
go test ./...
cd agent-services; node --test
```

**Observe:** `TestTerminalExecReportsExitCode` should **run**, not skip. It skips
itself when Docker isn't available, and a skip looks like a pass in the summary —
check the `-v` output if you want to be sure:

```powershell
go test ./internal/server/ -run TestTerminalExec -v
```

Node should report 83 passing, including `writtenPathFrom finds the target of a
write tool call` and `makeShellTool refuses to run without a bound container`.

---

## Things that are expected, not bugs

- **Every `shell` call marks the workspace dirty.** `shell` is in `WRITE_TOOLS`, so the file tree and preview refresh after an `ls`. That was true of `cli` before; it's noise, not breakage.
- **`shell` returns a friendly error, not a crash, when the Go host is unreachable.** Running the agent service standalone (no `go run .`) gives `shell: could not run the command (…)`. Correct — it must never fall back to the host.
- **The 10-minute sandbox TTL still tears everything down.** Unrelated to these fixes, and still the reason long-running work is impossible. It's Phase 3 in the audit.

## Things that would mean a regression

- A command that fails returning `exitCode: 0`.
- `pwd` in the agent's shell returning anything other than `/workspace`.
- An edit through `/agent/chat` that never recompiles.
- The IDE preview no longer updating after a chat edit.
- `go vet ./...` reporting anything — it was clean.
