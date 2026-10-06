// Agent Hub: lists the user's agents and manages one at a time in a drawer.
const HUB = { agents: [], meta: null, current: null, tab: 'overview' };

const TABS = [
  ['overview', 'Overview'], ['test', 'Test'], ['runs', 'Runs'], ['versions', 'Versions'], ['n8n', 'n8n'], ['prompt', 'Prompt & files'],
];

async function loadAgents() {
  const list = document.getElementById('agent-list');
  try {
    const [{ agents }, meta] = await Promise.all([hubApi('GET', '/agents'), HUB.meta ? HUB.meta : hubApi('GET', '/meta')]);
    HUB.agents = agents;
    HUB.meta = meta;
  } catch (e) {
    list.innerHTML = `<div class="h-callout bad">Could not load agents: ${esc(e.message)}</div>`;
    return;
  }
  if (!HUB.agents.length) {
    list.innerHTML = `
      <div class="h-empty" style="grid-column: 1 / -1">
        <h2>No agents yet</h2>
        <p>Describe what you want in plain English and Agent Builder designs it with you, or define every detail yourself.</p>
        <div class="h-row" style="justify-content:center; margin-top: var(--sp-5)">
          <button class="h-btn" onclick="openStudio()">Create your first agent</button>
          <button class="h-btn h-btn-ghost" onclick="openImport()">Import one</button>
        </div>
      </div>`;
    return;
  }
  list.innerHTML = HUB.agents.map(({ definition: d, updatedAt, n8n }) => {
    const v = d.validation;
    return `
      <article class="h-card ${HUB.current && HUB.current.id === d.id ? 'selected' : ''}" tabindex="0" data-id="${esc(d.id)}">
        <div class="h-row" style="justify-content:space-between">
          <h3>${esc(d.identity.name)}</h3>
          <span class="h-pill">v${esc(d.version)}</span>
        </div>
        <p>${esc(d.identity.description || d.purpose || 'No description yet.')}</p>
        <div class="h-card-foot">
          <span class="h-pill">${esc(d.model.provider)}</span>
          ${d.tools.map((t) => `<span class="h-pill accent">${esc(t.id)}</span>`).join('')}
          ${d.guardrails.rules.length ? `<span class="h-pill">${d.guardrails.rules.length} guardrail${d.guardrails.rules.length === 1 ? '' : 's'}</span>` : ''}
          ${d.humanInTheLoop.approveOutput || d.humanInTheLoop.approveTools.length ? '<span class="h-pill warn">human approval</span>' : ''}
          ${n8n ? '<span class="h-pill good">n8n connected</span>' : ''}
          ${v.ok ? '' : `<span class="h-pill bad">${v.errors.length} issue${v.errors.length === 1 ? '' : 's'}</span>`}
        </div>
        <div class="h-muted">Updated ${esc(timeAgo(updatedAt))}</div>
      </article>`;
  }).join('');
  list.querySelectorAll('.h-card').forEach((c) => {
    c.addEventListener('click', () => openAgent(c.dataset.id));
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') openAgent(c.dataset.id); });
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showMenu(e.clientX, e.clientY, agentMenu(c.dataset.id)); });
  });
  if (HUB.current && !HUB.agents.some((a) => a.definition.id === HUB.current.id)) closeDrawer();
}

