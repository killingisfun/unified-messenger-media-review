import { formatDateFullRu } from '../../core/utils.js';
import { getProvider } from '../../domain/providers.js';

/** History cursors, buffered pages, read scheduling and scroll position. */
export class ChatHistory {
  constructor(chat) { this.chat = chat; }

  _flushMessageBuffer() {
    if (this.chat._bufferFlushTimer) {
      clearTimeout(this.chat._bufferFlushTimer);
      this.chat._bufferFlushTimer = null;
    }
    if (this.chat._messageBuffer.length === 0) return;
    // A background refresh must never pull a person away from older
    // messages. Snapshot the intent before adding the new DOM nodes.
    const followBottom = this.chat._isNearBottom();
    const buffered = this.chat._messageBuffer;
    this.chat._messageBuffer = [];
    this.chat.renderMessagesBatch(buffered, false, { stickToBottom: followBottom });
  }

  _isNearBottom(threshold = 96) {
    const area = this.chat.messageArea;
    if (!area) return false;
    return (area.scrollHeight - area.scrollTop - area.clientHeight) <= Math.max(0, Number(threshold) || 0);
  }

  _historyMessageId(message) {
    return String(message?.id ?? message?.message_id ?? '');
  }

  _historyGroupKey(message) {
    const groupId = String(message?.groupId ?? message?.media_group_id ?? message?.group_id ?? '');
    if (!groupId) return '';
    return `${String(message?.direction) === 'out' ? 'out' : 'in'}:${groupId}`;
  }

  _sortHistoryMessages(messages) {
    return Array.isArray(messages) ? messages.slice().sort((a, b) => {
      const timeDiff = Number(a?.timestamp || 0) - Number(b?.timestamp || 0);
      if (timeDiff) return timeDiff;
      return this.chat._historyMessageId(a).localeCompare(this.chat._historyMessageId(b));
    }) : [];
  }

  _splitNewestHistoryPage(messages, pageSize = 30) {
    const sorted = this.chat._sortHistoryMessages(messages);
    if (sorted.length <= pageSize) return { page: sorted, older: [] };
    let start = Math.max(0, sorted.length - pageSize);
    // Do not split a provider album only because its final tile happens to
    // cross a page boundary. A slightly larger page is cheaper than broken
    // grouped media.
    const boundaryGroup = this.chat._historyGroupKey(sorted[start]);
    while (start > 0 && boundaryGroup && this.chat._historyGroupKey(sorted[start - 1]) === boundaryGroup) {
      start--;
    }
    return { page: sorted.slice(start), older: sorted.slice(0, start) };
  }

  _stashHistoryOverflow(messages, nextCursor, hasCursorField, requestedCursor = null) {
    const split = this.chat._splitNewestHistoryPage(messages);
    if (split.older.length === 0) return { items: split.page, hasOverflow: false };
    this.chat._localHistoryOverflow = split.older;
    this.chat._deferredHistoryCursor = nextCursor;
    this.chat._deferredHistoryCursorKnown = !!hasCursorField;
    this.chat._deferredHistoryRequestCursor = requestedCursor === null ? null : String(requestedCursor);
    return { items: split.page, hasOverflow: true };
  }

  _takeBufferedHistoryPage() {
    const split = this.chat._splitNewestHistoryPage(this.chat._localHistoryOverflow);
    this.chat._localHistoryOverflow = split.older;
    const oldestId = this.chat._historyMessageId(split.page[0]) || null;
    if (split.older.length > 0) {
      return { items: split.page, hasMore: true, oldestId };
    }
    const useDeferredCursor = this.chat._deferredHistoryCursorKnown;
    const deferredCursor = this.chat._deferredHistoryCursor;
    const deferredRequestCursor = this.chat._deferredHistoryRequestCursor;
    this.chat._deferredHistoryCursor = null;
    this.chat._deferredHistoryCursorKnown = false;
    this.chat._deferredHistoryRequestCursor = null;
    const repeatedDeferredCursor = useDeferredCursor && deferredCursor != null
      && deferredRequestCursor !== null && String(deferredCursor) === deferredRequestCursor;
    return {
      items: split.page,
      hasMore: !repeatedDeferredCursor && (useDeferredCursor ? !!deferredCursor : !!oldestId),
      oldestId: repeatedDeferredCursor ? null : (useDeferredCursor ? deferredCursor : oldestId),
    };
  }

