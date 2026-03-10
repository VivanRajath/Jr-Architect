// ── IDE State ──
const IDE = {
  container: null, repoUrl: '', previewUrl: '', tabs: [], activeTab: null,
  editor: null, models: {}, logsInterval: null, statusInterval: null,
  panelTab: 'terminal',
};

function initIDE(containerId, repoUrl) {
  IDE.container = containerId;
  IDE.repoUrl = repoUrl;
  document.body.classList.add('ide-mode');
  document.getElementById('landing-page').style.display = 'none';
  document.getElementById('ide-page').style.display = 'flex';
  document.querySelector('.repo-name').textContent = repoUrl.replace(/https?:\/\/github\.com\//, '');
  loadFileTree();
  initMonaco();
  startLogsPolling();
  startStatusPolling();
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
      item.innerHTML = `<span class="icon">▸</span><span class="name">${esc(node.name)}</span>
        <span class="tree-actions">
          <button onclick="event.stopPropagation(); deleteFileOrFolder('${esc(node.path)}', true)" title="Delete">🗑</button>
        </span>`;
      item.onclick = (e) => {
        if (e.target.closest('.tree-actions')) return;
        e.stopPropagation();
        dir.classList.toggle('open');
        item.querySelector('.icon').textContent = dir.classList.contains('open') ? '▾' : '▸';
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
          <button onclick="event.stopPropagation(); deleteFileOrFolder('${esc(node.path)}', false)" title="Delete">🗑</button>
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
    js: '📜', ts: '📘', jsx: '⚛', tsx: '⚛', py: '🐍', go: '🔷', rs: '🦀', java: '☕',
    html: '🌐', css: '🎨', json: '📋', md: '📝', yml: '⚙', yaml: '⚙', toml: '⚙',
    svg: '🖼', png: '🖼', jpg: '🖼', gif: '🖼', sh: '🔧', dockerfile: '🐳',
  };
  return map[ext] || '📄';
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
    IDE.editor = monaco.editor.create(document.getElementById('monaco-container'), {
      theme: 'jr-architect-light', fontSize: 14, fontFamily: "'JetBrains Mono', Consolas, monospace",
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
    d.innerHTML = `${esc(tab.name)}${tab.modified ? '<span class="tab-modified">●</span>' : ''}<span class="tab-close" onclick="closeTab('${tab.path}', event)">×</span>`;
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

// ── Terminal ──
const termHistory = [];
let termHistIdx = -1;
async function execTerminal(cmd) {
  if (!cmd.trim()) return;
  termHistory.unshift(cmd); termHistIdx = -1;
  const out = document.getElementById('terminal-output');
  out.textContent += `$ ${cmd}\n`;
  try {
    const res = await fetch('/terminal/exec', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, command: cmd })
    });
    const text = await res.text();
    out.textContent += text + '\n';
  } catch (e) { out.textContent += 'Error: ' + e.message + '\n'; }
  out.scrollTop = out.scrollHeight;
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
}

// ── Toast ──
function showToast(msg, type) {
  const el = document.getElementById('ide-toast');
  el.textContent = (type === 'success' ? '✓ ' : '✗ ') + msg;
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

// ── Init terminal input ──
document.addEventListener('DOMContentLoaded', () => {
  const input = document.getElementById('terminal-input');
  if (input) {
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') { execTerminal(input.value); input.value = ''; }
      if (e.key === 'ArrowUp') { if (termHistory.length) { termHistIdx = Math.min(termHistIdx + 1, termHistory.length - 1); input.value = termHistory[termHistIdx]; } }
      if (e.key === 'ArrowDown') { termHistIdx = Math.max(termHistIdx - 1, -1); input.value = termHistIdx >= 0 ? termHistory[termHistIdx] : ''; }
    });
  }
  initPanelResize();
});
