<?php
declare(strict_types=1);

/**
 * Pure contract checks for the server-side byte-range logic. No provider,
 * network connection, cache mutation, or account action is used here.
 */

require dirname(__DIR__) . '/src/Interfaces/MessagingClientInterface.php';
require dirname(__DIR__) . '/src/Interfaces/PaginatableClientInterface.php';
require dirname(__DIR__) . '/src/Services/WppConnectClient.php';
require dirname(__DIR__) . '/telegram_service/media_range.php';

function server_media_range_assert(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, "FAIL {$message}\n");
        exit(1);
    }
}

/** @return array<string,int>|null */
function wpp_range_plan(string $range, int $size): ?array
{
    $method = new ReflectionMethod(App\Services\WppConnectClient::class, 'singleByteRangePlan');
    return $method->invoke(null, $range, $size);
}

function wpp_output_file(string $path, string $range, string $method): string
{
    $client = (new ReflectionClass(App\Services\WppConnectClient::class))->newInstanceWithoutConstructor();
    $output = new ReflectionMethod(App\Services\WppConnectClient::class, 'outputFileResponse');
    $_SERVER['REQUEST_METHOD'] = $method;
    $_SERVER['HTTP_RANGE'] = $range;
    http_response_code(200);
    ob_start();
    ob_start();
    $output->invoke($client, $path, 'text/plain', 'details.txt', false);
    ob_end_clean();
    return (string)ob_get_clean();
}

foreach ([
    ['bytes=0-1', 10, 0, 1, 2],
    ['bytes=5-', 10, 5, 9, 5],
    ['bytes=-4', 10, 6, 9, 4],
    ['bytes=0-999', 10, 0, 9, 10],
] as [$range, $size, $start, $end, $length]) {
    $wpp = wpp_range_plan($range, $size);
    $telegram = tg_media_single_byte_range_plan($range, $size);
    foreach ([$wpp, $telegram] as $plan) {
        server_media_range_assert(is_array($plan) && ($plan['status'] ?? 0) === 206, "{$range} returns 206");
        server_media_range_assert(
            ($plan['start'] ?? -1) === $start && ($plan['end'] ?? -1) === $end && ($plan['length'] ?? -1) === $length,
            "{$range} has exact bounds"
        );
    }
}

foreach ([wpp_range_plan('bytes=10-', 10), tg_media_single_byte_range_plan('bytes=10-', 10)] as $plan) {
    server_media_range_assert(is_array($plan) && ($plan['status'] ?? 0) === 416 && ($plan['total'] ?? -1) === 10, 'past-end seek returns 416 with total');
}

// Exercise the Telegram cached-file emitter itself: GET returns only the
// requested bytes, while HEAD emits no body and retains the partial status.
$fixture = dirname(__DIR__) . '/tests/fixtures/media/details.txt';
$bytes = (string)file_get_contents($fixture);
server_media_range_assert($bytes !== '', 'range fixture is available');

$body = wpp_output_file($fixture, 'bytes=0-1', 'GET');
server_media_range_assert(http_response_code() === 206, 'cached WhatsApp first-byte request returns 206');
server_media_range_assert($body === substr($bytes, 0, 2), 'cached WhatsApp first-byte request emits exactly two bytes');
$body = wpp_output_file($fixture, 'bytes=5-', 'HEAD');
server_media_range_assert(http_response_code() === 206, 'cached WhatsApp HEAD range returns 206');
server_media_range_assert($body === '', 'cached WhatsApp HEAD range has no body');

$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['HTTP_RANGE'] = 'bytes=0-1';
http_response_code(200);
ob_start();
ob_start();
tg_media_stream_cached_file($fixture, 'text/plain', false, 'details.txt');
ob_end_clean();
$body = (string)ob_get_clean();
server_media_range_assert(http_response_code() === 206, 'cached Telegram first-byte request returns 206');
server_media_range_assert($body === substr($bytes, 0, 2), 'cached Telegram first-byte request emits exactly two bytes');

$_SERVER['REQUEST_METHOD'] = 'HEAD';
$_SERVER['HTTP_RANGE'] = 'bytes=5-';
http_response_code(200);
ob_start();
ob_start();
tg_media_stream_cached_file($fixture, 'text/plain', false, 'details.txt');
ob_end_clean();
$body = (string)ob_get_clean();
server_media_range_assert(http_response_code() === 206, 'cached Telegram HEAD range returns 206');
server_media_range_assert($body === '', 'cached Telegram HEAD range has no body');

unset($_SERVER['HTTP_RANGE']);
$_SERVER['REQUEST_METHOD'] = 'GET';
fwrite(STDOUT, "PASS server media range contract\n");
