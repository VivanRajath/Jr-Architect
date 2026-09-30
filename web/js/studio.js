// Agent Studio: choose Custom or Builder, then edit the structured definition with live validation, Improve and Test.
const ST = {
  meta: null, def: null, saved: '', agentId: null, preview: null, sideTab: 'check', why: {},
  builder: null, proposal: null, undo: [], schemaRows: {}, lastRunAgent: null,
};

const IMPORTANT = ['tools', 'permissions', 'guardrails', 'humanInTheLoop', 'memory'];
const SECTION_TITLES = {
  identity: 'Identity', purpose: 'Purpose', responsibilities: 'Responsibilities', instructions: 'Instructions', model: 'Model',
  tools: 'Tools', context: 'Context', memory: 'Memory', guardrails: 'Guardrails', permissions: 'Permissions',
  inputSchema: 'Input format', outputSchema: 'Output format', humanInTheLoop: 'Human approval', runtime: 'Runtime',
};
const NAV = [
  ['identity', 'Identity'], ['purpose', 'Purpose & instructions'], ['model', 'Model'], ['tools', 'Tools'], ['context', 'Context'],
  ['memory', 'Memory'], ['guardrails', 'Guardrails'], ['permissions', 'Permissions'], ['io', 'Input & output'],
  ['humanInTheLoop', 'Human approval'], ['runtime', 'Runtime'],
];
const NAV_OF = { responsibilities: 'purpose', instructions: 'purpose', inputSchema: 'io', outputSchema: 'io' };
const EXAMPLES = [
  'Read customer support emails, identify the type of issue, summarize the problem, draft a response, and ask for human approval before sending anything.',
  'Review a GitHub repository and produce a short report of security risks and missing tests, as structured JSON for a Slack message.',
  'Turn meeting notes into a list of action items with an owner and a due date for each.',
  'Check a product page on our website and flag prices or claims that contradict our pricing policy.',
];
const IMPROVE_CHIPS = [
  'Make the agent more strict.', "Don't let it modify production files.", 'Make the responses shorter.',
  'It should ask for approval before doing anything destructive.', 'Make the instructions clearer.',
];

const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));

function show(view) {
  for (const v of ['start', 'builder', 'editor']) $(`view-${v}`).classList.toggle('h-hidden', v !== view);
  $('s-save-bar').hidden = view !== 'editor';
}

// --- start ---

async function boot() {
  try { ST.meta = await hubApi('GET', '/meta'); } catch (e) { document.body.innerHTML = `<div class="h-main"><div class="h-callout bad">${esc(e.message)}</div></div>`; return; }
  const id = new URLSearchParams(location.search).get('agent');
  if (id) {
    try {
      const data = await hubApi('GET', `/agents/${encodeURIComponent(id)}`);
      ST.agentId = id;
      openEditor(data.definition, true);
    } catch (e) { hubToast(e.message, 'error'); show('start'); }
    return;
  }
  show('start');
}

function startCustom() {
  openEditor(clone(ST.meta.blank), false);
}

// --- builder ---

function startBuilder() {
  ST.builder = { description: '', suggestion: null, use: {}, decided: {}, edgeCases: false };
  renderBuilderAsk();
  show('builder');
}

function providerOptions(selected) {
  return ST.meta.providers.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''} ${p.hasKey ? '' : 'disabled'}>${esc(p.id)}${p.hasKey ? '' : ' (no key on this server)'}</option>`).join('');
}

function renderBuilderAsk(busy = false) {
  const b = ST.builder;
  const firstKey = (ST.meta.providers.find((p) => p.hasKey) || {}).id || 'groq';
  $('view-builder').innerHTML = `
    <h1>Describe your agent</h1>
    <p class="h-muted">Say what it should do, what it gets as input, what it should produce, and anything it must never do. Plain English is fine.</p>
    <div class="s-examples">${EXAMPLES.map((e, i) => `<button class="s-example" data-ex="${i}">${esc(e.slice(0, 90))}…</button>`).join('')}</div>
    <textarea id="b-desc" class="h-textarea" rows="7" placeholder="I want an agent that…">${esc(b.description)}</textarea>
    <div class="h-row" style="margin-top: var(--sp-4)">
      <label class="h-muted" for="b-provider">Design with</label>
      <select id="b-provider" class="h-select" style="width:auto">${providerOptions(firstKey)}</select>
      <span class="h-spacer"></span>
      <button class="h-btn h-btn-ghost" onclick="show('start')">Back</button>
      <button class="h-btn" id="b-go" ${busy ? 'disabled' : ''}>${busy ? 'Designing… (10 to 40 seconds)' : 'Design my agent'}</button>
    </div>`;
  document.querySelectorAll('[data-ex]').forEach((x) => x.addEventListener('click', () => { $('b-desc').value = EXAMPLES[x.dataset.ex]; }));
  $('b-go').addEventListener('click', runBuilder);
}

async function runBuilder() {
  const description = $('b-desc').value.trim();
  const provider = $('b-provider').value;
  if (description.length < 15) { hubToast('Describe the agent in a sentence or two.', 'error'); return; }
  ST.builder.description = description;
  renderBuilderAsk(true);
  try {
    const s = await hubApi('POST', '/builder', { description, provider });
    ST.builder.suggestion = s;
    ST.builder.provider = provider;
    ST.builder.use = {};
    ST.builder.decided = {};
    for (const k of ST.meta.sections) if (!IMPORTANT.includes(k)) ST.builder.use[k] = true;
    renderBuilderReview();
  } catch (e) {
    hubToast(e.message, 'error');
    renderBuilderAsk(false);
  }
}

function schemaText(s) {
  if (s.type !== 'object') return esc(s.type);
  const p = Object.entries(s.properties || {});
  return p.length ? p.map(([k, v]) => `<code>${esc(k)}</code> (${esc(v.type)}${(s.required || []).includes(k) ? '' : ', optional'})${v.description ? ` ${esc(v.description)}` : ''}`).join('<br>') : 'any object';
}

function ul(items) {
  return items.length ? `<ul class="h-list">${items.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : '<span class="h-muted">None</span>';
}

