const IDE = {
  container: null, repoUrl: '', previewUrl: '', port: null, tabs: [], activeTab: null,
  editor: null, models: {}, logsInterval: null, statusInterval: null,
  panelTab: 'terminal',
  // Multi-terminal support
  terminals: [],
  activeTerminalId: null,
  terminalCounter: 0,
  darkMode: false,
};

function initIDE(containerId, repoUrl, port) {
  IDE.container = containerId;
  IDE.repoUrl = repoUrl;
  IDE.port = port;
  document.body.classList.add('ide-mode');
  document.getElementById('landing-page').style.display = 'none';
  document.getElementById('ide-page').style.display = 'flex';
  document.querySelector('.repo-name').textContent = repoUrl.replace(/https?:\/\/github\.com\//, '');
  loadFileTree();
  initMonaco();
  initTerminal();
  startLogsPolling();
  startStatusPolling();
  // Restore dark mode preference
  if (localStorage.getItem('jr-dark-mode') === 'true') {
    setDarkMode(true);
  }
}

// ── File Tree ──
async function loadFileTree() {
  try {
    const res = await fetch(`/files?container=${IDE.container}`);
    const tree = await res.json();
    renderTree(tree, document.getElementById('file-tree'), 0);
  } catch (e) { console.error('Failed to load file tree', e); }
}

function renderTree(nodes, parent, depth) {
  parent.innerHTML = '';
  // Sort: dirs first, then files alphabetically
  nodes.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  nodes.forEach(node => {
    if (node.isDir) {
      const dir = document.createElement('div');
      dir.className = 'tree-dir';
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.style.setProperty('--depth', depth);
      item.innerHTML = `<span class="icon">\u25B8</span><span class="name">${esc(node.name)}</span>
        <span class="tree-actions">
          <button onclick="event.stopPropagation(); deleteFileOrFolder('${esc(node.path)}', true)" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
        </span>`;
      item.onclick = (e) => {
        if (e.target.closest('.tree-actions')) return;
        e.stopPropagation();
        dir.classList.toggle('open');
        item.querySelector('.icon').textContent = dir.classList.contains('open') ? '\u25BE' : '\u25B8';
      };
      const children = document.createElement('div');
      children.className = 'tree-children';
      renderTree(node.children || [], children, depth + 1);
      dir.appendChild(item);
      dir.appendChild(children);
      parent.appendChild(dir);
    } else {
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.style.setProperty('--depth', depth);
      item.innerHTML = `<span class="icon">${fileIcon(node.name)}</span><span class="name">${esc(node.name)}</span>
        <span class="tree-actions">
          <button onclick="event.stopPropagation(); deleteFileOrFolder('${esc(node.path)}', false)" title="Delete"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg></button>
        </span>`;
      item.onclick = (e) => {
        if (e.target.closest('.tree-actions')) return;
        openFile(node.path, node.name);
      };
      parent.appendChild(item);
    }
  });
}

function fileIcon(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    js: 'JS', ts: 'TS', jsx: 'JX', tsx: 'TX', py: 'PY', go: 'GO', rs: 'RS', java: 'JV',
    html: 'HT', css: 'CS', json: '{}', md: 'MD', yml: 'YM', yaml: 'YM', toml: 'TM',
    svg: 'SV', png: 'IM', jpg: 'IM', gif: 'IM', sh: 'SH', dockerfile: 'DK',
  };
  return map[ext] || 'F';
}
function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

// ── File Create / Delete ──
async function promptCreateFile() {
  const name = prompt('Enter file path (e.g. src/utils.js):');
  if (!name) return;
  try {
    const res = await fetch('/file/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, path: name, isDir: false })
    });
    if (res.ok) {
      showToast('Created ' + name, 'success');
      loadFileTree();
      openFile(name, name.split('/').pop());
    } else {
      const e = await res.json(); showToast(e.error || 'Create failed', 'error');
    }
  } catch (e) { showToast('Create error', 'error'); }
}

async function promptCreateFolder() {
  const name = prompt('Enter folder path (e.g. src/components):');
  if (!name) return;
  try {
    const res = await fetch('/file/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, path: name, isDir: true })
    });
    if (res.ok) {
      showToast('Created folder ' + name, 'success');
      loadFileTree();
    } else {
      const e = await res.json(); showToast(e.error || 'Create failed', 'error');
    }
  } catch (e) { showToast('Create error', 'error'); }
}

