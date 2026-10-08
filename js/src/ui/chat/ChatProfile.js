import { originalAvatar, chatAvatar, setHeaderAvatar } from '../avatar.js?v=20261003-avatar-cache-r15';
import { formatHmStockholm } from '../../core/utils.js';
import { getProvider, getFeatureAvailability } from '../../domain/providers.js';

/** Chat identity, connected account identity and capability presentation. */
export class ChatProfile {
  constructor(chat) { this.chat = chat; }

  async _loadChatDetailsIntoHeader() {
    if (!this.chat.chatDbId || !this.chat._isActiveInstance()) return;
    try {
      // Details are useful for the avatar and final title, but must never
      // delay the first page of message text.
      const r = await this.chat.api.getChatDetails(this.chat.chatDbId);
      if (!this.chat._isActiveInstance() || !r?.success) return;
      const chat = r.chat || {};
      this.chat._isSavedMessagesChat = chat.item_context?.telegram_saved_messages === true;
      const avatarEl = document.getElementById('chat-avatar');
      const titleEl = document.getElementById('chat-title');
      const itemTitle = chat.item_context ? chat.item_context.title : null;
      const isGenericTelegramName = getProvider(this.chat.source || '').id === 'telegram'
        && /^telegram\s+\d+$/i.test(String(chat.name || '').trim());
      const avatar = this.chat._safeRemoteUrl(chatAvatar({ ...chat, source: this.chat.source, chat_id: this.chat.chatId }));
      if (avatarEl) {
        if (avatar) {
          setHeaderAvatar(avatarEl, avatar, () => this.chat._fallbackAvatarUrl(chat.name || this.chat.chatTitle || 'Чат'));
        } else if (avatarEl.dataset.fallback !== '0' && !['telegram', 'whatsapp'].includes(getProvider(this.chat.source || '').id)) {
          avatarEl.src = this.chat._fallbackAvatarUrl(isGenericTelegramName ? 'Telegram' : (chat.name || this.chat.chatTitle || 'Чат'));
          avatarEl.dataset.fallback = '1';
        }
      }
      if (titleEl && !isGenericTelegramName) {
        titleEl.replaceChildren(document.createTextNode(String(chat.name || this.chat.chatTitle || 'Чат')));
        if (itemTitle) {
          const item = document.createElement('small');
          item.className = 'text-muted fw-normal';
          item.style.fontSize = '.7em';
          item.textContent = String(itemTitle);
          titleEl.append(document.createElement('br'), item);
        }
      }
      if (!isGenericTelegramName) document.title = `Чат - ${String(chat.name || this.chat.chatTitle || 'Чат')}`;
      await Promise.allSettled([this.chat._primeTelegramContactHeaderIdentity(), this.chat._primeWhatsAppContactAvatar()]);
    } catch (e) {
      if (this.chat._isActiveInstance()) {
        console.warn('Failed to load supplementary chat details:', e);
        // Details and avatar use separate read-only provider routes. A slow
        // chat-details request must not prevent the avatar route from running.
        void Promise.allSettled([
          this.chat._primeTelegramContactHeaderIdentity(),
          this.chat._primeWhatsAppContactAvatar(),
        ]);
      }
    } finally {
      if (this.chat._isActiveInstance()) {
        const avatar = document.getElementById('chat-avatar');
        if (avatar?.classList.contains('avatar-pending')) {
          avatar.classList.remove('avatar-pending');
          // A first avatar request can finish while a slower profile request
          // is still pending. Never replace that decoded photo with initials
          // merely because the opening state had no avatar URL.
          // A details timeout must not replace a photo that another provider
          // request is still loading. The opening shell already has a safe
          // fallback; changing src here caused a visible photo -> initials ->
          // photo flicker when the slower profile request completed later.
          const visibleSource = originalAvatar(avatar.currentSrc || avatar.getAttribute('src'));
          if (!visibleSource && avatar.dataset.fallback !== '1') {
            avatar.src = this.chat._fallbackAvatarUrl(this.chat.chatTitle || 'Чат');
            avatar.dataset.fallback = '1';
          }
        }
      }
    }
  }

  async _primeTelegramContactHeaderIdentity() {
    if (getProvider(this.chat.source || '').id !== 'telegram'
      || !this.chat.chatId || typeof this.chat.api?.getContactProfile !== 'function' || !this.chat._isActiveInstance()) return;
    try {
      const response = await this.chat.api.getContactProfile(this.chat.source, this.chat.chatId, this.chat.chatDbId, { refresh: true });
      if (!this.chat._isActiveInstance()) return;
      const profile = response?.profile || {};
      const usernameField = Array.isArray(profile.fields)
        ? profile.fields.find((field) => /имя пользователя|username/i.test(String(field?.label || '')))?.value
        : '';
      const name = String(profile.name || profile.username || usernameField || '').trim();
      if (!name) return;
      this.chat._telegramContactReactionActor = {
        id: String(this.chat.chatId || ''),
        username: String(profile.username || usernameField || ''),
        name,
        initials: name.replace(/^@/, '').slice(0, 2).toUpperCase(),
        avatar: this.chat._safeRemoteUrl(originalAvatar(profile.avatar, profile.avatar_url)),
        avatarAvailable: Boolean(this.chat._safeRemoteUrl(originalAvatar(profile.avatar, profile.avatar_url))),
      };
      const titleEl = document.getElementById('chat-title');
      if (titleEl && !this.chat._isSavedMessagesChat) titleEl.textContent = name;
      const avatarEl = document.getElementById('chat-avatar');
      const profileAvatar = this.chat._safeRemoteUrl(originalAvatar(profile.avatar, profile.avatar_url));
      if (avatarEl && profileAvatar) {
        // This is the deliberate provider profile refresh, so it is allowed
        // to replace a cached header photo when the person changed it.
        setHeaderAvatar(avatarEl, profileAvatar, () => this.chat._fallbackAvatarUrl(name), { replace: true });
      } else if (avatarEl && (avatarEl.dataset.fallback === '1'
        || !avatarEl.getAttribute('src')
        || /^data:image\/svg\+xml,/i.test(String(avatarEl.getAttribute('src') || '')))) {
        // The old fallback was made from a generic `Telegram <id>` title.
        // Regenerate it from the same preferred identity as the header.
        avatarEl.src = this.chat._fallbackAvatarUrl(name);
        avatarEl.dataset.fallback = '1';
      }
      if (!this.chat._isSavedMessagesChat) document.title = `Чат - ${name}`;
      this.chat._applyTelegramContactReactionIdentity();
    } catch {
      // The saved identity remains a valid fallback when Telegram is busy.
    }
  }

