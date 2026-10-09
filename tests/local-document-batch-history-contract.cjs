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

const partial = albums._collapseLocalOutgoingDocumentBatches([
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

console.log('local-document-batch-history-contract-ok');
