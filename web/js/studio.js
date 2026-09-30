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
  ['identity', '1. Name'], ['purpose', '2. What it does'], ['io', '3. Input & output'], ['guardrails', '4. Rules'], ['advanced', 'Advanced'],
];
// Validation names sections by field; this maps each onto the part of the form that holds it.
const NAV_OF = {
  instructions: 'purpose', inputSchema: 'io', outputSchema: 'io', humanInTheLoop: 'guardrails',
  model: 'advanced', tools: 'advanced', permissions: 'advanced', context: 'advanced', memory: 'advanced', runtime: 'advanced', responsibilities: 'advanced',
};
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

// The first three questions are always asked; the rest are written by the model from the answers.
const BASE_QUESTIONS = [
  { q: 'What does your agent need to do?', hint: 'Describe the job in a sentence or two, the way you would explain it to a new colleague.',
    options: ['Sort customer support emails and draft replies', 'Review a GitHub repository for security risks', 'Turn meeting notes into action items', 'Check product pages against our pricing policy'] },
  { q: 'What will you give it to work on?', hint: 'This becomes its input.',
    options: ['A customer email', 'A GitHub repository link', 'Notes or a block of text', 'A web page address'] },
  { q: 'What should it give back?', hint: 'This becomes its output. Name the pieces you want, if you know them.',
    options: ['A category and a short summary', 'A drafted reply', 'A yes/no decision with a reason', 'A list of action items with owners'] },
];

function providerOptions(selected) {
  return ST.meta.providers.map((p) => `<option value="${esc(p.id)}" ${p.id === selected ? 'selected' : ''} ${p.hasKey ? '' : 'disabled'}>${esc(p.id)}${p.hasKey ? '' : ' (no key on this server)'}</option>`).join('');
}

function startBuilder() {
  ST.chat = {
    answers: [], queue: BASE_QUESTIONS.slice(), current: null, phase: 'asking', followupsLoaded: false,
    provider: (ST.meta.providers.find((p) => p.hasKey) || {}).id || 'groq', note: '',
  };
  ST.builder = null;
  nextQuestion();
  show('builder');
}

function nextQuestion() {
  const c = ST.chat;
  c.current = c.queue.shift() || null;
  if (!c.current && !c.followupsLoaded && c.answers.length >= 3) { loadFollowups(); return; }
  if (!c.current && c.phase === 'asking') {
    c.current = { q: 'Anything else it should know? Rules, tone, examples, edge cases.', hint: 'Optional. Or press "Design my agent".', options: ['No, that is everything'], last: true };
  }
  renderChat();
}

async function loadFollowups() {
  const c = ST.chat;
  c.followupsLoaded = true;
  c.phase = 'thinking';
  renderChat();
  try {
    const { questions } = await hubApi('POST', '/builder/questions', { answers: c.answers, provider: c.provider });
    c.queue.push(...questions);
  } catch (e) {
    hubToast(e.message, 'error');
  }
  c.phase = 'asking';
  nextQuestion();
}

function answer(text) {
  const c = ST.chat;
  const t = String(text || '').trim();
  if (!c.current) return;
  if (!t && c.answers.length < 3) { hubToast('Answer this one so the agent knows what to do.', 'error'); return; }
  const wasLast = c.current.last;
  if (t && !(wasLast && /^no, that is everything$/i.test(t))) c.answers.push({ q: c.current.q, a: t });
  else if (!t) c.answers.push({ q: c.current.q, a: '(skipped)' });
  if (wasLast) { designFromChat(); return; }
  nextQuestion();
}

