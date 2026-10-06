<?php
// Runs Agent Hub workflows for the UI (called as /api.php?workflow=<key>); the tokens in jr-workflows.json never reach the browser.
header('Content-Type: application/json');

function reply(int $code, array $body): void {
    http_response_code($code);
    echo json_encode($body);
    exit;
}

if ($_SERVER['REQUEST_METHOD'] !== 'POST') reply(405, ['status' => 'failed', 'error' => 'POST only']);
$cfg = json_decode(@file_get_contents(__DIR__ . '/jr-workflows.json') ?: '{}', true) ?: [];
$flow = $cfg['workflows'][$_GET['workflow'] ?? ''] ?? null;
if (!$flow) { error_log('[workflow] ' . ($_GET['workflow'] ?? '') . ': unknown workflow (check jr-workflows.json)'); reply(404, ['status' => 'failed', 'error' => 'Unknown workflow']); }
$started = microtime(true);

$input = json_decode(file_get_contents('php://input') ?: '{}', true) ?: new stdClass();
$ctx = stream_context_create(['http' => [
    'method' => 'POST',
    'header' => "Content-Type: application/json\r\nAuthorization: Bearer {$flow['token']}\r\n",
    'content' => json_encode(['input' => $input]),
    'timeout' => 180,
    'ignore_errors' => true,
]]);
$raw = @file_get_contents("{$cfg['base']}/hooks/workflows/{$flow['id']}/run", false, $ctx);
if ($raw === false) { error_log('[workflow] ' . $_GET['workflow'] . ": could not reach {$cfg['base']}"); }
if ($raw === false) reply(502, ['status' => 'failed', 'error' => "Could not reach Jr Architect at {$cfg['base']}"]);

preg_match('{HTTP/\S+ (\d{3})}', $http_response_header[0] ?? '', $m);
$code = (int)($m[1] ?? 502);
$run = json_decode($raw, true) ?: [];
error_log('[workflow] ' . $_GET['workflow'] . ' -> ' . ($run['status'] ?? $code) . ' in ' . round((microtime(true) - $started) * 1000) . 'ms' . (!empty($run['error']) ? ': ' . $run['error'] : ''));
reply($code < 300 ? 200 : $code, ['status' => $run['status'] ?? 'failed', 'output' => $run['output'] ?? null, 'error' => $run['error'] ?? null]);
