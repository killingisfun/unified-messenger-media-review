<?php
declare(strict_types=1);

/**
 * Byte-range response helpers for the Telegram media cache.
 *
 * Telegram videos are first materialized under runtime/telegram/tmp/cache.
 * Serving that local file with readfile() always returns 200, even when a
 * native player asks for a metadata byte or a seek range. Keep the response
 * logic beside the Telegram route instead of relying on the browser or an
 * outer proxy to repair it.
 */

if (!function_exists('tg_media_single_byte_range_plan')) {
    /**
     * @return array{status:206,total:int,start:int,end:int,length:int}|array{status:416,total:int}|null
     */
    function tg_media_single_byte_range_plan(string $range, int $total): ?array
    {
        $range = trim($range);
        if ($range === '') return null;
        if (!preg_match('~^bytes=(?:(\d+)-(\d*)|-(\d+))$~', $range, $match)) return null;
        if ($total < 1) return ['status' => 416, 'total' => max(0, $total)];

        $maxIndex = $total - 1;
        $isGreaterThan = static function (string $value, int $limit): bool {
            $value = ltrim($value, '0');
            if ($value === '') return false;
            $limitText = (string)$limit;
            return strlen($value) > strlen($limitText)
                || (strlen($value) === strlen($limitText) && strcmp($value, $limitText) > 0);
        };
        $toInt = static function (string $value): int {
            $value = ltrim($value, '0');
            return $value === '' ? 0 : (int)$value;
        };

        $rangeStart = (string)($match[1] ?? '');
        $rangeEnd = (string)($match[2] ?? '');
        $rangeSuffix = (string)($match[3] ?? '');
        if ($rangeSuffix !== '') {
            $suffix = $isGreaterThan($rangeSuffix, $total) ? $total : $toInt($rangeSuffix);
            if ($suffix === 0) return ['status' => 416, 'total' => $total];
            $start = $total - $suffix;
            $end = $maxIndex;
        } else {
            if ($isGreaterThan($rangeStart, $maxIndex)) return ['status' => 416, 'total' => $total];
            $start = $toInt($rangeStart);
            if ($rangeEnd === '' || $isGreaterThan($rangeEnd, $maxIndex)) {
                $end = $maxIndex;
            } else {
                $end = $toInt($rangeEnd);
            }
            if ($end < $start) return ['status' => 416, 'total' => $total];
        }

        return [
            'status' => 206,
            'total' => $total,
            'start' => $start,
            'end' => $end,
            'length' => $end - $start + 1,
        ];
    }
}

if (!function_exists('tg_media_stream_cached_file')) {
    /** Serve a cache file as GET, HEAD, or one standards-compliant byte range. */
    function tg_media_stream_cached_file(string $path, string $mime, bool $asAttachment, string $filename): void
    {
        $total = (int)@filesize($path);
        $isHead = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) === 'HEAD';
        // Range is defined for GET. A successful HEAD describes the complete
        // representation and never promises a partial body it cannot return.
        $plan = $isHead ? null : tg_media_single_byte_range_plan((string)($_SERVER['HTTP_RANGE'] ?? ''), $total);
        $filename = str_replace(["\r", "\n", '"'], '', basename($filename));
        if ($filename === '') $filename = 'file.bin';

        if (is_array($plan) && ($plan['status'] ?? 0) === 416) {
            http_response_code(416);
            header('Content-Range: bytes */' . $plan['total']);
            header('Content-Length: 0');
        } else {
            $isPartial = is_array($plan) && ($plan['status'] ?? 0) === 206;
            $start = $isPartial ? (int)$plan['start'] : 0;
            $end = $isPartial ? (int)$plan['end'] : max(0, $total - 1);
            $length = $isPartial ? (int)$plan['length'] : $total;
            http_response_code($isPartial ? 206 : 200);
            header('Content-Length: ' . $length);
            if ($isPartial) header('Content-Range: bytes ' . $start . '-' . $end . '/' . $total);
        }

        header('Content-Type: ' . ($mime !== '' ? $mime : 'application/octet-stream'));
        header('Accept-Ranges: bytes');
        $disp = $asAttachment ? 'attachment' : 'inline';
        header('Content-Disposition: ' . $disp . '; filename="' . $filename . '"; filename*=UTF-8\'\'' . rawurlencode($filename));

        if ($isHead || (is_array($plan) && ($plan['status'] ?? 0) === 416) || $total < 1) return;

        $start = is_array($plan) && ($plan['status'] ?? 0) === 206 ? (int)$plan['start'] : 0;
        $remaining = is_array($plan) && ($plan['status'] ?? 0) === 206 ? (int)$plan['length'] : $total;
        $handle = @fopen($path, 'rb');
        if ($handle === false) throw new \RuntimeException('Unable to read Telegram media cache');
        try {
            if ($start > 0) @fseek($handle, $start, SEEK_SET);
            while ($remaining > 0 && !feof($handle)) {
                $chunk = fread($handle, min(262144, $remaining));
                if ($chunk === false || $chunk === '') break;
                echo $chunk;
                $remaining -= strlen($chunk);
                if (function_exists('ob_flush')) @ob_flush();
                flush();
            }
        } finally {
            fclose($handle);
        }
    }
}
