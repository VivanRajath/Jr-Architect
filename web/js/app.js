// Same-origin calls carry X-Jr for the server's CSRF check, and a lapsed session goes back to the login page.
(() => {
  const nativeFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input), location.href);
    if (url.origin !== location.origin) return nativeFetch(input, init);
    const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
    headers.set('X-Jr', '1');
    const res = await nativeFetch(input, { ...init, headers });
    if (res.status === 401 && !url.pathname.startsWith('/auth/')) location.href = '/login';
    return res;
  };
})();

const API = '';
// 'dev' opens the IDE as soon as the app is up; 'prompt' just runs it and hands back a URL.
let currentMode = 'dev';
let currentSource = 'saved';

function setMode(mode) {
  if (mode === 'hub') { location.href = '/hub.html'; return; }
  currentMode = mode;
  document.querySelectorAll('.action-tile').forEach(el => {
    const on = el.dataset.mode === mode;
    el.classList.toggle('active', on);
    if (el.tagName === 'BUTTON') el.setAttribute('aria-selected', on);
  });
  ['dev', 'prompt', 'build'].forEach(m => {
    const panel = document.getElementById(`panel-${m}`);
    panel.hidden = m !== mode;
    // Restarting the animation makes the switch visible even between panels of similar height.
    if (m === mode) { panel.classList.remove('enter'); void panel.offsetWidth; panel.classList.add('enter'); }
  });
  if (!repoState.container) clearRunStatus();
  const focus = mode === 'prompt' ? 'repoInput' : mode === 'build' ? 'buildPromptInput' : null;
  if (focus) document.getElementById(focus).focus();
}

// The rail's Projects and Build links switch the launcher in place on this page.
window.jrHomeNav = (target) => {
  if (document.body.classList.contains('ide-mode')) { location.href = target === 'build' ? '/?mode=build' : '/?open=saved'; return; }
  if (target === 'build') {
    setMode('build');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  } else {
    document.getElementById('work').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
};

// "Good evening, Vivan" when we know who is signed in.
async function greet() {
  const h = new Date().getHours();
  const part = h < 5 ? 'Working late' : h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  let name = '';
  try {
    const me = await (await fetch('/auth/me')).json();
    const p = me.profile || {};
    name = (p.name || p.login || '').split(' ')[0];
  } catch { /* no profile */ }
  document.getElementById('homeGreeting').textContent = name ? `${part}, ${name}` : part;
}

document.getElementById('buildPromptInput').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); startBuilder(); }
});

function useIdea(chip) {
  const box = document.getElementById('buildPromptInput');
  box.value = chip.textContent;
  box.focus();
}

function clearRunStatus() {
  const bar = document.getElementById('runStatus');
  bar.className = 'status-bar';
  bar.innerHTML = '';
}

function setBusy(busy) {
  document.querySelectorAll('.launch-go').forEach(b => { b.disabled = busy; b.classList.toggle('busy', busy); });
}

function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = `<span>${type === 'success' ? '\u2713' : '\u2717'}</span><span>${msg}</span>`;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => el.remove(), 3500);
}

function runtimeTag(image) {
  if (!image) return '';
  const map = {
    'sandbox-python': ['python', 'tag-python'],
    'sandbox-django': ['django', 'tag-python'],
    'sandbox-node': ['node', 'tag-node'],
    'sandbox-react': ['react', 'tag-node'],
    'sandbox-deno': ['deno', 'tag-node'],
    'sandbox-bun': ['bun', 'tag-node'],
    'sandbox-go': ['go', 'tag-go'],
    'sandbox-static': ['static', 'tag-static'],
    'sandbox-rust': ['rust', 'tag-rust'],
    'sandbox-java': ['java', 'tag-java'],
    'sandbox-php': ['php', 'tag-php'],
    'sandbox-ruby': ['ruby', 'tag-ruby'],
    'sandbox-dotnet': ['dotnet', 'tag-dotnet'],
  };
  const [label, cls] = map[image] || [image.replace('sandbox-', ''), 'tag-other'];
  return `<span class="runtime-tag ${cls}">${label}</span>`;
}

function setRunStatus(type, icon, html) {
  const bar = document.getElementById('runStatus');
  bar.className = `status-bar show ${type}`;
  bar.innerHTML = `<div class="status-icon">${icon}</div><div class="status-content">${html}</div>`;
}

// Repo state between /run (clone + scan) and /run/approve (build + start).
let repoState = { container: null, repo: '', plan: null, mode: 'prompt', startedAt: 0 };

// The server reports one of these stages (plus 'ready'/'failed'); each is a row the user can follow.
const RUN_STEPS = [
  ['clone', 'Clone the repository'],
  ['approve', 'Review what was found'],
  ['image', 'Prepare the runtime'],
  ['install', 'Install dependencies'],
  ['start', 'Start the app'],
  ['preview', 'Open the live preview'],
];

function fmtElapsed(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
}

function renderProgress(stage, detail) {
  const idx = stage === 'ready' ? RUN_STEPS.length : RUN_STEPS.findIndex(s => s[0] === stage);
  const rows = RUN_STEPS.map(([key, label], i) => {
    const state = i < idx ? 'done' : i === idx ? 'active' : 'todo';
    const extra = state === 'active' && detail ? `<div class="run-step-detail">${escHtml(detail)}</div>` : '';
    return `<li class="run-step ${state}"><span class="run-step-dot"></span><span>${label}</span>${extra}</li>`;
  }).join('');
  // Once the build has started the IDE can open; it keeps showing progress until the preview is up.
  const canOpen = idx >= 2 && repoState.container;
  setRunStatus('loading', '', `
    <div class="run-progress">
      <div class="run-progress-head">
        <strong>Setting up ${escHtml(sourceLabel(repoState.repo).replace(/^github\.com\//, ''))}</strong>
        <span class="run-elapsed">${fmtElapsed(Date.now() - repoState.startedAt)}</span>
      </div>
      <ol class="run-steps">${rows}</ol>
      <div class="link-row">
        ${canOpen ? `<button class="btn btn-sm" onclick="openIDEFromRun()">Open IDE now</button>` : ''}
        ${repoState.container ? `<button class="btn btn-sm btn-ghost" onclick="viewLogs('${repoState.container}')">Raw logs</button>` : ''}
      </div>
    </div>`);
}

function openIDEFromRun() {
  if (!repoState.container) return;
  initIDE(repoState.container, repoState.repo, '');
  loadSandboxes();
}

// Every way in (clone, saved project, upload) ends in the same scan, approval and progress flow.
async function startRun(label, mode, request, firstStep) {
  setBusy(true);
  repoState = { container: null, repo: label, plan: null, mode, startedAt: Date.now() };
  renderProgress('clone', firstStep);
  try {
    const res = await request();
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');
    repoState.container = data.container;
    await waitForPlan(data.container, firstStep);
  } catch (err) {
    repoState.container = null;
    setRunStatus('error', '', `<strong>Couldn't start:</strong> ${escHtml(err.message)}`);
    toast(err.message, 'error');
    setBusy(false);
  }
}

