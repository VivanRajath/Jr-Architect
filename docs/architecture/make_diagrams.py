import os, html
# Writes the SVGs and _*.html pages next to this script; render the PNGs and PDF from those pages with headless Chrome.
OUT = os.path.dirname(os.path.abspath(__file__))
os.makedirs(OUT, exist_ok=True)

STYLE = '''
  <style>
    .bg { fill: #ffffff; }
    .title { font: 700 30px Inter, 'Segoe UI', Arial, sans-serif; fill: #0f172a; }
    .subtitle { font: 400 16px Inter, 'Segoe UI', Arial, sans-serif; fill: #475569; }
    .zone rect { fill: #f8fafc; stroke: #cbd5e1; stroke-width: 1.5; }
    .zone.untrusted rect { fill: #fff7ed; stroke: #fb923c; stroke-dasharray: 7 5; }
    .zone.exec rect { fill: #fef2f2; stroke: #f87171; stroke-dasharray: 7 5; }
    .zone.go rect { fill: #eff6ff; stroke: #60a5fa; }
    .zone.node rect { fill: #f0fdf4; stroke: #4ade80; }
    .zone.ext rect { fill: #f5f3ff; stroke: #a78bfa; }
    .zone text.zt { font: 700 15px Inter, 'Segoe UI', Arial, sans-serif; fill: #334155; letter-spacing: .06em; }
    .zone text.zs { font: 400 12.5px Inter, 'Segoe UI', Arial, sans-serif; fill: #64748b; }
    .box rect { fill: #ffffff; stroke: #94a3b8; stroke-width: 1.2; }
    .box.key rect { stroke: #2563eb; stroke-width: 2; }
    .box.sec rect { stroke: #dc2626; stroke-width: 2; }
    .box.data rect { stroke: #7c3aed; stroke-width: 2; }
    .box text.t { font: 700 14.5px Inter, 'Segoe UI', Arial, sans-serif; fill: #0f172a; }
    .box text.s { font: 400 12px Inter, 'Segoe UI', Arial, sans-serif; fill: #475569; }
    .ln { fill: none; stroke: #334155; stroke-width: 1.6; }
    .ln.dash { stroke-dasharray: 6 5; }
    .ln.sec { stroke: #dc2626; }
    .ln.data { stroke: #7c3aed; }
    .lbl { font: 600 11.5px Inter, 'Segoe UI', Arial, sans-serif; fill: #334155; }
    .lbl.bg2 { paint-order: stroke; stroke: #ffffff; stroke-width: 4px; }
    .note { font: 400 13px Inter, 'Segoe UI', Arial, sans-serif; fill: #7c2d12; }
    .legend text { font: 400 13px Inter, 'Segoe UI', Arial, sans-serif; fill: #334155; }
  </style>'''

def esc(s): return html.escape(s, quote=False)

class D:
    def __init__(self, w, h, title, subtitle):
        self.w, self.h, self.parts = w, h, []
        self.parts.append(f'<rect class="bg" width="{w}" height="{h}"/>')
        self.parts.append(f'<text class="title" x="40" y="52">{esc(title)}</text>')
        self.parts.append(f'<text class="subtitle" x="40" y="80">{esc(subtitle)}</text>')
    def zone(self, x, y, w, h, title, sub='', kind=''):
        self.parts.append(f'<g class="zone {kind}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="16"/>'
                          f'<text class="zt" x="{x+18}" y="{y+28}">{esc(title.upper())}</text>'
                          + (f'<text class="zs" x="{x+18}" y="{y+47}">{esc(sub)}</text>' if sub else '') + '</g>')
    def box(self, x, y, w, h, title, *lines, kind=''):
        cx = x + w / 2
        n = 1 + len(lines)
        top = y + h / 2 - (n - 1) * 8.5 + 5
        t = [f'<text class="t" x="{cx}" y="{top}" text-anchor="middle">{esc(title)}</text>']
        for i, l in enumerate(lines):
            t.append(f'<text class="s" x="{cx}" y="{top + 18 + i * 16}" text-anchor="middle">{esc(l)}</text>')
        self.parts.append(f'<g class="box {kind}"><rect x="{x}" y="{y}" width="{w}" height="{h}" rx="10"/>{"".join(t)}</g>')
    def line(self, pts, kind='', label=None, at=None, end=True, start=False):
        d = 'M' + ' L'.join(f'{x},{y}' for x, y in pts)
        m = (' marker-end="url(#arr)"' if end else '') + (' marker-start="url(#arr)"' if start else '')
        self.parts.append(f'<path class="ln {kind}" d="{d}"{m}/>')
        if label:
            lx, ly = at or pts[len(pts) // 2]
            self.parts.append(f'<text class="lbl bg2" x="{lx}" y="{ly}" text-anchor="middle">{esc(label)}</text>')
    def text(self, x, y, s, cls='lbl', anchor='start'):
        self.parts.append(f'<text class="{cls}" x="{x}" y="{y}" text-anchor="{anchor}">{esc(s)}</text>')
    def raw(self, s): self.parts.append(s)
    def svg(self):
        defs = ('<defs><marker id="arr" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">'
                '<path d="M0,0 L10,5 L0,10 z" fill="#334155"/></marker></defs>')
        return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.w} {self.h}" width="{self.w}" height="{self.h}" font-family="Inter, Segoe UI, Arial, sans-serif">'
                + STYLE + defs + ''.join(self.parts) + '</svg>')

