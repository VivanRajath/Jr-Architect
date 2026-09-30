// Workflow editor: an n8n-style canvas where Hub agents and logic nodes are dragged in, wired together and run.
const F = {
  meta: null, agents: [], wf: null, saved: '', id: null, view: { x: 40, y: 40, z: 1 },
  sel: null, run: null, panel: 'overview', validation: null, lastField: null,
};
const NODE_W = 200;
const ICON = { trigger: '▶', agent: 'AI', if: '?', set: '{}', approval: '✓', http: '↗', output: '■' };
const OP_LABEL = { equals: 'equals', not_equals: 'does not equal', contains: 'contains', exists: 'exists', not_exists: 'is empty', greater: 'is greater than', less: 'is less than', is_true: 'is true' };

const $ = (id) => document.getElementById(id);
const clone = (o) => JSON.parse(JSON.stringify(o));
const nodeById = (id) => F.wf.nodes.find((n) => n.id === id);
const outputsOf = (n) => F.meta.nodeTypes[n.type].outputs;

// --- boot ---

async function boot() {
  try {
    const [meta, agents] = await Promise.all([hubApi('GET', '/workflows/meta'), hubApi('GET', '/agents')]);
    F.meta = meta;
    F.agents = agents.agents.map((a) => a.definition);
  } catch (e) { hubToast(e.message, 'error'); return; }
  const q = new URLSearchParams(location.search);
  if (q.get('id')) {
    try {
      const { workflow } = await hubApi('GET', `/workflows/${encodeURIComponent(q.get('id'))}`);
      F.id = workflow.id;
      load(workflow, true);
    } catch (e) { hubToast(e.message, 'error'); load(clone(F.meta.blank), false); }
  } else {
    const wf = clone(F.meta.blank);
    const agent = F.agents.find((a) => a.id === q.get('agent'));
    if (agent) seedWithAgent(wf, agent);
    load(wf, false);
  }
  renderPalette();
  bindCanvas();
  requestAnimationFrame(fitView);
}

// Started from an agent in the Hub: Trigger -> that agent -> Output, ready to run.
function seedWithAgent(wf, agent) {
  wf.name = `${agent.identity.name} workflow`;
  const t = wf.nodes.find((n) => n.type === 'trigger');
  t.config.sample = sampleFor(agent.inputSchema);
  const a = { id: newId('agent'), type: 'agent', name: agent.identity.name, position: { x: 300, y: 200 }, config: { agentId: agent.id, input: inputFromSchema(agent.inputSchema) } };
  wf.nodes.push(a);
  wf.nodes.find((n) => n.type === 'output').position = { x: 580, y: 200 };
  wf.edges = [{ from: t.id, port: 'main', to: a.id }, { from: a.id, port: 'main', to: wf.nodes.find((n) => n.type === 'output').id }];
}

function load(wf, saved) {
  F.wf = wf;
  F.saved = saved ? JSON.stringify(wf) : '';
  F.sel = null;
  F.run = null;
  $('f-name').value = wf.name;
  renderCanvas();
  renderPanel();
  updateHeader();
  scheduleValidate();
}

function isDirty() { return JSON.stringify(F.wf) !== F.saved; }

function updateHeader() {
  $('f-version').hidden = !F.id;
  $('f-version').textContent = `v${F.wf.version}`;
  $('f-dirty').hidden = !isDirty();
  $('f-save').textContent = F.id ? 'Save' : 'Create workflow';
  document.title = `${F.wf.name} - Workflow Editor`;
}

function changed(opts = {}) {
  updateHeader();
  if (opts.canvas !== false) renderCanvas();
  scheduleValidate();
}

// --- helpers ---

function newId(type) {
  let id;
  do { id = `${type}-${Math.random().toString(36).slice(2, 7)}`; } while (nodeById(id));
  return id;
}

function sampleFor(schema) {
  if (!schema) return {};
  if (schema.enum && schema.enum.length) return schema.enum[0];
  switch (schema.type) {
    case 'object': return Object.fromEntries(Object.entries(schema.properties || {}).map(([k, v]) => [k, sampleFor(v)]));
    case 'array': return [sampleFor(schema.items || { type: 'string' })];
    case 'number': case 'integer': return 1;
    case 'boolean': return true;
    default: return '';
  }
}

function inputFromSchema(schema) {
  if (!schema || schema.type !== 'object') return '{{ $json }}';
  return Object.fromEntries(Object.keys(schema.properties || {}).map((k) => [k, `{{ $json.${k} }}`]));
}

function defaultConfig(type, extra = {}) {
  switch (type) {
    case 'trigger': return { mode: 'manual', sample: {} };
    case 'agent': {
      const a = F.agents.find((x) => x.id === extra.agentId);
      return { agentId: extra.agentId || '', input: a ? inputFromSchema(a.inputSchema) : '{{ $json }}' };
    }
    case 'if': return { path: '', op: 'equals', value: '' };
    case 'set': return { value: { field: '{{ $json }}' } };
    case 'approval': return { message: 'Approve to continue' };
    case 'http': return { method: 'POST', url: '', body: { text: '{{ $json }}' }, headers: {} };
    case 'output': return { value: '{{ $json }}' };
    default: return {};
  }
}

function subtitle(n) {
  const c = n.config;
  switch (n.type) {
    case 'trigger': return c.mode === 'webhook' ? 'Webhook or manual' : 'Manual run';
    case 'agent': { const a = F.agents.find((x) => x.id === c.agentId); return a ? `${a.identity.name} v${a.version}` : 'Choose an agent'; }
    case 'if': return c.path ? `${c.path} ${OP_LABEL[c.op]} ${['exists', 'not_exists', 'is_true'].includes(c.op) ? '' : c.value}` : 'Set a condition';
    case 'set': return 'Build a JSON object';
    case 'approval': return 'Waits for a person';
    case 'http': return c.url ? `${c.method} ${c.url.replace(/^https?:\/\//, '')}` : 'Set a URL';
    case 'output': return 'Workflow result';
    default: return '';
  }
}

