<?php
declare(strict_types=1);

/**
 * Same-origin relay for external VK/Avito media.
 *
 * Unlike media_proxy.php it does not download a complete file to PHP memory or
 * uploads/. The body is relayed to the browser in cURL chunks, including the
 * browser's Range header used by <video> seeking.
 */

header('Cache-Control: private, no-store');

$url = trim((string)($_GET['u'] ?? ''));
$download = (int)($_GET['download'] ?? $_GET['dl'] ?? 0) === 1;
$requestedName = (string)($_GET['name'] ?? $_GET['fn'] ?? 'media.bin');

if ($url === '' || !preg_match('~^https?://~i', $url)) {
    http_response_code(400);
    exit('Некорректный адрес медиа');
}

$safeName = basename($requestedName);
$safeName = preg_replace('/[^a-zA-Z0-9._ -]/u', '_', $safeName) ?: 'media.bin';
$upstreamHeaders = ['Accept: */*'];
if (!empty($_SERVER['HTTP_RANGE'])) {
    $upstreamHeaders[] = 'Range: ' . $_SERVER['HTTP_RANGE'];
}

$contentType = 'application/octet-stream';
$contentLength = null;
$contentRange = null;
$status = 0;
$captureHeaders = static function ($ch, string $line) use (&$contentType, &$contentLength, &$contentRange, &$status): int {
    $trimmed = trim($line);
    if (preg_match('~^HTTP/\\S+\\s+(\\d+)~', $trimmed, $match)) {
        $status = (int)$match[1];
        // CURLOPT_FOLLOWLOCATION reports every response. Only the final
        // response is allowed to describe the bytes relayed to the browser.
        $contentType = 'application/octet-stream';
        $contentLength = null;
        $contentRange = null;
    } elseif (stripos($line, 'Content-Type:') === 0) {
        $contentType = trim(str_replace(["\r", "\n"], '', substr($line, strlen('Content-Type:'))));
    } elseif (stripos($line, 'Content-Length:') === 0) {
        $contentLength = trim(substr($line, strlen('Content-Length:')));
    } elseif (stripos($line, 'Content-Range:') === 0) {
        $contentRange = trim(str_replace(["\r", "\n"], '', substr($line, strlen('Content-Range:'))));
    }
    return strlen($line);
};

$emitHeaders = static function () use (&$contentType, &$contentLength, &$contentRange, &$status, $download, $safeName): void {
    if (($status < 200 || $status >= 300) && $status !== 416) return;
    header('Content-Type: ' . ($contentType !== '' ? $contentType : 'application/octet-stream'));
    // A 416 response is header-only. Do not retain an upstream error-page
    // length when this relay deliberately sends no body.
    if ($status !== 416 && $contentLength !== null && ctype_digit($contentLength)) header('Content-Length: ' . $contentLength);
    if ($contentRange !== null && $contentRange !== '') header('Content-Range: ' . $contentRange);
    header('Accept-Ranges: bytes');
    header('Content-Disposition: ' . ($download ? 'attachment' : 'inline') . '; filename="' . addcslashes($safeName, '\\\\"') . '"');
    http_response_code($status);
};

$isHead = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET')) === 'HEAD';
$headersEmitted = false;
$stream = curl_init($url);
curl_setopt_array($stream, [
    CURLOPT_HTTPHEADER => $upstreamHeaders,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 120,
    CURLOPT_NOBODY => $isHead,
    CURLOPT_HEADERFUNCTION => $captureHeaders,
    CURLOPT_USERAGENT => 'UnifiedMessengerBridge/1.0',
    CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk) use (&$headersEmitted, &$status, $emitHeaders): int {
        // cURL invokes the body callback only after the response headers, so
        // do not leak an upstream HTML error page before PHP can return its
        // own bounded error response.
        if ($status < 200 || $status >= 300) return 0;
        if (!$headersEmitted) {
            $emitHeaders();
            $headersEmitted = true;
        }
        echo $chunk;
        if (function_exists('ob_flush')) @ob_flush();
        flush();
        return strlen($chunk);
    },
]);
$ok = curl_exec($stream);
$status = (int)curl_getinfo($stream, CURLINFO_HTTP_CODE) ?: $status;
$error = curl_error($stream);
curl_close($stream);
if (!$headersEmitted && (($status >= 200 && $status < 300) || $status === 416)) {
    $emitHeaders();
    $headersEmitted = true;
}
if (!$headersEmitted) {
    http_response_code($status >= 400 ? $status : 502);
    exit('Внешнее медиа временно недоступно');
}
if ($ok === false) error_log('External media stream interrupted: ' . $error);
