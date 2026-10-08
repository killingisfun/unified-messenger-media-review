const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

export function telegramContext(chat) {
  if (String(chat?.source || '').toLowerCase() !== 'telegram') return null;
  let context = chat.item_context ?? chat.item_context_json ?? {};
  if (typeof context === 'string') { try { context = JSON.parse(context); } catch { context = {}; } }
  return context && typeof context === 'object' ? context : {};
}

export function chatSection(chat) {
  const context = telegramContext(chat);
  if (!context) return 'main';
  if (context.telegram_archived === true || Number(context.telegram_folder_id) === 1) return 'archive';
  const kind = context.telegram_chat_kind;
  return kind === 'group' ? 'groups' : kind === 'channel' ? 'channels' : 'main';
}

export function telegramFolders(chats) {
  const folders = new Map();
  for (const chat of chats) {
    for (const folder of telegramContext(chat)?.telegram_folders || []) {
      if (!/^\d+$/.test(String(folder.id)) || Number(folder.id) < 2) continue;
      if (!folders.has(String(folder.id))) folders.set(String(folder.id), String(folder.title || 'Папка'));
    }
  }
  return folders;
}

export function inTelegramFolder(chat, folderId) {
  if (!folderId) return true;
  return (telegramContext(chat)?.telegram_folders || []).some(folder => String(folder.id) === folderId && folder.included === true);
}

/** One selected Telegram view, one flat list. Other providers keep their own semantics. */
export function renderChatSections(chats, { renderRow, renderRows, selectedFolder = '', selectedView = 'all', telegramOnly = true, aiView = false }) {
  if(aiView)return (renderRows || (items=>items.map(renderRow).join('')))(chats);
  const folders = telegramFolders(chats);
  const selected = telegramOnly && folders.has(selectedFolder) ? selectedFolder : '';
  const personal = chat => {
    const context = telegramContext(chat);
    return chatSection(chat) === 'main' && (context?.telegram_chat_kind === 'contact' ||
      (!context?.telegram_chat_kind && !String(chat.chat_id || '').startsWith('-')));
  };
  const matches = (chat, view) => view === 'all' ? chatSection(chat) !== 'archive'
    : view === 'personal' ? personal(chat) : chatSection(chat) === view;
  const telegram = chats.filter(chat => telegramContext(chat) !== null);
  const visible = telegramOnly
    ? telegram.filter(chat => selected ? inTelegramFolder(chat, selected) : matches(chat, selectedView))
    : chats.filter(chat => !telegramContext(chat) || personal(chat));
  const rows = renderRows || (items => items.map(renderRow).join(''));
  let html = '';
  if (telegramOnly) {
    html = '<nav class="telegram-navigation" aria-label="Разделы Telegram"><div class="chat-folder-buttons">';
    for (const [view, title] of [['all','Все чаты'],['personal','Личные'],['groups','Группы'],['channels','Каналы'],['archive','Архив']]) {
      const count = telegram.filter(chat => matches(chat, view)).length;
      html += `<button type="button" data-telegram-view="${view}" aria-pressed="${!selected && view === selectedView}">${title}<span class="telegram-view-count">${count}</span></button>`;
    }
    html += '</div>';
    if (folders.size) {
      html += '<div class="chat-folder-buttons telegram-custom-folders" aria-label="Папки Telegram">';
      for (const [id, title] of folders) {
        html += `<button type="button" data-telegram-folder="${escape(id)}" aria-pressed="${id === selected}">${escape(title)}</button>`;
      }
      html += '</div>';
    }
    html += '</nav>';
  }
  return html + rows(visible);
}
