<?php
declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';
require dirname(__DIR__) . '/config.php';

use danog\MadelineProto\Settings;
use danog\MadelineProto\Settings\AppInfo;
use danog\MadelineProto\SimpleEventHandler;
use Amp\Http\Client\HttpClientBuilder;
use Amp\Http\Client\Request;
use function Amp\File\openFile;
use function Amp\File\read;
use function Amp\File\write;
use function Amp\File\isDirectory;
use function Amp\File\createDirectoryRecursively;
use function Amp\File\listFiles;
use function Amp\File\move;
use function Amp\File\deleteFile;
use function Amp\async;
use function Amp\delay;

const TG_LISTENER_SESSION = '/opt/unified-messenger/runtime/telegram/session.madeline';
const TG_LISTENER_LOG = '/opt/unified-messenger/runtime/telegram/tmp/listener.log';
const TG_LISTENER_SELF_ID_FILE = '/opt/unified-messenger/runtime/telegram/self_id';
const TG_LISTENER_WEBHOOK_URL = 'http://127.0.0.1:8090/rest.php?action=webhook';
const TG_LISTENER_OUTBOX_DIR = '/opt/unified-messenger/runtime/telegram/tmp/listener_outbox';

function tg_listener_log(string $message, array $context = []): void
{
    $row = [
        'ts' => date('c'),
        'pid' => getmypid(),
        'message' => $message,
        'context' => $context,
    ];
    $line = json_encode($row, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES) . PHP_EOL;
    try {
        $file = openFile(TG_LISTENER_LOG, 'a');
        $file->write($line);
        $file->close();
    } catch (\Throwable) {
        echo $line;
    }
}

function tg_listener_peer_id($value): ?string
{
    if (is_int($value) || (is_string($value) && ctype_digit($value))) return (string)$value;
    if (!is_array($value)) return null;
    $type = (string)($value['_'] ?? '');
    if ($type === 'peerUser' && isset($value['user_id'])) return (string)$value['user_id'];
    if ($type === 'peerChat' && isset($value['chat_id'])) return '-' . $value['chat_id'];
    if ($type === 'peerChannel' && isset($value['channel_id'])) return '-100' . $value['channel_id'];
    return null;
}

function tg_listener_message_peer(array $message): ?string
{
    $peer = tg_listener_peer_id($message['peer_id'] ?? null);
    $from = tg_listener_peer_id($message['from_id'] ?? null);
    if (empty($message['out']) && $peer !== null && $from !== null
        && $peer !== $from && $peer[0] !== '-' && $from[0] !== '-') {
        return $from;
    }
    return ($peer !== null && $peer !== 'me') ? $peer : $from;
}

final class UnifiedTelegramEventHandler extends SimpleEventHandler
{
    /** @var array<string, array> */
    private static array $pendingReactionUpdates = [];
    private static bool $reactionFlushScheduled = false;
    private static bool $outboxFlushRunning = false;
    private static bool $outboxFlushRequested = false;
    private static bool $priorityOutboxFlushRunning = false;
    private static bool $priorityOutboxFlushRequested = false;
    private static $httpClient = null;
    /** @var array<string, int> Latest inbound message awaiting bounded recovery. */
    private static array $reactionRecoveryTarget = [];
    /** @var array<string, bool> One recovery worker per private peer. */
    private static array $reactionRecoveryRunning = [];
    /** @var array<string, float> Reaction states already delivered live. */
    private static array $reactionLiveAt = [];

    public function getReportPeers(): array
    {
        return [];
    }

    public function onStart(): void
    {
        tg_listener_log('listener started');
        $this->ensureOutboxDirectory();
        try {
            $self = $this->getSelf();
            $selfId = is_array($self) ? (string)($self['id'] ?? '') : '';
            if ($selfId !== '') {
                $file = openFile(TG_LISTENER_SELF_ID_FILE, 'w');
                $file->write($selfId . PHP_EOL);
                $file->close();
                tg_listener_log('self id ready', ['self_id' => $selfId]);
            }
        } catch (\Throwable $e) {
            tg_listener_log('self id lookup failed', ['error' => $e->getMessage()]);
        }

        // Retry durable deliveries independently from incoming updates. The
        // queue is intentionally local: Telegram is never polled for this.
        async(function (): void {
            while (true) {
                $this->scheduleOutboxFlush();
                // Priority reactions have their own queue. Retry it even when
                // no new Telegram update arrives after a temporary local error.
                $this->schedulePriorityOutboxFlush();
                delay(2);
            }
        });
    }

    /** Telegram dispatches reaction changes through this exact update hook. */
    public function onUpdateMessageReactions(array $update): void
    {
        $this->handleUpdate($update);
    }

