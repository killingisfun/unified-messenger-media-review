import { originalAvatar } from '../avatar.js';
import { MotionMedia, motionKind } from '../MotionMedia.js?v=20261007-max-sticker-fallback-r1';
import { getProvider, hasKnownReactions, mergeMessageUpdate, normalizeMessage } from '../../domain/providers.js';
import { renderMessageActions } from '../components/MessageActions.js';
import { renderMessageQuote } from '../components/MessageQuote.js';

/** Shared message DOM, safe markup and incremental rendering for every provider. */
export class MessageRenderer {
  constructor(chat) { this.chat = chat; }

  patchMessageDOM(payload) {
    if (!this.chat._isActiveInstance()) return false;
    const rawPayload = payload || {};
    const hasReactionUpdate = hasKnownReactions(rawPayload);
    const incomingReactions = Object.prototype.hasOwnProperty.call(rawPayload, 'reactionsDetailed')
      ? rawPayload.reactionsDetailed
      : (Object.prototype.hasOwnProperty.call(rawPayload, 'reactions') ? rawPayload.reactions : []);
    const id = String(payload?.id || '');
    const candidate = id ? document.getElementById('message-' + id) : null;
    // Native albums deliberately reuse `message-{id}` on each tile so that
    // the lightbox and reaction aggregator can address an individual photo.
    // A realtime text update for such a child must never be patched into the
    // tile: prepending `.text` there shifts the full-size photo below the
    // clipping box and leaves only its neighbour clickable.  Only standalone
    // message roots own their bubble and may receive this generic DOM patch.
    const el = candidate && candidate.classList.contains('message')
      && this.chat.messagesContainer?.contains(candidate) ? candidate : null;
    payload = this.chat._mergeMessageState(mergeMessageUpdate(this.chat.source, el?._originalData || {}, rawPayload));
    if (hasReactionUpdate) {
      const reactions = this.chat._preserveReactionIntent(id, incomingReactions);
      payload = { ...payload, reactions, reactionsDetailed: reactions, reactionsKnown: true };
    }
    const batchEl = this.chat._batchOptimisticByMessageId?.get(id);
    if (batchEl?.isConnected && (Object.prototype.hasOwnProperty.call(payload || {}, 'is_read') || Object.prototype.hasOwnProperty.call(payload || {}, 'ack'))) {
      this.chat._markBatchReceipt(batchEl, id, this.chat._isReceiptRead(payload), Number(payload.ack ?? 0));
      return true;
    }
    // 🛡️ ВАЖНО: если DOM-ноды нет (в группах её часто нет), то всё равно обновим кэш реакций
    if (!el) {
      if (hasReactionUpdate) {
        const reactionsData = payload.reactionsDetailed || payload.reactions;
        const normalizedReactions = this.chat._normalizeReactions(reactionsData);
        this.chat._onMessageReactionsUpdated(id, normalizedReactions);
      }
      return false;
    }
    const updatedMsg = payload;
    el._originalData = updatedMsg;

    // A later partial update (realtime, receipt or reaction snapshot) may
    // carry the human text but omit the service marker.  The old generic
    // patcher then inserted a second plain-text line above an existing event
    // pill.  Service records have no reply or reaction controls, and their
    // single canonical label is already rendered inside the pill.
    if (el.classList.contains('service-message')) {
      el.querySelector(':scope > .text')?.remove();
      el.querySelector(':scope > .message-actions')?.remove();
      return true;
    }

    if (Object.prototype.hasOwnProperty.call(updatedMsg, 'text')) {
      const newHTML = updatedMsg.text?.trim() ? this.chat.linkify(updatedMsg.text) : '';
      let t = el.querySelector('.text');
      if (t && !newHTML) {
        t.remove();
      } else if (!t && newHTML) {
        const textNode = document.createElement('div');
        textNode.className = 'text';
        textNode.innerHTML = newHTML;
        (el.querySelector('.bubble') || el).prepend(textNode);
      } else if (t && newHTML) {
        t.innerHTML = newHTML;
      }
    }

    if (hasReactionUpdate) {
      const reactionsData = updatedMsg.reactionsDetailed || updatedMsg.reactions;
      let normalizedReactions = this.chat._normalizeReactions(reactionsData);

      // 🔧 подливаем actors из кэша (на случай голого payload)
      const prev = this.chat._rxByMessageId.get(id) || [];
      const prevByEmoji = new Map(prev.map(r => [r.emoji, r]));
      normalizedReactions = normalizedReactions.map(r => {
        if ((!r.actors || r.actors.length === 0) && prevByEmoji.has(r.emoji)) {
          const had = prevByEmoji.get(r.emoji);
          if (had && Array.isArray(had.actors) && had.actors.length) {
            return { ...r,
              actors: had.actors
            };
          }
        }
        return r;
      });

      this.chat._onMessageReactionsUpdated(id, normalizedReactions);

      const newReactionsHtml = this.chat.renderReactionsHTML({
        ...updatedMsg,
        reactions: normalizedReactions
      });
      let rxContainer = el.querySelector('.bubble > .rx');

      if (newReactionsHtml) {
        el.classList.toggle('has-reactions', !el.classList.contains('album') && !el.classList.contains('grouped-files'));
        if (!rxContainer) {
          rxContainer = document.createElement('div');
          rxContainer.className = 'rx';
          const meta = el.querySelector('.bubble .meta');
          if (meta) meta.parentNode.insertBefore(rxContainer, meta);
          else(el.querySelector('.bubble') || el).appendChild(rxContainer);
        }
        if (rxContainer.innerHTML !== newReactionsHtml) this.chat._setReactionMarkup(rxContainer, newReactionsHtml);
      } else if (rxContainer) {
        rxContainer.remove();
        el.classList.remove('has-reactions');
      }
    }

    if (el.classList.contains('out') && (Object.prototype.hasOwnProperty.call(updatedMsg, 'is_read') || Object.prototype.hasOwnProperty.call(updatedMsg, 'ack'))) {
      const i = el.querySelector('.read-receipt i');
      if (i) {
        this.chat._applyReceiptIcon(i, updatedMsg, false);
      }
    }
    return true;
  }

