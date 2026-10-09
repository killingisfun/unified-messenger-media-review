// js/src/core/ApiService.js — clean, fixed structure
import { maxHistoryQueue } from './MaxHistoryQueue.js';

export class ApiService {
    // --- Low-level helpers ---------------------------------------------------
    _responseErrorMessage(status, text) {
        const fallback = `HTTP ${status}: ${String(text || '').slice(0, 200)}`;
        try {
            const payload = JSON.parse(text);
            const message = typeof payload?.message === 'string' ? payload.message.trim() : '';
            return message || fallback;
        } catch {
            return fallback;
        }
    }

    _asyncFetchRaw(url, init = {}, timeoutMs = 15000) {
        const ctrl = new AbortController();
        const t = setTimeout(() => {
            try { ctrl.abort('timeout'); } catch (_) {}
        }, timeoutMs);
        // A person may explicitly retry a history page while its original
        // request is still waiting on a provider. Let that narrow caller
        // cancel its request, while retaining the normal timeout everywhere.
        const { signal: callerSignal, ...requestInit } = init || {};
        let detachCallerAbort = null;
        if (callerSignal) {
            const abortFromCaller = () => {
                try { ctrl.abort('cancelled'); } catch (_) {}
            };
            if (callerSignal.aborted) abortFromCaller();
            else {
                callerSignal.addEventListener('abort', abortFromCaller, { once: true });
                detachCallerAbort = () => callerSignal.removeEventListener('abort', abortFromCaller);
            }
        }

        // Sanitize URL for same-app endpoints to allow browser caching/304
        try {
            const u = new URL(url, document.baseURI || window.location.href);
            const isIndex = /\/index\.php$/i.test(u.pathname);
            if (isIndex && u.searchParams.has('_')) {
                u.searchParams.delete('_');
                url = u.pathname + (u.searchParams.toString() ? ('?' + u.searchParams.toString()) : '');
            } else {
                url = u.toString();
            }
        } catch { /* keep original url */ }

        const opts = {
            credentials: 'include',
            cache: 'no-cache',
            redirect: 'follow',
            signal: ctrl.signal,
            headers: {
                'Accept': 'application/json, text/plain, */*'
            },
            ...requestInit
        };

        // The local legacy bridge accepts mutations only from the UI document
        // that received this per-session token. Normal installations do not
        // expose a token, so their request contract is unchanged.
        const method = String(opts.method || 'GET').toUpperCase();
        const bridgeToken = String(window.APP_CONFIG?.bridgeToken || '').trim();
        // MAX's fixed local proxy is read-only at GET level, but it still
        // requires the per-page bridge token. Without it the MAX realtime
        // cursor and reaction snapshots silently fail while normal index.php
        // reads continue to work.
        let maxProxyRead = false;
        try {
            maxProxyRead = /\/max_api\.php$/i.test(new URL(url, document.baseURI || window.location.href).pathname);
        } catch {}
        if (bridgeToken && ((method !== 'GET' && method !== 'HEAD') || maxProxyRead)) {
            opts.headers = {
                ...(opts.headers || {}),
                'X-Unified-Bridge-Token': bridgeToken,
            };
        }

        // `fetch()` resolves as soon as response headers arrive. Keep the
        // deadline alive while a JSON/send body is being consumed; otherwise
        // a stalled body can wait forever after a seemingly successful HTTP
        // response. Raw consumers may call `unifiedFinish()` after explicitly
        // cancelling/ignoring a response body.
        let finished = false;
        const finish = () => {
            if (finished) return;
            finished = true;
            clearTimeout(t);
            detachCallerAbort?.();
        };
        return fetch(url, opts).then((response) => {
            if (!response?.body) {
                finish();
                return response;
            }
            for (const reader of ['arrayBuffer', 'blob', 'formData', 'json', 'text']) {
                const original = response[reader];
                if (typeof original !== 'function') continue;
                response[reader] = (...args) => Promise.resolve(original.apply(response, args)).finally(finish);
            }
            // Deliberately non-protocol metadata for the one raw caller that
            // probes a URL without reading its body.
            response.unifiedFinish = finish;
            return response;
        }, (error) => {
            finish();
            throw error;
        });
    }

