// Shim for the vendored jr-arch modules: every caller here passes the workspace's .gitagent folder explicitly.
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const TARGET = '.gitagent';

export function repoRoot(from = process.cwd()) {
  let dir = from;
  while (true) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return from;
    dir = parent;
  }
}

export function agentDir() { return join(repoRoot(), TARGET); }
