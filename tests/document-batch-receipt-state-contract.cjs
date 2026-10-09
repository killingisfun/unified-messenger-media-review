/* A visual document batch has several native Telegram messages. Its receipt
 * must be the weakest component state, while accepted is only a sent check. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const context = { globalThis: null };
context.globalThis = context;
const whatsapp = fs.readFileSync(`${__dirname}/../js/src/core/whatsappReceipts.js`, 'utf8').replace(/^export /gm, '');
const states = fs.readFileSync(`${__dirname}/../js/src/core/messageStates.js`, 'utf8')
  .replace(/^import[^;]+;\r?\n/gm, '').replace(/^export /gm, '');
vm.runInNewContext(`${whatsapp}\n${states}\nglobalThis.MessageStateStore=MessageStateStore;globalThis.messageStateView=messageStateView;`, context);
let receipts = fs.readFileSync(`${__dirname}/../js/src/ui/chat/MessageReceipts.js`, 'utf8')
  .replace(/^import \{ messageStateView \}[^;]+;\r?\n/m, '')
  .replace(/^import \{ getProvider \}[^;]+;\r?\n/m, 'const getProvider = () => ({ id: \'telegram\' });\n')
  .replace('export class MessageReceipts', 'class MessageReceipts');
vm.runInNewContext(`${receipts}\nglobalThis.MessageReceipts=MessageReceipts;`, context);

const store = new context.MessageStateStore();
const chat = { source: 'Telegram', chatDbId: '42', _messageStates: store };
const receiptsView = new context.MessageReceipts(chat);
const members = ['301', '302'].map(id => ({ id, direction: 'out', attachments: [{ type: 'document' }] }));
store.merge('Telegram', '42', { id: '301', direction: 'out', send_state: 'accepted' });
store.merge('Telegram', '42', { id: '302', direction: 'out', send_state: 'accepted' });
let group = receiptsView._mergeMessageState({ id: '302', direction: 'out', _albumMessages: members });
assert.equal(group.ack, 1, 'all accepted components render one sent check');
assert.equal(group.send_state, 'sent', 'acceptance is not promoted to delivery/read');

store.merge('Telegram', '42', { id: '301', direction: 'out', send_state: 'delivered' });
group = receiptsView._mergeMessageState({ id: '302', direction: 'out', _albumMessages: members });
assert.equal(group.send_state, 'sent', 'a delivered last component cannot overstate another accepted component');

store.merge('Telegram', '42', { id: '301', direction: 'out', send_state: 'rejected' });
group = receiptsView._mergeMessageState({ id: '302', direction: 'out', _albumMessages: members });
assert.equal(group.ack, -1, 'a failed component fails the whole visual batch');
assert.equal(group.send_state, 'failed', 'group exposes the terminal component failure');

console.log('document-batch-receipt-state-contract-ok');
