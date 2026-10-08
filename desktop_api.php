<?php
declare(strict_types=1);

use App\Database;
use App\Services\DesktopDeviceAccess;

require_once __DIR__ . '/vendor/autoload.php';
require_once __DIR__ . '/config.php';

// This facade can stream provider media. Preserve PHP diagnostics in logs but
// never inject an HTML warning before binary response bytes.
ini_set('display_errors', '0');
ini_set('log_errors', '1');
header('Cache-Control: no-store');

function desktop_api_error(int $status, string $message): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(['success' => false, 'message' => $message], JSON_UNESCAPED_UNICODE);
    exit;
}

function desktop_api_authorization_header(): ?string
{
    $header = $_SERVER['HTTP_AUTHORIZATION'] ?? $_SERVER['REDIRECT_HTTP_AUTHORIZATION'] ?? null;
    if (is_string($header) && $header !== '') return $header;
    if (function_exists('getallheaders')) {
        foreach (getallheaders() as $name => $value) {
            if (strcasecmp((string)$name, 'Authorization') === 0) return (string)$value;
        }
    }
    return null;
}

$action = trim((string)($_GET['desktop_action'] ?? $_POST['action'] ?? $_GET['action'] ?? ''));
$allowedActions = [
    'clear_provider_cache', 'save_provider_settings', 'get_provider_capabilities', 'get_whatsapp_self_avatar',
    'get_provider_self_profile', 'get_reaction_actor_avatar', 'get_message_reactions',
    'wa_get_preview', 'wa_get_media', 'get_chat_details', 'get_contact_profile',
    'send_telegram_comment', 'get_telegram_discussion', 'get_message_sender_profile', 'get_chats_json',
    'get_send_job', 'send_message_batch', 'get_infrastructure_health', 'get_unread_count', 'get_chats_meta',
    'send_message', 'send_reaction', 'retry_vk_request', 'get_messages_json',
    'get_new_messages', 'get_whatsapp_status', 'get_updated_chats', 'get_local_messages',
    'mark_chat_read', 'send_message_by_target', 'send_message_by_phone', 'delete_chat_universal',
    'clear_whatsapp_data', 'stream_external_media', 'telegram_media', 'provider_route',
    'stream_avatar', 'max_media',
];
if ($action === '' || !in_array($action, $allowedActions, true)) {
    desktop_api_error(403, 'This desktop API operation is not allowed.');
}

try {
    $device = DesktopDeviceAccess::authenticateBearer(Database::getInstance(), desktop_api_authorization_header());
} catch (Throwable $exception) {
    desktop_api_error(401, 'Device authorization is required.');
}

