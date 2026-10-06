// IDE Agents panel (OpenGAP): the repo's coding-agent team in .gitagent/ — Team, Workflow, Guardrails and Runs — plus the team's live workflow in chat.

const OG = { status: null, runs: [], editing: null, smoke: {}, smoking: null, live: null, openRun: null, guardForm: false, fileEdit: null, addOpen: false, busy: false };
const OG_TABS = ['team', 'workflow', 'guards', 'runs'];

const ogEsc = (s) => (typeof escapeHtml === 'function' ? escapeHtml(s) : String(s ?? ''));
const ogAttr = (s) => ogEsc(s).replace(/"/g, '&quot;');

function ogHue(name) {
  let h = 0;
  for (const c of String(name)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return h;
}

function ogInitials(name) {
  return String(name).split('-').map((p) => p[0] || '').join('').slice(0, 2).toUpperCase();
}

async function ogLoad() {
  if (!IDE.container) return;
  try {
    const res = await fetch(`/agent/opengap?container=${encodeURIComponent(IDE.container)}`);
    const d = await res.json();
    if (res.ok) OG.status = d;
  } catch { /* agent service starting */ }
  if (GitAgent.tab === 'runs') await ogLoadRuns(true);
  if (OG_TABS.includes(GitAgent.tab)) gaRender();
}

async function ogLoadRuns(silent) {
  try {
    const d = await (await fetch(`/agent/opengap/runs?container=${encodeURIComponent(IDE.container)}`)).json();
    OG.runs = d.runs || [];
  } catch { OG.runs = []; }
  if (!silent) gaRender();
}

async function ogPost(path, body, okMsg) {
  if (OG.busy) return null;
  OG.busy = true;
  try {
    const res = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jr': '1' }, body: JSON.stringify({ container: IDE.container, ...body }) });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(d.error || `failed (${res.status})`);
    if (d.agents) OG.status = d;
    if (okMsg) showToast(okMsg, 'success');
    return d;
  } catch (e) {
    showToast(e.message, 'error');
    return null;
  } finally {
    OG.busy = false;
    gaRender();
  }
}

function ogTabHTML(tab) {
  if (!OG.status) return '<div class="og-empty">Reading <code>.gitagent/</code>…</div>';
  if (OG.fileEdit) return ogFileEditorHTML();
  if (tab === 'team') return OG.editing ? ogAgentFormHTML() : ogTeamHTML();
  if (tab === 'workflow') return ogWorkflowHTML();
  if (tab === 'guards') return ogGuardsHTML();
  return ogRunsHTML();
}

// ── Team ──

function ogNotInstalledHTML() {
  return `<div class="og-hero">
    <div class="og-hero-badge">OpenGAP · GitAgent protocol</div>
    <div class="og-hero-title">Your coding agents, kept in your repo</div>
    <p>A team lives in <code>.gitagent/</code>. Each agent is a folder with <b>SOUL.md</b> (who it is, what files it owns, who it hands to) and <b>RULES.md</b>. Guardrails in <code>hooks/</code> are enforced on every edit, whatever an agent believes, and <b>DUTIES.md</b> is how they hand work to each other with a compact brief instead of a transcript.</p>
    <button class="og-btn og-primary" type="button" onclick="ogPost('/agent/opengap/init', {}, 'Default team installed')">Set up the default team</button>
    <div class="og-hero-team">${['build-doctor', 'junior-dev', 'ui-editor', 'senior-dev'].map((n) => `<span class="og-avatar" style="--hue:${ogHue(n)}">${ogInitials(n)}</span><span>${n}</span>`).join('')}</div>
    ${ogAddFormHTML(true)}
  </div>`;
}

function ogAddFormHTML(open) {
  return `<details class="og-add" ${open || OG.addOpen ? 'open' : ''} ontoggle="OG.addOpen=this.open">
    <summary>Add an agent or guard from Git</summary>
    <div class="og-add-row">
      <input id="og-add-url" class="og-input mono" placeholder="https://github.com/you/my-reviewer" spellcheck="false">
      <input id="og-add-as" class="og-input mono og-as" placeholder="as (optional)" spellcheck="false">
    </div>
    <div class="og-add-row">
      <button class="og-btn" type="button" onclick="ogAddFromGit('agent')">Add agent</button>
      <button class="og-btn" type="button" onclick="ogAddFromGit('guard')">Add guard</button>
      <span class="og-muted">Only Markdown and YAML are copied. A pack that tries to choose its own model is refused.</span>
    </div>
  </details>`;
}

async function ogAddFromGit(kind) {
  const url = document.getElementById('og-add-url').value.trim();
  const as = document.getElementById('og-add-as').value.trim();
  if (!url) { showToast('Paste a git URL', 'error'); return; }
  const d = await ogPost('/agent/opengap/add', { url, as, kind }, null);
  if (d) showToast(`Installed ${(d.installedNames || []).join(', ')}`, 'success');
}

function ogTeamHTML() {
  const st = OG.status;
  if (!st.installed) return ogNotInstalledHTML();
  const problems = st.problems.filter((p) => p.level !== 'info');
  const agents = st.agents;
  const r = st.routing || {};
  return `
    ${problems.length ? `<div class="og-problems">${problems.map((p) => `<div class="og-problem ${p.level}"><b>${ogEsc(p.where)}</b> ${ogEsc(p.what)}</div>`).join('')}</div>` : '<div class="og-ok">✓ /check passed: routing, escalation and guards look right</div>'}
    <div class="og-toolbar">
      <button class="og-btn og-primary" type="button" onclick="ogNewAgent()">+ New agent</button>
      <button class="og-btn" type="button" onclick="ogOpenFile('DUTIES.md')">DUTIES.md</button>
      <button class="og-btn" type="button" onclick="ogLoad()">Check</button>
    </div>
    <div class="og-agents">${agents.map(ogAgentCardHTML).join('')}</div>
    <details class="og-card og-routing">
      <summary><b>Routing</b><span class="og-muted">entry ${ogEsc(r.entry)} · ${ogEsc(r.default_attempts)} tries · floor ${ogEsc(r.classifier_confidence_floor)}</span></summary>
      <label class="og-field"><span>Entry</span>
        <select onchange="ogRouting('entry', this.value)"><option value="auto" ${r.entry === 'auto' ? 'selected' : ''}>auto (route each task)</option>${agents.map((a) => `<option value="${ogAttr(a.name)}" ${r.entry === a.name ? 'selected' : ''}>always ${ogEsc(a.name)}</option>`).join('')}</select></label>
      <label class="og-field"><span>Attempts per agent</span><input type="number" min="1" max="5" value="${ogAttr(r.default_attempts)}" onchange="ogRouting('default_attempts', this.value)"></label>
      <label class="og-field"><span>Classifier confidence floor <em>below it, the task goes one step up</em></span><input type="number" min="0" max="1" step="0.05" value="${ogAttr(r.classifier_confidence_floor)}" onchange="ogRouting('classifier_confidence_floor', this.value)"></label>
      <label class="og-field"><span>Handoff brief budget <em>characters; task and objective are never cut</em></span><input type="number" min="1000" max="20000" step="500" value="${ogAttr(r.context_budget)}" onchange="ogRouting('context_budget', this.value)"></label>
    </details>
    ${ogAddFormHTML(false)}`;
}

function ogAgentCardHTML(a) {
  const chips = [];
  chips.push(`<span class="og-chip" title="Lower numbers claim work first">P${a.priority}</span>`);
  if (a.owns.length) chips.push(`<span class="og-chip og-own" title="${ogAttr(a.owns.join(', '))}">owns ${ogEsc(a.owns.slice(0, 3).join(' '))}${a.owns.length > 3 ? ` +${a.owns.length - 3}` : ''}</span>`);
  else chips.push('<span class="og-chip">owns anything</span>');
  if (a.fixesBuild) chips.push('<span class="og-chip og-fix">fixes builds</span>');
  if (a.parallel) chips.push('<span class="og-chip">parallel</span>');
  chips.push(a.terminal ? '<span class="og-chip og-term">terminal → you</span>' : a.successor ? `<span class="og-chip">→ ${ogEsc(a.successor)}</span>` : '<span class="og-chip og-warn">no successor</span>');
  if (a.model) chips.push(`<span class="og-chip og-model">${ogEsc(a.model)}</span>`);
  const smoke = OG.smoke[a.name];
  return `<div class="og-agent">
    <div class="og-agent-top">
      <span class="og-avatar" style="--hue:${ogHue(a.name)}">${ogInitials(a.name)}</span>
      <div class="og-agent-id"><b>${ogEsc(a.name)}</b><span>${ogEsc(a.role || 'No role yet')}</span></div>
    </div>
    <div class="og-chips">${chips.join('')}</div>
    <div class="og-agent-actions">
      <button class="og-btn" type="button" onclick="ogChatWith('${ogAttr(a.name)}')" title="Give this agent a task in the chat">@ Task</button>
      <button class="og-btn" type="button" onclick="ogEditAgent('${ogAttr(a.name)}')">Edit</button>
      <button class="og-btn" type="button" onclick="ogSmoke('${ogAttr(a.name)}')" ${OG.smoking ? 'disabled' : ''}>${OG.smoking === a.name ? 'Testing…' : 'Smoke test'}</button>
      ${a.source ? `<span class="og-muted" title="${ogAttr(a.source)}">from git</span>` : ''}
    </div>
    ${smoke ? `<div class="og-smoke">${smoke.map((s) => `<div class="${s.ok ? 'ok' : 'bad'}"><span>${s.ok ? '✓' : '✕'}</span><b>${ogEsc(s.id)}</b> ${ogEsc(s.detail)}</div>`).join('')}</div>` : ''}
  </div>`;
}

function ogChatWith(name) {
  const panel = document.getElementById('ide-agent-panel');
  if (panel && panel.style.display === 'none' && typeof toggleAgentPanel === 'function') toggleAgentPanel();
  const input = document.getElementById('agent-input');
  if (input) {
    input.value = `@${name} ` + input.value.replace(/^@[a-z0-9-]+\s*/, '');
    input.focus();
    input.selectionStart = input.selectionEnd = input.value.length;
  }
}

async function ogSmoke(name) {
  OG.smoking = name;
  gaRender();
  try {
    const provider = (document.getElementById('agent-provider') || {}).value;
    const res = await fetch('/agent/opengap/smoke', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Jr': '1' }, body: JSON.stringify({ container: IDE.container, name, provider }) });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'smoke test failed');
    OG.smoke[name] = d.steps;
    const failed = d.steps.filter((s) => !s.ok).length;
    showToast(failed ? `${name}: ${failed} check(s) failed` : `${name} is ready`, failed ? 'error' : 'success');
  } catch (e) {
    showToast(e.message, 'error');
  }
  OG.smoking = null;
  gaRender();
}

function ogNewAgent() {
  OG.editing = { isNew: true, name: '', role: '', priority: 30, owns: [], escalatesTo: '', terminal: false, parallel: false, fixesBuild: false, attempts: '', soulBody: '', rules: '' };
  gaRender();
}

function ogEditAgent(name) {
  const a = OG.status.agents.find((x) => x.name === name);
  if (!a) return;
  OG.editing = { isNew: false, name: a.name, role: a.role, priority: a.priority, owns: a.owns, escalatesTo: a.escalatesTo || '', terminal: a.terminal, parallel: a.parallel, fixesBuild: a.fixesBuild, attempts: a.attempts || '', soulBody: a.soulBody, rules: a.rules };
  gaRender();
}

function ogAgentFormHTML() {
  const e = OG.editing;
  const others = OG.status.agents.filter((a) => a.name !== e.name);
  return `<div class="og-form">
    <div class="og-form-title">${e.isNew ? 'New agent' : `Edit ${ogEsc(e.name)}`}</div>
    <label class="og-field"><span>Name <em>the folder name; how you @mention it</em></span><input id="og-f-name" class="og-input mono" value="${ogAttr(e.name)}" ${e.isNew ? '' : 'disabled'} placeholder="reviewer"></label>
    <label class="og-field"><span>Role <em>one line; the router reads it</em></span><input id="og-f-role" class="og-input" value="${ogAttr(e.role)}" placeholder="Reviews diffs before they land"></label>
    <div class="og-field-row">
      <label class="og-field"><span>Priority <em>lower claims first</em></span><input id="og-f-priority" type="number" min="0" max="999" class="og-input" value="${ogAttr(e.priority)}"></label>
      <label class="og-field"><span>Attempts</span><input id="og-f-attempts" type="number" min="1" max="5" class="og-input" value="${ogAttr(e.attempts)}" placeholder="default"></label>
    </div>
    <label class="og-field"><span>Owns <em>globs, comma separated; empty means anything</em></span><input id="og-f-owns" class="og-input mono" value="${ogAttr((e.owns || []).join(', '))}" placeholder="**/*.css, src/components/**"></label>
    <label class="og-field"><span>When it runs out of attempts</span>
      <select id="og-f-esc" class="og-input"><option value="">hand to the next agent by priority</option><option value="__terminal" ${e.terminal ? 'selected' : ''}>stop and ask me (terminal)</option>${others.map((a) => `<option value="${ogAttr(a.name)}" ${e.escalatesTo === a.name && !e.terminal ? 'selected' : ''}>escalate to ${ogEsc(a.name)}</option>`).join('')}</select></label>
    <div class="og-checks">
      <label><input id="og-f-parallel" type="checkbox" ${e.parallel ? 'checked' : ''}> May run beside other agents</label>
      <label><input id="og-f-fix" type="checkbox" ${e.fixesBuild ? 'checked' : ''}> Fixes red builds first</label>
    </div>
    <label class="og-field"><span>SOUL.md <em>who it is and how it works</em></span><textarea id="og-f-soul" class="og-input og-ta" rows="8" placeholder="# Reviewer\n\nYou review diffs…">${ogEsc(e.soulBody)}</textarea></label>
    <label class="og-field"><span>RULES.md <em>must / must not / escalate when</em></span><textarea id="og-f-rules" class="og-input og-ta" rows="7" placeholder="# Rules\n\n## Must\n\n## Must not\n">${ogEsc(e.rules)}</textarea></label>
    <div class="og-form-actions">
      ${e.isNew ? '' : `<button class="og-btn og-danger" type="button" onclick="ogDeleteAgent('${ogAttr(e.name)}')">Delete</button>`}
      <span class="og-spacer"></span>
      <button class="og-btn" type="button" onclick="OG.editing=null;gaRender()">Cancel</button>
      <button class="og-btn og-primary" type="button" onclick="ogSaveAgent()">Save agent</button>
    </div>
  </div>`;
}

async function ogSaveAgent() {
  const v = (id) => document.getElementById(id);
  const esc = v('og-f-esc').value;
  const agent = {
    name: v('og-f-name').value.trim(), role: v('og-f-role').value.trim(), priority: Number(v('og-f-priority').value),
    attempts: v('og-f-attempts').value ? Number(v('og-f-attempts').value) : undefined,
    owns: v('og-f-owns').value.split(',').map((s) => s.trim()).filter(Boolean),
    terminal: esc === '__terminal', escalatesTo: esc && esc !== '__terminal' ? esc : '',
    parallel: v('og-f-parallel').checked, fixesBuild: v('og-f-fix').checked,
    soulBody: v('og-f-soul').value, rules: v('og-f-rules').value,
  };
  const d = await ogPost('/agent/opengap/agent', { agent }, `Saved ${agent.name}`);
  if (d) { OG.editing = null; gaRender(); }
}

async function ogDeleteAgent(name) {
  const btn = event && event.target;
  if (btn && !btn.dataset.armed) { btn.dataset.armed = '1'; btn.textContent = 'Click again to delete'; return; }
  const d = await ogPost('/agent/opengap/agent/delete', { name }, `Deleted ${name}`);
  if (d) { OG.editing = null; gaRender(); }
}

async function ogRouting(key, value) {
  await ogPost('/agent/opengap/routing', { key, value: key === 'entry' ? value : Number(value) }, 'Routing saved');
}

async function ogOpenFile(path) {
  try {
    const d = await (await fetch(`/agent/opengap/file?container=${encodeURIComponent(IDE.container)}&path=${encodeURIComponent(path)}`)).json();
    OG.fileEdit = { path, content: d.content || '', original: d.content || '' };
  } catch (e) { showToast(e.message, 'error'); return; }
  gaRender();
}

function ogFileEditorHTML() {
  const f = OG.fileEdit;
  return `<div class="og-form">
    <div class="og-form-title mono">.gitagent/${ogEsc(f.path)}</div>
    <textarea id="og-file-ta" class="og-input og-ta og-file-ta" spellcheck="false">${ogEsc(f.content)}</textarea>
    <div class="og-form-actions"><span class="og-muted">${/\.ya?ml$/.test(f.path) ? 'Guard files must parse before they are saved; a broken one would stop every run.' : 'Every agent is given this file.'}</span><span class="og-spacer"></span>
      <button class="og-btn" type="button" onclick="OG.fileEdit=null;gaRender()">Close</button>
      <button class="og-btn og-primary" type="button" onclick="ogSaveFile()">Save</button></div>
  </div>`;
}

async function ogSaveFile() {
  const content = document.getElementById('og-file-ta').value;
  const d = await ogPost('/agent/opengap/file', { path: OG.fileEdit.path, content }, 'Saved');
  if (d) { OG.fileEdit = null; gaRender(); }
}

// ── Workflow ──

const OG_RESULT_CLASS = { done: 'done', failed: 'failed', blocked: 'failed', 'out-of-scope': 'skipped' };

function ogWorkflowHTML() {
  const st = OG.status;
  if (!st.installed) return ogNotInstalledHTML();
  const live = OG.live || ogLastRunAsLive();
  const state = {};
  if (live) {
    for (const e of live.events) {
      if (e.kind === 'route') state[e.agent] = 'route';
      if (e.kind === 'attempt') state[e.agent] = 'active';
      if (e.kind === 'result') state[e.agent] = OG_RESULT_CLASS[e.status] || 'failed';
      if (e.kind === 'stop') state[e.agent] = 'stopped';
    }
  }
  const sealed = new Set(st.guards.hooks.filter((h) => h.sealed).map((h) => h.name)).size;
  const guards = st.guards.hooks.filter((h) => h.phase === 'pre_edit' && h.enabled).length;
  const r = st.routing || {};
  return `<div class="og-flow-head">
      <span>How a task moves through your team</span>
      ${live ? `<span class="og-pill p-${ogAttr(live.outcome || 'running')}">${live.outcome ? ogEsc(live.outcome) : 'running'}</span>` : ''}
    </div>
    <div class="og-flow">
      <div class="og-node og-io">${live ? `<b>Task</b><span>${ogEsc(live.task)}</span>` : '<b>Task</b><span>a chat message, or a step of an approved plan</span>'}</div>
      <div class="og-arrow"></div>
      <div class="og-node og-router${live ? ' lit' : ''}"><b>Router</b><span>@name → routing.entry (${ogEsc(r.entry)}) → files an agent owns → classifier ≥ ${ogEsc(r.classifier_confidence_floor)}</span>${live && live.route ? `<em>→ ${ogEsc(live.route.agent)} · ${ogEsc(live.route.how)}</em>` : ''}</div>
      <div class="og-arrow"></div>
      <div class="og-lanes" id="og-lanes">
        ${st.agents.map((a) => `<div class="og-node og-agent-node s-${state[a.name] || 'idle'}" data-agent="${ogAttr(a.name)}">
          <span class="og-avatar" style="--hue:${ogHue(a.name)}">${ogInitials(a.name)}</span>
          <div><b>${ogEsc(a.name)}</b><span>P${a.priority} · ${a.owns.length ? ogEsc(a.owns.slice(0, 2).join(' ')) : 'any file'}${a.fixesBuild ? ' · fixes builds' : ''}</span></div>
          ${a.terminal ? '<i class="og-to-you">→ you</i>' : ''}
        </div>`).join('')}
        <svg class="og-arcs" id="og-arcs"></svg>
      </div>
      <div class="og-arrow"></div>
      <div class="og-node og-guard"><b>Guardrails</b><span>${guards} edit guard(s) on every write · ${sealed} sealed in code</span></div>
      <div class="og-arrow"></div>
      <div class="og-node og-io"><b>Your files</b><span>edits land in the workspace and the live preview; Source Control commits them</span></div>
    </div>
    ${live ? ogTimelineHTML(live) : '<div class="og-muted og-pad">Run a task in Fast or Planning mode, or @mention an agent, and it lights up here.</div>'}`;
}

function ogLastRunAsLive() {
  const run = OG.runs && OG.runs[0];
  if (!run) return null;
  return { task: run.task, route: run.route, events: [{ kind: 'route', agent: run.route.agent, how: run.route.how }, ...run.events], outcome: run.outcome, brief: run.brief };
}

function ogTimelineHTML(live) {
  const rows = live.events.map((e) => {
    if (e.kind === 'route') return `<li class="t-route"><b>Router</b> → ${ogEsc(e.agent)} <span>${ogEsc(e.how || '')}</span></li>`;
    if (e.kind === 'attempt') return `<li class="t-attempt"><b>${ogEsc(e.agent)}</b> attempt ${e.attempt}${e.of ? `/${e.of}` : ''}${e.model ? ` <span>${ogEsc(e.model)}</span>` : ''}${e.brief ? '<details><summary>brief it was given</summary><pre>' + ogEsc(e.brief) + '</pre></details>' : ''}</li>`;
    if (e.kind === 'result') return `<li class="t-${OG_RESULT_CLASS[e.status] || 'failed'}"><b>${ogEsc(e.agent)}</b> ${ogEsc(e.status)}${e.files ? ` <span>${ogEsc(e.files.join(', '))}</span>` : ''}${e.detail ? ` <span>${ogEsc(e.detail)}</span>` : ''}</li>`;
    if (e.kind === 'handoff') return `<li class="t-handoff"><b>${ogEsc(e.from)} → ${ogEsc(e.to)}</b> handoff <span>${ogEsc(e.reason || '')}</span><details><summary>compiled brief (${(e.brief || '').length} chars, no transcript)</summary><pre>${ogEsc(e.brief || '')}</pre></details></li>`;
    if (e.kind === 'stop') return `<li class="t-stopped"><b>${ogEsc(e.agent)}</b> stopped <span>${ogEsc(e.detail || '')}</span></li>`;
    return '';
  }).join('');
  return `<ol class="og-timeline">${rows}</ol>`;
}

// Escalation arcs between agent nodes, drawn after layout so they follow the real positions.
function ogDrawArcs() {
  const lanes = document.getElementById('og-lanes');
  const svg = document.getElementById('og-arcs');
  if (!lanes || !svg || !OG.status) return;
  const box = lanes.getBoundingClientRect();
  svg.setAttribute('width', box.width);
  svg.setAttribute('height', box.height);
  const pos = {};
  lanes.querySelectorAll('.og-agent-node').forEach((n) => {
    const r = n.getBoundingClientRect();
    pos[n.dataset.agent] = { x: r.right - box.left, y: r.top - box.top + r.height / 2 };
  });
  const handed = new Set(((OG.live || ogLastRunAsLive() || { events: [] }).events).filter((e) => e.kind === 'handoff').map((e) => `${e.from}>${e.to}`));
  let k = 0;
  const paths = [];
  for (const a of OG.status.agents) {
    if (a.terminal || !a.successor || !pos[a.name] || !pos[a.successor]) continue;
    const from = pos[a.name], to = pos[a.successor];
    const out = 14 + (k++ % 4) * 9;
    const lit = handed.has(`${a.name}>${a.successor}`);
    paths.push(`<path d="M ${from.x - 4} ${from.y} C ${from.x + out} ${from.y}, ${to.x + out} ${to.y}, ${to.x - 4} ${to.y}" class="og-arc${lit ? ' lit' : ''}" marker-end="url(#og-ah${lit ? '-lit' : ''})"/>`);
  }
  svg.innerHTML = `<defs>
    <marker id="og-ah" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="og-ah"/></marker>
    <marker id="og-ah-lit" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" class="og-ah lit"/></marker>
  </defs>${paths.join('')}`;
}

// ── Guardrails ──

const OG_PHASES = [['pre_edit', 'On every edit'], ['pre_command', 'On every command'], ['pre_commit', 'Before a commit'], ['post_run', 'After a run']];

function ogGuardsHTML() {
  const st = OG.status;
  if (!st.installed) return ogNotInstalledHTML();
  const g = st.guards;
  const groups = OG_PHASES.map(([phase, label]) => {
    const hooks = g.hooks.filter((h) => h.phase === phase);
    if (!hooks.length) return '';
    return `<div class="og-sec">${label}</div>${hooks.map(ogGuardRowHTML).join('')}`;
  }).join('');
  return `${g.error ? `<div class="og-problem error"><b>hooks/</b> ${ogEsc(g.error)}</div>` : ''}
    <div class="og-legend"><span><i class="og-lock">🔒</i> sealed in code: cannot be switched off, weakened or shortened</span><span><i class="og-sw on"></i> overridable</span></div>
    <div class="og-toolbar">
      <button class="og-btn og-primary" type="button" onclick="OG.guardForm=!OG.guardForm;gaRender()">${OG.guardForm ? 'Close' : '+ Add guard'}</button>
      ${g.files.map((f) => `<button class="og-btn mono" type="button" onclick="ogOpenFile('${ogAttr(f.replace(/^\.gitagent\//, ''))}')">${ogEsc(f.replace(/^\.gitagent\//, ''))}</button>`).join('')}
    </div>
    ${OG.guardForm ? ogGuardFormHTML() : ''}
    ${groups}
    <p class="og-muted og-pad">Edit guards run on the exact content an agent is about to write. A blocked edit fails the attempt; a sealed block stops the run, because no agent can get past it.</p>`;
}

function ogGuardRowHTML(h) {
  const scope = [...h.paths.map((p) => `<code>${ogEsc(p)}</code>`), ...h.commands.map((c) => `<code>${ogEsc(c)}</code>`)];
  if (h.allow.length) scope.push(`<span class="og-muted">allow</span> ${h.allow.slice(0, 4).map((p) => `<code>${ogEsc(p)}</code>`).join(' ')}`);
  return `<div class="og-guard${h.enabled ? '' : ' off'}">
    <div class="og-guard-top">
      ${h.sealed ? '<i class="og-lock" title="Sealed in code">🔒</i>' : `<button class="og-sw${h.enabled ? ' on' : ''}" type="button" title="${h.enabled ? 'Switch off' : 'Switch on'}" onclick="ogPost('/agent/opengap/guard/toggle', {name:'${ogAttr(h.name)}', enabled:${!h.enabled}}, '${ogAttr(h.name)} ${h.enabled ? 'off' : 'on'}')"></button>`}
      <b>${ogEsc(h.name)}</b>
      <span class="og-sev s-${ogAttr(h.severity)}">${ogEsc(h.severity)}</span>
      ${h.appliesTo.length ? `<span class="og-muted">only ${ogEsc(h.appliesTo.join(', '))}</span>` : ''}
    </div>
    ${h.description ? `<div class="og-guard-desc">${ogEsc(h.description)}</div>` : ''}
    ${scope.length ? `<div class="og-guard-scope">${scope.slice(0, 10).join(' ')}${scope.length > 10 ? ` <span class="og-muted">+${scope.length - 10}</span>` : ''}</div>` : ''}
  </div>`;
}

function ogGuardFormHTML() {
  const agents = OG.status.agents;
  return `<div class="og-form og-inline-form">
    <div class="og-field-row">
      <label class="og-field"><span>Name</span><input id="og-g-name" class="og-input mono" placeholder="keep-payments-safe"></label>
      <label class="og-field"><span>When</span><select id="og-g-phase" class="og-input"><option value="pre_edit">on edit (paths)</option><option value="pre_command">on command</option></select></label>
    </div>
    <label class="og-field"><span>Paths or commands <em>comma separated</em></span><input id="og-g-items" class="og-input mono" placeholder="payments/**, migrations/**"></label>
    <div class="og-field-row">
      <label class="og-field"><span>Severity</span><select id="og-g-sev" class="og-input"><option value="block">block</option><option value="checkpoint">checkpoint (ask me)</option><option value="warn">warn</option></select></label>
      <label class="og-field"><span>Applies to</span><select id="og-g-applies" class="og-input" multiple size="3">${agents.map((a) => `<option value="${ogAttr(a.name)}">${ogEsc(a.name)}</option>`).join('')}</select></label>
    </div>
    <label class="og-field"><span>Why</span><input id="og-g-desc" class="og-input" placeholder="Money code is reviewed by a person"></label>
    <div class="og-form-actions"><span class="og-spacer"></span><button class="og-btn og-primary" type="button" onclick="ogAddGuard()">Add guard</button></div>
  </div>`;
}

async function ogAddGuard() {
  const v = (id) => document.getElementById(id);
  const guard = {
    name: v('og-g-name').value.trim(), phase: v('og-g-phase').value, severity: v('og-g-sev').value,
    items: v('og-g-items').value.split(',').map((s) => s.trim()).filter(Boolean),
    appliesTo: [...v('og-g-applies').selectedOptions].map((o) => o.value), description: v('og-g-desc').value.trim(),
  };
  const d = await ogPost('/agent/opengap/guard', { guard }, `Guard ${guard.name} added`);
  if (d) { OG.guardForm = false; gaRender(); }
}

// ── Runs ──

function ogRunsHTML() {
  if (!OG.runs.length) return '<div class="og-empty">No team runs yet. Every run is recorded in <code>.gitagent/.session/</code> with the context ledger the agents shared.</div>';
  return `<div class="og-runs">${OG.runs.map((r) => {
    const open = OG.openRun === r.id;
    const hops = [...new Set([r.route.agent, ...r.events.filter((e) => e.kind === 'handoff').map((e) => e.to)])];
    return `<div class="og-run${open ? ' open' : ''}">
      <button class="og-run-head" type="button" onclick="OG.openRun=OG.openRun==='${ogAttr(r.id)}'?null:'${ogAttr(r.id)}';gaRender()">
        <span class="og-pill p-${ogAttr(r.outcome)}">${ogEsc(r.outcome)}</span>
        <span class="og-run-task">${ogEsc(r.task)}</span>
        <span class="og-muted">${ogEsc(hops.join(' → '))} · ${new Date(r.at).toLocaleTimeString()}</span>
      </button>
      ${open ? `${ogTimelineHTML({ events: [{ kind: 'route', agent: r.route.agent, how: r.route.how }, ...r.events] })}
        ${ogLedgerHTML(r.ledger)}
        <details class="og-brief"><summary>Context brief (what the next model would be given)</summary><pre>${ogEsc(r.brief || '')}</pre></details>` : ''}
    </div>`;
  }).join('')}</div>`;
}

// The shared record: what was verified by the harness versus only claimed by a model.
function ogLedgerHTML(l) {
  if (!l) return '';
  const row = (label, items, fmt) => (items && items.length ? `<div class="og-sec">${label}</div><ul class="og-ledger">${items.map(fmt).join('')}</ul>` : '');
  const mark = (x) => (x.verified ? '<span class="og-v ok">verified</span>' : '<span class="og-v">claimed</span>');
  return `${row('Files touched', l.artifacts, (a) => `<li><code>${ogEsc(a.path)}</code> ${mark(a)} <span class="og-muted">by ${ogEsc(a.recorded_by)}</span></li>`)}
    ${row('Work completed', l.completed, (w) => `<li>${ogEsc(w.what)} ${mark(w)}</li>`)}
    ${row('Ruled out (append-only)', l.failed, (f) => `<li><b>${ogEsc(f.tier)}</b> ${ogEsc(f.approach)}${f.why ? ` — ${ogEsc(f.why)}` : ''}</li>`)}`;
}

// ── Chat: the team's live workflow ──

function ogHandleEvent(e) {
  if (e.kind === 'route') OG.live = { task: '', route: { agent: e.agent, how: e.how }, events: [], outcome: null };
  if (!OG.live) OG.live = { task: '', route: null, events: [], outcome: null };
  if (e.kind === 'end') {
    OG.live.outcome = e.outcome;
    OG.live.brief = e.brief;
    ogLoadRuns(true).then(() => { if (GitAgent.tab === 'runs' || GitAgent.tab === 'workflow') gaRender(); });
  } else {
    OG.live.events.push(e);
  }
  ogRenderChatCard(e);
  const panel = document.getElementById('ide-gitagent-panel');
  if (panel && panel.style.display !== 'none' && GitAgent.tab === 'workflow') gaRender();
}

function ogRenderChatCard(e) {
  const box = (typeof agentTurn !== 'undefined' && agentTurn && agentTurn.messagesEl) || document.getElementById('agent-messages');
  if (!box) return;
  if (agentTurn) { clearLoad(agentTurn); agentTurn.assistantEl = null; }
  let card = box.querySelector('.og-chat:not(.closed)');
  if (e.kind === 'route' || !card) {
    if (card) card.classList.add('closed');
    card = document.createElement('div');
    card.className = 'og-chat';
    card.innerHTML = `<div class="og-chat-head"><span>OpenGAP team</span><button type="button" onclick="openGitAgentPanel('workflow')">Workflow ↗</button></div><ol class="og-timeline"></ol>`;
    box.appendChild(card);
  }
  if (e.kind === 'end') {
    card.classList.add('closed', `o-${e.outcome}`);
    card.querySelector('.og-chat-head span').textContent = e.outcome === 'done' ? 'OpenGAP team · done' : 'OpenGAP team · stopped: needs you';
  } else {
    card.querySelector('.og-timeline').insertAdjacentHTML('beforeend', ogTimelineHTML({ events: [e] }).replace(/^<ol class="og-timeline">|<\/ol>$/g, ''));
  }
  scrollAgent(box);
}

// After each render: arcs on the Workflow tab, and the Registry tab's "add to team" buttons.
function ogAfterRender(tab) {
  if (tab === 'workflow') requestAnimationFrame(ogDrawArcs);
  if (tab === 'registry') {
    document.querySelectorAll('#ga-list .ga-card').forEach((card) => {
      const ref = (card.querySelector('.ga-card-name') || {}).textContent;
      const actions = card.querySelector('.ga-card-actions');
      if (!ref || !actions || actions.querySelector('.og-team-add')) return;
      const b = document.createElement('button');
      b.className = 'ga-btn og-team-add';
      b.textContent = '+ Team';
      b.title = 'Add it to your OpenGAP team as an agent in .gitagent/agents/';
      b.onclick = () => ogPost('/agent/opengap/add', { ref, kind: 'agent' }, `${ref} joined the team`);
      actions.prepend(b);
    });
  }
}

window.addEventListener('resize', () => { if (GitAgent && GitAgent.tab === 'workflow') ogDrawArcs(); });