# ---------- Diagram 1: the system as built ----------
d = D(1760, 1240, 'Jr Architect: system architecture',
      'One Go control plane, a Node agent service, isolated sandboxes, MongoDB. Orange and red dashed areas are untrusted; the server decides everything security-relevant.')

# Browser (untrusted)
d.zone(30, 110, 270, 760, 'Browser', 'untrusted client', 'untrusted')
d.box(50, 175, 230, 64, 'Home and Build mode', 'idea -> questions -> plan -> app')
d.box(50, 255, 230, 64, 'IDE', 'Monaco editor, xterm terminal,', 'agent chat, Source Control')
d.box(50, 335, 230, 64, 'Agent Hub', 'Studio, Flows, Playground')
d.box(50, 415, 230, 64, 'Settings', 'model keys, GitHub sync')
d.box(50, 520, 230, 78, 'Live preview iframe', 'p-<token> host or tunnel URL', 'separate origin, no IDE cookie', kind='sec')
d.box(50, 640, 230, 78, 'Generated app (end users)', 'calls its own workflows', 'with a per-workflow token')
d.text(50, 770, 'Holds no secrets and makes no', 'note')
d.text(50, 788, 'security decisions: identity comes', 'note')
d.text(50, 806, 'from the session cookie only.', 'note')

# Edge
d.zone(330, 110, 150, 760, 'Edge', 'TLS')
d.box(345, 300, 120, 120, 'HTTPS + WSS', 'Tailscale Funnel', 'or Caddy', '(TLS ends here)')

# Go control plane
d.zone(510, 110, 560, 760, 'Go control plane (one binary)', 'the security authority: identity, ownership, policy, side effects', 'go')
d.box(530, 170, 520, 64, 'Transport and auth', 'session cookie (HttpOnly, SameSite), Google and GitHub OAuth, beta code,', 'origin check, X-Jr CSRF header, login and model-call rate limits', kind='sec')
d.box(530, 250, 520, 50, 'Ownership checks on every resource', 'user comes from the session; sandbox, project, file, run looked up server-side', kind='sec')
d.box(530, 316, 255, 70, 'Builder', 'questions -> PRD -> design', 'codegen -> heal -> launch')
d.box(795, 316, 255, 70, 'Stack detector', '20+ stacks, ports,', 'install and start commands')
d.box(530, 402, 255, 70, 'Sandbox lifecycle', 'limits, idle and max TTL,', 'disk reaper, orphan cleanup')
d.box(795, 402, 255, 70, 'Files and terminal', 'os.Root file API (no escapes),', 'terminal WebSocket per sandbox')
d.box(530, 488, 255, 78, 'Git service', 'tokenless git in the sandbox;', 'fetch and push in a separate', 'credential-only container', kind='sec')
d.box(795, 488, 255, 78, 'GitHub API', 'repos, branches, PRs, publish,', 'README, collaborator invite')
d.box(530, 582, 255, 70, 'Key pool and model router', 'your keys first, per-key limits,', 'Groq org caps, fallbacks')
d.box(795, 582, 255, 70, 'Preview proxy', 'p-<token> host -> sandbox port,', 'or one quick tunnel per app')
d.box(530, 668, 520, 64, 'Agent proxy  /agent/*', 'sets X-Jr-User from the session, adds the internal token,', 'strips cookies; Node is reachable only through here', kind='key')
d.box(530, 748, 520, 100, 'Accounts and secrets', 'users, sign-in identities merged by verified email,', 'GitHub tokens and model keys sealed with AES-GCM,', 'never returned to the browser', kind='data')

