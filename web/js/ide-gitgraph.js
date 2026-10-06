// IDE Git Graph: every branch's commits as lanes, with refs, a commit's files and their diffs.

const GG = { commits: [], rows: [], head: '', branch: '', shallow: false, repo: true, selected: null, detail: null, loading: false, container: null };
const GG_LANE = 14;
const GG_ROW = 26;
const GG_COLORS = ['#60a5fa', '#f472b6', '#34d399', '#fbbf24', '#a78bfa', '#f87171', '#22d3ee', '#fb923c'];

const ggEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s ?? ''));

async function loadGitGraph(force) {
  const pane = document.getElementById('git-graph');
  if (!pane || !IDE.container) return;
  if (GG.container !== IDE.container) Object.assign(GG, { commits: [], rows: [], selected: null, detail: null, container: IDE.container });
  if (GG.loading || (GG.commits.length && !force)) { renderGitGraph(); return; }
  GG.loading = true;
  pane.innerHTML = '<div class="gg-empty">Reading the history…</div>';
  try {
    const res = await fetch(`/github/log?container=${encodeURIComponent(IDE.container)}&limit=300`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'could not read the history');
    Object.assign(GG, { commits: d.commits || [], head: d.head || '', branch: d.branch || '', shallow: !!d.shallow, repo: d.repo !== false });
    GG.rows = layoutLanes(GG.commits);
  } catch (e) {
    pane.innerHTML = `<div class="gg-empty">${ggEsc(e.message)}</div>`;
    GG.loading = false;
    return;
  }
  GG.loading = false;
  renderGitGraph();
}

// Assigns each commit a lane; a lane holds the hash it expects next, so branches and merges become lines between rows.
function layoutLanes(commits) {
  const lanes = [];
  return commits.map((c) => {
    let lane = lanes.indexOf(c.hash);
    if (lane < 0) { lane = lanes.indexOf(null); if (lane < 0) lane = lanes.length; lanes[lane] = c.hash; }
    const before = lanes.slice();
    // Other lanes that were also waiting for this commit join it here.
    const joins = before.map((h, i) => (h === c.hash && i !== lane ? i : -1)).filter((i) => i >= 0);
    joins.forEach((i) => { lanes[i] = null; });
    lanes[lane] = c.parents[0] || null;
    const forks = [];
    c.parents.slice(1).forEach((p) => {
      let j = lanes.indexOf(p);
      if (j < 0) { j = lanes.indexOf(null); if (j < 0) j = lanes.length; lanes[j] = p; }
      forks.push(j);
    });
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop();
    return { c, lane, before, after: lanes.slice(), joins, forks };
  });
}

function ggRowSVG(row, width) {
  const x = (i) => i * GG_LANE + GG_LANE / 2 + 2;
  const mid = GG_ROW / 2;
  const color = (i) => GG_COLORS[i % GG_COLORS.length];
  const parts = [];
  row.before.forEach((h, i) => {
    if (h === null) return;
    if (i === row.lane || row.joins.includes(i)) parts.push(`<path d="M${x(i)} 0 C ${x(i)} ${mid / 2}, ${x(row.lane)} ${mid / 2}, ${x(row.lane)} ${mid}" stroke="${color(i)}"/>`);
    else parts.push(`<line x1="${x(i)}" y1="0" x2="${x(i)}" y2="${mid}" stroke="${color(i)}"/>`);
  });
  row.after.forEach((h, i) => {
    if (h === null) return;
    const fromLane = i === row.lane || row.forks.includes(i) ? row.lane : i;
    if (fromLane === i) parts.push(`<line x1="${x(i)}" y1="${mid}" x2="${x(i)}" y2="${GG_ROW}" stroke="${color(i)}"/>`);
    else parts.push(`<path d="M${x(fromLane)} ${mid} C ${x(fromLane)} ${mid + mid / 2}, ${x(i)} ${mid + mid / 2}, ${x(i)} ${GG_ROW}" stroke="${color(i)}"/>`);
  });
  const isHead = row.c.hash === GG.head;
  parts.push(`<circle cx="${x(row.lane)}" cy="${mid}" r="${isHead ? 5 : 4}" fill="${isHead ? 'var(--bg)' : color(row.lane)}" stroke="${color(row.lane)}" stroke-width="${isHead ? 2.5 : 0}"/>`);
  return `<svg class="gg-svg" width="${width}" height="${GG_ROW}" viewBox="0 0 ${width} ${GG_ROW}">${parts.join('')}</svg>`;
}

function ggRefsHTML(refs) {
  return (refs || []).map((r) => {
    const tag = r.startsWith('tag: ');
    const head = r.startsWith('HEAD -> ');
    const remote = /^origin\//.test(r);
    const name = r.replace(/^HEAD -> |^tag: /, '');
    if (r === 'HEAD' || r === 'origin/HEAD') return '';
    return `<span class="gg-ref ${tag ? 'tag' : head ? 'head' : remote ? 'remote' : 'local'}">${head ? '● ' : ''}${ggEsc(name)}</span>`;
  }).join('');
}

