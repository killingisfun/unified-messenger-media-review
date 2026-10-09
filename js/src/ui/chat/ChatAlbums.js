import { getProvider } from '../../domain/providers.js';

/** Incoming album assembly, author boundaries and grouped media/file DOM. */
export class ChatAlbums {
  constructor(chat) {
    this.chat = chat;
    // A history page and realtime event frequently contain different children
    // of the same native Telegram document group. Keep only this open chat's
    // exact id snapshots, never a clock-window guess.
    this._documentGroupMembers = new Map();
  }

  _pendingWhatsAppBatchElement() {
    if (getProvider(this.chat.source || '').id !== 'whatsapp' || !this.chat.messagesContainer) return null;
    return Array.from(this.chat.messagesContainer.querySelectorAll('.message.out[data-send-batch="1"]'))
      .find((element) => element.isConnected
        && this.chat._batchExpectedIds(element).length < Number(element.dataset.batchTotal || 0)) || null;
  }

  _scheduleHeldBatchIncomingFlush() {
    if (this.chat._heldBatchIncomingTimer) this.chat.lifetime.clearTimeout(this.chat._heldBatchIncomingTimer);
    if (!this.chat._heldBatchIncoming.size) {
      this.chat._heldBatchIncomingTimer = null;
      return;
    }
    const expirations = Array.from(this.chat._heldBatchIncoming.values())
      .filter((entry) => entry.expiresAt != null && Number.isFinite(Number(entry.expiresAt)))
      .map((entry) => Number(entry.expiresAt));
    if (!expirations.length) {
      this.chat._heldBatchIncomingTimer = null;
      return;
    }
    const soonest = Math.min(...expirations);
    this.chat._heldBatchIncomingTimer = this.chat.lifetime.timeout(() => {
      this.chat._heldBatchIncomingTimer = null;
      const now = Date.now();
      const expired = [];
      for (const [id, entry] of this.chat._heldBatchIncoming) {
        if (entry.expiresAt == null || !Number.isFinite(Number(entry.expiresAt)) || Number(entry.expiresAt) > now) continue;
        this.chat._heldBatchIncoming.delete(id);
        expired.push(entry.message);
      }
      if (expired.length) {
        this.chat._messageBuffer.push(...expired);
        this.chat._flushMessageBuffer();
      }
      this.chat._scheduleHeldBatchIncomingFlush();
    }, Math.max(0, soonest - Date.now()));
  }

  _holdIncomingWhatsAppBatchMessages(messages) {
    const batch = this.chat._pendingWhatsAppBatchElement();
    if (!batch || !Array.isArray(messages) || !messages.length) return messages;
    // WPP publishes each photo before the batch status exposes its exact
    // native IDs. This is an identity barrier, not a display timeout: only a
    // terminal job result (or a failed local send) releases the candidate.
    // The send queue serializes local sends, so it cannot attach an unrelated
    // local photo to this batch while the provider sequence is active.
    const heldUntil = null;
    const visible = [];
    for (const message of messages) {
      const id = String(message?.id || '');
      if (!id || !this.chat._isVisualOutgoingMessage(message)) {
        visible.push(message);
        continue;
      }
      this.chat._heldBatchIncoming.set(id, { message, batch, expiresAt: heldUntil });
    }
    this.chat._scheduleHeldBatchIncomingFlush();
    return visible;
  }

  _stageIncomingWhatsAppPhotoAlbums(messages) {
    // Exact native groups are rendered directly into their persistent grid.
    // A quiet-period buffer cannot establish completeness: children may arrive
    // seconds later, long after an earlier portion has already been displayed.
    return messages;
  }

