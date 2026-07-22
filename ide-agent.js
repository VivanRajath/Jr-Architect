// ── Agent Chat (streaming, agentic) ──
//
// The agent-service (agent-services/server.js) runs a real coding agent against
// the sandbox workdir and streams its work over a WebSocket at /agent/ws
// (reverse-proxied by the Go server to the Node service on :8001). We render that
// stream live — tokens as they arrive, each tool call as its own row — and when
// the agent edits files we auto-refresh the file tree, reload open editors, and
// reload the live preview. If the socket can't be established we fall back to the
// single-shot REST endpoint so the panel still works.

const AgentWS = {
  sock: null,
  bound: null, // container the socket is currently bound to
};

// The turn currently streaming. Only one runs at a time (input is disabled while
// busy). Holds the DOM anchors and the set of files the agent touched this turn.
let agentTurn = null;

function agentWsUrl() {
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${window.location.host}/agent/ws`;
}

// ensureAgentSocket resolves with an OPEN socket, opening one if needed. It does
// NOT bind — the caller sends bind+chat so a reused socket rebinds if the active
// sandbox changed.
function ensureAgentSocket() {
  return new Promise((resolve, reject) => {
    const s = AgentWS.sock;
    if (s && s.readyState === WebSocket.OPEN) return resolve(s);
    if (s && s.readyState === WebSocket.CONNECTING) {
      s.addEventListener('open', () => resolve(s), { once: true });
      s.addEventListener('error', () => reject(new Error('agent ws error')), { once: true });
      return;
    }
    let sock;
    try {
      sock = new WebSocket(agentWsUrl());
    } catch (e) {
      return reject(e);
    }
    AgentWS.sock = sock;
    AgentWS.bound = null;
    sock.onmessage = handleAgentWsMessage;
    sock.onclose = () => {
      if (AgentWS.sock === sock) { AgentWS.sock = null; AgentWS.bound = null; }
    };
    sock.addEventListener('open', () => resolve(sock), { once: true });
    sock.addEventListener('error', () => reject(new Error('agent ws error')), { once: true });
  });
}

async function sendAgentMessage() {
  const input = document.getElementById('agent-input');
  const msg = input.value.trim();
  if (!msg) return;
  if (agentTurn) return; // a turn is already streaming
  input.value = '';
  autoGrowAgentInput(input); // collapse the composer back to one line

  const messages = document.getElementById('agent-messages');
  const welcome = messages.querySelector('.agent-welcome');
  if (welcome) welcome.remove();

  // User bubble
  const userEl = document.createElement('div');
  userEl.className = 'agent-msg user';
  userEl.textContent = msg;
  messages.appendChild(userEl);

  // Loading indicator (removed on first content)
  const loadEl = document.createElement('div');
  loadEl.className = 'agent-msg loading';
  loadEl.textContent = 'Thinking';
  messages.appendChild(loadEl);
  scrollAgent(messages);

  const provider = document.getElementById('agent-provider').value;
  const modeEl = document.getElementById('agent-mode');
  const mode = modeEl ? modeEl.value : 'auto';

  agentTurn = {
    messagesEl: messages,
    loadEl,
    assistantEl: null,
    raw: '',
    changedPaths: new Set(),
    sawFileChange: false,
    finished: false,
  };
  setAgentBusy(true);

  try {
    const sock = await ensureAgentSocket();
    if (AgentWS.bound !== IDE.container) {
      sock.send(JSON.stringify({ type: 'bind', container: IDE.container }));
      AgentWS.bound = IDE.container;
    }
    sock.send(JSON.stringify({ type: 'chat', container: IDE.container, message: msg, provider, mode }));
  } catch (e) {
    // Streaming transport unavailable — fall back to the single-shot REST path.
    await sendAgentViaRest(msg, provider, messages, mode);
  }
}

function handleAgentWsMessage(ev) {
  let msg;
  try { msg = JSON.parse(ev.data); } catch { return; }
  const t = agentTurn;

  switch (msg.type) {
    case 'ready':
      AgentWS.bound = IDE.container;
      break;

    case 'thinking':
      break; // loadEl already shows "Thinking"

    case 'delta': {
      if (!t) break;
      clearLoad(t);
      if (!t.assistantEl) {
        t.assistantEl = document.createElement('div');
        t.assistantEl.className = 'agent-msg assistant';
        t.messagesEl.appendChild(t.assistantEl);
        t.raw = '';
      }
      t.raw += msg.content || '';
      t.assistantEl.innerHTML = formatAgentResponse(t.raw);
      scrollAgent(t.messagesEl);
      break;
    }

    case 'tool': {
      if (!t) break;
      clearLoad(t);
      // Close the current assistant bubble so any following prose starts a fresh
      // bubble — producing a natural interleaved transcript (text, tool, text…).
      t.assistantEl = null;
      const changed = renderToolRow(t.messagesEl, msg.content || '');
      if (changed) t.changedPaths.add(changed);
      scrollAgent(t.messagesEl);
      break;
    }

    case 'file_changed':
      if (t) t.sawFileChange = true;
      break;

    case 'edit_summary': {
      if (!t) break;
      clearLoad(t);
      t.assistantEl = null;
      renderEditSummary(t.messagesEl, msg.files || [], t);
      scrollAgent(t.messagesEl);
      break;
    }

    case 'message_end':
      // Soft boundary between the agent's assistant messages within one turn —
      // just close the current bubble; the turn continues.
      if (t) t.assistantEl = null;
      break;

    case 'complete':
      finishAgentTurn();
      break;

    case 'error': {
      if (t) {
        clearLoad(t);
        const errEl = document.createElement('div');
        errEl.className = 'agent-msg error';
        errEl.textContent = msg.content || 'Agent error';
        t.messagesEl.appendChild(errEl);
        scrollAgent(t.messagesEl);
      }
      finishAgentTurn();
      break;
    }
  }
}

function clearLoad(t) {
  if (t && t.loadEl) { t.loadEl.remove(); t.loadEl = null; }
}

// Render the layered edit pipeline's result as a clickable file list. Rows for
// edited/created files open a before/after diff on click.
function renderEditSummary(container, files, turn) {
  const escLocal = (s) => { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; };
  const changed = files.filter(f => f.status === 'edited' || f.status === 'created');
  const wrap = document.createElement('div');
  wrap.className = 'agent-edit-summary';

  const head = document.createElement('div');
  head.className = 'agent-edit-head';
  head.textContent = `Applied ${changed.length} change${changed.length === 1 ? '' : 's'}`;
  wrap.appendChild(head);

  files.forEach(f => {
    const clickable = (f.status === 'edited' || f.status === 'created');
    const row = document.createElement('div');
    row.className = 'agent-edit-row' + (clickable ? ' clickable' : '');
    const kind = f.status.split(' ')[0]; // edited | created | unchanged | skipped | blocked | rejected
    row.innerHTML =
      `<span class="agent-edit-ico k-${kind}">${editStatusIcon(kind)}</span>` +
      `<span class="agent-edit-path">${escLocal(f.path)}</span>` +
      `<span class="agent-edit-status k-${kind}">${escLocal(f.status)}</span>`;
    if (clickable) {
      if (turn) turn.changedPaths.add(f.path);
      row.title = 'Click to view the diff';
      row.onclick = () => {
        if (f.before != null && f.after != null && typeof showDiffModal === 'function') {
          showDiffModal(f.path, f.before, f.after);
        } else if (typeof openFile === 'function') {
          openFile(f.path, f.path.split('/').pop());
        }
      };
    }
    wrap.appendChild(row);
  });

  // Explicit control so the change is visible and confirmable: re-apply the new
  // contents to disk and force the preview to show them. Changes are already
  // written by the pipeline, so this is a safe re-apply that also reveals them.
  if (changed.length) {
    const actions = document.createElement('div');
    actions.className = 'agent-edit-actions';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'agent-edit-apply';
    applyBtn.textContent = `Apply changes${changed.length > 1 ? ` (${changed.length})` : ''} & show in preview`;
    applyBtn.onclick = () => applyEditSummary(changed, applyBtn);
    actions.appendChild(applyBtn);
    wrap.appendChild(actions);
  }

  const hint = document.createElement('div');
  hint.className = 'agent-edit-hint';
  hint.textContent = changed.length
    ? 'Changes written to disk. Click a file for its diff, or use Apply changes to reveal them in the preview.'
    : 'No files changed — try rephrasing or naming the exact file.';
  wrap.appendChild(hint);

  container.appendChild(wrap);
}

// Re-apply the edited files' new contents to disk (idempotent — the pipeline
// already wrote them) and force the preview to reveal the change. Gives the user
// a tangible "the code changed and here it is" confirmation.
async function applyEditSummary(changed, btn) {
  if (!IDE.container) { showToast('Launch a repo first', 'error'); return; }
  const orig = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Applying…'; }
  let ok = 0;
  for (const f of changed) {
    if (f.after == null) continue;
    try {
      const res = await fetch('/file/save', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container: IDE.container, path: f.path, content: f.after }),
      });
      if (res.ok) {
        ok++;
        const tab = IDE.tabs && IDE.tabs.find(t => t.path === f.path);
        if (tab) { tab.model.setValue(f.after); tab.original = f.after; tab.modified = false; }
      }
    } catch { /* keep going */ }
  }
  if (typeof renderTabs === 'function') renderTabs();
  if (typeof loadFileTree === 'function') loadFileTree();
  // /file/save already wrote each file through the container, so the recompile is
  // in flight — just reveal it (reloads now and after the recompile settles).
  revealChangesInPreview(changed.map(f => f.path), true);
  showToast(`Applied ${ok} change${ok === 1 ? '' : 's'} · preview updating`, ok ? 'success' : 'error');
  if (btn) { btn.disabled = false; btn.textContent = orig; }
}

function editStatusIcon(kind) {
  const s = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">';
  if (kind === 'edited') return s + '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>';
  if (kind === 'created') return s + '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>';
  if (kind === 'unchanged') return s + '<line x1="5" y1="12" x2="19" y2="12"/></svg>';
  if (kind === 'blocked' || kind === 'rejected') return s + '<circle cx="12" cy="12" r="10"/><line x1="4.9" y1="4.9" x2="19.1" y2="19.1"/></svg>';
  return s + '<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>';
}

// finishAgentTurn finalizes the streaming turn: re-enable input, and reflect any
// filesystem changes the agent made into the tree, open editors, and preview.
function finishAgentTurn() {
  const t = agentTurn;
  if (!t || t.finished) { if (!t) setAgentBusy(false); return; }
  t.finished = true;
  clearLoad(t);
  agentTurn = null;
  setAgentBusy(false);

  if (t.sawFileChange || t.changedPaths.size > 0) {
    loadFileTree();
    // Reload editors for files the agent touched (without clobbering unsaved edits).
    t.changedPaths.forEach(reloadOpenFileFromDisk);
    // Reveal the change in the preview. The agent's auto-apply writes files
    // host-side, which the containerized dev server won't notice on its own, so
    // touch them inside the container to force a recompile, then reload.
    if (!IDE.previewUserClosed) {
      revealChangesInPreview(Array.from(t.changedPaths), false);
    } else {
      const preview = document.getElementById('ide-preview-panel');
      if (preview && preview.style.display !== 'none') revealChangesInPreview(Array.from(t.changedPaths), false);
    }
  }
}

// Make an edit actually show in the live preview. The dev server runs inside the
// sandbox and doesn't reliably see host-side writes (Docker bind-mount cache), so
// we ask the backend to re-write the changed files THROUGH the container (unless
// they were just saved via /file/save, which already does this) — that forces the
// dev server to recompile. Then we reload the preview twice: once now (catches HMR
// / an already-compiled route) and once after the recompile settles.
async function revealChangesInPreview(paths, alreadySynced) {
  try {
    if (!alreadySynced && Array.isArray(paths) && paths.length && IDE.container) {
      await fetch('/sandbox/sync', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ container: IDE.container, paths }),
      });
    }
  } catch { /* best-effort */ }
  if (typeof showChangesInPreview !== 'function') return;
  showChangesInPreview();
  setTimeout(() => showChangesInPreview(), 2200);
}

function setAgentBusy(busy) {
  const input = document.getElementById('agent-input');
  const btn = document.querySelector('.agent-send-btn');
  if (input) input.disabled = busy;
  if (btn) { btn.disabled = busy; btn.style.opacity = busy ? '0.6' : ''; }
  if (!busy && input) input.focus();
}

function scrollAgent(el) { el.scrollTop = el.scrollHeight; }

// ── Tool-call rendering ──

function toolIconSVG(name) {
  const n = (name || '').toLowerCase();
  let path;
  if (/(write|edit|create|save|patch|apply|update|insert)/.test(n)) {
    path = '<path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/>'; // pencil
  } else if (/(delete|remove|\brm\b|unlink)/.test(n)) {
    path = '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>'; // trash
  } else if (/(read|open|view|\bcat\b|get)/.test(n)) {
    path = '<path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>'; // book
  } else if (/(bash|shell|run|exec|command|npm|node|terminal|process)/.test(n)) {
    path = '<polyline points="4 17 10 11 4 5"/><line x1="12" x2="20" y1="19" y2="19"/>'; // terminal
  } else if (/(ls|list|glob|grep|search|find|ripgrep)/.test(n)) {
    path = '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>'; // search
  } else {
    path = '<path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"/>'; // wrench
  }
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + path + '</svg>';
}

const WRITE_TOOL_RE = /(write|edit|create|save|patch|apply|update|insert)/i;

// renderToolRow renders one tool invocation and returns the file path it changed
// (if it looks like a write), so the caller can reload that editor afterward.
// rawContent is "toolName({...json args...})" from the agent service.
function renderToolRow(container, rawContent) {
  let name = rawContent, argStr = '';
  const m = /^([A-Za-z0-9_.\-]+)\(([\s\S]*)\)$/.exec(rawContent);
  if (m) { name = m[1]; argStr = m[2]; }

  let args = null;
  try { args = JSON.parse(argStr); } catch { args = null; }

  let detail = '';
  if (args && typeof args === 'object') {
    detail = args.path || args.file_path || args.filePath || args.filename ||
      args.command || args.cmd || args.pattern || args.query || '';
    if (typeof detail !== 'string') detail = '';
  } else if (argStr) {
    detail = argStr.length > 80 ? argStr.slice(0, 80) + '…' : argStr;
  }

  const row = document.createElement('div');
  row.className = 'agent-tool-row';
  const iconEl = document.createElement('span');
  iconEl.className = 'agent-tool-icon';
  iconEl.innerHTML = toolIconSVG(name);
  const nameEl = document.createElement('span');
  nameEl.className = 'agent-tool-name';
  nameEl.textContent = name;
  row.appendChild(iconEl);
  row.appendChild(nameEl);
  if (detail) {
    const detailEl = document.createElement('span');
    detailEl.className = 'agent-tool-detail';
    detailEl.textContent = detail;
    row.appendChild(detailEl);
  }
  container.appendChild(row);

  // Report a changed path only for write-like tools with a concrete file path.
  if (WRITE_TOOL_RE.test(name) && args && typeof args === 'object') {
    const p = args.path || args.file_path || args.filePath || args.filename;
    if (typeof p === 'string' && p) return p;
  }
  return null;
}

// reloadOpenFileFromDisk refreshes an open editor tab from the sandbox after the
// agent edited it — unless the user has unsaved changes in that tab, in which case
// we leave their work alone and just flag it.
async function reloadOpenFileFromDisk(path) {
  const tab = IDE.tabs.find(t => t.path === path);
  if (!tab) return;
  if (tab.modified) {
    showToast('Agent changed ' + tab.name + ' on disk (kept your unsaved edits)', 'error');
    return;
  }
  try {
    const res = await fetch(`/file?container=${IDE.container}&path=${encodeURIComponent(path)}`);
    if (!res.ok) return;
    const content = await res.text();
    if (content !== tab.model.getValue()) tab.model.setValue(content);
    tab.original = content;
    tab.modified = false;
    renderTabs();
  } catch { /* ignore */ }
}

// ── REST fallback (single-shot, no streaming) ──

async function sendAgentViaRest(msg, provider, messages, mode) {
  try {
    const currentFile = IDE.activeTab ? {
      path: IDE.activeTab.path,
      content: IDE.activeTab.model.getValue(),
    } : null;

    const res = await fetch('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, provider, mode: mode || 'auto', container: IDE.container, current_file: currentFile }),
    });

    if (agentTurn) clearLoad(agentTurn);

    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: 'Agent unavailable' }));
      appendAgentError(messages, err.error || err.detail || 'Agent error');
    } else {
      const data = await res.json();
      const assistEl = document.createElement('div');
      assistEl.className = 'agent-msg assistant';
      assistEl.innerHTML = formatAgentResponse(data.response || data.message || JSON.stringify(data));
      messages.appendChild(assistEl);

      if (data.file_changes && data.file_changes.length > 0) {
        data.file_changes.forEach(change => {
          const applyBtn = document.createElement('button');
          applyBtn.className = 'agent-apply-btn';
          applyBtn.textContent = `Apply to ${change.path}`;
          applyBtn.onclick = () => applyAgentChange(change);
          assistEl.appendChild(applyBtn);
        });
      }
    }
  } catch (e) {
    appendAgentError(messages, 'Agent service unavailable. Start it with: cd agent-services && npm install && node server.js');
  } finally {
    agentTurn = null;
    setAgentBusy(false);
    scrollAgent(messages);
  }
}

function appendAgentError(messages, text) {
  const errEl = document.createElement('div');
  errEl.className = 'agent-msg error';
  errEl.textContent = text;
  messages.appendChild(errEl);
}

function formatAgentResponse(text) {
  // Escape HTML first so model/user/file content can never inject markup (XSS).
  // The markdown tags we add below are inserted after escaping, so they render.
  text = escapeHtml(text);
  // Code blocks
  text = text.replace(/```(\w*)\n([\s\S]*?)```/g, '<pre><code class="lang-$1">$2</code></pre>');
  // Inline code
  text = text.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  text = text.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Newlines
  text = text.replace(/\n/g, '<br>');
  return text;
}

function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = String(s);
  return d.innerHTML;
}

async function applyAgentChange(change) {
  try {
    const res = await fetch('/file/save', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, path: change.path, content: change.content }),
    });
    if (res.ok) {
      showToast('Applied changes to ' + change.path, 'success');
      const tab = IDE.tabs.find(t => t.path === change.path);
      if (tab) {
        tab.model.setValue(change.content);
        tab.original = change.content;
        tab.modified = false;
        renderTabs();
      }
      loadFileTree();
    } else {
      showToast('Failed to apply changes', 'error');
    }
  } catch (e) {
    showToast('Apply error', 'error');
  }
}

// Grow the composer textarea to fit its content (up to the CSS max-height, then
// it scrolls). Mirrors the Cursor/ChatGPT input behaviour.
function autoGrowAgentInput(el) {
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 200) + 'px';
}

// Agent input: Enter sends, Shift+Enter inserts a newline; textarea auto-grows.
document.addEventListener('DOMContentLoaded', () => {
  const agentInput = document.getElementById('agent-input');
  if (agentInput) {
    agentInput.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendAgentMessage();
      }
    });
    agentInput.addEventListener('input', () => autoGrowAgentInput(agentInput));
  }
});

// ── GitAgent panel ───────────────────────────────────────────────────────────
//
// Browse the GitAgent registry (registry.gitagent.sh), see which community agents
// fill the Developer and Guardrails slots of the edit pipeline for this workspace,
// and swap them. Assigning writes .gitagent/pipeline.json and live-clones the
// agent into the sandbox — so the next edit runs as that agent. See registry.js.

const GitAgent = { status: null, registry: [], busy: false, filter: '' };

// Which slot a registry category fills (mirrors the backend).
function gaSlotFor(category) {
  return (category === 'security' || category === 'compliance') ? 'guardrails' : 'developer';
}

function gaEnsureModal() {
  let m = document.getElementById('gitagent-modal');
  if (m) return m;
  m = document.createElement('div');
  m.className = 'ga-modal';
  m.id = 'gitagent-modal';
  m.style.display = 'none';
  m.innerHTML = `
    <div class="ga-box">
      <div class="ga-head">
        <div class="ga-title">GitAgent pipeline
          <a href="https://registry.gitagent.sh" target="_blank" rel="noopener" class="ga-sub">registry.gitagent.sh</a>
        </div>
        <button class="ga-close" onclick="closeGitAgentPanel()" title="Close">&times;</button>
      </div>
      <div class="ga-slots" id="ga-slots"></div>
      <div class="ga-skills-strip">
        <div class="ga-skills-head">
          <span class="ga-skills-title">Skills <span>the personas in .gitagent/skills — edit a file to change behavior</span></span>
          <button class="ga-btn" onclick="gaNewSkill()">+ New skill</button>
        </div>
        <div class="ga-skills" id="ga-skills"></div>
      </div>
      <div class="ga-browser">
        <div class="ga-browser-head">
          <input id="ga-search" class="ga-search" placeholder="Search the registry (name, tag, category)…" spellcheck="false" />
          <span class="ga-manual">
            <input id="ga-ref" class="ga-search ga-ref-input" placeholder="author/agent-name" spellcheck="false" />
            <button class="ga-btn dev" onclick="gaAssignManual('developer')">Dev</button>
            <button class="ga-btn guard" onclick="gaAssignManual('guardrails')">Guard</button>
          </span>
        </div>
        <div class="ga-list" id="ga-list"></div>
      </div>
      <div class="ga-steps" id="ga-steps"></div>
    </div>`;
  m.addEventListener('click', (e) => { if (e.target === m) closeGitAgentPanel(); });
  document.body.appendChild(m);
  const search = m.querySelector('#ga-search');
  search.addEventListener('input', () => { GitAgent.filter = search.value.trim().toLowerCase(); gaRenderList(); });
  return m;
}

async function openGitAgentPanel() {
  if (!IDE.container) { showToast('Launch a repo first', 'error'); return; }
  const m = gaEnsureModal();
  m.style.display = 'flex';
  gaRenderSlots();   // paint from any cached state immediately
  gaRenderSkills();
  gaRenderList();
  await Promise.all([gaLoadStatus(), gaLoadRegistry()]);
}

function closeGitAgentPanel() {
  const m = document.getElementById('gitagent-modal');
  if (m) m.style.display = 'none';
}

async function gaLoadStatus() {
  try {
    const res = await fetch(`/agent/gitagent?container=${encodeURIComponent(IDE.container)}`);
    const data = await res.json();
    if (res.ok) { GitAgent.status = data; gaRenderSlots(); gaRenderSkills(); }
  } catch { /* offline — slots stay as-is */ }
}

// The repo's own skills (.gitagent/skills). Built-in personas plus any the user
// authored. Click one to open its SKILL.md in the editor (it's the source of truth).
function gaRenderSkills() {
  const el = document.getElementById('ga-skills');
  if (!el) return;
  const skills = (GitAgent.status && GitAgent.status.skills) || [];
  if (!skills.length) { el.innerHTML = '<span class="ga-empty">No skills yet.</span>'; return; }
  el.innerHTML = skills.map((s) =>
    `<button class="ga-skill-chip" title="Open .gitagent/skills/${escapeHtml(s)}/SKILL.md"
        onclick="gaOpenSkill('${escapeHtml(s)}')">${escapeHtml(s)}</button>`).join('');
}

function gaOpenSkill(slug) {
  const path = `.gitagent/skills/${slug}/SKILL.md`;
  closeGitAgentPanel();
  if (typeof openFile === 'function') openFile(path, 'SKILL.md');
}

async function gaNewSkill() {
  if (!IDE.container) { showToast('Launch a repo first', 'error'); return; }
  const name = prompt('New skill name (e.g. accessibility-checker):');
  if (!name || !name.trim()) return;
  const description = prompt('One-line description (optional):') || '';
  const body = prompt('When does it apply and how should the agent behave? (optional):') || '';
  try {
    const res = await fetch('/agent/skill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, name, description, body }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not create skill', 'error'); return; }
    if (GitAgent.status) GitAgent.status.skills = data.skills || GitAgent.status.skills;
    gaRenderSkills();
    if (typeof loadFileTree === 'function') loadFileTree();
    showToast(`Created skill "${data.slug}"`, 'success');
  } catch (e) {
    showToast('Create skill failed', 'error');
  }
}

async function gaLoadRegistry() {
  const list = document.getElementById('ga-list');
  if (list && !GitAgent.registry.length) list.innerHTML = '<div class="ga-empty">Loading registry…</div>';
  try {
    const res = await fetch('/agent/registry');
    const data = await res.json();
    GitAgent.registry = (data && data.agents) || [];
  } catch { GitAgent.registry = []; }
  gaRenderList();
}

function gaSlotCard(slot, agent) {
  if (!agent) {
    return `<div class="ga-slot-agent empty">Built-in ${slot === 'developer' ? 'Developer' : 'Guardrails'}</div>`;
  }
  const dot = agent.installed ? 'installed' : 'pending';
  return `<div class="ga-slot-agent">
      <span class="ga-dot ${dot}" title="${agent.installed ? 'cloned into the sandbox' : 'clones on next edit'}"></span>
      <span class="ga-slot-name">${escapeHtml(agent.ref)}</span>
      <button class="ga-x" title="Remove" onclick="gaRemove('${escapeHtml(agent.ref)}','${slot}')">&times;</button>
    </div>`;
}

function gaRenderSlots() {
  const el = document.getElementById('ga-slots');
  if (!el) return;
  const st = GitAgent.status || { developer: null, guardrails: [] };
  const guards = (st.guardrails || []).map((g) => gaSlotCard('guardrails', g)).join('');
  el.innerHTML = `
    <div class="ga-slot">
      <div class="ga-slot-label">Developer<span>rewrites the code</span></div>
      <div class="ga-slot-body">${gaSlotCard('developer', st.developer)}</div>
    </div>
    <div class="ga-slot">
      <div class="ga-slot-label">Guardrails<span>can block an edit</span></div>
      <div class="ga-slot-body">${guards || gaSlotCard('guardrails', null)}</div>
    </div>`;
}

function gaRenderList() {
  const el = document.getElementById('ga-list');
  if (!el) return;
  if (!GitAgent.registry.length) {
    el.innerHTML = '<div class="ga-empty">Registry unavailable. Add an agent by ref above (author/agent-name).</div>';
    return;
  }
  const f = GitAgent.filter;
  const rows = GitAgent.registry.filter((a) => {
    if (!f) return true;
    return (a.ref + ' ' + a.description + ' ' + a.category + ' ' + (a.tags || []).join(' ')).toLowerCase().includes(f);
  });
  if (!rows.length) { el.innerHTML = '<div class="ga-empty">No agents match.</div>'; return; }
  el.innerHTML = rows.map((a) => {
    const primary = gaSlotFor(a.category);
    return `<div class="ga-card">
      <div class="ga-card-main">
        <div class="ga-card-top">
          <span class="ga-card-name">${escapeHtml(a.ref)}</span>
          <span class="ga-tag ${primary}">${escapeHtml(a.category)}</span>
        </div>
        <div class="ga-card-desc">${escapeHtml(a.description || '')}</div>
      </div>
      <div class="ga-card-actions">
        <button class="ga-btn dev" onclick="gaAssign('${escapeHtml(a.ref)}','developer')">Developer</button>
        <button class="ga-btn guard" onclick="gaAssign('${escapeHtml(a.ref)}','guardrails')">+ Guardrail</button>
      </div>
    </div>`;
  }).join('');
}

function gaRenderSteps(steps) {
  const el = document.getElementById('ga-steps');
  if (!el) return;
  if (!steps || !steps.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="ga-steps-title">Install log</div>' +
    steps.map((s) => `<div class="ga-step">${escapeHtml(s)}</div>`).join('');
}

function gaCurrent() {
  const st = GitAgent.status || { developer: null, guardrails: [] };
  return {
    developer: st.developer ? st.developer.ref : null,
    guardrails: (st.guardrails || []).map((g) => g.ref),
  };
}

async function gaAssign(ref, slot) {
  const cur = gaCurrent();
  if (slot === 'developer') cur.developer = ref;
  else if (!cur.guardrails.includes(ref)) cur.guardrails.push(ref);
  await gaSave(cur.developer, cur.guardrails);
}

function gaAssignManual(slot) {
  const input = document.getElementById('ga-ref');
  const ref = (input.value || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(ref)) { showToast('Use author/agent-name', 'error'); return; }
  input.value = '';
  gaAssign(ref, slot);
}

async function gaRemove(ref, slot) {
  const cur = gaCurrent();
  if (slot === 'developer') cur.developer = null;
  else cur.guardrails = cur.guardrails.filter((r) => r !== ref);
  await gaSave(cur.developer, cur.guardrails);
}

async function gaSave(developer, guardrails) {
  if (GitAgent.busy) return;
  GitAgent.busy = true;
  gaRenderSteps(['GitAgent: installing…']);
  try {
    const res = await fetch('/agent/gitagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, developer, guardrails }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Update failed', 'error'); gaRenderSteps([]); return; }
    GitAgent.status = data.status;
    gaRenderSlots();
    gaRenderSteps(data.steps);
    showToast('GitAgent pipeline updated', 'success');
  } catch (e) {
    showToast('Update failed', 'error');
    gaRenderSteps([]);
  } finally {
    GitAgent.busy = false;
  }
}

// ── Build doctor (intelligent auto-fix) ──────────────────────────────────────
// Reads the sandbox's container logs and asks the agent to classify real errors
// vs. noise, then proposes ONE fix (a command to run, or an edit to apply) with a
// one-click action. Triggered automatically when the app is slow to come up
// (ide.js fetchStatus) and manually from the "Diagnose" button in the agent panel.
let doctorBusy = false;

function ensureAgentPanelOpen() {
  const panel = document.getElementById('ide-agent-panel');
  if (panel && panel.style.display === 'none' && typeof toggleAgentPanel === 'function') {
    toggleAgentPanel();
  }
}

function doctorProvider() {
  const el = document.getElementById('agent-provider');
  return el ? el.value : undefined;
}

async function runDoctor(auto) {
  if (!IDE.container) { if (!auto) showToast('Launch a repo first', 'error'); return; }
  if (doctorBusy) return;
  doctorBusy = true; IDE.doctorRunning = true;
  ensureAgentPanelOpen();
  const messages = document.getElementById('agent-messages');
  const welcome = messages && messages.querySelector('.agent-welcome');
  if (welcome) welcome.remove();
  const statusEl = document.createElement('div');
  statusEl.className = 'agent-msg loading';
  statusEl.textContent = auto ? 'The app is taking a while — checking the logs' : 'Diagnosing the app';
  if (messages) { messages.appendChild(statusEl); scrollAgent(messages); }
  try {
    let logs = '';
    try { logs = await (await fetch(`/logs/${IDE.container}`)).text(); } catch (e) { /* logs optional */ }
    const res = await fetch('/agent/diagnose', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, logs, provider: doctorProvider() }),
    });
    statusEl.remove();
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      if (!auto) showToast(err.error || 'Diagnosis failed', 'error');
      return;
    }
    renderDoctorCard(await res.json(), auto);
  } catch (e) {
    statusEl.remove();
    if (!auto) showToast('Diagnosis error', 'error');
  } finally {
    doctorBusy = false; IDE.doctorRunning = false;
  }
}

function renderDoctorCard(result, auto) {
  const messages = document.getElementById('agent-messages');
  if (!messages) return;
  const sev = ['error', 'warning', 'ok'].includes(result.severity) ? result.severity : 'warning';
  const fix = result.fix || { kind: 'none' };

  const card = document.createElement('div');
  card.className = 'agent-msg doctor-card sev-' + sev;
  let html = `<div class="doctor-head"><span class="doctor-dot"></span>`
    + `<span class="doctor-title">Build doctor</span>`
    + `<span class="doctor-sev">${escapeHtml(sev)}</span></div>`;
  if (result.summary) html += `<div class="doctor-summary">${escapeHtml(result.summary)}</div>`;
  if (result.cause) html += `<div class="doctor-cause">${escapeHtml(result.cause)}</div>`;
  card.innerHTML = html;

  if (fix.kind === 'command' && fix.command) {
    const box = document.createElement('div');
    box.className = 'doctor-fix';
    box.innerHTML = `<div class="doctor-fix-label">Suggested command</div>`
      + `<pre class="doctor-cmd"><code>${escapeHtml(fix.command)}</code></pre>`;
    const btn = document.createElement('button');
    btn.className = 'doctor-btn';
    btn.textContent = 'Run in terminal';
    btn.onclick = () => doctorRunCommand(fix.command, btn, card);
    box.appendChild(btn);
    card.appendChild(box);
  } else if (fix.kind === 'edit' && fix.instruction) {
    const box = document.createElement('div');
    box.className = 'doctor-fix';
    box.innerHTML = `<div class="doctor-fix-label">Suggested edit${fix.file ? ' · ' + escapeHtml(fix.file) : ''}</div>`
      + `<div class="doctor-instruction">${escapeHtml(fix.instruction)}</div>`;
    const btn = document.createElement('button');
    btn.className = 'doctor-btn';
    btn.textContent = 'Apply fix';
    btn.onclick = () => {
      doctorApplyEdit(fix.file ? `In ${fix.file}: ${fix.instruction}` : fix.instruction);
      btn.disabled = true; btn.textContent = 'Applying';
    };
    box.appendChild(btn);
    card.appendChild(box);
  } else {
    const ok = document.createElement('div');
    ok.className = 'doctor-clear';
    ok.textContent = sev === 'ok'
      ? 'No blocking problem found. The app is fine — any warnings in the log are safe to ignore.'
      : 'Nothing to fix automatically right now.';
    card.appendChild(ok);
  }
  messages.appendChild(card);
  scrollAgent(messages);
}

async function doctorRunCommand(command, btn, card) {
  if (btn) { btn.disabled = true; btn.textContent = 'Running'; }
  try {
    const res = await fetch('/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, command }),
    });
    const out = await res.text();
    if (card) {
      const pre = document.createElement('pre');
      pre.className = 'doctor-output';
      pre.textContent = (out || '').slice(-2000);
      card.appendChild(pre);
      scrollAgent(document.getElementById('agent-messages'));
    }
    showToast(res.ok ? 'Command finished' : 'Command failed', res.ok ? 'success' : 'error');
    if (btn) { btn.textContent = res.ok ? 'Ran' : 'Retry'; btn.disabled = !res.ok; }
    // Re-arm the doctor and reset the grace window so a follow-up check can run.
    IDE.doctorRan = false; IDE.launchedAt = Date.now();
  } catch (e) {
    showToast('Run error', 'error');
    if (btn) { btn.disabled = false; btn.textContent = 'Run in terminal'; }
  }
}

// Route an edit fix through the existing (guardrailed) edit pipeline by reusing
// the normal agent send, forced to Edit mode for this one turn.
function doctorApplyEdit(instruction) {
  const input = document.getElementById('agent-input');
  if (!input) return;
  if (agentTurn) { showToast('Wait for the current turn to finish', 'error'); return; }
  input.value = instruction;
  const modeEl = document.getElementById('agent-mode');
  const prev = modeEl ? modeEl.value : null;
  if (modeEl) modeEl.value = 'edit';
  sendAgentMessage();
  if (modeEl && prev !== null) modeEl.value = prev;
}
