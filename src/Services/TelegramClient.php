<?php

namespace App\Services;

require_once \dirname(__DIR__, 2) . '/config.php';

use App\Interfaces\MessagingClientInterface;

/**
 * TelegramClient — версия с детальным логированием,
 * уважающим переменные окружения:
 *
 * APP_LOG_LEVEL
 * TELEGRAM_CLIENT_DEBUG
 * TELEGRAM_WEBHOOK_LEVEL
 * TELEGRAM_HTTP_LOG_BODY
 * TELEGRAM_HTTP_BODY_FULL
 *
 * Пишет в \App\Logger и в локальный файл storage/logs/telegram_client.log.
 * Логирует:
 *  - используемые REST-методы и статусы
 *  - сниппет начального JSON-ответа (если разрешено)
 *  - правила фильтрации чатов (почему чат включён/исключён)
 *  - счётчики людей/ботов/архивных и отфильтрованных чатов
 */
class TelegramClient implements MessagingClientInterface
{
    private string $baseUrl;
    /** @var \GuzzleHttp\Client|mixed|null */
    private $guzzle = null;
    private string $logFile;

    /** Настройки логирования на лету */
    private int  $threshold;             // числовой порог
    private bool $allowDebug;            // уважает TELEGRAM_CLIENT_DEBUG
    private bool $logHttpBody;           // TELEGRAM_HTTP_LOG_BODY
    private bool $logHttpBodyFull;       // TELEGRAM_HTTP_BODY_FULL
    private float $httpTimeout = 8.0;
    private bool $lastRestGetTimedOut = false;

    /** @var callable|null fn(string $chatId): ?array ['url'=>string, 'is_default'=>bool, 'checked_at'=>int] */
    private $getAvatarMeta = null;
    /** @var callable|null fn(string $chatId, string $url, bool $isDefault, int $checkedAt): void */
    private $saveAvatarMeta = null;
    /** @var int TTL проверки дефолтного аватара, сек */
    private int $avatarTtlSeconds = 86400;

    public function __construct(string $baseUrl, ?bool $debug = null)
    {
        if ($baseUrl === '') {
            throw new \InvalidArgumentException('Base URL for TelegramClient cannot be empty.');
        }

        $this->baseUrl = rtrim($baseUrl, '/');
        $this->logFile = \dirname(__DIR__, 2) . '/storage/logs/telegram_client.log';

        // Инициализируем политику логирования
        $this->threshold       = $this->effectiveThreshold();
        $this->allowDebug      = ($debug !== null) ? (bool)$debug : (\getenv('TELEGRAM_CLIENT_DEBUG') === '1');
        $this->logHttpBody     = (\getenv('TELEGRAM_HTTP_LOG_BODY') === '1');
        $this->logHttpBodyFull = (\getenv('TELEGRAM_HTTP_BODY_FULL') === '1');
        $this->httpTimeout     = max(3.0, min(30.0, (float)(\getenv('TELEGRAM_HTTP_TIMEOUT') ?: 8.0)));

        // TTL из окружения (по умолчанию сутки)
        $this->avatarTtlSeconds = (int) (getenv('TELEGRAM_AVATAR_TTL') ?: 86400);

        // Колбэки к БД для кэширования мета-данных аватаров
        $this->wireAvatarResolversFromDb();

        // HTTP-клиент
        if (\class_exists('\\GuzzleHttp\\Client')) {
            $this->guzzle = new \GuzzleHttp\Client([
                'base_uri'    => $this->baseUrl,
                'timeout'     => $this->httpTimeout,
                'connect_timeout' => min(5.0, $this->httpTimeout),
                'http_errors' => false,
                'headers'     => ['Accept' => 'application/json'],
            ]);
        }
    }

    /* ============================== ПОЛИТИКА ЛОГИРОВАНИЯ ============================== */

    private function levelToInt(string $level): int
    {
        switch (strtolower($level)) {
            case 'debug':     return 100;
            case 'info':      return 200;
            case 'notice':    return 250;
            case 'warning':   return 300;
            case 'error':     return 400;
            case 'critical':  return 500;
            case 'alert':     return 550;
            case 'emergency': return 600;
            default:          return 200;
        }
    }

    private function effectiveThreshold(): int
    {
        $app = getenv('APP_LOG_LEVEL') ?: 'info';
        $tg  = getenv('TELEGRAM_WEBHOOK_LEVEL') ?: $app;
        return max($this->levelToInt($app), $this->levelToInt($tg));
    }

    private function shouldLog(string $level): bool
    {
        $lvl = $this->levelToInt($level);
        if (!$this->allowDebug && strtolower($level) === 'debug') {
            return false;
        }
        return $lvl >= $this->threshold;
    }

    private function jsonSnippet(?string $raw, int $limit = 600): string
    {
        if (!$this->logHttpBody) {
            return '[body logging disabled by TELEGRAM_HTTP_LOG_BODY]';
        }
        if ($raw === null) return '';
        $trimmed = trim($raw);
        if ($trimmed === '') return '';

        $decoded = json_decode($trimmed, true);
        if (json_last_error() === JSON_ERROR_NONE) {
            $maskKeys = ['access_token','refresh_token','authorization','auth','token','session','cookies'];
            $mask = function (&$a) use (&$mask, $maskKeys) {
                if (!is_array($a)) return;
                foreach ($a as $k => &$v) {
                    if (is_array($v)) { $mask($v); continue; }
                    if (in_array(strtolower((string)$k), $maskKeys, true)) {
                        $v = '[MASKED]';
                    }
                }
            };
            $mask($decoded);
            $json = $this->logHttpBodyFull
                ? json_encode($decoded, JSON_UNESCAPED_UNICODE)
                : mb_substr(json_encode($decoded, JSON_UNESCAPED_UNICODE), 0, $limit) . (strlen(json_encode($decoded)) > $limit ? '…' : '');
            return $json ?? '';
        }

        if ($this->logHttpBodyFull) return $trimmed;
        return mb_substr($trimmed, 0, $limit) . (mb_strlen($trimmed) > $limit ? '…' : '');
    }

    private function sanitizeUrl(string $url): string
    {
        return preg_replace(
            '~([?&](?:access_token|refresh_token|token|client_secret|authorization|auth|session|cookie|cookies)=)[^&#]*~i',
            '$1[MASKED]',
            $url
        ) ?? $url;
    }

    private function log(string $level, string $message, array $context = []): void
    {
        if (!$this->shouldLog($level)) return;

        $record = [
            'timestamp' => date('c'),
            'level'     => strtolower($level),
            'source'    => 'Telegram',
            'message'   => $message,
            'context'   => $context,
        ];

        // В файл
        @file_put_contents($this->logFile, json_encode($record, JSON_UNESCAPED_UNICODE) . PHP_EOL, FILE_APPEND);

        // В общий логгер приложения
        if (class_exists('\\App\\Logger')) {
            switch (strtolower($level)) {
                case 'debug':     \App\Logger::debug($message, $context); break;
                case 'info':      \App\Logger::info($message, $context); break;
                case 'notice':    \App\Logger::notice($message, $context); break;
                case 'warning':   \App\Logger::warning($message, $context); break;
                case 'error':     \App\Logger::error($message, $context); break;
                case 'critical':  \App\Logger::critical($message, $context); break;
                case 'alert':     \App\Logger::alert($message, $context); break;
                case 'emergency': \App\Logger::emergency($message, $context); break;
                default:          \App\Logger::info($message, $context); break;
            }
        }
    }

    /* ============================== АВАТАР-РЕЗОЛВЕРЫ ============================== */

    /**
     * Ручная установка резолверов и TTL (если нужно переопределить авто-подключение).
     */
    public function setAvatarResolvers(?callable $get, ?callable $set, ?int $ttl = null): void
    {
        $this->getAvatarMeta  = $get;
        $this->saveAvatarMeta = $set;
        if ($ttl !== null && $ttl > 0) {
            $this->avatarTtlSeconds = $ttl;
        }
    }

