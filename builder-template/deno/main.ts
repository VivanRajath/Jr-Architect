// Serves the UI from public/ and runs Agent Hub workflows for it; the tokens in jr-workflows.json never reach the browser.
const TYPES: Record<string, string> = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css', json: 'application/json', svg: 'image/svg+xml', png: 'image/png', ico: 'image/x-icon' };
const json = (code: number, body: unknown) => Response.json(body, { status: code });

async function workflowConfig(): Promise<{ base?: string; workflows: Record<string, { id: string; token: string }> }> {
  try { return JSON.parse(await Deno.readTextFile('jr-workflows.json')); } catch { return { workflows: {} }; }
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
    const run = await r.json().catch(() => ({}));
    console.log(`[workflow] ${key} -> ${run.status || r.status} in ${Date.now() - started}ms${run.error ? `: ${run.error}` : ''}`);
    return json(r.ok ? 200 : r.status, { status: run.status || 'failed', output: run.output, error: run.error });
  } catch (e) {
    console.log(`[workflow] ${key}: could not reach ${cfg.base} (${(e as Error).message})`);
    return json(502, { status: 'failed', error: `Could not reach Jr Architect at ${cfg.base}` });
  }
}

Deno.serve({ hostname: '0.0.0.0', port: 8000 }, async (req) => {
  const url = new URL(req.url);
  if (req.method === 'POST' && url.pathname.startsWith('/api/workflows/')) return runWorkflow(decodeURIComponent(url.pathname.slice(15)), req);
  const rel = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
  if (rel.includes('..')) return new Response('Not found', { status: 404 });
  try {
    const body = await Deno.readFile(`public/${rel}`);
    return new Response(body, { headers: { 'Content-Type': TYPES[rel.split('.').pop() || ''] || 'application/octet-stream' } });
  } catch {
    return new Response('Not found', { status: 404 });
  }
});