# Node agent service
d.zone(1100, 110, 380, 560, 'Node agent service', 'loopback only, trusts only Go', 'node')
d.box(1120, 170, 340, 64, 'IDE chat and edit engine', 'SEARCH/REPLACE edits, edit guard,', 'token-budgeted context')
d.box(1120, 250, 165, 78, 'Planning mode', 'plan, review,', 'tasks, verify,', 'walkthrough')
d.box(1295, 250, 165, 78, 'OpenGAP team', '.gitagent agents,', 'routing, handoff,', 'sealed hooks')
d.box(1120, 344, 340, 64, 'Command policy', 'model proposes, server decides: deny, ask the user', '(server-held approval), or allow', kind='sec')
d.box(1120, 424, 165, 78, 'Agent Hub runtime', 'schemas, tools,', 'guardrails, memory,', 'versions')
d.box(1295, 424, 165, 78, 'Workflow engine', 'agents, if, set,', 'HTTP, approvals,', 'webhooks')
d.box(1120, 518, 340, 64, 'Model layer', 'Groq, OpenAI, Anthropic, Gemini; per agent and per', 'message; your own keys', kind='key')
d.box(1120, 598, 340, 52, 'SSRF guard', 'public https only, DNS checked, redirects re-checked')

# External and data
d.zone(1510, 110, 220, 760, 'Data and external', '', 'ext')
d.box(1525, 170, 190, 150, 'MongoDB (Atlas)', 'users, identities,', 'projects, keys,', 'agents + versions,', 'workflows + versions,', 'runs, memory, API keys,', 'playground chats', kind='data')
d.box(1525, 340, 190, 64, 'GitHub', 'OAuth and REST from Go;', 'git from the git container')
d.box(1525, 420, 190, 64, 'Model providers', 'Groq, OpenAI, Anthropic,', 'Gemini; from Node and Go')
d.box(1525, 500, 190, 64, 'Cloudflare', 'quick tunnels, one per', 'app preview (public mode)')

# Execution plane
d.zone(510, 900, 1220, 315, 'Execution plane: container engine', 'Docker locally, rootless Podman + egress firewall + disk pools in the public deployment. Runs untrusted code; controls nothing.', 'exec')
d.box(530, 985, 270, 110, 'Sandbox: your repo', 'stack image (14 images), --memory,', '--cpus, --pids-limit, no-new-privileges,', 'dropped caps, ports on 127.0.0.1,', 'no container-engine socket', kind='sec')
d.box(815, 985, 270, 110, 'Sandbox: generated app', 'Next.js or any Build mode stack,', 'same limits, own preview token,', 'calls its workflows by webhook')
d.box(1100, 985, 270, 110, 'Git credential container', 'fresh alpine/git per fetch or push,', 'cap-drop ALL, scratch GIT_DIR,', 'repo config, hooks and filters', 'never read; token only here', kind='sec')
d.box(1385, 985, 325, 110, 'Workspaces', 'one host folder per sandbox,', 'bind-mounted at /workspace;', 'saved projects copied to the data dir')
d.box(530, 1112, 1180, 80, 'Isolation', 'separate bridge with inter-container traffic off, idle and max lifetimes, per-user and global sandbox caps, per-sandbox disk reaper;', 'public deployment: rootless Podman in a locked-down WSL distro, nftables blocks private networks, fixed-size storage pools, preflight refuses to start if any control is missing')

# Edges: only through the gaps between columns, so no line crosses a box.
d.line([(300, 360), (345, 360)])
d.line([(465, 360), (490, 360), (490, 202), (530, 202)])
d.line([(1050, 700), (1088, 700), (1088, 202), (1120, 202)], start=True)
d.text(1290, 694, 'Go -> Node: /agent/* with X-Jr-User + internal token', 'lbl', 'middle')
d.text(1290, 712, 'Node -> Go: shell and file sync, as that user', 'lbl', 'middle')
d.line([(780, 870), (780, 900)], kind='', label=None)
d.text(800, 888, 'control only: start, exec, files, terminal, preview, git', 'lbl')
d.line([(1460, 550), (1492, 550), (1492, 452), (1525, 452)])
d.line([(1480, 245), (1525, 245)], kind='data')
d.line([(1050, 798), (1502, 798), (1502, 300), (1525, 300)], kind='data')
d.line([(1235, 985), (1235, 958), (1517, 958), (1517, 384), (1525, 384)], kind='sec')
d.text(1380, 952, 'git over https, token only here', 'lbl', 'middle')
d.line([(280, 560), (312, 560), (312, 405), (345, 405)], kind='dash')
d.line([(280, 680), (322, 680), (322, 412)], kind='dash')

