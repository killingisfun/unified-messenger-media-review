// Telegram login flow: phone -> code -> optional 2FA password.
// The settings panel is assembled by another module, so initialization must
// also work when this module is evaluated after DOMContentLoaded.
function initTelegramAuth() {
  if (window.__tgAuthInitialized) return;
  window.__tgAuthInitialized = true;
  const isPreviewMode = window.APP_CONFIG?.previewMode === true
    || new URLSearchParams(window.location.search).get('preview') === '1';
  if (isPreviewMode) return;

  const bridgeHeaders = (headers = {}) => {
    const token = String(window.APP_CONFIG?.bridgeToken || '').trim();
    return token ? { ...headers, 'X-Unified-Bridge-Token': token } : headers;
  };
  const button = document.getElementById('tg-login-btn');
  const logout = document.getElementById('tg-logout-btn');
  const modalEl = document.getElementById('telegramAuthModal');
  const startChatModalEl = document.getElementById('tgStartChatModal');
  const phone = document.getElementById('tg-auth-phone');
  const code = document.getElementById('tg-auth-code');
  const password = document.getElementById('tg-auth-password');
  const send = document.getElementById('tg-auth-send');
  const restart = document.getElementById('tg-auth-restart');
  const result = document.getElementById('tg-auth-result');
  const phoneStep = document.getElementById('tg-auth-phone-step');
  const codeStep = document.getElementById('tg-auth-code-step');
  const passwordStep = document.getElementById('tg-auth-password-step');
  if (!button || !modalEl || !phone || !code || !password || !send || !restart || !result || !phoneStep || !codeStep || !passwordStep) return;

  const modal = bootstrap.Modal.getOrCreateInstance(modalEl, { backdrop: 'static', keyboard: false });
  const show = (ok, text) => {
    result.className = `small mt-3 ${ok ? 'text-success' : 'text-danger'}`;
    result.textContent = text;
  };
  const setStep = (name) => {
    phoneStep.hidden = name !== 'phone';
    codeStep.hidden = name !== 'code';
    passwordStep.hidden = name !== 'password';
    modalEl.querySelectorAll('[data-tg-step]').forEach((step) => {
      step.classList.toggle('is-active', step.dataset.tgStep === name);
    });
  };
  const request = async (payload) => {
    const response = await fetch('telegram_auth.php', {
      method: 'POST',
      headers: bridgeHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
      body: JSON.stringify(payload),
    });
    const body = await response.json().catch(() => ({}));
    if (!response.ok || body.status === 'error') throw new Error(body.message || `HTTP ${response.status}`);
    return body;
  };

  let statusTimer = null;
  let connected = false;
  const stopStatus = () => {
    if (statusTimer) window.clearInterval(statusTimer);
    statusTimer = null;
  };
  const setSettingsOptions = (hidden) => {
    document.querySelectorAll('[data-telegram-auth-options]').forEach((options) => { options.hidden = hidden; });
  };
  const markConnected = () => {
    connected = true;
    button.classList.add('service-status--connected');
    button.innerHTML = '<i class="bi bi-telegram fs-5" aria-hidden="true"></i><span><span class="service-label">Telegram</span><span class="service-state">Подключён</span></span>';
    button.title = 'Telegram подключён. Нажмите, чтобы начать новый диалог.';
    if (logout) logout.style.display = 'inline-flex';
    setSettingsOptions(true);
  };
  const markDisconnected = () => {
    connected = false;
    button.classList.remove('service-status--connected');
    button.innerHTML = '<i class="bi bi-telegram fs-5" aria-hidden="true"></i><span><span class="service-label">Telegram</span><span class="service-state">Не подключён</span></span>';
    button.title = 'Подключить Telegram';
    if (logout) logout.style.display = 'none';
    setSettingsOptions(false);
  };
  const checkStatus = async () => {
    try {
      const response = await fetch('telegram_auth.php', {
        method: 'POST',
        headers: bridgeHeaders({ 'Content-Type': 'application/json', Accept: 'application/json' }),
        body: JSON.stringify({ action: 'status' }),
      });
      const body = await response.json().catch(() => ({}));
      const status = String(body.status || '').toUpperCase();
      if (status === 'WAITING_CODE') {
        stopStatus();
        setStep('code'); code.disabled = false; password.disabled = true; send.disabled = false;
        send.dataset.action = 'resend_code'; send.textContent = 'Получить код повторно';
        restart.classList.remove('d-none'); code.focus();
        show(true, 'Код отправлен. Проверьте Telegram и введите его.');
      } else if (status === 'WAITING_PASSWORD') {
        stopStatus(); setStep('password'); code.disabled = true; password.disabled = false;
        restart.classList.remove('d-none'); password.focus();
        show(true, 'Введите пароль двухэтапной защиты Telegram.');
      } else if (status === 'CONNECTED') {
        stopStatus(); markConnected(); show(true, 'Telegram подключён.');
        window.setTimeout(() => modal.hide(), 500);
        if (window.reloadChats) window.reloadChats('Telegram');
      } else if (status === 'ERROR') {
        stopStatus(); setStep('phone'); send.disabled = false; code.disabled = true; password.disabled = true;
        restart.classList.remove('d-none'); show(false, body.message || 'Telegram не выполнил запрос. Попробуйте ещё раз.');
      } else if (status === 'REQUESTING') {
        setStep('phone'); send.disabled = true; show(true, 'Запрос передан Telegram. Обычно это занимает несколько секунд…');
      } else {
        markDisconnected();
      }
    } catch (_) {
      // Keep the current state visible and let the next bounded poll collect it.
    }
  };
  const beginStatus = () => {
    stopStatus();
    void checkStatus();
    statusTimer = window.setInterval(() => { void checkStatus(); }, 1500);
  };
  const openAuth = () => {
    window.dispatchEvent(new Event('connection-settings:close'));
    setStep('phone');
    phone.disabled = false; code.disabled = true; password.disabled = true;
    send.disabled = false; send.dataset.action = 'send_code'; send.textContent = 'Получить код';
    restart.classList.add('d-none'); result.textContent = '';
    modal.show(); phone.focus();
    void checkStatus();
  };
  const submitCode = async () => {
    if (!code.value.trim() || code.disabled) return;
    code.disabled = true; show(true, 'Проверяем код…');
    try {
      await request({ action: 'complete_code', code: code.value.trim() });
      show(true, 'Проверяем код в Telegram…'); beginStatus();
    } catch (error) { code.disabled = false; show(false, error.message); }
  };
  const submitPassword = async () => {
    if (!password.value || password.disabled) return;
    password.disabled = true; show(true, 'Проверяем пароль Telegram…');
    try { await request({ action: 'complete_2fa', password: password.value }); beginStatus(); }
    catch (error) { password.disabled = false; show(false, error.message); }
  };

  button.addEventListener('click', (event) => {
    event.preventDefault();
    if (connected) {
      if (startChatModalEl) bootstrap.Modal.getOrCreateInstance(startChatModalEl).show();
      return;
    }
    openAuth();
  });
  document.querySelectorAll('[data-telegram-auth]').forEach((control) => control.addEventListener('click', openAuth));
  logout?.addEventListener('click', async (event) => {
    event.preventDefault();
    if (!confirm('Выйти из сессии Telegram? История чатов останется.')) return;
    logout.disabled = true;
    try { await request({ action: 'logout' }); markDisconnected(); }
    catch (error) { show(false, error.message); }
    finally { logout.disabled = false; }
  });
  send.addEventListener('click', async () => {
    const value = phone.value.trim();
    if (!value) return show(false, 'Введите номер Telegram.');
    code.disabled = true; password.disabled = true; restart.classList.add('d-none');
    send.disabled = true; show(true, 'Запрашиваем код у Telegram…');
    const action = send.dataset.action || 'send_code';
    try {
      await request({ action, phone: value });
      show(true, action === 'resend_code' ? 'Запрашиваем новый код…' : 'Запрос номера принят. Ожидаем Telegram…');
      beginStatus();
    } catch (error) { show(false, error.message); send.disabled = false; }
  });
  restart.addEventListener('click', () => {
    stopStatus(); setStep('phone'); send.dataset.action = 'send_code'; send.textContent = 'Получить код';
    send.disabled = false; code.value = ''; code.disabled = true; password.value = ''; password.disabled = true;
    restart.classList.add('d-none'); phone.focus(); show(true, 'Введите номер и запросите новый код.');
  });
  code.addEventListener('change', submitCode);
  code.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void submitCode(); } });
  password.addEventListener('change', submitPassword);
  password.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); void submitPassword(); } });
  modalEl.addEventListener('hidden.bs.modal', stopStatus);
  void checkStatus();
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initTelegramAuth, { once: true });
} else {
  initTelegramAuth();
}
