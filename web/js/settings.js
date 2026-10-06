// Settings: provider keys (stored by the Go server) and appearance.

function renderProviders(status) {
  document.getElementById('keysLocked').hidden = status.editable;
  document.getElementById('keyInput').hidden = !status.editable;
  document.getElementById('providers').innerHTML = status.providers.map(p => {
    const pill = !p.configured ? '<span class="h-pill">Not set</span>'
      : p.source === 'env' ? '<span class="h-pill good">From .env</span>'
        : '<span class="h-pill good">Saved</span>';
    const remove = p.source === 'saved' && status.editable
      ? `<button class="h-btn h-btn-danger h-btn-sm" data-remove="${esc(p.id)}">Remove</button>` : '';
    return `<div class="set-provider">
      <span class="set-provider-name">${esc(p.label)}</span>
      ${pill}
      <span class="set-provider-key">${p.configured ? esc(p.masked) : `starts with ${esc(p.prefix)}`}</span>
      ${remove}
    </div>`;
  }).join('');
  document.querySelectorAll('[data-remove]').forEach(b => b.addEventListener('click', () => removeKey(b)));
}

// The first click arms the button; the second removes the key.
async function removeKey(btn) {
  if (!btn.dataset.armed) {
    btn.dataset.armed = '1';
    btn.textContent = 'Click again to remove';
    setTimeout(() => { delete btn.dataset.armed; btn.textContent = 'Remove'; }, 3000);
    return;
  }
  try {
    const res = await fetch('/settings/keys', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ provider: btn.dataset.remove, key: '' }),
    });
    const d = await res.json();
    if (!res.ok) throw new Error(d.error || 'could not remove the key');
    hubToast(`${d.provider.label} key removed`);
    renderProviders({ providers: d.providers, editable: true });
  } catch (e) {
    hubToast(e.message, 'error');
  }
}

mountAccountCard(document.getElementById('account'));

(async () => {
  renderProviders(await jrKeyStatus(true));
  jrMountKeyInput(document.getElementById('keyInput'), {
    onSaved: (d) => renderProviders({ providers: d.providers, editable: true }),
  });
})();