function renderChat() {
  const c = ST.chat;
  const bubbles = c.answers.map((x) => `
    <div class="s-msg bot">${esc(x.q)}</div>
    <div class="s-msg user">${esc(x.a)}</div>`).join('');
  const thinking = c.phase === 'thinking' ? '<div class="s-msg bot s-typing">Thinking of a few questions about your agent…</div>'
    : c.phase === 'designing' ? '<div class="s-msg bot s-typing">Designing your agent… (10 to 40 seconds)</div>' : '';
  const cur = c.current && c.phase === 'asking' ? `<div class="s-msg bot"><strong>${esc(c.current.q)}</strong>${c.current.hint ? `<small>${esc(c.current.hint)}</small>` : ''}</div>` : '';
  const canDesign = c.answers.length >= 3 && c.phase === 'asking';
  $('view-builder').innerHTML = `
    <div class="s-chat-head">
      <div><h1>Agent Builder</h1><p class="h-muted">Answer a few questions. You will see the design and can change anything before it is saved.</p></div>
      <label class="h-row h-muted">Model <select id="c-provider" class="h-select" style="width:auto">${providerOptions(c.provider)}</select></label>
    </div>
    <div class="s-chat" id="c-log">${bubbles}${cur}${thinking}</div>
    ${c.current && c.phase === 'asking' ? `
      <div class="s-chips">${(c.current.options || []).map((o) => `<button class="s-example" data-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>
      <div class="s-chat-input">
        <textarea id="c-input" class="h-textarea" rows="2" placeholder="Type your answer, or pick one above. Enter to send."></textarea>
        <button class="h-btn" id="c-send">Send</button>
      </div>` : ''}
    <div class="s-builder-foot">
      <button class="h-btn h-btn-ghost" id="c-back">Back</button>
      <button class="h-link" id="c-restart">Start over</button>
      <span class="h-spacer"></span>
      ${c.current && c.answers.length >= 3 && c.phase === 'asking' ? '<button class="h-btn h-btn-ghost" id="c-skip">Skip question</button>' : ''}
      <button class="h-btn" id="c-design" ${canDesign ? '' : 'disabled'}>Design my agent</button>
    </div>`;
  const log = $('c-log');
  log.scrollTop = log.scrollHeight;
  $('c-provider').addEventListener('change', (e) => { c.provider = e.target.value; });
  $('c-back').addEventListener('click', () => show('start'));
  $('c-restart').addEventListener('click', startBuilder);
  $('c-design').addEventListener('click', designFromChat);
  if ($('c-skip')) $('c-skip').addEventListener('click', () => answer(''));
  document.querySelectorAll('[data-opt]').forEach((b) => b.addEventListener('click', () => answer(b.dataset.opt)));
  const input = $('c-input');
  if (input) {
    input.focus();
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); answer(input.value); } });
    $('c-send').addEventListener('click', () => answer(input.value));
  }
}

async function designFromChat() {
  const c = ST.chat;
  if (c.answers.length < 3) return;
  c.phase = 'designing';
  c.current = null;
  renderChat();
  const description = c.answers.filter((x) => x.a !== '(skipped)').map((x) => `${x.q}\n${x.a}`).join('\n\n');
  try {
    const s = await hubApi('POST', '/builder', { description, provider: c.provider });
    ST.builder = { description, suggestion: s, provider: c.provider, use: {}, decided: {}, edgeCases: false };
    for (const k of ST.meta.sections) if (!IMPORTANT.includes(k)) ST.builder.use[k] = true;
    renderBuilderReview();
  } catch (e) {
    hubToast(e.message, 'error');
    c.phase = 'asking';
    c.current = { q: 'Something went wrong while designing. Add anything, or press "Design my agent" to try again.', options: [], last: true };
    renderChat();
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
      <button class="h-btn h-btn-ghost" id="b-back">Back to the questions</button>
      <span class="h-spacer"></span>
      <span class="h-muted">${pending.length ? `Decide on: ${pending.map((k) => SECTION_TITLES[k]).join(', ')}` : 'Ready'}</span>
      <button class="h-btn" id="b-continue" ${pending.length ? 'disabled' : ''}>Continue to the editor</button>
    </div>`;
  document.querySelectorAll('[data-decide]').forEach((x) => x.addEventListener('click', () => { b.decided[x.dataset.decide] = x.dataset.v; renderBuilderReview(); }));
  document.querySelectorAll('[data-use]').forEach((x) => x.addEventListener('change', () => { b.use[x.dataset.use] = x.checked; renderBuilderReview(); }));
  const edge = $('b-edge');
  if (edge) edge.addEventListener('change', () => { b.edgeCases = edge.checked; });
  $('b-back').addEventListener('click', () => { ST.chat.phase = 'asking'; nextQuestion(); });
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
  openEditor(def, false, true);
  hubToast('Review the design, then Save to create the agent');
}

// --- editor ---

function openEditor(def, saved, touched = saved) {
  ST.def = def;
  // A blank Custom agent stays quiet until the user starts filling it in.
  ST.touched = touched;
  ST.advancedOpen = false;
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
  const v = ST.touched && ST.preview && ST.preview.validation;
  if (v) {
    for (const w of v.warnings) issues[NAV_OF[w.section] || w.section] = issues[NAV_OF[w.section] || w.section] || 'warn';
    for (const e of v.errors) issues[NAV_OF[e.section] || e.section] = 'bad';
  }
  $('s-nav').innerHTML = NAV.map(([k, label]) => `<a href="#sec-${k}" data-nav="${k}">${esc(label)}<span class="dot ${issues[k] || ''}"></span></a>`).join('');
  $('s-nav').querySelectorAll('[data-nav]').forEach((a) => a.addEventListener('click', () => goTo(a.dataset.nav)));
}

// Advanced lives in a closed <details>, so jumping there opens it first.
function goTo(section) {
  if (section === 'advanced' && $('sec-advanced')) { $('sec-advanced').open = true; ST.advancedOpen = true; }
  const el = $(`sec-${section}`);
  if (el) el.scrollIntoView();
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
  const open = ST.advancedOpen ? 'open' : '';
  $('s-form').innerHTML = `
    <section class="s-section" id="sec-identity">
      <h2>1. Name</h2>
      ${whyNote('identity')}
      ${field('What is it called?', `<input class="h-input" data-bind="identity.name" value="${esc(d.identity.name === 'New agent' ? '' : d.identity.name)}" placeholder="e.g. Support Email Triage">`)}
      ${field('One line about it (optional)', `<input class="h-input" data-bind="identity.description" value="${esc(d.identity.description)}" placeholder="Shown on its card in the Hub">`)}
    </section>

    <section class="s-section" id="sec-purpose">
      <h2>2. What it does</h2>
      ${whyNote('purpose', 'instructions')}
      ${field('What should the agent do?', `<textarea class="h-textarea" rows="3" data-bind="purpose" placeholder="e.g. Read a customer email, work out what the problem is, and draft a short reply.">${esc(d.purpose)}</textarea>`)}
      ${field('How should it do it? (optional)', `<textarea class="h-textarea" rows="6" data-bind="instructions" placeholder="Steps, tone, anything it should always check. Leave empty and use Improve on the right to have this written for you.">${esc(d.instructions)}</textarea>`)}
    </section>

    <section class="s-section" id="sec-io">
      <h2>3. Input & output</h2><p class="h-help">What the agent is given, and what it hands back. Callers such as n8n rely on these fields.</p>
      ${whyNote('inputSchema', 'outputSchema')}
      <label class="h-label">What it receives</label>
      <div id="schema-inputSchema"></div>
      ${field('What it returns', `<select class="h-select" data-bind="runtime.outputFormat" data-rerender="io"><option value="json" ${d.runtime.outputFormat === 'json' ? 'selected' : ''}>Structured fields (best for workflows)</option><option value="text" ${d.runtime.outputFormat === 'text' ? 'selected' : ''}>Plain text</option></select>`)}
      ${d.runtime.outputFormat === 'json' ? '<div id="schema-outputSchema"></div>' : ''}
    </section>

    <section class="s-section" id="sec-guardrails">
      <h2>4. Rules</h2>
      ${whyNote('guardrails', 'humanInTheLoop')}
      ${field('Things it must never do (optional)', `<textarea class="h-textarea" rows="3" data-bind="guardrails.rules" data-kind="lines" placeholder="Never promise refunds.&#10;Never share customer data.">${lines(d.guardrails.rules)}</textarea>`, 'One per line.')}
      <label class="h-check"><input type="checkbox" data-bind="humanInTheLoop.approveOutput" data-kind="bool" ${d.humanInTheLoop.approveOutput ? 'checked' : ''}><span><strong>A person approves every result before it is used</strong><small>The run pauses until someone approves or rejects it.</small></span></label>
    </section>

    <details class="s-advanced" id="sec-advanced" ${open}>
      <summary><span>Advanced settings (optional)</span><small>Model, tools, knowledge, memory, limits. The defaults work for most agents.</small></summary>

      <section class="s-section" id="sec-model">
        <h2>Model</h2>
        ${whyNote('model')}
        <div class="h-grid2">
          ${field('Provider', `<select class="h-select" data-bind="model.provider">${providerOptions(d.model.provider)}</select>`)}
          ${field('Model id', `<input class="h-input mono" data-bind="model.name" value="${esc(d.model.name)}" placeholder="${esc((ST.meta.providers.find((p) => p.id === d.model.provider) || {}).model || '')}">`, 'Leave empty for the default.')}
        </div>
        ${field('Longest answer (tokens)', `<input class="h-input" type="number" min="200" max="3000" data-bind="model.maxOutputTokens" data-kind="number" value="${d.model.maxOutputTokens}">`)}
      </section>

      <section class="s-section" id="sec-tools">
        <h2>Tools</h2><p class="h-help">Only needed if the agent must look something up itself. Sending email or posting to Slack happens in the workflow that calls the agent.</p>
        ${whyNote('tools')}
        <div style="display:flex; flex-direction:column; gap: var(--sp-3)">
          ${Object.entries(tools).map(([id, t]) => `<label class="h-check"><input type="checkbox" data-tool="${esc(id)}" ${d.tools.some((x) => x.id === id) ? 'checked' : ''}>
            <span><strong>${esc(t.label)}</strong><small>${esc(t.description)}</small></span></label>`).join('')}
        </div>
        ${d.tools.some((t) => t.id === 'repo.read') ? field('Repositories it may read', `<textarea class="h-textarea mono" rows="3" data-bind="permissions.repos" data-kind="lines" placeholder="owner/name">${lines(d.permissions.repos)}</textarea>`, 'One per line. * allows any public repository.') : ''}
        ${d.tools.some((t) => t.id === 'web.fetch') ? field('Websites it may read', `<textarea class="h-textarea mono" rows="3" data-bind="permissions.domains" data-kind="lines" placeholder="docs.example.com">${lines(d.permissions.domains)}</textarea>`, 'One per line; subdomains included.') : ''}
        ${d.tools.length ? `<label class="h-label">Ask a person before these run</label><div id="hitl-tools">${hitlTools()}</div>` : '<div id="hitl-tools" hidden></div>'}
      </section>

      <section class="s-section" id="sec-context">
        <h2>Knowledge & examples</h2>
        ${whyNote('context')}
        ${field('Facts it should always know', `<textarea class="h-textarea" rows="4" data-bind="context.knowledge" placeholder="Policies, product facts, tone of voice…">${esc(d.context.knowledge)}</textarea>`)}
        <label class="h-label">Examples of good answers</label>
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

      <section class="s-section" id="sec-more">
        <h2>More rules and memory</h2>
        ${whyNote('memory', 'responsibilities')}
        ${field('Responsibilities', `<textarea class="h-textarea" rows="3" data-bind="responsibilities" data-kind="lines">${lines(d.responsibilities)}</textarea>`, 'One per line; added to the instructions.')}
        ${field('Blocked words', `<input class="h-input" data-bind="guardrails.blockedTerms" data-kind="csv" value="${esc(d.guardrails.blockedTerms.join(', '))}" placeholder="confidential, internal-only">`, 'Comma separated. A run whose input or answer contains one is stopped.')}
        <label class="h-check"><input type="checkbox" data-bind="guardrails.blockSecrets" data-kind="bool" ${d.guardrails.blockSecrets ? 'checked' : ''}><span><strong>Block secrets</strong><small>Stop a run whose input or answer contains something that looks like an API key.</small></span></label>
        <div class="h-grid2" style="margin-top: var(--sp-4)">
          ${field('Memory between runs', `<select class="h-select" data-bind="memory.mode"><option value="none" ${d.memory.mode === 'none' ? 'selected' : ''}>None</option><option value="run" ${d.memory.mode === 'run' ? 'selected' : ''}>Within one run</option><option value="persistent" ${d.memory.mode === 'persistent' ? 'selected' : ''}>Keep notes between runs</option></select>`)}
          ${field('Tags', `<input class="h-input" data-bind="identity.tags" data-kind="csv" value="${esc(d.identity.tags.join(', '))}" placeholder="support, email">`)}
        </div>
      </section>

      <section class="s-section" id="sec-runtime">
        <h2>Limits</h2>
        ${whyNote('runtime')}
        <div class="h-grid2">
          ${field('Max steps', `<input class="h-input" type="number" min="1" max="8" data-bind="runtime.maxSteps" data-kind="number" value="${d.runtime.maxSteps}">`, 'A step is one model call.')}
          ${field('Timeout (seconds)', `<input class="h-input" type="number" min="10" max="120" data-bind="runtime.timeoutSeconds" data-kind="number" value="${d.runtime.timeoutSeconds}">`)}
        </div>
      </section>
    </details>`;
  $('sec-advanced').addEventListener('toggle', (e) => { ST.advancedOpen = e.target.open; });
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
  ST.touched = true;
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
    changed();
    renderForm();
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
  if (!ST.touched) {
    body.innerHTML = `<div class="h-callout">Fill in the four numbered parts on the left: a name, what it does, what it receives and returns, and any rules. Checks appear here as you go.</div>
      <div class="h-help">Not sure how to phrase the instructions? Write one sentence in "What it does", then use the Improve tab.</div>`;
    return;
  }
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
  body.querySelectorAll('[data-goto]').forEach((x) => x.addEventListener('click', () => goTo(x.dataset.goto)));
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
  ST.touched = true;
  renderNav();
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
  ST.touched = true;
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