// A readable rendering of one suggested section, so a non-expert can judge it without reading JSON.
function summarize(key, d) {
  switch (key) {
    case 'identity': return `<strong>${esc(d.identity.name)}</strong><div class="h-muted">${esc(d.identity.description)}</div>`;
    case 'purpose': return esc(d.purpose);
    case 'responsibilities': return ul(d.responsibilities);
    case 'instructions': return `<pre class="h-code">${esc(d.instructions)}</pre>`;
    case 'model': return `${esc(d.model.provider)} · up to ${d.model.maxOutputTokens} output tokens`;
    case 'tools': return d.tools.length ? ul(d.tools.map((t) => `${t.id}: ${ST.meta.tools[t.id].description}`)) : 'No tools: the agent works only from the input it is given.';
    case 'context': return `${d.context.knowledge ? `<pre class="h-code">${esc(d.context.knowledge)}</pre>` : '<span class="h-muted">No extra knowledge</span>'}${d.context.examples.length ? `<div class="h-help">${d.context.examples.length} worked example(s)</div>` : ''}`;
    case 'memory': return { none: 'No memory: every run starts fresh.', run: 'Remembers only within one run.', persistent: 'Keeps notes between runs.' }[d.memory.mode];
    case 'guardrails': return `${ul(d.guardrails.rules)}${d.guardrails.blockedTerms.length ? `<div class="h-help">Blocked terms: ${d.guardrails.blockedTerms.map(esc).join(', ')}</div>` : ''}`;
    case 'permissions': return `Repositories: ${d.permissions.repos.map(esc).join(', ') || 'none'}<br>Domains: ${d.permissions.domains.map(esc).join(', ') || 'none'}`;
    case 'inputSchema': return schemaText(d.inputSchema);
    case 'outputSchema': return d.runtime.outputFormat === 'json' ? schemaText(d.outputSchema) : 'Plain text';
    case 'humanInTheLoop': {
      const h = d.humanInTheLoop;
      const bits = [h.approveOutput ? 'A person approves the final output before it is used.' : '', ...h.approveTools.map((t) => `A person approves every ${t} call.`), h.instructions];
      return bits.filter(Boolean).map(esc).join('<br>') || 'No approval points.';
    }
    case 'runtime': return `Up to ${d.runtime.maxSteps} steps, ${d.runtime.timeoutSeconds}s timeout, ${d.runtime.outputFormat} output`;
    default: return '';
  }
}

function renderBuilderReview() {
  const b = ST.builder;
  const s = b.suggestion;
  const d = s.definition;
  const pending = IMPORTANT.filter((k) => !b.decided[k]);
  $('view-builder').innerHTML = `
    <h1>Suggested design</h1>
    <p class="h-muted">Nothing is decided yet. Sections marked <span class="h-pill warn">your call</span> affect what the agent can do or who approves it, so accept or skip each one. You can change anything in the editor afterwards.</p>
    ${s.questions.length ? `<div class="h-callout warn"><strong>Questions only you can answer</strong>${ul(s.questions)}</div>` : ''}
    ${ST.meta.sections.map((k) => {
      const imp = IMPORTANT.includes(k);
      const state = imp ? (b.decided[k] === 'accept' ? 'accepted' : b.decided[k] === 'skip' ? 'skipped' : 'important') : (b.use[k] ? 'accepted' : 'skipped');
      const ctrl = imp
        ? `<span class="h-pill warn">your call</span>
           <button class="h-btn h-btn-sm ${b.decided[k] === 'accept' ? 'h-btn-ok' : 'h-btn-ghost'}" data-decide="${k}" data-v="accept">Accept</button>
           <button class="h-btn h-btn-sm h-btn-ghost" data-decide="${k}" data-v="skip">${b.decided[k] === 'skip' ? 'Skipped' : 'Skip'}</button>`
        : `<label class="h-row h-muted"><input type="checkbox" data-use="${k}" ${b.use[k] ? 'checked' : ''}> Use this</label>`;
      return `<section class="s-suggest ${state}">
        <div class="s-suggest-head"><h3>${esc(SECTION_TITLES[k])}</h3>${ctrl}</div>
        <div>${summarize(k, d)}</div>
        ${s.explanations[k] ? `<div class="s-why">${esc(s.explanations[k])}</div>` : ''}
      </section>`;
    }).join('')}
    ${s.edgeCases.length ? `<section class="s-suggest"><div class="s-suggest-head"><h3>Edge cases to handle</h3>
      <label class="h-row h-muted"><input type="checkbox" id="b-edge" ${b.edgeCases ? 'checked' : ''}> Add to the instructions</label></div>${ul(s.edgeCases)}</section>` : ''}
    <div class="s-builder-foot">
      <button class="h-btn h-btn-ghost" id="b-back">Change the description</button>
      <span class="h-spacer"></span>
      <span class="h-muted">${pending.length ? `Decide on: ${pending.map((k) => SECTION_TITLES[k]).join(', ')}` : 'Ready'}</span>
      <button class="h-btn" id="b-continue" ${pending.length ? 'disabled' : ''}>Continue to the editor</button>
    </div>`;
  document.querySelectorAll('[data-decide]').forEach((x) => x.addEventListener('click', () => { b.decided[x.dataset.decide] = x.dataset.v; renderBuilderReview(); }));
  document.querySelectorAll('[data-use]').forEach((x) => x.addEventListener('change', () => { b.use[x.dataset.use] = x.checked; renderBuilderReview(); }));
  const edge = $('b-edge');
  if (edge) edge.addEventListener('change', () => { b.edgeCases = edge.checked; });
  $('b-back').addEventListener('click', () => renderBuilderAsk(false));
  $('b-continue').addEventListener('click', acceptBuilder);
}

