// A small, provider-neutral view model for connection status.  The transport
// can keep verbose diagnostic details on the server; the browser receives
// only a stable state and text that is safe to show in the shared UI.

export const ProviderConnectionState = Object.freeze({
  UNKNOWN: 'unknown',
  CHECKING: 'checking',
  CONNECTED: 'connected',
  RECOVERING: 'recovering',
  OFFLINE: 'offline',
  ERROR: 'error',
});

const WHATSAPP_CONNECTED = new Set(['CONNECTED', 'INCHAT', 'ISLOGGED', 'QRREADSUCCESS', 'MAIN']);
const WHATSAPP_OFFLINE = new Set(['NOT_LOGGED_IN', 'NOTLOGGEDIN', 'QR', 'PHONECODE', 'UNPAIRED']);
const WHATSAPP_ERROR = new Set(['ERROR', 'CLOSED', 'DISCONNECTED', 'BROWSERCLOSE', 'AUTOCLOSECALLED', 'QRREADERROR']);

function providerName(provider) {
  return String(provider || '').trim().toLowerCase() === 'whatsapp' ? 'WhatsApp' : 'Сервис';
}

function state(provider, value, rawStatus, label, detail, canSend) {
  return Object.freeze({
    provider: String(provider || '').trim().toLowerCase(),
    state: value,
    rawStatus,
    label,
    detail,
    connected: value === ProviderConnectionState.CONNECTED,
    canSend: canSend === true,
  });
}

/**
 * Convert a provider response into a presentable state without leaking a
 * URL, token, raw stack trace, or adapter-specific failure details to UI.
 */
export function describeProviderConnection(provider, payload = null, transportError = null) {
  const id = String(provider || '').trim().toLowerCase();
  const name = providerName(id);
  const rawStatus = String(payload?.status || '').trim();
  const normalized = rawStatus.toUpperCase();

  if (transportError) {
    return state(
      id,
      ProviderConnectionState.ERROR,
      rawStatus,
      `${name}: нет ответа`,
      'Сервис временно не отвечает. Проверка будет повторена автоматически.',
      false,
    );
  }

  if (id === 'whatsapp') {
    // The recovery guard deliberately exposes a fixed enum only. It never
    // forwards its private process/log reason to the browser.
    if (String(payload?.recovery_state || '').toLowerCase() === 'manual-review') {
      return state(
        id,
        ProviderConnectionState.ERROR,
        rawStatus,
        'Нужна проверка сеанса',
        'Автоматическое восстановление остановлено. Сеанс сохранён; требуется проверка службы WhatsApp.',
        false,
      );
    }
    if (WHATSAPP_CONNECTED.has(normalized)) {
      return state(id, ProviderConnectionState.CONNECTED, rawStatus, 'Подключён', 'Сеанс WhatsApp активен.', true);
    }

    // WPPConnect can report SYNCING while it still restores its Chromium
    // page. Treat it as recovery so a user cannot build up failed sends.
    if (payload?.recovering === true || String(payload?.recovery_state || '').toLowerCase() === 'recovering' || normalized === 'SYNCING') {
      return state(
        id,
        ProviderConnectionState.RECOVERING,
        rawStatus,
        normalized === 'SYNCING' ? 'Синхронизация сеанса' : 'Восстановление сеанса',
        'Привязка сохранена. Новые сообщения станут доступны после восстановления.',
        false,
      );
    }

    if (normalized === 'INITIALIZING' || rawStatus === '') {
      return state(
        id,
        ProviderConnectionState.CHECKING,
        rawStatus,
        'Проверяем подключение',
        'Проверяем состояние WhatsApp без изменения привязки.',
        false,
      );
    }

    if (WHATSAPP_OFFLINE.has(normalized)) {
      return state(id, ProviderConnectionState.OFFLINE, rawStatus, 'Не подключён', 'Для отправки сообщений требуется привязка WhatsApp.', false);
    }

    if (WHATSAPP_ERROR.has(normalized)) {
      return state(
        id,
        ProviderConnectionState.ERROR,
        rawStatus,
        'Сеанс недоступен',
        'Состояние сеанса проверяется. Повторный вход потребуется только если восстановление не удастся.',
        false,
      );
    }
  }

  return state(
    id,
    ProviderConnectionState.CHECKING,
    rawStatus,
    'Проверяем подключение',
    'Получаем актуальное состояние подключения.',
    false,
  );
}

/**
 * Keep connection checks serialized and inexpensive. Recovery is checked
 * quickly, a healthy adapter once per minute, and repeated errors back off.
 */
export function providerConnectionRetryDelay(connection, failures = 0) {
  const status = connection?.state || ProviderConnectionState.CHECKING;
  if (status === ProviderConnectionState.CONNECTED) return 60_000;
  if (status === ProviderConnectionState.RECOVERING || status === ProviderConnectionState.CHECKING) return 8_000;
  if (status === ProviderConnectionState.OFFLINE) return 0;
  const attempts = Math.max(0, Math.min(3, Number(failures) || 0));
  return Math.min(120_000, 15_000 * (2 ** attempts));
}