  _upsertIncomingNativeAlbum(message, fragment) {
    const album = this.chat._describeIncomingAlbum(message);
    const groupId = album?.groupId || '';
    const isParent = album?.technicalParent === true;
    if (message.direction !== 'in' || album?.native !== true
      || (!isParent && !this.chat._isWhatsAppPhotoAlbumMember(message))) return false;
    const existing = [...this.chat.messagesContainer.querySelectorAll('.message[data-native-album]')]
      .find(node => node.dataset.nativeAlbum === groupId)
      || [...fragment.querySelectorAll('.message[data-native-album]')].find(node => node.dataset.nativeAlbum === groupId);
    if (isParent) {
      if (existing) { this.chat.renderedMessageIds.add(String(message.id)); return true; }
      this.chat.renderedMessageIds.delete(String(message.id));
      const skeleton = this.chat.renderMessage({ ...message, groupId, media_group_id: groupId,
        attachments: [{type:'photo', url:''}], text:'' });
      if (!skeleton) return true;
      skeleton.dataset.nativeAlbum = groupId;
      skeleton._groupMessages = [];
      skeleton.querySelector('.album-grid').replaceChildren();
      skeleton.querySelector('.album-grid').setAttribute('aria-label', 'Загрузка фотоальбома');
      const download = skeleton.querySelector('.album-download-all');
      if (download) download.disabled = true;
      fragment.appendChild(skeleton);
      return true;
    }
    const records = new Map((existing?._groupMessages || []).map(item => [String(item.id), item]));
    for (const item of message._albumMessages || [message]) records.set(String(item.id), item);
    const members = this.chat._sortHistoryMessages([...records.values()]);
    const last = members[members.length - 1];
    const combined = { ...last, text: members.map(item => item.text || '').find(Boolean) || '',
      attachments: members.flatMap(item => item.attachments || []),
      _albumMessages: members, _albumMessageIds: members.map(item => String(item.id)) };
    // Build detached; no individual message or half-built grid reaches a frame.
    this.chat.renderedMessageIds.delete(String(combined.id));
    const built = this.chat.renderMessage(combined);
    if (!built) return false;
    built.dataset.nativeAlbum = groupId;
    built.dataset.messageIds = combined._albumMessageIds.join(',');
    built.dataset.groupKey = `gid:${groupId}`;
    built._groupMessages = members;
    if (existing) {
      // Retain decoded image nodes so late children don't reload earlier tiles.
      const oldImages = new Map([...existing.querySelectorAll('img[data-album-child]')]
        .map(image => [image.dataset.albumChild, image]));
      for (const image of built.querySelectorAll('img[data-album-child]')) {
        const old = oldImages.get(image.dataset.albumChild);
        if (old) image.replaceWith(old);
      }
      existing.replaceChildren(...built.childNodes);
      existing.id = built.id;
      Object.assign(existing.dataset, built.dataset);
      existing._originalData = built._originalData;
      existing._groupMessages = members;
    } else fragment.appendChild(built);
    const root = existing || built;
    for (const image of root.querySelectorAll('img.native-album-photo')) {
      if (image.dataset.fadeBound) continue;
      image.dataset.fadeBound = '1';
      const reveal = () => { if (image.naturalWidth) image.classList.add('is-decoded'); };
      image.addEventListener('load', () => { image.decode().then(reveal, reveal); }, { once: true });
      if (image.complete) reveal();
    }
    combined._albumMessageIds.forEach(id => this.chat.renderedMessageIds.add(id));
    this.chat._registerGroup(root);
    this.chat._renderGroupReactions(root, this.chat._computeAggregatedReactions(combined._albumMessageIds));
    this.chat._pendingMediaRoots.add(root);
    this.chat.observeNewMedia(root);
    return true;
  }

  _takeHeldBatchIncoming(messageIds = []) {
    const matched = [];
    for (const id of messageIds) {
      const entry = this.chat._heldBatchIncoming.get(String(id));
      if (!entry) continue;
      this.chat._heldBatchIncoming.delete(String(id));
      matched.push(entry.message);
    }
    this.chat._scheduleHeldBatchIncomingFlush();
    return matched;
  }

  _releaseHeldBatchIncoming(batch, messageIds = []) {
    if (!batch) return;
    const expected = new Set(Array.from(messageIds, id => String(id)));
    const visible = [];
    for (const [id, entry] of this.chat._heldBatchIncoming) {
      if (entry.batch !== batch || expected.has(id)) continue;
      this.chat._heldBatchIncoming.delete(id);
      visible.push(entry.message);
    }
    if (visible.length) {
      this.chat._messageBuffer.push(...visible);
      this.chat._flushMessageBuffer();
    }
    this.chat._scheduleHeldBatchIncomingFlush();
  }

  _describeIncomingAlbum(message) {
    const description = this.chat.albumTransport?.describeIncomingAlbum?.(message);
    if (!description?.groupId) return null;
    return {
      groupId: String(description.groupId),
      technicalParent: description.technicalParent === true,
      native: description.native === true,
    };
  }

  _isTechnicalWhatsAppAlbumParent(message) {
    // Compatibility method name retained for integrations and focused tests.
    return getProvider(this.chat.source).id === 'whatsapp'
      && this.chat._describeIncomingAlbum(message)?.technicalParent === true;
  }

  _sameAlbumAuthor(left, right) {
    const author = value => String(value?.sender_id || value?.sender_profile_id || value?.sender_name || '');
    return author(left) === author(right);
  }

