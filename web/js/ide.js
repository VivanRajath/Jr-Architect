const IDE = {
  container: null, repoUrl: '', previewUrl: '', port: null, tabs: [], activeTab: null,
  editor: null, models: {}, logsInterval: null, statusInterval: null,
  panelTab: 'terminal',
  // Live-preview readiness state
  appReady: false, previewPending: false, previewAutoOpened: false, previewUserClosed: false,
  framework: '', uiEntry: null, saveRefreshTimer: null,
  // Multi-terminal support
  terminals: [],
  activeTerminalId: null,
  terminalCounter: 0,
  darkMode: false,
  // Build doctor (auto issue diagnosis)
  launchedAt: 0, doctorRan: false, doctorRunning: false,
};

function initIDE(containerId, repoUrl, port) {
  IDE.container = containerId;
  IDE.repoUrl = repoUrl;
  IDE.port = port;
  // Reset per-sandbox state
  IDE.appReady = false; IDE.previewPending = false; IDE.previewAutoOpened = false;
  IDE.previewUserClosed = false; IDE.framework = ''; IDE.uiEntry = null;
  IDE.launchedAt = Date.now(); IDE.doctorRan = false; IDE.doctorRunning = false;
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
// The workspace is populated asynchronously (clone/scaffold), so early calls can
// come back empty. Poll until files appear so the tree fills in on its own.
async function loadFileTree(attempt = 0) {
  try {
    const res = await fetch(`/files?container=${IDE.container}`);
    const tree = await res.json();
    if (!Array.isArray(tree)) throw new Error('file tree not ready');
    const treeEl = document.getElementById('file-tree');
    renderTree(tree, treeEl, 0);
    // Right-click on empty space in the explorer → root-level menu.
    treeEl.oncontextmenu = (e) => {
      if (e.target.closest('.tree-item')) return; // items handle their own menu
      e.preventDefault();
      showContextMenu(e.clientX, e.clientY, rootMenuItems());
    };
    if (tree.length === 0 && attempt < 40) {
      setTimeout(() => loadFileTree(attempt + 1), 1500);
    }
  } catch (e) {
    if (attempt < 40) {
      setTimeout(() => loadFileTree(attempt + 1), 1500);
    } else {
      console.error('Failed to load file tree', e);
    }
  }
}

function renderTree(nodes, parent, depth) {
  parent.innerHTML = '';
  if (!Array.isArray(nodes)) return;
  // Sort: dirs first, then files alphabetically
  nodes.sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name));
  nodes.forEach(node => {
    if (node.isDir) {
      const dir = document.createElement('div');
      dir.className = 'tree-dir';
      const item = document.createElement('div');
      item.className = 'tree-item';
      item.dataset.path = node.path;
      item.style.setProperty('--depth', depth);
      item.innerHTML = `<span class="icon folder-icon">\u25B8</span><span class="name">${esc(node.name)}</span>
        <span class="tree-actions">
          <button type="button" class="tree-delete" title="Delete">${TRASH_ICON}</button>
        </span>`;
      // Bound as a property, not an onclick attribute. Paths come from a cloned
      // repo, so a filename containing a quote must never be able to become code.
      bindTreeDelete(item, node.path, true);
      item.onclick = (e) => {
        if (e.target.closest('.tree-actions')) return;
        e.stopPropagation();
        dir.classList.toggle('open');
        item.querySelector('.icon').textContent = dir.classList.contains('open') ? '\u25BE' : '\u25B8';
      };
      item.oncontextmenu = (e) => {
        e.preventDefault(); e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, folderMenuItems(node.path, node.name));
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
      item.dataset.path = node.path;
      item.style.setProperty('--depth', depth);
      const fileExt = node.name.split('.').pop().toLowerCase();
      item.innerHTML = `<span class="icon" data-ext="${esc(fileExt)}">${fileIcon(node.name)}</span><span class="name">${esc(node.name)}</span>
        <span class="tree-actions">
          <button type="button" class="tree-delete" title="Delete">${TRASH_ICON}</button>
        </span>`;
      bindTreeDelete(item, node.path, false);
      item.onclick = (e) => {
        if (e.target.closest('.tree-actions')) return;
        openFile(node.path, node.name);
      };
      item.oncontextmenu = (e) => {
        e.preventDefault(); e.stopPropagation();
        showContextMenu(e.clientX, e.clientY, fileMenuItems(node.path, node.name));
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
const TRASH_ICON = '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>';

// Wire a tree row's delete button without routing the path through markup.
function bindTreeDelete(item, path, isDir) {
  const btn = item.querySelector('.tree-delete');
  if (!btn) return;
  btn.onclick = (e) => { e.stopPropagation(); deleteFileOrFolder(path, isDir); };
}

// Escape a value for HTML — including both quote characters, so it is safe in an
// attribute as well as in element text. The previous textContent/innerHTML trick
// escaped only `& < >`, because a text node never needs a quote escaped; that left
// every `data-ext="${esc(x)}"` open to a filename crafted to close the attribute.
// Repos are cloned from arbitrary URLs, so filenames are untrusted input.
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

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

// ── VS Code-style right-click context menu ──
const CTX_ICON = {
  open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>',
  newFile: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="12" x2="12" y2="18"/><line x1="9" y1="15" x2="15" y2="15"/></svg>',
  newFolder: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/><line x1="12" y1="11" x2="12" y2="17"/><line x1="9" y1="14" x2="15" y2="14"/></svg>',
  rename: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.12 2.12 0 0 1 3 3L12 15l-4 1 1-4z"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/><path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
  refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
  ai: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3l1.9 4.6L18.5 9l-4.6 1.9L12 15l-1.9-4.1L5.5 9l4.6-1.4z"/><path d="M19 15l.7 1.8L21.5 17l-1.8.7L19 19.5l-.7-1.8L16.5 17l1.8-.5z"/></svg>',
};

let _ctxMenuEl = null;
function hideContextMenu() {
  if (_ctxMenuEl) { _ctxMenuEl.remove(); _ctxMenuEl = null; }
}

function showContextMenu(x, y, items) {
  hideContextMenu();
  const menu = document.createElement('div');
  menu.className = 'ctx-menu';
  items.forEach(it => {
    if (it.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-sep';
      menu.appendChild(sep);
      return;
    }
    const row = document.createElement('div');
    row.className = 'ctx-item' + (it.danger ? ' danger' : '');
    row.innerHTML = `<span class="ctx-ico">${it.icon || ''}</span><span class="ctx-label">${esc(it.label)}</span>`;
    row.onclick = (ev) => { ev.stopPropagation(); hideContextMenu(); it.action(); };
    menu.appendChild(row);
  });
  document.body.appendChild(menu);
  // Flip so the menu never runs off-screen.
  const r = menu.getBoundingClientRect();
  menu.style.left = Math.min(x, window.innerWidth - r.width - 8) + 'px';
  menu.style.top = Math.min(y, window.innerHeight - r.height - 8) + 'px';
  _ctxMenuEl = menu;
  setTimeout(() => {
    document.addEventListener('click', hideContextMenu, { once: true });
    document.addEventListener('keydown', function esc(e) {
      if (e.key === 'Escape') hideContextMenu();
    }, { once: true });
    window.addEventListener('scroll', hideContextMenu, { once: true, capture: true });
  }, 0);
}

function fileMenuItems(path, name) {
  const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
  return [
    { label: 'Open', icon: CTX_ICON.open, action: () => openFile(path, name) },
    { separator: true },
    { label: 'Rename…', icon: CTX_ICON.rename, action: () => renamePath(path, false) },
    { label: 'Delete', icon: CTX_ICON.trash, danger: true, action: () => deleteFileOrFolder(path, false) },
    { separator: true },
    { label: 'New File…', icon: CTX_ICON.newFile, action: () => createInDir(dir, false) },
    { label: 'New Folder…', icon: CTX_ICON.newFolder, action: () => createInDir(dir, true) },
    { separator: true },
    { label: 'Copy Path', icon: CTX_ICON.copy, action: () => copyPath(path) },
    { label: 'Ask AI about this file', icon: CTX_ICON.ai, action: () => askAIAbout(path) },
  ];
}

function folderMenuItems(path, name) {
  return [
    { label: 'New File…', icon: CTX_ICON.newFile, action: () => createInDir(path, false) },
    { label: 'New Folder…', icon: CTX_ICON.newFolder, action: () => createInDir(path, true) },
    { separator: true },
    { label: 'Rename…', icon: CTX_ICON.rename, action: () => renamePath(path, true) },
    { label: 'Delete', icon: CTX_ICON.trash, danger: true, action: () => deleteFileOrFolder(path, true) },
    { separator: true },
    { label: 'Copy Path', icon: CTX_ICON.copy, action: () => copyPath(path) },
  ];
}

function rootMenuItems() {
  return [
    { label: 'New File…', icon: CTX_ICON.newFile, action: () => createInDir('', false) },
    { label: 'New Folder…', icon: CTX_ICON.newFolder, action: () => createInDir('', true) },
    { separator: true },
    { label: 'Refresh Explorer', icon: CTX_ICON.refresh, action: () => loadFileTree() },
  ];
}

// Create a file/folder inside `dir` (empty string = workspace root).
async function createInDir(dir, isDir) {
  const label = isDir ? 'folder' : 'file';
  const name = prompt(`New ${label} name` + (dir ? ` in ${dir}/` : '') + ':');
  if (!name || !name.trim()) return;
  const path = (dir ? dir.replace(/\/+$/, '') + '/' : '') + name.trim();
  try {
    const res = await fetch('/file/create', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, path, isDir })
    });
    if (res.ok) {
      showToast('Created ' + path, 'success');
      loadFileTree();
      if (!isDir) openFile(path, path.split('/').pop());
    } else {
      const e = await res.json(); showToast(e.error || 'Create failed', 'error');
    }
  } catch (e) { showToast('Create error', 'error'); }
}

// Rename/move a file or folder, keeping any open tab pointed at the new path.
async function renamePath(path, isDir) {
  const cur = path.split('/').pop();
  const next = prompt(`Rename "${cur}" to:`, cur);
  if (!next || !next.trim() || next === cur) return;
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/') + 1) : '';
  const to = parent + next.trim();
  try {
    const res = await fetch('/file/rename', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: IDE.container, from: path, to })
    });
    if (res.ok) {
      showToast('Renamed to ' + to, 'success');
      const wasOpen = !isDir && IDE.tabs.some(t => t.path === path);
      if (wasOpen) closeTab(path);
      loadFileTree();
      if (wasOpen) openFile(to, to.split('/').pop());
    } else {
      const e = await res.json(); showToast(e.error || 'Rename failed', 'error');
    }
  } catch (e) { showToast('Rename error', 'error'); }
}

