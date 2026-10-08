import { originalAvatar, hasAvatarPhotoSource, setHeaderAvatar } from '../ui/avatar.js?v=20261004-perf-r1';
import { initConnectionSettings } from './connectionSettings.js?v=20260925-wa-status-recovery';
import { PROVIDERS, getProvider, getFeatureAvailability } from '../domain/providers.js?v=20260920-max-auth-r1';
import { ProviderConnectionState } from '../core/providerConnectionStatus.js';
import { ApiService } from '../core/ApiService.js?v=20261004-perf-r1';
import { icon, fillIcons } from '../ui/icons.js?v=20260921-max-group-services-r6';
import { escapeHtml } from '../ui/components/ChatListItem.js';

// Presentation only: transport, replies and permissions belong to BaseChat.
const byId = id => document.getElementById(id);
const app = byId('app');
const providers = Object.values(PROVIDERS);
let activeCapabilities = null;
const filters = byId('source-filters');
filters.innerHTML = '<button type="button" class="source-filter-all" data-source-filter="" aria-pressed="true">Все</button>' + providers.map(p => `<button type="button" class="source-filter" data-source-filter="${escapeHtml(p.name)}" aria-pressed="false">${escapeHtml(p.name)}</button>`).join('');
byId('welcome-providers').innerHTML = providers.map(p => `<span data-provider="${escapeHtml(p.id)}">${escapeHtml(p.name)}</span>`).join('');
document.querySelector('.provider-count').textContent = `${providers.length} провайдера`;
fillIcons(document);

const applyFilters = () => document.dispatchEvent(new Event('inbox:filter'));
byId('chat-search').addEventListener('input', applyFilters);
document.querySelectorAll('[data-inbox-view]').forEach(button => button.addEventListener('click', () => {
  document.querySelectorAll('[data-inbox-view]').forEach(el => {
    el.classList.toggle('is-active', el === button);
    el.setAttribute('aria-pressed', String(el === button));
  });
  applyFilters();
}));
byId('reset-chat-search').addEventListener('click', () => {
  byId('chat-search').value = '';
  document.querySelector('[data-inbox-view="all"]').click();
  filters.querySelector('button').click();
  byId('chat-search').focus();
});

const { close: closeConnections } = initConnectionSettings();

const infrastructureHealthButton = byId('infrastructure-health-button');
const infrastructureHealthPanel = byId('infrastructure-health-panel');
const infrastructureHealthMessage = byId('infrastructure-health-message');
const infrastructureHealthTime = byId('infrastructure-health-time');
let infrastructureHealth = null;

function formatHealthTime(timestamp) {
  const date = new Date(Number(timestamp || 0) * 1000);
  if (!Number.isFinite(date.getTime()) || date.getTime() <= 0) return 'Время проверки неизвестно';
  return `Последняя проверка: ${date.toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' })}`;
}

function recoverySummary(recovery) {
  if (!recovery || typeof recovery !== 'object') return '';
  const labels = { telegram: 'Telegram', whatsapp: 'WhatsApp', vk: 'VK', avito: 'Avito', max: 'MAX' };
  const parts = [];
  for (const [source, value] of Object.entries(recovery)) {
    if (!value || typeof value !== 'object' || Number(value.chats || 0) === 0) continue;
    const state = String(value.state || 'stale');
    const suffix = state === 'healthy' ? 'свежая' : state === 'restricted' ? 'ограничена' : state === 'unavailable' ? 'нет связи' : 'устарела';
    parts.push(`${labels[source] || source}: ${suffix}`);
  }
  return parts.join(' · ');
}

