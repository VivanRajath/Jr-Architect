// Planning mode in the IDE chat, after Google Antigravity: the Implementation Plan and Task List as reviewable artifacts, inline comments, Proceed/Review, live task progress, command approval and a Walkthrough.

const AgentPolicy = {
  get() {
    try { return { review: 'request', terminal: 'request', ...JSON.parse(localStorage.getItem('jr-agent-policy') || '{}') }; } catch { return { review: 'request', terminal: 'request' }; }
  },
  set(p) {
    try { localStorage.setItem('jr-agent-policy', JSON.stringify(p)); } catch { /* storage blocked */ }
  },
};

const PLAN_ICONS = {
  plan: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8M8 17h5"/></svg>',
  tasks: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m3 17 2 2 4-4"/><path d="m3 7 2 2 4-4"/><path d="M13 6h8M13 12h8M13 18h8"/></svg>',
  walk: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="m9 12 2 2 4-4"/></svg>',
  term: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m4 17 6-6-6-6"/><path d="M12 19h8"/></svg>',
  comment: '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
};

const TASK_STATUS = {
  pending: ['○', 'Pending'], running: ['', 'In progress'], done: ['✓', 'Done'], failed: ['✕', 'Failed'], skipped: ['–', 'Skipped'],
};

const planEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s ?? ''));

function planTarget() {
  return (agentTurn && agentTurn.messagesEl) || document.getElementById('agent-messages');
}

// Called from handleAgentWsMessage for the planning events; returns true when it handled one.
function planHandle(msg) {
  const box = planTarget();
  if (!box) return false;
  if (agentTurn) { clearLoad(agentTurn); agentTurn.assistantEl = null; }
  switch (msg.type) {
    case 'artifact':
      if (msg.kind === 'plan') renderPlanCard(box, msg);
      else if (msg.kind === 'tasks') renderTasksCard(box, msg.id, msg.tasks);
      else if (msg.kind === 'walkthrough') renderWalkthrough(box, msg.id, msg.walkthrough);
      break;
    case 'artifact_update':
      if (msg.kind === 'tasks') renderTasksCard(box, msg.id, msg.tasks);
      break;
    case 'awaiting_review': {
      const card = box.querySelector(`.ag-plan[data-plan="${msg.id}"]:not(.superseded)`);
      if (card) card.classList.add('awaiting');
      break;
    }
    case 'command_request':
      renderCommandRequest(box, msg);
      break;
    case 'command_result':
      renderCommandResult(msg);
      break;
    default:
      return false;
  }
  scrollAgent(box);
  return true;
}

function renderPlanCard(box, { id, version, plan }) {
  // A new version supersedes the one it revises.
  box.querySelectorAll(`.ag-plan[data-plan="${id}"]`).forEach((old) => {
    old.classList.add('superseded');
    old.classList.remove('awaiting');
    old.querySelectorAll('button, textarea').forEach((b) => { b.disabled = true; });
    const st = old.querySelector('.ag-state');
    if (st) st.textContent = 'Revised';
  });
  const card = document.createElement('div');
  card.className = 'ag-art ag-plan';
  card.dataset.plan = id;
  card.dataset.version = version;
  const item = (anchor, inner) => `<div class="ag-item" data-anchor="${planEsc(anchor)}">${inner}<button class="ag-cmt-btn" type="button" title="Comment on this">${PLAN_ICONS.comment}</button><div class="ag-cmts"></div></div>`;
  const changes = plan.changes.map((c) => item(`${c.file}: ${c.what}`,
    `<div class="ag-change"><span class="ag-act act-${planEsc(c.action)}">${planEsc(c.action)}</span><button class="ag-file" type="button" data-path="${planEsc(c.file)}">${planEsc(c.file)}</button></div><div class="ag-what">${planEsc(c.what)}</div>`)).join('');
  const verify = plan.verification.map((v) => item(`Verification: ${v.text}`,
    `<div class="ag-what">${planEsc(v.text)}${v.command ? `<code class="ag-cmd">${planEsc(v.command)}</code>` : ''}</div>`)).join('');
  const questions = plan.questions.map((q) => item(`Question: ${q}`, `<div class="ag-what ag-q">${planEsc(q)}</div>`)).join('');
  card.innerHTML = `
    <div class="ag-art-head">${PLAN_ICONS.plan}<span>Implementation Plan</span><span class="ag-ver">v${version}</span><span class="ag-state">Needs your review</span></div>
    <div class="ag-art-body">
      <div class="ag-plan-title">${planEsc(plan.title)}</div>
      ${item('Summary', `<div class="ag-summary">${planEsc(plan.summary || 'No summary.')}</div>`)}
      ${changes ? `<div class="ag-sec">Proposed changes</div>${changes}` : ''}
      ${verify ? `<div class="ag-sec">Verification plan</div>${verify}` : ''}
      ${questions ? `<div class="ag-sec">Open questions</div>${questions}` : ''}
    </div>
    <div class="ag-review">
      <textarea class="ag-general" rows="1" placeholder="Overall feedback (optional)…"></textarea>
      <div class="ag-btns">
        <button class="ag-btn ag-review-btn" type="button" disabled>Review</button>
        <button class="ag-btn ag-primary ag-proceed-btn" type="button">Proceed</button>
      </div>
    </div>`;
  box.appendChild(card);
  wirePlanCard(card, id);
}

