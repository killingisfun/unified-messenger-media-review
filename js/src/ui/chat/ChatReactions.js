import { getProvider, getFeatureConstraints, hasKnownReactions } from '../../domain/providers.js';
import { createReactionPicker, renderMessageActions } from '../components/MessageActions.js';
import { hasDecodedAvatarPhoto, isAvatarPhotoSource } from '../avatar.js?v=20261003-avatar-cache-r15';

/** Reaction normalization, optimistic intent, mutation and snapshot reconciliation. */
export class ChatReactions {
  constructor(chat) { this.chat = chat; }

  _setReactionMarkup(container, html) {
    if (!container) return;
    const previous = new Map();
    const previousPhotoByActor = new Map();
    container.querySelectorAll('img.rx-ava[data-rx-actor-key]').forEach((image) => {
      const key = String(image.dataset.rxActorKey || '');
      if (!key) return;
      previous.set(`${key}\u0000${image.getAttribute('src') || ''}`, image);
      if (hasDecodedAvatarPhoto(image)) previousPhotoByActor.set(key, image);
    });
    container.innerHTML = this.chat._safeRenderedHtml(html);
    // Reuse the existing image node when its actor and relay URL are unchanged.
    // This avoids re-decoding/repainting it on a count-only reaction update.
    container.querySelectorAll('.rx-ava[data-rx-actor-key]').forEach((image) => {
      const key = String(image.dataset.rxActorKey || '');
      const hasNewPhoto = image instanceof HTMLImageElement
        && isAvatarPhotoSource(image.getAttribute('src'));
      const old = previous.get(`${key}\u0000${image.getAttribute('src') || ''}`)
        || (!hasNewPhoto ? previousPhotoByActor.get(key) : null);
      if (old) image.replaceWith(old);
    });
  }

  _normalizeReactions(raw) {
    if (!raw) return [];

    // Case: Single object or "results" array from API
    if (typeof raw === 'object' && !Array.isArray(raw)) {
      if (Array.isArray(raw.reactions)) {
        raw = raw.reactions;
      } else if (raw.emoji || raw.emoticon || (raw.reaction && raw.reaction.emoticon)) {
        raw = [raw];
      } else if (raw.results) {
        const arr = raw.results.map(r => {
          const rx = r.reaction || {};
          const emoji = rx.emoticon || rx.emoji || '';
          const count = Math.max(0, Number(r.count ?? 1) || 0);
          return {
            emoji,
            count,
            me: r.me === true || r.chosen_order != null,
            actors: []
          };
        }).filter(x => x.emoji);
        const recent = Array.isArray(raw.recent_reactions) ? raw.recent_reactions : [];
        return this.chat._combineReactionsWithActors(arr, recent);
      }
    }

    // Case: Plain array of reaction objects
    if (Array.isArray(raw)) {
      const arr = raw.map(r => {
        const rx = r.reaction || r;
        const emoji = rx?.emoji || rx?.emoticon || r.emoji || r.emoticon || r.key || r.e || '';
        const count = Math.max(0, Number(r.count ?? r.total ?? r.n ?? 1) || 0);

        let actors = [];
        if (Array.isArray(r.actors)) {
          actors = r.actors.map(a => ({
            id: String(a.id ?? a.user_id ?? a.peer_id ?? ''),
            username: String(a.username ?? ''),
            name: String(a.username ?? a.name ?? a.displayName ?? ''),
            initials: String(a.initials ?? ''),
            avatar: a.avatar || a.avatarUrl || null,
            avatarAvailable: a.avatarAvailable === true
          }));
        }
        return {
          emoji,
          count,
          me: r.me === true || r.chosen_order != null,
          actors
        };
      }).filter(x => x.emoji);
      const combined = this.chat._combineReactionsWithActors(arr);
      this.chat._logRx?.('_normalizeReactions: Final combined list:', combined);
      return combined;
    }

    return [];
  }

  _onMessageReactionsUpdated(messageId, normList) {
    const id = String(messageId || '');
    if (!id) return;
    normList = this.chat._preserveReactionIntent(id, normList);
    // merge actors (сохранение предыдущих аватарок)
    const prev = this.chat._rxByMessageId.get(id) || [];
    const prevMap = new Map(prev.map(r => [(r.emoji || r.emoticon || (r.reaction && r.reaction.emoticon) || ''), r]));
    const incoming = Array.isArray(normList) ? normList : [];
    const merged = incoming.map(r => {
      const e = r.emoji || r.emoticon || (r.reaction && r.reaction.emoticon) || '';
      const hasActors = Array.isArray(r.actors) && r.actors.length > 0;
      const prevActors = prevMap.get(e)?.actors;
      const withPrevious = (!hasActors && prevActors?.length) ? { ...r,
        actors: prevActors
      } : r;
      return {
        ...withPrevious,
        actors: (withPrevious.actors || []).map((actor) => {
          const known = this.chat._reactionActorAvatarJobs?.get(this.chat._reactionActorKey(actor));
          return known?.state === 'ready' && known.avatar ? { ...actor, avatar: known.avatar, avatarAvailable: true } : actor;
        }),
      };
    });
    if (merged.length) this.chat._rxByMessageId.set(id, merged);
    else this.chat._rxByMessageId.delete(id);
    this.chat._queueTelegramReactionActorAvatars(id, merged);
    // если это часть группы — рендерим групповым флешем (один раз)
    const gk = this.chat._msgIdToGroupKey.get(id);
    if (gk) {
      this.chat._pendingGroupRx.add(gk);
      this.chat._scheduleGroupRxFlush();
    }
  }

