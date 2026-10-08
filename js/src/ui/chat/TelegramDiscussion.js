import { DiscussionComposer } from './DiscussionComposer.js?v=20261002-discussion-root-r12';
import { showSenderProfileDialog } from '../components/SenderProfileDialog.js?v=20260923-telegram-delete-r11';

/** Discussion view isolated from the active chat and its read state. */
export class TelegramDiscussion {
  constructor(chat) { this.chat = chat; this.dialog = null; }
  close() { this.dialog?.close(); this.dialog?.remove(); this.dialog = null; }
  async open(message) {
    if (String(this.chat.source).toLowerCase() !== 'telegram' || message?.discussion?.enabled !== true) return;
    this.close();
    const dialog = document.createElement('dialog');
    dialog.className = 'discussion-dialog';
    dialog.setAttribute('aria-label', 'Комментарии к посту');
    dialog.innerHTML = '<header><strong>Комментарии</strong><button class="discussion-refresh" type="button">Обновить</button><button type="button" aria-label="Закрыть">×</button></header><div class="discussion-scroll"><section class="discussion-post"></section><button class="discussion-more" type="button" hidden>Загрузить предыдущие</button><section class="discussion-comments"></section><p role="status"></p></div><footer></footer>';
    this.dialog = dialog; document.body.append(dialog);
    const previousFocus = document.activeElement;
    dialog.querySelector('header button[aria-label]').onclick = () => this.close();
    dialog.addEventListener('close', () => { dialog.remove(); if (this.dialog === dialog) this.dialog = null; if(previousFocus?.isConnected) previousFocus.focus(); }, {once:true});
    const post = dialog.querySelector('.discussion-post');
    const heading = document.createElement('strong'); heading.textContent = this.chat.chatTitle || 'Пост канала'; post.append(heading);
    const text = document.createElement('p'); text.textContent = message.text || 'Публикация с вложением'; post.append(text);
    const attachments = document.createElement('div'); post.append(attachments);
    this.addAttachments(attachments, message.attachments);
    const comments = dialog.querySelector('.discussion-comments'), status = dialog.querySelector('.discussion-scroll [role=status]'), more = dialog.querySelector('.discussion-more');
    const ids = new Set(), records = new Map(); let cursor = '', failedCursor = '', rootId = '', total = 0, busy = false, refreshQueued = false;
    const commentId = (comment) => String(comment?.id || '');
    const replyId = (comment) => String(comment?.reply_to_message_id ?? comment?.replyTo?.id ?? '');
    const authorName = (comment) => String(comment?.sender_name || '').trim()
      || (String(comment?.sender_id || '').startsWith('-100') ? this.chat.chatTitle : 'Участник');
    const updateReplyContexts = () => {
      comments.querySelectorAll('.discussion-comment[data-reply-id]').forEach((article) => {
        const target = article.dataset.replyId || '', reply = records.get(target), quote = article.querySelector('.discussion-reply-context');
        if (!quote) return;
        quote.textContent = reply
          ? `↳ ${authorName(reply)}: ${String(reply.text || 'Вложение').replace(/\s+/g, ' ').slice(0, 120)}`
          : (target === rootId ? '↳ Ответ на публикацию' : '↳ Ответ на комментарий');
        quote.disabled = !reply;
      });
    };
    const makeArticle = (comment) => {
      const id = commentId(comment), article = document.createElement('article'); article.className = 'discussion-comment'; article.id = `discussion-comment-${id}`; article.dataset.commentId = id;
      const parent = replyId(comment); if (parent) article.dataset.replyId = parent;
      const author = document.createElement(comment.sender_id ? 'button' : 'strong'); author.textContent = authorName(comment);
      if (comment.sender_id) { author.type = 'button'; author.className = 'discussion-author'; author.onclick = () => showSenderProfileDialog(this.chat, comment, dialog); }
      const avatarUrl = this.chat._safeRemoteUrl(comment.sender_avatar || '');
      if (avatarUrl) { const avatar=document.createElement('img');avatar.className='discussion-avatar';avatar.src=avatarUrl;avatar.alt='';avatar.loading='lazy';avatar.onerror=()=>avatar.remove();article.append(avatar); }
      article.append(author);
      if (parent) { const quote = document.createElement('button'); quote.type = 'button'; quote.className = 'discussion-reply-context'; quote.onclick = () => { const target = document.getElementById(`discussion-comment-${parent}`); if (target) { target.scrollIntoView({block:'center'}); target.classList.add('discussion-comment-target'); window.setTimeout(() => target.classList.remove('discussion-comment-target'), 1300); } }; article.append(quote); }
      const body = document.createElement('p'); body.textContent = comment.text || ''; article.append(body); this.addAttachments(article, comment.attachments); return article;
    };
    const paintPager = () => {
      more.hidden = !cursor; more.textContent = cursor ? `Загрузить предыдущие${total > ids.size ? ` · ещё ${Math.max(0, total - ids.size)}` : ''}` : '';
      status.textContent = ids.size === 0 ? 'Комментариев пока нет' : (total > ids.size ? `Показано ${ids.size} из ${total} комментариев` : `Комментарии · ${ids.size}`);
    };
    const load = async ({ before = '', refresh = false } = {}) => {
      if (busy) { refreshQueued ||= refresh; return; } busy = true; more.disabled = true; status.textContent = 'Загрузка комментариев…';
      const requestedBefore = String(before || '');
      try {
        const response = await this.chat.api.getTelegramDiscussion(this.chat.chatId, this.chat.chatDbId, String(message.discussion.post_id || message.id), requestedBefore);
        if (this.dialog !== dialog || !this.chat._isActiveInstance()) return;
        if (!response?.success) throw Error('unavailable');
        const page = response.discussion || {}, fragment = document.createDocumentFragment();
        rootId = String(page.root_id || rootId); total = Math.max(total, Number.parseInt(page.count, 10) || 0);
        for (const comment of page.items || []) {
          const id = commentId(comment); if (!id || ids.has(id)) continue; ids.add(id); records.set(id, comment); fragment.append(makeArticle(comment));
        }
        if (requestedBefore) comments.prepend(fragment); else comments.append(fragment);
        const next = String(page.nextCursor || ''); cursor = next && next !== requestedBefore ? next : ''; failedCursor = ''; updateReplyContexts(); paintPager();
        if (refresh) { const scroll = dialog.querySelector('.discussion-scroll'); scroll.scrollTop = scroll.scrollHeight; }
      } catch { if (this.dialog === dialog) { failedCursor = requestedBefore; more.hidden = !failedCursor; more.textContent = failedCursor ? 'Повторить загрузку предыдущих' : ''; status.textContent = 'Не удалось загрузить комментарии. Повторите попытку.'; } }
      finally {
        busy = false; more.disabled = false;
        if (refreshQueued && this.dialog === dialog) { refreshQueued = false; void load({ refresh: true }); }
      }
    };
    more.onclick = () => load({ before: cursor || failedCursor });
    dialog.querySelector('.discussion-refresh').onclick = () => load({ refresh: true });
    new DiscussionComposer(this.chat, String(message.discussion.post_id || message.id), dialog.querySelector('footer'), () => load({ refresh: true }));
    dialog.showModal(); await load();
  }
  addAttachments(host, attachments = []) {
    for (const attachment of attachments || []) {
      if (String(attachment?.type || '').toLowerCase() === 'poll') {
        const card = document.createElement('section'); card.className = 'discussion-poll';
        const question = document.createElement('strong'); question.textContent = String(attachment.question || 'Опрос'); card.append(question);
        const options = Array.isArray(attachment.options) ? attachment.options.slice(0, 20) : [];
        const total = Math.max(Number.parseInt(attachment.total_voters, 10) || 0, options.reduce((sum, option) => sum + Math.max(0, Number.parseInt(option?.voters, 10) || 0), 0));
        for (const option of options) {
          const row = document.createElement('div'); row.className = `discussion-poll-option${option?.chosen === true ? ' is-chosen' : ''}`;
          const label = document.createElement('span'); label.textContent = String(option?.text || '');
          const votes = Math.max(0, Number.parseInt(option?.voters, 10) || 0);
          const result = document.createElement('small'); result.textContent = total ? `${Math.round(votes * 100 / total)}% · ${votes}` : '—';
          const bar = document.createElement('i'); bar.style.width = `${total ? Math.round(votes * 100 / total) : 0}%`;
          row.append(label, result, bar); card.append(row);
        }
        const meta = document.createElement('small'); meta.className = 'discussion-poll-meta'; meta.textContent = `${attachment.closed ? 'Опрос завершён' : 'Опрос'} · ${total} ${total === 1 ? 'голос' : (total >= 2 && total <= 4 ? 'голоса' : 'голосов')}`;
        card.append(meta); host.append(card); continue;
      }
      const url = this.chat._safeRemoteUrl(attachment.url || attachment.public_url || ''); if (!url) continue;
      const link = document.createElement('a'); link.href = url; link.target = '_blank'; link.rel = 'noopener noreferrer';
      link.textContent = attachment.filename || attachment.title || 'Открыть вложение';
      if (attachment.type === 'photo') { const image=document.createElement('img');image.className='discussion-photo';image.src=url;image.alt=link.textContent;image.loading='lazy';link.replaceChildren(image); }
      host.append(link);
    }
  }
}