async function openAgent(id, tab) {
  try {
    const data = await hubApi('GET', `/agents/${encodeURIComponent(id)}`);
    HUB.current = { id, ...data };
  } catch (e) {
    hubToast(e.message, 'error');
    return;
  }
  HUB.tab = tab || HUB.tab || 'overview';
  const d = HUB.current.definition;
  document.getElementById('d-name').textContent = d.identity.name;
  document.getElementById('d-badges').innerHTML = `
    <span class="h-pill">v${esc(d.version)}</span>
    <span class="h-pill">${esc(d.id)}</span>
    ${HUB.current.validation.ok ? '<span class="h-pill good">valid</span>' : `<span class="h-pill bad">${HUB.current.validation.errors.length} issue(s)</span>`}
    ${HUB.current.n8n ? '<span class="h-pill good">n8n connected</span>' : ''}`;
  document.getElementById('d-actions').innerHTML = `
    <button class="h-btn h-btn-sm" onclick="openStudio('${esc(id)}')">Edit in Studio</button>
    <button class="h-btn h-btn-ghost h-btn-sm" onclick="openFlow('', '${esc(id)}')">Use in a workflow</button>
    <button class="h-btn h-btn-ghost h-btn-sm" onclick="duplicateAgent('${esc(id)}')">Duplicate</button>
    <button class="h-btn h-btn-ghost h-btn-sm" onclick="exportAgent('${esc(id)}')">Export</button>
    <button class="h-btn h-btn-danger h-btn-sm" onclick="deleteAgent('${esc(id)}')">Delete</button>`;
  document.getElementById('d-tabs').innerHTML = TABS.map(([k, label]) =>
    `<button class="h-tab ${k === HUB.tab ? 'active' : ''}" data-tab="${k}">${label}</button>`).join('');
  document.querySelectorAll('#d-tabs .h-tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));
  const drawer = document.getElementById('drawer');
  drawer.classList.add('open');
  drawer.setAttribute('aria-hidden', 'false');
  document.querySelectorAll('.h-card').forEach((c) => c.classList.toggle('selected', c.dataset.id === id));
  showTab(HUB.tab);
}

function closeDrawer() {
  HUB.current = null;
  const drawer = document.getElementById('drawer');
  drawer.classList.remove('open');
  drawer.setAttribute('aria-hidden', 'true');
  document.querySelectorAll('.h-card').forEach((c) => c.classList.remove('selected'));
}

function showTab(tab) {
  HUB.tab = tab;
  document.querySelectorAll('#d-tabs .h-tab').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  const body = document.getElementById('d-body');
  body.innerHTML = '';
  ({ overview: tabOverview, test: tabTest, runs: tabRuns, versions: tabVersions, n8n: tabN8n, prompt: tabPrompt })[tab](body);
}

function listOrNone(items, fmt = esc) {
  return items.length ? `<ul class="h-list">${items.map((x) => `<li>${fmt(x)}</li>`).join('')}</ul>` : '<div class="h-muted">None</div>';
}

function schemaSummary(s) {
  if (s.type !== 'object') return esc(s.type);
  const props = Object.entries(s.properties || {});
  if (!props.length) return '<span class="h-muted">any object</span>';
  return props.map(([k, v]) => `<code>${esc(k)}</code> ${esc(v.type)}${(s.required || []).includes(k) ? '' : '?'}`).join(', ');
}

function tabOverview(body) {
  const { definition: d, validation: v } = HUB.current;
  const tools = HUB.meta.tools;
  const issues = [...v.errors.map((e) => ['bad', e]), ...v.warnings.map((w) => ['warn', w])];
  body.innerHTML = `
    ${issues.length ? issues.map(([k, i]) => `<div class="h-callout ${k}">${esc(i.message)}</div>`).join('') : '<div class="h-callout good">This agent passes validation.</div>'}
    <span class="h-label">Purpose</span><div>${esc(d.purpose) || '<span class="h-muted">Not set</span>'}</div>
    <span class="h-label">Responsibilities</span>${listOrNone(d.responsibilities)}
    <span class="h-label">Model</span>
    <dl class="h-kv"><dt>Provider</dt><dd>${esc(d.model.provider)}</dd><dt>Model</dt><dd>${esc(d.model.name || (HUB.meta.providers.find((p) => p.id === d.model.provider) || {}).model || 'default')}</dd><dt>Max output</dt><dd>${d.model.maxOutputTokens} tokens</dd></dl>
    <span class="h-label">Tools</span>${listOrNone(d.tools, (t) => `<strong>${esc(t.id)}</strong> <span class="h-muted">${esc(tools[t.id] ? tools[t.id].description : '')}</span>`)}
    <span class="h-label">Guardrails</span>${listOrNone(d.guardrails.rules)}
    ${d.guardrails.blockedTerms.length ? `<div class="h-help">Blocked terms: ${d.guardrails.blockedTerms.map(esc).join(', ')}</div>` : ''}
    <div class="h-help">Secrets in input or output are ${d.guardrails.blockSecrets ? 'blocked' : '<strong>not</strong> blocked'}.</div>
    <span class="h-label">Permissions</span>
    <dl class="h-kv"><dt>Repositories</dt><dd>${d.permissions.repos.map(esc).join(', ') || 'none'}</dd><dt>Domains</dt><dd>${d.permissions.domains.map(esc).join(', ') || 'none'}</dd></dl>
    <span class="h-label">Human in the loop</span>
    <dl class="h-kv"><dt>Approve output</dt><dd>${d.humanInTheLoop.approveOutput ? 'Yes' : 'No'}</dd><dt>Approve tools</dt><dd>${d.humanInTheLoop.approveTools.map(esc).join(', ') || 'none'}</dd></dl>
    <span class="h-label">Input and output</span>
    <dl class="h-kv"><dt>Input</dt><dd>${schemaSummary(d.inputSchema)}</dd><dt>Output</dt><dd>${d.runtime.outputFormat === 'json' ? schemaSummary(d.outputSchema) : 'plain text'}</dd></dl>
    <span class="h-label">Runtime</span>
    <dl class="h-kv"><dt>Memory</dt><dd>${esc(d.memory.mode)}</dd><dt>Max steps</dt><dd>${d.runtime.maxSteps}</dd><dt>Timeout</dt><dd>${d.runtime.timeoutSeconds}s</dd></dl>
    ${d.memory.mode === 'persistent' ? '<div class="h-row" style="margin-top: var(--sp-4)"><button class="h-btn h-btn-ghost h-btn-sm" onclick="showMemory()">View memory</button><button class="h-btn h-btn-danger h-btn-sm" onclick="clearMemory()">Clear memory</button></div><div id="memory-box"></div>' : ''}`;
}

async function showMemory() {
  const { notes } = await hubApi('GET', `/agents/${HUB.current.id}/memory`);
  document.getElementById('memory-box').innerHTML = `<span class="h-label">Memory notes</span>${listOrNone(notes, (n) => `${esc(n.note)} <span class="h-muted">${esc(timeAgo(n.at))}</span>`)}`;
}

async function clearMemory() {
  if (!confirm('Forget everything this agent has saved to memory?')) return;
  await hubApi('DELETE', `/agents/${HUB.current.id}/memory`);
  hubToast('Memory cleared');
  showMemory();
}


function tabTest(body) {
  const d = HUB.current.definition;
  body.innerHTML = `
    <p class="h-muted">Runs the saved version (v${esc(d.version)}) exactly as n8n would, and records the run.</p>
    <span class="h-label">Input (JSON)</span>
    <textarea id="t-input" class="h-textarea mono" rows="8">${esc(JSON.stringify(sampleFor(d.inputSchema), null, 2))}</textarea>
    <div class="h-row" style="margin-top: var(--sp-3)"><button class="h-btn" id="t-run">Run agent</button><span class="h-muted" id="t-state"></span></div>
    <div id="t-out" style="margin-top: var(--sp-4)"></div>`;
  document.getElementById('t-run').addEventListener('click', () => runTest(d.id));
}

async function runTest(id) {
  let input;
  try { input = JSON.parse(document.getElementById('t-input').value || 'null'); } catch { hubToast('Input is not valid JSON', 'error'); return; }
  const btn = document.getElementById('t-run');
  btn.disabled = true;
  document.getElementById('t-state').textContent = 'Running…';
  try {
    const { run } = await hubApi('POST', '/test', { agentId: id, input });
    showRunIn(document.getElementById('t-out'), run, id);
  } catch (e) {
    hubToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    document.getElementById('t-state').textContent = '';
  }
}

function showRunIn(box, run, agentId) {
  box.innerHTML = '';
  box.appendChild(renderRun(run, {
    onDecision: async (approved, note) => {
      try {
        const out = await hubApi('POST', `/runs/${run.id}/decision`, { agentId, approved, note });
        showRunIn(box, out.run, agentId);
      } catch (e) { hubToast(e.message, 'error'); }
    },
  }));
}

async function tabRuns(body) {
  body.innerHTML = '<div class="h-muted">Loading runs…</div>';
  const { runs } = await hubApi('GET', `/agents/${HUB.current.id}/runs`);
  if (!runs.length) { body.innerHTML = '<div class="h-muted">No runs yet. Try the Test tab, or call it from n8n.</div>'; return; }
  body.innerHTML = '<p class="h-muted" style="margin-bottom: var(--sp-4)">Latest runs from Studio, this Hub and n8n. Paused runs can be approved here.</p>';
  for (const r of runs) {
    const box = document.createElement('div');
    showRunIn(box, r, HUB.current.id);
    body.appendChild(box);
  }
}

async function tabVersions(body) {
  body.innerHTML = '<div class="h-muted">Loading versions…</div>';
  const { versions } = await hubApi('GET', `/agents/${HUB.current.id}/versions`);
  const cur = HUB.current.definition.version;
  body.innerHTML = `<p class="h-muted">Each save is a git commit in the agent's own repository.</p>
    <div>${versions.map((v) => `
      <div class="h-version">
        <span class="h-pill ${v.version === cur ? 'accent' : ''}">v${esc(v.version)}</span>
        <span style="flex:1">${esc(v.message)} <span class="h-muted">· ${esc(timeAgo(v.at))} · ${esc(v.sha.slice(0, 7))}</span></span>
        ${v.version === cur ? '<span class="h-muted">current</span>' : `<button class="h-link" data-sha="${esc(v.sha)}" data-act="view">Compare</button><button class="h-link" data-sha="${esc(v.sha)}" data-act="restore">Restore</button>`}
      </div>`).join('')}</div>
    <div id="v-diff" style="margin-top: var(--sp-5)"></div>`;
  body.querySelectorAll('[data-act="view"]').forEach((b) => b.addEventListener('click', async () => {
    const { definition, diffFromCurrent } = await hubApi('GET', `/agents/${HUB.current.id}/versions/${b.dataset.sha}`);
    document.getElementById('v-diff').innerHTML = `<span class="h-label">Current → v${esc(definition.version)}</span>${renderDiff(diffFromCurrent)}`;
  }));
  body.querySelectorAll('[data-act="restore"]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('Restore this version? It is saved as a new version; nothing is lost.')) return;
    try {
      const out = await hubApi('POST', `/agents/${HUB.current.id}/versions/${b.dataset.sha}/restore`);
      hubToast(out.changed ? `Restored as v${out.definition.version}` : 'Already identical to the current version');
      await loadAgents();
      openAgent(HUB.current.id, 'versions');
    } catch (e) { hubToast(e.message, 'error'); }
  }));
}

