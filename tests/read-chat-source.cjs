// Source-based legacy contracts need the implementation modules as well as
// the facade. Browser contracts continue to import the real ES modules.
const fs = require('node:fs');
const path = require('node:path');
module.exports = function readChatSource(file, encoding) {
  if (!String(file).replaceAll('\\', '/').endsWith('/BaseChat.js')) return fs.readFileSync(file, encoding);
  const root = path.dirname(path.resolve(file));
  const base = fs.readFileSync(file, encoding);
  const features = [...base.matchAll(/from '\.\/chat\/([^']+)';/g)].map(m => m[1].split('?')[0]);
  const avatars = fs.readFileSync(path.join(root, 'avatar.js'), 'utf8').replace(/^export /gm, '').replaceAll('import.meta.url', JSON.stringify('http://localhost/js/src/ui/avatar.js'));
  return [avatars, fs.readFileSync(path.join(root, 'chat/mediaArchive.js'), 'utf8').replace(/^export /gm, ''),
    ...features.map(name => fs.readFileSync(path.join(root, 'chat', name), 'utf8').replace(/^export class /gm, 'class ')), base].join('\n');
};
