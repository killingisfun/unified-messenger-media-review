// New-dialog modals for connected WhatsApp and Telegram accounts.
document.addEventListener('DOMContentLoaded', () => {
  const isPreviewMode = window.APP_CONFIG?.previewMode === true
    || new URLSearchParams(window.location.search).get('preview') === '1';
  if (isPreviewMode) return;

  const bridgeHeaders = (headers = {}) => {
    const token = String(window.APP_CONFIG?.bridgeToken || '').trim();
    return token ? { ...headers, 'X-Unified-Bridge-Token': token } : headers;
  };

  const bind = ({ formId, modalId, source, targetName }) => {
    const form = document.getElementById(formId);
    const modalEl = document.getElementById(modalId);
    if (!form || !modalEl) return;

    const error = form.querySelector('[id$="-error"]');
    const submit = form.querySelector('button[type="submit"]');
    const initialLabel = submit?.textContent || 'Отправить';
    const setError = (text = '') => {
      if (!error) return;
      error.textContent = text;
      error.classList.toggle('d-none', !text);
    };

    modalEl.addEventListener('shown.bs.modal', () => {
      setError();
      form.elements[targetName]?.focus();
    });

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const target = String(form.elements[targetName]?.value || '').trim();
      const message = String(form.elements.message?.value || '').trim();
      if (!target || !message) return setError('Заполните получателя и сообщение.');

      setError();
      if (submit) { submit.disabled = true; submit.textContent = 'Отправляем…'; }
      try {
        const body = new URLSearchParams({ action: 'send_message_by_target', source, target, message });
        const response = await fetch('index.php?action=send_message_by_target', {
          method: 'POST', headers: bridgeHeaders({ 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' }), body
        });
        const data = await response.json().catch(() => ({}));
        if (!response.ok || !data.success) throw new Error(data.message || `HTTP ${response.status}`);

        bootstrap.Modal.getOrCreateInstance(modalEl).hide();
        form.reset();
        if (typeof window.reloadChats === 'function') {
          window.reloadChats(source);
          window.setTimeout(() => window.reloadChats(source), 1200);
        }
      } catch (e) {
        setError(e.message || 'Не удалось отправить сообщение.');
      } finally {
        if (submit) { submit.disabled = false; submit.textContent = initialLabel; }
      }
    });
  };

  bind({ formId: 'wa-start-chat-form', modalId: 'waStartChatModal', source: 'WhatsApp', targetName: 'phone' });
  bind({ formId: 'tg-start-chat-form', modalId: 'tgStartChatModal', source: 'Telegram', targetName: 'target' });
});