  scrollToBottom() {
    try {
      // scrollIntoView() also scrolls the document itself. That made a
      // delayed media/group update look like a random jump to the bottom of
      // the page. The chat pane is the only scroll container we should move.
      const area = this.chat.messageArea;
      if (!area) return;
      const apply = () => {
        if (!this.chat._isActiveInstance() || !area.isConnected) return;
        area.scrollTop = Math.max(0, area.scrollHeight - area.clientHeight);
      };
      apply();
      const alignedTop = area.scrollTop;
      requestAnimationFrame(() => {
        // Layout can settle in the next frame. Keep following it only if a
        // user has not already started reading upward after the first scroll.
        if (!this.chat._isActiveInstance() || !area.isConnected) return;
        if (Math.abs(area.scrollTop - alignedTop) > 2) return;
        apply();
      });
    } catch (e) {
      console.warn('[BaseChat] scrollToBottom failed', e);
    }
  }

  scrollToBottomAfterImagesLoad() {
    // Media is lazy now. Do not attach global image handlers that can fire
    // minutes later after the user has started reading old history.
    if (this.chat._isNearBottom(128)) this.chat.scrollToBottom();
  }

  playSound() {
    new Audio('sound.mp3').play().catch(() => {});
  }

  markReadIfVisible() {
    if (this.chat._isPreviewMode()) return;
    // Read/seen can be a slow provider request (especially WPP). It must not
    // occupy the bridge while the user is waiting for an older history page.
    if (this.chat.isLoadingHistory || this.chat._historyRetryPending) return;
    if (this.chat._isCompatibilityBridge() && window.APP_CONFIG?.autoMarkRead !== true) return;
    if (!document.hidden && this.chat.chatDbId) {
      this.chat.api.markChatRead(this.chat.chatDbId, this.chat.source, this.chat.chatId).catch(() => {});
    }
  }

  _scheduleReadReceiptAfterFirstPaint() {
    if (this.chat._initialMarkReadTimer !== null || this.chat._isPreviewMode()) return;
    this.chat._initialMarkReadTimer = this.chat.lifetime.timeout(() => {
      this.chat._initialMarkReadTimer = null;
      this.chat.markReadIfVisible();
    }, 2000);
  }

  setupHistoryPagination() {
    if (!this.chat._isActiveInstance()) return;
    if (this.chat._historyObserver) this.chat._historyObserver.disconnect();
    if (!this.chat.hasMoreHistory || !this.chat.historyLoader) {
      this.chat.historyLoader.style.display = 'none';
      return;
    }
    this.chat._historyObserver = new IntersectionObserver((entries) => {
      if (entries[0].isIntersecting && !this.chat.isLoadingHistory && !this.chat._historyRetryPending) {
        this.chat.fetchOlderMessages();
      }
    }, {
      root: this.chat.messageArea,
      threshold: 0.01
    });
    this.chat.lifetime.observe(this.chat._historyObserver, this.chat.historyLoader);
    this.chat.historyLoader.style.display = 'block';
  }

  _setHistoryLoaderLoading() {
    if (!this.chat.historyLoader) return;
    this.chat.historyLoader.innerHTML = '<div class="spinner-border spinner-border-sm" role="status" aria-label="Загрузка истории"></div>';
    this.chat.historyLoader.style.display = 'block';
  }

  _showHistoryRetryButton() {
    if (!this.chat.historyLoader) return;
    // A spinner without a recovery action traps the person after a temporary
    // transport/provider failure. Keep the control compact and shared.
    this.chat.historyLoader.innerHTML = '<button type="button" class="history-retry" title="Повторить загрузку предыдущих сообщений" aria-label="Повторить загрузку предыдущих сообщений"><span aria-hidden="true">↻</span><span>Повторить</span></button>';
    this.chat.historyLoader.querySelector('.history-retry')?.addEventListener('click', () => {
      if (!this.chat._isActiveInstance()) return;
      this.chat._historyAbortController?.abort('manual-retry');
      this.chat._historyAbortController = null;
      if (this.chat._historyRetryTimer) this.chat.lifetime.clearTimeout(this.chat._historyRetryTimer);
      this.chat._historyRetryTimer = null;
      this.chat._historyRetryPending = false;
      this.chat._historyRetryAttempts = 0;
      this.chat.isLoadingHistory = false;
      void this.fetchOlderMessages();
    }, { once: true });
    this.chat.historyLoader.style.display = 'block';
  }