// --- palette ---

function renderPalette() {
  const hasTrigger = F.wf.nodes.some((n) => n.type === 'trigger');
  const item = (type, label, desc, agentId = '') => `
    <div class="f-pal-item ${type === 'trigger' && hasTrigger ? 'disabled' : ''}" draggable="${type === 'trigger' && hasTrigger ? 'false' : 'true'}" data-type="${type}" data-agent="${esc(agentId)}" title="${esc(desc)}">
      <span class="f-icon t-${type}">${ICON[type]}</span><span><strong>${esc(label)}</strong><small>${esc(desc)}</small></span>
    </div>`;
  const types = F.meta.nodeTypes;
  $('f-palette').innerHTML = `
    <span class="h-label" style="margin-top:0">Your agents</span>
    ${F.agents.length ? F.agents.map((a) => item('agent', a.identity.name, a.identity.description || a.purpose || 'Hub agent', a.id)).join('') : '<div class="h-muted" style="margin-bottom: var(--sp-3)">No agents yet. <a href="/studio.html" target="_blank">Create one</a>.</div>'}
    <span class="h-label">Logic</span>
    ${['if', 'set', 'approval'].map((t) => item(t, types[t].label, types[t].description)).join('')}
    <span class="h-label">In and out</span>
    ${['trigger', 'http', 'output'].map((t) => item(t, types[t].label, types[t].description)).join('')}
    <div class="h-help">Drag onto the canvas, or click to add after the selected node.</div>`;
  $('f-palette').querySelectorAll('.f-pal-item').forEach((el) => {
    if (el.classList.contains('disabled')) return;
    el.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('application/x-jr-node', JSON.stringify({ type: el.dataset.type, agentId: el.dataset.agent }));
      e.dataTransfer.effectAllowed = 'copy';
    });
    el.addEventListener('click', () => addFromPalette(el.dataset.type, el.dataset.agent));
  });
}

function addNode(type, pos, agentId) {
  if (type === 'trigger' && F.wf.nodes.some((n) => n.type === 'trigger')) { hubToast('A workflow has one Trigger', 'error'); return null; }
  const agent = F.agents.find((a) => a.id === agentId);
  const n = { id: newId(type), type, name: uniqueName(agent ? agent.identity.name : F.meta.nodeTypes[type].label), position: { x: Math.round(pos.x / 10) * 10, y: Math.round(pos.y / 10) * 10 }, config: defaultConfig(type, { agentId }) };
  F.wf.nodes.push(n);
  return n;
}

function uniqueName(base) {
  let name = base;
  for (let i = 2; F.wf.nodes.some((n) => n.name === name); i++) name = `${base} ${i}`;
  return name;
}

// Clicking a palette item places the node after the selected one and wires it, the way n8n's "+" does.
function addFromPalette(type, agentId) {
  const from = F.sel && F.sel.type === 'node' ? nodeById(F.sel.id) : null;
  const pos = from ? { x: from.position.x + 280, y: from.position.y } : viewCenter();
  const n = addNode(type, pos, agentId);
  if (!n) return;
  if (from && outputsOf(from).length && n.type !== 'trigger') {
    const port = outputsOf(from)[0];
    for (const e of F.wf.edges.filter((x) => x.from === from.id && x.port === port)) {
      e.from = n.id;
      e.port = outputsOf(n)[0] || e.port;
      if (!outputsOf(n).length) F.wf.edges = F.wf.edges.filter((x) => x !== e);
    }
    F.wf.edges.push({ from: from.id, port, to: n.id });
    shiftRight(n);
  }
  select({ type: 'node', id: n.id });
  renderPalette();
  changed();
}

// Makes room when a node is inserted in the middle of a chain.
function shiftRight(inserted) {
  const seen = new Set([inserted.id]);
  const walk = (id) => {
    for (const e of F.wf.edges.filter((x) => x.from === id)) {
      if (seen.has(e.to)) continue;
      seen.add(e.to);
      const t = nodeById(e.to);
      if (t.position.x < inserted.position.x + 260) t.position.x = inserted.position.x + 280;
      walk(e.to);
    }
  };
  walk(inserted.id);
}

function viewCenter() {
  const r = $('f-canvas').getBoundingClientRect();
  return { x: (r.width / 2 - F.view.x) / F.view.z - NODE_W / 2, y: (r.height / 2 - F.view.y) / F.view.z - 30 };
}

// --- canvas rendering ---

function nodeHeight(n) { return Math.max(58, 16 + outputsOf(n).length * 24); }

function portPoint(n, port, side) {
  if (side === 'in') return { x: n.position.x, y: n.position.y + 29 };
  const i = Math.max(0, outputsOf(n).indexOf(port));
  const outs = outputsOf(n).length;
  return { x: n.position.x + NODE_W, y: n.position.y + (outs === 1 ? 29 : 18 + i * 24 + 7) };
}

function edgePath(a, b) {
  const dx = Math.max(50, Math.abs(b.x - a.x) / 2);
  return `M ${a.x} ${a.y} C ${a.x + dx} ${a.y}, ${b.x - dx} ${b.y}, ${b.x} ${b.y}`;
}

function nodeState(n) {
  const r = F.run && F.run.nodes && F.run.nodes[n.id];
  return r ? r.status : '';
}