async function tabN8n(body) {
  body.innerHTML = '<div class="h-muted">Loading…</div>';
  const info = await hubApi('GET', `/agents/${HUB.current.id}/connect`);
  renderN8n(body, info, '');
}

function renderN8n(body, info, token) {
  const key = info.key;
  body.innerHTML = `
    <p>n8n runs the workflow; Jr Architect runs the agent. An n8n <strong>HTTP Request</strong> node calls the agent with a token, gets structured output back, and the workflow continues.</p>
    ${info.localOnly ? '<div class="h-callout warn">This server has no public address, so only an n8n on this machine can reach these URLs.</div>' : ''}
    ${token ? `<div class="h-callout good"><strong>Copy this token now.</strong> Only a hash is stored, so it cannot be shown again.<pre class="h-code">${esc(token)}</pre><button class="h-btn h-btn-sm" onclick="copyText('${esc(token)}')">Copy token</button></div>` : ''}
    <div class="h-row" style="margin: var(--sp-4) 0">
      ${key ? `<span class="h-pill good">Connected</span><span class="h-muted">token ${esc(key.prefix)} · created ${esc(timeAgo(key.createdAt))}${key.lastUsedAt ? ` · last used ${esc(timeAgo(key.lastUsedAt))}` : ''}</span>` : '<span class="h-pill">Not connected</span>'}
    </div>
    <div class="h-row">
      <button class="h-btn" id="n-issue">${key ? 'Replace token' : 'Connect to n8n'}</button>
      ${key ? '<button class="h-btn h-btn-danger" id="n-revoke">Disconnect</button>' : ''}
      <button class="h-btn h-btn-ghost" id="n-workflow">Download n8n workflow</button>
    </div>
    <span class="h-label">Run endpoint</span>
    <pre class="h-code">POST ${esc(info.runUrl)}
Authorization: Bearer &lt;token&gt;
Content-Type: application/json

${esc(JSON.stringify(info.exampleBody, null, 2))}</pre>
    <span class="h-label">What comes back</span>
    <ul class="h-list">
      <li><code>status</code>: completed, awaiting_approval, failed, rejected or blocked</li>
      <li><code>output</code>: the agent's result, checked against its output schema</li>
      <li>If a human must approve, the response is <code>202</code> with a <code>decisionUrl</code>. Approve in this Hub, or POST <code>{"approved": true}</code> to it from n8n.</li>
      <li>Add <code>"callbackUrl"</code> (an n8n Wait node's <code>$execution.resumeUrl</code>) to be called when a paused run ends, or <code>"wait": false</code> to return immediately and poll.</li>
    </ul>
    <span class="h-label">Try it with curl</span>
    <pre class="h-code">${esc(info.curl)}</pre>
    <div class="h-help">The token can run only this agent, within its own tools, permissions, guardrails and your hourly AI limit.</div>`;
  document.getElementById('n-issue').addEventListener('click', async () => {
    if (key && !confirm('Replace the token? Workflows using the old one stop working.')) return;
    const out = await hubApi('POST', `/agents/${HUB.current.id}/connect`);
    renderN8n(body, { ...out, key: { prefix: out.token.slice(0, 16) + '…', createdAt: Date.now() } }, out.token);
    HUB.lastWorkflow = out.workflow;
    loadAgents();
  });
  const revoke = document.getElementById('n-revoke');
  if (revoke) revoke.addEventListener('click', async () => {
    if (!confirm('Disconnect? n8n calls with this token will be refused.')) return;
    await hubApi('DELETE', `/agents/${HUB.current.id}/connect`);
    hubToast('Disconnected');
    loadAgents();
    tabN8n(body);
  });
  document.getElementById('n-workflow').addEventListener('click', () => {
    downloadJSON(`${HUB.current.id}.n8n-workflow.json`, info.workflow);
    hubToast(token ? 'Workflow downloaded with your token filled in' : 'Workflow downloaded; paste your token into the HTTP Request node');
  });
}