  _scheduleHistoryRetry() {
    if (!this.chat._isActiveInstance()) return;
    if (this.chat._historyRetryTimer) this.chat.lifetime.clearTimeout(this.chat._historyRetryTimer);
    this.chat._historyRetryPending = true;
    if (this.chat.historyLoader) {
      this.chat.historyLoader.innerHTML = '<div class="spinner-border spinner-border-sm" role="status" aria-label="Повторная загрузка истории"></div>';
      this.chat.historyLoader.style.display = 'block';
    }
    this.chat._historyRetryTimer = this.chat.lifetime.timeout(() => {
      this.chat._historyRetryTimer = null;
      if (!this.chat._isActiveInstance()) return;
      this.chat._historyRetryPending = false;
      this.chat.fetchOlderMessages();
    }, 1200);
  }

  rebuildDateSeparators() {
    const c = this.chat.messagesContainer;
    if (!c) return;
    c.querySelectorAll('.date-separator').forEach(el => el.remove());
    let prevKey = null;
    const msgs = Array.from(c.querySelectorAll('.message'));
    for (const el of msgs) {
      const ts = parseInt(el.dataset.timestamp || '0', 10);
      const d = new Date(ts * 1000);
      const key = `${d.getFullYear()}-${('0' + (d.getMonth() + 1)).slice(-2)}-${('0' + d.getDate()).slice(-2)}`;
      if (key !== prevKey) {
        const sep = document.createElement('div');
        sep.className = 'date-separator';
        const span = document.createElement('span');
        span.className = 'date-separator-badge';
        span.textContent = formatDateFullRu(ts);
        sep.appendChild(span);
        c.insertBefore(sep, el);
        prevKey = key;
      }
    }
    this.chat._updateStickyDateIndicator(false);
  }

  _setupStickyDateIndicator() {
    if (!this.chat.messageArea || this.chat._boundDateScroll) return;
    // SPA navigation creates a new BaseChat instance for every opened
    // dialogue. Remove indicators left by the previous instance so their
    // fixed badges cannot stack (or remain positioned over the left pane).
    document.querySelectorAll('.chat-sticky-date').forEach((el) => el.remove());
    const badge = document.createElement('div');
    badge.className = 'chat-sticky-date';
    badge.setAttribute('aria-hidden', 'true');
    document.body.appendChild(badge);
    this.chat._stickyDateEl = badge;
    this.chat._boundDateScroll = () => {
      this.chat._updateStickyDateIndicator(true);
      this.chat.lifetime.clearTimeout(this.chat._stickyDateHideTimer);
      this.chat._stickyDateHideTimer = this.chat.lifetime.timeout(() => this.chat._hideStickyDateIndicator(), 850);
    };
    this.chat._boundDateResize = () => this.chat._updateStickyDateIndicator(false);
    this.chat.lifetime.listen(this.chat.messageArea, 'scroll', this.chat._boundDateScroll, { passive: true });
    this.chat.lifetime.listen(window, 'resize', this.chat._boundDateResize, { passive: true });
  }

