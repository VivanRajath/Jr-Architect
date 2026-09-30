# Agent Hub

Agent Hub (`/hub.html`) is where you build and manage agents. Agent Studio (`/studio.html`) opens in its own window to create or edit one.

Your model. Your agents. Your tools. Your guardrails. Your repository.

## The agent definition

An agent is a structured definition, not a prompt:

- identity, purpose, responsibilities and instructions
- model
- tools
- context (knowledge and examples)
- memory
- guardrails
- permissions
- input schema and output schema
- human approval points
- runtime limits

The system prompt is derived from the definition on every run (Studio's Prompt tab shows it), so the two cannot drift apart.

Each agent is its own git repository in gitagent layout, stored under `JR_HUB_DIR` (default `~/.jr-architect/agent-hub/<user hash>/agents/<id>`):

| File | Role |
| --- | --- |
| `agent.yaml` | gitagent manifest; the full definition sits under `jr:` and is the source of truth |
| `SOUL.md`, `RULES.md` | generated views, readable by other gitagent tools |

Every save is a commit with a version bump (0.1.0, 0.1.1, ...). Versions can be compared field by field and restored; a restore is saved as a new version.

Run records and memory notes live beside the repository in `state/`. They are not versioned.

## Two ways to build

- **Custom Agent.** You fill in every section. Validation runs as you type:
  - Errors block a run, for example a tool without permissions, or a provider with no key.
  - Warnings are advice.
- **Agent Builder.** You describe the job in plain English and the model suggests every section, each with a reason.
  - Sections that change what the agent may do (tools, permissions, guardrails, human approval, memory) must each be accepted or skipped before you continue.
  - Nothing is saved until you save.
- **Improve** (both modes). Plain-English feedback such as "make it stricter" returns a field-level diff that you apply or discard. Applied changes can be undone.

## Runtime

A run gives the model native functions:

- the agent's own tools (`repo_read`, `web_fetch`, `memory_save`)
- `submit_answer`

Every function call goes through the Jr runtime, so the definition is enforced whatever the model asks for:

- **Tools.** Only the agent's tools are offered.
- **Permissions.** They are re-checked on every call:
  - `repo.read` reads only the listed public repositories.
  - `web.fetch` is HTTPS-only, limited to the listed domains, and follows redirects hop by hop.
  - Private addresses are refused whenever `JR_PUBLIC_ORIGIN` is set.
- **Input.** It is validated against the input schema before the model is called.
- **Output.** It is validated against the output schema. A wrong answer gets one correction round.
- **Guardrails.**
  - Blocked terms and secret detection stop a run on its input, tool results and output.
  - Rules go into the prompt.
- **Human approval.**
  - A listed tool pauses the run before it executes.
  - An approved output is held until someone decides.
  - A run can be resumed from the Hub or over the API.
- **Limits.** Each run has a step budget and one total timeout. Each user gets two concurrent runs and the hourly AI limit.

## n8n

Jr Architect runs the agent; n8n runs the workflow. Here is how to connect one:

1. In the Hub, open an agent, go to **n8n**, and click **Connect**. The token is shown once; only its hash is stored.
2. Download the ready-made n8n workflow (Manual Trigger, HTTP Request, If), or add your own HTTP Request node.

Call the agent like this:

```
POST /hooks/agents/<id>/run
Authorization: Bearer <token>
{"input": {...}, "callbackUrl": "<optional>", "wait": true}
```

The response contains:

- `status`: `completed`, `awaiting_approval`, `failed`, `rejected` or `blocked`
- `output`
- `steps`

An approval pause returns `202` with a `decisionUrl`; POST `{"approved": true}` to it to resume the run. `callbackUrl` (for example an n8n Wait node's resume URL) is called when a paused run ends. `"wait": false` returns at once, and you poll `GET /hooks/agents/<id>/runs/<runId>` for the result.

`/hooks/agents/` is the only path that skips the beta-code login. The token can run only its own agent. Go limits each IP to 30 calls a minute, with bodies capped at 256 KB.

## Workflows (visual editor)

Hub → **Workflows** opens a canvas editor at `/flows.html`, much like n8n. Here is how you use it:

- **Add nodes.** Drag them from the palette onto the canvas. Clicking a palette item instead adds it after the selected node and wires it in.
- **Connect nodes.** Drag from a node's right dot to another node.
- **Remove things.** Click a node or a connection and press Delete.
- **Move around.** Scroll to zoom and drag the background to pan.

| Node | What it does |
| --- | --- |
| Trigger | Starts the run, from the Run button (with test input) or the webhook |
| Agent | Runs a Hub agent through the normal runtime. Its tools, permissions, guardrails and approvals all apply |
| If | Sends the item to the `true` or `false` port |
| Set fields | Builds a new JSON item |
| Human approval | Pauses the run; it continues from `approved` or `rejected` |
| HTTP request | Calls a public HTTPS URL, for example a Slack webhook. Private addresses are refused on a public server |
| Output | The result returned to the caller |

**Expressions.** Any setting can use `{{ $json.field }}` for the incoming item or `{{ $node["Name"].json.field }}` for an earlier node's result. They are path lookups only, never code.

**Pausing.** A pause anywhere pauses the whole run: an approval node, or an approval inside an agent. You resume it from the banner on the canvas or over the API.

**Versions and runs.** Each user's workflows live in one git repository (`workflows/<id>.json`), and every save is a version. Runs are kept under `wfstate/`. The Executions panel shows them on the canvas.

**Limits.**

- 40 nodes
- 50 node executions per run, which also stops loops
- 5 minutes per run

### Webhook

The Webhook panel issues a `jrw_` token that only runs that workflow. Agent tokens cannot run workflows.

```
POST /hooks/workflows/<id>/run
Authorization: Bearer <token>
{"input": {...}, "callbackUrl": "<optional>"}
```

The call returns one of two responses:

- **`200`** with the run's `status` and `output`, when the run finishes.
- **`202`** with `pending`, when the run is waiting for approval. Resume it with `POST /hooks/workflows/<id>/runs/<runId>/decision` and a body of `{"approved": true}`.
