import { chatAvatar, hasAvatarPhotoSource, setHeaderAvatar, shouldRetainAvatarPhoto } from '../ui/avatar.js?v=20261004-perf-r1';
import { cacheAvatar, forgetCachedAvatar, preferCachedAvatar } from '../ui/avatarCache.js?v=20261004-perf-r1';
import { renderChatSections, telegramFolders } from '../ui/ChatSections.js?v=20261004-perf-r1';
import { createChatListItem, subscribeChatListReceipts } from '../ui/components/ChatListItem.js?v=20261004-perf-r1';
import { messageStates } from '../core/messageStates.js?v=20260921-chat-list-receipts-r2';
import { formatDateWithRussianMonth } from '../core/utils.js';
import { ApiService } from '../core/ApiService.js?v=20261004-perf-r1';
import { normalizeChat } from '../domain/providers.js';


const CHAT_CACHE_TTL_MS = 15 * 60 * 1000;
const CHAT_CACHE_PREFIX = 'unified:chat-list:v2:';
const chatCacheScope = String(window.APP_CONFIG?.chatCacheScope || 'unbound').trim() || 'unbound';
const CHAT_CACHE_KEY = CHAT_CACHE_PREFIX + chatCacheScope;
const cachedChatFields = [
    'id', 'source', 'chat_id', 'name', 'avatar', 'avatar_url', 'avatar_version', 'last_message_time',
    'last_message_text', 'last_message_id', 'last_message_direction', 'last_message_ack',
    'last_message_send_state', 'last_message_is_read', 'last_message_is_service',
    'last_message_service_event', 'last_message_event_style', 'is_unread', 'debug_chat_kind',
];
const cachedContextFields = [
    'title', 'account_id', 'provider_account_id', 'telegram_account_id', 'max_account_id',
    'telegram_archived', 'telegram_folder_id', 'telegram_folders', 'telegram_chat_kind',
    'vk_archived', 'vk_folder_id', 'vk_chat_kind', 'max_chat_type',
    'last_message_ack', 'last_message_send_state', 'last_message_is_read',
    'last_message_service_event', 'last_message_event_style', 'max_last_message_timestamp_ms',
];
function cacheChat(chat) {
    const copy = {};
    for (const field of cachedChatFields) if (Object.hasOwn(chat || {}, field)) copy[field] = chat[field];
    let context = chat?.item_context;
    if (typeof context === 'string') { try { context = JSON.parse(context); } catch { context = {}; } }
    if (context && typeof context === 'object') {
        copy.item_context = {};
        for (const field of cachedContextFields) if (Object.hasOwn(context, field)) copy.item_context[field] = context[field];
    }
    return copy;
}
function saveChatCache(chats) {
    try { localStorage.setItem(CHAT_CACHE_KEY, JSON.stringify({ savedAt: Date.now(), chats: Array.isArray(chats) ? chats.map(cacheChat) : [] })); } catch {}
}
function clearChatCache() {
    try {
        for (let index = localStorage.length - 1; index >= 0; index--) {
            const key = localStorage.key(index);
            if (key === 'chatList:v1' || String(key || '').startsWith(CHAT_CACHE_PREFIX)) localStorage.removeItem(key);
        }
    } catch {}
}
function loadChatCache() {
    try {
        const envelope = JSON.parse(localStorage.getItem(CHAT_CACHE_KEY) || 'null');
        if (!envelope || !Array.isArray(envelope.chats) || Date.now() - Number(envelope.savedAt || 0) > CHAT_CACHE_TTL_MS) {
            localStorage.removeItem(CHAT_CACHE_KEY);
            return [];
        }
        const cached = envelope.chats;
        // A prior version persisted labels like `Telegram 1808411181` before
        // the provider identity was known. Do not flash that incorrect name
        // and then replace it with the username after the live refresh.
        return cached.filter((chat) => !(
            String(chat?.source || '').toLowerCase() === 'telegram'
            && /^telegram\s+\d+$/i.test(String(chat?.name || '').trim())
        ));
    } catch { return []; }
}
const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function safeImageUrl(value) {
    if (!String(value ?? '').trim()) return '';
    try {
        const url = new URL(String(value ?? '').trim(), window.location.href);
        return ['http:', 'https:'].includes(url.protocol.toLowerCase()) ? url.href : '';
    } catch {
        return '';
    }
}