  _updateStickyDateIndicator(show = false) {
    const root = this.chat.messageArea;
    const badge = this.chat._stickyDateEl;
    if (!root || !badge) return;
    const rootRect = root.getBoundingClientRect();
    const separators = Array.from(this.chat.messagesContainer?.querySelectorAll('.date-separator') || []);
    const messages = Array.from(this.chat.messagesContainer?.querySelectorAll('.message') || []);
    if (!messages.length) return this.chat._hideStickyDateIndicator();

    // Select the last date separator that has reached the top edge.  This
    // mirrors Telegram: the current date stays pinned, and switches only as
    // the next separator physically pushes it away.
    const reached = separators.filter((el) => el.getBoundingClientRect().top <= rootRect.top + 22);
    const awayFromBottom = root.scrollHeight - root.scrollTop - root.clientHeight > 28;
    const activeSeparator = reached.length ? reached[reached.length - 1] : null;
    const activeRect = activeSeparator?.getBoundingClientRect();
    // When the real separator is still visible at the top of the viewport,
    // let it be the only date marker.  The floating marker is hidden early
    // enough to prevent the two badges from touching/overlapping. Once the
    // separator has fully scrolled above the viewport, it becomes covered and
    // the floating marker takes over.
    const realSeparatorVisible = Boolean(activeRect && activeRect.bottom > rootRect.top + 2 && activeRect.top < rootRect.top + 34);
    separators.forEach((el) => {
      const isActiveVisible = el === activeSeparator && realSeparatorVisible;
      el.classList.toggle('is-covered', Boolean(show && awayFromBottom && reached.includes(el) && !isActiveVisible));
    });
    let ts = 0;
    if (reached.length) {
      const badge = reached[reached.length - 1].querySelector('.date-separator-badge');
      const text = badge?.textContent || '';
      ts = Number(reached[reached.length - 1].nextElementSibling?.dataset.timestamp || 0);
      this.chat._setStickyDateText(text, badge?.textContent || '');
    } else {
      const first = messages.find((el) => el.getBoundingClientRect().bottom > rootRect.top + 8);
      ts = Number(first?.dataset.timestamp || 0);
    }
    if (!ts) return this.chat._hideStickyDateIndicator();
    if (!reached.length) this.chat._setStickyDateText(formatDateFullRu(ts), formatDateFullRu(ts));
    // The ordinary separators are centered by messagesContainer, which can
    // be narrower than the scrollable pane (for example, next to its
    // scrollbar). Align the fixed marker to that exact same geometry.
    const dateLaneRect = this.chat.messagesContainer?.getBoundingClientRect() || rootRect;
    badge.style.left = `${Math.round(dateLaneRect.left + dateLaneRect.width / 2)}px`;
    badge.style.top = `${Math.round(rootRect.top + 12)}px`;
    // At the current bottom the ordinary in-flow separator already explains
    // the date.  The floating marker is useful only while browsing history.
    badge.classList.toggle('is-visible', Boolean(show && awayFromBottom && !realSeparatorVisible));
  }

  _setStickyDateText(text, fallback = '') {
    const badge = this.chat._stickyDateEl;
    const value = String(text || fallback || '').trim();
    if (!badge || !value || badge.textContent === value || this.chat._stickyDatePendingText === value) return;
    this.chat.lifetime.clearTimeout(this.chat._stickyDateSwapTimer);
    this.chat._stickyDatePendingText = value;
    badge.classList.add('is-changing');
    this.chat._stickyDateSwapTimer = this.chat.lifetime.timeout(() => {
      if (!this.chat._isActiveInstance()) return;
      badge.textContent = value;
      this.chat._stickyDatePendingText = '';
      requestAnimationFrame(() => badge.classList.remove('is-changing'));
    }, 70);
  }

  _hideStickyDateIndicator() {
    this.chat._stickyDateEl?.classList.remove('is-visible');
    this.chat.messagesContainer?.querySelectorAll('.date-separator.is-covered').forEach((el) => el.classList.remove('is-covered'));
  }

  _scrollToBottomStrong(opts = {}) {
    try {
      const c = this.chat.messageArea;
      if (!c) return;
      const tries = Number(opts.tries || 12),
        delay = Number(opts.delay || 50);
      const s = () => {
        c.scrollTop = c.scrollHeight;
      };
      s();
      requestAnimationFrame(s);
      setTimeout(s, 0);
      setTimeout(s, 200);
      let i = 0;
      const t = setInterval(() => {
        s();
        if (++i >= tries) clearInterval(t);
      }, delay);
    } catch (e) {
      console.warn('[BaseChat] _scrollToBottomStrong failed', e);
    }
  }