  _computeAggregatedReactions(ids = []) {
    const acc = new Map(); // emoji => {count, actors:[]}
    const seenActorKey = (a) => String(a?.id || '') + '|' + String(a?.avatar || '');
    (ids || []).map(String).forEach(id => {
      const list = this.chat._rxByMessageId.get(id) || [];
      for (const it of list) {
        const emo = it.emoji || it.emoticon || (it.reaction && it.reaction.emoticon) || '';
        if (!emo) continue;
        const cnt = Number(it.count) || 0;
        const cur = acc.get(emo) || {
          count: 0,
          actors: [],
          _seen: new Set()
        };
        cur.count += cnt;
        cur.me = Boolean(cur.me || it.me);
        const srcActors = Array.isArray(it.actors) ? it.actors : [];
        for (const a of srcActors) {
          if (cur.actors.length >= 3) break;
          const key = seenActorKey(a);
          if (!key || cur._seen.has(key)) continue;
          cur._seen.add(key);
          cur.actors.push({
            id: String(a.id || ''),
            avatar: a.avatar || a.avatarUrl || null
          });
        }
        acc.set(emo, cur);
      }
    });
    return Array.from(acc, ([emoji, v]) => ({
      emoji,
      count: v.count,
      me: Boolean(v.me),
      actors: v.actors
    }))
      .filter(x => x.count > 0);
  }

  _registerGroup(groupEl) {
    if (!groupEl) return;
    const gk = groupEl.dataset.groupKey;
    const ids = (groupEl.dataset.messageIds || '').split(',').map(s => s.trim()).filter(Boolean);
    if (!gk || !ids.length) return;
    this.chat._groupKeyToEl.set(gk, groupEl);
    for (const id of ids) this.chat._msgIdToGroupKey.set(String(id), gk);
  }

  _flushGroupRx() {
    const keys = Array.from(this.chat._pendingGroupRx);
    this.chat._pendingGroupRx.clear();
    for (const gk of keys) {
      const el = this.chat._groupKeyToEl.get(gk);
      if (!el || !el.isConnected) continue;
      const ids = (el.dataset.messageIds || '').split(',').map(s => s.trim()).filter(Boolean);
      if (!ids.length) continue;
      const agg = this.chat._computeAggregatedReactions(ids);
      this.chat._renderGroupReactions(el, agg);
    }
  }

  _ensureGroupRxContainer(groupEl) {
    if (!groupEl) return null;
    let rx = groupEl.querySelector(':scope > .rx');
    if (!rx) {
      rx = document.createElement('div');
      rx.className = 'rx';
      const anchor = groupEl.querySelector(':scope > .album-grid, :scope > .attachments');
      const before = groupEl.querySelector(':scope > .media-actions, :scope > .meta');
      if (before) groupEl.insertBefore(rx, before);
      else if (anchor && anchor.nextSibling) anchor.parentNode.insertBefore(rx, anchor.nextSibling);
      else groupEl.appendChild(rx);
    }
    return rx;
  }

  _ensureGroupReactionButton(groupEl, originalMessage = null) {
    if (!groupEl) return null;
    const ids = String(groupEl.dataset.messageIds || '').split(',').map((id) => id.trim()).filter(Boolean);
    const fallbackId = ids[ids.length - 1] || '';
    const message = this.chat._messageForCurrentChat({
      ...(originalMessage || groupEl._originalData || {}),
      id: originalMessage?.id || groupEl._originalData?.id || fallbackId,
    });
    if (!message.id) return null;
    groupEl._originalData = message;
    groupEl.querySelector(':scope > .msg-reaction-btn')?.remove();
    const current = groupEl.querySelector(':scope > .message-actions');
    const markup = renderMessageActions(this.chat.source, message, this.chat.providerCapabilities);
    if (current) current.outerHTML = markup;
    else groupEl.insertAdjacentHTML('beforeend', markup);
    return groupEl.querySelector(':scope > .message-actions');
  }

  _updateGroupReactionsForMessage(messageId) {
    // Тихая обёртка: переводим вызовы на групповой планировщик
    const gk = this.chat._msgIdToGroupKey.get(String(messageId || ''));
    if (!gk) return;
    this.chat._pendingGroupRx.add(gk);
    this.chat._scheduleGroupRxFlush();
  }

