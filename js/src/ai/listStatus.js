import { request } from './api.js?v=20260924-audit-r14';
import { publishAiStatuses } from './statusStore.js?v=20260924-audit-r14';

const POLL_MS = 15000;
const STALE_MS = POLL_MS * 3;
let cache = {}, settings = {}, busy = false, lastSuccessAt = 0, loading = true;

export function statusLabel(c, config, now = Date.now() / 1000, stale = false) {
  if (stale) return { text: 'AI: статус не обновлён', kind: 'stale', title: 'Последняя проверка AI устарела. Состояние диалога неизвестно.' };
  const mode = c.mode === 'default' ? config.channels?.[c.source]?.mode : c.mode;
  const allowed = c.auto_reply === 'enabled' || ((c.auto_reply || 'inherit') === 'inherit' && c.chat_scope === 'private');
  if (c.queue_state === 'queued') return { text: 'AI в очереди', kind: 'queued', title: 'Сообщение зарегистрировано и ожидает обработки AI' };
  if (['delayed', 'blocked', 'unknown', 'failed'].includes(c.queue_state)) {
    const operation = String(c.queue_request_id || '').trim();
    return { text: 'AI: нужна проверка', kind: 'handoff', title: `AI-задача задержана, завершилась с ошибкой или имеет неизвестный результат${operation ? `. Операция: ${operation}` : ''}` };
  }
  if (Number(c.thinking_until) > now) return { text: 'AI работает…', kind: 'working', title: 'AI подготавливает контекст и ответ' };
  if (c.state === 'MANUAL_REQUIRED') return { text: 'Нужен менеджер', kind: 'handoff', title: 'AI передал диалог оператору' };
  if (!allowed || !config.enabled || !config.channels?.[c.source]?.enabled || mode === 'manual' || c.state === 'MANUAL') {
    return c.last_ai_reply_at ? { text: 'AI ответил', kind: 'past', title: 'AI отвечал ранее; сейчас автоматические ответы выключены' } : null;
  }
  if (c.last_ai_reply_at) return { text: 'AI ответил', kind: 'replied', title: c.state === 'FIRST_REPLIED' ? 'Первый ответ AI отправлен; дальше отвечает оператор' : 'AI уже отвечал; автоматические ответы включены' };
  return { text: 'Под AI', kind: 'active', title: 'Автоматические ответы включены для этого чата' };
}

function isStale() { return !lastSuccessAt || Date.now() - lastSuccessAt > STALE_MS; }

function paint() {
  const stale = isStale();
  for (const row of document.querySelectorAll('.chat-row[data-db-id]')) {
    const value = cache[row.dataset.dbId];
    const status = value ? statusLabel(value, settings, Date.now() / 1000, stale) : null;
    const group = status ? (status.kind === 'handoff' ? 'manager' : ['working', 'queued', 'active'].includes(status.kind) ? 'working' : status.kind) : '';
    if (row.dataset.aiGroup !== group) row.dataset.aiGroup = group;
    let badge = row.querySelector('.ai-list-status');
    if (!status) { badge?.remove(); continue; }
    if (!badge) { badge = document.createElement('span'); badge.className = 'ai-list-status'; row.querySelector('.chat-row-meta')?.append(badge); }
    if (badge.textContent !== status.text) badge.textContent = status.text;
    if (badge.dataset.kind !== status.kind) badge.dataset.kind = status.kind;
    if (badge.title !== status.title) badge.title = status.title;
  }
  document.dispatchEvent(new Event('inbox:filter'));
  publishAiStatuses({ chats: cache, settings, stale, loading, updatedAt: lastSuccessAt });
}

async function refresh() {
  if (busy || document.hidden) return;
  busy = true;
  try {
    // The backend owns the workspace selection and has an explicit cap. This
    // does not depend on the order or number of rows already in the DOM.
    const data = await request('statuses', { all: true });
    cache = data.chats || {}; settings = data; lastSuccessAt = Date.now(); loading = false; paint();
  } catch {
    // Cached values are useful as a loading snapshot only. paint() changes
    // them to an explicit stale state after the freshness budget expires.
    loading = false; paint();
  } finally { busy = false; }
}

if (typeof document !== 'undefined') {
  let queued = false;
  new MutationObserver((records) => {
    if (!records.some((record) => [...record.addedNodes].some((node) => node.nodeType === 1 && (node.matches?.('.chat-row') || node.querySelector?.('.chat-row'))))) return;
    if (!queued) { queued = true; queueMicrotask(() => { queued = false; paint(); }); }
  }).observe(document.body, { childList: true, subtree: true });
  document.querySelectorAll('[data-inbox-view]').forEach((button) => button.addEventListener('click', () => {
    const ai = button.dataset.inboxView === 'ai';
    document.getElementById('ai-inbox-filters').hidden = !ai;
    document.body.classList.toggle('ai-inbox-open', ai);
  }));
  for (const id of ['ai-status-filter', 'ai-source-filter']) document.getElementById(id)?.addEventListener('change', () => document.dispatchEvent(new Event('inbox:filter')));
  // Status badges are secondary to the first chat-list/history paint. The
  // bridge is single-worker on local installs, so starting this full AI queue
  // scan beside chat bootstrap delays every provider's visible data.
  window.setTimeout(() => { void refresh(); }, 5500);
  setInterval(refresh, POLL_MS);
}
