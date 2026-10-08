/** Logout is possible only after a deliberate confirmation in this dialog. */
export function initConnectionLogout(panels, preview) {
  const dialog = document.createElement('dialog');
  dialog.className = 'connection-confirm';
  dialog.setAttribute('aria-labelledby', 'connection-confirm-title');
  dialog.innerHTML = `<h3 id="connection-confirm-title"></h3><p data-description></p><p data-error role="alert"></p><div><button type="button" data-cancel>Отмена</button><button type="button" data-confirm>Выйти</button></div>`;
  document.body.append(dialog);
  let selected = null, busy = false, opener = null;
  panels.addEventListener('click', event => {
    const button = event.target.closest('[data-provider-logout]');
    if (!button || preview) return;
    selected = button.dataset.providerLogout; opener = button;
    const title = {telegram:'Telegram',whatsapp:'WhatsApp',max:'MAX',vk:'VK',avito:'Avito'}[selected];
    dialog.querySelector('h3').textContent = `Выйти из ${title}?`;
    dialog.querySelector('[data-description]').textContent = ['vk','avito'].includes(selected)
      ? 'Вы уверены? Сохранённые параметры подключения и токены этого сервиса будут удалены. Для подключения потребуется ввести их заново. История сообщений останется; её можно очистить отдельно.'
      : 'Вы уверены? Сессия этого сервиса будет отключена. Для подключения потребуется повторный вход. История сообщений останется.';
    dialog.querySelector('[data-error]').textContent = '';
    dialog.showModal(); dialog.querySelector('[data-cancel]').focus();
  });
  dialog.querySelector('[data-cancel]').onclick = () => { if (!busy) dialog.close(); };
  dialog.addEventListener('cancel', event => { if (busy) event.preventDefault(); });
  dialog.addEventListener('close', () => opener?.focus());
  dialog.querySelector('[data-confirm]').onclick = async () => {
    if (busy || !selected || preview) return;
    busy = true; dialog.querySelectorAll('button').forEach(b=>b.disabled=true);
    const routes = {telegram:'telegram_auth.php',whatsapp:'wpp_proxy.php?action=logout',max:'max_auth.php',vk:'provider_logout.php',avito:'provider_logout.php'};
    try {
      const response = await fetch(routes[selected], {method:'POST',headers:{'Content-Type':'application/json','X-Unified-Bridge-Token':String(window.APP_CONFIG?.bridgeToken || '')},body:JSON.stringify({action:'logout',provider:selected,confirmed:true})});
      const data = await response.json();
      if (!response.ok || data.success === false || ['error','failed'].includes(data.status)) throw Error(data.message || 'Не удалось выйти. Состояние подключения не подтверждено.');
      window.clearUnifiedChatListCache?.();
      panels.querySelector(`[data-provider-form="${selected}"]`)?.reset();
      dialog.close(); location.reload();
    } catch(error) { dialog.querySelector('[data-error]').textContent=error.message || 'Не удалось выйти.'; }
    finally { busy=false; dialog.querySelectorAll('button').forEach(b=>b.disabled=false); }
  };
}