function postJSON(url, body) {
  return fetch(`${API}${url}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

function runRepo(inputId, mode, instructions = '') {
  const input = document.getElementById(inputId);
  const repo = input.value.trim();
  if (!repo) { input.focus(); return; }
  startRun(repo, mode, () => postJSON('/run', { repo, instructions, mode }), 'Cloning the repository and looking for services');
}

function runSandbox() {
  runRepo('repoInput', 'prompt', document.getElementById('instructionsInput').value.trim());
}

function cloneToIDE() {
  runRepo('cloneInput', 'dev');
}

// A repo picked from the GitHub list opens on its default branch, with the user's GitHub access.
function openGitHubRepo(url, branch) {
  document.getElementById('cloneInput').value = url;
  startRun(url, 'dev', () => postJSON('/run', { repo: url, branch, mode: 'dev' }), 'Cloning the whole repository with your GitHub account');
}

// ── Saved projects ───────────────────────────────

let projects = [];

async function loadProjects() {
  try {
    const res = await fetch(`${API}/projects`);
    if (!res.ok) return;
    projects = (await res.json()).projects || [];
  } catch { return; }
  document.getElementById('projectCount').textContent = projects.length || '';
  const list = document.getElementById('projectList');
  if (!projects.length) {
    list.innerHTML = `<div class="project-empty"><strong>No saved projects yet</strong>Open code from GitHub or your computer, or build an app, then use <b>Save project</b> in the IDE. It stays here after the sandbox stops.</div>`;
    return;
  }
  list.innerHTML = projects.map(p => `
    <div class="project-card">
      <div class="project-name" title="${escHtml(p.name)}">${escHtml(p.name)}</div>
      <div class="project-meta" title="${escHtml(p.source)}">${escHtml(p.framework || sourceLabel(p.source))} · ${formatTimeAgo(p.openedAt && p.openedAt > p.savedAt ? p.openedAt : p.savedAt)}</div>
      <div class="project-meta">${p.files} files · ${formatSize(p.bytes)}</div>
      <div class="project-actions">
        <button class="btn btn-sm btn-primary launch-go" onclick="openProject('${p.id}')"><span class="spinner"></span>Open in IDE</button>
        <button class="btn btn-sm btn-ghost" data-del="${p.id}" onclick="deleteProject(this)">Delete</button>
      </div>
    </div>`).join('');
}

function sourceLabel(src) {
  if (!src) return 'project';
  if (src.startsWith('local:')) return 'uploaded';
  if (src.startsWith('generated:')) return 'built';
  return src.replace(/^https?:\/\/(www\.)?/, '').replace(/^project:/, '');
}

function formatSize(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1 << 20) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1 << 20)).toFixed(1)} MB`;
}

function openProject(id) {
  const p = projects.find(x => x.id === id);
  if (!p) return;
  startRun(`project:${p.name}`, 'dev', () => postJSON('/projects/open', { id }), 'Copying your saved project into a fresh sandbox');
}

// Two clicks instead of a confirm() dialog: the first arms the button, the second deletes.
async function deleteProject(btn) {
  if (!btn.classList.contains('armed')) {
    btn.classList.add('armed', 'btn-danger');
    btn.textContent = 'Really delete?';
    setTimeout(() => { btn.classList.remove('armed', 'btn-danger'); btn.textContent = 'Delete'; }, 3000);
    return;
  }
  const res = await postJSON('/projects/delete', { id: btn.dataset.del });
  if (res.ok) toast('Project deleted'); else toast('Could not delete the project', 'error');
  loadProjects();
}

// ── Local folder / zip upload ────────────────────

const SKIP_DIRS = new Set(['node_modules', '.venv', 'venv', '__pycache__', 'target', '.next', '.nuxt', '.cache', '.gradle', '.turbo', '.pytest_cache', '.mypy_cache', '.parcel-cache']);
let localUpload = null;

function keepPath(path) {
  return !path.split('/').some(seg => SKIP_DIRS.has(seg));
}

// Paths arrive as "<picked folder>/src/a.js"; the picked folder becomes the project name.
function setLocalFiles(entries) {
  const kept = entries.filter(e => keepPath(e.path));
  if (!kept.length) { toast('That folder has no files to upload', 'error'); return; }
  const tops = new Set(kept.map(e => e.path.split('/')[0]));
  let name = 'local project';
  let files = kept;
  if (tops.size === 1 && kept.every(e => e.path.includes('/'))) {
    name = [...tops][0];
    files = kept.map(e => ({ path: e.path.slice(name.length + 1), file: e.file }));
  }
  const bytes = files.reduce((n, e) => n + e.file.size, 0);
  localUpload = { kind: 'folder', files, name, bytes };
  showLocalReady(`${files.length} files · ${formatSize(bytes)}`, name);
}

function setLocalZip(file) {
  const name = file.name.replace(/\.zip$/i, '');
  localUpload = { kind: 'zip', file, name, bytes: file.size };
  showLocalReady(`${file.name} · ${formatSize(file.size)}`, name);
}

function showLocalReady(summary, name) {
  document.getElementById('dropzone').classList.add('ready');
  document.getElementById('dropTitle').textContent = 'Ready to upload';
  document.getElementById('dropSub').textContent = summary;
  document.getElementById('localName').value = name;
  document.getElementById('localReady').hidden = false;
}

function clearLocal() {
  localUpload = null;
  document.getElementById('dropzone').classList.remove('ready');
  document.getElementById('dropTitle').textContent = 'Drop a folder or .zip';
  document.getElementById('dropSub').textContent = 'node_modules and build output are skipped';
  document.getElementById('localReady').hidden = true;
  document.getElementById('folderPick').value = '';
  document.getElementById('zipPick').value = '';
}

function uploadToIDE() {
  if (!localUpload) return;
  if (localUpload.bytes > 200 * (1 << 20)) { toast('Projects are limited to 200 MB', 'error'); return; }
  const name = document.getElementById('localName').value.trim() || localUpload.name;
  const form = new FormData();
  form.append('name', name);
  if (localUpload.kind === 'zip') {
    form.append('zip', localUpload.file, localUpload.file.name);
  } else {
    form.append('paths', JSON.stringify(localUpload.files.map(e => e.path)));
    localUpload.files.forEach(e => form.append('file', e.file, 'f'));
  }
  startRun(`local:${name}`, 'dev', () => fetch(`${API}/run/upload`, { method: 'POST', body: form }), 'Uploading your project');
}

// Folder drops only expose their contents through the entries API, one directory read at a time.
async function readDropped(items) {
  const out = [];
  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await new Promise((ok, fail) => entry.file(ok, fail));
      out.push({ path: prefix + entry.name, file });
    } else if (entry.isDirectory && !SKIP_DIRS.has(entry.name)) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((ok, fail) => reader.readEntries(ok, fail));
        if (!batch.length) break;
        for (const child of batch) await walk(child, `${prefix}${entry.name}/`);
      }
    }
  };
  for (const entry of items) await walk(entry, '');
  return out;
}

function initLocalUpload() {
  const zone = document.getElementById('dropzone');
  document.getElementById('folderPick').addEventListener('change', (e) => {
    setLocalFiles([...e.target.files].map(f => ({ path: f.webkitRelativePath || f.name, file: f })));
  });
  document.getElementById('zipPick').addEventListener('change', (e) => {
    if (e.target.files[0]) setLocalZip(e.target.files[0]);
  });
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', async (e) => {
    e.preventDefault();
    zone.classList.remove('over');
    const entries = [...e.dataTransfer.items].map(i => i.webkitGetAsEntry && i.webkitGetAsEntry()).filter(Boolean);
    if (entries.length === 1 && entries[0].isFile && /\.zip$/i.test(entries[0].name)) {
      setLocalZip(e.dataTransfer.files[0]);
      return;
    }
    document.getElementById('dropSub').textContent = 'Reading files…';
    setLocalFiles(await readDropped(entries));
  });
}

