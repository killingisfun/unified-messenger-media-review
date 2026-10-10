/* Every common UI seam must agree that an image-MIME document is a document. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
let providers = fs.readFileSync(path.join(root, 'js/src/domain/providers.js'), 'utf8')
  .replace(/^export /gm, '');
const context = { globalThis: null };
context.globalThis = context;
vm.runInNewContext(`${providers}\nglobalThis.isDocumentAttachment=isDocumentAttachment;`, context);

const transportContext = { globalThis: { isDocumentPredicate: context.isDocumentAttachment } };
let transport = fs.readFileSync(path.join(root, 'js/src/ui/services/transports/whatsappAlbum.js'), 'utf8')
  .replace("import { isDocumentAttachment } from '../../../domain/providers.js';", 'const isDocumentAttachment = globalThis.isDocumentPredicate;')
  .replace('export const whatsappAlbumTransport', 'const whatsappAlbumTransport');
vm.runInNewContext(`${transport}\nglobalThis.whatsappAlbumTransport=whatsappAlbumTransport;`, transportContext);

for (const attachment of [
  { source_type: 'document', mime: 'image/jpeg' },
  { type: 'document', mime: 'image/png' },
  { type: 'photo', kind: 'document', mime: 'image/jpeg' },
]) {
  assert.equal(context.isDocumentAttachment(attachment), true, 'shared classifier recognizes every explicit document marker');
  assert.equal(transportContext.globalThis.whatsappAlbumTransport.isPhotoAlbumMember({ attachments: [attachment] }), false,
    'WhatsApp transport never inserts an explicit document into a photo album');
}
assert.equal(transportContext.globalThis.whatsappAlbumTransport.isPhotoAlbumMember({ attachments: [{ type: 'photo', mime: 'image/jpeg' }] }), true,
  'ordinary WhatsApp photo remains an album candidate');

const renderer = fs.readFileSync(path.join(root, 'js/src/ui/chat/MessageRenderer.js'), 'utf8');
assert.match(renderer, /members\.every\(member => Array\.isArray\(member\?\.attachments\)/,
  'only document groups use the generic replacement path');
console.log('attachment-classification-contract-ok');
