// GitHub connection shared by Home, Settings and the IDE: connect (OAuth or token), the repo picker, and the account card.
const JRGH = { status: null, repos: [], loading: false };

const ghEsc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const GH_MARK = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 .5a11.5 11.5 0 0 0-3.64 22.41c.58.1.79-.25.79-.56v-2c-3.2.7-3.88-1.37-3.88-1.37-.53-1.33-1.28-1.69-1.28-1.69-1.05-.71.08-.7.08-.7 1.16.08 1.77 1.19 1.77 1.19 1.03 1.77 2.71 1.26 3.37.96.1-.75.4-1.26.73-1.55-2.55-.29-5.24-1.28-5.24-5.68 0-1.26.45-2.28 1.19-3.09-.12-.29-.52-1.46.11-3.05 0 0 .97-.31 3.17 1.18a11 11 0 0 1 5.77 0c2.2-1.49 3.17-1.18 3.17-1.18.63 1.59.23 2.76.11 3.05.74.81 1.19 1.83 1.19 3.09 0 4.41-2.69 5.38-5.26 5.67.41.36.78 1.06.78 2.14v3.17c0 .31.21.67.8.56A11.5 11.5 0 0 0 12 .5Z"/></svg>';

async function ghJSON(url, opts = {}) {
  const res = await fetch(url, opts.body ? { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jr': '1' }, ...opts, body: JSON.stringify(opts.body) } : opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}

async function ghStatus(force = false) {
  if (JRGH.status && !force) return JRGH.status;
  try { JRGH.status = await ghJSON('/github/status'); } catch { JRGH.status = { connected: false, oauth: false }; }
  return JRGH.status;
}

// OAuth comes back to next with ?github=connected or ?github_error=...
function ghConnect(next) {
  location.href = '/auth/oauth/github/start?mode=link&next=' + encodeURIComponent(next || (location.pathname + location.search));
}

async function ghDisconnect() {
  await ghJSON('/github/disconnect', { body: {} });
  JRGH.status = null;
  return ghStatus(true);
}

// The connect controls: the OAuth button when the server has an app, and the token form always.
function ghConnectHTML(status, { compact = false } = {}) {
  const oauth = status.oauth
    ? `<button class="gh-btn gh-btn-primary" type="button" data-gh-connect>${GH_MARK}<span>Connect GitHub</span></button>` : '';
  const tokenOpen = !status.oauth && compact;
  return `<div class="gh-connect-box">
    ${oauth}
    <details class="gh-token" ${tokenOpen ? 'open' : ''}>
      <summary>${status.oauth ? 'Use a personal access token instead' : 'Connect with a personal access token'}</summary>
      <form class="gh-token-form" data-gh-token>
        <input type="password" placeholder="ghp_… or github_pat_…" autocomplete="off" spellcheck="false" aria-label="GitHub token" />
        <button class="gh-btn" type="submit">Save</button>
      </form>
      <p class="gh-hint">Create one at <a href="https://github.com/settings/tokens/new?scopes=repo,read:user,user:email&description=Jr%20Architect" target="_blank" rel="noopener">github.com/settings/tokens</a> with the <code>repo</code> scope. It is stored encrypted on this server and never sent back to the browser.</p>
    </details>
    ${compact ? '' : '<p class="gh-hint">Public repositories open without connecting. Connect to open private ones and to pull, commit and push from the IDE.</p>'}
    <p class="gh-error" role="alert"></p>
  </div>`;
}

function ghWireConnect(root, onConnected, next) {
  root.querySelector('[data-gh-connect]')?.addEventListener('click', () => ghConnect(next));
  const form = root.querySelector('[data-gh-token]');
  form?.addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = form.querySelector('input');
    const btn = form.querySelector('button');
    const err = root.querySelector('.gh-error');
    btn.disabled = true;
    err.textContent = '';
    try {
      await ghJSON('/github/token', { body: { token: input.value.trim() } });
      input.value = '';
      onConnected(await ghStatus(true));
    } catch (ex) {
      err.textContent = ex.message;
    }
    btn.disabled = false;
  });
}

function ghAccountHTML(acc) {
  const avatar = acc.avatar ? `<img src="${ghEsc(acc.avatar)}" alt="" width="22" height="22">` : `<span class="gh-avatar-blank">${GH_MARK}</span>`;
  return `<span class="gh-account">${avatar}<span><b>${ghEsc(acc.login)}</b>${acc.canPush ? '' : ' <em>read-only</em>'}</span></span>`;
}

function ghTimeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  if (s < 3600) return `${Math.max(1, Math.round(s / 60))}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  if (s < 86400 * 30) return `${Math.round(s / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

// Home: the "Clone from GitHub" block lists the user's repos once GitHub is connected.
async function mountRepoPicker(box, onPick) {
  const status = await ghStatus(true);
  const q = new URLSearchParams(location.search);
  const flash = q.get('github_error') ? `<p class="gh-error">${ghEsc(q.get('github_error'))}</p>` : '';
  if (!status.connected) {
    box.innerHTML = flash + ghConnectHTML(status);
    ghWireConnect(box, () => mountRepoPicker(box, onPick), '/');
    return;
  }
  box.innerHTML = `<div class="gh-picker">
    <div class="gh-picker-head">${ghAccountHTML(status.account)}<a href="/settings.html#github" class="gh-link">Manage</a></div>
    <input class="gh-search" type="search" placeholder="Search your repositories" aria-label="Search repositories" />
    <div class="gh-repos" role="list"><div class="gh-empty">Loading repositories…</div></div>
  </div>`;
  const list = box.querySelector('.gh-repos');
  const search = box.querySelector('.gh-search');
  const render = () => {
    const term = search.value.trim().toLowerCase();
    const rows = JRGH.repos.filter((r) => !term || (r.fullName + ' ' + (r.description || '')).toLowerCase().includes(term)).slice(0, 60);
    list.innerHTML = rows.length ? rows.map((r) => `
      <button class="gh-repo" type="button" role="listitem" data-url="${ghEsc(r.url)}" data-branch="${ghEsc(r.defaultBranch)}" title="Open ${ghEsc(r.fullName)} in the IDE">
        <span class="gh-repo-name">${ghEsc(r.fullName)}${r.private ? '<span class="gh-tag">Private</span>' : ''}</span>
        <span class="gh-repo-meta">${ghEsc(r.language || '')}${r.language ? ' · ' : ''}${ghEsc(r.defaultBranch)} · ${ghTimeAgo(r.pushedAt)}</span>
      </button>`).join('') : `<div class="gh-empty">${JRGH.repos.length ? 'No repository matches.' : 'No repositories on this account yet.'}</div>`;
    list.querySelectorAll('.gh-repo').forEach((b) => b.addEventListener('click', () => onPick(b.dataset.url, b.dataset.branch)));
  };
  search.addEventListener('input', render);
  try {
    if (!JRGH.repos.length) JRGH.repos = (await ghJSON('/github/repos')).repos;
    render();
  } catch (e) {
    list.innerHTML = `<div class="gh-empty gh-error">${ghEsc(e.message)}</div>`;
  }
}

// Settings: who is signed in, and the GitHub link.
async function mountAccountCard(box) {
  let me = {};
  try { me = await ghJSON('/auth/me'); } catch { /* local mode */ }
  const status = await ghStatus(true);
  const p = me.profile;
  const who = p ? `<div class="gh-row"><span class="gh-account">${p.avatar ? `<img src="${ghEsc(p.avatar)}" alt="" width="22" height="22">` : ''}<span><b>${ghEsc(p.name || p.login || p.email)}</b> ${p.email ? `<span class="gh-muted">${ghEsc(p.email)}</span>` : ''}</span></span>
      <span class="gh-muted">Signed in with ${p.provider === 'google' ? 'Google' : 'GitHub'}</span></div>`
    : (me.auth ? '<div class="gh-row"><span class="gh-muted">Signed in with a beta code</span></div>' : '<div class="gh-row"><span class="gh-muted">This server runs without sign-in, so everything here belongs to this machine.</span></div>');
  const signOut = me.auth ? '<button class="gh-btn" type="button" data-signout>Sign out</button>' : '';
  const q = new URLSearchParams(location.search);
  const flash = q.get('github') === 'connected' ? '<p class="gh-ok">GitHub connected.</p>' : q.get('github_error') ? `<p class="gh-error">${ghEsc(q.get('github_error'))}</p>` : '';
  const syncBtn = `<button class="gh-btn gh-btn-sync" type="button" data-gh-sync>${GH_MARK}<span>Sync GitHub</span></button>`;
  const gh = status.connected
    ? `<div class="gh-row">${ghAccountHTML(status.account)}
        <span class="gh-muted">${status.account.via === 'token' ? 'Personal access token' : 'Connected with OAuth'}</span>
        <span class="gh-row-actions">${syncBtn}<button class="gh-btn gh-btn-danger" type="button" data-gh-disconnect>Disconnect</button></span></div>
       ${status.account.canPush ? '' : '<p class="gh-hint">This connection cannot push. Reconnect to grant the <code>repo</code> scope.</p>'}
       <div class="gh-prefs" id="gh-prefs"></div>
       <div class="gh-synced" id="gh-synced"></div>`
    : `<div class="gh-sync-empty">
        <p class="gh-hint">Sync your GitHub account to open your repositories (private ones too) in the IDE, change them with the coding agent, and pull, commit and push back.</p>
        ${syncBtn}
       </div>${ghConnectHTML(status, { compact: true }).replace('data-gh-connect', 'data-gh-connect hidden')}`;
  box.innerHTML = `${who}${signOut ? `<div class="gh-actions">${signOut}</div>` : ''}<h3 class="gh-sub" id="github">GitHub</h3>${flash}${gh}`;
  ghWireConnect(box, () => { mountAccountCard(box).then(() => ghSyncRepos(box)); }, '/settings.html?sync=1');
  box.querySelector('[data-gh-sync]')?.addEventListener('click', () => {
    if (status.connected) { ghSyncRepos(box, true); return; }
    // Without an OAuth app the token form is the way in, so it opens and takes focus.
    if (status.oauth) { ghConnect('/settings.html?sync=1'); return; }
    const det = box.querySelector('.gh-token');
    if (det) { det.open = true; det.querySelector('input')?.focus(); }
  });
  box.querySelector('[data-gh-disconnect]')?.addEventListener('click', async (e) => {
    e.target.disabled = true;
    await ghDisconnect().catch(() => {});
    JRGH.repos = [];
    mountAccountCard(box);
  });
  box.querySelector('[data-signout]')?.addEventListener('click', jrSignOut);
  if (status.connected) ghMountPrefs(box.querySelector('#gh-prefs'));
  if (status.connected && (q.get('github') === 'connected' || q.has('sync'))) ghSyncRepos(box, true);
  if (q.has('github') || q.has('github_error') || q.has('sync')) history.replaceState(null, '', location.pathname + location.hash);
}

// Re-reads the connection and every repository the account can reach, then lists them with an Open button.
async function ghSyncRepos(box, force = false) {
  const out = box.querySelector('#gh-synced');
  const btn = box.querySelector('[data-gh-sync]');
  if (!out) return;
  if (btn) { btn.disabled = true; btn.querySelector('span').textContent = 'Syncing…'; }
  out.innerHTML = '<div class="gh-empty">Syncing your repositories…</div>';
  try {
    const status = await ghStatus(true);
    if (!status.connected) throw new Error('GitHub is no longer connected');
    if (force || !JRGH.repos.length) {
      const all = [];
      for (let page = 1; page <= 5; page++) {
        const d = await ghJSON(`/github/repos?page=${page}`);
        all.push(...d.repos);
        if (!d.more) break;
      }
      JRGH.repos = all;
      JRGH.syncedAt = Date.now();
    }
    const priv = JRGH.repos.filter((r) => r.private).length;
    out.innerHTML = `<div class="gh-synced-head">
        <span class="gh-ok">Synced ${JRGH.repos.length} repositor${JRGH.repos.length === 1 ? 'y' : 'ies'}${priv ? ` (${priv} private)` : ''} · just now</span>
        <input class="gh-search" type="search" placeholder="Search repositories" aria-label="Search repositories">
      </div>
      <div class="gh-repos gh-repos-tall" role="list"></div>`;
    const list = out.querySelector('.gh-repos');
    const search = out.querySelector('.gh-search');
    const render = () => {
      const term = search.value.trim().toLowerCase();
      const rows = JRGH.repos.filter((r) => !term || (r.fullName + ' ' + (r.description || '')).toLowerCase().includes(term)).slice(0, 100);
      list.innerHTML = rows.length ? rows.map((r) => `
        <div class="gh-repo-row" role="listitem">
          <div class="gh-repo-info">
            <span class="gh-repo-name">${ghEsc(r.fullName)}${r.private ? '<span class="gh-tag">Private</span>' : ''}${r.canPush ? '' : '<span class="gh-tag">Read-only</span>'}</span>
            <span class="gh-repo-meta">${ghEsc(r.description || '')}${r.description ? ' · ' : ''}${ghEsc(r.language || '')}${r.language ? ' · ' : ''}${ghEsc(r.defaultBranch)} · ${ghTimeAgo(r.pushedAt)}</span>
          </div>
          <button class="gh-btn" type="button" data-open="${ghEsc(r.url)}" data-branch="${ghEsc(r.defaultBranch)}">Open in IDE</button>
        </div>`).join('') : '<div class="gh-empty">No repository matches.</div>';
      list.querySelectorAll('[data-open]').forEach((b) => b.addEventListener('click', () => ghOpenInIDE(b.dataset.open, b.dataset.branch)));
    };
    search.addEventListener('input', render);
    render();
  } catch (e) {
    const st = JRGH.status || {};
    const fix = /reconnect/i.test(e.message)
      ? (st.oauth ? '<button class="gh-btn" type="button" data-gh-reconnect>Reconnect GitHub</button>' : '<span class="gh-muted">Disconnect, then save a new token.</span>')
      : '';
    out.innerHTML = `<div class="gh-error-row"><p class="gh-error">${ghEsc(e.message)}</p>${fix}</div>`;
    out.querySelector('[data-gh-reconnect]')?.addEventListener('click', () => ghConnect('/settings.html?sync=1'));
  }
  if (btn) { btn.disabled = false; btn.querySelector('span').textContent = 'Sync GitHub'; }
}

// The per-user switches for what happens when Build mode finishes an app.
async function ghMountPrefs(box) {
  if (!box) return;
  let d;
  try { d = await ghJSON('/github/prefs'); } catch { return; }
  const p = d.prefs;
  const row = (key, title, sub) => `<label class="gh-switch">
      <input type="checkbox" data-pref="${key}" ${p[key] ? 'checked' : ''}>
      <span class="gh-switch-ui" aria-hidden="true"></span>
      <span class="gh-switch-text"><b>${title}</b><span>${sub}</span></span>
    </label>`;
  box.innerHTML = `<div class="gh-prefs-title">When Build mode finishes an app</div>
    ${row('autoPush', 'Push it to my GitHub', 'Creates a repository with the full code, a README written from the spec, and a blank <code>.env.example</code>. Tokens are never pushed.')}
    ${row('privateRepos', 'Make new repositories private', 'You can change visibility on GitHub any time.')}
    ${d.collaborator ? row('addCollaborator', `Invite @${ghEsc(d.collaborator)} as a collaborator`, `Gives the Jr Architect account push access to repositories it creates for you, so it can help maintain them.`) : ''}
    <p class="gh-hint gh-prefs-saved" aria-live="polite"></p>`;
  box.querySelectorAll('[data-pref]').forEach((cb) => cb.addEventListener('change', async () => {
    const next = { ...p };
    box.querySelectorAll('[data-pref]').forEach((c) => { next[c.dataset.pref] = c.checked; });
    const note = box.querySelector('.gh-prefs-saved');
    try {
      Object.assign(p, (await ghJSON('/github/prefs', { body: next })).prefs);
      note.textContent = 'Saved';
      setTimeout(() => { note.textContent = ''; }, 1500);
    } catch (e) {
      note.textContent = e.message;
    }
  }));
}

// Hands the repo to Home through sessionStorage, so only this site (never a link from elsewhere) can start a clone.
function ghOpenInIDE(url, branch) {
  try { sessionStorage.setItem('jr-open-repo', JSON.stringify({ url, branch })); } catch { /* storage blocked */ }
  location.href = '/?open=repo';
}

async function jrSignOut() {
  try { await fetch('/auth/logout', { method: 'POST', headers: { 'X-Jr': '1' } }); } catch { /* go to login anyway */ }
  location.href = '/login';
}
