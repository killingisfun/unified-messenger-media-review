const assert = require('node:assert/strict');
const fs = require('node:fs');

const source = fs.readFileSync('js/src/controllers/mainPage.js', 'utf8');
const handler = source.slice(source.indexOf('function handleRealtimeEvent'), source.indexOf('// --- WebSocket ---'));

assert.match(handler, /const eventSource = String\(data\.source \|\| ''\)\.trim\(\)\.toLowerCase\(\)/,
  'realtime events retain their declared provider source');
assert.match(handler, /activeSource === 'whatsapp'/,
  'the legacy bridge handler is scoped to an active WhatsApp pane');
assert.match(handler, /\(!eventSource \|\| eventSource === 'whatsapp'\)/,
  'MAX and other sourced events cannot enter the WhatsApp-specific path');

console.log('realtime-source-isolation-contract-ok');
