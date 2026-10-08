/*
 * Compatibility helpers for file downloads.
 *
 * This module intentionally does not patch BaseChat.prototype, observe a
 * message container, wrap History, or start timers. Those behaviours used to
 * survive a chat switch and could act on a different dialogue. Chat-specific
 * media behaviour now belongs to BaseChat and its provider adapter.
 */
const DOWNLOAD_PROXY = 'media_stream.php';

function isPreviewMode() {
  return window.APP_CONFIG?.previewMode === true
    || new URLSearchParams(window.location.search).get('preview') === '1';
}

const safeName = (value) => String(value || 'file')
  .replace(/[\\/:*?"<>|]+/g, '_')
  .replace(/\s+/g, ' ')
  .trim() || 'file';

function sourceId() {
  const fromChat = window.currentChat?.provider?.id || window.currentChat?.source;
  const fromUrl = new URLSearchParams(location.search).get('source');
  return String(fromChat || fromUrl || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'chat';
}

function shortHash(value) {
  let hash = 5381;
  for (const char of String(value || '')) hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  return (hash >>> 0).toString(16).slice(0, 8);
}

function filenameFor(anchor) {
  const href = anchor.getAttribute('href') || '';
  let name = anchor.getAttribute('download') || '';
  try {
    const url = new URL(href, location.href);
    name ||= url.searchParams.get('name') || url.pathname.split('/').pop() || '';
  } catch {}
  name = safeName(name || 'file');
  const ext = name.match(/\.[a-z0-9]{1,8}$/i)?.[0] || '';
  const base = ext ? name.slice(0, -ext.length) : name;
  const messageId = anchor.closest('.message')?.dataset?.id || shortHash(href);
  return `${base}__${sourceId()}_${String(messageId).replace(/[^a-zA-Z0-9_-]/g, '_')}${ext}`;
}

function isDownloadLink(anchor) {
  if (!anchor?.href || anchor.dataset.dlDirect === '1') return false;
  if (anchor.matches('a[data-lightbox], a.tile-open, a.single-photo-link')) return false;
  try {
    const url = new URL(anchor.href, location.href);
    // Local bridge media refs are bound to the browser's PHP session. The
    // legacy same-origin media_stream.php proxy cannot forward that session
    // to another local port, so let the browser download directly from the
    // worker (which returns Content-Disposition: attachment for dl=1).
    if (url.pathname === '/bridge-media'
      && ['127.0.0.1', 'localhost'].includes(url.hostname)
      && ['18085', '18087', '18089', '18090'].includes(url.port)) return false;
    if (anchor.hasAttribute('download') || anchor.classList.contains('tile-dl')) return true;
    return url.searchParams.get('dl') === '1';
  } catch {
    return false;
  }
}

function proxyUrl(href, name) {
  const query = new URLSearchParams({ u: new URL(href, location.href).href, name, _r: String(Date.now()) });
  return `${DOWNLOAD_PROXY}?${query.toString()}`;
}

function triggerDownload(url) {
  const frame = document.createElement('iframe');
  frame.hidden = true;
  frame.src = url;
  document.body.appendChild(frame);
  window.setTimeout(() => frame.remove(), 30_000);
}

async function downloadSameOrigin(href, name) {
  const response = await fetch(href, { credentials: 'include' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = objectUrl;
  link.download = name;
  link.dataset.dlDirect = '1';
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  window.setTimeout(() => {
    URL.revokeObjectURL(objectUrl);
    link.remove();
  }, 1_000);
}

export function rewriteDownloads(root = document) {
  root.querySelectorAll?.('.message a[download], .message a.tile-dl').forEach((anchor) => {
    if (anchor.dataset.downloadNameReady === '1') return;
    anchor.dataset.downloadNameReady = '1';
    anchor.setAttribute('download', filenameFor(anchor));
  });
}

function installDownloadCompatibility() {
  if (window.__downloadCompatibilityInstalled) return;
  window.__downloadCompatibilityInstalled = true;
  window.rewriteDownloads = rewriteDownloads;
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!isDownloadLink(anchor)) return;
    if (isPreviewMode()) {
      event.preventDefault();
      event.stopPropagation();
      window.currentChat?._showFeatureNotice?.('Загрузка файлов отключена в режиме проверки.');
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    const href = anchor.getAttribute('href') || '';
    const name = filenameFor(anchor);
    try {
      if (new URL(href, location.href).origin !== location.origin) {
        triggerDownload(proxyUrl(href, name));
        return;
      }
    } catch {
      triggerDownload(proxyUrl(href, name));
      return;
    }
    downloadSameOrigin(href, name).catch(() => triggerDownload(href));
  }, true);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', installDownloadCompatibility, { once: true });
} else {
  installDownloadCompatibility();
}
