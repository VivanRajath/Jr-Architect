import test from "node:test";
import assert from "node:assert/strict";

process.env.AGENT_NO_LISTEN = "1";
const { isAllowedOrigin } = await import("./server.js");

test("agent WebSocket origins: loopback locally, only the public origin when public", () => {
  delete process.env.JR_PUBLIC_ORIGIN;
  assert.equal(isAllowedOrigin("http://127.0.0.1:9000"), true);
  assert.equal(isAllowedOrigin("https://evil.example"), false);
  process.env.JR_PUBLIC_ORIGIN = "https://jr.example";
  assert.equal(isAllowedOrigin("https://jr.example"), true);
  assert.equal(isAllowedOrigin("https://p-abc.jr.example"), false);
  assert.equal(isAllowedOrigin("http://127.0.0.1:9000"), false);
  assert.equal(isAllowedOrigin(undefined), true);
  delete process.env.JR_PUBLIC_ORIGIN;
});
