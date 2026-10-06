// Workflow Playground: chat with one workflow, by its id; the chat and the system's replies are kept on the server.

const PG = { workflows: [], id: null, info: null, messages: [], values: {}, raw: false, busy: false };

function pgIcon(name, size = 16) {
  return window.jrIcon ? window.jrIcon(name, size) : '';
}

const pgPath = (id, rest = '') => `/workflows/${encodeURIComponent(id)}/playground${rest}`;

async function boot() {
  try {
    ({ workflows: PG.workflows } = await hubApi('GET', '/workflows'));
  } catch (e) {
    document.getElementById('pg-list').innerHTML = `<div class="h-callout bad">${esc(e.message)}</div>`;
    return;
  }
  renderList();
  const id = new URLSearchParams(location.search).get('id');
  if (id && PG.workflows.some((w) => w.id === id)) openWorkflow(id);
  else if (PG.workflows.length) openWorkflow(PG.workflows[0].id);
  else renderNoWorkflows();
}

function renderList() {
  const q = document.getElementById('pg-search').value.trim().toLowerCase();
  const shown = PG.workflows.filter((w) => !q || w.name.toLowerCase().includes(q) || (w.description || '').toLowerCase().includes(q));
  const list = document.getElementById('pg-list');
  list.innerHTML = shown.map((w) => `
    <a class="pg-item${w.id === PG.id ? ' active' : ''}" href="/playground.html?id=${encodeURIComponent(w.id)}" data-id="${esc(w.id)}" title="${esc(w.description || '')}">
      ${pgIcon('flows')}<span>${esc(w.name)}</span>
    </a>`).join('') || `<div class="h-muted">${PG.workflows.length ? 'Nothing matches.' : 'No workflows yet.'}</div>`;
  list.querySelectorAll('.pg-item').forEach((a) => a.addEventListener('click', (e) => {
    e.preventDefault();
    openWorkflow(a.dataset.id);
  }));
}

function renderNoWorkflows() {
  document.getElementById('pg-head').innerHTML = '<div class="pg-head-text"><h2>Workflow Playground</h2></div>';
  document.getElementById('pg-thread').innerHTML = `<div class="pg-empty"><h3>No workflows yet</h3>
    <p>Build a workflow in Agent Hub, then come back here to chat with it.</p>
    <div class="pg-suggest"><a class="h-btn" href="/flows.html">Create a workflow</a></div></div>`;
  document.getElementById('pg-about').innerHTML = '';
}

async function openWorkflow(id) {
  PG.id = id;
  PG.raw = false;
  history.replaceState(null, '', `/playground.html?id=${encodeURIComponent(id)}`);
  renderList();
  try {
    const data = await hubApi('GET', pgPath(id));
    if (PG.id !== id) return;
    PG.info = data.info;
    PG.messages = data.messages;
  } catch (e) {
    hubToast(e.message, 'error');
    return;
  }
  document.title = `${PG.info.name} - Playground`;
  PG.values = Object.assign(Object.fromEntries(PG.info.inputs.map((i) => [i.name, i.example || ''])), loadValues());
  renderHead();
  renderAbout();
  renderFields();
  renderThread();
  const input = document.getElementById('pg-input');
  input.disabled = false;
  input.placeholder = PG.info.mainField ? `Message (sent as ${PG.info.mainField}), or say hi` : 'Message, or say hi';
  document.getElementById('pg-send').disabled = false;
  input.focus();
}

function renderHead() {
  const i = PG.info;
  document.getElementById('pg-head').innerHTML = `
    <span class="pg-avatar">${pgIcon('flows')}</span>
    <div class="pg-head-text"><h2>${esc(i.name)}</h2><p>${esc(i.description || `${i.steps.length} step${i.steps.length === 1 ? '' : 's'}`)}</p></div>
    <a class="h-btn h-btn-ghost h-btn-sm" href="/flows.html?id=${encodeURIComponent(i.id)}">Open editor</a>
    <button class="h-btn h-btn-ghost h-btn-sm" id="pg-clear">Clear chat</button>`;
  document.getElementById('pg-clear').addEventListener('click', clearChat);
}

