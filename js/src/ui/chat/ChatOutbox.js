import { originalAvatar } from '../avatar.js';
import { getProvider, normalizeMessage, validateAttachmentSelection } from '../../domain/providers.js';
import { renderMessageActions } from '../components/MessageActions.js';

/** Composer snapshots, serialized delivery and optimistic send reconciliation. */
export class ChatOutbox {
  constructor(chat) { this.chat = chat; }

  _isVisualOutgoingMessage(message) {
    if (String(message?.direction || '') !== 'out') return false;
    const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
    return attachments.some((attachment) => {
      const type = String(attachment?.type || '').toLowerCase();
      const sourceType = String(attachment?.source_type || '').toLowerCase();
      const mime = String(attachment?.mime || '').toLowerCase();
      return sourceType !== 'document' && !['file', 'document'].includes(type)
        && (type === 'photo' || mime.startsWith('image/'));
    });
  }

  _morphOptimisticMessage(element, realMessage) {
    if (!element || !realMessage) return;
    const syncedMessage = this.chat._mergeMessageState({
      ...this.chat._messageForCurrentChat(realMessage),
      // The DOM node began as a local provisional bubble. A provider record
      // with a native id is now authoritative, even if an older adapter
      // happened to retain its local optimistic flag.
      optimistic: false,
    });
    if (!syncedMessage.id || syncedMessage.id.startsWith('optimistic_')) return;
    // The local composer can only infer a selected file from MIME. WPP later
    // supplies the semantic type, and image/jpeg can still mean "document".
    // Rebuild that one bubble from the authoritative provider record so an
    // optimistic <img> cannot be absorbed into an album as a photo tile.
    const authoritativeDocument = Array.isArray(syncedMessage.attachments)
      && syncedMessage.attachments.some((attachment) => this.chat._isDocumentAttachment(attachment));
    const stalePhotoMarkup = element.querySelector?.('img.msg-photo') !== null;
    if (authoritativeDocument && (element.dataset.documentAttachment !== '1' || stalePhotoMarkup)) {
      const replacement = this.chat.renderMessage(syncedMessage);
      if (replacement && typeof element.replaceWith === 'function') {
        element.replaceWith(replacement);
        this.chat._pendingMediaRoots?.add?.(replacement);
        return replacement;
      }
    }
    element.id = `message-${syncedMessage.id}`;
    element.dataset.id = String(syncedMessage.id);
    element.dataset.timestamp = String(syncedMessage.timestamp || element.dataset.timestamp || '');
    element.dataset.hasText = (String(syncedMessage.text || '').trim().length || (Array.isArray(syncedMessage.attachments) && syncedMessage.attachments.length)) ? '1' : '0';
    element.classList.remove('optimistic');
    delete element.dataset.awaitingSync;
    delete element.dataset.sendRequestId;
    delete element.dataset.sendStatus;
    // The initial action buttons were rendered against `optimistic_*` and
    // intentionally disabled. Keeping that markup after the provider row
    // arrives left a synced outgoing WhatsApp message looking unavailable.
    // Refresh only this bubble and retain its real provider ID for reply and
    // reaction requests.
    element._originalData = syncedMessage;
    const currentActions = element.querySelector(':scope > .message-actions');
    const actionsMarkup = renderMessageActions(this.chat.source, syncedMessage, this.chat.providerCapabilities);
    if (currentActions) currentActions.outerHTML = actionsMarkup;
    else element.insertAdjacentHTML('beforeend', actionsMarkup);
    let meta = element.querySelector('.meta');
    if (!meta) {
      meta = document.createElement('div');
      meta.className = 'meta';
      element.querySelector('.bubble')?.appendChild(meta);
    }
    let rr = meta.querySelector('.read-receipt');
    if (!rr) {
      rr = document.createElement('span');
      rr.className = 'read-receipt';
      meta.appendChild(rr);
    }
    let icon = rr.querySelector('i');
    if (!icon) {
      icon = document.createElement('i');
      rr.appendChild(icon);
    }
    this.chat._applyReceiptIcon(icon, syncedMessage, false);
    return element;
  }

  _consumeOptimisticMessage(realMessage) {
    if (!realMessage || String(realMessage.id || '').startsWith('optimistic_')) return false;
    if (realMessage.direction !== 'out') return false;
    if (!this.chat.messagesContainer) return false;

    const batchEls = Array.from(this.chat.messagesContainer.querySelectorAll('.message.out[data-expected-message-ids]'));
    const realId = String(realMessage.id || '');
    const batchEl = batchEls.find((element) => this.chat._batchExpectedIds(element).includes(realId));
    if (batchEl) {
      this.chat._batchOptimisticByMessageId ??= new Map();
      this.chat._batchOptimisticByMessageId.set(realId, batchEl);
      this.chat.renderedMessageIds.add(realId);
      batchEl._batchMessages ??= new Map();
      batchEl._batchMessages.set(realId, realMessage);
      this.chat._markBatchReceipt(batchEl, realId, this.chat._isReceiptRead(realMessage), Number(realMessage.ack ?? 0));
      this.chat._completeBatchReconciliation(batchEl);
      return true;
    }

    // A temporary bubble becomes a real message only when the send response
    // already bound this exact native ID (or when a batch exposed exact IDs).
    // Text, timestamp and MIME are not identities: using them can replace an
    // unrelated local photo and make it appear to exist in WhatsApp.
    return false;
  }

