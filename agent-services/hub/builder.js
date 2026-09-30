// Agent Builder and Improve: the model suggests, the user decides; nothing here saves anything.
import { collectTurn, parseJsonLoose, toollessAgentHome, modelFor, AGENT_MAX_OUTPUT_TOKENS } from "../llm.js";
import {
  normalizeDefinition, diffDefinitions, TOOL_CATALOG, SECTIONS, MEMORY_MODES,
} from "./definition.js";

let turn = (prompt, model) => collectTurn({
  prompt, dir: toollessAgentHome(), model, replaceBuiltinTools: true, allowedTools: [], constraints: { maxTokens: AGENT_MAX_OUTPUT_TOKENS },
}, model);
export function _setBuilderTurnForTests(fn) { turn = fn; }

// The tool list is data for the design; some models otherwise try to call those names as functions.
const NO_CALLS = "You cannot call any functions or tools yourself. Answer with the JSON text only.";

const TOOLS_TEXT = Object.entries(TOOL_CATALOG).map(([id, t]) => `- ${id}: ${t.description}`).join("\n");

const SHAPE = `{
  "identity": {"name": "short name", "description": "one sentence", "tags": ["..."]},
  "purpose": "what the agent is for, 1-3 sentences",
  "responsibilities": ["one duty per item"],
  "instructions": "numbered, concrete instructions the agent follows",
  "model": {"provider": "groq", "maxOutputTokens": 1500},
  "tools": ["tool ids from the list, only if truly needed"],
  "context": {"knowledge": "facts the agent needs that are not in the input", "examples": [{"input": "...", "output": "..."}]},
  "memory": {"mode": "${MEMORY_MODES.join("|")}"},
  "guardrails": {"rules": ["things it must never do"], "blockedTerms": [], "blockSecrets": true},
  "permissions": {"repos": ["owner/name"], "domains": ["example.com"]},
  "inputSchema": {"type": "object", "properties": {"field": {"type": "string", "description": "..."}}, "required": ["field"]},
  "outputSchema": {"type": "object", "properties": {"field": {"type": "string"}}, "required": ["field"]},
  "humanInTheLoop": {"approveOutput": true, "approveTools": [], "instructions": ""},
  "runtime": {"maxSteps": 4, "timeoutSeconds": 60, "outputFormat": "json"}
}`;

export function buildDraftPrompt(description) {
  return [
    "You design AI agents for people who know the outcome they want but not how to build an agent.",
    `The user wants:\n"""${String(description).slice(0, 4000)}"""`,
    "Design the agent. This runtime can only do what these tools allow:",
    TOOLS_TEXT,
    "Anything outside those tools (sending email, posting to Slack, writing to a database) is done by the workflow that calls the agent, for example n8n. The agent then returns a structured draft or decision and does not perform the action itself. Say so in the explanations when it applies.",
    "Most agents need no tools. Add one only if the job itself requires reading a GitHub repository, fetching a web page, or remembering facts across runs; set its permissions (repos or domains) to the narrowest list that works.",
    "Put a human approval point wherever the user mentions approval, sending, deleting, paying, publishing or anything irreversible.",
    `Reply with ONLY one JSON object:\n{"definition": ${SHAPE},\n "explanations": {"<section name>": "why you chose this, one or two plain sentences"},\n "edgeCases": ["situations the agent must handle"],\n "questions": ["things only the user can decide, if any"]}`,
    `Section names for explanations: ${SECTIONS.join(", ")}.`,
    NO_CALLS,
  ].join("\n\n");
}

export async function draftAgent(description, provider) {
  const model = modelFor(provider);
  const { text, error } = await turn(buildDraftPrompt(description), model);
  const parsed = parseJsonLoose(text);
  if (!parsed || !parsed.definition) throw Object.assign(new Error(error ? `the model failed: ${error.slice(0, 160)}` : "the model did not return a usable design; try rephrasing"), { status: 502 });
  const definition = normalizeDefinition(parsed.definition);
  const explanations = {};
  for (const s of SECTIONS) {
    const e = parsed.explanations && parsed.explanations[s];
    if (typeof e === "string" && e.trim()) explanations[s] = e.trim().slice(0, 600);
  }
  const list = (v) => (Array.isArray(v) ? v : []).map((x) => String(x).trim().slice(0, 300)).filter(Boolean).slice(0, 12);
  return { definition, explanations, edgeCases: list(parsed.edgeCases), questions: list(parsed.questions) };
}

export function buildRefinePrompt(definition, feedback) {
  const d = normalizeDefinition(definition);
  delete d.id;
  delete d.version;
  return [
    "You improve an existing AI agent definition based on the user's feedback.",
    `Current definition:\n${JSON.stringify(d, null, 2)}`,
    `User feedback:\n"""${String(feedback).slice(0, 2000)}"""`,
    "Change only what the feedback asks for. Prefer precise, testable instructions and rules over vague ones.",
    "If the feedback asks for approval before an action, set humanInTheLoop (approveOutput or approveTools) as well as the wording.",
    `Tools you may reference:\n${TOOLS_TEXT}`,
    `Reply with ONLY one JSON object:\n{"changes": {"<section name>": <the full new value of that section>}, "summary": "what you changed and why, 1-3 sentences", "notes": ["anything the user should double-check"]}`,
    `Section names: ${SECTIONS.join(", ")}. Include only the sections you change.`,
    NO_CALLS,
  ].join("\n\n");
}

export async function refineAgent(definition, feedback, provider) {
  const model = modelFor(provider);
  const { text, error } = await turn(buildRefinePrompt(definition, feedback), model);
  const parsed = parseJsonLoose(text);
  if (!parsed || !parsed.changes || typeof parsed.changes !== "object") {
    throw Object.assign(new Error(error ? `the model failed: ${error.slice(0, 160)}` : "the model did not return usable changes; try rephrasing"), { status: 502 });
  }
  return applyChanges(definition, parsed.changes, parsed.summary, parsed.notes);
}

// Only whole known sections are replaced, then everything is re-normalized, so a reply cannot add fields or tools that do not exist.
export function applyChanges(definition, changes, summary, notes) {
  const base = normalizeDefinition(definition);
  const merged = { ...base };
  for (const [k, v] of Object.entries(changes || {})) if (SECTIONS.includes(k)) merged[k] = v;
  const proposed = normalizeDefinition(merged);
  proposed.id = base.id;
  proposed.version = base.version;
  return {
    proposed,
    diff: diffDefinitions(base, proposed),
    summary: String(summary || "").slice(0, 800),
    notes: (Array.isArray(notes) ? notes : []).map((n) => String(n).slice(0, 300)).slice(0, 8),
  };
}
