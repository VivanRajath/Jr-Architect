import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename as fileName, join, relative, resolve, sep } from 'node:path';
import { agentDir, repoRoot } from './paths.js';
import { parseYaml } from './yaml.js';

// The guardrail engine.

// Non-overridable hooks.
const SEALED = Object.freeze({
  'secret-scan': { phase: 'pre_edit', severity: 'block' },
  'no-force-push': { phase: 'pre_command', severity: 'block' },
  'protected-read': { phase: 'pre_command', severity: 'block' },
  'no-sudo': { phase: 'pre_command', severity: 'block' },
});

/** Floor config for sealed hooks, applied even if hooks.yaml is absent. */
const SEALED_FLOOR = {
  'secret-scan': {
    name: 'secret-scan',
    severity: 'block',
    overridable: false,
    known_prefixes: ['sk-', 'ghp_', 'gho_', 'AKIA', 'AIza', 'xoxb-', '-----BEGIN'],
    high_entropy: { min_length: 32, min_entropy_bits: 4.0, ignore_paths: [] },
  },
  'no-force-push': { name: 'no-force-push', severity: 'block', overridable: false },
  // Deliberately narrower than protected-paths.
  'protected-read': {
    name: 'protected-read',
    severity: 'block',
    overridable: false,
    paths: ['.env*', '.git/**', '**/*.pem', '**/id_rsa*', '**/.npmrc', '**/.aws/credentials'],
  },
  'no-sudo': { name: 'no-sudo', severity: 'block', overridable: false, commands: ['sudo', 'doas', 'su', 'runas'] },
};

const DEFAULT_EXFIL = ['curl', 'wget', 'nc', 'ncat', 'netcat', 'telnet', 'scp', 'sftp', 'ssh', 'rsync'];
const DEFAULT_DEP = ['npm', 'pnpm', 'yarn', 'bun', 'pip', 'pip3', 'cargo', 'go', 'gem', 'apt', 'apt-get'];

/** An ignore glob this broad would switch the entropy check off wholesale. */
const UNIVERSAL_GLOB = /^(\*|\*\*|\*\*\/\*|\*\*\/\*\*)$/;

// Loading

const cache = new Map();

// Every guard file in `hooks/`, not just `hooks.yaml`.
export function hookFiles(dir = agentDir()) {
  const base = join(dir, 'hooks');
  if (!existsSync(base)) return [];
  let names;
  try { names = readdirSync(base); } catch { return []; }
  const yaml = names.filter((n) => /\.ya?ml$/i.test(n)).sort();
  return [
    ...yaml.filter((n) => n !== 'hooks.yaml').map((n) => join(base, n)),
    ...yaml.filter((n) => n === 'hooks.yaml').map((n) => join(base, n)),
  ];
}

export function loadHooks(dir = agentDir(), { reload = false } = {}) {
  const files = hookFiles(dir);
  const key = files.join('|') || join(dir, 'hooks');
  if (!reload && cache.has(key)) return cache.get(key);

  const notes = [];
  const set = {
    file: files[files.length - 1] ?? join(dir, 'hooks', 'hooks.yaml'),
    files, notes,
    pre_edit: {}, pre_command: {}, pre_commit: {}, post_run: {},
  };

  if (!files.length) notes.push('no guard files in hooks/ — running with the sealed hooks only');

  for (const path of files) {
    // Fail closed. A guardrail file that does not parse must abort the run, never degrade into an unguarded one.
    const label = `hooks/${fileName(path)}`;
    const doc = parseYaml(readFileSync(path, 'utf8'), label) ?? {};
    if (typeof doc !== 'object' || Array.isArray(doc)) {
      throw new Error(`${label}: expected a mapping of hook phases at the top level`);
    }
    for (const phase of ['pre_edit', 'pre_command', 'pre_commit', 'post_run']) {
      const declared = Array.isArray(doc[phase]) ? doc[phase] : [];
      for (const raw of declared) {
        if (!raw || typeof raw !== 'object' || !raw.name) continue;
        if (set[phase][raw.name]) notes.push(`${raw.name}: redefined by ${label}`);
        set[phase][raw.name] = normalize(raw, notes);
      }
    }
  }

  // Sealed hooks exist whether or not the file declares them.
  for (const [name, meta] of Object.entries(SEALED)) {
    set[meta.phase][name] = seal(name, set[meta.phase][name], notes);
  }

  cache.set(key, set);
  return set;
}