// What the workflow does, beside the chat.
function renderAbout() {
  const i = PG.info;
  const steps = i.steps.length ? `<ol class="pg-steps">${i.steps.map((s) => `<li>${esc(s)}</li>`).join('')}</ol>` : '<p class="h-muted">No steps yet.</p>';
  const agents = i.agents.length ? i.agents.map((a) => `<div class="pg-agent"><strong>${esc(a.name)}</strong>${a.purpose ? `<span>${esc(a.purpose)}</span>` : ''}</div>`).join('') : '';
  const inputs = i.inputs.length ? i.inputs.map((f) => `<div class="pg-input-row"><code>${esc(f.name)}</code>${f.name === i.mainField ? '<span class="h-pill">your message</span>' : ''}${f.example ? `<span class="h-muted">e.g. ${esc(f.example)}</span>` : ''}</div>`).join('') : '<p class="h-muted">Takes your message as is.</p>';
  document.getElementById('pg-about').innerHTML = `
    <h3>About this workflow</h3>
    ${i.description ? `<p>${esc(i.description)}</p>` : ''}
    <div class="h-label">What happens when you send a message</div>
    ${steps}
    ${i.approval ? '<div class="h-callout warn">It pauses for your approval before finishing; approve or reject in the chat.</div>' : ''}
    ${agents ? `<div class="h-label">Agents</div>${agents}` : ''}
    <div class="h-label">Inputs</div>${inputs}
    <div class="h-label">Workflow id</div><code class="pg-id">${esc(i.id)}</code>`;
}

function valuesKey() {
  return `pg:fields:${PG.id}`;
}

function loadValues() {
  try { return JSON.parse(localStorage.getItem(valuesKey()) || '{}'); } catch { return {}; }
}

function saveValues() {
  try { localStorage.setItem(valuesKey(), JSON.stringify(PG.values)); } catch { /* storage blocked */ }
}

// The inputs a message does not fill, plus a raw JSON mode for full control over the input.
function renderFields(open) {
  const box = document.getElementById('pg-fields');
  const toggle = document.getElementById('pg-fields-toggle');
  const others = PG.info.inputs.filter((f) => f.name !== PG.info.mainField);
  toggle.hidden = false;
  toggle.textContent = PG.raw ? 'Use form' : others.length ? `Fields (${others.length})` : 'Edit as JSON';
  toggle.onclick = () => {
    if (PG.raw) { PG.raw = false; renderFields(others.length > 0); return; }
    if (!others.length) { PG.raw = true; renderFields(true); return; }
    renderFields(box.hidden);
  };
  if (PG.raw) {
    box.hidden = false;
    box.innerHTML = `<label class="full"><span class="h-label">Input JSON, sent as is (the message box is ignored)</span>
      <textarea class="h-textarea mono" id="pg-raw" rows="6">${esc(JSON.stringify(buildInput(''), null, 2))}</textarea></label>`;
    return;
  }
  if (!others.length) { box.hidden = true; box.innerHTML = ''; return; }
  box.innerHTML = others.map((f) => `
    <label>
      <span class="h-label">${esc(f.name)}</span>
      <input class="h-input" data-field="${esc(f.name)}" value="${esc(PG.values[f.name] ?? '')}" placeholder="${esc(f.example || '')}">
    </label>`).join('') + '<div class="full"><button type="button" class="h-link" id="pg-as-json">Edit as JSON</button></div>';
  box.querySelectorAll('[data-field]').forEach((el) => el.addEventListener('input', () => { PG.values[el.dataset.field] = el.value; saveValues(); }));
  document.getElementById('pg-as-json').addEventListener('click', () => { PG.raw = true; renderFields(true); });
  // Open when asked, or when a field still has no value.
  box.hidden = !(open || others.some((f) => !String(PG.values[f.name] ?? '').trim()));
}

function buildInput(message) {
  if (!PG.info.inputs.length) return { message };
  const input = {};
  for (const f of PG.info.inputs) input[f.name] = f.name === PG.info.mainField ? message : (PG.values[f.name] ?? '');
  return input;
}

