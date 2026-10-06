// The context ledger, and the compiler that turns it into a handoff package.

// The four invariants. Each exists because a model, asked nicely, will break it.

export function newLedger(task) {
  return {
    task,
    objective: task,
    decisions: [],
    completed: [],
    artifacts: [],
    issues: [],
    failed: [],
    assumptions: [],
    notes: [],
    next: null,
  };
}

const stamp = (tier, verified) => ({
  recorded_by: tier,
  recorded_at: new Date().toISOString(),
  verified: Boolean(verified),
});

const text = (v, max = 400) => String(v ?? '').trim().slice(0, max);

// Merge one attempt's claims into the canonical ledger.
export function reconcile(ledger, { tier, claims = {}, observed = {}, status }) {
  const written = new Set(observed.touched ?? []);

  for (const d of arr(claims.decisions)) {
    ledger.decisions.push({ what: text(d.what ?? d), why: text(d.why, 300), ...stamp(tier, false) });
  }

  for (const w of arr(claims.completed)) {
    const what = text(w.what ?? w);
    // Invariant 2: a file named only in prose is not evidence it was written.
    const proven = arr(w.files).some((f) => written.has(String(f)));
    ledger.completed.push({ what, files: arr(w.files).map(String), ...stamp(tier, proven) });
  }

  for (const path of written) {
    if (!ledger.artifacts.some((a) => a.path === path)) {
      // The harness saw this write happen, so it is verified regardless of whether the model remembered to mention it.
      ledger.artifacts.push({ path, ...stamp(tier, true) });
    }
  }

  for (const i of arr(claims.issues)) {
    ledger.issues.push({ what: text(i.what ?? i), ...stamp(tier, false), open: true });
  }

  // Invariant 1: closing an issue is a claim about the world, not a fact.
  for (const ref of arr(claims.resolved)) {
    const target = ledger.issues.find((i) => i.open && i.what.startsWith(text(ref, 60).slice(0, 40)));
    if (target && observed.green === true) {
      target.open = false;
      target.closed_by = tier;
    }
  }

  for (const a of arr(claims.assumptions)) {
    ledger.assumptions.push({ what: text(a.what ?? a), ...stamp(tier, false) });
  }

  // Invariant 3: append-only, and written by the engine from what it observed, not from what the failing worker chose to admit.
  if (status === 'failed' || status === 'handoff') {
    ledger.failed.push({
      tier,
      approach: text(claims.approach ?? claims.summary ?? '(no approach recorded)', 300),
      why: text(observed.reason ?? claims.why, 300),
      diffLines: observed.diffLines ?? 0,
      ...stamp(tier, true),
    });
  }

  if (claims.next) ledger.next = { what: text(claims.next, 300), ...stamp(tier, false) };
  for (const n of arr(claims.notes)) ledger.notes.push({ what: text(n.what ?? n), ...stamp(tier, false) });

  return ledger;
}

const arr = (v) => (Array.isArray(v) ? v : v == null ? [] : [v]);

// Compiling a handoff package

// Sections in fill order.
const SECTIONS = [
  'task', 'objective', 'next', 'decisions', 'completed',
  'artifacts', 'issues', 'failed', 'assumptions', 'notes',
];

const PINNED = new Set(['task', 'objective']);

const DEFAULT_BUDGET = 6000;

// Render the ledger as a briefing for `to`, within `budget` characters.
export function compile(ledger, { to, reason, budget = DEFAULT_BUDGET } = {}) {
  const parts = [];
  const omitted = [];
  let spent = 0;

  const render = {
    task: () => `## Task (unmodified)\n\n${ledger.task}`,
    objective: () => (ledger.objective && ledger.objective !== ledger.task ? `## Objective\n\n${ledger.objective}` : ''),
    next: () => (ledger.next ? `## Next action\n\n${ledger.next.what}` : ''),
    decisions: () => list('Decisions made', ledger.decisions, (d) => `- ${d.what}${d.why ? ` — ${d.why}` : ''}${mark(d)}`),
    completed: () => list('Work completed', ledger.completed, (w) => `- ${w.what}${w.files.length ? ` (${w.files.join(', ')})` : ''}${mark(w)}`),
    artifacts: () => list('Files touched', ledger.artifacts, (a) => `- ${a.path}${mark(a)}`),
    issues: () => list('Open issues', ledger.issues.filter((i) => i.open), (i) => `- ${i.what}${mark(i)}`),
    failed: () => list('Approaches already ruled out — do not repeat these', ledger.failed,
      (f) => `- ${f.tier}: ${f.approach}${f.why ? ` — failed because ${f.why}` : ''}`),
    assumptions: () => list('Assumptions', ledger.assumptions, (a) => `- ${a.what}${mark(a)}`),
    notes: () => list('Notes', ledger.notes, (n) => `- ${n.what}`),
  };

  for (const name of SECTIONS) {
    const body = render[name]();
    if (!body) continue;

    if (PINNED.has(name)) { parts.push(body); spent += body.length; continue; }

    const room = budget - spent;
    if (body.length <= room) { parts.push(body); spent += body.length; continue; }

    const trimmed = trim(body, room);
    if (trimmed) { parts.push(trimmed); spent += trimmed.length; omitted.push(`${name} (trimmed)`); }
    else omitted.push(name);
  }

  const header = reason ? `## Why this reached you\n\n${reason}` : '';
  // Omissions are stated, never silent.
  const footer = omitted.length
    ? `\n---\n\n_Context budget reached. Omitted or shortened: ${omitted.join(', ')}. The full record is in the session transcript._`
    : '';

  return [parts[0], header, ...parts.slice(1)].filter(Boolean).join('\n\n') + footer;
}

const mark = (r) => (r.verified ? '' : ' _(claimed, unverified)_');

function list(heading, items, fmt) {
  if (!items?.length) return '';
  return `## ${heading}\n\n${items.map(fmt).join('\n')}`;
}

/** Keep whole lines, and only if the heading plus at least one survives. */
function trim(body, room) {
  if (room < 80) return '';
  const [heading, ...lines] = body.split('\n');
  const kept = [];
  let used = heading.length + 2;
  for (const line of lines) {
    if (used + line.length + 1 > room - 40) break;
    kept.push(line);
    used += line.length + 1;
  }
  if (!kept.filter((l) => l.trim()).length) return '';
  return `${heading}\n${kept.join('\n')}\n_… ${lines.filter((l) => l.trim().startsWith('-')).length - kept.filter((l) => l.trim().startsWith('-')).length} more omitted_`;
}