  _batchExpectedIds(element) {
    return String(element?.dataset?.expectedMessageIds || '')
      .split(',').map(id => id.trim()).filter(Boolean);
  }

  _markBatchReceipt(element, messageId, isRead, ack = 0) {
    if (!element || !messageId) return;
    const expected = this.chat._batchExpectedIds(element);
    if (!expected.length) return;
    const received = new Set(String(element.dataset.receivedMessageIds || '').split(',').filter(Boolean));
    const failed = new Set(String(element.dataset.failedMessageIds || '').split(',').filter(Boolean));
    const id = String(messageId);
    const wasFailed = failed.has(id);
    if (ack < 0) {
      received.delete(id);
      failed.add(id);
    } else if (!wasFailed && (isRead || ack >= 1)) {
      received.add(id);
    }
    element.dataset.receivedMessageIds = Array.from(received).join(',');
    element.dataset.failedMessageIds = Array.from(failed).join(',');
    const read = new Set(String(element.dataset.readMessageIds || '').split(',').filter(Boolean));
    if (ack < 0) read.delete(id);
    else if (!wasFailed && isRead) read.add(id);
    element.dataset.readMessageIds = Array.from(read).join(',');
    element.querySelector('.send-progress')?.remove();
    const icon = element.querySelector('.read-receipt i');
    if (icon) {
      const allRead = read.size >= expected.length;
      icon.className = failed.size ? 'bi bi-exclamation-circle-fill'
        : (allRead ? 'bi bi-check2-all' : (received.size >= expected.length ? 'bi bi-check2' : 'bi bi-clock'));
      icon.style.color = allRead ? '#0d6efd' : '';
    }
  }

  _bindBatchOptimisticMessage(element, job) {
    if (!element?.isConnected || !job) return;
    const rawResults = Array.isArray(job.result) ? job.result : [];
    this.chat._rememberOutgoingOperation({
      requestId: element.dataset.sendRequestId,
      status: String(job.status || '') === 'completed' ? 'accepted' : (String(job.status || '') === 'unknown' ? 'unknown' : 'started'),
      element,
      result: { attachments: rawResults },
    });
    const results = rawResults
      .filter(item => item?.success !== false && item?.message_id)
      .sort((a, b) => Number(a.index || 0) - Number(b.index || 0));
    const ids = results.map(item => String(item.message_id));
    if (!ids.length) return;
    element.dataset.sendBatch = '1';
    element.dataset.batchTotal = String(job.total || element.dataset.batchTotal || ids.length);
    element.dataset.expectedMessageIds = [...new Set([...this.chat._batchExpectedIds(element), ...ids])].join(',');
    element._batchMessages ??= new Map();
    this.chat._batchOptimisticByMessageId ??= new Map();
    const expected = new Set(this.chat._batchExpectedIds(element));
    expected.forEach(id => this.chat._batchOptimisticByMessageId.set(id, element));
    // Webhooks that beat this status response are held only while their
    // native IDs are unknown. Consume matching records now without first
    // inserting and removing individual photo cards.
    for (const message of this.chat._takeHeldBatchIncoming(expected)) {
      const id = String(message.id || '');
      if (!id) continue;
      element._batchMessages.set(id, message);
      this.chat.renderedMessageIds.add(id);
      this.chat._markBatchReceipt(element, id, this.chat._isReceiptRead(message), Number(message.ack || 0));
    }
    // Webhooks may beat the job response. Absorb those exact native records,
    // including already grouped ones, while preserving unrelated neighbours.
    for (const node of [...this.chat.messagesContainer.querySelectorAll('.message')]) {
      if (node === element) continue;
      const records = node._groupMessages || (node._originalData ? [node._originalData] : []);
      const matched = records.filter(message => expected.has(String(message.id)));
      if (!matched.length) continue;
      matched.forEach(message => element._batchMessages.set(String(message.id), message));
      const remaining = records.filter(message => !expected.has(String(message.id)));
      records.forEach(message => {
        this.chat.renderedMessageIds.delete(String(message.id));
        this.chat._msgIdToGroupKey?.delete(String(message.id));
      });
      if (node.dataset.groupKey) this.chat._groupKeyToEl?.delete(node.dataset.groupKey);
      for (const message of remaining) {
        const replacement = this.chat.renderMessage(message);
        if (replacement) { node.before(replacement); this.chat.observeNewMedia(replacement); }
      }
      node.remove();
    }
    expected.forEach(id => this.chat.renderedMessageIds.add(id));
    for (const message of element._batchMessages.values()) {
      this.chat._markBatchReceipt(element, String(message.id), this.chat._isReceiptRead(message), Number(message.ack || 0));
    }
    this.chat._completeBatchReconciliation(element);
    if (['completed', 'partial_failed', 'failed', 'unknown'].includes(String(job.status || ''))) {
      // Any held record without one of this job's exact IDs belongs to a
      // different source and may now render normally.
      this.chat._releaseHeldBatchIncoming(element, expected);
    }
  }