# Legend
lx, ly = 30, 900
d.raw(f'<g class="legend"><rect x="{lx}" y="{ly}" width="450" height="315" rx="16" fill="#ffffff" stroke="#cbd5e1"/>')
d.text(lx + 18, ly + 30, 'HOW TO READ THIS', 'lbl')
items = [('#dc2626', 'Security enforcement point (server-side)'), ('#2563eb', 'Boundary between services'), ('#7c3aed', 'Durable data (MongoDB)')]
for i, (c, t) in enumerate(items):
    y = ly + 60 + i * 32
    d.raw(f'<rect x="{lx+18}" y="{y-14}" width="34" height="20" rx="5" fill="#fff" stroke="{c}" stroke-width="2"/>')
    d.text(lx + 64, y, t, 'legend')
d.raw(f'<rect x="{lx+18}" y="{ly+142}" width="34" height="20" rx="5" fill="#fff7ed" stroke="#fb923c" stroke-dasharray="5 4"/>')
d.text(lx + 64, ly + 157, 'Untrusted: browser input, repo code, model output', 'legend')
d.raw(f'<path class="ln" d="M{lx+18},{ly+190} L{lx+52},{ly+190}" marker-end="url(#arr)"/>')
d.text(lx + 64, ly + 195, 'Request or control flow', 'legend')
d.raw(f'<path class="ln dash" d="M{lx+18},{ly+222} L{lx+52},{ly+222}" marker-end="url(#arr)"/>')
d.text(lx + 64, ly + 227, 'Preview traffic and app-to-workflow webhooks', 'legend')
d.text(lx + 18, ly + 262, 'Prompt to live app: browser -> Go builder -> model', 'legend')
d.text(lx + 18, ly + 282, 'router -> files -> sandbox -> preview proxy -> iframe.', 'legend')
d.raw('</g>')
open(os.path.join(OUT, 'architecture.svg'), 'w', encoding='utf-8').write(d.svg())

# ---------- Diagram 2: deploying and scaling Architect 2.0 in the cloud (proposal) ----------
s = D(1760, 1000, 'Architect 2.0 in the cloud: deployment and scaling (proposed)',
      'How the same design scales to thousands of concurrent builders. Today Jr Architect runs on one host; this is the target, not the current deployment.')
s.zone(30, 110, 230, 860, 'Users', '', 'untrusted')
s.box(45, 200, 200, 70, 'Browser', 'builders and developers')
s.box(45, 300, 200, 70, 'Generated apps', 'their end users')
s.box(45, 400, 200, 70, 'n8n, CI, webhooks', 'bearer tokens')

s.zone(290, 110, 230, 860, 'Edge', '', '')
s.box(305, 180, 200, 90, 'CDN + WAF', 'static UI, TLS,', 'bot and DDoS rules')
s.box(305, 290, 200, 80, 'Wildcard DNS', '*.app.example.com', 'per-app preview hosts', kind='key')
s.box(305, 400, 200, 90, 'Load balancer', 'HTTP/2, WebSocket', 'sticky only for terminals')

s.zone(550, 110, 560, 420, 'Stateless services (autoscaled)', 'any replica can serve any request', 'go')
s.box(570, 170, 250, 100, 'Go API (N replicas)', 'auth, sessions, ownership,', 'policy, rate limits, REST + WS,', 'audit events', kind='sec')
s.box(840, 170, 250, 100, 'Preview router (N)', 'host -> sandbox lookup,', 'proxies HTTP and WS', 'to the right sandbox host', kind='key')
s.box(570, 290, 250, 100, 'Agent workers (N)', 'IDE chat, Planning mode,', 'OpenGAP, Hub runs, workflows;', 'pull jobs from the queue')
s.box(840, 290, 250, 100, 'Build workers (N)', 'Build mode: plan, codegen,', 'heal; long jobs off the', 'request path')
s.box(570, 410, 520, 100, 'Model gateway', 'one place for provider keys, per-user and per-key budgets,', 'retries and fallbacks across Groq, OpenAI, Anthropic, Gemini,', 'token metering for billing', kind='key')

