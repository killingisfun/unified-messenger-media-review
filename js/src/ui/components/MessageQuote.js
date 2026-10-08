const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

/** A provider may only know the replied message id; render a useful quote either way. */
export function renderMessageQuote(replyTo) {
  if (!replyTo?.id) return '';
  const author = String(replyTo.author || 'Сообщение');
  const text = String(replyTo.text || 'Ответ на сообщение');
  return `<button type="button" class="message-quote" data-scroll-to-message="${escapeHtml(replyTo.id)}" title="Перейти к сообщению">
    <span class="message-quote-author">${escapeHtml(author)}</span>
    <span class="message-quote-text">${escapeHtml(text)}</span>
  </button>`;
}

export function renderComposerReply(replyTo) {
  if (!replyTo?.id) return '';
  const author = String(replyTo.author || 'Сообщение');
  const text = String(replyTo.text || 'Ответ на сообщение');
  return `<div class="composer-reply" data-reply-id="${escapeHtml(replyTo.id)}">
    <div class="composer-reply-copy"><span>${escapeHtml(author)}</span><small>${escapeHtml(text)}</small></div>
    <button type="button" class="composer-reply-close" data-clear-reply aria-label="Отменить ответ"><i class="bi bi-x-lg"></i></button>
  </div>`;
}
