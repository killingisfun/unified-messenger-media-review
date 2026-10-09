import { getProvider } from '../../domain/providers.js';

/** Socket/poll lifecycle, event routing and read-boundary application. */
export class ChatRealtime {
  constructor(chat) { this.chat = chat; }

  _realtimeEventMatchesActiveChat(data) {
    const activeProvider = getProvider(this.chat.source || '').id;
    const eventProvider = getProvider(data?.source ?? data?.provider ?? data?.message?.source ?? '').id;
    // Desktop realtime is shared by every connected provider. A matching
    // numeric chat id alone is never enough: IDs overlap between providers.
    if (window.APP_CONFIG?.desktopMode === true) {
      if (!eventProvider || eventProvider !== activeProvider) return false;
      const expectedAccount = String(this.chat._outgoingAccountKey || '').toLowerCase();
      const eventAccount = String(data?.account_id ?? data?.provider_account_id
        ?? data?.message?.account_id ?? data?.message?.provider_account_id ?? '').trim().toLowerCase();
      if (expectedAccount && !expectedAccount.endsWith(':unbound')
          && (!eventAccount || `${eventProvider}:${eventAccount}` !== expectedAccount)) return false;
    }
    const sameDb = data?.chat_db_id != null && String(data.chat_db_id) === String(this.chat.chatDbId || '');
    const eventChatId = data?.chatId ?? data?.chat_id;
    const sameCid = eventChatId != null && String(eventChatId) === String(this.chat.chatId || '');
    const samePeer =
      (data?.peer_id != null && String(data.peer_id) === String(this.chat.chatId || '')) ||
      (data?.message && data.message.peer_id != null && String(data.message.peer_id) === String(this.chat.chatId || '')) ||
      (data?.message && data.message.chat_id != null && String(data.message.chat_id) === String(this.chat.chatId || ''));
    return sameDb || sameCid || samePeer;
  }

  _startBridgeMessagePoll() {
    if (this.chat._bridgeMessagePoll !== null && this.chat._bridgeMessagePoll !== undefined) return;
    // The broker is the immediate path, but an open chat also reconciles its
    // own lightweight local-cache cursor. A browser-level socket can miss a
    // frame while the left list still updates; this bounded read makes the
    // two views converge without running another provider synchronizer.
    this.chat._bridgeMessagePoll = this.chat.lifetime.interval(() => {
      if (!document.hidden && this.chat._isActiveInstance()) this.chat.fetchNewMessages().catch(() => {});
    // Realtime events are the immediate path. This is recovery polling only;
    // a 3-second cadence on the single-worker compatibility bridge can keep
    // its only PHP process continuously occupied when a provider read takes
    // around the same time. Poll less often and let matching socket events
    // trigger an immediate reconciliation.
    }, 10000);
  }

  _stopBridgeMessagePoll() {
    if (this.chat._bridgeMessagePoll === null || this.chat._bridgeMessagePoll === undefined) return;
    this.chat.lifetime.clearInterval(this.chat._bridgeMessagePoll);
    this.chat._bridgeMessagePoll = null;
  }

  _queueRealtimeMessageFetch(delay = 0) {
    if (!this.chat._isActiveInstance() || this.chat.lifetime.disposed) return;
    this.chat._pendingRealtimeMessageFetch = true;
    // Coalesce a short event burst; stable native album containers now accept
    // partial pages, so no guessed album-completion delay is needed.
    const isInitialWhatsAppRealtime = getProvider(this.chat.source || '').id === 'whatsapp'
      && Number(delay || 0) === 0;
    if (this.chat._pendingRealtimeMessageFetchTimer !== null) {
      return;
    }

    this.chat._pendingRealtimeMessageFetchTimer = this.chat.lifetime.timeout(() => {
      this.chat._pendingRealtimeMessageFetchTimer = null;
      if (!this.chat._pendingRealtimeMessageFetch || !this.chat._isActiveInstance()) return;
      const busy = this.chat._isLoadingInitial || this.chat._isLoadingNew
        || this.chat.isLoadingHistory || this.chat._historyRetryPending;
      const remainingThrottle = Math.max(0, 800 - (Date.now() - Number(this.chat._lastFetchNew || 0)));
      if (busy || remainingThrottle > 0) {
        // This is a request queue, not a visual delay: wait until the single
        // bridge reader is free, then fetch the state that the event announced.
        this.chat._queueRealtimeMessageFetch(Math.max(busy ? 150 : 0, remainingThrottle));
        return;
      }
      this.chat._pendingRealtimeMessageFetch = false;
      this.chat.fetchNewMessages().catch(() => {
        if (!this.chat._isActiveInstance()) return;
        this.chat._pendingRealtimeMessageFetch = true;
        this.chat._queueRealtimeMessageFetch(1000);
      });
    }, isInitialWhatsAppRealtime ? 120 : Math.max(0, Number(delay) || 0));
  }

