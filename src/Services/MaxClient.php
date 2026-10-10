<?php

namespace App\Services;

use App\Interfaces\MessagingClientInterface;

/**
 * Adapter for the isolated personal MAX sidecar.
 *
 * PHP never opens the MAX session: it only talks to the fixed localhost
 * `max_api.php` contract. Every mutable operation keeps the server-selected
 * chat id and is checked again by the sidecar against the connected account.
 */
final class MaxClient implements MessagingClientInterface
{
    private const BASE_URL = 'http://127.0.0.1:8080/max_api.php';

    public function getSource(): string
    {
        return 'MAX';
    }

    /** @return list<array<string,mixed>> */
    public function getChats(): array
    {
        $rows = [];
        $accountId = '';
        $cursor = null;
        $seen = [];
        for ($page = 0; $page < 100; $page++) {
            $query = ['resource' => 'chats', 'limit' => 50];
            if ($cursor !== null) $query['cursor'] = $cursor;
            $payload = $this->get($query);
            $pageAccount = (string)($payload['account_id'] ?? '');
            if ($pageAccount === '' || ($accountId !== '' && $accountId !== $pageAccount)) {
                throw new \RuntimeException('MAX account changed during pagination');
            }
            $accountId = $pageAccount;
            foreach (($payload['chats'] ?? []) as $row) {
                if (is_array($row) && isset($row['id'])) $rows[(string)$row['id']] ??= $row;
            }
            $next = $payload['next_cursor'] ?? null;
            if ($next === null || $next === '') break;
            $next = (string)$next;
            if (!preg_match('/^[1-9][0-9]{0,18}$/D', $next) || isset($seen[$next]) || $page === 99) {
                throw new \RuntimeException('MAX pagination did not finish safely');
            }
            $seen[$next] = true;
            $cursor = $next;
        }
        $result = [];
        foreach ($rows as $row) {
            if (!is_array($row)) continue;
            $chatId = trim((string)($row['id'] ?? ''));
            if ($chatId === '') continue;
            $last = is_array($row['last_message'] ?? null) ? $row['last_message'] : [];
            $lastService = $this->serviceEvent($last['attachments'] ?? [], (string)($last['text'] ?? ''), (string)($last['sender_name'] ?? ''));
            $text = trim((string)($lastService['label'] ?? $last['text'] ?? ''));
            if ($text === '') $text = $this->attachmentPreview($last['attachments'] ?? []);
            if ($text === '') $text = '[Нет сообщений]';
            $timestamp = $this->seconds($row['updated_at'] ?? ($last['timestamp'] ?? 0));
            $result[] = [
                'id' => $chatId,
                'source' => $this->getSource(),
                // MAX uses chat 0 for the private self-dialogue. It has no
                // stable title in several current web payloads.
                'name' => $chatId === '0' ? 'Избранное' : (trim((string)($row['title'] ?? '')) ?: ('MAX ' . $chatId)),
                // A MAX relay reference is opaque and short-lived.  The local
                // bridge turns it into its own avatar URL before HTML sees it.
                'avatar' => $this->relayUrl($row['avatar_ref'] ?? ''),
                'avatar_version' => (string)($row['avatar_version'] ?? ''),
                'last_message_id' => (string)($last['id'] ?? ''),
                'last_message_text' => $text,
                'last_message_time' => $timestamp,
                'direction' => !empty($last['outgoing']) ? 'out' : 'in',
                // A history native ID is provider acceptance. MAX does not
                // expose WhatsApp-style ACKs, so project accepted outgoing
                // messages to one sent check instead of a permanent clock.
                'last_message_ack' => !empty($last['outgoing']) ? (!empty($last['is_read']) ? 3 : 1) : 0,
                'last_message_send_state' => !empty($last['outgoing']) ? (!empty($last['is_read']) ? 'read' : 'accepted') : '',
                'last_message_is_service' => $lastService !== null,
                // Keep the list presentation in lock-step with the common
                // history event-pill contract; this is not MAX-specific UI.
                'last_message_event_style' => $lastService['style'] ?? '',
                'is_read_by_peer' => !empty($last['outgoing']) && !empty($last['is_read']),
                'is_unread' => (int)($row['unread_count'] ?? 0) > 0,
                'item_context' => [
                    'max_account_id' => $accountId,
                    'max_last_message_timestamp_ms' => (int)($last['timestamp'] ?? 0),
                    'max_chat_type' => (string)($row['type'] ?? ''),
                    'max_avatar_available' => !empty($row['avatar_available']),
                    'max_avatar_version' => (string)($row['avatar_version'] ?? ''),
                    // The older chats table keeps provider-specific summary
                    // state in item_context_json. Preserve this here so the
                    // bridge can render the same service marker on the left.
                    'last_message_is_service' => $lastService !== null,
                    'last_message_service_event' => $lastService['event'] ?? '',
                    'last_message_event_style' => $lastService['style'] ?? '',
                ],
            ];
        }
        return $result;
    }