  _isWhatsAppPhotoAlbumMember(message) {
    return this.chat.albumTransport?.isPhotoAlbumMember?.(message) === true;
  }

  _collapseWhatsAppPhotoAlbums(messages) {
    if (!this.chat.albumTransport || !Array.isArray(messages)) return messages || [];
    const sorted = this.chat._sortHistoryMessages(messages);
    const result = [];
    for (let index = 0; index < sorted.length;) {
      const first = sorted[index];
      const album = this.chat._describeIncomingAlbum(first);
      const groupId = album?.groupId || '';
      if (!groupId || album?.technicalParent || !this.chat._isWhatsAppPhotoAlbumMember(first)) {
        result.push(first);
        index++;
        continue;
      }
      const group = [first];
      let next = index + 1;
      while (next < sorted.length) {
        const candidate = sorted[next];
        const candidateGroup = this.chat._describeIncomingAlbum(candidate)?.groupId || '';
        if (candidateGroup !== groupId
          || !this.chat._sameAlbumAuthor(first, candidate)
          || String(candidate?.direction || '') !== String(first?.direction || '')
          || !this.chat._isWhatsAppPhotoAlbumMember(candidate)) break;
        group.push(candidate);
        next++;
      }
      if (group.length === 1) {
        result.push(first);
        index = next;
        continue;
      }
      const last = group[group.length - 1];
      const caption = group.map((message) => String(message?.text || '').trim()).find(Boolean) || '';
      result.push({
        ...last,
        text: caption,
        attachments: group.flatMap((message) => Array.isArray(message.attachments) ? message.attachments : []),
        media_group_id: groupId,
        group_id: groupId,
        _albumMessageIds: group.map((message) => this.chat._historyMessageId(message)).filter(Boolean),
        _albumMessages: group,
      });
      index = next;
    }
    return result;
  }

  _localOutgoingDocumentBatches() {
    const membership = new Map();
    let operations = [];
    try { operations = this.chat._readOutgoingOperations?.() || []; } catch { return membership; }
    for (const operation of operations) {
      // The journal is account-scoped.  Never let a previous Telegram/MAX
      // account teach this chat how to combine its history.
      if (!this.chat._operationMatchesCurrentChat(operation)) continue;
      const files = (Array.isArray(operation.components) ? operation.components : [])
        .filter(component => String(component?.kind || '') === 'file');
      if (files.length < 2 || files.some(component => String(component?.status || '') !== 'accepted')) continue;
      const ids = files.map(component => String(component?.messageId || '').trim());
      if (ids.some(id => !id) || new Set(ids).size !== ids.length || ids.some(id => membership.has(id))) continue;
      const requestId = String(operation.requestId || '').trim();
      if (!requestId) continue;
      const groupId = `local-document-batch:${requestId}`;
      const record = { groupId, ids };
      ids.forEach(id => membership.set(id, record));
    }
    return membership;
  }

