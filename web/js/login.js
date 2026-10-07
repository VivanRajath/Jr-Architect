// Sign-in page: shows the methods this server has set up (GitHub, Google, beta code) and sends the user back where they were going.
const params = new URLSearchParams(location.search);
const errorBox = document.getElementById('auth-error');
const rawNext = params.get('next') || '/';
const next = rawNext.startsWith('/') && !rawNext.startsWith('//') && !rawNext.startsWith('/\\') ? rawNext : '/';
const show = (id, on = true) => { document.getElementById(id).hidden = !on; };

function showError(msg) {
  errorBox.textContent = msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : '';
  errorBox.hidden = !msg;
}

try { if (localStorage.getItem('jr-dark-mode') === 'false') document.body.classList.remove('dark-mode'); } catch { /* storage blocked */ }
if (params.get('error')) showError(params.get('error'));

(async () => {
  let p = { beta: true, google: false, github: false };
  try {
    const res = await fetch('/auth/providers');
    if (res.ok) p = await res.json();
  } catch { /* fall back to the beta form */ }
  const oauth = p.google || p.github;
  show('auth-providers', oauth);
  show('auth-github', p.github);
  show('auth-google', p.google);
  show('auth-form', p.beta);
  show('auth-divider', oauth && p.beta);
  if (!oauth && p.beta) {
    document.getElementById('auth-title').textContent = 'Private beta';
    if (document.getElementById('tour').hidden) document.getElementById('code').focus();
  }
  if (!oauth && !p.beta) showError('No sign-in method is set up on this server yet.');
  for (const id of ['auth-github', 'auth-google']) {
    const a = document.getElementById(id);
    a.href += '?next=' + encodeURIComponent(next);
    // One click only: the provider round trip takes a moment.
    a.addEventListener('click', (e) => {
      if (a.classList.contains('loading')) { e.preventDefault(); return; }
      a.classList.add('loading');
      a.querySelector('span').textContent = `Redirecting to ${a.dataset.label}…`;
      document.querySelectorAll('.auth-btn').forEach((b) => { if (b !== a) b.classList.add('disabled'); });
    });
  }
})();

// Coming back with the browser's back button should not leave the buttons stuck.
window.addEventListener('pageshow', () => {
  document.querySelectorAll('.auth-btn').forEach((a) => {
    a.classList.remove('loading', 'disabled');
    a.querySelector('span').textContent = `Continue with ${a.dataset.label}`;
  });
});

document.getElementById('auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const code = document.getElementById('code').value.trim();
  if (!code) { showError('Enter your beta code.'); return; }
  btn.disabled = true;
  showError('');
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Jr': '1' },
      body: JSON.stringify({ code }),
    });
    if (res.ok) { location.href = next; return; }
    const data = await res.json().catch(() => ({}));
    showError(data.error || 'Sign in failed');
  } catch {
    showError('Could not reach the server');
  }
  btn.disabled = false;
});

// First-visit walkthrough of what the platform does; Skip or the last step drops the visitor on the sign-in card.
const TOUR = [
  ['home', 'Describe an app, or bring your code', 'Start from one box: type an idea in plain words, open one of your GitHub repos, or paste any repo URL to run it.'],
  ['questions', 'Design decisions, not a form', 'A short interview turns a vague idea into a precise app. Every question has a recommended answer picked for you.'],
  ['build', 'Agents and workflows, built first', 'Your answers become an editable spec. Then the AI agents the app needs and the workflows that connect them are built and tested before any UI.'],
  ['playground', 'Talk to your workflows', 'Try every workflow in the Playground, see each agent step, and change the flow in a visual editor.'],
  ['ide-preview', 'A real IDE with a live preview', 'Every project runs in its own sandbox with a code editor, a terminal and a preview that updates as you edit.'],
  ['plan-review', 'Plan first, then the agent builds', 'Ask for a change and review the plan like a design doc. The coding agent then builds it task by task, within guardrails you set.'],
  ['source-control', 'Synced with GitHub', 'Commit, push and open pull requests from the IDE. Everything you build is yours, as a normal repo with a README.'],
];
const tour = document.getElementById('tour');
const tourImg = document.getElementById('tour-img');
const tourNext = document.getElementById('tour-next');
const tourBack = document.getElementById('tour-back');
const tourDots = document.getElementById('tour-dots');
let step = 0;

tourDots.innerHTML = TOUR.map((t, i) => `<button type="button" aria-label="Step ${i + 1}: ${t[1]}"></button>`).join('');
tourDots.querySelectorAll('button').forEach((b, i) => b.addEventListener('click', () => showStep(i)));

function showStep(i) {
  step = i;
  const [img, title, text] = TOUR[i];
  tourImg.classList.add('fading');
  const pic = new Image();
  pic.onload = pic.onerror = () => { tourImg.src = pic.src; tourImg.alt = title; tourImg.classList.remove('fading'); };
  pic.src = `/img/tour/${img}.webp`;
  if (TOUR[i + 1]) new Image().src = `/img/tour/${TOUR[i + 1][0]}.webp`;
  document.getElementById('tour-title').textContent = title;
  document.getElementById('tour-text').textContent = text;
  document.getElementById('tour-count').textContent = `${i + 1} / ${TOUR.length}`;
  tourDots.querySelectorAll('button').forEach((b, j) => b.classList.toggle('on', j === i));
  tourBack.disabled = i === 0;
  tourNext.textContent = i === TOUR.length - 1 ? 'Sign in' : 'Next';
}

function openTour() {
  showStep(0);
  tour.hidden = false;
  tourNext.focus();
}

function closeTour() {
  tour.hidden = true;
  try { localStorage.setItem('jr-tour-done', '1'); } catch { /* storage blocked */ }
  document.getElementById('tour-open').focus();
}

tourNext.addEventListener('click', () => (step < TOUR.length - 1 ? showStep(step + 1) : closeTour()));
tourBack.addEventListener('click', () => step > 0 && showStep(step - 1));
document.getElementById('tour-skip').addEventListener('click', closeTour);
document.getElementById('tour-open').addEventListener('click', openTour);
document.addEventListener('keydown', (e) => {
  if (tour.hidden) return;
  if (e.key === 'Escape') closeTour();
  else if (e.key === 'ArrowRight') tourNext.click();
  else if (e.key === 'ArrowLeft') tourBack.click();
});

let seen = false;
try { seen = localStorage.getItem('jr-tour-done') === '1'; } catch { /* storage blocked */ }
if (!seen && !params.get('error')) openTour();