    public function onUpdateDeleteMessages(array $update): void { $this->handleUpdate($update); }
    public function onUpdateDeleteChannelMessages(array $update): void { $this->handleUpdate($update); }

    /** Receive other raw Telegram updates without competing with the explicit reaction hook. */
    public function onAny(array $update): void
    {
        if (in_array($update['_'] ?? '', ['updateMessageReactions','updateDeleteMessages','updateDeleteChannelMessages'],true)) return;
        $this->handleUpdate($update);
    }

    private function handleUpdate(array $update): void
    {
        $type = (string)($update['_'] ?? 'unknown');

        // In private dialogs Telegram can carry a reaction-state change as an
        // edited message instead of updateMessageReactions.  We used to drop
        // every edit here, which made those changes visible only after a later
        // history reload.
        if ($type === 'updateEditMessage') {
            $reactionUpdate = $this->reactionUpdateFromEditedMessage($update);
            if ($reactionUpdate !== null) {
                $this->queueReactionUpdate($reactionUpdate, 'edit_message');
            }
            return;
        }

        if (!$this->shouldForward($update, $type)) {
            return;
        }

        if ($type === 'updateMessageReactions') {
            $this->queueReactionUpdate($update, 'native');
            return;
        }

        if ($type === 'updateNewMessage') {
            $message = is_array($update['message'] ?? null) ? $update['message'] : [];
            if (empty($message['out'])) {
                $peer = tg_listener_message_peer($message);
                $messageId = (int)($message['id'] ?? 0);
                if ($peer !== null && $messageId > 0 && $peer[0] !== '-') {
                    $this->scheduleReactionRecovery($peer, $messageId);
                }
            }
        }

        $this->forwardUpdates([$update], $type);
    }

    /** @return array|null A normalized authoritative reaction update. */
    private function reactionUpdateFromEditedMessage(array $update): ?array
    {
        $message = is_array($update['message'] ?? null) ? $update['message'] : [];
        if (!array_key_exists('reactions', $message)) return null;

        $peer = tg_listener_message_peer($message);
        $messageId = (int)($message['id'] ?? 0);
        if ($peer === null || $messageId <= 0) return null;

        return [
            '_' => 'updateMessageReactions',
            'peer' => ['_' => 'peerUser', 'user_id' => (int)$peer],
            'msg_id' => $messageId,
            'reactions' => $message['reactions'],
        ];
    }

    private function queueReactionUpdate(array $update, string $source): void
    {
        $peer = tg_listener_peer_id($update['peer'] ?? null);
        $messageId = (int)($update['msg_id'] ?? 0);
        if ($peer === null || $messageId <= 0) return;

        self::$reactionLiveAt[$peer . ':' . $messageId] = microtime(true);

        // A reaction update is a full state snapshot. A brief coalescing
        // window preserves the newest state during a rapid add/remove burst.
        self::$pendingReactionUpdates[$peer . ':' . $messageId] = $update;
        tg_listener_log('reaction update queued', [
            'source' => $source,
            'peer' => $peer,
            'message_id' => $messageId,
        ]);
        if (self::$reactionFlushScheduled) return;

        self::$reactionFlushScheduled = true;
        async(function (): void {
            delay(0.12);
            $updates = array_values(self::$pendingReactionUpdates);
            self::$pendingReactionUpdates = [];
            self::$reactionFlushScheduled = false;
            $this->forwardUpdates($updates, 'reaction_batch');
        });
    }

    /**
     * Some private-chat reaction changes are not emitted by Telegram as an
     * update at all. Check only the newest inbound message, three times in a
     * short bounded window, and stop as soon as a live state was received.
     * This is a server-side safety net, not a permanent history poller.
     */
    private function scheduleReactionRecovery(string $peer, int $messageId): void
    {
        self::$reactionRecoveryTarget[$peer] = $messageId;
        if (!empty(self::$reactionRecoveryRunning[$peer])) return;
        self::$reactionRecoveryRunning[$peer] = true;

        async(function () use ($peer): void {
            try {
                $elapsed = 0;
                foreach ([1, 2, 4] as $wait) {
                    delay($wait);
                    $elapsed += $wait;
                    $targetId = (int)(self::$reactionRecoveryTarget[$peer] ?? 0);
                    if ($targetId <= 0) break;
                    if (isset(self::$reactionLiveAt[$peer . ':' . $targetId])) continue;

                    $response = $this->messages->getMessagesReactions([
                        'peer' => $peer,
                        'id' => [$targetId],
                    ]);
                    $updates = is_array($response['updates'] ?? null) ? $response['updates'] : [];
                    foreach ($updates as $update) {
                        if (($update['_'] ?? '') === 'updateMessageReactions') {
                            $this->queueReactionUpdate($update, 'bounded_recovery');
                        }
                    }
                    tg_listener_log('bounded reaction recovery checked', [
                        'peer' => $peer,
                        'message_id' => $targetId,
                        'after_seconds' => $elapsed,
                        'updates' => count($updates),
                    ]);
                }
            } catch (\Throwable $e) {
                tg_listener_log('bounded reaction recovery failed', [
                    'peer' => $peer,
                    'error' => $e->getMessage(),
                ]);
            } finally {
                unset(self::$reactionRecoveryRunning[$peer], self::$reactionRecoveryTarget[$peer]);
            }
        });
    }

