import { originalAvatar, setHeaderAvatar } from '../avatar.js?v=20261003-avatar-cache-r15';
import { cacheAvatar, forgetCachedAvatar, readCachedAvatar } from '../avatarCache.js?v=20261003-avatar-cache-r15';
import { getProvider } from '../../domain/providers.js';

/** Reaction participant identity, avatar cache and bounded avatar hydration. */
export class ReactionActors {
  constructor(chat) { this.chat = chat; }

  async _primeWhatsAppReactionAvatar() {
    if (getProvider(this.chat.source || '').id !== 'whatsapp' || typeof this.chat.api?.getWhatsAppSelfAvatar !== 'function') return;
    const cacheKey = 'unified:whatsapp:self-reaction-avatar:v1';
    try {
      const cached = sessionStorage.getItem(cacheKey) || '';
      const cachedUrl = this.chat._safeRemoteUrl(originalAvatar(cached));
      if (cachedUrl) {
        this.chat._ownWhatsAppReactionAvatar = cachedUrl;
        this.chat._paintWhatsAppReactionAvatars();
        return;
      }
    } catch {}
    try {
      // The common self-profile endpoint performs one WPP read and carries
      // the normalized avatar. Keep the legacy endpoint as a bridge fallback.
      let response = null;
      if (typeof this.chat.api?.getProviderSelfProfile === 'function') {
        response = await this.chat.api.getProviderSelfProfile(this.chat.source);
      }
      let avatar = this.chat._safeRemoteUrl(originalAvatar(response?.profile?.avatar, response?.avatar));
      if (!avatar) {
        response = await this.chat.api.getWhatsAppSelfAvatar();
        avatar = this.chat._safeRemoteUrl(originalAvatar(response?.avatar));
      }
      if (!avatar || !this.chat._isActiveInstance()) return;
      this.chat._ownWhatsAppReactionAvatar = avatar;
      try { sessionStorage.setItem(cacheKey, avatar); } catch {}
      this.chat._paintWhatsAppReactionAvatars();
    } catch {
      // The placeholder actor retains final dimensions if WPP is temporarily busy.
    }
  }

  _isDirectWhatsAppChat() {
    return getProvider(this.chat.source || '').id === 'whatsapp'
      && !/@g\.us$/i.test(String(this.chat.chatId || ''));
  }

  _replaceReactionAvatarSlots(selector, avatar) {
    const safeAvatar = this.chat._safeRemoteUrl(originalAvatar(avatar));
    if (!safeAvatar || !this.chat.messagesContainer) return;
    this.chat.messagesContainer.querySelectorAll(selector).forEach((slot) => {
      const image = document.createElement('img');
      image.className = 'rx-ava';
      image.dataset.rxActorKey = String(slot.dataset.rxActorKey || '');
      image.dataset.rxInitials = String(slot.textContent || '').trim().slice(0, 2) || 'Я';
      image.src = safeAvatar;
      image.alt = '';
      slot.replaceWith(image);
    });
  }

