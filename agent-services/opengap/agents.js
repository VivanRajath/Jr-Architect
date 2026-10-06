import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { agentDir } from './paths.js';
import { parseYaml } from './yaml.js';
import { globToRegExp, normalizePath } from './hooks.js';

// The installed agents, read from the agents themselves.

const DEFAULTS = { priority: 50, parallel: false, owns: [] };

// Who an agent hands to when it is out of attempts.
export function escalatesTo(agent, agents) {
  if (agent.terminal) return null;
  if (agent.escalatesTo) {
    const named = agents.find((a) => a.name === agent.escalatesTo);
    // A named successor that is not installed is a dead end, not a silent fallthrough to somebody else's agent.
    return named && named.name !== agent.name ? named.name : null;
  }
  const after = agents.filter((a) => a.priority > agent.priority);
  return after.length ? after[0].name : null;
}

/** Split `---` front matter off a Markdown file. Returns {meta, body}. */
export function frontMatter(text, source = 'SOUL.md') {
  const s = String(text ?? '');
  const m = s.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!m) return { meta: {}, body: s };
  let meta = {};
  try {
    const parsed = parseYaml(m[1], source);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) meta = parsed;
  } catch {
    // A malformed header costs the agent its metadata, not its existence.
  }
  return { meta, body: s.slice(m[0].length) };
}

// Every agent in `.gitagent/agents/`, in the order they should claim work.
export function readAgents(dir = agentDir()) {
  const base = join(dir, 'agents');
  if (!existsSync(base)) return [];

  const found = [];
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const soul = join(base, entry.name, 'SOUL.md');
    if (!existsSync(soul)) continue;

    const { meta } = frontMatter(readFileSync(soul, 'utf8'), `agents/${entry.name}/SOUL.md`);
    found.push({
      name: entry.name,
      dir: join(base, entry.name),
      role: str(meta.role),
      priority: num(meta.priority, DEFAULTS.priority),
      parallel: meta.parallel === true,
      owns: list(meta.owns),
      escalatesTo: str(meta.escalates_to) || null,
      terminal: meta.terminal === true,
      // Declared, not inferred from a name.
      fixesBuild: meta.fixes_build === true,
      attempts: num(meta.attempts, null),
      hasRules: existsSync(join(base, entry.name, 'RULES.md')),
    });
  }

  // Priority first, then name, so the order is stable across machines — readdir order is not, and an unstable order makes a swarm unreproducible.
  return found.sort((a, b) => a.priority - b.priority || (a.name < b.name ? -1 : 1));
}

const str = (v) => (typeof v === 'string' ? v.trim() : '');
const num = (v, fallback) => (Number.isFinite(Number(v)) ? Number(v) : fallback);
const list = (v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? [v] : []);

export function findAgent(name, agents) {
  return agents.find((a) => a.name === name) ?? null;
}

// An escalation loop among the installed agents, as a list of names, or null.
export function escalationCycle(agents) {
  const next = new Map(agents.map((a) => [a.name, a.terminal ? null : escalatesTo(a, agents)]));
  for (const start of next.keys()) {
    const path = [];
    let at = start;
    while (at && !path.includes(at)) {
      path.push(at);
      at = next.get(at);
    }
    if (at) return path.slice(path.indexOf(at));
  }
  return null;
}

/** The agent a red build routes to, if any is installed that claims to fix them. */
export function buildFixer(agents) {
  return agents.find((a) => a.fixesBuild) ?? null;
}

// Scope

// Does this agent own this path?
export function ownsPath(agent, path) {
  if (!agent.owns.length) return true;
  const rel = normalizePath(path);
  return agent.owns.some((glob) => globToRegExp(glob).test(rel));
}
