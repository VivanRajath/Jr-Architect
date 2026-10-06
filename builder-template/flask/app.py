# Serves the UI from public/ and runs Agent Hub workflows for it; the tokens in jr-workflows.json never reach the browser.
import json
import time
import os
import urllib.error
import urllib.request

from flask import Flask, jsonify, request

ROOT = os.path.dirname(os.path.abspath(__file__))
app = Flask(__name__, static_folder=os.path.join(ROOT, "public"), static_url_path="")


def workflow_config():
    try:
        with open(os.path.join(ROOT, "jr-workflows.json"), encoding="utf-8") as f:
            return json.load(f)
    except (OSError, ValueError):
        return {"workflows": {}}


@app.get("/")
def index():
    return app.send_static_file("index.html")


@app.post("/api/workflows/<key>")
def run_workflow(key):
    cfg = workflow_config()
    flow = cfg.get("workflows", {}).get(key)
    if not flow:
        print(f"[workflow] {key}: unknown workflow (check jr-workflows.json)", flush=True)
        return jsonify(status="failed", error="Unknown workflow"), 404
    started = time.monotonic()
    body = json.dumps({"input": request.get_json(silent=True) or {}}).encode()
    req = urllib.request.Request(
        f"{cfg['base']}/hooks/workflows/{flow['id']}/run",
        data=body,
        headers={"Content-Type": "application/json", "Authorization": f"Bearer {flow['token']}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            run = json.loads(resp.read() or b"{}")
            code = 200
    except urllib.error.HTTPError as e:
        run, code = json.loads(e.read() or b"{}"), e.code
    except OSError as e:
        print(f"[workflow] {key}: could not reach {cfg.get('base')} ({e})", flush=True)
        return jsonify(status="failed", error=f"Could not reach Jr Architect at {cfg.get('base')}"), 502
    print(f"[workflow] {key} -> {run.get('status', code)} in {int((time.monotonic() - started) * 1000)}ms" + (f": {run.get('error')}" if run.get("error") else ""), flush=True)
    return jsonify(status=run.get("status", "failed"), output=run.get("output"), error=run.get("error")), code


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, debug=True)