function tabPrompt(body) {
  const { prompt, files } = HUB.current;
  body.innerHTML = `
    <p class="h-muted">The system prompt is derived from the agent definition on every run. It is shown here for inspection; edit the definition, not the prompt.</p>
    <span class="h-label">Derived system prompt</span><pre class="h-code">${esc(prompt)}</pre>
    ${Object.entries(files).map(([name, text]) => `<span class="h-label">${esc(name)}</span><pre class="h-code">${esc(text)}</pre>`).join('')}`;
}

async function duplicateAgent(id) {
  try {
    const { definition } = await hubApi('POST', `/agents/${id}/duplicate`);
    hubToast(`Created ${definition.identity.name}`);
    await loadAgents();
    openAgent(definition.id, 'overview');
  } catch (e) { hubToast(e.message, 'error'); }
}

async function exportAgent(id) {
  try {
    const bundle = await hubApi('GET', `/agents/${id}/export`);
    downloadJSON(`${id}.jr-agent.json`, bundle);
  } catch (e) { hubToast(e.message, 'error'); }
}

async function deleteAgent(id, confirmed = false) {
  if (!confirmed && !confirm('Delete this agent, its versions, runs and n8n token? This cannot be undone.')) return;
  try {
    await hubApi('DELETE', `/agents/${id}`);
    hubToast('Agent deleted');
    closeDrawer();
    loadAgents();
  } catch (e) { hubToast(e.message, 'error'); }
}

