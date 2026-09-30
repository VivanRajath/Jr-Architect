// Per-user agent storage: each agent is its own git repository in gitagent layout, so every save is a version.
import * as fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  normalizeDefinition, renderGitagentFiles, definitionFromGitagent, slugify, bumpPatch,
} from "./definition.js";

export const MAX_AGENTS_PER_USER = Number(process.env.JR_HUB_MAX_AGENTS) || 25;
const MAX_RUNS_KEPT = 40;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const RUN_RE = /^r-[a-f0-9]{16}$/;

export function hubRoot() {
  return process.env.JR_HUB_DIR || join(homedir(), ".jr-architect", "agent-hub");
}

// A hash, so a user id never becomes a path and a token can name its owner without revealing them.
export function userKey(user) {
  return createHash("sha256").update(String(user)).digest("hex").slice(0, 24);
}

const userDir = (user) => join(hubRoot(), userKey(user));
const agentDir = (user, id) => join(userDir(user), "agents", id);
const stateDir = (user, id) => join(userDir(user), "state", id);

function assertId(id) {
  if (!ID_RE.test(String(id || ""))) throw Object.assign(new Error("invalid agent id"), { status: 400 });
}

// Our own repos only, so hooks never run; identity is fixed so commits work on a fresh machine.
function git(dir, args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "user.name=Jr-Architect", "-c", "user.email=agents@jr-architect.local",
      "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().slice(0, 300))) : resolve(stdout)));
  });
}

// Saves of one agent are serialized so two commits never interleave.
const locks = new Map();
async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  locks.set(key, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === next) locks.delete(key); }
}

