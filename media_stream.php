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
    } elseif (stripos($line, 'Content-Type:') === 0) {
        $contentType = trim(str_replace(["\r", "\n"], '', substr($line, strlen('Content-Type:'))));
    } elseif (stripos($line, 'Content-Length:') === 0) {
        $contentLength = trim(substr($line, strlen('Content-Length:')));
    } elseif (stripos($line, 'Content-Range:') === 0) {
        $contentRange = trim(str_replace(["\r", "\n"], '', substr($line, strlen('Content-Range:'))));
    }
    return strlen($line);
};

// Ask for metadata first, so HTTP headers reach the browser before its first
// media byte. Some CDNs do not implement HEAD; then the stream still works,
// just without an upstream length/range hint.
$head = curl_init($url);
curl_setopt_array($head, [
    CURLOPT_HTTPHEADER => $upstreamHeaders,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 15,
    CURLOPT_NOBODY => true,
    CURLOPT_HEADERFUNCTION => $captureHeaders,
    CURLOPT_USERAGENT => 'UnifiedMessengerBridge/1.0',
]);
$headOk = curl_exec($head);
$status = (int)curl_getinfo($head, CURLINFO_HTTP_CODE) ?: $status;
curl_close($head);

// VK document/CDN endpoints can reject HEAD (notably with HTTP 418) while
// allowing an ordinary GET. Probe just one byte before declaring the original
// unavailable; this does not buffer the attachment or start its real stream.
// The actual GET below still owns the complete transfer and honours its Range.
if (($headOk === false || $status < 200 || $status >= 300)
    && in_array($status, [403, 405, 418, 501], true)) {
    $probe = curl_init($url);
    curl_setopt_array($probe, [
        CURLOPT_HTTPHEADER => ['Accept: */*', 'Range: bytes=0-0'],
        CURLOPT_FOLLOWLOCATION => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 15,
        CURLOPT_NOBODY => false,
        CURLOPT_HEADERFUNCTION => $captureHeaders,
        // Abort at the first body chunk: only the bounded Range response is
        // needed to establish that the provider accepts GET.
        CURLOPT_WRITEFUNCTION => static fn($handle, string $chunk): int => 0,
        CURLOPT_USERAGENT => 'UnifiedMessengerBridge/1.0',
    ]);
    curl_exec($probe);
    $probeStatus = (int)curl_getinfo($probe, CURLINFO_HTTP_CODE) ?: $status;
    curl_close($probe);
    if ($probeStatus >= 200 && $probeStatus < 300) {
        $headOk = true;
        // The probe's Content-Length is one byte; never report it for the
        // full transfer below. Its own response headers are not forwarded.
        $contentLength = null;
        $contentRange = null;
        $status = !empty($_SERVER['HTTP_RANGE']) ? 206 : 200;
    }
}

if (($headOk === false || $status < 200 || $status >= 300) && !in_array($status, [405, 501], true)) {
    http_response_code($status >= 400 ? $status : 502);
    exit('Внешнее медиа временно недоступно');
}
if (in_array($status, [405, 501], true)) {
    $status = !empty($_SERVER['HTTP_RANGE']) ? 206 : 200;
}

header('Content-Type: ' . ($contentType !== '' ? $contentType : 'application/octet-stream'));
if ($contentLength !== null && ctype_digit($contentLength)) header('Content-Length: ' . $contentLength);
if ($contentRange !== null && $contentRange !== '') header('Content-Range: ' . $contentRange);
header('Accept-Ranges: bytes');
header('Content-Disposition: ' . ($download ? 'attachment' : 'inline') . '; filename="' . addcslashes($safeName, '\\\\"') . '"');
http_response_code($status);

if (($_SERVER['REQUEST_METHOD'] ?? 'GET') === 'HEAD') {
    exit;
}

$stream = curl_init($url);
curl_setopt_array($stream, [
    CURLOPT_HTTPHEADER => $upstreamHeaders,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_CONNECTTIMEOUT => 5,
    CURLOPT_TIMEOUT => 120,
    CURLOPT_USERAGENT => 'UnifiedMessengerBridge/1.0',
    CURLOPT_WRITEFUNCTION => static function ($ch, string $chunk): int {
        echo $chunk;
        if (function_exists('ob_flush')) @ob_flush();
        flush();
        return strlen($chunk);
    },
]);
$ok = curl_exec($stream);
curl_close($stream);
if ($ok === false) {
    error_log('External media stream interrupted');
}