  _collapseLocalOutgoingDocumentBatches(messages) {
    if (!Array.isArray(messages) || messages.length === 0) return messages || [];
    const membership = this._localOutgoingDocumentBatches();

    // Add a synthetic group only to rows whose exact native ID belongs to a
    // fully confirmed local file operation. A provider supplied grouped_id is
    // already authoritative and is preserved below. Neither path uses a
    // time window: two independent uploads near one another stay separate.
    const annotated = messages.map((message) => {
      const id = this.chat._historyMessageId(message);
      const local = membership.get(id);
      if (!local || String(message?.direction) !== 'out') return message;
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      if (!attachments.some(attachment => this.chat._isDocumentAttachment(attachment))) return message;
      const nativeGroup = String(message?.groupId ?? message?.media_group_id ?? message?.group_id ?? '').trim();
      if (nativeGroup) return message;
      return {
        ...message,
        groupId: local.groupId,
        group_id: local.groupId,
        media_group_id: local.groupId,
        _localDocumentBatch: true,
      };
    });

    const sorted = this.chat._sortHistoryMessages(annotated);
    const currentGroupKeys = new Set();
    const groups = new Map();
    for (const [index, message] of sorted.entries()) {
      const attachments = Array.isArray(message?.attachments) ? message.attachments : [];
      if (!attachments.some(attachment => this.chat._isDocumentAttachment(attachment))) continue;
      const groupId = String(message?.media_group_id || message?.group_id || message?.groupId || '').trim();
      if (!groupId) continue;
      // Direction is part of the identity: a malformed provider row may not
      // turn an incoming document into a local outgoing operation.
      const key = `${String(message?.direction || '')}:${groupId}`;
      currentGroupKeys.add(key);
      const known = this._documentGroupMembers.get(key) || new Map();
      const id = this.chat._historyMessageId(message);
      if (!id) continue;
      const previous = known.get(id);
      // A receipt-only partial update must not clear an already-known file.
      known.set(id, {
        ...(previous || {}),
        ...message,
        attachments: Array.isArray(message?.attachments) && message.attachments.length
          ? message.attachments
          : (previous?.attachments || []),
      });
      this._documentGroupMembers.set(key, known);
      const record = groups.get(key) || { key, groupId, members: [] };
      record.members.push({ index, message });
      groups.set(key, record);
    }

    const aggregateAt = new Map();
    const hiddenIndexes = new Set();
    for (const record of groups.values()) {
      const members = record.members;
      if (!currentGroupKeys.has(record.key)) continue;
      const known = this._documentGroupMembers.get(record.key);
      const childMessages = this.chat._sortHistoryMessages([...(known?.values() || [])]);
      if (childMessages.length < 2) continue;
      const ids = childMessages.map(message => this.chat._historyMessageId(message)).filter(Boolean);
      if (ids.length !== childMessages.length || new Set(ids).size !== ids.length) continue;
      const local = membership.get(ids[0]);
      // A synthetic local group has an expected exact membership. Do not show
      // a partial history page as a complete operation; provider-native
      // grouped_id has no guessed expected size, so its observed children are
      // a genuine partial/native presentation rather than invented success.
      if (record.groupId.startsWith('local-document-batch:')
        && (!local || local.ids.length !== ids.length || !local.ids.every(id => ids.includes(id)))) continue;
      // Anchor the updated card at the newest member in the currently
      // rendered slice.  It may include siblings learned on an older page.
      const lastEntry = members[members.length - 1];
      const last = childMessages[childMessages.length - 1];
      aggregateAt.set(lastEntry.index, {
        ...last,
        text: childMessages.map(message => String(message?.text || '').trim()).find(Boolean) || '',
        attachments: childMessages.flatMap(message => Array.isArray(message?.attachments) ? message.attachments : []),
        groupId: record.groupId,
        group_id: record.groupId,
        media_group_id: record.groupId,
        _albumMessageIds: ids,
        _albumMessages: childMessages,
        _localDocumentBatch: record.groupId.startsWith('local-document-batch:'),
        _nativeDocumentBatch: !record.groupId.startsWith('local-document-batch:'),
      });
      members.filter(entry => entry.index !== lastEntry.index).forEach(entry => hiddenIndexes.add(entry.index));
    }

    return sorted.flatMap((message, index) => {
      if (hiddenIndexes.has(index)) return [];
      return [aggregateAt.get(index) || message];
    });
  }