function planComments(card) {
  const list = [];
  card.querySelectorAll('.ag-item').forEach((it) => {
    it.querySelectorAll('.ag-cmt-text').forEach((c) => list.push({ anchor: it.dataset.anchor.slice(0, 200), text: c.textContent }));
  });
  const general = card.querySelector('.ag-general').value.trim();
  if (general) list.push({ anchor: 'the whole plan', text: general });
  return list;
}

function refreshReviewButton(card) {
  const n = planComments(card).length;
  const btn = card.querySelector('.ag-review-btn');
  btn.disabled = n === 0;
  btn.textContent = n ? `Review (${n})` : 'Review';
}

function wirePlanCard(card, id) {
  card.querySelectorAll('.ag-file').forEach((b) => b.addEventListener('click', () => {
    if (typeof openFile === 'function') openFile(b.dataset.path, b.dataset.path.split('/').pop());
  }));
  card.querySelectorAll('.ag-cmt-btn').forEach((btn) => btn.addEventListener('click', () => {
    const it = btn.closest('.ag-item');
    if (it.querySelector('.ag-cmt-edit')) { it.querySelector('.ag-cmt-edit textarea').focus(); return; }
    const ed = document.createElement('div');
    ed.className = 'ag-cmt-edit';
    ed.innerHTML = '<textarea rows="2" placeholder="Comment for the agent…"></textarea><div><button class="ag-btn" type="button" data-x>Cancel</button><button class="ag-btn ag-primary" type="button" data-add>Add</button></div>';
    it.querySelector('.ag-cmts').before(ed);
    const ta = ed.querySelector('textarea');
    ta.focus();
    const add = () => {
      const text = ta.value.trim();
      if (!text) return;
      const c = document.createElement('div');
      c.className = 'ag-cmt';
      c.innerHTML = `<span class="ag-cmt-text"></span><button type="button" title="Remove">×</button>`;
      c.querySelector('.ag-cmt-text').textContent = text;
      c.querySelector('button').addEventListener('click', () => { c.remove(); refreshReviewButton(card); });
      it.querySelector('.ag-cmts').appendChild(c);
      ed.remove();
      refreshReviewButton(card);
    };
    ed.querySelector('[data-add]').addEventListener('click', add);
    ed.querySelector('[data-x]').addEventListener('click', () => ed.remove());
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); add(); } });
  }));
  const general = card.querySelector('.ag-general');
  general.addEventListener('input', () => { autoGrowAgentInput(general); refreshReviewButton(card); });
  card.querySelector('.ag-review-btn').addEventListener('click', () => {
    const comments = planComments(card);
    if (!comments.length) return;
    lockPlanCard(card, 'Revising…');
    planAction('plan_review', { id, comments }, `Review: ${comments.length} comment${comments.length === 1 ? '' : 's'} on the plan`);
  });
  card.querySelector('.ag-proceed-btn').addEventListener('click', () => {
    const pending = planComments(card).length;
    if (pending && !card.dataset.confirm) {
      card.dataset.confirm = '1';
      card.querySelector('.ag-proceed-btn').textContent = 'Proceed without comments?';
      setTimeout(() => { delete card.dataset.confirm; const b = card.querySelector('.ag-proceed-btn'); if (b && !b.disabled) b.textContent = 'Proceed'; }, 3000);
      return;
    }
    lockPlanCard(card, 'Approved');
    planAction('plan_proceed', { id }, 'Proceed with the plan');
  });
}

function lockPlanCard(card, state) {
  card.classList.remove('awaiting');
  card.classList.add('locked');
  card.querySelectorAll('button:not(.ag-file), textarea').forEach((b) => { b.disabled = true; });
  card.querySelector('.ag-state').textContent = state;
}