  _completeBatchReconciliation(element) {
    if (!element?.isConnected) return;
    const ids = this.chat._batchExpectedIds(element);
    if (ids.length !== Number(element.dataset.batchTotal) || !ids.every(id => element._batchMessages?.has(id))) return;
    const provider = String(this.chat.source || '').toLowerCase();
    const groupPrefix = provider === 'telegram' ? 'tg-local-batch:' : 'wa-local-batch:';
    const groupId = `${groupPrefix}${element.dataset.sendRequestId || ids[0]}`;
    for (const id of ids) {
      const message = { ...element._batchMessages.get(id), media_group_id: groupId, group_id: groupId };
      this.chat.renderedMessageIds.delete(id);
      this.chat._batchOptimisticByMessageId?.delete(id);
      const node = this.chat.renderMessage(message);
      if (node) { element.before(node); this.chat.observeNewMedia(node); }
    }
    element.remove();
    this.chat.normalizeMediaGroups();
  }

  async _waitForSendJob(jobId, onProgress = null) {
    const started = Date.now();
    let delay = 150;
    while ((Date.now() - started) < 180000) {
      if (this.chat.lifetime.disposed) throw new Error('Чат закрыт до завершения отправки.');
      const response = await this.chat.api.getSendJob(jobId);
      if (this.chat.lifetime.disposed) throw new Error('Чат закрыт до завершения отправки.');
      const job = response?.job || null;
      if (job && typeof onProgress === 'function') {
        try { onProgress(job); } catch {}
      }
      const status = String(job?.status || '');
      if (['completed', 'partial_failed', 'failed', 'unknown'].includes(status)) {
        return job;
      }
      await new Promise(resolve => setTimeout(resolve, delay));
      delay = Math.min(2500, delay + 250);
    }
    throw new Error('Отправка пачки файлов не завершилась за 3 минуты');
  }

  _updateSendQueueState() {
    const pending = Math.max(0, Number(this.chat._pendingSendCount || 0));
    this.chat._sending = pending > 0;
    if (!this.chat.sendBtn) return;
    this.chat.sendBtn.dataset.pendingSends = String(pending);
    this.chat.sendBtn.setAttribute('aria-busy', pending ? 'true' : 'false');
    this.chat.sendBtn.title = pending ? `Отправка: ${pending}` : 'Отправить сообщение';
  }

  _accountKeyFromProfile(profile) {
    const source = String(this.chat.source || '').trim().toLowerCase();
    const direct = profile?.account_id ?? profile?.accountId ?? profile?.user_id ?? profile?.userId
      ?? profile?.id ?? profile?.phone ?? profile?.username ?? '';
    const field = Array.isArray(profile?.fields) ? profile.fields.find(item => /^(id|user id|phone|телефон|аккаунт)$/i.test(String(item?.label || '').trim())) : null;
    const value = String(direct || field?.value || '').trim();
    return value ? `${source}:${value}` : '';
  }

  async _primeOutgoingAccountKey() {
    const source = String(this.chat.source || '').trim();
    if (!source || typeof this.chat.api?.getProviderSelfProfile !== 'function') return;
    const cacheKey = `unified-provider-self-profile-v3:${source.toLowerCase()}`;
    try {
      let profile = null;
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
      if (cached?.profile && Number(cached.fetchedAt || 0) > Date.now() - 10 * 60 * 1000) profile = cached.profile;
      if (!profile) {
        const response = await this.chat.api.getProviderSelfProfile(source);
        profile = response?.profile || null;
      }
      const accountKey = this.chat._accountKeyFromProfile(profile);
      if (!accountKey || !this.chat._isActiveInstance()) return;
      // Telegram and MAX expose a stable own-account profile. Reuse it in
      // reactions so the optimistic MAX slot does not jump from initials to
      // the real account avatar when the profile response completes.
      if (['telegram', 'max'].includes(getProvider(source).id)) {
        const id = String(profile?.account_id ?? profile?.id ?? '').trim();
        if (id) {
          const avatar = this.chat._safeRemoteUrl(originalAvatar(profile?.avatar, profile?.avatar_url));
          this.chat._ownReactionActor = {
            id,
            username: String(profile?.username || '').trim(),
            name: String(profile?.name || profile?.username || '').trim(),
            initials: String(profile?.name || profile?.username || '').trim().replace(/^@/, '').slice(0, 2),
            avatar,
            avatarAvailable: Boolean(avatar),
          };
          this.chat._applyOwnReactionActorProfile();
        }
      }
      const previousAccountKey = this.chat._outgoingAccountKey;
      this.chat._outgoingAccountKey = accountKey;
      if (getProvider(source).id === 'max' && previousAccountKey !== accountKey && this.chat._maxRealtimePoll !== null && this.chat._maxRealtimePoll !== undefined) {
        // Never carry a MAX event cursor from an unbound/previous account
        // into the current authenticated account. The sidecar also resets its
        // account-scoped journal, so this causes a safe history re-read.
        this.chat._maxRealtimeCursor = 0;
        try { sessionStorage.removeItem(this.chat._maxRealtimeCursorStorageKey(previousAccountKey)); } catch {}
        void this.chat._pollMaxRealtimeEvents();
      }
      // A different stable id can mean a different person connected this
      // provider in the same browser. A UI transition is not proof of account
      // continuity, so saved operations keep their original account key.
    } catch {
      // A profile lookup is only a scope improvement. Unknown accounts stay
      // isolated by provider/chat and are never used to resend anything.
    }
  }