  renderReactionsHTML(msg) {
    const raw = this.chat._preserveReactionIntent(String(msg?.id || msg?.message_id || ''), (msg && (msg.reactionsDetailed || msg.reactions)) || []);
    let norm = this.chat._normalizeReactions(raw);

    try {
      const msgId = msg && (String(msg.id || msg.message_id || ''));
      if (msgId && this.chat._rxByMessageId && this.chat._rxByMessageId.has(msgId)) {
        const cached = this.chat._rxByMessageId.get(msgId) || [];
        const cachedMap = new Map(
          cached.map(r => [(r.emoji || r.emoticon || (r.reaction && r.reaction.emoticon) || ''), r])
        );
        norm = norm.map(r => {
          const e = r.emoji || r.emoticon || (r.reaction && r.reaction.emoticon) || '';
          const hasActors = Array.isArray(r.actors) && r.actors.length > 0;
          const cachedActors = cachedMap.get(e)?.actors;
          if (!hasActors && Array.isArray(cachedActors) && cachedActors.length > 0) {
            return { ...r,
              actors: cachedActors
            };
          }
          return r;
        });
      }
    } catch (_) {}

    if (msg && msg.id) {
      const cached = this.chat._rxByMessageId.get(String(msg.id)) || [];
      const byEmoji = new Map(cached.map(r => [r.emoji, r]));
      norm = norm.map(r => {
        if ((!r.actors || r.actors.length === 0) && byEmoji.has(r.emoji)) {
          const had = byEmoji.get(r.emoji);
          if (had && Array.isArray(had.actors) && had.actors.length) {
            return { ...r,
              actors: had.actors
            };
          }
        }
        return r;
      });
    }

    if (!norm.length) return '';

    return norm.map(r => {
      const emo = this.chat._escapeHtml(r.emoji || '');
      const n = Number(r.count ?? 0);
      const actors = this.chat._reactionActorsForRender(r);
      const avas = actors.map((actor, index) => this.chat._reactionAvatarMarkup(actor, index)).join('');
      const actorsHtml = avas ? `<span class="rx-actors">${avas}</span>` : '';
      return `<span class="rx-item${r.me ? ' rx-item--mine' : ''}" title="${r.me ? 'Ваша реакция · ' : ''}${this.chat._escapeHtml(r.emoji || '')} · ${n}"><span class="rx-e">${emo}</span>${n > 0 ? `<span class="rx-n">${n}</span>` : ''}${actorsHtml}</span>`;
    }).join('');
  }

  _applyPendingReactions(containerEl) {
    try {
      let applied = 0;
      if (!containerEl || !this.chat._pendingReactions || this.chat._pendingReactions.size === 0) return;
      const els = containerEl.querySelectorAll('[id^="message-"]');
      els.forEach(node => {
        const mid = (node.id || '').replace(/^message-/, '');
        if (!mid) return;
        if (this.chat._pendingReactions.has(mid)) {
          const raw = this.chat._pendingReactions.get(mid);
          try {
            this.chat.patchMessageDOM({
              id: mid,
              reactions: raw
            });
            applied++;
          } catch (_) {}
          this.chat._pendingReactions.delete(mid);
        }
      });
    } catch (_) {}
  }

  _renderGroupReactions(groupEl, aggregatedReactions) {
    this.chat._logRx?.('_renderGroupReactions: Starting for group element:', groupEl);
    const list = aggregatedReactions || [];
    let rx = groupEl.querySelector(':scope > .rx');

    if (!list.length) {
      if (rx) {
        rx.remove();
        this.chat._logRx?.('_renderGroupReactions: Removed empty reaction container for group.');
      }
      return;
    }

    // Если контейнер не найден, создаем его
    if (!rx) {
      rx = document.createElement('div');
      rx.className = 'rx';
      // Ищем место для вставки.
      let anchor = groupEl.querySelector(':scope > .media-actions, :scope > .meta');
      if (anchor) {
        groupEl.insertBefore(rx, anchor);
      } else {
        groupEl.appendChild(rx);
      }
      this.chat._logRx?.('_renderGroupReactions: Created new reaction container for group.');
    }

    // Генерируем и вставляем HTML для реакций
    // Генерируем и вставляем HTML для реакций (с аватарками актёров)
    const reactionHtml = list.map(r => {
      const emo = this.chat._escapeHtml(r.emoji || '');
      const n = Number(r.count || 0);
      const actors = this.chat._reactionActorsForRender(r);
      const avas = actors.map((actor, index) => this.chat._reactionAvatarMarkup(actor, index)).join('');
      const actorsHtml = avas ? `<span class="rx-actors">${avas}</span>` : '';
      return `<span class="rx-item${r.me ? ' rx-item--mine' : ''}" title="${r.me ? 'Ваша реакция · ' : ''}${this.chat._escapeHtml(r.emoji || '')} · ${n}"><span class="rx-e">${emo}</span>${n > 0 ? `<span class="rx-n">${n}</span>` : ''}${actorsHtml}</span>`;
    }).join('');
    this.chat._setReactionMarkup(rx, reactionHtml);
    this.chat._logRx?.(`_renderGroupReactions: Rendered ${list.length} reactions for group (with actors).`);

  }