function copyPath(path) {
  const done = () => showToast('Copied path', 'success');
  const fail = () => showToast('Copy failed', 'error');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(path).then(done, fail);
  } else {
    fail();
  }
}

// Open the agent panel and pre-fill a question about the clicked file.
function askAIAbout(path) {
  const panel = document.getElementById('ide-agent-panel');
  if (panel && panel.style.display === 'none' && typeof toggleAgentPanel === 'function') {
    toggleAgentPanel();
  }
  const input = document.getElementById('agent-input');
  if (input) {
    input.value = 'Explain what `' + path + '` does and how it fits into the app.';
    if (typeof autoGrowAgentInput === 'function') autoGrowAgentInput(input);
    setTimeout(() => input.focus(), 0);
  }
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
  // Monaco is served from the binary, not a CDN — the loader fetches the rest of
  // the editor (workers, language services) relative to this path, so pointing it
  // at /vendor/monaco/vs is what actually makes the IDE work offline.
  require.config({ paths: { vs: '/vendor/monaco/vs' } });
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

// ── Diff modal (before/after view of an AI edit) ──
let _diffEditor = null;
function showDiffModal(path, before, after) {
  if (typeof monaco === 'undefined') { openFile(path, path.split('/').pop()); return; }
  let overlay = document.getElementById('diff-modal');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'diff-modal';
    overlay.className = 'diff-modal';
    overlay.innerHTML =
      '<div class="diff-box">' +
      '<div class="diff-head"><span class="diff-title"></span>' +
      '<button class="diff-close" title="Close (Esc)">&times;</button></div>' +
      '<div class="diff-editor" id="diff-editor-host"></div></div>';
    document.body.appendChild(overlay);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) closeDiffModal(); });
    overlay.querySelector('.diff-close').onclick = closeDiffModal;
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && overlay.style.display === 'flex') closeDiffModal();
    });
  }
  overlay.querySelector('.diff-title').textContent = path;
  overlay.style.display = 'flex';
  const host = document.getElementById('diff-editor-host');
  host.innerHTML = '';
  if (_diffEditor) { _diffEditor.dispose(); _diffEditor = null; }
  const lang = getLang(path);
  _diffEditor = monaco.editor.createDiffEditor(host, {
    readOnly: true, automaticLayout: true, renderSideBySide: true,
    theme: IDE.darkMode ? 'jr-architect-dark' : 'jr-architect-light',
    minimap: { enabled: false }, scrollBeyondLastLine: false, fontSize: 12.5,
  });
  _diffEditor.setModel({
    original: monaco.editor.createModel(before || '', lang),
    modified: monaco.editor.createModel(after || '', lang),
  });
}
function closeDiffModal() {
  const overlay = document.getElementById('diff-modal');
  if (overlay) overlay.style.display = 'none';
  if (_diffEditor) {
    const m = _diffEditor.getModel();
    _diffEditor.dispose(); _diffEditor = null;
    if (m) { m.original && m.original.dispose(); m.modified && m.modified.dispose(); }
  }
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
    const ext = tab.name.split('.').pop().toLowerCase();
    d.innerHTML = `<span class="tab-icon icon" data-ext="${esc(ext)}">${fileIcon(tab.name)}</span><span class="tab-label">${esc(tab.name)}</span>${tab.modified ? '<span class="tab-modified">\u25CF</span>' : ''}<span class="tab-close" role="button" tabindex="0" title="Close">\u00D7</span>`;
    // The close handler is bound as a property. It used to interpolate tab.path
    // into an onclick attribute completely unescaped, so a file named with a
    // quote could inject script into the tab strip.
    const close = d.querySelector('.tab-close');
    if (close) close.onclick = (e) => closeTab(tab.path, e);
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
      reflectSaveInPreview();
    } else {
      const e = await res.json(); showToast(e.error || 'Save failed', 'error');
    }
  } catch (e) { showToast('Save error', 'error'); }
}