function renderCanvas() {
  const world = $('f-world');
  world.querySelectorAll('.f-node').forEach((el) => el.remove());
  const invalid = new Set(((F.validation && F.validation.errors) || []).map((e) => e.node).filter(Boolean));
  for (const n of F.wf.nodes) {
    const st = nodeState(n);
    const el = document.createElement('div');
    el.className = `f-node ${F.sel && F.sel.type === 'node' && F.sel.id === n.id ? 'selected' : ''} ${st ? `st-${st}` : ''} ${invalid.has(n.id) ? 'invalid' : ''}`;
    el.dataset.id = n.id;
    el.style.left = `${n.position.x}px`;
    el.style.top = `${n.position.y}px`;
    el.style.minHeight = `${nodeHeight(n)}px`;
    const outs = outputsOf(n);
    const badge = st ? `<span class="f-node-badge">${{ success: 'done', error: 'error', waiting: 'waiting', running: 'running' }[st] || st}</span>` : '';
    el.innerHTML = `
      ${badge}
      <div class="f-node-head"><span class="f-icon t-${n.type}">${ICON[n.type]}</span>
        <span class="f-node-title"><strong>${esc(n.name)}</strong><small>${esc(subtitle(n))}</small></span></div>
      ${n.type === 'trigger' ? '' : '<span class="f-port in" data-port-in="1" title="Input"></span>'}
      ${outs.map((p, i) => `<span class="f-port out" data-port="${p}" title="${p}" style="top:${outs.length === 1 ? 22 : 18 + i * 24}px"></span>${outs.length > 1 ? `<span class="f-port-label" style="top:${18 + i * 24}px">${p}</span>` : ''}`).join('')}`;
    world.appendChild(el);
  }
  renderEdges();
  applyView();
  $('f-hint').hidden = F.wf.nodes.length > 2;
}

function renderEdges(temp) {
  const svg = $('f-edges');
  const ranTo = (e) => {
    if (!F.run || !F.run.nodes) return false;
    const a = F.run.nodes[e.from];
    return a && a.status === 'success' && a.port === e.port && F.run.nodes[e.to];
  };
  let html = '';
  F.wf.edges.forEach((e, i) => {
    const a = nodeById(e.from);
    const b = nodeById(e.to);
    if (!a || !b) return;
    const d = edgePath(portPoint(a, e.port, 'out'), portPoint(b, null, 'in'));
    const sel = F.sel && F.sel.type === 'edge' && F.sel.index === i;
    html += `<path class="f-edge ${sel ? 'selected' : ''} ${ranTo(e) ? 'ran' : ''}" d="${d}"/><path class="f-edge-hit" data-edge="${i}" d="${d}"><title>${esc(a.name)} → ${esc(b.name)} (click, then Delete to remove)</title></path>`;
  });
  if (temp) html += `<path class="f-edge temp" d="${edgePath(temp.a, temp.b)}"/>`;
  svg.innerHTML = html;
}

function applyView() {
  $('f-world').style.transform = `translate(${F.view.x}px, ${F.view.y}px) scale(${F.view.z})`;
  const c = $('f-canvas');
  c.style.backgroundPosition = `${F.view.x}px ${F.view.y}px`;
  c.style.backgroundSize = `${22 * F.view.z}px ${22 * F.view.z}px`;
}

function fitView() {
  if (!F.wf.nodes.length) return;
  const r = $('f-canvas').getBoundingClientRect();
  const xs = F.wf.nodes.map((n) => n.position.x);
  const ys = F.wf.nodes.map((n) => n.position.y);
  const minX = Math.min(...xs) - 60; const maxX = Math.max(...xs) + NODE_W + 60;
  const minY = Math.min(...ys) - 60; const maxY = Math.max(...ys) + 120;
  const z = Math.max(0.4, Math.min(1.2, r.width / (maxX - minX), r.height / (maxY - minY)));
  F.view = { z, x: (r.width - (maxX - minX) * z) / 2 - minX * z, y: (r.height - (maxY - minY) * z) / 2 - minY * z };
  applyView();
}

function zoomAt(cx, cy, factor) {
  const z = Math.max(0.3, Math.min(2, F.view.z * factor));
  const wx = (cx - F.view.x) / F.view.z;
  const wy = (cy - F.view.y) / F.view.z;
  F.view = { z, x: cx - wx * z, y: cy - wy * z };
  applyView();
}

function toWorld(clientX, clientY) {
  const r = $('f-canvas').getBoundingClientRect();
  return { x: (clientX - r.left - F.view.x) / F.view.z, y: (clientY - r.top - F.view.y) / F.view.z };
}

// --- canvas interaction: drag nodes, pan, wire ports, select edges, drop from the palette ---