// index.php stays bound to loopback. This authenticated facade is the only
// entry point that a reverse proxy may expose to desktop devices.
$_SERVER['UNIFIED_DESKTOP_DEVICE_ID'] = $device['id'];
if ($action === 'stream_external_media') {
    // `desktop_action` selected the facade operation and is not part of the
    // legacy media relay's query contract.
    unset($_GET['desktop_action']);
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if (!in_array($method, ['GET', 'HEAD'], true)) {
        desktop_api_error(405, 'External media method is not allowed.');
    }
    $url = trim((string)($_GET['u'] ?? ''));
    $parts = @parse_url($url);
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    $host = strtolower((string)($parts['host'] ?? ''));
    $port = isset($parts['port']) ? (int)$parts['port'] : null;
    $allowedHost = static function (array $suffixes) use ($host): bool {
        foreach ($suffixes as $suffix) {
            if ($host === $suffix || str_ends_with($host, '.' . $suffix)) return true;
        }
        return false;
    };
    $allowedExternal = is_array($parts) && $url !== '' && strlen($url) <= 8192
        && in_array($scheme, ['http', 'https'], true)
        && empty($parts['user']) && empty($parts['pass'])
        && ($port === null || ($scheme === 'http' && $port === 80) || ($scheme === 'https' && $port === 443))
        && preg_match('/^[a-z0-9.-]+$/', $host)
        && ($allowedHost(['vk.com', 'vkuseraudio.net', 'userapi.com', 'vkuser.net', 'vk-cdn.net'])
            || $allowedHost(['avito.ru', 'avito.st', 'avito.net']));
    $allowedFields = ['u' => true, 'download' => true, 'dl' => true, 'view' => true, 'name' => true, 'fn' => true, '_r' => true];
    foreach ($_GET as $key => $value) {
        if (!isset($allowedFields[$key]) || !is_string($value)) desktop_api_error(403, 'External media parameters are not allowed.');
        if (in_array($key, ['download', 'dl', 'view'], true) && !in_array($value, ['0', '1'], true)) desktop_api_error(403, 'External media parameters are not allowed.');
        if (in_array($key, ['name', 'fn'], true) && (strlen($value) === 0 || strlen($value) > 255 || str_contains($value, "\0"))) desktop_api_error(403, 'External media parameters are not allowed.');
        if ($key === '_r' && !preg_match('/^[0-9]{1,20}$/D', $value)) desktop_api_error(403, 'External media parameters are not allowed.');
    }
    if (!$allowedExternal) desktop_api_error(403, 'External media URL is not allowed.');
    unset($_GET['action'], $_POST['action']);
    require __DIR__ . '/media_stream.php';
    exit;
}
if ($action === 'telegram_media') {
    $telegramAction = trim((string)($_GET['telegram_action'] ?? ''));
    if (!in_array($telegramAction, ['downloadMedia', 'downloadThumb'], true)) {
        desktop_api_error(403, 'Telegram media operation is not allowed.');
    }
    $_GET['action'] = $telegramAction;
    require __DIR__ . '/telegram_service/rest.php';
    exit;
}
if ($action === 'stream_avatar') {
    $avatarPath = (string)($_GET['avatar_path'] ?? '');
    $prefix = '/uploads/avatar/';
    $relative = str_starts_with($avatarPath, $prefix) ? substr($avatarPath, strlen($prefix)) : '';
    if ($relative === '' || str_contains($relative, '/') || !preg_match('/^[A-Za-z0-9_-]+\.(?:jpe?g|png|webp|gif)$/i', $relative)) {
        desktop_api_error(403, 'Avatar path is not allowed.');
    }
    $file = __DIR__ . '/uploads/avatar/' . $relative;
    if (!is_file($file)) desktop_api_error(404, 'Avatar was not found.');
    $mime = function_exists('mime_content_type') ? mime_content_type($file) : false;
    if (!is_string($mime) || !str_starts_with($mime, 'image/')) $mime = 'application/octet-stream';
    header('Content-Type: ' . $mime);
    header('Content-Length: ' . (string)filesize($file));
    header('X-Content-Type-Options: nosniff');
    readfile($file);
    exit;
}
if ($action === 'max_media') {
    if (!in_array(strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')), ['GET', 'HEAD'], true)) {
        desktop_api_error(405, 'MAX media method is not allowed.');
    }
    $ref = (string)($_GET['ref'] ?? '');
    if (!preg_match('/^[A-Za-z0-9_-]{20,128}$/D', $ref)) {
        desktop_api_error(404, 'MAX media was not found.');
    }
    // Keep MAX's own Range, status and MIME validation in one place. The
    // desktop facade only authorizes this opaque, account-scoped media ref.
    $_GET = ['resource' => 'media', 'ref' => $ref];
    require __DIR__ . '/max_api.php';
    exit;
}
if ($action === 'provider_route') {
    $route = trim((string)($_GET['route'] ?? ''));
    $routes = [
        'ai_api.php', 'telegram_auth.php', 'max_auth.php', 'wpp_status.php', 'wpp_link_code.php', 'wpp_proxy.php', 'provider_logout.php',
    ];
    if (!in_array($route, $routes, true)) desktop_api_error(403, 'Provider route is not allowed.');
    if ($route === 'wpp_proxy.php' && trim((string)($_GET['action'] ?? '')) !== 'logout') {
        desktop_api_error(403, 'Only explicit WhatsApp logout is allowed through this route.');
    }
    require __DIR__ . '/' . $route;
    exit;
}
unset($_GET['desktop_action']);
// The facade-selected allowlisted action must be the one executed by
// index.php. In particular, do not let an unrelated form field choose a
// different internal action after this authorization check.
$_GET['action'] = $action;
$_POST['action'] = $action;
$_REQUEST['action'] = $action;
require __DIR__ . '/index.php';
