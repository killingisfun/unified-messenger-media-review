import { TelegramDiscussion } from './chat/TelegramDiscussion.js?v=20261004-perf-r1';
import { messageStates } from '../core/messageStates.js?v=20260921-chat-list-receipts-r2';
import { ChatLifetime } from '../core/ChatLifetime.js';
import { getProvider } from '../domain/providers.js';
import { ApiService } from '../core/ApiService.js?v=20261004-perf-r1';
import { ReactionActors } from './chat/ReactionActors.js?v=20261004-perf-r1';
import { ChatReactions } from './chat/ChatReactions.js?v=20261004-perf-r1';
import { MediaGallery } from './chat/MediaGallery.js?v=20261009-download-names-r1';
import { MediaUrls } from './chat/MediaUrls.js?v=20261001-static-sticker-r5';
import { MessageRenderer } from './chat/MessageRenderer.js?v=20261009-vk-private-video-r4';
import { ChatOutbox } from './chat/ChatOutbox.js?v=20260923-telegram-delete-r11';
import { ChatAlbums } from './chat/ChatAlbums.js?v=20260923-telegram-delete-r11';
import { ChatHistory } from './chat/ChatHistory.js?v=20261004-perf-r1';
import { MessageReceipts } from './chat/MessageReceipts.js?v=20260923-telegram-delete-r11';
import { ChatComposer } from './chat/ChatComposer.js?v=20260923-telegram-delete-r11';
import { MediaLoader } from './chat/MediaLoader.js?v=20261007-media-terminal-r1';
import { ChatProfile } from './chat/ChatProfile.js?v=20261003-avatar-cache-r17';
import { SendJournal } from './chat/SendJournal.js?v=20260923-telegram-delete-r11';
import { ChatRealtime } from './chat/ChatRealtime.js?v=20261004-perf-r1';

