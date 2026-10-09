<?php
declare(strict_types=1);
require_once __DIR__ . "/dialog_folders.php";
require_once __DIR__ . "/message_peer.php";
require_once __DIR__ . '/media_cache.php';

// Binary media responses must never contain a PHP warning or stack trace.
// Application failures are still logged and reported as JSON before headers
// are committed.
ini_set('display_errors', '0');
ini_set('display_startup_errors', '0');
error_reporting(E_ALL);

/**
 * REST API для Telegram (MadelineProto) с защёлками от гонок и X-Accel-Redirect
 * ФИНАЛЬНАЯ ВЕРСИЯ с пакетным получением данных и всеми функциями.
 */

// This handler can be embedded by the authenticated desktop facade, which has
// already loaded the shared configuration. A second plain require emits PHP
// warnings before an image/video response and corrupts its binary body.
require_once dirname(__DIR__) . '/config.php';
require_once __DIR__ . '/media_range.php';
require_once __DIR__ . '/send_result_helpers.php';
require_once __DIR__ . '/album_checkpoint.php';

const SESSION = '/opt/unified-messenger/runtime/telegram/session.madeline';
const TMPDIR  = '/opt/unified-messenger/runtime/telegram/tmp';
// A cancelled browser seek must not keep occupying the Telegram session just
// to finish a response nobody will read.  Locks are released by finally and
// the shutdown safety net below.
ignore_user_abort(false);
@set_time_limit(0);

ini_set('log_errors', '1');
ini_set('error_log', '/opt/unified-messenger/runtime/telegram/tmp/rest_errors.log');
if (!function_exists('rlog')) {
    function rlog(string $msg): void
    {
        error_log(date('c') . ' [REST] ' . $msg);
    }
}
if (!is_dir(TMPDIR)) {
    @mkdir(TMPDIR, 0775, true);
}

const CACHE_DIR = TMPDIR . '/cache';
// Keep Telegram avatars in the application's public uploads directory so the
// main UI can display them through the same origin as VK/Avito/WhatsApp.
const AVA_DIR   = '/opt/unified-messenger/uploads/avatar';
const AVA_URL   = 'uploads/avatar';

define('BASE_URL_MADELINE', rtrim($_ENV['TELEGRAM_API_URL'] ?? 'http://127.0.0.1:8090', '/') . '/');
// === Media grouping (Telegram) ===
define('TG_MEDIA_GROUP_WINDOW_SEC', 6);
if (!defined('TG_ALBUM_WINDOW_SEC')) {
    define('TG_ALBUM_WINDOW_SEC', TG_MEDIA_GROUP_WINDOW_SEC);
}
// === Webhook Album Buffering (like WhatsApp) ===
// The final destination URL where completed albums and single messages will be sent.
// Telegram service and the PHP application live on the same host.  Calling the
// local endpoint keeps delivery independent from the retired public webhook DNS.
define('FINAL_WEBHOOK_URL', 'http://127.0.0.1:8080/webhook_telegram.php');
// Directory to store temporary album bucket files.
define('TG_ALBUM_BUCKET_DIR', TMPDIR . '/tg_album_buckets');

// === Telegram media helpers (публичные ссылки как в WhatsApp) ===

// ---------- Media cache helpers (тот же ключ, что и /pub: sha1(peer#mid)) ----------
// (1) key helper
if (!function_exists('tg_cache_key')) {
    function tg_cache_key(string $peer, $mid): string {
        return sha1($peer . '#' . $mid);
    }
}

if (!function_exists('tg_invalidate_media_cache')) {
    // (2) single, guarded definition
    function tg_invalidate_media_cache(string $peer, int $mid): void {
        $cacheDir = rtrim(TMPDIR, '/') . '/cache';
        $key = tg_cache_key($peer, $mid);
        $paths = [
            $cacheDir . '/' . $key,           // оригинал
            $cacheDir . '/' . $key . '.meta.json',
            $cacheDir . '/th_' . $key . '.jpg'// превью
        ];
        foreach ($paths as $p) {
            if (is_file($p)) { @unlink($p); }
        }
    }
}

// (3) add v= helper
// Удобняшка: добавляет v= к URL, если его ещё нет
function add_v_param(string $url, $v): string {
    if (!$v) return $url;
    $hasQ = (strpos($url, '?') !== false);
    return $url . ($hasQ ? '&' : '?') . 'v=' . rawurlencode((string)$v);
}



/**
 * Extracts a message array from any kind of update structure.
 */
function extract_message_from_update(array $update): ?array
{
    $type = $update['_'] ?? '';
        if (in_array($type, [
        'updateNewMessage',
        'updateNewChannelMessage',
        'updateNewScheduledMessage',
        // ⬇️ добавили обработку редактирований
        'updateEditMessage',
        'updateEditChannelMessage'
    ], true)) {
        return $update['message'] ?? null;
    }
    if (in_array($type, ['updateShortMessage', 'updateShortChatMessage'])) {
        return $update;
    }
    return null;
}

/**
 * Converts a peer_id array into a canonical string chatId.
 */
function canonical_chat_id($peer_id): ?string
{
    // 🔧 NEW: поддержка числовых значений из апдейтов (peer_id как int/строка)
    if (is_int($peer_id)) {
        return (string)$peer_id; // user
    }
    if (is_string($peer_id) && ctype_digit($peer_id)) {
        return $peer_id; // user
    }

    if (!is_array($peer_id)) return null;
    $type = $peer_id['_'] ?? '';
    if ($type === 'peerUser' && isset($peer_id['user_id'])) {
        return (string)$peer_id['user_id'];
    }
    if ($type === 'peerChat' && isset($peer_id['chat_id'])) {
        return '-' . $peer_id['chat_id'];
    }
    if ($type === 'peerChannel' && isset($peer_id['channel_id'])) {
        return '-100' . $peer_id['channel_id'];
    }
    return null;
}

/**
 * Sends the completed album payload to the final destination webhook.
 * @return bool True on success (HTTP 2xx), false otherwise.
 */
function tg_send_album_payload(string $gid, array $bucket): bool
{
    if (empty($bucket['items'])) {
        return true; // Nothing to send, count as success.
    }

    // Build a payload compatible with the WhatsApp webhook format
    $payload = [
        'type'              => 'album_completed',
        'group_id'          => $gid,
        'chatId'            => $bucket['meta']['chatId'] ?? null,
        'from'              => $bucket['meta']['chatId'] ?? null,
        'to'                => null, // 'to' is not readily available in Telegram group context
        'direction'         => $bucket['meta']['direction'] ?? 'in',
        'kind'              => $bucket['meta']['kind'] ?? null,
        'timestamp_first'   => $bucket['meta']['timestamp_first'] ?? 0,
        'timestamp_last'    => $bucket['meta']['timestamp_last'] ?? 0,
        'count'             => count($bucket['items']),
        'items'             => $bucket['items'],
        'client_uid'        => $bucket['meta']['client_uid'] ?? null, // <— читаем из метаданных
    ];

    try {
        $ch = curl_init(FINAL_WEBHOOK_URL);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10); // 10-second timeout
        $response = curl_exec($ch);
        $http_code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($http_code >= 200 && $http_code < 300) {
            log_err('[ALBUM] Flushed successfully', ['gid' => $gid, 'count' => count($bucket['items'])]);
            return true;
        } else {
            log_err('[ALBUM] POST failed', ['gid' => $gid, 'http_code' => $http_code, 'response' => $response]);
            return false;
        }
    } catch (\Throwable $e) {
        log_err('[ALBUM] POST fatal error', ['gid' => $gid, 'error' => $e->getMessage()]);
        return false;
    }
}

/**
 * Scans the bucket directory and flushes any albums that haven't been updated
 * within the TG_ALBUM_WINDOW_SEC. This acts as a watchdog.
 */
function tg_flush_expired_albums(): void
{
    if (!is_dir(TG_ALBUM_BUCKET_DIR)) {
        return;
    }

    // Глобальный lock: только один watchdog одновременно
    $globalLock = TG_ALBUM_BUCKET_DIR . '/.watchdog.lock';
    [$gfh, $gok] = acquire_lock($globalLock, 1);
    if (!$gok) return;

    try {
        $now = time();
        $files = glob(TG_ALBUM_BUCKET_DIR . '/*.json');
        if (empty($files)) return;

        foreach ($files as $file) {
            if (!is_file($file)) continue;

            $gidSafe = basename($file, '.json');
            $mtime   = @filemtime($file) ?: 0;

            if (($now - $mtime) <= TG_ALBUM_WINDOW_SEC) {
                continue; // ещё не истекло окно
            }

            // Атомарно «забираем» файл на флаш: только один процесс сможет
            $flushing = $file . '.flushing';
            if (!@rename($file, $flushing)) {
                // другой процесс уже обрабатывает
                continue;
            }

            // Дальше файл принадлежит нам: читаем и шлём
            $content = @file_get_contents($flushing);
            $bucket  = $content ? json_decode($content, true) : null;

            if (is_array($bucket) && !empty($bucket['items'])) {
                $gidRaw = $bucket['meta']['group_id'] ?? ($bucket['meta']['chatId'] ?? '') . ':' . ($bucket['meta']['kind'] ?? '') . ':' . ($bucket['meta']['timestamp_first'] ?? '');
                if (tg_send_album_payload($gidRaw, $bucket)) {
                    @unlink($flushing);
                    log_err('[ALBUM] Watchdog flushed album', ['gid_raw' => $gidRaw, 'gid_safe' => $gidSafe, 'count' => count($bucket['items'])]);
                } else {
                    // Оставляем .flushing для повторной попытки в следующий прогон
                    log_err('[ALBUM] Watchdog flush failed', ['gid_raw' => $gidRaw, 'gid_safe' => $gidSafe]);
                }
            } else {
                @unlink($flushing);
                log_err('[ALBUM] Watchdog removed empty/invalid bucket', ['gid_safe' => $gidSafe]);
            }
        }
    } finally {
        release_lock($gfh);
        @unlink($globalLock);
    }
}


/**
 * Processes a single normalized message for the webhook.
 * - If it's a groupable media item, it's added to a temporary bucket file.
 * - Otherwise, it's sent immediately to the final webhook URL.
 */
// ЗАМЕНИТЕ ВСЮ ФУНКЦИЮ ЦЕЛИКОМ
// ЗАМЕНИТЕ ВСЮ ФУНКЦИЮ ЦЕЛИКОМ НА ЭТОТ ВАРИАНТ
function tg_process_for_webhook(array $cleanMsg, ?string $clientUid): void
{
    // Persist every native message immediately. The shared UI groups by
    // media_group_id; album_completed is not a Telegram message contract.
    // In particular a single photo must never disappear into an album bucket.
    // Если апдейт — «реакции-только», помечаем отдельным типом и НИКОГДА не считаем edited
    if (($cleanMsg['_update_type'] ?? null) === 'updateMessageReactions') {
        $payloadType = 'message_reactions';
        // гарантия: не зажигаем edited
        $cleanMsg['edited']    = false;
        $cleanMsg['edit_date'] = $cleanMsg['edit_date'] ?? null;
    } else {
        $payloadType = (!empty($cleanMsg['edited'])) ? 'message_edited' : 'message_single';
    }

    $payload = [
        'type'       => $payloadType,
        'normalized' => $cleanMsg,
        'client_uid' => $clientUid,
    ];

    try {
        $ch = curl_init(FINAL_WEBHOOK_URL);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload));
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($code >= 200 && $code < 300) {
            log_err('[SINGLE] POST ok', [
                'id' => $cleanMsg['id'] ?? null,
                'http_code' => $code
            ]);
        } else {
            throw new \RuntimeException('Telegram final webhook rejected message: HTTP ' . $code);
        }
    } catch (\Throwable $e) {
        // Propagate failure to the durable listener queue. Never acknowledge
        // an event whose database write has not succeeded.
        throw new \RuntimeException('Telegram message persistence failed', 0, $e);
    }
    return;
}



// Маппинг MIME -> расширение, нужно для X-Accel-Redirect e-варианта
function tg_ext_by_mime(string $mime): string
{
    static $map = [
        'image/jpeg' => '.jpg',
        'image/png'  => '.png',
        'image/webp' => '.webp',
        'image/gif'  => '.gif',
        'video/mp4'  => '.mp4',
        'video/webm' => '.webm',
        'audio/ogg'  => '.ogg',
        'audio/mpeg' => '.mp3',
        'application/pdf' => '.pdf',
        'text/plain' => '.txt',
    ];
    return $map[$mime] ?? '';
}

// Публичная база для ссылок ensure/pub (можно переопределить ENV MEDIA_PUBLIC_BASE)
function tg_media_host(): string
{
    return rtrim(getenv('MEDIA_PUBLIC_BASE') ?: 'https://media.cheeseapi.ru', '/');
}


// Какие типы считаем «альбомными» (будем объединять в группы)
const TG_GROUPABLE_TYPES = ['photo', 'video', 'document', 'audio', 'animation'];


// Типы, которые НЕ будем группировать (но отдадим как вложения)
const TG_GROUP_EXCLUDE_TYPES = ['sticker', 'voice', 'video_note'];

error_reporting(E_ALL);
ini_set('display_errors', '0'); // ничего лишнего в http-ответ

set_error_handler(function ($errno, $errstr, $errfile, $errline) {
    log_err('PHP warning/notice', ['errno' => $errno, 'msg' => $errstr, 'file' => $errfile, 'line' => $errline]);
    return true; // считаем обработанным, чтобы не лезло в output
});

register_shutdown_function(function () {
    $e = error_get_last();
    if ($e && in_array($e['type'], [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR], true)) {
        // A media response may already have begun. Never append JSON to its
        // binary body; later shutdown handlers must still release locks and
        // remove request-local temporary files.
        if (headers_sent() || !empty($GLOBALS['__TG_BINARY_BODY_STARTED__'])) {
            error_log('Telegram REST fatal after binary response began: ' . $e['message']);
            return;
        }
        json_cors();
        http_response_code(500);
        header('Content-Type: application/json; charset=utf-8');
        echo json_encode(['success' => false, 'message' => 'FATAL: ' . $e['message']], JSON_UNESCAPED_UNICODE);
    }
});


use danog\MadelineProto\API;
use danog\MadelineProto\Settings;
use danog\MadelineProto\Settings\Ipc;
use danog\MadelineProto\RemoteUrl;
use danog\MadelineProto\Tools;


date_default_timezone_set('Europe/Madrid');

// --- Helpers ---
/**
 * Возвращает кортеж [kind, mime, filename, title] по телеграм-сообщению $m
 * kind: photo|video|document|audio|sticker|...
 */
/**
 * Склеивает сообщения с одинаковым media_group_id в один item с массивом attachments[].
 * Логику сортировки и выбора текста/времени можно подстроить под фронт.
 */
function push_reactions_results(string $chatId, array $results, ?string $clientUid): void
{
    $payload = [
        'type'       => 'messagesReactions',
        'chatId'     => $chatId,
        'results'    => $results, // {"496717":[...], ...}
        'client_uid' => $clientUid, // <— добавлено
    ];

    try {
        $ch = curl_init(FINAL_WEBHOOK_URL);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($payload, JSON_UNESCAPED_UNICODE));
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 10);
        $resp = curl_exec($ch);
        $code = curl_getinfo($ch, CURLINFO_HTTP_CODE);
        curl_close($ch);

        if ($code < 200 || $code >= 300) {
            log_err('[RX] push_reactions_results failed', ['http' => $code, 'resp' => $resp]);
        }
    } catch (\Throwable $e) {
        log_err('[RX] push_reactions_results fatal', ['err' => $e->getMessage()]);
    }
}


function tg_collapse_media_groups(array $items): array
{
    if (empty($items)) return $items;

    $groups = [];
    $singles = [];

    foreach ($items as $it) {
        if (!empty($it['media_group']) && !empty($it['media_group_id'])) {
            $gid = (string)$it['media_group_id'];
            $groups[$gid][] = $it;
        } else {
            $singles[] = $it;
        }
    }

    // компаратор «по времени, затем по id» — такой же, как ниже в getChatHistory
    $cmp = function ($a, $b) {
        $ta = intval($a['timestamp']);
        $tb = intval($b['timestamp']);
        if ($ta !== $tb) return $ta <=> $tb;
        return strcmp((string)$a['id'], (string)$b['id']);
    };

    $collapsed = [];

    foreach ($groups as $gid => $arr) {
        usort($arr, $cmp); // порядок внутри группы — от старого к новому

        // базовый элемент — берём первый (самый ранний), но таймстемп/ид обновим на последний
        $base = $arr[0];

        // соберём attachments всех сообщений в порядке
        $allAt = [];
        $anyText = '';
        $anyOut  = $base['direction'] ?? 'in';
        $anyRead = (int)($base['is_read'] ?? 0);
        $anyEdited = false;
        $editMax   = 0;

        foreach ($arr as $m) {
            if (!empty($m['attachments'])) {
                foreach ($m['attachments'] as $a) $allAt[] = $a;
            }
            if ($anyText === '' && ($m['text'] ?? '') !== '') $anyText = (string)$m['text'];
            // на всякий: если вдруг в группе разное направление/прочитанность
            $anyOut  = ($m['direction'] ?? 'in');           // берём из последнего
            $anyRead = (int)($m['is_read'] ?? $anyRead);    // или можно max()
                         // агрегируем признак редактирования
             $ed = (int)($m['edit_date'] ?? 0);
             if ($ed > 0 || !empty($m['edited'])) {
                 $anyEdited = true;
                 if ($ed > 0) $editMax = max($editMax, $ed);
             }
        }

// агрегируем реакции по элементам группы
$rxAgg = [];
foreach ($arr as $m) {
    if (!empty($m['reactions'])) {
        $rx = $m['reactions'];
        $counts = $rx['results'] ?? [];
        if (empty($counts) && !empty($rx['recent_reactions'])) {
            // агрегируем recent_reactions как фолбэк
            $tmp = [];
            foreach ($rx['recent_reactions'] as $rr) {
                $r = $rr['reaction'] ?? null;
                if (!$r) continue;
                $key = isset($r['emoticon']) ? ('e:' . $r['emoticon']) : (isset($r['document_id']) ? ('c:' . $r['document_id']) : null);
                if (!$key) continue;
                if (!isset($tmp[$key])) $tmp[$key] = ['reaction' => $r, 'count' => 0];
                $tmp[$key]['count']++;
            }
            $counts = array_values($tmp);
        }
        foreach ($counts as $c) {
            $r = $c['reaction'] ?? null;
            if (!$r) continue;
            $key = isset($r['emoticon']) ? ('e:' . $r['emoticon']) : (isset($r['document_id']) ? ('c:' . $r['document_id']) : null);
            if (!$key) continue;
            if (!isset($rxAgg[$key])) $rxAgg[$key] = ['reaction' => $r, 'count' => 0];
            $rxAgg[$key]['count'] += (int)($c['count'] ?? 1);
        }
    }
}
if (!empty($rxAgg)) {
    // переложим в формат, который далее понимает клиент
    $base['reactions'] = [];
    foreach ($rxAgg as $agg) {
        $r = $agg['reaction'];
        $entry = ['count' => (int)$agg['count']];
        if (isset($r['emoticon']))    $entry['emoji'] = (string)$r['emoticon'];
        if (isset($r['document_id'])) $entry['custom_emoji_id'] = (string)$r['document_id'];
        $base['reactions'][] = $entry;
    }
}


        // хотим, чтобы «альбом» стоял как последнее (по времени) сообщение группы
        $last = end($arr);

        $base['attachments'] = $allAt;
        $base['text']        = $anyText;
        $base['direction']   = $anyOut;
        $base['is_read']     = $anyRead;
         $base['edited']      = $anyEdited;
         $base['edit_date']   = $anyEdited ? ($editMax ?: (int)($last['edit_date'] ?? 0)) : null;

        // айди/время — от последнего элемента группы (чтобы не «задвигать» альбом назад)
        $base['id']        = $last['id'];
        $base['timestamp'] = $last['timestamp'];

        // мета о группе сохраняем
        $base['media_group']      = true;
        $base['media_group_id']   = $gid;
        // можно оставить, если фронту нужно знать тип: photo/video/document
        $base['media_group_kind'] = $base['media_group_kind'] ?? ($arr[0]['media_group_kind'] ?? ($allAt[0]['type'] ?? null));

        // --- WA-совместимые алиасы и метаданные альбома ---
        $base['group_id']         = $gid;                                    // как в WA
        $base['kind']             = $base['media_group_kind'];               // как в WA
        $base['count']            = count($arr);                             // количество сообщений в альбоме
        $base['timestamp_first']  = intval($arr[0]['timestamp']);            // первый кадр
        $base['timestamp_last']   = intval($last['timestamp']);              // последний кадр (совпадает с $base['timestamp'])
        // мини-сводка по айтемам альбома (как WA.items, но мы уже склеили attachments)
        $base['items'] = array_map(function ($m) use ($anyOut) {
            $a = $m['attachments'][0] ?? null;    // в группе по одному аттачу на сообщение
            return [
                'id'         => (string)$m['id'],
                'mime'       => $a['mime']      ?? null,
                'type'       => $a['type']      ?? null,
                'ensure_url' => $a['ensure_url'] ?? null,
                'public_url' => $a['public_url'] ?? null,
            ];
        }, $arr);


        $collapsed[] = $base;
    }

    // объединяем одиночные и склеенные и окончательно сортируем
    $out = array_merge($singles, $collapsed);
    usort($out, $cmp);

    return $out;
}



function tg_guess_kind_and_meta(array $m): array
{
    $type = strtolower($m['type'] ?? ''); // <--- ВОТ ИСПРАВЛЕНИЕ
    $mime = $m['mime'] ?? null;
    $filename = $m['filename'] ?? null;
    $title = $filename ?: ($type ? ucfirst($type) : 'file');

    // Нормализуем kind
    $kind = 'document';
    if ($type === 'photo') {
        $kind = 'photo';
        if (!$mime) $mime = 'image/jpeg';
        if (!$filename) $filename = 'Photo.jpg';
    } elseif ($type === 'video' || $type === 'video_note') {
        $kind = 'video';
        if (!$mime) $mime = 'video/mp4';
        if (!$filename) $filename = 'Video.mp4';
    } elseif ($type === 'animation') {
        // анимированные GIF'ы — отдадим как video
        $kind = 'video';
        if (!$mime) $mime = 'video/mp4';
        if (!$filename) $filename = 'Animation.mp4';
    } elseif ($type === 'audio') {
        $kind = 'audio';
        if (!$mime) $mime = 'audio/mpeg';
        if (!$filename) $filename = 'Audio.mp3';
    } elseif ($type === 'voice') {
        $kind = 'audio';
        if (!$mime) $mime = 'audio/ogg';
        if (!$filename) $filename = 'Voice.ogg';
    } elseif ($type === 'sticker') {
        // не группируем, но отдаем как картинку webp
        $kind = 'sticker';
        if (!$mime) $mime = 'image/webp';
        if (!$filename) $filename = 'Sticker.webp';
    } else {
        // document / неопознанное
        $kind = 'document';
        if (!$mime) $mime = 'application/octet-stream';
        if (!$filename) $filename = 'Document.bin';
    }

    return [$kind, $mime, $filename, $title];
}

/** Telegram may represent poll labels as plain strings or textWithEntities. */
function tg_poll_text(mixed $value): string
{
    if (is_array($value)) {
        $value = $value['text'] ?? $value['message'] ?? '';
    }
    if (!is_scalar($value)) return '';
    $text = trim((string)$value);
    return function_exists('mb_substr') ? mb_substr($text, 0, 1000, 'UTF-8') : substr($text, 0, 1000);
}

/** Opaque poll answer bytes are only used to match vote results in this request. */
function tg_poll_option_key(mixed $value): string
{
    return is_string($value) ? bin2hex($value) : '';
}

/** @return array<string,mixed> */
function tg_build_poll_attachment(array $message): array
{
    $media = is_array($message['media'] ?? null) ? $message['media'] : [];
    $poll = is_array($media['poll'] ?? null) ? $media['poll'] : [];
    $results = is_array($media['results'] ?? null) ? $media['results'] : [];
    $votes = [];
    foreach (($results['results'] ?? []) as $result) {
        if (!is_array($result)) continue;
        $key = tg_poll_option_key($result['option'] ?? null);
        if ($key === '') continue;
        $votes[$key] = [
            'voters' => max(0, (int)($result['voters'] ?? 0)),
            'chosen' => !empty($result['chosen']),
        ];
    }
    $options = [];
    foreach (array_slice(is_array($poll['answers'] ?? null) ? $poll['answers'] : [], 0, 20) as $answer) {
        if (!is_array($answer)) continue;
        $key = tg_poll_option_key($answer['option'] ?? null);
        $vote = $key !== '' ? ($votes[$key] ?? []) : [];
        $options[] = [
            'text' => tg_poll_text($answer['text'] ?? ''),
            'voters' => max(0, (int)($vote['voters'] ?? 0)),
            'chosen' => !empty($vote['chosen']),
        ];
    }
    $sum = array_sum(array_map(static fn(array $option): int => (int)$option['voters'], $options));
    $total = max(0, (int)($results['total_voters'] ?? $sum));
    return [
        'type' => 'poll',
        'mime' => 'application/x-telegram-poll',
        'title' => 'Опрос',
        'filename' => '',
        'question' => tg_poll_text($poll['question'] ?? $message['message'] ?? ''),
        'options' => $options,
        'total_voters' => $total,
        'multiple_choice' => !empty($poll['multiple_choice']),
        'quiz' => !empty($poll['quiz']),
        'closed' => !empty($poll['closed']),
        'voted' => (bool)array_filter($options, static fn(array $option): bool => !empty($option['chosen'])),
    ];
}