s.zone(550, 560, 560, 410, 'Sandbox fleet', 'untrusted code only; no credentials, no control plane access', 'exec')
s.box(570, 620, 250, 110, 'Sandbox scheduler', 'places sandboxes on hosts by', 'free CPU, memory and disk;', 'enforces per-user quotas', kind='sec')
s.box(840, 620, 250, 110, 'Sandbox hosts (M)', 'Firecracker microVMs (or gVisor)', 'per project: own kernel, CPU,', 'memory, disk and egress policy', kind='sec')
s.box(570, 750, 250, 100, 'Warm pools', 'pre-booted VMs per stack image,', 'so a new sandbox starts', 'in about a second')
s.box(840, 750, 250, 100, 'Git credential runners', 'short-lived, token injected', 'per operation, never inside', 'a project sandbox', kind='sec')
s.box(570, 870, 520, 80, 'Workspace storage', 'a block volume per active sandbox; snapshots to object storage when idle,', 'restored on reopen, so idle sandboxes cost nothing')

s.zone(1140, 110, 590, 860, 'State and platform', '', 'ext')
s.box(1160, 170, 270, 110, 'MongoDB Atlas', 'replica set, sharded by owner:', 'users, projects, agents,', 'workflows, runs, audit log', kind='data')
s.box(1445, 170, 270, 110, 'Redis', 'sessions (revocable), rate', 'limits, sandbox -> host map,', 'preview routing cache', kind='data')
s.box(1160, 300, 270, 100, 'Job queue', 'NATS or Redis Streams:', 'builds, agent runs, git jobs;', 'pending, running, done, failed')
s.box(1445, 300, 270, 100, 'Object storage', 'workspace snapshots,', 'build artefacts, exports')
s.box(1160, 420, 270, 100, 'Secrets', 'KMS-wrapped keys for GitHub', 'tokens and provider keys;', 'rotated, never in images', kind='sec')
s.box(1445, 420, 270, 100, 'Observability', 'OpenTelemetry traces, JSON logs,', 'metrics per sandbox, model', 'and user; alerts')
s.box(1160, 540, 555, 90, 'GitHub and model providers', 'GitHub App (fine-grained, per-repo install) instead of user OAuth tokens;', 'provider APIs reached only through the model gateway')
s.box(1160, 650, 555, 130, 'Deploying users\' apps', 'one click from the IDE: build in a sandbox, push the image to a registry,', 'run it on a managed runtime (Cloud Run, Fly.io or a Kubernetes namespace)', 'with its own URL, env vars from the secrets store, and the app\'s agents', 'and workflows reached through the same API with per-app tokens')
s.box(1160, 800, 555, 150, 'How it scales', 'API, agents and builds scale on CPU and queue depth; sandbox hosts', 'scale on free capacity; MongoDB shards by owner; Redis holds hot', 'routing only; previews scale with the router fleet. A user\'s limits', '(sandboxes, model calls, tokens, disk) are enforced in the API and', 'the scheduler, so one user cannot starve the rest.')

s.line([(245, 235), (305, 225)])
s.line([(245, 335), (305, 335)])
s.line([(245, 435), (305, 445)])
s.line([(505, 445), (535, 445), (535, 220), (570, 220)])
s.text(405, 510, 'API + WS', 'lbl', 'middle')
s.line([(695, 270), (695, 290)])
s.line([(695, 390), (695, 410)])
s.line([(570, 250), (560, 250), (560, 675), (570, 675)])
s.text(580, 548, 'create, stop sandboxes', 'lbl')
s.line([(820, 675), (840, 675)])
s.line([(1090, 220), (1125, 220), (1125, 690), (1090, 690)], kind='sec')
s.line([(1110, 150), (1140, 150)], kind='data')
s.text(1125, 140, 'state', 'lbl', 'middle')
s.line([(1090, 800), (1132, 800), (1132, 585), (1160, 585)], kind='sec')
s.text(405, 395, '-> preview router', 'lbl', 'middle')
open(os.path.join(OUT, 'cloud-scaling.svg'), 'w', encoding='utf-8').write(s.svg())

# Pages for PNG rendering and the PDF.
page = lambda f: f'<!doctype html><meta charset="utf-8"><style>html,body{{margin:0;background:#fff}}img{{display:block;width:100%}}</style><img src="{f}">'
open(os.path.join(OUT, '_architecture.html'), 'w').write(page('architecture.svg'))
open(os.path.join(OUT, '_cloud.html'), 'w').write(page('cloud-scaling.svg'))
open(os.path.join(OUT, '_pdf.html'), 'w').write('<!doctype html><meta charset="utf-8"><style>@page{size:1760px 1240px;margin:0}html,body{margin:0}img{display:block;width:1760px;page-break-after:always}</style><img src="architecture.svg"><img src="cloud-scaling.svg">')
print('ok')
