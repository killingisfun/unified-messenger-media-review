<?php
/**
 * Local cached-data inspection mode for the current UI.
 *
 * Run with:
 *   php -S 127.0.0.1:18083 live-readonly-router.php
 *
 * By default this router reads only the chats/messages cache exposed by the
 * existing local server on port 18080. It blocks writes, media routes,
 * authentication, sync, and every unlisted PHP route.
 *
 * When the PHP process has UNIFIED_LEGACY_HISTORY=1, the router additionally
 * permits the legacy read-history endpoint for a chat already present in the
 * local list. It is used only by the dedicated integration server on 18084.
 *
 * `legacy-bridge-router.php` starts the same code in active mode. That mode
 * retains the narrow allowlist, but forwards the normal in-chat actions to
 * the existing server after checking source, chat_id and chat_db_id together.
 */

declare(strict_types=1);
require_once __DIR__ . '/src/UploadRequestGuard.php';
guard_upload_request();


function live_bridge_mode(): string
{
    return getenv('UNIFIED_LEGACY_BRIDGE_MODE') === 'active' ? 'active' : 'readonly';
}

function live_is_active_bridge(): bool
{
    return live_bridge_mode() === 'active';
}

/**
 * The optional media worker is deliberately opt-in. The normal bridge keeps
 * its established same-origin URLs unless both local PHP processes are
 * started with UNIFIED_LEGACY_MEDIA_WORKER=1.  A configured local worker
 * pool lets several PHP built-in-server processes fetch independent media
 * objects at once, while the UI bridge remains responsive.
 */
function live_is_media_worker(): bool
{
    return getenv('UNIFIED_LEGACY_MEDIA_WORKER_ROLE') === 'media';
}

/**
 * A history worker is intentionally separate from media workers. One chat
 * only requests one older-history page at a time, so a dedicated process is
 * enough to keep pagination out of the UI/API php -S queue.
 */
function live_is_history_worker(): bool
{
    return getenv('UNIFIED_LEGACY_HISTORY_WORKER_ROLE') === 'history';
}

/**
 * The main bridge may opt into one exact local history worker. Do not accept
 * an arbitrary URL from an environment typo: only a numeric loopback port is
 * valid. The history worker itself must not route recursively to itself.
 */
function live_history_worker_origin(): string
{
    if (!live_is_active_bridge() || live_is_history_worker()
        || getenv('UNIFIED_LEGACY_HISTORY_WORKER') !== '1') return '';
    $port = trim((string)getenv('UNIFIED_LEGACY_HISTORY_WORKER_PORT'));
    if ($port === '') $port = '18091';
    if (!ctype_digit($port)) return '';
    $number = (int)$port;
    if ($number < 1 || $number > 65535) return '';
    return 'http://127.0.0.1:' . $number;
}

function live_history_worker_url(): string
{
    $origin = live_history_worker_origin();
    return $origin === '' ? '' : $origin . '/bridge-history';
}

function live_history_worker_request_origin_allowed(): bool
{
    return trim((string)($_SERVER['HTTP_ORIGIN'] ?? '')) === 'http://127.0.0.1:18085';
}

function live_history_worker_apply_cors(): void
{
    if (!live_is_history_worker() || !live_history_worker_request_origin_allowed()) return;
    header('Access-Control-Allow-Origin: http://127.0.0.1:18085');
    header('Access-Control-Allow-Credentials: true');
    header('Access-Control-Expose-Headers: Content-Type, Content-Length');
    header('Vary: Origin');
}

function live_history_worker_preflight(): never
{
    if (!live_history_worker_request_origin_allowed()) {
        live_json(['success' => false, 'message' => 'История доступна только локальному интерфейсу.'], 403);
    }
    live_history_worker_apply_cors();
    header('Access-Control-Allow-Methods: GET, OPTIONS');
    header('Access-Control-Allow-Headers: Accept, X-Unified-Bridge-Token');
    header('Access-Control-Max-Age: 600');
    http_response_code(204);
    exit;
}

/**
 * A media URL always contains only an opaque reference. With the dedicated
 * pool enabled, new links point directly at the selected local worker so
 * they do not wait in the one-process UI bridge. Older relative links remain
 * valid and receive a local redirect for backwards compatibility.
 *
 * `UNIFIED_LEGACY_MEDIA_WORKERS` is an optional comma-separated list of local
 * ports, for example `18087,18089,18090`.  We deliberately accept ports
 * rather than arbitrary origins: a local configuration error must never turn
 * an opaque, session-bound media URL into a route to a remote host.
 * Without that variable the established single worker on 18087 is retained.
 *
 * @return list<string>
 */
function live_media_worker_origins(): array
{
    if (!live_is_active_bridge() || live_is_media_worker()
        || getenv('UNIFIED_LEGACY_MEDIA_WORKER') !== '1') return [];

    $configured = trim((string)getenv('UNIFIED_LEGACY_MEDIA_WORKERS'));
    $rawPorts = $configured === '' ? ['18087'] : explode(',', $configured);
    $origins = [];
    foreach ($rawPorts as $rawPort) {
        $port = trim($rawPort);
        if (!ctype_digit($port)) continue;
        $number = (int)$port;
        if ($number < 1 || $number > 65535) continue;
        $origin = 'http://127.0.0.1:' . $number;
        if (!in_array($origin, $origins, true)) $origins[] = $origin;
    }

    // A malformed optional pool must leave the known working single-worker
    // setup intact rather than making every media attachment unavailable.
    return $origins !== [] ? $origins : ['http://127.0.0.1:18087'];
}

/**
 * Kept for the callers which only need to know whether a worker exists.
 * Per-reference routing is intentionally done by
 * live_media_worker_origin_for_ref(), below.
 */
function live_media_worker_origin(): string
{
    return live_media_worker_origins()[0] ?? '';
}

/**
 * Hash only the opaque reference, never provider or chat data.  Thus a media
 * URL always returns to the same worker during its lifetime, which keeps
 * browser retry/range behavior stable and spreads independent attachments
 * across the configured local PHP workers.
 */
function live_media_worker_origin_for_ref(string $ref): string
{
    $origins = live_media_worker_origins();
    if ($origins === [] || !preg_match('/^[a-f0-9]{48}$/D', $ref)) return '';
    if (count($origins) === 1) return $origins[0];

    // Eight hexadecimal characters safely fit in PHP's integer range on the
    // supported 64-bit Windows build.  The modulo maps the ref deterministically.
    $bucket = (int)hexdec(substr($ref, 0, 8));
    return $origins[$bucket % count($origins)];
}

/**
 * All browser media elements may carry the page's Origin header, while
 * top-level downloads generally do not. A redirect changes the port and
 * therefore the origin, so the worker has to accept only these two cases.
 */
function live_media_worker_request_origin_allowed(): bool
{
    $origin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    return $origin === '' || $origin === 'http://127.0.0.1:18085';
}

/** @param array<string,mixed> $query */
function live_media_worker_redirect_url(string $path, array $query): string
{
    if ($path !== '/bridge-media') return '';
    $id = live_media_scalar($query['ref'] ?? '', 96);
    if (!preg_match('/^[a-f0-9]{48}$/D', $id)) return '';
    $origin = live_media_worker_origin_for_ref($id);
    if ($origin === '') return '';
    $forward = ['ref' => $id];
    if ((string)($query['dl'] ?? '') === '1') $forward['dl'] = '1';
    if ((string)($query['info'] ?? '') === '1') $forward['info'] = '1';
    return $origin . $path . '?' . http_build_query($forward, '', '&', PHP_QUERY_RFC3986);
}

function live_delegate_media_request(string $path): void
{
    $location = live_media_worker_redirect_url($path, $_GET);
    if ($location === '') return;
    // 307 preserves GET/HEAD and the browser's Range request. The worker
    // reads the same host-only PHP session cookie and validates the opaque ref.
    header('Cache-Control: no-store');
    header('Location: ' . $location, true, 307);
    exit;
}

function live_media_worker_apply_cors(): void
{
    if (!live_is_media_worker()) return;
    // A port is a distinct browser origin. Only the canonical local UI may
    // read a worker response (needed by the browser-side ZIP builder).
    $origin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    if ($origin !== 'http://127.0.0.1:18085') return;
    header('Access-Control-Allow-Origin: http://127.0.0.1:18085');
    header('Access-Control-Allow-Credentials: true');
    header('Access-Control-Expose-Headers: Content-Type, Content-Length, Content-Range, Content-Disposition, Accept-Ranges');
    header('Vary: Origin');
}

function live_media_worker_preflight(): never
{
    $origin = trim((string)($_SERVER['HTTP_ORIGIN'] ?? ''));
    if ($origin !== 'http://127.0.0.1:18085') {
        live_json(['success' => false, 'message' => 'Медиа-маршрут доступен только локальному интерфейсу.'], 403);
    }
    live_media_worker_apply_cors();
    header('Access-Control-Allow-Methods: GET, HEAD, OPTIONS');
    header('Access-Control-Allow-Headers: Accept, Range');
    header('Access-Control-Max-Age: 600');
    http_response_code(204);
    exit;
}

function live_bridge_token(): string
{
    if (!live_is_active_bridge()) return '';
    if (session_status() !== PHP_SESSION_ACTIVE) {
        $sessionDir = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'unified-messenger-bridge-sessions';
        if (!is_dir($sessionDir)) @mkdir($sessionDir, 0700, true);
        if (is_dir($sessionDir) && is_writable($sessionDir)) session_save_path($sessionDir);
        session_set_cookie_params([
            'httponly' => true,
            'samesite' => 'Strict',
        ]);
        session_start();
    }
    if (empty($_SESSION['unified_bridge_token'])) {
        $_SESSION['unified_bridge_token'] = bin2hex(random_bytes(32));
    }
    return (string)$_SESSION['unified_bridge_token'];
}

function live_valid_bridge_token(): bool
{
    $expected = live_bridge_token();
    $provided = trim((string)($_SERVER['HTTP_X_UNIFIED_BRIDGE_TOKEN'] ?? ''));
    return $expected !== '' && $provided !== '' && hash_equals($expected, $provided);
}

function live_allows_legacy_history(): bool
{
    return live_is_active_bridge() || getenv('UNIFIED_LEGACY_HISTORY') === '1';
}

function live_json(array $payload, int $status = 200): never
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store');
    echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    exit;
}

function live_apply_csp(): void
{
    $connect = "'self'";
    $images = "'self' data: blob:";
    $media = "'self' blob:";
    $realtime = trim((string)getenv('UNIFIED_REALTIME_URL'));
    if (live_is_active_bridge() && preg_match('~^wss?://127\\.0\\.0\\.1:18081$~i', $realtime)) {
        $connect .= ' ' . $realtime;
    }
    $historyWorker = live_history_worker_origin();
    if ($historyWorker !== '') $connect .= ' ' . $historyWorker;
    foreach (live_media_worker_origins() as $mediaWorker) {
        $connect .= ' ' . $mediaWorker;
        $images .= ' ' . $mediaWorker;
        $media .= ' ' . $mediaWorker;
    }
    header("Content-Security-Policy: default-src 'self'; connect-src {$connect}; img-src {$images}; media-src {$media}; object-src 'none'; base-uri 'self'; form-action 'self'; style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://cdnjs.cloudflare.com; font-src 'self' data: https://cdn.jsdelivr.net https://cdnjs.cloudflare.com");
}

/**
 * The only bridge to port 18080. Callers supply a fixed local cache action,
 * never a provider-specific endpoint or an arbitrary URL.
 *
 * @return array<string,mixed>|null
 */
function live_cached_json(string $action, array $params = []): ?array
{
    $allowed = ['get_chats_json', 'get_local_messages', 'get_infrastructure_health'];
    if (live_allows_legacy_history()) $allowed[] = 'get_messages_json';
    if (live_is_active_bridge()) {
        $allowed = array_merge($allowed, [
            'get_chat_details', 'get_new_messages', 'get_send_job', 'get_message_reactions', 'get_whatsapp_self_avatar',
            'get_provider_self_profile', 'get_reaction_actor_avatar', 'get_message_sender_profile', 'get_telegram_discussion',
        ]);
    }
    if (!in_array($action, $allowed, true)) return null;

    $query = array_merge(['action' => $action], $params);
    $url = 'http://127.0.0.1:18080/index.php?' . http_build_query($query);
    $timeout = $action === 'get_telegram_discussion' ? 20 : 15;
    $context = stream_context_create(['http' => [
        'method' => 'GET',
        'timeout' => $timeout,
        'ignore_errors' => true,
        'header' => "Accept: application/json\r\n",
    ]]);
    $body = @file_get_contents($url, false, $context);
    if (!is_string($body) || $body === '') return null;
    $decoded = json_decode($body, true);
    return is_array($decoded) ? $decoded : null;
}

/** @param array<string,mixed> $chat */
function live_contact_profile_cache_key(array $chat): string
{
    return hash('sha256', "contact-profile-v3\0" . (string)(int)($chat['id'] ?? 0) . "\0"
        . strtolower(live_media_scalar($chat['source'] ?? '', 32)) . "\0"
        . live_media_scalar($chat['chat_id'] ?? '', 512));
}

/** @return array<string,mixed>|null */
function live_cached_contact_profile(string $key): ?array
{
    live_bridge_token();
    $now = time();
    $stored = $_SESSION['unified_bridge_contact_profiles'] ?? [];
    $valid = [];
    if (is_array($stored)) {
        foreach ($stored as $storedKey => $entry) {
            if (!is_string($storedKey) || !is_array($entry)
                || (int)($entry['expires_at'] ?? 0) < $now
                || !is_array($entry['profile'] ?? null)) {
                continue;
            }
            $valid[$storedKey] = $entry;
        }
    }
    $_SESSION['unified_bridge_contact_profiles'] = $valid;
    $profile = $valid[$key]['profile'] ?? null;
    if (!is_array($profile)) return null;
    // Internal bridge metadata is removed before the response leaves PHP.
    // It lets the UI decide whether a background refresh is worthwhile.
    $profile['_bridge_cached_at'] = (int)($valid[$key]['fetched_at'] ?? 0);
    return $profile;
}

/** @param array<string,mixed> $profile */
function live_cache_contact_profile(string $key, array $profile): void
{
    live_bridge_token();
    $stored = $_SESSION['unified_bridge_contact_profiles'] ?? [];
    if (!is_array($stored)) $stored = [];
    $stored[$key] = [
        'profile' => $profile,
        'fetched_at' => time(),
        // Contact data is supplementary. A short per-browser-session cache
        // avoids repeatedly adding the same optional WPP call to its queue.
        'expires_at' => time() + 10 * 60,
    ];
    if (count($stored) > 32) {
        uasort($stored, static fn(array $a, array $b): int => (int)($a['expires_at'] ?? 0) <=> (int)($b['expires_at'] ?? 0));
        $stored = array_slice($stored, -24, null, true);
    }
    $_SESSION['unified_bridge_contact_profiles'] = $stored;
}

/** @param array<string,mixed> $chat @return array<string,mixed> */
function live_contact_profile_fallback(array $chat, string $notice, bool $canRefresh): array
{
    $name = live_media_scalar($chat['name'] ?? '', 256);
    $source = live_media_scalar($chat['source'] ?? '', 32);
    return [
        'name' => $name !== '' ? $name : 'Контакт',
        'subtitle' => $source,
        // The header already has an opaque bridge avatar. Never return a raw
        // provider URL through this supplementary profile endpoint.
        'avatar' => '',
        'fields' => [],
        'notice' => $notice,
        'origin' => 'saved',
        'can_refresh' => $canRefresh,
        'needs_refresh' => $canRefresh,
    ];
}

/** @param array<string,mixed> $chat @param array<string,mixed> $raw @return array<string,mixed> */
function live_normalize_contact_profile(array $chat, array $raw): array
{
    $fields = [];
    $username = live_media_scalar($raw['username'] ?? '', 160);
    $source = live_media_scalar($chat['source'] ?? '', 32);
    $chatId = live_media_scalar($chat['chat_id'] ?? '', 512);
    $lid = str_ends_with(strtolower($chatId), '@lid');
    $lidValue = $lid ? (preg_replace('/@.+$/', '', $chatId) ?: '') : '';
    foreach (($raw['fields'] ?? []) as $field) {
        if (!is_array($field) || count($fields) >= 12) continue;
        $label = live_media_scalar($field['label'] ?? '', 96);
        $value = live_media_scalar($field['value'] ?? '', 512);
        if ($label === '' || $value === '') continue;
        if ($username === '' && preg_match('/^(?:имя пользователя|username)$/iu', $label)) {
            $username = $value;
        }
        // WPP can use the numeric LID as its `number` fallback. It is not a
        // phone number, so preserve the value but name it accurately.
        if ($lid && $label === 'Телефон' && $lidValue !== '' && hash_equals($lidValue, $value)) {
            $label = 'Идентификатор WhatsApp';
        }
        $entry = ['label' => $label, 'value' => $value];
        $href = live_media_scalar($field['href'] ?? '', 512);
        if (strcasecmp($source, 'Telegram') === 0
            && preg_match('~^https://t\.me/[A-Za-z0-9_]{5,32}$~D', $href)) {
            $entry['href'] = $href;
        }
        $fields[] = $entry;
    }
    if ($username !== '' && !str_starts_with($username, '@')) $username = '@' . $username;
    $name = live_media_scalar($raw['name'] ?? '', 256) ?: $username;
    $fallbackName = live_media_scalar($chat['name'] ?? '', 256);
    $subtitle = live_media_scalar($raw['subtitle'] ?? '', 96);
    $provider = strtolower($source);
    $rawAvatar = live_media_scalar($raw['avatar'] ?? '', 4096);
    // Provider avatar URLs stay behind a same-origin relay. VK uses an
    // allowlisted public CDN; Telegram and MAX have their typed local paths.
    $avatarTarget = live_whatsapp_avatar_target($rawAvatar, $source)
        ?? live_chat_avatar_target($rawAvatar, $source)
        ?? live_max_avatar_target($rawAvatar, $source);
    $avatar = $avatarTarget === null ? '' : live_avatar_relay_url($avatarTarget, [
        'source' => $source,
        'chat_id' => $chatId,
        'message_id' => 'contact-avatar',
    ]);
    $rawKind = strtolower(live_media_scalar($raw['kind'] ?? '', 32));
    $kind = in_array($rawKind, ['group', 'channel'], true) ? $rawKind : 'contact';
    $members = [];
    foreach (($raw['members'] ?? []) as $member) {
        if (!is_array($member) || count($members) >= 50) continue;
        $memberId = live_media_scalar($member['id'] ?? '', 128);
        $memberName = live_media_scalar($member['name'] ?? '', 160);
        if ($memberId === '' || $memberName === '') continue;
        $memberAvatarRaw = live_media_scalar($member['avatar'] ?? '', 4096);
        $memberTarget = live_max_avatar_target($memberAvatarRaw, $source)
            ?? live_chat_avatar_target($memberAvatarRaw, $source);
        $memberAvatar = $memberTarget === null ? '' : live_avatar_relay_url($memberTarget, [
            'source' => $source, 'chat_id' => $chatId, 'message_id' => 'group-member', 'actor_id' => $memberId,
        ]);
        $members[] = ['id' => $memberId, 'name' => $memberName, 'avatar' => $memberAvatar];
    }
    $savedFallback = strtolower(live_media_scalar($raw['origin'] ?? '', 32)) === 'saved';
    return [
        'name' => $name !== '' ? $name : ($fallbackName !== '' ? $fallbackName : 'Контакт'),
        'username' => $username,
        'subtitle' => $subtitle !== '' ? $subtitle : $source,
        'avatar' => $avatar,
        'fields' => $fields,
        'kind' => $kind,
        'members' => $members,
        'members_total' => max(count($members), (int)($raw['members_total'] ?? 0)),
        'members_truncated' => !empty($raw['members_truncated']),
        'notice' => live_media_scalar($raw['notice'] ?? '', 256) ?: ('Сведения обновлены из ' . $source . '.'),
        'origin' => $savedFallback ? 'saved' : $provider,
        'can_refresh' => ($raw['can_refresh'] ?? true) === true,
        'needs_refresh' => !empty($raw['needs_refresh']),
    ];
}

/** @param array<string,mixed> $raw @return array<string,mixed> */
function live_normalize_own_profile(array $raw, string $source): array
{
    $source = live_media_scalar($source, 32);
    $fields = [];
    $username = live_media_scalar($raw['username'] ?? '', 160);
    foreach (($raw['fields'] ?? []) as $field) {
        if (!is_array($field) || count($fields) >= 12) continue;
        $label = live_media_scalar($field['label'] ?? '', 96);
        $value = live_media_scalar($field['value'] ?? '', 512);
        if ($label !== '' && $value !== '') $fields[] = ['label' => $label, 'value' => $value];
        if ($username === '' && preg_match('/^(?:имя пользователя|username)$/iu', $label)) $username = $value;
    }
    if ($username !== '' && !str_starts_with($username, '@')) $username = '@' . $username;
    $rawAvatar = live_media_scalar($raw['avatar'] ?? '', 4096);
    $target = live_whatsapp_avatar_target($rawAvatar, $source)
        ?? live_chat_avatar_target($rawAvatar, $source)
        ?? live_max_avatar_target($rawAvatar, $source);
    $avatar = $target === null ? '' : live_avatar_relay_url($target, [
        'source' => $source,
        'chat_id' => 'self',
        'message_id' => 'profile-avatar',
    ]);
    return [
        'id' => live_media_scalar($raw['id'] ?? $raw['account_id'] ?? '', 128),
        'account_id' => live_media_scalar($raw['account_id'] ?? $raw['id'] ?? '', 128),
        'name' => live_media_scalar($raw['name'] ?? '', 256) ?: ($username ?: 'Мой аккаунт'),
        'username' => $username,
        'subtitle' => live_media_scalar($raw['subtitle'] ?? '', 96) ?: ('Мой аккаунт ' . $source),
        'avatar' => $avatar,
        'fields' => $fields,
        'origin' => 'provider',
    ];
}

/** @return string */
function live_contact_profile_source_label(string $source): string
{
    return $source !== '' ? $source : 'сервиса';
}

/**
 * Queries one known chat through the fixed backend endpoint. It is deliberately
 * separate from live_cached_json(): contact details are optional and must not
 * hold history or media work. Every source remains allow-listed here.
 *
 * @param array<string,mixed> $chat
 * @return array<string,mixed>|null
 */