    async _asyncFetchJson(url, opts = {}, timeoutMs = 15000) {
        const resp = await this._asyncFetchRaw(url, opts, timeoutMs);
        const text = await resp.text();
        if (!resp.ok) {
            throw new Error(this._responseErrorMessage(resp.status, text));
        }
        // Try to parse as JSON even if header is wrong
        try {
            return JSON.parse(text);
        } catch {
            throw new Error(`Invalid JSON: ${text.slice(0, 200)}`);
        }
    }

    // --- High-level API ------------------------------------------------------

    async getChats(timeoutMs = 10000) {
        const url = `index.php?action=get_chats_json`;
        const resolvedTimeout = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
            ? Number(timeoutMs)
            : 10000;
        // Several UI modules can request the same snapshot during startup
        // (deep-link bootstrap, realtime recovery and manual refresh). Share
        // the in-flight GET so one slow bridge read does not serialize copies
        // of the same 600+ row list behind itself.
        const requests = globalThis.__unifiedReadRequests ??= new Map();
        const key = `GET ${url}`;
        const pending = requests.get(key);
        if (pending) return pending;
        const request = this._asyncFetchJson(url, {}, resolvedTimeout);
        requests.set(key, request);
        try {
            return await request;
        } finally {
            if (requests.get(key) === request) requests.delete(key);
        }
    }

    async getChatsMeta() {
        try {
            return await this._asyncFetchJson(`index.php?action=get_chats_meta`, {}, 6000);
        } catch {
            try {
                return await this._asyncFetchJson(`api/chats_meta.php`, {}, 6000);
            } catch {
                return null;
            }
        }
    }

    async getUpdatedChats(sinceTs) {
        if (!sinceTs) return this.getChats();
        const qs = `since=${encodeURIComponent(parseInt(sinceTs, 10))}`;
        try {
            return await this._asyncFetchJson(`index.php?action=get_updated_chats&${qs}`, {}, 10000);
        } catch {
            try {
                return await this._asyncFetchJson(`api/get_updated_chats.php?${qs}`, {}, 10000);
            } catch {
                return this.getChats();
            }
        }
    }

    async runSync(opts = {}) {
        // The desktop app owns transport and talks to a server that already
        // runs its own synchronizer. There is no local PHP worker to invoke.
        if (window.APP_CONFIG?.desktopMode === true) {
            return { success: true, desktopManaged: true };
        }
        const p = new URLSearchParams();
        p.set('ajax', '1');
        p.set('async', '1');
        if (opts.profile) p.set('profile', String(opts.profile));
        if (Array.isArray(opts.onlySources) && opts.onlySources.length) {
            for (const s of opts.onlySources) p.append('source[]', s);
        }
        const url = `sync.php?${p.toString()}`;
        return this._asyncFetchJson(url, {}, 20000);
    }

    async getWhatsappStatus() {
        const url = `index.php?action=get_whatsapp_status&_=${Date.now()}`;
        return this._asyncFetchJson(url, {}, 8000);
    }

    async getInfrastructureHealth() {
        return this._asyncFetchJson(`index.php?action=get_infrastructure_health`, {}, 7000);
    }

    async getWhatsAppSelfAvatar() {
        return this._asyncFetchJson('index.php?action=get_whatsapp_self_avatar', {}, 7000);
    }

    async getProviderSelfProfile(source) {
        const normalized = String(source || '').trim();
        const isWhats = normalized.toLowerCase().startsWith('whats');
        return this._asyncFetchJson(
            `index.php?action=get_provider_self_profile&source=${encodeURIComponent(normalized)}`,
            {},
            isWhats ? 9000 : 7000
        );
    }