    /**
     * Ищем \App\Database и настраиваем два колбэка на таблицу chats.
     * Мету по аватару кладём в chats.item_context_json.
     */
    private function wireAvatarResolversFromDb(): void
    {
        try {
            if (!class_exists('\\App\\Database')) {
                $candidate = \dirname(__DIR__) . '/Database.php';
                if (is_file($candidate)) {
                    require_once $candidate;
                }
            }

            if (!class_exists('\\App\\Database')) {
                $this->log('debug', 'Database class not found; avatar resolvers not wired.');
                return;
            }

            /** @var \PDO $pdo */
            $pdo = \App\Database::getInstance();

            $this->setAvatarResolvers(
                function (string $chatId) use ($pdo) {
                    $stmt = $pdo->prepare('
                        SELECT avatar, item_context_json
                          FROM chats
                         WHERE source = :src AND chat_id = :id
                         LIMIT 1
                    ');
                    $stmt->execute([':src' => 'Telegram', ':id' => $chatId]);
                    $row = $stmt->fetch(\PDO::FETCH_ASSOC);
                    if (!$row) return null;

                    $avatarUrl = (string)($row['avatar'] ?? '');
                    $ctx       = json_decode((string)($row['item_context_json'] ?? ''), true);
                    if (!is_array($ctx)) $ctx = [];

                    $isDefault = isset($ctx['tg_avatar_is_default'])
                        ? (bool)$ctx['tg_avatar_is_default']
                        : ($avatarUrl === '' || (bool)preg_match('~/default\.svg$~', $avatarUrl));

                    $checkedAt = (int)($ctx['tg_avatar_checked_at'] ?? 0);

                    return [
                        'url'        => $avatarUrl,
                        'is_default' => $isDefault,
                        'checked_at' => $checkedAt,
                    ];
                },
                function (string $chatId, string $url, bool $isDefault, int $checkedAt) use ($pdo) {
                    $stmt = $pdo->prepare('
                        SELECT item_context_json
                          FROM chats
                         WHERE source = :src AND chat_id = :id
                         LIMIT 1
                    ');
                    $stmt->execute([':src' => 'Telegram', ':id' => $chatId]);
                    $row = $stmt->fetch(\PDO::FETCH_ASSOC);
                    $ctx = [];
                    if ($row && isset($row['item_context_json']) && $row['item_context_json'] !== '') {
                        $tmp = json_decode((string)$row['item_context_json'], true);
                        if (is_array($tmp)) $ctx = $tmp;
                    }

                    $ctx['tg_avatar_is_default'] = $isDefault ? true : false;
                    $ctx['tg_avatar_checked_at'] = (int)$checkedAt;

                    $stmtU = $pdo->prepare('
                        UPDATE chats
                           SET avatar = :url,
                               item_context_json = :ctx
                         WHERE source = :src AND chat_id = :id
                    ');
                    $stmtU->execute([
                        ':url' => $url,
                        ':ctx' => json_encode($ctx, JSON_UNESCAPED_UNICODE),
                        ':src' => 'Telegram',
                        ':id'  => $chatId,
                    ]);
                },
                $this->avatarTtlSeconds
            );

            $this->log('debug', 'Avatar resolvers wired to database.');
        } catch (\Throwable $e) {
            $this->log('warning', 'Failed to wire avatar resolvers', ['error' => $e->getMessage()]);
        }
    }

    /* ============================== ИНТЕРФЕЙС КЛИЕНТА ============================== */

    public function getSource(): string
    {
        return 'Telegram';
    }

    /** @return array<string,mixed> */
    public function getOwnProfile(): array
    {
        $json = $this->httpPost('/rest.php', ['action' => 'whoami']);
        $data = is_array($json['data'] ?? null) ? $json['data'] : [];
        if (!($json['success'] ?? false) || !$data) {
            throw new \RuntimeException((string)($json['message'] ?? 'Telegram не вернул профиль текущего аккаунта.'));
        }
        $id = trim((string)($data['account_id'] ?? $data['id'] ?? ''));
        $first = trim((string)($data['first_name'] ?? ''));
        $last = trim((string)($data['last_name'] ?? ''));
        $username = ltrim(trim((string)($data['username'] ?? '')), '@');
        $name = trim($first . ' ' . $last);
        if ($name === '') $name = $username !== '' ? '@' . $username : 'Мой Telegram';
        $rawAvatar = trim((string)($data['avatarUrl'] ?? $data['avatar'] ?? ''));
        $avatar = preg_match('~^/?uploads/avatar/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp|gif|avif)$~i', $rawAvatar)
            ? ltrim($rawAvatar, '/') : '';
        $fields = [];
        if ($id !== '') $fields[] = ['label' => 'ID', 'value' => $id];
        if ($username !== '') $fields[] = ['label' => 'Username', 'value' => '@' . $username];
        if (($phone = trim((string)($data['phone'] ?? ''))) !== '') $fields[] = ['label' => 'Телефон', 'value' => '+' . ltrim($phone, '+')];
        return [
            'id' => $id,
            'account_id' => $id,
            'name' => $name,
            'subtitle' => $username !== '' ? '@' . $username : 'Мой аккаунт Telegram',
            'avatar' => $avatar,
            'fields' => $fields,
        ];
    }

    /** Public fields for the common contact-details modal. */
    public function getUserProfile(string $userId): array
    {
        if (!preg_match('/^[1-9][0-9]{0,19}$/D', $userId)) throw new \InvalidArgumentException('Invalid Telegram user');
        return ['id' => $userId] + $this->getContactProfile($userId);
    }

    public function getContactProfile(string $chatId): array
    {
        $isGroupOrChannel = str_starts_with($chatId, '-');
        $resp = $this->httpPost('/rest.php', [
            'action' => $isGroupOrChannel ? 'getPeerFull' : 'getUserFull',
            'peer' => $chatId,
        ], $isGroupOrChannel ? 12.0 : null);
        if (empty($resp['success'])) throw new \RuntimeException('Telegram profile unavailable');
        $data = is_array($resp['data'] ?? null) ? $resp['data'] : [];
        if ($isGroupOrChannel) {
            $peer = is_array($data['peer'] ?? null) ? $data['peer'] : [];
            $kind = ($peer['kind'] ?? '') === 'channel' ? 'channel' : 'group';
            $username = ltrim(trim((string)($peer['username'] ?? '')), '@');
            $name = trim((string)($peer['title'] ?? ''));
            $fields = [];
            if ($username !== '') {
                $publicUrl = 'https://t.me/' . $username;
                $fields[] = ['label' => 'Имя пользователя', 'value' => '@' . $username];
                $fields[] = ['label' => 'Публичная ссылка', 'value' => $publicUrl, 'href' => $publicUrl];
            }
            $about = trim((string)($peer['about'] ?? ''));
            if ($about !== '') $fields[] = ['label' => 'Описание', 'value' => $about];
            if (isset($peer['participants_count']) && is_numeric($peer['participants_count'])) {
                $count = max(0, (int)$peer['participants_count']);
                $fields[] = [
                    'label' => $kind === 'channel' ? 'Подписчиков' : 'Участников',
                    'value' => number_format($count, 0, '.', ' '),
                ];
            }
            return [
                'name' => $name,
                'username' => $username !== '' ? '@' . $username : '',
                'subtitle' => $kind === 'channel' ? 'Канал Telegram' : 'Группа Telegram',
                'kind' => $kind,
                'fields' => $fields,
            ];
        }
        $user = is_array($data['user'] ?? null) ? $data['user'] : [];
        $username = ltrim(trim((string)($user['username'] ?? '')), '@');
        $fields = [];
        if ($username !== '') $fields[] = ['label' => 'Имя пользователя', 'value' => '@' . $username];
        if (!empty($user['phone'])) $fields[] = ['label' => 'Телефон', 'value' => $user['phone']];
        if (isset($user['is_bot'])) $fields[] = ['label' => 'Тип', 'value' => $user['is_bot'] ? 'Бот' : 'Пользователь'];
        if (!empty($data['about'])) $fields[] = ['label' => 'О себе', 'value' => (string)$data['about']];
        if (isset($data['common_chats_count'])) $fields[] = ['label' => 'Общих чатов', 'value' => (string)$data['common_chats_count']];
        $status = is_array($user['status'] ?? null) ? $user['status'] : [];
        $displayName = trim((string)($user['first_name'] ?? '') . ' ' . (string)($user['last_name'] ?? ''));
        if ($displayName === '') $displayName = $username !== '' ? '@' . $username : '';
        return [
            'name' => $displayName,
            'username' => $username !== '' ? '@' . $username : '',
            'subtitle' => !empty($status['online']) ? 'в сети' : 'Telegram',
            'fields' => $fields,
        ];
    }

    public function getStatus(): array
    {
        $t0 = microtime(true);
        try {
            $data = $this->restGet('diag');
            $ok = is_array($data) && (isset($data['count']) || isset($data['sessionPath']));
            $res = [
                'connected' => $ok,
                'info'      => $data,
                'ms'        => (int)((microtime(true) - $t0) * 1000),
            ];
            $this->log('info', 'Telegram status', ['connected' => $ok, 'ms' => $res['ms']]);
            return $res;
        } catch (\Throwable $e) {
            $this->log('error', 'Telegram status exception', ['error' => $e->getMessage()]);
            return ['connected' => false, 'info' => ['error' => $e->getMessage()]];
        }
    }

    /* ============================== ЧАТЫ ============================== */

    public function getChats(bool $hydratePreviews = true): array
    {
        $this->log('info', 'Fetching Telegram chats including groups, channels and archive');

        // getRecentChats is folder-0 only in Telegram's MTProto API.  The
        // full dialog iterator includes archive folder 1 and peer types whose
        // id is negative (groups and channels), so it is the canonical list.
        $rows = $this->restGet('getChatsFull', [
            'humansOnly'  => 0,
            'orderByLast' => 1,
            'folder'      => 'all',
            'limit'       => max(200, (int)CHATS_FETCH_LIMIT),
        ]);

        // Keep the lightweight route only as a read-only fallback for a
        // temporarily unavailable full iterator. It never replaces a valid
        // all-folders response.
        if (!is_array($rows) || empty($rows)) {
            // A full iterator can exceed the foreground REST budget on a
            // large account. Do not turn that temporary timeout into an empty
            // sidebar: the compact dialog page still contains current groups,
            // channels and archive rows, and is a read-only fallback.
            $this->log('warning', $this->lastRestGetTimedOut
                ? 'getChatsFull timed out; falling back to getRecentChats'
                : 'getChatsFull returned empty; falling back to getRecentChats');
            $rows = $this->restGet('getRecentChats', [
                'humansOnly' => 0,
                'limit'      => max(100, (int)CHATS_FETCH_LIMIT),
            ]);
        }

        if (!is_array($rows)) {
            $this->log('warning', 'Telegram chats response is not an array; returning empty list');
            return [];
        }

        // Снимок исходных данных (частичный)
        $this->log('info', 'Raw chats sample (first items)', [
            'items_preview' => $this->jsonSnippet(json_encode(array_slice($rows, 0, 5), JSON_UNESCAPED_UNICODE))
        ]);

        // Подсчёты и причины исключений
        $counters = [
            'total_rows'         => count($rows),
            'accepted'           => 0,
            'accepted_humans'    => 0,
            'accepted_bots'      => 0,
            'accepted_archived'  => 0,
            'accepted_active'    => 0,
            'dropped_empty_id'   => 0,
            'accepted_groups'     => 0,
            'accepted_channels'   => 0,
            'dropped_other'      => 0,
        ];

        $out = [];
        $needsHydrate = [];

        // Мягкая эвристика для флагов
        $isTrue = static function ($v): bool {
            if (is_bool($v)) return $v;
            if (is_int($v))  return $v > 0;
            if (is_string($v)) return in_array(strtolower($v), ['1','true','yes','y'], true);
            return false;
        };

        $selfId = trim((string)@file_get_contents(dirname(__DIR__, 2) . '/runtime/telegram/self_id'));
        foreach ($rows as $idx => $r) {
            if (!is_array($r)) { $counters['dropped_other']++; continue; }

            $chatId = (string)($r['id'] ?? '');
            if ($chatId === '') {
                $counters['dropped_empty_id']++;
                $this->log('debug', 'Chat dropped: empty id', ['row_index' => $idx]);
                continue;
            }

            // Negative IDs are valid Telegram group/channel peers. Keep them
            // as first-class chats; only the adapter knows how to address them.

            // Флаги "бот/человек"
            $isBot = false;
            foreach (['is_bot','isBot','bot','isBOT'] as $k) {
                if (array_key_exists($k, $r)) { $isBot = $isTrue($r[$k]); break; }
            }
            if (!$isBot && isset($r['type']) && is_string($r['type'])) {
                $isBot = strtolower($r['type']) === 'bot';
            }

            // Флаг "архив"
            $isArchived = false;
            foreach (['archived','is_archived','isArchived','inArchive'] as $k) {
                if (array_key_exists($k, $r)) { $isArchived = $isTrue($r[$k]); break; }
            }

            $rawKind = strtolower(trim((string)($r['chat_kind'] ?? $r['type'] ?? '')));
            $chatKind = in_array($rawKind, ['group', 'channel', 'bot', 'contact'], true)
                ? $rawKind
                : (str_starts_with($chatId, '-100') ? 'channel' : (str_starts_with($chatId, '-') ? 'group' : 'contact'));
            $folderId = (int)($r['folder_id'] ?? ($isArchived ? 1 : 0));

            $username = ltrim(trim((string)($r['username'] ?? '')), '@');
            // Prefer Telegram's public nick to a generic numeric chat label.
            $name = trim((string)($r['name'] ?? ''));
            if ($name === '' || preg_match('/^Telegram -?\d+$/', $name)) {
                $name = $username !== '' ? '@' . $username : 'Чат Telegram';
            }
            $isSavedMessages = $selfId !== '' && $chatId === $selfId;
            if ($isSavedMessages) $name = 'Сохранённые';
            $text  = (string)($r['last_message_text'] ?? '');
            $type  = (string)($r['last_message_type'] ?? '');
            $ts    = (int)   ($r['last_message_time'] ?? 0);
            $isOut = (bool)  ($r['last_message_is_out']  ?? false);
            $isRd  = (int)   ($r['last_message_is_read'] ?? 0);

            $shouldHydrate = ($ts === 0 || $text === '');
            if ($shouldHydrate && class_exists('\\App\\Database')) {
                try {
                    $pdoHyd = \App\Database::getInstance();
                    $stmtHyd = $pdoHyd->prepare('SELECT item_context_json FROM chats WHERE source = :src AND chat_id = :id LIMIT 1');
                    $stmtHyd->execute([':src' => 'Telegram', ':id' => $chatId]);
                    $rowHyd = $stmtHyd->fetch(\PDO::FETCH_ASSOC) ?: [];
                    $ctxHyd = [];
                    if (!empty($rowHyd['item_context_json'])) {
                        $tmpHyd = json_decode((string)$rowHyd['item_context_json'], true);
                        if (is_array($tmpHyd)) $ctxHyd = $tmpHyd;
                    }
                    $lastHydrateAt = (int)($ctxHyd['tg_last_hydrate_at'] ?? 0);
                    if ($lastHydrateAt > 0 && (time() - $lastHydrateAt) < 300) {
                        $shouldHydrate = false;
                    }
                } catch (\Throwable $e) {
                    // fall through and allow hydration; cache lookup is best-effort only
                }
            }
            if ($shouldHydrate) $needsHydrate[$chatId] = true;

            $unreadCount = (int)($r['unread_count'] ?? 0);
            $itemContext = [];
            if (class_exists('\\App\\Database')) {
                try {
                    $pdoCtx = \App\Database::getInstance();
                    $stmtCtx = $pdoCtx->prepare('SELECT item_context_json FROM chats WHERE source = :src AND chat_id = :id LIMIT 1');
                    $stmtCtx->execute([':src' => 'Telegram', ':id' => $chatId]);
                    $rowCtx = $stmtCtx->fetch(\PDO::FETCH_ASSOC) ?: [];
                    if (!empty($rowCtx['item_context_json'])) {
                        $tmpCtx = json_decode((string)$rowCtx['item_context_json'], true);
                        if (is_array($tmpCtx)) $itemContext = $tmpCtx;
                    }
                } catch (\Throwable $e) {
                    $itemContext = [];
                }
            }

            // A default avatar may have been cached before Telegram resolved
            // this peer.  Retry only when the REST entity says a photo exists,
            // and no more often than the normal avatar TTL.
            $dataUri = isset($r['avatarUrl']) && is_string($r['avatarUrl']) ? $r['avatarUrl'] : null;
            $hasAvatar = $isTrue($r['avatar_available'] ?? false);
            $lastAvatarProbe = (int)($itemContext['telegram_avatar_probe_at'] ?? 0);
            $probeAvatar = $hasAvatar && (time() - $lastAvatarProbe >= $this->avatarTtlSeconds);
            $avatarPath = $this->ensureAvatarCached($chatId, $dataUri, $probeAvatar);
            if ($probeAvatar) $itemContext['telegram_avatar_probe_at'] = time();

            // These values are useful to both the unified list and the
            // server's persistent chat row. Preserve existing context because
            // it also contains receipt and avatar-cache data.
            $itemContext['telegram_saved_messages'] = $isSavedMessages;
            $itemContext['telegram_chat_kind'] = $chatKind;
            $itemContext['telegram_folder_id'] = $folderId;
            $itemContext['telegram_archived'] = $isArchived;
            if (is_array($r['folders'] ?? null)) $itemContext['telegram_folders'] = $r['folders'];
            foreach (['last_message_is_service', 'last_message_service_event', 'last_message_event_style'] as $serviceField) {
                if (array_key_exists($serviceField, $r)) $itemContext[$serviceField] = $r[$serviceField];
            }

            // Отображаемый текст
            $displayText = $text;
            if ($displayText === '') {
                if ($type !== '') {
                    $displayText = $this->mapTypeToPlaceholder($type);
                } elseif ($ts === 0) {
                    $displayText = '[Нет сообщений]';
                } else {
                    $displayText = '[Пусто]';
                }
            }

            $out[$chatId] = [
                'id'                => $chatId,
                'source'            => $this->getSource(),
                'name'              => $name,
                'avatar'            => $avatarPath,
                'last_message_text' => $displayText,
                'last_message_time' => $ts,
                'direction'         => $isOut ? 'out' : 'in',
                'is_read_by_peer'   => $isOut ? (bool)$isRd : true,
                'is_unread'         => $unreadCount > 0,
                'item_context'      => $itemContext,
                'last_message_is_service' => !empty($r['last_message_is_service']),
                'last_message_service_event' => (string)($r['last_message_service_event'] ?? ''),
                'last_message_event_style' => (string)($r['last_message_event_style'] ?? ''),
                // диагностические поля (не ломают БД, так как в упрощённом виде попадают выше по стэку)
                'debug_is_bot'      => $isBot,
                'debug_chat_kind'   => $chatKind,
                'debug_is_archived' => $isArchived,
                'debug_unread_cnt'  => $unreadCount,
            ];

            $counters['accepted']++;
            if ($chatKind === 'group') $counters['accepted_groups']++;
            if ($chatKind === 'channel') $counters['accepted_channels']++;
            $isBot ? $counters['accepted_bots']++ : $counters['accepted_humans']++;
            $isArchived ? $counters['accepted_archived']++ : $counters['accepted_active']++;

            $this->log('debug', 'Chat accepted', [
                'chat_id'     => $chatId,
                'name'        => $name,
                'is_bot'      => $isBot,
                'is_archived' => $isArchived,
                'unread'      => $unreadCount,
                'last_ts'     => $ts,
            ]);
        }

        // Гидратация (добираем мету последнего сообщения там, где было пусто)
        // Hydration only decorates incomplete sidebar rows. Scheduled sync
        // and recovery must not hold the serialized Telegram client for it.
        $hydrateList = $hydratePreviews ? array_keys($needsHydrate) : [];
        // This work only improves sidebar previews. Never let a long queue
        // of incomplete dialog metadata monopolize MadelineProto while a
        // person is opening an actual chat or its attachment.
        $hydrateStartedAt = microtime(true);
        $hydrateBudgetSeconds = 5.0;
        $hydratedCount = 0;
        if (!empty($hydrateList)) {
            $this->log('info', 'Hydrating chats with missing last message meta', ['count' => count($hydrateList)]);
        }

        foreach ($hydrateList as $chatId) {
            if ((microtime(true) - $hydrateStartedAt) >= $hydrateBudgetSeconds) {
                $this->log('info', 'Telegram sidebar hydration budget exhausted', [
                    'processed' => $hydratedCount,
                    'remaining' => max(0, count($hydrateList) - $hydratedCount),
                    'budget_seconds' => $hydrateBudgetSeconds,
                ]);
                break;
            }
            $hydratedCount++;
            try {
                $meta = $this->fetchLastMessageMeta($chatId);
            } catch (\Throwable $exception) {
                // A preview miss is not a sync failure and must never keep
                // the next interactive history page behind a retry storm.
                $this->log('debug', 'Telegram sidebar hydration skipped', [
                    'chat_id' => $chatId,
                    'error' => $exception->getMessage(),
                ]);
                continue;
            }
            $hydrateAt = time();
            if ($meta !== null) {
                $textHyd = (string)($meta['text'] ?? '');
                $typeHyd = (string)($meta['type'] ?? '');

                if ($textHyd === '' && $typeHyd !== '') {
                    $textHyd = $this->mapTypeToPlaceholder($typeHyd);
                } elseif ($textHyd === '' && ((int)($meta['ts'] ?? 0)) === 0) {
                    $textHyd = '[Нет сообщений]';
                } elseif ($textHyd === '') {
                    $textHyd = '[Пусто]';
                }

                $out[$chatId]['last_message_text'] = $textHyd;
                $out[$chatId]['last_message_time'] = (int)($meta['ts'] ?? 0);
                $out[$chatId]['direction']         = (string)($meta['direction'] ?? 'in');
                $out[$chatId]['is_read_by_peer']   = (bool)($meta['is_read_by_peer'] ?? false);

                $this->log('debug', 'Hydrated chat meta', [
                    'chat_id' => $chatId,
                    'text'    => $textHyd,
                    'ts'      => $out[$chatId]['last_message_time'],
                ]);
            }

            if (isset($out[$chatId]) && is_array($out[$chatId]['item_context'] ?? null)) {
                $out[$chatId]['item_context']['tg_last_hydrate_at'] = $hydrateAt;
            }

            if (class_exists('\\App\\Database')) {
                try {
                    $pdoHyd = \App\Database::getInstance();
                    $stmtHyd = $pdoHyd->prepare('SELECT item_context_json FROM chats WHERE source = :src AND chat_id = :id LIMIT 1');
                    $stmtHyd->execute([':src' => 'Telegram', ':id' => $chatId]);
                    $rowHyd = $stmtHyd->fetch(\PDO::FETCH_ASSOC) ?: [];
                    $ctxHyd = [];
                    if (!empty($rowHyd['item_context_json'])) {
                        $tmpHyd = json_decode((string)$rowHyd['item_context_json'], true);
                        if (is_array($tmpHyd)) $ctxHyd = $tmpHyd;
                    }
                    $ctxHyd['tg_last_hydrate_at'] = $hydrateAt;
                    $stmtUpd = $pdoHyd->prepare('UPDATE chats SET item_context_json = :ctx WHERE source = :src AND chat_id = :id');
                    $stmtUpd->execute([
                        ':ctx' => json_encode($ctxHyd, JSON_UNESCAPED_UNICODE),
                        ':src' => 'Telegram',
                        ':id'  => $chatId,
                    ]);
                } catch (\Throwable $e) {
                    // cache is best-effort only
                }
            }
        }

        // Сортируем по времени последнего сообщения
        $rowsSorted = array_values($out);
        usort($rowsSorted, fn($a, $b) => $b['last_message_time'] <=> $a['last_message_time']);

        $this->log('info', 'Telegram chats selection summary', $counters);

        // Дополнительный диагноз: почему "берутся только боты"
        if ($counters['accepted_humans'] === 0 && $counters['accepted_bots'] > 0) {
            $this->log('warning', 'Only bot chats appear to be selected. Check server filters and data.', [
                'hint' => 'Проверьте, не возвращает ли REST только ботов, и не фильтруются ли пользователи по humansOnly / типам.',
            ]);
        }

        return $rowsSorted;
    }

    /** Scheduled list sync must not contend with an opened Telegram chat. */
    public function getSyncChats(): array
    {
        return $this->getChats(false);
    }

    /** Recovery discovers peers without optional preview history reads. */
    public function getRecoveryChats(): array
    {
        return $this->getChats(false);
    }

    /* ============================== ИСТОРИЯ ============================== */

    /**
     * A Telegram reply always refers to the provider's positive decimal
     * message id.  Local database ids and optimistic UI ids must never cross
     * this boundary.
     */
    private function telegramNativeMessageId(mixed $value): ?string
    {
        if (!is_string($value) && !is_int($value)) {
            return null;
        }

        $id = (string)$value;
        return preg_match('/^[1-9][0-9]{0,18}$/D', $id) ? $id : null;
    }

    /**
     * Convert the several Telegram REST shapes into the shared quote shape.
     * Most history responses contain only the native id; richer data is
     * filled from the current page by hydrateTelegramReplyReferences().
     */
    private function telegramReplyReference(array $message): ?array
    {
        $embedded = null;
        foreach (['reply_to', 'replyTo', 'reply_to_message'] as $key) {
            if (is_array($message[$key] ?? null)) {
                $embedded = $message[$key];
                break;
            }
        }

        $candidates = [
            $message['reply_to_message_id'] ?? null,
            $message['reply_to_msg_id'] ?? null,
            $embedded['reply_to_message_id'] ?? null,
            $embedded['reply_to_msg_id'] ?? null,
            $embedded['message_id'] ?? null,
            $embedded['id'] ?? null,
        ];
        $id = null;
        foreach ($candidates as $candidate) {
            $id = $this->telegramNativeMessageId($candidate);
            if ($id !== null) {
                break;
            }
        }
        if ($id === null) {
            return null;
        }

        $content = is_array($embedded['content'] ?? null) ? $embedded['content'] : [];
        $text = trim((string)($embedded['text'] ?? $embedded['message'] ?? $embedded['caption']
            ?? $content['text'] ?? $content['caption'] ?? ''));

        $author = trim((string)($embedded['author_name'] ?? $embedded['sender_name']
            ?? $embedded['from_name'] ?? $embedded['sender'] ?? ''));
        if ($author === '' && is_array($embedded) && array_key_exists('out', $embedded)) {
            $author = !empty($embedded['out']) ? 'Вы' : 'Собеседник';
        }

        return ['id' => $id, 'text' => $text, 'author' => $author];
    }

    /** @param list<array<string,mixed>> $items @return list<array<string,mixed>> */
    private function hydrateTelegramReplyReferences(array $items): array
    {
        $known = [];
        foreach ($items as $item) {
            $id = $this->telegramNativeMessageId($item['id'] ?? null);
            if ($id === null) {
                continue;
            }

            $text = trim((string)($item['text'] ?? ''));
            if ($text === '' && !empty($item['attachments'])) {
                $text = '[Вложение]';
            }
            $known[$id] = [
                'text' => $text,
                'author' => (($item['direction'] ?? '') === 'out') ? 'Вы' : (trim((string)($item['sender_name'] ?? '')) ?: 'Сообщение'),
            ];
        }

        foreach ($items as &$item) {
            if (!is_array($item['reply_to'] ?? null)) {
                continue;
            }
            $replyId = $this->telegramNativeMessageId($item['reply_to']['id'] ?? null);
            if ($replyId === null) {
                unset($item['reply_to'], $item['reply_to_message_id']);
                continue;
            }

            $item['reply_to']['id'] = $replyId;
            $item['reply_to_message_id'] = $replyId;
            $reference = $known[$replyId] ?? null;
            if ($reference !== null) {
                if (trim((string)($item['reply_to']['text'] ?? '')) === '') {
                    $item['reply_to']['text'] = $reference['text'];
                }
                if (in_array(trim((string)($item['reply_to']['author'] ?? '')), ['', 'Собеседник', 'Сообщение'], true)) {
                    $item['reply_to']['author'] = $reference['author'];
                }
            }
        }
        unset($item);

        return $items;
    }

    public function getDiscussion(string $chatId, string $messageId, string $before = ''): array
    {
        // Resolving a channel discussion performs two Telegram reads. Keep
        // this bounded but do not apply the short media/profile timeout: an
        // eight-second cutoff made healthy comment threads look unavailable.
        $result = $this->httpPost('/rest.php', ['action' => 'getDiscussion', 'chatId' => $chatId, 'messageId' => $messageId, 'before' => $before], 18.0);
        if (empty($result['success'])) throw new \RuntimeException('Discussion unavailable');
        return is_array($result['data'] ?? null) ? $result['data'] : $result;
    }

    public function getChatHistory(string $chatId, $startMessageId = 0, ?float $timeout = null): array
    {
        $payload = [
            'action'   => 'getChatHistory',
            'chatId'   => $chatId,
            'offsetId' => (int)$startMessageId,
        ];
        $this->log('info', 'Fetching chat history', ['chat_id' => $chatId, 'offsetId' => (int)$startMessageId]);

        // An interactive page can be queued briefly behind a foreground
        // Madeline request. It deserves a larger bounded wait than optional
        // sidebar enrichment, otherwise a healthy provider looks like a 500.
        $json = $this->httpPost('/rest.php', $payload, $timeout ?? 25.0);

        if (!($json['success'] ?? false)) {
            $this->log('warning', 'getChatHistory returned unsuccessful response', [
                'chat_id' => $chatId,
                'error'   => $json['message'] ?? 'unknown',
                'sample'  => $this->jsonSnippet(json_encode($json, JSON_UNESCAPED_UNICODE)),
            ]);
            throw new \RuntimeException('Telegram history unavailable');
        }

        // Telegram is deployed in two compatible forms in this project:
        // {success, data:{items, nextCursor}} and {success, items, nextCursor}.
        // Always unwrap the envelope before looking for the page payload.
        $page = is_array($json['data'] ?? null) ? $json['data'] : $json;
        if (is_array($page['items'] ?? null)) {
            $raw = $page['items'];
        } elseif (is_array($page['messages']['items'] ?? null)) {
            $raw = $page['messages']['items'];
        } elseif ($page === [] || array_keys($page) === range(0, count($page) - 1)) {
            // Older helpers returned the message list directly.
            $raw = $page;
        } else {
            $raw = [];
        }

        $items = [];
        foreach ($raw as $m) {
            if (!is_array($m)) continue;

            $mid = (string)($m['id'] ?? '');
            if ($mid === '') continue;

            $type = (string)($m['type'] ?? 'text');
            $text = (string)($m['message'] ?? $m['text'] ?? '');
            $ts   = (int)   ($m['date'] ?? $m['timestamp'] ?? 0);

            $serverFilename = isset($m['filename']) && is_string($m['filename']) ? $m['filename'] : null;
            $serverMime     = isset($m['mime'])     && is_string($m['mime'])     ? $m['mime']     : null;

            // Current Telegram REST already returns a normalized attachment
            // contract.  Do not discard it merely because it has no legacy
            // `type` field; doing so turns document-only messages into empty
            // bubbles in the UI.
            $restAttachments = is_array($m['attachments'] ?? null) ? $m['attachments'] : [];
            $attachments = $restAttachments !== []
                ? $this->attachmentsFromRest($restAttachments, $chatId, $mid)
                : $this->attachmentsFromType($type, $chatId, $mid, $text, $serverFilename, $serverMime);

            if (!empty($attachments) && preg_match('/^\[(?:media|photo|image|video|audio|voice|document|sticker|webpage|location|empty)\]$/i', trim($text))) {
                $text = '';
            }

            $isService = ($m['presentation'] ?? '') === 'event_pill' || !empty($m['is_service']) || strtolower($type) === 'service';
            $msgType = $isService ? 'service' : (!empty($attachments) ? ($attachments[0]['type'] ?? 'document') : 'text');
            $mediaUrl = (!empty($attachments) && in_array($attachments[0]['type'], ['photo', 'video', 'audio', 'document'], true))
                ? $attachments[0]['url']
                : null;

            $isOut  = array_key_exists('out', $m) ? (bool)$m['out'] : (($m['direction'] ?? '') === 'out');
            $isRead = (int) ($m['is_read'] ?? 0);

            $replyReference = $this->telegramReplyReference($m);
            $item = [
                'id'          => $mid,
                'chat_id'     => $chatId,
                'text'        => $text,
                'timestamp'   => $ts,
                'direction'   => $isOut ? 'out' : 'in',
                'type'        => $msgType,
                'attachments' => $attachments,
                'files'       => $attachments,
                'media'       => $mediaUrl,
                'is_read'     => $isRead,
                'ack' => $isOut ? ($isRead ? 3 : 1) : 0,
                'send_state' => $isOut ? ($isRead ? 'read' : 'accepted') : '',
                'sender_id' => (string)($m['sender_id'] ?? ''),
                'sender_name' => mb_substr(trim((string)($m['sender_name'] ?? '')), 0, 160),
                'sender_username' => (string)($m['sender_username'] ?? ''),
                'sender_avatar' => (string)($m['sender_avatar'] ?? ''),
                'chat_kind' => $m['chat_kind'] ?? (str_starts_with($chatId, '-') ? 'group' : 'contact'),
                'discussion' => is_array($m['discussion'] ?? null) ? $m['discussion'] : null,
                'reply_to_message_id' => null,
            ];
            // Keep native grouping and the authoritative reaction snapshot.
            // Missing fields stay missing; an explicit empty array clears reactions.
            foreach (['media_group_id', 'media_group_kind', 'media_group'] as $field) {
                if (array_key_exists($field, $m)) $item[$field] = $m[$field];
            }
            if (is_array($m['reactions'] ?? null)) $item['reactions'] = $m['reactions'];
            if ($isService) {
                $item['is_service'] = true;
                $item['presentation'] = 'event_pill';
                $item['service_event'] = (string)($m['service_event'] ?? 'notice');
                $item['event_style'] = (string)($m['event_style'] ?? 'notice');
            }
            if ($replyReference !== null) {
                $item['reply_to_message_id'] = $replyReference['id'];
                $item['reply_to'] = $replyReference;
            }
            $items[] = $item;
        }

        $items = $this->hydrateTelegramReplyReferences($items);

        $nextCursor = $page['nextCursor']
            ?? $page['next_cursor']
            ?? $page['messages']['nextCursor']
            ?? $page['messages']['next_cursor']
            ?? null;
        if ($nextCursor !== null && $nextCursor !== '') {
            $nextCursor = (string)$nextCursor;
        } else {
            // A full legacy page has no explicit cursor. Telegram returns it
            // newest first, so the final mapped item is the safe "before" id.
            $pageSize = defined('MESSAGES_FETCH_LIMIT') ? max(1, (int)MESSAGES_FETCH_LIMIT) : 30;
            if (count($items) >= $pageSize) {
                $last = end($items);
                $candidate = is_array($last) ? (string)($last['id'] ?? '') : '';
                $nextCursor = $candidate !== '' ? $candidate : null;
            } else {
                $nextCursor = null;
            }
        }

        $this->log('info', 'Chat history fetched', ['chat_id' => $chatId, 'items' => count($items), 'nextCursor' => $nextCursor]);
        return ['items' => $items, 'nextCursor' => $nextCursor, 'prevCursor' => $nextCursor];
    }

    /**
     * Background recovery is useful only when it does not hold the single
     * MadelineProto client ahead of a person opening a dialog. Keep its
     * provider read short; HistoryRecovery has a separate sweep budget.
     */
    public function getRecoveryHistory(string $chatId, $startMessageId = 0): array
    {
        return $this->getChatHistory($chatId, $startMessageId, 3.0);
    }

    /* ============================== ОТПРАВКА ============================== */

    public function sendMessageByTarget(string $target, string $message): array
    {
        $payload = ['action' => 'sendMessageByTarget', 'target' => $target, 'message' => $message];
        $this->log('info', 'Sending message by target', ['target' => $target]);

        $json = $this->httpPost('/rest.php', $payload);

        if (!($json['success'] ?? false)) {
            $this->log('warning', 'sendMessageByTarget failed', [
                'target' => $target,
                'error'  => $json['message'] ?? 'unknown',
                'sample' => $this->jsonSnippet(json_encode($json, JSON_UNESCAPED_UNICODE)),
            ]);
            return ['success' => false, 'error' => $json['message'] ?? 'unknown'];
        }
        return ['success' => true, 'data' => $json['data'] ?? null];
    }

    public function sendMessageByPhone(string $phone, string $message): array
    {
        $payload = ['action' => 'sendMessageByPhone', 'phone' => $phone, 'message' => $message];
        $this->log('info', 'Sending message by phone', ['phone' => $phone]);

        $json = $this->httpPost('/rest.php', $payload);

        if (!($json['success'] ?? false)) {
            $this->log('warning', 'sendMessageByPhone failed', [
                'phone'  => $phone,
                'error'  => $json['message'] ?? 'unknown',
                'sample' => $this->jsonSnippet(json_encode($json, JSON_UNESCAPED_UNICODE)),
            ]);
            return ['success' => false, 'error' => $json['message'] ?? 'unknown'];
        }
        return ['success' => true, 'data' => $json['data'] ?? null];
    }

    public function sendMessage(string $chatId, string $message, ?array $file, ?string $replyToMessageId = null): array
    {
        $replyToId = $this->telegramNativeMessageId($replyToMessageId);
        if ($replyToMessageId !== null && $replyToMessageId !== '' && $replyToId === null) {
            return SendResult::rejected('invalid_reply_target', 'Некорректный идентификатор сообщения Telegram для ответа.');
        }

        $hasFile = is_array($file) && $file !== [];
        if ($hasFile && $replyToId !== null) {
            // The active REST endpoint cannot attach reply metadata to media.
            // Reject explicitly instead of accepting a text-only substitute.
            return SendResult::rejected('telegram_reply_attachment_unsupported', 'Telegram пока не подтвердил отправку вложения как ответа на сообщение.');
        }
        $payload = ['action' => 'sendMessage', 'chatId' => $chatId, 'message' => $message];
        $fileAction = 'sendFile';
        $filePrepared = !$hasFile;
        $multipartFile = null;

        // Файл (несколько форматов входа)
        if ($hasFile) {
            try {
                $sendAsFile = !empty($file['send_as_file']);
                if (!empty($file['tmp_name']) && is_string($file['tmp_name']) && is_file($file['tmp_name']) && is_readable($file['tmp_name'])) {
                    $name = (string)($file['name'] ?? basename($file['tmp_name']));
                    // Do not inflate browser uploads into JSON/base64. Apart
                    // from the extra memory, PHP applies post_max_size before
                    // the Telegram REST handler can decode the JSON payload.
                    $payload = [
                        'action'  => $fileAction,
                        'chatId'  => $chatId,
                        'caption' => $message,
                    ];
                    if ($sendAsFile) $payload['send_as_file'] = '1';
                    $multipartFile = [
                        'path' => (string)$file['tmp_name'],
                        'name' => $name,
                        'mime' => (string)($file['type'] ?? mime_content_type((string)$file['tmp_name']) ?: 'application/octet-stream'),
                    ];
                    $filePrepared = true;
                } elseif (!empty($file['name']) && !empty($file['base64']) && is_string($file['base64'])) {
                    $payload = [
                        'action'  => $fileAction,
                        'chatId'  => $chatId,
                        'file'    => ['name' => (string)$file['name'], 'base64' => (string)$file['base64']],
                        'caption' => $message,
                    ];
                    $filePrepared = true;
                } elseif (!empty($file['path']) && is_string($file['path']) && is_readable($file['path'])) {
                    $path = (string)$file['path'];
                    if ($replyToId !== null) {
                        $bin = file_get_contents($path);
                        if ($bin !== false) {
                            $payload = [
                                'action'  => 'sendMessage',
                                'chatId'  => $chatId,
                                'file'    => ['name' => (string)($file['name'] ?? basename($path)), 'base64' => base64_encode($bin)],
                                'caption' => $message,
                            ];
                            $filePrepared = true;
                        }
                    } else {
                        $payload = [
                            'action'   => 'sendFile',
                            'chatId'   => $chatId,
                            'filePath' => $path,
                            'caption'  => $message,
                        ];
                        $filePrepared = true;
                    }
                } elseif (!empty($file['filePath']) && is_string($file['filePath']) && is_readable($file['filePath'])) {
                    $path = (string)$file['filePath'];
                    if ($replyToId !== null) {
                        $bin = file_get_contents($path);
                        if ($bin !== false) {
                            $payload = [
                                'action'  => 'sendMessage',
                                'chatId'  => $chatId,
                                'file'    => ['name' => (string)($file['name'] ?? basename($path)), 'base64' => base64_encode($bin)],
                                'caption' => $message,
                            ];
                            $filePrepared = true;
                        }
                    } else {
                        $payload = [
                            'action'   => 'sendFile',
                            'chatId'   => $chatId,
                            'filePath' => $path,
                            'caption'  => $message,
                        ];
                        $filePrepared = true;
                    }
                }
            } catch (\Throwable $e) {
                $this->log('warning', 'sendMessage file processing failed', ['error' => $e->getMessage()]);
                return SendResult::rejected('attachment_unreadable', 'Не удалось подготовить вложение для Telegram.');
            }
            if (!$filePrepared) {
                return SendResult::rejected('attachment_unreadable', 'Не удалось прочитать вложение для Telegram.');
            }
            // Keep the document preference independent of how this caller
            // supplied the file. Browser uploads use multipart, whereas
            // durable jobs use filePath and older callers can use base64.
            // All three arrive at Telegram REST through the same media
            // choice, so none may silently lose this flag.
            if ($sendAsFile) $payload['send_as_file'] = '1';
        }

        if ($replyToId !== null) {
            $payload['reply_to_message_id'] = $replyToId;
        }

        $this->log('info', 'Sending message', [
            'chat_id' => $chatId,
            'has_file' => $multipartFile !== null || isset($payload['file']) || isset($payload['filePath']),
            'is_reply' => $replyToId !== null,
        ]);

        $json = $multipartFile !== null
            ? $this->httpPostMultipart('/rest.php', $payload, $multipartFile, 120.0)
            : $this->httpPost('/rest.php', $payload);
        if (!($json['success'] ?? false)) {
            $this->log('warning', 'sendMessage failed', [
                'chat_id' => $chatId,
                'error'   => $json['message'] ?? 'unknown',
                'sample'  => $this->jsonSnippet(json_encode($json, JSON_UNESCAPED_UNICODE)),
            ]);
            $messageText = (string)($json['message'] ?? 'Telegram не принял отправку.');
            if (!empty($json['_transport_error'])) {
                return SendResult::unknown('telegram_transport_unknown', 'Не удалось получить результат Telegram. Проверьте чат перед повтором.');
            }
            return SendResult::rejected('telegram_send_rejected', $messageText);
        }
        $data = is_array($json['data'] ?? null) ? $json['data'] : [];
        $messageId = $this->telegramNativeMessageId($data['message_id'] ?? null);
        if ($messageId === null) {
            return SendResult::unknown('telegram_send_unconfirmed', 'Telegram ответил без идентификатора сообщения. Проверьте чат перед повтором.');
        }
        $this->log('info', 'Message accepted by Telegram', ['chat_id' => $chatId, 'message_id' => $messageId]);
        return SendResult::accepted($messageId);
    }

    /**
     * Send one native Telegram media group.  The REST endpoint returns every
     * accepted native id; a missing id is an unknown result, never success.
     * Files are read by the application worker and are never exposed as URLs.
     */
    public function sendMediaAlbum(string $chatId, string $message, array $files, ?string $replyToMessageId = null, ?string $operationId = null, bool $sendAsFile = false): array
    {
        if (count($files) < 2 || count($files) > 10) {
            return SendResult::rejected('telegram_album_size_invalid', 'Альбом Telegram содержит от двух до десяти файлов.');
        }
        $replyToId = $this->telegramNativeMessageId($replyToMessageId);
        if ($replyToMessageId !== null && $replyToMessageId !== '' && $replyToId === null) {
            return SendResult::rejected('invalid_reply_target', 'Некорректный идентификатор сообщения Telegram для ответа.');
        }
        $payloadFiles = [];
        $totalBytes = 0;
        foreach ($files as $index => $file) {
            $path = (string)($file['path'] ?? $file['tmp_name'] ?? '');
            $name = trim((string)($file['name'] ?? basename($path)));
            if ($path === '' || $name === '' || !is_readable($path)) {
                return SendResult::rejected('attachment_unreadable', 'Не удалось прочитать вложение для альбома Telegram.', [
                    'attachments' => [['index' => (int)$index, 'status' => 'rejected', 'code' => 'attachment_unreadable']],
                ]);
            }
            $size = @filesize($path);
            if (!is_int($size) || $size < 1) {
                return SendResult::rejected('attachment_unreadable', 'Не удалось прочитать вложение для альбома Telegram.', [
                    'attachments' => [['index' => (int)$index, 'status' => 'rejected', 'code' => 'attachment_unreadable']],
                ]);
            }
            $totalBytes += $size;
            if ($totalBytes > 50 * 1024 * 1024) {
                return SendResult::rejected('attachment_total_too_large', 'Общий размер альбома Telegram превышает 50 МБ.');
            }
            $payloadFiles[] = [
                'name' => $name,
                'mime' => (string)($file['type'] ?? $file['mime'] ?? 'application/octet-stream'),
                // API and Telegram REST live on the same private host. Keep
                // the durable job file in place rather than multiplying a
                // 50 MB album in PHP JSON/base64 memory.
                'filePath' => $path,
            ];
        }

        $albumPayload = [
            'action' => 'sendMediaAlbum',
            'chatId' => $chatId,
            'caption' => $message,
            'files' => $payloadFiles,
        ];
        if ($sendAsFile) $albumPayload['send_as_file'] = '1';
        if ($replyToId !== null) $albumPayload['reply_to_message_id'] = $replyToId;
        // A durable server job may name itself to the private Telegram REST
        // process. It is deliberately optional so ordinary adapter callers
        // cannot create or overwrite arbitrary checkpoints.
        if (is_string($operationId) && preg_match('/^job_[a-f0-9]{24}$/D', $operationId)) {
            $albumPayload['operation_id'] = $operationId;
        }
        $json = $this->httpPost('/rest.php', $albumPayload);
        if (!($json['success'] ?? false)) {
            if (!empty($json['_transport_error'])) {
                return SendResult::unknown('telegram_album_transport_unknown', 'Не удалось получить результат альбома Telegram. Проверьте чат перед повтором.');
            }
            return SendResult::rejected('telegram_album_rejected', (string)($json['message'] ?? 'Telegram не принял альбом.'));
        }
        $data = is_array($json['data'] ?? null) ? $json['data'] : [];
        $ids = [];
        foreach (is_array($data['message_ids'] ?? null) ? $data['message_ids'] : [] as $value) {
            $id = $this->telegramNativeMessageId($value);
            if ($id !== null && !in_array($id, $ids, true)) $ids[] = $id;
        }
        $items = is_array($data['items'] ?? null) ? $data['items'] : [];
        $attachments = [];
        foreach ($items as $item) {
            if (!is_array($item)) continue;
            $entry = ['index' => (int)($item['index'] ?? count($attachments))];
            $id = $this->telegramNativeMessageId($item['message_id'] ?? null);
            if ($id !== null) $entry['message_id'] = $id;
            $entry['status'] = $id !== null ? 'accepted' : 'unknown';
            $attachments[] = $entry;
        }
        if (count($ids) !== count($files)) {
            return SendResult::unknown('telegram_album_unconfirmed', 'Telegram подтвердил альбом не полностью. Проверьте чат перед повтором.', [
                'message_ids' => $ids,
                'attachments' => $attachments,
            ]);
        }
        return SendResult::accepted($ids[0], [
            'message_ids' => $ids,
            'attachments' => $attachments,
        ]);
    }

    public function sendReaction(string $chatId, string $messageId, string $reaction): array
    {
        $json = $this->httpPost('/rest.php', [
            'action' => 'reactToMessage', 'chatId' => $chatId,
            'messageId' => (int)$messageId, 'reaction' => $reaction,
        ]);
        $accepted = ($json['success'] ?? false) && (($json['data']['success'] ?? true) !== false);
        return $accepted
            ? ['success' => true, 'data' => $json['data'] ?? null]
            : ['success' => false, 'message' => $json['message'] ?? 'Telegram не принял реакцию.'];
    }

    /** Return an authoritative aggregate, or null when Telegram could not supply one. */
    public function getMessageReactions(string $chatId, string $messageId): ?array
    {
        $json = $this->httpPost('/rest.php', [
            'action' => 'getMessageReactions',
            'chatId' => $chatId,
            'messageId' => (int)$messageId,
            'detailed' => 1,
            'include_recent' => 1,
            'include_actors' => 1,
        ]);

        if (($json['success'] ?? true) === false) return null;
        $payload = is_array($json['data'] ?? null) ? $json['data'] : $json;
        if (!array_key_exists('reactionsDetailed', $payload) && !array_key_exists('reactions', $payload)) {
            return null;
        }
        $reactions = $payload['reactionsDetailed'] ?? $payload['reactions'];
        return is_array($reactions) ? $reactions : null;
    }

    /**
     * Fetch one reaction participant's photo through the already authenticated
     * Telegram REST worker. The caller receives only the server-local cache
     * path; the local bridge converts that into an opaque browser relay.
     *
     * @return array{success:bool,avatar?:string,message?:string}
     */
    public function getReactionActorAvatar(string $actorId, bool $refresh = false): array
    {
        $actorId = trim($actorId);
        if (!preg_match('/^-?[1-9][0-9]{0,18}$/D', $actorId)) {
            return ['success' => false, 'message' => 'Некорректный идентификатор участника реакции.'];
        }
        $cached = $this->getCachedAvatar($actorId);
        if ($cached !== '' && !$refresh) return ['success' => true, 'avatar' => $cached];
        $json = $this->httpPost('/rest.php', [
            'action' => 'getPeerAvatar', 'chatId' => $actorId, 'refresh' => $refresh ? 1 : 0,
        ]);
        $url = is_array($json['data'] ?? null) ? (string)($json['data']['url'] ?? '') : '';
        // getPeerAvatar owns the cache. Never expose a provider URL from an
        // unexpected response shape through the unified API.
        if (($json['success'] ?? false) && preg_match('~^/?uploads/avatar/[A-Za-z0-9._-]+\.(?:jpe?g|png|webp|gif|avif)$~i', $url)) {
            return ['success' => true, 'avatar' => ltrim($url, '/')];
        }
        // A failed refresh must never turn a usable older portrait into an
        // empty reaction avatar. The caller keeps it and retries after TTL.
        if ($cached !== '') return ['success' => true, 'avatar' => $cached, 'stale' => true];
        return ['success' => false, 'message' => (string)($json['message'] ?? 'Фото участника реакции недоступно.')];
    }

    public function deleteChatForEveryone(string $chatId, ?int $dbId = null): array
    {
        $json = $this->httpPost('/rest.php', [
            'action' => 'deleteHistory',
            'chatId' => $chatId,
            'revoke' => true
        ]);

        $ok = (bool)($json['success'] ?? false);
        $msg = (string)($json['message'] ?? '');
        $this->log($ok ? 'info' : 'warning', 'Delete chat for everyone result', [
            'chat_id' => $chatId,
            'success' => $ok,
            'message' => $msg
        ]);

        if ($ok) {
            $this->deleteLocalChatRecord($dbId, $chatId);
            return ['success' => true, 'message' => 'deleted', 'data' => $json['data'] ?? null];
        }
        return ['success' => false, 'message' => $msg ?: 'tg delete failed', 'data' => $json['data'] ?? null];
    }

    public function deleteChatForMe(string $chatId, ?int $dbId = null): array
    {
        $json = $this->httpPost('/rest.php', [
            'action'     => 'deleteHistory',
            'chatId'     => $chatId,
            'just_clear' => true
        ]);

        $ok = (bool)($json['success'] ?? false);
        $msg = (string)($json['message'] ?? '');
        $this->log($ok ? 'info' : 'warning', 'Delete chat for me result', [
            'chat_id' => $chatId,
            'success' => $ok,
            'message' => $msg
        ]);

        if ($ok) {
            $this->deleteLocalChatRecord($dbId, $chatId);
            return ['success' => true, 'message' => 'cleared', 'data' => $json['data'] ?? null];
        }
        return ['success' => false, 'message' => $msg ?: 'tg clear failed', 'data' => $json['data'] ?? null];
    }

    public function blockContact(string $chatId): array
    {
        $this->log('info', 'Blocking contact', ['chat_id' => $chatId]);
        $json = $this->httpPost('/rest.php', ['action' => 'blockContact', 'chatId' => $chatId]);
        $ok = (bool)($json['success'] ?? false);
        $this->log($ok ? 'info' : 'warning', 'Block contact result', ['chat_id' => $chatId, 'success' => $ok]);
        return ['success' => $ok];
    }

    public function deleteContactByPhone(string $phone): array
    {
        $this->log('info', 'Deleting contact by phone', ['phone' => $phone]);
        $json = $this->httpPost('/rest.php', ['action' => 'deleteContactByPhone', 'phone' => $phone]);
        $ok = (bool)($json['success'] ?? false);
        $this->log($ok ? 'info' : 'warning', 'Delete contact by phone result', ['phone' => $phone, 'success' => $ok]);
        return ['success' => $ok];
    }

    public function markAsRead(string $chatId): bool
    {
        if ($chatId === 'me') return true;
        $this->log('info', 'Mark as read', ['chat_id' => $chatId]);
        $resp = $this->httpPost('/rest.php', ['action' => 'markAsRead', 'chatId' => $chatId]);
        return (bool)($resp['success'] ?? $resp['ok'] ?? false);
    }

    /* ============================== ВСПОМОГАТЕЛЬНОЕ ============================== */

    private function deleteLocalChatRecord(?int $dbId, string $chatId): void
    {
        try {
            $pdo = \App\Database::getInstance();
            $pdo->beginTransaction();

            if ($dbId && $dbId > 0) {
                $pdo->prepare("DELETE FROM messages WHERE chat_db_id = :id")->execute([':id' => $dbId]);
                $pdo->prepare("DELETE FROM chats    WHERE id = :id")->execute([':id' => $dbId]);
            } else {
                $stmt = $pdo->prepare("SELECT id FROM chats WHERE source = 'Telegram' AND chat_id = :cid LIMIT 1");
                $stmt->execute([':cid' => $chatId]);
                if ($row = $stmt->fetch(\PDO::FETCH_ASSOC)) {
                    $id = (int)$row['id'];
                    $pdo->prepare("DELETE FROM messages WHERE chat_db_id = :id")->execute([':id' => $id]);
                    $pdo->prepare("DELETE FROM chats    WHERE id = :id")->execute([':id' => $id]);
                }
            }

            $pdo->commit();
            $this->log('info', 'Local chat record deleted', ['chat_id' => $chatId, 'db_id' => $dbId]);
        } catch (\Throwable $e) {
            try { $pdo->rollBack(); } catch (\Throwable $e2) {}
            $this->log('error', 'Local DB delete failed', ['chat_id' => $chatId, 'db_id' => $dbId, 'error' => $e->getMessage()]);
        }
    }

    private function fetchLastMessageMeta(string $chatId): ?array
    {
        // Sidebar metadata is optional; yield quickly to interactive history
        // and media reads instead of retaining the provider lock.
        $resp = $this->getChatHistory($chatId, 0, 6.0);
        $items = $resp['items'] ?? [];
        if (empty($items)) return null;
        $last = end($items);
        if (!is_array($last)) return null;

        return [
            'text'            => (string)($last['text'] ?? ''),
            'type'            => (string)($last['type'] ?? ''),
            'ts'              => (int)($last['timestamp'] ?? 0),
            'direction'       => ((string)($last['direction'] ?? 'in')) === 'out' ? 'out' : 'in',
            'is_read_by_peer' => (bool)($last['is_read'] ?? 0),
        ];
    }

    private function uploadsFsDir(): string { $root = dirname(__DIR__, 2); return $root . '/uploads/avatar'; }

    private function uploadsWebPrefix(): string { return 'uploads/avatar'; }

    private function getCachedAvatar(string $chatId): string
    {
        $dir = $this->uploadsFsDir();
        foreach (['jpg', 'jpeg', 'png', 'webp', 'gif'] as $ext) {
            $fs = $dir . '/' . $chatId . '.' . $ext;
            if (is_file($fs) && filesize($fs) > 0) {
                return $this->uploadsWebPrefix() . '/' . $chatId . '.' . $ext;
            }
        }
        return '';
    }

    private function cacheAvatarFromDataUri(string $chatId, string $dataUri): string
    {
        if (!preg_match('#^data:([^;]+);base64,(.+)$#', $dataUri, $m)) {
            return '';
        }
        $mime = strtolower(trim($m[1]));
        $bin  = base64_decode($m[2], true);
        if ($bin === false || $bin === '') return '';

        $ext = match (true) {
            str_contains($mime, 'png')  => 'png',
            str_contains($mime, 'webp') => 'webp',
            str_contains($mime, 'gif')  => 'gif',
            default                     => 'jpg',
        };

        $dir = $this->uploadsFsDir();
        if (!is_dir($dir)) {
            @mkdir($dir, 0775, true);
        }
        $fs = $dir . '/' . $chatId . '.' . $ext;
        if (!is_file($fs) || filesize($fs) === 0) {
            @file_put_contents($fs, $bin);
            @chmod($fs, 0664);
        }

        return $this->uploadsWebPrefix() . '/' . $chatId . '.' . $ext;
    }

    private function ensureDefaultAvatarFile(): string
    {
        $svg = defined('DEFAULT_AVATAR_SVG') ? DEFAULT_AVATAR_SVG : '';
        if (!is_string($svg) || $svg === '') return '';

        if (preg_match('#^data:image/svg\+xml;base64,(.+)$#i', $svg, $m)) {
            $bin = base64_decode($m[1], true);
            if ($bin === false) return '';
        } else {
            $bin = $svg;
        }

        $dir = $this->uploadsFsDir();
        if (!is_dir($dir)) @mkdir($dir, 0775, true);
        $fs = $dir . '/default.svg';
        if (!is_file($fs) || filesize($fs) === 0) {
            @file_put_contents($fs, $bin);
            @chmod($fs, 0664);
        }
        return $this->uploadsWebPrefix() . '/default.svg';
    }

    private function ensureAvatarCached(string $chatId, ?string $dataUri, bool $probeDefault = false): string
    {
        // 1) локальный кэш файла
        $cached = $this->getCachedAvatar($chatId);
        if ($cached !== '') {
            if (is_callable($this->saveAvatarMeta)) {
                try { ($this->saveAvatarMeta)($chatId, $cached, false, time()); } catch (\Throwable $e) {}
            }
            return $cached;
        }

        // 2) БД: если уже не дефолт — отдаём; если дефолт и TTL не истёк — тоже отдаём
        if (is_callable($this->getAvatarMeta)) {
            try { $meta = ($this->getAvatarMeta)($chatId); } catch (\Throwable $e) { $meta = null; }
            if (is_array($meta) && !empty($meta['url'])) {
                $isDefault = !empty($meta['is_default']);
                $checkedAt = (int)($meta['checked_at'] ?? 0);

                if (!$isDefault) return (string)$meta['url'];
                if (!$probeDefault && $dataUri === null && time() - $checkedAt < $this->avatarTtlSeconds) {
                    return (string)$meta['url'];
                }
            }
        }

        // 3) REST прислал URL?
        if (is_string($dataUri) && $dataUri !== '') {
            if (str_starts_with($dataUri, 'uploads/')) {
                if (is_callable($this->saveAvatarMeta)) { try { ($this->saveAvatarMeta)($chatId, $dataUri, false, time()); } catch (\Throwable $e) {} }
                return $dataUri;
            }
            if (preg_match('#^https?://#i', $dataUri)) {
                $final = $dataUri;
                if (is_callable($this->saveAvatarMeta)) { try { ($this->saveAvatarMeta)($chatId, $final, false, time()); } catch (\Throwable $e) {} }
                return $final;
            }
            if ($dataUri[0] === '/') {
                $origin = preg_replace('#^(https?://[^/]+).*#', '$1', $this->baseUrl);
                $final  = $origin . $dataUri;
                if (is_callable($this->saveAvatarMeta)) { try { ($this->saveAvatarMeta)($chatId, $final, false, time()); } catch (\Throwable $e) {} }
                return $final;
            }
            if (str_starts_with($dataUri, 'data:')) {
                $saved = $this->cacheAvatarFromDataUri($chatId, $dataUri);
                if ($saved !== '') {
                    $final = $saved;
                    if (is_callable($this->saveAvatarMeta)) { try { ($this->saveAvatarMeta)($chatId, $final, false, time()); } catch (\Throwable $e) {} }
                    return $final;
                }
            }
        }

        // 4) Лениво просим REST
        $fetched = $this->tryFetchAvatarRemote($chatId);
        if ($fetched !== null) {
            if (is_callable($this->saveAvatarMeta)) { try { ($this->saveAvatarMeta)($chatId, $fetched, false, time()); } catch (\Throwable $e) {} }
            return $fetched;
        }

        // 5) Дефолт
        $default = $this->ensureDefaultAvatarFile();
        if ($default !== '') {
            if (is_callable($this->saveAvatarMeta)) { try { ($this->saveAvatarMeta)($chatId, $default, true, time()); } catch (\Throwable $e) {} }
            return $default;
        }

        return '';
    }

    private function mapTypeToPlaceholder(string $type): string
    {
        switch (strtolower($type)) {
            case 'photo':
            case 'image':    return '[Фото]';
            case 'video':    return '[Видео]';
            case 'audio':
            case 'voice':    return '[Аудио]';
            case 'sticker':  return '[Стикер]';
            case 'document':
            case 'media':    return '[Документ]';
            case 'webpage':  return '[Ссылка]';
            case 'location':
            case 'geo':      return '[Локация]';
            case 'poll':     return '[Опрос]';
            case 'text':
            case 'empty':    return '[Пусто]';
            default:         return '[Вложение]';
        }
    }

    /* ============================== HTTP ============================== */

    private function restGet(string $action, array $params = [])
    {
        $this->lastRestGetTimedOut = false;
        $params = array_merge(['action' => $action], $params);
        $url = $this->baseUrl . '/rest.php?' . http_build_query($params);
        $t0  = microtime(true);

        try {
            if ($this->guzzle) {
                /** @var \Psr\Http\Message\ResponseInterface $res */
                $res  = $this->guzzle->get($url);
                $code = $res->getStatusCode();
                $body = (string)$res->getBody();
            } else {
                [$code, $body] = $this->curl('GET', $url, null);
            }

            $this->debugHttp('GET', $url, $code, (microtime(true) - $t0) * 1000, $body);
            $json = json_decode($body, true);

            if (!is_array($json) || !($json['success'] ?? false)) {
                $this->log('warning', 'REST GET returned unsuccessful result', [
                    'action'  => $action,
                    'status'  => $code,
                    'sample'  => $this->jsonSnippet($body),
                ]);
                return [];
            }
            return $json['data'] ?? [];
        } catch (\Throwable $e) {
            $message = $e->getMessage();
            $this->lastRestGetTimedOut = stripos($message, 'timed out') !== false || stripos($message, 'cURL error 28') !== false;
            $this->log('error', 'REST GET exception', ['action' => $action, 'error' => $e->getMessage()]);
            return [];
        }
    }

    private function httpPost(string $path, array $payload, ?float $timeout = null): array
    {
        $url   = $this->baseUrl . $path;
        $body  = json_encode($payload, JSON_UNESCAPED_UNICODE);
        $t0    = microtime(true);
        $requestTimeout = $timeout === null
            ? $this->httpTimeout
            : max(3.0, min(30.0, $timeout));

        try {
            if ($this->guzzle) {
                /** @var \Psr\Http\Message\ResponseInterface $res */
                $res  = $this->guzzle->post($url, [
                    'headers' => ['Content-Type' => 'application/json'],
                    'body'    => $body,
                    'timeout' => $requestTimeout,
                    'connect_timeout' => min(5.0, $requestTimeout),
                ]);
                $code = $res->getStatusCode();
                $resp = (string)$res->getBody();
            } else {
                [$code, $resp] = $this->curl('POST', $url, $body, $requestTimeout);
            }

            $this->debugHttp('POST', $url, $code, (microtime(true) - $t0) * 1000, $resp, (string)($payload['action'] ?? ''));

            $json = json_decode($resp, true);
            if (!is_array($json)) {
                $this->log('warning', 'HTTP POST returned non-JSON body', [
                    'url'    => $this->sanitizeUrl($url),
                    'status' => $code,
                    'sample' => $this->jsonSnippet($resp),
                ]);
                return ['success' => false, 'message' => 'Invalid JSON', '_transport_error' => true, '_http_status' => $code];
            }
            // A 5xx response means the local Telegram REST process could have
            // lost the provider result after the RPC started. It is never a
            // confirmed rejection.  4xx responses remain explicit request
            // rejections because no provider operation is accepted there.
            if ($code < 200 || $code >= 500) {
                $json['_transport_error'] = true;
            }
            $json['_http_status'] = $code;
            return $json;
        } catch (\Throwable $e) {
            $this->log('error', 'HTTP POST exception', ['url' => $this->sanitizeUrl($url), 'error' => $e->getMessage()]);
            return ['success' => false, 'message' => 'HTTP POST exception: ' . $e->getMessage(), '_transport_error' => true];
        }
    }

    /**
     * Send the browser-uploaded temporary file as a real multipart body.
     * The response handling deliberately matches httpPost(): a 5xx or a lost
     * response is an unknown provider outcome, never a confirmed rejection.
     *
     * @param array{path:string,name:string,mime:string} $file
     */
    private function httpPostMultipart(string $path, array $payload, array $file, ?float $timeout = null): array
    {
        $url = $this->baseUrl . $path;
        $t0 = microtime(true);
        $requestTimeout = $timeout === null ? 120.0 : max(10.0, min(300.0, $timeout));

        try {
            if ($this->guzzle) {
                $parts = [];
                foreach ($payload as $name => $value) {
                    $parts[] = ['name' => (string)$name, 'contents' => (string)$value];
                }
                $stream = fopen($file['path'], 'rb');
                if ($stream === false) {
                    throw new \RuntimeException('Cannot open attachment for multipart upload');
                }
                try {
                    /** @var \Psr\Http\Message\ResponseInterface $res */
                    $res = $this->guzzle->post($url, [
                        'headers' => ['Accept' => 'application/json'],
                        'multipart' => array_merge($parts, [[
                            'name' => 'file',
                            'contents' => $stream,
                            'filename' => $file['name'],
                            'headers' => ['Content-Type' => $file['mime']],
                        ]]),
                        'timeout' => $requestTimeout,
                        'connect_timeout' => min(5.0, $requestTimeout),
                    ]);
                    $code = $res->getStatusCode();
                    $resp = (string)$res->getBody();
                } finally {
                    // Guzzle's multipart handler may already close the
                    // resource once the request body is consumed. A second
                    // fclose throws on PHP 8 and must not turn Telegram's
                    // confirmed response into an "unknown" send outcome.
                    if (is_resource($stream)) fclose($stream);
                }
            } else {
                $postFields = $payload;
                $postFields['file'] = new \CURLFile($file['path'], $file['mime'], $file['name']);
                $ch = curl_init($url);
                if ($ch === false) {
                    throw new \RuntimeException('Cannot initialize cURL');
                }
                curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
                curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
                curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
                curl_setopt($ch, CURLOPT_TIMEOUT, (int)ceil($requestTimeout));
                curl_setopt($ch, CURLOPT_POST, true);
                curl_setopt($ch, CURLOPT_POSTFIELDS, $postFields);
                curl_setopt($ch, CURLOPT_HTTPHEADER, ['Accept: application/json']);
                $resp = curl_exec($ch);
                if ($resp === false) {
                    $error = curl_error($ch);
                    curl_close($ch);
                    throw new \RuntimeException('cURL error: ' . $error);
                }
                $code = (int)curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
                curl_close($ch);
                $resp = (string)$resp;
            }

            $this->debugHttp('POST', $url, $code, (microtime(true) - $t0) * 1000, $resp, (string)($payload['action'] ?? ''));
            $json = json_decode($resp, true);
            if (!is_array($json)) {
                $this->log('warning', 'Multipart POST returned non-JSON body', [
                    'url' => $this->sanitizeUrl($url),
                    'status' => $code,
                    'sample' => $this->jsonSnippet($resp),
                ]);
                return ['success' => false, 'message' => 'Invalid JSON', '_transport_error' => true, '_http_status' => $code];
            }
            if ($code < 200 || $code >= 500) {
                $json['_transport_error'] = true;
            }
            $json['_http_status'] = $code;
            return $json;
        } catch (\Throwable $e) {
            $this->log('error', 'Multipart POST exception', ['url' => $this->sanitizeUrl($url), 'error' => $e->getMessage()]);
            return ['success' => false, 'message' => 'Multipart POST exception: ' . $e->getMessage(), '_transport_error' => true];
        }
    }

    private function curl(string $method, string $url, ?string $body, ?float $timeout = null): array
    {
        $ch = \curl_init($url);
        \curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
        \curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
        \curl_setopt($ch, CURLOPT_CONNECTTIMEOUT, 5);
        \curl_setopt($ch, CURLOPT_TIMEOUT, (int)ceil($timeout ?? $this->httpTimeout));

        $headers = ['Accept: application/json'];
        if ($method === 'POST') {
            \curl_setopt($ch, CURLOPT_POST, true);
            $headers[] = 'Content-Type: application/json';
            \curl_setopt($ch, CURLOPT_POSTFIELDS, $body ?? '');
        }
        \curl_setopt($ch, CURLOPT_HTTPHEADER, $headers);

        $resp = (string)\curl_exec($ch);
        if ($resp === false) {
            $err = \curl_error($ch);
            \curl_close($ch);
            throw new \RuntimeException('cURL error: ' . $err);
        }
        $status = (int)\curl_getinfo($ch, CURLINFO_RESPONSE_CODE);
        \curl_close($ch);

        return [$status, $resp];
    }

    private function debugHttp(string $method, string $url, int $code, float $ms, string $body, string $action = ''): void
    {
        $payload = [
            'method' => $method,
            'url'    => $this->sanitizeUrl($url),
            'status' => $code,
            'ms'     => (int)$ms,
            'length' => strlen($body),
        ];
        if ($action !== '') {
            $payload['action'] = $action;
        }
        $payload[$this->logHttpBodyFull ? 'body' : 'body_snippet'] = $this->jsonSnippet($body);

        $level = ($code >= 200 && $code < 400) ? 'info' : (($code >= 400 && $code < 500) ? 'warning' : 'error');
        if ($method === 'POST' && $code === 404 && $action === 'getPeerAvatar') {
            $level = 'debug';
        }
        $this->log($level, 'HTTP ' . $method . ' request completed', $payload);
    }

    private function tryFetchAvatarRemote(string $chatId): ?string
    {
        $this->log('debug', 'Fetching avatar URL from REST', ['chat_id' => $chatId]);
        $resp = $this->httpPost('/rest.php', ['action' => 'getPeerAvatar', 'chatId' => $chatId]);
        if (($resp['success'] ?? false) && isset($resp['data']['url'])) {
            $u = (string)$resp['data']['url'];
            $final = preg_match('#^https?://#i', $u)
                ? $u
                : (str_starts_with($u, 'uploads/') ? $u : rtrim($this->baseUrl, '/') . '/' . ltrim($u, '/'));
            $this->log('debug', 'Avatar URL resolved', ['chat_id' => $chatId, 'url' => $final]);
            return $final;
        }
        $this->log('debug', 'Avatar URL not available from REST', ['chat_id' => $chatId, 'sample' => $this->jsonSnippet(json_encode($resp, JSON_UNESCAPED_UNICODE))]);
        return null;
    }

    private function attachmentsFromType(
        string $type,
        string $chatId,
        string $messageId,
        string $text,
        ?string $serverFilename = null,
        ?string $serverMime = null
    ): array {
        if (in_array($type, ['text', 'webpage', 'poll', 'location'], true)) {
            return [];
        }

        $streamUrl = $this->baseUrl . '/rest.php?' . http_build_query([
            'action'    => 'downloadMedia',
            'chatId'    => $chatId,
            'messageId' => $messageId,
            'stream'    => 1,
        ]);

        $thumbUrl = $this->baseUrl . '/rest.php?' . http_build_query([
            'action'    => 'downloadThumb',
            'chatId'    => $chatId,
            'messageId' => $messageId,
        ]);

        $kind = match ($type) {
            'photo', 'image' => 'photo',
            'sticker' => 'sticker',
            'animation', 'video_note' => 'video',
            'video'                      => 'video',
            'audio', 'voice'             => 'audio',
            'document', 'media'          => 'document',
            default                      => 'document',
        };

        $mime = $serverMime ?: match ($type) {
            'sticker'                    => 'image/webp',
            'photo', 'image'             => 'image/jpeg',
            'video', 'animation', 'video_note' => 'video/mp4',
            'audio', 'voice'             => 'audio/mpeg',
            'document', 'media'          => 'application/octet-stream',
            default                      => 'application/octet-stream',
        };

        $title = $serverFilename ?: match ($type) {
            'sticker'                    => 'Sticker.webp',
            'photo', 'image'             => 'Photo.jpg',
            'video'                      => 'Video.mp4',
            'audio', 'voice'             => 'Audio.mp3',
            'document', 'media'          => 'Document.bin',
            default                      => '[' . strtoupper($type) . ']',
        };

        return [[
            'type'       => $kind,
            'animated' => $type === 'animation' || $mime === 'image/gif',
            'video_note' => $type === 'video_note',
            'url'        => $streamUrl,
            'mime'       => $mime,
            'title'      => $title,
            'filename'   => $title,
            'preview'    => $thumbUrl,
            'thumbnail'  => $thumbUrl,
        ]];
    }

    /** Preserve the normalized attachment returned by telegram_service/rest.php. */
    private function attachmentsFromRest(array $attachments, string $chatId, string $messageId): array
    {
        $result = [];
        foreach ($attachments as $attachment) {
            if (!is_array($attachment)) continue;
            $type = (string)($attachment['type'] ?? 'document');
            $title = (string)($attachment['title'] ?? $attachment['filename'] ?? 'Документ');
            $mime = (string)($attachment['mime'] ?? 'application/octet-stream');
            $remoteUrl = (string)($attachment['url'] ?? '');
            // A webpage preview has no Telegram media object to download.
            // Its URL is an ordinary outbound link and must remain intact;
            // treating it as a document silently replaced YouTube and other
            // previews with a fake `telegram_download.php` attachment.
            if (strtolower($type) === 'link') {
                $result[] = [
                    'type' => 'link',
                    'url' => $remoteUrl,
                    'external_url' => (string)($attachment['external_url'] ?? $remoteUrl),
                    'title' => $title,
                    'filename' => '',
                    'description' => (string)($attachment['description'] ?? ''),
                    'site_name' => (string)($attachment['site_name'] ?? ''),
                    'mime' => 'text/uri-list',
                ];
                continue;
            }
            // Polls are structured message content. They have no file URL
            // and must reach the common UI intact instead of becoming a fake
            // downloadable document named "Poll".
            if (strtolower($type) === 'poll') {
                $options = [];
                foreach (array_slice(is_array($attachment['options'] ?? null) ? $attachment['options'] : [], 0, 20) as $option) {
                    if (!is_array($option)) continue;
                    $options[] = [
                        'text' => mb_substr(trim((string)($option['text'] ?? '')), 0, 1000),
                        'voters' => max(0, (int)($option['voters'] ?? 0)),
                        'chosen' => !empty($option['chosen']),
                    ];
                }
                $result[] = [
                    'type' => 'poll',
                    'mime' => 'application/x-telegram-poll',
                    'title' => 'Опрос',
                    'filename' => '',
                    'question' => mb_substr(trim((string)($attachment['question'] ?? '')), 0, 1000),
                    'options' => $options,
                    'total_voters' => max(0, (int)($attachment['total_voters'] ?? 0)),
                    'multiple_choice' => !empty($attachment['multiple_choice']),
                    'quiz' => !empty($attachment['quiz']),
                    'closed' => !empty($attachment['closed']),
                    'voted' => !empty($attachment['voted']),
                ];
                continue;
            }
            if ($remoteUrl === '') {
                $remoteUrl = $this->baseUrl . '/rest.php?' . http_build_query([
                    'action' => 'downloadMedia', 'chatId' => $chatId, 'messageId' => $messageId, 'stream' => 1,
                ]);
            }
            // Archive downloads are streamed through a small same-origin
            // bridge.  Unlike media_proxy.php this never makes a second,
            // permanent copy under uploads/media.
            $isVisual = in_array($type, ['photo', 'image', 'sticker', 'video', 'audio'], true);
            $url = 'telegram_download.php?' . http_build_query([
                'chat_id' => $chatId, 'message_id' => $messageId, 'name' => $title,
                'inline' => $isVisual ? 1 : 0,
                // The desktop transport must distinguish an image thumbnail
                // from a video poster.  Telegram legitimately omits poster
                // thumbnails for many videos, while the MP4 itself remains
                // available.  This bounded UI hint is not provider data and
                // is ignored by the legacy same-origin downloader.
                'kind' => strtolower($type),
            ]);
            // Keep the lightweight marker distinct from the full stream.
            // The local bridge recognizes thumb=1 and routes it to Telegram's
            // thumbnail endpoint, while the original stays for lightbox and
            // downloads.
            $preview = $isVisual ? 'telegram_download.php?' . http_build_query([
                'chat_id' => $chatId, 'message_id' => $messageId,
                'name' => $title, 'thumb' => 1, 'kind' => strtolower($type),
            ]) : '';
            $result[] = [
                'type' => $type, 'url' => $url, 'mime' => $mime,
                'source_type' => (string)($attachment['source_type'] ?? ($type === 'document' ? 'document' : '')),
                'animated' => !empty($attachment['animated']),
                'video_note' => !empty($attachment['video_note']),
                'animation_format' => (string)($attachment['animation_format'] ?? ''),
                'width' => max(0, (int)($attachment['width'] ?? 0)) ?: null,
                'height' => max(0, (int)($attachment['height'] ?? 0)) ?: null,
                'duration' => max(0, (int)($attachment['duration'] ?? 0)) ?: null,
                'title' => $title, 'filename' => $title,
                'thumbnail' => $preview, 'preview' => $preview, 'preview_url' => $preview,
            ];
        }
        return $result;
    }
}
