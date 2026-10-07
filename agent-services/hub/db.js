// MongoDB for the agent hub when MONGODB_URI is set; without it the hub keeps its JSON files and git repos.
import { MongoClient, ObjectId } from "mongodb";

let client = null;
let db = null;

export const hasDb = () => db !== null;
export const col = (name) => db.collection(name);
export const newId = () => new ObjectId();

const INDEXES = {
  agents: [[{ owner: 1, slug: 1 }, { unique: true }], [{ owner: 1, updatedAt: -1 }]],
  agent_versions: [[{ owner: 1, slug: 1, createdAt: -1 }]],
  workflows: [[{ owner: 1, slug: 1 }, { unique: true }], [{ owner: 1, updatedAt: -1 }]],
  workflow_versions: [[{ owner: 1, slug: 1, createdAt: -1 }]],
  runs: [[{ runId: 1 }, { unique: true }], [{ owner: 1, scope: 1, scopeId: 1, startedAt: -1 }]],
  api_keys: [[{ hash: 1 }, { unique: true }], [{ owner: 1, kind: 1, target: 1 }, { unique: true }]],
  agent_memory: [[{ owner: 1, agent: 1 }, { unique: true }]],
  playground_threads: [[{ owner: 1, workflow: 1 }, { unique: true }]],
};

export async function connectDb(uri = process.env.MONGODB_URI, name = process.env.MONGODB_DB || "jr_architect") {
  if (!uri) return false;
  const c = new MongoClient(uri, { appName: "jr-architect-agents", serverSelectionTimeoutMS: 15000 });
  await c.connect();
  await c.db(name).command({ ping: 1 });
  client = c;
  db = c.db(name);
  for (const [name, list] of Object.entries(INDEXES)) {
    for (const [keys, opts] of list) await db.collection(name).createIndex(keys, opts || {});
  }
  return true;
}

// Tests only: removes the throwaway database and disconnects.
export async function dropDb() {
  if (db) await db.dropDatabase();
  await closeDb();
}

export async function closeDb() {
  if (client) await client.close();
  client = null;
  db = null;
}

// Records that a one-time step ran; false when it already had.
export async function markOnce(id) {
  try {
    await col("meta").insertOne({ _id: id, at: new Date() });
    return true;
  } catch (e) {
    if (e && e.code === 11000) return false;
    throw e;
  }
}

// Version ids are the version document's ObjectId, so they look like a short hex id just as git shas did.
export function objectId(hex) {
  return /^[a-f0-9]{24}$/.test(String(hex || "")) ? new ObjectId(hex) : null;
}

// Keeps the newest `keep` runs of one agent or workflow.
export async function trimRuns(owner, scope, scopeId, keep) {
  const old = await col("runs").find({ owner, scope, scopeId }, { projection: { _id: 1 } })
    .sort({ startedAt: -1 }).skip(keep).toArray();
  if (old.length) await col("runs").deleteMany({ _id: { $in: old.map((d) => d._id) } });
}

export async function saveRunDoc(owner, scope, scopeId, run) {
  const now = new Date();
  await col("runs").updateOne({ runId: run.id },
    { $set: { owner, scope, scopeId, startedAt: run.startedAt || Date.now(), status: run.status, run, updatedAt: now }, $setOnInsert: { createdAt: now } },
    { upsert: true });
}

export async function readRunDoc(owner, scope, scopeId, runId) {
  const d = await col("runs").findOne({ runId, owner, scope, scopeId });
  return d ? d.run : null;
}

export async function listRunDocs(owner, scope, scopeId, limit, omit) {
  const projection = omit ? { [`run.${omit}`]: 0 } : {};
  const docs = await col("runs").find({ owner, scope, scopeId }, { projection }).sort({ startedAt: -1 }).limit(limit).toArray();
  return docs.map((d) => d.run);
}
