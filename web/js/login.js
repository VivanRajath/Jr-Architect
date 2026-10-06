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
  show('auth-gh-note', p.github);
  show('auth-google', p.google);
  show('auth-form', p.beta);
  show('auth-divider', oauth && p.beta);
  if (!oauth && p.beta) {
    document.getElementById('auth-title').textContent = 'Private beta';
    document.getElementById('auth-sub').textContent = 'Enter the beta code you were given.';
    document.getElementById('code').focus();
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
