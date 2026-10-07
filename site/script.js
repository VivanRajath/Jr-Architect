// The public Tailscale Funnel address of the laptop running Jr Architect.
const LIVE_URL = 'https://inspiron.tail958877.ts.net';

// The "let me know" button posts to this ntfy.sh topic; subscribe to it in the ntfy app to get a phone notification.
const NTFY_TOPIC = 'jr-architect-wake-m043xgr8s5';
const PING_COOLDOWN_MS = 10 * 60 * 1000;

// The shared beta code (JR_BETA_CODE on the server), shown to visitors so they can sign in.
const BETA_CODE = 'jr-0771ec14';

const liveLink = document.getElementById('live-link');
liveLink.href = LIVE_URL;
document.getElementById('live-url-text').textContent = LIVE_URL;

const links = document.getElementById('links');
document.getElementById('menu').addEventListener('click', () => links.classList.toggle('open'));
links.addEventListener('click', (e) => { if (e.target.tagName === 'A') links.classList.remove('open'); });

// Opening the demo also tells the owner someone wants to try it, at most once every ten minutes per visitor.
const pingStatus = document.getElementById('ping-status');
function lastPing() {
  try { return Number(localStorage.getItem('jr-ping-at')) || 0; } catch { return 0; }
}
liveLink.addEventListener('click', () => {
  if (Date.now() - lastPing() < PING_COOLDOWN_MS) return;
  try { localStorage.setItem('jr-ping-at', String(Date.now())); } catch { /* storage blocked */ }
  const when = new Date().toLocaleString();
  const from = document.referrer ? ` (came from ${document.referrer})` : '';
  // A plain text POST needs no preflight; keepalive lets it finish while the new tab opens.
  const url = `https://ntfy.sh/${encodeURIComponent(NTFY_TOPIC)}?title=${encodeURIComponent('Someone is opening Jr Architect')}&tags=computer&priority=high`;
  fetch(url, { method: 'POST', body: `A visitor opened the live demo at ${when}${from}. If the laptop is asleep, start the tunnel.`, keepalive: true }).catch(() => {});
  pingStatus.textContent = "Opening Jr Architect in a new tab. If it doesn't load, I've been notified and will switch it on shortly.";
});

const betaBtn = document.getElementById('beta-btn');
const betaBox = document.getElementById('beta-box');
const betaCopy = document.getElementById('beta-copy');
document.getElementById('beta-code').textContent = BETA_CODE;
betaBtn.addEventListener('click', () => {
  betaBox.hidden = !betaBox.hidden;
  betaBtn.setAttribute('aria-expanded', String(!betaBox.hidden));
  betaBtn.textContent = betaBox.hidden ? 'Show beta code' : 'Hide beta code';
});
betaCopy.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(BETA_CODE);
    betaCopy.textContent = 'Copied';
  } catch {
    getSelection().selectAllChildren(document.getElementById('beta-code'));
    betaCopy.textContent = 'Press Ctrl+C';
  }
  setTimeout(() => { betaCopy.textContent = 'Copy'; }, 1800);
});

// Generated-app gallery tabs.
const galleryImg = document.getElementById('gallery-img');
const galleryCap = document.getElementById('gallery-cap');
document.querySelectorAll('#gallery .tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('#gallery .tab').forEach((t) => t.classList.toggle('on', t === tab));
    galleryImg.style.opacity = 0;
    const next = new Image();
    next.onload = () => { galleryImg.src = tab.dataset.img; galleryImg.alt = tab.textContent; galleryCap.textContent = tab.dataset.cap; galleryImg.style.opacity = 1; };
    next.src = tab.dataset.img;
  });
});

// Lightbox for screenshots and the diagram.
const box = document.getElementById('lightbox');
const close = () => { box.hidden = true; box.querySelector('svg')?.remove(); document.body.style.overflow = ''; };
document.querySelectorAll('[data-zoom]').forEach((fig) => {
  fig.addEventListener('click', () => {
    const img = box.querySelector('img');
    const svg = fig.querySelector('svg');
    if (svg) { img.hidden = true; box.insertBefore(svg.cloneNode(true), img); } else { img.hidden = false; img.src = fig.querySelector('img').src; img.alt = fig.querySelector('img').alt; }
    box.hidden = false;
    document.body.style.overflow = 'hidden';
  });
});
box.addEventListener('click', close);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !box.hidden) close(); });

// Fade sections in as they scroll into view.
const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  entries.forEach((en) => { if (en.isIntersecting) { en.target.classList.add('in'); io.unobserve(en.target); } });
}, { rootMargin: '0px 0px -10% 0px' }) : null;
document.querySelectorAll('.step, .card, .diagram, .live-card, .pick, .road, .stack').forEach((el) => {
  if (!io) return;
  el.classList.add('reveal');
  io.observe(el);
});
