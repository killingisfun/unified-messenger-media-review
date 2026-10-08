<?php
declare(strict_types=1);

/**
 * Shared Telegram media-cache contract.
 *
 * A cache entry is usable only when both the payload and its atomically
 * written sidecar agree on the exact byte length. Writers publish by rename;
 * readers never infer readiness from a non-zero filesize alone.
 */

function tg_media_cache_metadata_path(string $cachePath): string
{
    return $cachePath . '.meta.json';
}

/** @return array{size:int,mime:string}|null */
function tg_read_media_cache_metadata(string $cachePath): ?array
{
    $metaPath = tg_media_cache_metadata_path($cachePath);
    // MadelineProto installs an error handler that turns even a suppressed
    // `file_get_contents()` warning into an exception. A missing sidecar is
    // the normal cache-miss state, not a failed media request.
    if (!is_file($metaPath)) return null;
    set_error_handler(static fn(): bool => true);
    try {
        $raw = file_get_contents($metaPath);
    } finally {
        restore_error_handler();
    }
    if (!is_string($raw) || $raw === '') return null;
    try {
        $meta = json_decode($raw, true, 8, JSON_THROW_ON_ERROR);
    } catch (\Throwable) {
        return null;
    }
    if (!is_array($meta) || !isset($meta['size']) || !is_int($meta['size']) || $meta['size'] < 1) return null;
    return ['size' => $meta['size'], 'mime' => is_string($meta['mime'] ?? null) ? $meta['mime'] : ''];
}

function tg_media_cache_is_complete(string $cachePath, ?int $expectedSize = null): bool
{
    $meta = tg_read_media_cache_metadata($cachePath);
    if ($meta === null || !is_file($cachePath)) return false;
    $size = (int)@filesize($cachePath);
    $required = $expectedSize ?? $meta['size'];
    return $size > 0 && $size === $required && $meta['size'] === $required;
}

function tg_write_media_cache_metadata(string $cachePath, int $expectedSize, string $mime): bool
{
    if ($expectedSize < 1 || !is_file($cachePath) || (int)@filesize($cachePath) !== $expectedSize) return false;
    $metaPath = tg_media_cache_metadata_path($cachePath);
    $metaTmp = $metaPath . '.' . uniqid('tmp_', true);
    try {
        $payload = json_encode(['size' => $expectedSize, 'mime' => $mime], JSON_THROW_ON_ERROR);
    } catch (\Throwable) {
        return false;
    }
    if (@file_put_contents($metaTmp, $payload, LOCK_EX) === false || !@rename($metaTmp, $metaPath)) {
        @unlink($metaTmp);
        return false;
    }
    return true;
}

function tg_publish_complete_media_cache(string $temporaryPath, string $cachePath, int $expectedSize, string $mime): bool
{
    if ($expectedSize < 1 || !is_file($temporaryPath) || (int)@filesize($temporaryPath) !== $expectedSize) return false;
    if (!@rename($temporaryPath, $cachePath)) return false;
    if (!tg_write_media_cache_metadata($cachePath, $expectedSize, $mime)) {
        @unlink($cachePath);
        return false;
    }
    return true;
}

function tg_forget_incomplete_media_cache(string $cachePath): void
{
    @unlink($cachePath);
    @unlink(tg_media_cache_metadata_path($cachePath));
}

/**
 * `downloadToFile` succeeds only after Madeline has completed the requested
 * object. This helper still checks the local write before making that result
 * visible to every cache reader.
 */
function tg_publish_downloaded_media_cache(string $temporaryPath, string $cachePath, string $mime): bool
{
    $size = is_file($temporaryPath) ? (int)@filesize($temporaryPath) : 0;
    return tg_publish_complete_media_cache($temporaryPath, $cachePath, $size, $mime);
}

/** @return string The tracked path, convenient for assignment. */
function tg_track_temporary_media_file(string $path): string
{
    $GLOBALS['__TG_TEMP_MEDIA_FILES__'][$path] = true;
    return $path;
}

function tg_untrack_temporary_media_file(string $path): void
{
    unset($GLOBALS['__TG_TEMP_MEDIA_FILES__'][$path]);
}

/** Request-local cleanup for client aborts and fatal PHP termination. */
function tg_cleanup_temporary_media_files(): void
{
    foreach (array_keys($GLOBALS['__TG_TEMP_MEDIA_FILES__'] ?? []) as $path) {
        if (is_string($path) && $path !== '') @unlink($path);
        unset($GLOBALS['__TG_TEMP_MEDIA_FILES__'][$path]);
    }
}

register_shutdown_function('tg_cleanup_temporary_media_files');
