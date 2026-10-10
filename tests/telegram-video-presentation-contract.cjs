const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const renderer = read('js/src/ui/chat/MessageRenderer.js');
const loader = read('js/src/ui/chat/MediaLoader.js');
const outbox = read('js/src/ui/chat/ChatOutbox.js');
const runtime = read('js/src/ui/styles/chat-runtime.css');
const expect = (condition, message) => { if (!condition) throw new Error(message); };

// A provider poster is an image contract, never the MP4 itself. The renderer
// must accept all normalized aliases and sanitize the selected URL.
expect(renderer.includes('att.poster || att.preview_url || att.preview || att.thumbnail'), 'video renderer does not consume the normalized poster aliases');
expect(renderer.includes('this.chat._safeRemoteUrl(posterCandidate)'), 'video poster bypasses URL validation');
expect(renderer.includes("String(displayUrl || openUrl || '').startsWith('blob:')"), 'local optimistic video is not distinguished from remote media');
expect(renderer.includes("const deferredAttr = localVideo ? '' : ' data-defer-video=\"1\"'"), 'local video is still deferred behind a black poster');
expect(renderer.includes("probe.canPlayType?.(safeVideoMime)") && renderer.includes('Формат видео не поддерживается встроенным проигрывателем'),
  'unsupported Telegram video formats still become a permanent black player');

// Dimensions are applied before metadata arrives and CSS must not force every
// clip into a fixed-height 16:9 frame.
expect(renderer.includes('data-video-width') && renderer.includes('data-video-height'), 'video dimensions are not carried into the DOM');
expect(loader.includes('_applyVideoDimensions(target, target.dataset.videoWidth, target.dataset.videoHeight)'), 'lazy media does not apply provider dimensions before loading');
expect(/\.video-player\{[^}]*height:auto;min-height:0;aspect-ratio:16\/9/.test(runtime), 'runtime CSS still forces a fixed video height');

// The selected local file must be activated once, immediately after the
// optimistic bubble is appended. This prevents the later realtime row from
// being the first place where a sender sees any video frame.
expect(outbox.includes('video[data-lazy="1"] source[data-lazy-src]') && outbox.includes('this.chat._activateLazyMedia(source.closest(\'video\'))'), 'optimistic local video is not activated immediately');

console.log('telegram-video-presentation-contract-ok');
