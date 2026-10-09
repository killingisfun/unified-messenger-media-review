import { normalizeMessage, validateAttachmentSelection } from '../../domain/providers.js';
import { renderComposerReply } from '../components/MessageQuote.js';

/** Drafts, staged files, quotes and DOM input event bindings. */
function stabilizeAttachmentFile(file) {
  if (!file || typeof Blob === 'undefined' || !(file instanceof Blob) || typeof file.slice !== 'function') return file;
  const size = Number(file.size || 0);
  if (!Number.isFinite(size) || size <= 0) return file;
  try {
    // WebView2 can detach a File obtained from <input type=file> when the
    // input is cleared.  A sliced Blob owns the selected bytes independently
    // of that DOM element; keep the original display metadata as well.
    const stable = file.slice(0, size, file.type || 'application/octet-stream');
    try { if (file.name) Object.defineProperty(stable, 'name', { value: String(file.name), configurable: true }); } catch {}
    try { if (file.lastModified) Object.defineProperty(stable, 'lastModified', { value: Number(file.lastModified), configurable: true }); } catch {}
    return stable;
  } catch {
    return file;
  }
}

export class ChatComposer {
  constructor(chat) { this.chat = chat; }

  _sanitizeAttachmentInputs() {
    try {
      if (this.chat._clipboardFile && this.chat.attachmentInput) {
        this.chat.attachmentInput.value = '';
      }
    } catch {}
  }

  _clearAttachmentPreview() {
    for (const url of this.chat._attachmentPreviewUrls || []) {
      try { URL.revokeObjectURL(url); } catch {}
    }
    this.chat._attachmentPreviewUrls?.clear?.();
    this.chat.attachmentPreview?.replaceChildren();
  }

  _attachmentPreviewUrl(file) {
    if (!file || typeof URL?.createObjectURL !== 'function') return '';
    const url = URL.createObjectURL(file);
    this.chat._attachmentPreviewUrls ??= new Set();
    this.chat._attachmentPreviewUrls.add(url);
    return url;
  }

  _draftStorageKey() {
    const account = String(this.chat._outgoingAccountKey || this.chat._operationAccountKeyFromConfig() || '').trim();
    return `unified-composer-draft-v1:${account}:${String(this.chat.source || '').toLowerCase()}:${String(this.chat.chatId || '')}:${String(this.chat.chatDbId || '')}`;
  }

  _draftFileStore() {
    return globalThis.__unifiedComposerDraftFiles ??= new Map();
  }

  canSendFromComposer() {
    return Boolean(String(this.chat.messageInput?.value || '').trim()
      || this.chat._stagedFiles?.length
      || this.chat._clipboardFile
      || this.chat.attachmentInput?.files?.length);
  }

  saveComposerDraft() {
    if (!this.chat.source || !this.chat.chatId || !this.chat.chatDbId) return;
    const key = this.chat._draftStorageKey();
    const files = Array.from(this.chat._stagedFiles || []);
    const draft = {
      text: String(this.chat.messageInput?.value || ''),
      reply: this.chat._replyContext?.id ? { ...this.chat._replyContext } : null,
      hasFiles: files.length > 0,
      updatedAt: Date.now(),
    };
    try {
      if (!draft.text && !draft.reply && !draft.hasFiles) sessionStorage.removeItem(key);
      else sessionStorage.setItem(key, JSON.stringify(draft));
    } catch {}
    const store = this.chat._draftFileStore();
    if (files.length) store.set(key, files);
    else store.delete(key);
  }

  restoreComposerDraft() {
    const key = this.chat._draftStorageKey();
    let draft = null;
    try { draft = JSON.parse(sessionStorage.getItem(key) || 'null'); } catch {}
    if (!draft || typeof draft !== 'object') return;
    if (this.chat.messageInput && typeof draft.text === 'string') {
      this.chat.messageInput.value = draft.text;
      this.chat.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
    }
    if (draft.reply?.id) {
      this.chat._replyContext = { id: String(draft.reply.id), text: String(draft.reply.text || 'Вложение'), author: String(draft.reply.author || 'Собеседник') };
      const host = document.getElementById('composer-reply-preview');
      if (host) host.innerHTML = renderComposerReply(this.chat._replyContext);
    }
    const files = this.chat._draftFileStore().get(key);
    if (Array.isArray(files) && files.length) {
      this.chat._stagedFiles = files;
      this.chat._clipboardFile = files[0] || null;
      this.chat.showAttachmentPreview(files);
    } else if (draft.hasFiles) {
      this.chat._showFeatureNotice('Файлы из черновика нужно выбрать заново после перезагрузки страницы.');
      try { sessionStorage.setItem(key, JSON.stringify({ ...draft, hasFiles: false })); } catch {}
    }
  }

