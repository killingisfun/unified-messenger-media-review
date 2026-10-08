import {
  describeProviderConnection,
  providerConnectionRetryDelay,
  ProviderConnectionState,
} from '../core/providerConnectionStatus.js';

// WhatsApp authorization for the restored UI.
// This uses the current server-side WPPConnect bridges so a phone-code request
// never races with QR initialization.
window.__waAuthControlled = true;
function initWhatsAppAuth() {
  if (window.__waAuthInitialized) return;
  window.__waAuthInitialized = true;
  const isPreviewMode = window.APP_CONFIG?.previewMode === true
    || new URLSearchParams(window.location.search).get('preview') === '1';
  if (isPreviewMode) return;

  const bridgeHeaders = (headers = {}) => {
    const token = String(window.APP_CONFIG?.bridgeToken || '').trim();
    return token ? { ...headers, 'X-Unified-Bridge-Token': token } : headers;
  };

  const login = document.getElementById('login-btn');
  const logout = document.getElementById('logout-btn');
  const modalElement = document.getElementById('whatsappQrModal');
  const qrTab = document.getElementById('wa-auth-qr-tab');
  const phoneTab = document.getElementById('wa-auth-phone-tab');
  const qrPanel = document.getElementById('wa-auth-qr-panel');
  const phonePanel = document.getElementById('wa-auth-phone-panel');
  const qrBox = document.getElementById('qr-code-container');
  const phone = document.getElementById('wa-link-phone');
  const requestCode = document.getElementById('wa-link-code-btn');
  const result = document.getElementById('wa-link-code-result');
  if (!login || !modalElement || !qrTab || !phoneTab || !qrPanel || !phonePanel || !qrBox || !phone || !requestCode || !result) return;

  const modal = bootstrap.Modal.getOrCreateInstance(modalElement, { backdrop: 'static', keyboard: false });
  let mode = null;
  let poll = null;
  let healthTimer = null;
  let refreshInFlight = null;
  let refreshFailures = 0;
  let isConnected = false;
  let currentConnection = describeProviderConnection('whatsapp');
  let lastPublishedConnection = '';
  // Ignore responses from polls that were started before a newer response
  // established the connection. Without this, a late QR response could
  // overwrite the connected state after the phone had already linked.
  let refreshGeneration = 0;

  const setConnectionUi = (connection) => {
    const next = connection || describeProviderConnection('whatsapp');
    const wasConnected = isConnected;
    isConnected = next.connected === true;
    currentConnection = next;
    const snapshot = { ...next, updatedAt: Date.now() };
    window.__waConnected = isConnected;
    window.__waConnectionState = snapshot;
    window.__providerConnectionStates = {
      ...(window.__providerConnectionStates || {}),
      whatsapp: snapshot,
    };

    login.classList.toggle('service-status--connected', isConnected);
    login.classList.toggle('service-status--recovering', next.state === ProviderConnectionState.RECOVERING);
    login.classList.toggle('service-status--checking', next.state === ProviderConnectionState.CHECKING);
    login.classList.toggle('service-status--error', next.state === ProviderConnectionState.ERROR);
    login.dataset.connectionState = next.state;
    login.title = isConnected
      ? 'WhatsApp подключён. Нажмите, чтобы начать новый диалог.'
      : next.detail;
    login.setAttribute('aria-label', `WhatsApp: ${next.label}`);
    login.innerHTML = `<i class="bi bi-whatsapp fs-5" aria-hidden="true"></i><span><span class="service-label">WhatsApp</span><span class="service-state" aria-live="polite">${next.label}</span></span>`;
    if (logout) logout.style.display = isConnected ? 'inline-flex' : 'none';
    document.querySelectorAll('[data-whatsapp-auth-options]').forEach((options) => {
      options.hidden = next.state !== ProviderConnectionState.OFFLINE;
    });

    const fingerprint = [next.state, next.rawStatus, next.label, next.detail, next.canSend].join('|');
    if (fingerprint !== lastPublishedConnection || wasConnected !== isConnected) {
      lastPublishedConnection = fingerprint;
      window.dispatchEvent(new CustomEvent('provider:connection-status', { detail: snapshot }));
    }
    // List presentation must not turn a successful status response into an
    // auth failure or prevent the next health check from being scheduled.
    try {
      window.setWhatsappConnected?.(isConnected);
    } catch (error) {
      console.warn('[WhatsApp] Chat list status update failed', error);
    }
  };

  const setMode = (next) => {
    mode = next;
    qrPanel.classList.toggle('d-none', next !== 'qr');
    phonePanel.classList.toggle('d-none', next !== 'phone');
    qrTab.classList.toggle('btn-success', next === 'qr');
    qrTab.classList.toggle('btn-outline-success', next !== 'qr');
    phoneTab.classList.toggle('btn-success', next === 'phone');
    phoneTab.classList.toggle('btn-outline-success', next !== 'phone');
    if (next !== 'qr') qrBox.innerHTML = '';
    if (next === 'phone') phone.focus();
  };

  const stopPolling = () => {
    if (poll) window.clearInterval(poll);
    poll = null;
  };

  const clearHealthTimer = () => {
    if (healthTimer) window.clearTimeout(healthTimer);
    healthTimer = null;
  };

  const scheduleHealthCheck = (delay = null) => {
    clearHealthTimer();
    const wait = delay ?? providerConnectionRetryDelay(currentConnection, refreshFailures);
    if (!wait || mode === 'qr' || mode === 'phone') return;
    healthTimer = window.setTimeout(() => {
      healthTimer = null;
      if (document.hidden) {
        scheduleHealthCheck(wait);
        return;
      }
      void refresh();
    }, wait);
  };

  const showConnected = (connection) => {
    const wasConnected = isConnected;
    refreshGeneration += 1;
    stopPolling();
    mode = null;
    setConnectionUi(connection);
    modal.hide();
    if (!wasConnected && typeof window.reloadChats === 'function') window.reloadChats('WhatsApp');
    scheduleHealthCheck();
  };

  const status = async (start = false, reset = false) => {
    const params = new URLSearchParams({ _: String(Date.now()) });
    if (start) params.set('start', '1');
    if (reset) params.set('reset', '1');
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timeout = controller ? window.setTimeout(() => controller.abort(), 12_000) : null;
    try {
      const response = await fetch(`wpp_status.php?${params.toString()}`, {
        cache: 'no-store',
        headers: bridgeHeaders({ Accept: 'application/json' }),
        signal: controller?.signal,
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(body.message || `HTTP ${response.status}`);
      return body;
    } catch (error) {
      if (controller?.signal.aborted) throw new Error('status_timeout');
      throw error;
    } finally {
      if (timeout) window.clearTimeout(timeout);
    }
  };

  const refresh = (start = false, reset = false) => {
    // The bridge may be waiting on WPP/Chromium. A second status request would
    // occupy its only worker and makes recovery slower, so every caller joins
    // the outstanding check instead of starting a parallel one.
    if (refreshInFlight) return refreshInFlight;
    const generation = refreshGeneration;
    const request = (async () => {
      try {
        const body = await status(start, reset);
        if (generation !== refreshGeneration) return null;
        const connection = describeProviderConnection('whatsapp', body);
        refreshFailures = connection.state === ProviderConnectionState.ERROR ? refreshFailures + 1 : 0;
        if (connection.connected) {
          showConnected(connection);
          return connection;
        }
        setConnectionUi(connection);
        if (String(body.status || '').toLowerCase() === 'phonecode' && body.phoneCode) {
          setMode('phone');
          result.className = 'alert alert-success small mt-3 mb-0';
          result.textContent = `Код привязки: ${body.phoneCode}. Откройте WhatsApp → Связанные устройства → Связать по номеру телефона и введите этот код.`;
          return connection;
        }
        if (mode === 'qr') {
          if (body.status === 'qr' && body.qrcode) {
            qrBox.innerHTML = `<img src="${body.qrcode}" alt="QR-код WhatsApp" style="width:250px;height:250px">`;
          } else if (connection.state === ProviderConnectionState.ERROR) {
            // Do not call reset=1 from UI. It clears the session profile; a
            // normal status request or a new explicit QR choice is enough.
            qrBox.innerHTML = '<div class="text-center text-danger"><p class="mb-2">Сеанс WhatsApp пока недоступен. Проверяем восстановление без сброса привязки.</p><button type="button" class="btn btn-outline-success btn-sm" id="wa-auth-retry">Проверить повторно</button></div>';
            qrBox.querySelector('#wa-auth-retry')?.addEventListener('click', () => { qrBox.innerHTML = ''; void refresh(); }, { once: true });
          } else {
            qrBox.innerHTML = `<div class="text-center"><div class="spinner-border text-success" role="status"></div><p class="mt-2 small text-muted">${connection.label}…</p></div>`;
          }
        } else if (connection.state !== ProviderConnectionState.OFFLINE) {
          scheduleHealthCheck();
        }
        return connection;
      } catch (error) {
        if (generation !== refreshGeneration) return null;
        refreshFailures += 1;
        const connection = describeProviderConnection('whatsapp', null, error);
        setConnectionUi(connection);
        if (mode === 'qr') {
          qrBox.innerHTML = '<p class="text-danger small mb-0">Не удалось проверить WhatsApp. Повторяем проверку без сброса привязки…</p>';
        } else {
          scheduleHealthCheck();
        }
        return connection;
      } finally {
        if (refreshInFlight === request) refreshInFlight = null;
      }
    })();
    refreshInFlight = request;
    return request;
  };

  const beginPolling = (start = false) => {
    clearHealthTimer();
    stopPolling();
    refreshGeneration += 1;
    if (mode === 'qr') {
      qrBox.innerHTML = '<div class="text-center"><div class="spinner-border text-success" role="status" aria-label="Загрузка"></div><p class="mt-2 small text-muted">Запускаем браузер и получаем QR-код…</p></div>';
    }
    void refresh(start);
    poll = window.setInterval(() => { void refresh(); }, 3000);
  };

  const openAuth = (requestedMode = null) => {
    // The connection settings panel owns the card from which this flow starts.
    // Close it before showing Bootstrap's modal; otherwise its backdrop hides
    // the QR/phone choice even though the modal was successfully opened.
    window.dispatchEvent(new Event('connection-settings:close'));
    mode = null;
    setMode(null);
    result.textContent = '';
    modal.show();
    if (requestedMode === 'qr') {
      setMode('qr');
      beginPolling(true);
    } else if (requestedMode === 'phone') {
      setMode('phone');
    } else {
      // Opening the chooser must not start a browser or generate a QR.
      void refresh();
    }
  };

  login.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopImmediatePropagation();
    if (isConnected) {
      const startChatEl = document.getElementById('waStartChatModal');
      if (startChatEl) bootstrap.Modal.getOrCreateInstance(startChatEl).show();
      return;
    }
    openAuth();
  }, true);

  document.querySelectorAll('[data-whatsapp-auth]').forEach((button) => {
    button.addEventListener('click', () => {
      openAuth(button.dataset.whatsappAuth === 'phone' ? 'phone' : 'qr');
    });
  });

  qrTab.addEventListener('click', () => {
    setMode('qr');
    beginPolling(true);
  });
  phoneTab.addEventListener('click', () => {
    stopPolling();
    setMode('phone');
  });

  requestCode.addEventListener('click', async () => {
    const value = phone.value.trim();
    if (!value) {
      result.className = 'small mt-3 text-danger';
      result.textContent = 'Введите номер WhatsApp.';
      return;
    }
    requestCode.disabled = true;
    result.className = 'small mt-3 text-muted';
    result.textContent = 'Запрашиваем код у WhatsApp…';
    try {
      const response = await fetch('wpp_link_code.php', {
        method: 'POST',
        headers: bridgeHeaders({ 'Content-Type': 'application/json', 'Accept': 'application/json' }),
        body: JSON.stringify({ phone: value })
      });
      const body = await response.json().catch(() => ({}));
      if (!response.ok || !body.phoneCode) throw new Error(body.message || `HTTP ${response.status}`);
      result.className = 'alert alert-success small mt-3 mb-0';
      result.textContent = `Код привязки: ${body.phoneCode}. Откройте WhatsApp → Связанные устройства → Связать по номеру телефона и введите этот код.`;
      beginPolling();
    } catch (error) {
      result.className = 'small mt-3 text-danger';
      result.textContent = `Не удалось получить код: ${error.message}`;
    } finally {
      requestCode.disabled = false;
    }
  });

  modalElement.addEventListener('hidden.bs.modal', () => {
    stopPolling();
    mode = null;
    scheduleHealthCheck();
  });
  setConnectionUi(currentConnection);
  void refresh();
}

// A cached dependency can make this module execute just after DOMContentLoaded
// in the compatibility bridge.  Registering only an event listener then
// silently leaves the composer in its initial state. Initialize immediately
// when the document has already been parsed.
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', initWhatsAppAuth, { once: true });
} else {
  initWhatsAppAuth();
}
