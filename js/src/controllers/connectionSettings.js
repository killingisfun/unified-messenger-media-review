import { initConnectionLogout } from './connectionLogout.js?v=20260923-logout-r1';
import { PROVIDERS } from '../domain/providers.js?v=20260923-connections-r2';
import { ApiService } from '../core/ApiService.js';
import { escapeHtml } from '../ui/components/ChatListItem.js';

// This is connection guidance for the installed adapters, not a second secret store.
const setup = {
  telegram: {
    method: 'Вход по номеру телефона',
    description: 'Введите номер, подтвердите код из Telegram и, если включена двухэтапная проверка, пароль.',
    steps: ['Подготовьте номер телефона и доступ к Telegram.', 'Нажмите на карточку подключения ниже.', 'Подтвердите код и дождитесь статуса подключения.'],
    fields: [['Адрес сервиса Telegram', 'TELEGRAM_API_URL'], ['Идентификатор приложения', 'TELEGRAM_API_ID'], ['Ключ приложения', 'TELEGRAM_API_HASH']],
    webhook: 'webhook_telegram.php',
  },
  whatsapp: {
    method: 'QR-код или привязка по номеру',
    description: 'Подключите WhatsApp как связанное устройство. В существующем окне входа доступны QR-код и код привязки.',
    steps: ['Откройте WhatsApp на телефоне.', 'Нажмите на карточку подключения и выберите способ входа.', 'Подтвердите привязку в разделе «Связанные устройства».'],
    fields: [['Адрес WPPConnect', 'WPPCONNECT_API_URL'], ['Секретный ключ WPPConnect', 'WPPCONNECT_SECRET_KEY'], ['Адрес для входящих событий', 'WPPCONNECT_WEBHOOK_URL']],
    webhook: 'webhook_wppconnect.php',
  },
  vk: {
    method: 'Подключение через API',
    description: 'Текущий адаптер использует токен VK из серверной конфигурации. Ввод и сохранение токена через браузер пока не подключены.',
    steps: ['Подготовьте токен с доступом к нужным сообщениям.', 'Передайте параметры администратору для настройки сервера.', 'Настройте входящие события и проверьте появление диалогов.'],
    fields: [['Токен доступа', 'VK_ACCESS_TOKEN'], ['Версия API', 'VK_API_VERSION']],
    webhook: 'webhook_vk.php',
  },
  avito: {
    method: 'Подключение аккаунта через API',
    description: 'Текущий адаптер использует Client ID, Client Secret и ID аккаунта. Эти параметры задаются на сервере.',
    steps: ['Подготовьте данные приложения и ID аккаунта Avito.', 'Передайте параметры администратору для настройки сервера.', 'Настройте входящие события для этого аккаунта.'],
    fields: [['Идентификатор приложения', 'AVITO_CLIENT_ID'], ['Секрет приложения', 'AVITO_CLIENT_SECRET'], ['ID аккаунта', 'AVITO_ACCOUNT_ID'], ['Адрес API', 'AVITO_API_URL']],
    webhook: 'webhook_avito.php',
  },
  max: {
    method: 'Вход по QR-коду личного аккаунта',
    description: 'Подключите личный аккаунт MAX, чтобы читать диалоги и отвечать на сообщения в общем интерфейсе.',
    steps: ['Откройте MAX на телефоне.', 'Нажмите «Показать QR-код».', 'Отсканируйте код в приложении MAX и дождитесь подтверждения.'],
    fields: [['Внутренний сервис MAX', 'MAX_PORT=8091'], ['Каталог сессии', 'runtime/max'], ['Версия транспорта', 'maxapi-python==2.4.1']],
  },
};

const capabilityLabels = Object.freeze({
  reply: 'Ответы', reaction: 'Реакции', attachment: 'Вложения',
  photo: 'Фотографии', video: 'Видео', document: 'Документы', voice: 'Голосовые', album: 'Альбомы',
  edit: 'Редактирование', delete: 'Удаление', read_receipts: 'Статусы прочтения',
  profile: 'Профиль', self_profile: 'Мой профиль', contact_profile: 'Профиль контакта', presence: 'Присутствие',
});