function live_fetch_contact_profile(array $chat): ?array
{
    $source = live_media_scalar($chat['source'] ?? '', 32);
    $chatId = live_media_scalar($chat['chat_id'] ?? '', 512);
    $dbId = (int)($chat['id'] ?? 0);
    if (!in_array(strtolower($source), ['whatsapp', 'vk', 'telegram', 'max'], true) || $chatId === '' || $dbId < 1) return null;

    $query = http_build_query([
        'action' => 'get_contact_profile',
        'source' => $source,
        'chat_id' => $chatId,
        'db_id' => $dbId,
    ]);
    $curl = curl_init('http://127.0.0.1:18080/index.php?' . $query);
    curl_setopt_array($curl, [
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT_MS => 1000,
        CURLOPT_TIMEOUT_MS => 13000,
        CURLOPT_NOSIGNAL => true,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
    ]);
    $body = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    if ($status !== 200 || !is_string($body)) return null;
    $payload = json_decode($body, true);
    $profile = is_array($payload) && !empty($payload['success']) ? ($payload['profile'] ?? null) : null;
    return is_array($profile) ? live_normalize_contact_profile($chat, $profile) : null;
}

/** @param array<string,mixed> $chat @return array<string,mixed> */
function live_contact_profile_response(array $chat, bool $refresh): array
{
    $source = live_media_scalar($chat['source'] ?? '', 32);
    $provider = strtolower($source);
    $chatId = live_media_scalar($chat['chat_id'] ?? '', 512);
    $canRefresh = live_is_active_bridge() && in_array($provider, ['whatsapp', 'vk', 'telegram', 'max'], true);
    $sourceLabel = live_contact_profile_source_label($source);
    $key = live_contact_profile_cache_key($chat);
    $cached = live_cached_contact_profile($key);
    if (!$refresh && $cached !== null) {
        $cachedAt = (int)($cached['_bridge_cached_at'] ?? 0);
        unset($cached['_bridge_cached_at']);
        $cached['notice'] = 'Показаны сведения, ранее полученные из ' . $sourceLabel . '.';
        $cached['origin'] = 'cached-' . $provider;
        $cached['can_refresh'] = $canRefresh;
        // Keep cached details instant. WhatsApp has a shared browser queue;
        // other providers are fetched on first open below.
        $cached['needs_refresh'] = $canRefresh && ($cachedAt < time() - 5 * 60);
        return $cached;
    }
    if (!$canRefresh) {
        return live_contact_profile_fallback($chat, 'Обновление сведений из ' . $sourceLabel . ' пока недоступно.', false);
    }

    // Non-WhatsApp providers do not use the WPP interactive queue, so the
    // first deliberate opening can return their public profile immediately.
    if (!$refresh && $provider === 'whatsapp') {
        return live_contact_profile_fallback(
            $chat,
            'Показаны сохранённые данные диалога. WhatsApp сейчас не запрашивался.',
            true
        );
    }

    // Do not hold the shared bridge session while a provider answers an
    // optional profile request: media references and chat actions continue.
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    $profile = live_fetch_contact_profile($chat);
    if ($profile !== null) {
        if (($profile['origin'] ?? '') !== 'saved' && empty($profile['needs_refresh'])) {
            live_cache_contact_profile($key, $profile);
        }
        return $profile;
    }
    if ($cached !== null) {
        unset($cached['_bridge_cached_at']);
        $cached['notice'] = $sourceLabel . ' не ответил достаточно быстро. Показаны ранее полученные сведения.';
        $cached['origin'] = 'cached-' . $provider;
        $cached['can_refresh'] = true;
        $cached['needs_refresh'] = false;
        return $cached;
    }
    return live_contact_profile_fallback(
        $chat,
        $sourceLabel . ' не ответил достаточно быстро. Показаны сохранённые данные диалога.',
        true
    );
}

function live_is_asset_field(string $field): bool
{
    return in_array(strtolower($field), [
        'avatar', 'avatar_url', 'url', 'public_url', 'display_url', 'download',
        'download_url', 'cache_url', 'thumbnail', 'thumb', 'preview', 'src', 'href', 'uri',
        'media', 'media_url', 'image', 'image_url', 'video_url', 'audio_url',
        'file_url', 'path', 'ensure_url', 'source_url', 'stream_url',
        'original_url', 'proxy_url', 'remote_url',
    ], true);
}

/** Remove raw media and relay locations before cached data reaches the browser. */
function live_strip_asset_urls(mixed $value, ?string $field = null): mixed
{
    if (is_array($value)) {
        $out = [];
        foreach ($value as $key => $item) {
            $out[$key] = live_strip_asset_urls($item, is_string($key) ? $key : null);
        }
        return $out;
    }
    if (!is_string($value)) return $value;

    if ($field !== null && live_is_asset_field($field)) return '';
    // A URL in a message body is content, not an asset location.  In
    // particular, MAX represents a shared Rutube/TikTok link as a SHARE
    // marker plus the URL in `text`.  The former broad value-level check
    // treated that text as a provider media URL and erased the whole message
    // after the adapter had intentionally omitted the non-downloadable SHARE
    // marker.  Asset-bearing fields above are still stripped and then
    // re-issued as opaque bridge relays by live_normalize_attachments().
    // Keep only unkeyed raw provider values out of the payload; keyed text,
    // caption and reply fields must remain linkifiable in the shared UI.
    if ($field === null && preg_match('~^(?:https?:)?//|^(?:data|blob):|^/?(?:wa_media|telegram_service|media(?:_stream|_proxy)?|wpp_|uploads)/~i', $value)) {
        return '';
    }
    return $value;
}

/** @return list<string> */
function live_attachment_media_fields(): array
{
    return [
        'url', 'public_url', 'display_url', 'download', 'download_url', 'cache_url',
        'thumbnail', 'thumb', 'preview', 'src', 'href', 'uri', 'media',
        'media_url', 'image', 'image_url', 'video_url', 'audio_url',
        'file_url', 'path', 'ensure_url', 'source_url', 'stream_url',
        'original_url', 'proxy_url', 'remote_url',
    ];
}

function live_media_scalar(mixed $value, int $maxLength = 1024): string
{
    if (is_array($value) || is_object($value)) return '';
    $value = trim((string)$value);
    if ($value === '' || strlen($value) > $maxLength || preg_match('/[\x00-\x1F\x7F]/', $value)) return '';
    return $value;
}

function live_media_filename(mixed $value): string
{
    $name = live_media_scalar($value, 512);
    $name = basename(str_replace('\\', '/', $name));
    $name = preg_replace('/[\r\n"\\\\]+/', '_', $name) ?? '';
    $name = trim($name);
    return $name !== '' ? substr($name, 0, 180) : 'file';
}

/** @return array{path:string,query:array<string,mixed>}|null */
function live_local_media_location(string $raw): ?array
{
    $raw = trim(html_entity_decode($raw, ENT_QUOTES | ENT_HTML5, 'UTF-8'));
    if ($raw === '' || strlen($raw) > 4096 || str_starts_with($raw, '//')) return null;

    $isAbsolute = preg_match('~^[a-z][a-z0-9+.-]*://~i', $raw) === 1;
    $parts = @parse_url($raw);
    if (!is_array($parts)) return null;
    if ($isAbsolute) {
        $scheme = strtolower((string)($parts['scheme'] ?? ''));
        $host = strtolower((string)($parts['host'] ?? ''));
        $port = (int)($parts['port'] ?? 80);
        if ($scheme !== 'http' || !in_array($host, ['127.0.0.1', 'localhost'], true) || $port !== 18080) return null;
    }

    $path = '/' . ltrim((string)($parts['path'] ?? ''), '/');
    if ($path === '/' || str_contains($path, "\0") || preg_match('~/(?:\.|\.\.)?(?:/|$)~', $path)) return null;
    $query = [];
    if (isset($parts['query'])) parse_str((string)$parts['query'], $query);
    return ['path' => $path, 'query' => $query];
}

function live_media_query_value(array $query, string $name, int $maxLength = 1024): string
{
    return live_media_scalar($query[$name] ?? '', $maxLength);
}

function live_media_external_url_allowed(string $url, string $source): bool
{
    $parts = @parse_url($url);
    if (!is_array($parts)
        || !in_array(strtolower((string)($parts['scheme'] ?? '')), ['http', 'https'], true)
        || !empty($parts['user']) || !empty($parts['pass'])) return false;
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    $port = isset($parts['port']) ? (int)$parts['port'] : null;
    if ($port !== null && !(($scheme === 'http' && $port === 80) || ($scheme === 'https' && $port === 443))) {
        return false;
    }
    $host = strtolower((string)($parts['host'] ?? ''));
    if ($host === '' || !preg_match('/^[a-z0-9.-]+$/', $host)) return false;

    $hostMatches = static function (array $suffixes) use ($host): bool {
        foreach ($suffixes as $suffix) {
            if ($host === $suffix || str_ends_with($host, '.' . $suffix)) return true;
        }
        return false;
    };
    return match (strtolower($source)) {
        'vk' => $hostMatches(['vk.com', 'vkuseraudio.net', 'userapi.com', 'vkuser.net', 'vk-cdn.net']),
        'avito' => $hostMatches(['avito.ru', 'avito.st', 'avito.net']),
        default => false,
    };
}

/** WPP profile pictures use a signed URL on one exact provider host. */
function live_whatsapp_avatar_url_allowed(string $url): bool
{
    $parts = @parse_url($url);
    if (!is_array($parts)
        || strtolower((string)($parts['scheme'] ?? '')) !== 'https'
        || !empty($parts['user']) || !empty($parts['pass'])) return false;
    $port = isset($parts['port']) ? (int)$parts['port'] : null;
    if ($port !== null && $port !== 443) return false;
    $host = strtolower((string)($parts['host'] ?? ''));
    $path = (string)($parts['path'] ?? '');
    return $host === 'pps.whatsapp.net'
        && $path !== '' && str_starts_with($path, '/')
        && !str_contains($path, "\0");
}

/** @param array<string,mixed> $context @return array<string,string>|null */
function live_telegram_context_target(array $context, string $fallbackName, string $variant = 'media'): ?array
{
    if (strtolower(live_media_scalar($context['source'] ?? '', 32)) !== 'telegram') return null;
    $chatId = live_media_scalar($context['chat_id'] ?? '', 512);
    $messageId = live_media_scalar($context['message_id'] ?? '', 64);
    if ($chatId === '' || !ctype_digit($messageId)) return null;
    return [
        'kind' => 'telegram', 'chat_id' => $chatId, 'message_id' => $messageId,
        'name' => live_media_filename($fallbackName),
        'variant' => $variant === 'thumb' ? 'thumb' : 'media',
    ];
}

/**
 * Older Telegram webhook rows store the direct Madeline REST location rather
 * than the later telegram_download.php wrapper.  The current server may
 * expose the same endpoint under telegram_service/rest.php.  Accept only
 * those exact local shapes, bind them to the selected chat and turn them into
 * the current typed Telegram target. No raw local URL reaches the browser.
 *
 * @param array<string,mixed> $context
 * @return array<string,string>|null
 */
function live_legacy_telegram_target(string $raw, array $context, string $fallbackName): ?array
{
    if (strtolower(live_media_scalar($context['source'] ?? '', 32)) !== 'telegram') return null;
    $parts = @parse_url($raw);
    if (!is_array($parts)) return null;
    $path = '/' . ltrim((string)($parts['path'] ?? ''), '/');
    $isAbsolute = preg_match('~^[a-z][a-z0-9+.-]*://~i', $raw) === 1;
    if ($isAbsolute) {
        $scheme = strtolower((string)($parts['scheme'] ?? ''));
        $host = strtolower((string)($parts['host'] ?? ''));
        $port = (int)($parts['port'] ?? ($scheme === 'https' ? 443 : 80));
        $isMadelineRest = $scheme === 'http'
            && in_array($host, ['127.0.0.1', 'localhost'], true)
            && in_array($port, [8080, 8090], true) && $path === '/rest.php';
        $isTunnelRest = $scheme === 'http'
            && in_array($host, ['127.0.0.1', 'localhost'], true)
            && $port === 18080 && $path === '/telegram_service/rest.php';
        // The older project snapshot persisted this exact public Madeline
        // address. It is converted to a typed local target, never fetched as
        // a browser-controlled remote URL.
        $isHistoricalRest = $scheme === 'http'
            && $host === '95.142.40.57' && $port === 80
            && in_array($path, ['/rest.php', '/telegram_service/rest.php'], true);
        $isPublicMediaRest = $scheme === 'https'
            && $host === 'media.cheeseapi.ru' && $port === 443
            && $path === '/telegram_service/rest.php';
        if (!$isMadelineRest && !$isTunnelRest && !$isHistoricalRest && !$isPublicMediaRest) return null;
    } elseif ($path !== '/telegram_service/rest.php') {
        return null;
    }
    $query = [];
    parse_str((string)($parts['query'] ?? ''), $query);
    $action = live_media_query_value($query, 'action', 64);
    $chatId = live_media_query_value($query, 'chatId', 512);
    $messageId = live_media_query_value($query, 'messageId', 64);
    $expectedChatId = live_media_scalar($context['chat_id'] ?? '', 512);
    if (!in_array($action, ['downloadMedia', 'downloadThumb'], true)
        || $chatId === '' || $messageId === '' || !ctype_digit($messageId)
        || ($expectedChatId !== '' && !hash_equals($expectedChatId, $chatId))) return null;
    $context['chat_id'] = $chatId;
    $context['message_id'] = $messageId;
    return live_telegram_context_target($context, $fallbackName, $action === 'downloadThumb' ? 'thumb' : 'media');
}

/**
 * Madeline previously returned a directly served cached file.  Its filename
 * cannot be trusted as a route by itself, so use it only as evidence that a
 * known legacy format was used and rebuild the download from the message
 * identity already attached to this history row.
 *
 * @param array<string,mixed> $context
 * @return array<string,string>|null
 */
function live_legacy_telegram_cache_target(string $raw, array $context, string $fallbackName): ?array
{
    if (strtolower(live_media_scalar($context['source'] ?? '', 32)) !== 'telegram') return null;
    $parts = @parse_url($raw);
    if (!is_array($parts)) return null;
    $path = '/' . ltrim((string)($parts['path'] ?? ''), '/');
    $isAbsolute = preg_match('~^[a-z][a-z0-9+.-]*://~i', $raw) === 1;
    if ($isAbsolute) {
        $scheme = strtolower((string)($parts['scheme'] ?? ''));
        $host = strtolower((string)($parts['host'] ?? ''));
        $port = (int)($parts['port'] ?? 80);
        $isLocalCache = $scheme === 'http'
            && in_array($host, ['127.0.0.1', 'localhost'], true)
            && in_array($port, [8080, 8090, 18080], true);
        $isHistoricalCache = $scheme === 'http' && $host === '95.142.40.57' && $port === 80;
        if (!$isLocalCache && !$isHistoricalCache) {
            return null;
        }
    }
    if (!preg_match('~^/telegram_cache(?:_e)?/([A-Za-z0-9._-]{1,255})$~', $path, $match)) return null;
    $variant = str_starts_with(strtolower((string)$match[1]), 'th_') ? 'thumb' : 'media';
    return live_telegram_context_target($context, $fallbackName, $variant);
}

/**
 * Old collapsed Telegram records sometimes preserve only media.cheeseapi.ru
 * ensure/public links.  The key is opaque, while the selected message already
 * gives us a safe way to request the original file through telegram_download.
 *
 * @param array<string,mixed> $context
 * @return array<string,string>|null
 */
function live_legacy_telegram_public_target(string $raw, array $context, string $fallbackName): ?array
{
    if (strtolower(live_media_scalar($context['source'] ?? '', 32)) !== 'telegram') return null;
    $parts = @parse_url($raw);
    if (!is_array($parts)
        || !in_array(strtolower((string)($parts['scheme'] ?? '')), ['http', 'https'], true)
        || !empty($parts['user']) || !empty($parts['pass'])
        || strtolower((string)($parts['host'] ?? '')) !== 'media.cheeseapi.ru') return null;
    $port = isset($parts['port']) ? (int)$parts['port'] : null;
    $scheme = strtolower((string)($parts['scheme'] ?? ''));
    if ($port !== null && !(($scheme === 'http' && $port === 80) || ($scheme === 'https' && $port === 443))) return null;
    $path = (string)($parts['path'] ?? '');
    if (!preg_match('~^/(?:ensure|pub)/[a-f0-9]{40}$~i', $path)) return null;
    return live_telegram_context_target($context, $fallbackName, 'media');
}

/**
 * A collapsed Telegram album keeps the parent message id, while each
 * attachment's preview still points to its own child message.  Recover that
 * child identity before handling public/ensure/cache fields so every tile
 * opens the correct original file.
 *
 * @param array<string,mixed> $context
 */
function live_telegram_attachment_message_id(mixed $rawValue, array $context): string
{
    $raw = live_media_scalar($rawValue, 4096);
    if ($raw === '') return '';
    $legacyTarget = live_legacy_telegram_target($raw, $context, 'file');
    if ($legacyTarget !== null) return live_media_scalar($legacyTarget['message_id'] ?? '', 64);

    // Newer archived rows may already use telegram_download.php. It remains
    // local-only and must still belong to the selected chat.
    $location = live_local_media_location($raw);
    if ($location === null || strtolower(basename($location['path'])) !== 'telegram_download.php') return '';
    $query = $location['query'];
    $chatId = live_media_query_value($query, 'chat_id', 512);
    $messageId = live_media_query_value($query, 'message_id', 64);
    $expectedChatId = live_media_scalar($context['chat_id'] ?? '', 512);
    if ($chatId === '' || !ctype_digit($messageId)
        || ($expectedChatId !== '' && !hash_equals($expectedChatId, $chatId))) return '';
    return $messageId;
}

/**
 * Convert a provider attachment URL into a small, typed upstream descriptor.
 * The browser never receives this descriptor or the original provider URL.
 *
 * @param array<string,mixed> $context
 * @return array<string,string>|null
 */
function live_media_target_from_url(mixed $rawValue, array $context, string $fallbackName = ''): ?array
{
    $raw = live_media_scalar($rawValue, 4096);
    if ($raw === '') return null;
    $source = strtolower(live_media_scalar($context['source'] ?? '', 32));
    $fallbackName = live_media_filename($fallbackName);

    $legacyTelegram = live_legacy_telegram_target($raw, $context, $fallbackName);
    if ($legacyTelegram !== null) return $legacyTelegram;
    $legacyTelegramCache = live_legacy_telegram_cache_target($raw, $context, $fallbackName);
    if ($legacyTelegramCache !== null) return $legacyTelegramCache;
    $legacyTelegramPublic = live_legacy_telegram_public_target($raw, $context, $fallbackName);
    if ($legacyTelegramPublic !== null) return $legacyTelegramPublic;

    // An older WhatsApp renderer used this cosmetic path instead of the
    // index.php action. Recognize it before generic URL parsing, which would
    // otherwise treat it as an ordinary relative static path.
    if ($source === 'whatsapp' && preg_match('~^/?wa_media/([^/]+)/([^/?#]+)$~i', $raw, $match)) {
        $id = live_media_scalar(rawurldecode((string)$match[1]), 512);
        $name = live_media_filename(rawurldecode((string)$match[2]));
        if ($id !== '') return ['kind' => 'wa', 'id' => $id, 'name' => $name, 'mime' => ''];
    }

    if (preg_match('~^https?://~i', $raw) && !live_local_media_location($raw)) {
        if (!live_media_external_url_allowed($raw, $source)) return null;
        return ['kind' => 'stream', 'url' => $raw, 'name' => $fallbackName];
    }

    $location = live_local_media_location($raw);
    if ($location === null) return null;
    $path = strtolower(basename($location['path']));
    $query = $location['query'];

    if ($path === 'index.php' && $source === 'whatsapp'
        && strtolower(live_media_query_value($query, 'action', 64)) === 'wa_get_preview') {
        $id = live_media_query_value($query, 'id', 512);
        if ($id === '') return null;
        return [
            'kind' => 'wa_preview', 'id' => $id,
            'name' => live_media_filename($fallbackName ?: 'preview.jpg'),
        ];
    }
    if ($path === 'index.php' && $source === 'whatsapp'
        && strtolower(live_media_query_value($query, 'action', 64)) === 'wa_get_media') {
        $id = live_media_query_value($query, 'id', 512);
        if ($id === '') return null;
        return [
            'kind' => 'wa', 'id' => $id,
            'name' => live_media_filename(live_media_query_value($query, 'name', 512) ?: $fallbackName),
            'mime' => live_media_query_value($query, 'mime', 160),
        ];
    }
    if ($path === 'media.php' && $source === 'whatsapp') {
        $id = live_media_query_value($query, 'id', 512);
        if ($id === '') return null;
        return [
            'kind' => 'wa', 'id' => $id,
            'name' => live_media_filename(live_media_query_value($query, 'filename', 512) ?: $fallbackName),
            'mime' => live_media_query_value($query, 'mime', 160),
        ];
    }
    // MAX history exposes only an opaque sidecar token through its fixed
    // `max_api.php` route. Re-wrap that token in the bridge's own session
    // relay so the browser never receives a provider URL or a reusable MAX
    // token.
    if ($path === 'max_api.php' && $source === 'max'
        && strtolower(live_media_query_value($query, 'resource', 32)) === 'media') {
        $ref = live_media_query_value($query, 'ref', 128);
        if (!preg_match('/^[A-Za-z0-9_-]{20,128}$/D', $ref)) return null;
        return [
            'kind' => 'max', 'ref' => $ref,
            'name' => live_media_filename($fallbackName),
        ];
    }
    if ($path === 'telegram_download.php' && $source === 'telegram') {
        $chatId = live_media_query_value($query, 'chat_id', 512);
        $messageId = live_media_query_value($query, 'message_id', 64);
        $expectedChatId = live_media_scalar($context['chat_id'] ?? '', 512);
        if ($chatId === '' || $messageId === '' || !ctype_digit($messageId)
            || ($expectedChatId !== '' && !hash_equals($expectedChatId, $chatId))) return null;
        return [
            'kind' => 'telegram', 'chat_id' => $chatId, 'message_id' => $messageId,
            'name' => live_media_filename(live_media_query_value($query, 'name', 512) ?: $fallbackName),
            // TelegramClient marks its lightweight tile with thumb=1. The
            // browser still sees only an opaque bridge URL, which routes this
            // exact variant to downloadThumb instead of the original file.
            'variant' => live_media_query_value($query, 'thumb', 8) === '1' ? 'thumb' : 'media',
        ];
    }
    if (in_array($path, ['media_stream.php', 'media_proxy.php'], true) && in_array($source, ['vk', 'avito'], true)) {
        $url = live_media_query_value($query, 'u', 4096);
        if (!live_media_external_url_allowed($url, $source)) return null;
        // Current media_stream.php links also carry HEIC files. Convert inline
        // HEIC/HEIF requests after the bridge validates each CDN hop.
        $mediaName = live_media_filename(live_media_query_value($query, 'name', 512) ?: $fallbackName);
        $heicPath = (string)(parse_url($url, PHP_URL_PATH) ?? '');
        $wantsDownload = in_array(strtolower(live_media_query_value($query, 'download', 8)), ['1', 'true', 'yes'], true)
            || live_media_query_value($query, 'dl', 8) === '1';
        $isHeic = preg_match('~\.(?:heic|heif)$~i', $mediaName) === 1
            || preg_match('~\.(?:heic|heif)$~i', $heicPath) === 1;
        return [
            'kind' => 'stream', 'url' => $url,
            'name' => $mediaName,
            'heic_compat' => !$wantsDownload && $isHeic ? '1' : '0',
        ];
    }

    $relative = ltrim($location['path'], '/');
    if ($source === 'whatsapp' && preg_match('~^uploads/wa_media/[A-Za-z0-9._/-]+$~', $relative)) {
        return ['kind' => 'local', 'path' => $relative, 'name' => $fallbackName];
    }
    if (in_array($source, ['vk', 'avito'], true) && preg_match('~^uploads/media/[A-Za-z0-9._/-]+$~', $relative)) {
        return ['kind' => 'local', 'path' => $relative, 'name' => $fallbackName];
    }
    return null;
}

