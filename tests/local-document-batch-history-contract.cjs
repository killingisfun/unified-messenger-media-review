/* Exact-ID document-batch reconstruction.  Exercise the actual ChatAlbums
 * methods without a browser: these helpers must never fall back to a clock
 * window, because a slow upload can span several timestamps. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const filename = path.join(__dirname, '..', 'js/src/ui/chat/ChatAlbums.js');
let source = fs.readFileSync(filename, 'utf8');
source = source.replace("import { getProvider } from '../../domain/providers.js';", 'const getProvider = () => ({ id: \'telegram\' });');
source = source.replace('export class ChatAlbums', 'class ChatAlbums');
source += '\nmodule.exports = ChatAlbums;\n';
const mod = new Module(filename, module);
mod.filename = filename;
mod.paths = Module._nodeModulePaths(path.dirname(filename));
mod._compile(source, filename);
const ChatAlbums = mod.exports;

const documentMessage = (id, timestamp) => ({
  id: String(id), direction: 'out', timestamp,
  attachments: [{ type: 'document', source_type: 'document', filename: `file-${id}.jpg` }],
});

const makeChat = (components) => ({
  _readOutgoingOperations: () => [{ requestId: 'out_files_12345678', components }],
  _operationMatchesCurrentChat: () => true,
  _historyMessageId: (message) => String(message?.id || ''),
  _sortHistoryMessages: (messages) => messages.slice().sort((a, b) => a.timestamp - b.timestamp),
  _isDocumentAttachment: (attachment) => attachment?.source_type === 'document' || attachment?.type === 'document',
});

const accepted = ['101', '102', '103'].map((messageId, index) => ({
  kind: 'file', index, status: 'accepted', messageId,
}));
const albums = new ChatAlbums(makeChat(accepted));
const complete = albums._collapseLocalOutgoingDocumentBatches([
  documentMessage('101', 10), documentMessage('102', 25), documentMessage('103', 40),
]);
assert.equal(complete.length, 1, 'all exact native IDs from one operation become one card even when upload times differ');
assert.deepEqual(complete[0]._albumMessageIds, ['101', '102', '103'], 'aggregate preserves every native ID');
assert.equal(complete[0].attachments.length, 3, 'aggregate preserves every document attachment');
assert.match(complete[0].media_group_id, /^local-document-batch:out_files_12345678$/, 'synthetic group is request-scoped');

const partial = new ChatAlbums(makeChat(accepted))._collapseLocalOutgoingDocumentBatches([
  documentMessage('101', 10), documentMessage('102', 25),
]);
assert.equal(partial.length, 2, 'a partial history page is not presented as a complete batch');
assert.equal(partial.some(message => Array.isArray(message._albumMessageIds)), false, 'partial history contains no false aggregate');

const unconfirmed = new ChatAlbums(makeChat([
  accepted[0], { ...accepted[1], status: 'unknown' }, accepted[2],
]));
const unresolved = unconfirmed._collapseLocalOutgoingDocumentBatches([
  documentMessage('101', 10), documentMessage('102', 25), documentMessage('103', 40),
]);
assert.equal(unresolved.length, 3, 'unknown provider outcome cannot be visually promoted to a confirmed batch');
assert.equal(unresolved.some(message => String(message.media_group_id || '').startsWith('local-document-batch:')), false, 'unknown outcomes retain their native ungrouped state');

// Telegram gives every child a native grouped_id. This is stronger than a
// timestamp and must keep working when an unrelated incoming message arrives
// between two updates or when a polling page is not contiguous.
const nativeFirst = { ...documentMessage('201', 10), media_group_id: 'tg-native-docs-1' };
const interleaved = { id: 'in-1', direction: 'in', timestamp: 15, text: 'reply', attachments: [] };
const nativeSecond = { ...documentMessage('202', 20), media_group_id: 'tg-native-docs-1' };
const nativeGrouped = new ChatAlbums(makeChat([]))._collapseLocalOutgoingDocumentBatches([
  nativeFirst, interleaved, nativeSecond,
]);
assert.equal(nativeGrouped.length, 2, 'an exact native document group absorbs its non-contiguous children');
assert.equal(nativeGrouped[0].id, 'in-1', 'unrelated message remains independently ordered');
assert.deepEqual(nativeGrouped[1]._albumMessageIds, ['201', '202'], 'native group retains both provider IDs exactly once');
assert.equal(nativeGrouped[1]._nativeDocumentBatch, true, 'native group is distinct from local journal reconstruction');

// A native group often arrives one member at a time: a history page first,
// then realtime (or the next page).  The open-chat registry must enrich the
// existing identity rather than create a second single-file card.
const acrossUpdates = new ChatAlbums(makeChat([]));
const firstUpdate = acrossUpdates._collapseLocalOutgoingDocumentBatches([nativeFirst]);
assert.equal(firstUpdate.length, 1, 'one observed native document remains one row until a sibling is known');
const secondUpdate = acrossUpdates._collapseLocalOutgoingDocumentBatches([nativeSecond]);
assert.equal(secondUpdate.length, 1, 'the later native child updates one group presentation');
assert.deepEqual(secondUpdate[0]._albumMessageIds, ['201', '202'], 'the persistent registry retains the earlier exact child');

// A confirmed optimistic card can exist before the registry sees a history
// page. Seed its exact native members first; a later partial refresh must not
// split off or forget the image-document that was not included in that page.
const optimisticRegistry = new ChatAlbums(makeChat([]));
const brokenLegacyPhoto = {
  ...nativeFirst,
  attachments: [{ type: 'photo', mime: 'image/jpeg', filename: 'first.jpg' }],
};
optimisticRegistry.chat.messagesContainer = {
  querySelectorAll: () => [{
    dataset: { groupKey: 'gid:tg-native-docs-1' },
    _groupMessages: [brokenLegacyPhoto, nativeSecond, { ...documentMessage('203', 30), media_group_id: 'tg-native-docs-1' }],
  }],
};
optimisticRegistry._seedRenderedDocumentGroups();
const refreshedPartial = optimisticRegistry._collapseLocalOutgoingDocumentBatches([
  nativeSecond,
  { ...documentMessage('203', 30), media_group_id: 'tg-native-docs-1' },
]);
assert.equal(refreshedPartial.length, 1, 'a partial refresh replaces neither the old card nor one child');
assert.deepEqual(refreshedPartial[0]._albumMessageIds, ['201', '202', '203'], 'existing card membership is merged before the partial update renders');

console.log('local-document-batch-history-contract-ok');
