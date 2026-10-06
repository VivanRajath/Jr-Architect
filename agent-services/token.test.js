import test from "node:test";
import assert from "node:assert/strict";
import WebSocket from "ws";

process.env.AGENT_NO_LISTEN = "1";
const { fromJrArch, server } = await import("./server.js");

test("fromJrArch accepts only Go's exact token", () => {
  assert.equal(fromJrArch({ "x-jr-internal": "s3cret-token" }, "s3cret-token"), true);
  assert.equal(fromJrArch({ "x-jr-internal": "s3cret-tokeX" }, "s3cret-token"), false);
  assert.equal(fromJrArch({}, "s3cret-token"), false);
  assert.equal(fromJrArch({}, ""), true);
});

test("without Go's token the agent refuses HTTP and WebSocket callers (host.docker.internal reaches loopback)", async () => {
  process.env.JR_INTERNAL_TOKEN = "token-only-go-knows";
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `127.0.0.1:${server.address().port}`;
  try {
    const plain = await fetch(`http://${base}/agent/health`);
    assert.equal(plain.status, 403);
    const spoofedUser = await fetch(`http://${base}/agent/chat`, {
      method: "POST", headers: { "Content-Type": "application/json", "x-jr-user": "internal" },
      body: JSON.stringify({ container: "c", message: "hi" }),
    });
    assert.equal(spoofedUser.status, 403);
    const good = await fetch(`http://${base}/agent/health`, { headers: { "x-jr-internal": "token-only-go-knows" } });
    assert.equal(good.status, 200);
    const refused = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://${base}/agent/ws`);
      ws.on("open", () => { ws.close(); resolve("opened"); });
      ws.on("unexpected-response", (_q, res) => resolve(res.statusCode));
      ws.on("error", () => resolve("error"));
    });
    assert.notEqual(refused, "opened");
  } finally {
    delete process.env.JR_INTERNAL_TOKEN;
    await new Promise((r) => server.close(r));
  }
});
