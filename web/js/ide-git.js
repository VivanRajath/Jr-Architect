// IDE Source Control: the workspace's git state, pull, commit and push, pull requests, and publishing a new repo.
const SCM = { state: null, account: null, connected: false, oauth: false, busy: false, timer: null, view: 'explorer', note: null };

function showSidebarView(view) {
  const sb = document.querySelector('.ide-sidebar');
  if (!sb) return;
  const open = !sb.classList.contains('collapsed');
  if (open && SCM.view === view) {
    toggleSidebar(document.getElementById(view === 'scm' ? 'act-scm' : 'act-explorer'));
    document.getElementById('act-scm').classList.remove('active');
    document.getElementById('act-explorer').classList.remove('active');
    stopScmPolling();
    return;
  }
  if (!open) toggleSidebar(null);
  SCM.view = view;
  document.getElementById('sb-explorer').hidden = view !== 'explorer';
  document.getElementById('sb-scm').hidden = view !== 'scm';
  document.getElementById('act-explorer').classList.toggle('active', view === 'explorer');
  document.getElementById('act-scm').classList.toggle('active', view === 'scm');
  if (view === 'scm') {
    scmRefresh(false);
    startScmPolling();
  } else {
    stopScmPolling();
  }
}

function startScmPolling() {
  stopScmPolling();
  SCM.timer = setInterval(() => { if (!document.hidden && !SCM.busy) scmRefresh(false, true); }, 20000);
}

function stopScmPolling() {
  if (SCM.timer) clearInterval(SCM.timer);
  SCM.timer = null;
}

// Called when the IDE opens a sandbox: resets state and fills in the status-bar branch.
function scmInit() {
  SCM.state = null;
  SCM.note = null;
  SCM.view = 'explorer';
  document.getElementById('sb-explorer').hidden = false;
  document.getElementById('sb-scm').hidden = true;
  document.getElementById('act-scm').classList.remove('active');
  stopScmPolling();
  setTimeout(() => scmRefresh(false, true), 4000);
}

async function scmRefresh(fetchRemote, quiet = false) {
  if (!IDE.container) return;
  const body = document.getElementById('scm-body');
  if (!quiet && !SCM.state && body) body.innerHTML = '<div class="scm-empty">Reading the repository…</div>';
  try {
    const d = await ghJSON(`/github/sync?container=${encodeURIComponent(IDE.container)}${fetchRemote ? '&fetch=1' : ''}`);
    SCM.state = d.state;
    SCM.connected = d.connected;
    SCM.account = d.account || null;
    SCM.oauth = d.oauth;
    SCM.isBuild = /^generated:/.test(IDE.repoUrl || '');
    if (SCM.collaborator === undefined && d.connected) {
      try { SCM.collaborator = (await ghJSON('/github/prefs')).collaborator || ''; } catch { SCM.collaborator = ''; }
    }
    if (fetchRemote && !quiet) SCM.note = { ok: true, text: d.state.behind ? `GitHub has ${d.state.behind} new commit(s). Pull to get them.` : 'Up to date with GitHub.' };
  } catch (e) {
    if (!quiet) SCM.note = { ok: false, text: e.message };
  }
  renderScm();
  renderScmBadge();
}

function renderScmBadge() {
  const st = SCM.state;
  const badge = document.getElementById('scm-badge');
  const name = document.getElementById('statusbar-branch-name');
  if (!st || !st.repo) {
    if (badge) badge.hidden = true;
    if (name) name.textContent = 'no git';
    return;
  }
  if (name) {
    const sync = (st.ahead ? ` ↑${st.ahead}` : '') + (st.behind ? ` ↓${st.behind}` : '');
    name.textContent = (st.branch || 'detached') + sync + (st.changes.length ? ` · ${st.changes.length} changed` : '');
  }
  if (badge) {
    badge.hidden = !st.changes.length;
    badge.textContent = st.changes.length > 99 ? '99+' : st.changes.length;
  }
}

const SCM_LETTER = { modified: 'M', added: 'A', deleted: 'D', renamed: 'R', conflict: '!' };