function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
function writeJSON(p, v) {
  fs.mkdirSync(join(p, ".."), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

function writeFiles(dir, def) {
  for (const [name, body] of Object.entries(renderGitagentFiles(def))) fs.writeFileSync(join(dir, name), body);
}

export function readAgent(user, id) {
  assertId(id);
  const dir = agentDir(user, id);
  if (!fs.existsSync(join(dir, "agent.yaml"))) return null;
  const def = definitionFromGitagent({ "agent.yaml": fs.readFileSync(join(dir, "agent.yaml"), "utf8") });
  def.id = id;
  return def;
}

export function listAgents(user) {
  const root = join(userDir(user), "agents");
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const keys = readJSON(join(userDir(user), "keys.json"), {});
  return names.filter((n) => ID_RE.test(n)).map((id) => {
    try {
      const def = readAgent(user, id);
      if (!def) return null;
      const st = fs.statSync(join(root, id, "agent.yaml"));
      return { definition: def, updatedAt: st.mtimeMs, n8n: keys[id] ? { prefix: keys[id].prefix, createdAt: keys[id].createdAt, lastUsedAt: keys[id].lastUsedAt || null } : null };
    } catch { return null; }
  }).filter(Boolean).sort((a, b) => b.updatedAt - a.updatedAt);
}

function uniqueId(user, base) {
  const root = join(userDir(user), "agents");
  let id = slugify(base);
  for (let i = 2; fs.existsSync(join(root, id)); i++) id = `${slugify(base).slice(0, 44)}-${i}`;
  return id;
}

export async function createAgent(user, input, message = "Create agent") {
  const count = listAgents(user).length;
  if (count >= MAX_AGENTS_PER_USER) throw Object.assign(new Error(`You can keep up to ${MAX_AGENTS_PER_USER} agents; delete one first.`), { status: 409 });
  const def = normalizeDefinition(input);
  def.id = uniqueId(user, def.identity.name);
  def.version = "0.1.0";
  const dir = agentDir(user, def.id);
  return withLock(dir, async () => {
    fs.mkdirSync(dir, { recursive: true });
    try {
      await git(dir, ["init", "-q", "-b", "main"]);
      writeFiles(dir, def);
      fs.writeFileSync(join(dir, "README.md"), `# ${def.identity.name}\n\nA Jr-Architect agent in gitagent layout. agent.yaml is the source of truth.\n`);
      await git(dir, ["add", "-A"]);
      await git(dir, ["commit", "-q", "-m", `${message} (v${def.version})`]);
    } catch (e) {
      fs.rmSync(dir, { recursive: true, force: true });
      throw e;
    }
    return def;
  });
}

export async function saveAgent(user, id, input, message = "Update agent") {
  assertId(id);
  const dir = agentDir(user, id);
  return withLock(dir, async () => {
    const current = readAgent(user, id);
    if (!current) throw Object.assign(new Error("agent not found"), { status: 404 });
    const def = normalizeDefinition(input);
    def.id = id;
    def.version = current.version;
    const before = JSON.stringify(current);
    if (JSON.stringify({ ...def }) === before) return { definition: current, changed: false };
    def.version = bumpPatch(current.version);
    writeFiles(dir, def);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", `${String(message).replace(/\s+/g, " ").slice(0, 120)} (v${def.version})`]);
    return { definition: def, changed: true };
  });
}

export async function deleteAgent(user, id) {
  assertId(id);
  const dir = agentDir(user, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stateDir(user, id), { recursive: true, force: true });
  await revokeKey(user, id);
  return true;
}

export async function listVersions(user, id) {
  assertId(id);
  const dir = agentDir(user, id);
  if (!fs.existsSync(dir)) return null;
  const out = await git(dir, ["log", "-n", "50", "--format=%H%x09%at%x09%s", "--", "agent.yaml"]);
  return out.trim().split("\n").filter(Boolean).map((l) => {
    const [sha, at, subject] = l.split("\t");
    const m = subject.match(/\(v(\d+\.\d+\.\d+)\)$/);
    return { sha, at: Number(at) * 1000, message: subject.replace(/\s*\(v\d+\.\d+\.\d+\)$/, ""), version: m ? m[1] : "" };
  });
}

export async function readVersion(user, id, sha) {
  assertId(id);
  if (!/^[a-f0-9]{7,40}$/.test(String(sha || ""))) throw Object.assign(new Error("invalid version"), { status: 400 });
  const dir = agentDir(user, id);
  const yamlText = await git(dir, ["show", `${sha}:agent.yaml`]);
  const def = definitionFromGitagent({ "agent.yaml": yamlText });
  def.id = id;
  return def;
}

export async function restoreVersion(user, id, sha) {
  const old = await readVersion(user, id, sha);
  return saveAgent(user, id, old, `Restore v${old.version}`);
}

export function exportBundle(def) {
  return { kind: "jr-agent", apiVersion: 1, exportedAt: new Date().toISOString(), definition: def, files: renderGitagentFiles(def) };
}

// A bundle, a bare definition, or gitagent files all import to a normalized definition.
export function definitionFromImport(body) {
  if (!body || typeof body !== "object") throw Object.assign(new Error("nothing to import"), { status: 400 });
  if (body.kind === "jr-agent" && body.definition) return normalizeDefinition(body.definition);
  if (body.files && body.files["agent.yaml"]) return definitionFromGitagent(body.files);
  if (body.identity || body.purpose || body.instructions) return normalizeDefinition(body);
  throw Object.assign(new Error("not a Jr-Architect agent export"), { status: 400 });
}

// --- n8n keys: the token names owner and agent; only its hash is stored ---

const keysPath = (user) => join(userDir(user), "keys.json");
const sha256 = (s) => createHash("sha256").update(s).digest("hex");

export async function issueKey(user, id) {
  assertId(id);
  return withLock(keysPath(user), async () => {
    const keys = readJSON(keysPath(user), {});
    const secret = randomBytes(24).toString("hex");
    const token = `jrk_${userKey(user)}_${id}_${secret}`;
    keys[id] = { hash: sha256(token), prefix: token.slice(0, 12 + id.length) + "…", createdAt: Date.now(), owner: user };
    writeJSON(keysPath(user), keys);
    return token;
  });
}

export async function revokeKey(user, id) {
  return withLock(keysPath(user), async () => {
    const keys = readJSON(keysPath(user), {});
    if (!keys[id]) return false;
    delete keys[id];
    writeJSON(keysPath(user), keys);
    return true;
  });
}

// Returns { user, id } for a valid token bound to that agent, else null.
export function resolveKey(token, id) {
  const m = /^jrk_([a-f0-9]{24})_([a-z0-9][a-z0-9-]{0,47})_([a-f0-9]{48})$/.exec(String(token || ""));
  if (!m || m[2] !== id) return null;
  const keysFile = join(hubRoot(), m[1], "keys.json");
  const keys = readJSON(keysFile, {});
  const entry = keys[id];
  if (!entry || !entry.hash) return null;
  const a = Buffer.from(sha256(token));
  const b = Buffer.from(entry.hash);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  if (!entry.lastUsedAt || Date.now() - entry.lastUsedAt > 60_000) {
    entry.lastUsedAt = Date.now();
    try { writeJSON(keysFile, keys); } catch { /* best effort */ }
  }
  return { user: entry.owner, id };
}

// --- runtime state: memory notes and run records, outside the versioned repo ---

export function readMemory(user, id) {
  assertId(id);
  return readJSON(join(stateDir(user, id), "memory.json"), []);
}

export function appendMemory(user, id, note, max) {
  const notes = readMemory(user, id);
  notes.push({ note: String(note).slice(0, 300), at: Date.now() });
  writeJSON(join(stateDir(user, id), "memory.json"), notes.slice(-max));
}

export function clearMemory(user, id) {
  assertId(id);
  fs.rmSync(join(stateDir(user, id), "memory.json"), { force: true });
}

export function newRunId() {
  return "r-" + randomBytes(8).toString("hex");
}

export function saveRun(user, id, run) {
  assertId(id);
  const dir = join(stateDir(user, id), "runs");
  writeJSON(join(dir, `${run.id}.json`), run);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return; }
  if (files.length > MAX_RUNS_KEPT) {
    files.map((f) => ({ f, t: fs.statSync(join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t)
      .slice(0, files.length - MAX_RUNS_KEPT).forEach(({ f }) => fs.rmSync(join(dir, f), { force: true }));
  }
}

export function readRun(user, id, runId) {
  assertId(id);
  if (!RUN_RE.test(String(runId || ""))) return null;
  return readJSON(join(stateDir(user, id), "runs", `${runId}.json`), null);
}

export function listRuns(user, id, limit = 20) {
  assertId(id);
  const dir = join(stateDir(user, id), "runs");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => RUN_RE.test(f.replace(/\.json$/, ""))); } catch { return []; }
  return files.map((f) => readJSON(join(dir, f), null)).filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
    .map(({ transcript, ...rest }) => rest);
}
