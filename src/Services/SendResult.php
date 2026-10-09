<?php
declare(strict_types=1);

namespace App\Services;

/** One public result shape for one provider send operation. */
final class SendResult
{
    /** `accepted` means the provider returned the native id; it is not a delivery receipt. */
    public static function accepted(string|int $messageId, array $extra = []): array
    {
        $id = self::nativeId($messageId);
        if ($id === null) {
            return self::unknown('provider_id_missing', 'Провайдер не подтвердил идентификатор созданного сообщения. Проверьте чат перед повтором.');
        }

        $result = [
            'success' => true,
            'outcome' => 'accepted',
            'send_state' => self::sendState($extra['send_state'] ?? null),
            'message_id' => $id,
            'message_ids' => self::messageIds($extra['message_ids'] ?? [], $id),
        ];
        if (isset($extra['ack']) && is_numeric($extra['ack'])) $result['ack'] = (int)$extra['ack'];
        // MAX treats a multi-photo upload as one native message. Preserve this
        // provider contract through the shared result normalizer so the
        // browser journal can confirm the whole optimistic album.
        if (($extra['single_message_album'] ?? false) === true) {
            $result['single_message_album'] = true;
            $count = filter_var($extra['attachment_count'] ?? null, FILTER_VALIDATE_INT, ['options' => ['min_range' => 2, 'max_range' => 10]]);
            if ($count !== false) $result['attachment_count'] = $count;
        }
        $attachments = self::attachments($extra['attachments'] ?? null);
        if ($attachments !== []) $result['attachments'] = $attachments;
        return $result;
    }

    public static function rejected(string $code, string $message, array $extra = []): array
    {
        return self::failure('rejected', $code, $message, $extra);
    }

    public static function unknown(string $code, string $message, array $extra = []): array
    {
        return self::failure('unknown', $code, $message, $extra);
    }

    /** Convert legacy adapter output into the strict public shape. */
    public static function normalize(array $result): array
    {
        $explicitOutcome = strtolower(trim((string)($result['outcome'] ?? '')));
        if (in_array($explicitOutcome, ['unknown', 'rejected'], true)) {
            $code = trim((string)($result['code'] ?? ($explicitOutcome === 'unknown' ? 'send_outcome_unknown' : 'send_rejected')));
            $message = trim((string)($result['message'] ?? $result['error'] ?? ''));
            return $explicitOutcome === 'unknown'
                ? self::unknown($code, $message, $result)
                : self::rejected($code, $message, $result);
        }
        if ($explicitOutcome === 'accepted' && ($result['success'] ?? false) === true) {
            $id = self::nativeId($result['message_id'] ?? $result['messageId'] ?? null);
            return $id === null
                ? self::unknown('provider_id_missing', 'Провайдер ответил без идентификатора сообщения. Проверьте чат перед повтором.', $result)
                : self::accepted($id, $result);
        }
        if (!($result['success'] ?? false)) {
            $code = trim((string)($result['code'] ?? 'send_rejected'));
            $message = trim((string)($result['message'] ?? $result['error'] ?? 'Провайдер отклонил отправку.'));
            $unknown = $code === 'send_outcome_unknown' || $code === 'send_outcome_pending'
                || str_contains($code, 'unconfirmed') || str_contains($code, 'timeout') || str_contains($code, 'transport');
            return $unknown ? self::unknown($code ?: 'send_outcome_unknown', $message, $result)
                : self::rejected($code ?: 'send_rejected', $message, $result);
        }
        $id = self::nativeId($result['message_id'] ?? $result['messageId'] ?? null);
        return $id === null
            ? self::unknown('provider_id_missing', 'Провайдер ответил без идентификатора сообщения. Проверьте чат перед повтором.', $result)
            : self::accepted($id, $result);
    }

    public static function withRequestId(array $result, string $requestId): array
    {
        $normalized = self::normalize($result);
        $normalized['request_id'] = $requestId;
        return $normalized;
    }

    private static function failure(string $outcome, string $code, string $message, array $extra): array
    {
        $result = ['success' => false, 'outcome' => $outcome, 'send_state' => $outcome,
            'code' => $code !== '' ? $code : 'send_failed',
            'message' => $message !== '' ? $message : 'Не удалось определить результат отправки.'];
        $firstId = self::nativeId($extra['message_id'] ?? $extra['messageId'] ?? null);
        $messageIds = self::messageIds($extra['message_ids'] ?? [], $firstId);
        if ($messageIds !== []) $result['message_ids'] = $messageIds;
        $attachments = self::attachments($extra['attachments'] ?? null);
        if ($attachments !== []) $result['attachments'] = $attachments;
        return $result;
    }

    private static function nativeId(mixed $value): ?string
    {
        if (!is_string($value) && !is_int($value)) return null;
        $id = trim((string)$value);
        return $id === '' || strlen($id) > 512 || preg_match('/[\x00-\x1F\x7F]/', $id) ? null : $id;
    }

    /** @return list<string> */
    private static function messageIds(mixed $values, ?string $first): array
    {
        $out = $first === null ? [] : [$first];
        if (!is_array($values)) return $out;
        foreach ($values as $value) {
            $id = self::nativeId($value);
            if ($id !== null && !in_array($id, $out, true)) $out[] = $id;
        }
        return $out;
    }

    /** @return list<array<string,mixed>> */
    private static function attachments(mixed $attachments): array
    {
        if (!is_array($attachments)) return [];
        $out = [];
        foreach ($attachments as $item) {
            if (!is_array($item)) continue;
            $entry = [];
            if (isset($item['index']) && is_numeric($item['index'])) $entry['index'] = (int)$item['index'];
            $id = self::nativeId($item['message_id'] ?? null);
            if ($id !== null) $entry['message_id'] = $id;
            $status = strtolower(trim((string)($item['status'] ?? '')));
            if (in_array($status, ['accepted', 'rejected', 'unknown'], true)) $entry['status'] = $status;
            $code = trim((string)($item['code'] ?? ''));
            if ($code !== '') $entry['code'] = $code;
            $message = trim((string)($item['message'] ?? ''));
            if ($message !== '') $entry['message'] = $message;
            if ($entry !== []) $out[] = $entry;
        }
        return $out;
    }

    private static function sendState(mixed $value): string
    {
        $state = strtolower(trim((string)$value));
        return in_array($state, ['accepted', 'pending', 'sent', 'delivered', 'read'], true) ? $state : 'accepted';
    }
}