/**
 * Упрощает Telegram MessageReactions -> [{emoji?, custom_emoji_id?, count}]
 * Понимает как нормальные counts (results), так и fallback по recent_reactions.
 */
function tg_compact_reactions($rx): array
{
    $out = [];
    if (!is_array($rx)) return $out;

    $counts = $rx['results'] ?? [];
    if (empty($counts) && !empty($rx['recent_reactions'])) {
        $tmp = [];
        foreach ($rx['recent_reactions'] as $rr) {
            $r = $rr['reaction'] ?? null;
            if (!$r) continue;
            $key = isset($r['emoticon'])
                ? ('e:' . $r['emoticon'])
                : (isset($r['document_id']) ? ('c:' . $r['document_id']) : null);
            if (!$key) continue;
            if (!isset($tmp[$key])) $tmp[$key] = ['reaction' => $r, 'count' => 0];
            $tmp[$key]['count']++;
        }
        $counts = array_values($tmp);
    }

    foreach ($counts as $c) {
        $r = $c['reaction'] ?? null;
        if (!$r) continue;
        $entry = ['count' => (int)($c['count'] ?? 1)];
        if (isset($r['emoticon']))    $entry['emoji'] = (string)$r['emoticon'];
        if (isset($r['document_id'])) $entry['custom_emoji_id'] = (string)$r['document_id'];
        $out[] = $entry;
    }
    return $out;
}


function tg_simple_reactions(array $reactions): array {
    // 1) Полный телеграм-формат
    if (!empty($reactions['results']) && is_array($reactions['results'])) {
        $out = [];
        foreach ($reactions['results'] as $r) {
            $emo = $r['reaction']['emoticon'] ?? null;
            $cnt = (int)($r['count'] ?? 0);
            if ($emo && $cnt > 0) $out[] = ['emoji' => $emo, 'count' => $cnt];
        }
        return $out;
    }
    // 2) Компактный формат [{e,n}]
    if (isset($reactions[0]['e']) || isset($reactions[0]['n'])) {
        $out = [];
        foreach ($reactions as $r) {
            $emo = $r['e'] ?? null;
            $cnt = (int)($r['n'] ?? 0);
            if ($emo && $cnt > 0) $out[] = ['emoji' => $emo, 'count' => $cnt];
        }
        return $out;
    }
    return [];
}


/**
 * attachments[]: единый стиль (как в WA)
 * - type: photo|video|document|audio|sticker
 * - url:      downloadMedia&stream=1
 * - preview / thumbnail: downloadThumb
 * - title / filename / mime
 */
function tg_build_attachments(array $m, string $baseUrl, $chatId): array
{
    // Polls carry structured text and vote counts, not downloadable bytes.
    // Treating them as documents produced a dead "Poll" file card in the UI.
    if (strtolower((string)($m['type'] ?? '')) === 'poll') {
        return [tg_build_poll_attachment($m)];
    }
    // A Telegram webpage preview is a link, not a downloadable document.
    // Keep its original URL and descriptive fields so the common UI can
    // render a normal outbound-link card. Do not route it through the media
    // cache: there are no provider bytes to download for this message type.
    if (strtolower((string)($m['type'] ?? '')) === 'webpage') {
        $webpage = is_array($m['media']['webpage'] ?? null) ? $m['media']['webpage'] : [];
        $url = trim((string)($webpage['url'] ?? $m['webpage_url'] ?? ''));
        $title = trim((string)($webpage['title'] ?? $m['webpage_title'] ?? ''));
        $description = trim((string)($webpage['description'] ?? $m['webpage_description'] ?? ''));
        $siteName = trim((string)($webpage['site_name'] ?? $m['webpage_site_name'] ?? ''));
        if ($title === '') $title = $siteName !== '' ? $siteName : $url;
        return [[
            'type' => 'link',
            'url' => $url,
            'external_url' => $url,
            'title' => $title,
            'filename' => '',
            'description' => $description,
            'site_name' => $siteName,
            'mime' => 'text/uri-list',
        ]];
    }
    [$kind, $mime, $filename, $title] = tg_guess_kind_and_meta($m);

    // ==========================================================
    // ===== THE FIX IS HERE =====
    $chatIdStr = (string)$chatId;
    $midStr = (string)($m['id'] ?? '0');
     $editTs = (int)($m['edit_date'] ?? 0);
     $msgTs  = (int)($m['date'] ?? 0);
     $vts    = $editTs ?: $msgTs; // версия для кэш-байпаса
    // ==========================================================

    $mediaUrl = $baseUrl . '?action=downloadMedia&chatId=' . urlencode($chatIdStr)
        . '&messageId=' . urlencode($midStr) . '&stream=1';
    $thumbUrl = $baseUrl . '?action=downloadThumb&chatId=' . urlencode($chatIdStr)
        . '&messageId=' . urlencode($midStr);

    $key  = tg_cache_key($chatIdStr, $midStr);
    $host = tg_media_host();

    // версионируем все ссылки (включая локальные) — браузер не возьмёт старый объект
    $mediaUrlV = $vts ? add_v_param($mediaUrl, $vts) : $mediaUrl;
    $thumbUrlV = $vts ? add_v_param($thumbUrl, $vts) : $thumbUrl;
    $ensureV   = $vts ? add_v_param($host . '/ensure/' . $key, $vts) : ($host . '/ensure/' . $key);
    $publicV   = $vts ? add_v_param($host . '/pub/'    . $key, $vts) : ($host . '/pub/'    . $key);

    return [[
        'type'       => $kind,
        'animated'   => ($m['type'] ?? '') === 'animation' || $mime === 'image/gif',
        'video_note' => ($m['type'] ?? '') === 'video_note',
        'animation_format' => (string)($m['animation_format'] ?? ''),
        'mime'       => $mime,
        'title'      => $title,
        'filename'   => $filename,
        'preview'    => $thumbUrlV,
        'thumbnail'  => $thumbUrlV,
        'ensure_url' => $ensureV,
        'public_url' => $publicV,
        // кладём явную версию – фронту пригодится
        'v'          => $vts ?: null,
    ]];
}

/**
 * Приводим одно «сырое» сообщение TG к общему контракту фронта.
 * Выход: id, text, timestamp, direction, is_read, attachments[], media_group_id/kind/flag
 */
/**
 * Translate Telegram's MessageAction variants into the provider-neutral
 * centered event-pill contract.  The action payload does not always include
 * resolvable participant names, therefore these labels deliberately describe
 * only what Telegram confirmed instead of inventing an author.
 *
 * @return array{event:string,style:string,label:string}|null
 */
function tg_service_event(array $message): ?array
{
    $action = $message['action'] ?? null;
    if (!is_array($action)) return null;
    $type = strtolower((string)($action['_'] ?? ''));
    if ($type === '') return null;

    return match ($type) {
        'messageactionchatadduser', 'messageactionchatjoinedbylink', 'messageactionchatjoinedbyrequest' => [
            'event' => 'join', 'style' => 'membership', 'label' => 'В чат добавлен участник',
        ],
        'messageactionchatdeleteuser' => [
            'event' => 'leave', 'style' => 'membership', 'label' => 'Участник покинул чат',
        ],
        'messageactionchatcreate' => [
            'event' => 'create', 'style' => 'membership', 'label' => 'Создана группа',
        ],
        'messageactionchatmigratetochannel', 'messageactionchannelmigratefrom' => [
            'event' => 'migrate', 'style' => 'notice', 'label' => 'Чат преобразован в группу',
        ],
        'messageactionpinmessage' => [
            'event' => 'pin', 'style' => 'pin', 'label' => 'Закреплено сообщение',
        ],
        'messageactionphonecall', 'messageactiongroupcall' => [
            'event' => 'call', 'style' => 'call', 'label' => 'Звонок',
        ],
        'messageactionchatedittitle' => [
            'event' => 'edit_title', 'style' => 'notice', 'label' => 'Изменилось название группы',
        ],
        'messageactionchateditphoto', 'messageactionchatdeletephoto' => [
            'event' => 'edit_photo', 'style' => 'notice', 'label' => 'Изменилось фото группы',
        ],
        default => ['event' => 'notice', 'style' => 'notice', 'label' => 'Служебное событие Telegram'],
    };
}

function tg_normalize_message(array $m, $chatId, string $selfBaseUrl): array
{
    $isOut = !empty($m['out']);
    $direction = $isOut ? 'out' : 'in';
    $service = is_array($m['service'] ?? null) ? $m['service'] : tg_service_event($m);

    // text
    $text = '';
    if ($service !== null) {
        $text = (string)($service['label'] ?? 'Служебное событие Telegram');
    } elseif (($m['type'] ?? '') === 'text') {
        $text = $m['message'] ?? '';
    } else {
        // подписи к медиа Madeline не всегда кладет в message — если надо, можно расширить
        $text = $m['message'] ?? '';
    }

    // Service actions are records, not attachments. They must never become
    // fake media cards or participate in album grouping.
    $atts = [];
    if ($service === null && ($m['type'] ?? '') !== 'text') {
        $atts = tg_build_attachments($m, $selfBaseUrl, $chatId);
    }

    // базовые поля
    $item = [
        'id'                  => (string)($m['id']),
        'text'                => (string)$text,
        'timestamp'           => intval($m['date'] ?? 0),
        'direction'           => $direction,
        'attachments'         => $atts,
        'is_read'             => !empty($m['is_read']),
        'reactions'           => [],
        'media_group_id'      => null,
        'media_group_kind'    => null,
        'media_group'         => false,
        'sender_id'           => (string)($m['sender_id'] ?? ''),
        'sender_name'         => (string)($m['sender_name'] ?? ''),
        'sender_username'     => (string)($m['sender_username'] ?? ''),
        'sender_avatar'       => (string)($m['sender_avatar'] ?? ''),
        // ▼▼ ДОБАВЛЕНА ЭТА СТРОКА ▼▼
        'reply_to_message_id' => isset($m['reply_to_msg_id']) ? (string)$m['reply_to_msg_id'] : null,
    ];
    $item['chat_kind'] = !empty($m['post']) ? 'channel' : (str_starts_with((string)$chatId, '-') ? 'group' : 'contact');
    if (!empty($m['post']) && !empty($m['replies']['comments'])) {
        $item['discussion'] = ['enabled' => true, 'count' => max(0, (int)($m['replies']['replies'] ?? 0)), 'post_id' => (string)$m['id']];
    }
    if ($service !== null) {
        $item['type'] = 'service';
        $item['is_service'] = true;
        $item['presentation'] = 'event_pill';
        $item['service_event'] = (string)($service['event'] ?? 'notice');
        $item['event_style'] = (string)($service['style'] ?? 'notice');
    }

     
    // ▼▼ Метки редактирования: НЕ считать «реакции-только» редактированием ▼▼
    $editTs = (int)($m['edit_date'] ?? 0);
    $upd    = $m['_update_type'] ?? null; // может прийти из webhook/истории (см. вызовы выше)
    // апдейт только реакций — не зажигаем плашку "изменено"
    $isReactionOnlyUpdate = ($upd === 'updateMessageReactions');
    if ($editTs > 0 && !$isReactionOnlyUpdate) {
        $item['edit_date'] = $editTs;
        $item['edited']    = true;
    } else {
        // храним ts, если есть, но без флага edited (для истории/сортировок это безопасно)
        $item['edit_date'] = $editTs ?: null;
        $item['edited']    = false;
    }
     // ▲▲ ДОБАВЛЕНО ▲▲

    // === ИЗМЕНЕНИЕ: ОБРАБОТКА РЕАКЦИЙ ===
    // Вместо сложного ручного парсинга, используем нашу готовую функцию
    if (!empty($m['reactions'])) {
        $item['reactions'] = tg_reactions_detailed($m['reactions']);
    }
    // ===================================

    // нативный grouped_id от Telegram уже может быть в $m
    if (!empty($m['media_group_id'])) {
        $item['media_group_id'] = 'tg:' . $m['media_group_id'];
        $item['media_group']    = true;

        // kind по первому вложению
        if (!empty($atts)) {
            $item['media_group_kind'] = $atts[0]['type'];
        }

        // WA-алиасы сразу, чтобы фронт мог не оглядываться на доп. шаг склейки
        $item['group_id'] = $item['media_group_id'];
        $item['kind']     = $item['media_group_kind'] ?? ($atts[0]['type'] ?? null);
    }

    return $item;
}

/**
 * Догруппировывает in-place там, где у сообщения ещё нет media_group_id.
 * Ключ группы: tg:<chatKey>:<in|out>:<kind>:<bucketStart>
 */
function tg_assign_media_groups_in_place(array &$items, $chatKey): void
{
    if (empty($items)) return;

    foreach ($items as &$it) {
        if (!empty($it['media_group_id'])) continue;

        $kind = $it['attachments'][0]['type'] ?? null;
        if (!$kind) continue;

        if (in_array($kind, TG_GROUP_EXCLUDE_TYPES, true)) continue;
        if (!in_array($kind, TG_GROUPABLE_TYPES, true)) continue;

        $dir = ($it['direction'] === 'out') ? 'out' : 'in';
        $ts = (int)$it['timestamp'];
        $bucket = (int)(floor($ts / TG_MEDIA_GROUP_WINDOW_SEC) * TG_MEDIA_GROUP_WINDOW_SEC);

        $gid = 'tg:' . $chatKey . ':' . $dir . ':' . $kind . ':' . $bucket;
        $it['media_group_id']   = $gid;
        $it['media_group_kind'] = $kind;
        $it['media_group']      = true;

        // WA-совместимые алиасы
        $it['group_id'] = $gid;
        $it['kind']     = $kind;
    }
    unset($it);
}

function get_cached_thumb_url(string $peer, int $mid): ?string
{
    $thumbFile = 'th_' . sha1($peer . '#' . $mid) . '.jpg';
    $thumbPath = CACHE_DIR . '/' . $thumbFile; // <— константа, не переменная

    if (is_file($thumbPath) && filesize($thumbPath) > 0) {
        return rtrim(BASE_URL_MADELINE, '/') . '/telegram_cache/' . $thumbFile;
    }
    return null;
}

function json_cors(): void
{
    $origin = $_SERVER['HTTP_ORIGIN'] ?? '';
    header('Vary: Origin');
    if ($origin) {
        header('Access-Control-Allow-Origin: ' . $origin);
        header('Access-Control-Allow-Credentials: true');
    } else {
        header('Access-Control-Allow-Origin: *');
        // do NOT send Allow-Credentials with *
    }
    header('Access-Control-Allow-Methods: GET, POST, OPTIONS, HEAD');
    header('Access-Control-Allow-Headers: Content-Type, Authorization, X-Requested-With');
}
if (($_SERVER['REQUEST_METHOD'] ?? '') === 'OPTIONS') {
    json_cors();
    http_response_code(204);
    exit;
}
if (!function_exists('str_starts_with')) {
    function str_starts_with(string $h, string $n): bool
    {
        return $n === '' || strncmp($h, $n, strlen($n)) === 0;
    }
}
function json_input(): array
{
    $raw = file_get_contents('php://input') ?: '';
    $d = json_decode($raw, true);
    return is_array($d) ? $d : ($_POST ?: []);
}
function send_json($data, int $code = 200): void
{
    json_cors();
    http_response_code($code);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode($data, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function respond_ok_with_background_album_flush(array $data): void
{
    // Отдаём ответ клиенту немедленно
    json_cors();
    http_response_code(200);
    header('Content-Type: application/json; charset=utf-8');
    echo json_encode(
        ['success' => true, 'data' => $data],
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    );

    // Завершаем HTTP-ответ (для PHP-FPM)
    if (function_exists('fastcgi_finish_request')) {
        @fastcgi_finish_request();
    } else {
        // На всякий — сброс буферов вывода, если не FPM
        @ob_flush();
        @flush();
    }

    // Подождём чуть больше окна альбома и дожмём сторожем
    $delay = (int)(getenv('TG_ALBUM_FLUSH_DELAY') ?: (TG_ALBUM_WINDOW_SEC + 1));
    if ($delay > 0) {
        @sleep($delay);
    }
    tg_flush_expired_albums();
    exit;
}

// === helpers: publish provider-confirmed outgoing updates to the local webhook ===
function post_telegram_webhook(array $payload): bool
{
    try {
        $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE);
        if (!is_string($body)) return false;
        $ch = curl_init(FINAL_WEBHOOK_URL);
        curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        curl_setopt($ch, CURLOPT_POST, true);
        curl_setopt($ch, CURLOPT_POSTFIELDS, $body);
        curl_setopt($ch, CURLOPT_HTTPHEADER, ['Content-Type: application/json']);
        curl_setopt($ch, CURLOPT_TIMEOUT, 5);
        $response = curl_exec($ch);
        $status = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        curl_close($ch);
        return $response !== false && $status >= 200 && $status < 300;
    } catch (Throwable $e) {
        log_err('Telegram webhook publish failed', ['err' => $e->getMessage()]);
        return false;
    }
}

/**
 * The RPC result from sendMultiMedia contains updateNewMessage payloads with
 * the actual media. Forward those messages unchanged, rather than inventing
 * updateShortSentMessage records that have no attachment data.
 */
function notify_webhook_full_updates(array $updates): bool
{
    $full = [];
    foreach ($updates as $update) {
        if (!is_array($update)) continue;
        if (!in_array((string)($update['_'] ?? ''), ['updateNewMessage', 'updateNewChannelMessage'], true)) continue;
        if (!is_array($update['message'] ?? null) || (int)($update['message']['id'] ?? 0) <= 0) continue;
        $full[] = $update;
    }
    return $full !== [] && post_telegram_webhook(['updates' => $full]);
}

// Used by single-message routes where Telegram only returned a short receipt.
function notify_webhook_sent_update(string $peer, int $msgId, int $date, string $text = '', ?string $clientUid = null): bool
{
    if (str_starts_with($peer, '-100')) {
        $peerId = ['_' => 'peerChannel', 'channel_id' => (int)substr($peer, 4)];
    } elseif ($peer !== '' && $peer[0] === '-') {
        $peerId = ['_' => 'peerChat', 'chat_id' => (int)ltrim($peer, '-')];
    } else {
        $peerId = ['_' => 'peerUser', 'user_id' => (int)$peer];
    }

    return post_telegram_webhook([
        '_'          => 'updateShortSentMessage',
        'id'         => $msgId,
        'date'       => $date ?: time(),
        'message'    => (string)$text,
        'out'        => true,
        'peer_id'    => $peerId,
        'client_uid' => $clientUid,
    ]);
}

function ok($data): void
{
    release_all_madeline_locks();
    send_json(['success' => true, 'data' => $data], 200);
}
function fail(string $msg, int $code = 400): void
{
    release_all_madeline_locks();
    send_json(['success' => false, 'message' => $msg], $code);
}
function log_err(string $msg, array $ctx = []): void
{
    $logFile = rtrim(TMPDIR, '/') . '/rest_errors.log';
    $content = date('c') . ' ' . $msg . ' ' . json_encode(
        $ctx,
        JSON_UNESCAPED_UNICODE | JSON_INVALID_UTF8_SUBSTITUTE
    ) . PHP_EOL;

    // пробуем писать в файл
    $ok = @file_put_contents($logFile, $content, FILE_APPEND);
    if ($ok === false) {
        // аварийный канал — системный лог веб-сервера (journalctl/nginx error.log)
        error_log('[rest_errors] ' . $content);
    }
}

/**
 * A desktop-generated trace id follows one binary request across the native
 * WebView relay and this server. It contains no credentials or media URL and
 * is deliberately ignored for all normal/legacy calls.
 */
function tg_media_trace(string $event, array $context = []): void
{
    $trace = (string)($_SERVER['HTTP_X_UNIFIED_MEDIA_TRACE'] ?? '');
    if (!preg_match('/^d[0-9a-f]{1,16}-[0-9a-f]{1,16}$/D', $trace)) return;
    log_err('telegram_media_trace ' . $event, ['trace' => $trace] + $context);
}

function tg_media_trace_peer(string $peer): string
{
    return substr(hash('sha256', $peer), 0, 12);
}
function ensure_dirs(): void
{
    foreach ([dirname(SESSION), TMPDIR, CACHE_DIR, AVA_DIR, TG_ALBUM_BUCKET_DIR] as $d) {
        if (!is_dir($d)) @mkdir($d, 0777, true);
    }
}
/**
 * Скачивает и кэширует медиафайл по его ID.
 * Вызывается проактивно при получении вебхука.
 * @param API $mp Экземпляр MadelineProto
 * @param string $peer Канонический ID чата
 * @param int $mid ID сообщения
 * @return bool True в случае успеха или если файл уже в кэше
 */
function proactive_cache_media(API $mp, string $peer, int $mid): bool
{
    if ($peer === '' || $mid <= 0) return false;

    $cacheKey = sha1($peer . '#' . $mid);
    $cacheDir = rtrim(TMPDIR, '/') . '/cache';
    $cachePath = $cacheDir . '/' . $cacheKey;

    if (tg_media_cache_is_complete($cachePath)) return true;
    if (is_file($cachePath)) tg_forget_incomplete_media_cache($cachePath);

    try {
        $m = $mp->messages->getMessages(['peer' => $peer, 'id' => [$mid]])['messages'][0] ?? null;
        if ($m && !empty($m['media'])) {
            $tmp = tg_track_temporary_media_file($cacheDir . '/' . uniqid('dl_', true));
            $mp->downloadToFile($m, $tmp);
            if (is_file($tmp) && filesize($tmp) > 0) {
                $published = tg_publish_downloaded_media_cache(
                    $tmp,
                    $cachePath,
                    detect_mime($tmp, true, 'application/octet-stream')
                );
                tg_untrack_temporary_media_file($tmp);
                return $published;
            }
            @unlink($tmp);
            tg_untrack_temporary_media_file($tmp);
        }
    } catch (\Throwable $e) {
        log_err('proactive_cache_media FAILED', ['chatId' => $peer, 'msgId' => $mid, 'error' => $e->getMessage()]);
    }
    return false;
}

/**
 * Кэширует медиа и превью для списка сырых TG-сообщений одной беседы.
 * Используется внутри getChatHistory/messages и т.п.
 */
function ensure_media_cached_for_list(API $mp, string $peer, array $rawMessages): void
{
    $cacheDir = rtrim(TMPDIR, '/') . '/cache';
    if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);

    foreach ($rawMessages as $m) {
        if (!is_array($m)) continue;
        $mid = (int)($m['id'] ?? 0);
        if ($mid <= 0) continue;
        if (empty($m['media'])) continue;

        $key = sha1($peer . '#' . $mid);
        $path = $cacheDir . '/' . $key;
        if (!tg_media_cache_is_complete($path)) {
            if (is_file($path)) tg_forget_incomplete_media_cache($path);
            try {
                $tmp = tg_track_temporary_media_file($cacheDir . '/' . uniqid('dl_'));
                $mp->downloadToFile($m, $tmp);
                if (is_file($tmp) && filesize($tmp) > 0) {
                    $published = tg_publish_downloaded_media_cache(
                        $tmp,
                        $path,
                        detect_mime($tmp, true, 'application/octet-stream')
                    );
                    tg_untrack_temporary_media_file($tmp);
                    if (!$published) @unlink($tmp);
                } else {
                    @unlink($tmp);
                    tg_untrack_temporary_media_file($tmp);
                }
            } catch (\Throwable $e) {
                log_err('ensure_media_cached_for_list: media download failed', ['peer' => $peer, 'mid' => $mid, 'err' => $e->getMessage()]);
            }
        }

        // превью
        $thumbPath = $cacheDir . '/th_' . sha1($peer . '#' . $mid) . '.jpg';
        if (!is_file($thumbPath) || filesize($thumbPath) === 0) {
            try {
                $tmpT = $cacheDir . '/' . uniqid('dl_th_');
                $got = false;
                $media = $m['media'];
                if (isset($media['photo'])) {
                    $mp->downloadToFile($media['photo'], $tmpT);
                    $got = true;
                } elseif (isset($media['document']['thumbs'][0])) {
                    $mp->downloadToFile($media['document']['thumbs'][0], $tmpT);
                    $got = true;
                }
                if ($got && is_file($tmpT) && filesize($tmpT) > 0 && str_starts_with(detect_mime($tmpT), 'image/')) {
                    @rename($tmpT, $thumbPath);
                } else {
                    @unlink($tmpT);
                }
            } catch (\Throwable $e) {
                log_err('ensure_media_cached_for_list: thumb failed', ['peer' => $peer, 'mid' => $mid, 'err' => $e->getMessage()]);
            }
        }
    }
}


function acquire_lock(string $path, int $timeoutSec = 12)
{
    $fh = @fopen($path, 'c');
    if (!$fh) return [null, false];
    $start = microtime(true);
    $ok = false;
    do {
        $ok = @flock($fh, LOCK_EX | LOCK_NB);
        if ($ok) break;
        usleep(100_000);
    } while ((microtime(true) - $start) < $timeoutSec);
    return [$fh, $ok];
}
function release_lock($fh): void
{
    // Session locks are directory guards: unlike flock handles they are not
    // inherited by MadelineProto's IPC child process.
    if (is_string($fh)) {
        @rmdir($fh);
        return;
    }
    if ($fh) {
        @flock($fh, LOCK_UN);
        @fclose($fh);
    }
}

function acquire_session_lock(string $path, int $timeoutSec = 15): array
{
    $fh = @fopen($path, 'c');
    if (!$fh) return [null, false];
    $start = microtime(true);
    do {
        if (@flock($fh, LOCK_EX | LOCK_NB)) return [$fh, true];
        usleep(100_000);
    } while ((microtime(true) - $start) < $timeoutSec);
    @fclose($fh);
    return [null, false];
}

