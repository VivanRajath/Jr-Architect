document.getElementById('login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.target.querySelector('button');
  const err = document.getElementById('login-error');
  btn.disabled = true;
  err.textContent = '';
  try {
    const res = await fetch('/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Jr': '1' },
      body: JSON.stringify({ code: document.getElementById('code').value }),
    });
    if (res.ok) { location.href = '/'; return; }
    const data = await res.json().catch(() => ({}));
    err.textContent = data.error || 'Sign in failed';
  } catch {
    err.textContent = 'Could not reach the server';
  }
  btn.disabled = false;
});
