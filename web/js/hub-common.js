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

// shell.js owns the theme.
function toggleTheme() { if (window.jrToggleTheme) window.jrToggleTheme(); }

// --- context menu: items are {label, icon, hint, danger, confirm, disabled, onClick, items} or '-' for a divider ---

function closeMenu() {
  document.querySelectorAll('.h-menu').forEach((m) => m.remove());
}

function placeMenu(m, x, y, flipX) {
  const w = m.offsetWidth;
  const h = m.offsetHeight;
  let left = x;
  if (left + w > innerWidth - 8) left = (flipX ?? x) - w;
  m.style.left = `${Math.max(8, left)}px`;
  m.style.top = `${Math.max(8, Math.min(y, innerHeight - h - 8))}px`;
}

function closeSubmenu(parent) {
  if (!parent._sub) return;
  closeSubmenu(parent._sub);
  parent._sub.remove();
  parent._sub = null;
}

function openSubmenu(parent, btn, items) {
  if (parent._sub && parent._sub._owner === btn) return;
  closeSubmenu(parent);
  const sub = buildMenu(items);
  sub._owner = btn;
  document.body.appendChild(sub);
  const r = btn.getBoundingClientRect();
  placeMenu(sub, r.right + 2, r.top - 5, r.left - 2);
  parent._sub = sub;
}

function buildMenu(items) {
  const m = document.createElement('div');
  m.className = 'h-menu';
  m.setAttribute('role', 'menu');
  for (const it of items) {
    if (it === '-') { m.insertAdjacentHTML('beforeend', '<div class="h-menu-sep" role="separator"></div>'); continue; }
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `h-menu-item${it.danger ? ' danger' : ''}`;
    b.disabled = !!it.disabled;
    b.setAttribute('role', 'menuitem');
    const icon = it.icon && window.jrIcon ? jrIcon(it.icon, 15) : '';
    const tail = it.items ? (window.jrIcon ? jrIcon('chevronRight', 14) : '') : it.hint ? `<kbd>${esc(it.hint)}</kbd>` : '';
    b.innerHTML = `<span class="h-menu-icon">${icon}</span><span class="h-menu-label">${esc(it.label)}</span>${tail}`;
    if (it.items) {
      b.addEventListener('mouseenter', () => openSubmenu(m, b, it.items));
      b.addEventListener('click', (e) => { e.stopPropagation(); openSubmenu(m, b, it.items); });
    } else {
      b.addEventListener('mouseenter', () => closeSubmenu(m));
      b.addEventListener('click', () => {
        // A destructive item asks for a second click instead of a browser dialog.
        if (it.confirm && !b.dataset.armed) {
          b.dataset.armed = '1';
          b.querySelector('.h-menu-label').textContent = it.confirm;
          return;
        }
        closeMenu();
        if (it.onClick) it.onClick();
      });
    }
    m.appendChild(b);
  }
  return m;
}

function showMenu(x, y, items) {
  closeMenu();
  const m = buildMenu(items);
  document.body.appendChild(m);
  placeMenu(m, x, y);
  const first = m.querySelector('.h-menu-item:not(:disabled)');
  if (first) first.focus({ preventScroll: true });
}

document.addEventListener('pointerdown', (e) => { if (!e.target.closest('.h-menu')) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
document.addEventListener('keydown', (e) => {
  const menu = document.activeElement && document.activeElement.closest && document.activeElement.closest('.h-menu');
  if (!document.querySelector('.h-menu')) return;
  if (e.key === 'Escape') { closeMenu(); e.stopPropagation(); return; }
  if (!menu || !['ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const items = [...menu.querySelectorAll('.h-menu-item:not(:disabled)')];
  const i = items.indexOf(document.activeElement);
  items[(i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length].focus();
}, true);

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

// A placeholder value for each field of a schema, used to prefill test inputs.
function sampleFor(schema) {
  if (!schema) return {};
  if (schema.enum && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, sampleFor(v)]));
    case 'array': return [sampleFor(schema.items || { type: 'string' })];
    case 'number': case 'integer': return 1;
    case 'boolean': return true;
    default: return '';
  }
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