async function deleteFileOrFolder(path, isDir) {
  const label = isDir ? 'folder' : 'file';
  if (!confirm(`Delete ${label} "${path}"?`)) return;
  try {
    const res = await fetch('/file/delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, path: path })
    });
    if (res.ok) {
      showToast('Deleted ' + path, 'success');
      // Close tab if open
      const existing = IDE.tabs.find(t => t.path === path);
      if (existing) closeTab(path);
      loadFileTree();
    } else {
      const e = await res.json(); showToast(e.error || 'Delete failed', 'error');
    }
  } catch (e) { showToast('Delete error', 'error'); }
}

// ── Monaco ──
function getTerminalTheme() {
  if (IDE.darkMode) {
    return {
      background: '#1a1410',
      foreground: '#D7CCC8',
      cursor: '#A67C52',
      cursorAccent: '#1a1410',
      selectionBackground: '#3E2C1E80',
      black: '#1a1410',
      red: '#CF6679',
      green: '#81C784',
      yellow: '#FFD54F',
      blue: '#64B5F6',
      magenta: '#CE93D8',
      cyan: '#4DD0E1',
      white: '#D7CCC8',
      brightBlack: '#5D4037',
      brightRed: '#EF5350',
      brightGreen: '#A5D6A7',
      brightYellow: '#FFE082',
      brightBlue: '#90CAF9',
      brightMagenta: '#E1BEE7',
      brightCyan: '#80DEEA',
      brightWhite: '#EFEBE9',
    };
  } else {
    return {
      background: '#FAF8F5',
      foreground: '#2C1810',
      cursor: '#6B3E1A',
      cursorAccent: '#FAF8F5',
      selectionBackground: '#DEDAD180',
      black: '#2C1810',
      red: '#A4161A',
      green: '#2D6A4F',
      yellow: '#B07D05',
      blue: '#1565C0',
      magenta: '#7B1FA2',
      cyan: '#00838F',
      white: '#F5F2EE',
      brightBlack: '#5D4037',
      brightRed: '#C62828',
      brightGreen: '#388E3C',
      brightYellow: '#F9A825',
      brightBlue: '#1E88E5',
      brightMagenta: '#8E24AA',
      brightCyan: '#00ACC1',
      brightWhite: '#FFFFFF',
    };
  }
}

function initMonaco() {
  require.config({ paths: { vs: 'https://cdnjs.cloudflare.com/ajax/libs/monaco-editor/0.45.0/min/vs' } });
  require(['vs/editor/editor.main'], () => {
    monaco.editor.defineTheme('jr-architect-light', {
      base: 'vs', inherit: true,
      rules: [],
      colors: {
        'editor.background': '#FFFFFF',
        'editor.foreground': '#2C1810',
        'editorLineNumber.foreground': '#8D6E63',
        'editorCursor.foreground': '#6B3E1A',
        'editor.selectionBackground': '#DEDAD180',
        'editor.lineHighlightBackground': '#F5F2EE',
      }
    });
    monaco.editor.defineTheme('jr-architect-dark', {
      base: 'vs-dark', inherit: true,
      rules: [],
      colors: {
        'editor.background': '#1a1410',
        'editor.foreground': '#D7CCC8',
        'editorLineNumber.foreground': '#8D6E63',
        'editorCursor.foreground': '#A67C52',
        'editor.selectionBackground': '#3E2C1E80',
        'editor.lineHighlightBackground': '#231C16',
      }
    });
    IDE.editor = monaco.editor.create(document.getElementById('monaco-container'), {
      theme: IDE.darkMode ? 'jr-architect-dark' : 'jr-architect-light',
      fontSize: 14, fontFamily: "'JetBrains Mono', Consolas, monospace",
      minimap: { enabled: true }, scrollBeyondLastLine: false, automaticLayout: true,
      padding: { top: 8 }, smoothScrolling: true, cursorBlinking: 'smooth',
      renderWhitespace: 'selection',
    });
    // Ctrl+S / Cmd+S to save
    IDE.editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, saveCurrentFile);
  });
}

function getLang(name) {
  const ext = name.split('.').pop().toLowerCase();
  const map = {
    js: 'javascript', ts: 'typescript', jsx: 'javascript', tsx: 'typescript', py: 'python',
    go: 'go', rs: 'rust', java: 'java', html: 'html', css: 'css', json: 'json', md: 'markdown',
    yml: 'yaml', yaml: 'yaml', toml: 'toml', sh: 'shell', bat: 'bat', xml: 'xml', sql: 'sql',
    rb: 'ruby', php: 'php', c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', cs: 'csharp',
  };
  return map[ext] || 'plaintext';
}

