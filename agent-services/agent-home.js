// gitclaw runs hooks/ and tools/ scripts from its agent dir on the host, so it never gets a workspace as that dir.
import "./models.js";
import { query } from "gitclaw";
import yaml from "js-yaml";
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isSafePath, workspaceRootOf, readInsideWorkspace } from "./workspace-fs.js";

// Everything gitclaw reads to build its prompt, and nothing it would execute.
const MIRRORED = [
  "agent.yaml", "SOUL.md", "RULES.md", "DUTIES.md", "AGENTS.md",
  "knowledge", "skills", "workflows", "agents", "examples", "compliance", "config", "memory",
];
const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;
const MAX_DEPTH = 8;
const SWEEP_EVERY_MS = 10 * 60 * 1000;

let lastSweep = 0;

export function homesDir() {
  return join(process.env.JR_WORK_DIR || tmpdir(), "jr-agent-homes");
}

// Copies regular files only; a symlink is skipped whatever it points at.
function copyTree(src, dst, depth, budget) {
  let st;
  try { st = fs.lstatSync(src); } catch { return; }
  if (st.isDirectory()) {
    if (depth > MAX_DEPTH) return;
    fs.mkdirSync(dst, { recursive: true });
    for (const name of fs.readdirSync(src)) copyTree(join(src, name), join(dst, name), depth + 1, budget);
  } else if (st.isFile() && st.size <= MAX_FILE_BYTES && st.size <= budget.left) {
    budget.left -= st.size;
    // lstat above can be raced, so the bytes come from a read that verifies what it opened.
    try { fs.writeFileSync(dst, readInsideWorkspace(src)); } catch { /* refused or vanished: leave it out */ }
  }
}

// extends/dependencies make gitclaw clone other agents, whose hooks would come along.
function copyManifest(src, dst) {
  let st;
  try { st = fs.lstatSync(src); } catch { return; }
  if (!st.isFile() || st.size > MAX_FILE_BYTES) return;
  const raw = readInsideWorkspace(src, "utf8");
  let out = raw;
  try {
    const m = yaml.load(raw);
    if (m && typeof m === "object") {
      delete m.extends;
      delete m.dependencies;
      out = yaml.dump(m);
    }
  } catch { /* unparseable: gitclaw rejects it too */ }
  fs.writeFileSync(dst, out);
}

function sweep() {
  if (Date.now() - lastSweep < SWEEP_EVERY_MS) return;
  lastSweep = Date.now();
  let homes = [];
  try { homes = fs.readdirSync(homesDir()); } catch { return; }
  for (const h of homes) {
    const home = join(homesDir(), h);
    try {
      const source = fs.readFileSync(join(home, ".source"), "utf8");
      if (!fs.existsSync(source)) fs.rmSync(home, { recursive: true, force: true });
    } catch { /* not ours or half-written */ }
  }
}

// The dir gitclaw should load for `dir`: unchanged outside a workspace, a refreshed server-owned copy inside one.
export function agentHomeFor(dir) {
  const src = resolve(dir || process.cwd());
  if (!workspaceRootOf(src)) return src;
  if (!isSafePath(src)) throw new Error("agent directory leaves its workspace");
  sweep();
  const home = join(homesDir(), createHash("sha256").update(src).digest("hex").slice(0, 16));
  fs.mkdirSync(home, { recursive: true });
  fs.writeFileSync(join(home, ".source"), src);
  const budget = { left: MAX_TOTAL_BYTES };
  for (const name of MIRRORED) {
    const to = join(home, name);
    fs.rmSync(to, { recursive: true, force: true });
    if (name === "agent.yaml") copyManifest(join(src, name), to);
    else copyTree(join(src, name), to, 0, budget);
  }
  return home;
}

export function safeQuery(options) {
  return query({ ...options, dir: agentHomeFor(options.dir) });
}
