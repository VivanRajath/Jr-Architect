// Serves the UI from public/ and runs Agent Hub workflows for it; the tokens in jr-workflows.json never reach the browser.
use serde_json::{json, Value};
use std::fs;
use std::io::Read;
use std::time::Duration;
use tiny_http::{Header, Method, Request, Response, Server};

fn json_response(req: Request, code: u16, body: Value) {
    let header = Header::from_bytes("Content-Type", "application/json").unwrap();
    let _ = req.respond(Response::from_string(body.to_string()).with_status_code(code).with_header(header));
}

fn content_type(path: &str) -> &'static str {
    match path.rsplit('.').next().unwrap_or("") {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript",
        "css" => "text/css",
        "json" => "application/json",
        "svg" => "image/svg+xml",
        "png" => "image/png",
        _ => "application/octet-stream",
    }
}

fn run_workflow(mut req: Request, key: &str) {
    let cfg: Value = fs::read_to_string("jr-workflows.json").ok().and_then(|s| serde_json::from_str(&s).ok()).unwrap_or(json!({}));
    let flow = &cfg["workflows"][key];
    let (Some(id), Some(token)) = (flow["id"].as_str(), flow["token"].as_str()) else {
        println!("[workflow] {key}: unknown workflow (check jr-workflows.json)");
        return json_response(req, 404, json!({"status": "failed", "error": "Unknown workflow"}));
    };
    let mut raw = String::new();
    let _ = req.as_reader().take(256 * 1024).read_to_string(&mut raw);
    let input: Value = serde_json::from_str(&raw).unwrap_or(json!({}));
    let base = cfg["base"].as_str().unwrap_or("");
    let started = std::time::Instant::now();
    let call = ureq::post(&format!("{base}/hooks/workflows/{id}/run"))
        .timeout(Duration::from_secs(180))
        .set("Authorization", &format!("Bearer {token}"))
        .send_json(json!({ "input": input }));
    let (code, run): (u16, Value) = match call {
        Ok(res) => (200, res.into_json().unwrap_or(json!({}))),
        Err(ureq::Error::Status(code, res)) => (code, res.into_json().unwrap_or(json!({}))),
        Err(e) => {
            println!("[workflow] {key}: could not reach {base} ({e})");
            return json_response(req, 502, json!({"status": "failed", "error": format!("Could not reach Jr Architect at {base}")}));
        }
    };
    let status = run["status"].as_str().unwrap_or("failed").to_string();
    println!("[workflow] {key} -> {status} in {}ms {}", started.elapsed().as_millis(), run["error"].as_str().unwrap_or(""));
    json_response(req, code, json!({"status": status, "output": run["output"], "error": run["error"]}));
}

fn main() {
    let server = Server::http("0.0.0.0:8080").expect("port 8080 is free");
    println!("App running on port 8080");
    for req in server.incoming_requests() {
        let path = req.url().split('?').next().unwrap_or("/").to_string();
        if *req.method() == Method::Post && path.starts_with("/api/workflows/") {
            run_workflow(req, &path["/api/workflows/".len()..]);
            continue;
        }
        let rel = if path == "/" { "index.html".to_string() } else { path.trim_start_matches('/').to_string() };
        if rel.contains("..") {
            let _ = req.respond(Response::from_string("Not found").with_status_code(404));
            continue;
        }
        match fs::read(format!("public/{rel}")) {
            Ok(body) => {
                let header = Header::from_bytes("Content-Type", content_type(&rel)).unwrap();
                let _ = req.respond(Response::from_data(body).with_header(header));
            }
            Err(_) => {
                let _ = req.respond(Response::from_string("Not found").with_status_code(404));
            }
        }
    }
}
