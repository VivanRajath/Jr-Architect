// Guided tour of the home page: spotlights one part at a time with an arrow and a note; runs once per browser, replayable from the rail.
(() => {
  const mode = (m) => () => { if (typeof setMode === 'function') setMode(m); };
  const STEPS = [
    { el: '#panel-build .hx-composer', before: mode('build'), title: 'Build mode', text: 'Describe an app in plain words. Jr Architect asks a few design questions, writes a spec you can edit, builds the agents and workflows, then the app itself.' },
    { el: '.hx-ideas', title: 'Need a starting point?', text: 'Click an idea to drop it into the box, then press Build.' },
    { el: '#panel-dev', before: mode('dev'), title: 'Open code', text: 'Pick one of your GitHub repos, paste a repo URL, or drop a folder from your computer. It opens in a sandboxed IDE with a terminal, live preview and the coding agent.' },
    { el: '#panel-prompt', before: mode('prompt'), title: 'Run a repo', text: 'Paste any GitHub URL to get it running on a live URL. The stack and ports are detected and shown to you before anything runs.' },
    { el: '#source-saved', before: mode('build'), title: 'Your projects', text: 'Projects you save from the IDE stay here after the sandbox stops, so you can pick up where you left off.' },
    { el: '#hubCard', title: 'Agent Hub', text: 'The agents and workflows your apps use. Open the Hub to test an agent, or wire agents together into a workflow.' },
    { el: () => document.querySelector('.jr-rail [data-nav="hub"]')?.closest('.jr-rail-group'), place: 'right', title: 'Agents, Workflows and Settings', text: 'Manage your agents and workflows from here. In Settings you add AI keys and connect GitHub.' },
  ];
  const DONE_KEY = 'jr-tour-done';
  const PAD = 8;
  let step = -1;
  let ui = null;

  function build() {
    const root = document.createElement('div');
    root.className = 'tour';
    root.innerHTML = `
      <div class="tour-block"></div>
      <div class="tour-spot"></div>
      <div class="tour-tip" role="dialog" aria-modal="true" aria-labelledby="tour-title">
        <span class="tour-arrow"></span>
        <div class="tour-count"></div>
        <h3 id="tour-title"></h3>
        <p></p>
        <div class="tour-actions">
          <button type="button" class="tour-skip">Skip tour</button>
          <button type="button" class="tour-back">Back</button>
          <button type="button" class="tour-next">Next</button>
        </div>
      </div>`;
    document.body.appendChild(root);
    const q = (s) => root.querySelector(s);
    ui = { root, spot: q('.tour-spot'), tip: q('.tour-tip'), arrow: q('.tour-arrow'), count: q('.tour-count'), title: q('h3'), text: q('p'), back: q('.tour-back'), next: q('.tour-next') };
    q('.tour-skip').addEventListener('click', end);
    ui.back.addEventListener('click', () => go(step - 1));
    ui.next.addEventListener('click', () => (step < STEPS.length - 1 ? go(step + 1) : end()));
  }

  function target() {
    const sel = STEPS[step].el;
    const el = typeof sel === 'function' ? sel() : document.querySelector(sel);
    return el && el.getClientRects().length ? el : null;
  }

  // Places the spotlight on the target and the note beside it, with the arrow pointing at the target.
  function place() {
    const el = target();
    if (!el || !ui) return;
    const r = el.getBoundingClientRect();
    const box = { top: r.top - PAD, left: r.left - PAD, width: r.width + PAD * 2, height: r.height + PAD * 2 };
    Object.assign(ui.spot.style, { top: `${box.top}px`, left: `${box.left}px`, width: `${box.width}px`, height: `${box.height}px` });

    const tip = ui.tip.getBoundingClientRect();
    const vw = innerWidth, vh = innerHeight, gap = 16;
    let side = STEPS[step].place || (vh - (box.top + box.height) >= tip.height + gap + 8 ? 'bottom' : box.top >= tip.height + gap + 8 ? 'top' : 'bottom');
    if (side === 'right' && box.left + box.width + gap + tip.width > vw - 8) side = 'bottom';
    let top, left;
    if (side === 'right') {
      left = box.left + box.width + gap;
      top = Math.min(Math.max(8, box.top + box.height / 2 - tip.height / 2), vh - tip.height - 8);
    } else {
      left = Math.min(Math.max(8, box.left + box.width / 2 - tip.width / 2), vw - tip.width - 8);
      top = side === 'bottom' ? box.top + box.height + gap : box.top - gap - tip.height;
    }
    Object.assign(ui.tip.style, { top: `${top}px`, left: `${left}px` });
    ui.tip.dataset.side = side;
    if (side === 'right') {
      ui.arrow.style.left = '';
      ui.arrow.style.top = `${Math.min(Math.max(16, box.top + box.height / 2 - top), tip.height - 16)}px`;
    } else {
      ui.arrow.style.top = '';
      ui.arrow.style.left = `${Math.min(Math.max(16, box.left + box.width / 2 - left), tip.width - 16)}px`;
    }
  }

  function go(i) {
    if (i < 0 || i >= STEPS.length) return;
    step = i;
    const s = STEPS[i];
    if (s.before) s.before();
    const el = target();
    if (!el) { if (i < STEPS.length - 1) go(i + 1); else end(); return; }
    ui.count.textContent = `${i + 1} of ${STEPS.length}`;
    ui.title.textContent = s.title;
    ui.text.textContent = s.text;
    ui.back.disabled = i === 0;
    ui.next.textContent = i === STEPS.length - 1 ? 'Done' : 'Next';
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    place();
    requestAnimationFrame(place);
    ui.next.focus({ preventScroll: true });
  }

  function onKey(e) {
    if (e.key === 'Escape') end();
    else if (e.key === 'ArrowRight') ui.next.click();
    else if (e.key === 'ArrowLeft') go(step - 1);
  }

  function start() {
    if (ui || document.body.classList.contains('ide-mode')) return;
    build();
    document.addEventListener('keydown', onKey);
    addEventListener('resize', place);
    addEventListener('scroll', place, true);
    go(0);
  }

  function end() {
    if (!ui) return;
    ui.root.remove();
    ui = null;
    document.removeEventListener('keydown', onKey);
    removeEventListener('resize', place);
    removeEventListener('scroll', place, true);
    try { localStorage.setItem(DONE_KEY, '1'); } catch { /* storage blocked */ }
    if (typeof setMode === 'function') setMode('build');
    scrollTo({ top: 0 });
  }

  window.jrStartTour = start;

  // Read before app.js clears the query; deep links (an OAuth return, ?open=repo) skip the automatic run.
  const q = new URLSearchParams(location.search);
  const asked = q.get('tour') === '1';
  let seen = false;
  try { seen = localStorage.getItem(DONE_KEY) === '1'; } catch { /* storage blocked */ }
  if (asked || (!seen && !q.toString())) addEventListener('load', () => setTimeout(start, 400));
})();
