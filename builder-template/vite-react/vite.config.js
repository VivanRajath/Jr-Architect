import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import fs from 'node:fs';
import path from 'node:path';

// Runs Agent Hub workflows inside the dev server, so the tokens in jr-workflows.json never reach the browser.
function jrWorkflows() {
  return {
    name: 'jr-workflows',
    configureServer(server) {
      server.middlewares.use('/api/workflows/', async (req, res) => {
        const send = (code, body) => { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)); };
        if (req.method !== 'POST') return send(405, { status: 'failed', error: 'POST only' });
        let cfg = { workflows: {} };
        try { cfg = JSON.parse(fs.readFileSync('jr-workflows.json', 'utf8')); } catch { /* no workflows yet */ }
        const flow = (cfg.workflows || {})[decodeURIComponent(req.url.replace(/^\//, '').split('?')[0])];
        if (!flow) { console.log(`[workflow] ${req.url}: unknown workflow (check jr-workflows.json)`); return send(404, { status: 'failed', error: 'Unknown workflow' }); }
        const started = Date.now();
        let raw = '';
        for await (const chunk of req) raw += chunk;
        try {
          const r = await fetch(`${cfg.base}/hooks/workflows/${flow.id}/run`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${flow.token}` },
            body: JSON.stringify({ input: raw ? JSON.parse(raw) : {} }),
          });
          const run = await r.json().catch(() => ({}));
          console.log(`[workflow] ${req.url} -> ${run.status || r.status} in ${Date.now() - started}ms${run.error ? `: ${run.error}` : ''}`);
          send(r.ok ? 200 : r.status, { status: run.status || 'failed', output: run.output, error: run.error });
        } catch (e) {
          console.log(`[workflow] ${req.url}: could not reach ${cfg.base} (${e.message})`);
          send(502, { status: 'failed', error: `Could not reach Jr Architect at ${cfg.base}` });
        }
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), jrWorkflows()],
  resolve: { alias: { '@': path.resolve(process.cwd(), 'src') } },
  server: { host: '0.0.0.0', port: 5173, allowedHosts: true },
});
