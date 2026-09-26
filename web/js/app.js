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
let currentMode = 'prompt';

function setMode(mode) {
  currentMode = mode;
  document.querySelectorAll('.mode-option').forEach(el => {
    el.classList.toggle('active', el.dataset.mode === mode);
  });
  // Show/hide the correct input section
  const repoSection = document.getElementById('repoSection');
  const buildSection = document.getElementById('buildSection');
  const runStatus = document.getElementById('runStatus');
  if (mode === 'build') {
    repoSection.style.display = 'none';
    buildSection.style.display = 'block';
    runStatus.className = 'status-bar';
    runStatus.innerHTML = '';
  } else {
    repoSection.style.display = 'block';
    buildSection.style.display = 'none';
  }
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
let repoState = { container: null, repo: '', plan: null, mode: 'prompt' };

async function runSandbox() {
  const repo = document.getElementById('repoInput').value.trim();
  if (!repo) {
    document.getElementById('repoInput').focus();
    return;
  }

  const instructionsEl = document.getElementById('instructionsInput');
  const instructions = instructionsEl ? instructionsEl.value.trim() : '';

  const btn = document.getElementById('runBtn');
  btn.disabled = true;
  btn.closest('.card').classList.add('loading');
  setRunStatus('loading', '', `Cloning <strong>${escHtml(repo)}</strong> and looking for services…`);

  try {
    const res = await fetch(`${API}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ repo, instructions, mode: currentMode }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Unknown error');

    repoState = { container: data.container, repo, plan: null, mode: data.mode || currentMode };
    await waitForPlan(data.container);
  } catch (err) {
    setRunStatus('error', '', `<strong>Error:</strong> ${escHtml(err.message)}`);
    toast(err.message, 'error');
    btn.disabled = false;
    btn.closest('.card').classList.remove('loading');
  }
}

// The clone runs server-side, so poll until the scan produces something to approve.
async function waitForPlan(container) {
  for (let i = 0; i < 150; i++) {
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
  const btn = document.getElementById('runBtn');
  btn.disabled = false;
  btn.closest('.card').classList.remove('loading');

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
    in ${escHtml(repoState.repo)}
    <div class="svc-list">${rows}</div>
    <div class="svc-image"><span>Image</span><code>${escHtml(plan.image)}</code></div>
    ${buildNote}
    <div class="link-row" style="margin-top:10px;">
      <button class="btn btn-sm btn-ghost" onclick="cancelApproval()">Cancel</button>
      <button class="btn btn-sm btn-success" onclick="approveRun()">Approve &amp; Build</button>
    </div>
  `);
}

function cancelApproval() {
  if (repoState.container) fetch(`${API}/stop/${repoState.container}`, { method: 'POST' }).catch(() => {});
  repoState = { container: null, repo: '', plan: null, mode: 'prompt' };
  const bar = document.getElementById('runStatus');
  bar.className = 'status-bar';
  bar.innerHTML = '';
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
    // Only sent when actually edited, so the install/start split the scanner
    // worked out survives untouched rows.
    if (cmd !== original) {
      edit.install = '';
      edit.start = cmd;
    }
    return edit;
  });
}