// Starts a new streamed turn for a plan action (the earlier turn ended when the plan was shown).
async function planAction(type, payload, label) {
  if (agentTurn) { showToast('The agent is still working', 'error'); return; }
  const messages = document.getElementById('agent-messages');
  const userEl = document.createElement('div');
  userEl.className = 'agent-msg user ag-action';
  userEl.textContent = label;
  messages.appendChild(userEl);
  const loadEl = document.createElement('div');
  loadEl.className = 'agent-msg loading';
  loadEl.textContent = type === 'plan_review' ? 'Revising the plan' : 'Working through the tasks';
  messages.appendChild(loadEl);
  scrollAgent(messages);
  agentTurn = { messagesEl: messages, loadEl, assistantEl: null, raw: '', changedPaths: new Set(), sawFileChange: false, finished: false };
  setAgentBusy(true);
  try {
    const sock = await ensureAgentSocket();
    if (AgentWS.bound !== IDE.container) {
      sock.send(JSON.stringify({ type: 'bind', container: IDE.container }));
      AgentWS.bound = IDE.container;
    }
    sock.send(JSON.stringify({ type, ...payload, policy: AgentPolicy.get() }));
  } catch {
    clearLoad(agentTurn);
    appendAgentError(messages, 'Could not reach the agent service.');
    finishAgentTurn();
  }
}

function renderTasksCard(box, id, tasks) {
  let card = box.querySelector(`.ag-tasks[data-plan="${id}"]`);
  if (!card) {
    card = document.createElement('div');
    card.className = 'ag-art ag-tasks';
    card.dataset.plan = id;
    box.appendChild(card);
  }
  const done = tasks.filter((t) => t.status === 'done').length;
  card.innerHTML = `
    <div class="ag-art-head">${PLAN_ICONS.tasks}<span>Task list</span><span class="ag-progress">${done}/${tasks.length}</span></div>
    <div class="ag-bar"><span style="width:${tasks.length ? Math.round(done / tasks.length * 100) : 0}%"></span></div>
    <ul class="ag-task-list">${tasks.map((t) => {
      const [mark, word] = TASK_STATUS[t.status] || TASK_STATUS.pending;
      return `<li class="ag-task s-${planEsc(t.status)}" title="${planEsc(word)}"><span class="ag-check">${t.status === 'running' ? '<span class="ag-spin"></span>' : mark}</span>
        <span class="ag-task-body"><span class="ag-task-title">${planEsc(t.title)}</span>${t.files && t.files.length ? `<span class="ag-task-files">${t.files.map(planEsc).join(' · ')}</span>` : ''}${t.note ? `<span class="ag-task-note">${planEsc(t.note)}</span>` : ''}</span></li>`;
    }).join('')}</ul>`;
  // Keep the live list next to the newest output while it runs.
  if (tasks.some((t) => t.status === 'running')) box.appendChild(card);
}

function renderCommandRequest(box, { id, command, why }) {
  const card = document.createElement('div');
  card.className = 'ag-art ag-cmdreq';
  card.dataset.cmd = id;
  card.innerHTML = `
    <div class="ag-art-head">${PLAN_ICONS.term}<span>Run this command?</span><span class="ag-state">Waiting for you</span></div>
    <div class="ag-art-body"><div class="ag-what">${planEsc(why || 'Verification step')}</div><code class="ag-cmd">${planEsc(command)}</code></div>
    <div class="ag-btns ag-pad"><button class="ag-btn" type="button" data-no>Skip</button><button class="ag-btn ag-primary" type="button" data-yes>Run</button></div>`;
  box.appendChild(card);
  const answer = (approved) => {
    card.querySelectorAll('button').forEach((b) => { b.disabled = true; });
    card.querySelector('.ag-state').textContent = approved ? 'Running…' : 'Skipped';
    if (AgentWS.sock && AgentWS.sock.readyState === WebSocket.OPEN) AgentWS.sock.send(JSON.stringify({ type: 'command_decision', id, approved }));
  };
  card.querySelector('[data-yes]').addEventListener('click', () => answer(true));
  card.querySelector('[data-no]').addEventListener('click', () => answer(false));
}

function renderCommandResult({ id, status, output }) {
  const card = document.querySelector(`.ag-cmdreq[data-cmd="${id}"]`);
  if (!card) return;
  card.querySelector('.ag-state').textContent = status === 'passed' ? 'Passed' : 'Failed';
  card.classList.add(status === 'passed' ? 'ok' : 'bad');
  if (output) {
    const pre = document.createElement('details');
    pre.className = 'ag-output';
    pre.innerHTML = '<summary>Output</summary><pre></pre>';
    pre.querySelector('pre').textContent = output;
    card.appendChild(pre);
  }
}

