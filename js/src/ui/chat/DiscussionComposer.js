const inFlight = new Set();

/** Text composer scoped to a channel post, independent of the active chat draft. */
export class DiscussionComposer {
  constructor(chat, postId, host, onAccepted) {
    this.chat = chat;
    this.postId = postId;
    this.key = `discussion-draft:v1:${chat.chatDbId}:${chat.chatId}:${postId}`;
    this.state = { text: '', requestId: '', outcome: '' };
    try { Object.assign(this.state, JSON.parse(sessionStorage.getItem(this.key) || '{}')); } catch {}
    if (this.state.outcome === 'pending' && !inFlight.has(this.key)) this.state.outcome = 'unknown';
    host.innerHTML = '<form class="discussion-composer"><textarea aria-label="Комментарий" rows="2" maxlength="4096" placeholder="Написать комментарий…"></textarea><button type="submit">Отправить</button><p role="status" aria-live="polite"></p><button type="button" class="discussion-resolve" hidden>Я проверил комментарии — начать новый</button></form>';
    this.form = host.querySelector('form');
    this.input = host.querySelector('textarea');
    this.button = host.querySelector('button');
    this.status = host.querySelector('[role=status]');
    this.resolve = host.querySelector('.discussion-resolve');
    this.resolve.onclick = () => {
      this.state = {text:'', requestId:'', outcome:''}; this.input.value = ''; this.status.textContent = ''; this.save(); this.paint();
    };
    const sync = event => {
      if (event.detail !== this.key) return;
      try { this.state = JSON.parse(sessionStorage.getItem(this.key)); } catch { return; }
      this.input.value = this.state.text; this.paint();
    };
    document.addEventListener('discussion:send-state', sync);
    host.closest('dialog')?.addEventListener('close', () => document.removeEventListener('discussion:send-state', sync), {once:true});
    this.input.value = this.state.text;
    this.input.oninput = () => { this.state.text = this.input.value; this.save(); this.paint(); };
    this.form.onsubmit = event => { event.preventDefault(); void this.send(onAccepted); };
    this.input.onkeydown = event => {
      if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.isComposing) {
        event.preventDefault(); this.form.requestSubmit();
      }
    };
    this.paint();
  }
  save() { try { sessionStorage.setItem(this.key, JSON.stringify(this.state)); } catch {} }
  paint() {
    if (this.state.outcome === 'accepted') this.status.textContent = 'Комментарий принят Telegram.';
    const unresolved = ['pending', 'unknown'].includes(this.state.outcome);
    this.resolve.hidden = this.state.outcome !== 'unknown';
    this.input.disabled = unresolved;
    this.button.disabled = unresolved || !this.input.value.trim();
    if (unresolved) this.status.textContent = this.state.outcome === 'pending'
      ? 'Отправка комментария…' : 'Результат отправки неизвестен. Обновите комментарии, чтобы проверить. Текст сохранён; повторная отправка заблокирована.';
  }
  async send(onAccepted) {
    if (this.button.disabled) return;
    this.state.requestId = crypto.randomUUID();
    inFlight.add(this.key);
    this.state.outcome = 'pending'; this.save(); this.paint();
    const data = new FormData();
    for (const [key, value] of Object.entries({action:'send_telegram_comment', source:'Telegram',
      chat_id:this.chat.chatId, chat_db_id:this.chat.chatDbId, message_id:this.postId,
      message:this.state.text, client_request_id:this.state.requestId})) data.set(key, String(value));
    try {
      const result = await this.chat.api.sendMessage(data);
      if (!result?.success || result.outcome !== 'accepted') throw Object.assign(new Error(result?.message || 'Комментарий не принят.'), {outcome:result?.outcome || 'unknown'});
      this.state = {text:'', requestId:'', outcome:'accepted'}; this.input.value = '';
      this.status.textContent = 'Комментарий принят Telegram.';
      this.save(); this.paint();
      try { await onAccepted(); } catch { /* Accepted sends stay accepted if refreshing fails. */ }
    } catch (error) {
      // Never create another request for an ambiguous provider outcome.
      this.state.outcome = error?.outcome === 'rejected' ? 'rejected' : 'unknown';
      this.status.textContent = error?.message || 'Не удалось отправить комментарий.';
      this.save(); this.paint();
    } finally {
      inFlight.delete(this.key);
      document.dispatchEvent(new CustomEvent('discussion:send-state', {detail:this.key}));
    }
  }
}