// Session owner and compatibility facade for provider subclasses.
export class BaseChat {
  constructor(options = {}) {
    this.api = new ApiService();
    this.lifetime = new ChatLifetime('chat');
    this._lastPresence = { state: 'hidden', until: 0, last: 0 };
    // Reactions hydration: do bulk only once per "page" of messages
    this._rxHydratedOnce = false;
    // helper to reset hydration state when we load a new slice/page/history
    this._resetRxHydration = () => {
      this._rxHydratedOnce = false;
    };

    const urlParams = new URLSearchParams(window.location.search);

        this.source = (urlParams.get('source') || '').trim();
    // Фоллбек: если параметр отсутствует, а это телеграм-чат — подставим 'Telegram'
    if (!this.source && (window.APP_CONFIG?.TELEGRAM_API_URL || window.APP_CONFIG?.TG_HOST)) {
      this.source = 'Telegram';
    }
    this.provider = getProvider(options.provider || this.source);
    // Adapters translate provider-native album markers into a tiny common
    // contract. The renderer below never needs to parse WPP/Telegram ids.
    this.albumTransport = options.albumTransport || null;
    this.chatId = urlParams.get('chat_id');
    this.chatDbId = urlParams.get('db_id');
    const chatTitle = (urlParams.get('title') || '').trim();
    this.chatTitle = chatTitle;
const itemTitle = (urlParams.get('item_title') || '').trim();

// Reuse the selected chat identity while supplementary details are loading.
document.title = 'Чат';
const titleHost = document.getElementById('chat-title');
if (titleHost) {
  titleHost.classList.toggle('title-skeleton', !chatTitle);
  if (chatTitle) titleHost.textContent = chatTitle;
  else titleHost.innerHTML = `<span class="skeleton-line" style="width:52%"></span>`;
}
    // presence placeholder below title + lightweight styles
    (function() {
      const host = document.getElementById('chat-title');
      if (host && !document.getElementById('chat-presence')) {
        const s = document.createElement('div');
        s.id = 'chat-presence';
        s.className = 'chat-presence small text-muted mt-1';
        host.parentElement && host.parentElement.appendChild(s);
      }

    })();
    document.getElementById('form-source').value = this.source || '';
    document.getElementById('form-chat-id').value = this.chatId || '';
    this.messagesContainer = document.getElementById('messages-container');
    this.messageArea = document.querySelector('.message-area');
    this.loader = document.getElementById('loader');
    this.messageForm = document.getElementById('message-form');
    this.messageInput = document.getElementById('message-input');
    this.attachmentInput = document.getElementById('attachment-input');
    this.attachmentPreview = document.getElementById('attachment-preview');
    this.sendBtn = document.getElementById('send-btn');
    this.sendBtnSpinner = this.sendBtn ? this.sendBtn.querySelector('.spinner-border') : null;
    this.sendBtnText = this.sendBtn ? this.sendBtn.querySelector('.send-text') : null;
    // Delivery is deliberately serialized per open chat: WPP and the bridge
    // preserve message order this way, while the composer itself stays free
    // immediately after every submit.
    this._sending = false;
    this._sendQueue = Promise.resolve();
    this._pendingSendCount = 0;
    this._sendSequence = 0;
    this._listenersBound = false;
    this._clipboardFile = null;
    this._stagedFiles = [];
    this._attachmentPreviewUrls = new Set();
    this._boundHandleSendMessage = null;
    this._boundHandleAttachmentChange = null;
    this._boundAttachmentPreviewClick = null;
    this._boundHandlePaste = null;
    this._boundVisibilityChange = null;
    this._boundWindowFocus = null;
    this._boundWindowBlur = null;
    this._lastSendSig = null;
    this._lastSendAt = 0;
    this._lastOptimistic = null;
    this.historyLoader = document.createElement('div');
    this.historyLoader.id = 'history-loader';
    this.historyLoader.className = 'text-center p-3';
    this.historyLoader.innerHTML = '<div class="spinner-border spinner-border-sm" role="status"></div>';
    this.historyLoader.style.display = 'none';
    this.messageArea.prepend(this.historyLoader);
    this.lastTimestamp = 0;
    this.oldestMessageId = null;
    this.isLoadingHistory = false;
    this.hasMoreHistory = true;
    // Some legacy adapters ignore their requested page size and return an
    // entire local history. Keep the older part in the common UI state so
    // every provider still renders the newest page first.
    this._localHistoryOverflow = [];
    this._deferredHistoryCursor = null;
    this._deferredHistoryCursorKnown = false;
    this._deferredHistoryRequestCursor = null;
    this.renderedMessageIds = new Set();
    this._isLoadingInitial = false;
    this._lazyObserver = null;
    // WhatsApp relay media is decoded by WPP on the server. Keep that costly
    // work bounded so the text page remains usable while visible tiles arrive.
    this._waMediaQueue = [];
    this._waMediaActive = new Set();
    this._waMediaReleaseTimers = new Map();
    this._waMediaFlushTimer = null;
    this._waMediaSequence = 0;
    // Telegram thumbnails and originals share Madeline's backend lock with
    // history. A single visible request keeps a nearby album responsive while
    // an older-page cursor can proceed without a burst of thumbnail downloads.
    this._telegramMediaQueue = [];
    this._telegramMediaActive = new Set();
    this._telegramMediaReleaseTimers = new Map();
    this._telegramMediaFlushTimer = null;
    this._telegramMediaSequence = 0;
    this._initialMarkReadTimer = null;
    this._chatDetailsTimer = null;
    this._historyObserver = null;
    // A failed history request must not permanently turn pagination off. Keep
    // one bounded automatic retry and then expose an explicit retry button;
    // the IntersectionObserver is held while either state is pending.
    this._historyRetryTimer = null;
    this._historyRetryPending = false;
    this._historyRetryAttempts = 0;
    this._historyAbortController = null;
    // renderMessagesBatch debounces grouping. Remember only roots added by
    // those batches so the later lazy-media pass does not rescan the whole
    // accumulated conversation on every page.
    this._pendingMediaRoots = new Set();
    this._stickyDateEl = null;
    this._stickyDateHideTimer = null;
    this._stickyDateSwapTimer = null;
    this._stickyDatePendingText = '';
    this._boundDateScroll = null;
    this._tinyTransparent = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==';
    this._videoPoster = `data:image/svg+xml;utf8,` + encodeURIComponent(`
          <svg xmlns="http://www.w3.org/2000/svg" width="800" height="450" viewBox="0 0 800 450">
            <rect width="100%" height="100%" fill="#000"/>
            <circle cx="400" cy="225" r="56" fill="rgba(255,255,255,.25)"/>
            <polygon points="380,195 430,225 380,255" fill="#fff"/>
          </svg>`);


    this._setupStickyDateIndicator();






    // --- Presence (dot/label) styles for header ---

    console.info('[BaseChat] constructor: DOM ready');
    try {
      if (typeof window !== 'undefined') {
        window.__bc = this;
        if (!window.getBC) {
          Object.defineProperty(window, 'getBC', {
            value: () => window.__bc,
            writable: false,
            configurable: true
          });
        }
        if (!window.BaseChat) {
          Object.defineProperty(window, 'BaseChat', {
            value: this.constructor,
            writable: true,
            configurable: true
          });
        }
        console.log('%c[BaseChat] Instance attached to window.__bc', 'color:#0aa', this);
      }
    } catch (e) {
      console.warn('[BaseChat] debug expose failed', e);
    }
    this.originalTitle = document.title;
    this.isWindowActive = true;
    this._currentAlbumGroup = null;
    this._messageBuffer = [];
    this._bufferFlushTimer = null;
    // WPP webhooks can arrive before the batch status poll has exact native
    // IDs. Keep those records out of standalone DOM cards until identity binds
    // them to the provisional album.
    this._heldBatchIncoming = new Map();
    this._heldBatchIncomingTimer = null;
    this._groupingTimeout = null;
    this._pendingReactions = new Map();
    // A send-reaction acknowledgement is not an authoritative snapshot.
    // Keep the local mutation visible until a later provider update arrives
    // instead of replacing it with an older aggregate fetched immediately.
    this._pendingReactionMutations = new Map();
    this._reactionIntents = new Map();
    this._reactionMutationVersions = new Map();
    this._ownWhatsAppReactionAvatar = '';
    this._messageStates = messageStates;
    this.lifetime.add(messageStates.subscribe((source, chatId) => {
      if (source === getProvider(this.source).id && String(this.chatDbId) === chatId && this._isActiveInstance()) {
        this._paintSharedMessageStates();
      }
    }));
    this._rxByMessageId = new Map();
    this._rxDebug = new URLSearchParams(window.location.search).get('debug_rx') === '1';
    this._logRx = (...args) => {
      try {
        if (this._rxDebug) console.log('%c[RX]', 'color:#7b5cff;font-weight:600', ...args);
      } catch {}
    };
    this._logRx('constructor: ready, source=', this.source, 'chatId=', this.chatId, 'dbId=', this.chatDbId);
    this._isHydratingRx = false;
    this._rxInflightSingles = new Map();
    // The compatibility bridge keeps a low-frequency fallback poll, while
    // WhatsApp uses a filtered active-chat socket for messages, receipts and
    // reactions. This prevents repeated cache reads from competing with media
    // and pagination.
    this._bridgeLiveSocket = null;
    this._bridgeLiveReconnectTimer = null;
    // A realtime message can arrive while initial history or a prior refresh
    // owns the bridge. Keep one demand instead of discarding that event.
    this._pendingRealtimeMessageFetch = false;
    this._pendingRealtimeMessageFetchTimer = null;
    // The realtime broker assigns a monotonic ID to every event. Retaining the
    // last observed one lets a short SSH/WebSocket reconnect replay the event
    // that arrived while the socket was down, including phone-originated
    // outgoing WhatsApp messages.
    this._bridgeRealtimeId = 0;
    this._bridgeReactionSnapshotsAvailable = null;
    this._maxRealtimePoll = null;
    this._maxRealtimePollInFlight = false;
    this.USE_BULK_REACTIONS = true;
    this._hydrationTimer = null;
    this._scheduleReactionsHydration = () => {
      if (this._hydrationTimer) this.lifetime.clearTimeout(this._hydrationTimer);
      this._hydrationTimer = this.lifetime.timeout(() => {
        this._hydrationTimer = null;
        if (this._isActiveInstance() && !this._rxHydratedOnce) this._hydrateReactionsForViewportBatch();
      }, 1400);
    };

    // ==== group RX scheduler & indexes ====
    this._msgIdToGroupKey = new Map();
    this._groupKeyToEl = new Map();
    this._pendingGroupRx = new Set();
    this._groupRxTimer = null;
    this._scheduleGroupRxFlush = () => {
      if (this._groupRxTimer) return;
      this._groupRxTimer = this.lifetime.timeout(() => {
        this._groupRxTimer = null;
        if (this._isActiveInstance()) this._flushGroupRx();
      }, 60); // 60–80мс — нормальный дебаунс
    };
    this._replyContext = null;
    this._reactionPickerCleanup = null;
    this._outgoingAccountKey = this._operationAccountKeyFromConfig();
    void this._primeOutgoingAccountKey();
    this._primeWhatsAppReactionAvatar();
  }