function renderWalkthrough(box, id, w) {
  const card = document.createElement('div');
  card.className = 'ag-art ag-walk';
  const changed = [...new Map(w.changed.map((c) => [c.path, c])).values()];
  const failed = w.tasks.filter((t) => t.status === 'failed');
  const manual = w.verification.filter((v) => v.status === 'manual');
  const ran = w.verification.filter((v) => v.command);
  card.innerHTML = `
    <div class="ag-art-head">${PLAN_ICONS.walk}<span>Walkthrough</span><span class="ag-state">${w.stopped ? 'Stopped' : failed.length ? `${failed.length} task(s) need attention` : 'Done'}</span></div>
    <div class="ag-art-body">
      <div class="ag-plan-title">${planEsc(w.title)}</div>
      ${w.summary ? `<div class="ag-summary">${planEsc(w.summary)}</div>` : ''}
      <div class="ag-sec">Changes made</div>
      ${changed.length ? changed.map((c) => `<button class="ag-walk-file" type="button" data-path="${planEsc(c.path)}"><span class="ag-act act-${c.status === 'created' ? 'new' : 'modify'}">${c.status === 'created' ? 'new' : 'edited'}</span>${planEsc(c.path)}</button>`).join('') : '<div class="ag-what">No files changed.</div>'}
      ${failed.length ? `<div class="ag-sec">Not done</div>${failed.map((t) => `<div class="ag-what ag-bad">✕ ${planEsc(t.title)}${t.note ? ` — ${planEsc(t.note)}` : ''}</div>`).join('')}` : ''}
      ${ran.length ? `<div class="ag-sec">Verification</div>${ran.map((v) => `<div class="ag-what"><span class="ag-pill p-${planEsc(v.status)}">${planEsc(v.status)}</span> <code class="ag-cmd">${planEsc(v.command)}</code>${v.status === 'failed' && v.output ? `<span class="ag-fail-why">${planEsc(lastLines(v.output, 3))}</span>` : ''}</div>`).join('')}` : ''}
      ${manual.length ? `<div class="ag-sec">Check yourself</div>${manual.map((v) => `<div class="ag-what">☐ ${planEsc(v.text)}</div>`).join('')}` : ''}
    </div>
    <div class="ag-btns ag-pad">
      <button class="ag-btn" type="button" data-scm>Review in Source Control</button>
      <button class="ag-btn ag-primary" type="button" data-preview>Open preview</button>
    </div>`;
  box.appendChild(card);
  card.querySelectorAll('.ag-walk-file').forEach((b) => b.addEventListener('click', () => openFile(b.dataset.path, b.dataset.path.split('/').pop())));
  card.querySelector('[data-preview]').addEventListener('click', () => { if (typeof openLivePreview === 'function') openLivePreview(); });
  card.querySelector('[data-scm]').addEventListener('click', () => { if (typeof showSidebarView === 'function') showSidebarView('scm'); });
}

// The end of a command's output, where the reason it failed usually is.
function lastLines(text, n) {
  return String(text || '').trim().split(/\r?\n/).filter((l) => l.trim()).slice(-n).join('\n');
}

// ── Composer: slash commands, @file mentions, Stop, and the settings popover ──

const SLASH = { '/plan': 'plan', '/fast': 'fast', '/ask': 'ask' };

// "/plan add dark mode" → { mode: "plan", text: "add dark mode" }.
function parseSlash(text) {
  const m = /^\/(plan|fast|ask)\b\s*/i.exec(text);
  return m ? { mode: SLASH['/' + m[1].toLowerCase()], text: text.slice(m[0].length) } : { mode: null, text };
}

function stopAgent() {
  if (!agentTurn) return;
  if (AgentWS.sock && AgentWS.sock.readyState === WebSocket.OPEN) AgentWS.sock.send(JSON.stringify({ type: 'stop' }));
  if (agentTurn.loadEl) agentTurn.loadEl.textContent = 'Stopping after the current step';
  showToast('Stopping after the current step', 'info');
}

const Mentions = { files: null, container: null, open: false, items: [], index: 0 };

