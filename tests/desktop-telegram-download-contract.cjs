const fs = require('fs');

const host = fs.readFileSync('desktop/UnifiedMessenger.Desktop/Services/DesktopUiHost.cs', 'utf8');
const connection = fs.readFileSync('desktop/UnifiedMessenger.Desktop/Services/DirectConnection.cs', 'utf8');
const facade = fs.readFileSync('desktop_api.php', 'utf8');
const telegram = fs.readFileSync('src/Services/TelegramClient.php', 'utf8');
const telegramRest = fs.readFileSync('telegram_service/rest.php', 'utf8');
const telegramCache = fs.readFileSync('telegram_service/media_cache.php', 'utf8');
const mediaLoader = fs.readFileSync('js/src/ui/chat/MediaLoader.js', 'utf8');

if (!telegram.includes("'telegram_download.php?'")) {
  throw new Error('Telegram adapter no longer emits its production download route.');
}
if (!host.includes('path.Equals("/telegram_download.php", StringComparison.OrdinalIgnoreCase)')) {
  throw new Error('Desktop host does not intercept the Telegram download route.');
}
if (!host.includes('ForwardTelegramDownloadAsync')) {
  throw new Error('Telegram download route is missing its constrained native handler.');
}
for (const expression of [
  'TelegramChatIdPattern',
  'TelegramMessageIdPattern',
  'TelegramOptionalFlagValuesAreValid',
  'pair.Key is not ("chat_id" or "message_id" or "name" or "inline" or "dl" or "thumb" or "kind" or "r")',
]) {
  if (!host.includes(expression)) throw new Error(`Telegram download input guard missing: ${expression}`);
}
if (!host.includes('Shared media retry adds a numeric cache buster')
  || !host.includes('CacheBusterPattern.IsMatch(cacheBuster)')) {
  throw new Error('Telegram media retry cache buster must be accepted by the desktop download route.');
}
if (!host.includes('["telegram_action"] = source.TryGetValue("thumb", out var thumb) && thumb == "1" ? "downloadThumb" : "downloadMedia"')) {
  throw new Error('Telegram download route does not preserve the thumbnail/media distinction.');
}
if (!host.includes('var rangeHeaders = ReadSingleRangeHeader(request);')
  || !host.includes('requestHeaders: rangeHeaders')
  || !host.includes('Range not satisfiable')) {
  throw new Error('Desktop Telegram relay must preserve a native video byte-range request.');
}
if (!host.includes('SendTelegramMediaWithThumbnailFallbackAsync')
  || !host.includes('X-Unified-Telegram-Thumbnail-Placeholder')
  || !host.includes('legacyTinyPngPlaceholder')
  || !host.includes('parameters["telegram_action"] = "downloadMedia"')
  || !host.includes('canFallbackToOriginalImage')
  || !host.includes('kind.Equals("photo"')) {
  throw new Error('Only an image thumbnail may retry the authenticated original relay.');
}
if (!host.includes('SemaphoreSlim _telegramMediaOpenGate = new(3, 3)')
  || !host.includes('CreateTelegramMediaResponseAsync')
  || !host.includes('CreateTelegramMediaTrace')
  || !host.includes('X-Unified-Media-Trace')
  || !host.includes('telegram_media_headers')
  || !host.includes('telegram_media_body')
  || !host.includes('new ResponseOwnedStream(')
  || !host.includes('_telegramMediaOpenGate.Release();')
  || !host.includes('new CancellationTokenSource(TimeSpan.FromSeconds(10))')
  || !host.includes('parameters["kind"] = mediaKind')
  || !host.includes('contentLength is long expected && totalRead >= expected')
  || !host.includes('requestedCount == 0 || Volatile.Read(ref _ownersReleased) != 0')
  || !host.includes('catch\n            {\n                DisposeOwners();')) {
  throw new Error('Telegram response opening and ownership lifecycle must remain bounded and safe.');
}
if (!telegram.includes("'kind' => strtolower($type)")) {
  throw new Error('Telegram attachment URLs must carry a bounded media kind for the desktop relay.');
}
const renderer = fs.readFileSync('js/src/ui/chat/MessageRenderer.js', 'utf8');
if (!renderer.includes("const poster = att.preview || att.thumbnail || this.chat._videoPoster;")
  || !renderer.includes("const posterAttr = ` data-lazy-poster=")) {
  throw new Error('Every provider video must retain an image-only poster contract.');
}
if (!host.includes('"chatId"] = chatId') || !host.includes('"messageId"] = messageId')) {
  throw new Error('Telegram download route does not map bounded identifiers to the relay contract.');
}
if (!connection.includes('"telegram_media"')) {
  throw new Error('Desktop API client does not permit Telegram media relay.');
}
if (!facade.includes("'telegram_media'")) {
  throw new Error('Authenticated server facade does not permit Telegram media relay.');
}
if (!telegramRest.includes("require_once dirname(__DIR__) . '/config.php';")) {
  throw new Error('Nested Telegram media route must not load config.php twice and corrupt binary responses.');
}
if (telegramRest.includes("require dirname(__DIR__) . '/config.php';")) {
  throw new Error('Nested Telegram media route still has a duplicate config.php require.');
}
if (!telegramRest.includes("header('X-Unified-Telegram-Thumbnail-Placeholder: 1');")) {
  throw new Error('Telegram thumbnail placeholder must be explicit for the native relay.');
}
for (const expression of [
  'function tg_is_thumbnail_placeholder',
  'getMessages for a channel can omit document thumbs',
  "'offset_id' => $mid + 1, 'limit' => 1",
  "'photoStrippedSize'",
  "['thumb_size'] = $thumbSize",
  'downloadToCallable(',
  "header('X-Accel-Buffering: no');",
  'Cache only a true full-file read',
  '$downloadEndExclusive = $end + 1;',
  'tg_media_cache_is_complete',
  'tg_publish_complete_media_cache',
  'tg_track_temporary_media_file',
  'headers_sent() || !empty($GLOBALS[\'__TG_BINARY_BODY_STARTED__\'])',
]) {
  if (!telegramRest.includes(expression)) throw new Error(`Telegram responsive media contract missing: ${expression}`);
}
for (const expression of [
  'function start_madeline_media_ipc_client',
  '$isDesktopVideo',
  '$isDesktopVideoPoster',
  'start_madeline_media_ipc_client()',
  'function tg_media_trace',
  "tg_media_trace('thumb_ready'",
  '$cacheWholeFile = !$isDesktopVideo',
]) {
  if (!telegramRest.includes(expression)) throw new Error(`Telegram IPC video range contract missing: ${expression}`);
}
for (const expression of [
  'function tg_cleanup_temporary_media_files',
  'function tg_media_cache_is_complete',
  'function tg_publish_complete_media_cache',
]) {
  if (!telegramCache.includes(expression)) throw new Error(`Telegram cache contract missing: ${expression}`);
}
if (!mediaLoader.includes("&& window.APP_CONFIG?.desktopMode !== true)")) {
  throw new Error('Desktop must not call the legacy Telegram batch-prefetch endpoint through its virtual UI host.');
}
if (!mediaLoader.includes("? '640px 0px'")) {
  throw new Error('Telegram poster prefetch margin must stay ahead of the visible timeline.');
}
for (const expression of [
  '_bc_retryTimer',
  '_bc_retryGeneration',
  'this.chat.lifetime.clearTimeout(el._bc_retryTimer)',
  '_bc_lastFailureAt',
  "el.tagName === 'VIDEO'",
  'canplay: clear, error',
]) {
  if (!mediaLoader.includes(expression)) throw new Error(`Media failure lifecycle contract missing: ${expression}`);
}
if (!mediaLoader.includes("target.dataset.bcHasPoster = '1'")) {
  throw new Error('A real video poster must be visible before canplay.');
}
for (const expression of [
  '_startDeferredVideo',
  '_bindDeferredVideoStart',
  "video.dataset.deferVideo !== '1'",
  "target.dataset.deferVideo === '1'",
  "video.preload = 'metadata'",
  "if (video.dataset.deferVideo === '1') return;",
]) {
  if (!mediaLoader.includes(expression)) throw new Error(`Video poster activation contract missing: ${expression}`);
}
if (mediaLoader.includes("this._startDeferredVideo(video, false)")) {
  throw new Error('A deferred video error must not start MP4 loading without Play.');
}
for (const expression of [
  "const poster = att.preview || att.thumbnail || this.chat._videoPoster;",
  "const deferredAttr = ' data-defer-video=\"1\"';",
  "const preload = 'none';",
  "const motion = detectedMotion === 'note' ? '' : detectedMotion;",
]) {
  if (!renderer.includes(expression)) throw new Error(`Every provider video must use the play-only stream contract: ${expression}`);
}
if (!mediaLoader.includes("element.tagName === 'VIDEO' && element.dataset.deferVideo === '1'")) {
  throw new Error('A deferred video must not occupy a provider media queue before Play.');
}
const runtimeCss = fs.readFileSync('js/src/ui/styles/chat-runtime.css', 'utf8');
if (!runtimeCss.includes('video[data-bc-has-poster="1"] { visibility:visible; }')
  || !runtimeCss.includes('.video-player:has(video[data-bc-has-poster="1"]) > .bc-spin { display:none !important; }')) {
  throw new Error('The loading surface must not hide a loaded video poster.');
}

console.log('desktop-telegram-download-contract: ok');