  _prepareRejectedRetry(requestId) {
    const operation = this.chat._findOutgoingOperation(requestId);
    if (!operation || !this.chat._operationMatchesCurrentChat(operation)) return;
    const rejected = (operation.components || []).filter(item => String(item?.status || '') === 'rejected');
    if (!rejected.length) return;
    const files = this.chat._rejectedSendFileStore().get(String(requestId || '')) || [];
    if (files.length) {
      this.chat._stageFiles(files);
      this.chat._showFeatureNotice('Отклонённые файлы подготовлены. Проверьте их и нажмите «Отправить» для новой отдельной попытки.');
      return;
    }
    if (rejected.some(item => item.kind === 'text') && operation.text && this.chat.messageInput && !this.chat.messageInput.value.trim()) {
      this.chat.messageInput.value = operation.text;
      this.chat.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
      this.chat._showFeatureNotice('Неотправленный текст подготовлен. Нажмите «Отправить» для новой отдельной попытки.');
      return;
    }
    this.chat._showFeatureNotice('Файлы этой старой попытки больше недоступны в браузере. Выберите только отклонённые файлы заново.');
  }

  _nativeIdsFromMessages(messages = []) {
    const ids = new Set();
    for (const raw of messages) {
      const message = normalizeMessage(this.chat.source, raw || {});
      [message.id, ...(Array.isArray(message._albumMessageIds) ? message._albumMessageIds : [])]
        .map(value => String(value || '').trim()).filter(Boolean).forEach(id => ids.add(id));
      for (const attachment of Array.isArray(message.attachments) ? message.attachments : []) {
        // An attachment's own id may be a media/file id, not a provider
        // message id. Only explicit message-id fields can settle an operation.
        const id = String(attachment?.message_id ?? attachment?.messageId ?? '').trim();
        if (id) ids.add(id);
      }
    }
    return ids;
  }

  async _refreshOutgoingSendJob(operation) {
    const requestId = String(operation?.requestId || '').trim();
    const jobId = String(operation?.jobId || '').trim();
    if (!requestId || !jobId || !this.chat._operationMatchesCurrentChat(operation) || typeof this.chat.api?.getSendJob !== 'function') return null;
    const response = await this.chat.api.getSendJob(jobId);
    const job = response?.job;
    if (!job || !this.chat._isActiveInstance()) return null;
    const status = String(job.status || '').toLowerCase();
    const attachments = Array.isArray(job.result) ? job.result : [];
    const messageIds = attachments.map(item => String(item?.message_id || '').trim()).filter(Boolean);
    const terminal = ['completed', 'partial_failed', 'failed', 'unknown'].includes(status);
    const outcome = String(job.outcome || (status === 'completed' ? 'accepted' : (status === 'unknown' ? 'unknown' : 'rejected')));
    this.chat._rememberOutgoingOperation({
      requestId,
      status: terminal && status === 'completed' ? 'accepted' : (terminal ? (outcome === 'unknown' ? 'unknown' : 'partial_failed') : 'started'),
      result: { success: status === 'completed', outcome, message_ids: messageIds, attachments, job_id: jobId },
      jobId,
    });
    return job;
  }

  _markOptimisticStatus(element, statusText = '') {
    if (!element || !element.isConnected) return;
    // Delivery is communicated only by the receipt icon; textual progress is redundant.
    delete element.dataset.sendStatus;
    element.title = '';
    element.querySelector('.send-progress')?.remove();
  }

  _markOptimisticAwaitingConfirmation(element) {
    if (!element || !element.isConnected) return;
    // The provider outcome is unknown. Keep a neutral clock and a marker for
    // passive polling, but never promote this local draft to sent.
    element.classList.remove('optimistic', 'error');
    element.dataset.awaitingSync = '1';
    delete element.dataset.sendStatus;
    element.title = '';
    this.chat._rememberOutgoingOperation({ requestId: element.dataset.sendRequestId, status: 'unknown', element, result: element._sendResult });
    const progress = element.querySelector('.send-progress');
    if (progress) progress.remove();
    let meta = element.querySelector('.meta') || element.querySelector('.timestamp');
    if (!meta) {
      meta = document.createElement('div');
      meta.className = 'meta';
      element.querySelector('.bubble')?.appendChild(meta);
    }
    let receipt = meta?.querySelector('.read-receipt');
    if (!receipt && meta) {
      receipt = document.createElement('span');
      receipt.className = 'read-receipt';
      meta.appendChild(receipt);
    }
    const icon = receipt?.querySelector('i') || receipt?.appendChild(document.createElement('i'));
    if (icon) {
      this.chat._applyReceiptIcon(icon, { ack: 0 }, true);
    }
    this.chat._scheduleOutgoingReconciliation(element, true);
  }