function normalize(raw, notes) {
  const hook = { ...raw };
  hook.enabled = raw.enabled !== false;
  // `checks:` is a list of single-key maps in the shipped file; flatten it so callers read hook.known_prefixes rather than walking the list shape.
  for (const entry of Array.isArray(raw.checks) ? raw.checks : []) {
    if (entry && typeof entry === 'object') Object.assign(hook, entry);
  }
  if (Array.isArray(hook.high_entropy)) hook.high_entropy = {};
  return hook;
}

function seal(name, declared, notes) {
  const floor = SEALED_FLOOR[name];
  const hook = { ...floor, ...(declared ?? {}) };

  if (declared) {
    if (declared.overridable === true) notes.push(`${name}: overridable:true ignored — this hook is sealed in code`);
    if (declared.enabled === false) notes.push(`${name}: enabled:false ignored — this hook is sealed in code`);
    if (declared.severity && declared.severity !== SEALED[name].severity) {
      notes.push(`${name}: severity:${declared.severity} ignored — this hook is sealed at ${SEALED[name].severity}`);
    }
  }

  // Sealed properties come from code, never from the file.
  hook.name = name;
  hook.severity = SEALED[name].severity;
  hook.overridable = false;
  hook.enabled = true;

  // The file may only widen a sealed hook's lists, never shorten them.
  for (const key of ['known_prefixes', 'paths', 'commands']) {
    if (floor[key]) hook[key] = union(floor[key], declared?.[key]);
  }

  if (name === 'secret-scan') {
    const entropy = { ...floor.high_entropy, ...(hook.high_entropy ?? {}) };
    // ignore_paths is the one honest loosening the shipped file offers, and it exists because a lockfile hash is high-entropy and harmless.
    const ignore = (entropy.ignore_paths ?? []).filter((g) => {
      if (UNIVERSAL_GLOB.test(String(g).trim())) {
        notes.push(`secret-scan: ignore_paths entry "${g}" refused — it would disable the entropy check`);
        return false;
      }
      return true;
    });
    hook.high_entropy = { ...entropy, ignore_paths: ignore };
  }

  return hook;
}

const union = (a = [], b = []) => [...new Set([...(a ?? []), ...(Array.isArray(b) ? b : [])])];

/** Overridable hooks can be switched off with `enabled: false`; sealed ones cannot. */
function active(hook) {
  if (!hook) return null;
  if (SEALED[hook.name]) return hook;
  return hook.enabled ? hook : null;
}

// Glob matching

// Gitignore-ish semantics: a pattern containing no `/` matches a basename at any depth, so `.env*` catches packages/app/.env.local.
export function globToRegExp(glob) {
  const pattern = String(glob).replace(/\\/g, '/');
  const anchored = pattern.includes('/');
  let re = '';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        i++;
        if (pattern[i + 1] === '/') { i++; re += '(?:[^/]*/)*'; }   // **/ spans zero or more segments
        else re += '.*';
      } else re += '[^/]*';
    } else if (ch === '?') re += '[^/]';
    else if (ch === '{') re += '(?:';
    else if (ch === '}') re += ')';
    else if (ch === ',') re += '|';
    else if (ch === '[') {
      const end = pattern.indexOf(']', i);
      if (end === -1) re += '\\[';
      else { re += pattern.slice(i, end + 1); i = end; }
    } else re += ch.replace(/[.+^${}()|\\]/g, '\\$&');
  }
  return new RegExp(anchored ? `^${re}$` : `(?:^|/)${re}$`, 'i');
}

const globCache = new Map();
function matchesGlob(path, glob) {
  if (!globCache.has(glob)) globCache.set(glob, globToRegExp(glob));
  return globCache.get(glob).test(path);
}

export function matchesAny(path, globs = []) {
  return (globs ?? []).find((g) => matchesGlob(path, g)) ?? null;
}