function renderInfrastructureHealth(payload, unavailable = false) {
  const requestedState = unavailable ? 'stale' : String(payload?.state || 'unknown').toLowerCase();
  const state = ['healthy', 'critical', 'stale'].includes(requestedState) ? requestedState : 'stale';
  const critical = state === 'critical';
  const stale = state === 'stale';
  infrastructureHealth = { state, payload, unavailable };
  infrastructureHealthButton.classList.toggle('is-critical', critical);
  infrastructureHealthButton.classList.toggle('is-healthy', state === 'healthy');
  infrastructureHealthButton.classList.toggle('is-stale', stale);
  infrastructureHealthPanel.classList.toggle('is-critical', critical);
  infrastructureHealthPanel.classList.toggle('is-healthy', state === 'healthy');
  infrastructureHealthPanel.classList.toggle('is-stale', stale);
  const healthIcon = infrastructureHealthButton.querySelector('[data-icon]');
  if (healthIcon) healthIcon.innerHTML = icon(critical ? 'error' : 'health');
  infrastructureHealthButton.title = critical
    ? 'Проблема инфраструктуры'
    : stale
    ? 'Статус проверки сервера устарел'
    : 'Состояние инфраструктуры: всё в норме';
  infrastructureHealthButton.setAttribute('aria-label', infrastructureHealthButton.title);
  infrastructureHealthButton.setAttribute('aria-expanded', String(!infrastructureHealthPanel.hidden));
  infrastructureHealthMessage.textContent = state === 'healthy'
    ? 'Все критичные службы отвечают.'
    : stale
    ? (unavailable
      ? 'Не удалось получить результат проверки сервера. Статус требует повторной проверки.'
      : (String(payload?.message || '').trim() || 'Результат проверки сервера устарел.'))
    : (String(payload?.message || '').trim() || 'Сервер сообщил о критичной проблеме.');
  const recovery = recoverySummary(payload?.history_recovery);
  infrastructureHealthTime.textContent = unavailable
    ? 'Статус не обновлён'
    : [formatHealthTime(payload?.updated_at), recovery].filter(Boolean).join(' · ');
}
async function refreshInfrastructureHealth() {
  if (window.APP_CONFIG?.previewMode === true) return;
  try {
    const payload = await new ApiService().getInfrastructureHealth();
    renderInfrastructureHealth(payload, payload?.success !== true);
  } catch {
    renderInfrastructureHealth(null, true);
  }
}

infrastructureHealthButton?.addEventListener('click', () => {
  if (!infrastructureHealth) return;
  infrastructureHealthPanel.hidden = !infrastructureHealthPanel.hidden;
  infrastructureHealthButton.setAttribute('aria-expanded', String(!infrastructureHealthPanel.hidden));
});
refreshInfrastructureHealth();
window.setInterval(refreshInfrastructureHealth, 60_000);
byId('nav-chats').addEventListener('click', () => { app.classList.remove('chat-open'); byId('chat-search').focus(); });

function setTheme(dark) {
  document.body.classList.toggle('dark', dark);
  byId('theme-toggle').setAttribute('aria-label', dark ? 'Включить светлую тему' : 'Включить тёмную тему');
  byId('theme-toggle').setAttribute('aria-pressed', String(dark));
}
try { setTheme(localStorage.getItem('messenger-theme') === 'dark'); } catch {}
byId('theme-toggle').addEventListener('click', () => {
  const dark = !document.body.classList.contains('dark'); setTheme(dark);
  try { localStorage.setItem('messenger-theme', dark ? 'dark' : 'light'); } catch {}
});

const input = byId('message-input');
const resizeInput = () => { input.style.height = 'auto'; input.style.height = Math.min(150, input.scrollHeight) + 'px'; };
input.addEventListener('input', resizeInput);
input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    if (!byId('send-btn').disabled && (window.currentChat?.canSendFromComposer?.() || input.value.trim() || byId('attachment-input').files.length)) byId('message-form').requestSubmit();
  }
});
byId('message-form').addEventListener('reset', () => requestAnimationFrame(resizeInput));
byId('attach-btn').addEventListener('click', () => byId('attachment-input').click());
// Connection state belongs to a provider adapter, while the composer remains
// shared.  This listener therefore gates only the active provider's composer
// and leaves cached history, other chats and the connection settings usable.
const connectionNotice = document.createElement('div');
connectionNotice.id = 'composer-connection-notice';
connectionNotice.className = 'composer-connection-notice';
connectionNotice.setAttribute('role', 'status');
connectionNotice.setAttribute('aria-live', 'polite');
connectionNotice.hidden = true;
byId('message-form').querySelector('.composer-row')?.before(connectionNotice);