  normalizeMediaGroups() {
    const container = this.chat.messagesContainer;
    if (!container) return;
    const GROUP_WINDOW_SEC = 10;
    const MAX_GROUP_SPAN_SEC = 30;
    const isAlbumCandidate = (el) => {
      if (!el) return false;
      // A local selected image has no authoritative WPP type yet. Do not
      // group it before reconciliation: image-MIME documents must remain
      // eligible to become a standalone file card.
      if (el.dataset.nativeAlbum || el.classList.contains('optimistic') || el.dataset.awaitingSync === '1' || el.dataset.sendBatch === '1') return false;
      const hasOtherMedia = !!el.querySelector('audio.msg-audio, .msg-file');
      if (hasOtherMedia) return false;
      if (el.classList.contains('album')) {
        return !!el.querySelector('.album-grid a[data-lightbox], .album-grid img.msg-photo');
      }
      const hasVisuals = !!el.querySelector('img.msg-photo');
      // Telegram often omits grouped_id in the REST response. Adjacent photo
      // messages with the same timestamp are still one native album.
      return hasVisuals;
    };
    const hashString = (value) => {
      let hash = 0;
      const text = String(value || '');
      for (let n = 0; n < text.length; n++) hash = ((hash << 5) - hash + text.charCodeAt(n)) | 0;
      return Math.abs(hash).toString(36);
    };
    const ownMessageId = (el) => {
      if (el?.dataset?.id) return String(el.dataset.id);
      const ids = String(el?.dataset?.messageIds || '').split(',').map(s => s.trim()).filter(Boolean);
      if (ids.length === 1) return ids[0];
      return String(el?.id || '').replace(/^message-/, '');
    };
    const titleToFilename = (title) => {
      const raw = String(title || '').split('·')[0].trim();
      if (!raw) return '';
      const tmp = document.createElement('textarea');
      tmp.innerHTML = raw;
      return tmp.value.trim();
    };
    const filenameFromUrl = (url) => {
      try {
        const parsed = new URL(url, window.location.href);
        const explicitName = parsed.searchParams.get('name');
        if (explicitName) return explicitName;
        const last = parsed.pathname.split('/').filter(Boolean).pop();
        return last ? decodeURIComponent(last) : '';
      } catch (_) {
        return '';
      }
    };
    const pickFromMsg = (el) => {
      const items = [];
      const seen = new Set();
      const pushItem = (a, img = null) => {
        if (!a) return;
        const url = a.getAttribute('href') || img?.getAttribute('data-lazy-src') || img?.getAttribute('src') || '';
        if (!url) return;
        const tile = a.closest('.album-tile');
        const rawId = tile?.dataset?.id || ownMessageId(el);
        const mid = rawId || `media_${hashString(url)}`;
        const key = `${mid}|${url}`;
        if (seen.has(key)) return;
        seen.add(key);
        const filename = img?.getAttribute('alt') || titleToFilename(a.getAttribute('data-title')) || filenameFromUrl(url) || 'image.jpg';
        // Individual lazy tiles start with a transparent placeholder in src.
        // Preserve the deferred preview instead of treating that placeholder
        // as the album thumbnail during a later group rebuild.
        const thumb = img?.getAttribute('data-lazy-src') || img?.getAttribute('src') || '';
        items.push({
          id: mid,
          url,
          thumb,
          ts: parseInt(el.dataset.timestamp, 10) || 0,
          filename,
          reactions: this.chat._rxByMessageId.get(mid) || []
        });
      };
      const anchors = Array.from(el.querySelectorAll('a[data-lightbox]'));
      if (anchors.length) {
        anchors.forEach(a => pushItem(a, a.querySelector('img.msg-photo')));
      } else {
        el.querySelectorAll('img.msg-photo').forEach(img => pushItem(img.closest('a'), img));
      }
      return items;
    };
    const buildAlbumHTML = (items, groupKey) => {
      const lbKey = `alb-${groupKey}`;
      const tsAlbum = items.length ? items[items.length - 1].ts : 0;
      const gridClass = items.length === 2 ? 'two' : items.length === 3 ? 'three' : 'four';
      let tiles = '',
        hidden = '';
      items.forEach((it, k) => {
        const timeBadge = new Date((it.ts || tsAlbum) * 1000).toLocaleTimeString('ru-RU', {
          hour: '2-digit',
          minute: '2-digit'
        });
        const dlName = this.chat._pickDownloadName(it.filename || 'image.jpg', '', it.url);
        const openUrl = this.chat._toLightboxOpenUrl(it.url, dlName);
        const dlUrl = this.chat._withDlParam(this.chat._withNameParam(openUrl, dlName));
        // The grouped album is rebuilt after its individual bubbles were
        // rendered. Do not copy their bridge thumbnail into `src`: doing so
        // would start every relay request before the lazy observer sees the
        // new album. A tiny local placeholder keeps the tile stable.
        const thumb = this.chat._tinyTransparent;
        // The reconstructed grid must keep the lightbox URL separate from
        // the viewport image. `thumb` is the provider preview; `url` remains
        // the original for opening and downloading the tile.
        const lazySrc = this.chat._fixMediaUrl(it.thumb || it.url);
        const safeName = this.chat._escapeHtml(dlName);
        const safeOpenUrl = this.chat._escapeHtml(openUrl);
        const safeDlUrl = this.chat._escapeHtml(dlUrl);
        const safeId = this.chat._escapeHtml(it.id);
        const safeKey = this.chat._escapeHtml(lbKey);
        const fallback = it.url && it.url !== lazySrc ? ` data-fallback-src="${this.chat._escapeHtml(it.url)}"` : '';
        const imgTag = `<img src="${this.chat._escapeHtml(thumb)}" data-lazy-src="${this.chat._escapeHtml(lazySrc)}"${fallback} class="msg-photo rounded" alt="${safeName}">`;
        const caption = `${timeBadge} · <a href="${safeDlUrl}" download="${safeName}">Скачать</a>`;
        const safeCaption = this.chat._escapeHtml(caption);
        if (k < 3) {
          tiles += `<div class="album-tile t${k + 1}" id="message-${safeId}" data-id="${safeId}"><div class="bubble"><a class="tile-open" href="${safeOpenUrl}" data-lightbox="${safeKey}" data-title="${safeCaption}">${imgTag}</a><a class="tile-dl" href="${safeDlUrl}" download="${safeName}" title="Скачать"><i class="bi bi-download"></i></a></div></div>`;
        } else if (k === 3) {
          tiles += (items.length > 4) ? `<div class="album-tile t4 more" data-more="+${items.length - 3}" id="message-${safeId}" data-id="${safeId}"><div class="bubble"><a class="tile-open" href="${safeOpenUrl}" data-lightbox="${safeKey}" data-title="${safeCaption}">${imgTag}</a></div></div>` : `<div class="album-tile t4" id="message-${safeId}" data-id="${safeId}"><div class="bubble"><a class="tile-open" href="${safeOpenUrl}" data-lightbox="${safeKey}" data-title="${safeCaption}">${imgTag}</a><a class="tile-dl" href="${safeDlUrl}" download="${safeName}" title="Скачать"><i class="bi bi-download"></i></a></div></div>`;
        } else {
          hidden += `<a href="${safeOpenUrl}" data-lightbox="${safeKey}" data-title="${safeCaption}" class="d-none"></a>`;
        }
      });
      return {
        gridHtml: `<div class="album-grid ${gridClass}">${tiles}</div>${hidden}`
      };
    };
    const messages = Array.from(container.querySelectorAll('.message:not(.grouped-files)'));
    let i = 0;
    while (i < messages.length) {
      const currentMsg = messages[i];
      if (!isAlbumCandidate(currentMsg)) {
        i++;
        continue;
      }
      const group = [currentMsg];
      const groupKey = this.chat._getAlbumKey(currentMsg);
      const explicitGroupId = currentMsg.dataset.groupId || '';
      const startTs = parseInt(currentMsg.dataset.timestamp, 10) || 0;
      let lastTs = startTs;
      const dirIn = currentMsg.classList.contains('in');
      let j = i + 1;
      while (j < messages.length) {
        const nextMsg = messages[j];
        const nextTs = parseInt(nextMsg.dataset.timestamp, 10) || 0;
        const nextGroupId = nextMsg.dataset.groupId || '';
        // Explicit provider album ids must match when both sides have them.
        // WhatsApp often streams a batch one item at a time, so an already
        // rendered time-window album must still be allowed to absorb a later
        // item that arrived with no usable group id.
        const isLocalBatch = String(explicitGroupId).startsWith('wa-local-batch:')
          || String(nextGroupId).startsWith('wa-local-batch:');
        const compatibleExplicitGroup = isLocalBatch || (explicitGroupId && nextGroupId)
          ? nextGroupId === explicitGroupId
          : true;
        const sameDurableGroup = explicitGroupId !== '' && nextGroupId === explicitGroupId;
        const withinSlidingWindow = sameDurableGroup || (
          (nextTs - lastTs) <= GROUP_WINDOW_SEC && (nextTs - startTs) <= MAX_GROUP_SPAN_SEC
        );
        if (isAlbumCandidate(nextMsg) && this.chat._sameAlbumAuthor(currentMsg._originalData, nextMsg._originalData) && compatibleExplicitGroup && nextMsg.classList.contains('in') === dirIn && withinSlidingWindow) {
          group.push(nextMsg);
          lastTs = nextTs;
          j++;
        } else {
          break;
        }
      }

      if (group.length > 1) {
        const albumItems = [];
        group.forEach(msgNode => albumItems.push(...pickFromMsg(msgNode)));
        if (albumItems.length < 2) {
          i++;
          continue;
        }
        const albumIds = Array.from(new Set(group.flatMap(n => {
          const explicitIds = String(n.dataset.messageIds || '').split(',').map(s => s.trim()).filter(Boolean);
          const ownId = ownMessageId(n);
          return explicitIds.length ? explicitIds : (ownId ? [ownId] : []);
        })));
        const album = document.createElement('div');
        album.className = `message ${dirIn ? 'in' : 'out'} album`;
        album.dataset.timestamp = String(parseInt(group[group.length - 1].dataset.timestamp, 10) || 0);
        album.dataset.messageIds = albumIds.join(',');
        album._groupMessages = group.flatMap(node => node._groupMessages || (node._originalData ? [node._originalData] : []));
        album.dataset.groupKey = groupKey;
        album.dataset.hasText = '0';
        const mergedGroupId = group.map(n => n.dataset.groupId || '').find(Boolean);
        if (mergedGroupId) album.dataset.groupId = mergedGroupId;

        let combinedText = '';
        group.forEach(msgNode => {
          const textNode = msgNode.querySelector('.text');
          if (textNode) combinedText += textNode.innerHTML + '<br>';
        });

        const built = buildAlbumHTML(albumItems, groupKey);
        const lastFooter = group[group.length - 1].querySelector('.meta') || group[group.length - 1].querySelector('.timestamp');
        const downloadAllBtn = `
                <div class="media-actions text-center mt-2">
                    <button type="button" class="btn btn-sm btn-outline-secondary album-download-all">
                        <i class="bi bi-archive me-1"></i>
                        <span class="btn-text">Скачать всё</span>
                        <span class="spinner-border spinner-border-sm d-none" role="status"></span>
                    </button>
                </div>`;
        album.innerHTML = this.chat._safeRenderedHtml(`
                ${built.gridHtml}
                ${combinedText ? `<div class="text media-caption">${combinedText.trim().replace(/<br>$/, '')}</div>` : ''}
                ${downloadAllBtn}
                ${lastFooter ? lastFooter.outerHTML : ''}`);

        album._originalData = group[0]._originalData;
        const authorHeader = group[0].querySelector('.message-sender-link');
        if (authorHeader) album.prepend(authorHeader);
        const comments = group.map(node => node.querySelector('.message-comments')).find(Boolean);
        if (comments) album.append(comments);

        // кнопка реакций на всю группу
        try {
          this.chat._ensureGroupReactionButton(album, group[group.length - 1]._originalData);
        } catch (_) {}
        // и сразу отрендерим агрегат, чтобы он не был пустым до первого события
        try {
          const albumIds = (album.dataset.messageIds || '').split(',').filter(Boolean);
          const agg = this.chat._computeAggregatedReactions(albumIds);
          this.chat._renderGroupReactions(album, agg);
        } catch (_) {}

        container.insertBefore(album, group[0]);
        // регистрируем и планируем единый рендер по ключу группы
        this.chat._registerGroup(album);
        this.chat._pendingGroupRx.add(album.dataset.groupKey);
        this.chat._scheduleGroupRxFlush();

        group.forEach(msgNode => msgNode.remove());
        i = j;
        this.chat.observeNewMedia(album);
      } else {
        i++;
      }
    }
  }