function acceptBuilder() {
  const b = ST.builder;
  const s = b.suggestion;
  const def = clone(ST.meta.blank);
  for (const k of ST.meta.sections) {
    const take = IMPORTANT.includes(k) ? b.decided[k] === 'accept' : b.use[k];
    if (take) def[k] = clone(s.definition[k]);
  }
  if (b.use.runtime === false && b.use.outputSchema) def.runtime.outputFormat = s.definition.runtime.outputFormat;
  if (b.edgeCases && s.edgeCases.length) def.instructions = `${def.instructions}\n\nEdge cases:\n${s.edgeCases.map((e) => `- ${e}`).join('\n')}`.trim();
  if (b.provider) def.model.provider = b.provider;
  ST.why = s.explanations;
  openEditor(def, false);
  hubToast('Review the design, then Save to create the agent');
}

// --- editor ---

function openEditor(def, saved) {
  ST.def = def;
  ST.saved = saved ? JSON.stringify(def) : '';
  ST.schemaRows = {};
  show('editor');
  renderNav();
  renderForm();
  renderSideTabs();
  updateHeader();
  refreshPreview();
}

function updateHeader() {
  $('s-title').textContent = ST.def.identity.name || 'Untitled agent';
  document.title = `${ST.def.identity.name || 'Agent'} - Agent Studio`;
  const v = $('s-version');
  v.hidden = !ST.agentId;
  v.textContent = `v${ST.def.version}`;
  $('s-dirty').hidden = !isDirty();
  $('s-save').textContent = ST.agentId ? 'Save version' : 'Create agent';
}

function isDirty() {
  return JSON.stringify(ST.def) !== ST.saved;
}

function renderNav() {
  const issues = {};
  const v = ST.preview && ST.preview.validation;
  if (v) {
    for (const w of v.warnings) issues[NAV_OF[w.section] || w.section] = issues[NAV_OF[w.section] || w.section] || 'warn';
    for (const e of v.errors) issues[NAV_OF[e.section] || e.section] = 'bad';
  }
  $('s-nav').innerHTML = NAV.map(([k, label]) => `<a href="#sec-${k}" data-nav="${k}">${esc(label)}<span class="dot ${issues[k] || ''}"></span></a>`).join('');
}

function whyNote(...keys) {
  const notes = keys.map((k) => ST.why[k]).filter(Boolean);
  return notes.length ? notes.map((n) => `<div class="s-why">${esc(n)}</div>`).join('') : '';
}

const lines = (a) => esc((a || []).join('\n'));

function field(label, inner, help = '') {
  return `<div class="h-field"><label class="h-label">${label}</label>${inner}${help ? `<div class="h-help">${help}</div>` : ''}</div>`;
}