// hmrStack reports whether the running app has working hot-reload via the polling
// env vars (Next.js fast-refresh, CRA/webpack). For those, edits reflect on their
// own and we must NOT force a reload (it would throw away app state). Vite, static
// sites, and everything else don't hot-reload through a Docker bind mount, so we
// reload the iframe on save — a full reload re-reads files from disk and shows the
// change.
function hmrStack() {
  return /next\.js|CRA/i.test(IDE.framework || '');
}

function reflectSaveInPreview() {
  if (hmrStack()) return; // hot-reload handles it — don't clobber app state
  const panel = document.getElementById('ide-preview-panel');
  if (!panel || panel.style.display === 'none' || !IDE.appReady) return;
  // Debounce so a burst of saves triggers a single reload.
  clearTimeout(IDE.saveRefreshTimer);
  IDE.saveRefreshTimer = setTimeout(() => refreshPreview(), 400);
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
  socket.binaryType = 'arraybuffer';

  socket.onmessage = (event) => {
    // Shell output arrives as binary frames; the backend also sends the
    // occasional plain-text status/error frame (e.g. "Failed to start shell").
    // Handle both so an error is never silently swallowed into a blank terminal.
    if (typeof event.data === 'string') {
      term.write(event.data);
    } else {
      term.write(new Uint8Array(event.data));
    }
  };

  socket.onclose = () => {
    term.write('\r\n\x1b[90m[terminal disconnected — reopen the panel or reload]\x1b[0m\r\n');
  };
  socket.onerror = () => {
    term.write('\r\n\x1b[31m[terminal connection error]\x1b[0m\r\n');
  };

  // Tell the backend our terminal size so column-aware output (ls, wrapping)
  // lines up. Sent as a JSON text frame; keystrokes go as binary frames.
  const sendResize = () => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
    }
  };

  socket.onopen = () => {
    termFit.fit();
    sendResize();
  };

  term.onData((data) => {
    if (socket.readyState === WebSocket.OPEN) {
      socket.send(new TextEncoder().encode(data)); // binary frame = keystrokes
    }
  });

  term.onResize(() => sendResize());

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