/**
 * Chat avatars are cached by the established backend under uploads/avatar.
 * Expose only a typed local filename through the opaque media relay; never
 * pass provider URLs, query strings, or SVG markup to the browser.
 *
 * @return array<string,string>|null
 */
function live_chat_avatar_target(mixed $rawAvatar, string $source = ''): ?array
{
    $raw = live_media_scalar($rawAvatar, 4096);
    if ($raw === '') return null;
    $location = live_local_media_location($raw);
    if ($location === null || ($location['query'] ?? []) !== []) {
        // VK avatar CDN links are public image resources. The browser still
        // receives only an opaque bridge URL; the bridge fetches the exact
        // allowlisted image when it is actually visible.
        if (strtolower(trim($source)) === 'vk' && live_media_external_url_allowed($raw, 'vk')) {
            return ['kind' => 'stream', 'url' => $raw, 'avatar' => '1', 'name' => 'avatar.jpg'];
        }
        return null;
    }
    $relative = ltrim((string)($location['path'] ?? ''), '/');
    if (!preg_match('~^uploads/avatar/([^/]+)$~', $relative, $match)) {
        if (strtolower(trim($source)) === 'vk' && live_media_external_url_allowed($raw, 'vk')) {
            return ['kind' => 'stream', 'url' => $raw, 'avatar' => '1', 'name' => 'avatar.jpg'];
        }
        return null;
    }
    $filename = rawurldecode((string)$match[1]);
    if ($filename === '' || strlen($filename) > 255
        || !preg_match('~^[A-Za-z0-9._-]+$~', $filename)
        || !preg_match('~\.(?:jpe?g|png|webp|gif|avif)$~i', $filename)) return null;
    return [
        'kind' => 'avatar',
        'path' => 'uploads/avatar/' . rawurlencode($filename),
        'name' => $filename,
    ];
}

/** @return array<string,string>|null */
function live_whatsapp_avatar_target(mixed $rawAvatar, string $source): ?array
{
    $raw = live_media_scalar($rawAvatar, 4096);
    if (strtolower(trim($source)) !== 'whatsapp'
        || !live_whatsapp_avatar_url_allowed($raw)) return null;
    return ['kind' => 'wa_avatar', 'url' => $raw, 'name' => 'avatar.jpg'];
}

/**
 * MAX serialises avatars as its fixed local media relay, never as a provider
 * CDN URL.  Keep the token opaque and re-wrap it in the browser-session
 * avatar relay just like cached Telegram/WhatsApp avatars.
 *
 * @return array<string,string>|null
 */
function live_max_avatar_target(mixed $rawAvatar, string $source): ?array
{
    if (strtolower(trim($source)) !== 'max') return null;
    $raw = live_media_scalar($rawAvatar, 4096);
    $location = live_local_media_location($raw);
    if ($location === null || strtolower(basename((string)$location['path'])) !== 'max_api.php') return null;
    $query = $location['query'] ?? [];
    if (strtolower(live_media_query_value($query, 'resource', 32)) !== 'media') return null;
    $ref = live_media_query_value($query, 'ref', 128);
    if (!preg_match('/^[A-Za-z0-9_-]{20,128}$/D', $ref)) return null;
    return ['kind' => 'max', 'ref' => $ref, 'name' => 'avatar.jpg'];
}

/** @return array<string,array<string,mixed>> */
function live_media_references(): array
{
    live_bridge_token();
    $now = time();
    $stored = $_SESSION['unified_bridge_media_refs'] ?? [];
    $refs = [];
    if (is_array($stored)) {
        foreach ($stored as $id => $ref) {
            if (!is_string($id) || !is_array($ref) || (int)($ref['expires_at'] ?? 0) < $now) continue;
            $refs[$id] = $ref;
        }
    }
    $_SESSION['unified_bridge_media_refs'] = $refs;
    return $refs;
}

/** @return array<string,array<string,mixed>> */
function live_avatar_references(): array
{
    live_bridge_token();
    $now = time();
    $stored = $_SESSION['unified_bridge_avatar_refs'] ?? [];
    $refs = [];
    if (is_array($stored)) {
        foreach ($stored as $id => $ref) {
            if (!is_string($id) || !is_array($ref) || (int)($ref['expires_at'] ?? 0) < $now) continue;
            $refs[$id] = $ref;
        }
    }
    // Avatars are long-lived local cache files. Keep their small reference
    // map separate from message media so browsing history cannot evict the
    // still-visible chat list.
    if (count($refs) > 900) {
        uasort($refs, static fn(array $a, array $b): int => (int)($a['issued_at'] ?? 0) <=> (int)($b['issued_at'] ?? 0));
        $refs = array_slice($refs, -700, null, true);
    }
    $_SESSION['unified_bridge_avatar_refs'] = $refs;
    return $refs;
}

/** Resolve the currently connected Telegram account for avatar isolation. */
function live_provider_account_id(string $source): string
{
    $source = strtolower(live_media_scalar($source, 32));
    if ($source !== 'telegram') return '';
    live_bridge_token();
    $now = time();
    $stored = $_SESSION['unified_bridge_provider_accounts'] ?? [];
    $entry = is_array($stored) ? ($stored[$source] ?? null) : null;
    if (is_array($entry) && (int)($entry['expires_at'] ?? 0) >= $now) {
        return live_media_scalar($entry['id'] ?? '', 128);
    }
    $payload = live_cached_json('get_provider_self_profile', ['source' => 'Telegram']);
    $profile = is_array($payload) ? ($payload['profile'] ?? null) : null;
    $id = is_array($profile)
        ? live_media_scalar($profile['account_id'] ?? $profile['id'] ?? '', 128) : '';
    if (!is_array($stored)) $stored = [];
    $stored[$source] = ['id' => $id, 'expires_at' => $now + 5 * 60];
    $_SESSION['unified_bridge_provider_accounts'] = $stored;
    return $id;
}

/** @param array<string,string> $target @param array<string,mixed> $context */
function live_media_relay_url(array $target, array $context): string
{
    if (!live_is_active_bridge()) return '';
    $refs = live_media_references();
    // Bound the session footprint even when a long history page carries many
    // thumbnails. References are short lived and can be minted again later.
    if (count($refs) >= 500) {
        uasort($refs, static fn(array $a, array $b): int => (int)($a['issued_at'] ?? 0) <=> (int)($b['issued_at'] ?? 0));
        $refs = array_slice($refs, -350, null, true);
    }
    $id = bin2hex(random_bytes(24));
    $refs[$id] = [
        'target' => $target,
        'source' => live_media_scalar($context['source'] ?? '', 32),
        'chat_id' => live_media_scalar($context['chat_id'] ?? '', 512),
        'chat_db_id' => (int)($context['chat_db_id'] ?? 0),
        'message_id' => live_media_scalar($context['message_id'] ?? '', 512),
        'issued_at' => time(),
        'expires_at' => time() + 15 * 60,
    ];
    $_SESSION['unified_bridge_media_refs'] = $refs;

    // Do not make an image queue behind the one-process UI bridge merely to
    // receive a local 307. When the dedicated worker pool is enabled, the
    // browser can request its selected local worker directly. The URL still
    // holds only a short-lived opaque ref, which the worker verifies against
    // the same PHP session before resolving the provider media target.
    $workerOrigin = live_media_worker_origin_for_ref($id);
    if ($workerOrigin !== '') {
        return $workerOrigin . '/bridge-media?ref=' . rawurlencode($id);
    }
    return '/bridge-media?ref=' . rawurlencode($id);
}

/** @param array<string,string> $target @param array<string,mixed> $context */
function live_avatar_relay_url(array $target, array $context): string
{
    if (!live_is_active_bridge()) return '';
    $refs = live_avatar_references();
    $source = live_media_scalar($context['source'] ?? '', 32);
    $accountId = live_media_scalar($context['account_id'] ?? '', 128);
    if ($accountId === '') $accountId = live_provider_account_id($source);
    $chatId = live_media_scalar($context['chat_id'] ?? '', 512);
    $actorId = live_media_scalar($context['actor_id'] ?? '', 128);
    $seed = json_encode([$target, $accountId, $source, $chatId, $actorId], JSON_UNESCAPED_SLASHES);
    if (!is_string($seed)) return '';
    // Deterministic per bridge session: a periodic chat-list refresh reuses
    // the same opaque avatar URL instead of exhausting media references.
    $id = substr(hash_hmac('sha256', $seed, live_bridge_token()), 0, 48);
    $now = time();
    $refs[$id] = [
        'target' => $target,
        'account_id' => $accountId,
        'source' => $source,
        'chat_id' => $chatId,
        'actor_id' => $actorId,
        'message_id' => 'avatar',
        'issued_at' => (int)($refs[$id]['issued_at'] ?? $now),
        'expires_at' => $now + 24 * 60 * 60,
    ];
    $_SESSION['unified_bridge_avatar_refs'] = $refs;
    return '/bridge-avatar?ref=' . rawurlencode($id);
}

/** @param array<string,mixed> $context @return list<array<string,mixed>> */
function live_normalize_attachments(mixed $value, array $context = []): array
{
    $rows = is_array($value) ? $value : (live_decode_object($value) ?? []);
    if (!is_array($rows)) return [];
    $out = [];
    foreach ($rows as $row) {
        if (!is_array($row)) continue;
        $rawRow = $row;
        $linkType = strtolower(live_media_scalar($rawRow['type'] ?? '', 32)) === 'link';
        // Link previews are text metadata, not provider media. Preserve a
        // direct, inert http(s) destination for the renderer and never turn
        // it into a bridge-media request (which would fetch arbitrary pages).
        if ($linkType) {
            $url = live_media_scalar($rawRow['external_url'] ?? $rawRow['url'] ?? '', 4096);
            $parts = @parse_url($url);
            $valid = is_array($parts)
                && in_array(strtolower((string)($parts['scheme'] ?? '')), ['http', 'https'], true)
                && !empty($parts['host']) && empty($parts['user']) && empty($parts['pass']);
            $row = live_strip_asset_urls($row);
            $row['type'] = 'link';
            $row['url'] = $valid ? $url : '';
            $row['external_url'] = $valid ? $url : '';
            $row['unavailable'] = !$valid;
            if (!$valid) $row['unavailable_label'] = 'Ссылка недоступна.';
            else unset($row['unavailable_label']);
            $out[] = $row;
            continue;
        }
        // A poll is structured message data, not an asset. It has no media
        // relay by design; marking it unavailable would turn a valid poll
        // into a broken file card after the bridge strips provider URLs.
        if (strtolower(live_media_scalar($rawRow['type'] ?? '', 32)) === 'poll') {
            $row = live_strip_asset_urls($row);
            $row['type'] = 'poll';
            $row['mime'] = 'application/x-telegram-poll';
            $row['title'] = 'Опрос';
            $row['filename'] = '';
            $row['question'] = mb_substr(trim((string)($rawRow['question'] ?? '')), 0, 1000);
            $options = [];
            foreach (array_slice(is_array($rawRow['options'] ?? null) ? $rawRow['options'] : [], 0, 20) as $option) {
                if (!is_array($option)) continue;
                $options[] = [
                    'text' => mb_substr(trim((string)($option['text'] ?? '')), 0, 1000),
                    'voters' => max(0, (int)($option['voters'] ?? 0)),
                    'chosen' => !empty($option['chosen']),
                ];
            }
            $row['options'] = $options;
            $row['total_voters'] = max(0, (int)($rawRow['total_voters'] ?? 0));
            $row['multiple_choice'] = !empty($rawRow['multiple_choice']);
            $row['quiz'] = !empty($rawRow['quiz']);
            $row['closed'] = !empty($rawRow['closed']);
            $row['voted'] = !empty($rawRow['voted']);
            $row['unavailable'] = false;
            unset($row['unavailable_label']);
            $out[] = $row;
            continue;
        }
        $row = live_strip_asset_urls($row);
        $fallbackName = live_media_filename($rawRow['filename'] ?? $rawRow['title'] ?? 'file');
        $rowContext = $context;
        // A collapsed Telegram album has one parent message, while old
        // `items[]` rows and attachment previews preserve the child message
        // identity.  Prefer a verified local URL, then the row id, before
        // rebuilding ensure/public/cache links.
        if (strtolower(live_media_scalar($context['source'] ?? '', 32)) === 'telegram') {
            $rowMessageId = '';
            foreach (['url', 'download', 'download_url', 'media', 'media_url', 'preview', 'thumbnail', 'thumb'] as $identityField) {
                if (!array_key_exists($identityField, $rawRow)) continue;
                $rowMessageId = live_telegram_attachment_message_id($rawRow[$identityField], $rowContext);
                if ($rowMessageId !== '') break;
            }
            if ($rowMessageId === '') {
                $rowMessageId = live_media_scalar($rawRow['message_id'] ?? $rawRow['messageId'] ?? $rawRow['id'] ?? '', 64);
            }
            if (ctype_digit($rowMessageId)) $rowContext['message_id'] = $rowMessageId;
        }
        $hasRelay = false;
        $relays = [];
        $canonicalRelay = '';
        foreach (live_attachment_media_fields() as $field) {
            if (!array_key_exists($field, $rawRow)) continue;
            $target = live_media_target_from_url($rawRow[$field], $rowContext, $fallbackName);
            if ($target === null) continue;
            $targetKey = json_encode($target, JSON_UNESCAPED_SLASHES);
            $relay = is_string($targetKey) && isset($relays[$targetKey])
                ? $relays[$targetKey]
                : live_media_relay_url($target, $rowContext);
            if ($relay === '') continue;
            if (is_string($targetKey)) $relays[$targetKey] = $relay;
            $row[$field] = $relay;
            if ($canonicalRelay === '' && !in_array($field, ['preview', 'thumbnail', 'thumb'], true)) {
                $canonicalRelay = $relay;
            }
            $hasRelay = true;
        }
        // `ensure_url` was the only full-media address on some older
        // Telegram records.  The common renderer expects a canonical URL for
        // documents and for opening a photo, so retain the verified relay in
        // that field as well.  Preview-only links deliberately stay previews.
        if ($canonicalRelay !== '' && live_media_scalar($row['url'] ?? '', 4096) === '') {
            $row['url'] = $canonicalRelay;
        }
        if (!$hasRelay) {
            $row['unavailable'] = true;
            if (empty($row['unavailable_label'])) {
                $row['unavailable_label'] = live_is_active_bridge()
                    ? 'Вложение временно недоступно.'
                    : 'Вложение доступно в рабочем режиме';
            }
        } else {
            $row['unavailable'] = false;
            unset($row['unavailable_label']);
        }
        $out[] = $row;
    }
    return $out;
}

/** @return array<string,mixed>|null */
function live_decode_object(mixed $value): ?array
{
    if (is_array($value)) return $value;
    if (!is_string($value) || trim($value) === '') return null;
    $decoded = json_decode($value, true);
    return is_array($decoded) ? $decoded : null;
}

function live_reaction_actor_initials(mixed $value): string
{
    $name = trim((string)$value);
    if ($name === '') return '';
    if (str_starts_with($name, '@')) {
        $name = ltrim($name, '@');
        $chars = function_exists('mb_substr') ? mb_substr($name, 0, 2, 'UTF-8') : substr($name, 0, 2);
        return function_exists('mb_strtoupper') ? mb_strtoupper($chars, 'UTF-8') : strtoupper($chars);
    }
    $parts = preg_split('/\s+/u', $name, -1, PREG_SPLIT_NO_EMPTY) ?: [];
    $letters = [];
    foreach (array_slice($parts, 0, 2) as $part) {
        $letter = function_exists('mb_substr') ? mb_substr($part, 0, 1, 'UTF-8') : substr($part, 0, 1);
        if ($letter !== '') $letters[] = $letter;
    }
    return function_exists('mb_strtoupper') ? mb_strtoupper(implode('', $letters), 'UTF-8') : strtoupper(implode('', $letters));
}

/** @param array<string,mixed> $actor @param array<string,mixed> $context @return array<string,mixed> */
function live_normalize_reaction_actor(array $actor, array $context = []): array
{
    $id = '';
    foreach (['id', 'user_id', 'userId', 'peer_id', 'peerId', 'from_id', 'fromId'] as $field) {
        $candidate = live_media_scalar($actor[$field] ?? '', 128);
        if ($candidate !== '') { $id = $candidate; break; }
    }
    $username = live_media_scalar($actor['username'] ?? '', 160);
    if ($username !== '' && !str_starts_with($username, '@')) $username = '@' . $username;
    $name = '';
    // Display names take precedence; usernames remain a separate profile field.
    if ($name === '') {
        foreach (['name', 'display_name', 'displayName', 'sender_name', 'senderName'] as $field) {
            $candidate = live_media_scalar($actor[$field] ?? '', 160);
            if ($candidate !== '') { $name = $candidate; break; }
        }
    }
    if ($name === '') $name = $username;
    // Telegram reaction snapshots often contain only the numeric peer id.
    // In a direct dialog that id is the open contact, whose canonical label
    // is already known to the bridge. Never turn an arbitrary ID suffix into
    // a fake person's initials.
    $source = (string)($context['source'] ?? '');
    $chatId = live_media_scalar($context['chat_id'] ?? '', 128);
    $chatName = live_media_scalar($context['chat_name'] ?? '', 160);
    if ($name === '' && strcasecmp($source, 'Telegram') === 0 && $id !== ''
        && $chatId !== '' && hash_equals($chatId, $id)
        && !preg_match('/^telegram\s+\d+$/iu', $chatName)) {
        $name = $chatName;
        if (str_starts_with($chatName, '@')) $username = $chatName;
    }
    $target = null;
    foreach (['avatar', 'avatarUrl', 'avatar_url', 'photo', 'image'] as $field) {
        $candidate = live_media_scalar($actor[$field] ?? '', 4096);
        $target = live_chat_avatar_target($candidate, $source) ?? live_whatsapp_avatar_target($candidate, $source) ?? live_max_avatar_target($candidate, $source);
        if ($target !== null) break;
    }
    $actorContext = $context;
    $actorContext['actor_id'] = $id;
    $avatar = $target !== null ? live_avatar_relay_url($target, $actorContext) : '';
    return [
        'id' => $id,
        'name' => $name,
        'username' => $username,
        'initials' => live_reaction_actor_initials($name),
        'avatar' => $avatar,
        'avatarAvailable' => $avatar !== '',
    ];
}

/** @return list<array<string,mixed>> */
function live_normalize_reactions(mixed $value, array $context = []): array
{
    $rows = is_array($value) ? $value : (live_decode_object($value) ?? []);
    if (!is_array($rows)) return [];
    $out = [];
    foreach ($rows as $row) {
        if (!is_array($row)) continue;
        // Save actors before the generic URL scrubber runs. Unlike an
        // attachment, an actor image is transformed into a bridge avatar
        // reference rather than deleted.
        $rawActors = is_array($row['actors'] ?? null) ? $row['actors'] : [];
        $normalized = live_strip_asset_urls($row);
        $actors = [];
        foreach (array_slice($rawActors, 0, 3) as $actor) {
            if (!is_array($actor)) continue;
            $actors[] = live_normalize_reaction_actor($actor, $context);
        }
        $normalized['actors'] = $actors;
        $out[] = $normalized;
    }
    return $out;
}

/** @return array<string,mixed> */
function live_normalize_chat(array $chat): array
{
    // Keep a raw value only long enough to turn an already cached local image
    // into an opaque same-origin reference. Everything else is scrubbed.
    $avatarCandidates = [$chat['avatar_url'] ?? '', $chat['avatar'] ?? ''];
    $avatarContext = [
        'source' => (string)($chat['source'] ?? ''),
        'chat_id' => (string)($chat['chat_id'] ?? ''),
        'message_id' => 'avatar',
    ];
    $chat = live_strip_asset_urls($chat);
    $avatarTarget = null;
    foreach ($avatarCandidates as $candidate) {
        $avatarTarget = live_chat_avatar_target($candidate, $avatarContext['source'])
            ?? live_whatsapp_avatar_target($candidate, $avatarContext['source'])
            ?? live_max_avatar_target($candidate, $avatarContext['source']);
        if ($avatarTarget !== null) break;
    }
    if ($avatarTarget !== null) {
        $relay = live_avatar_relay_url($avatarTarget, $avatarContext);
        if ($relay !== '') {
            $chat['avatar'] = $relay;
            $chat['avatar_url'] = $relay;
        }
    }
    $context = live_decode_object($chat['item_context'] ?? null)
        ?? live_decode_object($chat['item_context_json'] ?? null);
    if ($context !== null) {
        $chat['item_context'] = live_strip_asset_urls($context);
        // Old summary storage keeps provider receipt data inside item_context.
        // Promote only known scalar state so the shared list and the open
        // history project the identical receipt without exposing raw payloads.
        foreach (['last_message_ack', 'last_message_send_state', 'last_message_is_service', 'last_message_service_event', 'last_message_event_style'] as $key) {
            if (!array_key_exists($key, $chat) && array_key_exists($key, $chat['item_context'])) {
                $chat[$key] = $chat['item_context'][$key];
            }
        }
    }
        if (strtolower((string)($chat['source']??''))==='telegram' && ($chat['last_message_direction']??'')==='out'
            && ctype_digit((string)($chat['last_message_id']??''))) {
            $chat['last_message_ack']=!empty($chat['last_message_is_read'])?3:1;
            $chat['last_message_send_state']=!empty($chat['last_message_is_read'])?'read':'accepted';
        }
    unset($chat['item_context_json']);
    return $chat;
}

