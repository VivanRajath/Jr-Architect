// Stale Groq keys: dropped at startup on a 401 and during a turn, never leaving the pool empty. Run: `node --test`.
import { test } from "node:test";
import assert from "node:assert";

process.env.GROQ_API_KEYS = "";
process.env.GROQ_KNOWLEDGE_API_KEY = "";
process.env.GROQ_API_KEY = "gsk_good_one";
process.env.GROQ_API_KEY_2 = "gsk_good_two";
process.env.GROQ_API_KEY_3 = "gsk_dead_three";
process.env.GROQ_API_KEY_4 = "gsk_dead_four";
const llm = await import("./llm.js");

test("startup drops rejected keys and never reserves a dead one for knowledge", async () => {
  assert.strictEqual(llm.KNOWLEDGE_KEY, "gsk_dead_four");
  const out = await llm.pruneGroqKeys(async (_url, init) => ({ status: /dead/.test(init.headers.Authorization) ? 401 : 200 }));
  assert.strictEqual(out.dropped, 2);
  assert.ok(llm.GROQ_KEYS.every((k) => k.includes("good")));
  assert.ok(!llm.KNOWLEDGE_KEY.includes("dead"));
  assert.ok(llm.GROQ_KEYS.length >= 1);
});

test("a 401 mid-turn drops the key in use, but never the last one", () => {
  llm.GROQ_KEYS.splice(0, llm.GROQ_KEYS.length, "gsk_a", "gsk_b");
  process.env.GROQ_API_KEY = "gsk_a";
  assert.strictEqual(llm.dropRejectedKey("groq:openai/gpt-oss-120b", "401 Invalid API Key"), true);
  assert.deepStrictEqual(llm.GROQ_KEYS, ["gsk_b"]);
  assert.strictEqual(process.env.GROQ_API_KEY, "gsk_b");
  assert.strictEqual(llm.dropRejectedKey("groq:openai/gpt-oss-120b", "401 Invalid API Key"), false, "the last key stays");
  assert.strictEqual(llm.dropRejectedKey("groq:openai/gpt-oss-120b", "429 rate limit"), false);
});
