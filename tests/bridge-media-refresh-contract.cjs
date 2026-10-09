const assert = require('node:assert/strict');
const fs = require('node:fs');

const bridge = fs.readFileSync('live-readonly-router.php', 'utf8');
const loader = fs.readFileSync('js/src/ui/chat/MediaLoader.js', 'utf8');

assert.match(bridge, /function live_media_refresh_relay_url\(string \$id\): array/,
  'the bridge has a session-bound media renewal operation');
assert.match(bridge, /\$path === '\/bridge-media-refresh'/,
  'the bridge exposes a narrow refresh route');
assert.match(bridge, /\['telegram', 'wa', 'wa_preview', 'local'\]/,
  'only typed stable attachment identities may renew');
assert.match(bridge, /MAX sidecar tokens[\s\S]*?excluded/,
  'MAX/CDN capabilities are not persisted as renewable upstream URLs');
assert.match(loader, /async _renewBridgeMediaUrl\(rawUrl, el, generation\)/,
  'the UI asks the bridge for a replacement before retrying media');
assert.match(loader, /new URL\('\/bridge-media-refresh', window\.location\.href\)/,
  'refresh always goes to the canonical bridge origin, not an arbitrary media worker');
assert.match(loader, /media_ref_refresh_unavailable/,
  'the UI stops retrying a link the bridge cannot safely renew');
assert.match(loader, /Ссылка на вложение истекла\. Обновите чат\./,
  'the final UI state explains how to recover an expired media link');

console.log('bridge-media-refresh-contract-ok');