function bindCanvas() {
  const canvas = $('f-canvas');
  let action = null;

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 && e.button !== 1) return;
    if (e.target.closest('.f-tools, .f-banner')) return;
    canvas.focus({ preventScroll: true });
    const out = e.target.closest('.f-port.out');
    const nodeEl = e.target.closest('.f-node');
    const edgeEl = e.target.closest('[data-edge]');
    if (out && nodeEl) {
      action = { kind: 'wire', from: nodeEl.dataset.id, port: out.dataset.port };
    } else if (nodeEl && e.button === 0) {
      const n = nodeById(nodeEl.dataset.id);
      if (!(F.sel && F.sel.type === 'node' && F.sel.id === n.id)) select({ type: 'node', id: n.id });
      action = { kind: 'move', node: n, sx: e.clientX, sy: e.clientY, ox: n.position.x, oy: n.position.y, moved: false };
    } else if (edgeEl) {
      select({ type: 'edge', index: Number(edgeEl.dataset.edge) });
      return;
    } else {
      if (F.sel) select(null);
      action = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: F.view.x, oy: F.view.y };
      canvas.classList.add('panning');
    }
    try { canvas.setPointerCapture(e.pointerId); } catch { /* synthetic or already released pointer */ }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!action) return;
    if (action.kind === 'pan') {
      F.view.x = action.ox + e.clientX - action.sx;
      F.view.y = action.oy + e.clientY - action.sy;
      applyView();
    } else if (action.kind === 'move') {
      const dx = (e.clientX - action.sx) / F.view.z;
      const dy = (e.clientY - action.sy) / F.view.z;
      if (Math.abs(dx) + Math.abs(dy) > 2) action.moved = true;
      action.node.position = { x: Math.round((action.ox + dx) / 10) * 10, y: Math.round((action.oy + dy) / 10) * 10 };
      const el = $('f-world').querySelector(`.f-node[data-id="${CSS.escape(action.node.id)}"]`);
      el.style.left = `${action.node.position.x}px`;
      el.style.top = `${action.node.position.y}px`;
      renderEdges();
    } else if (action.kind === 'wire') {
      const from = nodeById(action.from);
      document.querySelectorAll('.f-port.hot').forEach((p) => p.classList.remove('hot'));
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under && under.closest('.f-node');
      if (target && target.dataset.id !== from.id) { const inPort = target.querySelector('.f-port.in'); if (inPort) inPort.classList.add('hot'); }
      renderEdges({ a: portPoint(from, action.port, 'out'), b: toWorld(e.clientX, e.clientY) });
    }
  });

  const end = (e) => {
    if (!action) return;
    canvas.classList.remove('panning');
    if (action.kind === 'move' && action.moved) changed({ canvas: false });
    if (action.kind === 'wire') {
      document.querySelectorAll('.f-port.hot').forEach((p) => p.classList.remove('hot'));
      const under = document.elementFromPoint(e.clientX, e.clientY);
      const target = under && under.closest('.f-node');
      if (target) connect(action.from, action.port, target.dataset.id);
      else renderEdges();
    }
    action = null;
  };
  canvas.addEventListener('pointerup', end);
  canvas.addEventListener('pointercancel', end);

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const r = canvas.getBoundingClientRect();
    if (e.ctrlKey || Math.abs(e.deltaY) >= Math.abs(e.deltaX)) zoomAt(e.clientX - r.left, e.clientY - r.top, e.deltaY < 0 ? 1.1 : 1 / 1.1);
    else { F.view.x -= e.deltaX; applyView(); }
  }, { passive: false });

  canvas.addEventListener('dblclick', (e) => {
    const nodeEl = e.target.closest('.f-node');
    if (nodeEl) { select({ type: 'node', id: nodeEl.dataset.id }); const first = $('f-panel').querySelector('input, textarea, select'); if (first) first.focus(); }
  });

  canvas.addEventListener('dragover', (e) => {
    if (![...e.dataTransfer.types].includes('application/x-jr-node')) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    canvas.classList.add('drop-target');
  });
  canvas.addEventListener('dragleave', () => canvas.classList.remove('drop-target'));
  canvas.addEventListener('drop', (e) => {
    canvas.classList.remove('drop-target');
    const raw = e.dataTransfer.getData('application/x-jr-node');
    if (!raw) return;
    e.preventDefault();
    const { type, agentId } = JSON.parse(raw);
    const p = toWorld(e.clientX, e.clientY);
    const n = addNode(type, { x: p.x - NODE_W / 2, y: p.y - 29 }, agentId);
    if (!n) return;
    select({ type: 'node', id: n.id });
    renderPalette();
    changed();
  });

  $('f-zoom-in').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1.2); });
  $('f-zoom-out').addEventListener('click', () => { const r = canvas.getBoundingClientRect(); zoomAt(r.width / 2, r.height / 2, 1 / 1.2); });
  $('f-fit').addEventListener('click', fitView);
}

function connect(fromId, port, toId) {
  const to = nodeById(toId);
  if (fromId === toId) { renderEdges(); return; }
  if (to.type === 'trigger') { hubToast('Nothing can connect into the Trigger', 'error'); renderEdges(); return; }
  if (F.wf.edges.some((e) => e.from === fromId && e.port === port && e.to === toId)) { renderEdges(); return; }
  F.wf.edges.push({ from: fromId, port, to: toId });
  changed();
}

function select(sel) {
  F.sel = sel;
  if (sel) F.panel = 'overview';
  renderCanvas();
  renderPanel();
}

function deleteSelection() {
  if (!F.sel) return;
  if (F.sel.type === 'edge') {
    F.wf.edges.splice(F.sel.index, 1);
  } else {
    const id = F.sel.id;
    F.wf.nodes = F.wf.nodes.filter((n) => n.id !== id);
    F.wf.edges = F.wf.edges.filter((e) => e.from !== id && e.to !== id);
  }
  F.sel = null;
  renderPalette();
  changed();
  renderPanel();
}

// --- side panel ---

function renderPanel() {
  const p = $('f-panel');
  if (F.sel && F.sel.type === 'node' && nodeById(F.sel.id)) return nodePanel(p, nodeById(F.sel.id));
  if (F.sel && F.sel.type === 'edge' && F.wf.edges[F.sel.index]) {
    const e = F.wf.edges[F.sel.index];
    p.innerHTML = `<h3>Connection</h3><p>${esc(nodeById(e.from).name)} <span class="h-pill">${esc(e.port)}</span> → ${esc(nodeById(e.to).name)}</p>
      <div class="h-row" style="margin-top: var(--sp-4)"><button class="h-btn h-btn-danger" id="p-del">Delete connection</button></div><div class="h-help">Or press Delete.</div>`;
    $('p-del').addEventListener('click', deleteSelection);
    return;
  }
  if (F.panel === 'runs') return runsPanel(p);
  if (F.panel === 'hook') return hookPanel(p);
  overviewPanel(p);
}