document.addEventListener('DOMContentLoaded', function () {

    function unlockAudio() {
        const sound = new Audio('sound.mp3');
        sound.volume = 0;
        sound.play().catch(() => { });
        console.log('[DEBUG] Аудио контекст активирован взаимодействием пользователя.');
        document.body.removeEventListener('click', unlockAudio);
        document.body.removeEventListener('keydown', unlockAudio);
    }
    document.body.addEventListener('click', unlockAudio, { once: true });
    document.body.addEventListener('keydown', unlockAudio, { once: true });

    // --- Инициализация ---
    const api = new ApiService();
    const isPreviewMode = window.APP_CONFIG?.previewMode === true
        || new URLSearchParams(window.location.search).get('preview') === '1';
    const isCompatibilityBridge = window.APP_CONFIG?.bridgeMode === true;
    // A direct chat URL needs its first history page before the full list
    // refresh.  The local compatibility bridge has one PHP worker, so a
    // 300+ row list request otherwise queues ahead of the selected chat.
    const initialUrlParams = new URLSearchParams(window.location.search);
    const initialDeepLink = initialUrlParams.get('source')
        && initialUrlParams.get('chat_id')
        && initialUrlParams.get('db_id');
    const initialDeepLinkIdentity = initialDeepLink ? {
        source: String(initialUrlParams.get('source') || ''),
        chatId: String(initialUrlParams.get('chat_id') || ''),
        dbId: String(initialUrlParams.get('db_id') || ''),
    } : null;
    let initialChatListStarted = false;
    let initialChatListFallbackTimer = null;
    let initialChatListRetryScheduled = false;
    let initialChatListRetryTimer = null;
    let removeInitialHistoryListener = null;
    const chatListContainer = document.getElementById('chat-list-container');
    // Instant paint from cache

    const sourceFiltersContainer = document.getElementById('source-filters');
    const initialLoader = document.getElementById('initial-loader');
    const syncIndicator = document.getElementById('sync-indicator');
    const syncText = syncIndicator.querySelector('.sync-text');
    const spinner = syncIndicator.querySelector('.spinner-border');
    const logoutBtn = document.getElementById('logout-btn');
    const loginBtn = document.getElementById('login-btn');
    if (isCompatibilityBridge) {
        // Login buttons remain the entry point for QR/phone code and, after
        // a successful login, for a new dialog by number. Logging out stays
        // outside the local bridge because it clears a provider session.
        document.querySelectorAll('#logout-btn, #tg-logout-btn')
            .forEach((button) => { button.hidden = true; });
    }

    const captchaModalElement = document.getElementById('vkCaptchaModal');
    const captchaModal = new bootstrap.Modal(captchaModalElement);
    const captchaContainer = document.getElementById('vk-captcha-container');
    const captchaInput = document.getElementById('vk-captcha-input');
    const captchaSidInput = document.getElementById('vk-captcha-sid');
    const captchaSubmitBtn = document.getElementById('vk-captcha-submit');
    const captchaError = document.getElementById('vk-captcha-error');

    let lastSoftSyncAt = 0;
    const SOFT_SYNC_COOLDOWN_MS = 15000; // не чаще чем раз в 15 сек
    const FALLBACK_SYNC_MS = 180000;     // раз в 3 минуты, если вкладка активна

    let captchaPromiseResolver = null;
    let activeFilters = new Set(['Telegram', 'WhatsApp', 'VK', 'Avito', 'MAX']);

    let lastUnreadCount = 0;
    const originalTitle = document.title;
    console.log(`[DEBUG] СТРАНИЦА ЗАГРУЖЕНА. Начальное значение lastUnreadCount = ${lastUnreadCount}`);

    function playSound() {
        console.log('[DEBUG] 4. Вызвана функция playSound().');
        const lastSoundTime = parseInt(sessionStorage.getItem('lastSoundNotificationTime') || '0', 10);
        const timeDiff = Date.now() - lastSoundTime;
        console.log(`[DEBUG] 5. Проверка sessionStorage: ${timeDiff}ms прошло с последнего звука (лимит 3000ms).`);

        if (timeDiff < 3000) {
            console.log('[DEBUG] 6. ЗВУК ЗАГЛУШЕН из-за недавнего воспроизведения на другой странице.');
            return;
        }

        console.log('[DEBUG] 6. Воспроизвожу звук...');
        const sound = new Audio('sound.mp3');
        sound.play()
            .then(() => sessionStorage.setItem('lastSoundNotificationTime', String(Date.now())))
            .catch(e => console.error("[DEBUG] Ошибка воспроизведения звука:", e));
    }

    const qrModalElement = document.getElementById('whatsappQrModal');
    const qrModal = new bootstrap.Modal(qrModalElement);
    const qrCodeContainer = document.getElementById('qr-code-container');
    let statusCheckInterval = null;
let waAuthInFlight = false;

    let lastTimestampOnPage = 0;
    let lastChatsTs = 0;
    let isSyncRunning = false;
    let lastRenderedChats = [];
    let lastOpenChatListSignature = '';
    // MAX profile images are available only through a bridge-session relay.
    // Keep a browser cache so an older summary row can be enriched
    // without turning every list refresh into another provider read. Its TTL
    // stays below the bridge avatar-reference lifetime (24 hours).
    const MAX_AVATAR_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
    const MAX_AVATAR_HYDRATION_CONCURRENCY = 2;
    const MAX_AVATAR_HYDRATION_LIMIT = 8;
    const MAX_AVATAR_NEGATIVE_TTL_MS = 15 * 60 * 1000;
    const LIST_AVATAR_LOAD_CONCURRENCY = 3;
    const failedMaxAvatarUrls = new Set();
    const maxAvatarHydrationInFlight = new Set();
    const listAvatarQueue = [];
    const queuedListAvatarImages = new WeakSet();
    let activeListAvatarLoads = 0;

    function runListAvatarQueue() {
        while (activeListAvatarLoads < LIST_AVATAR_LOAD_CONCURRENCY && listAvatarQueue.length) {
            const image = listAvatarQueue.shift();
            queuedListAvatarImages.delete(image);
            const source = safeImageUrl(image?.dataset?.avatarSrc || '');
            if (!image?.isConnected || !source || image.dataset.avatarLoading === '1') continue;
            activeListAvatarLoads += 1;
            image.dataset.avatarLoading = '1';
            image.dataset.avatarLoadSource = source;
            image.onload = () => {
                if (image.dataset.avatarLoadSource !== source || image.dataset.avatarSource && image.dataset.avatarSource !== source) return;
                image.onload = null;
                delete image.dataset.avatarLoading;
                delete image.dataset.avatarLoadSource;
                activeListAvatarLoads = Math.max(0, activeListAvatarLoads - 1);
                image.dispatchEvent(new Event('unified-avatar-loaded'));
                runListAvatarQueue();
            };
            image.onerror = () => {
                if (image.dataset.avatarLoadSource !== source || image.dataset.avatarSource && image.dataset.avatarSource !== source) return;
                image.onerror = null;
                delete image.dataset.avatarLoading;
                delete image.dataset.avatarLoadSource;
                activeListAvatarLoads = Math.max(0, activeListAvatarLoads - 1);
                image.src = image.dataset.fallback || '';
                runListAvatarQueue();
            };
            image.src = source;
        }
    }

    function queueListAvatar(image) {
        if (!(image instanceof HTMLImageElement) || !safeImageUrl(image.dataset.avatarSrc || '') || queuedListAvatarImages.has(image)
            || image.dataset.avatarLoading === '1') return;
        queuedListAvatarImages.add(image);
        listAvatarQueue.push(image);
        runListAvatarQueue();
    }

    const listAvatarObserver = typeof IntersectionObserver === 'function'
        ? new IntersectionObserver((entries) => {
            entries.forEach((entry) => {
                if (!entry.isIntersecting) return;
                listAvatarObserver.unobserve(entry.target);
                queueListAvatar(entry.target);
            });
        }, { root: chatListContainer, rootMargin: '100px 0px' })
        : null;

    function observeListAvatars(root = chatListContainer) {
        root.querySelectorAll('img.chat-avatar[data-avatar-src]').forEach((image) => {
            // A preserved DOM node already owns a decoded photo. Its
            // data-avatar-src remains as identity metadata and must not turn
            // a later list repaint into another image request.
            if (hasAvatarPhotoSource(image) || !safeImageUrl(image.dataset.avatarSrc || '')) return;
            if (listAvatarObserver) listAvatarObserver.observe(image);
            else queueListAvatar(image);
        });
    }
    document.addEventListener('max:read-boundary', ({ detail }) => {
        const boundary = Number(detail?.read_until_ms);
        if (!Number.isSafeInteger(boundary) || boundary <= 0 || !detail?.account_id) return;
        for (const row of lastRenderedChats) {
            const stamp = Number(row.item_context?.max_last_message_timestamp_ms);
            if (String(row.source).toLowerCase() !== 'max' || row.last_message_direction !== 'out'
                || String(row.chat_id) !== String(detail.chat_id)
                || String(row.item_context?.max_account_id) !== String(detail.account_id)
                || !(stamp > 0 && stamp <= boundary)) continue;
            messageStates.merge('MAX', row.id, { id: row.last_message_id, direction: 'out', ack: 3, is_read: true, send_state: 'read' });
        }
        saveChatCache(lastRenderedChats);
    });
    subscribeChatListReceipts(() => lastRenderedChats);
    // The bridge can take longer than the minute poll interval to answer a
    // metadata request.  Keep one lightweight check in flight so a second
    // timer tick cannot queue another request ahead of the open chat.
    let isCheckingUpdates = false;

    // === Удаление чата (кнопка "крестик")
    chatListContainer.addEventListener('click', async (e) => {
        if (isPreviewMode) return;
        const btn = e.target.closest('.delete-chat-btn');
        if (!btn) return;

        e.preventDefault();
        e.stopPropagation();

        const source = btn.dataset.source || '';
        const chatId = btn.dataset.chatId || '';
        const dbId = btn.dataset.dbId || '';
        const name = btn.dataset.name || 'чат';

        const forEveryone = (source.toLowerCase() === 'telegram');
        if (!chatId) return;

        const q = (source.toLowerCase() === 'telegram')
            ? `Удалить "${name}" полностью (для всех участников)?`
            : `Удалить чат "${name}" у себя?`;
        if (!confirm(q)) return;

        try {
            const params = new URLSearchParams({
                action: 'delete_chat_universal',
                source,
                chat_id: chatId,
                chat_db_id: dbId,
                for_everyone: String(forEveryone ? 1 : 0)
            });

            const resp = await fetch('index.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
                body: params.toString()
            });

            let json;
            try { json = await resp.json(); } catch (_) {
                throw new Error('Сервер вернул не JSON (проверь action в index.php)');
            }
            if (!resp.ok || !json || json.success !== true) {
                throw new Error((json && json.message) || 'Удаление не выполнено');
            }

            const row = document.getElementById(`chat-item-${dbId}`);
            if (row) row.remove();
        } catch (err) {
            console.error(err);
            alert('Не удалось удалить чат: ' + (err.message || err));
        }
    });

    // Keep navigation instant. The provider read receipt is sent only after
    // BaseChat has rendered the first page, so a slow WPP request cannot take
    // a worker before history and text arrive.
    chatListContainer.addEventListener('click', (e) => {
        if (isPreviewMode) return;
        // игнор клика по кнопке удаления
        if (e.target.closest('.delete-chat-btn')) return;

        const item = e.target.closest('a.list-group-item');
        if (!item) return;
        item.classList.remove('unread');
    });

    // --- Функции рендеринга (UI) ---
    const READ_UNTIL_STORAGE_KEY = 'unifiedMessenger.readUntilByDbId.v1';
    let localReadUntilByDbId = {};
    try {
        localReadUntilByDbId = JSON.parse(localStorage.getItem(READ_UNTIL_STORAGE_KEY) || '{}') || {};
    } catch {
        localReadUntilByDbId = {};
    }

    function getCurrentChatDbId() {
        try {
            return String(new URLSearchParams(location.search).get('db_id') || '');
        } catch {
            return '';
        }
    }

    function rememberLocalReadUntil(dbId, timestamp) {
        const key = String(dbId || '');
        const ts = Number(timestamp || 0);
        if (!key || !Number.isFinite(ts) || ts <= 0) return;

        localReadUntilByDbId[key] = Math.max(Number(localReadUntilByDbId[key] || 0), ts);
        try {
            localStorage.setItem(READ_UNTIL_STORAGE_KEY, JSON.stringify(localReadUntilByDbId));
        } catch {}
    }

    function isEffectivelyUnread(chatData) {
        const dbId = String(chatData.id || '');
        const lastTs = Number(chatData.last_message_time || 0);

        if (dbId && dbId === getCurrentChatDbId()) {
            return false;
        }
        if (dbId && Number(localReadUntilByDbId[dbId] || 0) >= lastTs) {
            return false;
        }

        return !!chatData.is_unread;
    }

    async function markChatItemRead(item) {
        if (isPreviewMode || (isCompatibilityBridge && window.APP_CONFIG?.autoMarkRead !== true)) return;
        const dbId = item?.dataset?.dbId;
        const source = item?.dataset?.source;
        const chatId = item?.dataset?.chatId;
        const timestamp = Number(item?.dataset?.timestamp || 0);

        if (!dbId || !source || !chatId) return;

        const wasUnread = item.classList.contains('unread');
        item.classList.remove('unread');

        try {
            const result = await api.markChatRead(dbId, source, chatId);
            if (result?.success === true) {
                rememberLocalReadUntil(dbId, timestamp);
                updateUnreadCount('silent');
            } else if (wasUnread && String(dbId) !== getCurrentChatDbId()) {
                item.classList.add('unread');
                console.warn('markChatRead rejected:', result);
            }
        } catch (err) {
            if (wasUnread && String(dbId) !== getCurrentChatDbId()) {
                item.classList.add('unread');
            }
            console.warn('markChatRead failed:', err);
        }
    }

    function createChatHTML(chatData) {
        const chat = normalizeChat(chatData.source, chatData);
        chat.avatar_url = safeImageUrl(chatAvatar(chat));
        return createChatListItem(chat, isEffectivelyUnread(chat), !isCompatibilityBridge && !isPreviewMode);
    }

    function copyElementAttributes(target, source) {
        Array.from(target.attributes).forEach((attribute) => target.removeAttribute(attribute.name));
        Array.from(source.attributes).forEach((attribute) => target.setAttribute(attribute.name, attribute.value));
    }

    // The list refreshes often for receipts and realtime events. Keep a chat
    // row and its known avatar URL when the chat identity and URL did not
    // change. A list refresh can race the image decode; replacing it with
    // initials in that window caused the visible photo → initials → photo
    // flicker on every page reload.
    function patchChatRow(previous, next) {
        const sameChat = previous.dataset.source === next.dataset.source
            && previous.dataset.chatId === next.dataset.chatId;
        if (!sameChat) return next;

        const previousAvatar = previous.querySelector('img.chat-avatar');
        const previousAiBadge = previous.querySelector('.ai-list-status');
        const previousAiGroup = previous.dataset.aiGroup;
        const nextAvatar = next.querySelector('img.chat-avatar');
        // The chat list is refreshed from both a detailed and a terse
        // snapshot. A terse snapshot has no avatar URL; its initials are a
        // fallback, never newer information than a known photo URL.
        const previousVersion = String(previousAvatar?.dataset.avatarVersion || '');
        const nextVersion = String(nextAvatar?.dataset.avatarVersion || '');
        const versionChanged = Boolean(previousVersion && nextVersion && previousVersion !== nextVersion);
        // A provider can rotate a relay URL without changing the photograph.
        // The painted photo is evidence stronger than that unsigned refresh;
        // only an explicit avatar version may replace it during list redraw.
        const keepAvatar = !versionChanged && (shouldRetainAvatarPhoto(previousAvatar, nextAvatar)
            || hasAvatarPhotoSource(previousAvatar));
        copyElementAttributes(previous, next);
        previous.replaceChildren(...Array.from(next.childNodes));
        if (keepAvatar) {
            const replacement = previous.querySelector('img.chat-avatar');
            if (replacement?.dataset.fallback) previousAvatar.dataset.fallback = replacement.dataset.fallback;
            replacement?.replaceWith(previousAvatar);
        }
        // Targeted receipt refreshes patch one row without replacing the list.
        // Keep the independently polled AI badge and its filter group attached.
        if (previousAiBadge) previous.querySelector('.chat-row-meta')?.append(previousAiBadge);
        if (previousAiGroup !== undefined) previous.dataset.aiGroup = previousAiGroup;
        return previous;
    }

    let selectedTelegramFolder = '';
    let selectedTelegramView = 'all';
    chatListContainer.addEventListener('click', event => {
        const control = event.target.closest('[data-telegram-folder], [data-telegram-view]');
        if (!control) return;
        selectedTelegramFolder = control.dataset.telegramFolder || '';
        selectedTelegramView = control.dataset.telegramView || 'all';
        renderChatList(lastRenderedChats);
    });

    function patchChatListMarkup(markup) {
        const template = document.createElement('template');
        template.innerHTML = markup;
        const previousRows = new Map(
            Array.from(chatListContainer.querySelectorAll('a.list-group-item[data-db-id]'))
                .map((row) => [String(row.dataset.dbId || ''), row])
        );
        // Nested sections must retain the same avatar nodes as ordinary rows.
        template.content.querySelectorAll('a.list-group-item[data-db-id]').forEach(next => {
            const previous = previousRows.get(String(next.dataset.dbId || ''));
            if (previous) next.replaceWith(patchChatRow(previous, next));
        });
        chatListContainer.replaceChildren(template.content);
    }

    function maxAvatarCacheKey(chat) {
        return `unified:max-list-avatar:v2:${String(chat?.item_context?.max_account_id ?? 'unverified')}:${String(chat?.id ?? '')}:${String(chat?.chat_id ?? '')}`;
    }

    function listAvatarCacheIdentity(chat) {
        const context = chat?.item_context && typeof chat.item_context === 'object' ? chat.item_context : {};
        const source = String(chat?.source || '').toLowerCase();
        const account = String(context[`${source}_account_id`] || context.provider_account_id || context.account_id || 'unbound');
        return `${source}:${account}:${String(chat?.id ?? '')}:${String(chat?.chat_id ?? '')}`;
    }

    function listAvatarVersion(chat) {
        const context = chat?.item_context && typeof chat.item_context === 'object' ? chat.item_context : {};
        return String(chat?.avatar_version || context.max_avatar_version || context.avatar_version || '');
    }

    function applyKnownListAvatars(chats) {
        for (const chat of chats) {
            const identity = listAvatarCacheIdentity(chat);
            if (!identity || !String(chat?.source || '').trim()) continue;
            const avatar = preferCachedAvatar('chat-list', identity, chatAvatar(chat), listAvatarVersion(chat));
            if (avatar) {
                chat.avatar = avatar;
                chat.avatar_url = avatar;
            }
        }
    }

    function readMaxAvatarCache(chat) {
        try {
            const value = JSON.parse(sessionStorage.getItem(maxAvatarCacheKey(chat)) || 'null');
            if (!value || Number(value.expiresAt || 0) <= Date.now()) return null;
            return { avatar: safeImageUrl(value.avatar || ''), known: true };
        } catch {
            return null;
        }
    }

    function writeMaxAvatarCache(chat, avatar) {
        try {
            sessionStorage.setItem(maxAvatarCacheKey(chat), JSON.stringify({
                avatar: safeImageUrl(avatar || ''),
                expiresAt: Date.now() + (avatar ? MAX_AVATAR_CACHE_TTL_MS : MAX_AVATAR_NEGATIVE_TTL_MS),
            }));
        } catch {}
    }

    function applyMaxAvatar(chat, avatar) {
        const trusted = safeImageUrl(avatar);
        if (!trusted) return false;
        const id = String(chat?.id ?? '');
        const row = lastRenderedChats.find((candidate) => String(candidate?.id ?? '') === id);
        if (row) {
            row.avatar = trusted;
            row.avatar_url = trusted;
        }
        const listAvatar = Array.from(chatListContainer.querySelectorAll('a.list-group-item[data-db-id]'))
            .find((element) => String(element.dataset.dbId || '') === id)
            ?.querySelector('img.chat-avatar');
        if (listAvatar) {
            listAvatar.onerror = () => {
                listAvatar.onerror = null;
                listAvatar.src = listAvatar.dataset.fallback || '';
            };
            listAvatar.src = trusted;
        }
        const active = window.currentChat;
        if (active && String(active.source || '').toLowerCase() === 'max'
            && String(active.chatDbId || '') === id) {
            const headerAvatar = document.getElementById('chat-avatar');
            if (headerAvatar) setHeaderAvatar(headerAvatar, trusted);
        }
        try { saveChatCache(lastRenderedChats); } catch {}
        return true;
    }

    function applyKnownMaxAvatars(chats) {
        for (const chat of chats) {
            if (String(chat?.source || '').toLowerCase() !== 'max') continue;
            const current = safeImageUrl(chatAvatar(chat));
            if (current && !failedMaxAvatarUrls.has(current)) continue;
            chat.avatar = '';
            chat.avatar_url = '';
            const cached = readMaxAvatarCache(chat);
            if (cached?.avatar && !failedMaxAvatarUrls.has(cached.avatar)) {
                chat.avatar = cached.avatar;
                chat.avatar_url = cached.avatar;
            }
        }
    }

    async function hydrateMissingMaxAvatars(chats) {
        if (!isCompatibilityBridge || typeof api.getContactProfile !== 'function') return;
        const queue = [];
        for (const chat of chats) {
            if (queue.length >= MAX_AVATAR_HYDRATION_LIMIT) break;
            if (String(chat?.source || '').toLowerCase() !== 'max' || !chat?.id || chat?.chat_id === undefined) continue;
            if (safeImageUrl(chatAvatar(chat))) continue;
            if (readMaxAvatarCache(chat)?.known) continue;
            const key = String(chat.id);
            if (maxAvatarHydrationInFlight.has(key)) continue;
            maxAvatarHydrationInFlight.add(key);
            queue.push(chat);
        }
        const worker = async () => {
            while (queue.length) {
                const chat = queue.shift();
                if (!chat) return;
                const key = String(chat.id);
                try {
                    // This is the fixed read-only profile route. It neither
                    // opens the dialog nor marks it read.
                    // List refreshes are cache-first. A forced provider read
                    // here made every WebSocket/list repaint hit MAX again.
                    const response = await api.getContactProfile('MAX', String(chat.chat_id), String(chat.id));
                    const avatar = safeImageUrl(response?.profile?.avatar || '');
                    writeMaxAvatarCache(chat, avatar);
                    if (avatar) applyMaxAvatar(chat, avatar);
                } catch {
                    // A short negative cache prevents a missing provider photo
                    // from retrying on each ordinary list repaint.
                    writeMaxAvatarCache(chat, '');
                } finally {
                    maxAvatarHydrationInFlight.delete(key);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(MAX_AVATAR_HYDRATION_CONCURRENCY, queue.length) }, worker));
    }

    chatListContainer.addEventListener('error', (event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement) || !img.classList.contains('chat-avatar')) return;
        const element = img.closest('a[data-db-id]');
        const chat = lastRenderedChats.find(row => String(row.id) === element?.dataset.dbId);
        if (chat) forgetCachedAvatar('chat-list', listAvatarCacheIdentity(chat), img.dataset.avatarSrc || img.getAttribute('src'));
        if (String(element?.dataset.source || '').toLowerCase() !== 'max') return;
        const url = safeImageUrl(img.getAttribute('src'));
        if (!url || failedMaxAvatarUrls.has(url)) return;
        failedMaxAvatarUrls.add(url);
        if (!chat) return;
        chat.avatar = '';
        chat.avatar_url = '';
        const cached = readMaxAvatarCache(chat);
        // Do not loop if a freshly fetched profile repeats a broken URL.
        if (cached?.avatar === url) writeMaxAvatarCache(chat, '');
        else {
            try { sessionStorage.removeItem(maxAvatarCacheKey(chat)); } catch {}
        }
        // Run after the image fallback handler, including a cached profile response.
        setTimeout(() => { void hydrateMissingMaxAvatars([chat]); }, 0);
    }, true);

    chatListContainer.addEventListener('unified-avatar-loaded', (event) => {
        const img = event.target;
        if (!(img instanceof HTMLImageElement) || !img.classList.contains('chat-avatar') || img.naturalWidth <= 1) return;
        const element = img.closest('a[data-db-id]');
        const chat = lastRenderedChats.find(row => String(row.id) === element?.dataset.dbId);
        if (chat) cacheAvatar('chat-list', listAvatarCacheIdentity(chat), img.currentSrc || img.getAttribute('src'), listAvatarVersion(chat));
    }, true);

    // --- Функции для сохранения и загрузки фильтров ---
    const filterSources = ['Telegram', 'WhatsApp', 'VK', 'Avito', 'MAX'];
    function reflectSourceFilters() {
        const selected = activeFilters.size === 1 ? [...activeFilters][0] : '';
        sourceFiltersContainer.querySelectorAll('[data-source-filter]').forEach(button => {
            button.setAttribute('aria-pressed', String(button.dataset.sourceFilter === selected));
        });
    }
    function saveFiltersToStorage() {
        try { localStorage.setItem('chatSourceFilter:v2', activeFilters.size === 1 ? [...activeFilters][0] : ''); } catch {}
    }
    function loadFiltersFromStorage() {
        let selected = '';
        try { selected = localStorage.getItem('chatSourceFilter:v2') || ''; } catch {}
        activeFilters = new Set(filterSources.includes(selected) ? [selected] : filterSources);
        reflectSourceFilters();
    }

    function applyFiltersAndSeparators() {
        const aiView=document.querySelector('[data-inbox-view="ai"]')?.getAttribute('aria-pressed')==='true';
        // Keep the view marker on the list itself.  This makes the filter
        // state survive an extracted/reused renderer and avoids a hidden
        // second owner for the AI view.
        const wasAiView=chatListContainer.dataset.aiView==='1';
        if(aiView!==wasAiView){chatListContainer.dataset.aiView=aiView?'1':'0';renderChatList(lastRenderedChats);return;}
        if (selectedTelegramFolder && !(activeFilters.size === 1 && activeFilters.has('Telegram'))) {
            selectedTelegramFolder = '';
            renderChatList(lastRenderedChats);
            return;
        }
            const query = (document.getElementById('chat-search')?.value || '').trim().toLocaleLowerCase('ru');
            const unreadOnly = document.querySelector('[data-inbox-view="unread"]')?.getAttribute('aria-pressed') === 'true';
        const chatItems = chatListContainer.querySelectorAll('.list-group-item');
        chatItems.forEach(item => {
            const source = item.dataset.source;
            const aiFilter=document.getElementById('ai-status-filter')?.value||'all';
            const aiMatch=!!item.dataset.aiGroup&&(aiFilter==='all'||item.dataset.aiGroup===aiFilter);
            const sourceMatch=aiView?(!document.getElementById('ai-source-filter')?.value||document.getElementById('ai-source-filter').value===source):activeFilters.has(source);
            const visible = (!aiView||aiMatch) && sourceMatch && (!unreadOnly || item.classList.contains('unread')) && (!query || (item.dataset.search || '').includes(query));
            item.style.display = visible ? '' : 'none';
        });

        const empty = document.getElementById('chat-list-empty');
        if (empty) {
            const hasVisible = [...chatItems].some(item => item.style.display !== 'none');
            empty.hidden = hasVisible;
            const title = empty.querySelector('[data-empty-title]');
            const detail = empty.querySelector('[data-empty-detail]');
            const aiSnapshot = window.__unifiedAiStatusSnapshot;
            if (aiView && aiSnapshot?.loading) {
                if (title) title.textContent = 'Статусы AI загружаются';
                if (detail) detail.textContent = 'Список появится после первой проверки очереди';
            } else if (aiView && aiSnapshot?.stale) {
                if (title) title.textContent = 'Не удалось получить статусы AI';
                if (detail) detail.textContent = 'Проверьте подключение к локальному bridge и повторите позже';
            } else {
                if (title) title.textContent = 'Ничего не найдено';
                if (detail) detail.textContent = 'Попробуйте другой запрос или провайдер';
            }
        }
        document.dispatchEvent(new Event('inbox:filtered'));
        const separators = chatListContainer.querySelectorAll('.date-separator');
        separators.forEach(sep => {
            let nextElement = sep.nextElementSibling;
            let hasVisibleChatsAfter = false;

            while (nextElement && !nextElement.classList.contains('date-separator')) {
                if (nextElement.style.display !== 'none') {
                    hasVisibleChatsAfter = true;
                    break;
                }
                nextElement = nextElement.nextElementSibling;
            }

            sep.style.display = hasVisibleChatsAfter ? 'block' : 'none';
        });
    }

    document.addEventListener('inbox:filter', applyFiltersAndSeparators);

    async function updateUnreadCount(reason = 'silent') {
        try {
            const data = await api.getUnreadCount();
            const counterEl = document.getElementById('unread-counter');
            const newUnreadCount = data.success ? data.unread_count : 0;
            const prevUnreadCount = lastUnreadCount;

            if (newUnreadCount > 0) {
                counterEl.textContent = newUnreadCount;
                counterEl.style.display = 'inline-block';
                document.title = `(${newUnreadCount}) ${originalTitle}`;
            } else {
                counterEl.style.display = 'none';
                document.title = originalTitle;
            }

            console.log(`[DEBUG] UI ОБНОВЛЕН. Глобальный счетчик 'lastUnreadCount' будет изменен с ${lastUnreadCount} на ${newUnreadCount}`);
            // Решение по звуку: ТОЛЬКО если пришло событие из вебхука (reason==='webhook') и счётчик вырос
            try {
                if (reason === 'webhook' && Number(newUnreadCount) > Number(prevUnreadCount)) {
                    console.log('[DEBUG] Звук включён: reason=webhook, рост счётчика', prevUnreadCount, '→', newUnreadCount);
                    playSound();
                } else {
                    console.log('[DEBUG] Звук НЕ проигрывается: reason=', reason, ' delta=', Number(newUnreadCount) - Number(prevUnreadCount));
                }
            } catch (e) { console.warn('[DEBUG] Ошибка логики звука', e); }
            lastUnreadCount = newUnreadCount;

        } catch (error) {
            console.error('Failed to update unread count:', error);
        }
    }

    function reconcileOpenChatFromList(visibleChats) {
        const activeChat = window.currentChat;
        if (!activeChat || String(activeChat.source || '').toLowerCase() !== 'whatsapp') return;
        const dbId = String(activeChat.chatDbId || '');
        const row = visibleChats.find((chat) => String(chat?.id ?? '') === dbId);
        if (!row) return;
        // The list has demonstrably observed a newer native row.  Use that
        // observation as the durable handoff to the open pane; this covers
        // both broker notifications and the list's own safety polling.
        const signature = [dbId, row.last_message_id || '', row.last_message_time || 0, row.last_message_text || ''].join('|');
        if (signature === lastOpenChatListSignature) return;
        lastOpenChatListSignature = signature;
        if (typeof activeChat._queueRealtimeMessageFetch === 'function') {
            activeChat._queueRealtimeMessageFetch();
        }
    }

    function renderChatList(chats, { cached = false } = {}) {
        if (!chats) return;

        // Offline means only that the provider cannot be synced right now.
        // It must never make the already loaded WhatsApp history vanish.
        const visibleChats = Array.isArray(chats) ? chats.map(chat => messageStates.mergeChat(chat)) : [];
        applyKnownListAvatars(visibleChats);
        applyKnownMaxAvatars(visibleChats);
        // Keep the compact in-memory list so a websocket event for one chat
        // can update that row without waiting for the minute safety poll.
        lastRenderedChats = visibleChats.slice();
        reconcileOpenChatFromList(visibleChats);

        if (selectedTelegramFolder && !telegramFolders(visibleChats).has(selectedTelegramFolder)) selectedTelegramFolder = '';
        const finalHtml = renderChatSections(visibleChats, {
            aiView:document.querySelector('[data-inbox-view="ai"]')?.getAttribute('aria-pressed')==='true',
            selectedFolder: selectedTelegramFolder,
            telegramOnly: activeFilters.size === 1 && activeFilters.has('Telegram'),
            selectedView: selectedTelegramView,
            renderRows(rows) {
                let dateKey = null;
                return rows.map(chat => {
                    const date = new Date(chat.last_message_time * 1000);
                    const key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
                    const separator = key !== dateKey ? `<div class="text-center text-muted small my-2 date-separator">${formatDateWithRussianMonth(chat.last_message_time)}</div>` : '';
                    dateKey = key;
                    return separator + createChatHTML(chat);
                }).join('');
            },
        });

        patchChatListMarkup(finalHtml || '<p class="text-center text-muted">Чаты не найдены.</p>');
        observeListAvatars();
        chatListContainer.dataset.snapshot = cached ? '1' : '0';
        chatListContainer.setAttribute('aria-busy', cached ? 'true' : 'false');
        try { saveChatCache(visibleChats); } catch {}
        try { initialLoader?.classList.add('d-none'); } catch(e){}

        const firstChat = chatListContainer.querySelector('.list-group-item');
        if (firstChat) {
            lastTimestampOnPage = parseInt(firstChat.dataset.timestamp, 10);
        }

        applyFiltersAndSeparators();
        void hydrateMissingMaxAvatars(visibleChats);
        // Подсветка выбранного чата после перерисовки (исходя из URL)
        try {
            const q = new URLSearchParams(location.search);
            const db = q.get('db_id');
            if (db) {
                document.querySelectorAll('#chat-list-container .list-group-item.active')
                    .forEach(el => el.classList.remove('active'));
                const sel = document.getElementById('chat-item-' + db);
                if (sel) sel.classList.add('active');
            }
        } catch(e){}

    }

    function setTrustedImage(container, value, alt, style = {}) {
        if (!container) return false;
        const url = safeImageUrl(value);
        container.replaceChildren();
        if (!url) return false;
        const image = document.createElement('img');
        image.src = url;
        image.alt = alt;
        Object.assign(image.style, style);
        container.appendChild(image);
        return true;
    }

    function renderQrWaiting(status) {
        if (!qrCodeContainer) return;
        qrCodeContainer.replaceChildren();
        const spinnerEl = document.createElement('div');
        spinnerEl.className = 'spinner-border text-success';
        spinnerEl.setAttribute('role', 'status');
        const text = document.createElement('p');
        text.className = 'mt-2 small text-muted';
        text.textContent = `Ожидание QR-кода... (статус: ${String(status || 'неизвестен')})`;
        qrCodeContainer.append(spinnerEl, text);
    }

    async function handleCaptcha(captchaData) {
        if (!setTrustedImage(captchaContainer, captchaData.captcha_img, 'Captcha Image')) {
            throw new Error('Сервис вернул некорректное изображение капчи');
        }
        captchaSidInput.value = captchaData.captcha_sid;
        captchaInput.value = '';
        captchaError.style.display = 'none';
        captchaModal.show();

        return new Promise(resolve => {
            captchaPromiseResolver = async () => {
                const sid = captchaSidInput.value;
                const key = captchaInput.value.trim();
                if (!key) {
                    captchaError.textContent = 'Поле не может быть пустым.';
                    captchaError.style.display = 'block';
                    return;
                }
                try {
                    const result = await api.retryVkRequest(captchaData.original_method, captchaData.original_params, sid, key);
                    if (result.success) {
                        captchaModal.hide();
                        resolve(result.data);
                    } else {
                        captchaError.textContent = result.message || 'Ошибка.';
                        captchaError.style.display = 'block';
                        if (!setTrustedImage(captchaContainer, result.data?.captcha_img, 'Captcha Image')) {
                            throw new Error('Сервис вернул некорректное изображение капчи');
                        }
                        captchaSidInput.value = result.data.captcha_sid;
                    }
                } catch (e) {
                    captchaError.textContent = 'Сетевая ошибка. Попробуйте снова.';
                    captchaError.style.display = 'block';
                }
            };
        });
    }

    captchaSubmitBtn.addEventListener('click', () => {
        if (captchaPromiseResolver) {
            captchaPromiseResolver();
        }
    });

    async function checkWhatsappAuth() {
        // The current WPPConnect bridge owns the QR/phone-code flow.  Keep the
        // legacy controller from starting a QR session behind its back.
        if (window.__waAuthControlled) return;
        console.log("Checking WhatsApp status...");
        
    if (waAuthInFlight) return;
    waAuthInFlight = true;
try {
            const data = await api.getWhatsappStatus();
            console.log("Current status:", data.status);
            const connectedStates = ['CONNECTED', 'inChat', 'isLogged', 'qrReadSuccess', 'MAIN', 'SYNCING'];

            if (connectedStates.includes(data.status)) {
                if (logoutBtn) logoutBtn.style.display = 'inline-block';
                if (loginBtn) loginBtn.style.display = 'none';
                if (qrModalElement.classList.contains('show')) qrModal.hide();
                if (statusCheckInterval) {
                    clearInterval(statusCheckInterval);
                    statusCheckInterval = null;
                }
                return;
            }

            if (logoutBtn) logoutBtn.style.display = 'none';
            if (loginBtn) loginBtn.style.display = 'inline-block';

            if (data.status === 'qr' && data.qrcode) {
                if (!qrModalElement.classList.contains('show')) qrModal.show();
                if (!setTrustedImage(qrCodeContainer, data.qrcode, 'Scan me', { width: '250px', height: '250px' })) {
                    renderQrWaiting('QR-код недоступен');
                }
            } else {
                if (!qrModalElement.classList.contains('show')) qrModal.show();
                renderQrWaiting(data.status);
            }

            if (!statusCheckInterval) {
                statusCheckInterval = setInterval(checkWhatsappAuth, 5000);
            }
        } catch (error) {
        if (ApiService?.isAbort?.(error) || error?.name === 'AbortError' || error?.__aborted) { return; }
console.error("WhatsApp auth check failed:", error);
            if (logoutBtn) logoutBtn.style.display = 'none';
            if (loginBtn) loginBtn.style.display = 'inline-block';
            if (!qrModalElement.classList.contains('show')) qrModal.show();
            qrCodeContainer.innerHTML = `<p class="text-danger">Ошибка проверки статуса.</p>`;
            if (!statusCheckInterval) {
                statusCheckInterval = setInterval(checkWhatsappAuth, 5000);
            }
        }
    }

    // --- Функции-контроллеры (Логика) ---
    function hasRenderedChatRows() {
        return Boolean(chatListContainer?.querySelector('.list-group-item'));
    }

    function hideInitialChatListLoader() {
        if (!initialLoader) return;
        initialLoader.style.display = 'none';
        initialLoader.classList.add('d-none');
    }

    async function loadInitialChats({ isRetry = false } = {}) {
        try {
            // The bridge is a single local PHP worker. It may legitimately
            // wait behind visible media, so only its initial refresh receives
            // a longer deadline. Other installations retain their default.
            const data = await api.getChats(isCompatibilityBridge ? 20000 : undefined);
            hideInitialChatListLoader();
            renderChatList(data.chats);
            updateUnreadCount('silent');
        } catch (error) {
            // A direct chat can already have rendered from local cache. Do
            // not replace that useful list with an error when the optional
            // bridge refresh loses a race with media; try once more quietly.
            if (isCompatibilityBridge && hasRenderedChatRows()) {
                hideInitialChatListLoader();
                if (!isRetry && !initialChatListRetryScheduled) {
                    initialChatListRetryScheduled = true;
                    initialChatListRetryTimer = window.setTimeout(() => {
                        initialChatListRetryTimer = null;
                        void loadInitialChats({ isRetry: true });
                    }, 8000);
                }
                console.warn('[bridge] Initial chat-list refresh deferred:', error);
                return;
            }
            initialLoader.innerHTML = '<p class="text-danger">Ошибка загрузки чатов.</p>';
            console.error('Initial load failed:', error);
        }
    }

    function startInitialChatList() {
        if (initialChatListStarted) return;
        initialChatListStarted = true;
        if (initialChatListFallbackTimer !== null) {
            window.clearTimeout(initialChatListFallbackTimer);
            initialChatListFallbackTimer = null;
        }
        removeInitialHistoryListener?.();
        removeInitialHistoryListener = null;
        void loadInitialChats();
    }

    function deferInitialChatListForDeepLink() {
        if (!initialDeepLinkIdentity) {
            startInitialChatList();
            return;
        }

        const onFirstHistoryRendered = (event) => {
            const detail = event?.detail || {};
            if (String(detail.source || '') !== initialDeepLinkIdentity.source
                || String(detail.chatId || '') !== initialDeepLinkIdentity.chatId
                || String(detail.dbId || '') !== initialDeepLinkIdentity.dbId) {
                return;
            }
            startInitialChatList();
        };
        removeInitialHistoryListener = () => {
            document.removeEventListener('chat:first-history-rendered', onFirstHistoryRendered);
        };
        document.addEventListener('chat:first-history-rendered', onFirstHistoryRendered);

        // Keep the left panel recoverable if a provider never resolves its
        // history request.  Normal deep links release this as soon as their
        // first message page has been rendered.
        initialChatListFallbackTimer = window.setTimeout(startInitialChatList, 4500);
    }

    async function runSync() {
        if (isSyncRunning) return;
        isSyncRunning = true;
        syncIndicator.style.visibility = 'visible';
        spinner.style.display = 'inline-block';
        syncText.textContent = 'Синхронизация...';

        try {
            const onlySources = Array.from(activeFilters).filter(s => s !== 'WhatsApp' || window.__waConnected !== false);
            await api.runSync({ onlySources }); // профиль по умолчанию (DEFAULT)
            const data = await api.getChats();

            if (data.error_type === 'captcha') {
                syncText.textContent = 'Требуется ввод капчи...';
                await handleCaptcha(data);
                const allChatsData = await api.getChats();
                renderChatList(allChatsData.chats);
            } else {
                renderChatList(data.chats);
                updateUnreadCount('silent');
            }
        } catch (error) {
        if (ApiService?.isAbort?.(error) || error?.name === 'AbortError' || error?.__aborted) {
            // тихо игнорируем отмену; статус не меняем
        } else {
console.error('Sync or refresh failed:', error);
            syncText.textContent = 'Ошибка синхронизации';
        }
    } finally { waAuthInFlight = false; 
            isSyncRunning = false;
            spinner.style.display = 'none';
            if (syncText.textContent === 'Синхронизация...') {
                syncText.textContent = `Обновлено: ${new Date().toLocaleTimeString()}`;
            }
        }
    }

    // === ЛЁГКИЙ синк по WS-сигналу ===
    async function softSyncOnEvent() {
        const now = Date.now();
        if (now - lastSoftSyncAt < SOFT_SYNC_COOLDOWN_MS) return;
        lastSoftSyncAt = now;

        try {
            const onlySources = Array.from(activeFilters).filter(s => s !== 'WhatsApp' || window.__waConnected !== false);
            await api.runSync({ onlySources, profile: 'SOFT' });
            const data = await api.getChats();
            renderChatList(data.chats);
            updateUnreadCount('silent');
        } catch (e) {
            console.warn('[softSync] failed:', e);
        }
    }

    