async function mentionFiles() {
  if (Mentions.files && Mentions.container === IDE.container) return Mentions.files;
  const out = [];
  try {
    const tree = await (await fetch(`/files?container=${encodeURIComponent(IDE.container)}`)).json();
    const walk = (nodes) => (nodes || []).forEach((n) => {
      if (n.isDir || n.type === 'dir' || n.children) walk(n.children);
      else if (n.path && !/(^|\/)(node_modules|\.git|\.next|\.gitagent|knowledge)\//.test(n.path)) out.push(n.path);
    });
    walk(Array.isArray(tree) ? tree : tree.files || tree.children || []);
  } catch { /* no list */ }
  Mentions.files = out;
  Mentions.container = IDE.container;
  return out;
}

async function updateMentions(input) {
  const pop = document.getElementById('agent-mention-pop');
  const before = input.value.slice(0, input.selectionStart);
  const m = /(^|\s)@([\w./-]*)$/.exec(before);
  if (!m) { closeMentions(); return; }
  const q = m[2].toLowerCase();
  const files = await mentionFiles();
  const agents = (typeof OG !== 'undefined' && OG.status && OG.status.agents) || [];
  const agentHits = agents.filter((a) => a.name.includes(q)).slice(0, 4).map((a) => ({ agent: a }));
  const scored = files.filter((f) => f.toLowerCase().includes(q))
    .sort((a, b) => (a.split('/').pop().toLowerCase().startsWith(q) ? 0 : 1) - (b.split('/').pop().toLowerCase().startsWith(q) ? 0 : 1) || a.length - b.length)
    .slice(0, 8 - agentHits.length);
  const items = [...agentHits, ...scored];
  if (!items.length) { closeMentions(); return; }
  Mentions.open = true;
  Mentions.items = items.map((x) => (x.agent ? x.agent.name : x));
  Mentions.index = 0;
  pop.innerHTML = items.map((x, i) => (x.agent
    ? `<button type="button" class="ag-mention ag-mention-agent${i === 0 ? ' on' : ''}" data-i="${i}"><b>@${planEsc(x.agent.name)} <i>agent</i></b><span>${planEsc(x.agent.role || 'OpenGAP agent')}</span></button>`
    : `<button type="button" class="ag-mention${i === 0 ? ' on' : ''}" data-i="${i}"><b>${planEsc(x.split('/').pop())}</b><span>${planEsc(x)}</span></button>`)).join('');
  pop.hidden = false;
  pop.querySelectorAll('.ag-mention').forEach((b) => b.addEventListener('mousedown', (e) => { e.preventDefault(); pickMention(input, Number(b.dataset.i)); }));
}

function closeMentions() {
  Mentions.open = false;
  const pop = document.getElementById('agent-mention-pop');
  if (pop) pop.hidden = true;
}

function pickMention(input, i) {
  const file = Mentions.items[i];
  if (!file) return;
  const pos = input.selectionStart;
  const before = input.value.slice(0, pos).replace(/@([\w./-]*)$/, `@${file} `);
  input.value = before + input.value.slice(pos);
  input.selectionStart = input.selectionEnd = before.length;
  closeMentions();
  input.focus();
}

function mentionKeydown(e, input) {
  if (!Mentions.open) return false;
  const pop = document.getElementById('agent-mention-pop');
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    Mentions.index = (Mentions.index + (e.key === 'ArrowDown' ? 1 : -1) + Mentions.items.length) % Mentions.items.length;
    pop.querySelectorAll('.ag-mention').forEach((b, i) => b.classList.toggle('on', i === Mentions.index));
    return true;
  }
  if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); pickMention(input, Mentions.index); return true; }
  if (e.key === 'Escape') { closeMentions(); return true; }
  return false;
}

function toggleAgentSettings() {
  const pop = document.getElementById('agent-settings-pop');
  const p = AgentPolicy.get();
  pop.querySelectorAll('input[type=radio]').forEach((r) => { r.checked = p[r.name] === r.value; });
  pop.hidden = !pop.hidden;
}

document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('agent-input');
  const mode = document.getElementById('agent-mode');
  if (mode) {
    try { const saved = localStorage.getItem('jr-agent-mode'); if (saved && mode.querySelector(`option[value="${saved}"]`)) mode.value = saved; } catch { /* storage blocked */ }
    mode.addEventListener('change', () => { try { localStorage.setItem('jr-agent-mode', mode.value); } catch { /* storage blocked */ } });
  }
  if (input) {
    input.addEventListener('keydown', (e) => { if (mentionKeydown(e, input)) e.stopImmediatePropagation(); }, true);
    input.addEventListener('input', () => updateMentions(input));
    input.addEventListener('blur', () => setTimeout(closeMentions, 150));
  }
  const pop = document.getElementById('agent-settings-pop');
  if (pop) {
    pop.addEventListener('change', () => {
      const p = AgentPolicy.get();
      pop.querySelectorAll('input[type=radio]:checked').forEach((r) => { p[r.name] = r.value; });
      AgentPolicy.set(p);
    });
    document.addEventListener('mousedown', (e) => {
      if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('#agent-settings-btn')) pop.hidden = true;
    });
  }
});