  _applyRealtimeReactionEvent(data, { acceptAdvisoryWhatsAppSnapshot = false } = {}) {
    const evName = data?.event || data?.type || data?._ || '';
    const isReactionEvent = evName === 'message_reactions_update'
      || evName === 'message_reaction_accepted'
      || evName === 'tg_reaction_update'
      || (evName === 'updateEditMessage' && data?.message);
    if (!isReactionEvent) return false;
    if (!this.chat._realtimeEventMatchesActiveChat(data)) return true;

    const mid = String(data?.message_id || data?.message?.id || '');
    if (!mid) return true;
    const rxPayload = data?.message?.reactions || data?.reactions;
    const providerId = getProvider(this.chat.source).id;
    const hasPendingMutation = this.chat._pendingReactionMutations.has(mid);

    if (rxPayload !== undefined) {
      // Arrays normally mean a complete provider snapshot.  The older WPP
      // webhook does not mark whether its array came from WPP or its local
      // event fallback, so only the tiny reaction-only bridge socket may use
      // that unmarked state for a passive update.  It never settles a local
      // optimistic click.
      const snapshot = { ...data, reactions: rxPayload };
      if (this.chat._reactionSnapshotIsAuthoritative(snapshot, providerId)) {
        const intent = this.chat._reactionIntents?.get(mid);
        const confirmsIntent = !intent || this.chat._normalizeReactions(rxPayload).some(item => item.me && item.emoji === intent.reaction);
        if (confirmsIntent) this.chat._pendingReactionMutations.delete(mid);
        this.chat.patchMessageDOM({ id: mid, reactions: rxPayload });
      } else if (providerId === 'whatsapp'
        && acceptAdvisoryWhatsAppSnapshot
        && Array.isArray(rxPayload)
        && !hasPendingMutation) {
        this.chat.patchMessageDOM({ id: mid, reactions: rxPayload });
      } else {
        this.chat._refreshMessageReactions(mid, data?.refresh_reactions ? 450 : 0);
      }
    } else {
      // Providers sometimes acknowledge a reaction before their aggregate is
      // readable. A delayed repair is cheaper than treating one emoji as the
      // complete state.
      this.chat._refreshMessageReactions(mid, data?.refresh_reactions ? 450 : 0);
    }
    return true;
  }

  _closeReactionPicker() {
    try { this.chat._reactionPickerCleanup?.(); } catch {}
    this.chat._reactionPickerCleanup = null;
  }

  _openReactionPicker(trigger, message) {
    this.chat._closeReactionPicker();
    const selected = this.chat._normalizeReactions(message.reactions).filter(item => item.me).map(item => item.emoji);
    const reactionRules = getFeatureConstraints(this.chat.source, 'reaction', this.chat.providerCapabilities);
    const choices = reactionRules.reactionChoices;
    const picker = createReactionPicker((reaction) => {
      this.chat._closeReactionPicker();
      if (trigger.isConnected) trigger.focus();
      // The configured provider contract permits one own reaction. A second
      // click on it removes it instead of sending the same reaction again.
      const remove = reactionRules.canRemove && selected.includes(reaction);
      this.chat._sendReaction(message, remove ? '' : reaction, trigger);
    }, selected, choices);
    document.body.appendChild(picker);
    trigger.setAttribute('aria-expanded', 'true');
    const rect = trigger.getBoundingClientRect();
    const width = picker.offsetWidth;
    const height = picker.offsetHeight;
    const top = rect.top >= height + 16 ? rect.top - height - 8 : Math.min(window.innerHeight - height - 8, rect.bottom + 8);
    const left = Math.max(8, Math.min(window.innerWidth - width - 8, rect.left - 8));
    picker.style.top = `${Math.max(8, top)}px`;
    picker.style.left = `${left}px`;
    const buttons = [...picker.querySelectorAll('button')];
    const onPointerDown = event => {
      if (!picker.contains(event.target) && !trigger.contains(event.target)) this.chat._closeReactionPicker();
    };
    const onKeyDown = event => {
      if (event.key === 'Escape') {
        event.preventDefault(); this.chat._closeReactionPicker(); if (trigger.isConnected) trigger.focus();
      } else if (['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) {
        event.preventDefault();
        const index = buttons.indexOf(document.activeElement);
        const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
        buttons[next]?.focus();
      } else if (event.key === 'Tab') {
        this.chat._closeReactionPicker(); if (trigger.isConnected) trigger.focus();
      }
    };
    const onViewportChange = () => this.chat._closeReactionPicker();
    document.addEventListener('pointerdown', onPointerDown, true);
    picker.addEventListener('keydown', onKeyDown);
    this.chat.messageArea?.addEventListener('scroll', onViewportChange, { passive: true });
    window.addEventListener('resize', onViewportChange);
    this.chat._reactionPickerCleanup = () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      this.chat.messageArea?.removeEventListener('scroll', onViewportChange);
      window.removeEventListener('resize', onViewportChange);
      trigger.setAttribute('aria-expanded', 'false');
      picker.remove();
    };
    buttons[0]?.focus({ preventScroll: true });
  }