function ggDate(iso) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  const s = (Date.now() - d) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d`;
  return d.toLocaleDateString();
}

function renderGitGraph() {
  const pane = document.getElementById('git-graph');
  if (!pane) return;
  if (!GG.repo) { pane.innerHTML = '<div class="gg-empty">This project is not a git repository yet. Publish it from Source Control to start its history.</div>'; return; }
  const lanes = Math.max(1, ...GG.rows.map((r) => Math.max(r.before.length, r.after.length, r.lane + 1)));
  const width = Math.min(lanes, 12) * GG_LANE + 6;
  pane.innerHTML = `
    <div class="gg-toolbar">
      <span class="gg-title">Git Graph</span>
      ${GG.branch ? `<span class="gg-ref head">● ${ggEsc(GG.branch)}</span>` : ''}
      <span class="gg-muted">${GG.commits.length} commit${GG.commits.length === 1 ? '' : 's'}${GG.shallow ? ' · shallow clone' : ''}</span>
      <span class="gg-spacer"></span>
      ${GG.shallow ? '<button class="gg-btn" type="button" onclick="ggUnshallow(this)" title="Fetch every commit and branch from the remote">Load full history</button>' : ''}
      <button class="gg-btn" type="button" onclick="loadGitGraph(true)">Refresh</button>
    </div>
    <div class="gg-body">
      <div class="gg-list">${GG.rows.map((r, i) => `
        <div class="gg-row${GG.selected === r.c.hash ? ' on' : ''}${r.c.hash === GG.head ? ' is-head' : ''}" data-i="${i}" title="${ggEsc(r.c.hash)}">
          ${ggRowSVG(r, width)}
          <span class="gg-subject">${ggRefsHTML(r.c.refs)}<span>${ggEsc(r.c.subject)}</span></span>
          <span class="gg-author">${ggEsc(r.c.author)}</span>
          <span class="gg-when">${ggDate(r.c.date)}</span>
          <code class="gg-hash">${ggEsc(r.c.short)}</code>
        </div>`).join('') || '<div class="gg-empty">No commits yet.</div>'}
      </div>
      ${GG.selected ? `<div class="gg-detail">${ggDetailHTML()}</div>` : ''}
    </div>`;
  pane.querySelectorAll('.gg-row').forEach((el) => el.addEventListener('click', () => ggSelect(GG.rows[Number(el.dataset.i)].c.hash)));
  pane.querySelectorAll('.gg-file').forEach((el) => el.addEventListener('click', () => ggOpenDiff(el.dataset.path)));
}

function ggDetailHTML() {
  const d = GG.detail;
  if (!d) return '<div class="gg-empty">Loading the commit…</div>';
  if (d.error) return `<div class="gg-empty">${ggEsc(d.error)}</div>`;
  const letter = { A: 'added', M: 'modified', D: 'deleted', R: 'renamed', C: 'copied', T: 'changed' };
  return `<div class="gg-d-head"><code>${ggEsc(d.hash.slice(0, 10))}</code><button class="gg-x" type="button" onclick="GG.selected=null;renderGitGraph()">×</button></div>
    <div class="gg-d-msg">${ggEsc(d.message)}</div>
    <div class="gg-muted">${ggEsc(d.author)} · ${new Date(d.date).toLocaleString()}</div>
    <div class="gg-d-files">${d.files.map((f) => `<button class="gg-file" type="button" data-path="${ggEsc(f.path)}" ${f.status[0] === 'D' ? '' : ''}><span class="gg-st s-${ggEsc(f.status[0])}" title="${ggEsc(letter[f.status[0]] || f.status)}">${ggEsc(f.status[0])}</span><span>${ggEsc(f.path)}</span></button>`).join('') || '<div class="gg-muted">No file changes (a merge, or an empty commit).</div>'}</div>`;
}

async function ggSelect(hash) {
  GG.selected = hash;
  GG.detail = null;
  renderGitGraph();
  try {
    const res = await fetch(`/github/show?container=${encodeURIComponent(IDE.container)}&hash=${hash}`);
    const d = await res.json();
    GG.detail = res.ok ? d : { error: d.error || 'could not read the commit' };
  } catch (e) { GG.detail = { error: e.message }; }
  if (GG.selected === hash) renderGitGraph();
}

async function ggOpenDiff(path) {
  try {
    const res = await fetch(`/github/show?container=${encodeURIComponent(IDE.container)}&hash=${GG.selected}&path=${encodeURIComponent(path)}`);
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'could not read the file');
    if (typeof showDiffModal === 'function') showDiffModal(`${path} @ ${GG.selected.slice(0, 7)}`, d.before, d.after);
  } catch (e) { showToast(e.message, 'error'); }
}

async function ggUnshallow(btn) {
  btn.disabled = true;
  btn.textContent = 'Fetching…';
  try {
    const res = await fetch('/github/unshallow', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jr': '1' }, body: JSON.stringify({ container: IDE.container }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'fetch failed');
    await loadGitGraph(true);
  } catch (e) {
    showToast(e.message, 'error');
    btn.disabled = false;
    btn.textContent = 'Load full history';
  }
}