  async fetchNewMessages() {
    this.chat._logRx?.('API: fetching new messages from server. Last timestamp:', this.chat.lastTimestamp);
    if (!this.chat._isActiveInstance() || this.chat._isLoadingInitial || this.chat._isLoadingNew
      || this.chat.isLoadingHistory || this.chat._historyRetryPending) return;
    const now = Date.now();
    if (this.chat._lastFetchNew && (now - this.chat._lastFetchNew < 800)) {
      return;
    }
    this.chat._lastFetchNew = now;
    this.chat._isLoadingNew = true;
    const normId = (v) => String(v ?? '');
    const attType = (a) => {
      if (!a) return 'unknown';
      const t = (a.type || '').toLowerCase();
      if (t) return t;
      const m = (a.mime || '').toLowerCase();
      if (m.startsWith('image/')) return 'photo';
      if (m.startsWith('video/')) return 'video';
      if (m.startsWith('audio/')) return 'audio';
      return 'file';
    };
    const extractMessages = (data) => {
      if (Array.isArray(data?.messages?.items)) return data.messages.items.slice();
      if (Array.isArray(data?.messages)) return data.messages.slice();
      if (Array.isArray(data?.items)) return data.items.slice();
      return [];
    };
    try {
      const data = await this.chat.api.getNewMessages(this.chat.chatDbId, this.chat.lastTimestamp);
      if (!this.chat._isActiveInstance()) return;
      this.chat.markReadIfVisible();
      // Every provider has a slightly different wire shape. Reconcile
      // against the canonical message contract before comparing text,
      // direction, timestamp or attachments with a local provisional bubble.
      // In particular, WPP can expose `message_text` / `fromMe` / millisecond
      // dates in a delayed cache response; comparing those raw fields made a
      // delivered message fail to consume its awaiting-sync twin.
      let incoming = extractMessages(data)
        .map((message) => this.chat._messageForCurrentChat(message))
        .filter((message) => message.id);
      this.chat._reconcileOutgoingOperations(incoming);

      // ---> НАЧАЛО ИСПРАВЛЕНИЯ
// Ставим ONLINE только по реально свежему входящему сообщению,
// а не по любой подгруженной истории.
const nowSec = Math.floor(Date.now() / 1000);
const hasFreshIncoming = incoming.some(m => {
  const dirIn = String(m.direction) !== 'out';
  const ts = Number(m.timestamp || 0);
  // должно быть входящее, с валидным timestamp,
  // новее уже увиденного и не старше 60 секунд
  return dirIn && ts && ts > this.chat.lastTimestamp && (nowSec - ts) <= 60;
});

if (hasFreshIncoming) {
  console.log('[Presence] Fresh incoming message, setting ONLINE');
  this.chat._applyPresenceHeader({
    state: 'online',
    until: nowSec + 120
  });
}
// ---> КОНЕЦ ИСПРАВЛЕНИЯ
      let fresh = [];
      for (const m of incoming) {
        const messageId = normId(m.id);
        if (this.chat.renderedMessageIds.has(messageId)) {
          // Also repair a stale acknowledged provisional bubble left by an
          // earlier UI build. The already-rendered native record remains the
          // single source of truth for its controls and receipt state.
          if (!this.chat._consumeOptimisticMessage(m)) this.chat.patchMessageDOM(m);
        } else {
          fresh.push(m);
        }
      }
      if (Array.isArray(data?.read_ids)) {
        this.chat.updateReadReceipts(data.read_ids);
      }
      if (incoming.length > 0) {
        const maxTs = Math.max(...incoming.map(m => Number(m.timestamp || 0)));
        if (isFinite(maxTs)) this.chat.lastTimestamp = Math.max(this.chat.lastTimestamp, maxTs);
      }
      // Use the same exact-id/batch-aware reconciler as history rendering.
      // A second timestamp matcher must never morph a whole batch into its first photo.
      for (let index = fresh.length - 1; index >= 0; index--) {
        if (this.chat._consumeOptimisticMessage(fresh[index])) fresh.splice(index, 1);
      }
      fresh = this.chat._holdIncomingWhatsAppBatchMessages(fresh);
      fresh = this.chat._stageIncomingWhatsAppPhotoAlbums(fresh);
      if (fresh.length > 0) {
        this.chat._messageBuffer.push(...fresh);
        if (this.chat._bufferFlushTimer) this.chat.lifetime.clearTimeout(this.chat._bufferFlushTimer);
        this.chat._bufferFlushTimer = this.chat.lifetime.timeout(() => {
          if (this.chat._isActiveInstance()) this.chat._flushMessageBuffer();
        }, 100);
      }
    } catch (e) {
      if (!this.chat._isActiveInstance()) return;
      console.error('[BaseChat] fetchNewMessages failed', e);
    } finally {
      this.chat._isLoadingNew = false;
      if (this.chat._isActiveInstance() && !this.chat._isHydratingRx && !this.chat._rxHydratedOnce) this.chat._scheduleReactionsHydration();
    }
  }

  async _getInitialMessages() {
    return this.chat.api.getInitialMessages(
      this.chat.source, this.chat.chatId, this.chat.chatDbId,
      () => this.chat._isActiveInstance(),
    );
  }