  _isPreviewMode() {
    try {
      return window.APP_CONFIG?.previewMode === true
        || new URLSearchParams(window.location.search).get('preview') === '1';
    } catch (_) {
      return false;
    }
  }

  _isCompatibilityBridge() {
    try {
      return window.APP_CONFIG?.bridgeMode === true;
    } catch (_) {
      return false;
    }
  }

  async initialize() {
    if (!this._isActiveInstance()) return;
    this._subscribeToSharedRealtimeEvents();
     // ---> НАЧАЛО ИСПРАВЛЕНИЯ
    // Принудительно сбрасываем статус при загрузке, чтобы убрать серверную "заглушку"
    // и показать пользователю, что статус еще не определен.
    try {
        const dot = document.getElementById('presence-dot');
        const label = document.getElementById('presence-label');
        const pres = document.getElementById('chat-presence');

        if (dot) dot.className = 'presence-dot'; // Убираем все классы кроме базового
        if (label) label.textContent = '...'; // Показываем нейтральный текст
        if (pres) pres.textContent = '';

    } catch (e) {
        console.warn('Failed to reset initial presence UI', e);
    }
    // ---> КОНЕЦ ИСПРАВЛЕНИЯ
    if (!this._isActiveInstance()) return;
    const headerTitle = document.getElementById('chat-title');
    if (headerTitle) {
      const genericTelegramTitle = getProvider(this.source || '').id === 'telegram'
        && /^telegram\s+\d+$/i.test(String(this.chatTitle || '').trim());
      if (!genericTelegramTitle) {
        headerTitle.textContent = this.chatTitle || 'Чат';
        headerTitle.classList.remove('title-skeleton');
      }
    }
    this._renderProviderBadge();
    if (this._isPreviewMode()) {
      if (this.messageInput) {
        this.messageInput.disabled = true;
        this.messageInput.placeholder = 'Предпросмотр: отправка отключена';
      }
      if (this.attachmentInput) this.attachmentInput.disabled = true;
      if (this.sendBtn) this.sendBtn.disabled = true;
      this._showFeatureNotice('Предпросмотр показывает демонстрационные данные и не обращается к подключённым сервисам.');
    }
    this.setupHistoryPagination();
    const initialRendered = await this.fetchAndRenderInitialMessages();
    if (this.lifetime.disposed) return;
    this._resumeUnknownOutgoingOperations();
    // History is a snapshot from the dedicated read worker. Close the gap
    // before the chat socket opens: a webhook can update the list while that
    // snapshot is in flight, and its native message must still enter the pane.
    if (initialRendered && this._isCompatibilityBridge() && getProvider(this.source).id === 'whatsapp') {
      await this.fetchNewMessages();
    }
    if (this.lifetime.disposed) return;
    // Static provider capabilities already cover the first paint. The remote
    // override is secondary and otherwise queues beside the first history,
    // unread and realtime reads on the single-process local bridge.
    // Capabilities are server configuration, not chat history. A deployment
    // or a provider reconnection can legitimately change them while this
    // chat stays open. Revalidate the small manifest in the background so a
    // disabled header control cannot remain stale until the user reopens the
    // same conversation. This endpoint never opens a provider chat or marks
    // anything read.
    const refreshCapabilities = () => {
      void this._loadProviderCapabilities().then(() => {
        if (this._isActiveInstance()) {
          this._applyCapabilityVisibility();
          this._refreshMessageActions();
        }
      });
    };
    this.lifetime.timeout(refreshCapabilities, 1800);
    this.lifetime.interval(() => {
      if (!document.hidden && this._isActiveInstance()) refreshCapabilities();
    }, 60_000);
    // The header lookup uses the chat-list cache. Defer it slightly so it
    // cannot contend with the first history response or visible media.
    this._chatDetailsTimer = this.lifetime.timeout(() => {
      this._chatDetailsTimer = null;
      void this._loadChatDetailsIntoHeader();
    }, 250);
    this._installNativeGallery();
    try {
      this._installMediaFailureFallbacks();
    } catch (e) {
      console.warn('[MEDIA DEBUG] hook fail', e);
    }
    try {
      this._installWaLightboxDebug();
    } catch (e) {
      console.warn('[WA DEBUG] hook fail', e);
    }
    this.connectWebSocket();
    this.setupEventListeners();

    // === PresenceUI: дай ему знать какой чат открыт ===
    try {
      const pane = document.querySelector('.chat-pane');
      if (pane) {
        pane.dataset.source = this.source || '';
        pane.dataset.chatId = this.chatId || '';
      }
      window.__currentSource = this.source || ''; window.__currentChatId = this.chatId || '';
    } catch {}
  }

  _isActiveInstance() {
    return !this.lifetime?.disposed && (!window.currentChat || window.currentChat === this);
  }