/** Repo-relative, forward-slashed. Paths outside the repo keep their absolute form. */
export function normalizePath(filePath, root = repoRoot()) {
  const rel = relative(root, resolve(root, String(filePath)));
  if (rel.startsWith('..')) return String(filePath).split(sep).join('/');
  return rel.split(sep).join('/');
}

// Secret scanning

const TOKEN_RE = /[A-Za-z0-9+/=_-]+/g;

export function shannonBits(s) {
  const freq = new Map();
  for (const ch of s) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}

// Never render a candidate secret in full — a block reason ends up in logs, in the model transcript, and on the user's screen.
const mask = (token) => `${token.slice(0, 4)}…, ${token.length} chars`;

// The shortest thing any of the known prefixes produces in the wild: AWS is AKIA plus sixteen characters.
const MIN_CREDENTIAL = 20;
const MIN_SECRET_BODY = 12;

// Does this token actually look like the credential its prefix suggests?
export function looksLikeCredential(token, prefix) {
  if (prefix.startsWith('-')) return true;              // -----BEGIN PRIVATE KEY
  if (token.length < MIN_CREDENTIAL) return false;

  const body = token.slice(prefix.length);
  if (body.length < MIN_SECRET_BODY) return false;
  if (!/[0-9]/.test(body) || !/[A-Za-z]/.test(body)) return false;
  return shannonBits(body) >= 3.0;
}

/** Content the author pasted in on purpose, and which is not a credential. */
const DATA_URI = /(?:^|[^A-Za-z0-9])data:[\w.+-]+\/[\w.+-]+;base64,/i;

function scanLines(lines, hook, path) {
  const found = [];
  const prefixes = hook.known_prefixes ?? [];
  const entropy = hook.high_entropy ?? {};
  // ignore_paths scopes the entropy heuristic only.
  const ignored = matchesAny(path, entropy.ignore_paths);

  for (const { n, text } of lines) {
    const tokens = text.match(TOKEN_RE) ?? [];
    for (const prefix of prefixes) {
      // Per token, and anchored at its start: a credential IS a token, it is never a fragment in the middle of an identifier.
      const hit = tokens.find((t) => t.startsWith(prefix) && looksLikeCredential(t, prefix))
        ?? (prefix.startsWith('-') && text.includes(prefix) ? prefix : null);
      if (!hit) continue;
      found.push(`line ${n}: credential prefix "${prefix}" (${mask(hit)})`);
    }
    if (ignored) continue;

    // An inline data: URI is an image or a font the author embedded.
    if (DATA_URI.test(text)) continue;

    const minLength = entropy.min_length ?? 32;
    const minBits = entropy.min_entropy_bits ?? 4.0;
    for (const token of text.match(TOKEN_RE) ?? []) {
      if (token.length < minLength) continue;
      if (shannonBits(token) < minBits) continue;
      found.push(`line ${n}: high-entropy string (${mask(token)}, ${shannonBits(token).toFixed(1)} bits/char)`);
    }
  }
  return found;
}

// Lines present in `after` but not accounted for in `before`, with their line numbers in `after`.
export function lineDelta(before, after) {
  const beforeLines = before == null ? [] : String(before).split('\n');
  const afterLines = after == null ? [] : String(after).split('\n');

  const pool = new Map();
  for (const line of beforeLines) pool.set(line, (pool.get(line) ?? 0) + 1);

  const added = [];
  for (let i = 0; i < afterLines.length; i++) {
    const line = afterLines[i];
    const left = pool.get(line) ?? 0;
    if (left > 0) pool.set(line, left - 1);
    else added.push({ n: i + 1, text: line });
  }

  let removed = 0;
  for (const n of pool.values()) removed += n;
  return { added, removed };
}

// pre_edit

const verdict = () => ({ allowed: true, blocked: [], warnings: [] });
const block = (v, hook, reason) => { v.allowed = false; v.blocked.push({ hook, reason }); };
const warn = (v, hook, reason, checkpoint = false) => { v.warnings.push({ hook, reason, checkpoint }); };

/** Hooks with dedicated logic above. Everything else is checked by shape. */
const BUILTIN_EDIT = new Set(['secret-scan', 'protected-paths', 'scope-fence', 'diff-ceiling']);
const BUILTIN_COMMAND = new Set(['no-sudo', 'no-force-push', 'protected-read', 'no-exfil', 'destructive', 'dep-change']);