  _fallbackAvatarUrl(name = '') {
    const label = String(name || 'Чат').trim();
    const initials = label.startsWith('@')
      ? (Array.from(label.slice(1)).slice(0, 2).join('').toUpperCase() || 'Ч')
      : (label.split(/\s+/).slice(0, 2)
        .map((part) => Array.from(part)[0] || '')
        .join('').toUpperCase() || 'Ч');
    const palette = ['#e2ecf8', '#eee4f6', '#f7eadb', '#ddefe8', '#f3e1e5', '#e4e8f8'];
    const seed = Array.from(label).reduce((sum, char) => sum + char.codePointAt(0), 0);
    const safeText = initials.replace(/[&<>"']/g, (char) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    }[char]));
    return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="${palette[seed % palette.length]}"/><text x="48" y="51" dominant-baseline="middle" text-anchor="middle" fill="#44546a" font-family="Arial,sans-serif" font-size="32" font-weight="600">${safeText}</text></svg>`)}`;
  }

  _looksLikeInlineMediaText(text) {
    const value = String(text || '').trim();
    if (!value) return false;
    if (value.startsWith('data:image/') || value.startsWith('data:video/')) return true;
    if (value.startsWith('/9j/') || value.startsWith('iVBORw0KGgo') || value.startsWith('R0lGODlh') || value.startsWith('UklGR')) return true;
    if (value.length < 200) return false;
    if (/[\s<>]/.test(value)) return false;
    return /^[A-Za-z0-9+/=]+$/.test(value);
  }

  linkify(text) {
    const value = String(text ?? '');
    if (!value) return '';
    // Message bodies are provider data. Build the result from escaped text
    // segments and allow links only to web URLs; never interpolate a provider
    // value directly into HTML or an href attribute.
    const urlRegex = /(\bhttps?:\/\/[^\s<>"']+)|(\bwww\.[^\s<>"']+)/ig;
    const textHtml = (part) => this.chat._escapeHtml(part).replace(/\r?\n/g, '<br>');
    let html = '';
    let cursor = 0;
    let match;
    while ((match = urlRegex.exec(value))) {
      const rawUrl = match[0];
      html += textHtml(value.slice(cursor, match.index));
      const href = this.chat._safeRemoteUrl(rawUrl.startsWith('www.') ? `https://${rawUrl}` : rawUrl);
      html += href
        ? `<a href="${this.chat._escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${this.chat._escapeHtml(rawUrl)}</a>`
        : textHtml(rawUrl);
      cursor = match.index + rawUrl.length;
    }
    return html + textHtml(value.slice(cursor));
  }

  _escapeHtml(text) {
    return String(text ?? '').replace(/[&<>"']/g, ch => ({
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#39;'
    }[ch] || ch));
  }

  _safeRemoteUrl(value, fallback = '') {
    const raw = String(value ?? '').trim();
    if (!raw) return fallback;
    // These two data URLs are generated in this class, not supplied by a
    // provider. Other data: URLs (notably SVG) are deliberately rejected.
    if (raw === this.chat._tinyTransparent || raw === this.chat._videoPoster) return raw;
    try {
      const url = new URL(raw, window.location.href);
      const protocol = url.protocol.toLowerCase();
      return ['http:', 'https:', 'blob:'].includes(protocol) ? url.href : fallback;
    } catch {
      return fallback;
    }
  }

  _safeMime(value, fallback = 'application/octet-stream') {
    const mime = String(value ?? '').trim().toLowerCase();
    return /^[a-z0-9][a-z0-9.+-]*\/[a-z0-9][a-z0-9.+-]*$/.test(mime) ? mime : fallback;
  }

  _safeRenderedHtml(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html ?? '');
    template.content.querySelectorAll('script, iframe, object, embed, svg, math, base, link, meta, style').forEach((node) => node.remove());
    template.content.querySelectorAll('*').forEach((element) => {
      Array.from(element.attributes).forEach((attribute) => {
        const name = attribute.name.toLowerCase();
        if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction' || name === 'action' || name === 'srcset') {
          element.removeAttribute(attribute.name);
          return;
        }
        if (['href', 'src', 'poster', 'data-lazy-src', 'data-lazy-poster', 'data-download-url'].includes(name)) {
          const safeUrl = this.chat._safeRemoteUrl(attribute.value);
          if (safeUrl) element.setAttribute(attribute.name, safeUrl);
          else element.removeAttribute(attribute.name);
        }
      });
    });
    return template.innerHTML;
  }

  _messageForCurrentChat(raw) {
    const message = normalizeMessage(this.chat.source, raw || {});
    const messageChatId = String(message.chat_id ?? message.chatId ?? message.conversation_id ?? '').trim();
    const activeChatId = String(this.chat.chatId ?? '').trim();
    // Some providers omit the conversation id from individual history rows.
    // Scoped capabilities must still be evaluated against the actual open
    // conversation, while an explicit provider id always takes precedence.
    return !messageChatId && activeChatId
      ? { ...message, chat_id: activeChatId }
      : message;
  }

  _refreshMessageActions() {
    if (!this.chat._isActiveInstance() || !this.chat.messagesContainer) return;
    document.dispatchEvent(new CustomEvent('chat:capabilities', { detail: { source: this.chat.source, features: this.chat.providerCapabilities } }));
    this.chat.messagesContainer.querySelectorAll('.message').forEach((messageEl) => {
      const message = messageEl._originalData;
      if (!message) return;
      if (messageEl.classList.contains('service-message')) {
        messageEl.querySelector(':scope > .message-actions')?.remove();
        return;
      }
      const current = messageEl.querySelector(':scope > .message-actions');
      const markup = renderMessageActions(this.chat.source, message, this.chat.providerCapabilities);
      if (current) current.outerHTML = markup;
      else messageEl.insertAdjacentHTML('beforeend', markup);
    });
  }

  renderMessage(msg) {
    msg = this.chat._messageForCurrentChat(msg);
    msg = this.chat._mergeMessageState(msg);
    msg.reactions = this.chat._preserveReactionIntent(msg.id, msg.reactions);
    if (msg.reactionsDetailed) msg.reactionsDetailed = msg.reactions;
    const id = String(msg.id);
    if (!id.startsWith('optimistic_') && this.chat.renderedMessageIds.has(id)) {
      return null;
    }
    if (this.chat._isTechnicalWhatsAppAlbumParent(msg)) {
      // There is deliberately no DOM bubble for the provider's album
      // container. Still remember its native id so every polling result is
      // treated as handled and cannot delay the visible `wa-native:` items.
      if (id) this.chat.renderedMessageIds.add(id);
      return null;
    }
    const isOut = String(msg.direction) === 'out';
    // `event_pill` is provider-neutral: MAX is the first adapter to emit it,
    // while Telegram/WhatsApp/VK may later map their own system records here.
    const isService = msg.presentation === 'event_pill' || msg.is_service === true || String(msg.type || '').toLowerCase() === 'service';
    const serviceEvent = String(msg.service_event || '').toLowerCase();
    const eventStyle = String(msg.event_style || '').toLowerCase();
    const ts = Number(msg.timestamp || 0) * 1000;
    const time = isFinite(ts) ? new Date(ts) : new Date();
    const timeStr = `${time.getHours().toString().padStart(2, '0')}:${time.getMinutes().toString().padStart(2, '0')}`;
    const el = document.createElement('div');
    el._originalData = msg;
    const isOptimistic = id.startsWith('optimistic_');
    const optimisticClass = isOptimistic ? 'optimistic' : '';
    el.className = `message ${isService ? `service-message message-event-pill${eventStyle ? ` event-style-${eventStyle}` : ''}${/pin/.test(serviceEvent) ? ' service-message-pin' : ''}` : (isOut ? 'out' : 'in')} ${optimisticClass}`;
    el.id = `message-${id}`;
    el.dataset.id = id;
    el.dataset.timestamp = String(msg.timestamp || '');
    el.dataset.hasText = (msg.text && msg.text.trim().length) ? '1' : '0';

    if (isService) {
      const label = String(msg.text || 'Служебное событие группы').trim().slice(0, 1000);
      const icon = /leave|remove/i.test(serviceEvent) ? 'bi-person-dash' : /join|add|invite/i.test(serviceEvent) ? 'bi-person-plus' : /pin/i.test(serviceEvent) ? 'bi-pin-angle' : /call/i.test(serviceEvent) ? 'bi-telephone' : 'bi-info-circle';
      el.innerHTML = `<div class="service-message-pill"><i class="bi ${icon}" aria-hidden="true"></i><span>${this.chat._escapeHtml(label)}</span><time>${timeStr}</time></div>`;
      if (!isOptimistic) this.chat.renderedMessageIds.add(id);
      return el;
    }

    const rawGroup = msg.groupId ?? msg.group_id ?? msg.media_group_id ?? msg.album_id ?? msg.media_group;
    if (rawGroup !== true && rawGroup !== false && rawGroup != null) {
      el.dataset.groupId = String(rawGroup);
    } else if (rawGroup === true) {
      el.dataset.groupFlag = '1';
    }
    // `attachments` is the common, complete media contract. Telegram's
    // collapsed history may also carry an abbreviated `items` list without
    // URLs; using it first created empty-looking galleries. Only fall back to
    // `items` for an older adapter that truly has no attachments.
    const backendMedia = Array.isArray(msg.attachments) && msg.attachments.length
      ? msg.attachments
      : (Array.isArray(msg.items) ? msg.items : []);
    // A VK message can contain a mixed payload: real photo attachments plus
    // document attachments (even when the document filename ends in .JPG).
    // Group only the real photos into a gallery and render the rest as files.
    const isDocumentAttachment = (attachment) => this.chat._isDocumentAttachment(attachment);
    if (backendMedia.some(isDocumentAttachment)) {
      el.dataset.documentAttachment = '1';
    }
    const photoAttachments = backendMedia.filter((attachment) => {
      if (!attachment || isDocumentAttachment(attachment) || attachment.unavailable) return false;
      const type = String(attachment.type || '').toLowerCase();
      const kind = String(attachment.kind || '').toLowerCase();
      const mime = String(attachment.mime || '').toLowerCase();
      return type === 'photo' || type === 'image' || kind === 'photo' || kind === 'image'
        || (type === '' && kind === '' && mime.startsWith('image/'));
    });
    const otherAttachments = backendMedia.filter(a => !photoAttachments.includes(a));
    const isIncomingNativeAlbum = getProvider(this.chat.source).id === 'whatsapp' && msg.direction === 'in'
      && String(msg.groupId ?? msg.media_group_id ?? msg.group_id ?? '').startsWith('wa-native:') && photoAttachments.length > 0;
    const isAlbumFromBackend = photoAttachments.length > 1 || isIncomingNativeAlbum;
    // Backend albums (notably VK) arrive as one message with several photo
    // attachments. Mark the message itself as an album so the shared 260px
    // gallery styles are applied just like Telegram/WhatsApp.
    if (isAlbumFromBackend) el.classList.add('album');
    const rawBodyText = String(msg.text || '').trim();
    const isServiceMediaPlaceholder = backendMedia.length > 0 && /^\[(?:Изображение|Фото|Видео|Аудио|Файл|Стикер|Вложение)\](?:\s+.*)?$/i.test(rawBodyText);
    // Older cached VK rows used an invented `Пустое сообщение` text whenever
    // an attachment was discarded. Once current history has restored that
    // attachment, the exact sentinel is no longer message content. Scope it
    // to VK plus a present attachment so ordinary text-only messages remain
    // untouched, including messages from all other providers.
    const isLegacyVkPrivateVideoPlaceholder = getProvider(this.chat.source).id === 'vk'
      && rawBodyText === 'Пустое сообщение'
      && backendMedia.length > 0;
    const bodyText = (this.chat._looksLikeInlineMediaText(rawBodyText) || isServiceMediaPlaceholder || isLegacyVkPrivateVideoPlaceholder)
      ? ''
      : (rawBodyText.length ? this.chat.linkify(rawBodyText) : '');
    let attachmentsHtml = '';
    const renderSingle = (att) => {
      if (!att) return '';
      const {
        openUrl,
        displayUrl
      } = this.chat._pickBestMediaUrl(att);
      // Keep the MIME value local to one attachment.  The photo attachment
      // filter above has its own `mime` variable, but that scope does not
      // extend into this renderer.  A missing MIME must never abort rendering
      // the whole history page (MAX albums exposed this as a chat-load error).
      const mime = String(att.mime || '').toLowerCase();
      const filename = att.filename || att.title || 'file';
      const safeFilename = this.chat._escapeHtml(String(filename));
      const safeVideoMime = /^video\/[a-z0-9.+-]{1,80}$/.test(mime) ? mime : 'video/mp4';
      const safeAudioMime = /^audio\/[a-z0-9.+-]{1,80}$/.test(mime) ? mime : 'audio/mpeg';
      const lbHref = this.chat._toLightboxOpenUrl(openUrl || displayUrl, filename);
      const refreshChatId = String(att.media_refresh_chat_id || '');
      const refreshMessageId = String(att.media_refresh_message_id || '');
      const refreshAccountId = String(att.media_refresh_account_id || '');
      const refreshIndex = Number(att.media_refresh_index);
      const mediaRefreshAttr = /^-?[0-9]{1,20}$/.test(refreshChatId)
        && /^[1-9][0-9]{0,19}$/.test(refreshMessageId)
        && /^[1-9][0-9]{0,19}$/.test(refreshAccountId)
        && Number.isInteger(refreshIndex) && refreshIndex >= 0 && refreshIndex <= 99
        ? ` data-media-refresh-chat-id="${this.chat._escapeHtml(refreshChatId)}" data-media-refresh-message-id="${this.chat._escapeHtml(refreshMessageId)}" data-media-refresh-account-id="${this.chat._escapeHtml(refreshAccountId)}" data-media-refresh-index="${refreshIndex}"`
        : '';
      const normalizeAttType = (att) => {
        const t = (att.type || '').toLowerCase();
        const k = (att.kind || att.media_kind || att.media_group_kind || '').toLowerCase();
        const m = (att.mime || '').toLowerCase();

        // Явные типы от бэка — важнее всего
        if (t === 'photo' || k === 'photo') return 'photo';
        if (t === 'video' || k === 'video') return 'video';
        if (t === 'audio' || k === 'audio') return 'audio';
        if (t === 'sticker' || k === 'sticker') return 'sticker';
        if (t === 'link' || k === 'link') return 'link';
        if (t === 'poll' || k === 'poll') return 'poll';
        if (t === 'document' || t === 'file' || k === 'document') return 'file';

        // Если тип не задан — аккуратный фоллбэк по mime
        if (m.startsWith('image/')) return 'photo';
        if (m.startsWith('video/')) return 'video';
        if (m.startsWith('audio/')) return 'audio';
        return 'file';
      };
      // A Telegram document can have an image MIME (and even retain a
      // provider's photo-ish type).  The explicit document contract wins:
      // "send as file" must never turn into a full-size photo, GIF or
      // sticker merely because of its bytes.
      const isDocument = this.chat._isDocumentAttachment(att);
      const detectedMotion = isDocument ? '' : motionKind(att);
      // A video note is a playable video stream, not a sticker. Render it
      // through the shared video contract so merely scrolling cannot start
      // downloading it. Animated stickers and GIF-like motion keep their
      // existing autoplay behaviour.
      const motion = detectedMotion === 'note' ? '' : detectedMotion;
      const attachmentType = isDocument
        ? 'file'
        : detectedMotion === 'animation-image'
          ? 'photo'
          : detectedMotion === 'note' ? 'video' : normalizeAttType(att);
      if (attachmentType === 'link') {
        const href = this.chat._safeRemoteUrl(att.external_url || att.url || '');
        const title = String(att.title || att.site_name || href || 'Ссылка');
        const description = String(att.description || '').trim();
        let host = '';
        try { host = href ? new URL(href).hostname.replace(/^www\\./i, '') : ''; } catch {}
        if (!href || att.unavailable) {
          return `<div class="message-link-card attachment-card unavailable"><span class="attachment-icon"><i class="bi bi-link-45deg"></i></span><span class="file-meta"><span class="file-name">${this.chat._escapeHtml(title)}</span><span class="file-kind">${this.chat._escapeHtml(att.unavailable_label || 'Ссылка недоступна')}</span></span></div>`;
        }
        return `<a class="message-link-card attachment-card" href="${this.chat._escapeHtml(href)}" target="_blank" rel="noopener noreferrer"><span class="attachment-icon"><i class="bi bi-link-45deg"></i></span><span class="file-meta"><span class="file-name">${this.chat._escapeHtml(title)}</span>${description ? `<span class="link-description">${this.chat._escapeHtml(description)}</span>` : ''}<span class="file-kind">${this.chat._escapeHtml(host || href)}</span></span><i class="bi bi-box-arrow-up-right" aria-hidden="true"></i></a>`;
      }
      if (attachmentType === 'poll') {
        const rawOptions = Array.isArray(att.options) ? att.options.slice(0, 20) : [];
        const options = rawOptions.map((option) => ({
          text: String(option?.text || '').trim(),
          voters: Math.max(0, Number.parseInt(option?.voters, 10) || 0),
          chosen: option?.chosen === true,
        })).filter((option) => option.text !== '');
        const counted = options.reduce((sum, option) => sum + option.voters, 0);
        const total = Math.max(counted, Number.parseInt(att.total_voters, 10) || 0);
        const question = String(att.question || '').trim();
        const optionHtml = options.map((option) => {
          const percent = total > 0 ? Math.round((option.voters / total) * 100) : 0;
          return `<div class="poll-option${option.chosen ? ' is-chosen' : ''}" role="listitem"><span class="poll-option-copy">${this.chat._escapeHtml(option.text)}</span><span class="poll-option-result">${total > 0 ? `${percent}% · ${option.voters}` : '—'}</span><span class="poll-option-bar" aria-hidden="true"><i style="width:${percent}%"></i></span></div>`;
        }).join('');
        const kind = att.quiz ? 'Викторина' : (att.multiple_choice ? 'Можно выбрать несколько вариантов' : 'Опрос');
        const state = att.closed ? 'Опрос завершён' : (att.voted ? 'Ваш голос учтён' : kind);
        const voteWord = total === 1 ? 'голос' : (total >= 2 && total <= 4 ? 'голоса' : 'голосов');
        return `<section class="message-poll" aria-label="${this.chat._escapeHtml(question || 'Опрос')}"><div class="message-poll-heading"><i class="bi bi-bar-chart-fill" aria-hidden="true"></i><strong>${this.chat._escapeHtml(question || 'Опрос')}</strong></div><div class="poll-options" role="list">${optionHtml || '<span class="poll-empty">Варианты опроса недоступны.</span>'}</div><div class="poll-meta"><span>${this.chat._escapeHtml(state)}</span><span>${total} ${voteWord}</span></div></section>`;
      }
      if (motion && motion !== 'animation-image' && !att.unavailable) {
        const src = this.chat._escapeHtml(openUrl || displayUrl || '');
        const dl = this.chat._escapeHtml(this.chat._withDlParam(openUrl || displayUrl || ''));
        const sticker = motion.startsWith('sticker') || motion === 'lottie';
        const label = motion === 'note' ? 'Видеосообщение' : sticker ? 'Стикер' : 'Анимация';
        const control = motion === 'sticker-image' ? '' : `<button type="button" class="motion-toggle" aria-label="Воспроизвести ${label.toLowerCase()}">▶</button>`;
        let content;
        if (motion === 'lottie') content = '<div class="motion-canvas" role="img" aria-label="Анимированный стикер"></div>';
        else if (motion === 'sticker-image') content = `<img class="msg-sticker" alt="Стикер" data-lazy-src="${src}">`;
        else content = `<div class="video-player"><video class="msg-video" muted loop playsinline preload="metadata" data-lazy="1" aria-label="${label}" data-download-url="${dl}"><source data-lazy-src="${src}" type="${this.chat._escapeHtml(att.mime || 'video/mp4')}"></video></div>`;
        const previewSrc = this.chat._escapeHtml(this.chat._safeRemoteUrl(att.preview_url || ''));
        return `<div class="media-holder motion-media ${motion === 'sticker-image' || motion === 'lottie' ? '' : 'video-holder'} ${sticker ? 'motion-sticker' : ''} ${motion === 'note' ? 'video-note' : ''}" data-motion="${motion}"${mediaRefreshAttr}${motion === 'lottie' ? ` data-motion-src="${src}"${previewSrc ? ` data-motion-preview-src="${previewSrc}"` : ''}` : ''}>${content}${control}${motion === 'note' ? '<span class="motion-time"></span>' : ''}<a class="motion-download" href="${dl}" download title="Скачать" aria-label="Скачать ${label.toLowerCase()}">↓</a></div>`;
      }

      if (attachmentType === 'photo') {
        const imgSrc = displayUrl || this.chat._tinyTransparent;
        const fullFallbackSrc = openUrl && displayUrl && openUrl !== displayUrl ? openUrl : '';
        const niceName = this.chat._pickDownloadName(filename, att.mime, lbHref);
        const downloadUrl = this.chat._withDlParam(this.chat._withNameParam(lbHref, niceName));
        if (att.unavailable) {
          const fallbackDownload = this.chat._withDlParam(this.chat._withNameParam(att.download || downloadUrl, niceName));
          const unavailableLabel = att.unavailable_label || 'Фото недоступно';
          return `<div class="media-holder single-photo media-unavailable"><div class="media-unavailable-label"><i class="bi bi-image"></i><span>${unavailableLabel}</span></div><a class="tile-dl" href="${fallbackDownload}" download="${niceName}" title="Попробовать скачать"><i class="bi bi-download"></i></a></div>`;
        }
        const lightboxTitle = `${niceName} · <a class='lb-download' href='${downloadUrl}' download='${niceName}'><i class='bi bi-download'></i> Скачать</a>`;
        const fallbackAttr = fullFallbackSrc ? ` data-fallback-src="${this.chat._escapeHtml(fullFallbackSrc)}"` : '';
        const isAnimatedImage = att.animated === true || mime === 'image/gif' || /\.gif(?:[?#]|$)/i.test(String(filename));
        const motionBadge = isAnimatedImage ? '<span class="media-motion-badge" aria-label="Анимированный GIF">GIF</span>' : '';
        return `<div class="media-holder single-photo${isAnimatedImage ? ' animated-image' : ''}"${mediaRefreshAttr}>${motionBadge}<a class="single-photo-link" href="${lbHref}" data-lightbox="m-${id}" data-title="${lightboxTitle}"><img class="msg-photo rounded" alt="${niceName}" data-lazy-src="${imgSrc}"${fallbackAttr}></a>${isOptimistic ? '' : `<a class="tile-dl" href="${downloadUrl}" download="${niceName}" title="Скачать"><i class="bi bi-download"></i></a>`}</div>`;
      }
      if (attachmentType === 'video') {
        const isVideoNote = att.video_note === true || Number(att.video_type) === 1;
        const videoHolderClass = `media-holder video-holder${isVideoNote ? ' video-note' : ''}`;
        const videoLabel = isVideoNote ? 'Видеосообщение' : 'Видео';
        if (att.playback_unavailable === true) {
          const durationSeconds = Math.max(0, Number(att.duration) || 0);
          const duration = durationSeconds > 0
            ? `${Math.floor(durationSeconds / 60)}:${String(Math.floor(durationSeconds % 60)).padStart(2, '0')}`
            : '';
          const title = this.chat._escapeHtml(String(att.title || 'Видео VK'));
          // VK has not supplied a playable URL for this private video.  Do
          // not try its transient preview URL: the generic lazy loader would
          // turn one denied request into a broken-image icon and an alarming
          // media error.  A stable in-app card is more honest and does not
          // create background requests while the user reads the chat.
          return `<div class="${videoHolderClass} vk-provider-video" data-provider-video="vk"><div class="video-player vk-provider-video-frame" data-media-state="restricted" role="img" aria-label="${title}: доступ ограничен"><i class="bi bi-camera-video-fill vk-provider-video-icon" aria-hidden="true"></i><span class="vk-provider-video-lock" aria-hidden="true"><i class="bi bi-lock-fill"></i></span><span class="vk-provider-video-title">${title}</span>${duration ? `<span class="vk-provider-video-duration">${duration}</span>` : ''}</div><div class="media-provider-note"><i class="bi bi-shield-lock" aria-hidden="true"></i><span>Видеозапись с ограниченным доступом</span></div></div>`;
        }
        if (att.unavailable) {
          const niceName = this.chat._pickDownloadName(filename, att.mime, lbHref);
          const downloadUrl = this.chat._withDlParam(this.chat._withNameParam(att.download || lbHref, niceName));
          return `<div class="${videoHolderClass}"><div class="video-player" data-media-state="error"><div class="media-error" role="status"><span>${att.unavailable_label || `${videoLabel} недоступно`}</span></div></div><div class="media-actions"><a class="media-download" href="${downloadUrl}" download="${niceName}"><i class="bi bi-download" aria-hidden="true"></i><span>Попробовать скачать</span></a></div></div>`;
        }
        // Telegram can mark AVI/MKV and other containers as a video document,
        // while Chromium has no decoder for that declared MIME type. Do not
        // present a permanently black native player in that case: retain the
        // attachment as a truthful downloadable video card. MP4/WebM/MOV
        // keep the player whenever this WebView advertises support.
        let browserCanPlay = true;
        try {
          const probe = document.createElement('video');
          browserCanPlay = Boolean(probe.canPlayType?.(safeVideoMime));
        } catch {}
        if (!browserCanPlay) {
          const safeDownload = this.chat._escapeHtml(this.chat._withDlParam(lbHref));
          return `<div class="${videoHolderClass} video-format-unsupported"><div class="video-player" data-media-state="error"><div class="media-error" role="status"><span>Формат видео не поддерживается встроенным проигрывателем</span></div></div><div class="media-actions mt-1 small"><a class="media-download" href="${safeDownload}" download="${safeFilename}"><i class="bi bi-download" aria-hidden="true"></i><span>Скачать видео</span></a></div></div>`;
        }
        // Every provider shares this stream boundary. A real thumbnail is
        // preferred, but a generated static play surface keeps a video with
        // no provider preview from probing MP4 bytes during scrolling.
        const posterCandidate = att.poster || att.preview_url || att.preview || att.thumbnail || '';
        const poster = this.chat._safeRemoteUrl(posterCandidate)
          || (String(displayUrl || openUrl || '').startsWith('blob:') ? '' : this.chat._videoPoster);
        const posterAttr = poster ? ` data-lazy-poster="${this.chat._escapeHtml(poster)}"` : '';
        // A local optimistic video is already a browser-owned Blob URL. It
        // must be attached immediately so the sender sees its first frame;
        // deferring it with the remote-media policy produced a permanent
        // black tile until a second click after the upload completed.
        const localVideo = String(displayUrl || openUrl || '').startsWith('blob:');
        const deferredAttr = localVideo ? '' : ' data-defer-video="1"';
        // The source remains only in data-lazy-src until explicit Play.
        // This lets Chromium request normal byte ranges after activation,
        // without opening a full media response for timeline rendering.
        const preload = localVideo ? 'auto' : 'none';
        const src = this.chat._escapeHtml(displayUrl || '');
        const safeDownload = this.chat._escapeHtml(this.chat._withDlParam(lbHref));
        const width = Number(att.width ?? att.w);
        const height = Number(att.height ?? att.h);
        const dimensionAttr = Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0
          ? ` data-video-width="${Math.min(100000, Math.floor(width))}" data-video-height="${Math.min(100000, Math.floor(height))}"`
          : '';
        return `<div class="${videoHolderClass}"${mediaRefreshAttr}><div class="video-player"><video class="msg-video${isVideoNote ? ' msg-video-note' : ''}" controls playsinline preload="${preload}"${posterAttr}${deferredAttr}${dimensionAttr} aria-label="${this.chat._escapeHtml(`${videoLabel} ${filename}`)}" data-lazy="1" data-fallback-label="${safeFilename}" data-download-url="${safeDownload}"><source data-lazy-src="${src}" type="${safeVideoMime}"></video></div><div class="media-actions mt-1 small"><a class="media-download" href="${safeDownload}" download="${safeFilename}"><i class="bi bi-download" aria-hidden="true"></i><span>Скачать ${isVideoNote ? 'кружок' : 'видео'}</span></a></div></div>`;
      }
      if (attachmentType === 'audio') {
        const src = this.chat._escapeHtml(displayUrl || '');
        const safeDownload = this.chat._escapeHtml(this.chat._withDlParam(lbHref));
        return `<div class="media-holder"${mediaRefreshAttr}><audio controls preload="metadata" data-lazy="1"><source data-lazy-src="${src}" type="${safeAudioMime}"></audio><div class="media-actions mt-1 small"><a class="media-download" href="${safeDownload}" download="${safeFilename}"><i class="bi bi-download" aria-hidden="true"></i><span>Скачать аудио</span></a></div></div>`;
      }
      if (attachmentType === 'sticker') {
        const src = displayUrl || openUrl || '';
        const niceName = this.chat._pickDownloadName(filename || 'sticker', att.mime, src);
        if (att.unavailable || !src) {
          return `<div class="message-sticker"><span class="sticker-fallback"><i class="bi bi-sticky"></i><span>${att.unavailable_label || 'Стикер недоступен'}</span></span></div>`;
        }
        const downloadUrl = this.chat._withDlParam(this.chat._withNameParam(src, niceName));
        return `<div class="message-sticker"${mediaRefreshAttr}><img class="msg-sticker" alt="Стикер" data-lazy-src="${src}"><a class="tile-dl" href="${downloadUrl}" download="${niceName}" title="Скачать стикер"><i class="bi bi-download"></i></a></div>`;
      }
      if (attachmentType === 'file') {
        const providedDownload = att.download || att.public_url || openUrl || displayUrl || att.url || '';
        const raw = providedDownload || '#';
        const niceName = this.chat._pickDownloadName(filename, att.mime, raw);
        const open = this.chat._toLightboxOpenUrl(raw, niceName);
        const dl = this.chat._withDlParam(this.chat._withNameParam(raw, niceName));
        if (att.unavailable) {
          const download = providedDownload
            ? `<a class="attachment-download" href="${dl}" download="${niceName}" title="Скачать файл"><i class="bi bi-download"></i></a>`
            : '';
          return `<div class="msg-file attachment-card unavailable"><span class="attachment-thumb-placeholder"><i class="bi bi-file-earmark-x"></i></span><span class="file-meta"><span class="file-name">${niceName}</span><span class="file-kind">${att.unavailable_label || 'Превью недоступно'}</span></span>${download}</div>`;
        }
        // A document URL is often a PDF/office archive, not an image. Never
        // feed it to <img>: a broken-image icon looks like a loading failure.
        // Only true photo attachments receive a thumbnail in the chat.
        const ext = (niceName.match(/\.([a-z0-9]{1,10})$/i)?.[1] || '').toLowerCase();
        const iconClass = ext === 'pdf' ? 'is-pdf' : (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) ? 'is-archive' : (['mp3', 'wav', 'ogg', 'mp4', 'mov', 'avi'].includes(ext) ? 'is-media' : ''));
        const iconName = ext === 'pdf' ? 'bi-file-earmark-pdf' : (['zip', 'rar', '7z', 'tar', 'gz'].includes(ext) ? 'bi-file-earmark-zip' : (['mp3', 'wav', 'ogg', 'mp4', 'mov', 'avi'].includes(ext) ? 'bi-file-earmark-play' : 'bi-file-earmark'));
        const thumbHtml = `<span class="attachment-icon ${iconClass}"><i class="bi ${iconName}"></i></span>`;
        return `<div class="msg-file attachment-card"${mediaRefreshAttr}><a class="file-link d-flex align-items-center" href="${open}" target="_blank" rel="noopener">${thumbHtml}<span class="file-meta"><span class="file-name">${niceName}</span><span class="file-kind">${att.source_type === 'document' ? 'Вложение' : 'Файл'}</span></span></a><a class="attachment-download" href="${dl}" download="${niceName}" title="Скачать"><i class="bi bi-download"></i></a></div>`;
      }
      return '';
    };
    if (isAlbumFromBackend) {
      const list = photoAttachments;
      const lbKey = `alb-${id}`;
      const gridClass = list.length === 1 ? 'one' : list.length === 2 ? 'two' : list.length === 3 ? 'three' : 'four';
      const tiles = list.map((a, index) => {
        const {
          openUrl,
          displayUrl
        } = this.chat._pickBestMediaUrl(a);
        const filename = this.chat._pickDownloadName(a.filename || a.title || 'image', a.mime, openUrl || displayUrl);
        if (a.unavailable) {
          const fallbackDownload = this.chat._withDlParam(this.chat._withNameParam(a.download || '', filename));
          const unavailableLabel = a.unavailable_label || 'Фото недоступно';
          return `
            <div class="album-tile media-unavailable">
                <div class="media-unavailable-label"><i class="bi bi-image"></i><span>${unavailableLabel}</span></div>
                ${fallbackDownload ? `<a class="tile-dl" href="${fallbackDownload}" download="${filename}" title="Попробовать скачать"><i class="bi bi-download"></i></a>` : ''}
            </div>`;
        }
        const lbHref = this.chat._toLightboxOpenUrl(openUrl || displayUrl, filename);
        const thumb = displayUrl || a.preview || a.thumbnail || openUrl;
        const fullFallbackSrc = openUrl && thumb && openUrl !== thumb ? openUrl : '';
        const downloadUrl = this.chat._withDlParam(this.chat._withNameParam(lbHref, filename));
        const lightboxTitle = `${filename} · <a class='lb-download' href='${downloadUrl}' download='${filename}'><i class='bi bi-download'></i> Скачать</a>`;
        if (index > 3) {
          return `<a class="d-none" href="${lbHref}" data-lightbox="${lbKey}" data-title="${lightboxTitle}"></a>`;
        }
        const moreClass = index === 3 && list.length > 4 ? ' more' : '';
        return `
            <div class="album-tile t${index + 1}${moreClass}"${moreClass ? ` data-more="+${list.length - 3}"` : ''}>
                <a href="${lbHref}" data-lightbox="${lbKey}" data-title="${lightboxTitle}">
                    <img class="rounded msg-photo${isIncomingNativeAlbum ? ' native-album-photo' : ''}" ${isIncomingNativeAlbum ? `data-album-child="${this.chat._escapeHtml(String(msg._albumMessages?.[index]?.id || msg.id))}"` : ''} alt="${isIncomingNativeAlbum ? '' : filename}" data-lazy-src="${thumb}"${fullFallbackSrc ? ` data-fallback-src="${this.chat._escapeHtml(fullFallbackSrc)}"` : ''}>
                </a>
                ${isOptimistic ? '' : `<a class="tile-dl" href="${downloadUrl}" download="${filename}" title="Скачать фото"><i class="bi bi-download"></i></a>`}
            </div>`;
      }).join('');
      const extraFiles = otherAttachments.map(renderSingle).filter(Boolean);
      const downloadAllClass = extraFiles.length ? 'files-download-all' : 'album-download-all';
      attachmentsHtml = `
            <div class="album-grid ${gridClass}">${tiles}</div>
            ${extraFiles.length ? `<div class="attachments grouped-album-files">${extraFiles.join('')}</div>` : ''}
            ${isOptimistic ? '' : `<div class="media-actions text-center mt-2">
                <button type="button" class="btn btn-sm btn-outline-secondary ${downloadAllClass}">
                    <i class="bi bi-archive me-1"></i>
                    <span class="btn-text">Скачать всё</span>
                    <span class="spinner-border spinner-border-sm d-none" role="status"></span>
                </button>
            </div>`}`;
    } else if (backendMedia.length) {
      const parts = backendMedia.map(renderSingle).filter(Boolean);
      const downloadAllBtn = parts.length > 1 ? `
        <div class="media-actions text-center mt-2">
          <button type="button" class="btn btn-sm btn-outline-secondary files-download-all">
            <i class="bi bi-archive me-1"></i>
            <span class="btn-text">Скачать всё</span>
            <span class="spinner-border spinner-border-sm d-none" role="status"></span>
          </button>
        </div>` : '';
      attachmentsHtml = `<div class="attachments">${parts.join('')}</div>${downloadAllBtn}`;
    }
    // Do not leave a timestamp-only bubble for provider service records.
    // Every provider attachment field passes through the same final HTML and
    // URL policy. This also protects older provider-specific media branches
    // that still build markup with template strings.
    attachmentsHtml = this.chat._safeRenderedHtml(attachmentsHtml);
    if (!bodyText && !attachmentsHtml) return null;
    let receiptHtml = '';
    if (isOut) {
      const receipt = { className: '', style: {}, title: '' };
      this.chat._applyReceiptIcon(receipt, msg, isOptimistic);
      const readStyle = receipt.style.color ? ' style="color:#0d6efd"' : '';
      receiptHtml = `<span class="read-receipt"><i class="${receipt.className}" title="${receipt.title}"${readStyle}></i></span>`;
    }
    const reactionsHtml = this.chat.renderReactionsHTML(msg);
    if (reactionsHtml && !el.classList.contains('album') && !el.classList.contains('grouped-files')) {
      el.classList.add('has-reactions');
    }
    const quoteHtml = renderMessageQuote(msg.replyTo);
    // Group-capable providers expose individual authors for group history.
    // Preserve this as message metadata instead of turning the group title
    // into a sender name.
    // The avatar is optional; initials are strictly the visual fallback.
    const providerId = getProvider(this.chat.source).id;
    const messageChatKind = String(msg.chat_kind ?? msg.chatKind ?? msg.conversation_kind ?? '').toLowerCase();
    const isGroupConversation = ['group', 'channel', 'chat', 'community'].includes(messageChatKind)
      || (!messageChatKind && providerId === 'telegram' && /^-/.test(String(this.chat.chatId || '')))
      || (!messageChatKind && providerId === 'max' && /^-/.test(String(this.chat.chatId || '')))
      || (providerId === 'whatsapp' && /@g\.us$/i.test(String(this.chat.chatId || '')));
    // Every provider may expose a group author.  This must be based on the
    // message/chat contract, not a list of services, so new adapters do not
    // silently fall back to the one fictitious "Собеседник".
    const isGroupMessage = isGroupConversation && !isOut;
    const senderName = String(msg.sender_name || '').trim();
    const senderProfileId = String(msg.sender_profile_id || msg.sender_id || '').trim();
    const senderAvatar = originalAvatar(msg.sender_avatar, msg.sender_avatar_url);
    const senderInitials = senderName.split(/\s+/).filter(Boolean).slice(0, 2)
      .map((part) => Array.from(part)[0] || '').join('').toUpperCase().slice(0, 2);
    let senderHtml = '';
    if (isGroupMessage && senderName) {
      const avatarHtml = senderAvatar
        ? `<img class="message-sender-avatar" src="${this.chat._escapeHtml(senderAvatar)}" alt="" loading="lazy" decoding="async">`
        : `<span class="message-sender-avatar message-sender-avatar--fallback" aria-hidden="true">${this.chat._escapeHtml(senderInitials || '•')}</span>`;
      const content = `${avatarHtml}<span class="message-sender-name">${this.chat._escapeHtml(senderName)}</span>`;
      // MAX has a dedicated member-profile route. Other providers may expose
      // author identity before a safe member-profile action; render that name
      // as static rather than opening the group/contact profile by mistake.
      senderHtml = senderProfileId && ['max', 'telegram'].includes(providerId)
        ? `<button type="button" class="message-sender-link" data-message-sender-profile-id="${this.chat._escapeHtml(senderProfileId)}" data-message-sender-name="${this.chat._escapeHtml(senderName)}" data-message-sender-avatar="${this.chat._escapeHtml(senderAvatar)}" title="Открыть профиль ${this.chat._escapeHtml(senderName)}">${content}</button>`
        : `<div class="message-sender-link message-sender-link--static">${content}</div>`;
    }
    const actionsHtml = renderMessageActions(this.chat.source, msg, this.chat.providerCapabilities);
    const isOptimisticPhotoBatch = isOptimistic && isOut && isAlbumFromBackend && otherAttachments.length === 0;
    const hasVideo = backendMedia.some(a => String(a.type || '').toLowerCase() === 'video' || String(a.mime || '').startsWith('video/'));
    const hasRestrictedVkVideo = backendMedia.some(a => a?.playback_unavailable === true);
    const hasPhotoCaption = (photoAttachments.length > 0 || hasVideo) && Boolean(bodyText);
    el.classList.toggle('has-media-caption', hasPhotoCaption);
    el.classList.toggle('is-single-video', hasVideo && backendMedia.length === 1);
    // A forwarded VK message can contain several private videos. They remain
    // distinct cards, but must use the same readable column as a standalone
    // video instead of inheriting the narrow text-bubble width.
    el.classList.toggle('has-restricted-vk-video', hasRestrictedVkVideo);
    const reservedAlbumDownload = isOptimisticPhotoBatch ? `
        <div class="media-actions text-center mt-2">
            <button type="button" class="btn btn-sm btn-outline-secondary album-download-all" disabled aria-disabled="true" title="Будет доступно после подтверждения">
                <i class="bi bi-archive me-1"></i>
                <span class="btn-text">Скачать всё</span>
                <span class="spinner-border spinner-border-sm d-none" role="status"></span>
            </button>
        </div>` : '';
    el.innerHTML = this.chat._safeRenderedHtml(isOptimisticPhotoBatch ? `
        ${attachmentsHtml}
        ${bodyText ? `<div class="text media-caption">${bodyText}</div>` : ''}
        ${reservedAlbumDownload}
        ${reactionsHtml ? `<div class="rx">${reactionsHtml}</div>` : ''}
        <div class="meta">
            <span class="time">${timeStr}</span>
            ${receiptHtml}
        </div>` : `
        <div class="bubble">
            ${senderHtml}
            ${quoteHtml}
            ${bodyText && !hasPhotoCaption ? `<div class="text">${bodyText}</div>` : ''}
            ${attachmentsHtml}
            ${hasPhotoCaption ? `<div class="text media-caption">${bodyText}</div>` : ''}
            ${reactionsHtml ? `<div class="rx">${reactionsHtml}</div>` : ''}
            <div class="meta">
                <span class="time">${timeStr}</span>
                ${receiptHtml}
            </div>
        </div>
        ${actionsHtml}`);
    // Keep the caption attached to the pictures, before archive actions.
    // Both provisional and confirmed albums use the same visual order.
    if (hasPhotoCaption) {
      const caption = el.querySelector('.media-caption');
      const actions = el.querySelector('.media-actions');
      if (caption && actions && caption.parentElement === actions.parentElement) actions.before(caption);
      else if (caption && actions && el.classList.contains('is-single-video')) actions.before(caption);
    }
    const authorImage = el.querySelector('img.message-sender-avatar');
    if (authorImage) {
      const fallback = () => {
        const placeholder = document.createElement('span');
        placeholder.className = 'message-sender-avatar message-sender-avatar--fallback';
        placeholder.setAttribute('aria-hidden', 'true');
        placeholder.textContent = senderInitials || '•';
        authorImage.replaceWith(placeholder);
      };
      authorImage.addEventListener('error', fallback, { once: true });
      if (authorImage.complete && !authorImage.naturalWidth) fallback();
    }
    const video = el.querySelector('video.msg-video');
    if (video && backendMedia.length === 1) {
      const attachment = backendMedia[0];
      this.chat._applyVideoDimensions(video, attachment.width ?? attachment.w, attachment.height ?? attachment.h);
    }
    const motionElement = el.querySelector('[data-motion]');
    if (motionElement) {
      el.classList.toggle('is-motion-only', !bodyText && !quoteHtml && backendMedia.length === 1);
      if (!this.chat._motionMedia) this.chat._motionMedia = new MotionMedia(this.chat.lifetime, this.chat.messageArea);
      this.chat._motionMedia.register(el);
    }
    if (getProvider(this.chat.source).id === 'telegram' && msg.discussion?.enabled === true) {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'message-comments';
      button.textContent = 'Комментарии · ' + Math.max(0, Number(msg.discussion.count) || 0);
      button.addEventListener('click', () => this.chat.telegramDiscussion.open(msg));
      el.append(button);
    }
    if (!isOptimistic) {
      this.chat.renderedMessageIds.add(id);
    }
    return el;
  }

  _expandMessagesForReconciliation(messages) {
    const expanded = [];
    const byId = new Map();
    for (const source of messages || []) {
      // Album cards are presentation objects. Their children, not the card's
      // canonical (usually last) id, are the provider messages that can
      // acknowledge an optimistic send. Reconciliation must therefore happen
      // before this renderer turns children into a visual group.
      const candidates = Array.isArray(source?._albumMessages) && source._albumMessages.length
        ? source._albumMessages
        : [source];
      for (const candidate of candidates) {
        const message = this.chat._messageForCurrentChat(candidate);
        const id = String(message?.id || '').trim();
        if (!id) continue;
        const previous = byId.get(id);
        if (!previous) {
          byId.set(id, message);
          expanded.push(message);
          continue;
        }
        // A receipt can reach this method before the full history/realtime
        // snapshot.  Merge the two records rather than letting whichever was
        // first silently discard the attachment payload.
        const merged = mergeMessageUpdate(this.chat.source, previous, message);
        byId.set(id, merged);
        const index = expanded.findIndex(entry => String(entry?.id || '') === id);
        if (index >= 0) expanded[index] = merged;
      }
    }
    return expanded;
  }

  _prepareRenderedDocumentGroupRefresh(message) {
    const ids = new Set((Array.isArray(message?._albumMessageIds) ? message._albumMessageIds : [])
      .map(id => String(id || '').trim()).filter(Boolean));
    if (ids.size < 2 || !this.chat.messagesContainer) return null;
    const members = Array.isArray(message?._albumMessages) && message._albumMessages.length
      ? message._albumMessages
      : [message];
    // This path is exclusively for document groups. Incoming WhatsApp photo
    // albums have their own incremental upsert that merges an existing card
    // with later children; never remove that card from a partial photo page.
    if (!members.every(member => Array.isArray(member?.attachments)
      && member.attachments.some(attachment => this.chat._isDocumentAttachment(attachment)))) return null;
    const groupKey = `gid:${String(message?.media_group_id || message?.group_id || message?.groupId || '')}`;
    const nodes = [];
    const knownIds = new Set(ids);
    for (const node of [...this.chat.messagesContainer.querySelectorAll('.message')]) {
      const nodeIds = new Set([
        ...String(node.dataset?.messageIds || '').split(','),
        String(node.dataset?.id || node._originalData?.id || ''),
        ...(Array.isArray(node._groupMessages) ? node._groupMessages.map(item => String(item?.id || '')) : []),
      ].map(id => id.trim()).filter(Boolean));
      const sameGroup = groupKey !== 'gid:' && node.dataset?.groupKey === groupKey;
      const overlaps = [...nodeIds].some(id => ids.has(id));
      if (!sameGroup && !overlaps) continue;
      nodeIds.forEach(id => {
        knownIds.add(id);
        this.chat.renderedMessageIds.delete(id);
      });
      nodes.push(node);
    }
    if (!nodes.length) return null;
    // Keep the old card connected while the new one is built. A malformed or
    // already-handled partial response must never erase a complete group.
    return {
      restore: () => knownIds.forEach(id => this.chat.renderedMessageIds.add(id)),
      commit: () => nodes.forEach((node) => {
        const nodeIds = String(node.dataset?.messageIds || '').split(',').map(id => id.trim()).filter(Boolean);
        nodeIds.forEach(id => this.chat._msgIdToGroupKey?.delete(id));
        if (node.dataset?.groupKey) this.chat._groupKeyToEl?.delete(node.dataset.groupKey);
        node.remove();
      }),
    };
  }

  renderMessagesBatch(messages, prepend = false, options = {}) {
    if (!this.chat._isActiveInstance() || !messages || !messages.length) return;
    const stickToBottom = !prepend && options?.stickToBottom === true;
    messages = messages
      .map((message) => this.chat._messageForCurrentChat(message))
      .filter((message) => message.id);
    const nativeMessages = this._expandMessagesForReconciliation(messages);
    this.chat._reconcileOutgoingOperations(nativeMessages);
    // Store every explicit child snapshot before collapsing an album.  The
    // card renders one aggregate, while Telegram reports reactions by native
    // child id; without this, a reaction on an earlier photo disappears after
    // a reload even though the history record contains it.
    for (const message of nativeMessages) {
      if (!hasKnownReactions(message)) continue;
      this.chat._onMessageReactionsUpdated(message.id, this.chat._normalizeReactions(message.reactionsDetailed ?? message.reactions ?? []));
    }
    // Consume every authoritative native message first. In particular, never
    // pass an aggregate into _consumeOptimisticMessage: it would store all
    // files under the aggregate's last native id and either duplicate a file
    // or leave the optimistic batch waiting for a child that cannot arrive.
    const displayMessages = nativeMessages.filter((message) => !this.chat._consumeOptimisticMessage(message));
    // WhatsApp keeps the native album id on every photo. Build that exact
    // server group before it touches the DOM: inserting the children and
    // replacing them with a grid one frame later visibly shakes the chat.
    // Documents sent as one user-selected batch have distinct native IDs on
    // some providers.  Recover their exact persisted operation before the
    // generic provider album logic so reopening a chat keeps one file card.
    this.chat._seedRenderedDocumentGroups?.();
    messages = this.chat._collapseLocalOutgoingDocumentBatches(displayMessages);
    messages = this.chat._collapseWhatsAppPhotoAlbums(messages);
    const frag = document.createDocumentFragment();
    let addedCount = 0;
    messages.forEach(m => {
      const refresh = this._prepareRenderedDocumentGroupRefresh(m);
      if (this.chat._upsertIncomingNativeAlbum(m, frag)) { addedCount++; return; }
      const el = this.chat.renderMessage(m);
      if (el) {
        refresh?.commit();
        const albumIds = Array.isArray(m._albumMessageIds) ? m._albumMessageIds : [];
        if (albumIds.length > 1) {
          el.dataset.messageIds = albumIds.join(',');
          el.dataset.groupKey = `gid:${String(m.media_group_id || m.group_id || '')}`;
          el._groupMessages = Array.isArray(m._albumMessages) ? m._albumMessages : [m];
          // renderMessage registers its canonical (last) id. Polling must also
          // consider every child handled, otherwise a later response inserts
          // the same photos as standalone bubbles.
          albumIds.forEach((id) => this.chat.renderedMessageIds.add(String(id)));
        }
        frag.appendChild(el);
        addedCount++;
      } else refresh?.restore();
    });
    // A repeated polling result can contain only ids already in the DOM.
    // In that case there is nothing to group, load or scroll.
    if (addedCount === 0) return 0;
    // Keep the roots before appending the fragment. The grouping pass may
    // replace some of them with an album/group card; connected roots are then
    // observed below, while normalizeMediaGroups observes newly-created cards
    // at the seam itself.
    const addedRoots = Array.from(frag.childNodes).filter(node => node?.nodeType === 1);
    addedRoots.forEach(node => this.chat._pendingMediaRoots.add(node));
    if (prepend) {
      this.chat.messagesContainer.prepend(frag);
    } else {
      this.chat.messagesContainer.appendChild(frag);
    }
    addedRoots.forEach((root) => {
      if (!Array.isArray(root?._groupMessages) || root._groupMessages.length < 2) return;
      this.chat._registerGroup(root);
      const reactions = this.chat._computeAggregatedReactions(String(root.dataset.messageIds || '').split(',').filter(Boolean));
      this.chat._renderGroupReactions(root, reactions);
    });
    // Remember the exact pane position after the first alignment.  Grouping
    // below can change the height a moment later, but it must not override a
    // reader who started scrolling up in the meantime.
    let bottomTop = null;
    if (stickToBottom) {
      this.chat.scrollToBottom();
      bottomTop = this.chat.messageArea?.scrollTop ?? null;
    }
    if (this.chat._pendingReactions.size) {
      let applied = 0;
      for (const [mid, rx] of this.chat._pendingReactions) {
        const candidate = document.getElementById(`message-${mid}`);
        if (candidate && this.chat.messagesContainer?.contains(candidate)) {
          try {
            this.chat.patchMessageDOM({
              id: mid,
              reactions: rx
            });
            applied++;
          } catch (e) {
            this.chat._logRx('renderMessagesBatch: patch failed', e);
          }
          this.chat._pendingReactions.delete(mid);
        }
      }
    }
    if (this.chat._groupingTimeout) {
      clearTimeout(this.chat._groupingTimeout);
    }
    this.chat._groupingTimeout = this.chat.lifetime.timeout(async () => {
      if (!this.chat._isActiveInstance()) return;
      const mediaRoots = Array.from(this.chat._pendingMediaRoots);
      this.chat._pendingMediaRoots.clear();
      this.chat.normalizeMediaGroups();
      this.chat.normalizeFileGroups();
      this.chat.rebuildDateSeparators();
      // Only newly added message roots need layout/spinner/lazy observer work.
      // A full conversation scan here made each older page slower than the
      // previous one and competed with the next pagination request.
      mediaRoots.forEach(root => {
        if (root?.isConnected) this.chat.observeNewMedia(root);
      });
      // The caller chose to follow the bottom before this batch arrived.
      // Honor it only if the reader has not moved the pane after the first
      // alignment. A wide "near bottom" threshold here used to pull people
      // back down while they were starting to read older messages.
      const area = this.chat.messageArea;
      if (stickToBottom && area?.isConnected && bottomTop !== null
        && Math.abs(area.scrollTop - bottomTop) <= 2) {
        this.chat.scrollToBottomAfterImagesLoad();
      }
      try {
        if (!this.chat._rxHydratedOnce && this.chat._isActiveInstance()) this.chat._scheduleReactionsHydration();
      } catch {}
    }, 300);
    return addedCount;
  }
}