async function approveRun() {
  const plan = repoState.plan;
  if (!plan) return;
  const edits = collectEdits(plan);
  if (!edits.some(e => e.enabled)) {
    toast('Enable at least one service', 'error');
    return;
  }

  const n = edits.filter(e => e.enabled).length;
  setRunStatus('loading', '', `Building and starting ${n} service${n === 1 ? '' : 's'}…
    <div class="link-row" style="margin-top:8px;">
      <button class="btn btn-sm btn-ghost" onclick="viewLogs('${repoState.container}')">Logs</button>
    </div>`);

  try {
    const res = await fetch(`${API}/run/approve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ container: repoState.container, services: edits }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'approval failed');
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

    if (d.status === 'failed' || d.status === 'exited' || d.status === 'dead') {
      setRunStatus('error', '', `<strong>Failed:</strong> ${escHtml(d.error || 'see the logs')}
        <div class="link-row" style="margin-top:8px;">
          <button class="btn btn-sm btn-ghost" onclick="viewLogs('${container}')">Logs</button>
        </div>`);
      toast('Sandbox failed to start', 'error');
      return;
    }

    // Dev Mode opens the IDE as soon as the container is up rather than waiting for
    // the port to answer: an install takes minutes, and the IDE has its own
    // "starting your app" state to sit in meanwhile.
    if (repoState.mode === 'dev' && (d.status === 'running' || d.status === 'starting')) {
      setRunStatus('success', '', `<strong>Sandbox is live!</strong> Opening IDE...`);
      toast('Sandbox launched — opening IDE!');
      initIDE(container, repoState.repo, d.port);
      loadSandboxes();
      return;
    }
    if (d.status !== 'running') continue;

    {
      const links = (d.services || []).filter(s => s.url).map(s =>
        `<a class="sandbox-link" href="${s.url}" target="_blank" rel="noopener">${escHtml(s.name)} ${escHtml(s.url)}</a>`
      ).join('');
      setRunStatus('success', '', `
        <strong>Sandbox is live!</strong><br>
        <div class="link-row" style="margin-top:8px;">
          ${links}
          <button class="btn btn-sm btn-ghost" onclick="viewLogs('${container}')">Logs</button>
          <button class="btn btn-sm btn-success" onclick="initIDE('${container}','${escHtml(repoState.repo)}', '${d.port}')">Open IDE</button>
        </div>
        <small style="color:var(--text3); display:block; margin-top:6px;">Auto-destroys in 10 min -- Container: ${container}</small>
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

    if (items.length === 0) {
      list.innerHTML = `
        <div class="empty-state">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
          <p>No active sandboxes</p>
        </div>`;
      return;
    }

    list.innerHTML = items.map(sb => {
      // Nothing is listening before approval, so Open/IDE would lead nowhere.
      const pending = ['detecting', 'awaiting-approval', 'building', 'failed'].includes(sb.status);
      const open = pending ? '' : `
          ${sb.url ? `<a class="btn btn-sm btn-ghost" href="${escHtml(sb.url)}" target="_blank" rel="noopener">Open ↗</a>` : ''}
          <button class="btn btn-sm btn-success" onclick="initIDE('${sb.container}','${sb.repo}', '${sb.port}')">IDE</button>`;
      return `
      <div class="sandbox-item">
        <div class="status-dot${pending ? ' pending' : ''}"></div>
        <div class="sandbox-info">
          <div class="sandbox-name">${sb.container}</div>
          <div class="sandbox-repo">${sb.repo}</div>
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

document.getElementById('repoInput').addEventListener('keydown', e => {
  if (e.key === 'Enter') runSandbox();
});

// ════════════════════════════════════════════
//  BUILD MODE — Multi-step state machine
// ════════════════════════════════════════════

let builderState = {
  step: 1,            // 1=Q&A, 2=PRD, 3=Building, 4=Launch
  prompt: '',
  questions: [],
  qIndex: 0,
  answers: {},
  freetextAnswers: {},
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
  builderState = { step: 1, prompt, questions: [], qIndex: 0, answers: {}, freetextAnswers: {}, prd: null, container: null, buildId: null, url: null };
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
      <div style="font-size:13px;">Analyzing your idea with Groq AI…</div>
    </div>`;
}

function renderCurrentQuestion() {
  const qs = builderState.questions;
  const i = builderState.qIndex;
  const q = qs[i];
  if (!q) { submitAnswers(); return; }

  setBuilderStep(1);
  document.getElementById('builderHeaderTitle').textContent = 'Quick Questions';
  document.getElementById('builderHeaderSub').textContent = 'Help us understand what you need';

  const pct = Math.round((i / qs.length) * 100);
  const hasOptions = q.options && q.options.length > 0;

  // Build chips HTML
  let chipsHTML = '';
  if (hasOptions) {
    chipsHTML = `
      <div class="qa-chips" id="qaChips">
        ${q.options.map(opt => {
          const saved = builderState.answers[q.id] || '';
          const isSelected = saved.split('|||').map(s => s.trim()).includes(opt);
          return `<div class="qa-chip${isSelected ? ' selected' : ''}" data-value="${escHtml(opt)}" onclick="toggleChip(this, ${q.multi})">${escHtml(opt)}</div>`;
        }).join('')}
      </div>
      <span class="qa-freetext-toggle" onclick="toggleFreetext()"><svg style="vertical-align:middle" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg> Something else in mind?</span>
      <div class="qa-freetext-area" id="qaFreetextArea">
        <textarea id="qaAnswer" class="qa-input" rows="2"
          placeholder="Type your own answer…">${builderState.freetextAnswers?.[q.id] || ''}</textarea>
      </div>`;
  } else {
    // No options — fall back to pure textarea
    chipsHTML = `<textarea id="qaAnswer" class="qa-input" rows="3"
      placeholder="Your answer… (press Enter to continue, Tab to skip)">${builderState.answers[q.id] || ''}</textarea>`;
  }

  document.getElementById('builderBody').innerHTML = `
    <div class="qa-question-label">Question ${i + 1} of ${qs.length}</div>
    <div class="qa-progress">
      <div class="qa-progress-bar"><div class="qa-progress-fill" style="width:${pct}%"></div></div>
    </div>
    <div class="qa-question-text">${escHtml(q.text)}</div>
    ${chipsHTML}
    <div class="qa-nav" style="margin-top:16px;">
      ${i > 0 ? `<button class="btn btn-ghost" onclick="qaBack()">← Back</button>` : ''}
      <button class="btn" style="background:#6B3E1A;" onclick="qaNext()">
        ${i < qs.length - 1 ? 'Next →' : 'Generate PRD →'}
      </button>
      <button class="btn btn-ghost" style="margin-left:auto;" onclick="qaSkip()">Skip</button>
    </div>`;

  // For pure textarea mode — attach keyboard shortcuts
  const ta = document.getElementById('qaAnswer');
  if (ta && !hasOptions) {
    ta.focus();
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); qaNext(); }
      if (e.key === 'Tab') { e.preventDefault(); qaSkip(); }
    });
  }
}