function renderForm() {
  const d = ST.def;
  const tools = ST.meta.tools;
  $('s-form').innerHTML = `
    <section class="s-section" id="sec-identity">
      <h2>Identity</h2><p class="h-help">Who the agent is. The name also becomes its id and folder name.</p>
      ${whyNote('identity')}
      <div class="h-grid2">
        ${field('Name', `<input class="h-input" data-bind="identity.name" value="${esc(d.identity.name)}">`)}
        ${field('Tags', `<input class="h-input" data-bind="identity.tags" data-kind="csv" value="${esc(d.identity.tags.join(', '))}" placeholder="support, email">`, 'Comma separated.')}
      </div>
      ${field('Description', `<input class="h-input" data-bind="identity.description" value="${esc(d.identity.description)}" placeholder="One sentence people see in the Hub">`)}
    </section>

    <section class="s-section" id="sec-purpose">
      <h2>Purpose & instructions</h2><p class="h-help">What the agent is for and how it should work. This is the core of the derived system prompt.</p>
      ${whyNote('purpose', 'responsibilities', 'instructions')}
      ${field('Purpose', `<textarea class="h-textarea" rows="3" data-bind="purpose">${esc(d.purpose)}</textarea>`)}
      ${field('Responsibilities', `<textarea class="h-textarea" rows="4" data-bind="responsibilities" data-kind="lines">${lines(d.responsibilities)}</textarea>`, 'One per line.')}
      ${field('Instructions', `<textarea class="h-textarea" rows="9" data-bind="instructions">${esc(d.instructions)}</textarea>`, 'Step by step works best. Use the Improve tab to have it rewritten.')}
    </section>

    <section class="s-section" id="sec-model">
      <h2>Model</h2><p class="h-help">Your model, through the keys configured on this server.</p>
      ${whyNote('model')}
      <div class="h-grid2">
        ${field('Provider', `<select class="h-select" data-bind="model.provider">${providerOptions(d.model.provider)}</select>`)}
        ${field('Model id', `<input class="h-input mono" data-bind="model.name" value="${esc(d.model.name)}" placeholder="${esc((ST.meta.providers.find((p) => p.id === d.model.provider) || {}).model || '')}">`, 'Leave empty for the provider default.')}
      </div>
      ${field('Max output tokens', `<input class="h-input" type="number" min="200" max="3000" data-bind="model.maxOutputTokens" data-kind="number" value="${d.model.maxOutputTokens}">`)}
    </section>

    <section class="s-section" id="sec-tools">
      <h2>Tools</h2><p class="h-help">The only actions the runtime will carry out. A tool not ticked here is refused even if the model asks for it.</p>
      ${whyNote('tools')}
      <div style="display:flex; flex-direction:column; gap: var(--sp-3)">
        ${Object.entries(tools).map(([id, t]) => `<label class="h-check"><input type="checkbox" data-tool="${esc(id)}" ${d.tools.some((x) => x.id === id) ? 'checked' : ''}>
          <span><strong>${esc(t.label)} <code>${esc(id)}</code></strong><small>${esc(t.description)} Needs: ${esc(t.permission)}.</small></span></label>`).join('')}
      </div>
      <div class="h-help">Actions like sending email or posting to Slack belong in the n8n workflow that calls this agent; the agent returns the draft or decision.</div>
    </section>

    <section class="s-section" id="sec-context">
      <h2>Context</h2><p class="h-help">Knowledge the agent always has, and worked examples of good answers.</p>
      ${whyNote('context')}
      ${field('Reference knowledge', `<textarea class="h-textarea" rows="5" data-bind="context.knowledge" placeholder="Policies, product facts, tone of voice…">${esc(d.context.knowledge)}</textarea>`)}
      <label class="h-label">Examples</label>
      <div id="ex-list">${d.context.examples.map((e, i) => `
        <div class="s-example-pair">
          <div class="h-grid2">
            <textarea class="h-textarea" rows="3" data-ex="${i}" data-exf="input" placeholder="Input">${esc(e.input)}</textarea>
            <textarea class="h-textarea" rows="3" data-ex="${i}" data-exf="output" placeholder="Ideal output">${esc(e.output)}</textarea>
          </div>
          <button class="h-link" data-ex-del="${i}">Remove</button>
        </div>`).join('')}</div>
      ${d.context.examples.length < 5 ? '<button class="h-btn h-btn-ghost h-btn-sm" id="ex-add">+ Add example</button>' : ''}
    </section>

    <section class="s-section" id="sec-memory">
      <h2>Memory</h2><p class="h-help">Persistent memory lets the agent save short notes (with the memory.save tool) that later runs see.</p>
      ${whyNote('memory')}
      <div class="h-grid2">
        ${field('Mode', `<select class="h-select" data-bind="memory.mode">${ST.meta.memoryModes.map((m) => `<option ${m === d.memory.mode ? 'selected' : ''}>${m}</option>`).join('')}</select>`, 'none: every run starts fresh. run: within one run. persistent: across runs.')}
        ${field('Notes kept', `<input class="h-input" type="number" min="1" max="100" data-bind="memory.maxNotes" data-kind="number" value="${d.memory.maxNotes}">`)}
      </div>
    </section>

    <section class="s-section" id="sec-guardrails">
      <h2>Guardrails</h2><p class="h-help">Rules go into the prompt. Blocked terms and secret detection are enforced by the runtime on input, tool results and output, whatever the model does.</p>
      ${whyNote('guardrails')}
      ${field('Rules', `<textarea class="h-textarea" rows="5" data-bind="guardrails.rules" data-kind="lines" placeholder="Never promise refunds.">${lines(d.guardrails.rules)}</textarea>`, 'One per line.')}
      ${field('Blocked terms', `<input class="h-input" data-bind="guardrails.blockedTerms" data-kind="csv" value="${esc(d.guardrails.blockedTerms.join(', '))}" placeholder="confidential, internal-only">`, 'Comma separated. A run whose input or output contains one is stopped.')}
      <label class="h-check"><input type="checkbox" data-bind="guardrails.blockSecrets" data-kind="bool" ${d.guardrails.blockSecrets ? 'checked' : ''}><span><strong>Block secrets</strong><small>Stop any run whose input or output contains something that looks like an API key or private key.</small></span></label>
    </section>

    <section class="s-section" id="sec-permissions">
      <h2>Permissions</h2><p class="h-help">Exactly what the tools may touch. Checked by the runtime on every call.</p>
      ${whyNote('permissions')}
      <div class="h-grid2">
        ${field('Repositories (repo.read)', `<textarea class="h-textarea mono" rows="4" data-bind="permissions.repos" data-kind="lines" placeholder="owner/name">${lines(d.permissions.repos)}</textarea>`, 'One per line. * allows any public repository.')}
        ${field('Domains (web.fetch)', `<textarea class="h-textarea mono" rows="4" data-bind="permissions.domains" data-kind="lines" placeholder="docs.example.com">${lines(d.permissions.domains)}</textarea>`, 'One per line. Subdomains are included. HTTPS only; private addresses are always refused on a public server.')}
      </div>
    </section>

    <section class="s-section" id="sec-io">
      <h2>Input & output</h2><p class="h-help">The contract with n8n or any caller. Input is checked before the model runs; JSON output is checked against the schema, with one automatic retry.</p>
      ${whyNote('inputSchema', 'outputSchema')}
      <label class="h-label">Input fields</label>
      <div id="schema-inputSchema"></div>
      ${field('Output format', `<select class="h-select" data-bind="runtime.outputFormat" data-rerender="io">${['json', 'text'].map((f) => `<option ${f === d.runtime.outputFormat ? 'selected' : ''}>${f}</option>`).join('')}</select>`)}
      ${d.runtime.outputFormat === 'json' ? '<label class="h-label">Output fields</label><div id="schema-outputSchema"></div>' : ''}
    </section>

    <section class="s-section" id="sec-humanInTheLoop">
      <h2>Human approval</h2><p class="h-help">Where a run pauses until a person approves, in this Hub or from n8n. Enforced by the runtime, not left to the prompt.</p>
      ${whyNote('humanInTheLoop')}
      <label class="h-check"><input type="checkbox" data-bind="humanInTheLoop.approveOutput" data-kind="bool" ${d.humanInTheLoop.approveOutput ? 'checked' : ''}><span><strong>Approve the final output</strong><small>The result is held until a person approves or rejects it.</small></span></label>
      <label class="h-label">Approve before these tools run</label>
      <div id="hitl-tools">${hitlTools()}</div>
      ${field('Notes for the agent about approval', `<textarea class="h-textarea" rows="2" data-bind="humanInTheLoop.instructions">${esc(d.humanInTheLoop.instructions)}</textarea>`)}
    </section>

    <section class="s-section" id="sec-runtime">
      <h2>Runtime</h2><p class="h-help">Limits for one run. A step is one model call; tool calls need a step each.</p>
      ${whyNote('runtime')}
      <div class="h-grid2">
        ${field('Max steps', `<input class="h-input" type="number" min="1" max="8" data-bind="runtime.maxSteps" data-kind="number" value="${d.runtime.maxSteps}">`)}
        ${field('Timeout (seconds)', `<input class="h-input" type="number" min="10" max="120" data-bind="runtime.timeoutSeconds" data-kind="number" value="${d.runtime.timeoutSeconds}">`)}
      </div>
    </section>`;
  renderSchema('inputSchema');
  if (d.runtime.outputFormat === 'json') renderSchema('outputSchema');
  bindForm();
}