  _whatsAppNativeMessageId(value) {
    const id = String(value || '').trim();
    if (id.length === 0 || id.length > 512) return '';
    const match = id.match(/^(?:true|false)_([^_\s]+@(?:c\.us|g\.us|lid))_([^\s]+)$/i);
    if (!match) return '';
    const activeChat = String(this.chat.chatId || '').trim();
    return activeChat && match[1].toLowerCase() === activeChat.toLowerCase() ? id : '';
  }

  _bindOutgoingWhatsAppMessageId(element, response) {
    if (String(getProvider(this.chat.source || '').id || '').toLowerCase() !== 'whatsapp') return false;
    const nativeId = this.chat._whatsAppNativeMessageId(response?.message_id ?? response?.messageId);
    if (!nativeId || !element?.isConnected) return false;

    // WPPConnect has accepted this exact message and returned its provider id.
    // It is sufficient to make reply/reaction targets valid immediately;
    // background GET reconciliation still replaces the lightweight metadata
    // with the watcher/webhook record when it reaches SQLite.
    const original = element._originalData || {};
    const confirmed = {
      ...original,
      id: nativeId,
      message_id: nativeId,
      text: String(original.text || element.querySelector?.('.text')?.textContent || ''),
      timestamp: Number(original.timestamp || element.dataset.timestamp || Math.floor(Date.now() / 1000)),
      direction: 'out',
      optimistic: false,
      is_read: false,
      ack: Number(response?.ack ?? original.ack ?? 0),
    };
    const activeElement = this.chat._morphOptimisticMessage(element, confirmed) || element;
    this.chat.renderedMessageIds.add(nativeId);
    this.chat._scheduleOutgoingReconciliation(activeElement, false);
    return true;
  }

  _bindOutgoingProviderMessageId(element, response) {
    const providerId = String(getProvider(this.chat.source || '').id || '').toLowerCase();
    if (providerId === 'whatsapp') return this.chat._bindOutgoingWhatsAppMessageId(element, response);
    const nativeId = String(response?.message_id ?? response?.messageId ?? '').trim();
    if (!nativeId || nativeId.length > 512 || /[\x00-\x1f\x7f]/.test(nativeId) || !element?.isConnected) return false;

    // A native id proves that the provider accepted the operation, but it is
    // not a delivery/read receipt.  Keep a neutral clock for legacy responses
    // that only contain an id.  When the adapter explicitly returns the
    // accepted state, show the same single check as the history projection so
    // the newly created bubble does not contradict the server response.
    const rawState = String(response?.send_state || response?.outcome || '').trim().toLowerCase();
    const explicitAck = Number(response?.ack);
    const accepted = ['accepted', 'sent', 'delivered', 'read'].includes(rawState);
    const ack = Number.isFinite(explicitAck) && explicitAck > 0
      ? explicitAck
      : (accepted ? 1 : 0);
    const original = element._originalData || {};
    const confirmed = {
      ...original,
      id: nativeId,
      message_id: nativeId,
      text: String(original.text || element.querySelector?.('.text')?.textContent || ''),
      timestamp: Number(original.timestamp || element.dataset.timestamp || Math.floor(Date.now() / 1000)),
      direction: 'out',
      optimistic: false,
      is_read: false,
      ack,
      send_state: rawState,
    };
    const activeElement = this.chat._morphOptimisticMessage(element, confirmed) || element;
    this.chat.renderedMessageIds.add(nativeId);
    this.chat._scheduleOutgoingReconciliation(activeElement, false);
    return true;
  }

  _scheduleOutgoingReconciliation(element, requireAwaitingMarker = false) {
    const providerId = String(getProvider(this.chat.source || '').id || '').toLowerCase();
    // WhatsApp can accept the send before its webhook record is visible. A
    // bounded set of background polls replaces the local bubble without
    // holding the composer or sending anything again. In bridge mode an open
    // socket suppresses the generic 45-second fallback, but WPP does not
    // guarantee a `new_message` event for an outgoing send. Keep checking
    // through the watcher/queue window; each timer stops itself as soon as
    // the native record morphs this element and removes data-awaiting-sync.
    const delays = providerId === 'whatsapp'
      ? [650, 2000, 5000, 15000, 30000, 60000, 90000, 120000, 180000, 240000, 300000]
      : [650];
    delays.forEach((delay) => {
      this.chat.lifetime.timeout(() => {
        if (!this.chat._isActiveInstance() || !element?.isConnected) return;
        if (requireAwaitingMarker && element.dataset.awaitingSync !== '1') return;
        this.chat.fetchNewMessages().catch(() => {});
      }, delay);
    });
  }