function release_all_madeline_locks(): void
{
    if (!isset($GLOBALS['__MP_LOCKS__']) || !($GLOBALS['__MP_LOCKS__'] instanceof SplObjectStorage)) return;
    $locks = $GLOBALS['__MP_LOCKS__'];
    $items = [];
    foreach ($locks as $mp) $items[] = $mp;
    foreach ($items as $mp) {
        $fh = $locks[$mp] ?? null;
        release_lock($fh);
        $locks->detach($mp);
    }
}
// Some media endpoints stream a file and finish the request with exit.
// PHP does not enter the surrounding finally blocks in that case, so keep a
// process-wide safety net: the OS releases a flock if a request dies, but
// close the handle explicitly as well so normal shutdown does not delay waiters.
register_shutdown_function('release_all_madeline_locks');

function detect_mime(string $fileOrBytes, bool $isFile = true, string $default = 'application/octet-stream'): string
{
    $mime = $default;
    if (function_exists('finfo_open')) {
        $fi = @finfo_open(FILEINFO_MIME_TYPE);
        if ($fi) {
            $det = $isFile ? @finfo_file($fi, $fileOrBytes) : @finfo_buffer($fi, $fileOrBytes);
            if ($det) $mime = $det;
            @finfo_close($fi);
        }
    }
    return $mime;
}

/** A previous thumbnail attempt may have cached this exact transparent PNG. */
function tg_is_thumbnail_placeholder(string $path): bool
{
    return is_file($path)
        && (int)@filesize($path) === 68
        && detect_mime($path, true, '') === 'image/png';
}
function set_media_headers_common(): void
{
    header('Access-Control-Allow-Origin: *');
    header('Access-Control-Allow-Credentials: true');
    header('Cache-Control: public, max-age=86400');
}


function extract_sent_message_meta($res): array
{
    // Возвращает [message_id|null, date|null]
    $id = null;
    $date = null;
    if (!is_array($res)) return [null, null];

    // 1) Частый кейс: updateShortSentMessage
    if (($res['_'] ?? '') === 'updateShortSentMessage') {
        $id   = isset($res['id']) ? (int)$res['id'] : null;
        $date = isset($res['date']) ? (int)$res['date'] : null;
        return [$id, $date];
    }

    // 2) Полные updates с updateNewMessage / updateNewChannelMessage
    foreach (($res['updates'] ?? []) as $u) {
        $t = $u['_'] ?? '';
        if ($t === 'updateNewMessage' || $t === 'updateNewChannelMessage') {
            $m = $u['message'] ?? null;
            if (is_array($m)) {
                $id   = isset($m['id']) ? (int)$m['id'] : null;
                $date = isset($m['date']) ? (int)$m['date'] : null;
                if ($id) return [$id, $date];
            }
        }
    }

    // 3) Иногда ответ содержит массив messages
    if (!empty($res['messages']) && is_array($res['messages'])) {
        $last = end($res['messages']);
        if (is_array($last)) {
            $id   = isset($last['id']) ? (int)$last['id'] : null;
            $date = isset($last['date']) ? (int)$last['date'] : null;
            return [$id, $date];
        }
    }

    return [null, null];
}


function start_madeline_locked(): API
{
    // A separate lock name avoids treating an old directory guard as a live
    // session. flock has kernel-owned lifetime and never needs unsafe TTLs.
    $lockFile = TMPDIR . '/madeline_session.guard.lock';
    [$lfh, $locked] = acquire_session_lock($lockFile, 15);
    if (!$locked) {
        log_err('session lock timeout');
        fail('busy, try again', 503);
    }
    try {
$settings = new Settings;
        // Use the same application credentials as the explicit login bridge.
        // Without these, an unauthenticated REST request renders MadelineProto's
        // built-in HTML credential wizard instead of our JSON API.
        $apiId = (int)($_ENV['TELEGRAM_API_ID'] ?? 0);
        $apiHash = trim((string)($_ENV['TELEGRAM_API_HASH'] ?? ''));
        if ($apiId > 0 && $apiHash !== '') {
            $settings->setAppInfo(
                (new \danog\MadelineProto\Settings\AppInfo())
                    ->setApiId($apiId)
                    ->setApiHash($apiHash)
            );
        }


        // в некоторых версиях метода нет — просто тихо игнорируем
        try {
            if (method_exists($settings, 'getUpdates')) {
                $settings->getUpdates()->setHandleUpdates(false);
            }
        } catch (\Throwable $ignore) {
        }

        $mp = new API(SESSION, $settings);
        if ($mp->getAuthorization() !== API::LOGGED_IN) {
            release_lock($lfh);
            fail('TELEGRAM_NOT_AUTHORIZED: complete login through telegram_auth.php', 401);
        }
        $mp->start();
    } catch (\Throwable $e) {
        release_lock($lfh);
        fail('INIT ERROR: ' . $e->getMessage(), 500);
    }

    $GLOBALS['__MP_LOCKS__'] = $GLOBALS['__MP_LOCKS__'] ?? new \SplObjectStorage();

    $GLOBALS['__MP_LOCKS__']->attach($mp, $lfh);
    return $mp;
}

/**
 * The always-running Telegram listener owns the Madeline session.  A REST
 * media request therefore becomes an IPC client (confirmed by Madeline's
 * internal IPC server), not a second session owner.  Unlike UI mutations,
 * concurrent bounded video ranges must not wait behind an unrelated player
 * while holding a PHP flock for the whole response body.
 */
function start_madeline_media_ipc_client(): API
{
    $settings = new Settings;
    $apiId = (int)($_ENV['TELEGRAM_API_ID'] ?? 0);
    $apiHash = trim((string)($_ENV['TELEGRAM_API_HASH'] ?? ''));
    if ($apiId > 0 && $apiHash !== '') {
        $settings->setAppInfo(
            (new \danog\MadelineProto\Settings\AppInfo())
                ->setApiId($apiId)
                ->setApiHash($apiHash)
        );
    }
    try {
        $mp = new API(SESSION, $settings);
        if ($mp->getAuthorization() !== API::LOGGED_IN) {
            fail('TELEGRAM_NOT_AUTHORIZED: complete login through telegram_auth.php', 401);
        }
        $mp->start();
        return $mp;
    } catch (\Throwable $e) {
        fail('MEDIA IPC INIT ERROR: ' . $e->getMessage(), 500);
    }
}

function finish_madeline_locked(API $mp): void
{
    if (isset($GLOBALS['__MP_LOCKS__']) && $GLOBALS['__MP_LOCKS__'] instanceof SplObjectStorage) {
        $locks = $GLOBALS['__MP_LOCKS__'];
        if ($locks->contains($mp)) {
            $fh = $locks[$mp] ?? null;
            release_lock($fh);
            $locks->detach($mp);
        }
    }
}
function get_chat_id_from_peer($peer): ?string
{
    // 1) Чистый числовой user_id (int или строка цифр)
    if (is_int($peer) || (is_string($peer) && ctype_digit($peer))) {
        return (string)$peer; // user
    }

    // 2) Уже нормализованный chatId строкой, например "-100..." или "-123..."
    if (is_string($peer)) {
        if ($peer !== '' && $peer[0] === '-') return $peer;
        if (ctype_digit($peer)) return $peer;
        return null;
    }

    // 3) Классический peer-объект
    if (!is_array($peer)) return null;

    $type = $peer['_'] ?? '';
    if ($type === 'peerUser'    && isset($peer['user_id']))    return (string)$peer['user_id'];
    if ($type === 'peerChat'    && isset($peer['chat_id']))    return '-' . (string)$peer['chat_id'];
    if ($type === 'peerChannel' && isset($peer['channel_id'])) return '-100' . (string)$peer['channel_id'];
    return null;
}

/**
 * Madeline can return a dialog without embedding its Chat/User entity.  The
 * dialog is still usable, but rendering it as "Telegram -100..." loses the
 * title and makes the avatar resolver operate on an incomplete peer.  Resolve
 * only those missing entities, keeping the normal batch path fast.
 */
function resolve_missing_dialog_peer(API $mp, string $chatId): array
{
    try {
        $info = $mp->getInfo($chatId);
        foreach (['Chat', 'User', 'chat', 'user'] as $key) {
            if (isset($info[$key]) && is_array($info[$key])) {
                return $info[$key];
            }
        }
    } catch (\Throwable $e) {
        // A stale/deleted peer must remain visible with its technical label.
    }
    return [];
}


// Нормализуем телефон в E.164 без "+"
function normalize_phone(string $p): string
{
    $p = preg_replace('/[^\d+]/', '', $p);
    if ($p !== '' && $p[0] === '+') $p = substr($p, 1);
    return $p;
}

function resolvePeer(API $mp, string $target)
{
    $target = trim($target);

    // 1) Если это @username — используем getInfo (рекомендуемый способ)
    if (strlen($target) > 0 && $target[0] === '@') {
        // getInfo бросит исключение, если юзернейм не существует
        $info = $mp->getInfo($target); // https://docs.madelineproto.xyz
        // В sendMessage можно передать сам @username, MadelineProto сам разрулит.
        // Но если хочешь явный объект — можно вернуть $info['peer'].
        return $target;
    }

    // 2) Иначе — считаем, что это телефон
    $uid = userIdByPhone($mp, $target); // твоя уже существующая функция
    if (!$uid) {
        return null;
    }
    // В sendMessage можно передать числовой id
    return $uid;
}

// === User status normalization helpers ===
function normalize_user_status(array $status): array {
    $t = $status['_'] ?? null;
    if (!$t) return ['online'=>null,'last_seen_ts'=>null,'bucket'=>null];
    switch ($t) {
        case 'userStatusOnline':
            return ['online'=>true,  'last_seen_ts'=>(int)($status['expires']   ?? 0), 'bucket'=>null];
        case 'userStatusOffline':
            return ['online'=>false, 'last_seen_ts'=>(int)($status['was_online']?? 0), 'bucket'=>null];
        case 'userStatusRecently':
            return ['online'=>null,  'last_seen_ts'=>null, 'bucket'=>'recently'];
        case 'userStatusLastWeek':
            return ['online'=>null,  'last_seen_ts'=>null, 'bucket'=>'last_week'];
        case 'userStatusLastMonth':
            return ['online'=>null,  'last_seen_ts'=>null, 'bucket'=>'last_month'];
        default:
            return ['online'=>null,'last_seen_ts'=>null,'bucket'=>null];
    }
}

function build_user_brief(array $user): array {
    return [
        'id'         => (int)($user['id'] ?? 0),
        'first_name' => (string)($user['first_name'] ?? ''),
        'last_name'  => (string)($user['last_name']  ?? ''),
        'username'   => isset($user['username']) ? (string)$user['username'] : null,
        'phone'      => isset($user['phone'])    ? (string)$user['phone']    : null,
        'is_bot'     => (bool)($user['bot'] ?? false),
        'status'     => (isset($user['status']) && is_array($user['status']))
                          ? normalize_user_status($user['status'])
                          : ['online'=>null,'last_seen_ts'=>null,'bucket'=>null],
    ];
}

// Ищем user_id по номеру через contacts.importContacts
function userIdByPhone(API $mp, string $phone): ?int
{
    $phone = normalize_phone($phone);
    if ($phone === '') return null;

    $res = $mp->contacts->importContacts([
        'contacts' => [[
            '_'         => 'inputPhoneContact',
            'client_id' => random_int(1, PHP_INT_MAX),
            'phone'     => $phone,
            'first_name' => ' ',
            'last_name' => ''
        ]],
        'replace' => false
    ]);

    if (!empty($res['imported'][0]['user_id'])) {
        return (int)$res['imported'][0]['user_id'];
    }
    if (!empty($res['users'][0]['id'])) {
        return (int)$res['users'][0]['id'];
    }
    return null;
}

/**
 * [HELPER] Основная функция обработки диалогов.
 * Работает быстро за счет пакетной загрузки всех данных.
 */
function processDialogs(API $mp, array $dialogs, array $options): array
{
    // Шаг 1: Собираем ID всего, что нам нужно будет загрузить
    $userIds = [];
    $chatIds = [];
    $messageIds = [];

    foreach ($dialogs as $dialog) {
        if (!is_array($dialog) || !isset($dialog['peer'])) continue;

        $peer = $dialog['peer'];

        // ДОБАВЬ вот это:
        if (is_int($peer) || (is_string($peer) && ctype_digit($peer))) {
            // это пользователь
            $userIds[(int)$peer] = true;
        } else {
            if (isset($peer['user_id']))    $userIds[$peer['user_id']]     = true;
            if (isset($peer['channel_id'])) $chatIds[$peer['channel_id']]  = true;
            if (isset($peer['chat_id']))    $chatIds[$peer['chat_id']]     = true;
        }

        if (isset($dialog['top_message'])) {
            $messageIds[$dialog['top_message']] = true;
        }
    }

    // Шаг 2-3: Одной-двумя батч-загрузками получаем users/chats/messages
    $userLut = [];
    $chatLut = [];
    $messageLut = [];

    foreach (($options['preloadedUsers'] ?? []) as $u) {
        if (is_array($u) && isset($u['id'])) {
            $userLut[(string)$u['id']] = $u;
        }
    }
    foreach (($options['preloadedChats'] ?? []) as $c) {
        if (is_array($c) && isset($c['id'])) {
            $chatLut[(string)$c['id']] = $c;
        }
    }
    foreach (($options['preloadedMessages'] ?? []) as $m) {
        if (is_array($m) && isset($m['id'])) {
            $messageLut[(string)$m['id']] = $m;
        }
    }

    // Соберём все peers из dialogs
    $peers = [];
    foreach ($dialogs as $d) {
        if (isset($d['peer'])) $peers[] = $d['peer'];
    }

    // Грузим партиями (на всякий)
    if (empty($options['skipPeerDialogFetch'])) {
        foreach (array_chunk($peers, 100) as $chunk) {
            try {
                $pd = $mp->messages->getPeerDialogs(['peers' => $chunk]);

                foreach ($pd['users'] ?? [] as $u) {
                    if (is_array($u)) $userLut[(string)$u['id']] = $u;
                }
                foreach ($pd['chats'] ?? [] as $c) {
                    if (is_array($c)) $chatLut[(string)$c['id']] = $c;
                }
                foreach ($pd['messages'] ?? [] as $m) {
                    if (is_array($m)) $messageLut[(string)$m['id']] = $m;
                }
            } catch (\Throwable $e) {
                // пропускаем неудачную партию
            }
        }
    }

    // Дотягиваем конкретные top_message, если чего-то не хватило
    if (!empty($messageIds) && empty($options['skipTopMessageFetch'])) {
        try {
            $res = $mp->messages->getMessages(['id' => array_values($messageIds)]);
            foreach ($res['messages'] ?? [] as $m) {
                if (is_array($m)) $messageLut[(string)$m['id']] = $m;
            }
        } catch (\Throwable $e) {
        }
    }

    // Шаг 4: Собираем финальный результат, используя быстрые данные из lookup-таблиц
    $rows = [];
    $missingPeerBudget = max(0, (int)($options['missingPeerResolveLimit'] ?? 120));
    foreach ($dialogs as $dialog) {
        if (!is_array($dialog)) continue;

        $chatId = get_chat_id_from_peer($dialog['peer'] ?? null);
        if (!$chatId) continue;

        $peerIdRaw = str_replace(['-100', '-'], '', $chatId);
        $peerData = str_starts_with($chatId, '-') ? ($chatLut[$peerIdRaw] ?? null) : ($userLut[$peerIdRaw] ?? null);
        // The dialog itself is authoritative even if Madeline's compact page
        // omitted the associated chat entity.  Keeping that row is safer than
        // silently hiding a group or channel; the next normal sync can enrich
        // its title and avatar once the entity becomes available.
        if (!is_array($peerData)) $peerData = [];
        if (!$peerData && $missingPeerBudget > 0) {
            $missingPeerBudget--;
            $peerData = resolve_missing_dialog_peer($mp, $chatId);
        }

        $lastMessage = $messageLut[$dialog['top_message']] ?? null;

        $isBot = !empty($peerData['bot']);
        if (($options['humansOnly'] ?? false) && (str_starts_with($chatId, '-') || $isBot)) continue;
        if (($options['botsOnly'] ?? false) && !$isBot) continue;
        $folderId = (int)($dialog['folder_id'] ?? 0);
        if (($options['folderFilter'] ?? null) !== null && $folderId !== $options['folderFilter']) continue;

        $name = trim(($peerData['first_name'] ?? '') . ' ' . ($peerData['last_name'] ?? ''));
        if ($name === '') $name = $peerData['title'] ?? "Telegram {$chatId}";

        $lmId = null;
        $lmTime = 0;
        $lmOut = false;
        $lmType = 'text';
        $lmText = $lastMessage['message'] ?? '';
        $lmService = is_array($lastMessage) ? tg_service_event($lastMessage) : null;

        if ($lastMessage) {
            if ($lmService !== null) {
                $lmType = 'service';
                $lmText = (string)$lmService['label'];
            }
            $lmId  = (int)($lastMessage['id'] ?? 0);
            $lmTime = (int)($lastMessage['date'] ?? 0);
            $lmOut  = !empty($lastMessage['out']);

            if (!empty($lastMessage['media'])) {
                $media  = $lastMessage['media'];
                $lmType = 'document';

                if (isset($media['photo'])) {
                    $lmType = 'photo';
                } elseif (isset($media['document'])) {
                    $docMime = strtolower((string)($media['document']['mime_type'] ?? ''));
                    if (str_starts_with($docMime, 'image/webp')) {
                        $lmType = 'sticker';
                    } elseif (str_starts_with($docMime, 'video/')) {
                        $lmType = 'video';
                    } elseif (str_starts_with($docMime, 'audio/')) {
                        $lmType = 'audio';
                    } else {
                        $lmType = 'document';
                    }

                    // если текста нет — попробуем подставить имя файла
                    if ($lmText === '') {
                        foreach ($media['document']['attributes'] ?? [] as $a) {
                            if (($a['_'] ?? '') === 'documentAttributeFilename' && !empty($a['file_name'])) {
                                $lmText = (string)$a['file_name'];
                                break;
                            }
                        }
                    }
                }
                // ВАЖНО: не подставляем здесь [Type] — если lmText пустой, клиент сам покажет плейсхолдер
            } else {
                if ($lmText === '') $lmText = '[Пустое сообщение]';
            }
        }

        $rout = (int)($dialog['read_outbox_max_id'] ?? 0);
        $lmRead = ($lmId && $lmOut) ? (int)($lmId <= $rout) : 0;
        $avatarUrl = avatar_url_if_cached($chatId);
        // Важно: список чатов должен быть лёгким и не блокировать MadelineProto.
        // Живые докачки аватарок из getChats/getRecentChats на слабом сервере
        // держали REST по десятки секунд и тянули за собой общий sync.
        // Здесь используем только уже готовый кэш; обновление аватарок остаётся
        // отдельным точечным действием через getPeerAvatar.

        $rows[] = [
            'id' => $chatId,
            'name' => $name,
            'username' => isset($peerData['username']) ? '@' . $peerData['username'] : null,
            'is_bot' => $isBot,
            'avatarUrl' => $avatarUrl,
            // Lets the adapter distinguish an entity without a photo from a
            // temporary cache miss.  The URL is still cache-only here.
            'avatar_available' => !empty($peerData['photo']),
            'unread_count' => (int)($dialog['unread_count'] ?? 0),
            'last_message_id' => $lmId,
            'last_message_type' => $lmType,
            'last_message_text' => $lmText,
            'last_message_time' => $lmTime,
            'last_message_is_out' => $lmOut,
            'last_message_is_read' => $lmRead,
            'folder_id' => $folderId,
            'is_archived' => $folderId === 1,
            'chat_kind' => tg_dialog_kind($chatId, $peerData),
            ...(isset($options['dialogFilters']) ? ['folders' => tg_dialog_folders($options['dialogFilters'], $chatId, $dialog, $peerData)] : []),
            'last_message_is_service' => $lmService !== null,
            'last_message_service_event' => $lmService['event'] ?? '',
            'last_message_event_style' => $lmService['style'] ?? '',
        ];
    }

    if ($options['orderByLast'] ?? false) {
        usort($rows, fn($a, $b) => ($b['last_message_time'] <=> $a['last_message_time']));
    }
    $limit = $options['limit'] ?? 100;
    if ($limit > 0 && count($rows) > $limit) {
        $rows = array_slice($rows, 0, $limit);
    }

    return $rows;
}


// Нормализуем цель в вид, который понимает MadelineProto downloadToBytes
function tg_normalize_peer_for_download(API $mp, string $target)
{
    $target = trim($target);
    if ($target === '') return null;

    // username
    if ($target[0] === '@') {
        $info = $mp->getInfo($target);         // подтянет entity + access_hash
        return $info['InputPeer'] ?? $target;  // prefer InputPeer
    }

    // channel/supergroup: -100..., basic-group: -...
    if ($target[0] === '-') {
        // Madeline сам умеет резолвить numeric peer, но лучше всё же через getInfo
        try {
            $info = $mp->getInfo($target);     // может быть '-100123...'
            if (!empty($info['InputPeer'])) return $info['InputPeer'];
        } catch (\Throwable $e) {
        }
        return $target;
    }

    // user id (число в строке)
    if (ctype_digit($target)) {
        try {
            $info = $mp->getInfo((int)$target);
            if (!empty($info['InputPeer'])) return $info['InputPeer'];
        } catch (\Throwable $e) {
        }
        // fallback: просто id, Madeline попробует резолвить сам
        return (int)$target;
    }

    // на всякий — вернём как есть
    return $target;
}

function tg_guess_image_mime(string $bytes): string
{
    // простая сигнатурная проверка
    if (strncmp($bytes, "\x89PNG", 4) === 0) return 'image/png';
    if (substr($bytes, 0, 3) === "\xFF\xD8\xFF") return 'image/jpeg';
    if (substr($bytes, 0, 4) === "RIFF" && substr($bytes, 8, 4) === "WEBP") return 'image/webp';
    if (strncmp($bytes, "GIF8", 4) === 0) return 'image/gif';
    return 'image/jpeg';
}

// === ДОБАВЬ ЭТОТ ХЕЛПЕР рядом с остальными функциями-хелперами ===
function try_download_photo_to_file(API $mp, $candidate, string $tmp): bool
{
    // 1) Попытка как есть (если TL-объект фото)
    try {
        $mp->downloadToFile($candidate, $tmp);
        if (is_file($tmp) && filesize($tmp) > 0 && str_starts_with(detect_mime($tmp), 'image/')) {
            return true;
        }
    } catch (\Throwable $e) {
    }

    // 2) Если это массив — пробуем типичные ключи
    if (is_array($candidate)) {
        foreach (['full', 'big', 'small', 'photo', 'photo_big', 'photo_small'] as $k) {
            if (!empty($candidate[$k])) {
                try {
                    $mp->downloadToFile($candidate[$k], $tmp);
                    if (is_file($tmp) && filesize($tmp) > 0 && str_starts_with(detect_mime($tmp), 'image/')) {
                        return true;
                    }
                } catch (\Throwable $e) {
                }
            }
        }
    }
    return false;
}

function avatar_url_if_cached(string $key): ?string
{
    foreach (['jpg', 'jpeg', 'png', 'webp', 'gif'] as $ext) {
        $fs = AVA_DIR . "/{$key}.{$ext}";
        if (is_file($fs) && filesize($fs) > 0) {
            return AVA_URL . "/{$key}.{$ext}";
        }
    }
    return null;
}

function persist_peer_avatar_file(string $tmpFile, string $key): ?string
{
    if (!is_file($tmpFile) || filesize($tmpFile) <= 0) return null;
    $mime = detect_mime($tmpFile, true, 'image/jpeg');
    $ext = str_contains($mime, 'png') ? 'png' : (str_contains($mime, 'webp') ? 'webp' : 'jpg');
    $finalPath = AVA_DIR . "/{$key}.{$ext}";
    foreach (['jpg', 'jpeg', 'png', 'webp', 'gif'] as $old_ext) {
        $old_fs = AVA_DIR . "/{$key}.{$old_ext}";
        if (is_file($old_fs) && $old_fs !== $finalPath) @unlink($old_fs);
    }
    @rename($tmpFile, $finalPath);
    @chmod($finalPath, 0664);
    return is_file($finalPath) ? tg_media_host() . AVA_URL . "/{$key}.{$ext}" : null;
}

