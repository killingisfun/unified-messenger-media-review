import { icon } from './icons.js?v=20260922-inline-motion-r1';
// One lifecycle for inline animations across all providers.
let playerPromise;
function loadPlayer() {
  if (!playerPromise) playerPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../vendor/lottie/lottie_light.min.js', import.meta.url).href;
    script.onload = () => resolve(window.lottie);
    script.onerror = () => { playerPromise = null; script.remove(); reject(new Error('Animation player unavailable')); };
    document.head.append(script);
  });
  return playerPromise;
}

async function boundedBytes(stream, limit) {
  const reader = stream.getReader(), chunks = [];
  let size = 0;
  try {
    while (true) {
      const {done, value} = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) throw new Error('Animation too large');
      chunks.push(value);
    }
  } finally { await reader.cancel().catch(() => {}); }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  return bytes;
}

export function motionKind(attachment) {
  const type = String(attachment.type || attachment.kind || '').toLowerCase();
  const mime = String(attachment.mime || '').toLowerCase();
  const name = String(attachment.filename || attachment.name || '');
  if (attachment.video_note || Number(attachment.video_type) === 1 || type === 'video_note') return 'note';
  if (type === 'sticker') {
    if (attachment.animation_format === 'lottie' || /tgsticker|json/.test(mime) || /\.tgs$/i.test(name)) return 'lottie';
    if (mime.startsWith('video/') || /\.(webm|mp4)$/i.test(name)) return 'sticker-video';
    return 'sticker-image';
  }
  if (type === 'animation' || attachment.animated || attachment.animation || /image\/gif/.test(mime) || /\.gif$/i.test(name)) {
    return mime.startsWith('video/') || type === 'video' || type === 'animation' ? 'animation-video' : 'animation-image';
  }
  return '';
}

