const assert = require('node:assert/strict');
const fs = require('node:fs');

const outbox = fs.readFileSync('js/src/ui/chat/ChatOutbox.js', 'utf8');
const gallery = fs.readFileSync('js/src/ui/chat/MediaGallery.js', 'utf8');

assert.match(outbox, /_optimisticObjectUrls = new Set/, 'outgoing blob URLs are retained under the optimistic bubble owner');
assert.match(outbox, /this\.chat\.lifetime\.add\(\(\) => this\._revokeOptimisticObjectUrls\(element\)\)/,
  'chat destruction revokes remaining optimistic blob URLs');
assert.match(gallery, /if \(failures\.length\) \{\s*\/\/ A ZIP with an ordinary final name/s,
  'a partially fetched archive is not published under a final ZIP name');
assert.match(gallery, /replace\(\/\[\\\\\/:\*\?"<>\|\]\+\/g, '_'\)/,
  'rendered download names remove quote and markup metacharacters');

console.log('outgoing-blob-zip-cleanup-contract-ok');