function download_and_cache_peer_avatar(API $mp, string $peerRaw): ?string
{
    if ($peerRaw === '') {
        return null;
    }

    if (!method_exists($mp, 'downloadToFile')) {
        return null;
    }

    // Ключ для имени файла, очищенный от лишних символов
    $key = preg_replace('~[^0-9A-Za-z_@.-]+~', '_', $peerRaw);
    $tmpFile = rtrim(TMPDIR, '/') . '/ava_' . uniqid('', true);

    try {
        // Numeric channel IDs do not always contain enough information for
        // downloadProfilePhoto().  Try the resolved Chat/User entity as well.
        $candidates = [$peerRaw];
        $photoLocation = null;
        try {
            $info = $mp->getInfo($peerRaw);
            foreach (['InputPeer', 'Chat', 'User', 'chat', 'user'] as $name) {
                if (isset($info[$name]) && is_array($info[$name])) {
                    $candidates[] = $info[$name];
                }
            }
            // Some Madeline versions expose the entity but omit InputPeer.
            // Rebuild the TL input peer from its access hash in that case.
            $entity = is_array($info['Chat'] ?? null) ? $info['Chat'] : (is_array($info['User'] ?? null) ? $info['User'] : null);
            if (is_array($entity) && isset($entity['access_hash'], $entity['id'])) {
                $entityType = (string)($entity['_'] ?? '');
                $entityId = (int)$entity['id'];
                if ($entityType === 'channel') {
                    $rawChannelId = str_starts_with((string)$entityId, '-100')
                        ? (int)substr((string)$entityId, 4)
                        : abs($entityId);
                    if ($rawChannelId > 0) {
                        $constructedInput = [
                            '_' => 'inputPeerChannel',
                            'channel_id' => $rawChannelId,
                            'access_hash' => (int)$entity['access_hash'],
                        ];
                        $candidates[] = $constructedInput;
                        $photoId = (int)($entity['photo']['photo_id'] ?? 0);
                        if ($photoId > 0) {
                            $photoLocation = [
                                '_' => 'inputPeerPhotoFileLocation',
                                'peer' => $constructedInput,
                                'photo_id' => $photoId,
                                'big' => true,
                            ];
                        }
                    }
                } elseif ($entityType === 'user' && $entityId > 0) {
                    $constructedInput = [
                        '_' => 'inputPeerUser',
                        'user_id' => $entityId,
                        'access_hash' => (int)$entity['access_hash'],
                    ];
                    $candidates[] = $constructedInput;
                    $photoId = (int)($entity['photo']['photo_id'] ?? 0);
                    if ($photoId > 0) {
                        $photoLocation = [
                            '_' => 'inputPeerPhotoFileLocation',
                            'peer' => $constructedInput,
                            'photo_id' => $photoId,
                            'big' => true,
                        ];
                    }
                }
            }
        } catch (\Throwable $ignored) {
        }

        foreach ($candidates as $candidate) {
            try {
                if (is_file($tmpFile)) @unlink($tmpFile);
                if (!try_download_photo_to_file($mp, $candidate, $tmpFile)) continue;

                $cached = persist_peer_avatar_file($tmpFile, $key);
                if ($cached !== null) return $cached;
            } catch (\Throwable $ignored) {
                // Try the next representation of this peer.
            }
        }

        if (is_array($photoLocation) && try_download_photo_to_file($mp, $photoLocation, $tmpFile)) {
            $cached = persist_peer_avatar_file($tmpFile, $key);
            if ($cached !== null) return $cached;
        }
    } catch (\Throwable $e) {
        // The dialog's peer ID sometimes is not enough for downloadProfilePhoto
        // in MadelineProto 8. Ask its peer resolver for the complete photo TL
        // object and download that as a fallback.
        try {
            $pwr = $mp->getPwrChat($peerRaw);
            $fallback = is_array($pwr) ? ($pwr['photo'] ?? null) : null;
            $cached = cache_peer_avatar_candidate($mp, $fallback, $peerRaw);
            if ($cached !== null) return $cached;
        } catch (\Throwable $ignored) {
        }
        log_err('download_and_cache_peer_avatar error', ['peer' => $peerRaw, 'err' => $e->getMessage()]);
    } finally {
        if (isset($tmpFile) && is_file($tmpFile)) {
            @unlink($tmpFile);
        }
    }

    return null; // Возвращаем null, если ничего не получилось
}

/** @return array<string,string> */
function tg_group_sender_brief(API $mp, array $message, array &$usersById, int &$resolveBudget, int &$avatarBudget): array
{
    $senderId = canonical_chat_id($message['from_id'] ?? $message['peer_id'] ?? null);
    if ($senderId === null || $senderId === '') return [];

    $user = $usersById[$senderId] ?? [];
    if (!$user && $resolveBudget > 0) {
        $resolveBudget--;
        $user = resolve_missing_dialog_peer($mp, $senderId);
        if ($user) $usersById[$senderId] = $user;
    }
    if (!$user) return ['sender_id' => $senderId];

    $username = ltrim(trim((string)($user['username'] ?? '')), '@');
    $name = trim((string)($user['first_name'] ?? '') . ' ' . (string)($user['last_name'] ?? ''));
    if ($name === '') $name = trim((string)($user['title'] ?? ''));
    if ($name === '') $name = $username === '' ? '' : '@' . $username;

    $avatar = avatar_url_if_cached($senderId);
    if ($avatar === null && !empty($user['photo']) && $avatarBudget > 0) {
        $avatarBudget--;
        $avatar = download_and_cache_peer_avatar($mp, $senderId);
    }

    return array_filter([
        'sender_id' => $senderId,
        // Direct Telegram history does not yet expose a separate group-member
        // profile endpoint. Keep the name static instead of opening the group
        // itself as though it were the author.
        'sender_name' => $name,
        'sender_username' => $username === '' ? '' : '@' . $username,
        'sender_avatar' => $avatar ?? '',
    ], static fn($value) => $value !== '');
}


/**
 * tg_reactions_detailed:
 * из Telegram MessageReactions собирает массив вида
 * [{ emoji, count, actors: [{id, avatar}] }]
 * actors берутся из recent_reactions (если видим), аватар — если уже лежит в кэше.
 */
/**
 * tg_reactions_detailed:
 * Собирает массив [{ emoji, count, actors: [{id}] }]
 * ВАЖНО: НЕ отправляет URL аватара, только ID. Фронтенд запросит его сам.
 */
function tg_reactions_detailed(array $rx): array
{
    $byEmoji = [];
    
    // 1) Сначала собираем общее количество для каждого эмодзи из 'results'
    foreach (($rx['results'] ?? []) as $r) {
        $emo = $r['reaction']['emoticon'] ?? null;
        $cnt = (int)($r['count'] ?? 0);
        if (!$emo || $cnt <= 0) continue;
        
        if (!isset($byEmoji[$emo])) {
            $byEmoji[$emo] = ['emoji' => $emo, 'count' => 0, 'me' => false, 'actors' => []];
        }
        $byEmoji[$emo]['count'] += $cnt;
        // Telegram marks the current account's reaction with chosen_order.
        // This is the reliable signal when recent_reactions has no actor row.
        if (array_key_exists('chosen_order', $r) || !empty($r['chosen'])) {
            $byEmoji[$emo]['me'] = true;
        }
    }

    // 2) Затем добавляем информацию об авторах из 'recent_reactions'
    foreach (($rx['recent_reactions'] ?? []) as $rr) {
        $emo = $rr['reaction']['emoticon'] ?? null;
        if (!$emo) continue;
        
        $peer = $rr['peer_id'] ?? null;
        $aid = canonical_chat_id($peer); // Получаем ID пользователя
        if (!$aid) continue;

        if (!isset($byEmoji[$emo])) {
            $byEmoji[$emo] = ['emoji' => $emo, 'count' => 0, 'me' => false, 'actors' => []];
        }

        // --- ИЗМЕНЕНИЕ ЗДЕСЬ ---
        // Теперь avatar_url_if_cached() будет возвращать полный URL
        $avatarUrl = avatar_url_if_cached($aid);
        $byEmoji[$emo]['actors'][] = ['id' => (string)$aid, 'avatarUrl' => $avatarUrl];
        // -------------------------
    }

    // Финальная корректировка: если в 'results' не было данных, а только в 'recent_reactions',
    // то 'count' может быть 0. Установим его равным количеству найденных акторов.
    foreach ($byEmoji as &$entry) {
        if ($entry['count'] === 0) {
            $entry['count'] = count($entry['actors']);
        }
        
        // Удаляем дубликаты акторов
        $uniqueActors = [];
        $ids = [];
        foreach($entry['actors'] as $actor) {
            if (!in_array($actor['id'], $ids)) {
                $uniqueActors[] = $actor;
                $ids[] = $actor['id'];
            }
        }
        $entry['actors'] = $uniqueActors;
    }
    unset($entry);

    return array_values($byEmoji);
}

/* ---------------- ACTIONS ---------------- */
ensure_dirs();

$payload = json_input();

// V-- ДОБАВЬТЕ ЭТУ СТРОКУ
$clientUid = is_string($payload['client_uid'] ?? null) ? $payload['client_uid'] : null;
// A-- ДОБАВЬТЕ ЭТУ СТРОКУ
$action  = $_GET['action'] ?? $payload['action'] ?? null;
if (!$action) ok(['status' => 'ok']);

