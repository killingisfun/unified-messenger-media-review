const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

let source = fs.readFileSync('js/src/ui/chat/SendJournal.js', 'utf8');
source = source.replace('export class SendJournal', 'class SendJournal');
source += '\n;globalThis.SendJournal = SendJournal;';
const sandbox = { globalThis: {} };
sandbox.globalThis.globalThis = sandbox.globalThis;
vm.runInNewContext(source, sandbox, { filename: 'SendJournal.js' });

const journal = new sandbox.globalThis.SendJournal({});
const components = journal._normalizeOperationComponents([], [
  { name: 'one.jpg', size: 10 }, { name: 'two.jpg', size: 20 },
], {
  success: true, single_message_album: true, attachment_count: 2,
  message_id: '117336269561226880', message_ids: ['117336269561226880'],
});

assert.deepEqual(JSON.parse(JSON.stringify(components)), [{
  key: 'album:0', index: 0, kind: 'album', status: 'accepted',
  messageId: '117336269561226880', name: 'Альбом MAX (2)', size: 30,
}], 'one MAX album message has one durable acknowledgement component');
console.log('max-album-journal-contract-ok');