  destroy() {
    this._telegramDiscussion?.close();
    this._clearAttachmentPreview();
    try {
      if (typeof window !== 'undefined' && window.__bc === this) {
        delete window.__bc;
      }
    } catch {}
    try {
      this.__wa_patch_cleanup && this.__wa_patch_cleanup();
    } catch {}
    try {
      this._galleryCleanup && this._galleryCleanup();
    } catch {}
    this._closeReactionPicker();
    if (this._featureNoticeTimer) this.lifetime.clearTimeout(this._featureNoticeTimer);
    if (this._hydrationTimer) this.lifetime.clearTimeout(this._hydrationTimer);
    if (this._groupRxTimer) this.lifetime.clearTimeout(this._groupRxTimer);
    if (this._groupingTimeout) this.lifetime.clearTimeout(this._groupingTimeout);
    if (this._historyRetryTimer) this.lifetime.clearTimeout(this._historyRetryTimer);
    this._historyAbortController?.abort('chat-destroyed');
    this._historyAbortController = null;
    if (this._bufferFlushTimer) this.lifetime.clearTimeout(this._bufferFlushTimer);
    if (this._heldBatchIncomingTimer) this.lifetime.clearTimeout(this._heldBatchIncomingTimer);
    this._heldBatchIncoming?.clear?.();
    if (this._waMediaFlushTimer) this.lifetime.clearTimeout(this._waMediaFlushTimer);
    if (this._telegramMediaFlushTimer) this.lifetime.clearTimeout(this._telegramMediaFlushTimer);
    if (this._initialMarkReadTimer) this.lifetime.clearTimeout(this._initialMarkReadTimer);
    if (this._chatDetailsTimer) this.lifetime.clearTimeout(this._chatDetailsTimer);
    for (const timer of this._waMediaReleaseTimers?.values?.() || []) {
      this.lifetime.clearTimeout(timer);
    }
    for (const timer of this._telegramMediaReleaseTimers?.values?.() || []) {
      this.lifetime.clearTimeout(timer);
    }
    this._waMediaQueue = [];
    this._waMediaActive?.clear?.();
    this._waMediaReleaseTimers?.clear?.();
    this._telegramMediaQueue = [];
    this._telegramMediaActive?.clear?.();
    this._telegramMediaReleaseTimers?.clear?.();
    if (this._presenceTimer) this.lifetime.clearTimeout(this._presenceTimer);
    if (this._stickyDateHideTimer) this.lifetime.clearTimeout(this._stickyDateHideTimer);
    if (this._stickyDateSwapTimer) this.lifetime.clearTimeout(this._stickyDateSwapTimer);
    if (this._socketReconnectTimer) this.lifetime.clearTimeout(this._socketReconnectTimer);
    if (this._bridgeLiveReconnectTimer) this.lifetime.clearTimeout(this._bridgeLiveReconnectTimer);
    if (this._listenersBound) {
      if (this.messagesContainer) this.messagesContainer.removeEventListener('click', this._boundMessageContainerClick);
      if (this.messagesContainer) this.messagesContainer.removeEventListener('error', this._boundReactionAvatarError, true);
      if (this.messageForm) this.messageForm.removeEventListener('submit', this._boundHandleSendMessage);
      if (this.messageForm) this.messageForm.removeEventListener('click', this._boundComposerClick);
      if (this.attachmentInput) this.attachmentInput.removeEventListener('change', this._boundHandleAttachmentChange);
      if (this.attachmentPreview) this.attachmentPreview.removeEventListener('click', this._boundAttachmentPreviewClick);
      if (this.messageInput) this.messageInput.removeEventListener('paste', this._boundHandlePaste);
      if (this.messageInput) this.messageInput.removeEventListener('input', this._boundComposerDraftInput);
      if (this.messageArea) this.messageArea.removeEventListener('paste', this._boundHandlePaste);
      document.removeEventListener('visibilitychange', this._boundVisibilityChange);
      window.removeEventListener('focus', this._boundWindowFocus);
      window.removeEventListener('blur', this._boundWindowBlur);
    }
    if (this.messageArea && this._boundDateScroll) this.messageArea.removeEventListener('scroll', this._boundDateScroll);
    if (this._boundDateResize) window.removeEventListener('resize', this._boundDateResize);
    if (this._lazyObserver) this._lazyObserver.disconnect();
    if (this._historyObserver) this._historyObserver.disconnect();
    if (this._mediaFallbackObserver) this._mediaFallbackObserver.disconnect();
    try { this._stickyDateEl?.remove(); } catch {}
    this._stickyDateEl = null;
    this._pendingReactionMutations?.clear();
    this._reactionIntents?.clear();
    this._reactionMutationVersions?.clear();
    this._rxInflightSingles?.clear();
    this._pendingMediaRoots?.clear?.();
    this._historyRetryPending = false;
    try { this.lifetime.dispose(); } catch {}
    if (typeof window !== 'undefined' && window.currentChat === this) {
      window.currentChat = null;
      window.__currentSource = '';
      window.__currentChatId = '';
    }
    this._listenersBound = false;
  }

  get telegramDiscussion() { return this._telegramDiscussion ??= new TelegramDiscussion(this); }
  get reactionActors() { return this._featureReactionActors ??= new ReactionActors(this); }
  get chatReactions() { return this._featureChatReactions ??= new ChatReactions(this); }
  get mediaGallery() { return this._featureMediaGallery ??= new MediaGallery(this); }
  get mediaUrls() { return this._featureMediaUrls ??= new MediaUrls(this); }
  get messageRenderer() { return this._featureMessageRenderer ??= new MessageRenderer(this); }
  get chatOutbox() { return this._featureChatOutbox ??= new ChatOutbox(this); }
  get chatAlbums() { return this._featureChatAlbums ??= new ChatAlbums(this); }
  get chatHistory() { return this._featureChatHistory ??= new ChatHistory(this); }
  get messageReceipts() { return this._featureMessageReceipts ??= new MessageReceipts(this); }
  get chatComposer() { return this._featureChatComposer ??= new ChatComposer(this); }
  get mediaLoader() { return this._featureMediaLoader ??= new MediaLoader(this); }
  get chatProfile() { return this._featureChatProfile ??= new ChatProfile(this); }
  get sendJournal() { return this._featureSendJournal ??= new SendJournal(this); }
  get chatRealtime() { return this._featureChatRealtime ??= new ChatRealtime(this); }