  _getAlbumKey(el) {
    const GROUP_WINDOW_SEC = 10;
    const gid = el.dataset.groupId;
    if (gid && gid !== 'true') return `gid:${gid}`;
    const ts = parseInt(el.dataset.timestamp, 10) || 0;
    const bucket = Math.floor(ts / GROUP_WINDOW_SEC);
    const dir = el.classList.contains('in') ? 'in' : 'out';
    return `win:${dir}:${bucket}`;
  }

  normalizeFileGroups() {
    const c = this.chat.messagesContainer;
    if (!c) return;

    const GROUP_WINDOW_SEC = 10;

    const elId = (el) => {
      if (el?.dataset?.id) return String(el.dataset.id);
      const m = (el?.id || '').match(/message-(\d+)/);
      return m ? m[1] : '';
    };

    const isFileOnlyMessage = (el) => {
      if (!el || el.classList.contains('grouped-files')) return false;
      if (el.classList.contains('optimistic') || el.dataset.awaitingSync === '1') return false;
      // A semantic WPP document remains its own attachment card even when
      // the provider advertises image/jpeg for its MIME.
      if (el.dataset.documentAttachment === '1') return false;
      const hasText = el.dataset.hasText === '1';
      const hasFiles = el.querySelector('.attachments .msg-file, .attachments .attachment.file, .msg-file') !== null;
      const hasOtherMedia = el.querySelector('img.msg-photo, video.msg-video, audio.msg-audio') !== null;
      return !hasText && hasFiles && !hasOtherMedia;
    };

    const collectFilesFromMsg = (el) => {
      const fileDivs = Array.from(
        el.querySelectorAll('.attachments > .msg-file, .attachments > .attachment.file, .msg-file')
      );
      return fileDivs.map(div => div.outerHTML).join('');
    };

    const messages = Array.from(c.querySelectorAll('.message:not(.grouped-files)'));
    let i = 0;

    while (i < messages.length) {
      const currentMsg = messages[i];
      if (!isFileOnlyMessage(currentMsg)) {
        i++;
        continue;
      }

      const baseKey = this.chat._getAlbumKey(currentMsg); // ← ГЛАВНОЕ: общий ключ как у альбомов
      const dirIn = currentMsg.classList.contains('in');
      let lastTs = parseInt(currentMsg.dataset.timestamp, 10) || 0;

      const group = [currentMsg];
      let j = i + 1;
      while (j < messages.length) {
        const nextMsg = messages[j];
        const nextTs = parseInt(nextMsg.dataset.timestamp, 10) || 0;

        if (
          isFileOnlyMessage(nextMsg) &&
          this.chat._sameAlbumAuthor(currentMsg._originalData, nextMsg._originalData) &&
          nextMsg.classList.contains('in') === dirIn &&
          this.chat._getAlbumKey(nextMsg) === baseKey && // ← требуем тот же ключ
          (nextTs - lastTs) <= GROUP_WINDOW_SEC // ← и скользящее окно (не даст «разъехаться»)
        ) {
          group.push(nextMsg);
          lastTs = nextTs;
          j++;
        } else {
          break;
        }
      }

      if (group.length > 1) {
        const filesHTML = group.map(collectFilesFromMsg).join('');
        const firstMsg = group[0];
        const lastMsg = group[group.length - 1];
        const lastTimestamp = parseInt(lastMsg.dataset.timestamp, 10) || 0;

        const groupEl = document.createElement('div');
        groupEl.className = `message ${dirIn ? 'in' : 'out'} grouped-files`;
        groupEl.dataset.timestamp = String(lastTimestamp);
        groupEl.dataset.hasText = '0';

        // IDs сообщений группы — нужно для реакций и смайлика
        const ids = group.map(elId).filter(Boolean);
        groupEl.dataset.messageIds = ids.join(',');

        // СТАБИЛЬНЫЙ КЛЮЧ ГРУППЫ, как у альбомов:
        groupEl.dataset.groupKey = baseKey;

        groupEl.id = `group-files-${ids[0] || lastTimestamp}`;

        const meta = lastMsg.querySelector('.meta');
        const timestamp = meta ? meta.outerHTML : (lastMsg.querySelector('.timestamp')?.outerHTML || '');

        const downloadAllBtn = `
        <div class="media-actions text-center mt-2">
          <button type="button" class="btn btn-sm btn-outline-secondary files-download-all">
            <i class="bi bi-archive me-1"></i>
            <span class="btn-text">Скачать всё</span>
            <span class="spinner-border spinner-border-sm d-none" role="status"></span>
          </button>
        </div>`;

        groupEl.innerHTML = this.chat._safeRenderedHtml(`
        <div class="attachments">${filesHTML}</div>
        ${downloadAllBtn}
        ${timestamp}
      `);

        groupEl._originalData = firstMsg._originalData;
        const authorHeader = firstMsg.querySelector('.message-sender-link');
        if (authorHeader) groupEl.prepend(authorHeader);
        c.insertBefore(groupEl, firstMsg);
        group.forEach(n => n.remove());

        // The grouped card keeps the same shared controls as a regular
        // message. The action uses its most recent provider message id.
        try { this.chat._ensureGroupReactionButton(groupEl, lastMsg._originalData); } catch {}

        // регистрируем и планируем общий рендер
        this.chat._registerGroup(groupEl);
        this.chat._pendingGroupRx.add(groupEl.dataset.groupKey);
        this.chat._scheduleGroupRxFlush();

        i = j;
      } else {
        i++;
      }
    }
  }