  _reactionStateForOptimisticSend(raw, reaction) {
    const current = this.chat._normalizeReactions(raw);
    const wanted = String(reaction || '');
    const ownProfileId = String(this.chat._ownReactionActor?.id || '').toLowerCase();
    const isOwnActor = (actor) => {
      const id = String(actor?.id || '').toLowerCase();
      return id === 'me' || id === 'self' || (ownProfileId !== '' && id === ownProfileId);
    };
    const knownActors = current.flatMap(item => item.actors || []);
    for (const cached of this.chat._rxByMessageId?.values() || []) {
      for (const item of Array.isArray(cached) ? cached : []) knownActors.push(...(item.actors || []));
    }
    const ownActor = knownActors.find(actor => isOwnActor(actor) && actor.avatar)
      || (this.chat._ownReactionActor?.avatar ? this.chat._ownReactionActor : null)
      || (this.chat._ownWhatsAppReactionAvatar ? { id: 'me', avatar: this.chat._ownWhatsAppReactionAvatar } : null)
      || knownActors.find(isOwnActor) || { id: 'me', avatar: null, initials: 'Я' };
    const next = [];
    let selected = null;
    for (const item of current) {
      const count = Math.max(0, Number(item.count || 0));
      const peerCount = Math.max(0, count - (item.me ? 1 : 0));
      const peerActors = (item.actors || []).filter(actor => !isOwnActor(actor));
      if (wanted && item.emoji === wanted) {
        selected = { ...item, count: peerCount + 1, me: true, actors: [...peerActors, ownActor] };
      } else if (peerCount > 0) {
        // Telegram and WhatsApp both replace the account's prior reaction.
        // Keep other participants, but never retain a second `me` aggregate.
        next.push({ ...item, count: peerCount, me: false, actors: peerActors });
      }
    }
    if (wanted) next.push(selected || { emoji: wanted, count: 1, me: true, actors: [ownActor] });
    return next;
  }

  _reactionSnapshotIsAuthoritative(response, providerId = getProvider(this.chat.source).id) {
    if (!response || response.success === false || response.cached === true || response.authoritative === false) return false;
    const reactions = response.reactionsDetailed ?? response.reactions ?? response.data ?? response.results ?? response;
    if (!Array.isArray(reactions)) return false;
    // The old compatibility bridge used to turn a local empty cache into a
    // plain successful array. WhatsApp must only trust the explicit complete
    // provider snapshot emitted by the reaction route.
    if (providerId === 'whatsapp') {
      // The bridge's `webhook-cache` is the last state observed by the
      // webhook, not proof that a click which happened just now reached WPP.
      // It is safe for passive first paint, but must never settle or roll back
      // an optimistic reaction mutation.
      if (response.snapshot_origin === 'webhook-cache' || response.snapshot_origin === 'cache-miss') return false;
      return response.authoritative === true
        || (response.reactions_snapshot === true && response.cached !== true);
    }
    return true;
  }

  _preserveReactionIntent(messageId, reactions) {
    const intent = this.chat._reactionIntents?.get(String(messageId));
    if (!intent) return reactions;
    if (Date.now() > intent.expiresAt) {
      this.chat._reactionIntents.delete(String(messageId));
      return reactions;
    }
    // History, delayed websocket snapshots and gallery regrouping all pass
    // here. Preserve our last click while accepting other people's reactions.
    return this.chat._reactionStateForOptimisticSend(reactions || [], intent.reaction);
  }

  _scheduleReactionReconciliation(messageId, reaction, mutationToken) {
    const providerId = getProvider(this.chat.source).id;
    const delays = providerId === 'whatsapp' ? [900, 3000, 8500] : [550, 1800];
    delays.forEach((delay, attempt) => {
      this.chat.lifetime.timeout(async () => {
        if (!this.chat._isActiveInstance() || this.chat._pendingReactionMutations.get(messageId) !== mutationToken) return;
        const snapshot = await this.chat._fetchMessageReactionSnapshot(messageId);
        if (!this.chat._isActiveInstance() || this.chat._pendingReactionMutations.get(messageId) !== mutationToken) return;
        if (!snapshot?.authoritative) {
          // A missing/stale webhook cache must not erase the locally visible
          // click. It will be reconciled by a later reaction webhook or the
          // next history refresh, without stealing WPP time from media.
          if (attempt === delays.length - 1) this.chat._pendingReactionMutations.delete(messageId);
          return;
        }

        const confirmed = reaction === ''
          ? !this.chat._normalizeReactions(snapshot.reactions).some((item) => item.me)
          : this.chat._normalizeReactions(snapshot.reactions).some((item) => item.emoji === reaction && item.me);
        // A first provider read may still describe the state before the
        // mutation. Do not flash an old reaction back before the final retry.
        if (confirmed || attempt === delays.length - 1) {
          this.chat.patchMessageDOM({ id: messageId, reactions: snapshot.reactions });
          this.chat._pendingReactionMutations.delete(messageId);
        }
      }, delay);
    });
  }

