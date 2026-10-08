<?php
declare(strict_types=1);

/**
 * Filesystem-only contract for the shared Telegram cache readiness rules.
 * No Telegram account, session, network request or production cache is used.
 */

require dirname(__DIR__) . '/telegram_service/media_cache.php';

function media_cache_assert(bool $condition, string $message): void
{
    if (!$condition) {
        fwrite(STDERR, "FAIL {$message}\n");
        exit(1);
    }
}

$directory = sys_get_temp_dir() . DIRECTORY_SEPARATOR . 'unified-media-cache-contract-' . bin2hex(random_bytes(8));
media_cache_assert(@mkdir($directory, 0700, true), 'temporary directory created');
$cache = $directory . DIRECTORY_SEPARATOR . 'media';
$temporary = $directory . DIRECTORY_SEPARATOR . 'download';

try {
    file_put_contents($cache, 'partial');
    media_cache_assert(!tg_media_cache_is_complete($cache), 'payload without sidecar is not ready');

    file_put_contents($temporary, 'abcdef');
    media_cache_assert(!tg_publish_complete_media_cache($temporary, $cache, 7, 'video/mp4'), 'incorrect expected size is rejected');
    media_cache_assert(is_file($temporary), 'rejected temporary payload remains for cleanup');

    tg_forget_incomplete_media_cache($cache);
    media_cache_assert(tg_publish_complete_media_cache($temporary, $cache, 6, 'video/mp4'), 'exact payload publishes');
    media_cache_assert(tg_media_cache_is_complete($cache, 6), 'payload and sidecar are ready together');
    media_cache_assert(!tg_media_cache_is_complete($cache, 5), 'wrong expected size is never ready');
    $metadata = tg_read_media_cache_metadata($cache);
    media_cache_assert($metadata === ['size' => 6, 'mime' => 'video/mp4'], 'sidecar preserves size and MIME');

    $abortTemp = tg_track_temporary_media_file($directory . DIRECTORY_SEPARATOR . 'aborted-download');
    file_put_contents($abortTemp, 'discard');
    tg_cleanup_temporary_media_files();
    media_cache_assert(!file_exists($abortTemp), 'request-local temporary media is removed on cleanup');

    tg_forget_incomplete_media_cache($cache);
    media_cache_assert(!file_exists($cache) && !file_exists(tg_media_cache_metadata_path($cache)), 'payload and sidecar invalidate together');
} finally {
    @unlink($temporary);
    @unlink($cache);
    @unlink(tg_media_cache_metadata_path($cache));
    @rmdir($directory);
}

fwrite(STDOUT, "PASS Telegram media cache contract\n");