function others(phase, builtin) {
  return Object.values(phase ?? {}).filter((h) => h && !builtin.has(h.name) && active(h));
}

const appliesTo = (hook, tier) => !Array.isArray(hook.applies_to) || hook.applies_to.includes(tier);

// Apply a shape-matched hook according to its severity.
function enforce(v, hook, why) {
  const detail = hook.description ? ` ${String(hook.description).trim()}` : '';
  if (hook.checkpoint === true || hook.severity === 'checkpoint') {
    warn(v, hook.name, `${why} — this needs your approval.${detail}`, true);
  } else if (hook.severity === 'warn') {
    warn(v, hook.name, `${why}.${detail}`);
  } else {
    block(v, hook.name, `${why}, which ${hook.name} protects.${detail} Hand off or leave it alone rather than working around it.`);
  }
}

// `change` is {before, after}: the file's current content (null for a new file) and the content about to be written.
export function checkEdit(filePath, change, tier, hooks = loadHooks()) {
  const v = verdict();
  const path = normalizePath(filePath);
  const { before, after } = change ?? {};
  const { added, removed } = lineDelta(before, after);

  const secrets = active(hooks.pre_edit['secret-scan']);
  if (secrets) {
    const found = scanLines(added, secrets, path);
    if (found.length) {
      block(v, 'secret-scan', `${path} introduces credential-shaped content — ${found.join('; ')}. Remove it or read the value from an environment variable.`);
    }
  }

  const protectedPaths = active(hooks.pre_edit['protected-paths']);
  if (protectedPaths) {
    const hit = matchesAny(path, protectedPaths.paths);
    if (hit) block(v, 'protected-paths', `${path} is a protected path (matches "${hit}"). Editing it is a human checkpoint, not an agent step.`);
  }

  const fence = active(hooks.pre_edit['scope-fence']);
  if (fence && (fence.applies_to ?? []).includes(tier)) {
    const denied = matchesAny(path, fence.deny);
    if (denied) {
      block(v, 'scope-fence', `${tier} may not edit ${path} (matches deny "${denied}"). Hand off rather than crossing the boundary.`);
    } else if (!matchesAny(path, fence.allow)) {
      block(v, 'scope-fence', `${tier} may only edit presentational files; ${path} is not in its allow list. Hand off rather than crossing the boundary.`);
    }
  }

  const ceiling = active(hooks.pre_edit['diff-ceiling']);
  if (ceiling) {
    const total = added.length + removed;
    const max = ceiling.max_lines ?? 400;
    if (total > max) {
      // severity is warn in the shipped file; DUTIES.md makes an oversized single edit a human checkpoint, so it routes there rather than failing.
      warn(v, 'diff-ceiling', `${path}: ${total} changed lines exceeds the ${max}-line ceiling.`, true);
    }
  }

  // Every other hook is enforced by its SHAPE, not its name.
  for (const hook of others(hooks.pre_edit, BUILTIN_EDIT)) {
    if (!appliesTo(hook, tier) || !hook.paths?.length) continue;
    const hit = matchesAny(path, hook.paths);
    if (hit) enforce(v, hook, `${path} matches "${hit}"`);
  }

  return v;
}

// pre_command

const isFlag = (a, ...names) => names.includes(a);
const hasFlag = (argv, ...names) => argv.some((a) => isFlag(a, ...names));

/** Short flags combine: -rf, -fr, -fdx. */
function hasShortFlag(argv, letter) {
  return argv.some((a) => /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(letter));
}

const gitSub = (argv) => {
  // Skip git's own leading options: git -C path status
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-C' || a === '-c' || a === '--git-dir' || a === '--work-tree') { i++; continue; }
    if (a.startsWith('-')) continue;
    return { sub: a, rest: argv.slice(i + 1) };
  }
  return { sub: null, rest: [] };
};

const NETWORK_RE = /^(?:[a-z][a-z0-9+.-]*:\/\/|[^\s@]+@[^\s@]+|[a-z0-9.-]+\.[a-z]{2,}(?::\d+)?(?:\/|$))/i;
const hasNetworkDestination = (argv) => argv.slice(1).some((a) => !a.startsWith('-') && NETWORK_RE.test(a));

