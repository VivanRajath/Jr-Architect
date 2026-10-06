// Tests for keys pushed from Settings and for picking a provider.
import { test } from "node:test";
import assert from "node:assert";

for (const k of ["GROQ_API_KEYS", "ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN", "OPENAI_API_KEY", "GEMINI_API_KEY", "GITCLAW_MODEL", "JR_PROVIDER_KEYS", "GROQ_KNOWLEDGE_API_KEY"]) delete process.env[k];
for (let i = 2; i <= 10; i++) delete process.env[`GROQ_API_KEY_${i}`];
process.env.GROQ_API_KEY = "test-groq-system";
const { applyKeys, GROQ_KEYS, POOLS, providerHasKey, firstAvailableProvider, modelFor, rotateKey, dropRejectedKey, outputCap } = await import("./llm.js");

test("the server's Groq key is the fallback until the user saves keys", () => {
  assert.strictEqual(firstAvailableProvider(), "groq");
  assert.strictEqual(modelFor(), "groq:openai/gpt-oss-120b");
  applyKeys({ keys: { anthropic: ["test-anthropic-a", "test-anthropic-b"] } });
  assert.strictEqual(firstAvailableProvider(), "anthropic");
  assert.strictEqual(modelFor(), "anthropic:claude-opus-5-5");
  assert.strictEqual(modelFor("auto", "fast"), "anthropic:claude-haiku-4-5");
  assert.strictEqual(modelFor("groq"), "groq:openai/gpt-oss-120b", "an explicit provider with a key is kept");
  assert.strictEqual(modelFor("openai"), "anthropic:claude-opus-5-5", "a keyless provider falls back to the best one");
});

test("the user's own Groq keys replace the server's and come back out", () => {
  applyKeys({ keys: { groq: ["test-groq-mine1", "test-groq-mine2"], anthropic: [] } });
  assert.deepStrictEqual(GROQ_KEYS, ["test-groq-mine1", "test-groq-mine2"]);
  assert.strictEqual(firstAvailableProvider(), "groq");
  applyKeys({ keys: { groq: [] } });
  assert.deepStrictEqual(GROQ_KEYS, ["test-groq-system"]);
  assert.ok(!providerHasKey("anthropic"));
});

test("a stronger user provider is tried before a weaker one", () => {
  applyKeys({ keys: { groq: ["test-groq-mine"], openai: ["test-openai-1"], gemini: ["test-gemini-1"] } });
  assert.strictEqual(firstAvailableProvider(), "openai");
  applyKeys({ keys: {} });
});

test("every provider rotates keys and drops one it rejects", () => {
  applyKeys({ keys: { anthropic: ["test-anthropic-a", "test-anthropic-b"] } });
  const seen = new Set();
  for (let i = 0; i < 4; i++) { rotateKey("anthropic:claude-opus-5-5"); seen.add(process.env.ANTHROPIC_API_KEY); }
  assert.strictEqual(seen.size, 2);
  assert.strictEqual(dropRejectedKey("anthropic:claude-opus-5-5", "401 invalid x-api-key"), true);
  assert.strictEqual(POOLS.anthropic.length, 1);
  assert.strictEqual(dropRejectedKey("anthropic:claude-opus-5-5", "401 invalid x-api-key"), false, "the last key stays");
  applyKeys({ keys: {} });
});

test("hosted reasoning models get room for thinking, Groq keeps its small cap", () => {
  assert.strictEqual(outputCap("groq:openai/gpt-oss-120b", 1500), 1500);
  assert.ok(outputCap("anthropic:claude-opus-5-5", 1500) >= 16000);
});

test("applyKeys sets and clears provider keys and the Groq pool", () => {
  applyKeys({ GROQ_API_KEY: "test-groq-one", OPENAI_API_KEY: "test-openai-1" });
  assert.deepStrictEqual(GROQ_KEYS, ["test-groq-one"]);
  assert.ok(providerHasKey("groq") && providerHasKey("openai"));
  applyKeys({ GROQ_API_KEY: "", OPENAI_API_KEY: "" });
  assert.deepStrictEqual(GROQ_KEYS, []);
  assert.ok(!providerHasKey("groq") && !providerHasKey("openai"));
});

test("applyKeys ignores anything that is not a provider key", () => {
  applyKeys({ PATH: "/evil", JR_INTERNAL_TOKEN: "x" });
  assert.notStrictEqual(process.env.PATH, "/evil");
  assert.notStrictEqual(process.env.JR_INTERNAL_TOKEN, "x");
  applyKeys({ keys: { PATH: ["/evil"] } });
  assert.notStrictEqual(process.env.PATH, "/evil");
});