async function send(text) {
  if (PG.busy || !PG.id) return;
  let input;
  if (PG.raw) {
    try { input = JSON.parse(document.getElementById('pg-raw').value || '{}'); } catch { hubToast('The input is not valid JSON', 'error'); return; }
  } else {
    if (!text.trim()) return;
    input = buildInput(text);
  }
  const id = PG.id;
  // Shown at once; replaced by the stored copy when the server answers.
  const pending = { id: 'pending', role: 'user', text: PG.raw ? '' : text, input };
  PG.messages.push(pending);
  setBusy(true);
  renderThread();
  try {
    const { messages } = await hubApi('POST', pgPath(id), { text: PG.raw ? '' : text, input });
    if (PG.id !== id) return;
    PG.messages = PG.messages.filter((m) => m !== pending).concat(messages);
  } catch (e) {
    if (PG.id !== id) return;
    PG.messages = PG.messages.filter((m) => m !== pending);
    PG.messages.push(pending, { id: 'local-error', role: 'system', error: e.message });
  } finally {
    setBusy(false);
    renderThread();
  }
}

async function decide(messageId, approved) {
  const note = (document.querySelector(`[data-note="${CSS.escape(messageId)}"]`) || {}).value || '';
  setBusy(true);
  try {
    const out = await hubApi('POST', pgPath(PG.id, '/decision'), { messageId, approved, note });
    const m = PG.messages.find((x) => x.id === out.decided);
    if (m) m.decided = approved ? 'approved' : 'rejected';
    PG.messages.push(out.message);
  } catch (e) {
    hubToast(e.message, 'error');
  } finally {
    setBusy(false);
    renderThread();
  }
}

async function clearChat() {
  try {
    await hubApi('DELETE', pgPath(PG.id));
    PG.messages = [];
    renderThread();
  } catch (e) { hubToast(e.message, 'error'); }
}

function setBusy(on) {
  PG.busy = on;
  document.getElementById('pg-send').disabled = on;
  const thread = document.getElementById('pg-thread');
  const old = thread.querySelector('.pg-typing-row');
  if (old) old.remove();
  if (on) {
    thread.insertAdjacentHTML('beforeend', '<div class="pg-msg bot pg-typing-row"><div class="pg-bubble pg-typing" aria-label="Running"><i></i><i></i><i></i></div></div>');
    thread.scrollTop = thread.scrollHeight;
  }
}

// An answer as a person would read it: text as text, lists as bullets, objects as labelled fields.
function formatValue(v) {
  if (v == null || v === '') return '<span class="h-muted">(empty)</span>';
  if (Array.isArray(v)) return `<ul>${v.map((x) => `<li>${typeof x === 'object' ? esc(JSON.stringify(x)) : esc(x)}</li>`).join('')}</ul>`;
  if (typeof v === 'object') return `<pre class="h-code">${esc(JSON.stringify(v, null, 2))}</pre>`;
  return `<div class="pg-field-value">${esc(v)}</div>`;
}

function formatOutput(out) {
  if (out == null) return '<span class="h-muted">No output.</span>';
  if (typeof out !== 'object' || Array.isArray(out)) return formatValue(out);
  const entries = Object.entries(out);
  if (!entries.length) return '<span class="h-muted">No output.</span>';
  return entries.map(([k, v]) => `<div class="pg-field"><div class="pg-field-name">${esc(k.replace(/_/g, ' '))}</div>${formatValue(v)}</div>`).join('');
}

function copyText(out) {
  if (out == null) return '';
  if (typeof out !== 'object') return String(out);
  return Object.entries(out).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join('\n');
}

function runBubble(m) {
  const run = m.run;
  const secs = run.finishedAt && run.startedAt ? `${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s` : '';
  const waiting = run.status === 'awaiting_approval';
  const approval = waiting && !m.decided ? `
    <div class="h-approval">
      <strong>${esc((run.pending && run.pending.message) || 'This run is waiting for your approval.')}</strong>
      <input class="h-input" data-note="${esc(m.id)}" placeholder="Optional note">
      <div class="pg-actions"><button class="h-btn h-btn-ok h-btn-sm" data-approve="${esc(m.id)}">Approve</button><button class="h-btn h-btn-ghost h-btn-sm" data-reject="${esc(m.id)}">Reject</button></div>
    </div>` : waiting ? `<div class="h-muted">You ${esc(m.decided)} this.</div>` : '';
  const body = run.error ? `<div class="h-callout bad">${esc(run.error)}</div>` : waiting ? '' : formatOutput(run.output);
  const log = (run.log || []).map((l) => `<li class="h-trace-step"><span class="h-trace-detail">${esc(l.text)}</span></li>`).join('');
  return `
    <div class="pg-bubble">${body}${approval}
      <details class="pg-details"><summary>Details</summary>
        ${log ? `<ol class="h-trace">${log}</ol>` : ''}
        <div class="h-label">Input</div><pre class="h-code">${esc(JSON.stringify(run.input ?? null, null, 2))}</pre>
        ${run.output != null ? `<div class="h-label">Raw output</div><pre class="h-code">${esc(JSON.stringify(run.output, null, 2))}</pre>` : ''}
      </details>
    </div>
    <div class="pg-meta"><span class="h-pill s-${esc(run.status)}">${esc(STATUS_LABEL[run.status] || run.status)}</span>${secs ? `<span>${secs}</span>` : ''}
      ${run.output != null && !waiting ? `<button class="h-link" data-copy="${esc(m.id)}">Copy</button>` : ''}</div>`;
}

