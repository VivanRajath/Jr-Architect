// One-time copy of the hub's files into MongoDB, the first time a database is configured; the files stay where they are.
import * as fs from "node:fs";
import { join } from "node:path";
import { col, markOnce } from "./db.js";
import { hubRoot, userKey, readJSON } from "./store.js";
import { definitionFromGitagent } from "./definition.js";

const ID_RE = /^[a-z0-9][a-z0-9-]{0,47}$/;
const list = (dir) => { try { return fs.readdirSync(dir); } catch { return []; } };

// Hub folders are named by a hash of the owner, so owners are matched against every user the database knows.
async function ownersByHash(root) {
  const candidates = new Set(["local"]);
  for (const u of await col("users").find({}, { projection: { _id: 1 } }).toArray()) candidates.add(u._id);
  for (const dir of list(root)) {
    for (const k of Object.values(readJSON(join(root, dir, "keys.json"), {}))) if (k && k.owner) candidates.add(k.owner);
  }
  return new Map([...candidates].map((u) => [userKey(u), u]));
}

function runsIn(dir) {
  return list(dir).filter((f) => f.endsWith(".json")).map((f) => readJSON(join(dir, f), null)).filter((r) => r && r.id);
}

export async function importHubFiles() {
  if (!(await markOnce("hub-files-import"))) return null;
  const root = hubRoot();
  const owners = await ownersByHash(root);
  const counts = { agents: 0, workflows: 0, runs: 0, skipped: 0 };
  const now = new Date();
  const upsertRun = (owner, scope, scopeId, run) => col("runs").updateOne({ runId: run.id },
    { $setOnInsert: { owner, scope, scopeId, startedAt: run.startedAt || 0, status: run.status, run, createdAt: now, updatedAt: now } }, { upsert: true });

  for (const dir of list(root)) {
    const owner = owners.get(dir);
    if (!owner) { counts.skipped++; continue; }
    const base = join(root, dir);

    for (const slug of list(join(base, "agents")).filter((n) => ID_RE.test(n))) {
      let def;
      try { def = definitionFromGitagent({ "agent.yaml": fs.readFileSync(join(base, "agents", slug, "agent.yaml"), "utf8") }); } catch { continue; }
      def.id = slug;
      const res = await col("agents").updateOne({ owner, slug },
        { $setOnInsert: { version: def.version, definition: def, createdAt: now, updatedAt: now } }, { upsert: true });
      if (res.upsertedCount) {
        counts.agents++;
        await col("agent_versions").insertOne({ owner, slug, version: def.version, message: "Imported from files", definition: def, createdAt: now });
      }
      const notes = readJSON(join(base, "state", slug, "memory.json"), null);
      if (Array.isArray(notes) && notes.length) await col("agent_memory").updateOne({ owner, agent: slug }, { $setOnInsert: { notes, updatedAt: now } }, { upsert: true });
      for (const run of runsIn(join(base, "state", slug, "runs"))) { await upsertRun(owner, "agent", slug, run); counts.runs++; }
    }

    for (const f of list(join(base, "workflows")).filter((n) => n.endsWith(".json"))) {
      const slug = f.slice(0, -5);
      const w = readJSON(join(base, "workflows", f), null);
      if (!ID_RE.test(slug) || !w) continue;
      w.id = slug;
      const res = await col("workflows").updateOne({ owner, slug },
        { $setOnInsert: { version: w.version, workflow: w, createdAt: now, updatedAt: now } }, { upsert: true });
      if (res.upsertedCount) {
        counts.workflows++;
        await col("workflow_versions").insertOne({ owner, slug, version: w.version, message: "Imported from files", workflow: w, createdAt: now });
      }
      for (const run of runsIn(join(base, "wfstate", slug, "runs"))) { await upsertRun(owner, "workflow", slug, run); counts.runs++; }
      const thread = readJSON(join(base, "wfstate", slug, "playground.json"), null);
      if (thread && Array.isArray(thread.messages) && thread.messages.length) {
        await col("playground_threads").updateOne({ owner, workflow: slug }, { $setOnInsert: { messages: thread.messages, createdAt: now, updatedAt: now } }, { upsert: true });
      }
    }

    for (const [slot, k] of Object.entries(readJSON(join(base, "keys.json"), {}))) {
      if (!k || !k.hash) continue;
      const kind = slot.startsWith("wf:") ? "workflow" : "agent";
      const target = kind === "workflow" ? slot.slice(3) : slot;
      await col("api_keys").updateOne({ owner, kind, target },
        { $setOnInsert: { hash: k.hash, prefix: k.prefix, createdAt: k.createdAt, lastUsedAt: k.lastUsedAt || null } }, { upsert: true });
    }
  }
  return counts;
}