function hitlTools() {
  const on = ST.def.tools.map((t) => t.id);
  if (!on.length) return '<div class="h-muted">No tools are enabled.</div>';
  return on.map((id) => `<label class="h-check"><input type="checkbox" data-approve-tool="${esc(id)}" ${ST.def.humanInTheLoop.approveTools.includes(id) ? 'checked' : ''}><span><strong>${esc(id)}</strong></span></label>`).join('');
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let o = obj;
  for (const k of keys.slice(0, -1)) o = o[k];
  o[keys[keys.length - 1]] = value;
}

function readInput(el) {
  switch (el.dataset.kind) {
    case 'lines': return el.value.split('\n').map((s) => s.trim()).filter(Boolean);
    case 'csv': return el.value.split(',').map((s) => s.trim()).filter(Boolean);
    case 'number': return Number(el.value);
    case 'bool': return el.checked;
    default: return el.value;
  }
}

function changed(rerender) {
  if (rerender === 'io') { renderForm(); }
  updateHeader();
  schedulePreview();
}

function bindForm() {
  const form = $('s-form');
  form.querySelectorAll('[data-bind]').forEach((el) => {
    el.addEventListener(el.tagName === 'SELECT' || el.type === 'checkbox' ? 'change' : 'input', () => {
      setPath(ST.def, el.dataset.bind, readInput(el));
      changed(el.dataset.rerender);
    });
  });
  form.querySelectorAll('[data-tool]').forEach((el) => el.addEventListener('change', () => {
    const id = el.dataset.tool;
    ST.def.tools = ST.def.tools.filter((t) => t.id !== id);
    if (el.checked) ST.def.tools.push({ id });
    else ST.def.humanInTheLoop.approveTools = ST.def.humanInTheLoop.approveTools.filter((t) => t !== id);
    $('hitl-tools').innerHTML = hitlTools();
    bindHitl();
    changed();
  }));
  bindHitl();
  form.querySelectorAll('[data-ex]').forEach((el) => el.addEventListener('input', () => {
    ST.def.context.examples[Number(el.dataset.ex)][el.dataset.exf] = el.value;
    changed();
  }));
  form.querySelectorAll('[data-ex-del]').forEach((el) => el.addEventListener('click', () => {
    ST.def.context.examples.splice(Number(el.dataset.exDel), 1);
    renderForm();
    changed();
  }));
  const add = $('ex-add');
  if (add) add.addEventListener('click', () => { ST.def.context.examples.push({ input: '', output: '' }); renderForm(); changed(); });
  const scroller = $('s-form');
  scroller.onscroll = () => {
    let current = NAV[0][0];
    for (const [k] of NAV) { const s = $(`sec-${k}`); if (s && s.offsetTop - scroller.scrollTop < 120) current = k; }
    document.querySelectorAll('[data-nav]').forEach((a) => a.classList.toggle('active', a.dataset.nav === current));
  };
}