function openImport() {
  const root = document.getElementById('modal-root');
  root.innerHTML = `
    <div class="h-modal-bg" id="imp-bg">
      <div class="h-modal" role="dialog" aria-modal="true" aria-labelledby="imp-title">
        <h2 id="imp-title">Import an agent</h2>
        <span class="h-label">From a file</span>
        <input type="file" id="imp-file" accept=".json,application/json" class="h-input">
        <div class="h-help">A .jr-agent.json exported from any Jr Architect.</div>
        <span class="h-label">From GitHub (gitagent)</span>
        <input type="text" id="imp-repo" class="h-input mono" placeholder="owner/repo or https://github.com/owner/repo/tree/main/path">
        <div class="h-help">Reads agent.yaml, SOUL.md and RULES.md. Nothing from the repository is executed.</div>
        <div class="h-row" style="margin-top: var(--sp-5); justify-content: flex-end">
          <button class="h-btn h-btn-ghost" id="imp-cancel">Cancel</button>
          <button class="h-btn" id="imp-go">Import</button>
        </div>
      </div>
    </div>`;
  const close = () => { root.innerHTML = ''; };
  document.getElementById('imp-cancel').addEventListener('click', close);
  document.getElementById('imp-bg').addEventListener('click', (e) => { if (e.target.id === 'imp-bg') close(); });
  document.getElementById('imp-go').addEventListener('click', async () => {
    const file = document.getElementById('imp-file').files[0];
    const repo = document.getElementById('imp-repo').value.trim();
    try {
      let body;
      if (file) body = { bundle: JSON.parse(await file.text()) };
      else if (repo) body = { repo };
      else { hubToast('Choose a file or enter a repository', 'error'); return; }
      const { definition } = await hubApi('POST', '/import', body);
      close();
      hubToast(`Imported ${definition.identity.name}`);
      await loadAgents();
      openAgent(definition.id, 'overview');
    } catch (e) { hubToast(e.message, 'error'); }
  });
}

