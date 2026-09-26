// Minimal WebSocket probe for validate.sh: node wsclient.mjs <url> <origin> [cookie] [send]; prints the first frame.
import WebSocket from "ws";

const [url, origin, cookie, send] = process.argv.slice(2);
const headers = { Origin: origin };
if (cookie) headers.Cookie = cookie;
const ws = new WebSocket(url, { headers });
const done = (code, msg) => { console.log(msg); ws.terminate(); process.exit(code); };
const timer = setTimeout(() => done(1, "TIMEOUT"), 20000);
let got = "";
ws.on("open", () => { if (send) ws.send(Buffer.from(send)); });
ws.on("message", (m) => {
  got += m.toString();
  if (!send || got.includes("JRMARK")) { clearTimeout(timer); done(0, got.slice(0, 300)); }
});
ws.on("unexpected-response", (_req, res) => { clearTimeout(timer); done(1, `HTTP ${res.statusCode}`); });
ws.on("error", (e) => { clearTimeout(timer); done(1, `ERROR ${e.message}`); });