function activeProviderId() {
  return String(document.querySelector('.chat-pane')?.dataset?.provider || '').toLowerCase();
}

function applyWhatsAppConnectionState(connection = window.__waConnectionState || null) {
  const isWhatsAppChat = activeProviderId() === 'whatsapp';
  const state = connection?.state || ProviderConnectionState.CHECKING;
  const blocked = isWhatsAppChat && connection?.canSend !== true;
  const checking = blocked && [ProviderConnectionState.CHECKING, ProviderConnectionState.UNKNOWN].includes(state);
  const preview = window.APP_CONFIG?.previewMode === true;
  const attachState = getFeatureAvailability('WhatsApp', 'attachment', null, activeCapabilities);
  const attachmentAllowed = !preview && attachState.enabled;
  const message = blocked
    ? (connection?.detail || 'WhatsApp временно недоступен.')
    : '';

  document.querySelector('.chat-pane')?.classList.toggle('provider-recovering', isWhatsAppChat && state === ProviderConnectionState.RECOVERING);
  document.querySelector('.chat-pane')?.classList.toggle('provider-connection-error', isWhatsAppChat && state === ProviderConnectionState.ERROR);

  if (isWhatsAppChat) {
    // Initial discovery is not an outage. Drafting stays available, but a
    // send still requires a positively confirmed connection.
    input.disabled = preview || (blocked && !checking);
    byId('send-btn').disabled = preview || blocked;
    byId('send-btn').setAttribute('aria-busy', String(checking));
    byId('send-btn').title = checking ? 'Проверяем подключение…' : 'Отправить сообщение';
    byId('emoji-btn').disabled = preview || (blocked && !checking);
    byId('attach-btn').disabled = preview || (blocked && !checking) || !attachmentAllowed;
    byId('attachment-input').disabled = preview || (blocked && !checking) || !attachmentAllowed;
    input.placeholder = blocked && !checking
      ? (state === ProviderConnectionState.RECOVERING ? 'WhatsApp восстанавливает сеанс…' : 'Отправка WhatsApp временно недоступна')
      : 'Написать сообщение…';
    connectionNotice.hidden = !blocked || checking;
    connectionNotice.textContent = checking ? '' : message;
    return;
  }

  // A WhatsApp outage must never leave the next provider's composer disabled
  // after a chat switch. Reapply the active provider's chat-scoped capability
  // state instead of blindly enabling every control.
  updateComposerAvailability(activeProviderId(), activeCapabilities);
  byId('send-btn').setAttribute('aria-busy', 'false');
  input.placeholder = 'Написать сообщение…';
  connectionNotice.hidden = true;
  connectionNotice.textContent = '';
  document.querySelector('.chat-pane')?.classList.remove('provider-recovering', 'provider-connection-error');
}

window.addEventListener('provider:connection-status', event => {
  const connection = event?.detail;
  if (String(connection?.provider || '').toLowerCase() === 'whatsapp') {
    applyWhatsAppConnectionState(connection);
  }
});