// --- workflows ---

function openFlow(id, agentId) {
  location.href = id ? `/flows.html?id=${encodeURIComponent(id)}` : agentId ? `/flows.html?agent=${encodeURIComponent(agentId)}` : '/flows.html';
}

async function loadWorkflows() {
  const list = document.getElementById('workflow-list');
  let workflows;
  try { ({ workflows } = await hubApi('GET', '/workflows')); } catch (e) { list.innerHTML = `<div class="h-callout bad">${esc(e.message)}</div>`; return; }
  if (!workflows.length) {
    list.innerHTML = `<div class="h-empty" style="grid-column: 1 / -1"><h2>No workflows yet</h2>
      <p>Start with a trigger, drop in an agent, branch on its answer, and ask a person before anything goes out.</p>
      <div class="h-row" style="justify-content:center; margin-top: var(--sp-5)"><button class="h-btn" onclick="openFlow()">Create a workflow</button></div></div>`;
    return;
  }
  list.innerHTML = workflows.map((w) => {
    const agents = w.nodes.filter((n) => n.type === 'agent');
    return `<article class="h-card" tabindex="0" data-wf="${esc(w.id)}">
      <div class="h-row" style="justify-content:space-between"><h3>${esc(w.name)}</h3><span class="h-pill">v${esc(w.version)}</span></div>
      <p>${esc(w.description || `${w.nodes.length} nodes, ${w.edges.length} connections`)}</p>
      <div class="h-card-foot">
        ${agents.map((n) => `<span class="h-pill accent">${esc(n.name)}</span>`).join('')}
        ${w.nodes.some((n) => n.type === 'approval') ? '<span class="h-pill warn">human approval</span>' : ''}
        ${w.webhook ? '<span class="h-pill good">webhook on</span>' : ''}
        ${w.validation.ok ? '' : `<span class="h-pill bad">${w.validation.errors.length} issue(s)</span>`}
      </div>
      <div class="h-row" style="justify-content:space-between">
        <span class="h-muted">Updated ${esc(timeAgo(w.updatedAt))}</span>
        <span class="h-row"><a class="h-link" href="/playground.html?id=${encodeURIComponent(w.id)}">Playground</a><button class="h-link" data-dup="${esc(w.id)}">Duplicate</button><button class="h-link" data-del="${esc(w.id)}">Delete</button></span>
      </div>
    </article>`;
  }).join('');
  list.querySelectorAll('[data-wf]').forEach((c) => {
    c.addEventListener('click', (e) => { if (!e.target.closest('button, a')) openFlow(c.dataset.wf); });
    c.addEventListener('keydown', (e) => { if (e.key === 'Enter') openFlow(c.dataset.wf); });
    c.addEventListener('contextmenu', (e) => { e.preventDefault(); e.stopPropagation(); showMenu(e.clientX, e.clientY, workflowMenu(c.dataset.wf)); });
  });
  list.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', async () => {
    try { await hubApi('POST', `/workflows/${b.dataset.dup}/duplicate`); hubToast('Duplicated'); loadWorkflows(); } catch (e) { hubToast(e.message, 'error'); }
  }));
  list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => {
    if (confirm('Delete this workflow, its run history and its webhook token? Its past versions stay in the git history.')) deleteWorkflow(b.dataset.del);
  }));
}