// ── Tabs ──
async function openFile(path, name) {
  // Check if already open
  let existing = IDE.tabs.find(t => t.path === path);
  if (existing) { activateTab(existing); return; }

  try {
    const res = await fetch(`/file?container=${IDE.container}&path=${encodeURIComponent(path)}`);
    if (!res.ok) { const e = await res.json(); showToast(e.error || 'Error', 'error'); return; }
    const content = await res.text();
    const lang = getLang(name);
    const model = monaco.editor.createModel(content, lang);
    const tab = { path, name, model, original: content };
    model.onDidChangeContent(() => { tab.modified = model.getValue() !== tab.original; renderTabs(); });
    IDE.tabs.push(tab);
    IDE.models[path] = model;
    activateTab(tab);
  } catch (e) { showToast('Failed to load file', 'error'); }
}

function activateTab(tab) {
  IDE.activeTab = tab;
  IDE.editor.setModel(tab.model);
  renderTabs();
  // highlight in tree
  document.querySelectorAll('.tree-item.active').forEach(el => el.classList.remove('active'));
}

function closeTab(path, e) {
  if (e) e.stopPropagation();
  const idx = IDE.tabs.findIndex(t => t.path === path);
  if (idx === -1) return;
  const tab = IDE.tabs[idx];
  tab.model.dispose();
  delete IDE.models[path];
  IDE.tabs.splice(idx, 1);
  if (IDE.activeTab === tab) {
    IDE.activeTab = IDE.tabs[Math.min(idx, IDE.tabs.length - 1)] || null;
    IDE.editor.setModel(IDE.activeTab ? IDE.activeTab.model : null);
  }
  renderTabs();
  if (!IDE.activeTab) showWelcome();
}

function renderTabs() {
  const el = document.getElementById('editor-tabs');
  el.innerHTML = '';
  IDE.tabs.forEach(tab => {
    const d = document.createElement('div');
    d.className = 'editor-tab' + (tab === IDE.activeTab ? ' active' : '');
    d.innerHTML = `${esc(tab.name)}${tab.modified ? '<span class="tab-modified">\u25CF</span>' : ''}<span class="tab-close" onclick="closeTab('${tab.path}', event)">\u00D7</span>`;
    d.onclick = () => activateTab(tab);
    el.appendChild(d);
  });
  document.getElementById('editor-welcome').style.display = IDE.activeTab ? 'none' : 'flex';
  document.getElementById('monaco-container').style.display = IDE.activeTab ? 'block' : 'none';
}

function showWelcome() {
  document.getElementById('editor-welcome').style.display = 'flex';
  document.getElementById('monaco-container').style.display = 'none';
}

// ── Save ──
async function saveCurrentFile() {
  if (!IDE.activeTab) return;
  const tab = IDE.activeTab;
  const content = tab.model.getValue();
  try {
    const res = await fetch('/file/save', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, path: tab.path, content })
    });
    if (res.ok) {
      tab.original = content; tab.modified = false; renderTabs();
      showToast('Saved ' + tab.name, 'success');
    } else {
      const e = await res.json(); showToast(e.error || 'Save failed', 'error');
    }
  } catch (e) { showToast('Save error', 'error'); }
}

// ── Multi-Terminal Support ──
function initTerminal() {
  // Clean up any existing terminals
  IDE.terminals.forEach(t => {
    if (t.term) t.term.dispose();
    if (t.socket) t.socket.close();
  });
  IDE.terminals = [];
  IDE.activeTerminalId = null;
  IDE.terminalCounter = 0;

  // Create default terminal
  createTerminal();
}

function createTerminal() {
  IDE.terminalCounter++;
  const id = IDE.terminalCounter;
  const termTheme = getTerminalTheme();

  // Create container div for this terminal
  const termContainer = document.createElement('div');
  termContainer.id = `terminal-instance-${id}`;
  termContainer.className = 'terminal-instance';
  termContainer.style.display = 'none';
  document.getElementById('terminal-instances').appendChild(termContainer);

  const term = new Terminal({
    cursorBlink: true,
    fontSize: 14,
    fontFamily: "'JetBrains Mono', monospace",
    theme: termTheme,
    allowProposedApi: true
  });

  const termFit = new FitAddon.FitAddon();
  term.loadAddon(termFit);
  term.open(termContainer);

  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const socket = new WebSocket(`${protocol}//${window.location.host}/terminal/ws?container=${IDE.container}`);

  socket.onmessage = (event) => {
    const reader = new FileReader();
    reader.onload = () => {
      term.write(new Uint8Array(reader.result));
    };
    reader.readAsArrayBuffer(event.data);
  };

  term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(data);
    }
  });

  const terminalObj = { id, term, termFit, socket, name: `Terminal ${id}` };
  IDE.terminals.push(terminalObj);

  switchTerminal(id);
  renderTerminalTabs();

  // Ensure fit happens after rendering
  setTimeout(() => {
    termFit.fit();
    term.focus();
  }, 100);

  return terminalObj;
}

