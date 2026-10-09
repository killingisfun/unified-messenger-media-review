import { originalAvatar, chatAvatar, setHeaderAvatar } from '../ui/avatar.js';
import { createChatBySource } from '../ui/services/index.js?v=20261009-attachment-compose-r2';
import { ApiService } from '../core/ApiService.js?v=20261004-perf-r1';
import { writeScopedSelfProfile } from '../core/selfProfileCache.js';

        const app = document.getElementById('app');
        const listEl = document.getElementById('chat-list-container');
        const backBtn = document.getElementById('back-to-list');

        function isPreviewMode() {
            return window.APP_CONFIG?.previewMode === true
                || new URLSearchParams(window.location.search).get('preview') === '1';
        }


        // Подсветка выбранного чата
        function markActiveChat(dbId) {
            try {
                document.querySelectorAll('#chat-list-container .list-group-item.active')
                    .forEach(el => el.classList.remove('active'));
                const el = document.getElementById('chat-item-' + dbId);
                if (el) el.classList.add('active');
            } catch (e) {}
        }


        let currentChat = null;
        const contactTrigger = document.getElementById('contact-profile-trigger');
        const ownProfileTrigger = document.getElementById('contact-info-btn');
        const contactModalElement = document.getElementById('contactProfileModal');
        const contactProfileRefreshButton = document.getElementById('contact-profile-refresh');
        let contactProfileRefreshKey = '';
        let profileViewToken = 0;

        const escapeHtml = (value) => String(value ?? '').replace(/[&<>'"]/g, (char) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
        })[char]);

        function contactProfileContext() {
            const query = new URLSearchParams(location.search);
            const source = query.get('source') || '';
            const chatId = query.get('chat_id') || '';
            const dbId = query.get('db_id') || '';
            return {
                source,
                chatId,
                dbId,
                key: `${source.toLowerCase()}\u0000${chatId}\u0000${dbId}`,
                title: document.getElementById('chat-title')?.textContent?.trim() || 'Контакт',
            };
        }

        function isCurrentContactProfile(context) {
            const current = new URLSearchParams(location.search);
            return (context.viewToken == null || context.viewToken === profileViewToken) && current.get('source') === context.source && current.get('chat_id') === context.chatId;
        }

        function isSameContactProfile(context) {
            const current = new URLSearchParams(location.search);
            return current.get('source') === context.source
                && current.get('chat_id') === context.chatId
                && (current.get('db_id') || '') === (context.dbId || '');
        }

        function contactProfileBrowserCacheKey(context) {
            return `unified-contact-profile-v3:${context.source.toLowerCase()}:${context.chatId}:${context.dbId}`;
        }

        function readContactProfileBrowserCache(context) {
            try {
                const raw = sessionStorage.getItem(contactProfileBrowserCacheKey(context));
                const saved = raw ? JSON.parse(raw) : null;
                if (!saved || typeof saved !== 'object' || !saved.profile || typeof saved.profile !== 'object') return null;
                const fetchedAt = Number(saved.fetchedAt || 0);
                // Do not reuse a profile from a previous long-lived tab
                // session. An expired entry is simply ignored; no unrelated
                // browser data is deleted as part of opening a contact.
                if (!Number.isFinite(fetchedAt) || fetchedAt < Date.now() - 10 * 60 * 1000) return null;
                const sourceLabel = String(context.source || 'сервиса');
                const canRefresh = ['whatsapp', 'vk', 'telegram'].includes(context.source.toLowerCase());
                return {
                    ...saved.profile,
                    origin: 'cached-browser',
                    can_refresh: canRefresh,
                    needs_refresh: canRefresh && fetchedAt < Date.now() - 5 * 60 * 1000,
                    notice: `Показаны сведения, ранее полученные из ${sourceLabel}.`,
                };
            } catch {
                return null;
            }
        }

        function rememberContactProfileBrowserCache(context, profile) {
            const origin = String(profile?.origin || '');
            if (!['whatsapp', 'vk', 'telegram', 'cached-whatsapp', 'cached-vk', 'cached-telegram'].includes(origin)) return;
            try {
                sessionStorage.setItem(contactProfileBrowserCacheKey(context), JSON.stringify({
                    fetchedAt: Date.now(),
                    profile: {
                        name: String(profile?.name || ''),
                        subtitle: String(profile?.subtitle || context.source),
                        kind: String(profile?.kind || ''),
                        avatar: '',
                        fields: Array.isArray(profile?.fields) ? profile.fields.map((field) => ({
                            label: String(field?.label || ''),
                            value: String(field?.value || ''),
                            href: String(field?.href || ''),
                        })) : [],
                    },
                }));
            } catch {
                // Storage is only an acceleration layer. The bridge and the
                // saved chat record remain valid when it is unavailable.
            }
        }

        function profileAvatarInitials(value) {
            const label = String(value || 'Контакт').trim();
            if (label.startsWith('@')) return Array.from(label.slice(1)).slice(0, 2).join('').toUpperCase() || 'К';
            return label.split(/\s+/).slice(0, 2)
                .map((part) => Array.from(part)[0] || '')
                .join('').toUpperCase() || 'К';
        }

        function setProfileAvatar(url, fallbackName = '') {
            const avatar = document.getElementById('contact-profile-avatar');
            const fallback = document.getElementById('contact-profile-avatar-fallback');
            if (!avatar) return;
            const showFallback = () => {
                avatar.style.visibility = 'hidden';
                if (fallback) {
                    fallback.textContent = profileAvatarInitials(fallbackName);
                    fallback.hidden = false;
                }
            };
            const source = String(url || '').trim();
            avatar.onload = () => {
                avatar.style.visibility = 'visible';
                if (fallback) fallback.hidden = true;
            };
            avatar.onerror = showFallback;
            if (!source || /^(?:javascript|vbscript):/i.test(source)) {
                avatar.removeAttribute('src');
                showFallback();
                return;
            }
            showFallback();
            avatar.src = source;
            if (avatar.complete && avatar.naturalWidth > 0) avatar.onload();
        }

        // The profile request is often the first endpoint that returns a
        // provider avatar. Keep the already visible chat shell in sync with
        // the modal instead of leaving initials in the header and list row.
        function applyProfileAvatarToChatShell(profile, context) {
            const value = originalAvatar(profile?.avatar, profile?.avatar_url);
            if (!value || !context?.dbId) return;
            let url = '';
            try {
                const parsed = new URL(value, window.location.href);
                if (['http:', 'https:'].includes(parsed.protocol)) url = parsed.href;
            } catch {}
            if (!url) return;
            const fallback = () => {
                const title = String(profile?.name || context.title || 'Чат');
                return typeof window.currentChat?._fallbackAvatarUrl === 'function'
                    ? window.currentChat._fallbackAvatarUrl(title)
                    : '';
            };
            const header = document.getElementById('chat-avatar');
            if (header && isCurrentContactProfile(context)) setHeaderAvatar(header, url, fallback, { replace: true });
            const row = document.getElementById(`chat-item-${CSS.escape(String(context.dbId))}`);
            const listAvatar = row?.querySelector('img.chat-avatar');
            if (listAvatar) setHeaderAvatar(listAvatar, url, fallback, { replace: true });
        }

        function renderContactProfile(profile, context) {
            contactModalElement?.classList.remove('profile-loading');
            const avatar = document.getElementById('contact-profile-avatar');
            const name = document.getElementById('contact-profile-name');
            const subtitle = document.getElementById('contact-profile-subtitle');
            const fields = document.getElementById('contact-profile-fields');
            const membersHost = document.getElementById('contact-profile-members');
            const modalTitle = document.getElementById('contactProfileModalTitle');
            const notice = document.getElementById('contact-profile-notice');
            if (name) name.textContent = profile?.name || context.title;
            if (subtitle) subtitle.textContent = profile?.subtitle || context.source;
            const kind = String(profile?.kind || '').toLowerCase();
            const isGroup = kind === 'group';
            const isChannel = kind === 'channel';
            if (modalTitle) modalTitle.textContent = context.modalTitle || (isChannel ? 'Сведения о канале' : isGroup ? 'Сведения о группе' : 'Сведения о контакте');
            applyProfileAvatarToChatShell(profile, context);
            setProfileAvatar(originalAvatar(profile?.avatar, profile?.avatar_url, context.self || context.fallbackAvatar === false ? '' : document.getElementById('chat-avatar')?.getAttribute('src')) || chatAvatar(context), profile?.name || context.title);
            const items = Array.isArray(profile?.fields) ? profile.fields : [];
            const origin = String(profile?.origin || '');
            if (fields) {
                let emptyMessage = 'Сервис не передал дополнительных публичных сведений.';
                if (origin === 'saved') {
                    emptyMessage = profile?.needs_refresh
                        ? `Показываем сохранённые сведения. Обновляю данные ${context.source}…`
                        : 'Дополнительные сведения временно недоступны. Показаны название и аватар диалога.';
                } else if (origin.startsWith('cached-') || origin === 'cached-browser') {
                    emptyMessage = `В сохранённых сведениях ${context.source} нет дополнительных публичных полей.`;
                } else if (isGroup || isChannel) {
                    emptyMessage = 'Telegram не вернул дополнительных публичных сведений для этого чата.';
                }
                fields.innerHTML = items.length
                    ? items.map((field) => {
                        const href = String(field?.href || '');
                        const safeTelegramLink = isChannel || isGroup
                            ? /^https:\/\/t\.me\/[A-Za-z0-9_]{5,32}$/.test(href)
                            : false;
                        const valueHtml = safeTelegramLink
                            ? `<a href="${escapeHtml(href)}" target="_blank" rel="noopener noreferrer">${escapeHtml(field.value)}</a>`
                            : escapeHtml(field.value);
                        return `<div class="contact-profile-field"><div class="contact-profile-label">${escapeHtml(field.label)}</div><div class="contact-profile-value">${valueHtml}</div></div>`;
                    }).join('')
                    : `<div class="text-muted small py-2">${emptyMessage}</div>`;
            }
            if (membersHost) {
                const members = Array.isArray(profile?.members) ? profile.members : [];
                if (isGroup && members.length > 0) {
                    const memberRows = members.map((member) => {
                        const memberName = String(member?.name || 'Участник').trim();
                        const initials = memberName.split(/\s+/).filter(Boolean).slice(0, 2).map((part) => part.slice(0, 1)).join('').toUpperCase();
                        const avatar = String(member?.avatar || '').trim();
                        const avatarHtml = avatar
                            ? `<img src="${escapeHtml(avatar)}" alt="" loading="lazy" decoding="async">`
                            : escapeHtml(initials || '•');
                        return `<div class="contact-member"><span class="contact-member-avatar">${avatarHtml}</span><span class="contact-member-name" title="${escapeHtml(memberName)}">${escapeHtml(memberName)}</span></div>`;
                    }).join('');
                    const total = Math.max(Number(profile?.members_total || 0), members.length);
                    const more = profile?.members_truncated && total > members.length
                        ? `<div class="contact-members-more">Показаны ${members.length} из ${total} участников</div>`
                        : '';
                    membersHost.hidden = false;
                    membersHost.innerHTML = `<h6>Участники группы${total ? ` · ${total}` : ''}</h6>${memberRows ? `<div class="contact-members-list">${memberRows}</div>` : '<div class="text-muted small">Список участников пока недоступен.</div>'}${more}`;
                } else {
                    membersHost.hidden = true;
                    membersHost.replaceChildren();
                }
            }
            if (notice) {
                if (profile?.notice) {
                    notice.textContent = profile.notice;
                    notice.classList.remove('d-none');
                } else {
                    notice.textContent = '';
                    notice.classList.add('d-none');
                }
            }
            if (contactProfileRefreshButton) {
                const canRefresh = profile?.can_refresh === true;
                contactProfileRefreshButton.hidden = !canRefresh;
                contactProfileRefreshButton.disabled = contactProfileRefreshKey === context.key;
                contactProfileRefreshButton.textContent = contactProfileRefreshKey === context.key
                    ? 'Обновляю…'
                    : `Обновить из ${context.source}`;
            }
        }

        async function refreshContactProfile(context, automatic = false) {
            if (!context.source || !context.chatId || !isCurrentContactProfile(context)) return;
            // Do not create concurrent lookups from a repeated click or
            // several modal opens, regardless of the selected provider.
            if (contactProfileRefreshKey !== '') return;
            contactProfileRefreshKey = context.key;
            if (contactProfileRefreshButton) {
                contactProfileRefreshButton.disabled = true;
                contactProfileRefreshButton.textContent = 'Обновляю…';
            }
            const notice = document.getElementById('contact-profile-notice');
            if (automatic && notice) {
                notice.textContent = `Обновляю сведения из ${context.source} в фоне…`;
                notice.classList.remove('d-none');
            }

            try {
                const response = await new ApiService().getContactProfile(context.source, context.chatId, context.dbId, { refresh: true });
                if (!isCurrentContactProfile(context)) return;
                const profile = response?.profile || {};
                rememberContactProfileBrowserCache(context, profile);
                renderContactProfile(profile, context);
            } catch (error) {
                if (!isCurrentContactProfile(context)) return;
                if (notice) {
                    notice.textContent = `Не удалось обновить сведения из ${context.source}. Сохранённые данные остались на экране.`;
                    notice.classList.remove('d-none');
                }
            } finally {
                if (contactProfileRefreshKey === context.key) contactProfileRefreshKey = '';
                // The modal may have been reopened for the same chat while
                // this request was running. Its view token changes, but the
                // shared refresh key still has to release the visible button.
                if (isSameContactProfile(context) && contactProfileRefreshButton && !contactProfileRefreshButton.hidden) {
                    contactProfileRefreshButton.disabled = false;
                    contactProfileRefreshButton.textContent = `Обновить из ${context.source}`;
                }
            }
        }

        async function showContactProfile() {
            const context = contactProfileContext();
            if (!context.source || !context.chatId || !contactModalElement || !window.bootstrap) return;
            context.viewToken = ++profileViewToken;
            contactModalElement.classList.remove('profile-loading');
            const modal = window.bootstrap.Modal.getOrCreateInstance(contactModalElement);
            const avatar = document.getElementById('contact-profile-avatar');
            const name = document.getElementById('contact-profile-name');
            const subtitle = document.getElementById('contact-profile-subtitle');
            const loading = document.getElementById('contact-profile-loading');
            const fields = document.getElementById('contact-profile-fields');
            const notice = document.getElementById('contact-profile-notice');
            const modalTitle = document.getElementById('contactProfileModalTitle');
            if (modalTitle) modalTitle.textContent = 'Сведения о контакте';
            if (name) name.textContent = context.title;
            if (subtitle) subtitle.textContent = context.source;
            setProfileAvatar(document.getElementById('chat-avatar')?.getAttribute('src'), context.title);
            if (loading) loading.classList.remove('d-none');
            if (fields) fields.innerHTML = '';
            if (notice) { notice.textContent = ''; notice.classList.add('d-none'); }
            if (contactProfileRefreshButton) contactProfileRefreshButton.hidden = true;
            modal.show();

            // This cache belongs only to the current browser tab. It gives a
            // repeat opening an instant answer even if a media worker touched
            // the shared PHP session in between. A stale entry is refreshed
            // below without delaying the visible profile.
            const browserCachedProfile = readContactProfileBrowserCache(context);
            if (browserCachedProfile) {
                renderContactProfile(browserCachedProfile, context);
                if (loading) loading.classList.add('d-none');
                if (browserCachedProfile.needs_refresh === true) void refreshContactProfile(context, true);
                return;
            }

            try {
                const response = await new ApiService().getContactProfile(context.source, context.chatId, context.dbId);
                if (!isCurrentContactProfile(context)) return;
                const profile = response?.profile || {};
                rememberContactProfileBrowserCache(context, profile);
                renderContactProfile(profile, context);
                // Saved data is immediately useful. If it is older than the
                // short freshness window, refresh independently without making
                // the modal or chat wait for the provider.
                if (profile?.needs_refresh === true) void refreshContactProfile(context, true);
            } catch (error) {
                if (!isCurrentContactProfile(context)) return;
                if (fields) fields.innerHTML = '<div class="text-muted small py-2">Не удалось получить сохранённые сведения.</div>';
            } finally {
                if (isCurrentContactProfile(context) && loading) loading.classList.add('d-none');
            }
        }

        async function showMessageSenderProfile(detail) {
            const source = String(detail?.source || '');
            const userId = String(detail?.userId || '').trim();
            const query = new URLSearchParams(location.search);
            const chatId = query.get('chat_id') || '';
            const dbId = query.get('db_id') || '';
            const validSender = source.toLowerCase() === 'telegram'
                ? /^-?[1-9][0-9]{0,19}$/.test(userId)
                : /^[1-9][0-9]{0,19}$/.test(userId);
            if (!['max', 'telegram'].includes(source.toLowerCase()) || !validSender || !chatId || !contactModalElement || !window.bootstrap) return;
            const context = {
                source, chatId, dbId,
                key: `sender:${source.toLowerCase()}:${userId}`,
                title: String(detail?.name || `Пользователь ${source}`).trim() || `Пользователь ${source}`,
                modalTitle: 'Профиль участника',
                fallbackAvatar: false,
                viewToken: ++profileViewToken,
            };
            contactModalElement.classList.remove('profile-loading');
            const modal = window.bootstrap.Modal.getOrCreateInstance(contactModalElement);
            const title = document.getElementById('contactProfileModalTitle');
            const name = document.getElementById('contact-profile-name');
            const subtitle = document.getElementById('contact-profile-subtitle');
            const loading = document.getElementById('contact-profile-loading');
            const fields = document.getElementById('contact-profile-fields');
            const notice = document.getElementById('contact-profile-notice');
            if (title) title.textContent = context.modalTitle;
            if (name) name.textContent = context.title;
            if (subtitle) subtitle.textContent = `Пользователь ${source}`;
            setProfileAvatar(String(detail?.avatar || ''), context.title);
            if (loading) loading.classList.remove('d-none');
            if (fields) fields.innerHTML = '';
            if (notice) { notice.textContent = ''; notice.classList.add('d-none'); }
            if (contactProfileRefreshButton) contactProfileRefreshButton.hidden = true;
            modal.show();
            try {
                const response = await new ApiService().getMessageSenderProfile(source, userId);
                if (!isCurrentContactProfile(context)) return;
                if (!response?.success) throw new Error('Profile unavailable');
                const profile = response.profile || {};
                renderContactProfile({ ...profile, avatar: profile.avatar || detail?.avatar || '' }, context);
            } catch {
                if (!isCurrentContactProfile(context)) return;
                if (fields) fields.innerHTML = '<div class="text-muted small py-2">Не удалось получить сведения участника.</div>';
            } finally {
                if (isCurrentContactProfile(context) && loading) loading.classList.add('d-none');
            }
        }

        async function showOwnProfile() {
            const context = contactProfileContext();
            if (!context.source || !contactModalElement || !window.bootstrap) return;
            context.viewToken = ++profileViewToken;
            contactModalElement.classList.remove('profile-loading');
            const modal = window.bootstrap.Modal.getOrCreateInstance(contactModalElement);
            const modalTitle = document.getElementById('contactProfileModalTitle');
            const avatar = document.getElementById('contact-profile-avatar');
            const name = document.getElementById('contact-profile-name');
            const subtitle = document.getElementById('contact-profile-subtitle');
            const loading = document.getElementById('contact-profile-loading');
            const fields = document.getElementById('contact-profile-fields');
            const notice = document.getElementById('contact-profile-notice');
            if (modalTitle) modalTitle.textContent = 'Мой аккаунт';
            if (name) name.textContent = 'Мой аккаунт';
            if (subtitle) subtitle.textContent = context.source;
            setProfileAvatar('', 'Мой аккаунт');
            if (loading) loading.classList.remove('d-none');
            if (fields) fields.innerHTML = '';
            if (notice) { notice.textContent = ''; notice.classList.add('d-none'); }
            if (contactProfileRefreshButton) contactProfileRefreshButton.hidden = true;
            contactModalElement.classList.add('profile-loading');

            modal.show();
            try {
                const response = await new ApiService().getProviderSelfProfile(context.source);
                if (!isCurrentContactProfile(context)) return;
                const profile = response?.profile || {};
                renderContactProfile(profile, { ...context, self: true, title: 'Мой аккаунт', key: `self:${context.source}` });
                writeScopedSelfProfile(context.source, profile);
            } catch {
                if (!isCurrentContactProfile(context)) return;
                if (fields) fields.innerHTML = '<div class="text-muted small py-2">Не удалось получить сведения аккаунта.</div>';
            } finally {
                if (isCurrentContactProfile(context)) {
                    contactModalElement.classList.remove('profile-loading');
                    if (loading) loading.classList.add('d-none');
                }
            }
        }
        document.addEventListener('message:sender-profile', (event) => {
            void showMessageSenderProfile(event.detail);
        });
        contactTrigger?.addEventListener('click', showContactProfile);
        ownProfileTrigger?.addEventListener('click', showOwnProfile);
        contactProfileRefreshButton?.addEventListener('click', () => {
            void refreshContactProfile({ ...contactProfileContext(), viewToken: profileViewToken });
        });

        // Показ правой панели на мобилках
        function enterChatMode() {
            app.classList.add('chat-open', 'has-chat');
        }

        function exitChatMode() {
            app.classList.remove('chat-open');
        }
        backBtn?.addEventListener('click', exitChatMode);

        function resetChatPane() {
            app.classList.remove('has-chat');
            document.dispatchEvent(new Event('chat:reset'));
            try {
                const pane = document.querySelector('.chat-pane');
                const messageArea = pane?.querySelector('.message-area');
                if (messageArea) {
                    messageArea.innerHTML = `
            <div id="loader" class="text-center p-5" style="display:none">
              <div class="spinner-border" role="status"></div>
            </div>
            <div id="messages-container"></div>
          `;
                }
                const form = document.getElementById('message-form');
                if (form) form.reset();
                const preview = document.getElementById('attachment-preview');
                if (preview) preview.replaceChildren();
                const reply = document.getElementById('composer-reply-preview');
                if (reply) reply.replaceChildren();
                const notice = document.getElementById('chat-feature-notice');
                if (notice) { notice.hidden = true; notice.textContent = ''; }
                const avatar = document.getElementById('chat-avatar');
                if (avatar) avatar.src = (window.APP_CONFIG && window.APP_CONFIG.defaultAvatar) || '';
                const title = document.getElementById('chat-title');
                if (title) title.textContent = 'Открываю чат…';
                const providerBadge = document.getElementById('chat-provider-badge');
                if (providerBadge) {
                    providerBadge.hidden = true;
                    providerBadge.replaceChildren();
                }
            } catch (error) {
                console.warn('reset pane failed', error);
            }
        }

        function disposeCurrentChat({ reset = false } = {}) {
            const chat = currentChat;
            try { chat?.saveComposerDraft?.(); } catch {}
            currentChat = null;
            if (window.currentChat === chat) window.currentChat = null;
            if (chat && typeof chat.destroy === 'function') {
                try {
                    chat.destroy();
                } catch (error) {
                    console.warn('previous chat cleanup failed', error);
                }
            }
            if (reset) resetChatPane();
        }

        function isCurrentChat(source, chatId, dbId) {
            return !!currentChat
                && String(currentChat.source || '') === String(source || '')
                && String(currentChat.chatId || '') === String(chatId || '')
                && String(currentChat.chatDbId || '') === String(dbId || '');
        }

        // Открытие чата в правой панели (без перехода на chat.html)
        function openChat({
            source,
            chat_id,
            id,
            name,
            avatar_url,
            item_context
        }, { pushHistory = true } = {}) {
            if (!source || !chat_id || !id) return;
            try {
                document.getElementById('initial-loader')?.classList.add('d-none');
            } catch (e) {}
            if (isCurrentChat(source, chat_id, id)) {
                enterChatMode();
                return;
            }
            // Dispose before replacing any shared DOM: a previous chat must
            // never retain a socket/listener that can act on the next one.
            disposeCurrentChat({ reset: true });

            // 1) Подменяем URL, чтобы BaseChat взял параметры из location.search
            const qs = new URLSearchParams();
            qs.set('source', source);
            qs.set('chat_id', chat_id);
            qs.set('db_id', id);
            qs.set('title', name || 'Чат');
            if (item_context && item_context.title) qs.set('item_title', item_context.title);
            if (isPreviewMode()) qs.set('preview', '1');
            if (pushHistory) history.pushState(null, '', '?' + qs.toString());

            // 2) Показываем правую панель на мобилках
            enterChatMode();

            // 3) Инициализируем нужный адаптер. Все адаптеры используют
            // один BaseChat; отличаются только контрактом провайдера.
            const chat = createChatBySource(source);
            currentChat = chat;
            window.currentChat = chat;
            document.dispatchEvent(new CustomEvent('chat:opened', { detail: { source, name, avatar_url, item_context } }));
            chat.initialize().catch((error) => {
                if (window.currentChat === chat && currentChat === chat) {
                    console.error('chat initialization failed', error);
                }
            });
        }

        // Перехватываем клики по элементам списка, которые main.js рендерит как <a ...>
        listEl?.addEventListener('click', (e) => {
            // подсветить выбранный
            document.querySelectorAll('#chat-list-container .list-group-item.active').forEach(n => n.classList.remove('active'));
            if (e.target.closest('a.list-group-item')) e.target.closest('a.list-group-item').classList.add('active');
            const a = e.target.closest('a.list-group-item');
            if (!a) return;
            // не мешаем кнопке удаления
            if (e.target.closest('.delete-chat-btn')) return;

            e.preventDefault();
            const data = {
                source: a.dataset.source,
                chat_id: a.dataset.chatId,
                id: a.dataset.dbId,
                avatar_url: a.querySelector('img.chat-avatar')?.dataset.avatarSrc
                    || a.querySelector('img.chat-avatar')?.getAttribute('src') || '',
                name: a.querySelector('.chat-title')?.textContent?.trim() || 'Чат',
                item_context: (() => {
                    try {
                        const itemTitle = new URL(a.href, location.href).searchParams.get('item_title');
                        return itemTitle ? { title: itemTitle } : null;
                    } catch { return null; }
                })(),
            };
            // Avito: item_context заголовок уже есть в href-параметрах, но нам достаточно имени.
            openChat(data);
        });

        function hasUrlChatIdentity(query) {
            return Boolean(query.get('source'))
                && query.has('chat_id')
                && query.get('chat_id') !== '';
        }

        async function openChatFromUrl() {
            const q = new URLSearchParams(location.search);
            if (!hasUrlChatIdentity(q)) return false;

            const source = q.get('source');
            const chatId = q.get('chat_id');
            let dbId = q.get('db_id');
            let name = q.get('title') || 'Чат';

            // A shareable URL does not need to expose a local database id.
            // Resolve it once from the same list the sidebar uses.  This also
            // keeps native id "0" (MAX Saved Messages) valid: `0` is an id,
            // not an absent value.
            if (!dbId) {
                try {
                    const response = await new ApiService().getChats();
                    const rows = Array.isArray(response?.chats) ? response.chats : [];
                    const row = rows.find((candidate) => String(candidate?.source || '').toLowerCase() === String(source || '').toLowerCase()
                        && String(candidate?.chat_id ?? candidate?.chatId ?? '') === String(chatId));
                    if (!row) return false;
                    dbId = String(row.id ?? row.db_id ?? '');
                    name = q.get('title') || String(row.name || row.title || 'Чат');
                } catch (error) {
                    console.warn('Could not resolve chat deep link:', error);
                    return false;
                }
            }

            if (!dbId) return false;
            // Keep a resolved deep link canonical before BaseChat reads the
            // URL in its constructor.  Otherwise a link to native id `0`
            // opens visually but loses its local chat id for sends, drafts
            // and reconciliation.
            if (!q.get('db_id')) {
                q.set('db_id', dbId);
                if (!q.get('title') && name) q.set('title', name);
                history.replaceState(null, '', '?' + q.toString());
            }
            markActiveChat(dbId);
            openChat({
                source,
                chat_id: chatId,
                id: dbId,
                name,
                item_context: q.get('item_title') ? { title: q.get('item_title') } : null,
            }, { pushHistory: false });
            return true;
        }

        // Если в URL уже есть параметры — откроем чат сразу (deep link/перезагрузка).
        // Старые ссылки содержат db_id; новые могут обходиться без локального ID.
        window.addEventListener('DOMContentLoaded', () => {
            void openChatFromUrl();
        });

        // Назад по истории (если пользователь жмёт системную кнопку)
        window.addEventListener('popstate', () => {
            const q = new URLSearchParams(location.search);
            if (hasUrlChatIdentity(q)) {
                // A failed background resolution must not destroy the chat
                // that is already visible; retry is safe and has no side
                // effect on the provider.
                void openChatFromUrl();
                return;
            }
            {
                disposeCurrentChat({ reset: true });
                document.querySelectorAll('#chat-list-container .list-group-item.active').forEach((item) => item.classList.remove('active'));
                exitChatMode();
            }
        });