/** @return array<string,mixed> */
function live_normalize_message(array $message, ?array $chat = null): array
{
    // Preserve the raw attachment records only long enough to replace their
    // known local relays with opaque bridge references. The generic scrub
    // below still removes every provider URL from the rest of the payload.
    $hasAttachments = array_key_exists('attachments', $message);
    $hasItems = array_key_exists('items', $message);
    $hasFiles = array_key_exists('files', $message);
    $explicitAttachmentsKnown = array_key_exists('attachmentsKnown', $message)
        ? (bool)$message['attachmentsKnown'] : null;
    $hasReactionSnapshot = array_key_exists('reaction_snapshot', $message)
        || array_key_exists('reactions', $message)
        || array_key_exists('reactionsDetailed', $message);
    $explicitReactionsKnown = array_key_exists('reactionsKnown', $message)
        ? (bool)$message['reactionsKnown'] : null;
    $rawAttachments = $message['attachments'] ?? [];
    $rawItems = $message['items'] ?? [];
    $rawFiles = $message['files'] ?? [];
    $rawReactions = $message['reaction_snapshot'] ?? $message['reactions'] ?? $message['reactionsDetailed'] ?? [];
    // Keep the provider value before the generic URL scrub. Telegram and MAX
    // both use the same safe local-avatar relay after this point.
    $rawSenderAvatar = live_media_scalar($message['sender_avatar'] ?? '', 4096);
    $message = live_strip_asset_urls($message);
    $providerMessageId = trim((string)($message['message_id'] ?? ''));
    $message['id'] = $providerMessageId !== '' ? $providerMessageId : (string)($message['id'] ?? '');
    $message['text'] = (string)($message['text'] ?? $message['message_text'] ?? '');
    if (strtolower((string)($chat['source']??$message['source']??''))==='telegram'
        && ($message['direction']??'')==='out' && ctype_digit($message['id']) && (int)$message['id']>0
        && !in_array($message['send_state']??'', ['pending','unknown','failed','rejected'],true)) {
        $message['ack']=!empty($message['is_read'])?3:max(1,(int)($message['ack']??0));
        $message['send_state']=$message['ack']>=3?'read':'accepted';
    }

    $message['timestamp'] = (int)($message['timestamp'] ?? 0);
    $message['direction'] = (($message['direction'] ?? '') === 'out') ? 'out' : 'in';
    // Group message authors carry a typed avatar relay. Convert it into the
    // same bridge-avatar URL used by reaction actors, then remove the
    // provider token from the browser payload.
    if ($rawSenderAvatar !== '') {
        $source = (string)($chat['source'] ?? '');
        $senderTarget = live_chat_avatar_target($rawSenderAvatar)
            ?? live_whatsapp_avatar_target($rawSenderAvatar, $source)
            ?? live_max_avatar_target($rawSenderAvatar, $source);
        // VK profile images are remote provider URLs. The same bridge-media
        // relay used for its chat avatar validates and fetches them server
        // side, so the browser never receives the original URL.
        if ($senderTarget === null && strtolower($source) === 'vk') {
            $senderTarget = ['kind' => 'stream', 'url' => $rawSenderAvatar, 'avatar' => '1'];
        }
        $message['sender_avatar'] = $senderTarget === null ? '' : live_avatar_relay_url($senderTarget, [
            'source' => (string)($chat['source'] ?? ''),
            'chat_id' => (string)($chat['chat_id'] ?? ''),
            'message_id' => (string)($message['id'] ?? ''),
            'actor_id' => (string)($message['sender_profile_id'] ?? $message['sender_id'] ?? ''),
        ]);
    } else {
        unset($message['sender_avatar']);
    }
    $message['is_read'] = (bool)($message['is_read'] ?? false);
    $context = [
        'source' => (string)($message['source'] ?? $chat['source'] ?? ''),
        'chat_id' => (string)($message['chat_id'] ?? $chat['chat_id'] ?? ''),
        'chat_db_id' => (int)($chat['id'] ?? 0),
        'chat_name' => (string)($chat['name'] ?? ''),
        'message_id' => (string)$message['id'],
    ];
    $normalizedAttachments = live_normalize_attachments($rawAttachments, $context);
    // Telegram's collapsed records carry a shortened `items` list alongside
    // full `attachments`; normalize both so legacy consumers never see raw
    // URLs, while BaseChat can prefer the complete attachment contract.
    $normalizedItems = (is_array($rawItems) || is_string($rawItems))
        ? live_normalize_attachments($rawItems, $context)
        : [];
    if (is_array($rawItems) || is_string($rawItems)) $message['items'] = $normalizedItems;
    // A few older adapters expose only `items`. Keep `attachments` canonical
    // for the common UI while retaining `items` for legacy code that reads it.
    if ($hasAttachments || $hasItems) {
        $message['attachments'] = $normalizedAttachments ?: $normalizedItems;
    } else {
        // Keep the field absent when the provider did not send a media
        // snapshot. The JS model uses attachmentsKnown to distinguish that
        // state from an authoritative empty list.
        unset($message['attachments']);
    }
    if ($hasFiles && (is_array($rawFiles) || is_string($rawFiles))) {
        // TelegramClient can expose the identical attachment list under both
        // fields. Reuse the already-minted opaque refs rather than running
        // the full relay normalization twice for every media message.
        $message['files'] = $rawFiles === $rawAttachments
            ? $normalizedAttachments
            : live_normalize_attachments($rawFiles, $context);
    }
    if ($hasReactionSnapshot) {
        $message['reactions'] = live_normalize_reactions($rawReactions, $context);
    } else {
        unset($message['reactions'], $message['reactionsDetailed']);
    }
    $message['attachmentsKnown'] = $explicitAttachmentsKnown ?? ($hasAttachments || $hasItems || $hasFiles);
    $message['reactionsKnown'] = $explicitReactionsKnown ?? $hasReactionSnapshot;
    if (empty($message['reply_to']) && !empty($message['reply_to_message_id'])) {
        $message['reply_to'] = (string)$message['reply_to_message_id'];
    }
    // Raw payloads are not used by the UI and can contain provider URLs.
    unset($message['raw_json'], $message['reaction_snapshot']);
    return $message;
}

/** @return list<array<string,mixed>> */
function live_chats(): array
{
    $payload = live_cached_json('get_chats_json');
    $chats = $payload['chats'] ?? [];
    if (!is_array($chats)) return [];
    return array_values(array_filter(array_map(
        static fn(mixed $chat): mixed => is_array($chat) ? live_normalize_chat($chat) : null,
        $chats
    ), static fn(mixed $chat): bool => is_array($chat)));
}

/** @return array<string,mixed>|null */
function live_find_chat(): ?array
{
    $dbId = (int)($_GET['db_id'] ?? $_GET['chat_db_id'] ?? 0);
    $source = trim((string)($_GET['source'] ?? ''));
    $chatId = (string)($_GET['chat_id'] ?? '');

    // Opening a selected chat used to fetch, normalize and create avatar
    // relay references for every chat just to recover one database row. The
    // established server already exposes this same row through its fixed,
    // read-only `get_chat_details` action. Verify that the response belongs
    // to the requested database id before using it; malformed, stale or
    // unavailable replies deliberately keep the legacy list lookup below.
    //
    // A db id has always taken precedence in this function. Keep that
    // behaviour for callers which also carry an old source/chat_id pair;
    // source/chat_id-only lookups still use their original exact match.
    if ($dbId > 0 && live_is_active_bridge()) {
        $payload = live_cached_json('get_chat_details', ['db_id' => $dbId]);
        $candidate = $payload['chat'] ?? null;
        if (is_array($candidate) && (int)($candidate['id'] ?? 0) === $dbId) {
            return live_normalize_chat($candidate);
        }
    }

    foreach (live_chats() as $chat) {
        if ($dbId > 0 && (int)($chat['id'] ?? 0) === $dbId) return $chat;
        if ($source !== '' && $chatId !== ''
            && strcasecmp((string)($chat['source'] ?? ''), $source) === 0
            && (string)($chat['chat_id'] ?? '') === $chatId) return $chat;
    }
    return null;
}

/**
 * Resolve just the selected chat for the dedicated pagination worker. Unlike
 * live_find_chat(), this never falls back to normalizing the full chat list:
 * the worker must stay focused on one history page and avoid minting avatar
 * refs for hundreds of unrelated rows.
 *
 * @return array<string,mixed>|null
 */
function live_history_chat_cache_key(int $dbId, string $source, string $chatId): string
{
    return hash('sha256', $dbId . "\0" . strtolower($source) . "\0" . $chatId);
}

/**
 * A history request has already proved it owns this browser session. Keep a
 * short, session-local record of that exact chat identity so an older page
 * does not make a second get_chat_details request before every Telegram
 * cursor. The cache holds no message body or provider URL, and every lookup
 * checks all three identifiers again.
 *
 * @return array{id:int,source:string,chat_id:string}|null
 */
function live_cached_history_chat(int $dbId, string $source, string $chatId): ?array
{
    if ($dbId < 1 || $source === '' || $chatId === '') return null;
    live_bridge_token();
    $now = time();
    $stored = $_SESSION['unified_bridge_history_chats'] ?? [];
    $valid = [];
    if (is_array($stored)) {
        foreach ($stored as $key => $entry) {
            if (!is_string($key) || !is_array($entry)) continue;
            $id = (int)($entry['id'] ?? 0);
            $entrySource = live_media_scalar($entry['source'] ?? '', 32);
            $entryChatId = live_media_scalar($entry['chat_id'] ?? '', 512);
            $expiresAt = (int)($entry['expires_at'] ?? 0);
            if ($id < 1 || $entrySource === '' || $entryChatId === '' || $expiresAt < $now) continue;
            $valid[$key] = [
                'id' => $id,
                'source' => $entrySource,
                'chat_id' => $entryChatId,
                'expires_at' => $expiresAt,
            ];
        }
    }
    $_SESSION['unified_bridge_history_chats'] = $valid;
    $key = live_history_chat_cache_key($dbId, $source, $chatId);
    $entry = $valid[$key] ?? null;
    $result = null;
    if (is_array($entry)
        && (int)$entry['id'] === $dbId
        && strcasecmp((string)$entry['source'], $source) === 0
        && hash_equals((string)$entry['chat_id'], $chatId)) {
        $result = [
            'id' => $dbId,
            'source' => (string)$entry['source'],
            'chat_id' => (string)$entry['chat_id'],
        ];
    }
    // The cache is only an identity check. Release the browser session before
    // a slow backend request or the real history/media work begins.
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    return $result;
}

/** @param array{id:int,source:string,chat_id:string} $chat */
function live_remember_history_chat(array $chat): void
{
    $dbId = (int)($chat['id'] ?? 0);
    $source = live_media_scalar($chat['source'] ?? '', 32);
    $chatId = live_media_scalar($chat['chat_id'] ?? '', 512);
    if ($dbId < 1 || $source === '' || $chatId === '') return;
    live_bridge_token();
    $now = time();
    $stored = $_SESSION['unified_bridge_history_chats'] ?? [];
    $valid = [];
    if (is_array($stored)) {
        foreach ($stored as $key => $entry) {
            if (!is_string($key) || !is_array($entry) || (int)($entry['expires_at'] ?? 0) < $now) continue;
            $valid[$key] = $entry;
        }
    }
    $valid[live_history_chat_cache_key($dbId, $source, $chatId)] = [
        'id' => $dbId,
        'source' => $source,
        'chat_id' => $chatId,
        // A short cache is enough for continuous scrolling, while a stale
        // tab must re-verify the chat before it resumes paging.
        'expires_at' => $now + 180,
    ];
    if (count($valid) > 24) {
        uasort($valid, static fn(array $a, array $b): int => (int)($a['expires_at'] ?? 0) <=> (int)($b['expires_at'] ?? 0));
        $valid = array_slice($valid, -16, null, true);
    }
    $_SESSION['unified_bridge_history_chats'] = $valid;
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
}

function live_find_history_chat(): ?array
{
    $dbRaw = $_GET['db_id'] ?? $_GET['chat_db_id'] ?? '';
    if (is_array($dbRaw) || is_object($dbRaw)) return null;
    $dbRaw = trim((string)$dbRaw);
    $source = live_media_scalar($_GET['source'] ?? '', 32);
    $chatId = live_media_scalar($_GET['chat_id'] ?? '', 512);
    if (!ctype_digit($dbRaw) || (int)$dbRaw < 1 || $source === '' || $chatId === '') return null;
    $dbId = (int)$dbRaw;
    $cached = live_cached_history_chat($dbId, $source, $chatId);
    if ($cached !== null) return $cached;

    $payload = live_cached_json('get_chat_details', ['db_id' => $dbId]);
    $candidate = $payload['chat'] ?? null;
    if (!is_array($candidate) || (int)($candidate['id'] ?? 0) !== $dbId) return null;
    if (strcasecmp((string)($candidate['source'] ?? ''), $source) !== 0
        || (string)($candidate['chat_id'] ?? '') !== $chatId) return null;

    $chat = [
        'id' => $dbId,
        'source' => (string)$candidate['source'],
        'chat_id' => (string)$candidate['chat_id'],
    ];
    live_remember_history_chat($chat);
    return $chat;
}

/**
 * Mutations must never trust a database id by itself. A forwarded request is
 * rebuilt from the matching legacy chat row only when all three identifiers
 * agree, which prevents a stale page from cross-posting into another chat.
 *
 * @return array<string,mixed>|null
 */
function live_verified_post_chat(): ?array
{
    $source = trim((string)($_POST['source'] ?? ''));
    $chatId = (string)($_POST['chat_id'] ?? '');
    $dbRaw = (string)($_POST['chat_db_id'] ?? '');
    if ($source === '' || $chatId === '' || !ctype_digit($dbRaw)) return null;
    $dbId = (int)$dbRaw;
    if ($dbId <= 0) return null;

    foreach (live_chats() as $chat) {
        if ((int)($chat['id'] ?? 0) !== $dbId) continue;
        if (strcasecmp((string)($chat['source'] ?? ''), $source) !== 0) continue;
        if ((string)($chat['chat_id'] ?? '') !== $chatId) continue;
        return $chat;
    }
    return null;
}

function live_post_string(string $name, int $maxLength = 4096): ?string
{
    $value = $_POST[$name] ?? '';
    if (is_array($value) || is_object($value)) return null;
    $value = (string)$value;
    return strlen($value) <= $maxLength ? $value : null;
}

/**
 * Reply targets are provider message identifiers, never local database ids.
 * The bridge only forwards a target whose shape is safe for the selected
 * provider, while the legacy endpoint still owns the actual delivery.
 */
function live_reply_target_for_chat(array $chat): string
{
    $raw = live_post_string('reply_to_message_id', 512);
    if ($raw === null) {
        live_json(['success' => false, 'message' => 'Идентификатор сообщения для ответа имеет неверный формат.'], 422);
    }

    $replyTo = trim($raw);
    if ($replyTo === '') return '';

    $source = strtolower((string)($chat['source'] ?? ''));
    if (in_array($source, ['telegram', 'vk'], true)) {
        if (!preg_match('/^[1-9][0-9]{0,18}$/D', $replyTo)) {
            live_json(['success' => false, 'message' => 'Для этого сервиса нужен исходный числовой идентификатор сообщения.'], 422);
        }
        return $replyTo;
    }

    if ($source === 'max') {
        if (!preg_match('/^[1-9][0-9]{0,19}$/D', $replyTo)) {
            live_json(['success' => false, 'message' => 'Для MAX нужен исходный числовой идентификатор сообщения.'], 422);
        }
        return $replyTo;
    }

    if ($source === 'whatsapp') {
        // WPPConnect quote ids include direction, the full chat JID (often
        // @lid), and a provider token. Do not accept a shortened local id.
        if (!preg_match('/^(?:true|false)_([^_]+)_(.+)$/D', $replyTo, $match)
            || !preg_match('/^[^@_\s]+@(?:c\.us|g\.us|lid)$/i', (string)$match[1])
            || strlen((string)$match[2]) > 400
            || preg_match('/[\x00-\x1F\x7F\s]/', (string)$match[2])
            || strcasecmp((string)$match[1], (string)($chat['chat_id'] ?? '')) !== 0) {
            live_json(['success' => false, 'message' => 'Для WhatsApp нужен полный идентификатор исходного сообщения.'], 422);
        }
        return $replyTo;
    }

    if ($source === 'avito') {
        live_json(['success' => false, 'message' => 'Публичный API Avito пока не документирует отправку ответа на конкретное сообщение.'], 422);
    }

    live_json(['success' => false, 'message' => 'Ответы для этого сервиса пока не подключены.'], 422);
}

/** @return array{path:string,name:string,mime:string}|null */
function live_uploaded_file_descriptor(mixed $file): ?array
{
    if (!is_array($file) || is_array($file['error'] ?? null)) return null;
    if ((int)($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) return null;
    $path = (string)($file['tmp_name'] ?? '');
    if ($path === '' || !is_uploaded_file($path) || !is_readable($path)) return null;
    $size = (int)($file['size'] ?? 0);
    if ($size < 1 || $size > 50 * 1024 * 1024) return null;
    $name = trim(basename((string)($file['name'] ?? 'attachment')));
    if ($name === '') $name = 'attachment';
    $mime = trim((string)($file['type'] ?? 'application/octet-stream'));
    if (class_exists('finfo')) {
        $detected = (new finfo(FILEINFO_MIME_TYPE))->file($path);
        if (is_string($detected) && $detected !== '') $mime = $detected;
    }
    if ($mime === '') $mime = 'application/octet-stream';
    return ['path' => $path, 'name' => $name, 'mime' => $mime];
}

/** @return list<array{path:string,name:string,mime:string}> */
function live_uploaded_file_descriptors(string $field): array
{
    $files = $_FILES[$field] ?? null;
    if (!is_array($files)) return [];
    if (!is_array($files['name'] ?? null)) {
        $one = live_uploaded_file_descriptor($files);
        return $one ? [$one] : [];
    }

    $out = [];
    foreach ($files['name'] as $index => $_name) {
        $one = live_uploaded_file_descriptor([
            'name' => $files['name'][$index] ?? '',
            'type' => $files['type'][$index] ?? '',
            'tmp_name' => $files['tmp_name'][$index] ?? '',
            'error' => $files['error'][$index] ?? UPLOAD_ERR_NO_FILE,
            'size' => $files['size'][$index] ?? 0,
        ]);
        if ($one) $out[] = $one;
    }
    return $out;
}

function live_attachment_allowed_for_chat(array $chat, array $file): bool
{
    $source = strtolower((string)($chat['source'] ?? ''));
    if (!in_array($source, ['vk', 'avito'], true)) return true;
    $mime = strtolower((string)($file['mime'] ?? ''));
    return str_starts_with($mime, 'image/');
}

/** @return array<string,string> */
function live_verified_forward_fields(array $chat): array
{
    $source = (string)$chat['source'];
    $chatId = (string)$chat['chat_id'];
    $dbId = (string)$chat['id'];
    return [
        'source' => $source,
        'chat_id' => $chatId,
        'chat_db_id' => $dbId,
        'channel_guard' => $source . ':' . $chatId . ':' . $dbId,
    ];
}

/**
 * Forward only a prevalidated POST to the old same-machine endpoint. The
 * bridge has no generic URL proxy: action and every form key come from an
 * allowlist above this call.
 *
 * @param array<string,string> $fields
 * @param array<string,array{path:string,name:string,mime:string}> $files
 */
function live_forward_legacy_post(string $action, array $fields, array $files = [], bool $trackSendJob = false): never
{
    $url = 'http://127.0.0.1:18080/index.php?' . http_build_query(['action' => $action]);
    $payload = array_merge(['action' => $action], $fields);
    foreach ($files as $key => $file) {
        $payload[$key] = curl_file_create($file['path'], $file['mime'], $file['name']);
    }

    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $payload,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 120,
        CURLOPT_HTTPHEADER => ['Accept: application/json'],
    ]);
    $body = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $contentType = (string)curl_getinfo($curl, CURLINFO_CONTENT_TYPE);
    $error = curl_error($curl);
    curl_close($curl);

    if (!is_string($body)) {
        live_json(['success' => false, 'message' => 'Рабочий сервер не ответил на действие.'], 502);
    }
    if ($trackSendJob && $status >= 200 && $status < 300) {
        $decoded = json_decode($body, true);
        $jobId = is_array($decoded) ? (string)($decoded['job_id'] ?? '') : '';
        if (preg_match('/^job_[a-f0-9]{24}$/', $jobId)) {
            live_bridge_token();
            $_SESSION['unified_bridge_send_jobs'][$jobId] = time();
        }
    }
    http_response_code($status > 0 ? $status : 502);
    header('Content-Type: ' . (str_starts_with(strtolower($contentType), 'application/json') ? $contentType : 'application/json; charset=utf-8'));
    header('Cache-Control: no-store');
    echo $body;
    exit;
}

/**
 * Fixed-route JSON bridge for the existing authorization controllers. The
 * path is selected by this file, never by a browser-supplied URL.
 *
 * @param array<string,string|int> $query
 * @param array<string,mixed>|null $json
 */