/** Tokens that could name a file, including --flag=value forms. */
function pathTokens(argv) {
  const out = [];
  for (const a of argv.slice(1)) {
    if (a.includes('=')) out.push(a.slice(a.indexOf('=') + 1));
    if (!a.startsWith('-')) out.push(a);
  }
  return out.filter(Boolean);
}

const basename = (cmd) => String(cmd).split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, '');

// `argv` is an array, and run.js executes it with execFile and shell:false.
export function checkCommand(argv, tier, hooks = loadHooks()) {
  const v = verdict();
  if (!Array.isArray(argv) || argv.length === 0 || typeof argv[0] !== 'string') {
    block(v, 'pre_command', 'run_command takes a non-empty argv array, e.g. ["npm","run","build"].');
    return v;
  }
  const args = argv.map(String);
  const bin = basename(args[0]);
  const git = bin === 'git' ? gitSub(args) : { sub: null, rest: [] };

  const sudo = active(hooks.pre_command['no-sudo']);
  if (sudo && (sudo.commands ?? []).map(basename).includes(bin)) {
    block(v, 'no-sudo', `"${bin}" escalates privileges. Nothing in a run needs that.`);
  }

  const force = active(hooks.pre_command['no-force-push']);
  if (force && bin === 'git') {
    const reason = historyRewrite(git, args);
    if (reason) block(v, 'no-force-push', `${reason} Session branch history is not rewritable.`);
  }

  const read = active(hooks.pre_command['protected-read']);
  if (read) {
    for (const token of pathTokens(args)) {
      const hit = protectedRead(token, read);
      if (hit) {
        block(v, 'protected-read', `"${token}" names a protected path (matches "${hit}"). Reading it is a leak, not just writing it.`);
        break;
      }
    }
  }

  const exfil = active(hooks.pre_command['no-exfil']);
  if (exfil && (exfil.commands ?? DEFAULT_EXFIL).map(basename).includes(bin) && hasNetworkDestination(args)) {
    block(v, 'no-exfil', `"${bin}" with a network destination sends repository content off this machine.`);
  }

  const destructive = active(hooks.pre_command['destructive']);
  if (destructive) {
    const reason = destructiveReason(bin, git, args);
    if (reason) block(v, 'destructive', reason);
  }

  const dep = active(hooks.pre_command['dep-change']);
  if (dep) {
    const reason = depChangeReason(bin, args, dep.commands ?? DEFAULT_DEP);
    // Not a block: DUTIES.md already lists a dependency change as a human checkpoint, so this routes there instead of failing the step.
    if (reason) warn(v, 'dep-change', reason, true);
  }

  // Same rule as checkEdit: any other hook is enforced by what it declares.
  for (const hook of others(hooks.pre_command, BUILTIN_COMMAND)) {
    if (!appliesTo(hook, tier)) continue;
    if (hook.commands?.length && hook.commands.map(basename).includes(bin)) {
      enforce(v, hook, `"${bin}" is listed`);
      continue;
    }
    if (hook.paths?.length) {
      const token = pathTokens(args).find((t) => matchesAny(normalizePath(t), hook.paths));
      if (token) enforce(v, hook, `"${token}" matches "${matchesAny(normalizePath(token), hook.paths)}"`);
    }
  }

  return v;
}

/** Which protected-read glob a path hits, if any. `.git/**` also covers `.git`. */
function protectedRead(token, hook) {
  const path = normalizePath(token);
  return matchesAny(path, hook.paths) ?? matchesAny(path, (hook.paths ?? []).map((g) => g.replace(/\/\*\*$/, '')));
}

