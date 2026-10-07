// Shared app chrome: the left rail, the theme, and the paste-any-API-key widget.
(() => {
  const ICONS = {
    home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
    projects: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
    hub: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    flows: '<circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="18" r="2.5"/><path d="M8.5 6H14a4 4 0 0 1 4 4v5.5"/>',
    build: '<path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
    theme: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    key: '<circle cx="7.5" cy="15.5" r="4.5"/><path d="m10.7 12.3 9.8-9.8M17 6l3 3M14.5 8.5l2 2"/>',
    // Workflow and menu icons, from Lucide (lucide.dev, ISC licence), inlined so the app stays offline.
    play: '<polygon points="6 3 20 12 6 21 6 3"/>',
    bot: '<path d="M12 8V4H8"/><rect width="16" height="12" x="4" y="8" rx="2"/><path d="M2 14h2M20 14h2M15 13v2M9 13v2"/>',
    branch: '<line x1="6" x2="6" y1="3" y2="15"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M18 9a9 9 0 0 1-9 9"/>',
    braces: '<path d="M8 3H7a2 2 0 0 0-2 2v5a2 2 0 0 1-2 2 2 2 0 0 1 2 2v5c0 1.1.9 2 2 2h1"/><path d="M16 21h1a2 2 0 0 0 2-2v-5c0-1.1.9-2 2-2a2 2 0 0 1-2-2V5a2 2 0 0 0-2-2h-1"/>',
    userCheck: '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><polyline points="16 11 18 13 22 9"/>',
    globe: '<circle cx="12" cy="12" r="10"/><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"/><path d="M2 12h20"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><line x1="4" x2="4" y1="22" y2="15"/>',
    trash: '<path d="M3 6h18"/><path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"/><path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"/><line x1="10" x2="10" y1="11" y2="17"/><line x1="14" x2="14" y1="11" y2="17"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    clipboard: '<rect width="8" height="4" x="8" y="2" rx="1" ry="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>',
    pencil: '<path d="M21.2 6.8a1 1 0 0 0-4-4L3.8 16.2a2 2 0 0 0-.5.8l-1.3 4.4a.5.5 0 0 0 .6.6l4.4-1.3a2 2 0 0 0 .8-.5z"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    unplug: '<path d="m19 5 3-3"/><path d="m2 22 3-3"/><path d="M6.3 20.3a2.4 2.4 0 0 0 3.4 0L12 18l-6-6-2.3 2.3a2.4 2.4 0 0 0 0 3.4Z"/><path d="M7.5 13.5 10 11"/><path d="M10.5 16.5 13 14"/><path d="m12 6 6 6 2.3-2.3a2.4 2.4 0 0 0 0-3.4l-2.6-2.6a2.4 2.4 0 0 0-3.4 0Z"/>',
    sliders: '<line x1="21" x2="14" y1="4" y2="4"/><line x1="10" x2="3" y1="4" y2="4"/><line x1="21" x2="12" y1="12" y2="12"/><line x1="8" x2="3" y1="12" y2="12"/><line x1="21" x2="16" y1="20" y2="20"/><line x1="12" x2="3" y1="20" y2="20"/><line x1="14" x2="14" y1="2" y2="6"/><line x1="8" x2="8" y1="10" y2="14"/><line x1="16" x2="16" y1="18" y2="22"/>',
    fit: '<path d="M8 3H5a2 2 0 0 0-2 2v3"/><path d="M21 8V5a2 2 0 0 0-2-2h-3"/><path d="M3 16v3a2 2 0 0 0 2 2h3"/><path d="M16 21h3a2 2 0 0 0 2-2v-3"/>',
    search: '<circle cx="11" cy="11" r="8"/><path d="m21 21-4.3-4.3"/>',
    panelLeft: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M9 3v18"/>',
    panelRight: '<rect width="18" height="18" x="3" y="3" rx="2"/><path d="M15 3v18"/>',
    external: '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    restore: '<path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"/><path d="M3 3v5h5"/>',
    chevronRight: '<path d="m9 18 6-6-6-6"/>',
    open: '<path d="M5 12h14"/><path d="m12 5 7 7-7 7"/>',
  };
  const icon = (name, size = 20) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;
  window.jrIcon = icon;

  function storedDark() {
    try { return localStorage.getItem('jr-dark-mode') !== 'false'; } catch { return true; }
  }

  // ide.js listens for jr-theme to retheme Monaco.
  window.jrSetTheme = (dark) => {
    document.body.classList.toggle('dark-mode', dark);
    try { localStorage.setItem('jr-dark-mode', dark); } catch { /* storage blocked */ }
    window.dispatchEvent(new CustomEvent('jr-theme', { detail: { dark } }));
  };
  window.jrIsDark = () => document.body.classList.contains('dark-mode');
  window.jrToggleTheme = () => window.jrSetTheme(!window.jrIsDark());

  const NAV = [
    ['home', 'Home', '/', (p) => p === '/' || p === '/index.html', 'Workspace'],
    ['hub', 'Agents', '/hub.html', (p, h) => (p === '/hub.html' && h !== '#workflows') || p === '/studio.html', 'Automation'],
    ['flows', 'Workflows', '/hub.html#workflows', (p, h) => p === '/flows.html' || (p === '/hub.html' && h === '#workflows'), 'Automation'],
    ['settings', 'Settings', '/settings.html', (p) => p === '/settings.html', 'Automation'],
  ];

  function markActive(rail) {
    rail.querySelectorAll('[data-nav]').forEach((a) => {
      const item = NAV.find(([ic]) => ic === a.dataset.nav);
      a.classList.toggle('active', item[3](location.pathname, location.hash));
    });
  }

  // With a login on, the rail foot shows who is signed in and signs them out.
  async function mountAccount(rail) {
    let me;
    try {
      const r = await fetch('/auth/me', { headers: { 'X-Jr': '1' } });
      if (!r.ok) return;
      me = await r.json();
    } catch { return; }
    if (!me.auth) return;
    const p = me.profile || {};
    const name = p.name || p.login || p.email || 'Beta user';
    const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const avatar = p.avatar
      ? `<img class="jr-rail-avatar" src="${esc(p.avatar)}" alt="" width="16" height="16">`
      : `<b class="jr-rail-avatar">${esc(name.charAt(0).toUpperCase())}</b>`;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'jr-rail-item jr-rail-account';
    btn.title = `Signed in as ${name}. Click to sign out.`;
    btn.innerHTML = `${avatar}<span>Sign out · ${esc(name)}</span>`;
    btn.addEventListener('click', async () => {
      try { await fetch('/auth/logout', { method: 'POST', headers: { 'X-Jr': '1' } }); } catch { /* sign in again anyway */ }
      location.href = '/login';
    });
    rail.querySelector('.jr-rail-foot').prepend(btn);
  }

  function renderRail() {
    const rail = document.createElement('nav');
    rail.className = 'jr-rail';
    rail.setAttribute('aria-label', 'Main');
    const item = ([ic, label, href]) => `<a class="jr-rail-item" href="${href}" data-nav="${ic}">${icon(ic, 16)}<span>${label}</span></a>`;
    const group = (name) => `<div class="jr-rail-group"><div class="jr-rail-label">${name}</div>${NAV.filter((n) => n[4] === name).map(item).join('')}</div>`;
    rail.innerHTML = `
      <a class="jr-rail-brand" href="/"><span class="jr-rail-logo">Jr</span><span class="jr-rail-name">Jr Architect</span></a>
      ${group('Workspace')}
      ${group('Automation')}
      <div class="jr-rail-foot">
        <button class="jr-rail-item jr-rail-pin" type="button">${icon('panelLeft', 16)}<span></span></button>
        <button class="jr-rail-item jr-rail-theme" type="button">${icon('theme', 16)}<span>Toggle theme</span></button>
      </div>`;
    rail.querySelector('.jr-rail-theme').addEventListener('click', () => window.jrToggleTheme());
    // Collapsed to icons by default and opened by hovering; pinning keeps it open and pushes the page over.
    const pin = rail.querySelector('.jr-rail-pin');
    const setPinned = (on) => {
      document.body.classList.toggle('rail-pinned', on);
      pin.querySelector('span').textContent = on ? 'Collapse sidebar' : 'Keep sidebar open';
      pin.title = pin.querySelector('span').textContent;
      try { localStorage.setItem('jr-rail-pinned', on); } catch { /* storage blocked */ }
    };
    let pinned = false;
    try { pinned = localStorage.getItem('jr-rail-pinned') === 'true'; } catch { /* storage blocked */ }
    setPinned(pinned);
    pin.addEventListener('click', () => { setPinned(!document.body.classList.contains('rail-pinned')); pin.blur(); });
    mountAccount(rail);
    markActive(rail);
    ['hashchange', 'jr-nav'].forEach((ev) => window.addEventListener(ev, () => markActive(rail)));
    document.body.prepend(rail);
    document.body.classList.add('has-rail');
  }

  // ── Paste-any-API-key widget ──────────────────────────────────────────────
  const PREFIXES = [['gsk_', 'groq', 'Groq'], ['sk-ant-', 'anthropic', 'Anthropic'], ['sk-', 'openai', 'OpenAI'], ['AIza', 'gemini', 'Gemini']];
  const detect = (key) => (PREFIXES.find(([p]) => key.startsWith(p)) || [null, '', ''])
    .slice(1);

  let keyCache = null;
  window.jrKeyStatus = async (fresh = false) => {
    if (keyCache && !fresh) return keyCache;
    try {
      const r = await fetch('/settings/keys', { headers: { 'X-Jr': '1' } });
      keyCache = r.ok ? await r.json() : { providers: [], editable: false };
    } catch { keyCache = { providers: [], editable: false }; }
    return keyCache;
  };
  window.jrHasAnyKey = async () => (await window.jrKeyStatus()).providers.some(p => p.configured);

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  // Renders into el; onSaved runs after a key is stored so the host page can refresh what depended on it.
  window.jrMountKeyInput = (el, { onSaved, compact = false } = {}) => {
    el.classList.add('jr-key');
    if (compact) el.classList.add('jr-key-compact');
    el.innerHTML = `
      <div class="jr-key-row">
        <span class="jr-key-icon">${icon('key', 16)}</span>
        <input class="jr-key-input" type="text" autocomplete="off" spellcheck="false" data-1p-ignore data-lpignore="true"
          placeholder="Paste any API key: Groq, OpenAI, Anthropic or Gemini" aria-label="API key">
        <span class="jr-key-badge" hidden></span>
        <button class="jr-key-save" type="button" disabled>Save key</button>
      </div>
      <div class="jr-key-note" role="status"></div>`;
    const input = el.querySelector('.jr-key-input');
    const badge = el.querySelector('.jr-key-badge');
    const btn = el.querySelector('.jr-key-save');
    const note = el.querySelector('.jr-key-note');
    const setNote = (text, kind = '') => { note.textContent = text; note.className = `jr-key-note ${kind}`; };

    input.addEventListener('input', () => {
      const key = input.value.trim();
      const [id, label] = detect(key);
      badge.hidden = !key;
      badge.className = `jr-key-badge${id ? ' ok' : ''}`;
      badge.textContent = id ? `${label} detected` : 'Unknown key';
      btn.disabled = !id;
      setNote(key && !id ? 'Keys start with gsk_ (Groq), sk-ant- (Anthropic), sk- (OpenAI) or AIza (Gemini).' : '');
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !btn.disabled) btn.click(); });
    btn.addEventListener('click', async () => {
      const key = input.value.trim();
      btn.disabled = true;
      btn.textContent = 'Checking…';
      setNote('Checking the key with the provider…');
      try {
        const r = await fetch('/settings/keys', {
          method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jr': '1' }, body: JSON.stringify({ key }),
        });
        const d = await r.json();
        if (!r.ok) throw new Error(d.error || 'Could not save the key');
        input.value = '';
        badge.hidden = true;
        keyCache = { providers: d.providers, editable: true };
        setNote(d.check === 'valid' ? `${d.provider.label} key saved and working.` : `${d.provider.label} key saved, but not verified (${d.note}).`, d.check === 'valid' ? 'ok' : 'warn');
        if (onSaved) onSaved(d);
      } catch (e) {
        setNote(e.message, 'err');
      } finally {
        btn.textContent = 'Save key';
        btn.disabled = !detect(input.value.trim())[0];
      }
    });
  };

  // A dismissible strip that only appears while no provider has a key.
  window.jrKeyBanner = async (host, { onSaved } = {}) => {
    const status = await window.jrKeyStatus();
    if (status.providers.some(p => p.configured) || !status.editable) {
      host.hidden = true;
      return;
    }
    host.hidden = false;
    host.classList.add('jr-key-banner');
    host.innerHTML = `<div class="jr-key-banner-text"><strong>Add an AI key to get started.</strong> The agent, Build mode and Agent Studio need one. It stays on this server.</div><div class="jr-key-banner-input"></div>`;
    window.jrMountKeyInput(host.querySelector('.jr-key-banner-input'), {
      compact: true,
      onSaved: (d) => { setTimeout(() => { host.hidden = true; }, 1600); if (onSaved) onSaved(d); },
    });
  };

  window.jrEsc = esc;

  function boot() {
    document.body.classList.toggle('dark-mode', storedDark());
    if (!document.body.dataset.noRail) renderRail();
  }
  if (document.body) boot();
  else document.addEventListener('DOMContentLoaded', boot);
})();
