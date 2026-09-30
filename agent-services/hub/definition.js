// The structured Jr-Architect agent definition: the source of truth; the system prompt and gitagent files are derived from it.
import yaml from "js-yaml";
import { providerHasKey, PROVIDER_MODELS, AGENT_MAX_OUTPUT_TOKENS } from "../llm.js";

export const DEF_API_VERSION = 1;
export const MAX_DEF_BYTES = 64 * 1024;
export const MAX_STEPS_CAP = 8;
export const MAX_TIMEOUT_CAP = 120;

// Every tool the runtime can execute; an agent may only name these.
export const TOOL_CATALOG = {
  "repo.read": {
    label: "Read a GitHub repository",
    description: "Lists folders and reads files of a public GitHub repository. Read-only.",
    permission: "repos",
    args: { repo: "owner/name", path: "folder or file path, empty for the root" },
  },
  "web.fetch": {
    label: "Fetch a web page",
    description: "HTTPS GET of a page on an allowed domain, returned as text. Read-only.",
    permission: "domains",
    args: { url: "https URL on an allowed domain" },
  },
  "memory.save": {
    label: "Save a memory note",
    description: "Stores a short note that later runs of this agent see. Needs persistent memory.",
    permission: "memory",
    args: { note: "one short fact worth remembering" },
  },
};

export const MEMORY_MODES = ["none", "run", "persistent"];
export const OUTPUT_FORMATS = ["json", "text"];
const SCHEMA_TYPES = ["string", "number", "integer", "boolean", "object", "array"];

// The sections Studio edits, Builder suggests and Improve may change.
export const SECTIONS = [
  "identity", "purpose", "responsibilities", "instructions", "model", "tools", "context",
  "memory", "guardrails", "permissions", "inputSchema", "outputSchema", "humanInTheLoop", "runtime",
];

const str = (v, max = 4000) => (typeof v === "string" ? v : v == null ? "" : String(v)).trim().slice(0, max);
const strList = (v, maxItems = 30, max = 400) =>
  (Array.isArray(v) ? v : typeof v === "string" && v.trim() ? v.split("\n") : [])
    .map((x) => str(typeof x === "object" && x ? x.rule || x.text || x.name || "" : x, max).replace(/^[-*]\s+/, ""))
    .filter(Boolean).slice(0, maxItems);
const int = (v, def, min, max) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function slugify(s) {
  return str(s, 80).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "agent";
}

export function defaultDefinition(name = "New agent") {
  return {
    apiVersion: DEF_API_VERSION,
    id: "",
    version: "0.1.0",
    identity: { name, description: "", tags: [] },
    purpose: "",
    responsibilities: [],
    instructions: "",
    model: { provider: "groq", name: "", maxOutputTokens: 1500 },
    tools: [],
    context: { knowledge: "", examples: [] },
    memory: { mode: "none", maxNotes: 30 },
    guardrails: { rules: [], blockedTerms: [], blockSecrets: true },
    permissions: { repos: [], domains: [] },
    inputSchema: { type: "object", properties: { task: { type: "string", description: "What to do" } }, required: ["task"] },
    outputSchema: { type: "object", properties: { result: { type: "string" } }, required: ["result"] },
    humanInTheLoop: { approveOutput: false, approveTools: [], instructions: "" },
    runtime: { maxSteps: 4, timeoutSeconds: 90, outputFormat: "json" },
  };
}

// Keeps only what the schema-subset validator understands, so a model or an import cannot smuggle in odd shapes.
export function normalizeSchema(s, depth = 0) {
  if (!s || typeof s !== "object" || depth > 4) return { type: "string" };
  const type = SCHEMA_TYPES.includes(s.type) ? s.type : "string";
  const out = { type };
  if (s.description) out.description = str(s.description, 300);
  if (Array.isArray(s.enum)) out.enum = s.enum.filter((x) => ["string", "number", "boolean"].includes(typeof x)).slice(0, 30);
  if (type === "object") {
    out.properties = {};
    const props = s.properties && typeof s.properties === "object" ? s.properties : {};
    for (const [k, v] of Object.entries(props).slice(0, 40)) {
      const key = str(k, 60);
      if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(key)) out.properties[key] = normalizeSchema(v, depth + 1);
    }
    out.required = (Array.isArray(s.required) ? s.required : []).filter((k) => k in out.properties);
  }
  if (type === "array") out.items = normalizeSchema(s.items || { type: "string" }, depth + 1);
  return out;
}

