# Serves the UI from public/ and runs Agent Hub workflows for it; the tokens in jr-workflows.json never reach the browser.
import asyncio
import time
import json
import os
import urllib.error
import urllib.request

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

ROOT = os.path.dirname(os.path.abspath(__file__))
app = FastAPI()


def workflow_config():
    try:
        with open(os.path.join(ROOT, "jr-workflows.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"workflows": {}}


def call_workflow(cfg, flow, payload):
    req = urllib.request.Request(
        f"{cfg['base']}/hooks/workflows/{flow['id']}/run",
        data=json.dumps({"input": payload}).encode(),
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {flow['token']}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            return json.loads(resp.read() or b"{}"), 200
    except urllib.error.HTTPError as e:
        return json.loads(e.read() or b"{}"), e.code


@app.post("/api/workflows/{key}")
async def run_workflow(key: str, request: Request):
    cfg = workflow_config()
    flow = cfg.get("workflows", {}).get(key)
    if not flow:
        print(f"[workflow] {key}: unknown workflow (check jr-workflows.json)", flush=True)
        return JSONResponse({"status": "failed", "error": "Unknown workflow"}, status_code=404)
    started = time.monotonic()
    try:
        payload = await request.json()
    except ValueError:
        payload = {}
    try:
        run, code = await asyncio.to_thread(call_workflow, cfg, flow, payload)
    except OSError as e:
        print(f"[workflow] {key}: could not reach {cfg.get('base')} ({e})", flush=True)
        return JSONResponse({"status": "failed", "error": f"Could not reach Jr Architect at {cfg.get('base')}"}, status_code=502)
    print(f"[workflow] {key} -> {run.get('status', code)} in {int((time.monotonic() - started) * 1000)}ms" + (f": {run.get('error')}" if run.get("error") else ""), flush=True)
    return JSONResponse({"status": run.get("status", "failed"), "output": run.get("output"), "error": run.get("error")}, status_code=code)


app.mount("/", StaticFiles(directory=os.path.join(ROOT, "public"), html=True), name="public")