function overviewPanel(p) {
  const v = F.validation;
  const issues = v ? [...v.errors.map((x) => ['bad', x]), ...v.warnings.map((x) => ['warn', x])] : [];
  p.innerHTML = `
    <h3>Workflow</h3>
    <label class="h-label">Description</label>
    <textarea class="h-textarea" id="p-desc" rows="2" placeholder="What this workflow does">${esc(F.wf.description)}</textarea>
    <span class="h-label">Check</span>
    ${!v ? '<div class="h-muted">Checking…</div>' : issues.length ? issues.map(([k, i]) => `<div class="h-callout ${k}" ${i.node ? `data-goto="${esc(i.node)}" style="cursor:pointer"` : ''}>${esc(i.message)}</div>`).join('') : '<div class="h-callout good">Ready to run.</div>'}
    ${F.run ? runSummary() : ''}
    <span class="h-label">How it works</span>
    <ul class="h-list">
      <li>Drag agents and nodes from the left. Connect a node's right dot to the next node.</li>
      <li>Each node gets the previous node's result as <code>$json</code>. Use <code>{{ $json.field }}</code> or <code>{{ $node["Name"].json.field }}</code> in any setting.</li>
      <li>Agents run with their own tools, permissions and guardrails. An approval anywhere pauses the whole workflow.</li>
      <li>Click a node or a connection, then Delete to remove it. Scroll to zoom, drag the background to pan.</li>
    </ul>`;
  $('p-desc').addEventListener('input', (e) => { F.wf.description = e.target.value; changed({ canvas: false }); });
  p.querySelectorAll('[data-goto]').forEach((el) => el.addEventListener('click', () => select({ type: 'node', id: el.dataset.goto })));
}

const STATUS_WORD = { completed: 'Completed', failed: 'Failed', awaiting_approval: 'Waiting for approval', running: 'Running' };

function runSummary() {
  const r = F.run;
  return `
    <span class="h-label">Last run</span>
    <div class="h-row"><span class="h-pill s-${esc(r.status)}">${esc(STATUS_WORD[r.status] || r.status)}</span><span class="h-muted">${esc(r.source)} · ${r.finishedAt ? `${((r.finishedAt - r.startedAt) / 1000).toFixed(1)}s` : 'in progress'}</span></div>
    ${r.error ? `<div class="h-callout bad">${esc(r.error)}</div>` : ''}
    ${r.output != null ? `<span class="h-label">Result</span><pre class="h-code">${esc(JSON.stringify(r.output, null, 2))}</pre>` : ''}
    <span class="h-label">Log</span><ol class="f-log">${(r.log || []).map((l) => `<li>${esc(l.text)}</li>`).join('')}</ol>`;
}

function templateText(v) {
  return typeof v === 'string' ? v : JSON.stringify(v, null, 2);
}

