// QR authorisation for the isolated MAX sidecar.  It intentionally owns no
// sync/send operation: the only browser-visible calls are a status poll and
// the explicit start/password actions below.
function initMaxAuth() {
  if (window.__maxAuthInitialized) return;
  window.__maxAuthInitialized = true;
  if (window.APP_CONFIG?.previewMode === true || new URLSearchParams(location.search).get('preview') === '1') return;

  const modalElement = document.getElementById('maxAuthModal');
  const qrBox = document.getElementById('max-auth-qr');
  const stateBox = document.getElementById('max-auth-state');
  const passwordPanel = document.getElementById('max-auth-password-panel');
  const passwordInput = document.getElementById('max-auth-password');
  const passwordButton = document.getElementById('max-auth-password-submit');
  const logoutButton = document.getElementById('max-logout-btn');
  if (!modalElement || !qrBox || !stateBox || !passwordPanel || !passwordInput || !passwordButton) return;

  const modal = bootstrap.Modal.getOrCreateInstance(modalElement, { backdrop: 'static', keyboard: false });
  let timer = null;
  let closeTimer = null;
  let requestInFlight = null;
  let active = false;
  let connected = false;

  const bridgeHeaders = (headers = {}) => {
    const token = String(window.APP_CONFIG?.bridgeToken || '').trim();
    return token ? { ...headers, 'X-Unified-Bridge-Token': token } : headers;
  };
  const setState = (text, kind = 'muted') => {
    stateBox.className = `small mt-3 ${kind === 'error' ? 'text-danger' : kind === 'success' ? 'text-success' : 'text-muted'}`;
    stateBox.textContent = text;
  };
  const setSettingsState = (text, connectedState = false) => {
    document.querySelectorAll('[data-provider="max"] .service-state').forEach(el => { el.textContent = text; });
    document.querySelectorAll('[data-provider="max"] .service-status').forEach(el => el.classList.toggle('is-connected', connectedState));
  };
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  const schedule = (delay = 2000) => {
    stop();
    if (active) timer = setTimeout(() => { void refresh(); }, delay);
  };
  const call = async (payload = null) => {
    const init = payload === null ? {
      method: 'GET', headers: bridgeHeaders({ Accept: 'application/json' }), cache: 'no-store',
    } : {
      method: 'POST', headers: bridgeHeaders({ Accept: 'application/json', 'Content-Type': 'application/json' }),
      body: JSON.stringify(payload), cache: 'no-store',
    };
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 12_000);
    try {
      const response = await fetch('max_auth.php', { ...init, signal: controller.signal });
      const data = await response.json().catch(() => ({}));
      if (!response.ok || data?.success === false) throw new Error(data?.message || `HTTP ${response.status}`);
      return data;
    } finally { clearTimeout(timeout); }
  };
  const render = (data) => {
    const status = String(data?.status || 'error');
    passwordPanel.hidden = status !== 'password_required';
    connected = status === 'connected';
    setSettingsState(connected ? 'Подключён, сессия работает' : status === 'disconnected' ? 'Не подключён' : status === 'authorizing' ? 'Проверка сессии…' : 'Ошибка подключения', connected);
    if (logoutButton) logoutButton.style.display = connected ? 'inline-flex' : 'none';
    document.querySelectorAll('[data-max-auth="qr"]').forEach(button => { button.hidden = connected; });
    if (status === 'connected') {
      qrBox.replaceChildren();
      setState('MAX подключён. Подготавливаем чтение диалогов.', 'success');
      stop();
      window.dispatchEvent(new CustomEvent('max-auth:connected'));
      if (active && !closeTimer) closeTimer = setTimeout(() => { closeTimer = null; modal.hide(); }, 650);
      return;
    }
    if (status === 'qr_ready' && typeof data.qrcode === 'string' && data.qrcode.startsWith('data:image/svg+xml;base64,')) {
      const image = new Image();
      image.src = data.qrcode; image.alt = 'QR-код MAX'; image.width = 250; image.height = 250;
      qrBox.replaceChildren(image);
      setState('Откройте MAX на телефоне и отсканируйте QR-код.');
      schedule();
      return;
    }
    qrBox.replaceChildren();
    if (status === 'password_required') {
      setState('Для этого аккаунта нужен пароль двухэтапной проверки.');
      passwordInput.focus();
      schedule();
      return;
    }
    if (status === 'authorizing') {
      qrBox.innerHTML = '<div class="spinner-border" role="status" aria-label="Подключение"></div>';
      setState('Подготавливаем QR-код MAX…');
      schedule();
      return;
    }
    if (status === 'disconnected') {
      setState('Нажмите «Получить QR-код», чтобы начать подключение.');
      return;
    }
    qrBox.replaceChildren();
    setState('Не удалось подготовить подключение MAX. Попробуйте получить новый QR-код.', 'error');
  };
  const refresh = () => {
    if (requestInFlight) return requestInFlight;
    requestInFlight = call().then(render).catch(() => {
      setState('Служба MAX временно не отвечает. Сеанс не сбрасывался.', 'error');
      schedule(5000);
    }).finally(() => { requestInFlight = null; });
    return requestInFlight;
  };
  const begin = async () => {
    active = true;
    passwordPanel.hidden = true;
    passwordInput.value = '';
    qrBox.innerHTML = '<div class="spinner-border" role="status" aria-label="Подготовка QR-кода"></div>';
    setState('Подготавливаем защищённое подключение MAX…');
    try { render(await call({ action: 'start' })); } catch { render({ status: 'error' }); }
  };

  document.querySelectorAll('[data-max-auth="qr"]').forEach((button) => button.addEventListener('click', () => {
    if (connected) return;
    window.dispatchEvent(new Event('connection-settings:close'));
    modal.show();
    void begin();
  }));
  passwordButton.addEventListener('click', async () => {
    const value = passwordInput.value;
    if (!value) { setState('Введите пароль двухэтапной проверки.', 'error'); return; }
    passwordButton.disabled = true;
    try { render(await call({ action: 'password', password: value })); }
    catch (error) { setState(error?.message || 'Не удалось передать пароль.', 'error'); }
    finally { passwordInput.value = ''; passwordButton.disabled = false; }
  });
  logoutButton?.addEventListener('click', async () => {
    if (!window.confirm('Выйти из MAX и удалить сохранённую сессию?')) return;
    logoutButton.disabled = true;
    try { render(await call({ action: 'logout' })); } finally { logoutButton.disabled = false; }
  });
  passwordInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') { event.preventDefault(); passwordButton.click(); } });
  modalElement.addEventListener('hidden.bs.modal', () => { active = false; stop(); if (closeTimer) clearTimeout(closeTimer); closeTimer = null; passwordInput.value = ''; });
  // A status check must never start authentication or generate a QR code.
  void refresh();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initMaxAuth, { once: true });
else initMaxAuth();