    /** @return array{items:list<array<string,mixed>>,nextCursor:?string,prevCursor:?string,pinnedMessage?:array{id:string,text:string,author_name:string}} */
    public function getChatHistory(string $chatId, $startMessageId = 0): array
    {
        $chatId = $this->validChatId($chatId);
        $query = ['resource' => 'history', 'chat_id' => $chatId, 'limit' => 30];
        $cursor = trim((string)$startMessageId);
        if ($cursor !== '' && $cursor !== '0') $query['before'] = $this->validMessageId($cursor);
        $payload = $this->get($query);
        $accountId = (string)($payload['account_id'] ?? '');
        $rows = is_array($payload['messages'] ?? null) ? $payload['messages'] : [];
        $items = [];
        foreach ($rows as $row) {
            if (!is_array($row)) continue;
            $messageId = trim((string)($row['id'] ?? ''));
            if ($messageId === '') continue;
            $service = $this->serviceEvent($row['attachments'] ?? [], (string)($row['text'] ?? ''), (string)($row['sender_name'] ?? ''));
            $attachments = $this->attachments($row['attachments'] ?? []);
            $item = [
                'id' => $messageId,
                'chat_id' => $chatId,
                'text' => $service['label'] ?? (string)($row['text'] ?? ''),
                'timestamp' => $this->seconds($row['timestamp'] ?? 0),
                'direction' => !empty($row['outgoing']) ? 'out' : 'in',
                'type' => $service !== null ? 'service' : ($attachments !== [] ? (string)($attachments[0]['type'] ?? 'document') : 'text'),
                'attachments' => $attachments,
                'files' => $attachments,
                'is_service' => $service !== null,
                'service_event' => $service['event'] ?? '',
                // Generic presentation contract: other provider adapters may
                // emit the same event pill without inheriting MAX internals.
                'presentation' => $service !== null ? 'event_pill' : '',
                'event_style' => $service['style'] ?? '',
                'sender_name' => mb_substr(trim((string)($row['sender_name'] ?? '')), 0, 160),
                'sender_avatar' => $this->relayUrl($row['sender_avatar_ref'] ?? ''),
                'sender_profile_id' => trim((string)($row['sender_id'] ?? '')),
                'sender_id' => trim((string)($row['sender_id'] ?? '')),
                'chat_kind' => (string)($payload['chat_kind'] ?? ''),
                'is_read' => !empty($row['outgoing']) && !empty($row['is_read']) ? 1 : 0,
                'ack' => !empty($row['outgoing']) ? (!empty($row['is_read']) ? 3 : 1) : 0,
                'send_state' => !empty($row['outgoing']) ? (!empty($row['is_read']) ? 'read' : 'accepted') : '',
                // MAX reaction information is read-only at this stage. The
                // generic UI receives counters but cannot alter them yet.
                'reactions' => $this->reactions($row['reactions'] ?? [], (string)($row['own_reaction'] ?? '')),
                'item_context' => ['max_timestamp_ms' => (int)($row['timestamp'] ?? 0), 'max_account_id' => $accountId, 'max_sender_id' => (string)($row['sender_id'] ?? '')],
            ];
            $reply = $this->reply($row['reply_to'] ?? null);
            if ($reply !== null) $item['reply_to'] = $reply;
            $items[] = $item;
        }
        $next = trim((string)($payload['next_cursor'] ?? ''));
        $result = ['items' => $items, 'nextCursor' => $next !== '' ? $next : null, 'prevCursor' => $next !== '' ? $next : null];
        $pinnedMessage = $this->pinnedMessage($payload['pinned_message'] ?? null);
        if ($pinnedMessage !== null) $result['pinnedMessage'] = $pinnedMessage;
        return $result;
    }

