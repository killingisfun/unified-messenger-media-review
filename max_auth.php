<?php
declare(strict_types=1);

/**
 * Fixed local proxy for the MAX sidecar.  MAX's personal-account session is
 * never available to PHP or the browser; this endpoint returns only the
 * compact UI state and a locally rendered QR image.
 */

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const MAX_SIDECAR_BASE = 'http://127.0.0.1:8091';

function max_json(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function max_forward(string $method, string $path, ?array $payload = null): never
{
    $url = MAX_SIDECAR_BASE . $path;
    $curl = curl_init($url);
    if ($curl === false) max_json(['success' => false, 'message' => 'Служба MAX недоступна.'], 502);
    $headers = ['Accept: application/json'];
    $options = [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 3,
        CURLOPT_TIMEOUT => 12,
        CURLOPT_HTTPHEADER => $headers,
    ];
    if ($payload !== null) {
        $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($body)) max_json(['success' => false, 'message' => 'Некорректный запрос MAX.'], 400);
        $options[CURLOPT_POSTFIELDS] = $body;
        $options[CURLOPT_HTTPHEADER] = [...$headers, 'Content-Type: application/json'];
    }
    curl_setopt_array($curl, $options);
    $body = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    if (!is_string($body)) max_json(['success' => false, 'message' => 'Служба MAX не ответила.'], 502);
    $decoded = json_decode($body, true);
    if (!is_array($decoded)) max_json(['success' => false, 'message' => 'Служба MAX вернула некорректный ответ.'], 502);
    max_json($decoded, $status >= 100 ? $status : 502);
}

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
if ($method === 'GET') max_forward('GET', '/v1/status');
if ($method !== 'POST') max_json(['success' => false, 'message' => 'Метод не поддерживается.'], 405);

$raw = file_get_contents('php://input');
if (!is_string($raw) || $raw === '' || strlen($raw) > 8192) max_json(['success' => false, 'message' => 'Некорректный запрос MAX.'], 400);
$input = json_decode($raw, true);
if (!is_array($input)) max_json(['success' => false, 'message' => 'Ожидается JSON-запрос.'], 400);
$action = (string)($input['action'] ?? '');
if ($action === 'start') max_forward('POST', '/v1/auth/start', []);
if ($action === 'logout') max_forward('POST', '/v1/auth/logout', []);
if ($action === 'password') {
    $password = $input['password'] ?? null;
    if (!is_string($password) || $password === '' || strlen($password) > 512) {
        max_json(['success' => false, 'message' => 'Пароль имеет неверный формат.'], 422);
    }
    max_forward('POST', '/v1/auth/password', ['password' => $password]);
}
max_json(['success' => false, 'message' => 'Действие MAX не поддерживается.'], 405);
