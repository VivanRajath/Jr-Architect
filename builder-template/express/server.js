// Serves the UI from public/ and runs Agent Hub workflows for it; the tokens in jr-workflows.json never reach the browser.
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

function workflowConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'jr-workflows.json'), 'utf8')); } catch { return { workflows: {} }; }
}

app.post('/api/workflows/:key', async (req, res) => {
  const cfg = workflowConfig();
  const flow = (cfg.workflows || {})[req.params.key];
  if (!flow) { console.log(`[workflow] ${req.params.key}: unknown workflow (check jr-workflows.json)`); return res.status(404).json({ status: 'failed', error: 'Unknown workflow' }); }
  const started = Date.now();
  try {
    const r = await fetch(`${cfg.base}/hooks/workflows/${flow.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${flow.token}` },
      body: JSON.stringify({ input: req.body || {} }),
    });
    const run = await r.json().catch(() => ({}));
    console.log(`[workflow] ${req.params.key} -> ${run.status || r.status} in ${Date.now() - started}ms${run.error ? `: ${run.error}` : ''}`);
    res.status(r.ok ? 200 : r.status).json({ status: run.status || 'failed', output: run.output, error: run.error });
  } catch (e) {
    console.log(`[workflow] ${req.params.key}: could not reach ${cfg.base} (${e.message})`);
    res.status(502).json({ status: 'failed', error: `Could not reach Jr Architect at ${cfg.base}` });
  }
});

const port = Number(process.env.PORT) || 3000;
app.listen(port, '0.0.0.0', () => console.log(`App running on port ${port}`));