  _primeWhatsAppReactionAvatar(...args) { return this.reactionActors._primeWhatsAppReactionAvatar(...args); }
  _isDirectWhatsAppChat(...args) { return this.reactionActors._isDirectWhatsAppChat(...args); }
  _replaceReactionAvatarSlots(...args) { return this.reactionActors._replaceReactionAvatarSlots(...args); }
  _paintWhatsAppReactionAvatars(...args) { return this.reactionActors._paintWhatsAppReactionAvatars(...args); }
  _reactionActorsForRender(...args) { return this.reactionActors._reactionActorsForRender(...args); }
  _reactionActorKey(...args) { return this.reactionActors._reactionActorKey(...args); }
  _reactionAvatarMarkup(...args) { return this.reactionActors._reactionAvatarMarkup(...args); }
  _handleReactionAvatarError(...args) { return this.reactionActors._handleReactionAvatarError(...args); }
  _setReactionMarkup(...args) { return this.chatReactions._setReactionMarkup(...args); }
  _primeWhatsAppContactAvatar(...args) { return this.reactionActors._primeWhatsAppContactAvatar(...args); }
  _normalizeReactions(...args) { return this.chatReactions._normalizeReactions(...args); }
  _combineReactionsWithActors(...args) { return this.reactionActors._combineReactionsWithActors(...args); }
  _onMessageReactionsUpdated(...args) { return this.chatReactions._onMessageReactionsUpdated(...args); }
  _queueTelegramReactionActorAvatars(...args) { return this.reactionActors._queueTelegramReactionActorAvatars(...args); }
  _reactionActorAvatarRefreshDue(...args) { return this.reactionActors._reactionActorAvatarRefreshDue(...args); }
  _drainTelegramReactionActorAvatarQueue(...args) { return this.reactionActors._drainTelegramReactionActorAvatarQueue(...args); }
  _computeAggregatedReactions(...args) { return this.chatReactions._computeAggregatedReactions(...args); }
  _registerGroup(...args) { return this.chatReactions._registerGroup(...args); }
  _flushGroupRx(...args) { return this.chatReactions._flushGroupRx(...args); }
  _ensureGroupRxContainer(...args) { return this.chatReactions._ensureGroupRxContainer(...args); }
  _ensureGroupReactionButton(...args) { return this.chatReactions._ensureGroupReactionButton(...args); }
  _installNativeGallery(...args) { return this.mediaGallery._installNativeGallery(...args); }
  _updateGroupReactionsForMessage(...args) { return this.chatReactions._updateGroupReactionsForMessage(...args); }
  _pickBestMediaUrl(...args) { return this.mediaUrls._pickBestMediaUrl(...args); }
  _toLightboxOpenUrl(...args) { return this.mediaGallery._toLightboxOpenUrl(...args); }
  _handleDownloadAllClick(...args) { return this.mediaGallery._handleDownloadAllClick(...args); }
  patchMessageDOM(...args) { return this.messageRenderer.patchMessageDOM(...args); }
  _isVisualOutgoingMessage(...args) { return this.chatOutbox._isVisualOutgoingMessage(...args); }
  _pendingWhatsAppBatchElement(...args) { return this.chatAlbums._pendingWhatsAppBatchElement(...args); }
  _scheduleHeldBatchIncomingFlush(...args) { return this.chatAlbums._scheduleHeldBatchIncomingFlush(...args); }
  _holdIncomingWhatsAppBatchMessages(...args) { return this.chatAlbums._holdIncomingWhatsAppBatchMessages(...args); }
  _stageIncomingWhatsAppPhotoAlbums(...args) { return this.chatAlbums._stageIncomingWhatsAppPhotoAlbums(...args); }
  _upsertIncomingNativeAlbum(...args) { return this.chatAlbums._upsertIncomingNativeAlbum(...args); }
  _takeHeldBatchIncoming(...args) { return this.chatAlbums._takeHeldBatchIncoming(...args); }
  _releaseHeldBatchIncoming(...args) { return this.chatAlbums._releaseHeldBatchIncoming(...args); }
  _flushMessageBuffer(...args) { return this.chatHistory._flushMessageBuffer(...args); }
  _isNearBottom(...args) { return this.chatHistory._isNearBottom(...args); }
  _fallbackAvatarUrl(...args) { return this.messageRenderer._fallbackAvatarUrl(...args); }
  _historyMessageId(...args) { return this.chatHistory._historyMessageId(...args); }
  _describeIncomingAlbum(...args) { return this.chatAlbums._describeIncomingAlbum(...args); }
  _isTechnicalWhatsAppAlbumParent(...args) { return this.chatAlbums._isTechnicalWhatsAppAlbumParent(...args); }
  _sameAlbumAuthor(...args) { return this.chatAlbums._sameAlbumAuthor(...args); }
  _historyGroupKey(...args) { return this.chatHistory._historyGroupKey(...args); }
  _sortHistoryMessages(...args) { return this.chatHistory._sortHistoryMessages(...args); }
  _isWhatsAppPhotoAlbumMember(...args) { return this.chatAlbums._isWhatsAppPhotoAlbumMember(...args); }
  _collapseWhatsAppPhotoAlbums(...args) { return this.chatAlbums._collapseWhatsAppPhotoAlbums(...args); }
  _splitNewestHistoryPage(...args) { return this.chatHistory._splitNewestHistoryPage(...args); }
  _stashHistoryOverflow(...args) { return this.chatHistory._stashHistoryOverflow(...args); }
  _takeBufferedHistoryPage(...args) { return this.chatHistory._takeBufferedHistoryPage(...args); }
  scrollToBottom(...args) { return this.chatHistory.scrollToBottom(...args); }
  scrollToBottomAfterImagesLoad(...args) { return this.chatHistory.scrollToBottomAfterImagesLoad(...args); }
  _withNameParam(...args) { return this.mediaGallery._withNameParam(...args); }
  _toLightboxFriendlyUrl(...args) { return this.mediaGallery._toLightboxFriendlyUrl(...args); }
  _withDlParam(...args) { return this.mediaGallery._withDlParam(...args); }
  _fixMediaUrl(...args) { return this.mediaUrls._fixMediaUrl(...args); }
  _isDocumentAttachment(...args) { return this.mediaUrls._isDocumentAttachment(...args); }
  _morphOptimisticMessage(...args) { return this.chatOutbox._morphOptimisticMessage(...args); }
  _isReceiptRead(...args) { return this.messageReceipts._isReceiptRead(...args); }
  _looksLikeInlineMediaText(...args) { return this.messageRenderer._looksLikeInlineMediaText(...args); }
  _mergeMessageState(...args) { return this.messageReceipts._mergeMessageState(...args); }
  _paintSharedMessageStates(...args) { return this.messageReceipts._paintSharedMessageStates(...args); }
  _mergeWhatsAppReceipt(...args) { return this.messageReceipts._mergeWhatsAppReceipt(...args); }
  _paintSharedWhatsAppReceipts(...args) { return this.messageReceipts._paintSharedWhatsAppReceipts(...args); }
  _applyReceiptIcon(...args) { return this.messageReceipts._applyReceiptIcon(...args); }
  _consumeOptimisticMessage(...args) { return this.chatOutbox._consumeOptimisticMessage(...args); }
  _batchExpectedIds(...args) { return this.chatOutbox._batchExpectedIds(...args); }
  _markBatchReceipt(...args) { return this.chatOutbox._markBatchReceipt(...args); }
  _bindBatchOptimisticMessage(...args) { return this.chatOutbox._bindBatchOptimisticMessage(...args); }
  _completeBatchReconciliation(...args) { return this.chatOutbox._completeBatchReconciliation(...args); }
  resolveMediaSrc(...args) { return this.mediaUrls.resolveMediaSrc(...args); }
  _guessAltMediaUrls(...args) { return this.mediaUrls._guessAltMediaUrls(...args); }
  _pickDownloadName(...args) { return this.mediaGallery._pickDownloadName(...args); }
  _sanitizeAttachmentInputs(...args) { return this.chatComposer._sanitizeAttachmentInputs(...args); }
  linkify(...args) { return this.messageRenderer.linkify(...args); }
  _escapeHtml(...args) { return this.messageRenderer._escapeHtml(...args); }
  _safeRemoteUrl(...args) { return this.messageRenderer._safeRemoteUrl(...args); }
  _safeMime(...args) { return this.messageRenderer._safeMime(...args); }
  _safeRenderedHtml(...args) { return this.messageRenderer._safeRenderedHtml(...args); }
  renderReactionsHTML(...args) { return this.chatReactions.renderReactionsHTML(...args); }
  playSound(...args) { return this.chatHistory.playSound(...args); }
  markReadIfVisible(...args) { return this.chatHistory.markReadIfVisible(...args); }
  _scheduleReadReceiptAfterFirstPaint(...args) { return this.chatHistory._scheduleReadReceiptAfterFirstPaint(...args); }
  _applyPendingReactions(...args) { return this.chatReactions._applyPendingReactions(...args); }
  _applyCachedUrl(...args) { return this.mediaLoader._applyCachedUrl(...args); }
  _prefetchMediaByUrl(...args) { return this.mediaLoader._prefetchMediaByUrl(...args); }
  setupHistoryPagination(...args) { return this.chatHistory.setupHistoryPagination(...args); }
  _setHistoryLoaderLoading(...args) { return this.chatHistory._setHistoryLoaderLoading(...args); }
  _showHistoryRetryButton(...args) { return this.chatHistory._showHistoryRetryButton(...args); }
  _scheduleHistoryRetry(...args) { return this.chatHistory._scheduleHistoryRetry(...args); }
  rebuildDateSeparators(...args) { return this.chatHistory.rebuildDateSeparators(...args); }
  _setupStickyDateIndicator(...args) { return this.chatHistory._setupStickyDateIndicator(...args); }
  _updateStickyDateIndicator(...args) { return this.chatHistory._updateStickyDateIndicator(...args); }
  _setStickyDateText(...args) { return this.chatHistory._setStickyDateText(...args); }
  _hideStickyDateIndicator(...args) { return this.chatHistory._hideStickyDateIndicator(...args); }
  _renderGroupReactions(...args) { return this.chatReactions._renderGroupReactions(...args); }
  normalizeMediaGroups(...args) { return this.chatAlbums.normalizeMediaGroups(...args); }
  _getAlbumKey(...args) { return this.chatAlbums._getAlbumKey(...args); }
  normalizeFileGroups(...args) { return this.chatAlbums.normalizeFileGroups(...args); }
  _lazyMediaSource(...args) { return this.mediaLoader._lazyMediaSource(...args); }
  _activateLazyMedia(...args) { return this.mediaLoader._activateLazyMedia(...args); }
  _scheduleWhatsAppLazyMediaFlush(...args) { return this.mediaLoader._scheduleWhatsAppLazyMediaFlush(...args); }
  _queueWhatsAppLazyMedia(...args) { return this.mediaLoader._queueWhatsAppLazyMedia(...args); }
  _lazyMediaQueuePriority(...args) { return this.mediaLoader._lazyMediaQueuePriority(...args); }
  _flushWhatsAppLazyMedia(...args) { return this.mediaLoader._flushWhatsAppLazyMedia(...args); }
  _startWhatsAppLazyMedia(...args) { return this.mediaLoader._startWhatsAppLazyMedia(...args); }
  _scheduleTelegramLazyMediaFlush(...args) { return this.mediaLoader._scheduleTelegramLazyMediaFlush(...args); }
  _queueTelegramLazyMedia(...args) { return this.mediaLoader._queueTelegramLazyMedia(...args); }
  _activateVisibleLazyMedia(...args) { return this.mediaLoader._activateVisibleLazyMedia(...args); }
  _flushTelegramLazyMedia(...args) { return this.mediaLoader._flushTelegramLazyMedia(...args); }
  _startTelegramLazyMedia(...args) { return this.mediaLoader._startTelegramLazyMedia(...args); }
  _applyVideoDimensions(...args) { return this.mediaLoader._applyVideoDimensions(...args); }
  _prepareLazyImageLayout(...args) { return this.mediaLoader._prepareLazyImageLayout(...args); }
  setupLazyMediaObserver(...args) { return this.mediaLoader.setupLazyMediaObserver(...args); }
  _attachMediaSpinner(...args) { return this.mediaLoader._attachMediaSpinner(...args); }
  _addMediaRetryUI(...args) { return this.mediaLoader._addMediaRetryUI(...args); }
  _forceReloadMedia(...args) { return this.mediaLoader._forceReloadMedia(...args); }
  _scrollToBottomStrong(...args) { return this.chatHistory._scrollToBottomStrong(...args); }
  _prefetchTelegramBatch(...args) { return this.mediaLoader._prefetchTelegramBatch(...args); }
  observeNewMedia(...args) { return this.mediaLoader.observeNewMedia(...args); }
  _clearAttachmentPreview(...args) { return this.chatComposer._clearAttachmentPreview(...args); }
  _attachmentPreviewUrl(...args) { return this.chatComposer._attachmentPreviewUrl(...args); }
  _draftStorageKey(...args) { return this.chatComposer._draftStorageKey(...args); }
  _draftFileStore(...args) { return this.chatComposer._draftFileStore(...args); }
  canSendFromComposer(...args) { return this.chatComposer.canSendFromComposer(...args); }
  saveComposerDraft(...args) { return this.chatComposer.saveComposerDraft(...args); }
  restoreComposerDraft(...args) { return this.chatComposer.restoreComposerDraft(...args); }
  _stageFiles(...args) { return this.chatComposer._stageFiles(...args); }
  showAttachmentPreview(...args) { return this.chatComposer.showAttachmentPreview(...args); }
  handlePaste(...args) { return this.chatComposer.handlePaste(...args); }
  ensureEmojiUI(...args) { return this.chatComposer.ensureEmojiUI(...args); }
  _loadChatDetailsIntoHeader(...args) { return this.chatProfile._loadChatDetailsIntoHeader(...args); }
  _primeTelegramContactHeaderIdentity(...args) { return this.chatProfile._primeTelegramContactHeaderIdentity(...args); }
  _loadProviderCapabilities(...args) { return this.chatProfile._loadProviderCapabilities(...args); }
  _renderProviderBadge(...args) { return this.chatProfile._renderProviderBadge(...args); }
  _messageForCurrentChat(...args) { return this.messageRenderer._messageForCurrentChat(...args); }
  _refreshMessageActions(...args) { return this.messageRenderer._refreshMessageActions(...args); }
  _applyCapabilityVisibility(...args) { return this.chatProfile._applyCapabilityVisibility(...args); }
  _waitForSendJob(...args) { return this.chatOutbox._waitForSendJob(...args); }
  _updateSendQueueState(...args) { return this.chatOutbox._updateSendQueueState(...args); }
  _outgoingOperationStoreKey(...args) { return this.sendJournal._outgoingOperationStoreKey(...args); }
  _operationAccountKeyFromConfig(...args) { return this.sendJournal._operationAccountKeyFromConfig(...args); }
  _accountKeyFromProfile(...args) { return this.chatOutbox._accountKeyFromProfile(...args); }
  _primeOutgoingAccountKey(...args) { return this.chatOutbox._primeOutgoingAccountKey(...args); }
  _applyOwnReactionActorProfile(...args) { return this.reactionActors._applyOwnReactionActorProfile(...args); }
  _applyTelegramContactReactionIdentity(...args) { return this.reactionActors._applyTelegramContactReactionIdentity(...args); }
  _legacyOutgoingOperationStoreKey(...args) { return this.sendJournal._legacyOutgoingOperationStoreKey(...args); }
  _normalizeOperationComponents(...args) { return this.sendJournal._normalizeOperationComponents(...args); }
  _operationStatusFromComponents(...args) { return this.sendJournal._operationStatusFromComponents(...args); }
  _rejectedSendFileStore(...args) { return this.sendJournal._rejectedSendFileStore(...args); }
  _rememberRejectedSendFiles(...args) { return this.sendJournal._rememberRejectedSendFiles(...args); }
  _findOutgoingOperation(...args) { return this.sendJournal._findOutgoingOperation(...args); }
  _renderSendOperationOutcome(...args) { return this.sendJournal._renderSendOperationOutcome(...args); }
  _prepareRejectedRetry(...args) { return this.chatOutbox._prepareRejectedRetry(...args); }
  _readOutgoingOperations(...args) { return this.sendJournal._readOutgoingOperations(...args); }
  _writeOutgoingOperations(...args) { return this.sendJournal._writeOutgoingOperations(...args); }
  _migrateOutgoingOperationAccountKey(...args) { return this.sendJournal._migrateOutgoingOperationAccountKey(...args); }
  _rememberOutgoingOperation(...args) { return this.sendJournal._rememberOutgoingOperation(...args); }
  _rememberAcceptedSendEvidence(...args) { return this.sendJournal._rememberAcceptedSendEvidence(...args); }
  _operationMatchesCurrentChat(...args) { return this.sendJournal._operationMatchesCurrentChat(...args); }
  _nativeIdsFromMessages(...args) { return this.chatOutbox._nativeIdsFromMessages(...args); }
  _reconcileOutgoingOperations(...args) { return this.sendJournal._reconcileOutgoingOperations(...args); }
  _resumeUnknownOutgoingOperations(...args) { return this.sendJournal._resumeUnknownOutgoingOperations(...args); }
  _refreshOutgoingSendJob(...args) { return this.chatOutbox._refreshOutgoingSendJob(...args); }
  _markOptimisticStatus(...args) { return this.chatOutbox._markOptimisticStatus(...args); }
  _markOptimisticAwaitingConfirmation(...args) { return this.chatOutbox._markOptimisticAwaitingConfirmation(...args); }
  _whatsAppNativeMessageId(...args) { return this.chatOutbox._whatsAppNativeMessageId(...args); }
  _bindOutgoingWhatsAppMessageId(...args) { return this.chatOutbox._bindOutgoingWhatsAppMessageId(...args); }
  _bindOutgoingProviderMessageId(...args) { return this.chatOutbox._bindOutgoingProviderMessageId(...args); }
  _scheduleOutgoingReconciliation(...args) { return this.chatOutbox._scheduleOutgoingReconciliation(...args); }
  _markOptimisticFailed(...args) { return this.chatOutbox._markOptimisticFailed(...args); }
  _deliverOutgoingMessage(...args) { return this.chatOutbox._deliverOutgoingMessage(...args); }
  handleSendMessage(...args) { return this.chatOutbox.handleSendMessage(...args); }
  _applyPresenceHeader(...args) { return this.chatProfile._applyPresenceHeader(...args); }
  _realtimeEventMatchesActiveChat(...args) { return this.chatRealtime._realtimeEventMatchesActiveChat(...args); }
  _applyRealtimeReactionEvent(...args) { return this.chatReactions._applyRealtimeReactionEvent(...args); }
  _startBridgeMessagePoll(...args) { return this.chatRealtime._startBridgeMessagePoll(...args); }
  _stopBridgeMessagePoll(...args) { return this.chatRealtime._stopBridgeMessagePoll(...args); }
  _queueRealtimeMessageFetch(...args) { return this.chatRealtime._queueRealtimeMessageFetch(...args); }
  _bridgeLiveSocketUrl(...args) { return this.chatRealtime._bridgeLiveSocketUrl(...args); }
  _rememberBridgeRealtimeId(...args) { return this.chatRealtime._rememberBridgeRealtimeId(...args); }
  _connectBridgeWhatsAppLiveSocket(...args) { return this.chatRealtime._connectBridgeWhatsAppLiveSocket(...args); }
  _handleBridgeWhatsAppRealtimeEvent(...args) { return this.chatRealtime._handleBridgeWhatsAppRealtimeEvent(...args); }
  _subscribeToSharedRealtimeEvents(...args) { return this.chatRealtime._subscribeToSharedRealtimeEvents(...args); }
  _maxRealtimeCursorStorageKey(...args) { return this.chatRealtime._maxRealtimeCursorStorageKey(...args); }
  _applyMaxReadBoundary(...args) { return this.chatRealtime._applyMaxReadBoundary(...args); }
  _pollMaxRealtimeEvents(...args) { return this.chatRealtime._pollMaxRealtimeEvents(...args); }
  _startMaxRealtimePoll(...args) { return this.chatRealtime._startMaxRealtimePoll(...args); }
  connectWebSocket(...args) { return this.chatRealtime.connectWebSocket(...args); }
  setupEventListeners(...args) { return this.chatComposer.setupEventListeners(...args); }
  _showFeatureNotice(...args) { return this.chatComposer._showFeatureNotice(...args); }
  _setReplyContext(...args) { return this.chatComposer._setReplyContext(...args); }
  clearReplyContext(...args) { return this.chatComposer.clearReplyContext(...args); }
  _jumpToQuotedMessage(...args) { return this.chatComposer._jumpToQuotedMessage(...args); }
  _closeReactionPicker(...args) { return this.chatReactions._closeReactionPicker(...args); }
  _openReactionPicker(...args) { return this.chatReactions._openReactionPicker(...args); }
  _reactionStateForOptimisticSend(...args) { return this.chatReactions._reactionStateForOptimisticSend(...args); }
  _reactionSnapshotIsAuthoritative(...args) { return this.chatReactions._reactionSnapshotIsAuthoritative(...args); }
  _preserveReactionIntent(...args) { return this.chatReactions._preserveReactionIntent(...args); }
  _scheduleReactionReconciliation(...args) { return this.chatReactions._scheduleReactionReconciliation(...args); }
  _sendReaction(...args) { return this.chatReactions._sendReaction(...args); }
  renderMessage(...args) { return this.messageRenderer.renderMessage(...args); }
  renderMessagesBatch(...args) { return this.messageRenderer.renderMessagesBatch(...args); }
  updateReadReceipts(...args) { return this.messageReceipts.updateReadReceipts(...args); }
  fetchNewMessages(...args) { return this.chatHistory.fetchNewMessages(...args); }
  _getInitialMessages(...args) { return this.chatHistory._getInitialMessages(...args); }
  _getOlderMessages(...args) { return this.chatHistory._getOlderMessages(...args); }
  _notifyInitialHistoryRendered(...args) { return this.chatHistory._notifyInitialHistoryRendered(...args); }
  _paintPinnedMessage(...args) { return this.chatHistory._paintPinnedMessage(...args); }
  fetchAndRenderInitialMessages(...args) { return this.chatHistory.fetchAndRenderInitialMessages(...args); }
  fetchOlderMessages(...args) { return this.chatHistory.fetchOlderMessages(...args); }
  clearAttachment(...args) { return this.chatComposer.clearAttachment(...args); }
  _getSource(...args) { return this.chatProfile._getSource(...args); }
  _mediaUrls(...args) { return this.mediaUrls._mediaUrls(...args); }
  _toPrettyWaMedia(...args) { return this.mediaUrls._toPrettyWaMedia(...args); }
  _fixAlbumUrls(...args) { return this.chatAlbums._fixAlbumUrls(...args); }
  _waHead(...args) { return this.mediaUrls._waHead(...args); }
  _fetchMessageReactionSnapshot(...args) { return this.chatReactions._fetchMessageReactionSnapshot(...args); }
  _fetchMessageReactions(...args) { return this.chatReactions._fetchMessageReactions(...args); }
  _refreshMessageReactions(...args) { return this.chatReactions._refreshMessageReactions(...args); }
  _visibleWhatsappReactionMessageIds(...args) { return this.chatReactions._visibleWhatsappReactionMessageIds(...args); }
  _refreshVisibleWhatsappReactions(...args) { return this.chatReactions._refreshVisibleWhatsappReactions(...args); }
  _fetchMessageReactionsBulk(...args) { return this.chatReactions._fetchMessageReactionsBulk(...args); }
  _hydrateReactionsForViewportBatch(...args) { return this.chatReactions._hydrateReactionsForViewportBatch(...args); }
  _waDetectLb(...args) { return this.mediaGallery._waDetectLb(...args); }
  _waInstallOverlayMo(...args) { return this.mediaGallery._waInstallOverlayMo(...args); }
  _waInstallClickProbe(...args) { return this.mediaGallery._waInstallClickProbe(...args); }
  _installWaLightboxDebug(...args) { return this.mediaGallery._installWaLightboxDebug(...args); }
  _installMediaFailureFallbacks(...args) { return this.mediaLoader._installMediaFailureFallbacks(...args); }
}
