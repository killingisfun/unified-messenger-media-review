/*
 * Compatibility helpers for file downloads.
 *
 * This module intentionally does not patch BaseChat.prototype, observe a
 * message container, wrap History, or start timers. Those behaviours used to
 * survive a chat switch and could act on a different dialogue. Chat-specific
 * media behaviour now belongs to BaseChat and its provider adapter.
 */
import { attachmentMessageId, attachmentOrdinal, buildDownloadFileName, getOriginalDownloadName } from '../core/downloadNames.js';

const DOWNLOAD_PROXY = 'media_stream.php';

function isPreviewMode() {
  return window.APP_CONFIG?.previewMode === true
    || new URLSearchParams(window.location.search).get('preview') === '1';
}

function isDesktopMode() {
  return window.APP_CONFIG?.desktopMode === true && !!globalThis.chrome?.webview;
}

function showDesktopDownloadToast({ title, detail = '', kind = 'success' } = {}) {
  if (!isDesktopMode() || !title) return;
  let host = document.getElementById('desktop-download-toasts');
  if (!host) {
    host = document.createElement('div');
    host.id = 'desktop-download-toasts';
    host.setAttribute('aria-live', 'polite');
    host.setAttribute('aria-relevant', 'additions');
    document.body.appendChild(host);
  }
  const toast = document.createElement('section');
  toast.className = `desktop-download-toast is-${kind === 'error' ? 'error' : 'success'}`;
  toast.setAttribute('role', kind === 'error' ? 'alert' : 'status');
  const icon = document.createElement('i');
  icon.className = kind === 'error' ? 'bi bi-exclamation-circle-fill' : 'bi bi-check-circle-fill';
  icon.setAttribute('aria-hidden', 'true');
  const copy = document.createElement('div');
  copy.className = 'desktop-download-toast-copy';
  const heading = document.createElement('strong');
  heading.textContent = title;
  copy.appendChild(heading);
  if (detail) {
    const text = document.createElement('small');
    text.textContent = detail;
    copy.appendChild(text);
  }
  const open = document.createElement('button');
  open.type = 'button';
  open.className = 'desktop-download-toast-open';
  open.innerHTML = '<i class="bi bi-folder2-open" aria-hidden="true"></i><span>Открыть папку</span>';
  open.addEventListener('click', () => {
    globalThis.chrome.webview.postMessage({ type: 'open-download-library' });
    dismiss();
  });
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'desktop-download-toast-close';
  close.setAttribute('aria-label', 'Закрыть уведомление');
  close.innerHTML = '<i class="bi bi-x" aria-hidden="true"></i>';
  let timer;
  const dismiss = () => {
    if (timer) window.clearTimeout(timer);
    toast.classList.add('is-leaving');
    window.setTimeout(() => toast.remove(), 180);
  };
  close.addEventListener('click', dismiss);
  toast.append(icon, copy, open, close);
  host.appendChild(toast);
  timer = window.setTimeout(dismiss, 7000);
}

globalThis.showDesktopDownloadToast = showDesktopDownloadToast;

function clearNativeDownloadFeedback(anchor) {
  anchor.classList.remove('is-native-download-pending');
  anchor.removeAttribute('aria-busy');
  delete anchor.dataset.nativeDownloadPending;
  const label = anchor.querySelector('span');
  if (label && anchor.dataset.nativeDownloadLabel !== undefined) {
    label.textContent = anchor.dataset.nativeDownloadLabel;
    delete anchor.dataset.nativeDownloadLabel;
  }
  if (anchor.dataset.nativeDownloadTitle !== undefined) {
    anchor.title = anchor.dataset.nativeDownloadTitle;
    delete anchor.dataset.nativeDownloadTitle;
  }
}

function showNativeDownloadFeedback(anchor) {
  if (anchor.dataset.nativeDownloadPending === '1') return;
  anchor.dataset.nativeDownloadPending = '1';
  anchor.classList.add('is-native-download-pending');
  anchor.setAttribute('aria-busy', 'true');
  const label = anchor.querySelector('span');
  if (label) {
    anchor.dataset.nativeDownloadLabel = label.textContent || '';
    label.textContent = 'Загрузка…';
  }
  const title = anchor.getAttribute('title');
  if (title) anchor.dataset.nativeDownloadTitle = title;
  anchor.title = 'Загрузка начата';
  window.setTimeout(() => clearNativeDownloadFeedback(anchor), 30_000);
}

function sourceId() {
  const fromChat = window.currentChat?.provider?.id || window.currentChat?.source;
  const fromUrl = new URLSearchParams(location.search).get('source');
  return String(fromChat || fromUrl || 'chat').toLowerCase().replace(/[^a-z0-9]+/g, '_') || 'chat';
}

function filenameFor(anchor) {
  const ready = anchor.dataset.canonicalDownloadName;
  if (ready) return ready;
  const href = anchor.getAttribute('href') || '';
  const message = anchor.closest('.message');
  const originalName = anchor.dataset.downloadOriginalName
    || getOriginalDownloadName({
      originalName: anchor.getAttribute('download') || '',
      imageAlt: anchor.querySelector('img')?.getAttribute('alt') || '',
      url: href,
    });
  anchor.dataset.downloadOriginalName = originalName;
  const name = buildDownloadFileName({
    provider: sourceId(),
    messageId: attachmentMessageId(anchor, message),
    timestamp: message?.dataset?.timestamp || '',
    ordinal: attachmentOrdinal(anchor, message),
    originalName,
    url: href,
  });
  anchor.dataset.canonicalDownloadName = name;
  return name;
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
  if (isDesktopMode()) {
    globalThis.chrome.webview.addEventListener('message', event => {
      const data = event?.data;
      if (!data || data.type !== 'native-download-result' || !data.requestId) return;
      const anchor = document.querySelector(`a[data-native-download-request="${CSS.escape(String(data.requestId))}"]`);
      if (!anchor) return;
      delete anchor.dataset.nativeDownloadRequest;
      clearNativeDownloadFeedback(anchor);
      if (data.success) {
        showDesktopDownloadToast({
          title: 'Файл загружен',
          detail: String(data.fileName || 'Файл сохранён в библиотеке загрузок.')
        });
      } else {
        showDesktopDownloadToast({ title: 'Не удалось скачать файл', kind: 'error' });
        window.alert(data.error || 'Не удалось скачать файл.');
      }
    });
  }
  document.addEventListener('click', (event) => {
    const anchor = event.target instanceof Element ? event.target.closest('a[href]') : null;
    if (!isDownloadLink(anchor)) return;
    // The desktop host owns download transport and writes the response
    // straight to its native library.  Fetching into a Blob here both defeats
    // that handler and makes a large file consume the WebView's memory first.
    if (isDesktopMode()) {
      event.preventDefault();
      event.stopPropagation();
      if (anchor.dataset.nativeDownloadPending === '1') return;
      showNativeDownloadFeedback(anchor);
      const requestId = `download-${Date.now()}-${Math.random().toString(16).slice(2)}`;
      anchor.dataset.nativeDownloadRequest = requestId;
      globalThis.chrome.webview.postMessage({
        type: 'save-download',
        requestId,
        url: anchor.href,
        name: filenameFor(anchor)
      });
      return;
    }
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
