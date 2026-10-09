const assert = require('node:assert/strict');
const fs = require('node:fs');

const loader = fs.readFileSync('js/src/ui/chat/MediaLoader.js', 'utf8');
const renderer = fs.readFileSync('js/src/ui/chat/MessageRenderer.js', 'utf8');
const maxApi = fs.readFileSync('max_api.php', 'utf8');
const desktopApi = fs.readFileSync('desktop_api.php', 'utf8');
const sidecar = fs.readFileSync('max_service/app.py', 'utf8');
const host = fs.readFileSync('desktop/UnifiedMessenger.Desktop/Services/DesktopUiHost.cs', 'utf8');

assert.match(loader, /_replaceAttachedMediaUrls\(el, oldUrl, newUrl\)/);
assert.match(loader, /\['href', 'src', 'data-lazy-src', 'data-fallback-src', 'data-download-url'\]/);
assert.match(loader, /this\.chat\.api\._asyncFetchRaw\(/);
assert.match(loader, /this\.chat\.lifetime\.add\(cancelForChat\)/);
assert.match(loader, /_bc_mediaRefreshGeneration/);
assert.match(loader, /resource', 'media_ref'/);
assert.match(renderer, /data-media-refresh-account-id/);
assert.match(maxApi, /\$resource === 'media_ref'/);
assert.match(desktopApi, /\$action === 'max_media_ref'/);
assert.match(sidecar, /async def refresh_media_token/);
assert.match(sidecar, /max_media_ref_account_changed/);
assert.match(sidecar, /app\.router\.add_get\("\/v1\/media-ref", media_ref\)/);
assert.match(host, /ForwardMaxMediaReferenceAsync/);
assert.match(host, /totalDeadline\.CancelAfter\(TimeSpan\.FromMinutes\(20\)\)/);
assert.match(host, /idleDeadline\.CancelAfter\(TimeSpan\.FromSeconds\(45\)\)/);

console.log('media-refresh-followup-contract-ok');