  _paintWhatsAppReactionAvatars() {
    const ownAvatar = this.chat._safeRemoteUrl(originalAvatar(this.chat._ownWhatsAppReactionAvatar));
    // A history refresh can finish after the own-profile request.  Older
    // markup did not contain an actor at all for a WPP `me` reaction, leaving
    // nowhere to paint the real photograph.  Keep a visible initials slot in
    // every such pill; it is replaced below only when a real avatar exists.
    if (ownAvatar && this.chat.messagesContainer) {
      this.chat.messagesContainer.querySelectorAll('.rx-item--mine').forEach((item) => {
        let slots = Array.from(item.querySelectorAll('.rx-ava'));
        if (!slots.length) {
          const actors = document.createElement('span');
          actors.className = 'rx-actors';
          const slot = document.createElement('span');
          slot.className = 'rx-ava rx-ava--self';
          slot.dataset.rxActorKey = this.chat._reactionActorKey({ id: 'me', initials: 'Я' });
          slot.textContent = 'Я';
          slot.setAttribute('aria-label', 'Ваша реакция');
          actors.append(slot);
          item.append(actors);
          slots = [slot];
        }
        // WPP sometimes gives the current account an opaque actor id.  In a
        // one-person own reaction that sole slot is unambiguously ours, even
        // though it is not literally called `me` in the history payload.
        const namedOwnSlots = slots.filter((slot) => /:(?:me|self)$/i.test(String(slot.dataset.rxActorKey || '')));
        const ownSlots = namedOwnSlots.length ? namedOwnSlots : (slots.length === 1 ? slots : []);
        ownSlots.forEach((slot) => {
          if (slot instanceof HTMLImageElement && slot.getAttribute('src') === ownAvatar) return;
          const image = document.createElement('img');
          image.className = 'rx-ava';
          image.dataset.rxActorKey = String(slot.dataset.rxActorKey || this.chat._reactionActorKey({ id: 'me' }));
          image.dataset.rxInitials = String(slot.dataset.rxInitials || slot.textContent || 'Я').trim().slice(0, 2) || 'Я';
          image.src = ownAvatar;
          image.alt = '';
          slot.replaceWith(image);
        });
      });
    }
    this.chat._replaceReactionAvatarSlots(
      '.rx-item--mine .rx-ava--ph, .rx-item--mine .rx-ava--self',
      this.chat._ownWhatsAppReactionAvatar
    );
    // In a private chat every non-own actor is the person in the header. Do
    // not make this substitution in groups, where reactions need the actual
    // participant data from WhatsApp.
    if (this.chat._isDirectWhatsAppChat()) {
      this.chat._replaceReactionAvatarSlots(
        '.rx-item:not(.rx-item--mine) .rx-ava--ph',
        this.chat._whatsAppContactReactionAvatar
      );
    }
  }

  _reactionActorsForRender(reaction) {
    let actors = Array.isArray(reaction?.actors) ? reaction.actors.slice(0, 3) : [];
    const ownAvatar = this.chat._safeRemoteUrl(this.chat._ownWhatsAppReactionAvatar);
    const providerId = getProvider(this.chat.source || '').id;
    if (providerId === 'telegram' && reaction?.me !== true && this.chat._telegramContactReactionActor) {
      const contact = this.chat._telegramContactReactionActor;
      actors = actors.map((actor) => {
        const isContact = String(actor?.id || '') === String(this.chat.chatId || '');
        const hasIdentity = String(actor?.username || actor?.name || actor?.initials || '').trim() !== '';
        return isContact && !hasIdentity
          ? { ...actor, ...contact, avatar: this.chat._safeRemoteUrl(originalAvatar(actor?.avatar, actor?.avatar_url)) || contact.avatar || '' }
          : actor;
      });
    }
    if (['telegram', 'max'].includes(providerId) && reaction?.me === true && this.chat._ownReactionActor) {
      const own = this.chat._ownReactionActor;
      // Provider payloads use both the numeric account id and the sentinel
      // ids `me`/`self`. Treat them as one actor; otherwise profile hydration
      // appends the same person a second time and the reaction pill shows one
      // real avatar plus a duplicate initials fallback.
      const isOwn = (actor) => {
        const id = String(actor?.id || '').toLowerCase();
        return id === 'me' || id === 'self' || id === String(own.id || '').toLowerCase();
      };
      let foundOwn = false;
      actors = actors.map((actor) => {
        if (!isOwn(actor)) return actor;
        if (foundOwn) return null;
        foundOwn = true;
        return { ...actor, ...own, avatar: originalAvatar(own.avatar, actor.avatar) };
      }).filter(Boolean);
      if (!foundOwn) actors.push(own);
      return actors.slice(0, 3);
    }
    if (providerId !== 'whatsapp') return actors;
    // History rows can carry boolean, integer or string ACK-style flags.
    // Rendering already treats every truthy value as own; actor hydration must
    // use the same rule or an own reaction loses its avatar slot after reload.
    // This must exactly match the renderer's `r.me ? …` condition.  WPP
    // snapshots have used several truthy representations over time; a narrow
    // comparison made the pill look like ours while dropping its actor slot.
    const isMine = Boolean(reaction?.me);
    if (!isMine) {
      const contactAvatar = this.chat._safeRemoteUrl(this.chat._whatsAppContactReactionAvatar);
      if (!this.chat._isDirectWhatsAppChat() || !contactAvatar) return actors;
      if (!actors.length && Number(reaction?.count || 0) > 0) {
        return [{ id: String(this.chat.chatId || 'contact'), avatar: contactAvatar }];
      }
      return actors.map((actor) => actor?.avatar ? actor : { ...actor, avatar: contactAvatar });
    }
    // WPP often reports only `me: true` and omits the actor object.  Render
    // one stable slot immediately, so the async self-profile result can
    // replace it with the real photo instead of having no DOM node to paint.
    const isOwnActor = (actor) => ['me', 'self'].includes(String(actor?.id || '').toLowerCase())
      || actor?.me === true
      || (reaction?.me === true && actors.length === 1);
    if (!actors.some(isOwnActor)) {
      actors.push({ id: 'me', initials: 'Я' });
    }
    if (!ownAvatar) return actors.slice(0, 3);
    // WPP alternates between `me` and the account's opaque participant id.
    // When this is the only actor of our own one-person reaction, it is still
    // us and must receive the already known self photograph.
    let foundOwn = false;
    actors = actors.map((actor) => {
      if (!isOwnActor(actor)) return actor;
      foundOwn = true;
      return { ...actor, avatar: ownAvatar };
    });
    if (!foundOwn) actors.push({ id: 'me', avatar: ownAvatar });
    return actors.slice(0, 3);
  }

