// Shared by Agent Hub and Agent Studio: API calls, escaping, toasts, theme and cross-window refresh.
(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin) return nativeFetch(input, init);
    const headers = new Headers(init.headers || undefined);
    headers.set('X-Jr', '1');
    const res = await nativeFetch(input, { ...init, headers });
    if (res.status === 401 && !url.pathname.startsWith('/auth/')) location.href = '/login';
    return res;
  };
})();

const HUB_API = '/agent/hub';

async function hubApi(method, path, body) {
  const res = await fetch(HUB_API + path, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = {};
  try { data = await res.json(); } catch { /* empty body */ }
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function hubToast(msg, type = 'ok') {
  let box = document.getElementById('h-toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'h-toasts';
    box.className = 'h-toasts';
    box.setAttribute('role', 'status');
    document.body.appendChild(box);
  }
  const el = document.createElement('div');
  el.className = `h-toast ${type}`;
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 6000 : 3200);
}

function timeAgo(ms) {
  const s = Math.max(1, Math.round((Date.now() - ms) / 1000));
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return new Date(ms).toLocaleDateString();
}

function downloadJSON(name, obj) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); hubToast('Copied'); } catch { hubToast('Copy failed; select and copy by hand', 'error'); }
}

// The same preference the IDE stores, so every window matches.
function applyTheme() {
  let dark = false;
  try { dark = localStorage.getItem('jr-dark-mode') === 'true'; } catch { /* storage blocked */ }
  document.body.classList.toggle('dark-mode', dark);
}
function toggleTheme() {
  const dark = !document.body.classList.contains('dark-mode');
  document.body.classList.toggle('dark-mode', dark);
  try { localStorage.setItem('jr-dark-mode', dark); } catch { /* storage blocked */ }
}

// Studio saves in its own window; the Hub listens so its list stays current.
const hubChannel = 'BroadcastChannel' in window ? new BroadcastChannel('jr-agent-hub') : null;

function openStudio(agentId) {
  location.href = agentId ? `/studio.html?agent=${encodeURIComponent(agentId)}` : '/studio.html';
}

// Back goes to the page that opened this one when it is ours (Hub, home, a workflow), else to the Hub.
function goBack(fallback = '/hub.html') {
  let target = fallback;
  try {
    const ref = new URL(document.referrer);
    if (ref.origin === location.origin && ref.pathname !== location.pathname) target = ref.pathname + ref.search + ref.hash;
  } catch { /* no referrer */ }
  location.href = target;
}

const STATUS_LABEL = {
  completed: 'Completed', awaiting_approval: 'Needs approval', failed: 'Failed', rejected: 'Rejected', blocked: 'Blocked', running: 'Running',
};

// One run as a readable trace: steps, a pending approval, then the output or error.
function renderRun(run, { onDecision } = {}) {
  const steps = (run.steps || []).map((s) => `
    <li class="h-trace-step k-${esc(s.kind)}">
      <span class="h-trace-kind">${esc(s.kind.replace('_', ' '))}</span>
      <span class="h-trace-detail">${esc(s.detail)}${s.why ? `<em> · ${esc(s.why)}</em>` : ''}</span>
    </li>`).join('');
  const p = run.pendingApproval;
  const approval = p ? `
    <div class="h-approval">
      <strong>${esc(p.summary)}</strong>
      ${p.type === 'tool' ? `<pre class="h-code">${esc(JSON.stringify(p.args, null, 2))}</pre>` : `<pre class="h-code">${esc(typeof p.output === 'string' ? p.output : JSON.stringify(p.output, null, 2))}</pre>`}
      <input class="h-input" data-approval-note placeholder="Optional note for the agent or the log">
      <div class="h-row">
        <button class="h-btn h-btn-ok" data-decide="1">Approve</button>
        <button class="h-btn h-btn-ghost" data-decide="0">Reject</button>
      </div>
    </div>` : '';
  const out = run.output != null && run.status !== 'awaiting_approval'
    ? `<div class="h-label">Output</div><pre class="h-code">${esc(typeof run.output === 'string' ? run.output : JSON.stringify(run.output, null, 2))}</pre>` : '';
  const err = run.error ? `<div class="h-callout bad">${esc(run.error)}</div>` : '';
  const el = document.createElement('div');
  el.className = 'h-run';
  el.innerHTML = `
    <div class="h-run-head">
      <span class="h-pill s-${esc(run.status)}">${esc(STATUS_LABEL[run.status] || run.status)}</span>
      <span class="h-muted">${esc(run.source || '')} · ${run.finishedAt ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s` : 'in progress'} · ${esc(run.id)}</span>
    </div>
    <ol class="h-trace">${steps}</ol>${approval}${err}${out}`;
  if (p && onDecision) {
    el.querySelectorAll('[data-decide]').forEach((b) => b.addEventListener('click', () => {
      el.querySelectorAll('[data-decide]').forEach((x) => { x.disabled = true; });
      onDecision(b.dataset.decide === '1', el.querySelector('[data-approval-note]').value);
    }));
  }
  return el;
}

// Plain-language line for one diff row, used by Improve and the version history.
function renderDiff(diff) {
  if (!diff.length) return '<div class="h-muted">No changes.</div>';
  const show = (v) => v === undefined ? '<em>not set</em>' : `<pre class="h-code">${esc(typeof v === 'string' ? v : JSON.stringify(v, null, 2))}</pre>`;
  return `<div class="h-diff">${diff.map((d) => `
    <div class="h-diff-row">
      <div class="h-diff-path">${esc(d.path)}</div>
      <div class="h-diff-cols"><div class="h-diff-before"><span class="h-label">Before</span>${show(d.before)}</div>
      <div class="h-diff-after"><span class="h-label">After</span>${show(d.after)}</div></div>
    </div>`).join('')}</div>`;
}

applyTheme();