// The clone runs server-side, so poll until the scan produces something to approve.
async function waitForPlan(container, step) {
  for (let i = 0; i < 150; i++) {
    renderProgress('clone', step);
    const res = await fetch(`${API}/run/plan?container=${encodeURIComponent(container)}`);
    if (res.ok) {
      const d = await res.json();
      if (d.status === 'failed') throw new Error(d.error || 'detection failed');
      if (d.plan && d.status === 'awaiting-approval') {
        repoState.plan = d.plan;
        renderApproval(d.plan);
        return;
      }
    }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('timed out waiting for the repo scan');
}

function renderApproval(plan) {
  setBusy(false);

  const rows = plan.services.map((s, i) => `
    <div class="svc-row">
      <label class="svc-toggle">
        <input type="checkbox" id="svc-on-${i}" ${s.enabled ? 'checked' : ''}>
      </label>
      <div class="svc-main">
        <div class="svc-head">
          <span class="svc-name">${escHtml(s.name)}</span>
          ${runtimeTag('sandbox-' + s.stack)}
          <span class="svc-framework">${escHtml(s.framework)}</span>
          ${s.primary ? '<span class="svc-primary">preview</span>' : ''}
        </div>
        <div class="svc-path">${escHtml(s.dir || 'repo root')}/</div>
        <input class="svc-cmd" id="svc-cmd-${i}" value="${escHtml([s.install, s.start].filter(Boolean).join(' && '))}">
      </div>
      <input class="svc-port" id="svc-port-${i}" type="number" min="0" max="65535"
             value="${s.port || ''}" placeholder="none" title="Container port">
    </div>`).join('');

  const buildNote = plan.needsBuild
    ? `<div class="svc-build-note">Needs building — first repo using this toolchain combination, later ones reuse it.</div>`
    : `<div class="svc-build-note ready">Already built — starts immediately.</div>`;

  setRunStatus('info', '', `
    <strong>Found ${plan.services.length} service${plan.services.length === 1 ? '' : 's'}</strong>
    in ${escHtml(sourceLabel(repoState.repo))}. Check the commands and ports, then approve.
    <div class="svc-list">${rows}</div>
    <div class="svc-image"><span>Image</span><code>${escHtml(plan.image)}</code></div>
    ${buildNote}
    <div class="link-row" style="margin-top:10px;">
      <button class="btn btn-sm btn-ghost" onclick="cancelApproval()">Cancel</button>
      ${repoState.mode === 'dev'
        ? `<button class="btn btn-sm" onclick="approveRun(true)">Approve &amp; open IDE</button>`
        : `<button class="btn btn-sm btn-ghost" onclick="approveRun(true)">Approve &amp; open IDE</button>
           <button class="btn btn-sm" onclick="approveRun(false)">Approve &amp; run</button>`}
    </div>
  `);
}

function cancelApproval() {
  if (repoState.container) fetch(`${API}/stop/${repoState.container}`, { method: 'POST' }).catch(() => {});
  repoState = { container: null, repo: '', plan: null, mode: 'prompt', startedAt: 0 };
  clearRunStatus();
}

// Everything the user changed on the card, sent back as edits to the stored plan.
function collectEdits(plan) {
  return plan.services.map((s, i) => {
    const cmd = document.getElementById(`svc-cmd-${i}`).value.trim();
    const original = [s.install, s.start].filter(Boolean).join(' && ');
    const edit = {
      name: s.name,
      enabled: document.getElementById(`svc-on-${i}`).checked,
      port: parseInt(document.getElementById(`svc-port-${i}`).value, 10) || 0,
    };
    // Only sent when actually edited, so the install/start split the scanner worked out survives untouched rows.
    if (cmd !== original) {
      edit.install = '';
      edit.start = cmd;
    }
    return edit;
  });
}

async function approveRun(openIDE = false) {
  const plan = repoState.plan;
  if (!plan) return;
  const edits = collectEdits(plan);
  if (!edits.some(e => e.enabled)) {
    toast('Enable at least one service', 'error');
    return;
  }

  renderProgress('image', 'Starting the build');

  try {
    const res = await fetch(`${API}/run/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: repoState.container, services: edits }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'approval failed');
    if (openIDE) openIDEFromRun();
    pollUntilRunning(repoState.container);
  } catch (err) {
    setRunStatus('error', '', `<strong>Error:</strong> ${escHtml(err.message)}`);
    toast(err.message, 'error');
  }
}

async function pollUntilRunning(container) {
  for (let i = 0; i < 600; i++) {
    await new Promise(r => setTimeout(r, 2000));
    let d;
    try {
      const res = await fetch(`${API}/sandbox/status?container=${encodeURIComponent(container)}`);
      if (!res.ok) continue;
      d = await res.json();
    } catch (_) { continue; }

    // The IDE took over (Open IDE now); it shows the same progress itself.
    if (document.body.classList.contains('ide-mode')) return;

    if (d.stage === 'failed') {
      setRunStatus('error', '', `<strong>Failed:</strong> ${escHtml(d.detail || d.error || 'see the logs')}
        <div class="link-row" style="margin-top:8px;">
          <button class="btn btn-sm btn-ghost" onclick="viewLogs('${container}')">Logs</button>
        </div>`);
      toast('Sandbox failed to start', 'error');
      return;
    }

    // Dev Mode opens the IDE as soon as the container is up; the IDE shows the rest of the progress.
    if (repoState.mode === 'dev' && ['install', 'start', 'preview', 'ready'].includes(d.stage)) {
      toast('Sandbox started — opening IDE');
      openIDEFromRun();
      return;
    }
    if (d.stage !== 'ready') {
      renderProgress(d.stage, d.detail);
      continue;
    }

    {
      const links = (d.services || []).filter(s => s.url).map(s =>
        `<a class="sandbox-link" href="${s.url}" target="_blank" rel="noopener">${escHtml(s.name)} ${escHtml(s.url)}</a>`
      ).join('');
      setRunStatus('success', '', `
        <strong>Your app is live</strong> <span class="run-elapsed">ready in ${fmtElapsed(Date.now() - repoState.startedAt)}</span><br>
        <div class="link-row" style="margin-top:8px;">
          ${links}
          <button class="btn btn-sm btn-ghost" onclick="viewLogs('${container}')">Logs</button>
          <button class="btn btn-sm btn-success" onclick="initIDE('${container}','${escHtml(repoState.repo)}', '${d.port}')">Open IDE</button>
        </div>
        <small style="color:var(--text3); display:block; margin-top:6px;">Stops after 15 minutes without activity (45 minutes at most).</small>
      `);
      toast('Sandbox launched!');
    }
    loadSandboxes();
    return;
  }
}

async function loadSandboxes() {
  try {
    const res = await fetch(`${API}/sandboxes`);
    const data = await res.json();
    const list = document.getElementById('sandboxList');
    const count = document.getElementById('sandboxCount');

    const items = Object.values(data || {});
    count.textContent = items.length;
    document.getElementById('runningCard').hidden = items.length === 0;

    if (items.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <p>Nothing running. Open a project above and it shows up here.</p>
        </div>`;
      return;
    }

    list.innerHTML = items.map(sb => {
      // Nothing is listening before approval, so Open/IDE would lead nowhere.
      const pending = ['detecting', 'awaiting-approval', 'building', 'failed'].includes(sb.status);
      const open = pending ? '' : `
          ${sb.url ? `<a class="btn btn-sm btn-ghost" href="${escHtml(sb.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
          <button class="btn btn-sm" onclick="initIDE('${sb.container}','${escHtml(sb.repo)}', '${sb.port}')">IDE</button>`;
      return `
      <div class="sandbox-item">
        <div class="status-dot${pending ? ' pending' : ''}"></div>
        <div class="sandbox-info">
          <div class="sandbox-name">${escHtml(sourceLabel(sb.repo))}</div>
          <div class="sandbox-repo">${escHtml(sb.framework || '')} ${escHtml(sb.container)}</div>
          ${pending ? `<div class="sandbox-status">${escHtml(sb.status)}</div>` : ''}
        </div>
        <div class="sandbox-actions">${open}
          <button class="btn btn-sm btn-ghost" onclick="viewLogs('${sb.container}')">Logs</button>
          <button class="btn btn-sm btn-danger" onclick="stopSandbox('${sb.container}')">Stop</button>
        </div>
      </div>`;
    }).join('');
  } catch (err) {
    console.error('Failed to load sandboxes:', err);
  }
}

async function stopSandbox(container) {
  try {
    await fetch(`${API}/stop/${container}`, { method: 'POST' });
    toast('Sandbox stopped');
    loadSandboxes();
  } catch (err) {
    toast('Failed to stop sandbox', 'error');
  }
}

async function viewLogs(container) {
  document.getElementById('logsTitle').textContent = `Logs: ${container}`;
  document.getElementById('logsOutput').textContent = 'Loading…';
  document.getElementById('logsModal').classList.add('show');

  try {
    const res = await fetch(`${API}/logs/${container}`);
    const text = await res.text();
    document.getElementById('logsOutput').textContent = text || '(no output yet)';
  } catch (err) {
    document.getElementById('logsOutput').textContent = `Error: ${err.message}`;
  }
}

function closeLogs() {
  document.getElementById('logsModal').classList.remove('show');
}

function closeLogsIfOverlay(e) {
  if (e.target === document.getElementById('logsModal')) closeLogs();
}

document.getElementById('repoInput').addEventListener('keydown', e => { if (e.key === 'Enter') runSandbox(); });
document.getElementById('cloneInput').addEventListener('keydown', e => { if (e.key === 'Enter') cloneToIDE(); });
document.getElementById('localName').addEventListener('keydown', e => { if (e.key === 'Enter') uploadToIDE(); });

// BUILD MODE — Multi-step state machine

let builderState = {
  step: 1,            // 1=Q&A, 2=PRD, 3=Building, 4=Launch
  prompt: '',
  questions: [],
  qIndex: 0,
  answers: {},
  picks: {},
  custom: {},
  prd: null,
  container: null,
  buildId: null,
  url: null,
};

function startBuilder() {
  const prompt = document.getElementById('buildPromptInput').value.trim();
  if (!prompt) {
    document.getElementById('buildPromptInput').focus();
    toast('Please describe your app first', 'error');
    return;
  }
  builderState = { step: 1, prompt, questions: [], qIndex: 0, answers: {}, picks: {}, custom: {}, prd: null, container: null, buildId: null, url: null };
  document.getElementById('builderOverlay').classList.add('show');
  fetchQuestions(prompt);
}

function closeBuilder() {
  document.getElementById('builderOverlay').classList.remove('show');
}

function closeBuilderIfOverlay(e) {
  if (e.target === document.getElementById('builderOverlay') && builderState.step !== 3) {
    closeBuilder();
  }
}

function setBuilderStep(n) {
  builderState.step = n;
  for (let i = 1; i <= 4; i++) {
    const el = document.getElementById(`bstep-${i}`);
    el.className = 'bstep' + (i < n ? ' done' : i === n ? ' active' : '');
  }
  for (let i = 1; i <= 3; i++) {
    const conn = document.getElementById(`bconn-${i}`);
    conn.className = 'bstep-connector' + (i < n ? ' done' : '');
  }
}

// ── Step 1: Q&A ──────────────────────────────

async function fetchQuestions(prompt) {
  renderQALoading();
  try {
    const res = await fetch('/build/questions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to get questions');
    builderState.questions = data.questions || [];
    builderState.stack = data.stack || '';
    builderState.stacks = data.stacks || [];
    builderState.qIndex = 0;
    renderCurrentQuestion();
  } catch (err) {
    toast('Error: ' + err.message, 'error');
    closeBuilder();
  }
}

function renderQALoading() {
  setBuilderStep(1);
  document.getElementById('builderHeaderTitle').textContent = 'Generating questions…';
  document.getElementById('builderBody').innerHTML = `
    <div style="text-align:center;padding:40px 0;color:var(--text3);">
      <div style="font-size:32px;margin-bottom:12px;animation:spin 1s linear infinite;display:inline-block;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></div>
      <div style="font-size:13px;">Reading your idea and laying out the decisions that shape it…</div>
    </div>`;
}

const QA_KIND_LABEL = { stack: 'Stack', experience: 'Experience', ai: 'Intelligence', capability: 'Capabilities', design: 'Look & feel' };
const QA_CHECK = '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="20 6 9 17 4 12"/></svg>';

function qaStepLabel(q, i) {
  return QA_KIND_LABEL[q.id === 'tech_stack' ? 'stack' : q.kind] || `Question ${i + 1}`;
}

// The recommended options start selected, so Next alone takes the suggested direction.
function qaPicks(q) {
  if (!builderState.picks[q.id]) {
    builderState.picks[q.id] = (q.recommended || []).filter(i => i >= 0 && i < (q.options || []).length);
  }
  return builderState.picks[q.id];
}

// The PRD writer reads each option with what it means; the stack answer stays a bare label the server maps to a stack.
function qaAnswer(q) {
  const parts = [...qaPicks(q)].sort((a, b) => a - b).map(j => {
    const d = q.id === 'tech_stack' ? '' : (q.details || [])[j];
    return d ? `${q.options[j]} (${d})` : q.options[j];
  });
  const own = (builderState.custom[q.id] || '').trim();
  if (own) parts.push(own);
  return parts.join('; ');
}

function qaAnswered(q) {
  return (builderState.picks[q.id] || []).length > 0 || !!(builderState.custom[q.id] || '').trim();
}

function renderCurrentQuestion() {
  const qs = builderState.questions;
  const i = builderState.qIndex;
  const q = qs[i];
  if (!q) { submitAnswers(); return; }

  setBuilderStep(1);
  document.getElementById('builderHeaderTitle').textContent = 'Shape your app';
  document.getElementById('builderHeaderSub').textContent = 'One decision at a time. The recommended direction is already picked.';

  const picks = qaPicks(q);
  const opts = q.options || [];
  const isStack = q.id === 'tech_stack';
  const hasDetails = (q.details || []).some(Boolean);
  const last = i === qs.length - 1;

  const steps = qs.map((x, j) => `<button type="button" class="qa-step${j === i ? ' active' : ''}${j !== i && qaAnswered(x) ? ' done' : ''}" onclick="qaJump(${j})"><span class="qa-step-dot"></span>${escHtml(qaStepLabel(x, j))}</button>`).join('');

  const cards = opts.map((o, j) => {
    const detail = (q.details || [])[j] || '';
    const on = picks.includes(j);
    return `<button type="button" class="qa-option${on ? ' selected' : ''}" data-i="${j}" onclick="qaToggle(${j})" aria-pressed="${on}">
        <span class="qa-check">${QA_CHECK}</span>
        <span class="qa-option-body">
          <span class="qa-option-label">${escHtml(o)}</span>
          ${detail ? `<span class="qa-option-detail">${escHtml(detail)}</span>` : ''}
          ${(q.recommended || []).includes(j) ? '<span class="qa-badge">Recommended</span>' : ''}
        </span>
        ${j < 9 ? `<span class="qa-key">${j + 1}</span>` : ''}
      </button>`;
  }).join('');

  const hint = !opts.length ? 'Describe what you want' : (q.multi ? 'Pick any that fit' : 'Pick one') + (isStack ? ' · skip to use Next.js' : '') + (opts.length > 1 ? ` · keys 1-${Math.min(opts.length, 9)}` : '');

  document.getElementById('builderBody').innerHTML = `
    <div class="qa-steps">${steps}</div>
    <div class="qa-question-text">${escHtml(q.text)}</div>
    <div class="qa-hint">${hint}</div>
    ${opts.length ? `<div class="qa-options${q.multi ? ' multi' : ''}${isStack || !hasDetails ? ' compact' : ''}" role="group" aria-label="${escHtml(q.text)}">${cards}</div>` : ''}
    <div class="qa-own"><input id="qaOwn" class="qa-input" type="text" autocomplete="off" maxlength="300"
      placeholder="${opts.length ? 'Or describe your own direction (optional)' : 'Your answer'}" value="${escHtml(builderState.custom[q.id] || '')}"></div>
    <div class="qa-nav">
      ${i > 0 ? '<button class="btn btn-ghost" onclick="qaBack()">Back</button>' : ''}
      <span class="qa-nav-spacer"></span>
      ${!last ? '<button class="btn btn-ghost" onclick="qaUseRecommended()" title="Keep the recommended direction for every remaining decision">Use recommended for the rest</button>' : ''}
      <button class="btn" onclick="qaNext()">${last ? 'Write the PRD' : 'Next'}</button>
    </div>`;

  const own = document.getElementById('qaOwn');
  own.addEventListener('input', () => { builderState.custom[q.id] = own.value; });
  own.addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); qaNext(); } });
  if (!opts.length) own.focus();
}

function qaToggle(j) {
  const q = builderState.questions[builderState.qIndex];
  if (!q) return;
  const picks = qaPicks(q);
  const at = picks.indexOf(j);
  if (at >= 0) picks.splice(at, 1);
  else if (q.multi) picks.push(j);
  else picks.splice(0, picks.length, j);
  document.querySelectorAll('#builderBody .qa-option').forEach(el => {
    const on = picks.includes(Number(el.dataset.i));
    el.classList.toggle('selected', on);
    el.setAttribute('aria-pressed', String(on));
  });
}

function qaSave() {
  const q = builderState.questions[builderState.qIndex];
  if (q) builderState.answers[q.id] = qaAnswer(q);
}

function qaNext() {
  qaSave();
  builderState.qIndex++;
  renderCurrentQuestion();
}

function qaBack() {
  qaSave();
  if (builderState.qIndex > 0) builderState.qIndex--;
  renderCurrentQuestion();
}

function qaJump(j) {
  qaSave();
  builderState.qIndex = j;
  renderCurrentQuestion();
}

function qaUseRecommended() {
  qaSave();
  builderState.qIndex = builderState.questions.length;
  renderCurrentQuestion();
}

// Number keys pick options and Enter moves on, unless the person is typing or on a button.
document.addEventListener('keydown', (e) => {
  if (builderState.step !== 1 || !document.getElementById('builderOverlay').classList.contains('show')) return;
  const t = e.target instanceof Element ? e.target : null;
  if (e.metaKey || e.ctrlKey || e.altKey || (t && t.closest('input, textarea, select, button, [contenteditable="true"]'))) return;
  const q = builderState.questions[builderState.qIndex];
  if (!q) return;
  const n = Number(e.key);
  if (n >= 1 && n <= Math.min((q.options || []).length, 9)) { e.preventDefault(); qaToggle(n - 1); }
  else if (e.key === 'Enter') { e.preventDefault(); qaNext(); }
});

// ── Step 2: PRD ──────────────────────────────

async function submitAnswers() {
  setBuilderStep(2);
  document.getElementById('builderHeaderTitle').textContent = 'Generating PRD…';
  document.getElementById('builderHeaderSub').textContent = 'Crafting your product requirements';
  document.getElementById('builderBody').innerHTML = `
    <div style="text-align:center;padding:40px 0;color:var(--text3);">
      <div style="font-size:32px;margin-bottom:12px;animation:spin 1s linear infinite;display:inline-block;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></div>
      <div style="font-size:13px;">Writing the product spec and its AI plan. This takes about half a minute.</div>
      <div class="prd-stage" id="prdStage"></div>
    </div>`;

  // Unseen questions take their recommended direction.
  builderState.questions.forEach(q => { builderState.answers[q.id] = qaAnswer(q); });
  const stages = ['Working out what the best app for this idea would do', 'Mapping the journey, pages and features', 'Planning edge cases and the data model', 'Designing the agents and the workflows that connect them'];
  let stage = 0;
  const stageEl = () => document.getElementById('prdStage');
  if (stageEl()) stageEl().textContent = stages[0];
  const ticker = setInterval(() => { stage = Math.min(stage + 1, stages.length - 1); if (stageEl()) stageEl().textContent = stages[stage]; }, 7000);

  try {
    const res = await fetch('/build/prd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        prompt: builderState.prompt, answers: builderState.answers, stack: builderState.stack || '',
        questions: builderState.questions.map(q => ({ id: q.id, text: q.text })),
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'PRD generation failed');
    builderState.prd = data.prd;
    renderPRD(data.prd);
  } catch (err) {
    toast('Error: ' + err.message, 'error');
    backToQuestions();
  } finally {
    clearInterval(ticker);
  }
}

function renderPRD(prd) {
  setBuilderStep(2);
  document.getElementById('builderHeaderTitle').textContent = prd.name || 'PRD Review';
  document.getElementById('builderHeaderSub').textContent = prd.tagline || 'Review and edit before building';

  const featuresHTML = (prd.features || []).map(f =>
    `<li>${escHtml(f)}</li>`
  ).join('');

  const pagesHTML = (prd.pages || []).map(p =>
    `<span class="prd-chip">${escHtml(p)}</span>`
  ).join('');

  const edgeHTML = (prd.edge_cases || []).map(e => `<li>${escHtml(e)}</li>`).join('');

  const outHTML = (prd.out_of_scope || []).map(o =>
    `<span class="prd-chip" style="opacity:.6;">${escHtml(o)}</span>`
  ).join('');

  let dataModelHTML = '';
  if (prd.data_model && typeof prd.data_model === 'object') {
    for (const [entity, fields] of Object.entries(prd.data_model)) {
      const fieldsHTML = (fields || []).map(f =>
        `<span class="prd-field-tag">${escHtml(f)}</span>`
      ).join('');
      dataModelHTML += `
        <div class="prd-entity">
          <div class="prd-entity-name">${escHtml(entity)}</div>
          <div class="prd-entity-fields">${fieldsHTML}</div>
        </div>`;
    }
  }

  document.getElementById('builderBody').innerHTML = `
    <div class="prd-edit-hint"><svg style="vertical-align:middle" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg> Click any field to edit it before building.</div>

    <div class="prd-section">
      <div class="prd-section-label">Tech stack</div>
      <div class="prd-section-value prd-stack">
        <select id="prd-stack" class="prd-stack-select" onchange="changeStack(this.value)">${(builderState.stacks || []).map(st =>
          `<option value="${escHtml(st.id)}" ${st.id === prd.stack ? 'selected' : ''}>${escHtml(st.label)}</option>`).join('')}</select>
        <span class="prd-muted">${stackNote(prd)}</span>
      </div>
    </div>

    ${prd.vision ? `<div class="prd-section">
      <div class="prd-section-label">Vision</div>
      <div class="prd-section-value" contenteditable="true" id="prd-vision">${escHtml(prd.vision)}</div>
    </div>` : ''}

    <div class="prd-section">
      <div class="prd-section-label">Target Users</div>
      <div class="prd-section-value" contenteditable="true" id="prd-users">${escHtml(prd.target_users || '')}</div>
    </div>

    ${prd.core_loop ? `<div class="prd-section">
      <div class="prd-section-label">Core loop</div>
      <div class="prd-section-value prd-loop" contenteditable="true" id="prd-loop">${escHtml(prd.core_loop)}</div>
    </div>` : ''}

    <div class="prd-section">
      <div class="prd-section-label">Core Features</div>
      <div class="prd-section-value">
        <ul class="prd-features-list">${featuresHTML}</ul>
      </div>
    </div>

    <div class="prd-section">
      <div class="prd-section-label">Pages & Routes</div>
      <div class="prd-section-value">${pagesHTML}</div>
    </div>

    ${edgeHTML ? `<div class="prd-section">
      <div class="prd-section-label">Edge cases it handles</div>
      <div class="prd-section-value"><ul class="prd-edge-list">${edgeHTML}</ul></div>
    </div>` : ''}

    ${designHTML(prd.design)}

    ${prd.ui_note && !prd.design ? `<div class="prd-section">
      <div class="prd-section-label">UI / Style Notes</div>
      <div class="prd-section-value" contenteditable="true" id="prd-ui">${escHtml(prd.ui_note)}</div>
    </div>` : ''}

    ${dataModelHTML ? `<div class="prd-section">
      <div class="prd-section-label">Data Model</div>
      <div class="prd-section-value">${dataModelHTML}</div>
    </div>` : ''}

    ${aiPlanHTML(prd)}

    ${outHTML ? `<div class="prd-section">
      <div class="prd-section-label">Out of Scope (v1)</div>
      <div class="prd-section-value">${outHTML}</div>
    </div>` : ''}

    <div class="prd-actions">
      <button class="btn btn-ghost" onclick="backToQuestions()">Back</button>
      <button class="btn" onclick="triggerScaffold()">${prdHasAI(prd) ? 'Build agents, workflows and app' : 'Build the app'}</button>
    </div>`;
}

const NAV_LABEL = { top: 'Top navigation', sidebar: 'Sidebar', bottom: 'Bottom tab bar', none: 'Single screen' };

// The art director's plan: the concept, palette and signature pieces that make this app look like itself.
function designHTML(d) {
  if (!d || !d.concept) return '';
  const hex = v => /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(v || '') ? v : '';
  const swatches = (p) => p ? ['background', 'card', 'muted', 'primary', 'accent', 'foreground'].filter(k => hex(p[k]))
    .map(k => `<span class="prd-swatch" title="${k} ${escHtml(p[k])}" style="background:${p[k]}"></span>`).join('') : '';
  const meta = [NAV_LABEL[d.navigation], d.heading_font && `${d.heading_font} headings`, d.radius && `${d.radius} corners`, d.density].filter(Boolean).map(escHtml).join(' · ');
  return `<div class="prd-section">
      <div class="prd-section-label">Look &amp; feel</div>
      <div class="prd-section-value prd-design">
        <div class="prd-design-head">
          <div class="prd-swatches">${swatches(d.light)}</div>
          <div class="prd-swatches dark">${swatches(d.dark)}</div>
        </div>
        <p>${escHtml(d.concept)}</p>
        ${d.inspiration ? `<p class="prd-muted">Inspired by ${escHtml(d.inspiration)}</p>` : ''}
        <p class="prd-muted">${meta}</p>
        ${(d.signature || []).length ? `<ul class="prd-edge-list">${d.signature.map(x => `<li>${escHtml(x)}</li>`).join('')}</ul>` : ''}
      </div>
    </div>`;
}

function stackOf(prd) {
  return (builderState.stacks || []).find(st => st.id === prd.stack) || { id: prd.stack, label: prd.stack, ai: true, ui: 'vanilla' };
}

function stackNote(prd) {
  const st = stackOf(prd);
  if (!st.ai) return 'No server, so the app runs fully in the browser without AI workflows.';
  if (st.ui === 'nextjs' || st.ui === 'react') return 'React UI, with a small server route that runs the workflows.';
  return `A ${escHtml(st.label)} server runs the workflows; the UI is HTML, CSS and JavaScript you can grow in the IDE.`;
}

function changeStack(id) {
  builderState.prd.stack = id;
  renderPRD(builderState.prd);
}

function backToQuestions() {
  builderState.qIndex = Math.max(0, builderState.questions.length - 1);
  renderCurrentQuestion();
}

function prdHasAI(prd) {
  return stackOf(prd).ai !== false && !!(prd.ai && Array.isArray(prd.ai.workflows) && prd.ai.workflows.length);
}

// The AI half of the plan: which agents Agent Hub will create and how each workflow chains them.
function aiPlanHTML(prd) {
  if (!prdHasAI(prd)) {
    const why = stackOf(prd).ai === false && prd.ai && (prd.ai.workflows || []).length
      ? `${escHtml(stackOf(prd).label)} has no server to run them, so the planned workflows will be skipped. Pick another stack to keep them.`
      : "This app doesn't need AI, so no agents or workflows will be created.";
    return `<div class="prd-section">
      <div class="prd-section-label">AI agents &amp; workflows</div>
      <div class="prd-section-value prd-muted">${why}</div>
    </div>`;
  }
  const agents = prd.ai.agents || [];
  const nameOf = (key) => (agents.find(a => a.key === key) || { name: key }).name;
  const fields = (o) => Object.keys(o || {}).map(k => `<code>${escHtml(k)}</code>`).join(', ') || '—';
  const chip = k => `<span class="agent">${escHtml(nameOf(k))}</span>`;
  const branchHTML = (b) => `<div class="prd-flow-branch">${[['Yes', b.then], ['No', b.else]].map(([label, keys]) =>
    `<div class="prd-flow-chain"><b>${label}</b><i>→</i>${[...(keys || []).map(chip), '<span>Result</span>'].join('<i>→</i>')}</div>`).join('')}</div>`;
  const flows = prd.ai.workflows.map((w, i) => `
    <div class="prd-flow">
      <div class="prd-flow-head">
        <strong>${escHtml(w.name)}</strong>
        ${w.used_by ? `<span class="prd-flow-use">${escHtml(w.used_by)}</span>` : ''}
        <button class="icon-btn" onclick="removePlannedWorkflow(${i})" title="Don't build this workflow" aria-label="Remove workflow">&times;</button>
      </div>
      <div class="prd-flow-chain">${['<span>Start</span>', ...(w.agents || []).map(chip), ...(w.approval ? ['<span>Approval</span>'] : []),
        w.branch ? `<span class="cond">${escHtml(w.branch.label || `Check ${w.branch.field}`)}</span>` : '<span>Result</span>'].join('<i>→</i>')}</div>
      ${w.branch ? branchHTML(w.branch) : ''}
      ${w.description ? `<div class="prd-flow-desc">${escHtml(w.description)}</div>` : ''}
    </div>`).join('');
  const used = new Set(prd.ai.workflows.flatMap(flowAgents));
  const agentRows = agents.filter(a => used.has(a.key)).map(a => `
    <div class="prd-agent" title="${escHtml(a.instructions || '')}">
      <strong>${escHtml(a.name)}</strong>
      <span>${escHtml(a.purpose || '')}</span>
      <small>In: ${fields(a.input)} &nbsp;·&nbsp; Out: ${fields(a.output)}</small>
    </div>`).join('');
  return `<div class="prd-section">
    <div class="prd-section-label">AI agents &amp; workflows <span class="prd-muted">Created in Agent Hub, where you can edit them later</span></div>
    <div class="prd-section-value">${flows}<div class="prd-agents">${agentRows}</div></div>
  </div>`;
}

// Every agent a workflow can run, on either side of its branch.
function flowAgents(w) {
  return [...(w.agents || []), ...(w.branch ? [...(w.branch.then || []), ...(w.branch.else || [])] : [])];
}

function removePlannedWorkflow(i) {
  const ai = builderState.prd.ai;
  ai.workflows.splice(i, 1);
  const used = new Set(ai.workflows.flatMap(flowAgents));
  ai.agents = (ai.agents || []).filter(a => used.has(a.key));
  renderPRD(builderState.prd);
}

// ── Step 3: Building ─────────────────────────

async function triggerScaffold() {
  // Capture any inline edits
  const usersEl = document.getElementById('prd-users');
  const uiEl = document.getElementById('prd-ui');
  if (usersEl) builderState.prd.target_users = usersEl.textContent.trim();
  const visionEl = document.getElementById('prd-vision');
  const loopEl = document.getElementById('prd-loop');
  if (visionEl) builderState.prd.vision = visionEl.textContent.trim();
  if (loopEl) builderState.prd.core_loop = loopEl.textContent.trim();
  if (uiEl) builderState.prd.ui_note = uiEl.textContent.trim();

  setBuilderStep(3);
  document.getElementById('builderHeaderTitle').textContent = `Building ${builderState.prd.name}…`;
  document.getElementById('builderHeaderSub').textContent = prdHasAI(builderState.prd) ? 'Creating agents and workflows, then generating the app' : 'Generating code and spinning up sandbox';

  document.getElementById('builderBody').innerHTML = `
    <div class="build-progress-log" id="buildLog">Starting scaffolder…
</div>
    <div class="build-ready-banner" id="buildReadyBanner">
      <div class="build-ready-icon"></div>
      <div class="build-ready-text">
        <div class="build-ready-title" id="buildReadyTitle">App is ready!</div>
        <div class="build-ready-sub" id="buildReadySub"></div>
      </div>
      <a class="btn btn-ghost" id="openHubBtn" href="/hub.html#workflows" hidden>View workflows</a>
      <button class="btn" id="openIDEBtn" onclick="openBuiltApp()">Open IDE</button>
    </div>`;

  try {
    // Agents and workflows come first, so the generated code is written against workflows that already exist.
    let workflows = [];
    if (prdHasAI(builderState.prd)) {
      const ai = builderState.prd.ai;
      appendBuildLog(`Creating ${ai.workflows.length} workflow(s) and their agents in Agent Hub…`);
      const hubRes = await fetch('/agent/hub/blueprint', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ app: builderState.prd.name, agents: ai.agents, workflows: ai.workflows }),
      });
      const hub = await hubRes.json();
      if (!hubRes.ok) throw new Error(hub.error || 'Agent Hub could not create the agents');
      hub.agents.forEach(a => appendBuildLog(`Agent created: ${a.name}`, 'success'));
      hub.workflows.forEach(w => appendBuildLog(`Workflow created: ${w.name}, with a webhook token for the app`, 'success'));
      builderState.hub = hub;
      workflows = hub.workflows;
      document.getElementById('openHubBtn').hidden = false;
    }
    appendBuildLog('Generating the app…');
    const res = await fetch('/build/scaffold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prd: builderState.prd, workflows }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Scaffold failed');

    builderState.container = data.container;
    builderState.buildId = data.build_id;
    builderState.url = data.url;

    appendBuildLog('Scaffold request accepted. Generating code…');
    pollBuildStatus();
    pollBuildLogs();
    loadBuildHistory();
  } catch (err) {
    appendBuildLog('Error: ' + err.message, 'error');
    toast('Build failed: ' + err.message, 'error');
    // The window must not keep saying "Building" once nothing is running.
    document.getElementById('builderHeaderTitle').textContent = `${builderState.prd.name} was not built`;
    document.getElementById('builderHeaderSub').textContent = err.message;
    const banner = document.getElementById('buildReadyBanner');
    if (banner) {
      banner.classList.add('show');
      document.getElementById('buildReadyTitle').textContent = 'The build stopped before the app was created';
      document.getElementById('buildReadySub').textContent = /agents|workflows/.test(err.message) ? 'Agent Hub is full: delete agents or workflows you no longer need, then build again.' : 'Go back to the PRD and try again.';
      const open = document.getElementById('openIDEBtn');
      if (open) { open.textContent = 'Back to PRD'; open.onclick = () => renderPRD(builderState.prd); }
      const hub = document.getElementById('openHubBtn');
      if (hub && /agents|workflows/.test(err.message)) hub.hidden = false;
    }
  }
}

function appendBuildLog(msg, type = '') {
  const logEl = document.getElementById('buildLog');
  if (!logEl) return;
  const now = new Date().toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  logEl.innerHTML += `<div class="build-log-line ${type}"><span class="build-log-time">${now}</span><span class="build-log-msg">${escHtml(msg)}</span></div>`;
  logEl.scrollTop = logEl.scrollHeight;
}

let buildPollTimer = null;
let logPollTimer = null;
let lastLogLen = 0;

function pollBuildStatus() {
  buildPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/sandbox/status?container=${builderState.container}`);
      if (!res.ok) return;
      const d = await res.json();
      if (d.status === 'failed' || d.stage === 'failed') {
        clearInterval(buildPollTimer);
        clearInterval(logPollTimer);
        appendBuildLog(`The app failed to start: ${d.detail || d.error || 'see the logs above'}`, 'error');
        document.getElementById('builderHeaderTitle').textContent = `${builderState.prd.name} did not start`;
        document.getElementById('builderHeaderSub').textContent = 'Open the IDE to read the logs and fix it with the coding agent';
        const banner = document.getElementById('buildReadyBanner');
        if (banner) {
          banner.classList.add('show');
          document.getElementById('buildReadyTitle').textContent = 'Build finished with errors';
          document.getElementById('buildReadySub').textContent = 'The code is there; open it in the IDE to fix it.';
        }
        return;
      }
      if (d.status === 'running') {
        clearInterval(buildPollTimer);
        clearInterval(logPollTimer);
        setBuilderStep(4);
        document.getElementById('builderHeaderTitle').textContent = `${builderState.prd.name} is Live!`;
        document.getElementById('builderHeaderSub').textContent = d.url;
        const banner = document.getElementById('buildReadyBanner');
        if (banner) {
          banner.classList.add('show');
          document.getElementById('buildReadySub').textContent = d.url;
        }
        loadSandboxes();
        loadBuildHistory();
        watchBuildPush(builderState.buildId);
        toast(`${builderState.prd.name} is ready!`, 'success');
      }
    } catch (_) { }
  }, 3000);
}

