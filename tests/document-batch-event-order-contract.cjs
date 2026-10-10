/*
 * A presentation aggregate has one canonical id, but it represents several
 * provider messages. This contract drives the common render entry point and
 * proves that reconciliation sees each native child before visual grouping.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const filename = path.join(__dirname, '..', 'js', 'src', 'ui', 'chat', 'MessageRenderer.js');
let source = fs.readFileSync(filename, 'utf8');
source = source.replace(/^import .*;\r?\n/gm, '');
source = `
  const originalAvatar = value => value;
  class MotionMedia {}
  const motionKind = () => '';
  const getProvider = () => ({ id: 'telegram' });
  const hasKnownReactions = () => false;
  const mergeMessageUpdate = (_, previous, patch) => ({ ...previous, ...patch,
    attachments: Array.isArray(patch.attachments) && patch.attachments.length ? patch.attachments : (previous.attachments || []) });
  const normalizeMessage = (_, value) => value;
  const renderMessageActions = () => '';
  const renderMessageQuote = () => '';
${source}`;
source = source.replace('export class MessageRenderer', 'class MessageRenderer');
source += '\nmodule.exports = MessageRenderer;\n';
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(source, filename);
const MessageRenderer = mod.exports;

const child = (id) => ({
  id,
  direction: 'out',
  timestamp: 100,
  attachments: [{ type: 'document', source_type: 'document', filename: `file-${id}.jpg` }],
});
const first = child('101');
const second = child('102');
const aggregate = {
  ...second,
  attachments: [...first.attachments, ...second.attachments],
  _albumMessageIds: ['101', '102'],
  _albumMessages: [first, second],
};

const reconciled = [];
const consumed = [];
let collapseInput = null;
const chat = {
  _isActiveInstance: () => true,
  _messageForCurrentChat: message => message,
  _reconcileOutgoingOperations(messages) { reconciled.push(...messages.map(message => message.id)); },
  _onMessageReactionsUpdated() {},
  _normalizeReactions: value => value,
  _consumeOptimisticMessage(message) { consumed.push(message.id); return true; },
  _collapseLocalOutgoingDocumentBatches(messages) { collapseInput = messages; return messages; },
  _collapseWhatsAppPhotoAlbums: messages => messages,
  _upsertIncomingNativeAlbum: () => false,
};

const originalDocument = global.document;
global.document = { createDocumentFragment: () => ({ childNodes: [] }) };
try {
  const added = new MessageRenderer(chat).renderMessagesBatch([aggregate]);
  assert.equal(added, 0, 'fully consumed native children do not add standalone cards');
  assert.deepEqual(reconciled, ['101', '102'], 'operation reconciliation receives every provider child, not the aggregate id');
  assert.deepEqual(consumed, ['101', '102'], 'each child is consumed exactly once before presentation grouping');
  assert.deepEqual(collapseInput, [], 'the visual collapse receives only rows not already reconciled');
} finally {
  global.document = originalDocument;
}

// A short receipt and a full snapshot can appear in the same rendering
// response. They represent one native message and must keep the attachment.
const merged = new MessageRenderer(chat)._expandMessagesForReconciliation([
  { id: '103', direction: 'out', ack: 1 },
  child('103'),
]);
assert.equal(merged.length, 1, 'duplicate native IDs become one reconciliation record');
assert.equal(merged[0].attachments.length, 1, 'the later full snapshot is not discarded after a receipt');

// Replacement is two-phase: an incomplete/malformed next card must not erase
// the already rendered complete group before a new DOM node exists.
let removed = false;
const existingGroup = {
  dataset: { groupKey: 'gid:tg-native-docs-1', messageIds: '101,102,103' },
  _groupMessages: [child('101'), child('102'), child('103')],
  remove() { removed = true; },
};
const refreshChat = {
  messagesContainer: { querySelectorAll: () => [existingGroup] },
  renderedMessageIds: new Set(['101', '102', '103']),
  _msgIdToGroupKey: new Map([['101', 'gid:tg-native-docs-1']]),
  _groupKeyToEl: new Map([['gid:tg-native-docs-1', existingGroup]]),
};
const refreshRenderer = new MessageRenderer(refreshChat);
const refresh = refreshRenderer._prepareRenderedDocumentGroupRefresh({
  media_group_id: 'tg-native-docs-1', _albumMessageIds: ['101', '102'],
});
assert.equal(removed, false, 'old card remains visible while the replacement is only being prepared');
refresh.restore();
assert.deepEqual([...refreshChat.renderedMessageIds].sort(), ['101', '102', '103'], 'a failed replacement restores every existing component id');
const commit = refreshRenderer._prepareRenderedDocumentGroupRefresh({
  media_group_id: 'tg-native-docs-1', _albumMessageIds: ['101', '102', '103'],
});
commit.commit();
assert.equal(removed, true, 'old group is removed only when caller has built the replacement');

console.log('document-batch-event-order-contract-ok');