// Template fields accept JSON or plain text with {{ }} expressions; half-typed JSON is held back until it parses.
function readTemplate(el) {
  const t = el.value;
  const trimmed = t.trim();
  if (/^[[{]/.test(trimmed)) {
    try { el.classList.remove('f-json-bad'); return { ok: true, value: JSON.parse(trimmed) }; } catch { el.classList.add('f-json-bad'); return { ok: false }; }
  }
  el.classList.remove('f-json-bad');
  return { ok: true, value: t };
}

function upstreamNames(n) {
  const names = new Set();
  const walk = (id) => {
    for (const e of F.wf.edges.filter((x) => x.to === id)) {
      const a = nodeById(e.from);
      if (a && !names.has(a.name)) { names.add(a.name); walk(a.id); }
    }
  };
  walk(n.id);
  return [...names];
}

function exprHelp(n) {
  const ups = upstreamNames(n);
  return `<div class="f-expr-help">Insert: <code data-ins="{{ $json }}">$json</code> (the incoming item)${ups.map((u) => ` · <code data-ins='{{ $node["${esc(u)}"].json }}'>${esc(u)}</code>`).join('')}</div>`;
}

function configForm(n) {
  const c = n.config;
  const tpl = (key, rows, help = '') => `<textarea class="h-textarea mono" rows="${rows}" data-tpl="${key}">${esc(templateText(c[key]))}</textarea>${help ? `<div class="h-help">${help}</div>` : ''}${exprHelp(n)}`;
  switch (n.type) {
    case 'trigger': return `
      <label class="h-label">Started by</label>
      <select class="h-select" data-cfg="mode"><option value="manual" ${c.mode === 'manual' ? 'selected' : ''}>Run button</option><option value="webhook" ${c.mode === 'webhook' ? 'selected' : ''}>Webhook (n8n, scripts) or Run button</option></select>
      <label class="h-label">Test input (JSON)</label>
      <textarea class="h-textarea mono" rows="7" data-tpl="sample">${esc(JSON.stringify(c.sample, null, 2))}</textarea>
      <div class="h-help">Used when you click Run workflow. A webhook call sends its own input.</div>`;
    case 'agent': {
      const a = F.agents.find((x) => x.id === c.agentId);
      return `
      <label class="h-label">Agent</label>
      <select class="h-select" data-cfg="agentId"><option value="">Choose…</option>${F.agents.map((x) => `<option value="${esc(x.id)}" ${x.id === c.agentId ? 'selected' : ''}>${esc(x.identity.name)} (v${esc(x.version)})</option>`).join('')}</select>
      ${a ? `<div class="h-help">${esc(a.purpose)} · tools: ${a.tools.map((t) => esc(t.id)).join(', ') || 'none'} · ${a.humanInTheLoop.approveOutput || a.humanInTheLoop.approveTools.length ? 'has approval points' : 'no approval points'} · <a href="/studio.html?agent=${esc(a.id)}" target="_blank">open in Studio</a></div>` : ''}
      <label class="h-label">Agent input</label>
      ${tpl('input', 6, a ? `This agent expects: ${Object.keys((a.inputSchema && a.inputSchema.properties) || {}).map(esc).join(', ') || 'any value'}. <button class="h-link" id="p-fill">Map fields from $json</button>` : '')}`;
    }
    case 'if': return `
      <label class="h-label">Field</label>
      <input class="h-input mono" data-cfg="path" value="${esc(c.path)}" placeholder="category or $node[&quot;Triage&quot;].json.category">
      <label class="h-label">Condition</label>
      <select class="h-select" data-cfg="op">${F.meta.ifOps.map((o) => `<option value="${o}" ${o === c.op ? 'selected' : ''}>${OP_LABEL[o]}</option>`).join('')}</select>
      ${['exists', 'not_exists', 'is_true'].includes(c.op) ? '' : `<label class="h-label">Value</label><input class="h-input" data-cfg="value" value="${esc(c.value)}" placeholder="bug">`}
      ${exprHelp(n)}<div class="h-help">Items that match go out of "true", the rest out of "false".</div>`;
    case 'set': return `<label class="h-label">New item (JSON)</label>${tpl('value', 8, 'The output replaces the incoming item.')}`;
    case 'approval': return `<label class="h-label">What the approver sees</label>${tpl('message', 3)}<div class="h-help">Approve continues from "approved", Reject from "rejected". Decide in the banner on this canvas (or from Executions), or over the webhook API.</div>`;
    case 'http': return `
      <label class="h-label">Method</label>
      <select class="h-select" data-cfg="method"><option ${c.method === 'POST' ? 'selected' : ''}>POST</option><option ${c.method === 'GET' ? 'selected' : ''}>GET</option></select>
      <label class="h-label">URL</label>
      <input class="h-input mono" data-cfg="url" value="${esc(c.url)}" placeholder="https://hooks.slack.com/services/…">
      <label class="h-label">Headers (JSON)</label>
      <textarea class="h-textarea mono" rows="2" data-tpl="headers">${esc(JSON.stringify(c.headers, null, 2))}</textarea>
      ${c.method === 'POST' ? `<label class="h-label">Body</label>${tpl('body', 5)}` : exprHelp(n)}
      <div class="h-help">HTTPS only; private network addresses are refused on the public server.</div>`;
    case 'output': return `<label class="h-label">Result</label>${tpl('value', 5, 'What the Run button, the webhook caller or n8n gets back.')}`;
    default: return '';
  }
}

function nodeRunDetail(n) {
  const r = F.run && F.run.nodes && F.run.nodes[n.id];
  if (!r) return '';
  const pending = F.run.pending && F.run.pending.nodeId === n.id;
  return `
    <span class="h-label">Last run</span>
    <div class="h-row"><span class="h-pill s-${r.status === 'success' ? 'completed' : r.status === 'error' ? 'failed' : 'awaiting_approval'}">${esc(r.status)}</span>${r.port && n.type !== 'output' ? `<span class="h-muted">went out of "${esc(r.port)}"</span>` : ''}${r.agentRunId ? `<span class="h-muted">agent run ${esc(r.agentRunId)}</span>` : ''}</div>
    ${r.error ? `<div class="h-callout bad">${esc(r.error)}</div>` : ''}
    ${pending ? `<div class="h-callout warn">${esc(F.run.pending.message || 'Waiting for approval')}</div>` : ''}
    ${r.agentSteps && r.agentSteps.length ? `<span class="h-label">Agent steps</span><ol class="f-log">${r.agentSteps.map((s) => `<li><strong>${esc(s.kind)}</strong> ${esc(s.detail)}</li>`).join('')}</ol>` : ''}
    <span class="h-label">Input</span><pre class="h-code">${esc(JSON.stringify(r.input, null, 2))}</pre>
    ${r.output !== undefined ? `<span class="h-label">Output</span><pre class="h-code">${esc(JSON.stringify(r.output, null, 2))}</pre>` : ''}`;
}

function nodePanel(p, n) {
  p.innerHTML = `
    <h3><span class="f-icon t-${n.type}">${ICON[n.type]}</span>${esc(F.meta.nodeTypes[n.type].label)}</h3>
    <div class="h-help" style="margin-bottom: var(--sp-3)">${esc(F.meta.nodeTypes[n.type].description)}</div>
    <label class="h-label">Name</label>
    <input class="h-input" id="p-name" value="${esc(n.name)}">
    ${configForm(n)}
    ${nodeRunDetail(n)}
    <div class="h-row" style="margin-top: var(--sp-5)"><button class="h-btn h-btn-danger h-btn-sm" id="p-del">Delete node</button></div>`;
  $('p-name').addEventListener('input', (e) => {
    const name = e.target.value.trim();
    if (!name || F.wf.nodes.some((x) => x !== n && x.name === name)) { e.target.classList.add('f-json-bad'); return; }
    e.target.classList.remove('f-json-bad');
    renameReferences(n.name, name);
    n.name = name;
    changed();
  });
  p.querySelectorAll('[data-cfg]').forEach((el) => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => {
    n.config[el.dataset.cfg] = el.value;
    if (el.dataset.cfg === 'agentId') {
      const a = F.agents.find((x) => x.id === el.value);
      if (a) { n.config.input = inputFromSchema(a.inputSchema); if (/^Agent( \d+)?$/.test(n.name) || F.agents.some((x) => x.identity.name === n.name)) n.name = uniqueName(a.identity.name); }
    }
    changed();
    if (el.tagName === 'SELECT') nodePanel(p, n);
  }));
  p.querySelectorAll('[data-tpl]').forEach((el) => el.addEventListener('input', () => {
    const r = readTemplate(el);
    if (!r.ok) return;
    if ((el.dataset.tpl === 'sample' || el.dataset.tpl === 'headers') && typeof r.value === 'string') { el.classList.toggle('f-json-bad', r.value.trim() !== ''); return; }
    n.config[el.dataset.tpl] = r.value;
    changed();
  }));
  p.querySelectorAll('input, textarea').forEach((el) => el.addEventListener('focus', () => { F.lastField = el; }));
  p.querySelectorAll('[data-ins]').forEach((c) => c.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const f = F.lastField && p.contains(F.lastField) ? F.lastField : p.querySelector('[data-tpl], [data-cfg="path"], [data-cfg="url"], [data-cfg="value"]');
    if (!f) return;
    const s = f.selectionStart ?? f.value.length;
    f.value = f.value.slice(0, s) + c.dataset.ins + f.value.slice(f.selectionEnd ?? s);
    f.dispatchEvent(new Event('input'));
    f.focus();
  }));
  const fill = $('p-fill');
  if (fill) fill.addEventListener('click', () => {
    const a = F.agents.find((x) => x.id === n.config.agentId);
    n.config.input = inputFromSchema(a.inputSchema);
    changed();
    nodePanel(p, n);
  });
  $('p-del').addEventListener('click', deleteSelection);
}