function live_forward_legacy_json_route(string $path, string $method, array $query = [], ?array $json = null, int $timeout = 30): never
{
    if (!in_array($path, ['telegram_auth.php', 'wpp_status.php', 'wpp_link_code.php', 'max_auth.php', 'max_api.php', 'provider_logout.php', 'wpp_proxy.php', 'ai_api.php'], true)) {
        live_json(['success' => false, 'message' => 'Маршрут не входит в bridge.'], 405);
    }
    $url = 'http://127.0.0.1:18080/' . $path;
    if ($query) $url .= '?' . http_build_query($query);

    $headers = ['Accept: application/json'];
    $curlOptions = [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => $timeout,
        CURLOPT_HTTPHEADER => $headers,
    ];
    if ($json !== null) {
        $headers[] = 'Content-Type: application/json';
        $curlOptions[CURLOPT_HTTPHEADER] = $headers;
        $curlOptions[CURLOPT_POSTFIELDS] = json_encode($json, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    }

    $curl = curl_init($url);
    curl_setopt_array($curl, $curlOptions);
    $body = curl_exec($curl);
    $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $contentType = (string)curl_getinfo($curl, CURLINFO_CONTENT_TYPE);
    curl_close($curl);
    if (!is_string($body)) {
        live_json(['success' => false, 'message' => 'Рабочий сервер не ответил на запрос авторизации.'], 502);
    }
    http_response_code($status > 0 ? $status : 502);
    header('Content-Type: ' . (str_starts_with(strtolower($contentType), 'application/json') ? $contentType : 'application/json; charset=utf-8'));
    header('Cache-Control: no-store');
    echo $body;
    exit;
}

/** MAX is an isolated local sidecar.  The bridge exposes only its QR/password
 * state machine, never a generic sidecar proxy or session data. */
function live_active_max_auth(): never
{
    if (!live_is_active_bridge() || !live_valid_bridge_token()) {
        live_json(['success' => false, 'message' => 'Недействительный токен рабочего интерфейса.'], 403);
    }
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if ($method === 'GET') {
        live_forward_legacy_json_route('max_auth.php', 'GET', [], null, 15);
    }
    if ($method !== 'POST') {
        live_json(['success' => false, 'message' => 'Метод MAX не поддерживается.'], 405);
    }
    $input = live_request_json();
    $action = is_array($input) ? (string)($input['action'] ?? '') : '';
    if ($action === 'logout' && ($input['confirmed'] ?? false) === true) live_forward_legacy_json_route('max_auth.php', 'POST', [], ['action'=>'logout'], 30);
    if ($action === 'start') {
        live_forward_legacy_json_route('max_auth.php', 'POST', [], ['action' => 'start'], 15);
    }
    if ($action === 'password') {
        $password = is_array($input) ? ($input['password'] ?? null) : null;
        if (!is_string($password) || $password === '' || strlen($password) > 512) {
            live_json(['success' => false, 'message' => 'Пароль MAX имеет неверный формат.'], 422);
        }
        live_forward_legacy_json_route('max_auth.php', 'POST', [], ['action' => 'password', 'password' => $password], 15);
    }
    live_json(['success' => false, 'message' => 'Действие MAX не подключено к bridge.'], 405);
}

/** MAX data can cross the bridge only as one of these fixed GET resources. */
function live_active_max_api(): never
{
    if (!live_is_active_bridge() || !live_valid_bridge_token()) {
        live_json(['success' => false, 'message' => 'Недействительный токен рабочего интерфейса.'], 403);
    }
    if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
        live_json(['success' => false, 'message' => 'MAX доступен только для чтения.'], 405);
    }
    $resource = (string)($_GET['resource'] ?? '');
    if ($resource === 'profile') live_forward_legacy_json_route('max_api.php', 'GET', ['resource' => 'profile'], null, 15);
    if ($resource === 'chats') {
        $limit = filter_input(INPUT_GET, 'limit', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 50]]);
        $query = ['resource' => 'chats'];
        if ($limit) $query['limit'] = $limit;
        live_forward_legacy_json_route('max_api.php', 'GET', $query, null, 15);
    }
    if ($resource === 'history') {
        $chatId = (string)($_GET['chat_id'] ?? '');
        if (!preg_match('/^-?[0-9]{1,20}$/', $chatId)) live_json(['success' => false, 'message' => 'Некорректный идентификатор диалога MAX.'], 422);
        $query = ['resource' => 'history', 'chat_id' => $chatId];
        $limit = filter_input(INPUT_GET, 'limit', FILTER_VALIDATE_INT, ['options' => ['min_range' => 1, 'max_range' => 50]]);
        if ($limit) $query['limit'] = $limit;
        $before = (string)($_GET['before'] ?? '');
        if ($before !== '') {
            if (!preg_match('/^[0-9]{1,16}$/', $before)) live_json(['success' => false, 'message' => 'Некорректная граница истории MAX.'], 422);
            $query['before'] = $before;
        }
        live_forward_legacy_json_route('max_api.php', 'GET', $query, null, 15);
    }
    if ($resource === 'events') {
        $after = (string)($_GET['after'] ?? '0');
        if (!preg_match('/^[0-9]{1,20}$/D', $after)) {
            live_json(['success' => false, 'message' => 'Некорректный курсор событий MAX.'], 422);
        }
        // The sidecar journal carries only MAX native IDs. It does not expose
        // message bodies, sessions or provider URLs; the UI still re-reads
        // canonical history before painting a message.
        live_forward_legacy_json_route('max_api.php', 'GET', ['resource' => 'events', 'after' => $after], null, 15);
    }
    if ($resource === 'reactions') {
        $chatId = (string)($_GET['chat_id'] ?? '');
        $messageId = (string)($_GET['message_id'] ?? '');
        if (!preg_match('/^-?(?:0|[1-9][0-9]{0,19})$/D', $chatId)
            || !preg_match('/^[1-9][0-9]{0,19}$/D', $messageId)) {
            live_json(['success' => false, 'message' => 'Некорректный чат или идентификатор сообщения MAX.'], 422);
        }
        live_forward_legacy_json_route('max_api.php', 'GET', ['resource' => 'reactions', 'chat_id' => $chatId, 'message_id' => $messageId], null, 15);
    }
    live_json(['success' => false, 'message' => 'Ресурс MAX не поддерживается.'], 404);
}

/** @return array<string,mixed>|null */
function live_request_json(): ?array
{
    $raw = file_get_contents('php://input');
    if (!is_string($raw) || $raw === '' || strlen($raw) > 8192) return null;
    $decoded = json_decode($raw, true);
    return is_array($decoded) ? $decoded : null;
}

function live_active_wpp_status(): never
{
    if (!live_is_active_bridge() || !live_valid_bridge_token()) {
        live_json(['success' => false, 'message' => 'Недействительный токен рабочего интерфейса.'], 403);
    }
    if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
        live_json(['success' => false, 'message' => 'Для статуса WhatsApp нужен GET.'], 405);
    }
    $start = (string)($_GET['start'] ?? '');
    $reset = (string)($_GET['reset'] ?? '');
    if (!in_array($start, ['', '1'], true) || !in_array($reset, ['', '1'], true) || ($reset === '1' && $start !== '1')) {
        live_json(['success' => false, 'message' => 'Некорректный запрос статуса WhatsApp.'], 400);
    }
    $query = [];
    if ($start === '1') $query['start'] = 1;
    if ($reset === '1') $query['reset'] = 1;
    live_forward_legacy_json_route('wpp_status.php', 'GET', $query, null, 45);
}

function live_active_wpp_link_code(): never
{
    if (!live_is_active_bridge() || !live_valid_bridge_token()) {
        live_json(['success' => false, 'message' => 'Недействительный токен рабочего интерфейса.'], 403);
    }
    if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
        live_json(['success' => false, 'message' => 'Для кода WhatsApp нужен POST.'], 405);
    }
    $input = live_request_json();
    $phone = is_array($input) ? preg_replace('/\D+/', '', (string)($input['phone'] ?? '')) : '';
    if (!is_string($phone) || strlen($phone) < 8 || strlen($phone) > 15) {
        live_json(['success' => false, 'message' => 'Укажите номер WhatsApp в международном формате.'], 422);
    }
    // The legacy endpoint intentionally replaces the WPP session to request a
    // phone-link code; it is reached only by this explicit modal action.
    live_forward_legacy_json_route('wpp_link_code.php', 'POST', [], ['phone' => $phone], 100);
}

function live_active_telegram_auth(): never
{
    if (!live_is_active_bridge() || !live_valid_bridge_token()) {
        live_json(['success' => false, 'message' => 'Недействительный токен рабочего интерфейса.'], 403);
    }
    if (strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'POST') {
        live_json(['success' => false, 'message' => 'Для авторизации Telegram нужен POST.'], 405);
    }
    $input = live_request_json();
    $action = is_array($input) ? (string)($input['action'] ?? '') : '';
    if ($action === 'status') {
        live_forward_legacy_json_route('telegram_auth.php', 'POST', [], ['action' => 'status']);
    }
    if (in_array($action, ['send_code', 'resend_code'], true)) {
        $phone = trim((string)($input['phone'] ?? ''));
        if (!preg_match('/^\+?[0-9][0-9 ()-]{5,30}$/', $phone)) {
            live_json(['success' => false, 'message' => 'Укажите номер Telegram в международном формате.'], 422);
        }
        // Older runtimes expose only send_code. It starts the same bounded
        // worker as a retry, so map the client label to that stable action.
        live_forward_legacy_json_route('telegram_auth.php', 'POST', [], ['action' => 'send_code', 'phone' => $phone], 80);
    }
    if ($action === 'complete_code') {
        $code = trim((string)($input['code'] ?? ''));
        if (!preg_match('/^[0-9A-Za-z-]{3,32}$/', $code)) {
            live_json(['success' => false, 'message' => 'Код Telegram имеет неверный формат.'], 422);
        }
        live_forward_legacy_json_route('telegram_auth.php', 'POST', [], ['action' => 'complete_code', 'code' => $code], 80);
    }
    if ($action === 'complete_2fa') {
        $password = (string)($input['password'] ?? '');
        if ($password === '' || strlen($password) > 512) {
            live_json(['success' => false, 'message' => 'Пароль Telegram имеет неверный формат.'], 422);
        }
        live_forward_legacy_json_route('telegram_auth.php', 'POST', [], ['action' => 'complete_2fa', 'password' => $password], 80);
    }
    if ($action === 'logout' && ($input['confirmed'] ?? false) === true) live_forward_legacy_json_route('telegram_auth.php', 'POST', [], ['action'=>'logout'], 80);
    live_json(['success' => false, 'message' => 'Это действие Telegram не подключено к bridge.'], 405);
}

function live_active_send_message_by_target(): never
{
    $source = trim((string)live_post_string('source', 32));
    $target = trim((string)live_post_string('target', 128));
    $message = live_post_string('message', 10000);
    if (!in_array($source, ['Telegram', 'WhatsApp'], true) || $target === '' || $message === null || trim($message) === '') {
        live_json(['success' => false, 'message' => 'Проверьте сервис, получателя и текст сообщения.'], 400);
    }
    if ($source === 'WhatsApp') {
        $target = preg_replace('/\D+/', '', $target);
        if (!is_string($target) || strlen($target) < 8 || strlen($target) > 15) {
            live_json(['success' => false, 'message' => 'Укажите номер WhatsApp в международном формате.'], 422);
        }
    } elseif (!preg_match('/^(?:@[A-Za-z0-9_]{5,32}|\+?[0-9][0-9 ()-]{5,30})$/', $target)) {
        live_json(['success' => false, 'message' => 'Укажите номер Telegram или @username.'], 422);
    }
    live_forward_legacy_post('send_message_by_target', [
        'source' => $source,
        'target' => $target,
        'message' => $message,
    ]);
}

function live_active_post(string $action): never
{
    if (!live_valid_bridge_token()) {
        live_json(['success' => false, 'message' => 'Недействительный токен рабочего интерфейса.'], 403);
    }

    if ($action === 'send_telegram_comment') {
        $chat = live_verified_post_chat();
        $message = live_post_string('message', 20000);
        $post = trim((string)live_post_string('message_id', 20));
        $requestId = trim((string)live_post_string('client_request_id', 128));
        if (!$chat || strtolower((string)$chat['source']) !== 'telegram'
            || !preg_match('/^-100[0-9]+$/D', (string)$chat['chat_id'])
            || !preg_match('/^[1-9][0-9]{0,9}$/D', $post)
            || !is_string($message) || trim($message) === '' || mb_strlen($message) > 4096
            || !preg_match('/^[A-Za-z0-9_-]{8,128}$/D', $requestId)) {
            live_json(['success' => false, 'outcome' => 'rejected', 'message' => 'Проверьте публикацию и текст комментария.'], 400);
        }
        live_forward_legacy_post('send_telegram_comment', live_verified_forward_fields($chat) + [
            'message_id' => $post, 'message' => $message, 'client_request_id' => $requestId,
        ]);
    }

    if ($action === 'send_message') {
        $chat = live_verified_post_chat();
        $message = live_post_string('message', 10000);
        $file = live_uploaded_file_descriptor($_FILES['attachment'] ?? null);
        $source = strtolower((string)($chat['source'] ?? ''));
        // The MAX UI deliberately uses send_message for a photo album. Keep
        // this provider-specific multipart shape instead of routing it through
        // the generic batch worker.
        $maxFiles = $source === 'max' ? live_uploaded_file_descriptors('attachments') : [];
        if (!$chat || $message === null || (trim($message) === '' && !$file && $maxFiles === [])) {
            live_json(['success' => false, 'message' => 'Проверьте чат и содержимое сообщения.'], 400);
        }
        if ($maxFiles !== []) {
            if ($file || count($maxFiles) < 2 || count($maxFiles) > 10) {
                live_json(['success' => false, 'message' => 'Альбом MAX должен содержать от двух до десяти фотографий.'], 400);
            }
            foreach ($maxFiles as $maxFile) {
                if (!str_starts_with(strtolower((string)($maxFile['mime'] ?? '')), 'image/')) {
                    live_json(['success' => false, 'message' => 'В альбоме MAX можно отправлять только изображения.'], 415);
                }
            }
        } elseif ($file && !live_attachment_allowed_for_chat($chat, $file)) {
            live_json(['success' => false, 'message' => 'Для этого сервиса можно отправлять только изображения.'], 415);
        }
        $replyTo = live_reply_target_for_chat($chat);
        $files = $file ? ['attachment' => $file] : [];
        foreach ($maxFiles as $index => $maxFile) $files['attachments[' . $index . ']'] = $maxFile;
        $fields = live_verified_forward_fields($chat) + ['message' => $message];
        if ($replyTo !== '') $fields['reply_to_message_id'] = $replyTo;
        $requestId = trim((string)live_post_string('client_request_id', 160));
        if ($requestId !== '' && preg_match('/^[A-Za-z0-9_-]{8,128}(?::[0-9]{1,3})?$/', $requestId)) {
            $fields['client_request_id'] = $requestId;
        }
        live_forward_legacy_post('send_message', $fields, $files);
    }

    if ($action === 'send_message_by_target') {
        live_active_send_message_by_target();
    }

    if ($action === 'send_message_batch') {
        $chat = live_verified_post_chat();
        $message = live_post_string('message', 10000);
        $files = live_uploaded_file_descriptors('attachments');
        $batchSource = strtolower((string)($chat['source'] ?? ''));
        if (!$chat || !in_array($batchSource, ['whatsapp', 'telegram'], true) || $message === null || count($files) < 2) {
            live_json(['success' => false, 'message' => 'Пачка доступна для WhatsApp и Telegram и содержит минимум два файла.'], 400);
        }
        if (count($files) > 20) {
            live_json(['success' => false, 'message' => 'В одной пачке можно отправить не более 20 файлов.'], 400);
        }
        $replyTo = live_reply_target_for_chat($chat);
        $curlFiles = [];
        foreach ($files as $index => $file) $curlFiles['attachments[' . $index . ']'] = $file;
        $fields = live_verified_forward_fields($chat) + ['message' => $message];
        if ($replyTo !== '') $fields['reply_to_message_id'] = $replyTo;
        $requestId = trim((string)live_post_string('client_request_id', 160));
        if ($requestId !== '' && preg_match('/^[A-Za-z0-9_-]{8,128}(?::[0-9]{1,3})?$/', $requestId)) {
            $fields['client_request_id'] = $requestId;
        }
        live_forward_legacy_post('send_message_batch', $fields, $curlFiles, true);
    }

    if ($action === 'send_reaction') {
        $chat = live_verified_post_chat();
        $messageId = trim((string)live_post_string('message_id', 512));
        $reaction = live_post_string('reaction', 16);
        $allowed = ['👍', '❤️', '😂', '😮', '😢', '🙏'];
        $source = strtolower((string)($chat['source'] ?? ''));
        $supportedSource = in_array($source, ['telegram', 'whatsapp', 'max'], true);
        $validMaxMessageId = $source !== 'max' || preg_match('/^[1-9][0-9]{0,19}$/D', $messageId);
        if (!$chat || !$supportedSource || !$validMaxMessageId || $messageId === '' || !is_string($reaction) || ($reaction !== '' && !in_array($reaction, $allowed, true))) {
            live_json(['success' => false, 'message' => 'Некорректная реакция или чат.'], 400);
        }
        live_forward_legacy_post('send_reaction', live_verified_forward_fields($chat) + [
            'message_id' => $messageId,
            'reaction' => $reaction,
        ]);
    }

    if ($action === 'mark_chat_read') {
        $chat = live_verified_post_chat();
        if (!$chat) live_json(['success' => false, 'message' => 'Чат не найден.'], 404);
        // The forwarded WPP send-seen request can take several seconds. Do
        // not hold this browser session lock while it runs: otherwise the
        // first history/media GET from the same tab has to wait behind it.
        if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
        live_forward_legacy_post('mark_chat_read', live_verified_forward_fields($chat));
    }

    live_json(['success' => false, 'message' => 'Это действие не подключено к рабочему bridge.'], 405);
}

function live_active_send_job(): never
{
    live_bridge_token();
    $jobId = trim((string)($_GET['job_id'] ?? ''));
    $issued = $_SESSION['unified_bridge_send_jobs'] ?? [];
    if (!preg_match('/^job_[a-f0-9]{24}$/', $jobId) || !is_array($issued) || !isset($issued[$jobId])) {
        live_json(['success' => false, 'message' => 'Задача отправки не принадлежит этому сеансу.'], 404);
    }
    $payload = live_cached_json('get_send_job', ['job_id' => $jobId]);
    if (!is_array($payload)) live_json(['success' => false, 'message' => 'Рабочий сервер не вернул задачу отправки.'], 502);
    live_json($payload);
}

function live_active_new_messages(?array $chat): never
{
    if (!$chat) live_json(['messages' => [], 'read_ids' => []], 404);
    $sinceRaw = trim((string)($_GET['since'] ?? '0'));
    $since = is_numeric($sinceRaw) ? max(0, (int)$sinceRaw) : 0;
    $payload = live_cached_json('get_new_messages', [
        'chat_db_id' => (int)$chat['id'],
        'since' => $since,
    ]);
    if (!is_array($payload)) live_json(['messages' => [], 'read_ids' => []]);

    $messages = is_array($payload['messages'] ?? null) ? $payload['messages'] : [];
    $normalized = [];
    foreach ($messages as $message) {
        if (is_array($message)) $normalized[] = live_normalize_message($message, $chat);
    }
    $readIds = is_array($payload['read_ids'] ?? null) ? $payload['read_ids'] : [];
    $readIds = array_values(array_filter(array_map(
        static fn(mixed $id): string => substr((string)$id, 0, 512),
        $readIds
    ), static fn(string $id): bool => $id !== ''));
    live_json(['messages' => $normalized, 'read_ids' => $readIds]);
}

function live_active_message_reactions(?array $chat): never
{
    $messageId = trim((string)($_GET['message_id'] ?? ''));
    $source = strtolower((string)($chat['source'] ?? ''));
    $maxAllowed = $source === 'max' && preg_match('/^[1-9][0-9]{0,19}$/D', $messageId);
    if (!$chat || (!in_array($source, ['telegram', 'whatsapp'], true) && !$maxAllowed) || $messageId === '' || strlen($messageId) > 512) {
        live_json(['success' => false, 'message' => 'Некорректный запрос реакций.'], 400);
    }
    $payload = live_cached_json('get_message_reactions', [
        'source' => (string)$chat['source'],
        'chat_id' => (string)$chat['chat_id'],
        'message_id' => $messageId,
    ]);
    if (is_array($payload) && ($payload['success'] ?? false) === true) {
        // The standalone snapshot formerly bypassed live_normalize_message(),
        // so it could expose a different actor shape and raw cached avatar
        // path than history. Normalize it with the identical bridge context.
        $rawReactions = $payload['reactionsDetailed'] ?? $payload['reactions'] ?? [];
        $context = [
            'source' => (string)$chat['source'],
            'chat_id' => (string)$chat['chat_id'],
            'chat_db_id' => (int)($chat['id'] ?? 0),
            'chat_name' => (string)($chat['name'] ?? ''),
            'message_id' => $messageId,
        ];
        $payload = live_strip_asset_urls($payload);
        $payload['reactions'] = live_normalize_reactions($rawReactions, $context);
        unset($payload['reactionsDetailed']);
    }
    // The active bridge must never turn one missing reaction cache entry into
    // a full 50-message history request. That old fallback could occupy the
    // only local bridge worker for 10+ seconds and make pagination, media and
    // the composer appear frozen. A cache miss is explicit and cheap; it is
    // not evidence that the provider removed every reaction.
    if (live_is_active_bridge()) {
        if (is_array($payload) && ($payload['success'] ?? false) === true) live_json($payload);
        live_json([
            'success' => true,
            'reactions' => [],
            'known' => false,
            'reactions_snapshot' => false,
            'snapshot_complete' => false,
            'authoritative' => false,
            'cached' => false,
            'snapshot_origin' => 'cache-miss',
        ]);
    }
    // The legacy server has no `get_message_reactions` route yet and returns
    // an error-shaped JSON body with HTTP 404. Do not pass that shape through
    // as if it were a successful snapshot: render the cached aggregate
    // instead, then a user-initiated reaction can still use send_reaction.
    if (is_array($payload) && ($payload['success'] ?? false) === true) live_json($payload);

    foreach (live_local_messages($chat) as $message) {
        if ((string)($message['id'] ?? '') === $messageId) {
            // The local SQL mirror can be stale while WPPConnect is busy.
            // Keep its aggregate available for first paint, but mark it as a
            // cache result so the UI never mistakes an empty fallback for a
            // provider-confirmed removal of all reactions.
            live_json([
                'success' => true,
                'reactions' => $message['reactions'] ?? [],
                'reactions_snapshot' => false,
                'authoritative' => false,
                'cached' => true,
            ]);
        }
    }
    live_json([
        'success' => true,
        'reactions' => [],
        'reactions_snapshot' => false,
        'authoritative' => false,
        'cached' => true,
    ]);
}

