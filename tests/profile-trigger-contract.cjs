const assert = require('node:assert/strict');
const fs = require('node:fs');

const shell = require('./read-chat-source.cjs')(`${__dirname}/../js/src/controllers/uiShell.js`, 'utf8');
const glue = require('./read-chat-source.cjs')(`${__dirname}/../js/src/controllers/spaGlue.js`, 'utf8');
const chat = require('./read-chat-source.cjs')(`${__dirname}/../js/src/ui/BaseChat.js`, 'utf8');
const css = require('./read-chat-source.cjs')(`${__dirname}/../js/src/ui/styles/messenger.css`, 'utf8');

assert.doesNotMatch(shell, /contact-info-btn[^\n]*contact-profile-trigger/, 'own-profile button must not programmatically click the contact button');
assert.match(glue, /ownProfileTrigger\?\.addEventListener\('click', showOwnProfile\)/, 'only spa glue opens the own profile');
assert.match(glue, /contactTrigger\?\.addEventListener\('click', showContactProfile\)/, 'only spa glue opens the contact profile');
assert.match(shell, /updateProfileAvailability/, 'profile actions use the fetched capability contract');
assert.match(shell, /profile-details-unavailable/, 'an unavailable contact profile is marked without changing the header identity');
assert.match(css, /contact-trigger\.profile-details-unavailable:disabled \{ cursor: default; opacity: 1; \}/, 'disabled contact details do not fade name or avatar');
assert.match(chat, /_applyCapabilityVisibility\(\)/, 'presence uses the fetched capability contract');
assert.match(chat, /Telegram пока поддерживает цитату только для нативного альбома/, 'unsupported single-file Telegram quote is explained before send');

console.log('profile-trigger-contract-ok');
