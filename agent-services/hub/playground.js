// The workflow playground: what a workflow does, greetings answered by the system, and the chat history kept per workflow.
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { readJSON, writeJSON, userDir, readAgent } from "./store.js";
import { hasDb, col } from "./db.js";

const MAX_MESSAGES = 100;
// The input field a typed message goes into, when the workflow has one by these names.
export const MAIN_FIELD = /^(message|text|question|prompt|query|input|request|content|note|description|idea|topic|task)$/i;
const GREETING = /^\s*(h+i+|h+e+y+|hello+|hiya|yo|hola|namaste|good\s+(morning|afternoon|evening)|help|start|what\s+(can|do)\s+you\s+do|what\s+is\s+this|who\s+are\s+you|how\s+does\s+this\s+work)\s*[!?.]*\s*$/i;

const file = (user, id) => join(userDir(user), "wfstate", id, "playground.json");
const msgId = () => "m-" + randomBytes(6).toString("hex");

// Ends a description with a full stop, so the next sentence does not run into it.
export function sentence(text) {
  const t = String(text || "").trim();
  return !t || /[.!?]$/.test(t) ? t : t + ".";
}

export function isGreeting(text) {
  return GREETING.test(String(text || ""));
}

// Walks the graph from the trigger and reads it back as steps a person can follow.
export async function describeWorkflow(user, w) {
  const byId = Object.fromEntries(w.nodes.map((n) => [n.id, n]));
  const out = (id) => w.edges.filter((e) => e.from === id);
  const agents = [];
  const seen = new Set();
  // Agent definitions are loaded up front so the walk below stays synchronous.
  const defs = {};
  for (const n of w.nodes) {
    if (n.type !== "agent" || !n.config.agentId || n.config.agentId in defs) continue;
    try { defs[n.config.agentId] = await readAgent(user, n.config.agentId); } catch { defs[n.config.agentId] = null; }
  }
  const agentInfo = (n) => {
    const a = defs[n.config.agentId];
    const purpose = (a && (a.identity.description || a.purpose)) || "";
    return { name: n.name, purpose: String(purpose).slice(0, 240) };
  };
  // One readable line per node, following edges; branches are spelled out once.
  const walk = (id, depth) => {
    if (!id || seen.has(id) || depth > 30) return [];
    seen.add(id);
    const n = byId[id];
    if (!n) return [];
    const next = out(id);
    if (n.type === "agent") agents.push(agentInfo(n));
    if (n.type === "if") {
      const side = (port) => {
        const e = next.find((x) => x.port === port);
        const names = [];
        for (let cur = e && e.to, d = 0; cur && d < 20 && !seen.has(cur); d++) {
          const m = byId[cur];
          if (!m) break;
          seen.add(cur);
          if (m.type === "agent") { agents.push(agentInfo(m)); names.push(m.name); }
          else if (m.type === "approval") names.push("a person approves");
          else if (m.type === "http") names.push(`calls ${m.name}`);
          const nx = out(cur)[0];
          cur = nx && nx.to;
        }
        return names.length ? names.join(", then ") : "finishes";
      };
      return [`${n.name}: if yes, ${side("true")}; if no, ${side("false")}`];
    }
    const line = n.type === "agent" ? n.name : n.type === "approval" ? "A person approves the result" : n.type === "http" ? `Calls ${n.name}` : n.type === "set" ? `Prepares ${n.name}` : null;
    return [...(line ? [line] : []), ...next.flatMap((e) => walk(e.to, depth + 1))];
  };
  const trigger = w.nodes.find((n) => n.type === "trigger");
  const steps = trigger ? walk(trigger.id, 0) : [];
  const sample = (trigger && trigger.config && trigger.config.sample) || {};
  const inputs = typeof sample === "object" && !Array.isArray(sample)
    // Build mode fills a trigger with "Example <field>" placeholders; those are not worth showing or sending.
    ? Object.entries(sample).map(([name, v]) => ({ name, example: v === `Example ${name}` ? "" : typeof v === "string" ? v : JSON.stringify(v) }))
    : [];
  const main = inputs.find((i) => MAIN_FIELD.test(i.name)) || inputs[0] || null;
  return {
    id: w.id, name: w.name, description: w.description || "", steps, agents,
    approval: w.nodes.some((n) => n.type === "approval"), inputs, mainField: main ? main.name : null,
  };
}

// The system's own answer to a greeting: what the workflow does and how to use it here.
export function greetingReply(info) {
  const parts = [`Hi! This is the playground for "${info.name}".`];
  if (info.description) parts.push(sentence(info.description));
  if (info.steps.length) parts.push(`When you send a message it runs: ${info.steps.join(" → ")}.`);
  if (info.mainField) {
    const example = (info.inputs.find((i) => i.name === info.mainField) || {}).example;
    parts.push(`Type what you want as the ${info.mainField}${example ? `, for example "${example}"` : ""}.`);
  }
  const others = info.inputs.filter((i) => i.name !== info.mainField).map((i) => i.name);
  if (others.length) parts.push(`You can also set ${others.join(", ")} in the fields above the message box.`);
  if (info.approval) parts.push("It stops for your approval before finishing; you can approve or reject right here.");
  return parts.join(" ");
}

export async function readThread(user, id) {
  const t = hasDb() ? await col("playground_threads").findOne({ owner: user, workflow: id }) : readJSON(file(user, id), null);
  return Array.isArray(t && t.messages) ? t.messages : [];
}

async function writeThread(user, id, messages) {
  if (!hasDb()) return writeJSON(file(user, id), { messages });
  await col("playground_threads").updateOne({ owner: user, workflow: id },
    { $set: { messages, updatedAt: new Date() }, $setOnInsert: { createdAt: new Date() } }, { upsert: true });
}

export async function appendMessages(user, id, ...messages) {
  const all = [...await readThread(user, id), ...messages.map((m) => ({ id: msgId(), at: Date.now(), ...m }))].slice(-MAX_MESSAGES);
  await writeThread(user, id, all);
  return all.slice(-messages.length);
}

export async function updateMessage(user, id, messageId, patch) {
  const all = (await readThread(user, id)).map((m) => (m.id === messageId ? { ...m, ...patch } : m));
  await writeThread(user, id, all);
}

export async function clearThread(user, id) {
  await writeThread(user, id, []);
}