function live_active_reaction_actor_avatar(?array $chat): never
{
    $actorId = live_media_scalar($_GET['actor_id'] ?? '', 128);
    $refresh = (string)($_GET['refresh'] ?? '') === '1';
    if (!$chat || strcasecmp((string)($chat['source'] ?? ''), 'Telegram') !== 0
        || !preg_match('/^-?[1-9][0-9]{0,18}$/D', $actorId)) {
        live_json(['success' => false, 'message' => 'Некорректный участник реакции.'], 400);
    }
    $payload = live_cached_json('get_reaction_actor_avatar', [
        'source' => 'Telegram',
        'chat_id' => (string)$chat['chat_id'],
        'db_id' => (int)$chat['id'],
        'actor_id' => $actorId,
        'refresh' => $refresh ? '1' : '0',
    ]);
    $rawAvatar = is_array($payload) ? live_media_scalar($payload['avatar'] ?? '', 4096) : '';
    $target = live_chat_avatar_target($rawAvatar);
    $avatar = $target === null ? '' : live_avatar_relay_url($target, [
        'source' => 'Telegram', 'chat_id' => (string)$chat['chat_id'],
        'chat_db_id' => (int)$chat['id'], 'actor_id' => $actorId, 'message_id' => 'reaction-avatar',
    ]);
    if ($avatar === '') {
        live_json(['success' => false, 'message' => 'Фото участника реакции недоступно.'], 404);
    }
    live_json(['success' => true, 'actor_id' => $actorId, 'avatar' => $avatar]);
}

/** @return list<array<string,mixed>> */
function live_local_messages(?array $chat): array
{
    $dbId = (int)($chat['id'] ?? 0);
    if ($dbId <= 0) return [];
    $payload = live_cached_json('get_local_messages', ['chat_db_id' => $dbId]);
    $messages = $payload['messages'] ?? [];
    if (!is_array($messages)) return [];
    return array_values(array_filter(array_map(
        static fn(mixed $message): mixed => is_array($message) ? live_normalize_message($message, $chat) : null,
        $messages
    ), static fn(mixed $message): bool => is_array($message)));
}

/**
 * Return only explicit reaction snapshots kept by the local mirror.  Provider
 * history and webhook state arrive independently, so a local row is merged
 * only when it names the exact native message id and explicitly confirms a
 * snapshot (including an empty list after removal).
 *
 * @return array<string,list<array<string,mixed>>>
 */
function live_local_reaction_snapshots(?array $chat): array
{
    $dbId = (int)($chat['id'] ?? 0);
    if ($dbId <= 0) return [];
    $payload = live_cached_json('get_local_messages', ['chat_db_id' => $dbId]);
    $messages = $payload['messages'] ?? [];
    if (!is_array($messages)) return [];
    $snapshots = [];
    foreach ($messages as $message) {
        if (!is_array($message) || ($message['reactionsKnown'] ?? false) !== true
            || !array_key_exists('reactions', $message) || !is_array($message['reactions'])) continue;
        $id = trim((string)($message['message_id'] ?? $message['id'] ?? ''));
        if ($id === '') continue;
        $context = [
            'source' => (string)($chat['source'] ?? ''),
            'chat_id' => (string)($chat['chat_id'] ?? ''),
            'chat_db_id' => $dbId,
            'chat_name' => (string)($chat['name'] ?? ''),
            'message_id' => $id,
        ];
        $snapshots[$id] = live_normalize_reactions($message['reactions'], $context);
    }
    return $snapshots;
}

/** @param list<array<string,mixed>> $messages @return list<array<string,mixed>> */
function live_merge_local_reaction_snapshots(array $messages, ?array $chat): array
{
    $snapshots = live_local_reaction_snapshots($chat);
    if (!$snapshots) return $messages;
    foreach ($messages as $index => $message) {
        if (!is_array($message)) continue;
        $id = trim((string)($message['id'] ?? $message['message_id'] ?? ''));
        if ($id === '' || !array_key_exists($id, $snapshots)) continue;
        $messages[$index]['reactions'] = $snapshots[$id];
        $messages[$index]['reactionsKnown'] = true;
    }
    return $messages;
}

/**
 * Use only the existing legacy history route and only after a chat identity
 * has been verified against the local chat list. This route is GET-only; all
 * state-changing requests remain denied by live_index().
 *
 * @return array{items:list<array<string,mixed>>,nextCursor:mixed,prevCursor:mixed,hasNextCursor:bool,pinnedMessage:?array{id:string,text:string,author_name:string}}|null
 */
function live_legacy_history(?array $chat): ?array
{
    if (!live_allows_legacy_history() || !$chat) return null;
    $source = trim((string)($chat['source'] ?? ''));
    $chatId = trim((string)($chat['chat_id'] ?? ''));
    if ($source === '' || $chatId === '') return null;

    $params = ['source' => $source, 'chat_id' => $chatId];
    $cursor = trim((string)($_GET['before_id'] ?? $_GET['cursor'] ?? ''));
    if ($cursor !== '' && strlen($cursor) <= 512) $params['before_id'] = $cursor;
    $payload = live_cached_json('get_messages_json', $params);
    if (!is_array($payload) || ($payload['success'] ?? true) === false) return null;

    $rawMessages = $payload['messages'] ?? [];
    $pinnedMessage = null;
    $items = [];
    // Old Madeline history responses are a plain list and paginate with the
    // oldest numeric message id supplied as `before_id`.  A missing cursor is
    // therefore different from an explicit `nextCursor: null`: the latter
    // means that a cursor-aware adapter has reached the beginning, while the
    // former means the UI must use the oldest rendered id for the next page.
    $hasNextCursor = array_key_exists('nextCursor', $payload);
    $nextCursor = $hasNextCursor ? $payload['nextCursor'] : null;
    $prevCursor = null;
    if (is_array($rawMessages) && array_is_list($rawMessages)) {
        $items = $rawMessages;
    } elseif (is_array($rawMessages)) {
        $items = is_array($rawMessages['items'] ?? null) ? $rawMessages['items'] : [];
        if (array_key_exists('nextCursor', $rawMessages)) {
            $hasNextCursor = true;
            $nextCursor = $rawMessages['nextCursor'];
        }
        $prevCursor = $rawMessages['prevCursor'] ?? null;
        $pinnedMessage = live_normalize_pinned_message($rawMessages['pinnedMessage'] ?? $rawMessages['pinned_message'] ?? null);
    }

    $normalized = [];
    foreach ($items as $item) {
        if (is_array($item)) $normalized[] = live_normalize_message($item, $chat);
    }
    $normalized = live_merge_local_reaction_snapshots($normalized, $chat);
    return [
        'items' => $normalized,
        'nextCursor' => $nextCursor,
        'prevCursor' => $prevCursor,
        'hasNextCursor' => $hasNextCursor,
        'pinnedMessage' => $pinnedMessage,
    ];
}

/** @return array{id:string,text:string,author_name:string}|null */
function live_normalize_pinned_message(mixed $value): ?array
{
    if (!is_array($value)) return null;
    $id = trim((string)($value['id'] ?? $value['message_id'] ?? ''));
    $text = trim((string)($value['text'] ?? ''));
    if (!preg_match('/^[1-9][0-9]{0,19}$/D', $id) || $text === '') return null;
    return [
        'id' => $id,
        'text' => mb_substr($text, 0, 1000),
        'author_name' => mb_substr(trim((string)($value['author_name'] ?? '')), 0, 160),
    ];
}

/** @return array<string,mixed> */
function live_history_response_payload(?array $chat): array
{
    $history = live_legacy_history($chat);
    if ($history !== null) {
        $response = [
            'success' => true,
            'readonly' => true,
            'legacy_history' => true,
            'messages' => [
                'items' => $history['items'],
                'prevCursor' => $history['prevCursor'],
            ],
        ];
        // Preserve the absence of a cursor for old plain lists. BaseChat then
        // correctly uses the oldest provider message id for the next page.
        if ($history['hasNextCursor']) {
            $response['messages']['nextCursor'] = $history['nextCursor'];
            $response['nextCursor'] = $history['nextCursor'];
        }
        if ($history['pinnedMessage'] !== null) $response['messages']['pinnedMessage'] = $history['pinnedMessage'];
        return $response;
    }

    return [
        'success' => true,
        'offline' => true,
        'messages' => [
            'items' => live_local_messages($chat),
            'nextCursor' => null,
            'prevCursor' => null,
        ],
        'nextCursor' => null,
    ];
}

function live_history_worker_history(): never
{
    if (!live_is_active_bridge() || strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) !== 'GET') {
        live_json(['success' => false, 'message' => 'История доступна только в рабочем интерфейсе.'], 405);
    }
    if (!live_history_worker_request_origin_allowed() || !live_valid_bridge_token()) {
        live_json(['success' => false, 'message' => 'Недействительный запрос истории.'], 403);
    }
    live_history_worker_apply_cors();

    // The session proves that this browser owns the bridge. It does not need
    // to remain locked while the worker reads history from the backend.
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    $chat = live_find_history_chat();
    if ($chat === null) {
        live_json(['success' => false, 'message' => 'Чат не найден в локальном кэше.'], 404);
    }
    $response = live_history_response_payload($chat);
    // Message normalization may have minted short-lived opaque media refs.
    // Persist them before sending the page, then release the lock promptly.
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    live_json($response);
}

function live_capabilities(): never
{
    $path = __DIR__ . '/config/provider-capabilities.json';
    $providers = is_file($path) ? json_decode((string)file_get_contents($path), true) : [];
    if (!is_array($providers)) $providers = [];
    if (!live_is_active_bridge()) {
        foreach ($providers as $name => $features) {
            if (!is_array($features)) continue;
            $features['reaction'] = [
                'state' => 'unavailable',
                'reason' => 'Реакции отключены в режиме проверки.',
            ];
            $features['attachment'] = [
                'state' => 'unavailable',
                'reason' => 'Загрузка вложений отключена в режиме проверки.',
            ];
            $providers[$name] = $features;
        }
    }
    $source = trim((string)($_GET['source'] ?? ''));
    if ($source === '') live_json(['success' => true, 'providers' => $providers]);
    foreach ($providers as $name => $features) {
        if (strcasecmp((string)$name, $source) === 0) {
            live_json(['success' => true, 'provider' => ['source' => $name, 'features' => $features]]);
        }
    }
    live_json(['success' => true, 'provider' => null]);
}

/** @param array<string,mixed> $ref */
function live_media_upstream_url(array $ref, bool $download): string
{
    $target = $ref['target'] ?? null;
    if (!is_array($target)) return '';
    $kind = (string)($target['kind'] ?? '');
    if ($kind === 'wa_preview') {
        $id = live_media_scalar($target['id'] ?? '', 512);
        if ($id === '') return '';
        return 'http://127.0.0.1:18080/index.php?' . http_build_query([
            'action' => 'wa_get_preview', 'id' => $id,
        ]);
    }
    if ($kind === 'wa') {
        $id = live_media_scalar($target['id'] ?? '', 512);
        if ($id === '') return '';
        return 'http://127.0.0.1:18080/index.php?' . http_build_query([
            'action' => 'wa_get_media', 'id' => $id,
            'name' => live_media_filename($target['name'] ?? 'file'),
            'mime' => live_media_scalar($target['mime'] ?? '', 160),
            'dl' => $download ? 1 : 0,
        ]);
    }
    if ($kind === 'telegram') {
        $chatId = live_media_scalar($target['chat_id'] ?? '', 512);
        $messageId = live_media_scalar($target['message_id'] ?? '', 64);
        if ($chatId === '' || !ctype_digit($messageId)) return '';
        if (($target['variant'] ?? 'media') === 'thumb') {
            return 'http://127.0.0.1:18080/telegram_service/rest.php?' . http_build_query([
                'action' => 'downloadThumb', 'chatId' => $chatId, 'messageId' => $messageId,
            ]);
        }
        return 'http://127.0.0.1:18080/telegram_download.php?' . http_build_query([
            'chat_id' => $chatId, 'message_id' => $messageId,
            'name' => live_media_filename($target['name'] ?? 'file'),
            'inline' => $download ? 0 : 1,
            'dl' => $download ? 1 : 0,
        ]);
    }
    if ($kind === 'max') {
        $ref = live_media_scalar($target['ref'] ?? '', 128);
        if (!preg_match('/^[A-Za-z0-9_-]{20,128}$/D', $ref)) return '';
        return 'http://127.0.0.1:18080/max_api.php?' . http_build_query([
            'resource' => 'media', 'ref' => $ref,
        ]);
    }
    if ($kind === 'stream') {
        $source = strtolower(live_media_scalar($ref['source'] ?? '', 32));
        $url = live_media_scalar($target['url'] ?? '', 4096);
        if (!live_media_external_url_allowed($url, $source)) return '';
        // Redirects, when needed, are resolved one verified hop at a time in
        // live_media_relay().  Do not call the legacy generic proxy here.
        return $url;
    }
    if ($kind === 'local') {
        $path = ltrim(live_media_scalar($target['path'] ?? '', 1024), '/');
        if ($path === '' || !preg_match('~^uploads/(?:wa_media|media)/[A-Za-z0-9._/-]+$~', $path)) return '';
        return 'http://127.0.0.1:18080/' . $path;
    }
    if ($kind === 'avatar') {
        $path = ltrim(live_media_scalar($target['path'] ?? '', 1024), '/');
        if (!preg_match('~^uploads/avatar/([A-Za-z0-9._-]+)$~', $path, $match)
            || !preg_match('~\.(?:jpe?g|png|webp|gif|avif)$~i', (string)$match[1])) return '';
        return 'http://127.0.0.1:18080/uploads/avatar/' . rawurlencode((string)$match[1]);
    }
    if ($kind === 'wa_avatar') {
        $url = live_media_scalar($target['url'] ?? '', 4096);
        return strtolower(live_media_scalar($ref['source'] ?? '', 32)) === 'whatsapp'
            && live_whatsapp_avatar_url_allowed($url) ? $url : '';
    }
    return '';
}

function live_media_normalize_redirect_path(string $path): string
{
    $trailingSlash = str_ends_with($path, '/');
    $segments = [];
    foreach (explode('/', $path) as $segment) {
        if ($segment === '' || $segment === '.') continue;
        if ($segment === '..') {
            array_pop($segments);
            continue;
        }
        $segments[] = $segment;
    }
    $normalized = '/' . implode('/', $segments);
    return $trailingSlash && $normalized !== '/' ? $normalized . '/' : $normalized;
}

/**
 * Resolve one Location value without ever contacting it.  The resulting URL
 * must pass the same source-specific policy as the initial VK/Avito URL.
 */
function live_media_resolve_redirect_url(string $base, string $location, string $source): ?string
{
    $base = live_media_scalar($base, 4096);
    $location = trim($location);
    if ($base === '' || $location === '' || strlen($location) > 4096
        || preg_match('/[\x00-\x20\x7F\\\\]/', $location)
        || !live_media_external_url_allowed($base, $source)) return null;
    $baseParts = @parse_url($base);
    if (!is_array($baseParts)) return null;
    $baseScheme = strtolower((string)($baseParts['scheme'] ?? ''));
    $baseHost = strtolower((string)($baseParts['host'] ?? ''));
    if ($baseScheme === '' || $baseHost === '') return null;
    $authority = $baseScheme . '://' . $baseHost;
    if (isset($baseParts['port'])) $authority .= ':' . (int)$baseParts['port'];

    // Fragments are client-side only and must not participate in the next
    // network request.
    $location = preg_replace('~#.*$~s', '', $location) ?? '';
    if ($location === '') return null;
    if (preg_match('~^https?://~i', $location)) {
        $candidate = $location;
    } elseif (str_starts_with($location, '//')) {
        $candidate = $baseScheme . ':' . $location;
    } else {
        // A different scheme (file:, data:, javascript:, or a malformed
        // variant) is never a relative HTTP location.
        if (preg_match('~^[a-z][a-z0-9+.-]*:~i', $location)) return null;
        $locationParts = @parse_url($location);
        if (!is_array($locationParts) || isset($locationParts['host']) || isset($locationParts['user']) || isset($locationParts['pass'])) {
            return null;
        }
        $path = (string)($locationParts['path'] ?? '');
        if ($path === '') {
            $resolvedPath = live_media_normalize_redirect_path((string)($baseParts['path'] ?? '/'));
        } elseif (str_starts_with($path, '/')) {
            $resolvedPath = live_media_normalize_redirect_path($path);
        } else {
            $basePath = (string)($baseParts['path'] ?? '/');
            $slash = strrpos($basePath, '/');
            $directory = $slash === false ? '/' : substr($basePath, 0, $slash + 1);
            $resolvedPath = live_media_normalize_redirect_path($directory . $path);
        }
        $candidate = $authority . $resolvedPath;
        if (array_key_exists('query', $locationParts)) $candidate .= '?' . (string)$locationParts['query'];
    }
    return live_media_external_url_allowed($candidate, $source) ? $candidate : null;
}

/**
 * Follow a short chain manually.  The injectable probe makes the policy
 * testable without reaching a provider and keeps cURL from auto-following an
 * unvalidated Location.
 */
function live_media_follow_redirects(string $url, string $source, callable $probe, int $maxRedirects = 4): string
{
    if ($maxRedirects < 0 || !live_media_external_url_allowed($url, $source)) return '';
    $seen = [];
    for ($hop = 0; $hop <= $maxRedirects; $hop++) {
        if (isset($seen[$url])) return '';
        $seen[$url] = true;
        try {
            $response = $probe($url);
        } catch (\Throwable) {
            return '';
        }
        if (!is_array($response)) return '';
        $status = (int)($response['status'] ?? 0);
        if (in_array($status, [301, 302, 303, 307, 308], true)) {
            if ($hop >= $maxRedirects) return '';
            $locations = $response['locations'] ?? null;
            if (!is_array($locations)) {
                $one = $response['location'] ?? null;
                $locations = is_string($one) ? [$one] : [];
            }
            if (count($locations) !== 1 || !is_string($locations[0])) return '';
            $next = live_media_resolve_redirect_url($url, $locations[0], $source);
            if ($next === null || isset($seen[$next])) return '';
            $url = $next;
            continue;
        }
        // A few provider CDNs decline HEAD.  The existing GET relay is still
        // allowed to try that already verified final URL.
        return in_array($status, [200, 206, 405, 501], true) ? $url : '';
    }
    return '';
}

/** @return array{status:int,locations:list<string>}|null */
function live_media_probe_redirect(string $url, bool $allowGetFallback = true): ?array
{
    if (!function_exists('curl_init')) return null;
    $probe = static function (bool $head) use ($url): ?array {
        $status = 0;
        $locations = [];
        $curl = curl_init($url);
        if ($curl === false) return null;
        $options = [
            CURLOPT_NOBODY => $head,
            CURLOPT_RETURNTRANSFER => false,
            CURLOPT_FOLLOWLOCATION => false,
            CURLOPT_CONNECTTIMEOUT => 5,
            CURLOPT_TIMEOUT => 15,
            CURLOPT_HTTPHEADER => ['Accept: */*'],
            CURLOPT_USERAGENT => 'UnifiedMessengerBridge/1.0',
            CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$status, &$locations): int {
                $trimmed = trim($line);
                if (preg_match('~^HTTP/\S+\s+(\d{3})~', $trimmed, $match)) {
                    $status = (int)$match[1];
                    $locations = [];
                    return strlen($line);
                }
                $pos = strpos($trimmed, ':');
                if ($pos !== false && strtolower(trim(substr($trimmed, 0, $pos))) === 'location') {
                    $value = trim(substr($trimmed, $pos + 1));
                    if ($value !== '') $locations[] = $value;
                }
                return strlen($line);
            },
        ];
        if (!$head) {
            // HEAD is not universally supported by provider CDNs. Ask for a
            // single byte and abort immediately after its first body chunk;
            // this still exposes a GET-only redirect without downloading the
            // media a second time.
            $options[CURLOPT_RANGE] = '0-0';
            $options[CURLOPT_WRITEFUNCTION] = static fn($handle, string $chunk): int => 0;
        }
        curl_setopt_array($curl, $options);
        $ok = curl_exec($curl);
        $responseCode = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        curl_close($curl);
        if ($ok === false && $responseCode === 0 && $status === 0) return null;
        return ['status' => $responseCode ?: $status, 'locations' => $locations];
    };
    $response = $probe(true);
    if ($allowGetFallback && $response !== null && in_array((int)($response['status'] ?? 0), [403, 405, 418, 501], true)) {
        // Some VK document/CDN endpoints reject HEAD (including with 418)
        // while allowing GET.
        // Keep the fallback bounded to a one-byte Range probe; every redirect
        // still passes the same source-host allowlist before the media GET.
        $getResponse = $probe(false);
        if ($getResponse !== null) return $getResponse;
    }
    return $response;
}

function live_media_safe_header(string $name, string $value): void
{
    $value = trim(str_replace(["\r", "\n"], '', $value));
    if ($value === '') return;
    if ($name === 'Content-Type' && !preg_match('~^[a-z0-9][a-z0-9.+-]*/[a-z0-9][a-z0-9.+-]*(?:\s*;.*)?$~i', $value)) return;
    if ($name === 'Content-Length' && !ctype_digit($value)) return;
    if ($name === 'Content-Range' && !preg_match('~^(?:bytes\s+\d+-\d+/(?:\d+|\*)|\*)$~i', $value)) return;
    if ($name === 'Accept-Ranges' && strtolower($value) !== 'bytes') return;
    if ($name === 'Content-Disposition') {
        $value = preg_replace('/[^\x20-\x7E]/', '', $value) ?? '';
        if ($value === '') return;
    }
    header($name . ': ' . $value, true);
}

function live_media_inline_content_type(string $value): bool
{
    $type = strtolower(trim((string)preg_split('/\s*;/', $value, 2)[0]));
    if ($type === 'image/svg+xml') return false;
    return str_starts_with($type, 'image/')
        || str_starts_with($type, 'video/')
        || str_starts_with($type, 'audio/');
}