  async _getOlderMessages(cursor, signal = null) {
    return this.chat.api.getOlderMessages(
      this.chat.source, this.chat.chatId, cursor, this.chat.chatDbId,
      () => this.chat._isActiveInstance(), signal,
    );
  }

  _notifyInitialHistoryRendered(success) {
    if (!this.chat._isActiveInstance()) return;
    document.dispatchEvent(new CustomEvent('chat:first-history-rendered', {
      detail: {
        source: this.chat.source || '',
        chatId: this.chat.chatId || '',
        dbId: this.chat.chatDbId || '',
        success: success === true,
      },
    }));
  }

  _paintPinnedMessage(pinnedMessage) {
    if (getProvider(this.chat.source).id !== 'max') return;
    const banner = document.getElementById('chat-context-banner');
    if (!banner || pinnedMessage === undefined) return;
    const pinned = pinnedMessage && typeof pinnedMessage === 'object' ? pinnedMessage : null;
    const text = String(pinned?.text || '').trim();
    if (!text) {
      banner.classList.remove('chat-context-banner--pinned');
      delete banner.dataset.pinnedMessageId;
      banner.hidden = true;
      banner.replaceChildren();
      return;
    }
    const author = String(pinned?.author_name || '').trim();
    banner.hidden = false;
    banner.classList.add('chat-context-banner--pinned');
    banner.dataset.pinnedMessageId = String(pinned?.id || '');
    banner.innerHTML = `<i class="bi bi-pin-angle-fill" aria-hidden="true"></i><span class="chat-context-banner__copy"><strong>Закреплённое сообщение</strong><span>${this.chat._escapeHtml(author ? `${author}: ${text}` : text)}</span></span>`;
    const jump = document.createElement('button'); jump.type = 'button'; jump.className = 'pinned-message-link';
    jump.setAttribute('aria-label', 'Перейти к закреплённому сообщению');
    while (banner.firstChild) jump.append(banner.firstChild);
    jump.addEventListener('click', () => { if(this.chat._isActiveInstance()) void this.chat._jumpToQuotedMessage(String(pinned.id || '')); });
    banner.append(jump);
  }

  async fetchAndRenderInitialMessages() {
    if (this.chat._isLoadingInitial) return false;
    this.chat._isLoadingInitial = true;
    try {
      if (!this.chat._isActiveInstance()) return false;
      // Новый заход/страница чата -> разрешим одну bulk-гидрацию
      if (typeof this.chat._resetRxHydration === 'function') {
        this.chat._resetRxHydration();
      }
      if (this.chat.historyLoader) this.chat.historyLoader.style.display = 'none';
      if (this.chat.loader) this.chat.loader.style.display = 'block';
      const data = await this.chat._getInitialMessages();
      if (!this.chat._isActiveInstance()) return;
      this.chat._paintPinnedMessage(data?.pinnedMessage ?? data?.pinned_message);
      let messages = data.messages;
      let nextCursor = Object.prototype.hasOwnProperty.call(data, 'nextCursor') ? data.nextCursor : undefined;
      const haveCursorField = (nextCursor !== undefined);
      this.chat._localHistoryOverflow = [];
      this.chat._deferredHistoryCursor = null;
      this.chat._deferredHistoryCursorKnown = false;
      this.chat._deferredHistoryRequestCursor = null;
      const initialPage = this.chat._stashHistoryOverflow(messages, nextCursor, haveCursorField);
      messages = initialPage.items;
      this.chat.hasMoreHistory = initialPage.hasOverflow
        ? true
        : (haveCursorField ? !!nextCursor : (messages.length > 0));
      this.chat.oldestMessageId = initialPage.hasOverflow
        ? (this.chat._historyMessageId(messages[0]) || null)
        : (haveCursorField ? nextCursor : (this.chat._historyMessageId(messages[0]) || null));
      this.chat.messagesContainer.innerHTML = '';
      this.chat.renderedMessageIds.clear();
      if (messages.length > 0) {
        messages = this.chat._sortHistoryMessages(messages);
        // An adapter-supplied cursor is authoritative. It may differ from
        // the first rendered message when a provider hides system records.
        if (!initialPage.hasOverflow && !haveCursorField) this.chat.oldestMessageId = this.chat._historyMessageId(messages[0]) || null;
        if (!initialPage.hasOverflow && !haveCursorField) this.chat.hasMoreHistory = messages.length > 0;
        this.chat.lastTimestamp = Math.max(...messages.map(m => m.timestamp || 0));
      }
      this.chat.renderMessagesBatch(messages, false, { stickToBottom: true });
      // Let the shell refresh its full left list only after this selected
      // chat has its initial message page.  This is provider-neutral and
      // keeps a direct link responsive on the single-worker local bridge.
      this.chat._notifyInitialHistoryRendered(true);
      // A provider receipt can involve a slow WPP send-seen request. Text and
      // the message shell must paint before that side effect starts.
      this.chat._scheduleReadReceiptAfterFirstPaint();
      // опционально: если группы уже в DOM, зарегистрируем их один раз
      // (bulk-гидрация реакций выполнится один раз чуть позже)
      try {
        this.chat.messagesContainer
          .querySelectorAll('.message.album, .message.grouped-files')
          .forEach(el => this.chat._registerGroup(el));
      } catch {}
      return true;
    } catch (e) {
      if (!this.chat._isActiveInstance()) return;
      console.error('[BaseChat] Initial API fetch failed:', e);
      this.chat.messagesContainer.innerHTML = `
          <div class="text-center p-5">
            <p class="text-danger">Не удалось загрузить чат. Возможно, соединение прервалось.</p>
            <button id="retry-chat-load" class="btn btn-primary mt-2">Попробовать снова</button>
          </div>`;
      this.chat.hasMoreHistory = false;
      this.chat._notifyInitialHistoryRendered(false);
      const retryBtn = document.getElementById('retry-chat-load');
      if (retryBtn) {
        retryBtn.addEventListener('click', () => {
          retryBtn.disabled = true;
          retryBtn.textContent = 'Загрузка...';
          this.chat.fetchAndRenderInitialMessages();
        }, {
          once: true
        });
      }
      return false;
    } finally {
      this.chat._isLoadingInitial = false;
      if (this.chat._pendingRealtimeMessageFetch) this.chat._queueRealtimeMessageFetch();
      if (this.chat._isActiveInstance()) {
        if (this.chat.loader) this.chat.loader.style.display = 'none';
        this.chat.setupHistoryPagination();
      }
    }
  }