function renderScm() {
  const body = document.getElementById('scm-body');
  if (!body || SCM.view !== 'scm') return;
  const st = SCM.state;
  const note = SCM.note ? `<div class="scm-note ${SCM.note.ok ? 'ok' : 'err'}">${SCM.note.html || ghEsc(SCM.note.text)}</div>` : '';
  if (!st) {
    body.innerHTML = note || '<div class="scm-empty">Reading the repository…</div>';
    return;
  }
  if (!SCM.connected) {
    body.innerHTML = `${note}${scmSummaryHTML(st)}
      <div class="scm-card"><p class="scm-p">Connect GitHub to pull, commit and push${st.github ? ` to <b>${ghEsc(st.github)}</b>` : ''}. ${SCM.oauth ? 'Connecting with GitHub takes you back to Home; this sandbox keeps running and stays under Running now.' : ''}</p>
      ${ghConnectHTML({ oauth: SCM.oauth }, { compact: true })}</div>`;
    ghWireConnect(body, () => { SCM.note = { ok: true, text: 'GitHub connected.' }; scmRefresh(false); }, '/');
    return;
  }
  if (!st.repo || !st.github) {
    body.innerHTML = `${note}${st.repo ? scmSummaryHTML(st) : ''}${scmPublishHTML(st)}`;
    wirePublish(body);
    return;
  }
  const changes = st.changes.length ? st.changes.map((c) => `
      <button class="scm-file" type="button" data-path="${ghEsc(c.path)}" ${c.status === 'deleted' ? 'disabled' : ''} title="${ghEsc(c.path)}">
        <span class="scm-file-name">${ghEsc(c.path.split('/').pop())}</span>
        <span class="scm-file-dir">${ghEsc(c.path.includes('/') ? c.path.slice(0, c.path.lastIndexOf('/')) : '')}</span>
        <span class="scm-letter ${c.status}">${SCM_LETTER[c.status] || 'M'}</span>
      </button>`).join('') : '<div class="scm-empty">No changes. Edits you or the coding agent make show up here.</div>';
  const conflicts = st.changes.some((c) => c.status === 'conflict');
  const canPush = SCM.account && SCM.account.canPush;
  body.innerHTML = `${note}${scmSummaryHTML(st)}
    <div class="scm-actions">
      <button class="scm-btn" type="button" data-act="pull" ${SCM.busy ? 'disabled' : ''} title="Bring in commits from GitHub">Pull${st.behind ? ` ↓${st.behind}` : ''}</button>
      <button class="scm-btn" type="button" data-act="fetch" ${SCM.busy ? 'disabled' : ''} title="Check GitHub for new commits">Fetch</button>
    </div>
    <div class="scm-commit">
      <textarea id="scm-message" rows="2" placeholder="Commit message (Ctrl+Enter to commit and push)" ${st.changes.length ? '' : 'disabled'}>${ghEsc(SCM.draft || '')}</textarea>
      <label class="scm-check"><input type="checkbox" id="scm-newbranch" ${SCM.newBranch ? 'checked' : ''}> Push to a new branch</label>
      <div class="scm-branch-opts" ${SCM.newBranch ? '' : 'hidden'}>
        <input id="scm-branch" type="text" spellcheck="false" placeholder="jr/my-change" value="${ghEsc(SCM.branchName || defaultBranchName())}">
        <label class="scm-check"><input type="checkbox" id="scm-pr" ${SCM.openPR !== false ? 'checked' : ''}> Open a pull request</label>
      </div>
      <button class="scm-btn scm-primary" type="button" data-act="push" ${SCM.busy || conflicts || !canPush || (!st.changes.length && !st.ahead && !SCM.newBranch) ? 'disabled' : ''}>
        ${st.changes.length ? `Commit &amp; push ${st.changes.length} file${st.changes.length === 1 ? '' : 's'}` : st.ahead ? `Push ${st.ahead} commit${st.ahead === 1 ? '' : 's'}` : 'Push'}
      </button>
      ${canPush ? '' : '<p class="scm-p">Your GitHub connection is read-only. Reconnect it in Settings with the <code>repo</code> scope to push.</p>'}
      ${conflicts ? '<p class="scm-p">Resolve the conflicted files in the terminal before pushing.</p>' : ''}
    </div>
    <div class="scm-section">Changes <span>${st.changes.length}</span></div>
    <div class="scm-files">${changes}</div>`;
  wireScm(body);
}