export function initConnectionSettings() {
  const overlay = document.getElementById('connections-panel');
  const tabs = document.getElementById('settings-provider-tabs');
  const panels = document.getElementById('settings-provider-panels');
  const preview = window.APP_CONFIG?.previewMode === true;
  const providers = Object.values(PROVIDERS);
  let selected = providers[0]?.id;
  let opener;
  const api = new ApiService();
  const renderCapabilities = (panel, features) => {
    const entries = Object.entries(features || {});
    panel.querySelector('.settings-capabilities').innerHTML = entries.map(([key, value]) => {
      const label = capabilityLabels[key] || key;
      const state = typeof value === 'object' ? value?.state : value;
      const ready = state === 'ready';
      const reason = typeof value === 'object' ? value?.reason : '';
      const constraints = typeof value === 'object' && value?.constraints ? value.constraints : null;
      const limit = constraints?.max_files ? `До ${escapeHtml(constraints.max_files)} файлов` : '';
      return `<div class="settings-capability ${ready ? 'is-ready' : ''}"><span>${escapeHtml(label)}</span><span title="${escapeHtml(reason || '')}">${ready ? 'Доступно' : 'Не подключено'}</span>${reason ? `<small>${escapeHtml(reason)}</small>` : ''}${limit ? `<small>${limit}</small>` : ''}</div>`;
    }).join('');
  };
  for (const provider of providers) {
    const info = setup[provider.id] || { method: 'Серверное подключение', description: 'Параметры этого адаптера задаются администратором.', steps: [], fields: [] };
    const tab = document.createElement('button');
    tab.type = 'button'; tab.id = `settings-tab-${provider.id}`;
    tab.dataset.provider = provider.id; tab.setAttribute('role', 'tab');
    tab.setAttribute('aria-controls', `settings-panel-${provider.id}`);
    tab.innerHTML = `<i class="bi ${escapeHtml(provider.icon)}" aria-hidden="true"></i><span>${escapeHtml(provider.name)}</span>`;
    tabs.append(tab);
    const panel = document.createElement('section');
    panel.id = `settings-panel-${provider.id}`; panel.className = 'settings-provider-panel';
    panel.dataset.provider = provider.id; panel.setAttribute('role', 'tabpanel');
    panel.setAttribute('aria-labelledby', tab.id);
    const authOptions = provider.id === 'whatsapp'
      ? `<div class="settings-auth-options" data-whatsapp-auth-options hidden aria-label="Способ входа в WhatsApp">
          <p class="settings-auth-options__title">Выберите способ входа</p>
          <div class="settings-auth-options__buttons">
            <button type="button" class="btn btn-outline-success" data-whatsapp-auth="qr"><i class="bi bi-qr-code" aria-hidden="true"></i> Показать QR-код</button>
            <button type="button" class="btn btn-outline-success" data-whatsapp-auth="phone"><i class="bi bi-phone" aria-hidden="true"></i> Получить код</button>
          </div>
        </div>`
      : provider.id === 'telegram'
        ? `<div class="settings-auth-options" data-telegram-auth-options aria-label="Вход в Telegram">
            <p class="settings-auth-options__title">Подключите аккаунт Telegram</p>
            <div class="settings-auth-options__buttons">
              <button type="button" class="btn btn-outline-primary" data-telegram-auth="phone"><i class="bi bi-phone" aria-hidden="true"></i> Войти по номеру</button>
            </div>
          </div>`
      : provider.id === 'max'
        ? `<div class="settings-auth-options" data-max-auth-options aria-label="Вход в MAX">
            <p class="settings-auth-options__title">Подключите личный аккаунт MAX</p>
            <div class="settings-auth-options__buttons">
              <button type="button" class="btn btn-outline-dark" data-max-auth="qr"><i class="bi bi-qr-code" aria-hidden="true"></i> Показать QR-код</button>
            </div>
          </div>`
      : '';
    const editable = provider.id === 'vk' || provider.id === 'avito';
    const settingsForm = editable ? `<form class="provider-settings-form" data-provider-form="${provider.id}"><h4>Параметры подключения</h4>${info.fields.map(([label,name]) => `<label class="form-label small">${escapeHtml(label)}<input class="form-control form-control-sm" name="${escapeHtml(name)}" type="${/secret|token/i.test(name) ? 'password' : 'text'}" autocomplete="off"></label>`).join('')}<button class="btn btn-primary btn-sm" type="submit">Сохранить и проверить</button><span class="small text-muted" data-form-status></span></form>` : '';
    panel.innerHTML = `<div class="settings-provider-heading"><span class="settings-provider-icon"><i class="bi ${escapeHtml(provider.icon)}" aria-hidden="true"></i></span><div><h3>${escapeHtml(provider.name)}</h3><p>${escapeHtml(info.method)}</p></div></div>
      <p class="settings-description">${escapeHtml(info.description)}</p>
      <div class="settings-account"></div>
      <div class="settings-maintenance"><p class="small text-muted">Очистка удаляет только сообщения и чаты из локальной БД. Сессия подключения сохраняется.</p><button type="button" class="btn btn-outline-secondary btn-sm" data-clear-provider="${escapeHtml(provider.id)}"><i class="bi bi-trash3"></i> Очистить локальный кэш</button></div>
      ${authOptions}
      ${settingsForm}
      <details class="settings-parameters"><summary>Как подключить</summary><ol class="settings-steps">${info.steps.map(step => `<li>${escapeHtml(step)}</li>`).join('')}</ol></details>
      <details class="settings-parameters"><summary>Возможности сервиса</summary><div class="settings-capabilities"></div></details>`;
    panels.append(panel);
    const controls = document.querySelector(`#settings-existing-controls [data-provider="${provider.id}"]`);
    if (controls) {
      panel.querySelector('.settings-account').append(controls);
      controls.querySelectorAll('.service-logout').forEach(button => button.remove());
    }
    const logout = document.createElement('button');
    logout.type = 'button'; logout.className = 'service-logout';
    logout.dataset.providerLogout = provider.id; logout.textContent = 'Выйти';
    logout.setAttribute('aria-label', `Выйти из ${provider.name}`);
    panel.querySelector('.settings-account').append(logout);
    renderCapabilities(panel, provider.features);
    tab.addEventListener('click', () => select(provider.id));
  }
  if (preview) {
    panels.querySelectorAll('.service-status button, button.service-status, .service-logout').forEach(el => { el.disabled = true; });
    panels.querySelectorAll('.service-state').forEach(el => { el.textContent = 'Демонстрационный режим'; });
  }
  function select(id) {
    selected = id;
    tabs.querySelectorAll('[role="tab"]').forEach(el => {
      const active = el.dataset.provider === id;
      el.setAttribute('aria-selected', String(active)); el.tabIndex = active ? 0 : -1;
    });
    panels.querySelectorAll('[role="tabpanel"]').forEach(el => { el.hidden = el.dataset.provider !== id; });
    const provider = PROVIDERS[id];
    if (!overlay.hidden && provider) {
      api.getProviderCapabilities(provider.name).then(data => {
        if (data?.provider?.features) renderCapabilities(document.getElementById(`settings-panel-${id}`), data.provider.features);
      }).catch(() => {});
    }
  }
  initConnectionLogout(panels, preview);
  select(selected);
  function close(restoreFocus = false) {
    overlay.hidden = true;
    document.querySelectorAll('[data-open-connections]').forEach(el => el.setAttribute('aria-expanded', 'false'));
    if (restoreFocus) opener?.focus();
  }
  document.querySelectorAll('[data-open-connections]').forEach(button => button.addEventListener('click', () => {
    opener = button; overlay.hidden = false; select(selected);
    document.querySelectorAll('[data-open-connections]').forEach(el => el.setAttribute('aria-expanded', 'true'));
    tabs.querySelector('[aria-selected="true"]')?.focus();
  }));
  document.getElementById('connections-close').addEventListener('click', () => close(true));
  window.addEventListener('connection-settings:close', () => close());
  overlay.addEventListener('click', e => { if (e.target === overlay) close(true); });
  panels.addEventListener('click', async e => {
    if (e.target.closest('#login-btn, #tg-login-btn, [data-max-auth]') && !preview) close();
    const clear = e.target.closest('[data-clear-provider]');
    if (!clear || preview) return;
    const source = ({telegram:'Telegram',whatsapp:'WhatsApp',vk:'VK',avito:'Avito',max:'MAX'})[clear.dataset.clearProvider];
    if (!source || !window.confirm(`Удалить сообщения и чаты ${source} из локальной БД? Подключение останется.`)) return;
    clear.disabled = true;
    try { const r=await fetch(`index.php?action=clear_provider_cache&source=${encodeURIComponent(source)}`,{method:'POST',headers:{'Accept':'application/json'}}); const d=await r.json(); if(!d.success) throw Error(d.message||'Ошибка'); clear.textContent='Кэш очищен'; window.dispatchEvent(new Event('chat:reset')); } catch(err) { clear.textContent='Не удалось очистить'; } finally { clear.disabled=false; }
  });
  panels.addEventListener('submit', async e => {
    const form = e.target.closest('[data-provider-form]'); if (!form) return; e.preventDefault();
    const data = new URLSearchParams(new FormData(form)); data.set('action','save_provider_settings'); data.set('provider',form.dataset.provider);
    const status=form.querySelector('[data-form-status]'); try { const r=await fetch('index.php',{method:'POST',body:data}); const out=await r.json(); if(!out.success) throw Error(out.message); status.textContent='Параметры сохранены'; } catch(err) { status.textContent=err.message||'Не удалось сохранить'; }
  });
  overlay.addEventListener('keydown', e => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); }
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key) && e.target.matches('[role="tab"]')) {
      e.preventDefault(); const items = [...tabs.children]; const current = items.indexOf(e.target);
      const index = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : (current + (['ArrowRight', 'ArrowDown'].includes(e.key) ? 1 : -1) + items.length) % items.length;
      items[index].click(); items[index].focus();
    }
    if (e.key === 'Tab') {
      const items = [...overlay.querySelectorAll('button:not(:disabled), [tabindex="0"], summary, a[href], input, select, textarea')].filter(el => el.getClientRects().length && el.tabIndex >= 0);
      const first = items[0], last = items.at(-1);
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); }
      if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); }
    }
  });
  return { close };
}