function historyRewrite({ sub, rest }, args) {
  if (sub === 'push') {
    if (hasFlag(rest, '--force', '--force-with-lease') || hasShortFlag(rest, 'f')) return 'git push --force rewrites published history.';
    if (rest.some((a) => a.startsWith('+') && a.includes(':'))) return 'a "+" refspec force-updates the remote ref.';
    if (hasFlag(rest, '--delete', '-d')) return 'git push --delete removes a remote ref.';
    if (rest.some((a) => /^:/.test(a) && a.length > 1)) return 'a ":ref" refspec deletes a remote branch.';
  }
  if (sub === 'reset' && hasFlag(rest, '--hard')) return 'git reset --hard discards commits and working-tree state.';
  if (sub === 'rebase' && !hasFlag(rest, '--abort', '--quit')) return 'git rebase rewrites commit history.';
  if (sub === 'commit' && hasFlag(rest, '--amend')) return 'git commit --amend rewrites the last commit.';
  if (sub === 'filter-branch' || sub === 'filter-repo') return `git ${sub} rewrites the whole history.`;
  if (sub === 'update-ref' && hasFlag(rest, '-d', '--delete')) return 'git update-ref -d deletes a ref directly.';
  if (sub === 'reflog' && rest[0] === 'expire') return 'git reflog expire destroys the recovery log.';
  if (sub === 'branch' && (hasFlag(rest, '-D') || (hasFlag(rest, '-d') && hasFlag(rest, '--force')))) {
    return 'git branch -D force-deletes a branch.';
  }
  return null;
}

function destructiveReason(bin, { sub, rest }, args) {
  if (bin === 'rm' && (hasShortFlag(args, 'r') || hasFlag(args, '--recursive')) && (hasShortFlag(args, 'f') || hasFlag(args, '--force'))) {
    return 'rm -rf deletes a tree with no confirmation and no undo.';
  }
  if (bin === 'rmdir' && hasFlag(args, '/s', '/q')) return 'rmdir /s deletes a tree with no undo.';
  if (bin === 'git' && sub === 'clean' && (hasShortFlag(rest, 'f') || hasFlag(rest, '--force'))) {
    return 'git clean -f deletes untracked files, including work not yet staged.';
  }
  if (bin === 'git' && sub === 'checkout' && rest.includes('--') && rest[rest.indexOf('--') + 1] === '.') {
    return 'git checkout -- . discards every unstaged change in the tree.';
  }
  if (bin === 'git' && sub === 'restore' && (rest.includes('.') || hasFlag(rest, '--staged')) && !rest.some((a) => a !== '.' && !a.startsWith('-'))) {
    return 'git restore . discards every unstaged change in the tree.';
  }
  if (bin === 'dropdb') return 'dropdb destroys a database.';
  if (/\b(DROP\s+(DATABASE|TABLE|SCHEMA)|TRUNCATE\s+TABLE)\b/i.test(args.slice(1).join(' '))) {
    return 'the command contains a destructive SQL statement.';
  }
  return null;
}

function depChangeReason(bin, args, commands) {
  if (!commands.map(basename).includes(bin)) return null;
  const sub = args.slice(1).find((a) => !a.startsWith('-')) ?? '';
  const named = args.slice(1).filter((a) => !a.startsWith('-'));

  if (['npm', 'pnpm', 'yarn', 'bun'].includes(bin)) {
    if (!['install', 'i', 'add', 'remove', 'rm', 'uninstall', 'un', 'update', 'up', 'upgrade'].includes(sub)) return null;
    // A bare `npm install` restores from the lockfile; build-doctor needs that.
    if (['install', 'i'].includes(sub) && named.length === 1) return null;
    return `"${bin} ${sub}" changes dependencies, which DUTIES.md makes a human checkpoint.`;
  }
  if (['pip', 'pip3'].includes(bin) && ['install', 'uninstall'].includes(sub)) {
    return `"${bin} ${sub}" changes dependencies, which DUTIES.md makes a human checkpoint.`;
  }
  if (bin === 'cargo' && ['add', 'remove', 'install', 'update'].includes(sub)) {
    return `"cargo ${sub}" changes dependencies, which DUTIES.md makes a human checkpoint.`;
  }
  if (bin === 'go' && ['get', 'install'].includes(sub)) {
    return `"go ${sub}" changes dependencies, which DUTIES.md makes a human checkpoint.`;
  }
  if (bin === 'gem' && ['install', 'uninstall', 'update'].includes(sub)) {
    return `"gem ${sub}" changes dependencies, which DUTIES.md makes a human checkpoint.`;
  }
  if (['apt', 'apt-get'].includes(bin) && ['install', 'remove', 'purge', 'upgrade'].includes(sub)) {
    return `"${bin} ${sub}" changes system packages, which DUTIES.md makes a human checkpoint.`;
  }
  return null;
}
