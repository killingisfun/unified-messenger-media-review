<?php
declare(strict_types=1);

// The relay must make one upstream request. Metadata HEAD followed by a new
// GET was observable as two provider hits and could disagree after a redirect
// or an expiring URL. Headers are captured from that one streamed GET before
// its first body chunk reaches the browser. This needs no provider network.
$source = file_get_contents(__DIR__ . '/../media_stream.php');
if (!is_string($source)) throw new RuntimeException('Unable to read media_stream.php');

foreach ([
    'CURLOPT_HEADERFUNCTION => $captureHeaders',
    'CURLOPT_NOBODY => $isHead',
    'CURLOPT_WRITEFUNCTION => static function',
    'if ($status < 200 || $status >= 300) return 0;',
    '$status !== 416',
    'if (!$headersEmitted && (($status >= 200 && $status < 300) || $status === 416))',
    "CURLOPT_USERAGENT => 'UnifiedMessengerBridge/1.0'",
] as $expected) {
    if (!str_contains($source, $expected)) {
        throw new RuntimeException('Missing media-stream fallback contract: ' . $expected);
    }
}

foreach ([
    'CURLOPT_NOBODY => true',
    "'Range: bytes=0-0'",
    '$head = curl_init($url);',
] as $removed) {
    if (str_contains($source, $removed)) {
        throw new RuntimeException('Obsolete second-request relay contract remains: ' . $removed);
    }
}

echo "media-stream-single-get-contract: ok\n";