export class MotionMedia {
  constructor(lifetime, root) {
    this.items = new Map();
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)');
    this.observer = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const item = this.items.get(entry.target);
        if (!item) continue;
        item.visible = entry.isIntersecting;
        this.update(item);
      }
    }, {root: root || null, threshold: 0.1});
    lifetime.listen(document, 'visibilitychange', () => this.items.forEach(item => this.update(item)));
    lifetime.add(() => {
      this.observer.disconnect();
      for (const item of this.items.values()) { item.abort.abort(); item.player?.destroy(); item.video?.pause(); }
      this.items.clear();
    });
  }

  register(root) {
    for (const [element, item] of this.items) {
      if (item.wasConnected && !element.isConnected) {
        item.abort.abort(); item.player?.destroy(); item.video?.pause();
        this.observer.unobserve(element); this.items.delete(element);
      }
    }
    root.querySelectorAll('[data-motion]').forEach(element => {
      if (this.items.has(element)) return;
      const download = element.querySelector('.motion-download');
      if (download) download.innerHTML = icon('mediaDownload');
      const video = element.querySelector('video');
      const item = {element, video, abort: new AbortController(), visible: false, paused: false};
      this.items.set(element, item);
      if (video) {
        video.muted = true; video.loop = true;
        video.addEventListener('click', () => element.querySelector('.motion-toggle')?.click(), {signal:item.abort.signal});
        video.addEventListener('loadeddata', () => this.update(item), {signal:item.abort.signal});
        const tick = () => {
          const duration = Number.isFinite(video.duration) ? video.duration : 0;
          element.style.setProperty('--motion-progress', `${duration ? video.currentTime / duration * 100 : 0}%`);
          const time = element.querySelector('.motion-time');
          const seconds = Math.max(0, Math.ceil(duration - video.currentTime));
          if (time) time.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
        };
        video.addEventListener('timeupdate', tick, {signal:item.abort.signal});
        video.addEventListener('loadedmetadata', tick, {signal:item.abort.signal});
        video.addEventListener('ended', () => { item.paused = true; this.update(item); }, {signal:item.abort.signal});
      }
      element.querySelector('.motion-toggle')?.addEventListener('click', event => {
        event.stopPropagation();
        if (item.failed) {
          item.failed = false; item.paused = false;
          element.classList.remove('motion-failed');
          element.querySelector('.motion-canvas').textContent = '';
          item.explicit = true; this.update(item); return;
        }
        if (element.dataset.motion === 'note' && video?.muted) {
          // Start the spoken message from the beginning on explicit activation.
          video.muted = false; video.loop = false; video.currentTime = 0; item.paused = false;
        } else item.paused = !item.paused;
        item.explicit = true;
        this.update(item);
      }, {signal:item.abort.signal});
      this.observer.observe(element);
    });
  }

  _renderStaticSticker(item, mime, bytes = null) {
    const {element} = item;
    const source = element.dataset.motionSrc;
    const canvas = element.querySelector('.motion-canvas');
    if (!source || !canvas) return false;
    const image = document.createElement('img');
    image.className = 'msg-sticker';
    image.alt = 'Стикер';
    const objectUrl = bytes ? URL.createObjectURL(new Blob([bytes], {type: mime || 'application/octet-stream'})) : '';
    image.src = objectUrl || source;
    image.addEventListener('load', () => { if (objectUrl) URL.revokeObjectURL(objectUrl); }, {once: true});
    image.addEventListener('error', () => {
      if (objectUrl) URL.revokeObjectURL(objectUrl);
      this._showLottieFailure(item);
    }, {once: true});
    canvas.replaceWith(image);
    element.dataset.motion = 'sticker-image';
    delete element.dataset.motionSrc;
    element.classList.remove('motion-ready', 'motion-failed');
    element.querySelector('.motion-toggle')?.remove();
    item.failed = false;
    item.staticMime = mime;
    return true;
  }

  _showLottieFailure(item, { permanent = false } = {}) {
    const {element} = item;
    if (item.abort.signal.aborted) return;
    item.failed = true;
    element.classList.add('motion-failed');
    let canvas = element.querySelector('.motion-canvas');
    if (!canvas) {
      canvas = document.createElement('div');
      canvas.className = 'motion-canvas';
      element.querySelector('.msg-sticker')?.replaceWith(canvas);
    }
    canvas.textContent = permanent ? 'Стикер недоступен' : 'Не удалось загрузить';
    const button = element.querySelector('.motion-toggle');
    if (button) {
      if (permanent) button.remove();
      else { button.textContent = '↻'; button.title = 'Повторить загрузку'; button.setAttribute('aria-label', 'Повторить загрузку анимации'); }
    }
  }

  async _renderStaticFallback(item) {
    const source = String(item.element.dataset.motionPreviewSrc || '');
    if (!source) return false;
    try {
      const response = await fetch(source, {credentials: 'include', signal: AbortSignal.any([item.abort.signal, AbortSignal.timeout(15000)])});
      if (!response.ok) return false;
      const bytes = await boundedBytes(response.body, 2 * 1024 * 1024);
      const mime = (response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
      const staticImage = (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
        || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        || (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
        || (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50);
      if (!staticImage) return false;
      const staticMime = mime.startsWith('image/') ? mime
        : (bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg' : bytes[0] === 0x47 ? 'image/gif' : 'image/webp');
      return this._renderStaticSticker(item, staticMime, bytes);
    } catch {
      return false;
    }
  }

  async update(item) {
    const {element, video} = item;
    item.wasConnected ||= element.isConnected;
    if (item.abort.signal.aborted) return;
    const play = item.visible && !document.hidden && !item.paused && (!this.reduced.matches || item.explicit);
    element.classList.toggle('motion-paused', !play);
    const button = element.querySelector('.motion-toggle');
    if (button) {
      const label = element.dataset.motion === 'note' && video?.muted ? 'Включить звук' : play ? 'Приостановить' : 'Воспроизвести';
      button.setAttribute('aria-label', label); button.title = label;
      button.innerHTML = icon(element.dataset.motion === 'note' && video?.muted ? 'mediaSound' : play ? 'mediaPause' : 'mediaPlay');
    }
    if (video) {
      if (play) video.play().catch(error => {
        if (error.name === 'NotAllowedError') { item.paused = true; this.update(item); }
      });
      else video.pause();
    }
    if (item.player) { play ? item.player.play() : item.player.pause(); return; }
    if (element.dataset.motion !== 'lottie' || !item.visible || item.loading || item.failed) return;
    item.loading = true;
    try {
      const response = await fetch(element.dataset.motionSrc, {credentials: 'include', signal:AbortSignal.any([item.abort.signal, AbortSignal.timeout(15000)])});
      if (!response.ok) throw new Error('Animation unavailable');
      const contentType = (response.headers.get('content-type') || '').split(';', 1)[0].toLowerCase();
      let bytes = await boundedBytes(response.body, 2 * 1024 * 1024);
      const staticImageBytes = (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47)
        || (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
        || (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
        || (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 && bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50);
      // The compatibility bridge may preserve the provider's generic
      // application/octet-stream. Magic bytes keep the static fallback correct
      // even before that response header reaches the browser.
      // MAX can label static PNG/WebP stickers as Lottie. Decode the body
      // once and show its verified image bytes from a local blob, so the
      // provider's generic MIME cannot cause a second cross-port request to
      // fail after the correct file has already arrived.
      if (staticImageBytes || contentType.startsWith('image/')) {
        const staticMime = contentType.startsWith('image/') ? contentType
          : (bytes[0] === 0x89 ? 'image/png' : bytes[0] === 0xff ? 'image/jpeg'
            : bytes[0] === 0x47 ? 'image/gif' : 'image/webp');
        if (this._renderStaticSticker(item, staticMime, bytes)) return;
      }
      if (bytes[0] === 31 && bytes[1] === 139) bytes = await boundedBytes(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip')), 4 * 1024 * 1024);
      const data = JSON.parse(new TextDecoder().decode(bytes));
      // Stickers must not cause browser requests to provider URLs or load fonts.
      if (!Array.isArray(data.layers) || data.assets?.some(asset => asset.p || asset.u) || data.fonts?.list?.some(font => font.fPath)) throw new Error('Unsupported external animation asset');
      const player = await loadPlayer();
      if (item.abort.signal.aborted) return;
      item.player = player.loadAnimation({container: element.querySelector('.motion-canvas'), renderer:'svg', loop:true, autoplay:false, animationData:data});
      element.classList.add('motion-ready');
      this.update(item);
    } catch (error) {
      // A malformed Lottie document cannot become valid on a repeated local
      // fetch. MAX occasionally retains such an old truncated sticker: keep
      // it as an explicit unavailable item instead of offering a misleading
      // retry loop. Transport and player errors remain retryable.
      const permanent = error instanceof SyntaxError;
      if (!item.abort.signal.aborted && !(permanent && await this._renderStaticFallback(item))) {
        this._showLottieFailure(item, { permanent });
      }
    } finally { item.loading = false; }
  }
}
