<?php
/**
 * Current unified UI over the established Madeline/WPP backend tunnel.
 *
 * Run locally only:
 *   php -S 127.0.0.1:18085 legacy-bridge-router.php
 *
 * The included router still uses an explicit allowlist. It enables normal
 * in-chat actions only after the browser presents its bridge session token.
 */

declare(strict_types=1);

putenv('UNIFIED_LEGACY_BRIDGE_MODE=active');
if (getenv('UNIFIED_REALTIME_URL') === false) {
    putenv('UNIFIED_REALTIME_URL=ws://127.0.0.1:18081');
}
// Pagination has a separate local worker. The main bridge may be an already
// running php -S process, so set safe defaults while handling every request;
// no restart is needed for the UI to discover the worker after reload.
if (getenv('UNIFIED_LEGACY_HISTORY_WORKER') === false) {
    putenv('UNIFIED_LEGACY_HISTORY_WORKER=1');
}
if (getenv('UNIFIED_LEGACY_HISTORY_WORKER_PORT') === false) {
    putenv('UNIFIED_LEGACY_HISTORY_WORKER_PORT=18091');
}
// The history worker mints media refs that point directly at the media pool.
// The main document must advertise the same allowlisted origins in its CSP,
// otherwise the browser blocks every cross-port image before it reaches a
// worker and leaves the UI showing a retry overlay.
if (getenv('UNIFIED_LEGACY_MEDIA_WORKER') === false) {
    putenv('UNIFIED_LEGACY_MEDIA_WORKER=1');
}
if (getenv('UNIFIED_LEGACY_MEDIA_WORKERS') === false) {
    putenv('UNIFIED_LEGACY_MEDIA_WORKERS=18087,18089,18090');
}

return require __DIR__ . '/live-readonly-router.php';