const searchBar = byId('conversation-search-bar');
let conversationSearchMatches = [];
let conversationSearchIndex = -1;
function searchMessages(scroll = false) {
  const query = byId('conversation-search').value.trim().toLocaleLowerCase('ru');
  const matches = [];
  document.querySelectorAll('#messages-container .message').forEach(el => {
    const hit = !!query && (el.querySelector('.text')?.textContent || el.textContent).toLocaleLowerCase('ru').includes(query);
    el.classList.toggle('search-hit', hit); if (hit) matches.push(el);
  });
  conversationSearchMatches = matches;
  conversationSearchIndex = matches.length ? (scroll ? 0 : Math.min(conversationSearchIndex, matches.length - 1)) : -1;
  byId('conversation-search-count').textContent = query ? `В загруженных: ${matches.length}` : '';
  const historyButton = byId('conversation-search-history');
  if (historyButton) historyButton.hidden = !query || !window.currentChat?.hasMoreHistory;
  const prev = byId('conversation-search-prev');
  const next = byId('conversation-search-next');
  if (prev) prev.hidden = matches.length < 2;
  if (next) next.hidden = matches.length < 2;
  if (scroll && matches[0]) matches[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
}
function selectConversationSearchMatch(delta) {
  if (!conversationSearchMatches.length) return;
  conversationSearchIndex = (conversationSearchIndex + delta + conversationSearchMatches.length) % conversationSearchMatches.length;
  conversationSearchMatches.forEach((el, index) => el.classList.toggle('search-hit-current', index === conversationSearchIndex));
  conversationSearchMatches[conversationSearchIndex]?.scrollIntoView({ block: 'center', behavior: 'smooth' });
}
async function searchWholeConversationHistory() {
  const chat = window.currentChat;
  const button = byId('conversation-search-history');
  if (!chat || typeof chat.fetchOlderMessages !== 'function' || chat._fullSearchInFlight) return;
  chat._fullSearchInFlight = true;
  if (button) { button.disabled = true; button.textContent = 'Загружаю историю…'; }
  try {
    let pages = 0;
    while (chat.hasMoreHistory && pages < 200 && chat._isActiveInstance?.()) {
      const before = String(chat.oldestMessageId || '');
      await chat.fetchOlderMessages();
      pages += 1;
      if (before && before === String(chat.oldestMessageId || '') && !chat.hasMoreHistory) break;
    }
    searchMessages(true);
  } finally {
    chat._fullSearchInFlight = false;
    if (button) { button.disabled = false; button.textContent = 'Искать всю историю'; }
    if (!chat.hasMoreHistory && button) button.hidden = true;
  }
}
function closeSearch() {
  searchBar.hidden = true; byId('conversation-search').value = ''; conversationSearchMatches = []; conversationSearchIndex = -1; searchMessages();
  byId('conversation-search-toggle').setAttribute('aria-expanded', 'false');
}
byId('conversation-search-toggle').addEventListener('click', () => {
  searchBar.hidden = !searchBar.hidden;
  byId('conversation-search-toggle').setAttribute('aria-expanded', String(!searchBar.hidden));
  if (!searchBar.hidden) byId('conversation-search').focus(); else closeSearch();
});
byId('conversation-search-close').addEventListener('click', () => { closeSearch(); byId('conversation-search-toggle').focus(); });
byId('conversation-search').addEventListener('input', () => searchMessages(true));
byId('conversation-search-history')?.addEventListener('click', () => { void searchWholeConversationHistory(); });
byId('conversation-search-prev')?.addEventListener('click', () => selectConversationSearchMatch(-1));
byId('conversation-search-next')?.addEventListener('click', () => selectConversationSearchMatch(1));
const area = document.querySelector('.message-area');
const jump = byId('jump-latest');
area.addEventListener('scroll', () => { jump.hidden = area.scrollHeight - area.scrollTop - area.clientHeight < 180; }, { passive: true });
jump.addEventListener('click', () => area.scrollTo({ top: area.scrollHeight, behavior: 'smooth' }));
document.addEventListener('chat:reset', () => { closeSearch(); closeConnections(); jump.hidden = true; });
document.addEventListener('chat:opened', ({ detail }) => {
  const provider = getProvider(detail.source);
  document.querySelector('.chat-pane').dataset.provider = provider.id;
  activeCapabilities = null;
  byId('composer-provider').textContent = provider.name;
  const headerAvatar = byId('chat-avatar');
  const knownAvatar = originalAvatar(detail.avatar_url, detail.avatar);
  const chatKey = `${provider.id}:${String(detail.chat_id ?? detail.chatId ?? detail.id ?? '')}`;
  const reopeningSameChat = headerAvatar.dataset.avatarChatKey === chatKey;
  const keepKnownAvatar = reopeningSameChat && hasAvatarPhotoSource(headerAvatar);
  headerAvatar.dataset.avatarChatKey = chatKey;
  headerAvatar.classList.toggle('avatar-pending', !knownAvatar && !keepKnownAvatar);
  if (!setHeaderAvatar(headerAvatar, knownAvatar)) {
    // A duplicate chat-open event often has only the terse list snapshot.
    // It must not wipe the detailed profile photo that arrived moments ago.
    if (keepKnownAvatar) {
      headerAvatar.classList.remove('avatar-pending');
      delete headerAvatar.dataset.fallback;
      return;
    }
    headerAvatar.onerror = null;
    headerAvatar.src = 'data:image/gif;base64,R0lGODlhAQABAAD/ACwAAAAAAQABAAACADs=';
    headerAvatar.dataset.fallback = '1';
  }
  const context = byId('chat-context-banner');
  // The MAX pin preview is painted asynchronously after history arrives.
  // Clear its provider-specific decoration before a different chat reuses the
  // shared banner for an ordinary context title.
  context.classList.remove('chat-context-banner--pinned');
  delete context.dataset.pinnedMessageId;
  context.hidden = !detail.item_context?.title;
  context.innerHTML = detail.item_context?.title ? `${icon('box')}<strong>${escapeHtml(detail.item_context.title)}</strong>` : '';
  resizeInput();
  updateComposerAvailability(detail.source);
  updateProfileAvailability(detail.source);
  applyWhatsAppConnectionState();
});
function updateComposerAvailability(source, capabilities = null) {
  // Provider permissions may be scoped to one native chat. The composer must
  // use the active chat identity too; otherwise MAX «Избранное» is rendered
  // as unavailable even after its ready capability response arrives.
  const activeChat = window.currentChat;
  const chatContext = activeChat && String(activeChat.source || '').toLowerCase() === String(source || '').toLowerCase()
    ? { chat_id: String(activeChat.chatId ?? '') }
    : null;
  const messageState = getFeatureAvailability(source, 'message', chatContext, capabilities);
  const state = getFeatureAvailability(source, 'attachment', chatContext, capabilities);
  const preview = window.APP_CONFIG?.previewMode === true;
  const canCompose = messageState.enabled;
  byId('message-input').disabled = preview || !canCompose;
  byId('send-btn').disabled = preview || !canCompose;
  byId('attach-btn').disabled = preview || !canCompose || !state.enabled;
  byId('attachment-input').disabled = preview || !canCompose || !state.enabled;
  byId('attach-btn').title = preview
    ? 'Вложения отключены в предпросмотре'
    : (!canCompose ? (messageState.reason || 'Отправка в этом диалоге недоступна') : (state.reason || 'Прикрепить файл'));
  byId('emoji-btn').disabled = preview || !canCompose;
}
function updateProfileAvailability(source, capabilities = null) {
  const contact = getFeatureAvailability(source, 'contact_profile', null, capabilities);
  const self = getFeatureAvailability(source, 'self_profile', null, capabilities);
  for (const [id, state, readyTitle] of [
    ['contact-profile-trigger', contact, 'Сведения о контакте'],
    ['contact-info-btn', self, 'Мой аккаунт'],
  ]) {
    const button = byId(id);
    if (!button) continue;
    button.disabled = !state.enabled;
    button.title = state.enabled ? readyTitle : (state.reason || 'Профиль пока недоступен');
    // The contact trigger contains the visible name, avatar and provider.
    // A missing details endpoint must not make that identity look disabled.
    button.classList.toggle('profile-details-unavailable', id === 'contact-profile-trigger' && !state.enabled);
  }
}
document.addEventListener('chat:capabilities', ({ detail }) => {
  if (String(detail?.source || '').toLowerCase() === activeProviderId()) {
    activeCapabilities = detail?.features || null;
  }
  updateComposerAvailability(detail.source, detail.features);
  updateProfileAvailability(detail.source, detail.features);
  applyWhatsAppConnectionState();
});
document.addEventListener('keydown', e => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); app.classList.remove('chat-open'); byId('chat-search').focus(); }
  if (e.key === 'Escape') { closeConnections(); closeSearch(); }
});
if (window.APP_CONFIG?.previewMode) {
  document.querySelector('.workspace-label').textContent = 'Демонстрация интерфейса';
  document.querySelector('.composer-footer > span').textContent = 'Предпросмотр · сообщения не отправляются';
}