function bindHitl() {
  document.querySelectorAll('[data-approve-tool]').forEach((el) => el.addEventListener('change', () => {
    const id = el.dataset.approveTool;
    const list = ST.def.humanInTheLoop.approveTools.filter((t) => t !== id);
    if (el.checked) list.push(id);
    ST.def.humanInTheLoop.approveTools = list;
    changed();
  }));
}

// Allowed values show as "one of: ..." so they stay visible and editable in the table.
function describeField(p) {
  const d = p.description || '';
  return p.enum && p.enum.length && !/one of:/i.test(d) ? `${d}${d ? ' ' : ''}one of: ${p.enum.join(', ')}` : d;
}

// Top-level fields as a table; nested shapes keep their detail and can be edited as JSON.
function renderSchema(which) {
  const box = $(`schema-${which}`);
  const s = ST.def[which];
  const rows = Object.entries(s.properties || {}).map(([name, p]) => ({ name, p, req: (s.required || []).includes(name) }));
  ST.schemaRows[which] = rows;
  const types = ['string', 'number', 'integer', 'boolean', 'object', 'array'];
  box.innerHTML = `
    <table class="s-fields">
      <thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Description / allowed values</th><th></th></tr></thead>
      <tbody>${rows.map((r, i) => `<tr>
        <td><input class="h-input mono" data-sf="${i}" data-sk="name" value="${esc(r.name)}"></td>
        <td><select class="h-select" data-sf="${i}" data-sk="type">${types.map((t) => `<option ${t === r.p.type ? 'selected' : ''}>${t}</option>`).join('')}</select></td>
        <td style="text-align:center"><input type="checkbox" data-sf="${i}" data-sk="req" ${r.req ? 'checked' : ''}></td>
        <td><input class="h-input" data-sf="${i}" data-sk="description" value="${esc(describeField(r.p))}" placeholder="${r.p.type === 'string' ? 'e.g. one of: bug, billing' : ''}"></td>
        <td><button class="h-link" data-sf-del="${i}" aria-label="Remove field">Remove</button></td></tr>`).join('')}</tbody>
    </table>
    <div class="h-row" style="margin-top: var(--sp-3)">
      <button class="h-btn h-btn-ghost h-btn-sm" data-sf-add>+ Add field</button>
      <button class="h-link" data-sf-json>Edit as JSON schema</button>
    </div>
    <div class="h-help">Write "one of: a, b, c" in a text field's description to limit its values.</div>
    <div data-sf-jsonbox class="h-hidden"><textarea class="h-textarea mono" rows="8">${esc(JSON.stringify(s, null, 2))}</textarea><button class="h-btn h-btn-sm" data-sf-apply>Apply JSON</button></div>`;
  const rebuild = () => {
    const props = {};
    const required = [];
    for (const r of ST.schemaRows[which]) {
      const name = r.name.trim();
      if (!name) continue;
      const { _raw, ...p } = r.p;
      const m = /one of:\s*(.+)$/i.exec(_raw || '');
      if (m) p.enum = m[1].split(',').map((x) => x.trim()).filter(Boolean);
      if (!p.enum) delete p.enum;
      if (!p.description) delete p.description;
      props[name] = p;
      if (r.req) required.push(name);
    }
    ST.def[which] = { ...ST.def[which], type: 'object', properties: props, required };
    changed();
  };
  box.querySelectorAll('[data-sf]').forEach((el) => el.addEventListener(el.type === 'checkbox' || el.tagName === 'SELECT' ? 'change' : 'input', () => {
    const r = ST.schemaRows[which][Number(el.dataset.sf)];
    if (el.dataset.sk === 'name') r.name = el.value;
    else if (el.dataset.sk === 'req') r.req = el.checked;
    else if (el.dataset.sk === 'type') r.p = { type: el.value, ...(r.p.description ? { description: r.p.description } : {}), ...(el.value === 'array' ? { items: { type: 'string' } } : {}), ...(el.value === 'object' ? { properties: {}, required: [] } : {}) };
    else r.p = { ...r.p, description: el.value.replace(/\s*one of:.*$/i, '').trim(), ...(/one of:/i.test(el.value) ? {} : { enum: undefined }), _raw: el.value };
    rebuild();
  }));
  box.querySelectorAll('[data-sf-del]').forEach((el) => el.addEventListener('click', () => { ST.schemaRows[which].splice(Number(el.dataset.sfDel), 1); rebuild(); renderSchema(which); }));
  box.querySelector('[data-sf-add]').addEventListener('click', () => { ST.schemaRows[which].push({ name: `field${ST.schemaRows[which].length + 1}`, p: { type: 'string' }, req: false }); rebuild(); renderSchema(which); });
  box.querySelector('[data-sf-json]').addEventListener('click', () => box.querySelector('[data-sf-jsonbox]').classList.toggle('h-hidden'));
  box.querySelector('[data-sf-apply]').addEventListener('click', () => {
    try {
      ST.def[which] = JSON.parse(box.querySelector('[data-sf-jsonbox] textarea').value);
      changed();
      refreshPreview().then(() => { ST.def[which] = ST.preview.definition[which]; renderSchema(which); });
    } catch { hubToast('That is not valid JSON', 'error'); }
  });
}

