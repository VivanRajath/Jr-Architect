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
  // Use the shared escaper rather than a local textContent/innerHTML trick — the
  // local one had the same quote-blind behaviour that made the registry XSS possible.
  const escLocal = escapeHtml;
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

// Escape a value for insertion into HTML — including BOTH quote characters, so
// the result is safe in an attribute value as well as in element text.
//
// This used to be `d.textContent = s; return d.innerHTML`, which escapes only
// `& < >`: a text node never needs a quote escaped, so the browser doesn't
// produce one. That made every `title="${escapeHtml(x)}"` an injection point for
// any value we don't control — and several of them carry data straight from the
// public registry index, so merely browsing the Registry tab was enough to run
// an attacker's `onmouseover`. Escaping explicitly closes the whole class.
function escapeHtml(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Same function, named for the position. Use it where the value lands inside an
// attribute so the intent is legible at the call site.
const escapeAttr = escapeHtml;

// Only http(s) may reach an href. A registry entry supplies its own repository
// URL, and a `javascript:` URL is dangerous without needing a quote at all —
// escaping cannot help there, so the scheme is allowlisted instead. Returns ""
// for anything else, which renders as a dead link rather than a live hazard.
function safeUrl(u) {
  const s = String(u == null ? '' : u).trim();
  return /^https?:\/\/[^\s]+$/i.test(s) ? s : '';
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
// The IDE's front door to the GitAgent standard (gitagent.sh). One dock, three
// tabs:
//
//   Agent     this repository's own agent — identity, rules, memory, guardrails,
//             manifest — plus which agents fill the edit pipeline's slots
//   Skills    the personas under .gitagent/skills that drive the pipeline; the
//             built-in ones are editable files, not hidden prompts
//   Registry  community agents from registry.gitagent.sh: preview what an agent
//             will inject, install it, hand it a slot
//
// Everything shown here is a real file in the workspace, so every change is a
// git diff the user can review and commit — the point of the standard. Assigning
// a slot writes .gitagent/pipeline.json and live-clones the agent into the
// sandbox, so the next edit runs as that agent. See agent-services/registry.js.

const GitAgent = {
  status: null,      // GET /agent/gitagent — spec, skills, slots, installed
  registry: [],      // GET /agent/registry — the community index (workspace-independent)
  container: null,   // which sandbox `status` describes — see gaResetForContainer
  tab: 'agent',
  filter: '',
  busy: false,
  editor: null,      // { path, label, hint, content, original } while editing a file
  detail: null,      // ref of the expanded registry card
  details: {},       // ref -> preview from GET /agent/registry/agent
  draft: null,       // { name, description, body } while composing a new skill
  steps: [],
  knowledgePoll: null, // interval id while a knowledge build is in flight
};

// The slot an agent will take. The backend classifies it (registry.js
// classifySlot) and ships it on each row, so this is only a fallback for a
// cached response from an older service.
function gaSlotFor(agent) {
  if (agent && agent.slot) return agent.slot;
  const c = agent && agent.category;
  return (c === 'security' || c === 'compliance' || c === 'governance') ? 'guardrails' : 'developer';
}

function gaSlotLabel(slot) {
  return slot === 'guardrails' ? 'Guardrail' : 'Developer';
}

// escapeHtml() leaves quotes alone, which is fine for text but not for a value
// interpolated into a single-quoted JS string inside an onclick attribute. A
// registry ref is remote data, so escape it for that position specifically.
function gaJs(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/&/g, '&amp;')
    .replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// ── Panel open/close ─────────────────────────────────────────────────────────

function toggleGitAgentPanel() {
  const panel = document.getElementById('ide-gitagent-panel');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  if (open) { closeGitAgentPanel(); return; }
  openGitAgentPanel();
}

// Everything except the registry index is per-workspace, so going back to the
// landing page and launching a different repo must not leave the previous repo's
// spec, skills, or install log on screen.
function gaResetForContainer() {
  if (GitAgent.container === IDE.container) return;
  GitAgent.container = IDE.container;
  GitAgent.status = null;
  GitAgent.editor = null;
  GitAgent.draft = null;
  GitAgent.detail = null;
  GitAgent.steps = [];
  GitAgent.tab = 'agent';
}

// `tab` is optional — the AI-panel header button opens straight to the registry,
// while the activity bar opens the repo's own agent.
function openGitAgentPanel(tab) {
  if (!IDE.container) { showToast('Launch a repo first', 'error'); return; }
  const panel = document.getElementById('ide-gitagent-panel');
  if (!panel) return;
  gaResetForContainer();
  panel.style.display = 'flex';
  const btn = document.getElementById('act-gitagent');
  if (btn) btn.classList.add('active');
  if (tab) GitAgent.tab = tab;
  gaRender();
  if (IDE.editor && typeof IDE.editor.layout === 'function') setTimeout(() => IDE.editor.layout(), 0);
  gaRefresh();
}

function closeGitAgentPanel() {
  const panel = document.getElementById('ide-gitagent-panel');
  if (panel) panel.style.display = 'none';
  const btn = document.getElementById('act-gitagent');
  if (btn) btn.classList.remove('active');
  if (IDE.editor && typeof IDE.editor.layout === 'function') setTimeout(() => IDE.editor.layout(), 0);
}

function gaSwitchTab(tab) {
  GitAgent.tab = tab;
  GitAgent.editor = null;   // leaving a tab abandons an open file editor
  GitAgent.draft = null;
  gaRender();
  if (tab === 'registry' && !GitAgent.registry.length) gaLoadRegistry();
}

async function gaRefresh() {
  await Promise.all([gaLoadStatus(), GitAgent.tab === 'registry' ? gaLoadRegistry() : null]);
}

async function gaLoadStatus() {
  try {
    const res = await fetch(`/agent/gitagent?container=${encodeURIComponent(IDE.container)}`);
    const data = await res.json();
    if (res.ok) {
      GitAgent.status = data;
      gaRender();
      // Opening the panel during the automatic build at workspace open should
      // show it finishing, not a frozen "building…" that never resolves.
      if ((data.knowledgeState || {}).status === 'building' && !GitAgent.knowledgePoll) {
        gaPollKnowledge();
      }
    }
  } catch { /* offline — keep whatever is painted */ }
}

async function gaLoadRegistry() {
  try {
    const res = await fetch('/agent/registry');
    const data = await res.json();
    GitAgent.registry = (data && data.agents) || [];
  } catch { GitAgent.registry = []; }
  gaRender();
}

// ── Render ───────────────────────────────────────────────────────────────────

function gaRender() {
  const body = document.getElementById('ga-panel-body');
  if (!body) return;
  document.querySelectorAll('#ide-gitagent-panel .ga-tab').forEach((t) => {
    t.classList.toggle('active', t.dataset.tab === GitAgent.tab);
  });
  // A file editor takes over the panel body so the textarea keeps focus and
  // caret position — re-rendering the whole tab on every keystroke would not.
  if (GitAgent.editor) { body.innerHTML = gaEditorHTML(); gaFocusEditor(); return; }
  if (GitAgent.tab === 'agent') body.innerHTML = gaAgentTabHTML();
  else if (GitAgent.tab === 'skills') body.innerHTML = gaSkillsTabHTML();
  else body.innerHTML = gaRegistryTabHTML();
  gaBindTabInputs();
  gaRenderSteps();
}

// Re-attach the handlers for inputs that must not trigger a re-render on every
// keystroke (search box, new-skill draft).
function gaBindTabInputs() {
  const search = document.getElementById('ga-search');
  if (search) {
    search.value = GitAgent.filter;
    search.oninput = () => {
      GitAgent.filter = search.value.trim().toLowerCase();
      const list = document.getElementById('ga-list');
      if (list) list.innerHTML = gaListHTML();
    };
  }
  ['name', 'description', 'body'].forEach((k) => {
    const el = document.getElementById(`ga-draft-${k}`);
    if (el && GitAgent.draft) el.oninput = () => { GitAgent.draft[k] = el.value; };
  });
}

// ── Agent tab: this repository's own agent ───────────────────────────────────

function gaAgentTabHTML() {
  const st = GitAgent.status;
  if (!st) return '<div class="ga-empty">Loading the agent spec…</div>';
  const spec = st.spec || [];
  const files = spec.map((f) => `
    <button class="ga-file" onclick="gaOpenEditor('${gaJs(f.path)}','${gaJs(f.label)}','${gaJs(f.hint)}')">
      <span class="ga-file-top">
        <span class="ga-file-label">${escapeHtml(f.label)}</span>
        <span class="ga-file-path">${escapeHtml(f.path)}</span>
        ${f.exists ? '' : '<span class="ga-badge missing">missing</span>'}
      </span>
      <span class="ga-file-hint">${escapeHtml(f.hint)}</span>
    </button>`).join('');

  return `
    <div class="ga-section">
      <div class="ga-section-head">
        <span class="ga-section-title">This repository's agent</span>
        <span class="ga-section-sub">Committed under <code>.gitagent/</code> — versioned with the code and read before every edit.</span>
      </div>
      <div class="ga-files">${files || '<div class="ga-empty">No spec files yet.</div>'}</div>
    </div>
    <div class="ga-section">
      <div class="ga-section-head">
        <span class="ga-section-title">Pipeline slots</span>
        <span class="ga-section-sub">Which agent rewrites the code, which can block an edit, and which reads the repo when it opens. Assign from the Registry tab.</span>
      </div>
      ${gaSlotsHTML()}
    </div>
    ${gaInstalledHTML()}`;
}

function gaSlotCard(slot, agent) {
  if (!agent) {
    return `<div class="ga-slot-agent empty">Built-in ${slot === 'developer' ? 'Developer' : 'Guardrails'}</div>`;
  }
  const dot = agent.installed ? 'installed' : 'pending';
  // The files this agent wrote into .gitagent/ — its rules and its stage. Opening
  // one shows exactly what it contributes, and editing it changes the next edit.
  const hint = slot === 'guardrails'
    ? 'The rules this guardrail enforces. Edit them and the next review uses your version.'
    : slot === 'knowledge'
    ? 'The prompt this agent runs when the workspace opens. Edit it, then press Rebuild.'
    : 'What this agent injects before it rewrites code. Edit it and the next edit changes.';
  // The built-in knowledge builder is a real skill file, not a pulled agent — so it
  // gets no remove control (there is nothing to remove it to) but is still openable.
  if (agent.builtin) {
    const bFiles = (agent.specFiles || []).map((f) => `
      <button class="ga-chip" title="${escapeAttr(f)}"
        onclick="gaOpenEditor('${gaJs(f)}','${gaJs(agent.ref)}','${gaJs(hint)}')">${escapeHtml(f.split('/').pop())}</button>`).join('');
    return `<div class="ga-slot-agent">
        <div class="ga-slot-agent-head">
          <span class="ga-dot installed" title="built in — a skill file in this repo"></span>
          <span class="ga-slot-name">${escapeHtml(agent.ref)}</span>
          <span class="ga-badge">default</span>
        </div>
        ${bFiles ? `<div class="ga-slot-files">${bFiles}</div>` : ''}
      </div>`;
  }
  const files = (agent.specFiles || []).map((f) => `
      <button class="ga-chip" title="${escapeAttr(f)}"
        onclick="gaOpenEditor('${gaJs(f)}','${gaJs(agent.ref)}','${gaJs(hint)}')">${escapeHtml(f.split('/').pop())}</button>`).join('');
  return `<div class="ga-slot-agent">
      <div class="ga-slot-agent-head">
        <span class="ga-dot ${dot}" title="${agent.installed ? 'cloned into the sandbox' : 'clones on the next edit'}"></span>
        <span class="ga-slot-name">${escapeHtml(agent.ref)}</span>
        <button class="ga-x" title="Remove" onclick="gaRemove('${gaJs(agent.ref)}','${slot}')">&times;</button>
      </div>
      ${files ? `<div class="ga-slot-files">${files}</div>` : ''}
    </div>`;
}

function gaSlotsHTML() {
  const st = GitAgent.status || { developer: null, guardrails: [] };
  const guards = (st.guardrails || []).map((g) => gaSlotCard('guardrails', g)).join('');
  return `
    <div class="ga-slots">
      <div class="ga-slot">
        <div class="ga-slot-label">Developer<span>rewrites the code</span></div>
        <div class="ga-slot-body">${gaSlotCard('developer', st.developer)}</div>
      </div>
      <div class="ga-slot">
        <div class="ga-slot-label">Guardrails<span>can block an edit</span></div>
        <div class="ga-slot-body">${guards || gaSlotCard('guardrails', null)}</div>
      </div>
      <div class="ga-slot">
        <div class="ga-slot-label">Knowledge<span>reads the repo at open</span></div>
        <div class="ga-slot-body">${gaSlotCard('knowledge', st.knowledge)}${gaKnowledgeDocHTML()}</div>
      </div>
    </div>`;
}

// What the Knowledge slot has actually produced. The slot always has an occupant,
// so the useful question is not "is one assigned" but "did it run, and when".
function gaKnowledgeDocHTML() {
  const st = GitAgent.status || {};
  const doc = st.knowledgeDoc || {};
  const state = st.knowledgeState || {};

  if (state.status === 'building') {
    return `<div class="ga-know building">
      <span class="ga-spin"></span>
      <span class="ga-know-text">Reading the repository on its own API key…</span>
    </div>`;
  }

  const rebuild = `<button class="ga-btn tiny" onclick="gaRebuildKnowledge()">Rebuild</button>`;

  if (!doc.exists) {
    const why = state.status === 'failed'
      ? `Build failed — ${escapeHtml(state.error || 'unknown error')}`
      : 'Not built yet. It runs automatically when a workspace opens.';
    return `<div class="ga-know">
      <span class="ga-know-text ${state.status === 'failed' ? 'bad' : ''}">${why}</span>
      ${rebuild}
    </div>`;
  }

  const when = doc.builtAt ? gaAgo(doc.builtAt) : '';
  const kb = doc.bytes ? `${Math.max(1, Math.round(doc.bytes / 1024))} KB` : '';
  const meta = [when, kb, doc.sources ? `${doc.sources} sources` : ''].filter(Boolean).join(' · ');
  // The document rides in every turn, so a claim it could not verify is worth
  // showing rather than burying — the reader can open it and judge.
  const unverified = (doc.unverified || []).length
    ? `<span class="ga-know-text warn" title="${escapeAttr('Cited but not found in the workspace: ' + doc.unverified.join(', '))}">${doc.unverified.length} unverified path${doc.unverified.length === 1 ? '' : 's'}</span>`
    : '';
  return `<div class="ga-know">
    <button class="ga-chip" title="${escapeAttr(doc.path)}"
      onclick="gaOpenKnowledgeDoc()">${escapeHtml((doc.path || '').split('/').pop())}</button>
    <span class="ga-know-text">${escapeHtml(meta)}</span>
    ${unverified}
    ${rebuild}
  </div>`;
}

function gaAgo(iso) {
  const t = Date.parse(iso);
  if (!t) return '';
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

// The overview lives under knowledge/, not .gitagent/, so the spec-file editor
// cannot open it (it only reaches into the spec folder). Open it in the real
// editor instead — it is a normal file in the workspace.
function gaOpenKnowledgeDoc() {
  const doc = (GitAgent.status || {}).knowledgeDoc || {};
  if (!doc.path) return;
  if (typeof openFile === 'function') openFile(doc.path, doc.path.split('/').pop());
  if (typeof revealInTree === 'function') revealInTree(doc.path);
}

async function gaRebuildKnowledge() {
  if (GitAgent.busy) return;
  GitAgent.busy = true;
  try {
    const res = await fetch('/agent/knowledge', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not start the build', 'error'); return; }
    showToast('Knowledge build started', 'success');
    gaPollKnowledge();
  } catch {
    showToast('Could not reach the agent service', 'error');
  } finally {
    GitAgent.busy = false;
  }
}

// The build takes ~30-60s in a child process, so the panel polls rather than
// waiting on the request. Stops as soon as the state settles.
function gaPollKnowledge() {
  if (GitAgent.knowledgePoll) clearInterval(GitAgent.knowledgePoll);
  let ticks = 0;
  GitAgent.knowledgePoll = setInterval(async () => {
    if (++ticks > 60) { clearInterval(GitAgent.knowledgePoll); GitAgent.knowledgePoll = null; return; }
    try {
      const res = await fetch(`/agent/knowledge?container=${encodeURIComponent(IDE.container)}`);
      if (!res.ok) return;
      const data = await res.json();
      if (GitAgent.status) {
        GitAgent.status.knowledgeState = data.state || {};
        GitAgent.status.knowledgeDoc = data.doc || {};
        if (!GitAgent.editor) gaRender();
      }
      if ((data.state || {}).status !== 'building') {
        clearInterval(GitAgent.knowledgePoll);
        GitAgent.knowledgePoll = null;
        if (typeof loadFileTree === 'function') loadFileTree();
      }
    } catch { /* keep polling; the service may be restarting */ }
  }, 2000);
}

// Community agents cloned into this workspace, slot or no slot — each one's real
// files can be opened, which is how you audit what an installed agent injects.
function gaInstalledHTML() {
  const installed = (GitAgent.status && GitAgent.status.installedAgents) || [];
  if (!installed.length) return '';
  const rows = installed.map((a) => `
    <div class="ga-installed">
      <div class="ga-installed-head">
        <span class="ga-dot installed"></span>
        <span class="ga-slot-name">${escapeHtml(a.ref)}</span>
        <span class="ga-file-path">${escapeHtml(a.path)}</span>
      </div>
      <div class="ga-installed-files">
        ${a.files.length
          ? a.files.map((f) => `<button class="ga-chip" onclick="gaOpenEditor('${gaJs(f)}','${gaJs(a.ref)}','A file from the installed agent. Editing it changes what this agent injects here, locally.')">${escapeHtml(f.split('/').pop())}</button>`).join('')
          : '<span class="ga-empty">ships no spec files</span>'}
      </div>
    </div>`).join('');
  return `
    <div class="ga-section">
      <div class="ga-section-head">
        <span class="ga-section-title">Installed agents</span>
        <span class="ga-section-sub">The upstream clone under <code>.gitagent/agents/</code>, kept as-is to diff against. The copy that actually runs is the one in the slot above.</span>
      </div>
      ${rows}
    </div>`;
}

// ── Skills tab ───────────────────────────────────────────────────────────────

function gaSkillsTabHTML() {
  if (GitAgent.draft) return gaDraftHTML();
  const skills = (GitAgent.status && GitAgent.status.skills) || [];
  const rows = skills.map((s) => {
    const slug = typeof s === 'string' ? s : s.slug;
    const desc = (typeof s === 'string' ? '' : s.description) || '';
    const builtin = typeof s === 'string' ? false : !!s.builtin;
    const path = (typeof s === 'string' ? `.gitagent/skills/${s}/SKILL.md` : s.path);
    // A skill written here by a pulled agent: editable, but owned by its slot —
    // deleting the file alone would just bring it back on the next turn.
    const agent = (typeof s === 'string' ? '' : s.agent) || '';
    const badge = agent
      ? `<span class="ga-badge pulled" title="Pulled from the registry as ${escapeHtml(agent)}">${escapeHtml(agent)}</span>`
      : builtin ? '<span class="ga-badge">built-in</span>' : '<span class="ga-badge custom">yours</span>';
    return `<div class="ga-skill">
      <div class="ga-skill-main">
        <div class="ga-skill-top">
          <span class="ga-skill-name">${escapeHtml(slug)}</span>
          ${badge}
        </div>
        <div class="ga-skill-desc">${escapeHtml(desc || 'No description.')}</div>
      </div>
      <div class="ga-skill-actions">
        <button class="ga-btn" onclick="gaOpenEditor('${gaJs(path)}','${gaJs(slug)}','This persona drives the edit pipeline. Change the text and the next turn behaves differently.')">Edit</button>
        <button class="ga-btn" title="Open in the code editor" onclick="gaOpenInMonaco('${gaJs(path)}')">Open</button>
        ${builtin || agent ? '' : `<button class="ga-btn danger" onclick="gaDeleteSkill('${gaJs(slug)}')">Delete</button>`}
      </div>
    </div>`;
  }).join('');
  return `
    <div class="ga-section">
      <div class="ga-section-head">
        <span class="ga-section-title">Skills</span>
        <span class="ga-section-sub">The personas in <code>.gitagent/skills</code>. The built-in ones are files, not hidden prompts — edit one and the pipeline changes.</span>
      </div>
      <div class="ga-row-actions"><button class="ga-btn dev" onclick="gaNewSkill()">+ New skill</button></div>
      ${rows || '<div class="ga-empty">No skills yet. Create one to teach the agent a new behavior.</div>'}
    </div>`;
}

function gaDraftHTML() {
  const d = GitAgent.draft;
  return `
    <div class="ga-section">
      <div class="ga-section-head">
        <span class="ga-section-title">New skill</span>
        <span class="ga-section-sub">Writes <code>.gitagent/skills/&lt;name&gt;/SKILL.md</code>. It joins the pipeline immediately.</span>
      </div>
      <label class="ga-field">
        <span>Name</span>
        <input id="ga-draft-name" class="ga-input" placeholder="accessibility-checker" spellcheck="false" value="${escapeAttr(d.name)}" />
      </label>
      <label class="ga-field">
        <span>Description</span>
        <input id="ga-draft-description" class="ga-input" placeholder="One line: when does this skill apply?" value="${escapeAttr(d.description)}" />
      </label>
      <label class="ga-field">
        <span>Instructions</span>
        <textarea id="ga-draft-body" class="ga-textarea" rows="10"
          placeholder="How should the agent behave when this skill applies? Be concrete — this text goes into the prompt verbatim.">${escapeHtml(d.body)}</textarea>
      </label>
      <div class="ga-row-actions">
        <button class="ga-btn dev" onclick="gaCreateSkill()">Create skill</button>
        <button class="ga-btn" onclick="gaCancelDraft()">Cancel</button>
      </div>
    </div>`;
}

function gaNewSkill() {
  GitAgent.draft = { name: '', description: '', body: '' };
  GitAgent.tab = 'skills';
  gaRender();
  const el = document.getElementById('ga-draft-name');
  if (el) el.focus();
}

function gaCancelDraft() { GitAgent.draft = null; gaRender(); }

async function gaCreateSkill() {
  const d = GitAgent.draft;
  if (!d || !d.name.trim()) { showToast('A skill needs a name', 'error'); return; }
  try {
    const res = await fetch('/agent/skill', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, ...d }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not create the skill', 'error'); return; }
    if (GitAgent.status) GitAgent.status.skills = data.skills || GitAgent.status.skills;
    GitAgent.draft = null;
    gaRender();
    if (typeof loadFileTree === 'function') loadFileTree();
    showToast(`Created skill "${data.slug}"`, 'success');
  } catch {
    showToast('Could not create the skill', 'error');
  }
}

async function gaDeleteSkill(slug) {
  if (!confirm(`Delete the skill "${slug}"? Its SKILL.md is removed from the repo.`)) return;
  try {
    const res = await fetch('/agent/skill', {
      method: 'DELETE', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, slug }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not delete the skill', 'error'); return; }
    if (GitAgent.status) GitAgent.status.skills = data.skills || GitAgent.status.skills;
    gaRender();
    if (typeof loadFileTree === 'function') loadFileTree();
    showToast(`Deleted "${slug}"`, 'success');
  } catch {
    showToast('Could not delete the skill', 'error');
  }
}

// ── File editor (identity, rules, memory, guardrails, manifest, skills) ──────

async function gaOpenEditor(path, label, hint) {
  GitAgent.editor = { path, label, hint, content: '', original: '', loading: true };
  gaRender();
  try {
    const res = await fetch(`/agent/gitagent/file?container=${encodeURIComponent(IDE.container)}&path=${encodeURIComponent(path)}`);
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Could not open the file', 'error'); GitAgent.editor = null; gaRender(); return; }
    GitAgent.editor = { path, label, hint, content: data.content, original: data.content, loading: false, exists: data.exists };
  } catch {
    showToast('Could not open the file', 'error');
    GitAgent.editor = null;
  }
  gaRender();
}

function gaEditorHTML() {
  const e = GitAgent.editor;
  if (e.loading) return '<div class="ga-empty">Loading…</div>';
  return `
    <div class="ga-editor">
      <div class="ga-editor-head">
        <button class="ga-back" onclick="gaCloseEditor()" title="Back">&larr;</button>
        <div class="ga-editor-title">
          <span>${escapeHtml(e.label)}${e.exists ? '' : ' <span class="ga-badge missing">new</span>'}</span>
          <code>${escapeHtml(e.path)}</code>
        </div>
      </div>
      ${e.hint ? `<div class="ga-editor-hint">${escapeHtml(e.hint)}</div>` : ''}
      <textarea id="ga-file-text" class="ga-textarea grow" spellcheck="false">${escapeHtml(e.content)}</textarea>
      <div class="ga-row-actions">
        <button class="ga-btn dev" onclick="gaSaveEditor()">Save</button>
        <button class="ga-btn" onclick="gaRevertEditor()">Revert</button>
        <button class="ga-btn" title="Open in the code editor" onclick="gaOpenInMonaco('${gaJs(e.path)}')">Open in editor</button>
      </div>
    </div>`;
}

// Bind the textarea without re-rendering per keystroke, so focus and caret hold.
function gaFocusEditor() {
  const ta = document.getElementById('ga-file-text');
  if (!ta) return;
  ta.oninput = () => { GitAgent.editor.content = ta.value; };
  ta.onkeydown = (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && ev.key === 's') { ev.preventDefault(); gaSaveEditor(); }
  };
}

function gaCloseEditor() {
  const e = GitAgent.editor;
  if (e && !e.loading && e.content !== e.original &&
      !confirm('Discard unsaved changes to ' + e.path + '?')) return;
  GitAgent.editor = null;
  gaRender();
}

function gaRevertEditor() {
  if (!GitAgent.editor) return;
  GitAgent.editor.content = GitAgent.editor.original;
  gaRender();
}

async function gaSaveEditor() {
  const e = GitAgent.editor;
  if (!e || GitAgent.busy) return;
  GitAgent.busy = true;
  try {
    const res = await fetch('/agent/gitagent/file', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, path: e.path, content: e.content }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Save failed', 'error'); return; }
    e.original = e.content;
    e.exists = true;
    showToast(`Saved ${e.path.split('/').pop()} — the next turn uses it`, 'success');
    gaLoadStatus();
    if (typeof loadFileTree === 'function') loadFileTree();
  } catch {
    showToast('Save failed', 'error');
  } finally {
    GitAgent.busy = false;
  }
}

// Hand a spec file to the main code editor, for anyone who would rather work in
// Monaco (diffs, search, the file tree) than in the panel.
function gaOpenInMonaco(path) {
  if (typeof openFile === 'function') openFile(path, path.split('/').pop());
}

// ── Registry tab ─────────────────────────────────────────────────────────────

function gaRegistryTabHTML() {
  return `
    <div class="ga-section">
      <div class="ga-section-head">
        <span class="ga-section-title">Registry
          <a href="https://registry.gitagent.sh" target="_blank" rel="noopener" class="ga-sub">registry.gitagent.sh</a>
        </span>
        <span class="ga-section-sub">Community agents. Pull one and it goes to work — a code agent takes the Developer slot, a compliance or security agent becomes a Guardrail that can block an edit. Its rules and its stage are written into <code>.gitagent/</code>, so you can read and edit exactly what it does here.</span>
      </div>
      <input id="ga-search" class="ga-input" placeholder="Search the registry (name, tag, category)…" spellcheck="false" />
      <div class="ga-manual">
        <input id="ga-ref" class="ga-input mono" placeholder="author/agent-name" spellcheck="false" />
        <button class="ga-btn" onclick="gaPullManual()">Pull</button>
        <button class="ga-btn dev" onclick="gaPullManual('developer')">Dev</button>
        <button class="ga-btn guard" onclick="gaPullManual('guardrails')">Guard</button>
      </div>
      <div class="ga-list" id="ga-list">${gaListHTML()}</div>
    </div>`;
}

function gaListHTML() {
  if (!GitAgent.registry.length) {
    return '<div class="ga-empty">Registry unavailable. Add an agent by reference above (author/agent-name).</div>';
  }
  const f = GitAgent.filter;
  const rows = GitAgent.registry.filter((a) => {
    if (!f) return true;
    return (a.ref + ' ' + a.description + ' ' + a.category + ' ' + (a.tags || []).join(' ')).toLowerCase().includes(f);
  });
  if (!rows.length) return '<div class="ga-empty">No agents match.</div>';
  return rows.map((a) => {
    const primary = gaSlotFor(a);
    const open = GitAgent.detail === a.ref;
    // Pull is one click: the tag says which slot the agent lands in, and the
    // title says why. The explicit slot buttons stay as an override.
    return `<div class="ga-card${open ? ' open' : ''}">
      <div class="ga-card-main">
        <div class="ga-card-top">
          <span class="ga-card-name">${escapeHtml(a.ref)}</span>
          <span class="ga-tag ${primary}" title="${escapeAttr(a.slotReason || a.category)}">→ ${gaSlotLabel(primary)}</span>
        </div>
        <div class="ga-card-desc">${escapeHtml(a.description || '')}</div>
      </div>
      <div class="ga-card-actions">
        <button class="ga-btn" onclick="gaToggleDetail('${gaJs(a.ref)}')">${open ? 'Hide' : 'Preview'}</button>
        <button class="ga-btn ${primary === 'guardrails' ? 'guard' : 'dev'}" onclick="gaPull('${gaJs(a.ref)}')"
                title="Clone it and put it in the ${gaSlotLabel(primary)} slot">Pull</button>
        <button class="ga-btn" onclick="gaPull('${gaJs(a.ref)}','${primary === 'guardrails' ? 'developer' : 'guardrails'}')"
                title="Use it as a ${gaSlotLabel(primary === 'guardrails' ? 'developer' : 'guardrails')} instead">as ${gaSlotLabel(primary === 'guardrails' ? 'developer' : 'guardrails')}</button>
      </div>
      ${open ? gaDetailHTML(a.ref) : ''}
    </div>`;
  }).join('');
}

// The preview reads the agent's SOUL/RULES/README straight from its GitHub repo,
// so you can see what it will inject before installing anything.
function gaDetailHTML(ref) {
  const d = GitAgent.details[ref];
  if (!d) return '<div class="ga-detail"><div class="ga-empty">Loading the agent…</div></div>';
  const files = Object.entries(d.files || {});
  // The repository URL is remote data, so the scheme is allowlisted before it
  // reaches an href; the visible label is still the raw value, escaped.
  const repo = safeUrl(d.repository);
  return `<div class="ga-detail">
    <div class="ga-detail-meta">
      ${repo
        ? `<a href="${escapeAttr(repo)}" target="_blank" rel="noopener noreferrer">${escapeHtml(repo)}</a>`
        : (d.repository ? `<span class="ga-sub">${escapeHtml(d.repository)}</span>` : '')}
      ${(d.adapters || []).map((x) => `<span class="ga-badge">${escapeHtml(x)}</span>`).join('')}
    </div>
    ${files.length
      ? files.map(([name, text]) => `<details class="ga-detail-file"><summary>${escapeHtml(name)}</summary><pre>${escapeHtml(text)}</pre></details>`).join('')
      : '<div class="ga-empty">This agent publishes no SOUL/RULES/README we could read.</div>'}
    <div class="ga-row-actions">
      ${d.slot ? `<span class="ga-sub">Pulling this adds it to <b>${gaSlotLabel(d.slot)}</b> — ${escapeHtml(d.slotReason || '')}</span>` : ''}
      <button class="ga-btn" onclick="gaPull('${gaJs(ref)}','none')">Clone only</button>
    </div>
  </div>`;
}

async function gaToggleDetail(ref) {
  if (GitAgent.detail === ref) { GitAgent.detail = null; gaRender(); return; }
  GitAgent.detail = ref;
  gaRender();
  if (GitAgent.details[ref]) return;
  try {
    const res = await fetch(`/agent/registry/agent?ref=${encodeURIComponent(ref)}`);
    const data = await res.json();
    GitAgent.details[ref] = res.ok ? data : { files: {} };
  } catch {
    GitAgent.details[ref] = { files: {} };
  }
  if (GitAgent.detail === ref) gaRender();
}

// Pull an agent: clone it and put it straight to work. The backend picks the
// slot from the registry's own metadata, so one click is the whole flow. Pass
// a slot to override it, or 'none' to clone without assigning (read it first).
async function gaPull(ref, slot) {
  if (GitAgent.busy) return;
  GitAgent.busy = true;
  gaSetSteps([`GitAgent: pulling ${ref}…`]);
  try {
    const res = await fetch('/agent/gitagent/install', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, ref, slot }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Pull failed', 'error'); gaSetSteps([]); return; }
    GitAgent.status = data.status;
    const where = data.slot
      ? `${gaSlotLabel(data.slot)}${data.slotReason ? ` · ${data.slotReason}` : ''}`
      : 'cloned, no slot';
    const steps = [`GitAgent: cloned ${ref}`, `GitAgent: ${ref} → ${where}`];
    // The pull writes the agent's rules and stage into .gitagent/ — say which
    // files, so the folder change is visible instead of something to go hunt for.
    for (const f of data.files || []) {
      steps.push(`GitAgent: ${f.action === 'pruned' ? 'removed' : 'wrote'} ${f.path}`);
    }
    gaSetSteps(steps);
    gaRender();
    // Reload the explorer, then flash the rules file the pull just wrote so the
    // change to .gitagent/ is something you see, not something you go looking for.
    if (typeof loadFileTree === 'function') await loadFileTree();
    const wrote = (data.files || []).find((f) => f.action === 'updated');
    if (wrote && typeof revealInTree === 'function') revealInTree(wrote.path);
    showToast(data.slot ? `${ref} → ${gaSlotLabel(data.slot)}` : `Cloned ${ref}`, 'success');
  } catch {
    showToast('Pull failed', 'error');
    gaSetSteps([]);
  } finally {
    GitAgent.busy = false;
  }
}

// ── Slot assignment ──────────────────────────────────────────────────────────

function gaCurrent() {
  const st = GitAgent.status || { developer: null, guardrails: [] };
  return {
    developer: st.developer ? st.developer.ref : null,
    guardrails: (st.guardrails || []).map((g) => g.ref),
  };
}

// A ref typed by hand goes through the same pull path, so an agent that isn't in
// the index yet is still classified (from its synthetic entry) and slotted.
function gaPullManual(slot) {
  const input = document.getElementById('ga-ref');
  const ref = (input.value || '').trim();
  if (!/^[^/\s]+\/[^/\s]+$/.test(ref)) { showToast('Use author/agent-name', 'error'); return; }
  input.value = '';
  gaPull(ref, slot);
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
  gaSetSteps(['GitAgent: installing…']);
  try {
    const res = await fetch('/agent/gitagent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, developer, guardrails }),
    });
    const data = await res.json();
    if (!res.ok) { showToast(data.error || 'Update failed', 'error'); gaSetSteps([]); return; }
    GitAgent.status = data.status;
    gaSetSteps(data.steps);
    gaRender();
    showToast('GitAgent pipeline updated', 'success');
  } catch (e) {
    showToast('Update failed', 'error');
    gaSetSteps([]);
  } finally {
    GitAgent.busy = false;
  }
}

// The install log lives outside the tab body so it survives a tab switch.
function gaSetSteps(steps) {
  GitAgent.steps = steps || [];
  gaRenderSteps();
}

function gaRenderSteps() {
  const el = document.getElementById('ga-steps');
  if (!el) return;
  const steps = GitAgent.steps;
  if (!steps.length) { el.innerHTML = ''; return; }
  el.innerHTML = '<div class="ga-steps-title">Install log</div>' +
    steps.map((s) => `<div class="ga-step">${escapeHtml(s)}</div>`).join('');
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