  async _sendReaction(message, reaction, trigger) {
    if (this.chat._isPreviewMode()) {
      this.chat._showFeatureNotice('Предпросмотр не отправляет реакции.');
      return;
    }
    if (!this.chat._isActiveInstance()) return;
    const messageId = String(message?.id || '');
    if (!messageId) return;
    const desiredReaction = String(reaction || '');
    const element = document.getElementById(`message-${messageId}`);
    const previous = this.chat._normalizeReactions(element?._originalData?.reactions ?? message.reactions ?? []);
    const optimistic = this.chat._reactionStateForOptimisticSend(previous, desiredReaction);
    const mutationToken = `${Date.now()}:${desiredReaction || 'remove'}:${Math.random().toString(36).slice(2, 8)}`;
    this.chat._pendingReactionMutations.set(messageId, mutationToken);
    this.chat._reactionMutationVersions ??= new Map();
    this.chat._reactionMutationVersions.set(messageId, mutationToken);
    this.chat._reactionIntents ??= new Map();
    this.chat._reactionIntents.set(messageId, { token: mutationToken, reaction: desiredReaction, expiresAt: Infinity });
    this.chat.patchMessageDOM({ id: messageId, reactions: optimistic });
    trigger.disabled = true;
    try {
      const response = await this.chat.api.sendReaction({
        source: this.chat.source,
        chatId: this.chat.chatId,
        chatDbId: this.chat.chatDbId,
        messageId,
        reaction: desiredReaction,
      });
      if (!this.chat._isActiveInstance()) return;
      if (this.chat._reactionMutationVersions.get(messageId) !== mutationToken) return;
      if (!response?.success) throw new Error(response?.message || 'Сервис не принял реакцию.');
      const intent = this.chat._reactionIntents?.get(messageId);
      if (intent?.token === mutationToken) intent.expiresAt = Date.now() + 30000;

      const responseReactions = response.reactionsDetailed ?? response.reactions ?? response.data;
      const confirmsIntent = !intent || (intent.reaction === ''
        ? !this.chat._normalizeReactions(responseReactions || []).some(item => item.me)
        : this.chat._normalizeReactions(responseReactions || []).some(item => item.me && item.emoji === intent.reaction));
      if (this.chat._reactionSnapshotIsAuthoritative(response) && confirmsIntent) {
        this.chat.patchMessageDOM({ id: messageId, reactions: responseReactions });
        this.chat._pendingReactionMutations.delete(messageId);
      } else {
        this.chat._scheduleReactionReconciliation(messageId, desiredReaction, mutationToken);
      }
    } catch (error) {
      if (!this.chat._isActiveInstance()) return;
      if (this.chat._reactionMutationVersions.get(messageId) !== mutationToken) return;
      const rejected = error?.result?.success === false || error?.outcome === 'rejected' || error?.code === 'reaction_rejected'
        || /(?:refused|rejected|declined|не принял|отклонил)/i.test(String(error?.message || ''));
      if (rejected) {
        if (this.chat._pendingReactionMutations.get(messageId) === mutationToken) this.chat._pendingReactionMutations.delete(messageId);
        this.chat._reactionIntents?.delete(messageId);
        this.chat._showFeatureNotice(error?.message || 'Сервис не принял реакцию.');
        this.chat.patchMessageDOM({ id: messageId, reactions: previous });
      } else {
        // The provider may have accepted the reaction before the transport
        // failed. Keep the intended state and reconcile it; never resend.
        const intent = this.chat._reactionIntents?.get(messageId);
        if (intent?.token === mutationToken) intent.expiresAt = Date.now() + 30000;
        this.chat._showFeatureNotice('Результат реакции пока неизвестен. Проверяю изменения без повторной отправки.');
        this.chat._scheduleReactionReconciliation(messageId, desiredReaction, mutationToken);
      }
    } finally {
      if (this.chat._isActiveInstance() && trigger?.isConnected) trigger.disabled = false;
    }
  }

  async _fetchMessageReactionSnapshot(messageId, timeoutMs = 15000) {
    try {
      if (this.chat._isPreviewMode()) return null;
      if (!this.chat._isActiveInstance()) return null;
      const providerId = getProvider(this.chat.source).id;
      if (!['telegram', 'whatsapp', 'max'].includes(providerId)) return null;
      const mid = String(messageId || '');
      if (!mid) return null;
      if (this.chat._rxInflightSingles.has(mid)) {
        return await this.chat._rxInflightSingles.get(mid);
      }
      if (!this.chat.api) return null;
      const p = (typeof this.chat.api.getMessageReactions === 'function'
        ? this.chat.api.getMessageReactions(this.chat.source, this.chat.chatId, mid, this.chat.chatDbId, timeoutMs)
        : (providerId === 'telegram' && typeof this.chat.api.httpClientTG === 'function'
          ? this.chat.api.httpClientTG({ action: 'getMessageReactions', chatId: String(this.chat.chatId || ''), messageId: mid })
          : Promise.resolve(null))
      ).then(r => {
        if (r?.success === false) return null;
        const result = (r?.reactionsDetailed ?? r?.reactions ?? r?.data ?? r?.results ?? r) || [];
        if (!Array.isArray(result)) return null;
        const authoritative = this.chat._reactionSnapshotIsAuthoritative(r, providerId);
        if (providerId === 'whatsapp' && this.chat._isCompatibilityBridge()) {
          // Older servers have no snapshot route and the bridge falls back to
          // a local history row. Learn that once, then stop background polls
          // until the page is reloaded after the narrow server patch lands.
          if (authoritative) this.chat._bridgeReactionSnapshotsAvailable = true;
          else if (r?.success === true) this.chat._bridgeReactionSnapshotsAvailable = false;
        }
        return {
          reactions: result,
          authoritative,
          cached: r?.cached === true,
          origin: String(r?.snapshot_origin || ''),
          known: r?.known !== false,
        };
      }).finally(() => {
        if (this.chat._isActiveInstance()) {
          this.chat.lifetime.timeout(() => this.chat._rxInflightSingles.delete(mid), 500);
        } else {
          this.chat._rxInflightSingles.delete(mid);
        }
      });
      this.chat._rxInflightSingles.set(mid, p);
      const result = await p;
      return this.chat._isActiveInstance() ? result : null;
    } catch (e) {
      return null;
    }
  }