  _bridgeLiveSocketUrl(socketUrl) {
    const lastId = Math.max(0, Number(this.chat._bridgeRealtimeId || 0));
    if (!lastId) return socketUrl;
    try {
      const url = new URL(socketUrl);
      url.searchParams.set('since', String(Math.floor(lastId)));
      return url.toString();
    } catch {
      return socketUrl;
    }
  }

  _rememberBridgeRealtimeId(raw) {
    const match = String(raw || '').match(/"realtime_id"\s*:\s*(\d+)/);
    const id = Number(match?.[1] || 0);
    if (Number.isSafeInteger(id) && id > this.chat._bridgeRealtimeId) this.chat._bridgeRealtimeId = id;
  }

  _connectBridgeWhatsAppLiveSocket() {
    if (!this.chat._isCompatibilityBridge() || getProvider(this.chat.source).id !== 'whatsapp' || this.chat.lifetime.disposed) return;
    const socketUrl = String(window.APP_CONFIG?.realtimeUrl || '').trim();
    if (!/^wss?:\/\//i.test(socketUrl) || typeof WebSocket === 'undefined') return;
    const current = this.chat._bridgeLiveSocket;
    if (current && (current.readyState === WebSocket.OPEN || current.readyState === WebSocket.CONNECTING)) return;

    let socket;
    try {
      socket = new WebSocket(this.chat._bridgeLiveSocketUrl(socketUrl));
    } catch (error) {
      this.chat._logRx('[bridge-rx] open failed', error);
      return;
    }
    this.chat._bridgeLiveSocket = socket;
    this.chat.lifetime.trackSocket(socket);
    socket.onopen = () => {
      // Keep the active-chat cache cursor alive even while the socket is open.
      // The broker can lose a browser frame independently of the chat list;
      // reconciliation is the delivery guarantee for the visible pane.
      this.chat._startBridgeMessagePoll();
      this.chat._logRx('[bridge-live] open');
    };
    socket.onerror = (error) => this.chat._logRx('[bridge-live] error', error);
    socket.onclose = () => {
      if (this.chat.lifetime.disposed || this.chat._bridgeLiveSocket !== socket) return;
      this.chat._bridgeLiveSocket = null;
      this.chat._startBridgeMessagePoll();
      this.chat._bridgeLiveReconnectTimer = this.chat.lifetime.timeout(() => {
        this.chat._bridgeLiveReconnectTimer = null;
        this.chat._connectBridgeWhatsAppLiveSocket();
      }, 5000);
    };
    socket.onmessage = (event) => {
      // The broker broadcasts all provider events. Reject the overwhelming
      // majority before parsing JSON so the active chat never competes with
      // gallery/media work merely because another chat received a message.
      const raw = typeof event?.data === 'string' ? event.data : '';
      this.chat._rememberBridgeRealtimeId(raw);
      if (!raw.includes('message_reactions_update')
        && !raw.includes('new_message')
        && !raw.includes('message_new')
        && !raw.includes('message_read')
        && !raw.includes('read_update')) return;
      let data;
      try {
        data = JSON.parse(raw);
      } catch {
        return;
      }
      this.chat._handleBridgeWhatsAppRealtimeEvent(data);
    };
  }

  _handleBridgeWhatsAppRealtimeEvent(data) {
    if (!data || typeof data !== 'object') return;
    if (data.source && getProvider(String(data.source)).id !== 'whatsapp') return;
    if (!this.chat._realtimeEventMatchesActiveChat(data)) return;
    if (this.chat._applyRealtimeReactionEvent(data, { acceptAdvisoryWhatsAppSnapshot: true })) return;
    const eventName = data.event || data.type || data._ || '';
    if ((eventName === 'read_update' || eventName === 'message_read') && Array.isArray(data.read_ids)) {
      this.chat.updateReadReceipts(data.read_ids);
    } else if (eventName === 'new_message' || eventName === 'message_new' || eventName === 'updateNewMessage') {
      this.chat._queueRealtimeMessageFetch();
    }
  }

  _refreshAfterDeletion() {
    if (!this.chat._isActiveInstance() || this.chat.lifetime.disposed) return;
    if (this.chat._isLoadingInitial || this.chat._isLoadingNew || this.chat.isLoadingHistory) {
      this.chat.lifetime.timeout(() => this._refreshAfterDeletion(), 150);
      return;
    }
    this.chat.lastTimestamp = 0;
    this.chat.fetchAndRenderInitialMessages();
  }

  _subscribeToSharedRealtimeEvents() {
    if (!this.chat._isCompatibilityBridge() && window.APP_CONFIG?.desktopMode !== true) return;
    this.chat.lifetime.listen(document, 'unified:realtime-event', (event) => {
      const data=event?.detail;
      if (getProvider(this.chat.source).id==='telegram' && data?.event==='messages_deleted'
          && data.source==='telegram' && this.chat._realtimeEventMatchesActiveChat(data)) {
        this._refreshAfterDeletion();
      } else if (getProvider(this.chat.source).id==='whatsapp') {
        this.chat._handleBridgeWhatsAppRealtimeEvent(data);
      } else if (window.APP_CONFIG?.desktopMode === true && this.chat._realtimeEventMatchesActiveChat(data)) {
        if (this.chat._applyRealtimeReactionEvent(data)) return;
        const eventName = data?.event || data?.type || data?._ || '';
        if ((eventName === 'read_update' || eventName === 'message_read') && Array.isArray(data?.read_ids)) {
          this.chat.updateReadReceipts(data.read_ids);
        } else if (eventName === 'new_message' || eventName === 'message_new' || /^update/i.test(eventName)) {
          this.chat._queueRealtimeMessageFetch();
        }
      }
    });
  }

  _maxRealtimeCursorStorageKey(accountKey = this.chat._outgoingAccountKey) {
    const account = String(accountKey || '').trim().toLowerCase();
    // The account id comes from the provider profile, never from chat data.
    // An unresolved profile deliberately has a separate transient key.
    return `unified:max-realtime-cursor:v2:${account.startsWith('max:') ? account : 'max:unbound'}`;
  }

  _applyMaxReadBoundary(event, accountId) {
    if (getProvider(this.chat.source).id !== 'max' || !accountId
        || this.chat._outgoingAccountKey !== `max:${accountId}`
        || String(event.chat_id) !== String(this.chat.chatId)) return;
    const boundary = Number(event.read_until_ms);
    if (!Number.isSafeInteger(boundary) || boundary <= 0) return;
    for (const node of this.chat.messagesContainer?.querySelectorAll('.message.out') || []) {
      for (const message of node._groupMessages || (node._originalData ? [node._originalData] : [])) {
        const stamp = Number(message.item_context?.max_timestamp_ms);
        if (message.direction === 'out' && stamp > 0 && stamp <= boundary
            && String(message.item_context?.max_account_id) === String(accountId)) {
          this.chat._messageStates?.merge(this.chat.source, this.chat.chatDbId, { ...message, ack: 3, is_read: true, send_state: 'read' });
        }
      }
    }
    this.chat._paintSharedMessageStates();
  }

  async _pollMaxRealtimeEvents() {
    if (document.hidden || !this.chat._isActiveInstance() || this.chat._maxRealtimePollInFlight || typeof this.chat.api.getMaxRealtimeEvents !== 'function') return;
    this.chat._maxRealtimePollInFlight = true;
    try {
      const storageKey = this.chat._maxRealtimeCursorStorageKey();
      const data = await this.chat.api.getMaxRealtimeEvents(this.chat._maxRealtimeCursor);
      if (!this.chat._isActiveInstance() || data?.success !== true) return;
      const cursor = Number(data.cursor || this.chat._maxRealtimeCursor);
      const events = Array.isArray(data.events) ? data.events : [];
      if (data.reset_required || events.some(event => event?.event === 'new_message' && String(event?.chat_id) === String(this.chat.chatId))) {
        await this.chat.fetchAndRenderInitialMessages();
      }
      for (const event of events) {
        if (event?.event === 'read_update' && data.account_id) {
          this.chat._applyMaxReadBoundary(event, String(data.account_id));
          document.dispatchEvent(new CustomEvent('max:read-boundary', { detail: { ...event, account_id: String(data.account_id) } }));
        }
        if (event?.event === 'reaction_update' && String(event?.chat_id) === String(this.chat.chatId) && event?.message_id) {
          this.chat._refreshMessageReactions(String(event.message_id));
        }
      }
      if (Number.isFinite(cursor) && cursor >= this.chat._maxRealtimeCursor) {
        this.chat._maxRealtimeCursor = cursor;
        sessionStorage.setItem(storageKey, String(cursor));
      }
    } catch (error) {
      // The next scheduled read retries the same cursor. Do not overlap
      // slow local bridge requests: concurrent PHP session reads can turn a
      // harmless delay into a noisy timeout and duplicate history reload.
      console.warn('[MAX realtime] cursor poll failed', error);
    } finally {
      this.chat._maxRealtimePollInFlight = false;
    }
  }

  _startMaxRealtimePoll() {
    if (this.chat._maxRealtimePoll !== null && this.chat._maxRealtimePoll !== undefined) return;
    try { this.chat._maxRealtimeCursor = Number(sessionStorage.getItem(this.chat._maxRealtimeCursorStorageKey()) || 0) || 0; } catch { this.chat._maxRealtimeCursor = 0; }
    void this.chat._pollMaxRealtimeEvents();
    // MAX events arrive through the socket; the cursor poll only recovers a
    // missed frame. Keep it below the bridge saturation point instead of
    // repeatedly occupying the shared local PHP listener.
    this.chat._maxRealtimePoll = this.chat.lifetime.interval(() => { void this.chat._pollMaxRealtimeEvents(); }, 10000);
  }

  connectWebSocket() {
    if (this.chat._isPreviewMode()) return;
    if (this.chat.lifetime.disposed) return;
    if (window.APP_CONFIG?.desktopMode === true) {
      this._subscribeToSharedRealtimeEvents();
      this._startBridgeMessagePoll();
      return;
    }
    if (this.chat._isCompatibilityBridge()) {
      // Telegram retains its conservative polling fallback. WhatsApp gets a
      // small event socket for the active chat and only falls back to one
      // cache-cursor reconciliation every 3 seconds as a read-only fallback.
      if (getProvider(this.chat.source).id === 'whatsapp') {
        this.chat._startBridgeMessagePoll();
        this.chat._connectBridgeWhatsAppLiveSocket();
      } else if (getProvider(this.chat.source).id === 'max') {
        this.chat._startMaxRealtimePoll();
      } else if (this.chat._bridgeMessagePoll === null || this.chat._bridgeMessagePoll === undefined) {
        this.chat._bridgeMessagePoll = this.chat.lifetime.interval(() => {
          if (!document.hidden && this.chat._isActiveInstance()) this.chat.fetchNewMessages().catch(() => {});
        }, 15000);
      }
      return;
    }
    const configured = String(window.APP_CONFIG?.realtimeUrl || '').trim();
    const wsProto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    // 8080 is Telegram's REST service.  Realtime events are broadcast on
    // 8081; the local PuTTY tunnel exposes that port as 18081.
    const isLocalTunnel = ['127.0.0.1', 'localhost', '::1'].includes(location.hostname) && location.port === '18080';
    const realtimePort = isLocalTunnel ? '18081' : '8081';
    const socketUrl = /^wss?:\/\//i.test(configured)
      ? configured
      : (wsProto + window.location.hostname + ':' + realtimePort);
    const socket = new WebSocket(socketUrl);
    this.chat.socket = socket;
    this.chat.lifetime.trackSocket(socket);

    socket.onopen = () => this.chat._logRx('[WS] open');
    socket.onerror = (e) => this.chat._logRx('[WS] error', e);
    socket.onclose = () => {
      if (this.chat.lifetime.disposed || this.chat.socket !== socket) return;
      this.chat._logRx('[WS] close -> reconnect in 5s');
      this.chat._socketReconnectTimer = this.chat.lifetime.timeout(() => this.chat.connectWebSocket(), 5000);
    };

    socket.onmessage = (event) => {
      let data;
      try {
        data = JSON.parse(event.data);
      } catch (e) {
        console.warn('[BaseChat] WS parse error', e, event.data);
        return;
      }

      console.log('[WS Received]', data);

      const evName = (data.event || data.type || data._ || '');
      const isTg = String(this.chat.source || '').toLowerCase().startsWith('tele');

      // --- [FIXED] Unified check for Presence and Typing events ---
      // First, determine the relevant chat/user ID from the event, regardless of its type.
      let eventSourceId = null;
      if (evName === 'updateUserTyping' || evName === 'updateUserStatus') {
        eventSourceId = String(data.user_id || '');
      } else if (evName === 'updateChatUserTyping') {
        // Group chats have a negative ID.
        eventSourceId = '-' + String(data.chat_id || '');
      } else if (evName === 'updateChannelUserTyping') {
        // Channels have a -100 prefix.
        eventSourceId = '-100' + String(data.channel_id || '');
      } else if (data.payload?.chatId || data.payload?.userId) {
          // Handle custom 'tg.typing' event from backend
          eventSourceId = String(data.payload.chatId || data.payload.userId || '');
      }


      // Now, check if the event's source ID matches the current chat ID.
      if (isTg && eventSourceId && eventSourceId === String(this.chat.chatId || '')) {

        // --- Handle Typing ---
        if (evName.includes('Typing')) {
          const until = (data.expires || data.payload?.until || 0) || (Math.floor(Date.now() / 1000) + 5);
          this.chat._applyPresenceHeader({
            state: 'typing',
            until
          });
          return; // Event handled, no need to proceed further.
        }

        // --- Handle Status Updates ---
        if (evName === 'updateUserStatus') {
          const st = data?.status?._ || '';
          if (st === 'userStatusOnline') {
            this.chat._applyPresenceHeader({
              state: 'online',
              until: data.status.expires | 0
            });
          } else if (st === 'userStatusOffline') {
            this.chat._applyPresenceHeader({
              state: 'offline',
              last: data.status.was_online | 0
            });
          } else if (st === 'userStatusRecently') {
            this.chat._applyPresenceHeader({
              state: 'recently'
            });
          } else if (st === 'userStatusLastWeek') {
            this.chat._applyPresenceHeader({
              state: 'last_week'
            });
          } else if (st === 'userStatusLastMonth') {
            this.chat._applyPresenceHeader({
              state: 'last_month'
            });
          }
          return; // Event handled.
        }
      }

      // Reaction handling also powers the bridge's filtered WhatsApp socket.
      if (this.chat._applyRealtimeReactionEvent(data)) return;

      // --- Original logic for events strictly bound to the current chat (messages) ---
      if (!this.chat._realtimeEventMatchesActiveChat(data)) return;

      if (evName === 'messages_deleted' && isTg && data.source==='telegram') {
        this._refreshAfterDeletion();
        return;
      }

      // --- 2) Read receipts
      if ((evName === 'read_update' || evName === 'message_read') && Array.isArray(data.read_ids)) {
        this.chat.updateReadReceipts(data.read_ids);
        return;
      }

      // --- 3) Новые/обновлённые сообщения
      if (
        evName === 'new_message' ||
        evName === 'message_new' ||
        evName === 'updateNewMessage' ||
        /^update/i.test(evName)
      ) {
        this.chat._queueRealtimeMessageFetch();
        return;
      }
    };
  }
}