  async _loadProviderCapabilities() {
    try {
      const response = await this.chat.api.getProviderCapabilities(this.chat.source);
      if (!this.chat._isActiveInstance()) return;
      const provider = response?.provider;
      if (provider?.features && typeof provider.features === 'object') {
        this.chat.providerCapabilities = provider.features;
      }
    } catch (error) {
      if (!this.chat._isActiveInstance()) return;
      // Static defaults in domain/providers.js keep the interface usable
      // during an API outage.
      this.chat.providerCapabilities = null;
    }
  }

  _renderProviderBadge() {
    const badge = document.getElementById('chat-provider-badge');
    if (!badge) return;
    const provider = this.chat.provider || getProvider(this.chat.source);
    const knownTones = new Set(['telegram', 'whatsapp', 'vk', 'avito', 'unknown']);
    const tone = knownTones.has(provider.tone) ? provider.tone : 'unknown';
    const icon = /^[a-z0-9-]+$/i.test(provider.icon || '') ? provider.icon : 'bi-chat-square-text';
    badge.className = `chat-provider-badge is-${tone}`;
    badge.replaceChildren();
    const iconEl = document.createElement('i');
    iconEl.className = `bi ${icon}`;
    iconEl.setAttribute('aria-hidden', 'true');
    const nameEl = document.createElement('span');
    nameEl.textContent = String(provider.name || this.chat.source || 'Сервис');
    badge.append(iconEl, nameEl);
    badge.hidden = false;
  }

  _applyCapabilityVisibility() {
    const presence = getFeatureAvailability(this.chat.source, 'presence', null, this.chat.providerCapabilities);
    for (const element of [
      document.getElementById('presence-dot'),
      document.getElementById('presence-label'),
      document.getElementById('chat-presence'),
    ]) {
      if (element) element.hidden = !presence.enabled;
    }
  }

  _applyPresenceHeader({ state, until, last }) {
    const dot = document.getElementById('presence-dot');
    const label = document.getElementById('presence-label');
    const pres = document.getElementById('chat-presence');
    if (!dot || !label || !pres) return;

    // Clear any existing timer that was supposed to revert the status
    this.chat.lifetime.clearTimeout(this.chat._presenceTimer);

    // --- TYPING STATE LOGIC ---
    if (state === 'typing') {
        dot.className = 'presence-dot typing'; // Set typing class
        label.textContent = 'в сети';
        pres.textContent = 'печатает…';

        // Set a timer to revert to the last known non-typing status when done
        const delay = Math.max(0, ((until | 0) * 1000) - Date.now());
        this.chat._presenceTimer = this.chat.lifetime.timeout(() => {
            // When typing expires, re-apply the last saved "normal" status
            this.chat._applyPresenceHeader(this.chat._lastPresence);
        }, delay + 100); // Small buffer
        return; // IMPORTANT: Exit the function here for typing events
    }

    // --- "NORMAL" STATE LOGIC (Not typing) ---
    // If we've reached here, it's a normal status update, so we save it.
    this.chat._lastPresence = { state, until: until | 0, last: last | 0 };

    let shortText = '';
    let lineText = '';
    dot.className = 'presence-dot'; // Reset to base class first

    switch (state) {
        case 'online':
            dot.classList.add('online');
            shortText = 'в сети';
            if (until) {
                const delay = Math.max(0, ((until | 0) * 1000) - Date.now());
                this.chat._presenceTimer = this.chat.lifetime.timeout(() => {
                    this.chat._applyPresenceHeader({ state: 'offline', last: until });
                }, delay + 50);
            }
            break;
        case 'offline':
            dot.classList.add('offline');
            shortText = 'не в сети';
            lineText = last ? `был(а) в ${formatHmStockholm(last)}` : '';
            break;
        case 'recently':
            dot.classList.add('away');
            shortText = 'недавно';
            break;
        case 'last_week':
            dot.classList.add('away');
            shortText = 'на этой неделе';
            break;
        case 'last_month':
            dot.classList.add('away');
            shortText = 'в прошлом месяце';
            break;
        default: // 'hidden' or unknown
            dot.classList.add('hidden');
            shortText = 'статус скрыт';
            break;
    }

    label.textContent = shortText;
    pres.textContent = lineText;
}

  _getSource() {
    return (this.chat.source || '').toLowerCase();
  }
}