function toggleChip(el, multi) {
  if (!multi) {
    // Single select — deselect all others
    document.querySelectorAll('#qaChips .qa-chip').forEach(c => c.classList.remove('selected'));
  }
  el.classList.toggle('selected');
}

function toggleFreetext() {
  const area = document.getElementById('qaFreetextArea');
  if (area) {
    area.classList.toggle('show');
    if (area.classList.contains('show')) {
      const ta = area.querySelector('textarea');
      if (ta) ta.focus();
    }
  }
}

function collectCurrentAnswer(q) {
  const hasOptions = q.options && q.options.length > 0;
  if (hasOptions) {
    // Collect selected chips
    const chips = document.querySelectorAll('#qaChips .qa-chip.selected');
    const chipAnswers = Array.from(chips).map(c => c.dataset.value).filter(Boolean);
    // Also collect any free-text
    const ta = document.getElementById('qaAnswer');
    const freeText = ta ? ta.value.trim() : '';
    // Merge: chips first, then freetext if provided
    const parts = [...chipAnswers];
    if (freeText) parts.push(freeText);
    // Save freetext separately so Back can restore it
    if (!builderState.freetextAnswers) builderState.freetextAnswers = {};
    builderState.freetextAnswers[q.id] = freeText;
    return parts.join(', ');
  } else {
    const ta = document.getElementById('qaAnswer');
    return ta ? ta.value.trim() : '';
  }
}

function qaNext() {
  const q = builderState.questions[builderState.qIndex];
  if (q) builderState.answers[q.id] = collectCurrentAnswer(q);
  builderState.qIndex++;
  renderCurrentQuestion();
}

function qaBack() {
  if (builderState.qIndex > 0) builderState.qIndex--;
  renderCurrentQuestion();
}

function qaSkip() {
  builderState.qIndex++;
  renderCurrentQuestion();
}

// ── Step 2: PRD ──────────────────────────────

