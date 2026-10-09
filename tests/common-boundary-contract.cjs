const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let providers = fs.readFileSync('js/src/domain/providers.js', 'utf8')
  .replace(/export const /g, 'const ')
  .replace(/export function /g, 'function ')
  .concat('\nglobalThis.contract = { normalizeMessage, mergeMessageUpdate, getFeatureAvailability };');
const context = { globalThis: null };
context.globalThis = context;
vm.runInNewContext(providers, context, { filename: 'providers.js' });
const { normalizeMessage, mergeMessageUpdate, getFeatureAvailability } = context.contract;

const history = normalizeMessage('WhatsApp', { id: 'fixture-1', text: 'before', attachments: [] });
assert.equal(mergeMessageUpdate('WhatsApp', history, { id: 'fixture-1', message_text: 'after' }).text, 'after', 'WPP message_text updates a rendered bubble');
assert.equal(mergeMessageUpdate('WhatsApp', history, normalizeMessage('WhatsApp', { id: 'fixture-1', ack: 3 })).text, 'before', 'receipt without text keeps history text');
const capabilities = JSON.parse(fs.readFileSync('config/provider-capabilities.json', 'utf8'));
for (const source of ['Telegram', 'WhatsApp', 'VK', 'Avito', 'MAX']) {
  assert.equal(getFeatureAvailability(source, 'message', null, capabilities[source]).enabled, true, `${source} explicitly enables text composer`);
}
const api = fs.readFileSync('js/src/core/ApiService.js', 'utf8');
assert.ok(api.includes('_normalizeHistoryResponse(data)'), 'history has one strict wire normalizer');
assert.ok(api.includes('Сервис вернул неполную историю сообщений.'), 'malformed history does not become an empty chat');
const outbox = fs.readFileSync('js/src/ui/chat/ChatOutbox.js', 'utf8');
assert.ok(outbox.includes('readScopedSelfProfile(source, this.chat._outgoingAccountKey)'), 'account identity does not use a provider-only cache');
console.log('common-boundary-contract-ok');
