/* The final acknowledgement must replace one optimistic batch with one
 * aggregate DOM card.  This runs the real ChatOutbox method with a tiny DOM
 * seam rather than testing a copy of the algorithm. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const filename = path.join(__dirname, '..', 'js/src/ui/chat/ChatOutbox.js');
let source = fs.readFileSync(filename, 'utf8');
source = source.replace("import { originalAvatar } from '../avatar.js';", 'const originalAvatar = value => value;');
source = source.replace("import { getProvider, normalizeMessage, validateAttachmentSelection } from '../../domain/providers.js';", 'const getProvider = () => ({ id: \'telegram\' }); const normalizeMessage = (_, value) => value; const validateAttachmentSelection = () => null;');
source = source.replace("import { readScopedSelfProfile, selfProfileAccountKey, writeScopedSelfProfile } from '../../core/selfProfileCache.js';", 'const readScopedSelfProfile = () => null; const selfProfileAccountKey = () => \'telegram:test\'; const writeScopedSelfProfile = () => {};');
source = source.replace("import { renderMessageActions } from '../components/MessageActions.js';", 'const renderMessageActions = () => \'\';');
source = source.replace('export class ChatOutbox', 'class ChatOutbox');
source += '\nmodule.exports = ChatOutbox;\n';
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(source, filename);
const ChatOutbox = mod.exports;

const ids = ['101', '102', '103'];
const messages = ids.map((id, index) => ({
  id, direction: 'out', timestamp: 100 + index * 15,
  attachments: [{ type: 'document', source_type: 'document', filename: `file-${id}.jpg` }],
}));
let rendered = null;
let observed = null;
let groupRegistered = null;
const chat = {
  source: 'Telegram',
  renderedMessageIds: new Set(ids),
  _batchExpectedIds: () => ids,
  _batchOptimisticByMessageId: new Map(ids.map(id => [id, true])),
  renderMessage(message) {
    rendered = message;
    return { dataset: {}, _originalData: message };
  },
  _registerGroup(node) { groupRegistered = node; },
  _computeAggregatedReactions: (nativeIds) => ({ nativeIds }),
  _renderGroupReactions: () => {},
  _pendingMediaRoots: new Set(),
  observeNewMedia(node) { observed = node; },
};
const element = {
  isConnected: true,
  dataset: { batchTotal: '3', sendRequestId: 'out_files_12345678' },
  _batchMessages: new Map(messages.map(message => [message.id, message])),
  replaceWith(node) { this.replacement = node; },
};

new ChatOutbox(chat)._completeBatchReconciliation(element);
assert.equal(rendered.attachments.length, 3, 'one render receives every confirmed file');
assert.deepEqual(rendered._albumMessageIds, ids, 'aggregate carries every exact native ID');
assert.equal(element.replacement, observed, 'the optimistic node is replaced once, not followed by standalone rows');
assert.equal(groupRegistered, observed, 'aggregate keeps shared group controls');
assert.equal(observed.dataset.messageIds, '101,102,103', 'DOM tracks all IDs for later realtime de-duplication');
assert.match(observed.dataset.groupKey, /^gid:tg-local-batch:out_files_12345678$/, 'DOM group is scoped to the request');
assert.deepEqual([...chat.renderedMessageIds].sort(), ids, 'all native IDs remain handled after replacement');
assert.equal(chat._batchOptimisticByMessageId.size, 0, 'no stale optimistic/native mapping survives');

// A receipt-only realtime event proves that an id exists, but it has no
// attachment payload. It must not complete a document batch with a blank
// child while the authoritative history snapshot is still on its way.
const receiptOnlyElement = {
  isConnected: true,
  dataset: { batchTotal: '3', expectedMessageIds: ids.join(',') },
  _batchMessages: new Map(),
  querySelector() { return null; },
};
const receiptOnlyChat = {
  ...chat,
  messagesContainer: {
    querySelectorAll(selector) {
      return selector === '.message.out[data-expected-message-ids]' ? [receiptOnlyElement] : [];
    },
  },
  renderedMessageIds: new Set(),
  _batchOptimisticByMessageId: new Map(),
  _isReceiptRead: () => false,
  _markBatchReceipt: () => {},
};
const receiptOnlyOutbox = new ChatOutbox(receiptOnlyChat);
let completionCalls = 0;
receiptOnlyOutbox._completeBatchReconciliation = () => { completionCalls++; };
assert.equal(receiptOnlyOutbox._consumeOptimisticMessage({ id: '101', direction: 'out', ack: 1, attachments: [] }), true,
  'an exact receipt-only event is consumed without creating a second bubble');
assert.equal(receiptOnlyElement._batchMessages.size, 0, 'receipt-only event is not stored as an attachment snapshot');
assert.equal(completionCalls, 0, 'receipt-only event cannot finish the visual document batch');

console.log('local-document-batch-reconciliation-contract-ok');