function live_media_active_content_type(string $value): bool
{
    $type = strtolower(trim((string)preg_split('/\s*;/', $value, 2)[0]));
    return in_array($type, [
        'text/html', 'application/xhtml+xml', 'application/javascript',
        'text/javascript', 'application/xml', 'text/xml', 'image/svg+xml',
    ], true);
}

/**
 * Build a local byte-range plan only when an upstream cache ignored a valid
 * browser Range request.  Some historical WhatsApp/Telegram cache responses
 * advertise `Accept-Ranges: bytes` but return `200` and the whole file for
 * every request.  Native video players treat that combination as a broken
 * seek response.
 *
 * The relay can correct the response without trusting arbitrary headers: it
 * knows the complete upstream length, skips bytes locally and emits an exact
 * 206 range.  A genuine upstream 206 is deliberately left untouched.
 *
 * @return array{status:int,total:int,start?:int,end?:int,length?:int,skip?:int}|null
 */
function live_media_range_emulation_plan(string $range, int $upstreamStatus, ?int $upstreamLength, string $upstreamContentRange = ''): ?array
{
    $range = trim($range);
    if ($range === '' || $upstreamStatus !== 200 || $upstreamLength === null || $upstreamLength < 1 || trim($upstreamContentRange) !== '') {
        return null;
    }
    if (!preg_match('~^bytes=(?:(\d+)-(\d*)|-(\d+))$~', $range, $match)) return null;

    // The relay already bounds whole objects to 200 MiB.  Parsing relative to
    // the known total avoids integer overflow from a malformed huge range.
    $atMostTotal = static function (string $value, int $total): ?int {
        $digits = ltrim($value, '0');
        if ($digits === '') return 0;
        $totalDigits = (string)$total;
        if (strlen($digits) > strlen($totalDigits)) return null;
        if (strlen($digits) === strlen($totalDigits) && strcmp($digits, $totalDigits) > 0) return null;
        return (int)$digits;
    };

    $total = $upstreamLength;
    if (($match[3] ?? '') !== '') {
        $suffix = $atMostTotal((string)$match[3], $total);
        if ($suffix === 0) return ['status' => 416, 'total' => $total];
        // A suffix larger than the object is the complete object.
        if ($suffix === null) $suffix = $total;
        $start = max(0, $total - $suffix);
        $end = $total - 1;
    } else {
        $start = $atMostTotal((string)($match[1] ?? ''), $total);
        if ($start === null || $start >= $total) return ['status' => 416, 'total' => $total];
        $endValue = (string)($match[2] ?? '');
        if ($endValue === '') {
            $end = $total - 1;
        } else {
            // RFC 9110 permits an end beyond the object; cap it to the final
            // byte rather than rejecting an otherwise satisfiable request.
            $end = $atMostTotal($endValue, $total - 1);
            if ($end === null) $end = $total - 1;
        }
        if ($end < $start) return ['status' => 416, 'total' => $total];
    }

    return [
        'status' => 206,
        'total' => $total,
        'start' => $start,
        'end' => $end,
        'length' => $end - $start + 1,
        'skip' => $start,
    ];
}

/** Profile photos must remain raster images, never an active document. */
function live_avatar_content_type_allowed(string $value): bool
{
    return preg_match('~^image/(?:avif|gif|jpe?g|png|webp)(?:\s*;|$)~i', trim($value)) === 1;
}

/** @param array<string,mixed> $target */
function live_media_needs_heic_compat(array $target, bool $download, string $range): bool
{
    if ($download || $range !== '' || ($target['heic_compat'] ?? '') !== '1') return false;
    foreach ([$target['name'] ?? '', $target['url'] ?? ''] as $candidate) {
        $candidate = live_media_scalar($candidate, 4096);
        if ($candidate === '') continue;
        $path = (string)(parse_url($candidate, PHP_URL_PATH) ?? $candidate);
        if (preg_match('~\.(?:heic|heif)$~i', $path)) return true;
    }
    return false;
}

function live_media_heic_jpeg_filename(mixed $value): string
{
    $name = live_media_filename($value);
    if (preg_match('~\.(?:heic|heif)$~i', $name)) {
        return preg_replace('~\.(?:heic|heif)$~i', '.jpg', $name) ?: 'photo.jpg';
    }
    return $name . '.jpg';
}

function live_media_imagemagick_binary(): string
{
    static $resolved = null;
    if (is_string($resolved)) return $resolved;

    $configured = trim((string)getenv('UNIFIED_IMAGEMAGICK_BINARY'));
    if ($configured !== '' && is_file($configured)) return $resolved = $configured;

    $windows = strncasecmp(PHP_OS, 'WIN', 3) === 0;
    $candidates = [];
    if ($windows) {
        $candidates = array_merge(
            glob('C:/Program Files/ImageMagick*/magick.exe') ?: [],
            glob('C:/Program Files (x86)/ImageMagick*/magick.exe') ?: []
        );
        sort($candidates, SORT_NATURAL | SORT_FLAG_CASE);
        $candidates = array_reverse($candidates);
    }
    foreach (explode(PATH_SEPARATOR, (string)getenv('PATH')) as $directory) {
        $directory = trim($directory, " \t\"'");
        if ($directory === '') continue;
        $candidates[] = rtrim($directory, '/\\') . DIRECTORY_SEPARATOR . ($windows ? 'magick.exe' : 'magick');
    }
    $candidates[] = $windows ? 'magick.exe' : 'magick';
    foreach ($candidates as $candidate) {
        if (is_file($candidate) && ($windows || is_executable($candidate))) return $resolved = $candidate;
    }
    return $resolved = '';
}

function live_media_convert_heic_cli(string $source, string $destination): bool
{
    $binary = live_media_imagemagick_binary();
    if ($binary === '' || !function_exists('proc_open')) return false;
    $log = tempnam(sys_get_temp_dir(), 'unified-im-');
    if ($log === false) return false;
    $descriptors = [0 => ['pipe', 'r'], 1 => ['file', $log, 'ab'], 2 => ['file', $log, 'ab']];
    $command = [
        $binary, '-limit', 'memory', '512MiB', '-limit', 'map', '1024MiB',
        '-limit', 'disk', '1GiB', '-limit', 'thread', '2',
        $source . '[0]', '-auto-orient', '-strip', '-quality', '85', 'jpeg:' . $destination,
    ];
    $process = @proc_open($command, $descriptors, $pipes, null, null, ['bypass_shell' => true]);
    if (!is_resource($process)) {
        @unlink($log);
        return false;
    }
    if (isset($pipes[0]) && is_resource($pipes[0])) fclose($pipes[0]);
    $startedAt = microtime(true);
    $timedOut = false;
    do {
        $status = proc_get_status($process);
        if (!$status['running']) break;
        if (microtime(true) - $startedAt > 60) {
            $timedOut = true;
            @proc_terminate($process);
            break;
        }
        usleep(100000);
    } while (true);
    @proc_close($process);
    @unlink($log);
    if ($timedOut) return false;
    $size = @filesize($destination);
    if ((!is_int($size) && !is_float($size)) || $size < 4 || $size > 200 * 1024 * 1024) return false;
    $handle = @fopen($destination, 'rb');
    if ($handle === false) return false;
    $signature = fread($handle, 2);
    fclose($handle);
    return $signature === "\xFF\xD8";
}

/** @param array<string,mixed> $target @return array{type:string,length:int|null,name:string} */
function live_media_heic_representation(array $target): array
{
    $name = live_media_heic_jpeg_filename($target['name'] ?? 'photo');
    if (extension_loaded('imagick') || live_media_imagemagick_binary() !== '') {
        // The converted JPEG length is intentionally omitted for HEAD: it is
        // not known until the safe conversion occurs during GET.
        return ['type' => 'image/jpeg', 'length' => null, 'name' => $name];
    }
    return ['type' => 'application/json; charset=utf-8', 'length' => null, 'name' => $name];
}

function live_media_emit_heic_unavailable(): never
{
    live_json(['success' => false, 'message' => 'На сервере недоступна конвертация HEIC.'], 503);
}

/** @param array<string,mixed> $target */
function live_media_emit_heic_head(string $url, array $target): never
{
    // The final endpoint was already obtained through the checked redirect
    // walk immediately above. Do not repeat it here: a CDN that rejects HEAD
    // would force a GET fallback and violate HEAD's no-body semantics.
    unset($url);
    $representation = live_media_heic_representation($target);
    if ($representation['type'] !== 'image/jpeg') live_media_emit_heic_unavailable();
    http_response_code(200);
    header('Content-Type: ' . $representation['type']);
    if ($representation['length'] !== null) header('Content-Length: ' . $representation['length']);
    header('Content-Disposition: inline; filename="' . addcslashes($representation['name'], '\\\\"') . '"');
    header('Cache-Control: private, no-store');
    header('X-Content-Type-Options: nosniff');
    exit;
}

/**
 * Convert HEIC for inline display after `live_media_follow_redirects()`
 * has verified the
 * final provider URL.  This function never follows redirects itself and uses
 * a temporary file so a large image is not held in PHP memory.
 *
 * @param array<string,mixed> $target
 */
function live_media_relay_heic(string $url, array $target): never
{
    $maxBytes = 200 * 1024 * 1024;
    $tmp = tempnam(sys_get_temp_dir(), 'unified-heic-');
    if ($tmp === false) {
        live_json(['success' => false, 'message' => 'Временное хранилище медиа недоступно.'], 502);
    }
    $file = @fopen($tmp, 'wb');
    if ($file === false) {
        @unlink($tmp);
        live_json(['success' => false, 'message' => 'Временное хранилище медиа недоступно.'], 502);
    }

    $status = 0;
    $headersComplete = false;
    $bodyAllowed = false;
    $contentLength = null;
    $bytes = 0;
    $curl = curl_init($url);
    if ($curl === false) {
        @fclose($file);
        @unlink($tmp);
        live_json(['success' => false, 'message' => 'Медиа временно недоступно.'], 502);
    }
    curl_setopt_array($curl, [
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 180,
        CURLOPT_HTTPHEADER => ['Accept: image/heic,image/heif,image/*;q=0.8,*/*;q=0.1'],
        CURLOPT_USERAGENT => 'UnifiedMessengerBridge/1.0',
        CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$status, &$headersComplete, &$bodyAllowed, &$contentLength, $maxBytes): int {
            $trimmed = trim($line);
            if (preg_match('~^HTTP/\S+\s+(\d{3})~', $trimmed, $match)) {
                $status = (int)$match[1];
                $headersComplete = false;
                $bodyAllowed = false;
                $contentLength = null;
                return strlen($line);
            }
            if ($trimmed === '') {
                if ($status >= 100 && $status < 200) return strlen($line);
                if ($headersComplete) return strlen($line);
                $headersComplete = true;
                $bodyAllowed = $status === 200 && ($contentLength === null || $contentLength <= $maxBytes);
                return strlen($line);
            }
            $pos = strpos($trimmed, ':');
            if ($pos !== false && strtolower(trim(substr($trimmed, 0, $pos))) === 'content-length') {
                $value = trim(substr($trimmed, $pos + 1));
                if (ctype_digit($value)) $contentLength = (int)$value;
            }
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use ($file, &$bytes, $maxBytes, &$headersComplete, &$bodyAllowed): int {
            if (!$headersComplete || !$bodyAllowed || $bytes + strlen($chunk) > $maxBytes) return 0;
            $written = @fwrite($file, $chunk);
            if (!is_int($written) || $written !== strlen($chunk)) return 0;
            $bytes += $written;
            return $written;
        },
    ]);
    $ok = curl_exec($curl);
    $responseCode = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    @fclose($file);

    if ($ok === false || ($responseCode ?: $status) !== 200 || !$bodyAllowed || $bytes < 1) {
        @unlink($tmp);
        live_json(['success' => false, 'message' => 'Медиа временно недоступно.'], 502);
    }
    if (!extension_loaded('imagick') && live_media_imagemagick_binary() === '') {
        @unlink($tmp);
        live_media_emit_heic_unavailable();
    }

    $jpeg = tempnam(sys_get_temp_dir(), 'unified-heic-jpeg-');
    if ($jpeg === false) {
        @unlink($tmp);
        live_json(['success' => false, 'message' => 'Не удалось подготовить преобразование HEIC.'], 502);
    }
    try {
        if (extension_loaded('imagick')) {
            $image = new \Imagick();
            $image->readImage($tmp . '[0]');
            $image->setImageAutoOrient();
            $image->setImageFormat('jpeg');
            $image->setImageCompressionQuality(85);
            $image->stripImage();
            $image->writeImage($jpeg);
            $image->clear();
            $image->destroy();
        } elseif (!live_media_convert_heic_cli($tmp, $jpeg)) {
            throw new \RuntimeException('HEIC conversion failed');
        }
        $size = @filesize($jpeg);
        if (!is_int($size) && !is_float($size)) throw new \RuntimeException('Converted image is unavailable');
        if ($size < 1 || $size > $maxBytes) throw new \RuntimeException('Converted image size is invalid');
        $representation = live_media_heic_representation($target);
        http_response_code(200);
        header('Content-Type: ' . $representation['type']);
        header('Content-Length: ' . (string)$size);
        header('Content-Disposition: inline; filename="' . addcslashes($representation['name'], '\\\\"') . '"');
        header('Cache-Control: private, no-store');
        header('X-Content-Type-Options: nosniff');
        @readfile($jpeg);
    } catch (\Throwable) {
        @unlink($jpeg);
        @unlink($tmp);
        live_json(['success' => false, 'message' => 'Не удалось преобразовать фотографию HEIC.'], 502);
    }
    @unlink($jpeg);
    @unlink($tmp);
    exit;
}

function live_media_relay(bool $avatarOnly = false): never
{
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if (!in_array($method, ['GET', 'HEAD'], true) || !live_is_active_bridge()) {
        live_json(['success' => false, 'message' => 'Медиа-маршрут доступен только в рабочем интерфейсе.'], 405);
    }
    $id = live_media_scalar($_GET['ref'] ?? '', 96);
    if (!preg_match('/^[a-f0-9]{48}$/D', $id)) {
        live_json(['success' => false, 'message' => 'Недействительная ссылка на вложение.'], 404);
    }
    $refs = $avatarOnly ? live_avatar_references() : live_media_references();
    $sessionKey = $avatarOnly ? 'unified_bridge_avatar_refs' : 'unified_bridge_media_refs';
    $ref = $refs[$id] ?? null;
    if (!is_array($ref) || (int)($ref['expires_at'] ?? 0) < time()) {
        // A dedicated worker uses the same PHP session as the UI bridge, but
        // separate local ports can occasionally observe a delayed session
        // write during a concurrent history refresh. Retry this exact opaque
        // media handle once through the main bridge, which owns the session
        // update. The main route then serves it directly (no worker loop).
        // An actually expired or invalid reference still becomes a 404 there.
        if (!$avatarOnly && live_is_media_worker()) {
            $forward = ['ref' => $id, 'local' => '1'];
            if ((string)($_GET['dl'] ?? '') === '1') $forward['dl'] = '1';
            header('Cache-Control: no-store');
            header('Location: http://127.0.0.1:18085/bridge-media?' . http_build_query($forward, '', '&', PHP_QUERY_RFC3986), true, 307);
            exit;
        }
        unset($refs[$id]);
        $_SESSION[$sessionKey] = $refs;
        live_json(['success' => false, 'message' => 'Срок ссылки на вложение истёк. Обновите чат.'], 404);
    }
    $target = is_array($ref['target'] ?? null) ? $ref['target'] : [];
    $targetKind = (string)($target['kind'] ?? '');
    // MAX avatars use the same fixed opaque upstream type as MAX message
    // media.  The reference store, not a mutable URL flag, distinguishes the
    // avatar instance from an attachment instance.
    $isAvatarTarget = in_array($targetKind, ['avatar', 'wa_avatar'], true)
        || ($targetKind === 'stream' && (string)($target['avatar'] ?? '') === '1')
        || ($targetKind === 'max' && (string)($ref['message_id'] ?? '') === 'avatar');
    if ($avatarOnly !== $isAvatarTarget) {
        live_json(['success' => false, 'message' => 'Ссылка относится к другому типу ресурса.'], 404);
    }
    // Read-only support view for this session's exact media reference. Never
    // expose provider URLs, access tokens, local paths or another session's refs.
    if (!$avatarOnly && $method === 'GET' && (string)($_GET['info'] ?? '') === '1') {
        live_json([
            'success' => true,
            'source' => (string)($ref['source'] ?? ''),
            'chat_id' => (string)($ref['chat_id'] ?? ''),
            'chat_db_id' => (int)($ref['chat_db_id'] ?? 0),
            'message_id' => (string)($ref['message_id'] ?? ''),
            'media_kind' => $targetKind,
            'issued_at' => (int)($ref['issued_at'] ?? 0),
            'expires_at' => (int)($ref['expires_at'] ?? 0),
        ]);
    }
    // References are now copied locally. Release PHP's per-session lock
    // before redirect probing or a long media stream, otherwise the images
    // inside one album wait for one another for up to the cURL timeout.
    if (session_status() === PHP_SESSION_ACTIVE) session_write_close();
    $download = (string)($_GET['dl'] ?? '') === '1';
    $url = live_media_upstream_url($ref, $download);
    if ($url === '' || !function_exists('curl_init')) {
        live_json(['success' => false, 'message' => 'Медиа-маршрут временно недоступен.'], 502);
    }
    if ($targetKind === 'stream') {
        $source = strtolower(live_media_scalar($ref['source'] ?? '', 32));
        $resolvedUrl = live_media_follow_redirects(
            $url,
            $source,
            static fn(string $candidate): ?array => live_media_probe_redirect($candidate, $method !== 'HEAD')
        );
        if ($resolvedUrl === '') {
            live_json(['success' => false, 'message' => 'Медиа временно недоступно.'], 502);
        }
        $url = $resolvedUrl;
    }

    $range = trim((string)($_SERVER['HTTP_RANGE'] ?? ''));
    if ($range !== '' && !preg_match('~^bytes=(?:\d+-\d*|-\d+)$~', $range)) {
        live_json(['success' => false, 'message' => 'Некорректный диапазон файла.'], 416);
    }
    if (live_media_needs_heic_compat($target, $download, $range)) {
        if ($method === 'HEAD') live_media_emit_heic_head($url, $target);
        live_media_relay_heic($url, $target);
    }
    $requestHeaders = ['Accept: */*'];
    if ($range !== '') $requestHeaders[] = 'Range: ' . $range;
    // Avatar relay URLs are stable for the bridge session. Forward browser
    // validators to the local cache so a warm image can finish with 304 rather
    // than carrying the body again. Never forward arbitrary request headers.
    if ($avatarOnly) {
        $ifNoneMatch = trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''));
        if ($ifNoneMatch !== '' && preg_match('/^[\x20-\x7E]{1,512}$/D', $ifNoneMatch)) {
            $requestHeaders[] = 'If-None-Match: ' . $ifNoneMatch;
        }
        $ifModifiedSince = trim((string)($_SERVER['HTTP_IF_MODIFIED_SINCE'] ?? ''));
        if ($ifModifiedSince !== '' && preg_match('/^[\x20-\x7E]{1,512}$/D', $ifModifiedSince)) {
            $requestHeaders[] = 'If-Modified-Since: ' . $ifModifiedSince;
        }
    }

    $status = 0;
    $headersSent = false;
    $headersComplete = false;
    $bodyAllowed = false;
    $sentBytes = 0;
    $maxBytes = 200 * 1024 * 1024;
    $contentLength = null;
    $responseHeaders = [];
    // Populated only when a legacy cache ignores the client's valid Range
    // header and answers 200 with a full object.  In that narrow case the
    // local relay converts it to a standards-compliant 206 while preserving
    // real upstream 206 responses unchanged.
    $rangePlan = null;
    $rangeEmulationSkip = 0;
    $rangeEmulationRemaining = null;
    $curl = curl_init($url);
    curl_setopt_array($curl, [
        CURLOPT_CUSTOMREQUEST => $method,
        CURLOPT_NOBODY => $method === 'HEAD',
        CURLOPT_FOLLOWLOCATION => false,
        CURLOPT_CONNECTTIMEOUT => 10,
        CURLOPT_TIMEOUT => 180,
        CURLOPT_HTTPHEADER => $requestHeaders,
        CURLOPT_USERAGENT => 'UnifiedMessengerBridge/1.0',
        CURLOPT_HEADERFUNCTION => static function ($handle, string $line) use (&$status, &$headersSent, &$headersComplete, &$bodyAllowed, &$contentLength, &$responseHeaders, &$rangePlan, &$rangeEmulationSkip, &$rangeEmulationRemaining, $maxBytes, $download, $ref, $avatarOnly, $range, $method): int {
            $trimmed = trim($line);
            if (preg_match('~^HTTP/\S+\s+(\d{3})~', $trimmed, $match)) {
                $status = (int)$match[1];
                $headersComplete = false;
                $bodyAllowed = false;
                $contentLength = null;
                $responseHeaders = [];
                return strlen($line);
            }
            if ($trimmed === '') {
                // Continue responses precede the final status and never
                // carry a body for this request.
                if ($status >= 100 && $status < 200) return strlen($line);
                if ($headersComplete) return strlen($line);
                $headersComplete = true;
                if ($avatarOnly && $status === 304) {
                    http_response_code(304);
                    header('Cache-Control: private, max-age=3600');
                    header('X-Content-Type-Options: nosniff');
                    foreach ($responseHeaders as $name => $value) live_media_safe_header($name, $value);
                    $headersSent = true;
                    return strlen($line);
                }
                if (!in_array($status, [200, 206], true)) {
                    http_response_code($status === 416 ? 416 : 502);
                    header('Content-Type: text/plain; charset=utf-8');
                    header('Cache-Control: no-store');
                    echo 'Медиа временно недоступно';
                    $headersSent = true;
                    return strlen($line);
                }
                if ($contentLength !== null && $contentLength > $maxBytes) {
                    http_response_code(413);
                    header('Content-Type: text/plain; charset=utf-8');
                    header('Cache-Control: no-store');
                    echo 'Файл превышает допустимый размер.';
                    $headersSent = true;
                    return strlen($line);
                }
                $target = is_array($ref['target'] ?? null) ? $ref['target'] : [];
                $filename = live_media_filename($target['name'] ?? 'file');
                $contentType = (string)($responseHeaders['Content-Type'] ?? 'application/octet-stream');
                if ($avatarOnly && !live_avatar_content_type_allowed($contentType)) {
                    http_response_code(502);
                    header('Content-Type: text/plain; charset=utf-8');
                    header('Cache-Control: no-store');
                    header('X-Content-Type-Options: nosniff');
                    echo 'Аватар временно недоступен';
                    $headersSent = true;
                    return strlen($line);
                }
                if (live_media_active_content_type($contentType)) $contentType = 'application/octet-stream';
                $responseHeaders['Content-Type'] = $contentType;
                $responseHeaders['Content-Disposition'] = (!$download && live_media_inline_content_type($contentType) ? 'inline' : 'attachment')
                    . '; filename="' . addcslashes($filename, '\\\\"') . '"';
                $rangePlan = live_media_range_emulation_plan(
                    $range,
                    $status,
                    $contentLength,
                    (string)($responseHeaders['Content-Range'] ?? '')
                );
                if (is_array($rangePlan) && (int)($rangePlan['status'] ?? 0) === 416) {
                    http_response_code(416);
                    header('Content-Range: bytes */' . (string)$rangePlan['total']);
                    header('Content-Type: text/plain; charset=utf-8');
                    header('Cache-Control: no-store');
                    header('X-Content-Type-Options: nosniff');
                    if ($method !== 'HEAD') echo 'Запрошенный диапазон файла недоступен';
                    $headersSent = true;
                    return strlen($line);
                }
                if (is_array($rangePlan) && (int)($rangePlan['status'] ?? 0) === 206) {
                    $rangeEmulationSkip = (int)($rangePlan['skip'] ?? 0);
                    $rangeEmulationRemaining = (int)($rangePlan['length'] ?? 0);
                    $responseHeaders['Content-Length'] = (string)$rangeEmulationRemaining;
                    $responseHeaders['Content-Range'] = 'bytes ' . (string)$rangePlan['start']
                        . '-' . (string)$rangePlan['end'] . '/' . (string)$rangePlan['total'];
                    $responseHeaders['Accept-Ranges'] = 'bytes';
                    http_response_code(206);
                } else {
                    http_response_code($status);
                }
                header($avatarOnly ? 'Cache-Control: private, max-age=3600' : 'Cache-Control: private, no-store');
                header('X-Content-Type-Options: nosniff');
                foreach ($responseHeaders as $name => $value) live_media_safe_header($name, $value);
                $headersSent = true;
                $bodyAllowed = true;
                return strlen($line);
            }
            $pos = strpos($trimmed, ':');
            if ($pos === false) return strlen($line);
            $name = strtolower(trim(substr($trimmed, 0, $pos)));
            $value = trim(substr($trimmed, $pos + 1));
            if ($name === 'content-length' && ctype_digit($value)) $contentLength = (int)$value;
            $map = [
                'content-type' => 'Content-Type', 'content-length' => 'Content-Length',
                'content-range' => 'Content-Range', 'accept-ranges' => 'Accept-Ranges',
                'content-disposition' => 'Content-Disposition', 'etag' => 'ETag',
                'last-modified' => 'Last-Modified',
            ];
            if (isset($map[$name])) $responseHeaders[$map[$name]] = $value;
            return strlen($line);
        },
        CURLOPT_WRITEFUNCTION => static function ($handle, string $chunk) use (&$sentBytes, $maxBytes, &$headersComplete, &$bodyAllowed, &$rangeEmulationSkip, &$rangeEmulationRemaining): int {
            if (!$headersComplete || !$bodyAllowed) return 0;
            if ($rangeEmulationRemaining !== null) {
                $chunkLength = strlen($chunk);
                if ($rangeEmulationSkip > 0) {
                    if ($rangeEmulationSkip >= $chunkLength) {
                        $rangeEmulationSkip -= $chunkLength;
                        return $chunkLength;
                    }
                    $chunk = substr($chunk, $rangeEmulationSkip);
                    $rangeEmulationSkip = 0;
                }
                if ($rangeEmulationRemaining < 1) return 0;
                $take = min($rangeEmulationRemaining, strlen($chunk));
                if ($take < 1 || $sentBytes + $take > $maxBytes) return 0;
                echo $take === strlen($chunk) ? $chunk : substr($chunk, 0, $take);
                $sentBytes += $take;
                $rangeEmulationRemaining -= $take;
                if (function_exists('ob_flush')) @ob_flush();
                flush();
                // cURL receives a zero-length acknowledgement only after the
                // exact requested bytes reached the browser.  It then stops
                // the ignored-full-object upstream response immediately.
                return $rangeEmulationRemaining === 0 ? 0 : $chunkLength;
            }
            if ($sentBytes + strlen($chunk) > $maxBytes) return 0;
            $sentBytes += strlen($chunk);
            echo $chunk;
            if (function_exists('ob_flush')) @ob_flush();
            flush();
            return strlen($chunk);
        },
    ]);
    $ok = curl_exec($curl);
    $curlStatus = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    curl_close($curl);
    if (!$headersSent) {
        http_response_code(in_array($curlStatus, [200, 206], true) ? $curlStatus : 502);
        header('Content-Type: text/plain; charset=utf-8');
        header('Cache-Control: no-store');
        echo $ok === false ? 'Медиа временно недоступно' : '';
    }
    exit;
}