  async fetchOlderMessages() {
    const hasBufferedHistory = Array.isArray(this.chat._localHistoryOverflow) && this.chat._localHistoryOverflow.length > 0;
    if (!this.chat._isActiveInstance() || !this.chat.hasMoreHistory || (!hasBufferedHistory && !this.chat.oldestMessageId)) {
      if (this.chat.historyLoader) this.chat.historyLoader.style.display = 'none';
      return;
    }
    if (this.chat.isLoadingHistory || this.chat._historyRetryPending) return;
    // Подгружаем следующую "страницу" истории при листании вверх:
    // сбрасываем флаг, чтобы для ЭТОЙ новой порции прошла одна bulk-гидрация,
    // а дальше обновления реакций будут приходить по WS/новым сообщениям.
    if (typeof this.chat._resetRxHydration === 'function') {
      this.chat._resetRxHydration();
    }
    this.chat.isLoadingHistory = true;
    this.chat._historyRetryPending = false;
    let requestedCursor = null;
    let requestController = null;
    let slowFeedbackTimer = null;
    this.chat._setHistoryLoaderLoading();
    try {
      let messages = [];
      let nextCursor = undefined;
      if (hasBufferedHistory) {
        const localPage = this.chat._takeBufferedHistoryPage();
        messages = localPage.items;
        this.chat.oldestMessageId = localPage.oldestId;
        this.chat.hasMoreHistory = localPage.hasMore;
      } else {
        requestedCursor = String(this.chat.oldestMessageId);
        requestController = new AbortController();
        this.chat._historyAbortController = requestController;
        // The ordinary request timeout still applies. This earlier feedback
        // gives the person a way out of an unusually slow provider request.
        slowFeedbackTimer = this.chat.lifetime.timeout(() => {
          if (this.chat._isActiveInstance() && this.chat._historyAbortController === requestController) {
            this.chat._showHistoryRetryButton();
          }
        }, 12000);
        const data = await this.chat._getOlderMessages(this.chat.oldestMessageId, requestController.signal);
        if (!this.chat._isActiveInstance()) return;
        messages = data.messages;
        nextCursor = Object.prototype.hasOwnProperty.call(data, 'nextCursor') ? data.nextCursor : undefined;
        const haveCursorField = nextCursor !== undefined;
        const networkPage = this.chat._stashHistoryOverflow(messages, nextCursor, haveCursorField, requestedCursor);
        messages = networkPage.items;
        if (networkPage.hasOverflow) {
          this.chat.oldestMessageId = this.chat._historyMessageId(messages[0]) || null;
          this.chat.hasMoreHistory = true;
        } else if (haveCursorField) {
          this.chat.oldestMessageId = nextCursor;
          this.chat.hasMoreHistory = !!nextCursor;
          if (nextCursor != null && String(nextCursor) === requestedCursor) {
            // A repeated cursor would make the observer request the same page
            // forever. Stop safely until the adapter can provide a new cursor.
            this.chat.oldestMessageId = null;
            this.chat.hasMoreHistory = false;
          }
        } else if (messages.length > 0) {
          messages = this.chat._sortHistoryMessages(messages);
          this.chat.oldestMessageId = this.chat._historyMessageId(messages[0]) || null;
          this.chat.hasMoreHistory = true;
        } else {
          this.chat.hasMoreHistory = false;
          this.chat.oldestMessageId = null;
        }
      }
      if (messages.length > 0) {
        const area = this.chat.messageArea;
        const rootTop = area.getBoundingClientRect().top;
        const anchor = Array.from(this.chat.messagesContainer.querySelectorAll('.message'))
          .find((node) => node.getBoundingClientRect().bottom > rootTop + 1) || null;
        const anchorOffset = anchor ? anchor.getBoundingClientRect().top - rootTop : 0;
        const prevH = area.scrollHeight;
        const previousTop = area.scrollTop;
        const addedCount = this.chat.renderMessagesBatch(messages, true);
        // Plain legacy lists have no explicit cursor. If they repeat their
        // oldest DOM record, another observer turn would request the same
        // page forever. Do not stop an adapter that advanced a real cursor.
        if (addedCount === 0 && requestedCursor !== null
          && String(this.chat.oldestMessageId ?? '') === requestedCursor) {
          this.chat.oldestMessageId = null;
          this.chat.hasMoreHistory = false;
        }

        // Preserve the message which was visible before prepending. A second
        // guarded pass covers the delayed album/date normalization without
        // overriding a manual scroll made while the request was in flight.
        const restoreViewport = () => {
          if (!this.chat._isActiveInstance() || !area.isConnected) return area.scrollTop;
          if (anchor?.isConnected) {
            area.scrollTop += anchor.getBoundingClientRect().top - area.getBoundingClientRect().top - anchorOffset;
          } else {
            area.scrollTop = previousTop + (area.scrollHeight - prevH);
          }
          return area.scrollTop;
        };
        const restoredTop = restoreViewport();
        requestAnimationFrame(() => {
          if (Math.abs(area.scrollTop - restoredTop) <= 6) restoreViewport();
        });
        this.chat.lifetime.timeout(() => {
          if (Math.abs(area.scrollTop - restoredTop) <= 6) restoreViewport();
        }, 360);
      }
      if (!this.chat.hasMoreHistory && this.chat.historyLoader) {
        this.chat.historyLoader.style.display = 'none';
      }
      this.chat._historyRetryAttempts = 0;
    } catch (e) {
      if (!this.chat._isActiveInstance()) return;
      // A manual retry aborts the superseded request. The new request owns the
      // loader and must not inherit automatic retry from the old one.
      if (requestController && this.chat._historyAbortController !== requestController) return;
      console.error('[BaseChat] Ошибка при загрузке старых сообщений:', e);
      // Keep the cursor and `hasMoreHistory`: a timeout/temporary provider
      // failure is not proof that the conversation has ended. Retry once
      // automatically, then keep the neutral loading indicator instead of
      // turning the message column into a manual retry control.
      if (this.chat._historyRetryAttempts < 1) {
        this.chat._historyRetryAttempts += 1;
        this.chat._scheduleHistoryRetry();
      } else {
        this.chat._historyRetryPending = true;
        this.chat._showHistoryRetryButton();
      }
    } finally {
      if (slowFeedbackTimer) this.chat.lifetime.clearTimeout(slowFeedbackTimer);
      if (!requestController || this.chat._historyAbortController === requestController) {
        this.chat._historyAbortController = null;
        this.chat.isLoadingHistory = false;
      }
    }
  }
}
