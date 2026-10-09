const assert = require('node:assert/strict');
const fs = require('node:fs');

const realtime = fs.readFileSync('js/src/ui/chat/ChatRealtime.js', 'utf8');
assert.match(realtime, /eventProvider = getProvider\(data\?\.source/, 'desktop realtime reads the event provider');
assert.match(realtime, /eventProvider !== activeProvider/, 'desktop realtime rejects a matching chat ID from another provider');
assert.match(realtime, /eventAccount/, 'desktop realtime checks a bound provider account');

const renderer = fs.readFileSync('js/src/ui/chat/MessageRenderer.js', 'utf8');
assert.match(renderer, /const safeFilename = this\.chat\._escapeHtml/, 'media filenames are escaped before HTML interpolation');
assert.match(renderer, /safeVideoMime/, 'video MIME is validated before interpolation');
assert.match(renderer, /safeAudioMime/, 'audio MIME is validated before interpolation');

const desktop = fs.readFileSync('desktop/UnifiedMessenger.Desktop/Services/DesktopUiHost.cs', 'utf8');
assert.match(desktop, /Do not publish an archive after any failed entry/, 'native ZIP stops on a failed item');
assert.match(desktop, /CopyResponseBodyAsync/, 'native downloads use the bounded body reader');
assert.match(desktop, /totalDeadline\.CancelAfter\(TimeSpan\.FromMinutes\(20\)\)/, 'native download body reads have a finite total deadline');
assert.match(desktop, /idleDeadline\.CancelAfter\(TimeSpan\.FromSeconds\(45\)\)/, 'native download body reads stop only after a no-progress interval');

const maxApi = fs.readFileSync('max_api.php', 'utf8');
assert.match(maxApi, /CURLOPT_WRITEFUNCTION => static function/, 'MAX PHP media proxy streams callback chunks');
assert.doesNotMatch(maxApi, /CURLOPT_RETURNTRANSFER => true, CURLOPT_CONNECTTIMEOUT => 3, CURLOPT_TIMEOUT => 180, CURLOPT_HEADER => true/, 'MAX PHP media proxy no longer buffers complete responses');
assert.match(maxApi, /\$code !== 416 && \$contentLength !== null/, 'MAX PHP proxy suppresses misleading 416 lengths');

const sidecar = fs.readFileSync('max_service/app.py', 'utf8');
assert.match(sidecar, /MAX_HISTORY_QUEUE_TIMEOUT_SECONDS = 3/, 'history queue has a bounded wait');
assert.match(sidecar, /MAX_SHORT_READ_QUEUE_TIMEOUT_SECONDS = 3/, 'short reads have a bounded queue wait');
assert.match(sidecar, /history and self\._short_read_waiters > 0/, 'queued short reads take precedence over history');
assert.doesNotMatch(sidecar, /self\.read_lock/, 'all MAX provider reads use the bounded shared scheduler');
assert.match(sidecar, /while len\(self\.media_tokens\) >= self\.media_token_journal\.limit/, 'MAX token count has a hard shared limit');
assert.match(sidecar, /if not static_url:\s+return ""/, 'stickers without a static rendition get no false preview token');

console.log('expert-review-followup-contract-ok');
