"""Build mode: serves the generated UI from public/ and runs Agent Hub workflows for it."""

import json
import time
import urllib.error
import urllib.request

from django.conf import settings
from django.http import FileResponse, Http404, JsonResponse
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST

PUBLIC = settings.BASE_DIR / "public"


def workflow_config():
    try:
        return json.loads((settings.BASE_DIR / "jr-workflows.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"workflows": {}}


def public_file(request, path=""):
    target = (PUBLIC / (path or "index.html")).resolve()
    if PUBLIC.resolve() not in target.parents or not target.is_file():
        raise Http404
    return FileResponse(open(target, "rb"))


# The UI posts JSON with fetch and no CSRF token; the endpoint only forwards to this app's own workflows.
@csrf_exempt
@require_POST
def run_workflow(request, key):
    cfg = workflow_config()
    flow = cfg.get("workflows", {}).get(key)
    if not flow:
        print(f"[workflow] {key}: unknown workflow (check jr-workflows.json)", flush=True)
        return JsonResponse({"status": "failed", "error": "Unknown workflow"}, status=404)
    started = time.monotonic()
    try:
        payload = json.loads(request.body or b"{}")
    except ValueError:
        payload = {}
    req = urllib.request.Request(
        f"{cfg['base']}/hooks/workflows/{flow['id']}/run",
        data=json.dumps({"input": payload}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {flow['token']}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            run, code = json.loads(resp.read() or b"{}"), 200
    except urllib.error.HTTPError as e:
        run, code = json.loads(e.read() or b"{}"), e.code
    except OSError as e:
        print(f"[workflow] {key}: could not reach {cfg.get('base')} ({e})", flush=True)
        return JsonResponse({"status": "failed", "error": f"Could not reach Jr Architect at {cfg.get('base')}"}, status=502)
    print(f"[workflow] {key} -> {run.get('status', code)} in {int((time.monotonic() - started) * 1000)}ms" + (f": {run.get('error')}" if run.get("error") else ""), flush=True)
    return JsonResponse({"status": run.get("status", "failed"), "output": run.get("output"), "error": run.get("error")}, status=code)