  _reactionActorKey(actor, index = 0) {
    const provider = String(getProvider(this.chat.source || '').id || 'unknown');
    const account = String(this.chat._outgoingAccountKey || this.chat._operationAccountKeyFromConfig?.() || 'unbound');
    const id = String(actor?.id || actor?.name || actor?.initials || `unknown-${index}`).slice(0, 160);
    return `${provider}:${account}:${id}`;
  }

  _reactionAvatarMarkup(actor, index = 0) {
    this.chat._reactionAvatarFailures ??= new Map();
    const key = this.chat._reactionActorKey(actor, index);
    const failedUntil = Number(this.chat._reactionAvatarFailures.get(key) || 0);
    // A relay URL may be reissued on every history/reaction snapshot. Keep
    // the browser-tab copy for this exact provider actor until it fails.
    const suppliedAvatar = this.chat._safeRemoteUrl(originalAvatar(actor?.avatar, actor?.avatar_url));
    const cachedAvatar = readCachedAvatar('reaction-actor', key)?.avatar || '';
    const avatar = failedUntil > Date.now() ? '' : (cachedAvatar || suppliedAvatar);
    if (suppliedAvatar && !cachedAvatar) cacheAvatar('reaction-actor', key, suppliedAvatar);
    const named = String(actor?.name || actor?.username || actor?.initials || '').trim();
    // A provider ID identifies data, never a person. Use a neutral fallback
    // until a name or avatar is available instead of showing the last digits.
    const initials = (named.startsWith('@') ? named.slice(1) : named).slice(0, 2).toUpperCase() || '?';
    if (!avatar && (!named || /^[?•\s]+$/.test(named))) return '';
    const safeKey = this.chat._escapeHtml(key);
    if (avatar) {
      return `<img class="rx-ava" data-rx-actor-key="${safeKey}" data-rx-initials="${this.chat._escapeHtml(initials)}" src="${this.chat._escapeHtml(avatar)}" alt="">`;
    }
    return `<span class="rx-ava rx-ava--self" data-rx-actor-key="${safeKey}" aria-label="Участник реакции">${this.chat._escapeHtml(initials)}</span>`;
  }