  async _fetchMessageReactions(messageId, timeoutMs = 15000) {
    const snapshot = await this.chat._fetchMessageReactionSnapshot(messageId, timeoutMs);
    return snapshot?.authoritative && Array.isArray(snapshot.reactions) ? snapshot.reactions : null;
  }

  _refreshMessageReactions(messageId, delay = 0) {
    const refresh = async () => {
      if (!this.chat._isActiveInstance() || this.chat._pendingReactionMutations.has(String(messageId))) return;
      const snapshot = await this.chat._fetchMessageReactionSnapshot(messageId);
      if (this.chat._isActiveInstance() && !this.chat._pendingReactionMutations.has(String(messageId)) && snapshot?.authoritative) {
        this.chat.patchMessageDOM({ id: String(messageId), reactions: snapshot.reactions });
      }
    };
    if (delay > 0) {
      this.chat.lifetime.timeout(() => refresh().catch(() => {}), delay);
    } else {
      refresh().catch(() => {});
    }
  }

  _visibleWhatsappReactionMessageIds(limit = 2) {
    const container = this.chat.messagesContainer;
    if (!container?.querySelectorAll) return [];
    const areaRect = this.chat.messageArea?.getBoundingClientRect?.();
    const nodes = Array.from(container.querySelectorAll('.message[data-id]'));
    const candidates = nodes.map((element) => {
      const id = String(element.dataset?.id || '');
      if (!id || id.startsWith('optimistic_') || this.chat._pendingReactionMutations.has(id)) return null;
      const rect = element.getBoundingClientRect?.();
      if (areaRect && rect && (rect.bottom < areaRect.top || rect.top > areaRect.bottom)) return null;
      return {
        id,
        hasReactions: Boolean(element.querySelector?.('.rx')),
        timestamp: Number(element.dataset?.timestamp || 0),
      };
    }).filter(Boolean);
    candidates.sort((a, b) => (Number(b.hasReactions) - Number(a.hasReactions)) || (b.timestamp - a.timestamp));
    return candidates.slice(0, Math.max(1, limit)).map((item) => item.id);
  }

  async _refreshVisibleWhatsappReactions() {
    if (this.chat._isRefreshingBridgeReactions || this.chat._isPreviewMode() || !this.chat._isActiveInstance()) return;
    if (getProvider(this.chat.source).id !== 'whatsapp' || !this.chat._isCompatibilityBridge()) return;
    if (this.chat._bridgeReactionSnapshotsAvailable === false) return;
    const ids = this.chat._visibleWhatsappReactionMessageIds(2);
    if (!ids.length) return;
    this.chat._isRefreshingBridgeReactions = true;
    try {
      // Keep WPP work serialized.  Parallel reaction reads create competing
      // account tokens and were a source of the perceived chat slowdown.
      for (const id of ids) {
        if (!this.chat._isActiveInstance() || document.hidden) break;
        const snapshot = await this.chat._fetchMessageReactionSnapshot(id, 15000);
        // A webhook cache is useful to initialise a blank bubble but does not
        // replace an already-rendered aggregate during passive polling. It is
        // deliberately advisory: WPP's authoritative snapshot arrives via a
        // reaction event or an explicit repair, not one request per viewport.
        const canPaintCache = snapshot?.origin === 'webhook-cache'
          && !this.chat._pendingReactionMutations.has(id)
          && !this.chat._rxByMessageId.has(id);
        if (this.chat._isActiveInstance() && (snapshot?.authoritative || canPaintCache) && !this.chat._pendingReactionMutations.has(id)) {
          this.chat.patchMessageDOM({ id, reactions: snapshot.reactions });
        }
      }
    } finally {
      this.chat._isRefreshingBridgeReactions = false;
    }
  }

  async _fetchMessageReactionsBulk(messageIds = []) {
    try {
      if (this.chat._isPreviewMode()) return {};
      if (!this.chat._isActiveInstance()) return {};
      if (getProvider(this.chat.source).id !== 'telegram') return {};
      const mids = (Array.isArray(messageIds) ? messageIds : []).map(x => String(x)).filter(Boolean);
      this.chat._logRx?.('FETCH-BULK: Fetching reactions for messageIds:', mids.join(', '));
      if (!mids.length) return {};
      if (!this.chat.api || typeof this.chat.api.httpClientTG !== 'function') return {};
      const body = {
        action: 'getMessagesReactions',
        chatId: String(this.chat.chatId || ''),
        messageIds: mids,
        detailed: 1,
        include_recent: 1,
        include_actors: 1
      };
      const r = await this.chat.api.httpClientTG(body, {
        method: 'POST'
      });
      if (!this.chat._isActiveInstance()) return {};

      // Универсальный разбор возможных форматов ответа
      const candidateMaps = [
        r?.data?.map,
        r?.map,
        r?.results,
        r?.data,
        r
      ].filter(Boolean);

      let out = {};
      for (const cm of candidateMaps) {
        if (Array.isArray(cm)) {
          for (const it of cm) {
            const mid = String(it?.message_id ?? it?.id ?? '');
            if (mid) out[mid] = it?.reactionsDetailed ?? it?.reactions ?? it;
          }
        } else if (typeof cm === 'object') {
          Object.keys(cm).forEach(k => {
            out[String(k)] = cm[k];
          });
        }
        if (Object.keys(out).length) break;
      }
      return out;
    } catch (e) {
      console.error('[AVATAR DEBUG] _fetchMessageReactionsBulk failed', e);
      return {};
    }
  }

