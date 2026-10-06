// fs calls for code that touches sandbox workspaces: a path inside one may not be carried outside it by a symlink.
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { resolve, dirname, basename, join, sep } from "node:path";

const WORKSPACE_NAME = /^(sandbox|builder)-/;

function inside(root, p) {
  const r = root.endsWith(sep) ? root.slice(0, -1) : root;
  return p === r || p.startsWith(r + sep);
}

function real(p) {
  try { return fs.realpathSync.native(p); } catch { return null; }
}

// The Go server creates every workspace as <JR_WORK_DIR or tmp>/sandbox-* or builder-*.
export function workspaceRootOf(p) {
  const abs = resolve(String(p));
  const bases = [process.env.JR_WORK_DIR, tmpdir()].filter(Boolean).map((b) => resolve(b));
  for (const base of bases) {
    if (abs === base || !inside(base, abs)) continue;
    const name = abs.slice(base.length).split(/[\\/]/).filter(Boolean)[0];
    if (name && WORKSPACE_NAME.test(name)) return join(base, name);
  }
  return null;
}

// Real path of p via its deepest existing ancestor; null when a link on the way dangles.
function realLocation(p) {
  const rest = [];
  for (let cur = p; ;) {
    const r = real(cur);
    if (r) return join(r, ...rest);
    try { fs.lstatSync(cur); return null; } catch { /* missing: climb */ }
    const parent = dirname(cur);
    if (parent === cur) return null;
    rest.unshift(basename(cur));
    cur = parent;
  }
}

export function isSafePath(p) {
  const abs = resolve(String(p));
  const root = workspaceRootOf(abs);
  if (!root) return true;
  const realRoot = real(root);
  if (!realRoot) return true;
  const loc = realLocation(abs);
  return loc !== null && inside(realRoot, loc);
}

// Absolute path for a repo-relative path, or null when it leaves root by any route.
export function resolveInside(root, rel) {
  if (typeof rel !== "string" || !rel.trim()) return null;
  const base = resolve(root);
  const abs = resolve(base, rel.trim().replace(/^\.\//, ""));
  if (!inside(base, abs)) return null;
  const realRoot = real(base);
  if (!realRoot) return abs;
  const loc = realLocation(abs);
  return loc !== null && inside(realRoot, loc) ? abs : null;
}

function refused(p) {
  const e = new Error(`ENOENT: path leaves its workspace, '${p}'`);
  e.code = "ENOENT";
  return e;
}

function guarded(fn) {
  return (p, ...rest) => {
    if (typeof p === "string" && !isSafePath(p)) throw refused(p);
    return fn(p, ...rest);
  };
}

const O = fs.constants;
// Only Linux (the WSL runtime) exposes an open fd's real path; elsewhere the path check alone applies.
const canVerifyFd = process.platform === "linux";

function fdInside(fd, realRoot) {
  try { return inside(realRoot, fs.readlinkSync(`/proc/self/fd/${fd}`)); } catch { return false; }
}

// The path check can be raced by the sandbox, so reads confirm what was actually opened before reading from it.
export function readInsideWorkspace(p, opts) {
  const root = workspaceRootOf(resolve(String(p)));
  if (!root || !canVerifyFd) return fs.readFileSync(p, opts);
  const realRoot = real(root);
  // O_NONBLOCK so a pipe planted outside cannot hang the open.
  const fd = fs.openSync(p, O.O_RDONLY | O.O_NONBLOCK);
  try {
    if (!realRoot || !fdInside(fd, realRoot)) throw refused(p);
    return fs.readFileSync(fd, opts);
  } finally {
    fs.closeSync(fd);
  }
}

// Nothing is truncated or written until the opened file is confirmed inside; a file this call created outside is removed.
export function writeInsideWorkspace(p, data, append = false) {
  const root = workspaceRootOf(resolve(String(p)));
  if (!root || !canVerifyFd) return append ? fs.appendFileSync(p, data) : fs.writeFileSync(p, data);
  const realRoot = real(root);
  let fd;
  let created = false;
  const mode = O.O_WRONLY | O.O_NONBLOCK | (append ? O.O_APPEND : 0);
  try {
    fd = fs.openSync(p, mode);
  } catch (e) {
    if (e.code !== "ENOENT") throw e;
    fd = fs.openSync(p, mode | O.O_CREAT | O.O_EXCL, 0o644);
    created = true;
  }
  try {
    if (!realRoot || !fdInside(fd, realRoot)) {
      if (created) {
        try { fs.unlinkSync(fs.readlinkSync(`/proc/self/fd/${fd}`)); } catch { /* already gone */ }
      }
      throw refused(p);
    }
    if (!append) fs.ftruncateSync(fd, 0);
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(String(data));
    fs.writeSync(fd, buf, 0, buf.length, append ? null : 0);
  } finally {
    fs.closeSync(fd);
  }
}

export const readFileSync = guarded(readInsideWorkspace);
export const writeFileSync = guarded((p, data) => writeInsideWorkspace(p, data));
export const appendFileSync = guarded((p, data) => writeInsideWorkspace(p, data, true));
export const statSync = guarded(fs.statSync);
export const readdirSync = guarded(fs.readdirSync);
export const mkdirSync = guarded(fs.mkdirSync);
export const existsSync = (p) => (typeof p !== "string" || isSafePath(p)) && fs.existsSync(p);
// rm unlinks a symlink rather than following it.
export const rmSync = fs.rmSync;

// Repo config can name programs (fsmonitor, hooks, diff drivers) that git would run on the host.
export const SAFE_GIT = [
  "-c", "core.fsmonitor=false",
  "-c", `core.hooksPath=${join(tmpdir(), "jr-no-hooks")}`,
  "-c", "diff.external=",
  "-c", "core.pager=cat",
  "-c", "protocol.file.allow=never",
];

// A workspace .git must be a real directory: a gitfile or link would point git at a host repo.
export function assertOwnGitDir(dir) {
  if (!workspaceRootOf(dir)) return;
  const git = join(resolve(dir), ".git");
  let st;
  try { st = fs.lstatSync(git); } catch { throw new Error(`${dir} is not a git repository`); }
  if (!st.isDirectory() || !isSafePath(git)) throw new Error(".git must be a plain directory inside the workspace");
}