    /** @param list<array> $updates */
    private function forwardUpdates(array $updates, string $type): void
    {
        if ($updates === []) return;

        // Reactions are complete states, not a log. One short coalescing
        // window already keeps the newest state per message. Send the whole
        // window as one priority request so message delivery cannot delay it.
        if ($type === 'reaction_batch') {
            $this->enqueueWebhookPayload(
                $updates,
                $type,
                'reaction_batch_' . sprintf('%.6f', microtime(true)) . '_' . bin2hex(random_bytes(3))
            );
            $this->schedulePriorityOutboxFlush();
        } elseif (in_array($type, ['updateReadHistoryInbox', 'updateReadHistoryOutbox', 'updateReadChannelInbox', 'updateReadChannelOutbox'], true)) {
            $this->enqueueWebhookPayload(
                $updates,
                $type,
                'priority_read_' . sprintf('%.6f', microtime(true)) . '_' . bin2hex(random_bytes(3))
            );
            $this->schedulePriorityOutboxFlush();
        } else {
            $this->enqueueWebhookPayload($updates, $type);
            $this->scheduleOutboxFlush();
        }
    }

    /** @param list<array> $updates */
    private function enqueueWebhookPayload(array $updates, string $type, ?string $stableKey = null): void
    {
        if (!$this->ensureOutboxDirectory()) {
            tg_listener_log('outbox directory unavailable', ['type' => $type]);
            return;
        }
        $entry = [
            'type' => $type,
            'updates' => $updates,
            'attempts' => 0,
            'retry_at' => 0,
            'created_at' => time(),
        ];
        $json = json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) {
            tg_listener_log('outbox json encode failed', ['type' => $type]);
            return;
        }
        $name = $stableKey ?: sprintf('event_%020.6f_%s', microtime(true), bin2hex(random_bytes(5)));
        $path = TG_LISTENER_OUTBOX_DIR . '/' . preg_replace('/[^A-Za-z0-9_.-]/', '_', $name) . '.json';
        $tmp = $path . '.tmp-' . bin2hex(random_bytes(3));
        try {
            write($tmp, $json);
            move($tmp, $path);
        } catch (\Throwable) {
            try { deleteFile($tmp); } catch (\Throwable) {}
            tg_listener_log('outbox write failed', ['type' => $type]);
        }
    }

    private function scheduleOutboxFlush(): void
    {
        if (self::$outboxFlushRunning) {
            self::$outboxFlushRequested = true;
            return;
        }
        self::$outboxFlushRunning = true;
        async(function (): void {
            try {
                $this->flushOutbox(false);
            } finally {
                self::$outboxFlushRunning = false;
                if (self::$outboxFlushRequested) {
                    self::$outboxFlushRequested = false;
                    $this->scheduleOutboxFlush();
                }
            }
        });
    }

    private function schedulePriorityOutboxFlush(): void
    {
        if (self::$priorityOutboxFlushRunning) {
            self::$priorityOutboxFlushRequested = true;
            return;
        }
        self::$priorityOutboxFlushRunning = true;
        async(function (): void {
            try {
                $this->flushOutbox(true);
            } finally {
                self::$priorityOutboxFlushRunning = false;
                if (self::$priorityOutboxFlushRequested) {
                    self::$priorityOutboxFlushRequested = false;
                    $this->schedulePriorityOutboxFlush();
                }
            }
        });
    }

    private function flushOutbox(bool $priorityOnly = false): void
    {
        try {
            $files = array_map(
                static fn(string $file): string => str_starts_with($file, '/') ? $file : TG_LISTENER_OUTBOX_DIR . '/' . $file,
                array_filter(listFiles(TG_LISTENER_OUTBOX_DIR), static function (string $file) use ($priorityOnly): bool {
                    if (!str_ends_with($file, '.json')) return false;
                    $name = basename($file);
                    $isPriority = str_starts_with($name, 'reaction_') || str_starts_with($name, 'priority_');
                    return $priorityOnly ? $isPriority : !$isPriority;
                })
            );
        } catch (\Throwable) {
            return;
        }
        sort($files, SORT_STRING);
        foreach ($files as $path) {
            try { $json = read($path); } catch (\Throwable) { continue; }
            $entry = is_string($json) ? json_decode($json, true) : null;
            if (!is_array($entry) || !is_array($entry['updates'] ?? null)) {
                try { deleteFile($path); } catch (\Throwable) {}
                continue;
            }
            if ((int)($entry['retry_at'] ?? 0) > time()) continue;

            $result = $this->deliverWebhookPayload($entry['updates']);
            if ($result['ok']) {
                // Do not remove a newer reaction snapshot which replaced this
                // file while the HTTP request was in progress.
                try {
                    if (read($path) === $json) deleteFile($path);
                } catch (\Throwable) {}
                tg_listener_log('forward ok', [
                    'type' => (string)($entry['type'] ?? 'unknown'),
                    'updates' => count($entry['updates']),
                    'http_code' => $result['code'],
                ]);
                continue;
            }

            $entry['attempts'] = (int)($entry['attempts'] ?? 0) + 1;
            $entry['retry_at'] = time() + min(60, 2 ** min(6, $entry['attempts']));
            $retryJson = json_encode($entry, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
            try {
                if ($retryJson !== false && read($path) === $json) write($path, $retryJson);
            } catch (\Throwable) {
            }
            tg_listener_log('forward deferred', [
                'type' => (string)($entry['type'] ?? 'unknown'),
                'attempt' => $entry['attempts'],
                'retry_in' => max(0, $entry['retry_at'] - time()),
                'error' => $result['error'],
            ]);
            // A local webhook failure usually affects all queued events; do
            // not turn recovery into a request flood.
            break;
        }
    }

    private function ensureOutboxDirectory(): bool
    {
        try {
            if (!isDirectory(TG_LISTENER_OUTBOX_DIR)) {
                createDirectoryRecursively(TG_LISTENER_OUTBOX_DIR, 0770);
            }
            return true;
        } catch (\Throwable) {
            return false;
        }
    }

    /** @param list<array> $updates @return array{ok: bool, code: int, error: string} */
    private function deliverWebhookPayload(array $updates): array
    {
        self::$httpClient ??= HttpClientBuilder::buildDefault();
        $json = json_encode(['action' => 'webhook', 'updates' => $updates], JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        if ($json === false) return ['ok' => false, 'code' => 0, 'error' => 'json encode failed'];
        try {
            $request = new Request(TG_LISTENER_WEBHOOK_URL, 'POST', $json);
            $request->setHeader('content-type', 'application/json');
            $request->setTransferTimeout(10);
            $request->setInactivityTimeout(10);
            $response = self::$httpClient->request($request);
            $code = $response->getStatus();
            $body = $response->getBody()->buffer();
            return [
                'ok' => $code >= 200 && $code < 300,
                'code' => $code,
                'error' => $code >= 200 && $code < 300 ? '' : mb_substr($body, 0, 500),
            ];
        } catch (\Throwable $e) {
            return ['ok' => false, 'code' => 0, 'error' => $e->getMessage()];
        }
    }

    private function shouldForward(array $update, string $type): bool
    {
        if (in_array($type, ['updateDeleteMessages','updateDeleteChannelMessages'], true)) return true;
        if ($type === 'updateMessageReactions') return true;
        if ($type === 'updateUserTyping' || $type === 'updateUserStatus') return true;
        if ($type === 'updateReadHistoryInbox' || $type === 'updateReadHistoryOutbox') return true;
        if ($type === 'updateShortMessage' || $type === 'updateShortChatMessage') {
            // The browser creates an optimistic outgoing bubble first. It can
            // only acquire the provider message id when this update reaches
            // the webhook and is persisted locally.
            return true;
        }

        if ($type === 'updateNewMessage') {
            // Forward both directions. The webhook upsert is idempotent, and
            // dropping our own update leaves the UI with a permanent
            // optimistic element that reactions/read receipts cannot target.
            return true;
        }

        if ($type === 'updateEditMessage') {
            return false;
        }

        // Human/private chats in this UI do not need noisy channel view counters
        // and public channel updates. They can arrive in bursts and delay the
        // reaction-only updates we actually need live.
        if (str_contains($type, 'Channel')) {
            return false;
        }

        return false;
    }
}

$settings = new Settings;
$apiId = (int)($_ENV['TELEGRAM_API_ID'] ?? 0);
$apiHash = trim((string)($_ENV['TELEGRAM_API_HASH'] ?? ''));
if ($apiId > 0 && $apiHash !== '') {
    $settings->setAppInfo(
        (new AppInfo())
            ->setApiId($apiId)
            ->setApiHash($apiHash)
    );
}

tg_listener_log('boot');
UnifiedTelegramEventHandler::startAndLoop(TG_LISTENER_SESSION, $settings);
