import { chatAvatar } from '../avatar.js';
import { icon } from '../icons.js?v=20260921-max-group-services-r6';
import { getProvider } from '../../domain/providers.js';
import { messageStateView, messageStates } from '../../core/messageStates.js?v=20260921-chat-list-receipts-r2';

export function subscribeChatListReceipts(getChats) {
  return messageStates.subscribe((source, chatId) => {
    const chats = getChats();
    const index = chats.findIndex(row => String(row.id) === chatId && getProvider(row.source).id === source);
    if (index < 0) return;
    const chat = messageStates.projectChat(chats[index]);
    chats[index] = chat;
    const receipt = document.getElementById(`chat-item-${chatId}`)?.querySelector('.chat-receipt');
    if (receipt) receipt.outerHTML = chatReceiptHTML(chat);
  });
}

export function chatReceiptHTML(chat) {
  if (chat.last_message_direction !== 'out') return '';
  const context = chat.item_context || {};
  const view = messageStateView(chat.source, {
    ack: chat.last_message_ack ?? context.last_message_ack,
    send_state: chat.last_message_send_state ?? context.last_message_send_state,
    is_read: chat.last_message_is_read ?? context.last_message_is_read,
  });
  const iconName = view.state === 'pending' ? 'clock' : view.state === 'failed' ? 'error' : ['delivered', 'read'].includes(view.state) ? 'checkAll' : 'check';
  return `<span class="chat-receipt${view.state === 'read' ? ' is-read' : ''}" title="${view.title}">${icon(iconName)}</span>`;
}

export const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));

export function avatarFor(name = '') {
  const label = String(name).trim();
  const initials = label.startsWith('@')
    ? (Array.from(label.slice(1)).slice(0, 2).join('').toUpperCase() || 'Ч')
    : (label.split(/\s+/).slice(0, 2).map(part => Array.from(part)[0] || '').join('').toUpperCase() || 'Ч');
  const colors = ['#e2ecf8', '#eee4f6', '#f7eadb', '#ddefe8', '#f3e1e5', '#e4e8f8'];
  const seed = Array.from(label).reduce((sum, char) => sum + char.codePointAt(0), 0);
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><rect width="96" height="96" rx="48" fill="${colors[seed % colors.length]}"/><text x="48" y="51" dominant-baseline="middle" text-anchor="middle" fill="#44546a" font-family="Arial,sans-serif" font-size="32" font-weight="600">${escapeHtml(initials)}</text></svg>`)}`;
}

function chatKindFor(chat, providerId) {
  if (providerId === 'max') {
    const type = String(chat.item_context?.max_chat_type || '').trim().toUpperCase();
    if (String(chat.chat_id ?? '') === '0') return { className: 'max-chat-self', badge: 'Я', label: 'Избранное MAX', meta: 'Избранное' };
    if (type === 'DIALOG') return { className: 'max-chat-contact', badge: 'Л', label: 'Личный контакт MAX', meta: 'Личный чат' };
    if (type === 'CHANNEL') return { className: 'max-chat-channel', badge: 'К', label: 'Канал MAX', meta: 'Канал' };
    if (type === 'CHAT' || type === 'GROUP') return { className: 'max-chat-group', badge: 'Г', label: 'Группа MAX', meta: 'Группа' };
    return { className: 'max-chat-unknown', badge: '?', label: 'Тип диалога MAX не определён', meta: 'MAX' };
  }
  if (providerId === 'vk') {
    const context = chat.item_context || {};
    const type = String(context.vk_chat_kind || chat.debug_chat_kind || '').toLowerCase();
    const archived = context.vk_archived === true || Number(context.vk_folder_id) === 1;
    if (archived) return { className: 'vk-chat-archive', badge: 'А', label: 'Архив VK', meta: 'Архив' };
    if (type === 'group') return { className: 'vk-chat-group', badge: 'Г', label: 'Группа VK', meta: 'Группа' };
    return null;
  }
  if (providerId !== 'telegram') return null;
  const context = chat.item_context || {};
  const type = String(context.telegram_chat_kind || chat.debug_chat_kind || '').toLowerCase();
  const archived = context.telegram_archived === true || Number(context.telegram_folder_id) === 1;
  const prefix = 'telegram-chat-';
  if (archived) return { className: `${prefix}archive`, badge: 'А', label: 'Архив Telegram', meta: 'Архив' };
  if (type === 'group') return { className: `${prefix}group`, badge: 'Г', label: 'Группа Telegram', meta: 'Группа' };
  if (type === 'channel') return { className: `${prefix}channel`, badge: 'К', label: 'Канал Telegram', meta: 'Канал' };
  if (type === 'bot') return { className: `${prefix}bot`, badge: 'Б', label: 'Бот Telegram', meta: 'Бот' };
  return null;
}