  _stageFiles(files) {
    const next = Array.from(files || []).filter(Boolean).map(stabilizeAttachmentFile);
    if (!next.length) return;
    const state = validateAttachmentSelection(this.chat.source, next, this.chat.providerCapabilities, { chat_id: this.chat.chatId });
    if (!state.enabled) {
      this.chat._showFeatureNotice(state.reason || 'Эти вложения недоступны в текущем чате.');
      return;
    }
    this.chat._stagedFiles = next;
    this.chat._clipboardFile = next[0] || null;
    if (this.chat.attachmentInput) this.chat.attachmentInput.value = '';
    this.chat.showAttachmentPreview(next);
    this.chat.saveComposerDraft();
  }

  _attachmentDialogTitle(files) {
    const images = files.filter((file) => String(file?.type || '').startsWith('image/')).length;
    if (images === files.length) return images === 1 ? 'Отправить изображение' : `Отправить ${images} изображения`;
    return files.length === 1 ? 'Отправить файл' : `Отправить ${files.length} файла`;
  }

  _supportsSendAsFile() {
    // Do not expose a switch which a provider silently ignores. The shared
    // dialog remains the same in every chat; adapters opt in only after their
    // document transport is implemented and covered by a contract.
    return ['telegram', 'max'].includes(String(this.chat.source || '').toLowerCase());
  }

  _closeAttachmentDialog({ keepDraft = true } = {}) {
    const state = this.chat._attachmentDialogState;
    if (!state) return;
    for (const url of state.urls || []) { try { URL.revokeObjectURL(url); } catch {} }
    state.root?.remove?.();
    this.chat._attachmentDialogState = null;
    if (!keepDraft && this.chat.attachmentInput) this.chat.attachmentInput.value = '';
  }

