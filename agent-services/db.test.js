// MongoDB storage for the hub: records get ids, secrets stay hashed, and files import once. Runs only with MONGODB_TEST_URI. Run: `node --test`.
import { test, after } from "node:test";
import assert from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.JR_HUB_DIR = mkdtempSync(join(tmpdir(), "jr-db-test-"));
const uri = process.env.MONGODB_TEST_URI;
const skip = uri ? false : "MONGODB_TEST_URI not set";

const store = await import("./hub/store.js");
const wf = await import("./hub/workflows.js");
const db = await import("./hub/db.js");
const { importHubFiles } = await import("./hub/import.js");

const agentInput = { identity: { name: "Greeter" }, purpose: "Say hello.", instructions: "Greet the person." };

test("agents, versions, workflows and runs are stored with ids", { skip }, async () => {
  // Files first, so the import below has something to copy.
  const fromFiles = await store.createAgent("u-files", { ...agentInput, identity: { name: "Old Agent" } });
  await store.saveRun("u-files", fromFiles.id, { id: "r-00000000000000aa", status: "completed", startedAt: Date.now() });

  await db.connectDb(uri, `jr_test_${process.pid}`);
  after(() => db.dropDb());
  // The Go server imports users before the agent service starts; the hub matches its folders to them.
  await db.col("users").insertOne({ _id: "u-files", provider: "github" });

  const imported = await importHubFiles();
  assert.strictEqual(imported.agents, 1);
  assert.strictEqual(imported.runs, 1);
  assert.strictEqual(await importHubFiles(), null, "the import runs once");
  assert.strictEqual((await store.readAgent("u-files", fromFiles.id)).identity.name, "Old Agent");

  const a = await store.createAgent("u-db", agentInput);
  const doc = await db.col("agents").findOne({ owner: "u-db", slug: a.id });
  assert.ok(doc._id, "the agent has a database id");
  await store.saveAgent("u-db", a.id, { ...a, purpose: "Say hello warmly." });
  const versions = await store.listVersions("u-db", a.id);
  assert.strictEqual(versions.length, 2);
  assert.match(versions[1].sha, /^[a-f0-9]{24}$/);
  const restored = await store.restoreVersion("u-db", a.id, versions[1].sha);
  assert.strictEqual(restored.definition.purpose, "Say hello.");

  const token = await store.issueKey("u-db", a.id);
  const key = await db.col("api_keys").findOne({ owner: "u-db", target: a.id });
  assert.ok(key._id && key.hash && !JSON.stringify(key).includes(token), "only the token's hash is stored");
  assert.deepStrictEqual(await store.resolveKey(token, a.id), { user: "u-db", id: a.id });

  const w = await wf.createWorkflow("u-db", { name: "Hello flow" });
  assert.ok((await db.col("workflows").findOne({ owner: "u-db", slug: w.id }))._id);
  assert.strictEqual((await wf.listWorkflows("u-other")).length, 0, "another user sees nothing");

  await store.appendMemory("u-db", a.id, "likes tea", 2);
  await store.appendMemory("u-db", a.id, "lives in Pune", 2);
  await store.appendMemory("u-db", a.id, "prefers mornings", 2);
  assert.deepStrictEqual((await store.readMemory("u-db", a.id)).map((n) => n.note), ["lives in Pune", "prefers mornings"]);

  assert.ok(await store.deleteAgent("u-db", a.id));
  assert.strictEqual(await db.col("agent_versions").countDocuments({ owner: "u-db", slug: a.id }), 0);
  assert.strictEqual(await db.col("api_keys").countDocuments({ owner: "u-db", target: a.id }), 0);
});