try {
    switch ($action) {
        case 'getDiscussion': {
            $channel = (string)($payload['chatId'] ?? '');
            $post = (int)($payload['messageId'] ?? 0);
            if (!preg_match('/^-100[0-9]+$/D', $channel) || $post < 1) fail('Invalid discussion');
            require_once __DIR__ . '/discussion.php';
            $mp = start_madeline_locked();
            try { $result = tg_discussion_page($mp, $channel, $post, (int)($payload['before'] ?? 0)); }
            finally { finish_madeline_locked($mp); }
            ok($result);
        }


        case 'prefetchMediaBatch': {
                $items = $payload['items'] ?? [];
                if (empty($items) || !is_array($items)) fail('`items` array is required');

                $async = (int)($payload['async'] ?? 0) === 1;

                if ($async) {
                    rlog('Accepted items=' . count($items));
                    header('Content-Type: application/json');
                    http_response_code(202);
                    echo json_encode(['status' => 'accepted', 'items' => count($items)], JSON_UNESCAPED_UNICODE);
                    if (function_exists('fastcgi_finish_request')) fastcgi_finish_request();
                }

                $resultsMap = [];
                $mp = start_madeline_locked(); // Запускаем MadelineProto ОДИН РАЗ
                try {
                    foreach ($items as $item) {
                        $peer = (string)($item['chatId'] ?? '');
                        $mid = (int)($item['messageId'] ?? 0);
                        if ($peer === '' || $mid <= 0) continue;

                        $key = "{$peer}:{$mid}";
                        $cacheKey = sha1($peer . '#' . $mid);
                        $cacheDir = rtrim(TMPDIR, '/') . '/cache';
                        $cachePath = $cacheDir . '/' . $cacheKey;

                        rlog("Prefetch start chatId={$peer} mid={$mid} key={$cacheKey} path={$cachePath}");


                        // 1. Сначала проверяем кэш
                        if (tg_media_cache_is_complete($cachePath)) {
                            $ext = tg_ext_by_mime(detect_mime($cachePath, true, 'application/octet-stream'));
                            $resultsMap[$key] = [
                                // e-вариант с расширением
                                'cache_url'  => rtrim(BASE_URL_MADELINE, '/') . '/telegram_cache_e/' . $cacheKey . $ext,
                                'ensure_url' => tg_media_host() . '/ensure/' . $cacheKey,
                                'public_url' => tg_media_host() . '/pub/'    . $cacheKey,
                            ];
                            continue;
                        }

                        // 2. Если в кэше нет - скачиваем
                        try {
                            $m = $mp->messages->getMessages(['peer' => $peer, 'id' => [$mid]])['messages'][0] ?? null;
                            if ($m && !empty($m['media'])) {
                                if (is_file($cachePath)) tg_forget_incomplete_media_cache($cachePath);
                                $tmp = tg_track_temporary_media_file($cacheDir . '/' . uniqid('dl_'));
                                $mp->downloadToFile($m, $tmp);
                                if (is_file($tmp) && filesize($tmp) > 0) {
                                    if (!tg_publish_downloaded_media_cache(
                                        $tmp,
                                        $cachePath,
                                        detect_mime($tmp, true, 'application/octet-stream')
                                    )) {
                                        @unlink($tmp);
                                        tg_untrack_temporary_media_file($tmp);
                                        continue;
                                    }
                                    tg_untrack_temporary_media_file($tmp);
                                    $ext = tg_ext_by_mime(detect_mime($cachePath, true, 'application/octet-stream'));
                                    $resultsMap[$key] = [
                                        'cache_url'  => rtrim(BASE_URL_MADELINE, '/') . '/telegram_cache_e/' . $cacheKey . $ext,
                                        'ensure_url' => tg_media_host() . '/ensure/' . $cacheKey,
                                        'public_url' => tg_media_host() . '/pub/'    . $cacheKey,
                                    ];


                                    // =================================================================
                                    // ===== НАЧАЛО: Добавляем проактивное кэширование превью =====
                                    // =================================================================

                                    // 1. Определяем путь для кэша превью (точно так же, как в downloadThumb)
                                    $thumbPath = $cacheDir . '/th_' . sha1($peer . '#' . $mid) . '.jpg';

                                    // 2. Кэшируем, только если его еще нет
                                    if (!is_file($thumbPath) || filesize($thumbPath) === 0) {
                                        $thumbTmp = $cacheDir . '/' . uniqid('dl_thumb_');
                                        $thumbDownloaded = false;
                                        $media = $m['media'];

                                        try {
                                            // 3. Пытаемся скачать превью (логика скопирована из downloadThumb)
                                            if (isset($media['photo'])) {
                                                $mp->downloadToFile($media['photo'], $thumbTmp);
                                                $thumbDownloaded = true;
                                            } elseif (isset($media['document']['thumbs'][0])) {
                                                $mp->downloadToFile($media['document']['thumbs'][0], $thumbTmp);
                                                $thumbDownloaded = true;
                                            }

                                            // 4. Если успешно скачали - сохраняем в кэш
                                            if ($thumbDownloaded && is_file($thumbTmp) && filesize($thumbTmp) > 0) {
                                                @rename($thumbTmp, $thumbPath);
                                            }
                                        } catch (\Throwable $e) {
                                            // Ничего страшного, если превью не скачалось, основной файл уже в кэше
                                            log_err('prefetchMediaBatch thumb failed', ['chatId' => $peer, 'msgId' => $mid, 'error' => $e->getMessage()]);
                                        } finally {
                                            if (is_file($thumbTmp)) @unlink($thumbTmp); // Чистим временный файл
                                        }
                                    }
                                    // =================================================================
                                    // ===== КОНЕЦ: Добавляем проактивное кэширование превью =====
                                    // =================================================================
                                }
                            }
                        } catch (\Throwable $e) {
                            // Тихо игнорируем ошибки для отдельных файлов, чтобы не ломать всю пачку
                            log_err('prefetchMediaBatch item failed', ['chatId' => $peer, 'msgId' => $mid, 'error' => $e->getMessage()]);
                        }
                    }
                } finally {
                    finish_madeline_locked($mp); // Завершаем сессию MadelineProto ОДИН РАЗ
                }

                // Возвращаем карту со всеми успешно закэшированными файлами
                ok(['map' => $resultsMap]);
                break; // Не забудьте break
            }


        case 'deleteMessages': {
            $peer = (string)($payload['chatId'] ?? '');
            $ids = $payload['ids'] ?? [];
            // Ensure IDs are integers
            $messageIds = array_map('intval', is_array($ids) ? $ids : [$ids]);
            // 'revoke' means delete for everyone
            $revoke = (bool)($payload['revoke'] ?? true);
        
            if ($peer === '' || empty($messageIds)) {
                fail('chatId and at least one message ID in `ids` are required');
            }
        
            $mp = start_madeline_locked();
            try {
                $res = $mp->messages->deleteMessages([
                    'id'     => $messageIds,
                    'revoke' => $revoke, // true to delete for everyone
                ]);
                ok(['success' => true, 'result' => $res]);
            } finally {
                finish_madeline_locked($mp);
            }
            break; // Important: Add break
        }
        // ---> END: ADDED DELETE MESSAGES ACTION


case 'send_message':
case 'sendMessage': {
    $peer = (string)($payload['chatId'] ?? $payload['chat_id'] ?? '');
    if ($peer === '') fail('chatId is required');

    $caption   = (string)($payload['message'] ?? $payload['caption'] ?? ''); // Добавил 'caption' для совместимости
    $replyToId = (int)($payload['reply_to_message_id'] ?? 0);
    $attachments = $payload['attachments'] ?? [];

    $mp = start_madeline_locked();
    try {
        // =================================================================================
        // --- НАЧАЛО: БЛОК ПРОВЕРКИ ЛОКАЛЬНЫХ ФАЙЛОВ (логика из old_rest.php) ---
        // =================================================================================

        $tmp = null;
        $tmpIsOwn = false;
        $mime = 'application/octet-stream';
        $name = 'file.bin';

        // перед проверками 1) и 2) — сразу после $mp = start_madeline_locked();
if (empty($_FILES['file']) && !empty($_FILES['attachment'])) {
    // Принять старое имя поля от внешнего сервиса
    $_FILES['file'] = $_FILES['attachment'];
}

        // 1. Проверяем multipart/form-data (стандартная загрузка файла)
        // ВАЖНО: имя поля должно быть 'file', как в старом скрипте, или измените его здесь.
        if (!empty($_FILES['file']) && is_uploaded_file($_FILES['file']['tmp_name'])) {
            $tmp  = $_FILES['file']['tmp_name'];
            $name = $_FILES['file']['name'] ?? $name;
            $mime = $_FILES['file']['type'] ?: (mime_content_type($tmp) ?: $mime);
        }
        // 2. Проверяем base64 в JSON-теле запроса
        elseif (!empty($payload['file']) && is_array($payload['file']) && !empty($payload['file']['base64'])) {
            $name = basename((string)($payload['file']['name'] ?? $name));
            $data = (string)$payload['file']['base64'];
            $data = preg_replace('#^data:[^;]+;base64,#', '', $data);
            $bin  = base64_decode($data, true);
            if ($bin === false) fail('invalid base64', 400);
            $tmp = rtrim(TMPDIR, '/') . '/' . uniqid('tg_up_', true) . '_' . $name;
            file_put_contents($tmp, $bin);
            $tmpIsOwn = true;
            $mime = (string)($payload['file']['mime'] ?? mime_content_type($tmp) ?: $mime);
        }

        // Если один из локальных файлов был найден, отправляем его и выходим
        if ($tmp && is_readable($tmp) && filesize($tmp) > 0) {
            try {
                $uploaded = $mp->upload($tmp, $name);

                if (str_starts_with($mime, 'image/') && strtolower(pathinfo($name, PATHINFO_EXTENSION)) !== 'gif') {
                    $media = ['_' => 'inputMediaUploadedPhoto', 'file' => $uploaded];
                } else {
                    $attrs = [['_' => 'documentAttributeFilename', 'file_name' => $name]];
                    if (str_starts_with($mime, 'video/')) {
                        $attrs[] = ['_' => 'documentAttributeVideo', 'supports_streaming' => true];
                    } elseif (str_starts_with($mime, 'audio/')) {
                        $attrs[] = ['_' => 'documentAttributeAudio'];
                    }
                    $media = [
                        '_'          => 'inputMediaUploadedDocument',
                        'file'       => $uploaded,
                        'mime_type'  => $mime,
                        'attributes' => $attrs
                    ];
                }
                
                $params = ['peer' => $peer, 'media' => $media, 'message' => $caption];
                if ($replyToId > 0) {
                    $params['reply_to'] = ['_' => 'inputReplyToMessage', 'reply_to_msg_id' => $replyToId];
                }

                $res = $mp->messages->sendMedia($params);

                [$msgId, $date] = extract_sent_message_meta($res);
                if (!$msgId) fail('Telegram did not confirm media message', 502);

                ok(['success' => true, 'message_id' => $msgId, 'date' => $date, 'client_uid' => $clientUid, 'via' => 'upload']);

            } catch (\Throwable $e) {
                log_err('sendFile upload error (old logic)', ['err' => $e->getMessage()]);
                fail('SEND ERROR: ' . $e->getMessage(), 500);
            } finally {
                if ($tmpIsOwn && is_file($tmp)) @unlink($tmp);
                // Важно! Завершаем выполнение, так как файл уже отправлен.
                finish_madeline_locked($mp);
                return; 
            }
        }

        // ===============================================================================
        // --- КОНЕЦ: БЛОК ПРОВЕРКИ ЛОКАЛЬНЫХ ФАЙЛОВ ---
        // --- Если мы здесь, значит локальных файлов не было, выполняем новую логику ---
        // ===============================================================================

        $base_params = ['peer' => $peer];
        if ($replyToId > 0) {
            $base_params['reply_to'] = ['_' => 'inputReplyToMessage', 'reply_to_msg_id' => $replyToId];
        }

        // Если нет ни локальных файлов, ни вложений по URL, отправляем просто текст
        if (empty($attachments)) {
            if ($caption === '') fail('message text is required for text messages');
            $base_params['message'] = $caption;
            $res = $mp->messages->sendMessage($base_params);
        } else {
            // Новая логика для обработки вложений по URL (остается без изменений)
            $photo_album = [];
            $video_urls  = [];

            foreach ($attachments as $att) {
                $url = trim((string)($att['url'] ?? ''));
                if ($url === '') continue;

                $user_type = strtolower($att['type'] ?? '');
                $is_photo = $user_type === 'photo'
                    || preg_match('/\.(jpe?g|png|webp)(\?.*)?$/i', $url);
                $is_video = $user_type === 'video'
                    || preg_match('/\.(mp4|mov|m4v|webm)(\?.*)?$/i', $url);

                if ($is_photo) {
                    $photo_album[] = [
                        '_'         => 'inputSingleMedia',
                        'media'     => ['_' => 'inputMediaPhotoExternal', 'url' => $url],
                        'message'   => '',
                        'random_id' => danog\MadelineProto\Tools::randomInt(0, PHP_INT_MAX),
                    ];
                } elseif ($is_video) {
                    $video_urls[] = $url;
                }
            }

            if (empty($photo_album) && empty($video_urls)) {
                // Если в attachments были переданы невалидные URL, но есть текст, отправим текст
                if ($caption !== '') {
                     $base_params['message'] = $caption;
                     $res = $mp->messages->sendMessage($base_params);
                } else {
                    fail('No valid URLs or text to send');
                }
            } else {
                $res = null;
                $is_first = true;
    
                if (count($photo_album) === 1) {
                    $params = $base_params;
                    $params['media'] = $photo_album[0]['media'];
                    $send_result = $mp->messages->sendMedia(
                        peer: $params['peer'],
                        media: $params['media'],
                        message: $caption,
                        reply_to: $params['reply_to'] ?? null
                    );
                    [$mid] = extract_sent_message_meta($send_result);
                    if (!$mid) fail('Telegram did not confirm sending for single photo.', 502);
                    $res = $send_result;
                    $is_first = false;
                } elseif (count($photo_album) > 1) {
                    if ($caption !== '') $photo_album[0]['message'] = $caption;
                    $params = $base_params;
                    $params['multi_media'] = $photo_album;
                    $send_result = $mp->messages->sendMultiMedia($params);
                    [$mid] = extract_sent_message_meta($send_result);
                    if (!$mid) fail('Telegram did not confirm sending for photo album.', 502);
                    $res = $send_result;
                    $is_first = false;
                }
    
                foreach ($video_urls as $vurl) {
                    $params = $base_params;
                    if (!$is_first) unset($params['reply_to']);
                    $params['media'] = [
                        '_'         => 'inputMediaDocumentExternal',
                        'url'       => $vurl,
                        'attributes'=> [
                            ['_' => 'documentAttributeVideo', 'supports_streaming' => true],
                        ],
                    ];
                    if ($is_first && $caption !== '') $params['message'] = $caption;
                    $send_result = $mp->messages->sendMedia($params);
                    [$mid] = extract_sent_message_meta($send_result);
                    if (!$mid) fail('Telegram did not confirm sending for video.', 502);
                    $res = $send_result;
                    $is_first = false;
                }
            }
        }

        [$msgId, $date] = extract_sent_message_meta($res);
        if (!$msgId) fail('An unexpected error occurred after sending.', 500);

        ok(['success' => true, 'chat_id' => (string)$peer, 'message_id' => $msgId, 'date' => $date, 'client_uid' => $clientUid, 'info' => 'Message sent successfully']);
    } finally {
        finish_madeline_locked($mp);
    }
    break;
}

case 'upload': {
    // multipart: <input name="attachment">
    if (empty($_FILES['attachment']) || $_FILES['attachment']['error'] !== UPLOAD_ERR_OK) {
        fail('no file', 400);
    }
    $f = $_FILES['attachment'];
    $ext = strtolower(pathinfo($f['name'], PATHINFO_EXTENSION));
    if ($ext === '') $ext = 'bin';
    $name = bin2hex(random_bytes(16)) . '.' . $ext;

    $dir = __DIR__ . '/uploads';
    if (!is_dir($dir)) @mkdir($dir, 0775, true);

    $fs = "$dir/$name";
    if (!move_uploaded_file($f['tmp_name'], $fs)) {
        fail('move_failed', 500);
    }
    @chmod($fs, 0664);

    // отдаём URL, по которому фронт потом воспользуется в attachments
    $publicUrl = '/telegram_service/uploads/' . $name;
    ok(['success' => true, 'url' => $publicUrl]);
}


        case 'deleteHistory': { // удалить историю диалога
                $peer = (string)($payload['chatId'] ?? $payload['peer'] ?? '');
                if ($peer === '') fail('chatId is required');

                $revoke     = (bool)($payload['revoke'] ?? false);     // удалить у всех
                $justClear  = (bool)($payload['just_clear'] ?? false); // удалить только у себя
                $maxId      = (int)($payload['max_id'] ?? 0);

                $mp = start_madeline_locked();
                try {
                    $res = $mp->messages->deleteHistory([
                        'peer'       => $peer,
                        'revoke'     => $revoke,
                        'just_clear' => $justClear,
                        'max_id'     => $maxId
                    ]);
                    ok(['success' => true, 'result' => $res]);
                } finally {
                    finish_madeline_locked($mp);
                }
            }

        case 'blockContact': { // опционально: блокировка
                $peer = (string)($payload['chatId'] ?? '');
                if ($peer === '') fail('chatId is required');
                $mp = start_madeline_locked();
                try {
                    $res = $mp->contacts->block(['id' => $peer]);
                    ok(['success' => (bool)$res]);
                } finally {
                    finish_madeline_locked($mp);
                }
            }

        case 'deleteContactByPhone': { // опционально: убрать из контактов
                $phone = (string)($payload['phone'] ?? '');
                if ($phone === '') fail('phone is required');
                $mp = start_madeline_locked();
                try {
                    $res = $mp->contacts->deleteByPhones(['phones' => [$phone]]);
                    ok(['success' => (bool)$res]);
                } finally {
                    finish_madeline_locked($mp);
                }
            }


        case 'diag': {
                $mp = start_madeline_locked();
                try {
                    $cnt = null;
                    try {
                        $d = $mp->getFullDialogs();
                        if ($d instanceof \Traversable) $cnt = iterator_count($d);
                        elseif (is_array($d)) $cnt = count($d);
                    } catch (\Throwable $e) {
                    }

                    ok(['sessionPath' => SESSION, 'count' => $cnt, 'tmpDir' => TMPDIR, 'cacheDir' => CACHE_DIR, 'avatarDir' => AVA_DIR]);
                } finally {
                    finish_madeline_locked($mp);
                }
            }

        case 'getPeerAvatar': {
    $peerRaw = (string)($payload['chatId'] ?? $payload['target'] ?? '');
    if ($peerRaw === '') fail('chatId or target required', 400);

    $refresh = (int)($payload['refresh'] ?? 0) === 1;
    $key = preg_replace('~[^0-9A-Za-z_@.-]+~', '_', $peerRaw);

    // Если не требуется принудительное обновление, сначала проверим кэш
    if (!$refresh) {
        $cachedUrl = avatar_url_if_cached($key);
        if ($cachedUrl) {
            $fsPath = AVA_DIR . "/" . basename($cachedUrl);
            ok(['url' => $cachedUrl, 'mime' => mime_content_type($fsPath) ?: 'image/jpeg']);
        }
    }

    // Если в кэше нет или требуется обновить
    $mp = start_madeline_locked();
    try {
        $newUrl = download_and_cache_peer_avatar($mp, $peerRaw);
        if ($newUrl) {
            $fsPath = AVA_DIR . "/" . basename($newUrl);
            ok(['url' => $newUrl, 'mime' => mime_content_type($fsPath) ?: 'image/jpeg']);
        } else {
            fail('No avatar for this peer', 404);
        }
    } catch (\Throwable $e) {
        log_err('getPeerAvatar error', ['peer' => $peerRaw, 'err' => $e->getMessage()]);
        fail('Failed to download avatar: ' . $e->getMessage(), 500);
    } finally {
        finish_madeline_locked($mp);
    }
    break;
}

case 'getPeerRaw':
    if (!isset($_GET['peerId'])) {
        http_response_code(400);
        echo json_encode(['error' => 'Missing peerId parameter']);
        break;
    }

    $mp = start_madeline_locked();
    try {
        $peerId = (int)$_GET['peerId'];
        $info = $mp->getInfo($peerId);
        
        header('Content-Type: application/json');
        echo json_encode($info, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE);
        
    } catch (\Throwable $e) {
        http_response_code(500);
        echo json_encode(['error' => $e->getMessage()]);
    } finally {
        finish_madeline_locked($mp);
    }
    break;

        case 'whoami': {
    $mp = start_madeline_locked();
    try {
        $me = $mp->getSelf();
        $myId = (string)($me['id'] ?? '');

        $avatarUrl = null;
        if ($myId) {
            // Сначала проверяем, есть ли аватар в кэше
            $avatarUrl = avatar_url_if_cached($myId);
            // Если в кэше нет — скачиваем и кэшируем его
            if (!$avatarUrl) {
                $avatarUrl = download_and_cache_peer_avatar($mp, $myId);
            }
        }

        // --- ВОТ ИСПРАВЛЕНИЕ ---
        // Мы добавляем 'avatarUrl' => $avatarUrl в массив ответа
        ok([
            'id'       => $myId ?: null,
            'account_id' => $myId ?: null,
            'first_name' => $me['first_name'] ?? null,
            'last_name'  => $me['last_name'] ?? null,
            'phone'    => $me['phone'] ?? null,
            'username' => $me['username'] ?? null,
            'avatarUrl'=> $avatarUrl, // <-- Добавлено недостающее поле
        ]);
        // --- КОНЕЦ ИСПРАВЛЕНИЯ ---

    } finally {
        finish_madeline_locked($mp);
    }
}
break;

        case 'debugPeer': {
                $target = (string)($payload['target'] ?? $payload['chatId'] ?? '');
                if ($target === '') fail('target/chatId required', 400);
                $mp = start_madeline_locked();
                try {
                    $info = null;
                    $pwr = null;
                    $errInfo = null;
                    $errPwr = null;
                    try {
                        $info = $mp->getInfo($target);
                    } catch (\Throwable $e) {
                        $errInfo = $e->getMessage();
                    }
                    try {
                        $pwr  = $mp->getPwrChat($target);
                    } catch (\Throwable $e) {
                        $errPwr  = $e->getMessage();
                    }
                    ok([
                        'target' => $target,
                        'haveInputPeer' => isset($info['InputPeer']),
                        'info_keys' => is_array($info) ? array_keys($info) : null,
                        'err_getInfo' => $errInfo,
                        'pwr_has_photo' => is_array($pwr) && !empty($pwr['photo']),
                        'err_getPwrChat' => $errPwr
                    ]);
                } finally {
                    finish_madeline_locked($mp);
                }
            }

            

        case 'getChatsFull': {
                $mp = start_madeline_locked();
                try {
                    $dialogs = $mp->getFullDialogs();
                    if ($dialogs instanceof \Traversable) {
                        $dialogs = iterator_to_array($dialogs, true);
                    }
                    if (!$dialogs) ok([]);

                    // One read per list sync, never one API request per dialog.
                    $dialogFilters = null;
                    try {
                        $filterResult = $mp->messages->getDialogFilters();
                        $dialogFilters = $filterResult['filters'] ?? (array_is_list($filterResult) ? $filterResult : null);
                    } catch (\Throwable $e) {
                        error_log('Telegram folder metadata temporarily unavailable');
                    }
                    $folderParam = $_GET['folder'] ?? $payload['folder'] ?? 'all';
                    $folderFilter = ($folderParam === '0' || $folderParam === 0) ? 0 : (($folderParam === '1' || $folderParam === 1) ? 1 : null);

                    $rows = processDialogs($mp, $dialogs, [
                        'humansOnly' => (int)($_GET['humansOnly'] ?? $payload['humansOnly'] ?? 0) === 1,
                        'botsOnly' => (int)($_GET['botsOnly'] ?? $payload['botsOnly'] ?? 0) === 1,
                        'folderFilter' => $folderFilter,
                        'dialogFilters' => $dialogFilters,
                        'orderByLast' => (int)($_GET['orderByLast'] ?? $payload['orderByLast'] ?? 1) === 1,
                        'limit' => (int)($_GET['limit'] ?? $payload['limit'] ?? 100),
                    ]);
                    ok($rows);
                } finally {
                    finish_madeline_locked($mp);
                }
            }

        // --- добавить в switch по action ---

// В файле rest.php

case 'get_messages_by_ids': {
    header('Content-Type: application/json; charset=utf-8');

    // Корректно читаем данные из JSON-тела ($payload)
    $chatId   = (string)($payload['chat_id'] ?? $_REQUEST['chat_id'] ?? '');
    $ids      = $payload['ids'] ?? $payload['message_ids'] ?? $_REQUEST['ids'] ?? $_REQUEST['message_ids'] ?? [];

    if (!is_array($ids)) $ids = [$ids];
    $ids = array_values(array_unique(array_filter(array_map('intval', $ids))));

    if (empty($ids) || $chatId === '') {
        http_response_code(400);
        echo json_encode(['success' => false, 'error' => 'chat_id and ids[] are required']);
        exit;
    }
    
    $mp = start_madeline_locked();
    $finalItems = [];

    try {
        // 1. Получаем полные объекты сообщений (как и было)
        $fullMessagesResult = $mp->messages->getMessages(['peer' => $chatId, 'id' => $ids]);
        $messages = $fullMessagesResult['messages'] ?? [];

        // 2. 🔴 СНАЧАЛА: инвалидируем кэш для отредактированных (как и было)
        foreach ($messages as $msg) {
            if (!is_array($msg)) continue;
            
            if (!empty($msg['edit_date']) && !empty($msg['media'])) {
                try {
                    tg_invalidate_media_cache($chatId, (int)$msg['id']);
                    log_err('[CACHE] Invalidated for edited message', ['chatId' => $chatId, 'msgId' => $msg['id']]);
                } catch (\Throwable $e) { /* Игнорируем */ }
            }
        }
        
        // 3. 🟢 ПОТОМ: перекачиваем медиа в кэш (как и было)
        if (getenv('TELEGRAM_PREFETCH_MEDIA') === '1' && !empty($messages)) {
            ensure_media_cached_for_list($mp, $chatId, $messages);
        }

        // 4. ✨ НОВОЕ: Нормализуем сообщения для ответа
        $selfBaseUrl = (isset($_SERVER['REQUEST_SCHEME']) ? $_SERVER['REQUEST_SCHEME'] : 'http')
            . '://' . $_SERVER['HTTP_HOST'] . $_SERVER['PHP_SELF'];

        $normalized_list = [];
        foreach ($messages as $m) {
            if (!is_array($m)) continue;
            
            // Адаптируем сырое сообщение для функции tg_normalize_message,
            // т.к. она ожидает доп. поля 'type', 'mime', 'filename', как в 'getChatHistory'.
            $raw_for_norm = $m;
            $raw_for_norm['service'] = tg_service_event($m);
            
            $media = $m['media'] ?? null;
            $typ = !empty($media) ? strtolower(str_replace('messageMedia', '', $media['_'] ?? '')) : 'text';
            if (is_array($media) && ($media['_'] ?? '') === 'messageMediaDocument' && !empty($media['document'])) {
                $mime = $media['document']['mime_type'] ?? null;
                $raw_for_norm['mime'] = $mime;
                if ($mime && str_starts_with(strtolower($mime), 'image/') && strtolower($mime) !== 'image/webp') $typ = 'photo';
                if ($mime && str_starts_with(strtolower($mime), 'video/')) $typ = 'video';
                if ($mime && str_starts_with(strtolower($mime), 'audio/')) $typ = 'audio';
                
                foreach ($media['document']['attributes'] ?? [] as $a) {
                    if (($a['_'] ?? '') === 'documentAttributeFilename' && !empty($a['file_name'])) {
                        $raw_for_norm['filename'] = (string)$a['file_name'];
                        break;
                    }
                }
            }
            $raw_for_norm['type'] = $typ;
            
            $normalized_list[] = tg_normalize_message($raw_for_norm, $chatId, $selfBaseUrl);
        }

        // 5. ✨ НОВОЕ: Группируем и сортируем результат
        tg_assign_media_groups_in_place($normalized_list, $chatId);
        $groupedItems = tg_collapse_media_groups($normalized_list);
        
        // Переименовываем 'edit_date' в 'edit_ts' для соответствия вашему формату
        $finalItems = array_map(function($item) {
            if (array_key_exists('edit_date', $item)) {
                $item['edit_ts'] = $item['edit_date'];
                unset($item['edit_date']);
            }
            return $item;
        }, $groupedItems);
        
        // Финальная сортировка по времени и ID для консистентности
        usort($finalItems, function ($a, $b) {
            $ta = intval($a['timestamp']);
            $tb = intval($b['timestamp']);
            if ($ta !== $tb) return $ta <=> $tb;
            return strcmp((string)$a['id'], (string)$b['id']);
        });

    } catch (\Throwable $e) {
        log_err('get_messages_by_ids: failed to process', ['peer' => $chatId, 'err' => $e->getMessage()]);
        finish_madeline_locked($mp); // Важно освободить лок до выхода
        http_response_code(500);
        echo json_encode(['success' => false, 'error' => 'Internal server error: ' . $e->getMessage()]);
        exit;
    } finally {
        finish_madeline_locked($mp);
    }

    // 6. ✨ НОВОЕ: Отправляем ответ с данными
    echo json_encode(['success' => true, 'items' => $finalItems]);
    exit;
}
        case 'getChats':
        case 'getRecentChats': {
                $mp = start_madeline_locked();
                try {
                    $limit = ($action === 'getRecentChats') ? (int)($_GET['limit'] ?? $payload['limit'] ?? 30) : (int)($_GET['limit'] ?? $payload['limit'] ?? 100);

                    if ($action === 'getRecentChats') {
                        try {
                            $bundle = $mp->messages->getDialogs([
                                'offset_date' => 0,
                                'offset_id'   => 0,
                                'offset_peer' => ['_' => 'inputPeerEmpty'],
                                'limit'       => max(1, $limit),
                                'hash'        => 0,
                            ]);

                            $dialogs = is_array($bundle) ? ($bundle['dialogs'] ?? []) : [];
                            if ($dialogs instanceof \Traversable) {
                                $dialogs = iterator_to_array($dialogs, true);
                            }
                            if ($dialogs) {
                                $rows = processDialogs($mp, $dialogs, [
                                    'humansOnly' => (int)($_GET['humansOnly'] ?? $payload['humansOnly'] ?? 0) === 1,
                                    'orderByLast' => true,
                                    'limit' => $limit,
                                    'preloadedUsers' => is_array($bundle) ? ($bundle['users'] ?? []) : [],
                                    'preloadedChats' => is_array($bundle) ? ($bundle['chats'] ?? []) : [],
                                    'preloadedMessages' => is_array($bundle) ? ($bundle['messages'] ?? []) : [],
                                    'skipPeerDialogFetch' => true,
                                    'skipTopMessageFetch' => true,
                                ]);
                                ok($rows);
                            }
                        } catch (\Throwable $e) {
                            log_err('getRecentChats lightweight getDialogs failed', ['err' => $e->getMessage()]);
                        }
                    }

                    $dialogs = $mp->getFullDialogs();
                    if ($dialogs instanceof \Traversable) {
                        $dialogs = iterator_to_array($dialogs, true);
                    }
                    if (!$dialogs) ok([]);
                    $rows = processDialogs($mp, $dialogs, [
                        'humansOnly' => (int)($_GET['humansOnly'] ?? $payload['humansOnly'] ?? 0) === 1,
                        'orderByLast' => true,
                        'limit' => $limit
                    ]);
                    ok($rows);
                } finally {
                    finish_madeline_locked($mp);
                }
            }

       case 'getChatHistory': {
                $peer = (string)($payload['chatId'] ?? '');
                if ($peer === '') fail('chatId is required');
                $offsetId = (int)($payload['offsetId'] ?? 0);
                $limit    = (int)($payload['limit'] ?? 30);

                // фича-флаг (можно управлять через ENV INCLUDE_MEDIA_GROUP_ID=0)
                $includeMediaGroup = (getenv('INCLUDE_MEDIA_GROUP_ID') === '0') ? false : true;

                $mp = start_madeline_locked();
                try {
                    // Numeric chat IDs alone are not sufficient for every
                    // user/channel: Telegram also needs the access hash.
                    $inputPeer = tg_normalize_peer_for_download($mp, $peer) ?? $peer;
                    // прочитанные id
                    $rin = 0;
                    $rout = 0;
                    try {
                        $pd = $mp->messages->getPeerDialogs(['peers' => [$inputPeer]]);
                        $dlg = $pd['dialogs'][0] ?? null;
                        if (is_array($dlg)) {
                            $rin  = (int)($dlg['read_inbox_max_id'] ?? 0);
                            $rout = (int)($dlg['read_outbox_max_id'] ?? 0);
                        }
                    } catch (\Throwable $e) {
                        }

                        // ШАГ 1: Получаем "легкую" историю, как и раньше, чтобы узнать ID сообщений
    $historyResult = $mp->messages->getHistory([
        'peer'      => $inputPeer,
        'offset_id' => $offsetId,
        'limit'     => $limit
    ]);

    $initialMessages = $historyResult['messages'] ?? [];
    if (empty($initialMessages)) {
        // Если сообщений нет, выходим с пустым результатом
        ok(['items' => [], 'nextCursor' => null, 'messages' => ['items' => [], 'nextCursor' => null]]);
    }

    // ШАГ 2: Собираем ID всех полученных сообщений
    $messageIds = [];
    foreach ($initialMessages as $msg) {
        if (!empty($msg['id'])) {
            $messageIds[] = $msg['id'];
        }
    }

    // ШАГ 3: Делаем запрос на получение ПОЛНЫХ объектов сообщений по их ID
    // Without peer Madeline returns messageEmpty shells for channel/file
    // dialogs.  Keep the peer so Telegram resolves the actual text and media.
    $fullMessagesResult = $mp->messages->getMessages(['peer' => $inputPeer, 'id' => $messageIds]);

    // getMessages may return messageEmpty shells for channel/file dialogs,
    // while getHistory above already contains the real message payload.  Use
    // the extra result only when it actually carries message text or media.
    $fullById = [];
    foreach (($fullMessagesResult['messages'] ?? []) as $fullMessage) {
        if (is_array($fullMessage) && !empty($fullMessage['id'])) {
            $fullById[(int) $fullMessage['id']] = $fullMessage;
        }
    }
    // getHistory is already the authoritative payload.  In MadelineProto 8
    // the optional getMessages enrichment can replace a document with a
    // stripped shell, so do not let it overwrite the history entry.
    $messages = array_values(array_filter($initialMessages, 'is_array'));
    // A group history contains the participant entities needed for message
    // authors.  Keep a small lookup so every incoming bubble gets its own
    // name/avatar rather than inheriting the chat's identity.
    $historyUsersById = [];
    foreach ([$historyResult['users'] ?? [], $fullMessagesResult['users'] ?? []] as $userBatch) {
        foreach ($userBatch as $historyUser) {
            if (is_array($historyUser) && isset($historyUser['id'])) {
                $historyUsersById[(string)$historyUser['id']] = $historyUser;
            }
        }
    }
    foreach ([$historyResult['chats'] ?? [], $fullMessagesResult['chats'] ?? []] as $chatBatch) {
        foreach ($chatBatch as $historyChat) {
            if (!is_array($historyChat) || !isset($historyChat['id'])) continue;
            $prefix = str_starts_with((string)($historyChat['_'] ?? ''), 'channel') ? '-100' : '-';
            $historyUsersById[$prefix . $historyChat['id']] = $historyChat;
        }
    }
    $senderResolveBudget = 24;
    $senderAvatarBudget = 12;

    // 🔴 СНАЧАЛА: инвалидируем кэш для отредактированных сообщений, где есть медиа
    foreach ($messages as $mm) {
        if (!is_array($mm)) continue;
        $mid = (int)($mm['id'] ?? 0);
        if ($mid <= 0) continue;
        $ed  = (int)($mm['edit_date'] ?? 0);
        if ($ed > 0 && !empty($mm['media'])) {
            try { tg_invalidate_media_cache($peer, $mid); } catch (\Throwable $e) {}
        }
    }

    // === ДОБАВКА: дотягиваем реакции явно и сливаем по msg_id ===
if (!empty($messageIds)) {
    try {
        $rx = $mp->messages->getMessagesReactions([
            'peer' => $peer,
            'id'   => array_values($messageIds),
        ]);
        // Этот метод возвращает updates с элементами updateMessageReactions
        $reacMap = [];
        foreach (($rx['updates'] ?? []) as $u) {
            if (($u['_'] ?? '') === 'updateMessageReactions') {
                $rid = (int)($u['msg_id'] ?? 0);
                if ($rid > 0) {
                    $reacMap[$rid] = $u['reactions'] ?? null; // объект MessageReactions
                }
            }
        }
        // Слить в $messages
        foreach ($messages as &$mm) {
            $id = (int)($mm['id'] ?? 0);
            if ($id && array_key_exists($id, $reacMap)) {
                $mm['reactions'] = $reacMap[$id];
            }
        }
        unset($mm);
    } catch (\Throwable $e) {
        log_err('getChatHistory: getMessagesReactions failed', ['peer' => $peer, 'err' => $e->getMessage()]);
    }
}

                // Дальнейшая логика остается без изменений
               // 🟢 ПОТОМ: перекачиваем медиа в кэш (после инвалидации)
                // Do not pre-download every file just because its chat was
                // opened.  Archives are fetched lazily only when requested.
                if (getenv('TELEGRAM_PREFETCH_MEDIA') === '1') {
                    ensure_media_cached_for_list($mp, $peer, $messages);
                }
                        // Собираем «сырой» список, который понимает tg_normalize_message
                        $list = [];
                        foreach ($messages as $m) {
                            if (!is_array($m)) continue;

                            $mid   = (int)($m['id'] ?? 0);
                        if ($mid <= 0) continue;

                        $time  = (int)($m['date'] ?? time());
                        $isOut = !empty($m['out']);
                        $text  = (string)($m['message'] ?? '');
                        $type  = 'text';
                        $filename = null;
                        $mime = null;
                        // Text-only Telegram entries still pass through the
                        // common normalizer below. Keep this explicit so a
                        // prior media message cannot leak its value and a
                        // plain message never raises "Undefined variable
                        // $media" and aborts the whole history page.
                        $media = null;

                        if (!empty($m['media'])) {
                            $media = $m['media'];
                            $mediaType = is_array($media) ? ($media['_'] ?? '') : (is_object($media) ? get_class($media) : '');

                            if (str_contains($mediaType, 'Photo')) {
                                $type = 'photo';
                            } elseif (str_contains($mediaType, 'WebPage')) {
                                $type = 'webpage';
                            } elseif (str_contains($mediaType, 'Poll')) {
                                $type = 'poll';
                            } elseif (str_contains($mediaType, 'Geo')) {
                                $type = 'location';
                            } elseif (str_contains($mediaType, 'Document')) {
                                $docMime = (string)($media['document']['mime_type'] ?? '');
                                if (str_starts_with($docMime, 'image/webp'))      $type = 'sticker';
                                elseif (str_starts_with($docMime, 'video/'))      $type = 'video';
                                elseif (str_starts_with($docMime, 'audio/'))      $type = 'audio';
                                else                                              $type = 'document';

                                $mime = $docMime ?: null;
                                $motionSticker = $motionAnimation = $motionRound = false;
                                foreach ($media['document']['attributes'] ?? [] as $attribute) {
                                    $motionSticker = $motionSticker || ($attribute['_'] ?? '') === 'documentAttributeSticker';
                                    $motionAnimation = $motionAnimation || ($attribute['_'] ?? '') === 'documentAttributeAnimated';
                                    $motionRound = $motionRound || (($attribute['_'] ?? '') === 'documentAttributeVideo' && !empty($attribute['round_message']));
                                }
                                if ($motionSticker) $type = 'sticker';
                                elseif ($motionRound) $type = 'video_note';
                                elseif ($motionAnimation) $type = 'animation';

                                // имя файла из атрибутов (если есть)
                                foreach ($media['document']['attributes'] ?? [] as $a) {
                                    if (($a['_'] ?? '') === 'documentAttributeFilename' && !empty($a['file_name'])) {
                                        $filename = (string)$a['file_name'];
                                        break;
                                    }
                                }
                            }

                            // если текста нет — оставим пусто (клиент сам решит плейсхолдер),
                            // но можно и "[photo]" и т.п., если тебе так удобнее
                            // if ($text === '') $text = '[' . $type . ']';
                        }

                        // Прочитанность «для out» сравниваем с read_outbox_max_id
                        $isRead = ($mid > 0) ? ($isOut ? (int)($mid <= $rout) : 0) : 0;

                        // Нативная группа от Telegram (если есть)
                        $mediaGroupIdNative = null;
                        if (!empty($m['grouped_id'])) {
                            $mediaGroupIdNative = (string)$m['grouped_id'];
                        }

                        $sender = (!$isOut && str_starts_with($peer, '-'))
                            ? tg_group_sender_brief($mp, $m, $historyUsersById, $senderResolveBudget, $senderAvatarBudget)
                            : [];

                        $list[] = array_merge([
                            'id'              => $mid,
                            'date'            => $time,
                            // Не зажигаем плашку в истории из-за «реакции-только».
                            // Эвристика: edit_date есть, но нет изменения контента (текст/медиа).
                            'edit_date'       => (function() use ($m) {
                                $ed = (int)($m['edit_date'] ?? 0);
                                if ($ed <= 0) return null;
                                $hasContent = (($m['message'] ?? '') !== '') || !empty($m['media']);
                                // если нет содержимого — считаем, что правки "несодержательные" (реакции и пр.)
                                if (!$hasContent) return null;
                                // если Telegram пометил служебную правку (когда такое поле есть)
                                if (!empty($m['edit_hide'])) return null;
                                return $ed;
                            })(),
                            // при нормализации будет выставлен edited только если edit_date != null
                            // и _update_type не равен updateMessageReactions
                            'type'            => $type,
                            'message'         => $text,
                            'out'             => (bool)$isOut,
                            'is_read'         => (bool)$isRead,
                            'filename'        => $filename,
                            'mime'            => $mime,
                            'media'           => $media,
                            'animation_format'=> (!empty($motionSticker) && (str_contains(strtolower((string)$mime), 'tgsticker') || str_ends_with(strtolower((string)$filename), '.tgs'))) ? 'lottie' : '',
                            'service'         => tg_service_event($m),
                            'post' => !empty($m['post']),
                            'replies' => $m['replies'] ?? null,
                            // ключ, который увидит tg_normalize_message
                            'media_group_id'  => $mediaGroupIdNative,
                            'reactions'       => isset($m['reactions']) ? $m['reactions'] : null,
                            // ▼▼ ДОБАВЛЕНА ЭТА СТРОКА ▼▼
                            'reply_to_msg_id' => isset($m['reply_to']['reply_to_msg_id']) ? (int)$m['reply_to']['reply_to_msg_id'] : null,
                        ], $sender);
                    }

                    // База для ссылок downloadMedia/downloadThumb
                    $selfBaseUrl = (isset($_SERVER['REQUEST_SCHEME']) ? $_SERVER['REQUEST_SCHEME'] : 'http')
                        . '://' . $_SERVER['HTTP_HOST'] . $_SERVER['PHP_SELF'];

                    // Нормализуем → получаем единый контракт
                    $items = [];
                    foreach ($list as $raw) {
                        $items[] = tg_normalize_message($raw, $peer, $selfBaseUrl);
                    }

                    // Догруппировать те, у кого нет нативного grouped_id (эвристикой «окно»)
                    tg_assign_media_groups_in_place($items, $peer);
                    //$items = tg_collapse_media_groups($items);

                    // Стабильная сортировка (по времени, затем по id)
                    usort($items, function ($a, $b) {
                        $ta = intval($a['timestamp']);
                        $tb = intval($b['timestamp']);
                        if ($ta !== $tb) return $ta <=> $tb;
                        return strcmp((string)$a['id'], (string)$b['id']);
                    });

                    // ⭐ НАЧАЛО ИСПРАВЛЕНИЯ ПАГИНАЦИИ ⭐
                    $nextCursor = null;
                    if (!empty($messages) && count($messages) >= $limit) {
                        $oldestRaw = end($messages);
                        if (isset($oldestRaw['id'])) {
                            $nextCursor = (string)$oldestRaw['id'];
                        }
                    }

                    // единый ответ как в getChatHistory
                    $response = [
                        'success'     => true,
                        'items'       => $items,              // <-- добавили плоские items
                        'nextCursor'  => $nextCursor,
                        'messages'    => [
                            'items'      => $items,
                            'nextCursor' => $nextCursor,
                        ],
                    ];

                    header('Content-Type: application/json; charset=utf-8');
                    // `exit` does not run PHP finally blocks.  Release the
                    // session guard explicitly before sending this response.
                    finish_madeline_locked($mp);
                    echo json_encode($response, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                    exit;
                } finally {
                    finish_madeline_locked($mp);
                }
            }


        case 'messages': {
                // WA-совместимые параметры
                $peer = (string)($_GET['chatId'] ?? $payload['chatId'] ?? '');
                if ($peer === '') fail('chatId is required');

                // по умолчанию как в WA — "before" (старее курсора)
                $direction = (string)($_GET['direction'] ?? $payload['direction'] ?? 'before');
                $cursorRaw = $_GET['cursor'] ?? $_GET['before_id'] ?? $_GET['beforeId']
                    ?? $_GET['after_id'] ?? $_GET['afterId']
                    ?? $payload['cursor'] ?? null;
                $limit = (int)($_GET['limit'] ?? $payload['limit'] ?? 30);
                if ($limit <= 0) $limit = 30;

                // Telegram getHistory надёжно поддерживает пагинацию "старее" через offset_id
                // Поэтому direction='after' сейчас игнорируем и ведём себя как 'before'.
                $offsetId = $cursorRaw ? (int)$cursorRaw : 0;

                $mp = start_madeline_locked();
                try {
                    $inputPeer = tg_normalize_peer_for_download($mp, $peer) ?? $peer;
                    // прочитанные id (как в getChatHistory)
                    $rin = 0;
                    $rout = 0;
                    try {
                        $pd  = $mp->messages->getPeerDialogs(['peers' => [$inputPeer]]);
                        $dlg = $pd['dialogs'][0] ?? null;
                        if (is_array($dlg)) {
                            $rin  = (int)($dlg['read_inbox_max_id'] ?? 0);
                            $rout = (int)($dlg['read_outbox_max_id'] ?? 0);
                        }
                    } catch (\Throwable $e) {
                    }

                    // берём историю
                    // ШАГ 1: Получаем "легкую" историю, как и раньше, чтобы узнать ID сообщений
$historyResult = $mp->messages->getHistory([
    'peer'      => $inputPeer,
    'offset_id' => $offsetId,
    'limit'     => $limit
]);

$initialMessages = $historyResult['messages'] ?? [];
if (empty($initialMessages)) {
    // Если сообщений нет, выходим с пустым результатом
    ok(['items' => [], 'nextCursor' => null, 'messages' => ['items' => [], 'nextCursor' => null]]);
}

// ШАГ 2: Собираем ID всех полученных сообщений
$messageIds = [];
foreach ($initialMessages as $msg) {
    if (!empty($msg['id'])) {
        $messageIds[] = $msg['id'];
    }
}

// ШАГ 3: Делаем запрос на получение ПОЛНЫХ объектов сообщений по их ID
$fullMessagesResult = $mp->messages->getMessages(['peer' => $inputPeer, 'id' => $messageIds]);

// Channel/file dialogs can yield messageEmpty from getMessages.  Keep the
// real getHistory object whenever that enrichment has no usable payload.
$fullById = [];
foreach (($fullMessagesResult['messages'] ?? []) as $fullMessage) {
    if (is_array($fullMessage) && !empty($fullMessage['id'])) {
        $fullById[(int) $fullMessage['id']] = $fullMessage;
    }
}

// Preserve getHistory entries: getMessages enrichment is incomplete for some
// channel documents in MadelineProto 8.
$messages = array_values(array_filter($initialMessages, 'is_array'));

// 🔴 СНАЧАЛА: инвалидируем кэш для отредактированных сообщений, где есть медиа
foreach ($messages as $mm) {
    if (!is_array($mm)) continue;
    $mid = (int)($mm['id'] ?? 0);
    if ($mid <= 0) continue;
    $ed  = (int)($mm['edit_date'] ?? 0);
    if ($ed > 0 && !empty($mm['media'])) {
        try { tg_invalidate_media_cache($peer, $mid); } catch (\Throwable $e) {}
    }
}

// === ДОБАВКА: дотягиваем реакции явно и сливаем по msg_id ===
if (!empty($messageIds)) {
    try {
        $rx = $mp->messages->getMessagesReactions([
            'peer' => $peer,
            'id'   => array_values($messageIds),
        ]);
        $reacMap = [];
        foreach (($rx['updates'] ?? []) as $u) {
            if (($u['_'] ?? '') === 'updateMessageReactions') {
                $rid = (int)($u['msg_id'] ?? 0);
                if ($rid > 0) {
                    $reacMap[$rid] = $u['reactions'] ?? null;
                }
            }
        }
        foreach ($messages as &$mm) {
            $id = (int)($mm['id'] ?? 0);
            if ($id && array_key_exists($id, $reacMap)) {
                $mm['reactions'] = $reacMap[$id];
            }
        }
        unset($mm);
    } catch (\Throwable $e) {
        log_err('messages: getMessagesReactions failed', ['peer' => $peer, 'err' => $e->getMessage()]);
    }
}



            // Дальнейшая логика остается без изменений
            // 🟢 ПОТОМ: перекачиваем медиа в кэш (после инвалидации)
            if (getenv('TELEGRAM_PREFETCH_MEDIA') === '1') {
                ensure_media_cached_for_list($mp, $peer, $messages);
            }


                    // соберём "сырой" список в твой промежуточный формат
                    $list = [];
                    foreach ($messages as $m) {
                        if (!is_array($m)) continue;
                        $mid = (int)($m['id'] ?? 0);
                        if ($mid <= 0) continue;

                        $time  = (int)($m['date'] ?? time());
                        $isOut = !empty($m['out']);
                        $text  = (string)($m['message'] ?? '');
                        $type  = 'text';
                        $filename = null;
                        $mime = null;

                        if (!empty($m['media'])) {
                            $media = $m['media'];
                            $mediaType = is_array($media) ? ($media['_'] ?? '') : '';
                            if (str_contains($mediaType, 'Photo'))       $type = 'photo';
                            elseif (str_contains($mediaType, 'WebPage')) $type = 'webpage';
                            elseif (str_contains($mediaType, 'Poll'))    $type = 'poll';
                            elseif (str_contains($mediaType, 'Geo'))     $type = 'location';
                            elseif (str_contains($mediaType, 'Document')) {
                                $docMime = (string)($media['document']['mime_type'] ?? '');
                                if (str_starts_with($docMime, 'image/webp'))      $type = 'sticker';
                                elseif (str_starts_with($docMime, 'video/'))      $type = 'video';
                                elseif (str_starts_with($docMime, 'audio/'))      $type = 'audio';
                                else                                              $type = 'document';
                                $mime = $docMime ?: null;
                                $motionSticker = $motionAnimation = $motionRound = false;
                                foreach ($media['document']['attributes'] ?? [] as $attribute) {
                                    $motionSticker = $motionSticker || ($attribute['_'] ?? '') === 'documentAttributeSticker';
                                    $motionAnimation = $motionAnimation || ($attribute['_'] ?? '') === 'documentAttributeAnimated';
                                    $motionRound = $motionRound || (($attribute['_'] ?? '') === 'documentAttributeVideo' && !empty($attribute['round_message']));
                                }
                                if ($motionSticker) $type = 'sticker';
                                elseif ($motionRound) $type = 'video_note';
                                elseif ($motionAnimation) $type = 'animation';

                                foreach ($media['document']['attributes'] ?? [] as $a) {
                                    if (($a['_'] ?? '') === 'documentAttributeFilename' && !empty($a['file_name'])) {
                                        $filename = (string)$a['file_name'];
                                        break;
                                    }
                                }
                            }
                        }

                        $isRead = $mid > 0 ? ($isOut ? (int)($mid <= $rout) : 0) : 0;

                        $mediaGroupIdNative = null;
                        if (!empty($m['grouped_id'])) {
                            $mediaGroupIdNative = (string)$m['grouped_id'];
                        }

                        $list[] = [
                            'id'              => $mid,
                            'date'            => $time,
                            // Не зажигаем плашку в истории из-за «реакции-только».
                            // Эвристика идентична getChatHistory.
                            'edit_date'       => (function() use ($m) {
                                $ed = (int)($m['edit_date'] ?? 0);
                                if ($ed <= 0) return null;
                                $hasContent = (($m['message'] ?? '') !== '') || !empty($m['media']);
                                if (!$hasContent) return null;
                                if (!empty($m['edit_hide'])) return null;
                                return $ed;
                            })(),
                            // при нормализации будет выставлен edited только если edit_date != null
                            // и _update_type не равен updateMessageReactions
                            'type'            => $type,
                            'message'         => $text,
                            'out'             => (bool)$isOut,
                            'is_read'         => (bool)$isRead,
                            'filename'        => $filename,
                            'mime'            => $mime,
                            'media'           => $media,
                            'animation_format'=> (!empty($motionSticker) && (str_contains(strtolower((string)$mime), 'tgsticker') || str_ends_with(strtolower((string)$filename), '.tgs'))) ? 'lottie' : '',
                            'service'         => tg_service_event($m),
                            'post' => !empty($m['post']),
                            'replies' => $m['replies'] ?? null,
                            'media_group_id'  => $mediaGroupIdNative,
                            'reactions'       => isset($m['reactions']) ? $m['reactions'] : null,
                            // ▼▼ ДОБАВЛЕНА ЭТА СТРОКА ▼▼
                            'reply_to_msg_id' => isset($m['reply_to']['reply_to_msg_id']) ? (int)$m['reply_to']['reply_to_msg_id'] : null,
                        ];
                    }

                    // база для ссылок (как в getChatHistory)
                    $selfBaseUrl = (isset($_SERVER['REQUEST_SCHEME']) ? $_SERVER['REQUEST_SCHEME'] : 'http')
                        . '://' . $_SERVER['HTTP_HOST'] . $_SERVER['PHP_SELF'];

                    // нормализация -> attachments[] + базовые поля
                    $items = [];
                    foreach ($list as $raw) {
                        $items[] = tg_normalize_message($raw, $peer, $selfBaseUrl);
                    }

                    // догруппировка альбомов «окном»
                    tg_assign_media_groups_in_place($items, $peer);
                    $items = tg_collapse_media_groups($items);

                    // стабильная сортировка (по времени, затем по id)
                    usort($items, function ($a, $b) {
                        $ta = intval($a['timestamp']);
                        $tb = intval($b['timestamp']);
                        if ($ta !== $tb) return $ta <=> $tb;
                        return strcmp((string)$a['id'], (string)$b['id']);
                    });

                    // === курсор как у WA ===
                    // для "before" следующей странице передаём id самого старого (первого) из текущего окна
                    $nextCursor = null;
                    if (!empty($items)) {
                        // Если Телеграм вернул полную страницу — выставим курсор.
                        if (!empty($messages) && count($messages) >= $limit) {
                            $nextCursor = (string)$items[0]['id']; // самый старый в текущей выдаче
                        }
                    }

                    $response = [
                        'success'     => true,
                        'messages'    => ['items' => $items, 'nextCursor' => $nextCursor],
                        'nextCursor'  => $nextCursor,
                    ];

                    header('Content-Type: application/json; charset=utf-8');
                    echo json_encode($response, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
                    exit;
                } finally {
                    finish_madeline_locked($mp);
                }
            }
            
            // ЗАМЕНИТЕ ВАШ case 'webhook' НА ЭТОТ
        case 'webhook': {
                tg_flush_expired_albums();

                $raw = file_get_contents('php://input') ?: '';
                log_err('[WEBHOOK RECEIVED]', ['body' => $raw]); // keep your diagnostic

                $update_payload = json_decode($raw, true);
                if (!is_array($update_payload)) {
                    $update_payload = $_POST ?: [];
                }

                if (empty($update_payload)) {
                    ok(['status' => 'no payload']);
                    break;
                }

                $updates = isset($update_payload['updates']) && is_array($update_payload['updates'])
                    ? $update_payload['updates']
                    : [$update_payload];

                $raw_messages = [];
                $reaction_updates = [];
                $chatId = null;

                // 2. Извлекаем все "сырые" объекты сообщений из входящей пачки
                foreach ($updates as $update) {
    if (!is_array($update)) continue;

    if (in_array($update['_'] ?? '', ['updateDeleteMessages','updateDeleteChannelMessages','updateReadHistoryInbox','updateReadHistoryOutbox','updateReadChannelInbox','updateReadChannelOutbox'], true)) {
        $ch=curl_init(FINAL_WEBHOOK_URL);
        curl_setopt_array($ch,[CURLOPT_RETURNTRANSFER=>true,CURLOPT_POST=>true,CURLOPT_POSTFIELDS=>json_encode(['updates'=>[$update]]),CURLOPT_HTTPHEADER=>['Content-Type: application/json'],CURLOPT_TIMEOUT=>15]);
        $response=curl_exec($ch); $code=curl_getinfo($ch,CURLINFO_HTTP_CODE);curl_close($ch);
        if($response===false || $code<200 || $code>=300){http_response_code(503);echo 'RETRY';exit;}
        continue;
    }

    // Отдельно перехватываем апдейты реакций
    if (($update['_'] ?? '') === 'updateMessageReactions') {
        $reaction_updates[] = $update;
        // тут нет message целиком — продолжаем разбор следующего update
        continue;
    }

    $msg = extract_message_from_update($update);
    if ($msg) {
               // прокинем тип апдейта внутрь сообщения, чтобы отличать «реакции-только»
        $msg['_update_type'] = $update['_'] ?? null; // например: updateEditMessage, updateMessageReactions
        $raw_messages[] = $msg;
        if ($chatId === null) {
            $chatId = tg_message_chat_id($msg);
        }
    }
}
                

               if (empty($raw_messages) || $chatId === null) {
                                  // Даже если нет "полных" сообщений — всё равно попробуем обработать обновления реакций
                   if (!empty($reaction_updates)) {
    // A batch may contain reaction updates for several peers. Keep every
    // peer separate so a snapshot is never delivered to the last chat seen.
    $byChat = [];
    foreach ($reaction_updates as $u) {
        $rxChat = canonical_chat_id($u['peer'] ?? ($u['peer_id'] ?? null));
        $msgId  = (int)($u['msg_id'] ?? 0);
        if (!$rxChat || $msgId <= 0) {
            log_err('[RX] Bad updateMessageReactions', ['peer' => $u['peer'] ?? null, 'msg_id' => $msgId]);
            continue;
        }
        $byChat[$rxChat][(string)$msgId] = tg_reactions_detailed($u['reactions'] ?? []);
    }

    foreach ($byChat as $reactionChatId => $results) {
        if ($results) push_reactions_results((string)$reactionChatId, $results, $clientUid);
    }
    ok(['status' => 'rx-only processed']);
    break;

                    } else {
                        ok(['status' => 'no processable messages in this batch']);
                        break;
                    }
                }

                // Media bytes are fetched on demand. Receiving a message must
                // not wait for downloading its file or acquiring an MP session.
                foreach ($raw_messages as $raw_msg) {
                    if (empty($raw_msg['media'])) continue;
                    $mediaChatId = tg_message_chat_id($raw_msg);
                    $mid = (int)($raw_msg['id'] ?? 0);
                    if ($mediaChatId !== null && $mid > 0 &&
                        (!empty($raw_msg['edit_date']) || in_array($raw_msg['_update_type'] ?? '', ['updateEditMessage', 'updateEditChannelMessage'], true))) {
                        tg_invalidate_media_cache($mediaChatId, $mid);
                    }
                }

                // 4. Нормализуем все сообщения в пачке к нашему стандартному формату
                $selfBaseUrl = (isset($_SERVER['REQUEST_SCHEME']) ? $_SERVER['REQUEST_SCHEME'] : 'http')
                    . '://' . $_SERVER['HTTP_HOST'] . $_SERVER['PHP_SELF'];

                $normalized_by_chat = [];
                foreach ($raw_messages as $raw) {
                    $messageChatId = tg_message_chat_id($raw);
                    if ($messageChatId === null) continue;
                    // ... (здесь идет ваша существующая логика нормализации сообщений внутри 'webhook', она у вас правильная) ...
                    $updType = $raw['_update_type'] ?? null;
                    $media = $raw['media'] ?? null;
                    $typ = !empty($media) ? strtolower(str_replace('messageMedia', '', $media['_'])) : 'text';
                    $mime  = null;
                    $fname = null;
                    if (is_array($media) && ($media['_'] ?? '') === 'messageMediaDocument' && !empty($media['document'])) {
                        $mime = $media['document']['mime_type'] ?? null;
                        foreach ($media['document']['attributes'] ?? [] as $a) {
                            if (($a['_'] ?? '') === 'documentAttributeFilename' && !empty($a['file_name'])) {
                                $fname = (string)$a['file_name'];
                                break;
                            }
                        }
                        if ($mime && str_starts_with(strtolower($mime), 'image/') && strtolower($mime) !== 'image/webp') {
                            $typ = 'photo';
                        }
                        if ($mime && str_starts_with(strtolower($mime), 'video/')) {
                            $typ = 'video';
                        }
                        if ($mime && str_starts_with(strtolower($mime), 'audio/')) {
                            $typ = 'audio';
                        }
                    }

                     $adapted_raw = [
                        'id'             => $raw['id'],
                        'date'           => $raw['date'],
                        '_update_type'   => $updType, // ← прокидываем дальше в нормализацию
                        'edit_date'      => isset($raw['edit_date']) ? (int)$raw['edit_date'] : null,
                        'type'           => $typ,
                        'message'        => $raw['message'] ?? '',
                        'out'            => !empty($raw['out']),
                        'is_read'        => false,
                        'media_group_id' => $raw['grouped_id'] ?? null,
                        'filename'       => $fname,
                        'mime'           => $mime,
                        'media'          => $media,
                        'reactions'      => $raw['reactions'] ?? null
                    ];

                    $normalized = tg_normalize_message($adapted_raw, $messageChatId, $selfBaseUrl);
                    $normalized['chatIdForAlbum'] = $messageChatId;
                    $normalized['_update_type']   = $updType;
                    $normalized_by_chat[$messageChatId][] = $normalized;
                }

                // 5. Назначаем серверные ID групп для медиа, у которых нет нативного ID
                $normalized_items = [];
                foreach ($normalized_by_chat as $peer => $items) {
                    tg_assign_media_groups_in_place($items, (string)$peer);
                    array_push($normalized_items, ...$items);
                }

                // ... (исправление для media_group_kind)
                foreach ($normalized_items as &$item) {
                    if (!empty($item['media_group']) && empty($item['media_group_kind'])) {
                        $kind = $item['attachments'][0]['type'] ?? null;
                        if ($kind) {
                            $item['media_group_kind'] = $kind;
                            $item['kind'] = $kind;
                        }
                    }
                }
                unset($item);

                // 6. Обрабатываем каждое нормализованное сообщение (отправляем на FINAL_WEBHOOK_URL)
foreach ($normalized_items as $item) {
    tg_process_for_webhook($item, $clientUid); // <— передаём $clientUid
}
                // 6.1. Отдельно пушим апдейты реакций (если были в пачке)
               if (!empty($reaction_updates)) {
    // Do not merge reactions from distinct peers into the current message
    // batch. Message ids are peer-local in Telegram.
    $byChat = [];
    foreach ($reaction_updates as $u) {
        $rxChat = canonical_chat_id($u['peer'] ?? ($u['peer_id'] ?? null)) ?: $chatId;
        $msgId  = (int)($u['msg_id'] ?? 0);
        if ($msgId <= 0) continue;

        if ($rxChat) $byChat[$rxChat][(string)$msgId] = tg_reactions_detailed($u['reactions'] ?? []);
    }
    foreach ($byChat as $reactionChatId => $results) {
        if ($results) push_reactions_results((string)$reactionChatId, $results, $clientUid); // <— передаём $clientUid
    }
}



                // 7. Отправляем ответ сразу, а фоново (после окна) дожимаем альбомы
                respond_ok_with_background_album_flush(['status' => 'webhook processed']);
                break;
            }

        case 'sendMessage': {
                $peer = (string)($payload['chatId'] ?? '');
                if ($peer === '') fail('chatId is required');
                $msg = (string)($payload['message'] ?? '');
                if ($msg === '') fail('message is required');

                $mp = start_madeline_locked();
                try {
                    $res = $mp->messages->sendMessage(['peer' => $peer, 'message' => $msg]);

                    [$msgId, $date] = extract_sent_message_meta($res);
                    if ($msgId) {
                        notify_webhook_sent_update((string)$peer, (int)$msgId, (int)$date, (string)$msg, $clientUid); // <— добавлено
                    }
                    if ($msgId) {
                        // текст тоже прогоняем — функция сама поймёт, что качать нечего
                        proactive_cache_media($mp, (string)$peer, (int)$msgId);
                    } else {
                        fail('Telegram did not confirm message', 502);
                    }

                    ok(['success' => true, 'chat_id' => (string)$peer, 'message_id' => $msgId, 'date' => $date]);
                } finally {
                    finish_madeline_locked($mp);
                }
            }
        case 'sendMessageByTarget': {
                $target = (string)($payload['target'] ?? '');
                $msg    = (string)($payload['message'] ?? '');
                if ($target === '' || $msg === '') fail('target and message are required', 400);

                $mp = start_madeline_locked();
                try {
                    $peer = resolvePeer($mp, $target);
                    if ($peer === null) fail('Target not resolvable (username/phone)', 404);

                    // Само отправление
                    $res = $mp->messages->sendMessage(['peer' => $peer, 'message' => $msg]);

                    // ↓↓↓ ДОБАВЬ ЭТО ↓↓↓
                    [$msgId, $date] = extract_sent_message_meta($res);
                    if ($msgId) {
                        // peer может быть числом (user_id) — приводим к строке
                        notify_webhook_sent_update((string)$peer, (int)$msgId, (int)$date, (string)$msg, $clientUid); // <— добавлено
                    }
                    if ($msgId) {
                        // кэшируем (если это текст — ничего не скачается и это ок)
                        proactive_cache_media($mp, (string)$peer, (int)$msgId);
                    }
                    // ↑↑↑ ДОБАВЬ ЭТО ↑↑↑


                    // Нормализуем user_id для ответа
                    $userId = is_numeric($peer) ? (string)$peer : null;

                    ok([
                        'success'    => true,
                        'user_id'    => $userId,
                        'chat_id'    => $userId,
                        'message_id' => $msgId,
                        'date'       => $date
                    ]);
                } catch (\Throwable $e) {
                    $m = $e->getMessage();

                    // Дружелюбная мапа популярных ошибок
                    if (stripos($m, 'USERNAME_NOT_OCCUPIED') !== false || stripos($m, 'USERNAME_INVALID') !== false) {
                        fail('Username not found', 404);
                    }
                    if (stripos($m, 'FLOOD_WAIT_') !== false || stripos($m, 'PEER_FLOOD') !== false) {
                        fail($m, 429); // фронт покажет «подождите ...»
                    }
                    if (stripos($m, 'AUTH_KEY_UNREGISTERED') !== false || stripos($m, 'SESSION_REVOKED') !== false) {
                        fail('Session invalid. Re-login required.', 401);
                    }
                    if (stripos($m, 'You cannot use this method directly') !== false) {
                        // На случай, если где-то остался прямой вызов raw-метода
                        fail('Internal resolve error. Use getInfo/username path.', 500);
                    }

                    // Если MadelineProto занят (твоя блокировка возвращает 503)
                    if ($e->getCode() === 503) {
                        fail('busy, try again', 503);
                    }

                    // Остальное — как есть
                    fail($m ?: 'Unknown error', 500);
                } finally {
                    finish_madeline_locked($mp);
                }
            }
        case 'sendMessageByPhone': {
                $phone = (string)($payload['phone'] ?? '');
                $msg   = (string)($payload['message'] ?? '');
                if ($phone === '' || $msg === '') fail('phone and message are required', 400);

                $mp = start_madeline_locked();
                try {
                    $uid = userIdByPhone($mp, $phone);
                    if (!$uid) fail('User not found by phone or cannot be messaged', 404);

                    $res = $mp->messages->sendMessage(['peer' => $uid, 'message' => $msg]);

                    // достанем подтверждённый message_id
                    [$msgId, $date] = extract_sent_message_meta($res);
                    if ($msgId) {
                        notify_webhook_sent_update((string)$peer, (int)$msgId, (int)$date, (string)$msg, $clientUid); // <— добавлено
                    }
                    if (!$msgId) fail('Telegram did not confirm message', 502);

                    ok([
                        'success'    => true,
                        'user_id'    => (string)$uid,
                        'chat_id'    => (string)$uid,
                        'message_id' => $msgId,
                        'date'       => $date
                    ]);
                } finally {
                    finish_madeline_locked($mp);
                }
            }
        case 'sendMediaAlbum': {
                $peer = (string)($payload['chatId'] ?? '');
                $files = is_array($payload['files'] ?? null) ? $payload['files'] : [];
                $caption = (string)($payload['caption'] ?? '');
                $replyToId = (int)($payload['reply_to_message_id'] ?? 0);
                $operationId = trim((string)($payload['operation_id'] ?? ''));
                if (!preg_match('/^job_[a-f0-9]{24}$/D', $operationId)) $operationId = '';
                if ($peer === '' || count($files) < 2 || count($files) > 10) {
                    fail('Album requires chatId and from two to ten files', 400);
                }
                $total = 0;
                $prepared = [];
                foreach ($files as $index => $file) {
                    if (!is_array($file)) fail('Invalid album file', 400);
                    $name = basename((string)($file['name'] ?? ''));
                    $path = (string)($file['filePath'] ?? '');
                    $realPath = realpath($path);
                    $jobsRoot = realpath(dirname(__DIR__) . '/runtime/send_jobs');
                    if ($name === '' || $jobsRoot === false || $realPath === false
                        || !str_starts_with($realPath, rtrim($jobsRoot, '/') . '/')
                        || !is_readable($realPath) || ($size = @filesize($realPath)) < 1) {
                        fail('Invalid album file', 400);
                    }
                    $total += $size;
                    if ($total > 50 * 1024 * 1024) fail('Album is larger than 50 MB', 413);
                    $prepared[] = ['index'=>(int)$index, 'path'=>$realPath, 'name'=>$name, 'mime'=>strtolower(trim((string)($file['mime'] ?? 'application/octet-stream')))];
                }
                $mp = start_madeline_locked();
                try {
                    $multi = [];
                    foreach ($prepared as $position => &$file) {
                        $uploaded = $mp->upload($file['path'], $file['name']);
                        $photo = str_starts_with($file['mime'], 'image/') && strtolower(pathinfo($file['name'], PATHINFO_EXTENSION)) !== 'gif';
                        if ($photo) {
                            $media = ['_' => 'inputMediaUploadedPhoto', 'file' => $uploaded];
                        } else {
                            $attrs = [['_' => 'documentAttributeFilename', 'file_name' => $file['name']]];
                            if (str_starts_with($file['mime'], 'video/')) $attrs[] = ['_' => 'documentAttributeVideo', 'supports_streaming' => true];
                            if (str_starts_with($file['mime'], 'audio/')) $attrs[] = ['_' => 'documentAttributeAudio'];
                            $media = ['_' => 'inputMediaUploadedDocument', 'file' => $uploaded, 'mime_type' => $file['mime'], 'attributes' => $attrs];
                        }
                        // updateMessageID carries this value back from Telegram.
                        // It is the only reliable association to the original input.
                        $file['random_id'] = (string)\danog\MadelineProto\Tools::randomInt(0, PHP_INT_MAX);
                        $multi[] = ['_' => 'inputSingleMedia', 'media' => $media, 'message' => $position === 0 ? $caption : '', 'random_id' => (int)$file['random_id']];
                    }
                    unset($file);
                    $params = ['peer'=>$peer, 'multi_media'=>$multi];
                    if ($replyToId > 0) $params['reply_to'] = ['_' => 'inputReplyToMessage', 'reply_to_msg_id' => $replyToId];
                    $result = $mp->messages->sendMultiMedia($params);
                    $byRandomId = [];
                    foreach (($result['updates'] ?? []) as $update) {
                        if (!is_array($update) || ($update['_'] ?? '') !== 'updateMessageID') continue;
                        $randomId = (string)($update['random_id'] ?? '');
                        $messageId = (int)($update['id'] ?? 0);
                        if ($randomId !== '' && $messageId > 0) $byRandomId[$randomId] = $messageId;
                    }
                    $datesById = [];
                    foreach (extract_sent_messages_meta($result) as $meta) $datesById[(int)$meta['id']] = (int)$meta['date'];
                    $items = [];
                    foreach ($prepared as $file) {
                        $messageId = (int)($byRandomId[(string)$file['random_id']] ?? 0);
                        if ($messageId > 0) {
                            // The provider-native ID is the critical evidence.
                            // Record it before optional cache/webhook work, whose
                            // failure must not turn a confirmed RPC into a 500.
                            $items[] = ['index'=>$file['index'], 'message_id'=>$messageId, 'status'=>'accepted'];
                        } else {
                            // RPC may have succeeded, but without updateMessageID
                            // we must not attach a native ID to a wrong file.
                            $items[] = ['index'=>$file['index'], 'status'=>'unknown'];
                        }
                    }
                    $acceptedIds = array_values(array_unique(array_map(
                        static fn(array $item): int => (int)($item['message_id'] ?? 0),
                        array_filter($items, static fn(array $item): bool => ($item['status'] ?? '') === 'accepted')
                    )));
                    $acceptedIds = array_values(array_filter($acceptedIds));
                    // This is the first durable point after Telegram accepted
                    // sendMultiMedia. Do it before the optional webhook and
                    // cache paths, so a later connection loss cannot discard
                    // the per-file native-ID evidence.
                    if ($operationId !== '') {
                        telegram_album_checkpoint_after_rpc($operationId, $items, count($prepared));
                    }
                    // Preserve Telegram's full updateNewMessage payload: it contains
                    // media and grouped_id, whereas a short receipt cannot rebuild an
                    // album in the local history.
                    $fullUpdates = [];
                    foreach (($result['updates'] ?? []) as $update) {
                        $messageId = is_array($update) ? (int)($update['message']['id'] ?? 0) : 0;
                        if ($messageId > 0 && in_array($messageId, $acceptedIds, true)) $fullUpdates[] = $update;
                    }
                    try {
                        if (!notify_webhook_full_updates($fullUpdates)) {
                            log_err('sendMediaAlbum full webhook delivery failed', ['message_ids' => $acceptedIds]);
                        }
                    } catch (Throwable $sideEffectError) {
                        log_err('sendMediaAlbum post-send side effect failed', ['error'=>$sideEffectError->getMessage()]);
                    }
                    foreach ($items as $item) {
                        if (($item['status'] ?? '') !== 'accepted') continue;
                        try {
                            proactive_cache_media($mp, (string)$peer, (int)$item['message_id']);
                        } catch (Throwable $sideEffectError) {
                            log_err('sendMediaAlbum post-send side effect failed', ['message_id'=>(int)$item['message_id'], 'error'=>$sideEffectError->getMessage()]);
                        }
                    }
                    ok([
                        'success' => true,
                        'message_ids' => array_values(array_filter(array_column($items, 'message_id'))),
                        'items' => $items,
                        'complete' => count($byRandomId) === count($prepared),
                        'via' => 'sendMultiMedia',
                    ]);
                } catch (Throwable $e) {
                    log_err('sendMediaAlbum failed', ['error' => $e->getMessage(), 'count' => count($prepared)]);
                    fail('SEND ERROR: ' . $e->getMessage(), 500);
                } finally {
                    finish_madeline_locked($mp);
                }
            }

        case 'sendFile': {
                $peer = (string)($payload['chatId'] ?? '');
                if ($peer === '') fail('chatId is required');

                $caption = (string)($payload['caption'] ?? '');

                // -------- приоритет: ПРЯМАЯ ССЫЛКА (как в WhatsApp) --------
                $url = null;
                if (!empty($payload['fileUrl'])) $url = (string)$payload['fileUrl'];
                elseif (!empty($payload['file']['url'])) $url = (string)$payload['file']['url'];

                if ($url) {
                    if (!preg_match('#^https?://#i', $url)) fail('fileUrl must be http/https public URL', 400);

                    // Тип по расширению/переданному mime
                    $nameFromUrl = basename(parse_url($url, PHP_URL_PATH) ?: 'file.bin');
                    $ext = strtolower(pathinfo($nameFromUrl, PATHINFO_EXTENSION));
                    $mime = (string)($payload['file']['mime'] ?? '');
                    if ($mime === '') {
                        $map = [
                            'jpg' => 'image/jpeg',
                            'jpeg' => 'image/jpeg',
                            'png' => 'image/png',
                            'webp' => 'image/webp',
                            'gif' => 'image/gif',
                            'mp4' => 'video/mp4',
                            'mov' => 'video/quicktime',
                            'mkv' => 'video/x-matroska',
                            'avi' => 'video/x-msvideo',
                            'mp3' => 'audio/mpeg',
                            'ogg' => 'audio/ogg',
                            'wav' => 'audio/wav',
                            'm4a' => 'audio/mp4'
                        ];
                        $mime = $map[$ext] ?? 'application/octet-stream';
                    }

                    $mp = start_madeline_locked();
                    try {
                        // 1) Пытаемся через low-level external
                        try {
                            $media = (str_starts_with($mime, 'image/') && $ext !== 'gif')
                                ? ['_' => 'inputMediaPhotoExternal',    'url' => $url]
                                : ['_' => 'inputMediaDocumentExternal', 'url' => $url];

                            $res = $mp->messages->sendMedia([
                                'peer'    => $peer,
                                'media'   => $media,
                                'message' => $caption,
                            ]);
                        } catch (\Throwable $ex) {
                            // 2) Фолбэк: high-level с RemoteUrl
                            $rl = new RemoteUrl($url);
                            if (str_starts_with($mime, 'image/') && $ext !== 'gif') {
                                $res = $mp->sendPhoto($peer, $rl, $caption);
                            } else {
                                $res = $mp->sendDocument($peer, $rl, $caption);
                            }
                        }

                        // Достаём подтверждённый message_id из любого формата апдейтов
                        [$msgId, $date] = extract_sent_message_meta($res);
                        if (!$msgId) fail('Telegram did not confirm media message', 502);
                        proactive_cache_media($mp, (string)$peer, (int)$msgId);
                        notify_webhook_sent_update((string)$peer, (int)$msgId, (int)$date, (string)$caption, $clientUid);

                        ok(['success' => true, 'message_id' => $msgId, 'date' => $date, 'via' => 'external_url']);
                    } catch (\Throwable $e) {
                        log_err('sendFile external error', ['err' => $e->getMessage(), 'url' => $url]);
                        fail('SEND ERROR: ' . $e->getMessage(), 500);
                    } finally {
                        finish_madeline_locked($mp);
                    }
                }

                // -------- если URL не пришёл — остаётся локальный upload --------
                $tmp = null;
                $tmpIsOwn = false;
                $mime = 'application/octet-stream';
                $name = 'file.bin';

                if (!empty($_FILES['file']) && is_uploaded_file($_FILES['file']['tmp_name'])) {
                    $tmp  = $_FILES['file']['tmp_name'];
                    $name = $_FILES['file']['name'] ?? $name;
                    $mime = $_FILES['file']['type'] ?: (mime_content_type($tmp) ?: $mime);
                } elseif (!empty($payload['file']) && is_array($payload['file']) && !empty($payload['file']['base64'])) {
                    $name = basename((string)($payload['file']['name'] ?? $name));
                    $data = (string)$payload['file']['base64'];
                    $data = preg_replace('#^data:[^;]+;base64,#', '', $data);
                    $bin  = base64_decode($data, true);
                    if ($bin === false) fail('invalid base64', 400);
                    $tmp = rtrim(TMPDIR, '/') . '/' . uniqid('tg_up_', true) . '_' . $name;
                    file_put_contents($tmp, $bin);
                    $tmpIsOwn = true;
                    $mime = (string)($payload['file']['mime'] ?? mime_content_type($tmp) ?: $mime);
                } else {
                    $filePath = (string)($payload['filePath'] ?? '');
                    if ($filePath !== '' && is_readable($filePath)) {
                        $tmp  = $filePath;
                        $name = basename($filePath);
                        $mime = mime_content_type($tmp) ?: $mime;
                    }
                }
                if (!$tmp || !is_readable($tmp) || filesize($tmp) === 0) {
                    fail('Provide fileUrl OR file (multipart/base64) OR filePath', 400);
                }

                $mp = start_madeline_locked();
                try {
                    $uploaded = $mp->upload($tmp, $name);

                    if (str_starts_with($mime, 'image/') && strtolower(pathinfo($name, PATHINFO_EXTENSION)) !== 'gif') {
                        $media = ['_' => 'inputMediaUploadedPhoto', 'file' => $uploaded];
                    } else {
                        $attrs = [['_' => 'documentAttributeFilename', 'file_name' => $name]];
                        if (str_starts_with($mime, 'video/')) {
                            $attrs[] = ['_' => 'documentAttributeVideo', 'supports_streaming' => true];
                        } elseif (str_starts_with($mime, 'audio/')) {
                            $attrs[] = ['_' => 'documentAttributeAudio'];
                        }
                        $media = [
                            '_'          => 'inputMediaUploadedDocument',
                            'file'       => $uploaded,
                            'mime_type'  => $mime,
                            'attributes' => $attrs
                        ];
                    }

                    $res = $mp->messages->sendMedia(['peer' => $peer, 'media' => $media, 'message' => $caption]);

                    [$msgId, $date] = extract_sent_message_meta($res);
                    if (!$msgId) fail('Telegram did not confirm media message', 502);
                    proactive_cache_media($mp, (string)$peer, (int)$msgId);
                    notify_webhook_sent_update((string)$peer, (int)$msgId, (int)$date, (string)$caption, $clientUid);


                    ok(['success' => true, 'message_id' => $msgId, 'date' => $date, 'via' => 'upload']);
                } catch (\Throwable $e) {
                    log_err('sendFile upload error', ['err' => $e->getMessage()]);
                    fail('SEND ERROR: ' . $e->getMessage(), 500);
                } finally {
                    if ($tmpIsOwn && is_file($tmp)) @unlink($tmp);
                    finish_madeline_locked($mp);
                }
            }

        case 'markAsRead': {
                $peer = (string)($payload['chatId'] ?? '');
                if ($peer === '') fail('chatId is required');
                $mp = start_madeline_locked();
                try {
                    require_once __DIR__ . '/read_history.php';
                    tg_read_history($mp, $peer, 2147483647);
                    ok(['status' => 'ok']);
                } finally {
                    finish_madeline_locked($mp);
                }
            }
        
        case 'reactToMessage': {
            $peer = (string)($payload['chatId'] ?? '');
            $msgId = (int)($payload['messageId'] ?? 0);
            // Реакция - это строка с эмодзи. Для удаления передайте пустую строку.
            $reaction = (string)($payload['reaction'] ?? '');

            if ($peer === '' || $msgId <= 0) {
                fail('Требуются chatId и messageId');
            }

            $mp = start_madeline_locked();
            try {
                $params = [
                    'peer'   => $peer,
                    'msg_id' => $msgId,
                    'reaction' => [] // По умолчанию - удаление реакции
                ];

                // Если эмодзи реакции передан, добавляем его в параметры
                if (!empty($reaction)) {
                    $params['reaction'][] = ['_' => 'reactionEmoji', 'emoticon' => $reaction];
                }

                $res = $mp->messages->sendReaction($params);
                ok(['success' => (bool)$res, 'result' => $res]);

            } finally {
                finish_madeline_locked($mp);
            }
            break; // Не забудьте break
        }

 case 'getMessageReactions': {
    // Возвращает массив компактных реакций для ОДНОГО сообщения
    // Параметры: chatId (string|int), messageId (int)
    header('Content-Type: application/json; charset=utf-8');
    $peer  = (string)($_GET['chatId']  ?? $_POST['chatId']  ?? ($payload['chatId'] ?? ''));
    $msgId = (int)   ($_GET['messageId'] ?? $_POST['messageId'] ?? ($payload['messageId'] ?? 0));
    if ($peer === '' || $msgId <= 0) {
        http_response_code(400);
        echo json_encode(['error' => 'chatId and messageId are required']);
        break;
    }

    $mp = start_madeline_locked();
    try {
        // 1) Быстрый путь: getMessagesReactions
        $rx = $mp->messages->getMessagesReactions([
            'peer' => $peer,
            'id'   => [$msgId],
        ]);
        $out = [];
        $detailed = [];
        $snapshotFound = false;
        if (is_array($rx) && !empty($rx['updates'])) {
            foreach ($rx['updates'] as $u) {
                if (($u['_'] ?? '') === 'updateMessageReactions' && (int)($u['msg_id'] ?? 0) === $msgId) {
                    $out = tg_simple_reactions($u['reactions'] ?? []);
                    
                    // === ИСПРАВЛЕНИЕ ЗДЕСЬ ===
                    // Вызываем функцию с правильным количеством аргументов
                    $detailed = tg_reactions_detailed($u['reactions'] ?? []);
                    $snapshotFound = true;
                    
                    break;
                }
            }
        }

        // 2) Резерв: дёрнуть полное сообщение и вытащить reactions
        if (!$snapshotFound) {
            $gm = $mp->messages->getMessages(['peer' => $peer, 'id' => [$msgId]]);
            $messages = $gm['messages'] ?? [];
            foreach ($messages as $m) {
                if ((int)($m['id'] ?? 0) === $msgId && ($m['_'] ?? '') !== 'messageEmpty') {
                    $out = tg_simple_reactions($m['reactions'] ?? []);

                    // === И ИСПРАВЛЕНИЕ ЗДЕСЬ ===
                    // Вызываем функцию с правильным количеством аргументов
                    $detailed = tg_reactions_detailed($m['reactions'] ?? []);
                    $snapshotFound = true;
                    
                    break;
                }
            }
        }

        if (!$snapshotFound) {
            http_response_code(404);
            echo json_encode(['success' => false, 'error' => 'reaction snapshot was not found']);
            break;
        }
        echo json_encode(['success' => true, 'reactions' => $out, 'reactionsDetailed' => $detailed], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    
    } catch (\Throwable $e) {
        http_response_code(500);
        echo json_encode(['error' => 'tg', 'message' => $e->getMessage()]);
    } finally {
        finish_madeline_locked($mp);
    }
    break;
}

case 'getMessagesReactions': {
    // Возвращает карту реакций для НЕСКОЛЬКИХ сообщений
    // Параметры: chatId (string|int), messageIds (array<int>|csv)
    header('Content-Type: application/json; charset=utf-8');
    $peer  = (string)($_GET['chatId']  ?? $_POST['chatId']  ?? ($payload['chatId'] ?? ''));
    $idsRaw = $_POST['messageIds'] ?? $_GET['messageIds'] ?? ($payload['messageIds'] ?? []);
    if (is_string($idsRaw)) {
        // допускаем CSV "1,2,3"
        $idsRaw = array_filter(array_map('trim', explode(',', $idsRaw)), 'strlen');
    }
    if (!is_array($idsRaw)) $idsRaw = [];
    $msgIds = [];
    foreach ($idsRaw as $v) {
        $i = (int)$v;
        if ($i > 0) $msgIds[] = $i;
    }
    if ($peer === '' || empty($msgIds)) {
        http_response_code(400);
        echo json_encode(['error' => 'chatId and messageIds[] are required']);
        break;
    }

    $mp = start_madeline_locked();
    try {
        $result = [];

        // 1) Основной путь: messages.getMessagesReactions (возвращает updates)
        try {
            $rx = $mp->messages->getMessagesReactions([
                'peer' => $peer,
                'id'   => array_values($msgIds),
            ]);
            if (is_array($rx) && !empty($rx['updates'])) {
                foreach ($rx['updates'] as $u) {
                    if (($u['_'] ?? '') === 'updateMessageReactions') {
                        $rid = (int)($u['msg_id'] ?? 0);
                        if ($rid > 0) {
                            // Нормализуем в компакт с актёрами (только id)
                            $result[(string)$rid] = tg_reactions_detailed($u['reactions'] ?? []);
                        }
                    }
                }
            }
        } catch (\Throwable $e) {
            log_err('getMessagesReactions: telegram call failed', ['peer' => $peer, 'err' => $e->getMessage()]);
        }

        // 2) Фолбэк: messages.getMessages и взять поле reactions
        $missing = [];
        foreach ($msgIds as $mid) {
            if (!array_key_exists((string)$mid, $result)) $missing[] = $mid;
        }
        if (!empty($missing)) {
            try {
                // Message ids are only unique inside a peer. Supplying the
                // current peer keeps a fallback snapshot from another dialog
                // from being attached to this chat.
                $gm = $mp->messages->getMessages(['peer' => $peer, 'id' => $missing]);
                foreach (($gm['messages'] ?? []) as $m) {
                    $mid = (int)($m['id'] ?? 0);
                    if ($mid > 0 && ($m['_'] ?? '') !== 'messageEmpty') {
                        $result[(string)$mid] = tg_reactions_detailed($m['reactions'] ?? []);
                    }
                }
            } catch (\Throwable $e) {
                log_err('getMessagesReactions: fallback getMessages failed', ['peer' => $peer, 'err' => $e->getMessage()]);
            }
        }

        echo json_encode(['success' => true, 'data' => $result], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
    } catch (\Throwable $e) {
        http_response_code(500);
        echo json_encode(['error' => 'tg', 'message' => $e->getMessage()]);
    } finally {
        finish_madeline_locked($mp);
    }
    break;
}


         // =========================
         // EDIT MESSAGE (унифицированный)
         // =========================
        case 'edit_message': {
    // читаем JSON-тело, НЕ $_POST
    $chatId    = (string)($payload['chat_id'] ?? '');
    $messageId = (int)($payload['message_id'] ?? 0);
    $text      = (string)($payload['text'] ?? '');
    $parseMode = (string)($payload['parse_mode'] ?? 'HTML');

    if ($chatId === '' || $messageId <= 0 || $text === '') {
        http_response_code(400);
        echo json_encode(['ok' => false, 'error' => 'bad_args']);
        break;
    }

    try {
        // Это чисто Telegram-эндпоинт — не проверяем $source вообще
        /** @var \danog\MadelineProto\API $Madeline */
        $mp = start_madeline_locked();
        try {
            $res = $mp->messages->editMessage([
                'peer'       => $chatId,     // можно id/username/ссылку
                'id'         => $messageId,  // INT!
                'message'    => $text,
                'parse_mode' => $parseMode,  // 'HTML' | 'Markdown'
            ]);
            echo json_encode([
                'ok'     => true,
                'result' => $res,
                    'patched'=> [
                     'id'        => (string)$messageId,
                     'text'      => $text,
                     'edited'    => true,
                     'edit_date' => time()
                 ],
                
            ]);
        } finally {
            finish_madeline_locked($mp);
        }
    } catch (\Throwable $e) {
        http_response_code(500);
        echo json_encode(['ok' => false, 'error' => 'edit_failed', 'message' => $e->getMessage()]);
    }
    break;
}

         // =========================
         // FORWARD MESSAGE (унифицированный)
         // =========================
         case 'forward_message': {
           $chatDbId      = $_POST['chat_db_id'] ?? '';
           $fromSource    = strtolower(trim($_POST['from_source'] ?? ''));
           $fromChatId    = $_POST['from_chat_id'] ?? '';
           $fromMessageId = $_POST['from_message_id'] ?? '';
           $toSource      = strtolower(trim($_POST['to_source'] ?? ''));
           $toChatId      = $_POST['to_chat_id'] ?? '';

           if (!$fromSource || !$toSource || !$fromChatId || !$fromMessageId || !$toChatId) {
             http_response_code(400);
             echo json_encode(['ok' => false, 'error' => 'bad_args']);
             break;
           }

           try {
             if (strpos($fromSource, 'tele') === 0 && strpos($toSource, 'tele') === 0) {
               // --- Telegram native forward
               /** @var \danog\MadelineProto\API $Madeline */
                $mp = start_madeline_locked();
                try {
                    $res = $mp->messages->forwardMessages([
                     'from_peer' => $fromChatId,
                     'id'        => [(int)$fromMessageId],
                     'to_peer'   => $toChatId,
                     'silent'    => true,
                    ]);
                    echo json_encode(['ok' => true, 'result' => $res]);
                } finally {
                    finish_madeline_locked($mp);
                }
               break;
             }

             // --- Fallback: нет нативного форварда (или другой source)
             // Отправим новое сообщение с пометкой "forwarded_from"
             $forwardedFrom = 'Переслано от: ' . $fromChatId;
             // TODO: здесь вызовите вашу обычную логику "send_message"
             // и верните объект нового сообщения. Ниже — формальный ответ,
             // который фронт умеет отрисовать (fwd header).
             echo json_encode([
               'ok' => true,
               'fallback' => true,
               'forwarded_from' => $forwardedFrom
             ]);
           } catch (Throwable $e) {
             http_response_code(500);
             echo json_encode(['ok' => false, 'error' => 'forward_failed', 'message' => $e->getMessage()]);
           }
           break;
         }

            // ===== НАЧАЛО ЗАМЕНЫ =====
        case 'downloadThumb': {
                set_media_headers_common();

                $peer = (string)($_GET['chatId'] ?? '');
                $mid  = (int)($_GET['messageId'] ?? 0);
                if ($peer === '' || $mid <= 0) fail('chatId and messageId are required');
                $isDesktopVideoPoster = strtolower((string)($_GET['kind'] ?? '')) === 'video';
                $traceContext = ['peer_hash' => tg_media_trace_peer($peer), 'mid' => $mid, 'kind' => $isDesktopVideoPoster ? 'video' : 'other'];
                tg_media_trace('thumb_start', $traceContext);

                $cacheDir  = rtrim(TMPDIR, '/') . '/cache';
                if (!is_dir($cacheDir)) @mkdir($cacheDir, 0777, true);
                $thumbPath = $cacheDir . '/th_' . sha1($peer . '#' . $mid) . '.jpg';

                // --- HEAD: отвечаем по кэшу, иначе 404 ---
                if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
                    if (is_file($thumbPath) && filesize($thumbPath) > 0 && !tg_is_thumbnail_placeholder($thumbPath)) {
                        tg_media_trace('thumb_head_cache', $traceContext + ['bytes' => (int)filesize($thumbPath)]);
                        header('Content-Type: ' . detect_mime($thumbPath, true, 'image/jpeg'));
                        header('Content-Length: ' . (string)filesize($thumbPath));
                        exit;
                    }
                    http_response_code(404);
                    exit;
                }

                // 1) кэш есть — отдаем сразу
                if (is_file($thumbPath) && filesize($thumbPath) > 0 && !tg_is_thumbnail_placeholder($thumbPath)) {
                    tg_media_trace('thumb_cache', $traceContext + ['bytes' => (int)filesize($thumbPath)]);
                    header('Content-Type: ' . detect_mime($thumbPath, true, 'image/jpeg'));
                    header('Content-Length: ' . (string)filesize($thumbPath));
                    readfile($thumbPath);
                    exit;
                }
                // The old route negatively cached the transparent 1×1 PNG.
                // It must not prevent a later request from recovering the
                // actual Telegram poster after the message becomes available.
                if (tg_is_thumbnail_placeholder($thumbPath)) @unlink($thumbPath);

                // 2) если кэша нет — пробуем скачать превью из сообщения
                $png = base64_decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR4nGNgYAAAAAMAASsJTYQAAAAASUVORK5CYII=');

                // Video posters must use the listener's IPC client just like
                // video ranges. Otherwise a thumbnail can wait behind the
                // legacy session flock while the visible player is loading.
                $mp = $isDesktopVideoPoster ? start_madeline_media_ipc_client() : start_madeline_locked();
                try {
                    $m = $mp->messages->getMessages(['peer' => $peer, 'id' => [$mid]])['messages'][0] ?? null;

                    // getMessages for a channel can omit document thumbs even
                    // while getHistory has the complete video descriptor.
                    // Prefer the richer record before concluding that a
                    // poster does not exist.
                    $hasEmbeddedThumbnail = static function ($message): bool {
                        if (!is_array($message) || !is_array($message['media'] ?? null)) return false;
                        $media = $message['media'];
                        return isset($media['photo'])
                            || !empty($media['document']['thumbs'])
                            || !empty($media['document']['video_thumbs']);
                    };
                    if (!$hasEmbeddedThumbnail($m)) {
                        $history = $mp->messages->getHistory([
                            'peer' => $peer, 'offset_id' => $mid + 1, 'limit' => 1,
                        ]);
                        foreach (($history['messages'] ?? []) as $candidate) {
                            if ((int)($candidate['id'] ?? 0) === $mid && $hasEmbeddedThumbnail($candidate)) {
                                $m = $candidate;
                                break;
                            }
                        }
                    }

                    if ($m === null || empty($m['media'])) {
                        tg_media_trace('thumb_placeholder_missing_message', $traceContext);
                        header('X-Unified-Telegram-Thumbnail-Placeholder: 1');
                        header('Content-Type: image/png');
                        header('Content-Length: ' . (string)strlen($png));
                        echo $png;
                        exit;
                    }

                    $tmp = rtrim(TMPDIR, '/') . '/' . uniqid('tg_th_', true);
                    $downloaded = false;

                    try {
                        $media = $m['media'];
                        if (isset($media['photo'])) {
                            $mp->downloadToFile($media['photo'], $tmp);
                            $downloaded = true;
                        } else {
                            // Telegram puts a tiny `photoStrippedSize` record
                            // first for many videos. It is an inline blur, not
                            // a downloadable file location; asking Madeline to
                            // fetch it leaves us with the 1×1 fallback. Pick a
                            // real image size from either thumbnail collection.
                            $thumbs = array_merge(
                                array_values(is_array($media['document']['thumbs'] ?? null) ? $media['document']['thumbs'] : []),
                                array_values(is_array($media['document']['video_thumbs'] ?? null) ? $media['document']['video_thumbs'] : [])
                            );
                            foreach ($thumbs as $thumb) {
                                if (!is_array($thumb) || (($thumb['_'] ?? '') === 'photoStrippedSize')) continue;
                                $thumbSize = (string)($thumb['type'] ?? '');
                                if ($thumbSize === '') continue;

                                // A document thumbnail is addressed as a
                                // particular `thumb_size` *of the document*.
                                // `photoSize` by itself has no
                                // InputFileLocation, which is why passing it
                                // directly caused "Undefined array key
                                // InputFileLocation" and a fake PNG fallback.
                                $download = $mp->getDownloadInfo($m);
                                if (!is_array($download['InputFileLocation'] ?? null)) continue;
                                $download['InputFileLocation']['thumb_size'] = $thumbSize;
                                if (isset($thumb['size'])) $download['size'] = (int)$thumb['size'];
                                $mp->downloadToFile($download, $tmp);
                                $downloaded = true;
                                break;
                            }
                        }

                        if ($downloaded && is_file($tmp) && filesize($tmp) > 0 && str_starts_with(detect_mime($tmp), 'image/')) {
                            @rename($tmp, $thumbPath);
                            tg_media_trace('thumb_ready', $traceContext + ['bytes' => (int)filesize($thumbPath)]);
                            header('Content-Type: ' . detect_mime($thumbPath, true, 'image/jpeg'));
                            header('Content-Length: ' . (string)filesize($thumbPath));
                            readfile($thumbPath);
                            exit;
                        }
                    } catch (\Throwable $e) {
                        tg_media_trace('thumb_error', $traceContext + ['error' => get_class($e)]);
                        log_err('downloadThumb: Download FAILED', ['peer' => $peer, 'mid' => $mid, 'error' => $e->getMessage()]);
                    } finally {
                        if (is_file($tmp)) @unlink($tmp);
                    }

                    // Do not cache a missing preview. Some channel messages
                    // briefly return messageEmpty to getMessages but their
                    // video thumb is available through getHistory on the next
                    // read. A transparent PNG is only a one-request fallback.
                    header('X-Unified-Telegram-Thumbnail-Placeholder: 1');
                    tg_media_trace('thumb_placeholder_unavailable', $traceContext);
                    header('Content-Type: image/png');
                    header('Content-Length: ' . (string)strlen($png));
                    echo $png;
                    exit;
                } finally {
                    finish_madeline_locked($mp);
                }
            }

        case 'downloadMedia': {
                set_media_headers_common();
                $peer = (string)($_GET['chatId'] ?? '');
                $mid = (int)($_GET['messageId'] ?? 0);
                if ($peer === '' || $mid <= 0) fail('chatId and messageId are required');
                $asAttachment = (int)($_GET['dl'] ?? 0) === 1;
                $isDesktopVideo = strtolower((string)($_GET['kind'] ?? '')) === 'video';
                $traceContext = ['peer_hash' => tg_media_trace_peer($peer), 'mid' => $mid, 'kind' => $isDesktopVideo ? 'video' : 'other'];
                tg_media_trace('media_start', $traceContext);
                $disposition = $asAttachment ? 'attachment' : 'inline';
                $cacheDir = rtrim(TMPDIR, '/') . '/cache';
                $cachePath = $cacheDir . '/' . sha1($peer . '#' . $mid);
                $cacheMeta = tg_read_media_cache_metadata($cachePath);
                if (tg_media_cache_is_complete($cachePath)) {
                    tg_media_trace('media_cache', $traceContext + ['bytes' => (int)@filesize($cachePath)]);
                    tg_media_stream_cached_file(
                        $cachePath,
                        $cacheMeta['mime'] !== '' ? $cacheMeta['mime'] : detect_mime($cachePath, true, 'application/octet-stream'),
                        $asAttachment,
                        'file_' . $mid . '.bin'
                    );
                    exit;
                }
                // A second WebView range request must not sit on the global
                // Madeline session while another request owns this same file.
                // Either consume a complete cache or return a retryable 503.
                $lock = null;
                if (!$isDesktopVideo) {
                    $lockPath = $cachePath . '.lock';
                    $lock = @fopen($lockPath, 'c');
                    if (!$lock || !@flock($lock, LOCK_EX | LOCK_NB)) {
                        if ($lock) @fclose($lock);
                        $cacheMeta = tg_read_media_cache_metadata($cachePath);
                        if (tg_media_cache_is_complete($cachePath)) {
                            tg_media_stream_cached_file(
                                $cachePath,
                                $cacheMeta['mime'] !== '' ? $cacheMeta['mime'] : detect_mime($cachePath, true, 'application/octet-stream'),
                                $asAttachment,
                                'file_' . $mid . '.bin'
                            );
                            exit;
                        }
                        fail('Media is being downloaded by another process, try again later', 503);
                    }
                }
                try {
                    $mp = $isDesktopVideo ? start_madeline_media_ipc_client() : start_madeline_locked();
                    try {
                        $cacheMeta = tg_read_media_cache_metadata($cachePath);
                        if (tg_media_cache_is_complete($cachePath)) {
                            tg_media_stream_cached_file(
                                $cachePath,
                                $cacheMeta['mime'] !== '' ? $cacheMeta['mime'] : detect_mime($cachePath, true, 'application/octet-stream'),
                                $asAttachment,
                                'file_' . $mid . '.bin'
                            );
                            exit;
                        }
                        $m = $mp->messages->getMessages(['peer' => $peer, 'id' => [$mid]])['messages'][0] ?? null;
                        // MadelineProto can return messageEmpty for a channel
                        // document.  getHistory retains the real media object.
                        if ($m === null || empty($m['media'])) {
                            $history = $mp->messages->getHistory([
                                'peer' => $peer, 'offset_id' => $mid + 1, 'limit' => 1,
                            ]);
                            foreach (($history['messages'] ?? []) as $candidate) {
                                if ((int)($candidate['id'] ?? 0) === $mid && !empty($candidate['media'])) {
                                    $m = $candidate;
                                    break;
                                }
                            }
                        }
                        if ($m === null || empty($m['media'])) fail('message or media not found', 404);
                        $filenameHdr = "file_{$mid}.bin";
                        if (!empty($m['media']['document']['attributes'])) {
                            foreach ($m['media']['document']['attributes'] as $a) {
                                if (($a['_'] ?? '') === 'documentAttributeFilename' && !empty($a['file_name'])) {
                                    $filenameHdr = (string)$a['file_name'];
                                    break;
                                }
                            }
                        }
                        $document = is_array($m['media']['document'] ?? null) ? $m['media']['document'] : [];
                        $total = (int)($document['size'] ?? 0);
                        $mime = (string)($document['mime_type'] ?? 'application/octet-stream');

                        // Caches created by earlier releases did not have a
                        // sidecar. Trust one only after the Telegram document
                        // gives us its authoritative byte size.
                        if ($total > 0 && is_file($cachePath)) {
                            if ((int)@filesize($cachePath) === $total
                                && tg_write_media_cache_metadata($cachePath, $total, $mime)) {
                                tg_media_stream_cached_file($cachePath, $mime, $asAttachment, $filenameHdr);
                                exit;
                            }
                            tg_forget_incomplete_media_cache($cachePath);
                        }

                        // Do not materialize a whole MP4 before returning a
                        // single byte to the player. Telegram's client shows
                        // a poster immediately and then consumes byte ranges;
                        // preserve that responsive model for an uncached file.
                        // A missing size is rare (and cannot form a correct
                        // HTTP range response), so retain the established
                        // file-cache path for that compatibility case.
                        if ($total > 0) {
                            $isHead = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) === 'HEAD';
                            // RFC 9110 applies Range to GET. HEAD describes
                            // the whole representation and has no body.
                            $plan = $isHead ? null : tg_media_single_byte_range_plan((string)($_SERVER['HTTP_RANGE'] ?? ''), $total);
                            if (is_array($plan) && ($plan['status'] ?? 0) === 416) {
                                http_response_code(416);
                                header('Content-Range: bytes */' . $plan['total']);
                                header('Content-Length: 0');
                                header('Accept-Ranges: bytes');
                                exit;
                            }
                            $isPartial = is_array($plan) && ($plan['status'] ?? 0) === 206;
                            $start = $isPartial ? (int)$plan['start'] : 0;
                            $end = $isPartial ? (int)$plan['end'] : $total - 1;
                            $length = $isPartial ? (int)$plan['length'] : $total;
                            tg_media_trace('media_headers', $traceContext + ['status' => $isPartial ? 206 : 200, 'start' => $start, 'length' => $length, 'total' => $total]);

                            http_response_code($isPartial ? 206 : 200);
                            header('Content-Type: ' . $mime);
                            header('Content-Length: ' . $length);
                            if ($isPartial) header('Content-Range: bytes ' . $start . '-' . $end . '/' . $total);
                            header('Accept-Ranges: bytes');
                            header('Content-Disposition: ' . $disposition . '; filename="' . str_replace('"', '', basename($filenameHdr)) . '"');
                            header('X-Accel-Buffering: no');
                            if ($isHead) exit;

                            // Cache only a true full-file read. Partial video
                            // probes must never leave a fragment that another
                            // player could mistake for a complete download.
                            $cacheWholeFile = !$isDesktopVideo && $start === 0 && $end === $total - 1;
                            $tmp = $cacheWholeFile ? tg_track_temporary_media_file($cacheDir . '/' . uniqid('dl_', true)) : '';
                            $sink = $cacheWholeFile ? @fopen($tmp, 'xb') : false;
                            $bytesStreamed = 0;
                            $bytesCached = 0;
                            // MadelineProto 8.7 treats its final offset as
                            // exclusive; HTTP Content-Range is inclusive.
                            $downloadEndExclusive = $end + 1;
                            try {
                                $mp->downloadToCallable(
                                    $m,
                                    static function (string $payload, int $offset) use ($sink, &$bytesStreamed, &$bytesCached): int {
                                        if (connection_aborted()) {
                                            throw new \RuntimeException('Client disconnected during Telegram media stream');
                                        }
                                        $payloadLength = strlen($payload);
                                        if (is_resource($sink)) {
                                            $written = @fwrite($sink, $payload);
                                            if ($written !== $payloadLength) {
                                                throw new \RuntimeException('Unable to write complete Telegram media cache chunk');
                                            }
                                            $bytesCached += $written;
                                        }
                                        $bytesStreamed += $payloadLength;
                                        $GLOBALS['__TG_BINARY_BODY_STARTED__'] = true;
                                        echo $payload;
                                        if (function_exists('ob_flush')) @ob_flush();
                                        flush();
                                        return $payloadLength;
                                    },
                                    null,
                                    false,
                                    $start,
                                    $downloadEndExclusive
                                );
                                if ($bytesStreamed !== $length) {
                                    throw new \RuntimeException('Telegram media range length mismatch');
                                }
                                tg_media_trace('media_complete', $traceContext + ['bytes' => $bytesStreamed, 'total' => $total]);
                                if (is_resource($sink)) {
                                    fclose($sink);
                                    $sink = false;
                                    if ($bytesCached !== $total || !tg_publish_complete_media_cache($tmp, $cachePath, $total, $mime)) {
                                        throw new \RuntimeException('Telegram full media cache integrity check failed');
                                    }
                                    tg_untrack_temporary_media_file($tmp);
                                }
                            } finally {
                                if (is_resource($sink)) fclose($sink);
                                if ($tmp !== '' && is_file($tmp)) @unlink($tmp);
                            }
                            exit;
                        }

                        $tmp = tg_track_temporary_media_file($cacheDir . '/' . uniqid('dl_'));
                        $mp->downloadToFile($m, $tmp);
                        $downloadedSize = is_file($tmp) ? (int)@filesize($tmp) : 0;
                        if (!tg_publish_complete_media_cache($tmp, $cachePath, $downloadedSize, detect_mime($tmp, true, 'application/octet-stream'))) {
                            throw new \RuntimeException('Telegram media cache integrity check failed');
                        }
                        tg_untrack_temporary_media_file($tmp);
                        tg_media_stream_cached_file($cachePath, detect_mime($cachePath), $asAttachment, $filenameHdr);
                        exit;
                    } finally {
                        finish_madeline_locked($mp);
                    }
                } catch (\Throwable $e) {
                    tg_media_trace('media_error', $traceContext + ['error' => get_class($e)]);
                    throw $e;
                } finally {
                    if (is_resource($lock)) {
                        @flock($lock, LOCK_UN);
                        @fclose($lock);
                    }
                }
            }

        case 'ensure': {
                // Поддерживаем ?key=<sha1> или ?chatId=<peer>&messageId=<mid> -> derive key
                $key = $_GET['key'] ?? null;
                if (!$key && isset($_GET['chatId'], $_GET['messageId'])) {
                    $key = tg_cache_key((string)$_GET['chatId'], (string)$_GET['messageId']);
                }
                if (!$key || !preg_match('/^[a-f0-9]{40}$/', $key)) {
                    json_cors();
                    http_response_code(400);
                    header('Content-Type: application/json; charset=utf-8');
                    echo json_encode(['ok' => false, 'error' => 'bad key'], JSON_UNESCAPED_UNICODE);
                    exit;
                }

                $cacheDir  = rtrim(TMPDIR, '/') . '/cache';
                if (!is_dir($cacheDir)) @mkdir($cacheDir, 0775, true);
                $cachePath = $cacheDir . '/' . $key;

                $ready = tg_media_cache_is_complete($cachePath);
                $pub   = tg_media_host() . '/pub/' . $key;

                json_cors();
                header('Content-Type: application/json; charset=utf-8');
                header('Cache-Control: no-cache, no-store, must-revalidate');
                if (!$ready) {
                    http_response_code(202);
                    header('Retry-After: 2');
                }
                echo json_encode(['ok' => true, 'ready' => $ready, 'key' => $key, 'public_url' => $pub], JSON_UNESCAPED_UNICODE);
                exit;
            }

        case 'pub': {
                $key = $_GET['key'] ?? null;
                if (!$key || !preg_match('/^[a-f0-9]{40}$/', $key)) {
                    http_response_code(400);
                    echo 'bad key';
                    exit;
                }

                $cacheDir  = rtrim(TMPDIR, '/') . '/cache';
                $cachePath = $cacheDir . '/' . $key;
                $cacheMeta = tg_read_media_cache_metadata($cachePath);
                if (!tg_media_cache_is_complete($cachePath)) {
                    http_response_code(404);
                    echo 'not found';
                    exit;
                }

                $mime = $cacheMeta['mime'] !== '' ? $cacheMeta['mime'] : detect_mime($cachePath, true, 'application/octet-stream');
                $ext  = tg_ext_by_mime($mime);

                header('Access-Control-Allow-Origin: *');
                header('Cache-Control: public, max-age=3600'); // мягкий кэш
                $mtime = @filemtime($cachePath) ?: time();
                header('ETag: "m'.$mtime.'"');
                header('Last-Modified: '.gmdate('D, d M Y H:i:s', $mtime).' GMT');
                header('X-Content-Type-Options: nosniff');
                header('Content-Type: ' . $mime);
                header('Content-Disposition: inline; filename="tg_' . $key . $ext . '"');

                // e-вариант: nginx отдаёт файл без расширения
                header('X-Accel-Redirect: /telegram_cache_e/' . $key . $ext);
                exit;
            }

        case 'getUserInfo': {
            $peerRaw = $_GET['peer'] ?? $payload['peer'] ?? null;
            if (!$peerRaw || !is_string($peerRaw)) fail('peer is required');
            $mp = start_madeline_locked();
            try {
                $info = $mp->getInfo($peerRaw);
                $user = $info['User'] ?? null;
                if (!$user) fail('Not a user or not found', 404);
                ok(['user' => build_user_brief($user)]);
            } catch (\Throwable $e) {
                log_err('getUserInfo error', ['peer' => $peerRaw, 'err' => $e->getMessage()]);
                fail('Failed to get user info: ' . $e->getMessage(), 500);
            } finally {
                finish_madeline_locked($mp);
            }
            break;
        }

        case 'getUserFull': {
            $peerRaw = $_GET['peer'] ?? $payload['peer'] ?? null;
            if (!$peerRaw || !is_string($peerRaw)) fail('peer is required');
            $mp = start_madeline_locked();
            try {
                $info = $mp->getInfo($peerRaw);
                $full = $mp->getFullInfo($peerRaw);
                $user = $info['User'] ?? null;
                if (!$user) fail('Not a user or not found', 404);
                $brief = build_user_brief($user);
                $about = $full['full']['about'] ?? null;
                $commonChats = $full['full']['common_chats_count'] ?? null;
                ok(['user' => $brief, 'about' => $about, 'common_chats_count' => $commonChats, 'raw_full' => $full]);
            } catch (\Throwable $e) {
                log_err('getUserFull error', ['peer' => $peerRaw, 'err' => $e->getMessage()]);
                fail('Failed to get full user info: ' . $e->getMessage(), 500);
            } finally {
                finish_madeline_locked($mp);
            }
            break;
        }

        case 'getPeerFull': {
            $peerRaw = $_GET['peer'] ?? $payload['peer'] ?? null;
            if (!$peerRaw || !is_string($peerRaw) || !preg_match('/^-[1-9][0-9]{0,19}$/D', $peerRaw)) {
                fail('A Telegram group or channel peer is required');
            }
            $mp = start_madeline_locked();
            try {
                $full = $mp->getFullInfo($peerRaw);
                $fullChat = is_array($full['full'] ?? null) ? $full['full'] : [];
                $chat = is_array($full['Chat'] ?? null) ? $full['Chat'] : [];
                $channel = is_array($full['Channel'] ?? null) ? $full['Channel'] : [];
                $entities = [$chat, $channel, $fullChat, $full];
                $pick = static function (array $keys) use ($entities): mixed {
                    foreach ($entities as $entity) {
                        foreach ($keys as $key) {
                            $value = $entity[$key] ?? null;
                            if (is_string($value) && trim($value) !== '') return trim($value);
                            if (is_int($value) || is_float($value)) return $value;
                        }
                    }
                    return null;
                };
                $kind = !empty($channel['broadcast'])
                    || strtolower((string)($full['type'] ?? '')) === 'channel'
                    ? 'channel' : 'group';
                $peer = [
                    'kind' => $kind,
                    'title' => (string)($pick(['title', 'name']) ?? ''),
                    'username' => ltrim((string)($pick(['username']) ?? ''), '@'),
                    'about' => (string)($pick(['about']) ?? ''),
                ];
                $participantsCount = $pick(['participants_count', 'members_count']);
                if ($participantsCount === null && is_array($fullChat['participants'] ?? null)) {
                    $participantRows = $fullChat['participants']['participants'] ?? null;
                    if (is_array($participantRows)) $participantsCount = count($participantRows);
                }
                if ($participantsCount !== null && is_numeric($participantsCount)) {
                    $peer['participants_count'] = max(0, (int)$participantsCount);
                }
                ok(['peer' => $peer]);
            } catch (\Throwable $e) {
                log_err('getPeerFull error', ['peer' => $peerRaw, 'err' => $e->getMessage()]);
                fail('Failed to get full group/channel info: ' . $e->getMessage(), 500);
            } finally {
                finish_madeline_locked($mp);
            }
            break;
        }

        default:
            fail("Unknown action: {$action}");
    }
} catch (\Throwable $e) {
    log_err('top-level error', ['e' => $e->getMessage(), 'trace' => $e->getTraceAsString()]);
    // A binary response may already have emitted its headers and a prefix of
    // the body. Appending JSON would corrupt the image/video even further.
    if (headers_sent() || !empty($GLOBALS['__TG_BINARY_BODY_STARTED__'])) exit;
    fail('ERROR: ' . $e->getMessage(), 500);
}

function cache_peer_avatar_candidate(API $mp, $candidate, string $peerRaw): ?string
{
    $key = preg_replace('~[^0-9A-Za-z_@.-]+~', '_', $peerRaw);
    $tmpFile = rtrim(TMPDIR, '/') . '/ava_' . uniqid('', true);
    try {
        if (!try_download_photo_to_file($mp, $candidate, $tmpFile)) return null;
        $mime = detect_mime($tmpFile, true, 'image/jpeg');
        $ext = str_contains($mime, 'png') ? 'png' : (str_contains($mime, 'webp') ? 'webp' : 'jpg');
        $finalPath = AVA_DIR . "/{$key}.{$ext}";
        foreach (['jpg', 'jpeg', 'png', 'webp', 'gif'] as $oldExt) {
            $oldPath = AVA_DIR . "/{$key}.{$oldExt}";
            if ($oldPath !== $finalPath && is_file($oldPath)) @unlink($oldPath);
        }
        @rename($tmpFile, $finalPath);
        @chmod($finalPath, 0664);
        return is_file($finalPath) ? AVA_URL . "/{$key}.{$ext}" : null;
    } finally {
        if (is_file($tmpFile)) @unlink($tmpFile);
    }
}

function cache_profile_avatar(API $mp, $peer, string $peerKey): ?string
{
    $key = preg_replace('~[^0-9A-Za-z_@.-]+~', '_', $peerKey);
    $tmpFile = rtrim(TMPDIR, '/') . '/ava_' . uniqid('', true);
    try {
        $mp->downloadProfilePhoto($peer, $tmpFile);
        if (!is_file($tmpFile) || filesize($tmpFile) === 0) return null;
        $mime = detect_mime($tmpFile, true, 'image/jpeg');
        $ext = str_contains($mime, 'png') ? 'png' : (str_contains($mime, 'webp') ? 'webp' : 'jpg');
        $finalPath = AVA_DIR . "/{$key}.{$ext}";
        @rename($tmpFile, $finalPath);
        @chmod($finalPath, 0664);
        return is_file($finalPath) ? AVA_URL . "/{$key}.{$ext}" : null;
    } catch (\Throwable $e) {
        return null;
    } finally {
        if (is_file($tmpFile)) @unlink($tmpFile);
    }
}