    /** Mark the newest visible MAX message after the chat is shown. */
    public function markAsRead(string $chatId): bool
    {
        try {
            $chatId = $this->validChatId($chatId);
            $result = $this->post(['resource' => 'read', 'chat_id' => $chatId]);
            return ($result['success'] ?? false) === true;
        } catch (\Throwable) {
            return false;
        }
    }

    /** @return array{success:false,outcome:'rejected',code:string,message:string} */
    public function sendMessage(string $chatId, string $message, ?array $file, ?string $replyToMessageId = null): array
    {
        try {
            $chatId = $this->validChatId($chatId);
        } catch (\InvalidArgumentException $e) {
            return SendResult::rejected('max_chat_invalid', $e->getMessage());
        }
        if (is_array($file) && is_array($file['files'] ?? null)) {
            return SendResult::normalize($this->postAttachments($chatId, $file['files'], $message, $replyToMessageId));
        }
        if ($file !== null) {
            if (!is_array($file) || ($file['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) return SendResult::rejected('max_attachment_invalid', 'Файл MAX не загружен.');
            if ((int)($file['size'] ?? 0) < 1 || (int)($file['size'] ?? 0) > 10 * 1024 * 1024) return SendResult::rejected('max_attachment_too_large', 'Файл MAX превышает 10 МБ.');
            return SendResult::normalize($this->postAttachment($chatId, $file, $message, $replyToMessageId));
        }
        if ($replyToMessageId !== null && $replyToMessageId !== '' && !preg_match('/^[1-9][0-9]{0,19}$/', $replyToMessageId)) return SendResult::rejected('max_reply_target_invalid', 'Некорректная цитата MAX.');
        if (trim($message) === '' || mb_strlen($message) > 4000) return SendResult::rejected('max_invalid_text', 'Текст MAX имеет неверный формат.');
        return SendResult::normalize($this->postMessage($chatId, $message, $replyToMessageId));
    }

    /** @return array{message_id:string,text:string,author_name:string}|null */
    private function reply(mixed $value): ?array
    {
        if (!is_array($value)) return null;
        $id = trim((string)($value['message_id'] ?? $value['id'] ?? ''));
        if (!preg_match('/^[1-9][0-9]{0,19}$/D', $id)) return null;
        return [
            'message_id' => $id,
            'text' => mb_substr((string)($value['text'] ?? ''), 0, 4000),
            'author_name' => mb_substr(trim((string)($value['author_name'] ?? '')) ?: 'Сообщение', 0, 128),
        ];
    }

    /** @return list<array{emoji:string,count:int,me:bool}> */
    public function getMessageReactions(string $chatId, string $messageId): array
    {
        $chatId = $this->validChatId($chatId);
        $this->validMessageId($messageId);
        $payload = $this->get(['resource' => 'reactions', 'chat_id' => $chatId, 'message_id' => $messageId]);
        return $this->reactionSnapshot($payload['reactions'] ?? []);
    }

    /** @return array<string,mixed> */
    public function sendReaction(string $chatId, string $messageId, string $reaction): array
    {
        try {
            $chatId = $this->validChatId($chatId);
            $this->validMessageId($messageId);
        } catch (\InvalidArgumentException $e) {
            return SendResult::rejected('max_reaction_invalid', $e->getMessage());
        }
        if ($reaction !== '' && !in_array($reaction, ['👍', '❤️', '😂', '😮', '😢', '🙏'], true)) {
            return SendResult::rejected('max_reaction_unsupported', 'Эта реакция пока не разрешена для MAX.');
        }
        return $this->post(['resource' => 'reaction', 'chat_id' => $chatId, 'message_id' => $messageId, 'reaction' => $reaction]);
    }

    /** @return array<string,mixed> */
    public function getOwnProfile(): array
    {
        $payload = $this->get(['resource' => 'profile']);
        $profile = is_array($payload['profile'] ?? null) ? $payload['profile'] : [];
        $id = trim((string)($profile['id'] ?? ''));
        return [
            'id' => $id,
            'account_id' => $id,
            'name' => trim((string)($profile['name'] ?? '')) ?: 'Мой аккаунт MAX',
            'subtitle' => 'Подключённый аккаунт MAX',
            'avatar' => $this->relayUrl($profile['avatar_ref'] ?? ''),
            'avatar_version' => (string)($profile['avatar_version'] ?? ''),
            'fields' => $id === '' ? [] : [['label' => 'ID MAX', 'value' => $id]],
            'avatar_available' => !empty($profile['avatar_available']),
        ];
    }

    /** @param array<string,string|int> $query @return array<string,mixed> */
    private function get(array $query): array
    {
        $url = self::BASE_URL . '?' . http_build_query($query, '', '&', PHP_QUERY_RFC3986);
        $curl = curl_init($url);
        if ($curl === false) throw new \RuntimeException('MAX sidecar is unavailable.');
        curl_setopt_array($curl, [CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 15, CURLOPT_HTTPHEADER => ['Accept: application/json']]);
        $body = curl_exec($curl);
        $status = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
        curl_close($curl);
        if (!is_string($body)) throw new \RuntimeException('MAX sidecar did not respond.');
        $decoded = json_decode($body, true);
        if (!is_array($decoded) || !($decoded['success'] ?? false) || !($decoded['read_only'] ?? false)) {
            throw new \RuntimeException((string)($decoded['message'] ?? ('MAX read failed (HTTP ' . $status . ').')));
        }
        return $decoded;
    }

    /** @return array<string,mixed> */
    private function postMessage(string $chatId, string $text, ?string $replyTo = null): array
    {
        $payload = ['resource' => 'send', 'chat_id' => $chatId, 'text' => $text];
        if ($replyTo !== null && $replyTo !== '') $payload['reply_to'] = $replyTo;
        return $this->post($payload);
    }

    /** @param array<string,mixed> $file @return array<string,mixed> */
    private function postAttachment(string $chatId, array $file, string $caption, ?string $replyTo): array
    {
        $tmp = (string)($file['tmp_name'] ?? '');
        if ($tmp === '' || !is_readable($tmp)) return SendResult::rejected('max_attachment_invalid', 'Файл MAX недоступен.');
        $fields = ['resource' => 'attachment', 'chat_id' => $chatId, 'caption' => $caption, 'file' => new \CURLFile($tmp, (string)($file['type'] ?? 'application/octet-stream'), basename((string)($file['name'] ?? 'attachment.bin')))];
        if (!empty($file['send_as_file'])) $fields['send_as_file'] = '1';
        if ($replyTo !== null && $replyTo !== '') $fields['reply_to'] = $replyTo;
        $curl = curl_init(self::BASE_URL); if ($curl === false) return SendResult::unknown('max_attachment_unknown', 'Результат отправки вложения MAX неизвестен.');
        curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $fields, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 60, CURLOPT_HTTPHEADER => ['Accept: application/json']]);
        $response = curl_exec($curl); curl_close($curl);
        if (!is_string($response)) return SendResult::unknown('max_attachment_unknown', 'Результат отправки вложения MAX неизвестен.');
        $decoded = json_decode($response, true);
        return is_array($decoded) ? $decoded : SendResult::unknown('max_invalid_response', 'MAX вернул некорректный ответ вложения.');
    }

    /** @return array<string,mixed> */
    public function getContactProfile(string $chatId): array
    {
        $chatId = $this->validChatId($chatId);
        $payload = $this->get(['resource' => 'contact_profile', 'chat_id' => $chatId]);
        $profile = is_array($payload['profile'] ?? null) ? $payload['profile'] : [];
        $id = trim((string)($profile['id'] ?? ''));
        $fields = is_array($profile['fields'] ?? null) ? $profile['fields'] : [];
        $members = [];
        foreach ((is_array($profile['members'] ?? null) ? $profile['members'] : []) as $member) {
            if (!is_array($member) || count($members) >= 50) continue;
            $memberId = trim((string)($member['id'] ?? ''));
            $name = mb_substr(trim((string)($member['name'] ?? '')), 0, 160);
            if ($memberId === '' || $name === '') continue;
            $members[] = [
                'id' => $memberId,
                'name' => $name,
                'avatar' => $this->relayUrl($member['avatar_ref'] ?? ''),
                'avatar_available' => !empty($member['avatar_available']),
            ];
        }
        return [
            'id' => $id,
            'name' => trim((string)($profile['name'] ?? '')) ?: ($chatId === '0' ? 'Избранное' : 'Диалог MAX'),
            'subtitle' => trim((string)($profile['subtitle'] ?? '')) ?: 'MAX',
            'avatar' => $this->relayUrl($profile['avatar_ref'] ?? ''),
            'avatar_version' => (string)($profile['avatar_version'] ?? ''),
            'avatar_available' => !empty($profile['avatar_available']),
            'fields' => $fields,
            'kind' => strtolower(trim((string)($profile['kind'] ?? ''))) === 'group' ? 'group' : 'contact',
            'members' => $members,
            'members_total' => max(count($members), (int)($profile['members_total'] ?? 0)),
            'members_truncated' => !empty($profile['members_truncated']),
        ];
    }

    /** @return array<string,mixed> */
    public function getUserProfile(string $userId): array
    {
        $userId = $this->validUserId($userId);
        $payload = $this->get(['resource' => 'user_profile', 'user_id' => $userId]);
        $profile = is_array($payload['profile'] ?? null) ? $payload['profile'] : [];
        $id = trim((string)($profile['id'] ?? $userId));
        return [
            'id' => $id,
            'name' => mb_substr(trim((string)($profile['name'] ?? '')) ?: 'Пользователь MAX', 0, 160),
            'subtitle' => trim((string)($profile['subtitle'] ?? '')) ?: 'Пользователь MAX',
            'avatar' => $this->relayUrl($profile['avatar_ref'] ?? ''),
            'avatar_version' => (string)($profile['avatar_version'] ?? ''),
            'avatar_available' => !empty($profile['avatar_available']),
            'fields' => is_array($profile['fields'] ?? null) ? $profile['fields'] : [],
        ];
    }

    /** @param list<array<string,mixed>> $files @return array<string,mixed> */
    private function postAttachments(string $chatId, array $files, string $caption, ?string $replyTo): array
    {
        if (count($files) < 2 || count($files) > 10) return SendResult::rejected('max_attachment_batch_invalid', 'MAX принимает от двух до десяти файлов за раз.');
        $fields = ['resource' => 'attachments', 'chat_id' => $chatId, 'caption' => $caption];
        $sendAsFile = false;
        $total = 0;
        foreach ($files as $index => $file) {
            $tmp = (string)($file['tmp_name'] ?? '');
            $size = (int)($file['size'] ?? 0);
            if ($tmp === '' || !is_readable($tmp) || $size < 1 || $size > 10 * 1024 * 1024) return SendResult::rejected('max_attachment_invalid', 'Одно из вложений MAX недоступно или превышает 10 МБ.');
            $total += $size;
            $sendAsFile = $sendAsFile || !empty($file['send_as_file']);
            $fields['files[' . $index . ']'] = new \CURLFile($tmp, (string)($file['type'] ?? 'application/octet-stream'), basename((string)($file['name'] ?? ('attachment-' . ($index + 1)))));
        }
        if ($total > 20 * 1024 * 1024) return SendResult::rejected('max_attachment_batch_too_large', 'Пачка MAX превышает 20 МБ.');
        if ($sendAsFile) $fields['send_as_file'] = '1';
        if ($replyTo !== null && $replyTo !== '') $fields['reply_to'] = $replyTo;
        $curl = curl_init(self::BASE_URL); if ($curl === false) return SendResult::unknown('max_attachment_unknown', 'Результат отправки пачки MAX неизвестен.');
        curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $fields, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 90, CURLOPT_HTTPHEADER => ['Accept: application/json']]);
        $response = curl_exec($curl); curl_close($curl);
        if (!is_string($response)) return SendResult::unknown('max_attachment_unknown', 'Результат отправки пачки MAX неизвестен.');
        $decoded = json_decode($response, true);
        return is_array($decoded) ? $decoded : SendResult::unknown('max_invalid_response', 'MAX вернул некорректный результат пачки.');
    }

    /** @param array<string,string> $payload @return array<string,mixed> */
    /** @param array<string,string> $payload @return array<string,mixed> */
    private function post(array $payload): array
    {
        $curl = curl_init(self::BASE_URL);
        if ($curl === false) return SendResult::unknown('max_transport_unknown', 'Результат отправки MAX неизвестен.');
        $body = json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        curl_setopt_array($curl, [CURLOPT_POST => true, CURLOPT_POSTFIELDS => $body, CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 15, CURLOPT_HTTPHEADER => ['Accept: application/json', 'Content-Type: application/json']]);
        $response = curl_exec($curl);
        curl_close($curl);
        if (!is_string($response)) return SendResult::unknown('max_transport_unknown', 'Результат отправки MAX неизвестен.');
        $decoded = json_decode($response, true);
        return is_array($decoded) ? $decoded : SendResult::unknown('max_invalid_response', 'MAX вернул некорректный результат отправки.');
    }

    private function validChatId(string $value): string
    {
        $value = trim($value);
        if (!preg_match('/^-?[0-9]{1,20}$/', $value)) throw new \InvalidArgumentException('Некорректный идентификатор чата MAX.');
        return $value;
    }

    private function validMessageId(string $value): string
    {
        if (!preg_match('/^[0-9]{1,20}$/', $value)) throw new \InvalidArgumentException('Некорректный идентификатор сообщения MAX.');
        return $value;
    }

    private function validUserId(string $value): string
    {
        $value = trim($value);
        if (!preg_match('/^[1-9][0-9]{0,19}$/D', $value)) throw new \InvalidArgumentException('Некорректный идентификатор пользователя MAX.');
        return $value;
    }

    private function seconds(mixed $value): int
    {
        $time = is_numeric($value) ? (int)$value : 0;
        return $time > 100000000000 ? intdiv($time, 1000) : $time;
    }

    private function relayUrl(mixed $value): string
    {
        $ref = is_string($value) ? $value : '';
        return preg_match('/^[A-Za-z0-9_-]{20,128}$/D', $ref)
            ? 'max_api.php?resource=media&ref=' . rawurlencode($ref)
            : '';
    }

    /** @return list<array<string,mixed>> */
    private function attachments(mixed $value): array
    {
        if (!is_array($value)) return [];
        $result = [];
        foreach ($value as $attachment) {
            if (!is_array($attachment)) continue;
            $type = strtolower((string)($attachment['type'] ?? 'document'));
            // MAX history also contains service controls (for example,
            // inline keyboards and call controls) in the attachment array.
            // They have neither a media token nor downloadable bytes. Do not
            // turn them into a fake, unavailable document card in the shared
            // UI: only provider-declared media belongs in this contract.
            if ($type === 'file') $type = 'document';
            if (!in_array($type, ['photo', 'video', 'document', 'audio', 'sticker'], true)) continue;
            $videoNote = $type === 'video' && (!empty($attachment['video_note']) || (int)($attachment['video_type'] ?? 0) === 1);
            $identity = is_array($attachment['media_identity'] ?? null) ? $attachment['media_identity'] : [];
            $refreshChatId = trim((string)($identity['chat_id'] ?? ''));
            $refreshMessageId = trim((string)($identity['message_id'] ?? ''));
            $refreshAccountId = trim((string)($identity['account_id'] ?? ''));
            $refreshIndex = $identity['index'] ?? null;
            $canRefresh = preg_match('/^-?[0-9]{1,20}$/D', $refreshChatId)
                && preg_match('/^[1-9][0-9]{0,19}$/D', $refreshMessageId)
                && preg_match('/^[1-9][0-9]{0,19}$/D', $refreshAccountId)
                && is_int($refreshIndex) && $refreshIndex >= 0 && $refreshIndex <= 99;
            $result[] = [
                'type' => $type,
                'name' => (string)($attachment['name'] ?? ''),
                'animation_format' => (string)($attachment['animation_format'] ?? ''),
                'mime' => (string)($attachment['mime'] ?? ''),
                'size' => (int)($attachment['size'] ?? 0),
                'width' => (int)($attachment['width'] ?? 0),
                'height' => (int)($attachment['height'] ?? 0),
                // Presentation only: the browser still receives an opaque
                // relay URL, never an original MAX URL or token.
                'animated' => !empty($attachment['animated']),
                'video_note' => $videoNote,
                // These bounded native IDs can only request a replacement
                // opaque token for this exact message attachment. They are
                // not provider URLs and are never used as a media endpoint.
                'media_refresh_chat_id' => $canRefresh ? $refreshChatId : '',
                'media_refresh_message_id' => $canRefresh ? $refreshMessageId : '',
                'media_refresh_account_id' => $canRefresh ? $refreshAccountId : '',
                'media_refresh_index' => $canRefresh ? $refreshIndex : -1,
                // No URL until MAX media relay has a separately audited token
                // and cache contract. This avoids a browser reaching MAX.
                'url' => isset($attachment['media_ref']) && preg_match('/^[A-Za-z0-9_-]{20,128}$/', (string)$attachment['media_ref']) ? 'max_api.php?resource=media&ref=' . rawurlencode((string)$attachment['media_ref']) : '',
                // An animated MAX sticker can also carry a static provider
                // rendition. It is an opaque relay token too; the UI uses it
                // only after a malformed Lottie document and verifies image
                // magic bytes before displaying it.
                'preview_url' => isset($attachment['preview_ref']) && preg_match('/^[A-Za-z0-9_-]{20,128}$/', (string)$attachment['preview_ref']) ? 'max_api.php?resource=media&ref=' . rawurlencode((string)$attachment['preview_ref']) : '',
            ];
        }
        return $result;
    }

    /** @return array{id:string,text:string,author_name:string}|null */
    private function pinnedMessage(mixed $value): ?array
    {
        if (!is_array($value)) return null;
        $id = trim((string)($value['id'] ?? ''));
        $text = trim((string)($value['text'] ?? ''));
        if (!preg_match('/^[1-9][0-9]{0,19}$/D', $id) || $text === '') return null;
        return [
            'id' => $id,
            'text' => mb_substr($text, 0, 1000),
            'author_name' => mb_substr(trim((string)($value['author_name'] ?? '')), 0, 160),
        ];
    }

    /** @return array{event:string,label:string,style:string}|null */
    private function serviceEvent(mixed $value, string $nativeText = '', string $actorName = ''): ?array
    {
        if (!is_array($value)) return null;
        foreach ($value as $attachment) {
            if (!is_array($attachment) || strtolower((string)($attachment['type'] ?? '')) !== 'control') continue;
            $event = strtolower(trim((string)($attachment['event'] ?? '')));
            $title = trim((string)($attachment['title'] ?? ''));
            $actor = mb_substr(trim($actorName), 0, 160);
            $text = mb_substr(trim($nativeText), 0, 1000);
            $label = match (true) {
                str_contains($event, 'pin') => $text !== '' ? $text : ($title !== '' ? ('Закреплено: «' . $title . '»') : 'Закреплено сообщение'),
                str_contains($event, 'leave') => $actor !== '' ? ('Группу покинул(а) ' . $actor) : 'Участник вышел из группы',
                str_contains($event, 'remove') => $actor !== '' ? ($actor . ' удалил(а) участника из группы') : 'Участник удалён из группы',
                str_contains($event, 'join'), str_contains($event, 'invite') => $actor !== '' ? ('В группу вступил(а) ' . $actor) : 'Участник вступил в группу',
                str_contains($event, 'add') => $actor !== '' ? ($actor . ' добавил(а) участника в группу') : 'В группу добавлен участник',
                str_contains($event, 'new'), str_contains($event, 'create') => $actor !== '' ? ($title !== '' ? ($actor . ' создал(а) группу «' . $title . '»') : ($actor . ' создал(а) группу')) : ($title !== '' ? ('Создана группа «' . $title . '»') : 'Создана группа'),
                str_contains($event, 'title'), str_contains($event, 'name') => $title !== '' ? ($actor !== '' ? ($actor . ' изменил(а) название группы на «' . $title . '»') : ('Название группы изменено на «' . $title . '»')) : ($actor !== '' ? ($actor . ' изменил(а) название группы') : 'Изменено название группы'),
                str_contains($event, 'icon'), str_contains($event, 'avatar'), str_contains($event, 'photo') => $actor !== '' ? ($actor . ' изменил(а) фото группы') : 'Изменено фото группы',
                default => $text !== '' ? $text : ($title !== '' ? ($actor !== '' ? ($actor . ' обновил(а) группу: «' . $title . '»') : ('Обновлена группа: «' . $title . '»')) : ($actor !== '' ? ($actor . ' изменил(а) данные группы') : 'Изменены данные группы')),
            };
            return ['event' => mb_substr($event, 0, 128), 'label' => $label, 'style' => $this->eventStyle($event)];
        }
        // Calls come from MAX as a non-downloadable attachment with a
        // duration, not as conversation text.  It belongs to the same
        // neutral, auditable service-record contract as group joins/leaves;
        // never turn it into an empty history row or a fake file card.
        foreach ($value as $attachment) {
            if (!is_array($attachment) || strtolower((string)($attachment['type'] ?? '')) !== 'call') continue;
            $duration = $this->callDurationLabel($attachment['duration'] ?? null);
            return ['event' => 'call', 'label' => $duration === '' ? 'Звонок' : ('Звонок · ' . $duration), 'style' => 'call'];
        }
        return null;
    }

    private function eventStyle(string $event): string
    {
        $event = strtolower($event);
        if (str_contains($event, 'pin')) return 'pin';
        if (str_contains($event, 'leave') || str_contains($event, 'remove') || str_contains($event, 'join') || str_contains($event, 'add') || str_contains($event, 'invite')) return 'membership';
        return 'notice';
    }

    private function callDurationLabel(mixed $value): string
    {
        if (!is_numeric($value)) return '';
        $raw = max(0, (int)$value);
        if ($raw === 0) return '';
        // PyMAX provides this attachment field in milliseconds.  Retain a
        // seconds fallback for an older cache record that may already hold a
        // normalized duration.
        $seconds = $raw > 1000 ? max(1, (int)round($raw / 1000)) : $raw;
        if ($seconds >= 3600) return intdiv($seconds, 3600) . ':' . str_pad((string)intdiv($seconds % 3600, 60), 2, '0', STR_PAD_LEFT) . ':' . str_pad((string)($seconds % 60), 2, '0', STR_PAD_LEFT);
        if ($seconds >= 60) return intdiv($seconds, 60) . ':' . str_pad((string)($seconds % 60), 2, '0', STR_PAD_LEFT);
        return $seconds . ' с';
    }

    private function attachmentPreview(mixed $attachments): string
    {
        $items = $this->attachments($attachments);
        return match ((string)($items[0]['type'] ?? '')) {
            'photo' => '[Изображение]', 'video' => '[Видео]', 'audio' => '[Аудио]', 'sticker' => '[Стикер]', 'document' => '[Файл]', default => '',
        };
    }

    /** @return list<array<string,mixed>> */
    private function reactionSnapshot(mixed $value): array
    {
        if (!is_array($value)) return [];
        $result = [];
        foreach ($value as $reaction) {
            if (!is_array($reaction)) continue;
            $emoji = trim((string)($reaction['emoji'] ?? ''));
            if ($emoji === '') continue;
            $result[] = [
                'emoji' => $emoji,
                'count' => max(0, (int)($reaction['count'] ?? 0)),
                'me' => !empty($reaction['me']),
            ];
        }
        return $result;
    }

    /** @return list<array<string,mixed>> */
    private function reactions(mixed $value, string $own): array
    {
        if (!is_array($value)) return [];
        $result = [];
        foreach ($value as $reaction) {
            if (!is_array($reaction)) continue;
            $emoji = trim((string)($reaction['emoji'] ?? ''));
            if ($emoji === '') continue;
            $result[] = ['emoji' => $emoji, 'count' => max(0, (int)($reaction['count'] ?? 0)), 'me' => $emoji === $own];
        }
        return $result;
    }
}

