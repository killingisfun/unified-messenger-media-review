import { getFeatureAvailability } from '../../domain/providers.js';

export const REACTION_CHOICES = Object.freeze(['👍', '❤️', '😂', '😮', '😢', '🙏']);

const escapeHtml = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
}[char]));

function actionMarkup({ action, icon, label, availability, messageId }) {
  const disabled = availability.enabled ? '' : ' disabled aria-disabled="true"';
  const reason = availability.reason ? ` data-unavailable-reason="${escapeHtml(availability.reason)}"` : '';
  const knownStates = new Set(['ready', 'not_implemented', 'service_unsupported', 'unavailable']);
  const state = availability.enabled ? 'is-ready' : `is-${knownStates.has(availability.state) ? availability.state : 'unavailable'}`;
  return `<span class="message-action-wrap ${state}"${reason}${availability.enabled ? '' : ' tabindex="0"'}>
    <button type="button" class="message-action" data-message-action="${escapeHtml(action)}" data-message-id="${escapeHtml(messageId)}" aria-label="${escapeHtml(label)}" title="${escapeHtml(availability.reason || label)}"${disabled}>
      <i class="bi ${escapeHtml(icon)}" aria-hidden="true"></i><span class="visually-hidden">${escapeHtml(label)}</span>
    </button>
  </span>`;
}

/** Shared controls stay in the same place for every provider. */
export function renderMessageActions(source, message, capabilities = null) {
  const messageId = String(message?.id ?? message?.message_id ?? '');
  const reaction = getFeatureAvailability(source, 'reaction', message, capabilities);
  const reply = getFeatureAvailability(source, 'reply', message, capabilities);
  return `<div class="message-actions" aria-label="Действия с сообщением">
    ${actionMarkup({ action: 'reply', icon: 'bi-reply', label: 'Ответить', availability: reply, messageId })}
    ${actionMarkup({ action: 'reaction', icon: 'bi-emoji-smile', label: 'Реакция', availability: reaction, messageId })}
  </div>`;
}

export function createReactionPicker(onPick, selected = [], choices = REACTION_CHOICES) {
  const picker = document.createElement('div');
  picker.className = 'reaction-picker';
  picker.setAttribute('role', 'dialog');
  picker.setAttribute('aria-label', 'Выберите реакцию');
  const availableChoices = Array.isArray(choices) && choices.length ? choices : REACTION_CHOICES;
  picker.innerHTML = availableChoices.map((emoji) => (
    `<button type="button" class="reaction-choice" data-reaction="${emoji}" aria-pressed="${selected.includes(emoji)}" aria-label="Реакция ${emoji}">${emoji}</button>`
  )).join('');
  picker.addEventListener('click', (event) => {
    const button = event.target.closest('[data-reaction]');
    if (button) onPick(String(button.dataset.reaction || ''));
  });
  return picker;
}