// Accepts anything (a draft from the UI, a model's suggestion, an import) and returns a well-formed definition.
export function normalizeDefinition(input) {
  const d = input && typeof input === "object" ? input : {};
  const base = defaultDefinition();
  const identity = d.identity && typeof d.identity === "object" ? d.identity : {};
  const model = d.model && typeof d.model === "object" ? d.model : {};
  const context = d.context && typeof d.context === "object" ? d.context : {};
  const memory = d.memory && typeof d.memory === "object" ? d.memory : {};
  const guard = d.guardrails && typeof d.guardrails === "object" && !Array.isArray(d.guardrails) ? d.guardrails : { rules: d.guardrails };
  const perm = d.permissions && typeof d.permissions === "object" ? d.permissions : {};
  const hitl = d.humanInTheLoop && typeof d.humanInTheLoop === "object" ? d.humanInTheLoop : {};
  const runtime = d.runtime && typeof d.runtime === "object" ? d.runtime : {};
  const provider = str(model.provider, 20).toLowerCase();

  const tools = [];
  for (const t of Array.isArray(d.tools) ? d.tools : []) {
    const id = str(typeof t === "string" ? t : t && t.id, 40);
    if (TOOL_CATALOG[id] && !tools.some((x) => x.id === id)) tools.push({ id });
  }
  const toolIds = tools.map((t) => t.id);

  return {
    apiVersion: DEF_API_VERSION,
    id: /^[a-z0-9][a-z0-9-]{0,47}$/.test(d.id || "") ? d.id : "",
    version: /^\d+\.\d+\.\d+$/.test(d.version || "") ? d.version : base.version,
    identity: {
      name: str(identity.name, 80) || str(d.name, 80) || base.identity.name,
      description: str(identity.description ?? d.description, 400),
      tags: strList(identity.tags, 10, 30).map((t) => t.toLowerCase()),
    },
    purpose: str(d.purpose, 1500),
    responsibilities: strList(d.responsibilities, 20, 300),
    instructions: str(d.instructions, 8000),
    model: {
      provider: PROVIDER_MODELS[provider] ? provider : base.model.provider,
      name: str(model.name, 100),
      maxOutputTokens: int(model.maxOutputTokens, base.model.maxOutputTokens, 200, AGENT_MAX_OUTPUT_TOKENS),
    },
    tools,
    context: {
      knowledge: str(context.knowledge, 12000),
      examples: (Array.isArray(context.examples) ? context.examples : []).slice(0, 5)
        .map((e) => ({ input: str(e && e.input, 2000), output: str(e && e.output, 2000) }))
        .filter((e) => e.input || e.output),
    },
    memory: {
      mode: MEMORY_MODES.includes(memory.mode) ? memory.mode : "none",
      maxNotes: int(memory.maxNotes, 30, 1, 100),
    },
    guardrails: {
      rules: strList(guard.rules, 30, 400),
      blockedTerms: strList(guard.blockedTerms, 30, 80),
      blockSecrets: guard.blockSecrets !== false,
    },
    permissions: {
      repos: strList(perm.repos, 20, 120).filter((r) => r === "*" || /^[\w.-]+\/[\w.-]+$/.test(r)),
      domains: strList(perm.domains, 20, 120).map((x) => x.toLowerCase().replace(/^https?:\/\//, "").replace(/\/.*$/, ""))
        .filter((x) => /^[a-z0-9.-]+\.[a-z]{2,}$/.test(x)),
    },
    inputSchema: normalizeSchema(d.inputSchema || base.inputSchema),
    outputSchema: normalizeSchema(d.outputSchema || base.outputSchema),
    humanInTheLoop: {
      approveOutput: !!hitl.approveOutput,
      approveTools: strList(hitl.approveTools, 10, 40).filter((t) => toolIds.includes(t)),
      instructions: str(hitl.instructions, 1000),
    },
    runtime: {
      maxSteps: int(runtime.maxSteps, base.runtime.maxSteps, 1, MAX_STEPS_CAP),
      timeoutSeconds: int(runtime.timeoutSeconds, base.runtime.timeoutSeconds, 10, MAX_TIMEOUT_CAP),
      outputFormat: OUTPUT_FORMATS.includes(runtime.outputFormat) ? runtime.outputFormat : "json",
    },
  };
}

// Errors block a save; warnings are advice the user may ignore.
export function validateDefinition(def) {
  const errors = [];
  const warnings = [];
  const d = normalizeDefinition(def);
  if (!d.identity.name || d.identity.name === "New agent") warnings.push({ section: "identity", message: "Give the agent a specific name." });
  if (!d.purpose) errors.push({ section: "purpose", message: "Say what the agent is for." });
  if (!d.instructions && !d.responsibilities.length) errors.push({ section: "instructions", message: "Add instructions or at least one responsibility." });
  if (!providerHasKey(d.model.provider)) {
    errors.push({ section: "model", message: `No API key is configured for ${d.model.provider} on this server.` });
  }
  for (const t of d.tools) {
    const need = TOOL_CATALOG[t.id].permission;
    if (need === "repos" && !d.permissions.repos.length) errors.push({ section: "permissions", message: `${t.id} needs at least one allowed repository (or * for any public repo).` });
    if (need === "domains" && !d.permissions.domains.length) errors.push({ section: "permissions", message: `${t.id} needs at least one allowed domain.` });
    if (need === "memory" && d.memory.mode !== "persistent") errors.push({ section: "memory", message: "memory.save needs persistent memory." });
  }
  if (d.permissions.repos.length && !d.tools.some((t) => t.id === "repo.read")) warnings.push({ section: "permissions", message: "Repositories are allowed but repo.read is not enabled." });
  if (d.permissions.domains.length && !d.tools.some((t) => t.id === "web.fetch")) warnings.push({ section: "permissions", message: "Domains are allowed but web.fetch is not enabled." });
  if (d.permissions.repos.includes("*")) warnings.push({ section: "permissions", message: "repo.read may read any public repository." });
  if (d.tools.length && d.runtime.maxSteps < 2) warnings.push({ section: "runtime", message: "With tools, allow at least 2 steps: one to call a tool, one to answer." });
  if (!d.guardrails.rules.length) warnings.push({ section: "guardrails", message: "No guardrail rules: the agent is limited only by its instructions." });
  if (d.runtime.outputFormat === "json" && d.outputSchema.type === "object" && !Object.keys(d.outputSchema.properties).length) {
    warnings.push({ section: "outputSchema", message: "The output schema has no fields, so any object passes." });
  }
  if (/approv|human|review before|confirm/i.test(d.instructions + d.purpose) && !d.humanInTheLoop.approveOutput && !d.humanInTheLoop.approveTools.length) {
    warnings.push({ section: "humanInTheLoop", message: "The instructions mention approval, but no approval point is configured, so nothing will actually pause." });
  }
  const bytes = Buffer.byteLength(JSON.stringify(d));
  if (bytes > MAX_DEF_BYTES) errors.push({ section: "context", message: `The definition is ${Math.round(bytes / 1024)} KB; the limit is 64 KB.` });
  if (buildSystemPrompt(d).length > 24000) warnings.push({ section: "context", message: "The derived prompt is long; smaller models may lose parts of it." });
  return { ok: errors.length === 0, errors, warnings };
}

function schemaLines(s, indent = "") {
  if (s.type === "object") {
    return Object.entries(s.properties || {}).map(([k, v]) => {
      const req = (s.required || []).includes(k) ? "required" : "optional";
      const en = v.enum ? ` one of ${JSON.stringify(v.enum)}` : "";
      const desc = v.description ? ` - ${v.description}` : "";
      const head = `${indent}- ${k} (${v.type}, ${req})${en}${desc}`;
      const sub = v.type === "object" ? schemaLines(v, indent + "  ") : v.type === "array" && v.items.type === "object" ? schemaLines(v.items, indent + "  ") : [];
      return [head, ...sub].join("\n");
    });
  }
  return [`${indent}- a ${s.type}`];
}

// The system prompt is a view of the definition, rebuilt on every run so it can never drift from it.
export function buildSystemPrompt(input) {
  const d = normalizeDefinition(input);
  const parts = [`You are ${d.identity.name}.${d.identity.description ? " " + d.identity.description : ""}`];
  if (d.purpose) parts.push(`## Purpose\n${d.purpose}`);
  if (d.responsibilities.length) parts.push(`## Responsibilities\n${d.responsibilities.map((r) => `- ${r}`).join("\n")}`);
  if (d.instructions) parts.push(`## Instructions\n${d.instructions}`);
  if (d.guardrails.rules.length) parts.push(`## Rules you must never break\n${d.guardrails.rules.map((r) => `- ${r}`).join("\n")}`);
  if (d.context.knowledge) parts.push(`## Reference knowledge\n${d.context.knowledge}`);
  if (d.context.examples.length) {
    parts.push(`## Examples\n${d.context.examples.map((e, i) => `Example ${i + 1}\nInput: ${e.input}\nOutput: ${e.output}`).join("\n\n")}`);
  }
  const approvals = [];
  if (d.humanInTheLoop.approveTools.length) approvals.push(`A human approves every call to: ${d.humanInTheLoop.approveTools.join(", ")}. The runtime pauses for it; just call the tool.`);
  if (d.humanInTheLoop.approveOutput) approvals.push("A human reviews your final answer before it is used.");
  if (d.humanInTheLoop.instructions) approvals.push(d.humanInTheLoop.instructions);
  if (approvals.length) parts.push(`## Human approval\n${approvals.join("\n")}`);
  if (d.runtime.outputFormat === "json") parts.push(`## Output\nYour final answer is a JSON value with this shape:\n${schemaLines(d.outputSchema).join("\n")}`);
  else parts.push("## Output\nYour final answer is plain text.");
  return parts.join("\n\n");
}

// Git-native layout: agent.yaml follows the gitagent standard and carries the full definition under `jr`; SOUL.md and RULES.md are generated views.
export function renderGitagentFiles(input) {
  const d = normalizeDefinition(input);
  const manifest = {
    spec_version: "0.1.0",
    name: d.id || slugify(d.identity.name),
    version: d.version,
    description: d.identity.description || d.purpose.slice(0, 200),
    model: { preferred: d.model.name || PROVIDER_MODELS[d.model.provider] },
    tools: d.tools.map((t) => t.id),
    runtime: { max_turns: d.runtime.maxSteps, timeout: d.runtime.timeoutSeconds },
    tags: d.identity.tags,
    jr: d,
  };
  const soul = [
    `# ${d.identity.name}`, "", "<!-- Generated from agent.yaml by Jr-Architect. Edit the agent in Agent Studio. -->", "",
    d.identity.description, "", "## Purpose", d.purpose || "_Not set._", "",
    ...(d.responsibilities.length ? ["## Responsibilities", ...d.responsibilities.map((r) => `- ${r}`), ""] : []),
    ...(d.instructions ? ["## Instructions", d.instructions, ""] : []),
  ].join("\n");
  const rules = [
    "# Rules", "", "<!-- Generated from agent.yaml by Jr-Architect. -->", "",
    ...(d.guardrails.rules.length ? d.guardrails.rules.map((r) => `- ${r}`) : ["- No custom rules."]),
    ...(d.guardrails.blockedTerms.length ? ["", "## Blocked terms", ...d.guardrails.blockedTerms.map((t) => `- ${t}`)] : []),
    ...(d.humanInTheLoop.approveOutput || d.humanInTheLoop.approveTools.length
      ? ["", "## Human approval", ...(d.humanInTheLoop.approveOutput ? ["- Final output is approved by a human."] : []),
        ...d.humanInTheLoop.approveTools.map((t) => `- Calls to ${t} are approved by a human.`)] : []),
  ].join("\n");
  return {
    "agent.yaml": yaml.dump(manifest, { lineWidth: 120, noRefs: true }),
    "SOUL.md": soul + "\n",
    "RULES.md": rules + "\n",
  };
}

// Reads a Jr agent back from agent.yaml, or maps a plain gitagent (manifest plus SOUL/RULES) onto a definition.
export function definitionFromGitagent(files) {
  let m = {};
  try { m = yaml.load(files["agent.yaml"] || "") || {}; } catch { throw new Error("agent.yaml is not valid YAML"); }
  if (m.jr && typeof m.jr === "object") return normalizeDefinition(m.jr);
  const soul = String(files["SOUL.md"] || "").replace(/<!--[\s\S]*?-->/g, "").trim();
  const rules = String(files["RULES.md"] || "").split("\n").filter((l) => /^\s*[-*]\s+/.test(l));
  const preferred = (m.model && (m.model.preferred || m.model.name)) || (typeof m.model === "string" ? m.model : "");
  const provider = Object.keys(PROVIDER_MODELS).find((p) => String(preferred).toLowerCase().includes(p === "gemini" ? "gemini" : p)) || "groq";
  return normalizeDefinition({
    identity: { name: m.name || "Imported agent", description: m.description || "", tags: m.tags || [] },
    purpose: m.description || soul.split("\n").find((l) => l.trim() && !l.startsWith("#")) || "",
    instructions: soul,
    guardrails: { rules },
    model: { provider },
    runtime: { maxSteps: m.runtime && m.runtime.max_turns, outputFormat: "text" },
  });
}

function isPlain(v) { return v && typeof v === "object" && !Array.isArray(v); }

// Field-level differences, so Improve and version history can show what changed instead of a wall of JSON.
export function diffDefinitions(beforeIn, afterIn, prefix = "") {
  const out = [];
  const walk = (a, b, path) => {
    if (isPlain(a) && isPlain(b)) {
      for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], path ? `${path}.${k}` : k);
      return;
    }
    if (JSON.stringify(a) !== JSON.stringify(b)) out.push({ path, before: a, after: b });
  };
  const before = normalizeDefinition(beforeIn);
  const after = normalizeDefinition(afterIn);
  for (const k of ["id", "version", "apiVersion"]) { delete before[k]; delete after[k]; }
  walk(before, after, prefix);
  return out;
}

