const assert = require('node:assert/strict');
const fs = require('node:fs');

const api = fs.readFileSync('js/src/core/ApiService.js', 'utf8');
const media = fs.readFileSync('js/src/ui/chat/MediaUrls.js', 'utf8');

assert.match(api, /for \(const reader of \['arrayBuffer', 'blob', 'formData', 'json', 'text'\]\)/,
  'response readers are covered by the request cleanup lifecycle');
assert.match(api, /Promise\.resolve\(original\.apply\(response, args\)\)\.finally\(finish\)/,
  'the deadline is cleared only after the response body reader settles');
assert.match(api, /response\.unifiedFinish = finish/,
  'raw no-body consumers have an explicit cleanup hook');
assert.match(media, /await response\?\.body\?\.cancel\?\.\(\);\s*response\?\.unifiedFinish\?\.\(\);/,
  'media URL probe cancels an ignored GET body and clears its deadline');

console.log('api-response-timeout-contract-ok');