    _normalizeHistoryResponse(data) {
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            throw new Error('Сервис вернул некорректный ответ истории сообщений.');
        }
        if (data.success === false) {
            throw new Error(data.message || 'Сервис не вернул историю сообщений.');
        }
        if (Array.isArray(data.messages)) return data;
        if (data.messages && typeof data.messages === 'object' && Array.isArray(data.messages.items)) {
            return { ...data, ...data.messages, messages: data.messages.items };
        }
        if (Array.isArray(data.items)) return { ...data, messages: data.items };
        throw new Error(data.message || 'Сервис вернул неполную историю сообщений.');
    }

    async clearWhatsappData() {
        return this._asyncFetchJson('index.php?action=clear_whatsapp_data', {
            method: 'POST',
            body: new URLSearchParams({ confirm: '1' })
        }, 15000);
    }

    _sendOperationError(message, details = {}) {
        const error = new Error(String(message || 'Не удалось определить результат отправки.'));
        for (const key of ['outcome', 'send_state', 'code', 'request_id', 'message_id', 'message_ids', 'attachments', 'status']) {
            if (details?.[key] !== undefined) error[key] = details[key];
        }
        // Every client-side transport interruption happens after the browser
        // started a submit. The provider may already have accepted it.
        if (!error.outcome) error.outcome = 'unknown';
        if (!error.code) error.code = 'send_transport_unknown';
        return error;
    }

    async _sendOperationJson(url, init, timeoutMs, defaultCode = 'send_transport_unknown') {
        // File uploads stream through the desktop host. A normal text-send
        // deadline is too short for a healthy large video on a slow uplink;
        // retain a finite bound without misreporting it as a provider result.
        const body = init?.body;
        const hasAttachment = typeof FormData !== 'undefined'
            && body instanceof FormData
            && (body.has('attachment') || body.has('attachments[]'));
        const effectiveTimeout = hasAttachment ? Math.max(Number(timeoutMs) || 0, 10 * 60 * 1000) : timeoutMs;
        let resp;
        try {
            resp = await this._asyncFetchRaw(url, init, effectiveTimeout);
        } catch (cause) {
            if (cause?.outcome) throw cause;
            throw this._sendOperationError('Связь прервалась до получения результата отправки. Проверьте чат перед повтором.', {
                outcome: 'unknown', code: defaultCode, cause,
            });
        }
        let text = '';
        try {
            text = await resp.text();
        } catch (cause) {
            throw this._sendOperationError('Не удалось прочитать ответ отправки. Проверьте чат перед повтором.', {
                outcome: 'unknown', code: defaultCode, status: resp?.status, cause,
            });
        }
        let payload = null;
        try {
            payload = JSON.parse(text);
        } catch {
            const outcome = resp?.ok ? 'unknown' : (Number(resp?.status) >= 500 || Number(resp?.status) === 408 ? 'unknown' : 'rejected');
            throw this._sendOperationError(
                resp?.ok ? 'Сервис вернул некорректный ответ после отправки. Проверьте чат перед повтором.' : this._responseErrorMessage(resp?.status, text),
                { outcome, code: outcome === 'unknown' ? defaultCode : 'send_rejected', status: resp?.status }
            );
        }
        if (!resp.ok) {
            const outcome = String(payload?.outcome || '').toLowerCase()
                || (Number(resp?.status) >= 500 || Number(resp?.status) === 408 ? 'unknown' : 'rejected');
            throw this._sendOperationError(payload?.message || this._responseErrorMessage(resp.status, text), {
                ...payload,
                outcome,
                code: payload?.code || (outcome === 'unknown' ? defaultCode : 'send_rejected'),
                status: resp.status,
            });
        }
        return payload;
    }

    async sendMessage(formData) {
        return this._sendOperationJson('index.php', { method: 'POST', body: formData }, 120000);
    }

    async sendMessageBatch(formData) {
        return this._sendOperationJson('index.php', { method: 'POST', body: formData }, 60000, 'send_batch_transport_unknown');
    }

    async getSendJob(jobId) {
        const qs = new URLSearchParams({ action: 'get_send_job', job_id: String(jobId || '') });
        return this._sendOperationJson(`index.php?${qs.toString()}`, {}, 10000, 'send_job_status_unknown');
    }

    async sendReaction({ source, chatId, chatDbId, messageId, reaction }) {
        const body = new URLSearchParams({
            source: String(source || ''),
            chat_id: String(chatId || ''),
            chat_db_id: String(chatDbId || ''),
            message_id: String(messageId || ''),
            reaction: String(reaction || ''),
        });
        return this._asyncFetchJson('index.php?action=send_reaction', {
            method: 'POST',
            body,
        // WPPConnect obtains an account token and then performs the provider
        // request.  It can legitimately take longer than the generic UI
        // timeout, while the optimistic reaction already keeps the chat
        // responsive. Telegram retains its shorter request budget.
        }, String(source || '').toLowerCase() === 'whatsapp' ? 45000 : 15000);
    }

    async getMaxRealtimeEvents(after = 0, timeoutMs = 10000) {
        // Native WSS delivers these updates to the desktop shell. The shared
        // UI keeps its polling path inert instead of calling a local PHP file.
        if (window.APP_CONFIG?.desktopMode === true) {
            return { success: true, events: [], next_cursor: String(after ?? '0') };
        }
        const cursor = String(after ?? '0');
        if (!/^[0-9]{1,20}$/.test(cursor)) throw new Error('Некорректный курсор событий MAX.');
        return this._asyncFetchJson(`max_api.php?resource=events&after=${encodeURIComponent(cursor)}`, {}, timeoutMs);
    }

    async getMessageReactions(source, chatId, messageId, dbId = '', timeoutMs = 15000) {
        const query = new URLSearchParams({
            action: 'get_message_reactions',
            source: String(source || ''),
            chat_id: String(chatId || ''),
            message_id: String(messageId || ''),
        });
        if (dbId !== '' && dbId !== null && dbId !== undefined) query.set('db_id', String(dbId));
        const budget = Number(timeoutMs);
        return this._asyncFetchJson(
            `index.php?${query.toString()}`,
            {},
            Number.isFinite(budget) && budget > 0 ? budget : 15000
        );
    }

    async getReactionActorAvatar(source, chatId, dbId, actorId, timeoutMs = 20000, refresh = false) {
        const query = new URLSearchParams({
            action: 'get_reaction_actor_avatar',
            source: String(source || ''),
            chat_id: String(chatId || ''),
            db_id: String(dbId || ''),
            actor_id: String(actorId || ''),
        });
        if (refresh) query.set('refresh', '1');
        return this._asyncFetchJson(`index.php?${query.toString()}`, {}, timeoutMs);
    }

    async markChatRead(dbId, source = '', chatId = '') {
        const key = `${String(dbId || '')}:${String(source || '').toLowerCase()}:${String(chatId || '')}`;
        const registry = globalThis.__unifiedMarkReadRequests ??= new Map();
        const pending = registry.get(key);
        if (pending) return pending;

        const url = 'index.php?action=mark_chat_read';
        // PHP's route uses chat_db_id; include the provider identity so the
        // adapter can also send the native read/seen event (e.g. WhatsApp).
        const body = new URLSearchParams({
            chat_db_id: String(dbId || ''),
            db_id: String(dbId || ''), // legacy compatibility
            source: String(source || ''),
            chat_id: String(chatId || ''),
        });
        const request = (async () => {
        try {
            const data = await this._asyncFetchJson(url, { method: 'POST', body, keepalive: true }, 8000);
            return data && data.success === true ? data : { success: false, message: data?.message || 'mark_chat_read rejected' };
        } catch (error) {
            return { success: false, message: error?.message || 'mark_chat_read failed' };
        }
        })();
        registry.set(key, request);
        // Keep one provider receipt while it is actually in flight. A fixed
        // five-second expiry could create a duplicate WPP send-seen request
        // when the first one was merely slow.
        request.finally(() => {
            setTimeout(() => {
                if (registry.get(key) === request) registry.delete(key);
            }, 5000);
        });
        return request;
    }

    async getUnreadCount() {
        const requests = globalThis.__unifiedReadRequests ??= new Map();
        const key = 'GET index.php?action=get_unread_count';
        const pending = requests.get(key);
        if (pending) return pending;
        const request = this._getUnreadCountUnshared();
        requests.set(key, request);
        try {
            return await request;
        } finally {
            if (requests.get(key) === request) requests.delete(key);
        }
    }

    async _getUnreadCountUnshared() {
        try {
            return await this._asyncFetchJson(`index.php?action=get_unread_count`, {}, 6000);
        } catch {
            try {
                return await this._asyncFetchJson(`api/get_unread_count.php`, {}, 6000);
            } catch {
                return { success: false, unread_count: 0 };
            }
        }
    }

    