  _handleReactionAvatarError(event) {
    const image = event.target instanceof HTMLImageElement && event.target.matches('img.rx-ava[data-rx-actor-key]')
      ? event.target : null;
    if (!image) return;
    const key = String(image.dataset.rxActorKey || '');
    if (key) {
      this.chat._reactionAvatarFailures ??= new Map();
      // A relay error should not retry on every unrelated reaction redraw.
      this.chat._reactionAvatarFailures.set(key, Date.now() + 5 * 60 * 1000);
      forgetCachedAvatar('reaction-actor', key, image.currentSrc || image.getAttribute('src'));
    }
    if (!image.dataset.rxInitials || image.dataset.rxInitials === '?') {
      const holder = image.parentElement;
      image.remove();
      if (holder?.classList.contains('rx-actors') && !holder.children.length) holder.remove();
      return;
    }
    const fallback = document.createElement('span');
    fallback.className = 'rx-ava rx-ava--self';
    fallback.dataset.rxActorKey = key;
    fallback.textContent = String(image.dataset.rxInitials || '?').slice(0, 2);
    fallback.setAttribute('aria-label', 'Участник реакции');
    image.replaceWith(fallback);
  }

  async _primeWhatsAppContactAvatar() {
    if (getProvider(this.chat.source || '').id !== 'whatsapp' || !this.chat.chatId || typeof this.chat.api?.getContactProfile !== 'function') return;
    const cacheKey = `unified:whatsapp:contact-avatar:v1:${this.chat.chatId}`;
    const apply = (value, { replaceHeader = false } = {}) => {
      const avatar = this.chat._safeRemoteUrl(originalAvatar(value));
      if (avatar) {
        this.chat._whatsAppContactReactionAvatar = avatar;
        this.chat._paintWhatsAppReactionAvatars();
      }
      const avatarEl = document.getElementById('chat-avatar');
      if (avatar && avatarEl && this.chat._isActiveInstance()) {
        setHeaderAvatar(avatarEl, avatar, () => this.chat._fallbackAvatarUrl(this.chat.chatTitle || 'Чат'), { replace: replaceHeader });
      }
      const listAvatar = document.querySelector(`#chat-item-${CSS.escape(String(this.chat.chatDbId || ''))} img.chat-avatar`);
      if (avatar && listAvatar) {
        listAvatar.src = avatar;
        listAvatar.onerror = () => {
          listAvatar.onerror = null;
          listAvatar.src = listAvatar.dataset.fallback || this.chat._fallbackAvatarUrl(this.chat.chatTitle || 'Чат');
        };
      }
      return avatar;
    };
    try {
      const cached = apply(sessionStorage.getItem(cacheKey) || '');
      if (cached) return;
    } catch {}
    try {
      const response = await this.chat.api.getContactProfile(this.chat.source, this.chat.chatId, this.chat.chatDbId, { refresh: true });
      if (!this.chat._isActiveInstance()) return;
      const avatar = apply(response?.profile?.avatar || '', { replaceHeader: true });
      if (avatar) {
        try { sessionStorage.setItem(cacheKey, avatar); } catch {}
      }
    } catch {
      // The saved chat avatar or initials remain usable while WPP is busy.
    }
  }

  _combineReactionsWithActors(reactions, recent_reactions = []) {
    const map = new Map();
    reactions.forEach(({
      emoji,
      count,
      actors,
      me = false
    }) => {
      const cur = map.get(emoji) || {
        count: 0,
        actors: []
      };
      cur.count += count;
      cur.me = Boolean(cur.me || me);
      if (Array.isArray(actors)) {
        for (const a of actors) {
          if (cur.actors.length >= 3) break;
          cur.actors.push(a);
        }
      }
      map.set(emoji, cur);
    });

    if (recent_reactions.length) {
      for (const rr of recent_reactions) {
        const emoji = rr?.reaction?.emoticon || rr?.reaction?.emoji || rr?.emoji;
        if (!emoji) continue;
        const cur = map.get(emoji) || {
          count: 0,
          actors: []
        };
        const id = rr?.peer_id || rr?.user_id || rr?.from_id || rr?.peerId || rr?.userId;
        const avatar = rr?.avatar || rr?.photo || rr?.image || rr?.avatarUrl;
        if (id && avatar && cur.actors.length < 3 && !cur.actors.find(a => String(a.id) === String(id))) {
          cur.actors.push({
            id,
            avatar
          });
          map.set(emoji, cur);
        }
      }
    }

    return Array.from(map, ([emoji, v]) => ({
      emoji,
      count: v.count,
      me: Boolean(v.me),
      actors: v.actors
    })).filter(x => x.count > 0);
  }