  async _hydrateReactionsForViewportBatch() {
    // The bridge keeps the normal per-message reaction endpoint, but does
    // not make a background POST to the Telegram REST service when a chat
    // merely opens. Historical reaction snapshots still render immediately.
    const providerId = getProvider(this.chat.source).id;
    // MAX reaction snapshots are read-only and already pass through the
    // authenticated bridge GET route.  They must be hydrated on the first
    // paint just like Telegram; the old compatibility-bridge short circuit
    // was written for providers whose snapshot route was not available.
    if (this.chat._isPreviewMode() || (this.chat._isCompatibilityBridge() && providerId !== 'max')) return;
    if (!this.chat._isActiveInstance()) return;
    if (!['telegram', 'max'].includes(providerId)) {
      this.chat._rxHydratedOnce = true;
      return;
    }
    if (this.chat._isHydratingRx) return;
    this.chat._isHydratingRx = true;
    try {
      const container = this.chat.messagesContainer;
      if (!container) return;
      const toLoad = new Set();
      const handledGroups = new Set();
      const knownSnapshots = new Set();
      const nodes = Array.from(container.querySelectorAll(
        '.message[id^="message-"], .message.album, .message.grouped-files'
      ));
      for (const node of nodes) {
        const records = Array.isArray(node._groupMessages)
          ? node._groupMessages
          : (node._originalData ? [node._originalData] : []);
        for (const record of records) {
          if (record?.id != null && hasKnownReactions(record)) knownSnapshots.add(String(record.id));
        }
      }
      nodes.forEach(n => {
        if (toLoad.size >= 24) return;
        const mid = n.id.replace('message-', '');
        if (n.classList.contains('album') || n.classList.contains('grouped-files')) {
          const groupKey = n.dataset.groupKey;
            if (groupKey && !handledGroups.has(groupKey)) {
              const groupIds = (n.dataset.messageIds || '').split(',').filter(Boolean);
              if (groupIds.some(id => !knownSnapshots.has(String(id)) && !this.chat._rxByMessageId.has(String(id)))) {
              groupIds.forEach(id => {
                const messageId = String(id);
                if (toLoad.size < 24 && !knownSnapshots.has(messageId) && !this.chat._rxByMessageId.has(messageId)) toLoad.add(messageId);
              });
              }
            handledGroups.add(groupKey);
          }
        } else {
          const rxEl = n.querySelector(':scope > .bubble > .rx, :scope .rx');
          if (!rxEl || !rxEl.childElementCount) {
            if (!knownSnapshots.has(mid) && !this.chat._rxByMessageId.has(mid)) {
              toLoad.add(mid);
            }
          }
        }
      });
      this.chat._logRx?.('HYDRATE: Found messages to load:', toLoad.size, Array.from(toLoad));
      if (toLoad.size === 0) return;
      const map = await this.chat._fetchMessageReactionsBulk(Array.from(toLoad));
      if (!this.chat._isActiveInstance()) return;

      const singlesToEnrich = [];
      for (const mid of toLoad) {
        if (!this.chat._isActiveInstance()) return;
        const raw = map[mid] ?? map[String(mid)];
        const norm = this.chat._normalizeReactions(raw);
        if (!norm.length || !norm.some(r => Array.isArray(r.actors) && r.actors.length)) {
          singlesToEnrich.push(String(mid));
        } else {
          const ok = this.chat.patchMessageDOM({
            id: String(mid),
            reactions: norm
          });
          if (!ok) this.chat._onMessageReactionsUpdated(String(mid), norm);
        }
      }

      const limit = 8;
      for (let i = 0; i < singlesToEnrich.length; i += limit) {
        const chunk = singlesToEnrich.slice(i, i + limit);
        await Promise.all(chunk.map(async (smid) => {
          try {
            const raw = await this.chat._fetchMessageReactions(smid);
            if (!this.chat._isActiveInstance()) return;
            if (!Array.isArray(raw)) return;
            const norm = this.chat._normalizeReactions(raw);
            const ok = this.chat.patchMessageDOM({
              id: smid,
              reactions: norm
            });
            if (!ok) this.chat._onMessageReactionsUpdated(String(smid), norm);
          } catch {}
        }));
      }

      try {
        if (!this.chat._isActiveInstance()) return;
        const groups = Array.from(this.chat.messagesContainer.querySelectorAll('.message.album, .message.grouped-files'));
        for (const g of groups) {
          this.chat._registerGroup(g);
          this.chat._pendingGroupRx.add(g.dataset.groupKey);
        }
        this.chat._scheduleGroupRxFlush();
      } catch (_) {}
      // Первая успешная гидрация на текущей "странице" завершена
      this.chat._rxHydratedOnce = true;
    } catch (e) {
      console.warn('[RX] _hydrateReactionsForViewportBatch failed', e);
    } finally {
      this.chat._isHydratingRx = false;
    }
  }
}