function switchTerminal(id) {
  IDE.activeTerminalId = id;
  IDE.terminals.forEach(t => {
    const el = document.getElementById(`terminal-instance-${t.id}`);
    if (el) el.style.display = t.id === id ? 'block' : 'none';
  });
  renderTerminalTabs();

  // Fit the active terminal
  const active = IDE.terminals.find(t => t.id === id);
  if (active && active.termFit) {
    setTimeout(() => {
      active.termFit.fit();
      active.term.focus();
    }, 50);
  }
}

function closeTerminal(id, e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  // Don't close if it's the only terminal
  if (IDE.terminals.length <= 1) return;

  const idx = IDE.terminals.findIndex(t => t.id === id);
  if (idx === -1) return;

  const termObj = IDE.terminals[idx];
  termObj.term.dispose();
  if (termObj.socket) termObj.socket.close();

  const el = document.getElementById(`terminal-instance-${id}`);
  if (el) el.remove();

  IDE.terminals.splice(idx, 1);

  if (IDE.activeTerminalId === id) {
    const next = IDE.terminals[Math.min(idx, IDE.terminals.length - 1)];
    if (next) switchTerminal(next.id);
  }
  renderTerminalTabs();
}

function renderTerminalTabs() {
  const tabBar = document.getElementById('terminal-tab-bar');
  if (!tabBar) return;

  // Clear existing tabs (but not the + button)
  const addBtn = tabBar.querySelector('.terminal-add-btn');
  tabBar.innerHTML = '';

  IDE.terminals.forEach(t => {
    const tab = document.createElement('div');
    tab.className = 'terminal-tab' + (t.id === IDE.activeTerminalId ? ' active' : '');
    tab.innerHTML = `<span class="terminal-tab-name">${esc(t.name)}</span>${IDE.terminals.length > 1 ? '<span class="terminal-tab-close" onclick="closeTerminal(' + t.id + ', event)">\u00D7</span>' : ''}`;
    tab.onclick = () => switchTerminal(t.id);
    tabBar.appendChild(tab);
  });

  // Re-add the + button
  const newAddBtn = document.createElement('button');
  newAddBtn.className = 'terminal-add-btn';
  newAddBtn.innerHTML = '+';
  newAddBtn.title = 'New Terminal';
  newAddBtn.onclick = () => createTerminal();
  tabBar.appendChild(newAddBtn);
}

// ── Logs ──
function startLogsPolling() {
  fetchLogs();
  IDE.logsInterval = setInterval(fetchLogs, 3000);
}
async function fetchLogs() {
  try {
    const res = await fetch(`/logs/${IDE.container}`);
    const text = await res.text();
    document.getElementById('logs-output').textContent = text;
    const el = document.getElementById('logs-output');
    el.scrollTop = el.scrollHeight;
  } catch (e) { }
}

// ── Status Polling ──
function startStatusPolling() {
  fetchStatus();
  IDE.statusInterval = setInterval(fetchStatus, 5000);
}
async function fetchStatus() {
  try {
    const res = await fetch(`/sandbox/status?container=${IDE.container}`);
    const data = await res.json();
    IDE.previewUrl = data.url;

    // Update status indicator
    const dot = document.querySelector('.ide-status-dot');
    const text = document.querySelector('.ide-status-text');
    if (data.status === 'running') {
      dot.style.background = 'var(--green)';
      text.textContent = 'Running';
      text.style.color = 'var(--green)';
    } else if (data.status === 'starting') {
      dot.style.background = 'var(--yellow)';
      text.textContent = 'Starting...';
      text.style.color = 'var(--yellow)';
    } else {
      dot.style.background = 'var(--red)';
      text.textContent = data.status || 'Unknown';
      text.style.color = 'var(--red)';
    }

    // Update status panel
    const panel = document.getElementById('status-panel-content');
    panel.innerHTML = `
      <div class="status-row"><span class="status-label">Container:</span><span class="status-value">${data.container}</span></div>
      <div class="status-row"><span class="status-label">Status:</span><span class="status-value ${data.status === 'running' ? 'running' : (data.status === 'starting' ? 'starting' : 'stopped')}">${data.status}</span></div>
      <div class="status-row"><span class="status-label">Port:</span><span class="status-value">${data.port}</span></div>
      <div class="status-row"><span class="status-label">Preview:</span><span class="status-value"><a href="${data.url}" target="_blank" style="color:var(--accent)">${data.url}</a></span></div>
      <div class="status-row"><span class="status-label">Repository:</span><span class="status-value">${data.repo}</span></div>
    `;
  } catch (e) { }
}