  _queueTelegramReactionActorAvatars(messageId, reactions) {
    if (getProvider(this.chat.source || '').id !== 'telegram'
      || typeof this.chat.api?.getReactionActorAvatar !== 'function') return;
    this.chat._reactionActorAvatarJobs ??= new Map();
    this.chat._reactionActorAvatarQueue ??= [];
    this.chat._reactionActorAvatarActive ??= 0;
    this.chat._reactionActorAvatarRefreshes ??= 0;
    const now = Date.now();
    for (const reaction of Array.isArray(reactions) ? reactions : []) {
      for (const actor of Array.isArray(reaction?.actors) ? reaction.actors : []) {
        const actorId = String(actor?.id || '');
        if (!/^-?[1-9][0-9]{0,18}$/.test(actorId)) continue;
        const key = this.chat._reactionActorKey(actor);
        const avatar = this.chat._safeRemoteUrl(originalAvatar(actor?.avatar, actor?.avatar_url));
        const refresh = Boolean(avatar) && this.chat._reactionActorAvatarRefreshDue(key, now);
        // A cold history can contain many different people. Existing images
        // stay usable while at most eight stale entries are refreshed during
        // this chat lifetime; the two-worker queue remains the hard limit.
        if (avatar && (!refresh || this.chat._reactionActorAvatarRefreshes >= 8)) continue;
        const job = this.chat._reactionActorAvatarJobs.get(key);
        if (job?.state === 'pending') {
          job.messageIds?.add?.(String(messageId));
          continue;
        }
        if (job?.state === 'ready' || Number(job?.retryAt || 0) > now) continue;
        if (refresh) this.chat._reactionActorAvatarRefreshes += 1;
        this.chat._reactionActorAvatarJobs.set(key, { state: 'pending', actorId, refresh, messageIds: new Set([String(messageId)]) });
        this.chat._reactionActorAvatarQueue.push(key);
      }
    }
    this.chat._drainTelegramReactionActorAvatarQueue();
  }

  _reactionActorAvatarRefreshDue(key, now = Date.now()) {
    const ttl = 24 * 60 * 60 * 1000;
    this.chat._reactionActorAvatarRefreshAt ??= new Map();
    let previous = Number(this.chat._reactionActorAvatarRefreshAt.get(key) || 0);
    if (!previous) {
      try {
        const stored = JSON.parse(localStorage.getItem('unifiedMessenger.reactionAvatarRefresh.v1') || '{}');
        previous = Number(stored?.[key] || 0);
      } catch {}
    }
    if (previous && now - previous < ttl) return false;
    this.chat._reactionActorAvatarRefreshAt.set(key, now);
    try {
      const stored = JSON.parse(localStorage.getItem('unifiedMessenger.reactionAvatarRefresh.v1') || '{}') || {};
      stored[key] = now;
      const entries = Object.entries(stored).sort((a, b) => Number(b[1]) - Number(a[1])).slice(0, 120);
      localStorage.setItem('unifiedMessenger.reactionAvatarRefresh.v1', JSON.stringify(Object.fromEntries(entries)));
    } catch {}
    return true;
  }