export function bumpPatch(v) {
  const [a, b, c] = String(v || "0.1.0").split(".").map((x) => Number(x) || 0);
  return `${a}.${b}.${c + 1}`;
}

// Minimal JSON-schema check for the subset normalizeSchema keeps.
export function validateAgainstSchema(value, schema, path = "$") {
  const errs = [];
  const t = schema.type;
  const actual = Array.isArray(value) ? "array" : value === null ? "null" : typeof value;
  const okType = t === "integer" ? Number.isInteger(value) : t === "number" ? typeof value === "number" && Number.isFinite(value) : actual === t;
  if (!okType) return [`${path} should be ${t}, got ${actual}`];
  if (schema.enum && schema.enum.length && !schema.enum.includes(value)) errs.push(`${path} should be one of ${JSON.stringify(schema.enum)}`);
  if (t === "object") {
    for (const k of schema.required || []) if (value[k] === undefined) errs.push(`${path}.${k} is required`);
    for (const [k, s] of Object.entries(schema.properties || {})) if (value[k] !== undefined) errs.push(...validateAgainstSchema(value[k], s, `${path}.${k}`));
  }
  if (t === "array") value.slice(0, 200).forEach((v, i) => errs.push(...validateAgainstSchema(v, schema.items, `${path}[${i}]`)));
  return errs.slice(0, 20);
}