async getChatDetails(source, chatId) {
    // The details endpoint is DB-backed. Support the legacy one-argument call
    // (db id) and the two-argument form without ever producing chat_id=undefined.
    const byDb = chatId === undefined || chatId === null || chatId === '';
    const url = byDb
      ? `index.php?action=get_chat_details&db_id=${encodeURIComponent(source)}&_=${Date.now()}`
      : `index.php?action=get_chat_details&source=${encodeURIComponent(source)}&chat_id=${encodeURIComponent(chatId)}&_=${Date.now()}`;
    const s = String(source || '').toLowerCase();
    const isWhats = s.startsWith('whats');
    return this._asyncFetchJson(url, {}, isWhats ? 15000 : 8000);
}
    async getContactProfile(source, chatId, dbId = '', { refresh = false } = {}) {
        const dbParam = dbId !== '' && dbId !== null && dbId !== undefined
            ? `&db_id=${encodeURIComponent(dbId)}`
            : '';
        const refreshParam = refresh === true ? '&refresh=1' : '';
        const url = `index.php?action=get_contact_profile&source=${encodeURIComponent(source)}&chat_id=${encodeURIComponent(chatId)}${dbParam}${refreshParam}`;
        const normalizedSource = String(source || '').toLowerCase();
        const isWhats = normalizedSource.startsWith('whats');
        // An initial modal render is cache-only and should be quick. The
        // optional explicit WhatsApp refresh has its own short bridge budget.
        const timeout = refresh && isWhats ? 6500 : isWhats ? 6000 : normalizedSource === 'telegram' ? 16000 : 12000;
        return this._asyncFetchJson(url, {}, timeout);
    }
    async getTelegramDiscussion(chatId, dbId, messageId, before = '') {
        const query = new URLSearchParams({action:'get_telegram_discussion', source:'Telegram', chat_id:String(chatId), db_id:String(dbId), message_id:String(messageId), before:String(before)});
        return this._asyncFetchJson('index.php?' + query, {}, 25000);
    }
    async getMessageSenderProfile(source, userId) {
        const active = new URLSearchParams(window.location.search);
        const query = new URLSearchParams({
            action: 'get_message_sender_profile',
            source: String(source || ''),
            user_id: String(userId || ''),
            chat_id: active.get('chat_id') || '',
            db_id: active.get('db_id') || '',
        });
        return this._asyncFetchJson(`index.php?${query.toString()}`, {}, 12000);
    }
    async getProviderCapabilities(source = '') {
        const url = `index.php?action=get_provider_capabilities${source ? `&source=${encodeURIComponent(source)}` : ''}`;
        return this._asyncFetchJson(url, {}, 8000);
    }