  _openAttachmentDialog(files, { append = false, captionOverride = null, asFileOverride = null } = {}) {
    const picked = Array.from(files || []).filter(Boolean).map(stabilizeAttachmentFile);
    const previous = append ? (this.chat._attachmentDialogState?.files || []) : [];
    const selected = [...previous, ...picked];
    if (!selected.length) return;
    const allowed = validateAttachmentSelection(this.chat.source, selected, this.chat.providerCapabilities, { chat_id: this.chat.chatId });
    if (!allowed.enabled) { this.chat._showFeatureNotice(allowed.reason || 'Эти вложения недоступны в текущем чате.'); return; }
    const caption = captionOverride === null
      ? (append ? String(this.chat._attachmentDialogState?.caption?.value || '') : String(this.chat.messageInput?.value || ''))
      : String(captionOverride);
    const asFile = asFileOverride === null
      ? (append ? Boolean(this.chat._attachmentDialogState?.asFile?.checked) : false)
      : Boolean(asFileOverride);
    this._closeAttachmentDialog();
    // The picked File belongs to WebView's input. The stabilized Blob above
    // owns its bytes, so resetting the picker is safe and permits reselecting
    // the same file through «Добавить».
    if (this.chat.attachmentInput) this.chat.attachmentInput.value = '';

    const root = document.createElement('section');
    root.className = 'attachment-compose-overlay';
    root.tabIndex = -1;
    root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', this._attachmentDialogTitle(selected));
    const panel = document.createElement('div'); panel.className = 'attachment-compose';
    const header = document.createElement('header'); header.className = 'attachment-compose__heading';
    const title = document.createElement('h2'); title.textContent = this._attachmentDialogTitle(selected);
    const close = document.createElement('button'); close.type = 'button'; close.className = 'attachment-compose__close'; close.setAttribute('aria-label', 'Закрыть'); close.innerHTML = '<i class="bi bi-x-lg" aria-hidden="true"></i>';
    header.append(title, close);
    const preview = document.createElement('div'); preview.className = 'attachment-compose__preview';
    const urls = new Set();
    selected.forEach((file, index) => {
      const tile = document.createElement('figure'); tile.className = 'attachment-compose__tile';
      if (String(file?.type || '').startsWith('image/') && typeof URL?.createObjectURL === 'function') {
        const image = document.createElement('img'); image.alt = file.name || `Изображение ${index + 1}`; image.decoding = 'async';
        const url = URL.createObjectURL(file); urls.add(url); image.src = url; tile.appendChild(image);
      } else {
        const icon = document.createElement('span'); icon.className = 'attachment-compose__file-icon'; icon.innerHTML = '<i class="bi bi-file-earmark" aria-hidden="true"></i>'; tile.appendChild(icon);
      }
      const name = document.createElement('figcaption'); name.textContent = file.name || 'Вложение'; tile.appendChild(name);
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'attachment-compose__remove'; remove.setAttribute('aria-label', `Убрать ${file.name || 'вложение'}`); remove.innerHTML = '<i class="bi bi-x" aria-hidden="true"></i>';
      remove.addEventListener('click', () => {
        const rest = selected.filter((_, itemIndex) => itemIndex !== index);
        // Rebuilding the modal revokes its preview URLs. Preserve the edits
        // made so far rather than quietly clearing its caption or mode.
        if (rest.length) this._openAttachmentDialog(rest, {
          captionOverride: captionInput.value,
          asFileOverride: modeInput.checked,
        });
        else this._closeAttachmentDialog({ keepDraft: false });
      });
      tile.appendChild(remove); preview.appendChild(tile);
    });
    const hasImages = selected.some((file) => String(file?.type || '').startsWith('image/'));
    const supportsSendAsFile = this._supportsSendAsFile();
    const mode = document.createElement('label'); mode.className = 'attachment-compose__mode';
    const modeInput = document.createElement('input'); modeInput.type = 'checkbox'; modeInput.checked = supportsSendAsFile && asFile; modeInput.disabled = !hasImages || !supportsSendAsFile;
    const modeText = document.createElement('span'); modeText.textContent = 'Отправить как файл';
    const modeHint = document.createElement('small');
    modeHint.textContent = !hasImages
      ? 'Для выбранного типа это уже обычный файл.'
      : (supportsSendAsFile
        ? 'Изображение сохранит исходный файл и не будет сжато.'
        : 'Этот адаптер пока не умеет надёжно выбрать режим документа.');
    mode.append(modeInput, modeText, modeHint);
    const captionField = document.createElement('label'); captionField.className = 'attachment-compose__caption';
    const captionLabel = document.createElement('span'); captionLabel.textContent = 'Подпись';
    const captionInput = document.createElement('textarea'); captionInput.rows = 2; captionInput.placeholder = 'Добавить подпись'; captionInput.value = caption;
    captionField.append(captionLabel, captionInput);
    const actions = document.createElement('footer'); actions.className = 'attachment-compose__actions';
    const add = document.createElement('button'); add.type = 'button'; add.className = 'attachment-compose__secondary'; add.textContent = 'Добавить';
    const cancel = document.createElement('button'); cancel.type = 'button'; cancel.className = 'attachment-compose__secondary'; cancel.textContent = 'Отмена';
    const send = document.createElement('button'); send.type = 'button'; send.className = 'attachment-compose__send'; send.textContent = 'Отправить';
    add.addEventListener('click', () => this.chat.attachmentInput?.click());
    const dismiss = () => this._closeAttachmentDialog({ keepDraft: false });
    cancel.addEventListener('click', dismiss); close.addEventListener('click', dismiss);
    root.addEventListener('click', (event) => { if (event.target === root) dismiss(); });
    root.addEventListener('keydown', (event) => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } });
    send.addEventListener('click', () => {
      this.chat._attachmentSendAsFile = Boolean(modeInput.checked);
      if (this.chat.messageInput) {
        this.chat.messageInput.value = captionInput.value;
        this.chat.messageInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      this._closeAttachmentDialog();
      this._stageFiles(selected);
      void this.chat.handleSendMessage();
    });
    actions.append(add, cancel, send); panel.append(header, preview, mode, captionField, actions); root.append(panel); document.body.append(root);
    this.chat._attachmentDialogState = { root, files: selected, urls, caption: captionInput, asFile: modeInput };
    requestAnimationFrame(() => captionInput.focus());
  }

  showAttachmentPreview(file) {
    try {
      if (!this.chat.attachmentPreview || !file) return;
      const files = Array.isArray(file) ? file : Array.from((typeof FileList !== 'undefined' && file instanceof FileList) ? file : [file]);
      if (!files.length) return;
      this.chat._clearAttachmentPreview();

      const tray = document.createElement('section');
      tray.className = 'attachment-staging';
      tray.setAttribute('aria-label', 'Файлы готовы к отправке');
      const previews = document.createElement('div');
      previews.className = 'attachment-staging__previews';
      const visualCount = files.filter((item) => String(item?.type || '').startsWith('image/')).length;
      files.forEach((item, index) => {
        const tile = document.createElement('span');
        tile.className = 'attachment-staging__thumb';
        if (String(item?.type || '').startsWith('image/')) {
          const image = document.createElement('img');
          image.alt = '';
          image.decoding = 'async';
          image.src = this.chat._attachmentPreviewUrl(item);
          image.addEventListener('error', () => { image.remove(); tile.classList.add('is-file'); tile.innerHTML = '<i class="bi bi-file-earmark-image" aria-hidden="true"></i>'; }, { once: true });
          tile.appendChild(image);
        } else { tile.classList.add('is-file'); tile.innerHTML = '<i class="bi bi-file-earmark" aria-hidden="true"></i>'; }
        const remove = document.createElement('button');
        remove.type = 'button'; remove.className = 'attachment-staging__remove'; remove.dataset.removeAttachment = String(index);
        remove.title = `Убрать ${item?.name || 'файл'}`; remove.setAttribute('aria-label', remove.title); remove.innerHTML = '<i class="bi bi-x" aria-hidden="true"></i>';
        tile.appendChild(remove);
        previews.appendChild(tile);
      });
      const copy = document.createElement('div'); copy.className = 'attachment-staging__copy';
      const title = document.createElement('strong'); title.textContent = visualCount === files.length ? `${files.length} фото готовы к отправке` : `${files.length} ${files.length === 1 ? 'файл' : 'файлов'} готовы к отправке`;
      const names = document.createElement('span'); names.textContent = files.slice(0, 2).map((item) => item?.name || 'Вложение').join(' · ') + (files.length > 2 ? ` · ещё ${files.length - 2}` : '');
      copy.append(title, names);
      const clear = document.createElement('button'); clear.type = 'button'; clear.className = 'attachment-staging__clear'; clear.dataset.clearAttachment = '1'; clear.setAttribute('aria-label', 'Убрать вложения'); clear.title = 'Убрать вложения'; clear.innerHTML = '<i class="bi bi-x-lg" aria-hidden="true"></i>';
      tray.append(previews, copy, clear); this.chat.attachmentPreview.appendChild(tray);
    } catch (e) { console.warn('[BaseChat] showAttachmentPreview failed', e); }
  }

  handlePaste(e) {
    try {
      const cd = e.clipboardData || window.clipboardData;
      if (!cd || !cd.items) return;
      for (const item of cd.items) {
        if (item.kind === 'file' && item.type && item.type.startsWith('image/')) {
          const file = item.getAsFile(); if (!file) continue;
          if (!file.name) { try { Object.defineProperty(file, 'name', { value: 'pasted-image.png' }); } catch {} }
          this._openAttachmentDialog([file]); e.preventDefault(); e.stopPropagation(); return;
        }
      }
    } catch (err) { console.warn('[BaseChat] handlePaste failed', err); }
  }

  ensureEmojiUI() {}

  setupEventListeners() {
    if (this.chat._listenersBound) return;
    this.chat._listenersBound = true;
    this.chat._boundMessageContainerClick = (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (!target) return;
      const senderProfile = target.closest('[data-message-sender-profile-id]');
      if (senderProfile) {
        e.preventDefault();
        document.dispatchEvent(new CustomEvent('message:sender-profile', {
          detail: {
            source: this.chat.source,
            userId: String(senderProfile.dataset.messageSenderProfileId || ''),
            name: String(senderProfile.dataset.messageSenderName || ''),
            avatar: String(senderProfile.dataset.messageSenderAvatar || ''),
          },
        }));
        return;
      }
      const clearReply = target.closest('[data-clear-reply]');
      if (clearReply) {
        this.chat.clearReplyContext();
        return;
      }
      const quote = target.closest('[data-scroll-to-message]');
      if (quote) {
        void this.chat._jumpToQuotedMessage(String(quote.dataset.scrollToMessage || ''));
        return;
      }
      const prepareRetry = target.closest('[data-prepare-rejected-retry]');
      if (prepareRetry) {
        this.chat._prepareRejectedRetry(String(prepareRetry.dataset.prepareRejectedRetry || ''));
        return;
      }
      const action = target.closest('[data-message-action]');
      if (action) {
        const messageEl = action.closest('.message');
        const message = messageEl?._originalData;
        if (!message || action.disabled) return;
        if (action.dataset.messageAction === 'reaction') {
          this.chat._openReactionPicker(action, message);
        } else if (action.dataset.messageAction === 'reply') {
          this.chat._setReplyContext(message);
        }
        return;
      }
      const singleDownloadLink = e.target.closest('a.tile-dl');
      const downloadAllButton = e.target.closest('.album-download-all, .files-download-all');
      if (singleDownloadLink) {
        e.stopPropagation();
        return;
      }
      if (downloadAllButton) {
        e.stopPropagation();
        this.chat._handleDownloadAllClick(e);
        return;
      }
    };
    this.chat.messagesContainer.addEventListener('click', this.chat._boundMessageContainerClick);
    this.chat._boundReactionAvatarError = (event) => this.chat._handleReactionAvatarError(event);
    this.chat.messagesContainer.addEventListener('error', this.chat._boundReactionAvatarError, true);
    this.chat._boundHandleSendMessage = (e) => {
      e.preventDefault();
      // The composer hands the snapshot to its queue synchronously.  Do not
      // await delivery here: a second submit must be accepted at once.
      Promise.resolve(this.chat.handleSendMessage()).catch(() => {});
    };
    this.chat._boundHandleAttachmentChange = () => {
      const files = Array.from(this.chat.attachmentInput?.files || []);
      if (files.length) this._openAttachmentDialog(files, { append: Boolean(this.chat._attachmentDialogState) });
    };
    this.chat._boundComposerDraftInput = () => this.chat.saveComposerDraft();
    this.chat._boundAttachmentPreviewClick = (event) => {
      if (!(event.target instanceof Element)) return;
      if (event.target.closest('[data-clear-attachment]') || event.target.closest('[data-remove-attachment]')) this.chat.clearAttachment(event);
    };
    this.chat._boundHandlePaste = (e) => this.chat.handlePaste(e);
    this.chat._boundComposerClick = (e) => {
      const target = e.target instanceof Element ? e.target : null;
      if (target?.closest('[data-clear-reply]')) this.chat.clearReplyContext();
    };
    this.chat._boundVisibilityChange = () => {
      this.chat.isWindowActive = !document.hidden;
      if (this.chat.isWindowActive) {
        document.title = this.chat.originalTitle;
        this.chat.fetchNewMessages().catch(() => {});
        this.chat.markReadIfVisible();
      }
    };
    this.chat._boundWindowFocus = () => {
      this.chat.isWindowActive = true;
      document.title = this.chat.originalTitle;
    };
    this.chat._boundWindowBlur = () => {
      this.chat.isWindowActive = false;
    };
    if (this.chat.messageForm) this.chat.messageForm.addEventListener('submit', this.chat._boundHandleSendMessage);
    if (this.chat.messageForm) this.chat.messageForm.addEventListener('click', this.chat._boundComposerClick);
    if (this.chat.attachmentPreview) this.chat.attachmentPreview.addEventListener('click', this.chat._boundAttachmentPreviewClick);
    if (this.chat.attachmentInput) this.chat.attachmentInput.addEventListener('change', this.chat._boundHandleAttachmentChange);
    if (this.chat.messageInput) this.chat.messageInput.addEventListener('paste', this.chat._boundHandlePaste);
    if (this.chat.messageInput) this.chat.messageInput.addEventListener('input', this.chat._boundComposerDraftInput);
    if (this.chat.messageArea) this.chat.messageArea.addEventListener('paste', this.chat._boundHandlePaste);
    document.addEventListener('visibilitychange', this.chat._boundVisibilityChange);
    window.addEventListener('focus', this.chat._boundWindowFocus);
    window.addEventListener('blur', this.chat._boundWindowBlur);
    this.chat.ensureEmojiUI();
    this.chat.restoreComposerDraft();
  }

  _showFeatureNotice(text) {
    const host = document.getElementById('chat-feature-notice');
    if (!host || !text) return;
    host.textContent = text;
    host.hidden = false;
    if (this.chat._featureNoticeTimer) this.chat.lifetime.clearTimeout(this.chat._featureNoticeTimer);
    this.chat._featureNoticeTimer = this.chat.lifetime.timeout(() => {
      host.hidden = true;
      host.textContent = '';
    }, 3500);
  }

  _setReplyContext(message) {
    const normalized = normalizeMessage(this.chat.source, message);
    if (!normalized.id) return;
    this.chat._replyContext = {
      id: normalized.id,
      text: normalized.text || 'Вложение',
      author: normalized.direction === 'out' ? 'Вы' : (message.sender_name || this.chat.chatTitle || 'Собеседник'),
    };
    const host = document.getElementById('composer-reply-preview');
    if (host) host.innerHTML = renderComposerReply(this.chat._replyContext);
    this.chat.saveComposerDraft();
    this.chat.messageInput?.focus();
  }

  clearReplyContext() {
    this.chat._replyContext = null;
    const host = document.getElementById('composer-reply-preview');
    if (host) host.innerHTML = '';
    this.chat.saveComposerDraft();
  }

  async _jumpToQuotedMessage(messageId) {
    const id = String(messageId || '');
    if (!id || this.chat._quoteJumpInFlight === id) return;
    this.chat._quoteJumpInFlight = id;
    const active = () => this.chat._isActiveInstance() && this.chat._quoteJumpInFlight === id;
    const find = () => {
      for (const node of this.chat.messagesContainer?.querySelectorAll('.message, .album-tile') || []) {
        const data = node._originalData || {};
        const ids = [node.dataset.id, data.id, data.message_id, data.native_message_id,
          ...(node.dataset.messageIds || '').split(','),
          ...(node._groupMessages || data._albumMessages || []).flatMap(m => [m.id, m.message_id])];
        if (node.id === 'message-' + id || ids.some(value => value != null && String(value) === id)) return node;
      }
      return null;
    };
    const wait = () => new Promise(resolve => setTimeout(resolve, 60));
    try {
      let target = find();
      for (let page = 0; !target && this.chat.hasMoreHistory && page < 200 && active(); page++) {
        // Wait for an existing history read and the buffered DOM commit before
        // deciding that its cursor did not move. Never race another jump.
        for (let tick = 0; this.chat.isLoadingHistory && tick < 250 && active(); tick++) await wait();
        if (!active()) return;
        const before = String(this.chat.oldestMessageId || '');
        await this.chat.fetchOlderMessages();
        for (let tick = 0; !find() && tick < 7 && active(); tick++) await wait();
        target = find();
        if (!target && before === String(this.chat.oldestMessageId || '')) break;
      }
      if (!active()) return;
      if (!target) { this.chat._showFeatureNotice('Исходное сообщение недоступно или удалено.'); return; }
      target.scrollIntoView({behavior:'smooth', block:'center'});
      target.classList.remove('is-reply-target');
      void target.offsetWidth; // Restart the highlight on repeated navigation.
      target.classList.add('is-reply-target');
    } finally { if (this.chat._quoteJumpInFlight === id) this.chat._quoteJumpInFlight = ''; }
  }

  clearAttachment(event, index = null) {
    if (event) event.preventDefault();
    const selected = Number.isInteger(index) ? index : Number(event?.target?.closest?.('[data-remove-attachment]')?.dataset?.removeAttachment);
    if (Number.isInteger(selected) && selected >= 0) {
      this.chat._stagedFiles = Array.from(this.chat._stagedFiles || []).filter((_, itemIndex) => itemIndex !== selected);
      this.chat._clipboardFile = this.chat._stagedFiles[0] || null;
      if (this.chat._stagedFiles.length) this.chat.showAttachmentPreview(this.chat._stagedFiles);
      else this.chat._clearAttachmentPreview();
    } else {
      this.chat._stagedFiles = []; this.chat._clearAttachmentPreview(); this.chat._clipboardFile = null;
    }
    if (this.chat.attachmentInput) this.chat.attachmentInput.value = '';
    this.chat._attachmentSendAsFile = false;
    this.chat.saveComposerDraft();
  }
}