function systemBubble(text, isError) {
  return `<div class="pg-msg bot system"><div class="pg-sender">${pgIcon('bot', 14)} System</div>
    <div class="pg-bubble">${isError ? `<div class="h-callout bad">${esc(text)}</div>` : `<div class="pg-field-value">${esc(text)}</div>`}</div></div>`;
}

// What the system says before the first message: what the workflow does, and how to start.
function welcome() {
  const i = PG.info;
  const example = (i.inputs.find((f) => f.name === i.mainField) || {}).example;
  const suggestions = ['hi', example].filter(Boolean);
  const about = i.description ? i.description.trim().replace(/([^.!?])$/, '$1.') + ' ' : '';
  return systemBubble(`This is the playground for "${i.name}". ${about}Each message runs the saved workflow once, exactly as your app would. Say hi to hear what it does, or send a real request.`)
    + `<div class="pg-suggest">${suggestions.map((s) => `<button type="button" class="h-btn h-btn-ghost h-btn-sm" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div>`;
}

function renderThread() {
  const thread = document.getElementById('pg-thread');
  if (!PG.info) return;
  const parts = [];
  if (!PG.messages.length) parts.push(welcome());
  for (const m of PG.messages) {
    if (m.role === 'user') {
      const extra = Object.entries(m.input || {}).filter(([k, v]) => k !== PG.info.mainField && v !== '' && v != null);
      const chips = extra.map(([k, v]) => `<span class="h-pill">${esc(k)}: ${esc(typeof v === 'object' ? JSON.stringify(v) : v).slice(0, 60)}</span>`).join('');
      parts.push(`<div class="pg-msg user">${m.text ? `<div class="pg-bubble">${esc(m.text)}</div>` : ''}${chips ? `<div class="pg-chips">${chips}</div>` : ''}</div>`);
    } else if (m.role === 'system') {
      parts.push(systemBubble(m.error || m.text, !!m.error));
    } else if (m.role === 'run') {
      parts.push(`<div class="pg-msg bot">${runBubble(m)}</div>`);
    }
  }
  thread.innerHTML = parts.join('');
  thread.querySelectorAll('[data-approve]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.approve, true)));
  thread.querySelectorAll('[data-reject]').forEach((b) => b.addEventListener('click', () => decide(b.dataset.reject, false)));
  thread.querySelectorAll('[data-copy]').forEach((b) => b.addEventListener('click', () => {
    const m = PG.messages.find((x) => x.id === b.dataset.copy);
    if (m && navigator.clipboard) navigator.clipboard.writeText(copyText(m.run.output));
    hubToast('Copied');
  }));
  thread.querySelectorAll('[data-suggest]').forEach((b) => b.addEventListener('click', () => send(b.dataset.suggest)));
  if (PG.busy) setBusy(true);
  thread.scrollTop = thread.scrollHeight;
}

document.getElementById('pg-search').addEventListener('input', renderList);
document.getElementById('pg-composer').addEventListener('submit', (e) => {
  e.preventDefault();
  const input = document.getElementById('pg-input');
  const text = input.value;
  if (!PG.raw && !text.trim()) return;
  input.value = '';
  input.style.height = '';
  send(text);
});
document.getElementById('pg-input').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); document.getElementById('pg-composer').requestSubmit(); }
});
document.getElementById('pg-input').addEventListener('input', (e) => {
  e.target.style.height = '';
  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
});
boot();