async getLocalMessages(dbId) {
        const url = `index.php?action=get_local_messages&chat_db_id=${encodeURIComponent(dbId)}&_=${Date.now()}`;
        return this._asyncFetchJson(url, {}, 6000);
    }

    _historyWorkerUrl(source, chatId, dbId = '', beforeId = '') {
        const configured = String(window.APP_CONFIG?.historyWorkerUrl || '').trim();
        const token = String(window.APP_CONFIG?.bridgeToken || '').trim();
        if (!configured || !token || window.APP_CONFIG?.bridgeMode !== true) return '';
        try {
            const url = new URL(configured, window.location.href);
            // The PHP bridge emits this URL itself. Keep the client-side check
            // narrow so a malformed page configuration cannot turn a history
            // request into a cross-site request carrying its bridge token.
            if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1'
                || !/^\d+$/.test(url.port) || url.pathname !== '/bridge-history') return '';
            url.searchParams.set('source', String(source || ''));
            url.searchParams.set('chat_id', String(chatId || ''));
            url.searchParams.set('db_id', String(dbId || ''));
            if (beforeId !== '' && beforeId !== null && beforeId !== undefined) {
                url.searchParams.set('before_id', String(beforeId));
            }
            return url.href;
        } catch {
            return '';
        }
    }

    _historyWorkerInit() {
        return {
            headers: {
                'Accept': 'application/json, text/plain, */*',
                'X-Unified-Bridge-Token': String(window.APP_CONFIG?.bridgeToken || '').trim(),
            },
        };
    }

    async _getHistoryPage(source, chatId, dbId, beforeId, fallbackUrl, timeoutMs, isCurrent = null, signal = null) {
        const request = async () => {
        const workerUrl = this._historyWorkerUrl(source, chatId, dbId, beforeId);
        if (workerUrl) {
            try {
                // The history worker has its own PHP process. Give the
                // backend's 15-second cache request enough time, but leave a
                // bounded fallback to the established same-origin route if a
                // local worker is not running yet.
                return await this._asyncFetchJson(workerUrl, { ...this._historyWorkerInit(), signal }, Math.min(timeoutMs, 17000));
            } catch (error) {
                console.debug('[ApiService] Dedicated history worker unavailable; using compatibility route.', error);
            }
        }
        return this._asyncFetchJson(fallbackUrl, { signal }, timeoutMs);
        };
        // Opening another MAX chat must not leave an old queued history read
        // ahead of the chat the person is actually viewing. Other providers
        // keep their existing independent history paths.
        if (String(source || '').toLowerCase() !== 'max') return request();
        const key = [String(chatId || ''), String(dbId || ''), String(beforeId || '')].join(':');
        return maxHistoryQueue.enqueue(key, request, typeof isCurrent === 'function' ? isCurrent : undefined);
    }

    async getInitialMessages(source, chatId, dbId = '', isCurrent = null) {
        const dbParam = dbId !== '' && dbId !== null && dbId !== undefined
            ? `&db_id=${encodeURIComponent(dbId)}`
            : '';
        const url = `index.php?action=get_messages_json&source=${encodeURIComponent(source)}&chat_id=${encodeURIComponent(chatId)}${dbParam}&_=${Date.now()}`;
        const s = String(source || '').toLowerCase();
        const isWhats = s.startsWith('whats');
        const isAvito = s === 'avito';
        // A Telegram history request may briefly wait for the background
        // Madeline sync lock.  Do not turn that wait into a blank chat.
        const data = await this._getHistoryPage(
            source, chatId, dbId, '', url, isWhats ? 25000 : (isAvito ? 9000 : 45000), isCurrent
        );
        return this._normalizeHistoryResponse(data);
    }

    async getOlderMessages(source, chatId, beforeId, dbId = '', isCurrent = null, signal = null) {
        const dbParam = dbId !== '' && dbId !== null && dbId !== undefined
            ? `&db_id=${encodeURIComponent(dbId)}`
            : '';
        const url = `index.php?action=get_messages_json&source=${encodeURIComponent(source)}&chat_id=${encodeURIComponent(chatId)}&before_id=${encodeURIComponent(beforeId)}${dbParam}&_=${Date.now()}`;
        const s = String(source || '').toLowerCase();
        const isWhats = s.startsWith('whats');
        const isAvito = s === 'avito';
        const data = await this._getHistoryPage(
            source, chatId, dbId, beforeId, url, isWhats ? 25000 : (isAvito ? 9000 : 45000), isCurrent, signal
        );
        return this._normalizeHistoryResponse(data);
    }

    async getNewMessages(dbId, sinceTimestamp) {
        const url = `index.php?action=get_new_messages&chat_db_id=${encodeURIComponent(dbId)}&since=${sinceTimestamp}&_=${Date.now()}`;
        return this._asyncFetchJson(url, {}, 20000);
    }

    _telegramRestUrl() {
        const configured = String(window.APP_CONFIG?.telegramUrl || window.APP_CONFIG?.TELEGRAM_API_URL || '').trim();
        const base = configured || 'telegram_service/';
        return new URL('rest.php', base.endsWith('/') ? base : `${base}/`).href;
    }

    async httpClientTG(payload = {}, options = {}) {
        const method = String(options.method || 'GET').toUpperCase();
        const url = new URL(this._telegramRestUrl());
        const init = { ...options, method };
        delete init.method;
        if (method === 'GET') {
            Object.entries(payload || {}).forEach(([key, value]) => {
                if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
            });
        } else {
            init.headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
            init.body = JSON.stringify(payload || {});
        }
        return this._asyncFetchJson(url.href, init, 30000);
    }

    async prefetchTelegramMedia(items = []) {
        if (!Array.isArray(items) || items.length === 0) return { success: false, message: 'no items to prefetch' };
        return this.httpClientTG({ action: 'prefetchMediaBatch', items }, { method: 'POST' });
    }

    async prefetchMediaBatch(source, items = []) {
        if (String(source || '').toLowerCase().startsWith('tele')) {
            return this.prefetchTelegramMedia(items);
        }
        return { success: false, message: 'provider does not use Telegram media prefetch' };
    }
}

export default new ApiService();