  _fixAlbumUrls(root) {
    try {
      if (!root) return;
      root.querySelectorAll('a.tile-open[href*="/wa_media/"], a[data-lightbox][href*="/wa_media/"]').forEach(a => {
        try {
          const before = a.href;
          const after = this.chat._toPrettyWaMedia(this.chat._withNameParam(before, a.getAttribute('download') || a.getAttribute('data-prefetch-fn') || 'file'));
          if (after !== before) {
            a.href = after;
            const img = a.querySelector('img.msg-photo');
            if (img) {
              if (img.dataset.lazySrc) img.dataset.lazySrc = this.chat._toPrettyWaMedia(img.dataset.lazySrc);
              if (img.getAttribute('src')) img.setAttribute('src', this.chat._toPrettyWaMedia(img.getAttribute('src')));
            }
          }
        } catch (e) {
          console.warn('[WA DEBUG] fix openUrl failed', e);
        }
      });
      root.querySelectorAll('a.tile-dl[href*="/wa_media/"], .media-actions a[href*="/wa_media/"]').forEach(a => {
        try {
          let url = new URL(this.chat._toPrettyWaMedia(a.href), window.location.href);
          url.searchParams.set('dl', '1');
          const after = url.toString();
          if (after !== a.href) {
            a.href = after;
          }
        } catch (e) {
          console.warn('[WA DEBUG] fix dlUrl failed', e);
        }
      });
    } catch (e) {
      console.warn('[WA DEBUG] _fixAlbumUrls failed', e);
    }
  }
}