async function checkUpdates() {
    if (isSyncRunning || isCheckingUpdates) return;
    isCheckingUpdates = true;
    try {
        // Use meta endpoint if available to avoid unnecessary heavy refresh
        let shouldRefresh = true;
        try {
            const meta = await api.getChatsMeta();
            if (meta && typeof meta.max_ts !== 'undefined') {
                if (meta.max_ts <= (lastChatsTs || 0)) {
                    shouldRefresh = false;
                } else {
                    lastChatsTs = meta.max_ts|0;
                }
            }
        } catch {}
        if (!shouldRefresh) { updateUnreadCount('silent'); return; }

        const data = await api.getChats();
        renderChatList(data.chats);
        if (Array.isArray(data.chats) && data.chats.length) {
            lastChatsTs = Math.max(lastChatsTs, ...data.chats.map(c => (c.last_message_time|0 || 0)));
        }
        updateUnreadCount('silent');
    } catch (error) {
        console.error('Check updates failed:', error);
    } finally {
        isCheckingUpdates = false;
    }
}

    // WebSocket events also carry receipt-only updates.  Such an update does
    // not change last_message_time, so checkUpdates() intentionally skips it.
    // Fetch the compact chat list directly and debounce bursts of events: the
    // left preview must show exactly the same receipt as the open chat.
    const REALTIME_LIST_REFRESH_DEBOUNCE_MS = 400;
    let realtimeChatRefreshTimer = null;
    let realtimeChatRefreshInFlight = false;
    let realtimeSocketConnected = false;
    // The browser connects only through the local SSH tunnel configured by
    // main.php (`ws://127.0.0.1:18081`).  The bridge used to disable this
    // entirely after duplicate receipt bursts caused full-list rerenders.
    // Coalescing below preserves the live path without reviving that load.
    const bridgeRealtimeDisabled = false;
    function refreshChatListFromRealtime() {
        if (bridgeRealtimeDisabled) return;
        if (realtimeChatRefreshTimer !== null) return;
        realtimeChatRefreshTimer = setTimeout(async () => {
            realtimeChatRefreshTimer = null;
            if (realtimeChatRefreshInFlight) return;
            realtimeChatRefreshInFlight = true;
            try {
                const data = await api.getChats();
                renderChatList(data.chats);
                updateUnreadCount('silent');
            } catch (error) {
                console.warn('[WS] Chat-list refresh failed:', error);
            } finally {
                realtimeChatRefreshInFlight = false;
            }
        }, REALTIME_LIST_REFRESH_DEBOUNCE_MS);
    }

    let realtimeChangedChatIds = new Set();
    let realtimeReceiptOnlyChatIds = new Set();
    let realtimeRowRefreshTimer = null;
    let realtimeRowRefreshInFlight = false;

    function realtimeChatDbId(value) {
        const id = String(value ?? '').trim();
        return /^\d+$/.test(id) && Number(id) > 0 ? id : '';
    }

    function patchRealtimeChatRow(chat) {
        const dbId = String(chat?.id ?? '');
        if (!dbId) return false;
        const previous = Array.from(chatListContainer.querySelectorAll('a.list-group-item[data-db-id]'))
            .find(row => String(row.dataset.dbId || '') === dbId);
        if (!previous) return false;
        const template = document.createElement('template');
        template.innerHTML = createChatHTML(chat);
        const next = template.content.querySelector('a.list-group-item[data-db-id]');
        if (!next) return false;
        patchChatRow(previous, next);
        observeListAvatars(previous);
        return true;
    }

    function mergeRealtimeChats(updatedChats, receiptOnlyIds = new Set()) {
        let changed = false;
        let rowPatched = false;
        for (const updated of updatedChats) {
            const id = realtimeChatDbId(updated?.id);
            if (!id) continue;
            const index = lastRenderedChats.findIndex((chat) => String(chat?.id ?? '') === id);
            const previous = index >= 0 ? lastRenderedChats[index] : null;
            const merged = messageStates.mergeChat(updated);
            const stablePosition = previous
                && String(previous.last_message_id || '') === String(merged.last_message_id || '')
                && Number(previous.last_message_time || 0) === Number(merged.last_message_time || 0);
            if (index >= 0) lastRenderedChats[index] = merged;
            else lastRenderedChats.push(merged);
            if (receiptOnlyIds.has(id) && stablePosition && patchRealtimeChatRow(merged)) rowPatched = true;
            else changed = true;
        }
        if (changed) {
            lastRenderedChats.sort((left, right) => Number(right?.last_message_time || 0) - Number(left?.last_message_time || 0));
            renderChatList(lastRenderedChats);
        } else if (rowPatched) {
            applyFiltersAndSeparators();
            try { saveChatCache(lastRenderedChats); } catch {}
        }
        return changed || rowPatched;
    }

    function refreshChangedChatsFromRealtime() {
        if (bridgeRealtimeDisabled || realtimeRowRefreshTimer !== null) return;
        realtimeRowRefreshTimer = setTimeout(async () => {
            realtimeRowRefreshTimer = null;
            if (realtimeRowRefreshInFlight) return;
            const ids = [...realtimeChangedChatIds].slice(0, 8);
            const receiptOnlyIds = new Set([...realtimeReceiptOnlyChatIds].filter(id => ids.includes(id)));
            for (const id of ids) realtimeChangedChatIds.delete(id);
            for (const id of receiptOnlyIds) realtimeReceiptOnlyChatIds.delete(id);
            if (!ids.length) return;
            realtimeRowRefreshInFlight = true;
            try {
                // A websocket `new_message` carries its DB row id. Fetching
                // one row avoids a 300+ chat reload after each incoming
                // WhatsApp message while still moving the row to the top.
                const results = await Promise.all(ids.map(async (id) => {
                    try { return await api.getChatDetails(id); } catch { return null; }
                }));
                const changed = mergeRealtimeChats(
                    results.map((result) => result?.chat).filter(Boolean),
                    receiptOnlyIds
                );
                if (changed) updateUnreadCount('silent');
            } finally {
                realtimeRowRefreshInFlight = false;
                // Events arriving during the previous request are handled in
                // a fresh pass rather than being silently lost.
                if (realtimeChangedChatIds.size) refreshChangedChatsFromRealtime();
            }
        }, REALTIME_LIST_REFRESH_DEBOUNCE_MS);
    }

    let lastTargetedRealtimeEventAt = 0;
    let legacyRealtimeRefreshTimer = null;
    function scheduleLegacyRealtimeRefresh() {
        if (legacyRealtimeRefreshTimer !== null) return;
        legacyRealtimeRefreshTimer = setTimeout(() => {
            legacyRealtimeRefreshTimer = null;
            // Current webhooks send both `new_message` (with the DB id) and
            // a historical id-less `update_chat_list`. Let the targeted row
            // path win when they belong to the same delivery.
            if (Date.now() - lastTargetedRealtimeEventAt < 1000) return;
            refreshChatListFromRealtime();
        }, 500);
    }

    function queueRealtimeChatRefresh(event) {
        const eventName = String(event?.event || event?.type || '');
        const id = realtimeChatDbId(event?.chat_db_id ?? event?.chatDbId);
        if (id && eventName !== 'update_chat_list') {
            lastTargetedRealtimeEventAt = Date.now();
            realtimeChangedChatIds.add(id);
            if (['read_update', 'message_read', 'message_reactions_update'].includes(eventName)) {
                realtimeReceiptOnlyChatIds.add(id);
            } else {
                realtimeReceiptOnlyChatIds.delete(id);
            }
            refreshChangedChatsFromRealtime();
            return;
        }
        // Older server events lack a chat id. Keep one debounced full-list
        // read for that legacy shape; it is a compatibility fallback, not the
        // normal incoming-message path.
        scheduleLegacyRealtimeRefresh();
    }

    function handleRealtimeEvent(data, publishToSubscribers = true) {
        if (!data || typeof data !== 'object') return;
        const eventName = String(data.event || data.type || '');
        if (!['update_chat_list', 'new_message', 'read_update', 'message_read', 'message_reactions_update', 'messages_deleted'].includes(eventName)) return;
        // The chat list owns the shared event fan-out. The active pane also
        // receives the DOM event below, where its lifecycle-bound subscriber
        // handles fetching/reaction state without a second browser socket.
        const activeChat = window.currentChat;
        const eventSource = String(data.source || '').trim().toLowerCase();
        const activeSource = String(activeChat?.source || '').trim().toLowerCase();
        // The bridge socket carries WhatsApp events. A MAX/desktop event can
        // share the generic event name and must never drive its provider-
        // specific recovery path in an open WhatsApp pane. Legacy events
        // without a source retain their existing bridge compatibility.
        if (window.APP_CONFIG?.desktopMode !== true
            && activeSource === 'whatsapp'
            && (!eventSource || eventSource === 'whatsapp')
            && typeof activeChat?._handleBridgeWhatsAppRealtimeEvent === 'function') {
            activeChat._handleBridgeWhatsAppRealtimeEvent(data);
        }
        if (publishToSubscribers) {
            document.dispatchEvent(new CustomEvent('unified:realtime-event', { detail: data }));
        }
        if (Array.isArray(data.read_ids)) {
            const chatId = String(data.chat_db_id ?? data.chatDbId ?? '');
            const row = lastRenderedChats.find(chat => String(chat.id) === chatId);
            const source = String(data.source || row?.source || '');
            for (const id of data.read_ids) {
                messageStates.merge(source, chatId, { id: String(id), ack: 3, is_read: true, direction: 'out' });
            }
        }
        if (eventName === 'messages_deleted' || eventName === 'update_chat_list' || eventName === 'new_message' || eventName === 'read_update' || eventName === 'message_read') {
            queueRealtimeChatRefresh(data);
        }
    }


    // --- WebSocket ---
    function realtimeWebSocketUrl() {
        const configured = String(window.APP_CONFIG?.realtimeUrl || '').trim();
        if (/^wss?:\/\//i.test(configured)) return configured;
        const isLocalTunnel = ['127.0.0.1', 'localhost', '::1'].includes(location.hostname) && location.port === '18080';
        const port = isLocalTunnel ? '18081' : '8081';
        return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${port}`;
    }
    function connectWebSocket() {
        if (bridgeRealtimeDisabled) return;
        if (window.APP_CONFIG?.desktopMode === true) {
            // DesktopRealtimeClient owns the authenticated WSS connection.
            // `appassets.local` has no server socket and must never retry a
            // legacy :8081 WebSocket from inside the WebView.
            document.addEventListener('unified:realtime-event', event => handleRealtimeEvent(event.detail, false));
            realtimeSocketConnected = true;
            return;
        }
        const socketUrl = realtimeWebSocketUrl();
        // Active bridge pages must never fall back to a server hostname here:
        // the page explicitly supplies a loopback tunnel URL.
        if (isCompatibilityBridge && socketUrl !== 'ws://127.0.0.1:18081') {
            console.warn('[WS] Local bridge realtime URL rejected:', socketUrl);
            return;
        }
        const socket = new WebSocket(socketUrl);

        socket.onopen = () => {
            realtimeSocketConnected = true;
            console.log('[WS] Подключен к главной странице.');
        };
        socket.onclose = () => {
            realtimeSocketConnected = false;
            console.log('[WS] Соединение закрыто, переподключение через 5 секунд...');
            setTimeout(connectWebSocket, 5000);
        };
        socket.onerror = (err) => {
            realtimeSocketConnected = false;
            console.error('[WS] Ошибка соединения:', err);
        };

        socket.onmessage = (event) => {
            try {
                const raw = typeof event?.data === 'string' ? event.data : '';
                if (!raw.includes('update_chat_list') && !raw.includes('new_message')
                    && !raw.includes('read_update') && !raw.includes('message_read')
                    && !raw.includes('message_reactions_update') && !raw.includes('messages_deleted')) return;
                handleRealtimeEvent(JSON.parse(raw));
            } catch { }
        };
    }

    // --- Бережный fallback вместо setInterval(runSync, 30000) ---
    function scheduleFallbackSync() {
        setTimeout(async function tick() {
            if (!document.hidden && !isSyncRunning) {
                try { await runSync(); } catch { }
            }
            scheduleFallbackSync();
        }, FALLBACK_SYNC_MS);
    }

    // --- Обработчик событий для фильтров ---
    sourceFiltersContainer.addEventListener('click', event => {
        const button = event.target.closest('[data-source-filter]');
        if (!button) return;
        const selected = button.dataset.sourceFilter;
        activeFilters = new Set(filterSources.includes(selected) ? [selected] : filterSources);
        selectedTelegramFolder = '';
        selectedTelegramView = 'all';
        saveFiltersToStorage();
        reflectSourceFilters();
        renderChatList(lastRenderedChats);
    });

    // --- Запуск ---
    loadFiltersFromStorage();
    try { const cached = isPreviewMode ? [] : loadChatCache(); if (Array.isArray(cached) && cached.length) renderChatList(cached, { cached: true }); } catch {}

    deferInitialChatListForDeepLink();
    if (!isPreviewMode) {
        // The compatibility bridge uses the existing server's workers and
        // cache. It must not start a competing WPP auth poll or full sync.
        if (!isCompatibilityBridge) checkWhatsappAuth();
        connectWebSocket();

        // The socket is the source of list changes while it is alive. The
        // minute poll is recovery only: running it alongside a healthy socket
        // made an unnecessary SQLite list read every minute.
        setInterval(() => {
            if (!realtimeSocketConnected) void checkUpdates();
        }, 60000);
        // If the optional WebSocket tunnel is unavailable, keep the same unified
        // list/receipt behaviour through a lightweight direct poll. This is a
        // safety net, not a second synchronizer: it only reads chats from SQLite.
        if (!bridgeRealtimeDisabled) {
            setInterval(() => {
                if (!realtimeSocketConnected && !document.hidden) refreshChatListFromRealtime();
            }, 15000);
        }
        if (!isCompatibilityBridge) {
            scheduleFallbackSync();
            setInterval(checkWhatsappAuth, 60000); // Проверка статуса WhatsApp
        }
    }

    // --- Обработчики кнопок ---
    if (logoutBtn) {
        if (isCompatibilityBridge) logoutBtn.hidden = true;
        logoutBtn.addEventListener('click', async () => {
            if (isPreviewMode) return;
            if (confirm('Выйти из сессии WhatsApp? История чатов останется.')) {
                try {
                    const clear = await api.clearWhatsappData();
                    if (!clear?.success) throw new Error(clear?.message || 'Не удалось очистить историю WhatsApp');
                    const response = await fetch('wpp_proxy.php?action=logout', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: '{}'
                    });
                    const body = await response.json().catch(() => ({}));
                    if (!response.ok) {
                        throw new Error(body.message || `HTTP ${response.status}`);
                    }
                    alert('WhatsApp отключён. История WhatsApp очищена. Нажмите «Войти в WhatsApp», чтобы привязать телефон заново.');
                    clearChatCache();
                    window.location.href = 'main.php';
                } catch (error) {
                    console.error('Произошла ошибка в процессе выхода:', error);
                    alert('Произошла критическая ошибка в процессе выхода.');
                }
            }
        });
    }

    if (loginBtn) {
        loginBtn.addEventListener('click', () => {
            if (isPreviewMode || isCompatibilityBridge) return;
            checkWhatsappAuth();
        });
    }

    // ---- Экспорт лёгкого обновления списка чатов для других частей SPA ----
    // Можно вызвать: window.reloadChats('WhatsApp') или просто window.reloadChats()
    if (typeof window !== 'undefined') {
        window.clearUnifiedChatListCache = clearChatCache;
        window.setWhatsappConnected = function(value) {
            window.__waConnected = value === true;
            // Keep cached chats visible during a temporary provider outage.
            document.body.classList.toggle('whatsapp-offline', !window.__waConnected);
            applyFiltersAndSeparators();
        };
        let whatsappBootstrapSync = null;
        window.reloadChats = async function(source){
            try {
                if (isPreviewMode) return;
                if (source) console.log('[reloadChats] requested by', source);
                // A WhatsApp logout intentionally clears its local cache.
                // After reconnect, repopulate that cache before the first
                // render instead of waiting for the periodic background sync.
                if (!isCompatibilityBridge && source === 'WhatsApp' && window.__waConnected === true) {
                    if (!whatsappBootstrapSync) {
                        whatsappBootstrapSync = api.runSync({ onlySources: ['WhatsApp'], profile: 'CONNECT' })
                            .catch((e) => console.warn('[reloadChats] WhatsApp bootstrap failed:', e))
                            .finally(() => { whatsappBootstrapSync = null; });
                    }
                    await whatsappBootstrapSync;
                }
                const data = await api.getChats();
                renderChatList(data.chats);
                updateUnreadCount('silent');
            } catch (e) {
                console.warn('[reloadChats] failed:', e);
            }
        };
    }

});

// Fix Bootstrap aria-hidden focus warning: return focus to input after QR modal hides
(function(){
  const qrModalElement = document.getElementById('whatsappQrModal');
  if (qrModalElement && typeof bootstrap !== 'undefined' && bootstrap.Modal) {
    qrModalElement.addEventListener('hidden.bs.modal', () => {
      (document.querySelector('#message-input') || document.body).focus();
    });
  }
})();
