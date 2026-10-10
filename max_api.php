<?php
declare(strict_types=1);

/** Fixed MAX proxy: data and account-scoped actions for verified MAX chats. */
header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store');

const MAX_API_SIDECAR_BASE = 'http://127.0.0.1:8091';

function max_api_json(array $payload, int $status = 200): never
{
    http_response_code($status);
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function max_api_forward(string $method, string $path, ?array $payload = null): never
{
    $curl = curl_init(MAX_API_SIDECAR_BASE . $path);
    if ($curl === false) max_api_json(['success' => false, 'message' => 'Служба MAX недоступна.'], 502);
    $options = [CURLOPT_CUSTOMREQUEST => $method, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 15, CURLOPT_HTTPHEADER => ['Accept: application/json']];
    if ($payload !== null) {
        $json = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if (!is_string($json)) max_api_json(['success' => false, 'message' => 'Некорректный запрос MAX.'], 400);
        $options[CURLOPT_POSTFIELDS] = $json;
        $options[CURLOPT_HTTPHEADER] = ['Accept: application/json', 'Content-Type: application/json'];
    }
    curl_setopt_array($curl, $options);
    $body = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    if (!is_string($body)) max_api_json(['success' => false, 'message' => 'Служба MAX не ответила.'], 502);
    $decoded = json_decode($body, true);
    if (!is_array($decoded)) max_api_json(['success' => false, 'message' => 'Служба MAX вернула некорректный ответ.'], 502);
    max_api_json($decoded, $status >= 100 ? $status : 502);
}

$method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
function max_api_chat_id(mixed $value): ?string
{
    $chatId = is_string($value) ? trim($value) : '';
    return preg_match('/^-?(?:0|[1-9][0-9]{0,19})$/D', $chatId) ? $chatId : null;
}
if ($method === 'POST' && in_array((string)($_POST['resource'] ?? ''), ['attachment', 'attachments'], true)) {
    $batch = (string)($_POST['resource'] ?? '') === 'attachments';
    $files = $batch ? ($_FILES['files'] ?? null) : ($_FILES['file'] ?? null);
    $replyTo = $_POST['reply_to'] ?? null;
    $normalised = [];
    if ($batch && is_array($files) && is_array($files['name'] ?? null)) {
        foreach (array_keys($files['name']) as $index) $normalised[] = ['name'=>$files['name'][$index] ?? '', 'type'=>$files['type'][$index] ?? '', 'tmp_name'=>$files['tmp_name'][$index] ?? '', 'error'=>$files['error'][$index] ?? UPLOAD_ERR_NO_FILE, 'size'=>$files['size'][$index] ?? 0];
    } elseif (!$batch && is_array($files)) {
        $normalised[] = $files;
    }
    if (count($normalised) < 1 || count($normalised) > 10 || !is_string($replyTo) && $replyTo !== null || is_string($replyTo) && !preg_match('/^[1-9][0-9]{0,19}$/', $replyTo)) max_api_json(['success' => false, 'message' => 'Некорректное вложение MAX.'], 422);
    $total = 0;
    foreach ($normalised as $file) {
        if (($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK || !is_uploaded_file((string)($file['tmp_name'] ?? '')) || (int)($file['size'] ?? 0) < 1 || (int)($file['size'] ?? 0) > 10 * 1024 * 1024) max_api_json(['success' => false, 'message' => 'Некорректное вложение MAX.'], 422);
        $total += (int)$file['size'];
    }
    if ($total > 20 * 1024 * 1024) max_api_json(['success' => false, 'message' => 'Пачка MAX превышает 20 МБ.'], 422);
    $chatId = max_api_chat_id($_POST['chat_id'] ?? null);
    if ($chatId === null) max_api_json(['success' => false, 'message' => 'Некорректный идентификатор диалога MAX.'], 422);
    $curl = curl_init(MAX_API_SIDECAR_BASE . ($batch ? '/v1/messages/attachments' : '/v1/messages/attachment'));
    if ($curl === false) max_api_json(['success' => false, 'message' => 'Служба MAX недоступна.'], 502);
    $payload = ['chat_id' => $chatId, 'caption' => (string)($_POST['caption'] ?? '')];
    if ((string)($_POST['send_as_file'] ?? '') === '1') $payload['send_as_file'] = '1';
    foreach ($normalised as $index => $file) $payload[$batch ? "files[{$index}]" : 'file'] = new CURLFile((string)$file['tmp_name'], (string)($file['type'] ?? 'application/octet-stream'), basename((string)$file['name']));
    if (is_string($replyTo) && $replyTo !== '') $payload['reply_to'] = $replyTo;
    curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $payload, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 60, CURLOPT_HTTPHEADER => ['Accept: application/json']]);
    $body = curl_exec($curl); $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE); curl_close($curl);
    if (!is_string($body) || !is_array($decoded = json_decode($body, true))) max_api_json(['success' => false, 'message' => 'MAX не ответил на вложение.'], 502);
    max_api_json($decoded, $status >= 100 ? $status : 502);
}
if ($method === 'POST') {
    $input = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($input)) max_api_json(['success' => false, 'message' => 'Действие MAX не поддерживается.'], 405);
    if (($input['resource'] ?? '') === 'read') {
        $chatId = max_api_chat_id($input['chat_id'] ?? null);
        if ($chatId === null) max_api_json(['success' => false, 'message' => 'Некорректный идентификатор диалога MAX.'], 422);
        max_api_forward('POST', '/v1/chats/' . rawurlencode($chatId) . '/read', []);
    }
    if (($input['resource'] ?? '') === 'send') {
        $text = $input['text'] ?? null;
        if (!is_string($text) || $text === '' || mb_strlen($text) > 4000) max_api_json(['success' => false, 'message' => 'Текст MAX имеет неверный формат.'], 422);
        $replyTo = $input['reply_to'] ?? null;
        if ($replyTo !== null && (!is_string($replyTo) || !preg_match('/^[1-9][0-9]{0,19}$/', $replyTo))) max_api_json(['success' => false, 'message' => 'Некорректная цитата MAX.'], 422);
        $chatId = max_api_chat_id($input['chat_id'] ?? null);
        if ($chatId === null) max_api_json(['success' => false, 'message' => 'Некорректный идентификатор диалога MAX.'], 422);
        $payload = ['chat_id' => $chatId, 'text' => $text];
        if ($replyTo !== null) $payload['reply_to'] = $replyTo;
        max_api_forward('POST', '/v1/messages/send', $payload);
    }
    if (($input['resource'] ?? '') === 'reaction') {
        $messageId = $input['message_id'] ?? null;
        $reaction = $input['reaction'] ?? null;
        if (!is_string($messageId) || !preg_match('/^[1-9][0-9]{0,19}$/', $messageId) || !is_string($reaction)) {
            max_api_json(['success' => false, 'message' => 'Некорректная реакция MAX.'], 422);
        }
        $chatId = max_api_chat_id($input['chat_id'] ?? null);
        if ($chatId === null) max_api_json(['success' => false, 'message' => 'Некорректный идентификатор диалога MAX.'], 422);
        max_api_forward('POST', '/v1/messages/reaction', ['chat_id' => $chatId, 'message_id' => $messageId, 'reaction' => $reaction]);
    }
    max_api_json(['success' => false, 'message' => 'Действие MAX не поддерживается.'], 405);
}
if (!in_array($method, ['GET', 'HEAD'], true)) max_api_json(['success' => false, 'message' => 'Метод MAX не поддерживается.'], 405);
$resource = (string)($_GET['resource'] ?? '');
if ($resource === 'media') {
    $ref = (string)($_GET['ref'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_-]{20,128}$/', $ref)) { http_response_code(404); exit; }
    $range = trim((string)($_SERVER['HTTP_RANGE'] ?? ''));
    if ($range !== '' && !preg_match('~^bytes=(?:\d+-\d*|-\d+)$~', $range)) { http_response_code(416); exit; }
    $curl = curl_init(MAX_API_SIDECAR_BASE . '/v1/media/' . rawurlencode($ref));
    if ($curl === false) { http_response_code(502); exit; }
    $headers = ['Accept: */*']; if ($range !== '') $headers[] = 'Range: ' . $range;
    $status = 0; $contentType = 'application/octet-stream'; $contentLength = null; $contentRange = null; $acceptRanges = null; $emitted = false;
    $captureHeaders = static function ($ch, string $line) use (&$status, &$contentType, &$contentLength, &$contentRange, &$acceptRanges): int {
        $trimmed = trim($line);
        if (preg_match('~^HTTP/\\S+\\s+(\\d+)~', $trimmed, $match)) {
            $status = (int)$match[1]; $contentType = 'application/octet-stream'; $contentLength = null; $contentRange = null; $acceptRanges = null;
        } elseif (stripos($line, 'Content-Type:') === 0) {
            $value = trim(substr($line, strlen('Content-Type:')));
            if (preg_match('#^[A-Za-z0-9.+-]+/[A-Za-z0-9.+-]+(?:;[^\\r\\n]*)?$#', $value)) $contentType = $value;
        } elseif (stripos($line, 'Content-Length:') === 0) {
            $value = trim(substr($line, strlen('Content-Length:')));
            if (preg_match('/^[0-9]+$/', $value)) $contentLength = $value;
        } elseif (stripos($line, 'Content-Range:') === 0) {
            $value = trim(substr($line, strlen('Content-Range:')));
            if (preg_match('~^bytes (?:\\d+-\\d+|\\*)/(?:\\d+|\\*)$~', $value)) $contentRange = $value;
        } elseif (stripos($line, 'Accept-Ranges:') === 0) {
            if (strtolower(trim(substr($line, strlen('Accept-Ranges:')))) === 'bytes') $acceptRanges = 'bytes';
        }
        return strlen($line);
    };
    $emitHeaders = static function () use (&$status, &$contentType, &$contentLength, &$contentRange, &$acceptRanges): void {
        $code = $status ?: 502;
        http_response_code($code);
        header('Content-Type: ' . $contentType);
        header('Cache-Control: private, max-age=900'); header('X-Content-Type-Options: nosniff');
        // A 416 response has no body. Do not forward a non-zero upstream length.
        if ($code !== 416 && $contentLength !== null) header('Content-Length: ' . $contentLength);
        if ($contentRange !== null) header('Content-Range: ' . $contentRange);
        if ($acceptRanges !== null) header('Accept-Ranges: ' . $acceptRanges);
    };
    curl_setopt_array($curl, [CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 180, CURLOPT_CUSTOMREQUEST => $method, CURLOPT_NOBODY => $method === 'HEAD', CURLOPT_HTTPHEADER => $headers, CURLOPT_HEADERFUNCTION => $captureHeaders, CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$status, &$emitted, $emitHeaders): int {
        if ($status !== 200 && $status !== 206) return 0;
        if (!$emitted) { $emitHeaders(); $emitted = true; }
        echo $chunk;
        if (function_exists('ob_flush')) @ob_flush();
        flush();
        return strlen($chunk);
    }]);
    $ok = curl_exec($curl); $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE) ?: $status; curl_close($curl);
    if (!$emitted && in_array($status, [200, 206, 416], true)) { $emitHeaders(); $emitted = true; }
    if (!$emitted || (!$ok && $status !== 416)) { if (!headers_sent()) http_response_code($status ?: 502); }
    exit;
}
if ($resource === 'media_ref') {
    $chatId = max_api_chat_id($_GET['chat_id'] ?? null);
    $messageId = (string)($_GET['message_id'] ?? '');
    $accountId = (string)($_GET['account_id'] ?? '');
    $index = (string)($_GET['index'] ?? '');
    if ($chatId === null || !preg_match('/^[1-9][0-9]{0,19}$/D', $messageId)
        || !preg_match('/^[1-9][0-9]{0,19}$/D', $accountId)
        || !preg_match('/^[0-9]{1,2}$/D', $index)) {
        max_api_json(['success' => false, 'code' => 'max_media_ref_invalid', 'message' => 'Некорректное вложение MAX.'], 422);
    }
    max_api_forward('GET', '/v1/media-ref?' . http_build_query([
        'chat_id' => $chatId,
        'message_id' => $messageId,
        'account_id' => $accountId,
        'index' => $index,
    ]));
}
if ($resource === 'profile') max_api_forward('GET', '/v1/profile');
if ($resource === 'contact_profile') {
    $chatId = (string)($_GET['chat_id'] ?? '');
    if (!preg_match('/^-?[0-9]{1,20}$/', $chatId)) max_api_json(['success' => false, 'message' => 'Некорректный идентификатор диалога MAX.'], 422);
    max_api_forward('GET', '/v1/chats/' . rawurlencode($chatId) . '/profile');
}
if ($resource === 'user_profile') {
    $userId = (string)($_GET['user_id'] ?? '');
    if (!preg_match('/^[1-9][0-9]{0,19}$/D', $userId)) max_api_json(['success' => false, 'message' => 'Некорректный идентификатор пользователя MAX.'], 422);
    max_api_forward('GET', '/v1/users/' . rawurlencode($userId) . '/profile');
}
if ($resource === 'chats') {
    $limit = filter_input(INPUT_GET, 'limit', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 50]]);
    $query = ['limit' => $limit ?: 50];
    $cursor = $_GET['cursor'] ?? null;
    if ($cursor !== null) {
        if (!is_string($cursor) || !preg_match('/^[1-9][0-9]{0,18}$/D', $cursor)) max_api_json(['success' => false, 'message' => 'Некорректный курсор MAX.'], 422);
        $query['cursor'] = $cursor;
    }
    max_api_forward('GET', '/v1/chats?' . http_build_query($query));
}
if ($resource === 'history') {
    $chatId = (string)($_GET['chat_id'] ?? '');
    if (!preg_match('/^-?[0-9]{1,20}$/', $chatId)) max_api_json(['success' => false, 'message' => 'Некорректный идентификатор диалога MAX.'], 422);
    $query = [];
    $limit = filter_input(INPUT_GET, 'limit', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 50]]);
    if ($limit) $query['limit'] = $limit;
    $before = (string)($_GET['before'] ?? '');
    if ($before !== '') {
        if (!preg_match('/^[0-9]{1,16}$/', $before)) max_api_json(['success' => false, 'message' => 'Некорректная граница истории MAX.'], 422);
        $query['before'] = $before;
    }
    max_api_forward('GET', '/v1/chats/' . rawurlencode($chatId) . '/history' . ($query ? '?' . http_build_query($query) : ''));
}
if ($resource === 'events') {
    $after = (string)($_GET['after'] ?? '0');
    if (!preg_match('/^[0-9]{1,20}$/', $after)) max_api_json(['success' => false, 'message' => 'Некорректный курсор событий MAX.'], 422);
    max_api_forward('GET', '/v1/events?after=' . rawurlencode($after));
}
if ($resource === 'reactions') {
    $chatId = max_api_chat_id($_GET['chat_id'] ?? null);
    $messageId = (string)($_GET['message_id'] ?? '');
    if ($chatId === null || !preg_match('/^[1-9][0-9]{0,19}$/', $messageId)) max_api_json(['success' => false, 'message' => 'Некорректный идентификатор сообщения MAX.'], 422);
    max_api_forward('GET', '/v1/messages/reactions?' . http_build_query(['chat_id' => $chatId, 'message_id' => $messageId]));
}
max_api_json(['success' => false, 'message' => 'Ресурс MAX не поддерживается.'], 404);
