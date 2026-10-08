/** A native profile dialog can sit above another modal without losing its draft. */
export async function showSenderProfileDialog(chat, sender, parent) {
  const dialog = document.createElement('dialog');
  dialog.className = 'discussion-dialog sender-profile-dialog';
  dialog.setAttribute('aria-label', 'Профиль участника');
  dialog.innerHTML = '<header><strong>Профиль участника</strong><button type="button" aria-label="Закрыть профиль">×</button></header><section class="sender-profile-content"><h3></h3><dl></dl><p role="status">Загрузка…</p></section>';
  const focus = document.activeElement;
  const close = () => { dialog.close(); dialog.remove(); };
  dialog.querySelector('button').onclick = close;
  parent.addEventListener('close', close, {once:true});
  dialog.addEventListener('close', () => { dialog.remove(); parent.removeEventListener('close', close); if(focus?.isConnected) focus.focus(); }, {once:true});
  dialog.querySelector('h3').textContent = sender.sender_name || 'Участник';
  document.body.append(dialog); dialog.showModal();
  const status = dialog.querySelector('[role=status]');
  try {
    const response = await chat.api.getMessageSenderProfile(chat.source, String(sender.sender_id));
    if (!dialog.isConnected) return;
    if (!response?.success || !response.profile) throw Error('unavailable');
    const profile = response.profile;
    dialog.querySelector('h3').textContent = profile.name || sender.sender_name || 'Участник';
    const avatarUrl = chat._safeRemoteUrl(profile.avatar || sender.sender_avatar || '');
    if (avatarUrl) {
      const image = document.createElement('img'); image.className = 'sender-profile-avatar'; image.src = avatarUrl; image.alt = ''; image.onerror = () => image.remove();
      dialog.querySelector('.sender-profile-content').prepend(image);
    }
    const fields = dialog.querySelector('dl');
    for (const field of profile.fields || []) {
      const label = document.createElement('dt'), value = document.createElement('dd');
      label.textContent = field.label || ''; value.textContent = field.value || ''; fields.append(label, value);
    }
    status.textContent = profile.notice || (fields.children.length ? '' : 'Нет дополнительных публичных сведений.');
  } catch { if (dialog.isConnected) status.textContent = 'Дополнительные сведения сейчас недоступны.'; }
}