export function createChatListItem(chat, unread = false, allowDelete = true) {
  // The existing delete endpoint is intentionally not exposed through the
  // authenticated bridge yet. Do not render a control that cannot work.
  const deleteAvailable = false;
  const provider = getProvider(chat.source);
  const name = String(chat.name || 'Без имени');
  const params = new URLSearchParams({ source: chat.source || '', chat_id: String(chat.chat_id ?? ''), title: name, db_id: String(chat.id) });
  if (chat.item_context?.title) params.set('item_title', chat.item_context.title);
  const date = new Date(Number(chat.last_message_time || 0) * 1000);
  const today = new Date();
  const time = date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
  let preview = String(chat.last_message_text || '').trim();
  if (/^(data:|\/9j\/|iVBORw0|R0lGODlh|UklGR)/.test(preview) || (preview.length > 200 && /^[A-Za-z0-9+/=]+$/.test(preview))) preview = 'Изображение';
  if (!preview) preview = 'Вложение';
  const prefix = chatReceiptHTML(chat);
  const serviceEvent = String(chat.last_message_service_event || chat.item_context?.last_message_service_event || '').toLowerCase();
  const rawServiceStyle = String(chat.last_message_event_style || chat.item_context?.last_message_event_style || '').toLowerCase();
  // The list consumes the same small, provider-neutral vocabulary as
  // BaseChat's centered event pill. Unknown future styles intentionally use
  // the neutral notice presentation instead of creating an arbitrary class.
  const serviceStyle = ['membership', 'pin', 'call', 'notice'].includes(rawServiceStyle)
    ? rawServiceStyle
    : (/pin/.test(serviceEvent) ? 'pin' : /call/.test(serviceEvent) ? 'call' : /leave|remove|join|add|invite/.test(serviceEvent) ? 'membership' : 'notice');
  const serviceIcon = serviceStyle === 'pin' ? icon('pin')
    : serviceStyle === 'call' ? icon('phone')
    : serviceStyle === 'membership' ? icon('users')
    : icon('info');
  const servicePrefix = chat.last_message_is_service ? `<span class="chat-service-preview event-style-${serviceStyle}" title="Служебное событие группы">${serviceIcon}</span>` : '';
  const fallback = avatarFor(name);
  const avatarVersion = String(chat.avatar_version || chat.item_context?.max_avatar_version || chat.item_context?.avatar_version || '');
  const avatar = chatAvatar(chat);
  const context = chat.item_context?.title ? `<span class="chat-item-context">${icon('box')}${escapeHtml(chat.item_context.title)}</span>` : '';
  const chatKind = chatKindFor(chat, provider.id);
  const kindBadge = chatKind ? `<span class="avatar-chat-kind" title="${escapeHtml(chatKind.label)}" aria-label="${escapeHtml(chatKind.label)}">${chatKind.badge}</span>` : '';
  const kindMeta = chatKind ? `<span class="chat-kind-label ${chatKind.className}" title="${escapeHtml(chatKind.label)}">${escapeHtml(chatKind.meta)}</span>` : '';
  return `<a href="?${escapeHtml(params)}" id="chat-item-${escapeHtml(chat.id)}"
    class="list-group-item list-group-item-action chat-row${unread ? ' unread' : ''}"
    data-timestamp="${Number(chat.last_message_time || 0)}" data-source="${escapeHtml(chat.source)}"
    data-db-id="${escapeHtml(chat.id)}" data-chat-id="${escapeHtml(chat.chat_id)}" data-provider="${escapeHtml(provider.id)}"
    data-search="${escapeHtml(`${name} ${preview} ${chat.item_context?.title || ''}`.toLocaleLowerCase('ru'))}">
    <span class="chat-avatar-wrap${chatKind ? ` ${chatKind.className}` : ''}"><img class="chat-avatar" src="${escapeHtml(avatar || fallback)}" loading="lazy" alt="" decoding="async" onerror="this.onerror=null;this.src=this.dataset.fallback" data-fallback="${escapeHtml(fallback)}" data-avatar-src="${escapeHtml(avatar)}" data-avatar-version="${escapeHtml(avatarVersion)}">${kindBadge}<span class="avatar-provider" title="${escapeHtml(provider.name)}">${escapeHtml(provider.short || provider.name.slice(0, 2))}</span></span>
    <span class="chat-row-content"><span class="chat-row-top"><span class="chat-title">${escapeHtml(name)}</span><time class="chat-time">${escapeHtml(time)}</time></span>
    <span class="chat-row-preview">${prefix}${servicePrefix}<span class="chat-text${chat.last_message_is_service ? ' is-service-preview' : ''}">${escapeHtml(preview)}</span><span class="unread-dot" aria-label="Непрочитанный диалог"></span></span>
    <span class="chat-row-meta"><span class="source-badge">${escapeHtml(provider.name)}</span>${kindMeta}${context}</span></span>
    ${deleteAvailable && allowDelete ? `<button type="button" class="delete-chat-btn" title="Удалить чат" aria-label="Удалить чат ${escapeHtml(name)}" data-source="${escapeHtml(chat.source)}" data-chat-id="${escapeHtml(chat.chat_id)}" data-db-id="${escapeHtml(chat.id)}" data-name="${escapeHtml(name)}">${icon('close')}</button>` : ''}
  </a>`;
}