// ── Live Preview ──
function openLivePreview() {
  const panel = document.getElementById('ide-preview-panel');
  const iframe = document.getElementById('preview-iframe');
  const url = IDE.previewUrl || `http://127.0.0.1:${IDE.port}`;
  panel.style.display = 'flex';
  iframe.src = url;
}

function closePreview() {
  document.getElementById('ide-preview-panel').style.display = 'none';
  document.getElementById('preview-iframe').src = '';
}

function refreshPreview() {
  const iframe = document.getElementById('preview-iframe');
  iframe.src = iframe.src;
}

function openPreviewExternal() {
  const url = IDE.previewUrl || `http://127.0.0.1:${IDE.port}`;
  window.open(url, '_blank');
}

// ── Panel Tabs ──
function switchPanelTab(name) {
  IDE.panelTab = name;
  document.querySelectorAll('.panel-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === name));
  document.querySelectorAll('.panel-pane, .terminal-pane').forEach(p => p.classList.toggle('active', p.dataset.tab === name));
  // If switching to terminal, fit the active one
  if (name === 'terminal') {
    const active = IDE.terminals.find(t => t.id === IDE.activeTerminalId);
    if (active && active.termFit) {
      setTimeout(() => { active.termFit.fit(); active.term.focus(); }, 50);
    }
  }
}

// ── Dark Mode ──
function toggleDarkMode() {
  setDarkMode(!IDE.darkMode);
}

function setDarkMode(enabled) {
  IDE.darkMode = enabled;
  document.body.classList.toggle('dark-mode', enabled);
  localStorage.setItem('jr-dark-mode', enabled);

  // Update dark mode button icon
  const btn = document.getElementById('dark-mode-btn');
  if (btn) {
    btn.innerHTML = enabled
      ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg> Light'
      : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg> Dark';
  }

  // Update Monaco theme
  if (IDE.editor && typeof monaco !== 'undefined') {
    monaco.editor.setTheme(enabled ? 'jr-architect-dark' : 'jr-architect-light');
  }

  // Update all terminal themes
  const termTheme = getTerminalTheme();
  IDE.terminals.forEach(t => {
    if (t.term) {
      t.term.options.theme = termTheme;
    }
  });
}

// ── Toast ──
function showToast(msg, type) {
  const el = document.getElementById('ide-toast');
  el.textContent = (type === 'success' ? '\u2713 ' : '\u2717 ') + msg;
  el.className = 'ide-toast show ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), 2500);
}

// ── Back to Landing ──
function backToLanding() {
  document.body.classList.remove('ide-mode');
  document.getElementById('landing-page').style.display = '';
  document.getElementById('ide-page').style.display = 'none';
  IDE.tabs.forEach(t => t.model.dispose());
  IDE.tabs = []; IDE.activeTab = null; IDE.models = {};
  if (IDE.logsInterval) clearInterval(IDE.logsInterval);
  if (IDE.statusInterval) clearInterval(IDE.statusInterval);
  // Clean up terminals
  IDE.terminals.forEach(t => {
    if (t.term) t.term.dispose();
    if (t.socket) t.socket.close();
  });
  IDE.terminals = [];
  IDE.activeTerminalId = null;
  closePreview();
}

// ── Panel Resize ──
function initPanelResize() {
  const handle = document.getElementById('panel-resize');
  const panel = document.querySelector('.ide-bottom-panel');
  let startY, startH;
  handle.addEventListener('mousedown', e => {
    startY = e.clientY; startH = panel.offsetHeight;
    const onMove = e2 => {
      const h = Math.max(80, Math.min(500, startH + (startY - e2.clientY)));
      panel.style.height = h + 'px';
    };
    const onUp = () => { document.removeEventListener('mousemove', onMove); document.removeEventListener('mouseup', onUp); };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Init ──
document.addEventListener('DOMContentLoaded', () => {
  initPanelResize();
  // Restore dark mode on landing page too
  if (localStorage.getItem('jr-dark-mode') === 'true') {
    setDarkMode(true);
  }
});

// Handle window resize for active terminal
window.addEventListener('resize', () => {
  const active = IDE.terminals.find(t => t.id === IDE.activeTerminalId);
  if (active && active.termFit) active.termFit.fit();
});
