import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";

process.env.AGENT_NO_LISTEN = "1";
const { server } = await import("./server.js");

test("a registered sandbox answers only its owner, over HTTP and WebSocket", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sandbox-owner-"));
  writeFileSync(join(dir, "agent.yaml"), "name: demo\n");
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const base = `127.0.0.1:${server.address().port}`;
  try {
    const reg = await fetch(`http://${base}/agent/register`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ container: "c-own", workdir: dir, stack: "node", owner: "u-a" }),
    });
    assert.equal(reg.status, 200);

    const knowledge = (user) => fetch(`http://${base}/agent/knowledge?container=c-own`, { headers: { "x-jr-user": user } }).then((r) => r.status);
    assert.equal(await knowledge("u-b"), 404);
    assert.equal(await knowledge("u-a"), 200);
    assert.equal(await knowledge("internal"), 200);

    const bind = (user) => new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${base}/agent/ws`, { headers: { "x-jr-user": user } });
      ws.on("open", () => ws.send(JSON.stringify({ type: "bind", container: "c-own" })));
      ws.on("message", (m) => { ws.close(); resolve(JSON.parse(m.toString()).type); });
      ws.on("error", reject);
    });
    assert.equal(await bind("u-b"), "error");
    assert.equal(await bind("u-a"), "ready");
  } finally {
    await new Promise((r) => server.close(r));
  }
});