function scmSummaryHTML(st) {
  const repo = st.github ? `<a href="https://github.com/${ghEsc(st.github)}" target="_blank" rel="noopener">${ghEsc(st.github)}</a>` : '<span>Local repository</span>';
  const sync = st.upstream ? `<span class="scm-sync">${st.ahead ? `↑${st.ahead}` : ''} ${st.behind ? `↓${st.behind}` : ''}${!st.ahead && !st.behind ? 'in sync' : ''}</span>` : '';
  return `<div class="scm-summary">
    <div class="scm-repo">${GH_MARK}${repo}</div>
    <div class="scm-branch"><span class="scm-branch-name">${ghEsc(st.branch || 'detached HEAD')}</span>${sync}</div>
    ${st.head ? `<div class="scm-head" title="Last commit">${ghEsc(st.head)}</div>` : ''}
    ${SCM.account ? `<div class="scm-who">as ${ghEsc(SCM.account.login)}</div>` : ''}
  </div>`;
}

function defaultBranchName() {
  const d = new Date();
  return `jr/update-${d.getMonth() + 1}-${d.getDate()}-${d.getHours()}${String(d.getMinutes()).padStart(2, '0')}`;
}

function scmPublishHTML(st) {
  const base = (document.querySelector('.repo-name')?.textContent || 'my-app').split('/').pop().replace(/[^A-Za-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '') || 'my-app';
  return `<div class="scm-card">
    <h4>Publish to GitHub</h4>
    <p class="scm-p">${st.repo ? 'This repository has no GitHub remote yet.' : 'This project is not in a repository yet.'} Create one on <b>${ghEsc(SCM.account.login)}</b> and push everything to it. Files Jr Architect adds (agent specs, <code>.env.local</code>, <code>node_modules</code>) are left out.</p>
    <form class="scm-publish" id="scm-publish">
      <input name="name" type="text" value="${ghEsc(base)}" spellcheck="false" aria-label="Repository name" required>
      <input name="description" type="text" placeholder="Description (optional)" aria-label="Description">
      <label class="scm-check"><input name="private" type="checkbox" checked> Private repository</label>
      ${SCM.collaborator ? `<label class="scm-check"><input name="collab" type="checkbox" checked> Invite @${ghEsc(SCM.collaborator)} as a collaborator</label>` : ''}
      <p class="scm-p">Adds a README written from the project${SCM.isBuild ? "'s spec" : ''} when it has none, plus blank examples of secret files.</p>
      <button class="scm-btn scm-primary" type="submit" ${SCM.busy ? 'disabled' : ''}>Create repository &amp; push</button>
    </form>
  </div>`;
}

function wirePublish(body) {
  body.querySelector('#scm-publish')?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const f = e.target;
    await scmRun('Creating the repository and pushing…', async () => {
      const body = { container: IDE.container, name: f.name.value.trim(), description: f.description.value.trim(), private: f.private.checked };
      if (f.collab) body.collaborator = f.collab.checked;
      const d = await ghJSON('/github/publish', { body });
      SCM.state = d.state;
      const pub = d.publish || {};
      let html = `Published to <a href="${ghEsc(d.url)}" target="_blank" rel="noopener">${ghEsc(d.repo)}</a>${pub.readme ? ' with a README' : ''}.`;
      if (pub.invited) html += ` Invited @${ghEsc(pub.collaborator)}.`;
      if (pub.inviteError) html += ` Collaborator not added: ${ghEsc(pub.inviteError)}`;
      SCM.note = { ok: true, html };
    });
  });
}