async function duplicateWorkflow(id) {
  try { await hubApi('POST', `/workflows/${id}/duplicate`); hubToast('Duplicated'); loadWorkflows(); } catch (e) { hubToast(e.message, 'error'); }
}

async function deleteWorkflow(id) {
  try { await hubApi('DELETE', `/workflows/${id}`); hubToast('Workflow deleted'); loadWorkflows(); } catch (e) { hubToast(e.message, 'error'); }
}

// --- right-click menus on cards and on the empty part of each list ---

function agentMenu(id) {
  return [
    { label: 'Open', icon: 'open', onClick: () => openAgent(id) },
    { label: 'Edit in Studio', icon: 'pencil', onClick: () => openStudio(id) },
    { label: 'Use in a new workflow', icon: 'flows', onClick: () => openFlow(null, id) },
    '-',
    { label: 'Duplicate', icon: 'copy', onClick: () => duplicateAgent(id) },
    { label: 'Export', icon: 'external', onClick: () => exportAgent(id) },
    { label: 'New agent', icon: 'plus', onClick: () => openStudio() },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, confirm: 'Click again to delete', onClick: () => deleteAgent(id, true) },
  ];
}

function workflowMenu(id) {
  return [
    { label: 'Open', icon: 'open', onClick: () => openFlow(id) },
    { label: 'Open Playground', icon: 'play', onClick: () => { location.href = `/playground.html?id=${encodeURIComponent(id)}`; } },
    { label: 'Open in new tab', icon: 'external', onClick: () => window.open(`/flows.html?id=${encodeURIComponent(id)}`, '_blank') },
    '-',
    { label: 'Duplicate', icon: 'copy', onClick: () => duplicateWorkflow(id) },
    { label: 'New workflow', icon: 'plus', onClick: () => openFlow() },
    '-',
    { label: 'Delete', icon: 'trash', danger: true, confirm: 'Click again to delete', onClick: () => deleteWorkflow(id) },
  ];
}

document.getElementById('agent-list').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [{ label: 'New agent', icon: 'plus', onClick: () => openStudio() }, { label: 'Import an agent', icon: 'clipboard', onClick: openImport }]);
});
document.getElementById('workflow-list').addEventListener('contextmenu', (e) => {
  e.preventDefault();
  showMenu(e.clientX, e.clientY, [{ label: 'New workflow', icon: 'plus', onClick: () => openFlow() }]);
});

function showSection(name) {
  document.querySelectorAll('[data-section]').forEach((b) => b.classList.toggle('active', b.dataset.section === name));
  document.getElementById('sec-agents').hidden = name !== 'agents';
  document.getElementById('sec-workflows').hidden = name !== 'workflows';
  if (name === 'workflows') { closeDrawer(); loadWorkflows(); }
  history.replaceState(null, '', name === 'workflows' ? '#workflows' : location.pathname);
  window.dispatchEvent(new Event('jr-nav'));
}

const sectionFromHash = () => location.hash === '#workflows' ? 'workflows' : 'agents';
document.querySelectorAll('[data-section]').forEach((b) => b.addEventListener('click', () => showSection(b.dataset.section)));
if (location.hash === '#workflows') showSection('workflows');
// The rail's Workflows link only changes the hash when this page is already open.
window.addEventListener('hashchange', () => showSection(sectionFromHash()));

document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { document.getElementById('modal-root').innerHTML = ''; closeDrawer(); } });
if (hubChannel) hubChannel.onmessage = (e) => {
  if (e.data && e.data.workflow) { loadWorkflows(); return; }
  loadAgents().then(() => { if (HUB.current && e.data && e.data.id === HUB.current.id) openAgent(HUB.current.id); });
};
window.addEventListener('focus', () => { loadAgents(); if (!document.getElementById('sec-workflows').hidden) loadWorkflows(); });
loadAgents();