  _markOptimisticFailed(element, error) {
    if (!element || !element.isConnected) return;
    this.chat._releaseHeldBatchIncoming(element);
    element._originalData = { ...element._originalData, ack: -1, is_read: false };
    const message = error?.message || 'неизвестная ошибка';
    element.classList.remove('optimistic');
    element.classList.add('error');
    delete element.dataset.awaitingSync;
    element.dataset.sendStatus = 'error';
    element.title = message;
    let progress = element.querySelector('.send-progress');
    if (!progress) {
      progress = document.createElement('div');
      progress.className = 'send-progress';
      const meta = element.querySelector('.meta');
      if (meta) meta.parentNode.insertBefore(progress, meta);
      else element.querySelector('.bubble')?.appendChild(progress);
    }
    progress.textContent = `Ошибка отправки: ${message}`;
    let meta = element.querySelector('.meta') || element.querySelector('.timestamp');
    if (!meta) {
      meta = document.createElement('div');
      meta.className = 'meta';
      element.querySelector('.bubble')?.appendChild(meta);
    }
    let receipt = meta?.querySelector('.read-receipt');
    if (!receipt && meta) {
      receipt = document.createElement('span');
      receipt.className = 'read-receipt';
      meta.appendChild(receipt);
    }
    const icon = receipt?.querySelector('i') || receipt?.appendChild(document.createElement('i'));
    if (icon) icon.className = 'bi bi-exclamation-circle-fill';
  }

