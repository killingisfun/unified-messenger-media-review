
import { buildZipBlob } from './mediaArchive.js';
import { attachmentMessageId, buildArchiveFileName, buildDownloadFileName, getOriginalDownloadName } from '../../core/downloadNames.js';

/** Image viewer, download links and client-side ZIP downloads. */
export class MediaGallery {
  constructor(chat) { this.chat = chat; }

  _installNativeGallery() {
    if (this.chat._galleryCleanup || !this.chat.messagesContainer) return;
    const old = document.getElementById('bc-gallery-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'bc-gallery-overlay';
    overlay.className = 'bc-gallery';
    overlay.setAttribute('aria-hidden', 'true');
    overlay.innerHTML = `
      <button type="button" class="bc-gallery-close" aria-label="Закрыть">×</button>
      <button type="button" class="bc-gallery-nav bc-gallery-prev" aria-label="Предыдущее фото">‹</button>
      <figure><img alt=""><figcaption></figcaption></figure>
      <button type="button" class="bc-gallery-nav bc-gallery-next" aria-label="Следующее фото">›</button>
      <a class="bc-gallery-download" download><i class="bi bi-download"></i> Скачать фото</a>`;
    document.body.appendChild(overlay);

    const image = overlay.querySelector('img');
    const caption = overlay.querySelector('figcaption');
    const download = overlay.querySelector('.bc-gallery-download');
    let links = [];
    let index = 0;
    let galleryOpener;
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-label', 'Просмотр фотографий');
    const titleDownloadName = (link) => link?.dataset?.title?.match(/download='([^']*)'/)?.[1] || '';
    const filenameFor = (link) => {
      const message = link?.closest('.message');
      return buildDownloadFileName({
        provider: this.chat.source,
        messageId: attachmentMessageId(link, message),
        timestamp: message?.dataset?.timestamp || '',
        ordinal: Math.max(1, links.indexOf(link) + 1),
        originalName: link?.dataset?.downloadOriginalName || link?.getAttribute('download') || titleDownloadName(link),
        imageAlt: link?.querySelector('img')?.getAttribute('alt') || '',
        url: link?.href || '',
      });
    };
    const render = () => {
      const link = links[index];
      if (!link) return;
      const filename = filenameFor(link);
      image.src = link.href;
      image.alt = filename;
      caption.textContent = links.length > 1 ? `${index + 1} из ${links.length}` : filename;
      download.href = this.chat._withDlParam(this.chat._withNameParam(link.href, filename));
      download.setAttribute('download', filename);
      download.dataset.canonicalDownloadName = filename;
      overlay.querySelector('.bc-gallery-prev').disabled = links.length < 2;
      overlay.querySelector('.bc-gallery-next').disabled = links.length < 2;
    };
    const close = () => {
      overlay.classList.remove('is-open');
      overlay.setAttribute('aria-hidden', 'true');
      image.removeAttribute('src');
      if (galleryOpener?.isConnected) galleryOpener.focus({ preventScroll: true });
    };
    const move = (step) => {
      if (links.length < 2) return;
      index = (index + step + links.length) % links.length;
      render();
    };
    const show = (link) => {
      galleryOpener = link;
      const key = link.getAttribute('data-lightbox');
      links = Array.from(this.chat.messagesContainer.querySelectorAll('a[data-lightbox]'))
        .filter((candidate) => candidate.getAttribute('data-lightbox') === key);
      index = Math.max(0, links.indexOf(link));
      render();
      overlay.classList.add('is-open');
      overlay.setAttribute('aria-hidden', 'false');
      overlay.querySelector('.bc-gallery-close').focus();
    };
    const onClick = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('.tile-dl,.album-download-all,.files-download-all,.lb-download')) return;
      const link = target.closest('a[data-lightbox]');
      if (!link || !this.chat.messagesContainer.contains(link)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      show(link);
    };
    const onKeyDown = (event) => {
      if (!overlay.classList.contains('is-open')) return;
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key === 'Tab') {
        const focusable = [...overlay.querySelectorAll('button:not(:disabled), a[href]')];
        const first = focusable[0], last = focusable.at(-1);
        if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
        if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
      }
      if (event.key === 'ArrowLeft') move(-1);
      if (event.key === 'ArrowRight') move(1);
    };
    // Delegate on document as well as the current container.  The SPA
    // replaces the message pane when switching chats, so a container-bound
    // listener alone can become stale during a fast chat switch.
    document.addEventListener('click', onClick, true);
    overlay.querySelector('.bc-gallery-close').addEventListener('click', close);
    overlay.querySelector('.bc-gallery-prev').addEventListener('click', () => move(-1));
    overlay.querySelector('.bc-gallery-next').addEventListener('click', () => move(1));
    overlay.addEventListener('click', (event) => { if (event.target === overlay) close(); });
    document.addEventListener('keydown', onKeyDown);
    this.chat._galleryCleanup = () => {
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('keydown', onKeyDown);
      overlay.remove();
    };
  }

  _toLightboxOpenUrl(rawUrl, filename) {
    try {
      return this.chat._toLightboxFriendlyUrl(rawUrl, filename);
    } catch {
      return '';
    }
  }

  async _handleDownloadAllClick(event) {
    const btn = event.target.closest('.album-download-all, .files-download-all');
    if (!btn) return;
    // The same control becomes the final native download link after ZIP
    // generation. Let the browser handle that click synchronously.
    if (btn.dataset.archiveReady === '1') return;
    const messageEl = btn.closest('.message');
    if (!btn) return;
    btn.disabled = true;
    const btnText = btn.querySelector('.btn-text');
    const btnSpinner = btn.querySelector('.spinner-border');
    let archiveReady = false;
    if (btnText) btnText.textContent = 'Подготовка...';
    if (btnSpinner) btnSpinner.classList.remove('d-none');
    try {
      let links;
      if (btn.classList.contains('album-download-all')) {
        links = Array.from(messageEl.querySelectorAll('a[data-lightbox]'));
      } else {
        links = Array.from(messageEl.querySelectorAll('a[download]'));
      }
      const filesToZip = links.map((a, index) => {
        // Attachment links enter through the local bridge. In the optional
        // media-worker mode they may make one local redirect after that.
        // Keep the proven browser-side ZIP flow, but never rewrite a local
        // media URL to the retired external fallback from the old UI.
        const url = a.href || '';
        let originalName = a.dataset.downloadOriginalName || a.getAttribute('download') || (a.querySelector('img') ? a.querySelector('img').getAttribute('alt') : null);
        if (!originalName && a.dataset.title) {
          const match = a.dataset.title.match(/download='([^']*)'/);
          if (match && match[1]) {
            originalName = match[1];
          }
        }
        const finalName = buildDownloadFileName({
          provider: this.chat.source,
          messageId: attachmentMessageId(a, messageEl),
          timestamp: messageEl?.dataset?.timestamp || '',
          ordinal: index + 1,
          originalName: getOriginalDownloadName({ originalName, url }),
          url,
        });
        return {
          url: url,
          name: finalName
        };
      });
      if (filesToZip.length === 0) throw new Error('Файлы для скачивания не найдены.');
      const archiveName = buildArchiveFileName({
        provider: this.chat.source,
        chatId: this.chat.chatId || this.chat.chatDbId || '',
      });
      if (window.APP_CONFIG?.desktopMode === true && !!globalThis.chrome?.webview) {
        if (btnText) btnText.textContent = `Архивирование... (0/${filesToZip.length})`;
        const result = await this._createDesktopArchive(archiveName, filesToZip, (completed, total) => {
          if (btnText) btnText.textContent = `Архивирование... (${completed}/${total})`;
        });
        if (!result.success) throw new Error(result.error || 'Не удалось создать архив.');
        archiveReady = true;
        btn.disabled = false;
        if (btnSpinner) btnSpinner.classList.add('d-none');
        if (btnText) btnText.textContent = `Архив готов: ${result.archiveName}`;
        globalThis.showDesktopDownloadToast?.({
          title: 'Архив готов',
          detail: String(result.archiveName || 'Архив сохранён в библиотеке загрузок.')
        });
        if (result.failures?.length) window.alert(`Архив создан: ${result.added} из ${filesToZip.length} файлов. Не добавлены: ${result.failures.join(', ')}`);
        window.setTimeout(() => {
          if (btnText) btnText.textContent = 'Скачать всё';
        }, 2500);
        return;
      }
      const fetched = [];
      const failures = [];
      let completedCount = 0;
      if (btnText) btnText.textContent = `Архивация... (0/${filesToZip.length})`;
      let nextIndex = 0;
      const fetchOne = async () => {
        while (nextIndex < filesToZip.length) {
          const index = nextIndex++;
          const file = filesToZip[index];
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 120000);
          try {
            // Keep the timeout active through the response body. Fetch resolves
            // at headers; large or slow media can otherwise leave blob() stuck
            // forever while the button appears frozen.
            const response = await fetch(file.url, { credentials: 'include', signal: controller.signal });
            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const blob = await response.blob();
            if (!blob.size) throw new Error('Пустой файл');
            fetched[index] = { name: file.name.replace(/[\\/]+/g, '_'), data: blob };
          } catch (err) {
            const reason = err?.name === 'AbortError' ? 'timeout' : (err instanceof Error ? err.message : 'network error');
            failures.push({ name: file.name, reason });
          } finally {
            clearTimeout(timeout);
            completedCount++;
            if (btnText) btnText.textContent = `Загрузка файлов... (${completedCount}/${filesToZip.length})`;
          }
        }
      };
      const workers = Array.from({ length: Math.min(3, filesToZip.length) }, () => fetchOne());
      await Promise.all(workers);
      const validFiles = fetched.filter(Boolean);
      if (!validFiles.length) {
        const reason = failures.some(item => item.reason === 'timeout')
          ? 'Загрузка файлов не завершилась за 2 минуты. Попробуй скачать файлы меньшими группами.'
          : 'Не удалось скачать файлы для архива. Обнови чат и попробуй ещё раз.';
        throw new Error(reason);
      }
      if (btnText) btnText.textContent = 'Генерация архива...';
      const zipBlob = await buildZipBlob(validFiles);
      const objectUrl = URL.createObjectURL(zipBlob);
      const download = document.createElement('a');
      download.href = objectUrl;
      download.download = archiveName;
      // The global compatibility handler otherwise prevents this native
      // click and tries to re-download the Blob through fetch().
      download.dataset.dlDirect = '1';
      // Do not retain the delegated "download all" behavior class: the
      // ready link must bypass the archive builder and use native navigation.
      download.className = btn.className.replace(/\b(?:album-download-all|files-download-all)\b/g, '').trim();
      download.dataset.archiveReady = '1';
      download.textContent = 'Скачать ZIP';
      download.title = archiveName;
      btn.replaceWith(download);
      archiveReady = true;
      setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
      }, 10 * 60 * 1000);
      if (failures.length) {
        window.alert(`Архив создан: ${validFiles.length} из ${filesToZip.length} файлов. Не удалось добавить: ${failures.map(item => item.name).join(', ')}`);
      }
    } catch (err) {
      console.error('Ошибка при создании ZIP-архива:', err);
      if (btnText) btnText.textContent = 'Не удалось собрать архив';
      window.alert(err instanceof Error ? err.message : 'Не удалось создать архив. Обнови чат и попробуй ещё раз.');
    } finally {
      setTimeout(() => {
        if (!archiveReady) {
          btn.disabled = false;
          if (btnText) btnText.textContent = 'Скачать всё';
          if (btnSpinner) btnSpinner.classList.add('d-none');
        }
      }, 2000);
    }
  }

  _createDesktopArchive(archiveName, files, onProgress) {
    const webview = globalThis.chrome?.webview;
    if (!webview) return Promise.reject(new Error('Нативная загрузка недоступна.'));
    const requestId = `archive-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return new Promise((resolve, reject) => {
      let timeout;
      const cleanup = () => {
        if (timeout) window.clearTimeout(timeout);
        webview.removeEventListener('message', onMessage);
      };
      const onMessage = event => {
        const data = event?.data;
        if (!data || data.requestId !== requestId) return;
        if (data.type === 'download-archive-progress') {
          onProgress?.(Number(data.completed || 0), Number(data.total || files.length));
          return;
        }
        if (data.type === 'download-archive-result') {
          cleanup();
          resolve(data);
        }
      };
      timeout = window.setTimeout(() => {
        cleanup();
        reject(new Error('Создание архива не завершилось вовремя.'));
      }, 15 * 60 * 1000);
      webview.addEventListener('message', onMessage);
      webview.postMessage({ type: 'create-download-archive', requestId, archiveName, files });
    });
  }

  _withNameParam(url, name) {
    const safeUrl = this.chat._safeRemoteUrl(url);
    if (!safeUrl) return '';
    if (safeUrl === this.chat._tinyTransparent || safeUrl === this.chat._videoPoster) return safeUrl;
    try {
      const u = new URL(this.chat._fixMediaUrl(safeUrl), window.location.href);
      if (name && !u.searchParams.get('name')) u.searchParams.set('name', name);
      return u.toString();
    } catch {
      return '';
    }
  }

  _toLightboxFriendlyUrl(rawUrl, filename) {
    const safeUrl = this.chat._safeRemoteUrl(rawUrl);
    if (!safeUrl) return '';
    try {
      const u = new URL(this.chat._fixMediaUrl(safeUrl), window.location.href);
      if (/\.(jpe?g|png|webp|gif|bmp|svg|heic|avif)(?:$|\?)/i.test(u.pathname)) {
        return u.toString();
      }
      let name = filename || u.searchParams.get('name') || '';
      const m = /.+\.([a-z0-9]{2,5})$/i.exec(name);
      const hasExt = !!m;
      if (/\/wa_media\//i.test(u.pathname) && hasExt) {
        const parts = u.pathname.split('/');
        const last = parts[parts.length - 1] || '';
        u.pathname = `/wa_media/${encodeURIComponent(last)}/${encodeURIComponent(name)}`;
        u.searchParams.delete('name');
        return u.toString();
      }
      return u.toString();
    } catch {
      return '';
    }
  }

  _withDlParam(url) {
    const safeUrl = this.chat._safeRemoteUrl(url);
    if (!safeUrl) return '';
    if (safeUrl === this.chat._tinyTransparent || safeUrl === this.chat._videoPoster) return safeUrl;
    try {
      const u = new URL(safeUrl, window.location.href);
      u.searchParams.set('dl', '1');
      return u.toString();
    } catch {
      return '';
    }
  }

  _pickDownloadName(title, mime, url) {
    const hasExt = (s) => /\.[a-z0-9]{2,5}$/i.test(s || '');
    const extFromUrl = (p) => {
      const m = String(p || '').match(/\.([a-z0-9]{2,5})(?:\?|$)/i);
      if (m && m[1].toLowerCase() === 'php') return '';
      return m ? m[1].toLowerCase() : '';
    };
    const mimeMap = {
      'video/mp4': 'mp4',
      'video/webm': 'webm',
      'video/quicktime': 'mov',
      'image/jpeg': 'jpg',
      'image/png': 'png',
      'image/webp': 'webp',
      'image/gif': 'gif',
      'audio/mpeg': 'mp3',
      'audio/ogg': 'ogg',
      'audio/opus': 'opus',
      'audio/wav': 'wav',
      'application/pdf': 'pdf'
    };
    let name = String(title || '').trim()
      .replace(/[\\/]+/g, '_')
      .replace(/[\u0000-\u001f\u007f]/g, '')
      .replace(/^\.+/, '')
      .slice(0, 180);
    if (hasExt(name)) return name || 'file';
    let ext = '';
    if (mime && mimeMap[mime.toLowerCase()]) {
      ext = mimeMap[mime.toLowerCase()];
    }
    if (!ext) {
      ext = extFromUrl(url);
    }
    if (!name || name.toLowerCase() === 'фото') name = 'photo';
    if (!name) name = 'file';
    return ext ? `${name}.${ext}` : name;
  }

  _waDetectLb() {
    const hasLb2 = !!(window.lightbox || document.querySelector('link[href*="lightbox"]'));
    const hasGL = !!(window.GLightbox || document.querySelector('[class*="glightbox"]'));
    const hasPs = !!(window.PhotoSwipe || document.querySelector('.pswp'));
    const hasFb = !!(window.Fancybox || window.jQuery?.fancybox);
    const hasFs = !!(window.fslightbox || document.querySelector('.fslightbox-container'));
    const found = [];
    if (hasLb2) found.push('Lightbox2');
    if (hasGL) found.push('GLightbox');
    if (hasPs) found.push('PhotoSwipe');
    if (hasFb) found.push('Fancybox');
    if (hasFs) found.push('FsLightbox');
    return found.join(', ') || 'unknown';
  }

  _waInstallOverlayMo() {
    const mo = new MutationObserver(list => {
      for (const m of list) {
        for (const n of m.addedNodes) {
          if (!(n instanceof HTMLElement)) continue;
          if (
            n.matches('.lightboxOverlay, .lightbox, .glightbox-container, .pswp, .fancybox-container, .fslightbox-container') ||
            (n.querySelector && n.querySelector('.lightboxOverlay, .glightbox-container, .pswp, .fancybox-container, .fslightbox-container'))
          ) {}
        }
      }
    });
    mo.observe(document.documentElement, {
      childList: true,
      subtree: true
    });
    return mo;
  }

  _waInstallClickProbe() {
    const container = this.chat.messagesContainer;
    if (!container) return () => {};
    const overlayMo = this.chat._waInstallOverlayMo();
    const onClickCap = (e) => {
      const a = e.target && (e.target.closest ? e.target.closest('a[data-lightbox]') : null);
      if (!a) return;
      if (this.chat._getSource() !== 'whatsapp') return;
    };
    container.addEventListener('click', onClickCap, true);
    return () => {
      try {
        container.removeEventListener('click', onClickCap, true);
      } catch {}
      try {
        overlayMo && overlayMo.disconnect();
      } catch {}
    };
  }

  _installWaLightboxDebug() {
    try {
      if (this.chat._getSource() !== 'whatsapp') return;
      this.chat._fixAlbumUrls(this.chat.messagesContainer);
      const mo = new MutationObserver(list => {
        for (const m of list) {
          m.addedNodes && m.addedNodes.forEach(n => {
            if (n && n.nodeType === 1) this.chat._fixAlbumUrls(n);
          });
        }
      });
      mo.observe(this.chat.messagesContainer, {
        childList: true,
        subtree: true
      });
      const off = this.chat._waInstallClickProbe();
      this.chat.__wa_patch_cleanup = () => {
        try {
          mo.disconnect();
        } catch {}
        try {
          off && off();
        } catch {}
      };
    } catch (e) {
      console.warn('[WA DEBUG] init failed', e);
    }
  }
}