  _drainTelegramReactionActorAvatarQueue() {
    if (!this.chat._isActiveInstance?.()) return;
    this.chat._reactionActorAvatarQueue ??= [];
    this.chat._reactionActorAvatarJobs ??= new Map();
    this.chat._reactionActorAvatarActive ??= 0;
    while (this.chat._reactionActorAvatarActive < 2 && this.chat._reactionActorAvatarQueue.length) {
      const key = this.chat._reactionActorAvatarQueue.shift();
      const job = this.chat._reactionActorAvatarJobs.get(key);
      if (!job || job.state !== 'pending') continue;
      this.chat._reactionActorAvatarActive += 1;
      Promise.resolve(this.chat.api.getReactionActorAvatar(this.chat.source, this.chat.chatId, this.chat.chatDbId, job.actorId, 20000, job.refresh === true))
        .then((response) => {
          const avatar = this.chat._safeRemoteUrl(response?.avatar);
          if (!avatar || !this.chat._isActiveInstance()) {
            this.chat._reactionActorAvatarJobs.set(key, { ...job, state: 'missing', retryAt: Date.now() + 5 * 60 * 1000 });
            return;
          }
          this.chat._reactionActorAvatarJobs.set(key, { ...job, state: 'ready', avatar });
          for (const [messageId, list] of this.chat._rxByMessageId || []) {
            let changed = false;
            const next = (Array.isArray(list) ? list : []).map((reaction) => ({
              ...reaction,
              actors: (reaction.actors || []).map((actor) => {
                if (this.chat._reactionActorKey(actor) !== key) return actor;
                changed = true;
                return { ...actor, avatar, avatarAvailable: true };
              }),
            }));
            if (!changed) continue;
            this.chat._rxByMessageId.set(messageId, next);
            this.chat.patchMessageDOM({ id: String(messageId), reactions: next });
          }
        })
        .catch(() => {
          this.chat._reactionActorAvatarJobs.set(key, { ...job, state: 'missing', retryAt: Date.now() + 5 * 60 * 1000 });
        })
        .finally(() => {
          this.chat._reactionActorAvatarActive = Math.max(0, Number(this.chat._reactionActorAvatarActive || 1) - 1);
          this.chat._drainTelegramReactionActorAvatarQueue();
        });
    }
  }

  _applyOwnReactionActorProfile() {
    const own = this.chat._ownReactionActor;
    if (!own?.id) return;
    for (const [messageId, reactions] of this.chat._rxByMessageId || []) {
      let changed = false;
      const next = (Array.isArray(reactions) ? reactions : []).map((reaction) => {
        if (reaction?.me !== true) return reaction;
        const actors = Array.isArray(reaction.actors) ? reaction.actors : [];
        const isOwn = (actor) => {
          const id = String(actor?.id || '').toLowerCase();
          return id === 'me' || id === 'self' || id === String(own.id).toLowerCase();
        };
        let foundOwn = false;
        const hydrated = actors.map((actor) => {
          if (!isOwn(actor)) return actor;
          if (foundOwn) { changed = true; return null; }
          foundOwn = true;
          changed = true;
          return { ...actor, ...own, avatar: own.avatar || actor.avatar || '' };
        }).filter(Boolean);
        if (!foundOwn) {
          hydrated.push(own);
          changed = true;
        }
        changed = true;
        return { ...reaction, actors: hydrated };
      });
      if (!changed) continue;
      this.chat._rxByMessageId.set(messageId, next);
      this.chat.patchMessageDOM({ id: String(messageId), reactions: next });
    }
  }

  _applyTelegramContactReactionIdentity() {
    const contact = this.chat._telegramContactReactionActor;
    if (getProvider(this.chat.source || '').id !== 'telegram' || !contact?.id) return;
    for (const [messageId, reactions] of this.chat._rxByMessageId || []) {
      let changed = false;
      const next = (Array.isArray(reactions) ? reactions : []).map((reaction) => {
        if (reaction?.me === true) return reaction;
        const actors = Array.isArray(reaction?.actors) ? reaction.actors : [];
        let reactionChanged = false;
        const hydrated = actors.map((actor) => {
          const isContact = String(actor?.id || '') === String(contact.id);
          const hasIdentity = String(actor?.username || actor?.name || actor?.initials || '').trim() !== '';
          if (!isContact || hasIdentity) return actor;
          changed = true;
          reactionChanged = true;
          return { ...actor, ...contact, avatar: this.chat._safeRemoteUrl(originalAvatar(actor?.avatar, actor?.avatar_url)) || contact.avatar || '' };
        });
        return reactionChanged ? { ...reaction, actors: hydrated } : reaction;
      });
      if (!changed) continue;
      this.chat._rxByMessageId.set(messageId, next);
      this.chat.patchMessageDOM({ id: String(messageId), reactions: next });
    }
  }
}
