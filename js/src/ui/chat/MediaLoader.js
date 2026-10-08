

/** Viewport loading, bounded provider queues, retry UI and media fallbacks. */
export class MediaLoader {
  constructor(chat) { this.chat = chat; }

  _applyCachedUrl(el, _origUrl, cachedPath) {
    if (!el || !cachedPath) return;
    const abs = this.chat._safeRemoteUrl(cachedPath);
    if (!abs) return;
    const updateDlLinks = (root) => {};
    if (el.tagName === 'IMG') {
      el.src = abs;
      if (el.dataset && el.dataset.lazySrc) delete el.dataset.lazySrc;
      const a = el.closest('a[data-lightbox], .media-item a, .wa-media-wrap a');
      if (a) a.href = abs;
      updateDlLinks(el);
      return;
    }
    if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
      const sourceTag = el.querySelector('source[data-lazy-src]');
      if (sourceTag) {
        sourceTag.src = abs;
        delete sourceTag.dataset.lazySrc;
      } else {
        el.src = abs;
      }
      delete el.dataset.lazy;
      try {
        el.load();
      } catch (e) {
        console.warn('[BaseChat] el.load() failed for video/audio', e);
      }
      updateDlLinks(el);
      return;
    }
  }

  _prefetchMediaByUrl(rawUrl, fileName, el) {
    if (this.chat._isPreviewMode() || this.chat._isCompatibilityBridge()) return;
    const source = this.chat.source ? this.chat.source.toLowerCase() : '';
    if (source === 'telegram' || source === 'whatsapp') {
      return;
    }
    try {
      const isMedia = /\.(jpe?g|png|webp|gif|heic|mp4|webm|mov|m4v|mp3|ogg|m4a|wav|opus)($|\?)/i.test(fileName || '') ||
        /\.(jpe?g|png|webp|gif|heic|mp4|webm|mov|m4v|mp3|ogg|m4a|wav|opus)($|\?)/i.test(rawUrl || '');
      if (!isMedia) {
        return;
      }
      if (!rawUrl) return;
      const fixed = this.chat._fixMediaUrl(rawUrl);
      const url = new URL(fixed, window.location.href);
      if (/\/uploads\//.test(url.pathname)) {
        return;
      }
      if (!/\/(rest\.php|media\.php|media\/)/i.test(url.pathname)) {
        return;
      }
      const body = new URLSearchParams({
        u: url.href,
        sub: url.hostname || '',
        fn: fileName || 'media.bin',
        max_mb: '200'
      });
      const fire = () => {
        fetch('prefetch.php', {
          method: 'POST',
          body,
          keepalive: true
        })
          .then(r => {
            if (!r.ok) {
              return r.text().then(text => Promise.reject(new Error(text)));
            }
            return r.json();
          })
          .then(j => {
            if (!j) return;
            if (j.ok && j.path) {
              this.chat._applyCachedUrl(el, url.href, j.path);
              return;
            } else if (j && j.ok && !j.path) {
              try {
                if (el.tagName === 'IMG') {
                  const proxied = (el.dataset && (el.dataset.lazySrc || el.getAttribute('data-lazy-src'))) || url.href;
                  el.src = proxied;
                  if (el.dataset && el.dataset.lazySrc) delete el.dataset.lazySrc;
                } else if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
                  const sEl = el.querySelector('source') || el;
                  const proxied = (sEl && sEl.dataset && (sEl.dataset.lazySrc || el.getAttribute('data-lazy-src'))) || url.href;
                  if (sEl && sEl.tagName === 'SOURCE') sEl.setAttribute('src', proxied);
                  else el.setAttribute('src', proxied);
                  el.removeAttribute('data-lazy');
                  try {
                    el.load();
                  } catch {}
                }
              } catch (e) {
                console.warn('[DEBUG Prefetch] Fallback failed', e);
              }
              return;
            }
          })
          .catch((err) => {
            console.error('%c[DEBUG Prefetch] Ошибка fetch или обработки JSON:', 'color: red; font-weight: bold;', err);
          });
      };
      ('requestIdleCallback' in window) ? requestIdleCallback(fire, {
        timeout: 1500
      }) : setTimeout(fire, 400);
    } catch (e) {
      console.error('[DEBUG Prefetch] Критическая ошибка в функции _prefetchMediaByUrl:', e);
    }
  }

  _lazyMediaSource(element) {
    if (!element) return '';
    if (element.tagName === 'IMG') return this.chat._safeRemoteUrl(element.dataset.lazySrc || '');
    const sourceTag = element.tagName === 'SOURCE'
      ? element
      : element.querySelector?.('source[data-lazy-src], source');
    return this.chat._safeRemoteUrl(sourceTag?.dataset?.lazySrc || element.dataset?.lazySrc || '');
  }

  _activateLazyMedia(element) {
    if (!element || !this.chat._isActiveInstance()) return;
    const target = element.tagName === 'SOURCE' ? element.closest('video, audio') : element;
    if (!target) return;
    const sourceTag = target.tagName === 'VIDEO' || target.tagName === 'AUDIO'
      ? target.querySelector('source[data-lazy-src], source')
      : null;
    const lazySrc = this.chat._lazyMediaSource(target);
    const lazyPoster = target.tagName === 'VIDEO'
      ? this.chat._safeRemoteUrl(target.dataset.lazyPoster || '')
      : '';

    if (lazyPoster) {
      target.poster = lazyPoster;
      delete target.dataset.lazyPoster;
    }
    if (!lazySrc) {
      delete target.dataset.lazyObserved;
      return;
    }

    if (target.tagName === 'IMG') {
      // Cached and rebuilt images also need the handler that reveals them.
      this.chat._attachMediaSpinner(target);
      delete target.dataset.mediaReady;
      target.src = lazySrc;
      delete target.dataset.lazySrc;
    } else if (target.tagName === 'VIDEO' || target.tagName === 'AUDIO') {
      if (sourceTag) {
        sourceTag.src = lazySrc;
        delete sourceTag.dataset.lazySrc;
      } else {
        target.src = lazySrc;
        delete target.dataset.lazySrc;
      }
      delete target.dataset.lazy;
      this.chat._attachMediaSpinner(target);
      try { target.load(); } catch {}
    }
    delete target.dataset.lazyObserved;
  }

  _scheduleWhatsAppLazyMediaFlush() {
    if (this.chat._waMediaFlushTimer !== null || !this.chat._isActiveInstance()) return;
    this.chat._waMediaFlushTimer = this.chat.lifetime.timeout(() => {
      this.chat._waMediaFlushTimer = null;
      this.chat._flushWhatsAppLazyMedia();
    }, 0);
  }

  _queueWhatsAppLazyMedia(element) {
    if (!element || !this.chat._isActiveInstance() || !this.chat._lazyMediaSource(element)) return;
    if (element.dataset.waMediaQueued === '1' || this.chat._waMediaActive.has(element)) return;
    element.dataset.waMediaQueued = '1';
    this.chat._waMediaQueue.push({ element, sequence: this.chat._waMediaSequence++ });
    this.chat._scheduleWhatsAppLazyMediaFlush();
  }

  _lazyMediaQueuePriority(item) {
    const element = item?.element;
    if (!element?.isConnected) return [2, Number.MAX_SAFE_INTEGER, Number(item?.sequence || 0)];
    try {
      const root = this.chat.messageArea?.getBoundingClientRect?.();
      const rect = element.getBoundingClientRect();
      const top = root?.top ?? 0;
      const bottom = root?.bottom ?? (window.innerHeight || document.documentElement.clientHeight || 0);
      const visible = rect.bottom >= top && rect.top <= bottom;
      const distance = visible ? 0 : (rect.top > bottom ? rect.top - bottom : top - rect.bottom);
      return [visible ? 0 : 1, distance, Number(item?.sequence || 0)];
    } catch {
      return [1, Number.MAX_SAFE_INTEGER, Number(item?.sequence || 0)];
    }
  }

  _flushWhatsAppLazyMedia() {
    if (!this.chat._isActiveInstance()) return;
    this.chat._waMediaQueue = this.chat._waMediaQueue.filter(item => (
      item?.element?.isConnected && this.chat._lazyMediaSource(item.element)
    ));
    this.chat._waMediaQueue.sort((a, b) => {
      const left = this.chat._lazyMediaQueuePriority(a);
      const right = this.chat._lazyMediaQueuePriority(b);
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    });

    // The local bridge has a small PHP worker pool, and each uncached WPP
    // image may perform token, probe and decode work. Two visible files keep
    // the page responsive without serializing an album forever.
    while (this.chat._waMediaActive.size < 2 && this.chat._waMediaQueue.length) {
      const entry = this.chat._waMediaQueue.shift();
      const element = entry?.element;
      if (!element?.isConnected || !this.chat._lazyMediaSource(element)) continue;
      delete element.dataset.waMediaQueued;
      this.chat._startWhatsAppLazyMedia(element);
    }
  }

  _startWhatsAppLazyMedia(element) {
    const target = element?.tagName === 'SOURCE' ? element.closest('video, audio') : element;
    if (!target || !target.isConnected || this.chat._waMediaActive.has(element)) return;

    this.chat._waMediaActive.add(element);
    const events = target.tagName === 'IMG'
      ? ['load', 'error']
      : ['loadedmetadata', 'error', 'abort'];
    const release = () => {
      if (!this.chat._waMediaActive.delete(element)) return;
      events.forEach(event => {
        try { target.removeEventListener(event, release, true); } catch {}
      });
      const timer = this.chat._waMediaReleaseTimers.get(element);
      if (timer !== undefined) this.chat.lifetime.clearTimeout(timer);
      this.chat._waMediaReleaseTimers.delete(element);
      this.chat._scheduleWhatsAppLazyMediaFlush();
    };
    events.forEach(event => target.addEventListener(event, release, { once: true, capture: true }));
    const timeout = this.chat.lifetime.timeout(release, 30000);
    this.chat._waMediaReleaseTimers.set(element, timeout);
    this.chat._activateLazyMedia(element);
  }

  _scheduleTelegramLazyMediaFlush() {
    if (this.chat._telegramMediaFlushTimer !== null || !this.chat._isActiveInstance()) return;
    this.chat._telegramMediaFlushTimer = this.chat.lifetime.timeout(() => {
      this.chat._telegramMediaFlushTimer = null;
      this.chat._flushTelegramLazyMedia();
    }, 0);
  }

  _queueTelegramLazyMedia(element) {
    if (!element || !this.chat._isActiveInstance() || !this.chat._lazyMediaSource(element)) return;
    if (element.dataset.telegramMediaQueued === '1' || this.chat._telegramMediaActive.has(element)) return;
    element.dataset.telegramMediaQueued = '1';
    this.chat._telegramMediaQueue.push({ element, sequence: this.chat._telegramMediaSequence++ });
    this.chat._scheduleTelegramLazyMediaFlush();
  }

  _activateVisibleLazyMedia(element) {
    if (!element || !element.isConnected || !this.chat._isActiveInstance()) return;
    const lazySrc = this.chat._lazyMediaSource(element);
    if (!lazySrc) return;
    const provider = String(this.chat.source || '').toLowerCase();
    if (provider === 'whatsapp') {
      this.chat._queueWhatsAppLazyMedia(element);
      return;
    }
    if (provider === 'telegram') {
      let isBridgeRelay = false;
      try { isBridgeRelay = new URL(lazySrc, window.location.href).pathname === '/bridge-media'; } catch {}
      if (this.chat._isCompatibilityBridge() && isBridgeRelay) {
        this.chat._queueTelegramLazyMedia(element);
      } else {
        this.chat._activateLazyMedia(element);
      }
      return;
    }
    this.chat._activateLazyMedia(element);
  }

  _flushTelegramLazyMedia() {
    if (!this.chat._isActiveInstance()) return;
    this.chat._telegramMediaQueue = this.chat._telegramMediaQueue.filter(item => (
      item?.element?.isConnected && this.chat._lazyMediaSource(item.element)
    ));
    this.chat._telegramMediaQueue.sort((a, b) => {
      const left = this.chat._lazyMediaQueuePriority(a);
      const right = this.chat._lazyMediaQueuePriority(b);
      return left[0] - right[0] || left[1] - right[1] || left[2] - right[2];
    });

    // Madeline serializes some thumbnail/original reads behind its history
    // lock. One visible Telegram relay at a time avoids a page-load burst
    // starving the cursor request; the next tile starts as soon as metadata
    // or an image arrives.
    while (this.chat._telegramMediaActive.size < 1 && this.chat._telegramMediaQueue.length) {
      const entry = this.chat._telegramMediaQueue.shift();
      const element = entry?.element;
      if (!element?.isConnected || !this.chat._lazyMediaSource(element)) continue;
      delete element.dataset.telegramMediaQueued;
      this.chat._startTelegramLazyMedia(element);
    }
  }

  _startTelegramLazyMedia(element) {
    const target = element?.tagName === 'SOURCE' ? element.closest('video, audio') : element;
    if (!target || !target.isConnected || this.chat._telegramMediaActive.has(element)) return;

    this.chat._telegramMediaActive.add(element);
    const events = target.tagName === 'IMG'
      ? ['load', 'error']
      : ['loadedmetadata', 'error', 'abort'];
    const release = () => {
      if (!this.chat._telegramMediaActive.delete(element)) return;
      events.forEach(event => {
        try { target.removeEventListener(event, release, true); } catch {}
      });
      const timer = this.chat._telegramMediaReleaseTimers.get(element);
      if (timer !== undefined) this.chat.lifetime.clearTimeout(timer);
      this.chat._telegramMediaReleaseTimers.delete(element);
      this.chat._scheduleTelegramLazyMediaFlush();
    };
    events.forEach(event => target.addEventListener(event, release, { once: true, capture: true }));
    const timeout = this.chat.lifetime.timeout(release, 20000);
    this.chat._telegramMediaReleaseTimers.set(element, timeout);
    this.chat._activateLazyMedia(element);
  }

  _applyVideoDimensions(video, width, height) {
    if (video.closest('[data-motion]')) return;
    const w = Number(width), h = Number(height);
    if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return;
    const holder = video.closest('.video-holder');
    const player = video.closest('.video-player');
    if (!holder || !player) return;
    const orientation = h > w ? 'portrait' : w > h ? 'landscape' : 'square';
    const displayWidth = Math.max(80, Math.min(orientation === 'portrait' ? 280 : orientation === 'square' ? 320 : 420, 440 * w / h));
    holder.dataset.orientation = orientation;
    holder.style.width = `min(100%, ${displayWidth}px)`;
    player.style.aspectRatio = `${w} / ${h}`;
    const message = video.closest('.message');
    if (message?.classList.contains('is-single-video')) message.style.setProperty('--video-bubble-width', `${displayWidth + 30}px`);
  }

  _prepareLazyImageLayout(image) {
    if (!image || image.tagName !== 'IMG' || image.dataset.bcOrientationAttached === '1') return;
    const holder = image.closest('.media-holder');
    if (!holder || !holder.classList.contains('single-photo')) return;
    image.dataset.bcOrientationAttached = '1';
    this.chat.lifetime.listen(image, 'load', () => {
      if (!this.chat._isActiveInstance()) return;
      holder.classList.toggle('is-horizontal', image.naturalWidth > image.naturalHeight);
      holder.classList.toggle('is-vertical', image.naturalWidth <= image.naturalHeight);
    }, { once: true });
  }

  setupLazyMediaObserver() {
    if (this.chat._lazyObserver) this.chat._lazyObserver.disconnect();
    this.chat._lazyObserver = null;
    if (!this.chat._isActiveInstance() || typeof IntersectionObserver !== 'function') return;

    const batchBuffer = [];
    let batchTimer = null;
    const flushBatch = async () => {
      batchTimer = null;
      if (!batchBuffer.length || !this.chat._isActiveInstance()) return;
      const items = batchBuffer.splice(0, batchBuffer.length);
      const fallback = () => items.forEach(item => this.chat._activateLazyMedia(item.element));
      if (typeof this.chat.api.prefetchMediaBatch !== 'function') {
        fallback();
        return;
      }
      try {
        const response = await this.chat.api.prefetchMediaBatch(this.chat.source, items.map(item => ({
          chatId: item.chatId,
          messageId: item.messageId,
        })));
        if (!this.chat._isActiveInstance()) return;
        const fileMap = response?.success ? response?.data?.map : null;
        items.forEach(item => {
          const cachedPath = fileMap?.[`${item.chatId}:${item.messageId}`];
          if (cachedPath) this.chat._applyCachedUrl(item.element, '', cachedPath);
          else this.chat._activateLazyMedia(item.element);
        });
      } catch {
        fallback();
      }
    };
    const queueLegacyPrefetch = (element, lazySrc) => {
      try {
        const url = new URL(lazySrc, window.location.href);
        // Bridge URLs intentionally contain only an opaque ref. They cannot
        // use the old batch endpoint, so load them directly on intersection.
        if (url.pathname === '/bridge-media') {
          this.chat._activateLazyMedia(element);
          return;
        }
        const chatId = url.searchParams.get('chatId');
        const messageId = url.searchParams.get('messageId');
        if (!chatId || !messageId) {
          this.chat._activateLazyMedia(element);
          return;
        }
        batchBuffer.push({ chatId, messageId, element });
        if (batchTimer !== null) this.chat.lifetime.clearTimeout(batchTimer);
        batchTimer = this.chat.lifetime.timeout(flushBatch, 100);
      } catch {
        this.chat._activateLazyMedia(element);
      }
    };
    this.chat._lazyObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting || !this.chat._isActiveInstance()) continue;
        const element = entry.target;
        this.chat._lazyObserver?.unobserve(element);
        const lazySrc = this.chat._lazyMediaSource(element);
        const provider = String(this.chat.source || '').toLowerCase();
        if (provider === 'telegram' && lazySrc && !this.chat._isCompatibilityBridge()) {
          queueLegacyPrefetch(element, lazySrc);
        } else {
          this.chat._activateVisibleLazyMedia(element);
        }
      }
    }, {
      root: this.chat.messageArea || null,
      rootMargin: ['whatsapp', 'telegram'].includes(String(this.chat.source || '').toLowerCase())
        ? '72px'
        : '240px',
      threshold: 0.01,
    });
  }

  _attachMediaSpinner(el) {
    try {
      if (!el || el.dataset.bcSpinAttached === '1') return;
      if (el.matches?.('video, audio') && el.querySelector('source[data-lazy-src]')) return;
      el.dataset.bcSpinAttached = '1';
      let holder = el.closest('.media-holder') || el.closest('.album-tile') || el.parentElement;
      if (!holder) return;
      holder.classList.add('media-holder', 'loading');
      holder.classList.remove('loaded');
      holder.setAttribute('aria-busy', 'true');
      if (el.tagName === 'IMG') delete el.dataset.mediaReady;
      if (el._bcImageHandlers) {
        el.removeEventListener('load', el._bcImageHandlers.load);
        el.removeEventListener('error', el._bcImageHandlers.error);
      }
      const surface = el.closest('.video-player') || holder;
      surface.dataset.mediaState = 'loading';
      surface.querySelector('.media-error')?.remove();
      if (el._bcMediaHandlers) {
        for (const [event, handler] of Object.entries(el._bcMediaHandlers)) el.removeEventListener(event, handler, true);
      }
      let spin = holder.querySelector('.bc-spin');
      if (!spin) {
        spin = document.createElement('div');
        spin.className = 'bc-spin';
        if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
        surface.appendChild(spin);
        if (el.tagName === 'VIDEO') {
          spin.setAttribute('role', 'status');
          spin.textContent = 'Загрузка видео…';
        }
      }
      const clear = () => {
        // A placeholder's load event is not the requested photograph. Keep
        // its tile reserved until the actual image has decoded successfully.
        if (el.tagName === 'IMG' && (el.dataset.lazySrc || !el.complete || !el.naturalWidth)) return;
        // Telegram can return a 1×1 transparent placeholder for a thumbnail.
        // That is a successful DOM image load but not a usable photo preview.
        // Prefer the full relay already supplied with this attachment.
        if (el.tagName === 'IMG'
          && el.dataset.fallbackSrc
          && el.dataset.bcFallbackTried !== '1'
          && el.naturalWidth <= 1
          && el.naturalHeight <= 1) {
          error();
          return;
        }
        if (el.tagName === 'IMG') el.dataset.mediaReady = '1';
        surface.dataset.mediaState = 'ready';
        surface.querySelector('.media-error')?.remove();
        holder.classList.remove('loading');
        holder.classList.add('loaded');
        holder.setAttribute('aria-busy', 'false');
        try {
          spin.remove();
        } catch {}
        const retryBtn = holder.querySelector('.bc-retry');
        if (retryBtn) {
          try {
            retryBtn.remove();
          } catch {}
        }
        if (el._bc_tmr) {
          clearTimeout(el._bc_tmr);
          el._bc_tmr = null;
        }
        delete el.dataset.bcMediaRetryCount;
        delete el.dataset.bcMediaRetryScheduled;
      };
      const error = () => {
        if (el.tagName === 'IMG') delete el.dataset.mediaReady;
        holder.classList.remove('loaded');
        holder.classList.remove('loading');
        holder.setAttribute('aria-busy', 'false');
        spin.remove();
        if (el._bc_tmr) { clearTimeout(el._bc_tmr); el._bc_tmr = null; }

        // A saved WPP thumbnail is optional. If it expired or the stored
        // message has no valid preview after all, move this one visible tile
        // to its original relay instead of leaving a broken image forever.
        // The original still goes through the normal WhatsApp two-at-a-time
        // queue, so a missing preview cannot restart a page-wide media burst.
        const fallbackSrc = el.tagName === 'IMG'
          ? this.chat._safeRemoteUrl(el.dataset.fallbackSrc || '')
          : '';
        if (fallbackSrc && el.dataset.bcFallbackTried !== '1') {
          el.dataset.bcFallbackTried = '1';
          el.dataset.lazySrc = fallbackSrc;
          el.removeAttribute('src');
          this.chat.lifetime.timeout(() => {
            if (!el.isConnected || !this.chat._isActiveInstance()) return;
            delete el.dataset.bcSpinAttached;
            this.chat._attachMediaSpinner(el);
            if (String(this.chat.source || '').toLowerCase() === 'whatsapp') {
              this.chat._queueWhatsAppLazyMedia(el);
            } else {
              this.chat._activateLazyMedia(el);
            }
          }, 0);
          return;
        }
        this.chat._addMediaRetryUI(holder, el);
      };
      if (el.tagName === 'IMG') {
        el._bcImageHandlers = { load: clear, error };
        el.addEventListener('load', clear);
        el.addEventListener('error', error);
        if (!el.dataset.lazySrc && el.complete && el.naturalWidth > 0) clear();
        else if (!el.dataset.lazySrc && el.getAttribute('src') && el.complete) error();
      } else if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
        if (el.tagName === 'VIDEO') {
          const orient = () => this.chat._applyVideoDimensions(el, el.videoWidth, el.videoHeight);
          if (el._bcOrientationHandler) el.removeEventListener('loadedmetadata', el._bcOrientationHandler);
          el._bcOrientationHandler = orient;
          el.addEventListener('loadedmetadata', orient);
          orient();
        }
        // Source errors do not bubble: capture them on the media element.
        el._bcMediaHandlers = { loadedmetadata: clear, canplay: clear, error };
        for (const [event, handler] of Object.entries(el._bcMediaHandlers)) el.addEventListener(event, handler, true);
        if ((el.readyState || 0) >= 1) clear();
      }
    } catch (e) {
      console.warn('[BaseChat] _attachMediaSpinner failed', e);
    }
  }

  _addMediaRetryUI(holder, el) {
    try {
      if (!holder || !el) return;
      const surface = el.closest('.video-player') || holder;
      // Every provider uses one media contract: retry a transient failure a
      // bounded number of times, then show its final state.  Leaving a
      // spinner forever makes an unavailable historic attachment look like a
      // still-running request and gives the user no truthful outcome.
      const tries = Number(el.dataset.bcMediaRetryCount || '0');
      const unavailable = el.dataset.waUnavailable === '1';
      if (tries >= 2 || unavailable) {
        surface.querySelectorAll('.bc-retry, .media-error').forEach(node => node.remove());
        holder.classList.remove('loading');
        holder.classList.remove('loaded');
        holder.setAttribute('aria-busy', 'false');
        surface.dataset.mediaState = 'error';
        holder.querySelector('.bc-spin')?.remove();
        const error = document.createElement('div');
        error.className = 'media-error';
        error.setAttribute('role', 'status');
        const label = document.createElement('span');
        label.textContent = unavailable ? 'Файл недоступен в WhatsApp' : 'Не удалось загрузить вложение';
        error.appendChild(label);
        surface.appendChild(error);
        return;
      }

      // Do not add provider-specific or manual "retry" buttons into message
      // bubbles: narrow tiles can turn that text into a vertical bar.
      surface.querySelectorAll('.bc-retry, .media-error').forEach(node => node.remove());
      surface.classList.remove('media-retry-surface');
      surface.dataset.mediaState = 'loading';
      holder.classList.add('loading');
      holder.setAttribute('aria-busy', 'true');
      let spin = holder.querySelector('.bc-spin');
      if (!spin) {
        spin = document.createElement('div');
        spin.className = 'bc-spin';
        spin.setAttribute('role', 'status');
        spin.setAttribute('aria-label', 'Загрузка вложения');
        if (getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
        surface.appendChild(spin);
      }
      if (el.dataset.bcMediaRetryScheduled === '1') return;
      el.dataset.bcMediaRetryCount = String(tries + 1);
      el.dataset.bcMediaRetryScheduled = '1';
      this.chat.lifetime.timeout(() => {
        delete el.dataset.bcMediaRetryScheduled;
        if (!el.isConnected || !this.chat._isActiveInstance()) return;
        delete el.dataset.bcSpinAttached;
        this.chat._attachMediaSpinner(el);
        this.chat._forceReloadMedia(el);
      }, 1200 * (tries + 1));
    } catch (e) {
      console.warn('[BaseChat] _addMediaRetryUI failed', e);
    }
  }

  _forceReloadMedia(el) {
    try {
      if (!el) return;
      const bump = (u) => {
        if (!u) return u;
        const url = new URL(u, window.location.href);
        url.searchParams.set('r', Date.now().toString());
        return url.toString();
      };
      if (el.tagName === 'IMG') {
        let src = el.getAttribute('src') || el.dataset.lazySrc || '';
        src = this.chat._fixMediaUrl(src);
        try {
          this.chat._prefetchMediaByUrl(src, el.getAttribute('alt') || 'image.jpg', el);
        } catch {}
        el.setAttribute('src', bump(src));
      } else if (el.tagName === 'VIDEO' || el.tagName === 'AUDIO') {
        const s = el.querySelector('source');
        if (s) {
          let src = s.getAttribute('src') || s.dataset.lazySrc || '';
          delete s.dataset.lazySrc;
          src = this.chat._fixMediaUrl(src);
          try {
            this.chat._prefetchMediaByUrl(src, 'media.bin', el);
          } catch {}
          s.setAttribute('src', bump(src));
          this.chat._attachMediaSpinner(el);
          try {
            el.load();
          } catch {}
        }
      }
    } catch (e) {
      console.warn('[BaseChat] _forceReloadMedia failed', e);
    }
  }

  _prefetchTelegramBatch(container = this.chat.messagesContainer) {
    if (this.chat._isPreviewMode()) return;
    if (!container?.querySelectorAll) return;
    const itemsToPrefetch = [];
    const selector = 'img[data-lazy-src*="telegram_service"], video[data-lazy="1"] source[data-lazy-src*="telegram_service"], audio[data-lazy="1"] source[data-lazy-src*="telegram_service"]';
    container.querySelectorAll(selector).forEach(el => {
      const mediaUrl = el.dataset.lazySrc || (el.parentElement.tagName === 'VIDEO' || el.parentElement.tagName === 'AUDIO' ? el.parentElement.dataset.lazySrc : null);
      const parentElement = el.closest('video, audio, img');
      if (!mediaUrl || (parentElement && parentElement.dataset.prefetched === '1')) return;
      try {
        const url = new URL(mediaUrl, window.location.href);
        const chatId = url.searchParams.get('chatId');
        const messageId = url.searchParams.get('messageId');
        if (chatId && messageId) {
          const targetElement = (el.tagName === 'SOURCE') ? el.closest('video, audio') : el;
          itemsToPrefetch.push({
            chatId,
            messageId,
            element: targetElement
          });
          if (parentElement) parentElement.dataset.prefetched = '1';
        }
      } catch {}
    });
    if (itemsToPrefetch.length === 0) return;
    if (typeof this.chat.api.prefetchTelegramMedia !== 'function') return;
    this.chat.api.prefetchTelegramMedia(itemsToPrefetch.map(i => ({
      chatId: i.chatId,
      messageId: i.messageId
    })))
      .then(response => {
        const isSuccess = response && response.success === true;
        const fileMap = response && response.data ? response.data.map : null;
        if (isSuccess && fileMap) {
          itemsToPrefetch.forEach(item => {
            const key = `${item.chatId}:${item.messageId}`;
            const cachedPath = fileMap[key];
            if (cachedPath) {
              this.chat._applyCachedUrl(item.element, '', cachedPath);
            }
          });
        } else {
          console.warn('[Prefetch Batch] Запрос на пакетное кэширование не удался или ответ в неверном формате.', response);
        }
      })
      .catch(err => {
        console.error('[Prefetch Batch] Ошибка пакетного кэширования:', err);
        itemsToPrefetch.forEach(item => {
          const el = item.element;
          if (el) delete el.dataset.prefetched;
        });
      });
  }

  observeNewMedia(container) {
    if (!this.chat._isActiveInstance() || !container) return;
    if (!this.chat._lazyObserver) this.chat.setupLazyMediaObserver();
    const seen = new Set();
    // Observe parents only. Including the nested <source> made video/audio
    // call .load() twice and doubled requests through the single bridge.
    const targets = container.querySelectorAll(
      'img[data-lazy-src], video[data-lazy="1"], audio[data-lazy="1"], video[data-lazy-poster]'
    );
    targets.forEach(target => {
      if (!target || seen.has(target)) return;
      seen.add(target);
      this.chat._prepareLazyImageLayout(target);
      try { this.chat._attachMediaSpinner(target); } catch {}

      if (!this.chat._lazyObserver) {
        this.chat._activateLazyMedia(target);
        return;
      }
      if (target.dataset.lazyObserved === '1') return;
      target.dataset.lazyObserved = '1';
      this.chat.lifetime.observe(this.chat._lazyObserver, target);
      // A root-scoped observer can miss a newly inserted, already-visible
      // tile after an album regroup. Trigger the same queued path on the next
      // frame; queue guards prevent a duplicate fetch when the observer fires.
      this.chat.lifetime.timeout(() => {
        if (!target.isConnected || !target.dataset.lazySrc || target.dataset.lazyObserved !== '1') return;
        const rect = target.getBoundingClientRect?.();
        const root = this.chat.messageArea?.getBoundingClientRect?.();
        const top = root?.top ?? 0;
        const bottom = root?.bottom ?? (window.innerHeight || document.documentElement.clientHeight || 0);
        if (!rect || rect.bottom < top || rect.top > bottom) return;
        this.chat._lazyObserver?.unobserve(target);
        this.chat._activateVisibleLazyMedia(target);
      }, 0);
    });
    try {
      const src = (this.chat.source || '').toLowerCase();
      // The bridge uses opaque media references; its intersection branch
      // above is the only prefetch path. The old batch endpoint belongs to a
      // direct legacy installation that exposes a Telegram HTTP service.
      // Desktop instead has a bounded native relay for each visible tile;
      // sending this batch request to its virtual UI host only produces a
      // 404 and can contend with the real media request.
      if (src === 'telegram'
        && !this.chat._isCompatibilityBridge()
        && window.APP_CONFIG?.desktopMode !== true) {
        this.chat._prefetchTelegramBatch(container);
      }
    } catch (e) {
      console.warn('[BaseChat] _prefetchTelegramBatch failed', e);
    }
  }

  _installMediaFailureFallbacks() {
    try {
      const root = this.chat.messagesContainer;
      if (!root) return;

      const bindVideo = (video) => {
        if (!video || video.__mediaFallbackBound) return;
        video.__mediaFallbackBound = true;

        // A browser may emit `stalled` while a valid large video is still
        // downloading (especially when an upstream relay ignores an initial
        // Range probe). Do not replace the player at that transient event.
        // Keep a download fallback for an actual media error, or only after a
        // full no-progress interval before metadata has arrived.
        const fallbackDelayMs = 45000;
        let fallbackTimer = null;
        let metadataReady = Number(video.readyState || 0) >= 1;
        const clearFallbackTimer = () => {
          if (fallbackTimer === null) return;
          this.chat.lifetime.clearTimeout(fallbackTimer);
          fallbackTimer = null;
        };
        const convertToFallback = () => {
          clearFallbackTimer();
          const holder = video.closest('.media-holder.video-holder');
          if (!holder) return;
          this.chat._addMediaRetryUI(holder, video);
        };
        const markMetadataReady = () => {
          metadataReady = true;
          clearFallbackTimer();
        };
        const armSlowLoadFallback = () => {
          clearFallbackTimer();
          if (metadataReady || !video.isConnected || video.error) return;
          fallbackTimer = this.chat.lifetime.timeout(() => {
            fallbackTimer = null;
            // A slow but progressing request must remain playable. The
            // fallback applies only when the player still has no metadata.
            if (!metadataReady && video.isConnected && Number(video.readyState || 0) < 1) {
              convertToFallback();
            }
          }, fallbackDelayMs);
        };

        video.addEventListener('error', convertToFallback, true);
        video.addEventListener('loadstart', () => { metadataReady = false; armSlowLoadFallback(); });
        // `progress` renews the timeout only while metadata is unavailable;
        // it prevents a slow full-file relay from being treated as broken.
        video.addEventListener('progress', armSlowLoadFallback);
        ['loadedmetadata', 'loadeddata', 'canplay', 'playing'].forEach(evt => {
          video.addEventListener(evt, markMetadataReady);
        });
        // `stalled` is intentionally not a failure handler. It must not
        // discard a player that may recover when the next upstream chunk
        // arrives; the existing no-progress timer remains authoritative.
        // The hook is installed after the initial lazy-load setup. Cover a
        // video that was already loading before these handlers were attached.
        if (video.networkState === 2 && !metadataReady) armSlowLoadFallback();
      };

      root.querySelectorAll('video.msg-video').forEach(bindVideo);

      if (!this.chat._mediaFallbackObserver) {
        this.chat._mediaFallbackObserver = new MutationObserver(list => {
          for (const rec of list) {
            rec.addedNodes && rec.addedNodes.forEach(n => {
              if (!n || n.nodeType !== 1) return;
              if (n.matches && n.matches('video.msg-video')) bindVideo(n);
              if (n.querySelectorAll) n.querySelectorAll('video.msg-video').forEach(bindVideo);
            });
          }
        });
        this.chat.lifetime.observe(this.chat._mediaFallbackObserver, root, { childList: true, subtree: true });
      }
    } catch (e) {
      console.warn('[MEDIA DEBUG] init failed', e);
    }
  }
}
