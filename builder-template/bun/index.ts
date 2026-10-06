// Serves the UI from public/ and runs Agent Hub workflows for it; the tokens in jr-workflows.json never reach the browser.
const json = (code: number, body: unknown) => Response.json(body, { status: code });

async function workflowConfig(): Promise<{ base?: string; workflows: Record<string, { id: string; token: string }> }> {
  try { return await Bun.file('jr-workflows.json').json(); } catch { return { workflows: {} }; }
}

async function runWorkflow(key: string, req: Request) {
  const cfg = await workflowConfig();
  const flow = (cfg.workflows || {})[key];
  if (!flow) { console.log(`[workflow] ${key}: unknown workflow (check jr-workflows.json)`); return json(404, { status: 'failed', error: 'Unknown workflow' }); }
  const started = Date.now();
  const input = await req.json().catch(() => ({}));
  try {
    const r = await fetch(`${cfg.base}/hooks/workflows/${flow.id}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${flow.token}` },
      body: JSON.stringify({ input }),
    });
    const run: any = await r.json().catch(() => ({}));
    console.log(`[workflow] ${key} -> ${run.status || r.status} in ${Date.now() - started}ms${run.error ? `: ${run.error}` : ''}`);
    return json(r.ok ? 200 : r.status, { status: run.status || 'failed', output: run.output, error: run.error });
  } catch (e) {
    console.log(`[workflow] ${key}: could not reach ${cfg.base} (${(e as Error).message})`);
    return json(502, { status: 'failed', error: `Could not reach Jr Architect at ${cfg.base}` });
  }
}

Bun.serve({
  hostname: '0.0.0.0',
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === 'POST' && url.pathname.startsWith('/api/workflows/')) return runWorkflow(decodeURIComponent(url.pathname.slice(15)), req);
    const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (rel.includes('..')) return new Response('Not found', { status: 404 });
    const file = Bun.file(`public/${rel}`);
    return (await file.exists()) ? new Response(file) : new Response('Not found', { status: 404 });
  },
});
console.log('App running on port 3000');