// Focus the active xterm terminal (you type directly into it, VS Code-style).
function focusActiveTerminal() {
  const active = IDE.terminals.find(t => t.id === IDE.activeTerminalId);
  if (active && active.term) active.term.focus();
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
    const el = document.getElementById('logs-output');
    
    // Parse URLs into clickable hyperlinks
    const formattedHtml = esc(text).replace(
      /(https?:\/\/[^\s&<"']+)/g,
      '<a href="$1" target="_blank" style="color:var(--accent); text-decoration:underline;">$1</a>'
    );
    
    el.innerHTML = formattedHtml;
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

    // The backend reports "running" only once the app's port actually answers
    // (see sandboxStatusHandler), so it's a real readiness signal. Drive the
    // preview off the running -> not-running edges.
    const running = data.status === 'running';
    if (running && !IDE.appReady) { IDE.appReady = true; onAppReady(); }
    else if (!running) { IDE.appReady = false; }

    // Intelligent IDE: if the app is still not answering well after a grace
    // window (a slow install is normal, a broken build is not), let the agent
    // read the container logs and decide — reassure if it's just installing,
    // propose a fix if something is actually wrong. Once, per stuck episode.
    if (running) {
      IDE.doctorRan = false; // healthy again → re-arm for a future breakage
    } else if (!IDE.doctorRan && !IDE.doctorRunning && IDE.launchedAt &&
               (Date.now() - IDE.launchedAt) > 150000) {
      IDE.doctorRan = true;
      if (typeof runDoctor === 'function') runDoctor(true);
    }

    // Framework badge (e.g. "Next.js (Lyzr App)") — set once detection resolves.
    if (data.framework) IDE.framework = data.framework;
    const fwBadge = document.getElementById('framework-badge');
    if (fwBadge && data.framework) {
      fwBadge.textContent = data.framework;
      fwBadge.style.display = '';
    }

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
      ${data.framework ? `<div class="status-row"><span class="status-label">Framework:</span><span class="status-value">${data.framework}</span></div>` : ''}
      <div class="status-row"><span class="status-label">Status:</span><span class="status-value ${data.status === 'running' ? 'running' : (data.status === 'starting' ? 'starting' : 'stopped')}">${data.status}</span></div>
      <div class="status-row"><span class="status-label">Port:</span><span class="status-value">${data.port}</span></div>
      <div class="status-row"><span class="status-label">Preview:</span><span class="status-value"><a href="${data.url}" target="_blank" style="color:var(--accent)">${data.url}</a></span></div>
      <div class="status-row"><span class="status-label">Repository:</span><span class="status-value">${data.repo}</span></div>
    `;
  } catch (e) { }
}

// ── Live Preview ──
// The dev server inside a freshly-cloned sandbox isn't up for a while (npm
// install + build). Loading the iframe before then just shows a connection
// error that never recovers, so the preview is readiness-aware: it waits for the
// app to be "running" (per status polling), shows a loading state until then,
// and loads/auto-opens once ready.
function openLivePreview() {
  const panel = document.getElementById('ide-preview-panel');
  panel.style.display = 'flex';
  IDE.previewUserClosed = false;
  if (IDE.appReady) {
    loadPreviewIntoIframe();
  } else {
    showPreviewLoading();
    IDE.previewPending = true;
  }
}

// Called when the app first becomes reachable.
function onAppReady() {
  const panel = document.getElementById('ide-preview-panel');
  const open = panel && panel.style.display !== 'none';
  // Auto-open the preview the first time the app is ready (unless the user
  // deliberately closed it), so they see their app without hunting for a button.
  if (!IDE.previewAutoOpened && !IDE.previewUserClosed) {
    IDE.previewAutoOpened = true;
    openLivePreview();
    return;
  }
  // Already open and waiting on the app — load it now.
  if (open && IDE.previewPending) loadPreviewIntoIframe();
}

function loadPreviewIntoIframe() {
  IDE.previewPending = false;
  hidePreviewLoading();
  const iframe = document.getElementById('preview-iframe');
  const url = IDE.previewUrl || `http://127.0.0.1:${IDE.port}`;
  iframe.style.display = '';
  iframe.src = url;
}

function showPreviewLoading() {
  const overlay = document.getElementById('preview-loading');
  const iframe = document.getElementById('preview-iframe');
  if (iframe) iframe.style.display = 'none';
  if (overlay) overlay.style.display = 'flex';
}

function hidePreviewLoading() {
  const overlay = document.getElementById('preview-loading');
  if (overlay) overlay.style.display = 'none';
}

function closePreview() {
  document.getElementById('ide-preview-panel').style.display = 'none';
  document.getElementById('preview-iframe').src = '';
  IDE.previewPending = false;
  IDE.previewUserClosed = true;
}

function refreshPreview() {
  if (!IDE.appReady) {
    // App isn't up yet — show the waiting state and load automatically once ready.
    showPreviewLoading();
    IDE.previewPending = true;
    return;
  }
  loadPreviewIntoIframe();
}

// Force the live preview to reveal a just-applied edit: open the panel if it's
// closed (so the change is actually visible), then hard-reload with a cache-bust
// param so a CSS/Tailwind change isn't served from the iframe's cache. Returns
// false if the app isn't reachable yet (shows the waiting state instead).
function showChangesInPreview() {
  const panel = document.getElementById('ide-preview-panel');
  if (panel && panel.style.display === 'none') {
    panel.style.display = 'flex';
    IDE.previewUserClosed = false;
    if (IDE.editor && typeof IDE.editor.layout === 'function') setTimeout(() => IDE.editor.layout(), 0);
  }
  if (!IDE.appReady) {
    showPreviewLoading();
    IDE.previewPending = true;
    return false;
  }
  IDE.previewPending = false;
  hidePreviewLoading();
  const iframe = document.getElementById('preview-iframe');
  const base = IDE.previewUrl || `http://127.0.0.1:${IDE.port}`;
  const bust = (base.includes('?') ? '&' : '?') + '_jr=' + Date.now();
  iframe.style.display = '';
  iframe.src = base + bust;
  return true;
}

// ── Locate UI source (from the preview) ──
// A control floating on the preview reveals where the app's UI code lives in the
// IDE. Hovering highlights the file's folder in the tree; clicking opens the file.
async function getUIEntry() {
  if (IDE.uiEntry) return IDE.uiEntry;
  try {
    const res = await fetch(`/sandbox/entry?container=${IDE.container}`);
    if (!res.ok) return null;
    IDE.uiEntry = await res.json(); // { path, dir }
    // Enrich the tooltip with the actual path once we know it.
    const tip = document.getElementById('preview-locate-tip');
    if (tip && IDE.uiEntry.path) tip.textContent = 'UI code: ' + IDE.uiEntry.path + '  (click to open)';
    return IDE.uiEntry;
  } catch { return null; }
}

async function locateUISource(open) {
  const entry = await getUIEntry();
  if (!entry || !entry.path) {
    if (open) showToast('Could not find the UI entry file yet', 'error');
    return;
  }
  revealInTree(entry.path);
  if (open) {
    openFile(entry.path, entry.path.split('/').pop());
  }
}

// revealInTree expands the folders leading to `path`, scrolls it into view, and
// flashes it — so you can see exactly which folder the UI lives in.
function revealInTree(path) {
  const treeRoot = document.getElementById('file-tree');
  if (!treeRoot) return;
  let item = null;
  treeRoot.querySelectorAll('.tree-item').forEach(i => { if (i.dataset.path === path) item = i; });
  if (!item) return;
  // Open every ancestor directory so the item is visible.
  let el = item.parentElement;
  while (el && el !== treeRoot) {
    if (el.classList && el.classList.contains('tree-dir')) {
      el.classList.add('open');
      const arrow = el.querySelector(':scope > .tree-item .folder-icon');
      if (arrow) arrow.textContent = '▾';
    }
    el = el.parentElement;
  }
  item.scrollIntoView({ block: 'center', behavior: 'smooth' });
  item.classList.add('tree-flash');
  setTimeout(() => item.classList.remove('tree-flash'), 1600);
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

// ── Sidebar (Explorer) toggle from the activity bar ──
function toggleSidebar(btn) {
  const sb = document.querySelector('.ide-sidebar');
  if (!sb) return;
  sb.classList.toggle('collapsed');
  if (btn) btn.classList.toggle('active', !sb.classList.contains('collapsed'));
  // Monaco needs a relayout when the editor area width changes.
  if (IDE.editor && typeof IDE.editor.layout === 'function') {
    setTimeout(() => IDE.editor.layout(), 0);
  }
}

// ── AI Agent side panel (VS Code-style chat dock) toggle ──
function toggleAgentPanel() {
  const panel = document.getElementById('ide-agent-panel');
  if (!panel) return;
  const open = panel.style.display !== 'none';
  panel.style.display = open ? 'none' : 'flex';
  const btn = document.getElementById('act-agent');
  if (btn) btn.classList.toggle('active', !open);
  if (!open) {
    const input = document.getElementById('agent-input');
    if (input) setTimeout(() => input.focus(), 0);
  }
  if (IDE.editor && typeof IDE.editor.layout === 'function') {
    setTimeout(() => IDE.editor.layout(), 0);
  }
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