// Build mode pushes the finished app to the user's GitHub in the background; this shows where it went.
async function watchBuildPush(buildId) {
  const banner = document.getElementById('buildReadyBanner');
  if (!banner || !buildId) return;
  let slot = document.getElementById('buildGitHub');
  if (!slot) {
    slot = document.createElement('div');
    slot.id = 'buildGitHub';
    slot.className = 'build-github';
    banner.after(slot);
  }
  const mark = '<svg width="15" height="15" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>';
  for (let i = 0; i < 80; i++) {
    let rec = null;
    try { rec = (await (await fetch('/build/history')).json()).find(r => r.id === buildId); } catch { /* try again */ }
    const st = rec && rec.githubStatus;
    if (!st && i > 3) { slot.remove(); return; }
    if (st === 'pushing') slot.innerHTML = `${mark}<span>Pushing the code to your GitHub…</span>`;
    if (st === 'pushed') {
      slot.innerHTML = `${mark}<span>Pushed to <b>${escHtml(rec.github.replace('https://github.com/', ''))}</b> with a README</span><a class="btn btn-sm" href="${escHtml(rec.github)}" target="_blank" rel="noopener">View on GitHub</a>`;
      return;
    }
    if (st === 'failed') {
      slot.innerHTML = `${mark}<span>Not pushed to GitHub: ${escHtml(rec.githubError || 'unknown error')}. Publish it from the IDE's Source Control view.</span>`;
      slot.classList.add('error');
      return;
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

function pollBuildLogs() {
  logPollTimer = setInterval(async () => {
    try {
      const res = await fetch(`/logs/${builderState.container}`);
      if (!res.ok) return;
      const text = await res.text();
      const lines = text.split('\n').filter(l => l.trim());
      for (let i = lastLogLen; i < lines.length; i++) {
        const line = lines[i];
        const type = line.includes('Error') || line.includes('failed') ? 'error'
          : line.includes('ready') || line.includes('Ready') ? 'success' : '';
        appendBuildLog(line.replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, ''), type);
      }
      lastLogLen = lines.length;
    } catch (_) { }
  }, 2000);
}

function openBuiltApp() {
  if (!builderState.container) return;
  closeBuilder();
  setTimeout(() => {
    initIDE(builderState.container, `generated:${builderState.prd.name}`, '');
  }, 150);
}

// ── Build History ─────────────────────────────

async function loadBuildHistory() {
  try {
    const res = await fetch('/build/history');
    if (!res.ok) return;
    const records = await res.json();
    if (!Array.isArray(records) || records.length === 0) return;

    document.getElementById('buildHistoryCard').hidden = false;
    document.getElementById('buildHistoryCount').textContent = records.length;

    const list = document.getElementById('buildHistoryList');
    list.innerHTML = records.map(r => {
      const statusDot = r.status === 'ready' ? 'build-status-dot-ready'
        : r.status === 'error' ? 'build-status-dot-error'
          : 'build-status-dot-building';
      const timeAgo = formatTimeAgo(r.createdAt);
      return `
        <div class="build-history-item">
          <div class="build-history-icon"><svg style="vertical-align:middle" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/></svg></div>
          <div class="build-history-info">
            <div class="build-history-name">${escHtml(r.appName || 'Untitled App')}</div>
            <div class="build-history-meta">${timeAgo} · ${escHtml(r.status)}</div>
          </div>
          <div class="${statusDot}"></div>
          ${r.github ? `<a class="btn btn-sm btn-ghost" href="${escHtml(r.github)}" target="_blank" rel="noopener" title="${escHtml(r.github)}">GitHub</a>` : ''}
          ${r.status === 'ready' && r.container ? `
            <button class="btn btn-sm" onclick="initIDE('${r.container}','generated:${escHtml(r.appName)}','')">
              IDE
            </button>` : ''}
        </div>`;
    }).join('');
  } catch (_) { }
}

function formatTimeAgo(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  const secs = Math.floor((Date.now() - d) / 1000);
  if (secs < 60) return 'just now';
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  if (secs < 172800) return 'yesterday';
  return d.toLocaleDateString();
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Agent Hub summary on the home page: counts, the latest few items, and shortcuts into the Hub windows.
function openHubWindow(url) {
  location.href = url;
}

async function loadHubSummary() {
  try {
    const [a, f] = await Promise.all([fetch('/agent/hub/agents').then(r => r.json()), fetch('/agent/hub/workflows').then(r => r.json())]);
    const agents = a.agents || [];
    const flows = f.workflows || [];
    document.getElementById('hubAgentCount').textContent = agents.length;
    document.getElementById('hubFlowCount').textContent = flows.length;
    document.getElementById('hubAgentWord').textContent = agents.length === 1 ? 'agent' : 'agents';
    document.getElementById('hubFlowWord').textContent = flows.length === 1 ? 'workflow' : 'workflows';
    const recent = [
      ...agents.map(x => ({ kind: 'Agent', name: x.definition.identity.name, at: x.updatedAt, url: `/studio.html?agent=${encodeURIComponent(x.definition.id)}` })),
      ...flows.map(x => ({ kind: 'Workflow', name: x.name, at: x.updatedAt, url: `/flows.html?id=${encodeURIComponent(x.id)}` })),
    ].sort((x, y) => y.at - x.at).slice(0, 4);
    const box = document.getElementById('hubRecent');
    box.innerHTML = recent.length
      ? recent.map(r => `<button class="hub-recent-item" data-url="${escHtml(r.url)}"><span class="hub-kind">${r.kind}</span>${escHtml(r.name)}<small>${new Date(r.at).toLocaleDateString()}</small></button>`).join('')
      : '<div class="hub-card-lead" style="margin:0">Nothing yet. Start with an agent: describe what it should do in plain English.</div>';
    box.querySelectorAll('[data-url]').forEach(b => b.addEventListener('click', () => openHubWindow(b.dataset.url)));
  } catch {
    document.getElementById('hubRecent').innerHTML = '<div class="hub-card-lead" style="margin:0">The agent service is starting; refresh in a moment.</div>';
  }
}

// ?mode=build and ?open=saved come from the rail on other pages.
async function initHome() {
  initLocalUpload();
  const q = new URLSearchParams(location.search);
  await loadProjects();
  if (q.get('mode') === 'run') setMode('prompt');
  else if (q.get('mode') === 'code' || q.get('github') || q.get('github_error')) setMode('dev');
  else setMode('build');
  if (q.get('open') === 'saved') setTimeout(() => document.getElementById('work').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  greet();
  if (typeof mountRepoPicker === 'function') mountRepoPicker(document.getElementById('gh-picker'), openGitHubRepo);
  if (q.get('open') === 'repo') {
    let pick = null;
    try { pick = JSON.parse(sessionStorage.getItem('jr-open-repo') || 'null'); sessionStorage.removeItem('jr-open-repo'); } catch { /* storage blocked */ }
    if (pick && /^https:\/\/github\.com\//.test(pick.url || '')) openGitHubRepo(pick.url, pick.branch || '');
  }
  if (q.toString()) history.replaceState(null, '', '/');
  if (window.jrKeyBanner) jrKeyBanner(document.getElementById('keyBanner'));
}

initHome();
loadHubSummary();
window.addEventListener('focus', loadHubSummary);
loadSandboxes();
loadBuildHistory();
setInterval(loadSandboxes, 5000);
setInterval(loadBuildHistory, 10000);