  async _deliverOutgoingMessage(outbound, element) {
    const { text, files, replyTargetId, requestId } = outbound;
    if (!this.chat._isActiveInstance()) throw new Error('Чат закрыт до завершения отправки.');
    // This is the first point at which a provider request can start. It is
    // distinct from a local queued composer task and must be reconciled if
    // the tab closes before the promise settles.
    this.chat._rememberOutgoingOperation({ requestId, status: 'started', element, text, files });
    this.chat._markOptimisticStatus(element);
    const rejectSend = (result, fallback) => {
      const error = new Error(result?.message || fallback);
      error.code = String(result?.code || '');
      error.outcome = String(result?.outcome || '');
      error.send_state = String(result?.send_state || '');
      error.request_id = String(result?.request_id || requestId || '');
      error.message_id = String(result?.message_id || '');
      error.message_ids = Array.isArray(result?.message_ids) ? result.message_ids.map(String).filter(Boolean) : [];
      error.attachments = Array.isArray(result?.attachments) ? result.attachments : [];
      error.componentIndex = Number.isInteger(result?.component_index) ? result.component_index : null;
      error.result = result && typeof result === 'object' ? { ...result } : {};
      return error;
    };
    const sendOne = async (file = null, index = 0) => {
      const fd = new FormData();
      fd.append('action', 'send_message');
      fd.append('source', this.chat.source || '');
      fd.append('chat_id', this.chat.chatId || '');
      fd.append('chat_db_id', this.chat.chatDbId || '');
      fd.append('message', index === 0 ? (text || '') : '');
      if (index === 0 && replyTargetId) fd.append('reply_to_message_id', replyTargetId);
      fd.append('channel_guard', `${this.chat.source}:${this.chat.chatId}:${this.chat.chatDbId}`);
      fd.append('client_request_id', `${requestId}:${index}`);
      if (file) fd.append('attachment', file, file.name || 'attachment');
      return this.chat.api.sendMessage(fd);
    };

    let isNativeBatch = false;
    let lastSingleResult = null;
    if (files.length) {
      const providerId = String(this.chat.source || '').toLowerCase();
      const isMaxBundle = providerId === 'max' && files.length > 1;
      isNativeBatch = ['whatsapp', 'telegram'].includes(providerId)
        && files.length > 1
        && typeof this.chat.api.sendMessageBatch === 'function';
      if (isMaxBundle) {
        const fd = new FormData();
        fd.append('action', 'send_message');
        fd.append('source', this.chat.source || '');
        fd.append('chat_id', this.chat.chatId || '');
        fd.append('chat_db_id', this.chat.chatDbId || '');
        fd.append('message', text || '');
        if (replyTargetId) fd.append('reply_to_message_id', replyTargetId);
        fd.append('channel_guard', `${this.chat.source}:${this.chat.chatId}:${this.chat.chatDbId}`);
        fd.append('client_request_id', requestId);
        files.forEach(file => fd.append('attachments[]', file, file.name || 'attachment'));
        this.chat._markOptimisticStatus(element);
        const result = await this.chat.api.sendMessage(fd);
        if (!result?.success) throw rejectSend(result, 'Не удалось отправить пачку файлов MAX');
        lastSingleResult = result;
        this.chat._rememberAcceptedSendEvidence(element, result, requestId, 'accepted', 0);
      } else if (isNativeBatch) {
        const fd = new FormData();
        fd.append('action', 'send_message_batch');
        fd.append('source', this.chat.source || '');
        fd.append('chat_id', this.chat.chatId || '');
        fd.append('chat_db_id', this.chat.chatDbId || '');
        fd.append('message', text || '');
        if (replyTargetId) fd.append('reply_to_message_id', replyTargetId);
        fd.append('channel_guard', `${this.chat.source}:${this.chat.chatId}:${this.chat.chatDbId}`);
        fd.append('client_request_id', requestId);
        files.forEach(file => fd.append('attachments[]', file, file.name || 'attachment'));
        this.chat._markOptimisticStatus(element);
        const batch = await this.chat.api.sendMessageBatch(fd);
        if (element?.isConnected && batch?.job_id) {
          element.dataset.sendJobId = String(batch.job_id);
        }
        if (!batch?.success || !batch?.job_id) {
          throw rejectSend(batch, 'Не удалось поставить пачку файлов в очередь отправки');
        }
        // The DOM can disappear on reload or a chat switch. Persist the server
        // operation id before the first poll so recovery can query it without
        // resending anything.
        this.chat._rememberOutgoingOperation({ requestId, status: 'started', element, text, files, result: batch, jobId: batch.job_id });
        const job = await this.chat._waitForSendJob(batch.job_id, (progress) => {
          this.chat._rememberOutgoingOperation({ requestId, status: 'started', element, text, files, result: { job_id: batch.job_id, attachments: progress?.result }, jobId: batch.job_id });
          this.chat._bindBatchOptimisticMessage(element, progress);
          const sent = parseInt(progress?.sent || 0, 10);
          const failed = parseInt(progress?.failed || 0, 10);
          const total = parseInt(progress?.total || files.length, 10);
          // Individual files keep their provider receipts; do not add a
          // second textual delivery state to the bubble.
          this.chat._markOptimisticStatus(element);
        });
        if (!job || !['completed'].includes(String(job.status || ''))) {
          const sent = parseInt(job?.sent || 0, 10);
          const failed = parseInt(job?.failed || 0, 10);
          const total = parseInt(job?.total || files.length, 10);
          const knownIds = Array.isArray(job?.result) ? job.result.map(item => item?.message_id).filter(Boolean).map(String) : [];
          throw rejectSend({
            success: false,
            outcome: knownIds.length || sent > 0 || String(job?.status || '') === 'unknown' ? 'unknown' : String(job?.outcome || 'rejected'),
            code: String(job?.code || (knownIds.length || sent > 0 ? 'send_batch_partial' : 'send_batch_rejected')),
            message: `Пачка отправлена не полностью: ${sent}/${total}, ошибок: ${failed}`,
            request_id: requestId,
            message_ids: knownIds,
            attachments: Array.isArray(job?.result) ? job.result : [],
          }, `Пачка отправлена не полностью: ${sent}/${total}, ошибок: ${failed}`);
        }
        this.chat._bindBatchOptimisticMessage(element, job);
      } else {
        for (let index = 0; index < files.length; index++) {
          let result;
          try {
            result = await sendOne(files[index], index);
          } catch (error) {
            error.componentIndex = index;
            throw error;
          }
          if (!result?.success) {
            const knownIds = [
              ...(Array.isArray(lastSingleResult?.message_ids) ? lastSingleResult.message_ids : []),
              lastSingleResult?.message_id,
              ...(Array.isArray(result?.message_ids) ? result.message_ids : []),
              result?.message_id,
            ].map(value => String(value || '').trim()).filter(Boolean);
            throw rejectSend({
              ...result,
              component_outcome: result?.outcome,
              outcome: knownIds.length ? 'unknown' : result?.outcome,
              message_ids: [...new Set(knownIds)],
              request_id: result?.request_id || requestId,
              component_index: index,
            }, `Не удалось отправить файл ${index + 1}/${files.length}`);
          }
          lastSingleResult = result;
          this.chat._rememberAcceptedSendEvidence(element, result, requestId, 'accepted', index);
        }
      }
    } else {
      const result = await sendOne(null, 0);
      if (!result?.success) {
        throw rejectSend(result, 'Не удалось отправить сообщение');
      }
      lastSingleResult = result;
      this.chat._rememberAcceptedSendEvidence(element, result, requestId, 'accepted', 0);
    }

    if (!isNativeBatch) {
      this.chat._rememberAcceptedSendEvidence(element, lastSingleResult, requestId);
      if (!this.chat._bindOutgoingProviderMessageId(element, lastSingleResult)) {
        this.chat._markOptimisticAwaitingConfirmation(element);
      }
    } else {
      this.chat._scheduleOutgoingReconciliation(element);
    }
  }

