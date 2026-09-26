// Proves live reload end to end: node reload.mjs <ws url> <origin> <api base> <cookie> <container> <file>; prints RELOADED.
import WebSocket from "ws";

const [url, origin, api, cookie, container, file] = process.argv.slice(2);
const headers = { Cookie: cookie, "X-Jr": "1", "Content-Type": "application/json" };
const ws = new WebSocket(url, { headers: { Origin: origin } });
const done = (code, msg) => { console.log(msg); ws.terminate(); process.exit(code); };
setTimeout(() => done(1, "TIMEOUT waiting for a rebuild after the save"), 90000);
let saved = false;
ws.on("open", () => setTimeout(async () => {
  // Only a file in webpack's import graph triggers a rebuild, so an existing one is edited in place.
  const cur = await fetch(`${api}/file?container=${container}&path=${encodeURIComponent(file)}`, { headers });
  if (!cur.ok) return done(1, `READ failed: HTTP ${cur.status}`);
  const content = (await cur.text()) + `\n// jr live-reload check ${Date.now()}\n`;
  const res = await fetch(`${api}/file/save`, { method: "POST", headers, body: JSON.stringify({ container, path: file, content }) });
  if (!res.ok) return done(1, `SAVE failed: HTTP ${res.status}`);
  saved = true;
}, 3000));
ws.on("message", (m) => {
  const s = m.toString();
  // webpack-dev-server announces every rebuild with a new hash, then ok or errors.
  if (saved && /"type":"(hash|ok|still-ok)"/.test(s)) done(0, `RELOADED ${s.slice(0, 80)}`);
});
ws.on("error", (e) => done(1, `ERROR ${e.message}`));
