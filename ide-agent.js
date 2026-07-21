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
    sock.send(JSON.stringify({ type: 'chat', container: IDE.container, message: msg, provider }));
  } catch (e) {
    // Streaming transport unavailable — fall back to the single-shot REST path.
    await sendAgentViaRest(msg, provider, messages);
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
    // Reload the live preview if it's showing.
    const preview = document.getElementById('ide-preview-panel');
    if (preview && preview.style.display !== 'none') {
      refreshPreview();
    }
  }
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

async function sendAgentViaRest(msg, provider, messages) {
  try {
    const currentFile = IDE.activeTab ? {
      path: IDE.activeTab.path,
      content: IDE.activeTab.model.getValue(),
    } : null;

    const res = await fetch('/agent/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg, provider, container: IDE.container, current_file: currentFile }),
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

// Agent input Enter key
document.addEventListener('DOMContentLoaded', () => {
  const agentInput = document.getElementById('agent-input');
  if (agentInput) {
    agentInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') sendAgentMessage();
    });
  }
});