// Renaming a node keeps every {{ $node["Old"] }} reference pointing at it.
function renameReferences(oldName, newName) {
  const from = `$node["${oldName}"]`;
  const to = `$node["${newName}"]`;
  const fix = (v) => typeof v === 'string' ? v.split(from).join(to) : Array.isArray(v) ? v.map(fix) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fix(x)])) : v;
  for (const node of F.wf.nodes) node.config = fix(node.config);
}

// --- validate, save, run ---

let validateTimer = null;
function scheduleValidate() {
  clearTimeout(validateTimer);
  validateTimer = setTimeout(async () => {
    try {
      const out = await hubApi('POST', '/workflows/validate', { workflow: F.wf });
      F.validation = out.validation;
      renderCanvas();
      if (!F.sel && F.panel === 'overview') renderPanel();
    } catch (e) { /* offline; the save will report it */ }
  }, 400);
}

async function save() {
  const btn = $('f-save');
  btn.disabled = true;
  try {
    if (F.id) {
      const out = await hubApi('PUT', `/workflows/${F.id}`, { workflow: F.wf, message: 'Edit in the workflow editor' });
      hubToast(out.changed ? `Saved v${out.workflow.version}` : 'No changes to save');
      F.wf.version = out.workflow.version;
    } else {
      const out = await hubApi('POST', '/workflows', { workflow: F.wf });
      F.id = out.workflow.id;
      F.wf.id = F.id;
      F.wf.version = out.workflow.version;
      history.replaceState(null, '', `/flows.html?id=${encodeURIComponent(F.id)}`);
      hubToast(`Created ${out.workflow.name}`);
    }
    F.saved = JSON.stringify(F.wf);
    updateHeader();
    if (hubChannel) hubChannel.postMessage({ workflow: F.id });
  } catch (e) {
    hubToast(e.message, 'error');
  } finally {
    btn.disabled = false;
  }
}

function banner(kind, html) {
  const b = $('f-banner');
  b.className = `f-banner ${kind}`;
  b.innerHTML = html;
  b.hidden = !html;
}

function showRun(run) {
  F.run = run;
  renderCanvas();
  if (run.status === 'awaiting_approval') {
    const node = nodeById(run.pending.nodeId);
    banner('warn', `<span><strong>${esc(node ? node.name : 'A node')}</strong> is waiting: ${esc(run.pending.message || 'approve to continue')}</span>
      <input class="h-input" id="b-note" placeholder="Note (optional)" style="width:160px">
      <button class="h-btn h-btn-ok h-btn-sm" id="b-yes">Approve</button><button class="h-btn h-btn-ghost h-btn-sm" id="b-no">Reject</button>`);
    $('b-yes').addEventListener('click', () => decide(true));
    $('b-no').addEventListener('click', () => decide(false));
  } else if (run.status === 'completed') {
    banner('good', `<span>Completed in ${((run.finishedAt - run.startedAt) / 1000).toFixed(1)}s.</span><button class="h-link" id="b-result">See the result</button><button class="h-link" id="b-close">Dismiss</button>`);
    $('b-result').addEventListener('click', () => { F.sel = null; F.panel = 'overview'; renderCanvas(); renderPanel(); });
    $('b-close').addEventListener('click', () => banner('', ''));
  } else if (run.status === 'failed') {
    banner('bad', `<span>${esc(run.error || 'Failed')}</span>${run.failedNode ? '<button class="h-link" id="b-node">Show the node</button>' : ''}<button class="h-link" id="b-close">Dismiss</button>`);
    if (run.failedNode) $('b-node').addEventListener('click', () => select({ type: 'node', id: run.failedNode }));
    $('b-close').addEventListener('click', () => banner('', ''));
  }
  renderPanel();
}

async function runWorkflow() {
  const trigger = F.wf.nodes.find((n) => n.type === 'trigger');
  const saved = F.id && !isDirty();
  const btn = $('f-run');
  btn.disabled = true;
  btn.textContent = 'Running…';
  F.run = { status: 'running', nodes: {} };
  renderCanvas();
  banner('', '<span>Running… agent steps can take a little while.</span>');
  try {
    const { run } = await hubApi('POST', '/workflows/run', saved ? { workflowId: F.id, input: trigger && trigger.config.sample } : { workflow: F.wf, input: trigger && trigger.config.sample });
    F.runSaved = saved;
    showRun(run);
  } catch (e) {
    banner('bad', `<span>${esc(e.message)}</span>`);
    F.run = null;
    renderCanvas();
  } finally {
    btn.disabled = false;
    btn.textContent = 'Run workflow';
  }
}