async function submitAnswers() {
  setBuilderStep(2);
  document.getElementById('builderHeaderTitle').textContent = 'Generating PRD…';
  document.getElementById('builderHeaderSub').textContent = 'Crafting your product requirements';
  document.getElementById('builderBody').innerHTML = `
    <div style="text-align:center;padding:40px 0;color:var(--text3);">
      <div style="font-size:32px;margin-bottom:12px;animation:spin 1s linear infinite;display:inline-block;"><svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg></div>
      <div style="font-size:13px;">Synthesizing your answers into a PRD…</div>
    </div>`;

  try {
    const res = await fetch('/build/prd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt: builderState.prompt, answers: builderState.answers }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'PRD generation failed');
    builderState.prd = data.prd;
    renderPRD(data.prd);
  } catch (err) {
    toast('Error: ' + err.message, 'error');
    closeBuilder();
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
      <div class="prd-section-label">Target Users</div>
      <div class="prd-section-value" contenteditable="true" id="prd-users">${escHtml(prd.target_users || '')}</div>
    </div>

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

    ${prd.ui_note ? `<div class="prd-section">
      <div class="prd-section-label">UI / Style Notes</div>
      <div class="prd-section-value" contenteditable="true" id="prd-ui">${escHtml(prd.ui_note)}</div>
    </div>` : ''}

    ${dataModelHTML ? `<div class="prd-section">
      <div class="prd-section-label">Data Model</div>
      <div class="prd-section-value">${dataModelHTML}</div>
    </div>` : ''}

    ${outHTML ? `<div class="prd-section">
      <div class="prd-section-label">Out of Scope (v1)</div>
      <div class="prd-section-value">${outHTML}</div>
    </div>` : ''}

    <div style="display:flex;gap:10px;margin-top:8px;">
      <button class="btn btn-ghost" onclick="() => { builderState.qIndex = builderState.questions.length - 1; renderCurrentQuestion(); }">← Back</button>
      <button class="btn" style="background:#6B3E1A;box-shadow:0 4px 16px rgba(107,62,26,0.4);"
        onclick="triggerScaffold()">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5">
          <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/>
        </svg>
        Build it!
      </button>
    </div>`;
}

// ── Step 3: Building ─────────────────────────

async function triggerScaffold() {
  // Capture any inline edits
  const usersEl = document.getElementById('prd-users');
  const uiEl = document.getElementById('prd-ui');
  if (usersEl) builderState.prd.target_users = usersEl.textContent.trim();
  if (uiEl) builderState.prd.ui_note = uiEl.textContent.trim();

  setBuilderStep(3);
  document.getElementById('builderHeaderTitle').textContent = `Building ${builderState.prd.name}…`;
  document.getElementById('builderHeaderSub').textContent = 'Generating code and spinning up sandbox';

  document.getElementById('builderBody').innerHTML = `
    <div class="build-progress-log" id="buildLog">Starting scaffolder…
</div>
    <div class="build-ready-banner" id="buildReadyBanner">
      <div class="build-ready-icon"></div>
      <div class="build-ready-text">
        <div class="build-ready-title" id="buildReadyTitle">App is ready!</div>
        <div class="build-ready-sub" id="buildReadySub"></div>
      </div>
      <button class="btn" style="background:#6B3E1A;"
        id="openIDEBtn" onclick="openBuiltApp()">
        Open IDE →
      </button>
    </div>`;

  try {
    const res = await fetch('/build/scaffold', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prd: builderState.prd }),
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
        toast(`${builderState.prd.name} is ready!`, 'success');
      }
    } catch (_) { }
  }, 3000);
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

    document.getElementById('buildHistoryCard').style.display = '';
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
          ${r.status === 'ready' && r.container ? `
            <button class="btn btn-sm btn-success" onclick="initIDE('${r.container}','generated:${escHtml(r.appName)}','')">
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
  return `${Math.floor(secs / 3600)}h ago`;
}

function escHtml(s) {
  if (!s) return '';
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Initial load
loadSandboxes();
loadBuildHistory();
setInterval(loadSandboxes, 5000);
setInterval(loadBuildHistory, 10000);