function wireScm(body) {
  body.querySelectorAll('.scm-file').forEach((b) => b.addEventListener('click', () => openFile(b.dataset.path, b.dataset.path.split('/').pop())));
  const msg = body.querySelector('#scm-message');
  msg?.addEventListener('input', () => { SCM.draft = msg.value; });
  msg?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); scmPush(); } });
  body.querySelector('#scm-newbranch')?.addEventListener('change', (e) => { SCM.newBranch = e.target.checked; renderScm(); });
  body.querySelector('#scm-branch')?.addEventListener('input', (e) => { SCM.branchName = e.target.value; });
  body.querySelector('#scm-pr')?.addEventListener('change', (e) => { SCM.openPR = e.target.checked; });
  body.querySelectorAll('[data-act]').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.act === 'pull') scmPull();
    if (b.dataset.act === 'fetch') scmRefresh(true);
    if (b.dataset.act === 'push') scmPush();
  }));
}

async function scmRun(label, fn) {
  if (SCM.busy) return;
  SCM.busy = true;
  SCM.note = { ok: true, text: label };
  renderScm();
  try {
    await fn();
    // The graph shows the new commit straight away when it is open.
    if (typeof GG !== 'undefined' && GG.commits.length && typeof loadGitGraph === 'function') loadGitGraph(true);
  } catch (e) {
    SCM.note = { ok: false, text: e.message };
    // A failed push can still have committed or switched branch, so re-read the real state.
    setTimeout(() => scmRefresh(false, true), 0);
  }
  SCM.busy = false;
  renderScm();
  renderScmBadge();
}

async function scmPull() {
  await scmRun('Pulling from GitHub…', async () => {
    const d = await ghJSON('/github/pull', { body: { container: IDE.container } });
    SCM.state = d.state;
    SCM.note = { ok: true, text: /up to date/i.test(d.output || '') ? 'Already up to date.' : 'Pulled the latest commits.' };
    if (typeof loadFileTree === 'function') loadFileTree();
    if (typeof refreshOpenEditors === 'function') refreshOpenEditors();
  });
}

// After a pull, open tabs without unsaved edits pick up the new file contents.
async function refreshOpenEditors() {
  for (const tab of IDE.tabs || []) {
    if (tab.modified) continue;
    try {
      const res = await fetch(`/file?container=${encodeURIComponent(IDE.container)}&path=${encodeURIComponent(tab.path)}`);
      if (!res.ok) continue;
      const text = await res.text();
      if (text !== tab.model.getValue()) {
        tab.original = text;
        tab.model.setValue(text);
        tab.modified = false;
      }
    } catch { /* leave the tab as it is */ }
  }
  if (typeof renderTabs === 'function') renderTabs();
}

async function scmPush() {
  const st = SCM.state;
  if (!st || SCM.busy) return;
  const unsaved = (IDE.tabs || []).filter((t) => t.modified).map((t) => t.name);
  if (unsaved.length) {
    SCM.note = { ok: false, text: `Save ${unsaved.join(', ')} first (Ctrl+S); only saved files are committed.` };
    renderScm();
    return;
  }
  const message = (document.getElementById('scm-message')?.value || '').trim();
  if (st.changes.length && !message) {
    SCM.note = { ok: false, text: 'Write a commit message first.' };
    renderScm();
    document.getElementById('scm-message')?.focus();
    return;
  }
  const req = { container: IDE.container, message };
  if (SCM.newBranch) {
    req.branch = (document.getElementById('scm-branch')?.value || '').trim();
    if (!req.branch) {
      SCM.note = { ok: false, text: 'Name the new branch.' };
      renderScm();
      return;
    }
    if (document.getElementById('scm-pr')?.checked) req.pr = { title: message };
  }
  await scmRun('Committing and pushing to GitHub…', async () => {
    const d = await ghJSON('/github/push', { body: req });
    SCM.state = d.state;
    SCM.draft = '';
    let html = `Pushed to <b>${ghEsc(d.branch)}</b> on <a href="https://github.com/${ghEsc(d.repo)}/tree/${encodeURIComponent(d.branch)}" target="_blank" rel="noopener">${ghEsc(d.repo)}</a>.`;
    if (d.prUrl) html += ` <a href="${ghEsc(d.prUrl)}" target="_blank" rel="noopener">Pull request #${d.prNumber}</a> is open.`;
    if (d.prError) html += ` The pull request was not opened: ${ghEsc(d.prError)}`;
    SCM.note = { ok: !d.prError, html };
    SCM.newBranch = false;
    SCM.branchName = '';
  });
}