function live_index(): never
{
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    $action = (string)($_GET['action'] ?? $_POST['action'] ?? '');
    if ($method === 'POST' && live_is_active_bridge()) {
        live_active_post($action);
    }
    if ($method !== 'GET') {
        live_json(['success' => false, 'message' => 'Режим проверки не изменяет данные.'], 403);
    }

    if ($action === 'get_provider_capabilities') live_capabilities();
    if ($action === 'get_chats_json') live_json(['chats' => live_chats(), 'readonly' => true]);
    if ($action === 'get_chats_meta') live_json(['success' => true, 'readonly' => true]);
    if ($action === 'get_infrastructure_health') {
        $health = live_cached_json('get_infrastructure_health');
        if (!is_array($health)) {
            live_json(['success' => true, 'state' => 'unknown', 'updated_at' => 0, 'message' => 'Статус сервера временно недоступен.']);
        }
        live_json([
            'success' => true,
            'state' => in_array(($health['state'] ?? ''), ['healthy', 'critical', 'stale'], true) ? $health['state'] : 'unknown',
            'updated_at' => (int)($health['updated_at'] ?? 0),
            'message' => mb_substr((string)($health['message'] ?? ''), 0, 240),
            'history_recovery' => is_array($health['history_recovery'] ?? null) ? $health['history_recovery'] : [],
        ]);
    }
    if ($action === 'get_updated_chats') live_json(['updated_chats' => []]);
    if ($action === 'get_unread_count') {
        $unread = array_sum(array_map(static fn(array $chat): int => (int)($chat['unread_count'] ?? 0), live_chats()));
        live_json(['success' => true, 'unread_count' => $unread]);
    }
    if ($action === 'get_whatsapp_self_avatar') {
        $payload = live_cached_json('get_whatsapp_self_avatar');
        $rawAvatar = is_array($payload) ? live_media_scalar($payload['avatar'] ?? '', 4096) : '';
        $target = live_whatsapp_avatar_target($rawAvatar, 'WhatsApp');
        $avatar = $target === null ? '' : live_avatar_relay_url($target, [
            'source' => 'WhatsApp', 'chat_id' => 'self', 'message_id' => 'avatar',
        ]);
        live_json(['success' => true, 'avatar' => $avatar]);
    }
    if ($action === 'get_provider_self_profile') {
        $source = live_media_scalar($_GET['source'] ?? '', 32);
        if (!in_array(strtolower($source), ['whatsapp', 'telegram', 'max'], true)) {
            live_json(['success' => true, 'profile' => [
                'name' => 'Мой аккаунт', 'subtitle' => 'Мой аккаунт ' . $source,
                'avatar' => '', 'fields' => [],
            ]]);
        }
        $payload = live_cached_json('get_provider_self_profile', ['source' => $source]);
        $profile = is_array($payload) ? ($payload['profile'] ?? null) : null;
        if (!is_array($profile)) {
            live_json(['success' => true, 'profile' => [
                'name' => 'Мой ' . $source, 'subtitle' => 'Мой аккаунт ' . $source,
                'avatar' => '', 'fields' => [],
                'notice' => 'Сведения аккаунта временно недоступны.',
            ]]);
        }
        live_json(['success' => true, 'profile' => live_normalize_own_profile($profile, $source)]);
    }
    $chat = live_find_chat();
    if ($action === 'get_new_messages') {
        if (live_is_active_bridge()) live_active_new_messages($chat);
        live_json(['messages' => [], 'read_ids' => []]);
    }
    if ($action === 'get_message_reactions') {
        if (live_is_active_bridge()) live_active_message_reactions($chat);
        live_json(['success' => true, 'reactions' => []]);
    }
    if ($action === 'get_reaction_actor_avatar') {
        if (live_is_active_bridge()) live_active_reaction_actor_avatar($chat);
        live_json(['success' => false, 'message' => 'Загрузка аватаров отключена в режиме проверки.'], 403);
    }
    if ($action === 'get_send_job') {
        if (live_is_active_bridge()) live_active_send_job();
        live_json(['success' => false, 'message' => 'Задачи отправки отключены в режиме проверки.'], 405);
    }
    if ($action === 'get_chat_details') {
        if (!$chat) live_json(['success' => false, 'message' => 'Чат не найден в локальном кэше.'], 404);
        live_json(['success' => true, 'chat' => $chat]);
    }
    if ($action === 'get_telegram_discussion') {
        $chat = live_find_chat();
        $post = live_media_scalar($_GET['message_id'] ?? '', 20);
        if (!$chat || strtolower((string)$chat['source']) !== 'telegram' || !preg_match('/^[1-9][0-9]*$/D', $post)) live_json(['success' => false], 400);
        $result = live_cached_json($action, ['chat_id' => (string)$chat['chat_id'], 'message_id' => $post, 'before' => live_media_scalar($_GET['before'] ?? '', 20)]);
        if (empty($result['success']) || !is_array($result['discussion'] ?? null)) live_json(['success' => false, 'message' => 'Комментарии временно недоступны.'], 502);
        $page = $result['discussion']; $context = $chat; $context['chat_id'] = (string)($page['chat_id'] ?? '');
        $page['items'] = array_map(fn($item) => live_normalize_message($item, $context), $page['items'] ?? []);
        live_json(['success' => true, 'discussion' => $page]);
    }
    if ($action === 'get_message_sender_profile') {
        $source = live_media_scalar($_GET['source'] ?? '', 32);
        $userId = live_media_scalar($_GET['user_id'] ?? '', 32);
        $chat = live_find_chat();
        if (!in_array(strtolower($source), ['max', 'telegram'], true) || !preg_match('/^[1-9][0-9]{0,19}$/D', $userId) || !$chat || strtolower((string)($chat['source'] ?? '')) !== strtolower($source)) {
            live_json(['success' => false, 'message' => 'Профиль участника недоступен для этого чата.'], 400);
        }
        $payload = live_cached_json('get_message_sender_profile', ['source' => $source, 'user_id' => $userId]);
        $raw = is_array($payload) ? ($payload['profile'] ?? null) : null;
        if (!is_array($raw)) live_json(['success' => false, 'message' => 'Профиль участника временно недоступен.'], 502);
        $rawAvatar = live_media_scalar($raw['avatar'] ?? '', 4096);
        $target = live_max_avatar_target($rawAvatar, $source) ?? live_chat_avatar_target($rawAvatar);
        $avatar = $target === null ? '' : live_avatar_relay_url($target, [
            'source' => $source, 'chat_id' => (string)($chat['chat_id'] ?? ''),
            'message_id' => 'sender-profile', 'actor_id' => $userId,
        ]);
        $fields = [];
        foreach ((array)($raw['fields'] ?? []) as $field) {
            if (!is_array($field) || count($fields) >= 12) continue;
            $label = live_media_scalar($field['label'] ?? '', 96);
            $value = live_media_scalar($field['value'] ?? '', 512);
            if ($label !== '' && $value !== '') $fields[] = ['label' => $label, 'value' => $value];
        }
        live_json(['success' => true, 'profile' => [
            'id' => $userId,
            'name' => live_media_scalar($raw['name'] ?? '', 160) ?: ('Пользователь ' . $source),
            'subtitle' => live_media_scalar($raw['subtitle'] ?? '', 96) ?: ('Пользователь ' . $source),
            'avatar' => $avatar,
            'avatar_available' => $avatar !== '',
            'fields' => $fields,
            'origin' => 'provider',
        ]]);
    }
    if ($action === 'get_contact_profile') {
        $refresh = (string)($_GET['refresh'] ?? '');
        if (!in_array($refresh, ['', '1'], true)) {
            live_json(['success' => false, 'message' => 'Некорректный режим обновления профиля.'], 400);
        }
        // A profile is supplementary UI. The title and avatar are already
        // available in the opened row, so an unavailable provider must never
        // turn the entire modal into a generic error. The initial request
        // stays cache-first; only an explicit refresh may use the fixed WPP
        // contact route with a short independent timeout.
        if (!$chat) {
            $source = trim((string)($_GET['source'] ?? ''));
            live_json(['success' => true, 'profile' => [
                'name' => '',
                'subtitle' => substr($source, 0, 64),
                'avatar' => '',
                'fields' => [],
                'notice' => 'Дополнительные сведения временно недоступны. Показаны данные открытого диалога.',
                'origin' => 'saved',
                'can_refresh' => false,
            ]]);
        }
        live_json(['success' => true, 'profile' => live_contact_profile_response($chat, $refresh === '1')]);
    }
    if ($action === 'get_local_messages') live_json(['messages' => live_local_messages($chat)]);
    if ($action === 'get_messages_json') {
        live_json(live_history_response_payload($chat));
    }

    live_json(['success' => false, 'message' => 'Этот запрос отключён в режиме проверки.'], 405);
}

$path = parse_url($_SERVER['REQUEST_URI'] ?? '/', PHP_URL_PATH) ?: '/';
if (live_is_history_worker()) {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') live_history_worker_preflight();
    if (!live_history_worker_request_origin_allowed()) {
        live_json(['success' => false, 'message' => 'История доступна только локальному интерфейсу.'], 403);
    }
    live_history_worker_apply_cors();
    if ($path === '/bridge-history') live_history_worker_history();
    live_json(['success' => false, 'message' => 'Этот worker обслуживает только историю.'], 404);
}
if (live_is_media_worker()) {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'OPTIONS') live_media_worker_preflight();
    if (!live_media_worker_request_origin_allowed()) {
        live_json(['success' => false, 'message' => 'Медиа-маршрут доступен только локальному интерфейсу.'], 403);
    }
    live_media_worker_apply_cors();
    if ($path === '/bridge-media') live_media_relay();
    live_json(['success' => false, 'message' => 'Этот worker обслуживает только медиа.'], 404);
}
if ($path === '/') {
    header('Location: ' . (live_is_active_bridge() ? '/main.php' : '/main.php?preview=1'), true, 302);
    exit;
}
if ($path === '/bridge-media') {
    // A worker can fall back once when it did not yet observe the main
    // bridge's session update. Do not send that retry into the worker pool.
    if (live_is_active_bridge() && (string)($_GET['local'] ?? '') === '1') {
        // The browser started at a media-worker origin and followed its 307
        // to this main bridge. A fetch response still needs CORS permission
        // from that original cross-port request, even though this final hop
        // is the canonical UI origin.
        if (trim((string)($_SERVER['HTTP_ORIGIN'] ?? '')) === 'http://127.0.0.1:18085') {
            header('Access-Control-Allow-Origin: http://127.0.0.1:18085');
            header('Access-Control-Allow-Credentials: true');
            header('Access-Control-Expose-Headers: Content-Type, Content-Length, Content-Range, Content-Disposition, Accept-Ranges');
            header('Vary: Origin');
        }
        live_media_relay();
    }
    live_delegate_media_request($path);
    live_media_relay();
}
if ($path === '/bridge-avatar') live_media_relay(true);
if ($path === '/index.php') live_index();
if ($path === '/wpp_status.php') {
    if (!live_is_active_bridge()) live_json(['success' => false, 'message' => 'WhatsApp-авторизация отключена в режиме проверки.'], 403);
    live_active_wpp_status();
}
if ($path === '/wpp_link_code.php') {
    if (!live_is_active_bridge()) live_json(['success' => false, 'message' => 'WhatsApp-авторизация отключена в режиме проверки.'], 403);
    live_active_wpp_link_code();
}
if ($path === '/ai_api.php') {
    if (!live_is_active_bridge() || !live_valid_bridge_token() || ($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') live_json(['success'=>false,'message'=>'Запрос запрещён'],403);
    $raw = file_get_contents('php://input', false, null, 0, 262145);
    if (strlen($raw) > 262144) live_json(['success'=>false,'message'=>'Слишком большой запрос'],413);
    $input = json_decode($raw, true);
    if (!is_array($input)) live_json(['success'=>false,'message'=>'Неверный JSON'],422);
    live_forward_legacy_json_route('ai_api.php','POST',[],$input,60);
}
if (in_array($path, ['/provider_logout.php', '/wpp_proxy.php'], true)) {
    if (!live_is_active_bridge() || !live_valid_bridge_token() || ($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') live_json(['success'=>false,'message'=>'Запрос запрещён'],403);
    $input = json_decode((string)file_get_contents('php://input'), true);
    if (!is_array($input) || ($input['confirmed'] ?? false) !== true || ($input['action'] ?? '') !== 'logout') live_json(['success'=>false,'message'=>'Подтвердите выход'],422);
    if ($path === '/wpp_proxy.php') live_forward_legacy_json_route('wpp_proxy.php','POST',['action'=>'logout'],['confirmed'=>true],45);
    $provider = (string)($input['provider'] ?? '');
    if (!in_array($provider,['vk','avito'],true)) live_json(['success'=>false,'message'=>'Неизвестный сервис'],422);
    live_forward_legacy_json_route('provider_logout.php','POST',[],['provider'=>$provider,'confirmed'=>true],30);
}
if ($path === '/telegram_auth.php') {
    if (!live_is_active_bridge()) live_json(['success' => false, 'message' => 'Telegram-авторизация отключена в режиме проверки.'], 403);
    live_active_telegram_auth();
}
if ($path === '/max_auth.php') {
    if (!live_is_active_bridge()) live_json(['success' => false, 'message' => 'Авторизация MAX отключена в режиме проверки.'], 403);
    live_active_max_auth();
}
if ($path === '/max_api.php') {
    if (!live_is_active_bridge()) live_json(['success' => false, 'message' => 'MAX отключён в режиме проверки.'], 403);
    live_active_max_api();
}
if ($path === '/telegram_service/rest.php') {
    if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'GET') {
        live_json(['success' => false, 'message' => 'Фоновый Telegram REST-запрос отключён в bridge.'], 405);
    }
    live_json(['success' => true, 'data' => []]);
}

if ($path === '/main.php') {
    if (!in_array($_SERVER['REQUEST_METHOD'] ?? 'GET', ['GET', 'HEAD'], true)) {
        live_json(['success' => false, 'message' => 'Режим проверки доступен только для чтения.'], 405);
    }
    if (!live_is_active_bridge() && ($_GET['preview'] ?? '') !== '1') {
        $query = $_GET;
        $query['preview'] = '1';
        header('Location: /main.php?' . http_build_query($query), true, 302);
        exit;
    }
    if (live_is_active_bridge() && isset($_GET['preview'])) {
        $query = $_GET;
        unset($query['preview']);
        header('Location: /main.php' . ($query ? '?' . http_build_query($query) : ''), true, 302);
        exit;
    }
    live_apply_csp();
    return false;
}

// Keep local UI assets in the browser cache and revalidate them by content.
// This avoids retransferring every module on reload while still picking up
// edits immediately, including modules imported without a version query.
if (preg_match('~^/(?:js/src|js/vendor)/[A-Za-z0-9_./-]+\.(?:js|css|woff2?|ttf|otf|svg|png|jpe?g|webp|gif|ico)$~i', $path)) {
    $assetPrefix = str_starts_with($path, '/js/src/') ? '/js/src' : '/js/vendor';
    $root = realpath(__DIR__ . $assetPrefix);
    $file = realpath(__DIR__ . $path);
    if ($root !== false && $file !== false && str_starts_with($file, $root . DIRECTORY_SEPARATOR) && is_file($file)) {
        $extension = strtolower(pathinfo($file, PATHINFO_EXTENSION));
        $mimeTypes = [
            'js' => 'application/javascript; charset=utf-8',
            'css' => 'text/css; charset=utf-8',
            'woff' => 'font/woff',
            'woff2' => 'font/woff2',
            'ttf' => 'font/ttf',
            'otf' => 'font/otf',
            'svg' => 'image/svg+xml',
            'png' => 'image/png',
            'jpg' => 'image/jpeg',
            'jpeg' => 'image/jpeg',
            'webp' => 'image/webp',
            'gif' => 'image/gif',
            'ico' => 'image/x-icon',
        ];
        $etag = '"' . hash_file('sha256', $file) . '"';
        $modifiedAt = filemtime($file);
        header('Content-Type: ' . ($mimeTypes[$extension] ?? 'application/octet-stream'));
        header('Cache-Control: private, no-cache');
        header('ETag: ' . $etag);
        if ($modifiedAt !== false) header('Last-Modified: ' . gmdate('D, d M Y H:i:s', $modifiedAt) . ' GMT');
        $ifNoneMatch = trim((string)($_SERVER['HTTP_IF_NONE_MATCH'] ?? ''));
        $notModified = $ifNoneMatch !== ''
            ? in_array($etag, array_map('trim', explode(',', $ifNoneMatch)), true)
            : ($modifiedAt !== false && isset($_SERVER['HTTP_IF_MODIFIED_SINCE'])
                && strtotime((string)$_SERVER['HTTP_IF_MODIFIED_SINCE']) >= $modifiedAt);
        if ($notModified) {
            http_response_code(304);
            exit;
        }
        readfile($file);
        exit;
    }
}

// Default-deny executable endpoints. Static workspace assets remain available.
if (preg_match('~\.php$~i', $path) || preg_match('~^/(?:uploads|runtime|cache|tmp)/~i', $path)) {
    live_json(['success' => false, 'message' => 'Этот маршрут отключён в режиме проверки.'], 403);
}

return false;