// --- live preview: the server normalizes, validates and derives the prompt ---

let previewTimer = null;
function schedulePreview() {
  clearTimeout(previewTimer);
  previewTimer = setTimeout(refreshPreview, 450);
}

async function refreshPreview() {
  try {
    ST.preview = await hubApi('POST', '/preview', { definition: ST.def });
    renderNav();
    if (['check', 'prompt'].includes(ST.sideTab)) renderSide();
  } catch (e) { hubToast(e.message, 'error'); }
}

const SIDE_TABS = [['check', 'Check'], ['prompt', 'Prompt'], ['improve', 'Improve'], ['test', 'Test']];

function renderSideTabs() {
  $('s-side-tabs').innerHTML = SIDE_TABS.map(([k, l]) => `<button class="h-tab ${k === ST.sideTab ? 'active' : ''}" data-side="${k}">${l}</button>`).join('');
  document.querySelectorAll('[data-side]').forEach((b) => b.addEventListener('click', () => { ST.sideTab = b.dataset.side; renderSideTabs(); renderSide(); }));
  renderSide();
}

function renderSide() {
  const body = $('s-side-body');
  if (ST.sideTab === 'check') return sideCheck(body);
  if (ST.sideTab === 'prompt') return sidePrompt(body);
  if (ST.sideTab === 'improve') return sideImprove(body);
  return sideTest(body);
}

function sideCheck(body) {
  if (!ST.preview) { body.innerHTML = '<div class="h-muted">Checking…</div>'; return; }
  const v = ST.preview.validation;
  const item = (k, i) => `<div class="s-issue" data-goto="${esc(NAV_OF[i.section] || i.section)}"><span class="h-pill ${k}">${k === 'bad' ? 'error' : 'advice'}</span><span>${esc(i.message)}</span></div>`;
  body.innerHTML = `
    ${v.ok ? '<div class="h-callout good">Valid. The runtime can execute this agent.</div>' : `<div class="h-callout bad">${v.errors.length} problem(s) must be fixed before it can run.</div>`}
    ${v.errors.map((e) => item('bad', e)).join('')}
    ${v.warnings.map((w) => item('warn', w)).join('')}
    <span class="h-label">What the runtime enforces</span>
    <ul class="h-list">
      <li>Only the ${ST.def.tools.length || 'no'} ticked tool${ST.def.tools.length === 1 ? '' : 's'} can run</li>
      <li>Every tool call is checked against Permissions</li>
      <li>Input is validated before the model is called</li>
      ${ST.def.runtime.outputFormat === 'json' ? '<li>Output must match the output schema</li>' : ''}
      ${ST.def.guardrails.blockSecrets || ST.def.guardrails.blockedTerms.length ? '<li>Blocked terms and secrets stop the run</li>' : ''}
      ${ST.def.humanInTheLoop.approveOutput || ST.def.humanInTheLoop.approveTools.length ? '<li>Runs pause at the approval points</li>' : ''}
      <li>At most ${ST.def.runtime.maxSteps} steps and ${ST.def.runtime.timeoutSeconds}s per run</li>
    </ul>`;
  body.querySelectorAll('[data-goto]').forEach((x) => x.addEventListener('click', () => { const s = $(`sec-${x.dataset.goto}`); if (s) s.scrollIntoView(); }));
}

function sidePrompt(body) {
  if (!ST.preview) { body.innerHTML = '<div class="h-muted">Building…</div>'; return; }
  body.innerHTML = `
    <p class="h-muted">Derived from the definition on every run. To change it, change the sections, or ask Improve.</p>
    <span class="h-label">System prompt</span><pre class="h-code">${esc(ST.preview.prompt)}</pre>
    ${Object.entries(ST.preview.files).map(([n, t]) => `<span class="h-label">${esc(n)}</span><pre class="h-code">${esc(t)}</pre>`).join('')}`;
}

function sideImprove(body) {
  const p = ST.proposal;
  body.innerHTML = `
    <p class="h-muted">Say what to change in plain English. You see exactly what would change before anything is applied.</p>
    <div class="s-chips">${IMPROVE_CHIPS.map((c) => `<button class="s-example" data-chip="${esc(c)}">${esc(c)}</button>`).join('')}</div>
    <textarea id="i-feedback" class="h-textarea" rows="3" placeholder="e.g. It should never reply to legal threats; escalate them instead."></textarea>
    <div class="h-row" style="margin-top: var(--sp-3)">
      <button class="h-btn" id="i-go">Suggest changes</button>
      ${ST.undo.length ? '<button class="h-btn h-btn-ghost" id="i-undo">Undo last applied</button>' : ''}
    </div>
    <div id="i-out" style="margin-top: var(--sp-4)">${p ? proposalHtml(p) : ''}</div>`;
  body.querySelectorAll('[data-chip]').forEach((c) => c.addEventListener('click', () => { $('i-feedback').value = c.dataset.chip; }));
  $('i-go').addEventListener('click', runImprove);
  const undo = $('i-undo');
  if (undo) undo.addEventListener('click', () => {
    ST.def = ST.undo.pop();
    renderForm(); updateHeader(); schedulePreview(); renderSide();
    hubToast('Reverted the last applied change');
  });
  bindProposal();
}