  handleSendMessage(e) {
    if (e) e.preventDefault();
    if (this.chat._isPreviewMode()) {
      this.chat._showFeatureNotice('Предпросмотр не отправляет сообщения.');
      return Promise.resolve(false);
    }
    if (!String(this.chat.source || '').trim() || !String(this.chat.chatId || '').trim() || !/^\d+$/.test(String(this.chat.chatDbId || ''))) {
      this.chat._showFeatureNotice('Не удалось определить открытый чат. Перезайдите в диалог и повторите отправку.');
      return Promise.resolve(false);
    }
    const text = (this.chat.messageInput?.value || '').trim();
    const files = Array.from(this.chat._stagedFiles?.length ? this.chat._stagedFiles : (this.chat._clipboardFile ? [this.chat._clipboardFile] : this.chat.attachmentInput?.files || []));
    const replyTargetId = this.chat._replyContext?.id ? String(this.chat._replyContext.id) : '';
    if (!text && !files.length) return Promise.resolve(false);
    if (files.length) {
      const attachmentState = validateAttachmentSelection(this.chat.source, files, this.chat.providerCapabilities, { chat_id: this.chat.chatId });
      if (!attachmentState.enabled) {
        this.chat._showFeatureNotice(attachmentState.reason || 'Эти вложения недоступны в текущем чате.');
        return Promise.resolve(false);
      }
      if (replyTargetId && getProvider(this.chat.source).id === 'telegram' && files.length < 2) {
        this.chat._showFeatureNotice('Telegram пока поддерживает цитату только для нативного альбома из двух и более файлов.');
        return Promise.resolve(false);
      }
    }

    // Freeze the composer before any asynchronous work.  Later sends can now
    // use their own text, files and quote while this one waits in the queue.
    const replyContext = this.chat._replyContext?.id
      ? { ...this.chat._replyContext, id: String(this.chat._replyContext.id) }
      : null;
    const now = Date.now();
    // Deliberately accept identical consecutive drafts. The backend uses the
    // per-submit request id below for retry deduplication, so two intentional
    // "ok" messages are not silently collapsed into one.
    const sequence = ++this.chat._sendSequence;
    const requestId = `out_${now.toString(36)}_${sequence.toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
    const optimisticMessage = {
      id: `optimistic_${now}_${sequence}`,
      text,
      timestamp: Math.floor(now / 1000),
      direction: 'out',
      attachments: files.map(file => {
        const url = (typeof URL !== 'undefined' && URL.createObjectURL) ? URL.createObjectURL(file) : '';
        const mime = file.type || '';
        const type = mime.startsWith('image/') ? 'photo' : (mime.startsWith('video/') ? 'video' : (mime.startsWith('audio/') ? 'audio' : 'file'));
        return { type, url, public_url: url, title: file.name || 'attachment', filename: file.name || 'attachment', mime };
      }),
      is_read: false,
      replyTo: replyContext,
    };
    const element = this.chat.renderMessage(optimisticMessage);
    if (element) {
      this.chat.messagesContainer.appendChild(element);
      // Optimistic images are local blob URLs. They do not pass through a
      // history batch, so activate them instead of leaving alt text in a tile.
      this.chat.observeNewMedia(element);
      element.querySelectorAll?.('img[data-lazy-src]').forEach((image) => {
        if (String(image.dataset.lazySrc || '').startsWith('blob:')) this.chat._activateLazyMedia(image);
      });
      this.chat.scrollToBottom();
      element.dataset.sendRequestId = requestId;
      this.chat._rememberOutgoingOperation({ requestId, status: 'queued', element, text, files });
      if (getProvider(this.chat.source).id === 'whatsapp' && files.length > 1) {
        element.dataset.sendBatch = '1';
        element.dataset.batchTotal = String(files.length);
      }
    }

    // Free the exact snapshot synchronously.  `files` and `replyContext`
    // above remain valid for the queued network request.
    this.chat.clearAttachment();
    if (this.chat.messageInput) {
      this.chat.messageInput.value = '';
      this.chat.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (!replyContext || this.chat._replyContext?.id === replyContext.id) this.chat.clearReplyContext();

    const outbound = { text, files, replyTargetId, requestId };
    this.chat._pendingSendCount += 1;
    this.chat._updateSendQueueState();
    const task = this.chat._sendQueue.then(
      () => this.chat._deliverOutgoingMessage(outbound, element),
      () => this.chat._deliverOutgoingMessage(outbound, element)
    );
    // A failed task must not block subsequent user messages.
    this.chat._sendQueue = task.catch(() => {});
    task.then(
      () => {
        this.chat._pendingSendCount = Math.max(0, this.chat._pendingSendCount - 1);
        this.chat._updateSendQueueState();
      },
      (error) => {
        if (error?.outcome === 'unknown' || error?.code === 'send_outcome_unknown') {
          // The provider call already happened. A retry could duplicate the
          // message, so retain every native id and reconcile from history.
          console.warn('[BaseChat] send outcome needs reconciliation', error);
          this.chat._rememberAcceptedSendEvidence(element, error?.result || error, outbound.requestId, 'unknown', error?.componentIndex ?? error?.result?.component_index ?? null);
          this.chat._markOptimisticAwaitingConfirmation(element);
          const operation = this.chat._findOutgoingOperation(outbound.requestId);
          this.chat._rememberRejectedSendFiles(outbound.requestId, outbound.files, operation?.components);
          this.chat._renderSendOperationOutcome(element, outbound.requestId, error);
        } else {
          console.error('[BaseChat] send failed', error);
          this.chat._rememberOutgoingOperation({ requestId: outbound.requestId, status: 'rejected', element, result: error?.result || error });
          this.chat._markOptimisticFailed(element, error);
          const operation = this.chat._findOutgoingOperation(outbound.requestId);
          this.chat._rememberRejectedSendFiles(outbound.requestId, outbound.files, operation?.components);
          this.chat._renderSendOperationOutcome(element, outbound.requestId, error);
        }
        this.chat._pendingSendCount = Math.max(0, this.chat._pendingSendCount - 1);
        this.chat._updateSendQueueState();
      }
    );
    return task;
  }
}