async function decide(approved) {
  const note = ($('b-note') && $('b-note').value) || '';
  banner('', `<span>${approved ? 'Approved' : 'Rejected'}; continuing…</span>`);
  try {
    const { run } = await hubApi('POST', `/workflows/runs/${F.run.id}/decision`, { workflowId: F.runSaved ? F.id : undefined, approved, note });
    showRun(run);
  } catch (e) { banner('bad', `<span>${esc(e.message)}</span>`); }
}

async function runsPanel(p) {
  if (!F.id) { p.innerHTML = '<h3>Executions</h3><div class="h-muted">Save the workflow to keep a history of its runs.</div>'; return; }
  p.innerHTML = '<h3>Executions</h3><div class="h-muted">Loading…</div>';
  const { runs } = await hubApi('GET', `/workflows/${F.id}/runs`);
  p.innerHTML = `<h3>Executions</h3><p class="h-muted" style="margin-bottom: var(--sp-3)">Runs from the editor, the webhook and n8n. Click one to show it on the canvas.</p>
    ${runs.length ? runs.map((r) => `<div class="f-run-item" data-run="${esc(r.id)}"><span class="h-pill s-${esc(r.status)}">${esc(STATUS_WORD[r.status] || r.status)}</span><span>${esc(r.source)}</span><span class="h-muted">${esc(timeAgo(r.startedAt))}</span></div>`).join('') : '<div class="h-muted">No runs yet.</div>'}`;
  p.querySelectorAll('[data-run]').forEach((el) => el.addEventListener('click', () => {
    const r = runs.find((x) => x.id === el.dataset.run);
    F.runSaved = true;
    F.panel = 'overview';
    showRun(r);
  }));
}

async function hookPanel(p, token) {
  if (!F.id) { p.innerHTML = '<h3>Webhook</h3><div class="h-muted">Save the workflow first.</div>'; return; }
  const info = token ? token : await hubApi('GET', `/workflows/${F.id}/connect`);
  const key = info.key;
  p.innerHTML = `
    <h3>Webhook</h3>
    <p class="h-muted">Start this workflow from anywhere: n8n (an HTTP Request node), a script, or another service. It runs exactly as the Run button does, with its own token.</p>
    ${info.localOnly ? '<div class="h-callout warn">This server has no public address, so only callers on this machine can reach it.</div>' : ''}
    ${info.token ? `<div class="h-callout good"><strong>Copy this token now.</strong> Only a hash is kept.<pre class="h-code">${esc(info.token)}</pre><button class="h-btn h-btn-sm" id="w-copy">Copy</button></div>` : ''}
    <div class="h-row" style="margin: var(--sp-3) 0">${key ? `<span class="h-pill good">Enabled</span><span class="h-muted">${esc(key.prefix)}${key.lastUsedAt ? ` · last used ${esc(timeAgo(key.lastUsedAt))}` : ''}</span>` : '<span class="h-pill">Off</span>'}</div>
    <div class="h-row"><button class="h-btn h-btn-sm" id="w-issue">${key ? 'Replace token' : 'Enable webhook'}</button>${key ? '<button class="h-btn h-btn-danger h-btn-sm" id="w-off">Disable</button>' : ''}</div>
    <span class="h-label">Call</span><pre class="h-code">POST ${esc(info.runUrl)}
Authorization: Bearer &lt;token&gt;

${esc(JSON.stringify(info.exampleBody, null, 2))}</pre>
    <span class="h-label">curl</span><pre class="h-code">${esc(info.curl)}</pre>
    <div class="h-help">A paused run answers 202; approve it here or POST {"approved": true} to ${esc(info.decisionUrl)}.</div>`;
  if ($('w-copy')) $('w-copy').addEventListener('click', () => copyText(info.token));
  $('w-issue').addEventListener('click', async () => {
    if (key && !confirm('Replace the token? Callers using the old one stop working.')) return;
    hookPanel(p, await hubApi('POST', `/workflows/${F.id}/connect`));
  });
  if ($('w-off')) $('w-off').addEventListener('click', async () => {
    if (!confirm('Disable the webhook?')) return;
    await hubApi('DELETE', `/workflows/${F.id}/connect`);
    hookPanel(p);
  });
}

// --- wiring the chrome ---

$('f-name').addEventListener('input', (e) => { F.wf.name = e.target.value.trim() || 'New workflow'; changed({ canvas: false }); });
$('f-save').addEventListener('click', save);
$('f-run').addEventListener('click', runWorkflow);
$('f-runs-btn').addEventListener('click', () => { F.sel = null; F.panel = F.panel === 'runs' ? 'overview' : 'runs'; renderCanvas(); renderPanel(); });
$('f-hook-btn').addEventListener('click', () => { F.sel = null; F.panel = F.panel === 'hook' ? 'overview' : 'hook'; renderCanvas(); renderPanel(); });
document.addEventListener('keydown', (e) => {
  const typing = /^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement && document.activeElement.tagName);
  if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); return; }
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); runWorkflow(); return; }
  if (typing) return;
  if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); }
  if (e.key === 'Escape') select(null);
});
window.addEventListener('beforeunload', (e) => { if (F.wf && isDirty()) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('focus', async () => {
  try { F.agents = (await hubApi('GET', '/agents')).agents.map((a) => a.definition); renderPalette(); renderCanvas(); } catch { /* keep the old list */ }
});

boot();
