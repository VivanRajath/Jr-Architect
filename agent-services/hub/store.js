// Per-user agent storage: MongoDB when configured, else each agent is its own git repository in gitagent layout; every save is a version.
import * as fs from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  normalizeDefinition, renderGitagentFiles, definitionFromGitagent, slugify, bumpPatch,
} from "./definition.js";
import { hasDb, col, objectId, trimRuns, saveRunDoc, readRunDoc, listRunDocs } from "./db.js";

// A public server shares one machine among many people; a local install belongs to one person who builds many apps.
export const MAX_AGENTS_PER_USER = Number(process.env.JR_HUB_MAX_AGENTS) || (process.env.JR_PUBLIC_ORIGIN ? 25 : 500);
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

export const userDir = (user) => join(hubRoot(), userKey(user));
const agentDir = (user, id) => join(userDir(user), "agents", id);
const stateDir = (user, id) => join(userDir(user), "state", id);

function assertId(id) {
  if (!ID_RE.test(String(id || ""))) throw Object.assign(new Error("invalid agent id"), { status: 400 });
}

// Our own repos only, so hooks never run; identity is fixed so commits work on a fresh machine.
export function git(dir, args) {
  return new Promise((resolve, reject) => {
    execFile("git", ["-c", "user.name=Jr-Architect", "-c", "user.email=agents@jr-architect.local",
      "-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd: dir, timeout: 15000, maxBuffer: 4 * 1024 * 1024, windowsHide: true },
    (err, stdout, stderr) => (err ? reject(new Error((stderr || err.message).trim().slice(0, 300))) : resolve(stdout)));
  });
}

// Saves of one agent are serialized so two commits never interleave.
const locks = new Map();
export async function withLock(key, fn) {
  const prev = locks.get(key) || Promise.resolve();
  let release;
  const next = new Promise((r) => { release = r; });
  locks.set(key, prev.then(() => next));
  await prev;
  try { return await fn(); } finally { release(); if (locks.get(key) === next) locks.delete(key); }
}

export function readJSON(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return fallback; }
}
export function writeJSON(p, v) {
  fs.mkdirSync(join(p, ".."), { recursive: true });
  const tmp = `${p}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(v, null, 2));
  fs.renameSync(tmp, p);
}

function writeFiles(dir, def) {
  for (const [name, body] of Object.entries(renderGitagentFiles(def))) fs.writeFileSync(join(dir, name), body);
}

// The stored definition goes back through normalize, so a read compares equal to what a save would write.
function defFromDoc(doc) {
  const def = normalizeDefinition(doc.definition);
  def.id = doc.slug;
  def.version = doc.version;
  return def;
}

function keyPublic(k) {
  return k ? { prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null } : null;
}

export async function readAgent(user, id) {
  assertId(id);
  if (hasDb()) {
    const doc = await col("agents").findOne({ owner: user, slug: id });
    return doc ? defFromDoc(doc) : null;
  }
  const dir = agentDir(user, id);
  if (!fs.existsSync(join(dir, "agent.yaml"))) return null;
  const def = definitionFromGitagent({ "agent.yaml": fs.readFileSync(join(dir, "agent.yaml"), "utf8") });
  def.id = id;
  return def;
}

export async function listAgents(user) {
  if (hasDb()) {
    const [docs, keys] = await Promise.all([
      col("agents").find({ owner: user }).sort({ updatedAt: -1 }).toArray(),
      col("api_keys").find({ owner: user, kind: "agent" }).toArray(),
    ]);
    const byTarget = Object.fromEntries(keys.map((k) => [k.target, k]));
    return docs.map((d) => ({ definition: defFromDoc(d), updatedAt: d.updatedAt.getTime(), n8n: keyPublic(byTarget[d.slug]) }));
  }
  const root = join(userDir(user), "agents");
  let names = [];
  try { names = fs.readdirSync(root); } catch { return []; }
  const keys = readJSON(join(userDir(user), "keys.json"), {});
  const out = [];
  for (const id of names.filter((n) => ID_RE.test(n))) {
    try {
      const def = await readAgent(user, id);
      if (!def) continue;
      const st = fs.statSync(join(root, id, "agent.yaml"));
      out.push({ definition: def, updatedAt: st.mtimeMs, n8n: keyPublic(keys[id]) });
    } catch { /* unreadable agent */ }
  }
  return out.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function slugTaken(user, id) {
  if (hasDb()) return !!(await col("agents").findOne({ owner: user, slug: id }, { projection: { _id: 1 } }));
  return fs.existsSync(join(userDir(user), "agents", id));
}

async function uniqueId(user, base) {
  let id = slugify(base);
  for (let i = 2; await slugTaken(user, id); i++) id = `${slugify(base).slice(0, 44)}-${i}`;
  return id;
}

async function addAgentVersion(user, def, message) {
  await col("agent_versions").insertOne({
    owner: user, slug: def.id, version: def.version, message: String(message).replace(/\s+/g, " ").slice(0, 120), definition: def, createdAt: new Date(),
  });
}

export async function createAgent(user, input, message = "Create agent") {
  const count = hasDb() ? await col("agents").countDocuments({ owner: user }) : (await listAgents(user)).length;
  if (count >= MAX_AGENTS_PER_USER) throw Object.assign(new Error(`You can keep up to ${MAX_AGENTS_PER_USER} agents; delete one first.`), { status: 409 });
  const def = normalizeDefinition(input);
  return withLock(`agents:${user}`, async () => {
    def.id = await uniqueId(user, def.identity.name);
    def.version = "0.1.0";
    if (hasDb()) {
      const now = new Date();
      await col("agents").insertOne({ owner: user, slug: def.id, version: def.version, definition: def, createdAt: now, updatedAt: now });
      await addAgentVersion(user, def, message);
      return def;
    }
    const dir = agentDir(user, def.id);
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
  return withLock(`agents:${user}`, async () => {
    const current = await readAgent(user, id);
    if (!current) throw Object.assign(new Error("agent not found"), { status: 404 });
    const def = normalizeDefinition(input);
    def.id = id;
    def.version = current.version;
    if (JSON.stringify(def) === JSON.stringify(current)) return { definition: current, changed: false };
    def.version = bumpPatch(current.version);
    if (hasDb()) {
      await col("agents").updateOne({ owner: user, slug: id }, { $set: { version: def.version, definition: def, updatedAt: new Date() } });
      await addAgentVersion(user, def, message);
      return { definition: def, changed: true };
    }
    const dir = agentDir(user, id);
    writeFiles(dir, def);
    await git(dir, ["add", "-A"]);
    await git(dir, ["commit", "-q", "-m", `${String(message).replace(/\s+/g, " ").slice(0, 120)} (v${def.version})`]);
    return { definition: def, changed: true };
  });
}

export async function deleteAgent(user, id) {
  assertId(id);
  if (hasDb()) {
    const { deletedCount } = await col("agents").deleteOne({ owner: user, slug: id });
    if (!deletedCount) return false;
    await Promise.all([
      col("agent_versions").deleteMany({ owner: user, slug: id }),
      col("agent_memory").deleteMany({ owner: user, agent: id }),
      col("runs").deleteMany({ owner: user, scope: "agent", scopeId: id }),
    ]);
    await revokeKey(user, id);
    return true;
  }
  const dir = agentDir(user, id);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  fs.rmSync(stateDir(user, id), { recursive: true, force: true });
  await revokeKey(user, id);
  return true;
}

export async function listVersions(user, id) {
  assertId(id);
  if (hasDb()) {
    if (!(await slugTaken(user, id))) return null;
    const docs = await col("agent_versions").find({ owner: user, slug: id }, { projection: { definition: 0 } }).sort({ createdAt: -1 }).limit(50).toArray();
    return docs.map((d) => ({ sha: d._id.toHexString(), at: d.createdAt.getTime(), message: d.message, version: d.version }));
  }
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
  if (hasDb()) {
    const _id = objectId(sha);
    const doc = _id && await col("agent_versions").findOne({ _id, owner: user, slug: id });
    if (!doc) throw Object.assign(new Error("version not found"), { status: 404 });
    return defFromDoc(doc);
  }
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

// Agents and workflows each get their own token namespace, so an agent token can never run a workflow of the same name.
const KEY_KINDS = { agent: { prefix: "jrk", slot: (id) => id }, workflow: { prefix: "jrw", slot: (id) => `wf:${id}` } };

export async function keyInfo(user, id, kind = "agent") {
  if (hasDb()) return keyPublic(await col("api_keys").findOne({ owner: user, kind, target: id }));
  return keyPublic(readJSON(keysPath(user), {})[KEY_KINDS[kind].slot(id)]);
}

export async function issueKey(user, id, kind = "agent") {
  assertId(id);
  const k = KEY_KINDS[kind];
  const secret = randomBytes(24).toString("hex");
  const token = `${k.prefix}_${userKey(user)}_${id}_${secret}`;
  const entry = { hash: sha256(token), prefix: token.slice(0, 12 + id.length) + "…", createdAt: Date.now(), owner: user };
  if (hasDb()) {
    await col("api_keys").updateOne({ owner: user, kind, target: id },
      { $set: { ...entry, lastUsedAt: null } }, { upsert: true });
    return token;
  }
  return withLock(keysPath(user), async () => {
    const keys = readJSON(keysPath(user), {});
    keys[k.slot(id)] = entry;
    writeJSON(keysPath(user), keys);
    return token;
  });
}

export async function revokeKey(user, id, kind = "agent") {
  if (hasDb()) return (await col("api_keys").deleteOne({ owner: user, kind, target: id })).deletedCount > 0;
  const slot = KEY_KINDS[kind].slot(id);
  return withLock(keysPath(user), async () => {
    const keys = readJSON(keysPath(user), {});
    if (!keys[slot]) return false;
    delete keys[slot];
    writeJSON(keysPath(user), keys);
    return true;
  });
}

// Returns { user, id } for a valid token bound to that agent, else null.
export async function resolveKey(token, id, kind = "agent") {
  const k = KEY_KINDS[kind];
  const m = /^(jr[kw])_([a-f0-9]{24})_([a-z0-9][a-z0-9-]{0,47})_([a-f0-9]{48})$/.exec(String(token || ""));
  if (!m || m[1] !== k.prefix || m[3] !== id) return null;
  if (hasDb()) {
    const entry = await col("api_keys").findOne({ hash: sha256(token), kind, target: id });
    if (!entry || userKey(entry.owner) !== m[2]) return null;
    if (!entry.lastUsedAt || Date.now() - entry.lastUsedAt > 60_000) {
      col("api_keys").updateOne({ _id: entry._id }, { $set: { lastUsedAt: Date.now() } }).catch(() => {});
    }
    return { user: entry.owner, id };
  }
  const keysFile = join(hubRoot(), m[2], "keys.json");
  const keys = readJSON(keysFile, {});
  const entry = keys[k.slot(id)];
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

// --- runtime state: memory notes and run records, outside the versioned definition ---

export async function readMemory(user, id) {
  assertId(id);
  if (hasDb()) {
    const doc = await col("agent_memory").findOne({ owner: user, agent: id });
    return doc ? doc.notes : [];
  }
  return readJSON(join(stateDir(user, id), "memory.json"), []);
}

export async function appendMemory(user, id, note, max) {
  const entry = { note: String(note).slice(0, 300), at: Date.now() };
  if (hasDb()) {
    assertId(id);
    await col("agent_memory").updateOne({ owner: user, agent: id },
      { $push: { notes: { $each: [entry], $slice: -max } }, $set: { updatedAt: new Date() } }, { upsert: true });
    return;
  }
  const notes = await readMemory(user, id);
  notes.push(entry);
  writeJSON(join(stateDir(user, id), "memory.json"), notes.slice(-max));
}

export async function clearMemory(user, id) {
  assertId(id);
  if (hasDb()) {
    await col("agent_memory").deleteOne({ owner: user, agent: id });
    return;
  }
  fs.rmSync(join(stateDir(user, id), "memory.json"), { force: true });
}

export function newRunId() {
  return "r-" + randomBytes(8).toString("hex");
}

export async function saveRun(user, id, run) {
  assertId(id);
  if (hasDb()) {
    await saveRunDoc(user, "agent", id, run);
    await trimRuns(user, "agent", id, MAX_RUNS_KEPT);
    return;
  }
  const dir = join(stateDir(user, id), "runs");
  writeJSON(join(dir, `${run.id}.json`), run);
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith(".json")); } catch { return; }
  if (files.length > MAX_RUNS_KEPT) {
    files.map((f) => ({ f, t: fs.statSync(join(dir, f)).mtimeMs })).sort((a, b) => a.t - b.t)
      .slice(0, files.length - MAX_RUNS_KEPT).forEach(({ f }) => fs.rmSync(join(dir, f), { force: true }));
  }
}

export async function readRun(user, id, runId) {
  assertId(id);
  if (!RUN_RE.test(String(runId || ""))) return null;
  if (hasDb()) return readRunDoc(user, "agent", id, runId);
  return readJSON(join(stateDir(user, id), "runs", `${runId}.json`), null);
}

export async function listRuns(user, id, limit = 20) {
  assertId(id);
  if (hasDb()) return listRunDocs(user, "agent", id, limit, "transcript");
  const dir = join(stateDir(user, id), "runs");
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => RUN_RE.test(f.replace(/\.json$/, ""))); } catch { return []; }
  return files.map((f) => readJSON(join(dir, f), null)).filter(Boolean)
    .sort((a, b) => b.startedAt - a.startedAt).slice(0, limit)
    .map(({ transcript, ...rest }) => rest);
}