function proposalHtml(p) {
  return `
    <div class="h-callout">${esc(p.summary || 'Proposed changes')}</div>
    ${p.notes.length ? `<div class="h-callout warn">${p.notes.map(esc).join('<br>')}</div>` : ''}
    ${renderDiff(p.diff)}
    <div class="h-row" style="margin-top: var(--sp-4)">
      <button class="h-btn h-btn-ok" id="i-apply" ${p.diff.length ? '' : 'disabled'}>Apply these changes</button>
      <button class="h-btn h-btn-ghost" id="i-discard">Discard</button>
    </div>`;
}

function bindProposal() {
  const apply = $('i-apply');
  if (apply) apply.addEventListener('click', () => {
    ST.undo.push(clone(ST.def));
    const keep = { id: ST.def.id, version: ST.def.version };
    ST.def = { ...clone(ST.proposal.proposed), ...keep };
    ST.proposal = null;
    renderForm(); updateHeader(); schedulePreview(); renderSide();
    hubToast('Applied. Save to keep it as a new version.');
  });
  const discard = $('i-discard');
  if (discard) discard.addEventListener('click', () => { ST.proposal = null; renderSide(); });
}

async function runImprove() {
  const feedback = $('i-feedback').value.trim();
  if (!feedback) { hubToast('Say what to change', 'error'); return; }
  const btn = $('i-go');
  btn.disabled = true;
  btn.textContent = 'Thinking… (10 to 30 seconds)';
  try {
    ST.proposal = await hubApi('POST', '/refine', { definition: ST.def, feedback, provider: ST.def.model.provider });
    $('i-out').innerHTML = proposalHtml(ST.proposal);
    bindProposal();
  } catch (e) {
    hubToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Suggest changes';
  }
}

function sampleFor(schema) {
  if (schema.enum && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, sampleFor(v)]));
    case 'array': return [sampleFor(schema.items || { type: 'string' })];
    case 'number': case 'integer': return 1;
    case 'boolean': return true;
    default: return '';
  }
}

function sideTest(body) {
  const saved = ST.agentId && !isDirty();
  body.innerHTML = `
    <p class="h-muted">${saved ? `Runs saved version v${esc(ST.def.version)}; the run is recorded in the Hub.` : 'Runs this unsaved draft exactly as the runtime would. Draft runs are not recorded.'}</p>
    <span class="h-label">Input (JSON)</span>
    <textarea id="t-input" class="h-textarea mono" rows="7">${esc(JSON.stringify(sampleFor(ST.def.inputSchema), null, 2))}</textarea>
    <div class="h-row" style="margin-top: var(--sp-3)"><button class="h-btn" id="t-run">Run test</button><span class="h-muted" id="t-state"></span></div>
    <div id="t-out" style="margin-top: var(--sp-4)"></div>`;
  $('t-run').addEventListener('click', runTest);
}

async function runTest() {
  let input;
  try { input = JSON.parse($('t-input').value || 'null'); } catch { hubToast('Input is not valid JSON', 'error'); return; }
  const saved = ST.agentId && !isDirty();
  const btn = $('t-run');
  btn.disabled = true;
  $('t-state').textContent = 'Running… (a step is one model call)';
  try {
    const { run } = await hubApi('POST', '/test', saved ? { agentId: ST.agentId, input } : { definition: ST.def, input });
    ST.lastRunAgent = saved ? ST.agentId : null;
    showRun(run);
  } catch (e) {
    hubToast(e.message, 'error');
  } finally {
    btn.disabled = false;
    $('t-state').textContent = '';
  }
}

function showRun(run) {
  const box = $('t-out');
  if (!box) return;
  box.innerHTML = '';
  box.appendChild(renderRun(run, {
    onDecision: async (approved, note) => {
      try {
        const out = await hubApi('POST', `/runs/${run.id}/decision`, { agentId: ST.lastRunAgent || undefined, approved, note });
        showRun(out.run);
      } catch (e) { hubToast(e.message, 'error'); }
    },
  }));
}

// --- save ---

async function save() {
  const btn = $('s-save');
  const message = $('s-message').value.trim();
  btn.disabled = true;
  try {
    if (ST.agentId) {
      const out = await hubApi('PUT', `/agents/${ST.agentId}`, { definition: ST.def, message: message || 'Update agent' });
      if (!out.changed) hubToast('No changes to save');
      else hubToast(`Saved v${out.definition.version}`);
      ST.def = out.definition;
    } else {
      const out = await hubApi('POST', '/agents', { definition: ST.def, message: message || 'Create agent' });
      ST.def = out.definition;
      ST.agentId = out.definition.id;
      history.replaceState(null, '', `/studio.html?agent=${encodeURIComponent(ST.agentId)}`);
      hubToast(`Created ${out.definition.identity.name}`);
    }
    ST.saved = JSON.stringify(ST.def);
    $('s-message').value = '';
    renderForm();
    updateHeader();
    refreshPreview();
    if (ST.sideTab === 'test') renderSide();
    if (hubChannel) hubChannel.postMessage({ id: ST.agentId });
  } catch (e) {
    hubToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

$('s-save').addEventListener('click', save);
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 's' && !$('view-editor').classList.contains('h-hidden')) { e.preventDefault(); save(); }
});
window.addEventListener('beforeunload', (e) => { if (ST.def && isDirty() && !$('view-editor').classList.contains('h-hidden')) { e.preventDefault(); e.returnValue = ''; } });

boot();
