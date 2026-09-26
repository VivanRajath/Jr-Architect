import test from "node:test";
import assert from "node:assert/strict";

process.env.AGENT_NO_LISTEN = "1";
const { allowLLM, server } = await import("./server.js");

test("allowLLM spends a per-user hourly budget and exempts internal calls", () => {
  process.env.JR_LLM_PER_HOUR = "2";
  const t0 = 1_000_000;
  assert.equal(allowLLM("u-rl", t0).ok, true);
  assert.equal(allowLLM("u-rl", t0 + 1).ok, true);
  const third = allowLLM("u-rl", t0 + 60_000);
  assert.equal(third.ok, false);
  assert.equal(third.minutes, 59);
  assert.equal(allowLLM("u-other", t0).ok, true);
  assert.equal(allowLLM("internal", t0).ok, true);
  assert.equal(allowLLM(undefined, t0).ok, true);
  assert.equal(allowLLM("u-rl", t0 + 3600_000).ok, true);
  process.env.JR_LLM_PER_HOUR = "0";
  for (let i = 0; i < 5; i++) assert.equal(allowLLM("u-free").ok, true);
});

test("LLM routes answer 429 once the budget is spent", async () => {
  process.env.JR_LLM_PER_HOUR = "1";
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const url = `http://127.0.0.1:${server.address().port}/agent/diagnose`;
  const post = () => fetch(url, {
    method: "POST", headers: { "Content-Type": "application/json", "x-jr-user": "u-429" }, body: "{}",
  }).then((r) => r.status);
  try {
    assert.notEqual(await post(), 429);
    assert.equal(await post(), 429);
  } finally {
    process.env.JR_LLM_PER_HOUR = "0";
    await new Promise((r) => server.close(r));
  }
});
