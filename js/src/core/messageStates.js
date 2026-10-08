import { whatsappReceipts, whatsappReceiptView } from './whatsappReceipts.js?v=20260920-receipt-matrix-r1';

const providerId = (source) => String(source || '').trim().toLowerCase();
const isWhatsApp = (source) => ['whatsapp', 'wa', 'wpp'].includes(providerId(source));
const nativeId = (message) => String(message?.id ?? message?.message_id ?? '').trim();

/**
 * One browser-side message-state store for history, realtime and chat-list
 * rows. WhatsApp retains its ACK-specific merger; other providers advance
 * only when their own payload explicitly carries a state.
 */
export class MessageStateStore {
  constructor() {
    this.chats = new Map();
    this.listeners = new Set();
    whatsappReceipts.subscribe((chatKey, changes) => this._emit('whatsapp', chatKey, changes));
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  _emit(source, chatKey, changes) {
    for (const listener of this.listeners) listener(providerId(source), String(chatKey || ''), changes);
  }

  _chat(source, chatKey) {
    const key = `${providerId(source)}:${String(chatKey || '')}`;
    if (!this.chats.has(key)) this.chats.set(key, new Map());
    return this.chats.get(key);
  }

  get(source, chatKey, id) {
    if (isWhatsApp(source)) return whatsappReceipts.get(chatKey, id);
    return this._chat(source, chatKey).get(String(id)) || null;
  }

  merge(source, chatKey, message) {
    if (isWhatsApp(source)) return whatsappReceipts.merge(chatKey, message);
    const id = nativeId(message);
    if (!chatKey || !id || id.startsWith('optimistic_') || message?.direction !== 'out') return message;

    const chat = this._chat(source, chatKey);
    const old = chat.get(id);
    const explicitAck = Number(message?.ack);
    const explicitState = String(message?.send_state || '').toLowerCase();
    const rejected = ['rejected', 'failed'].includes(explicitState);
    const read = message?.is_read === true || Number(message?.is_read) === 1 || explicitState === 'read';
    const incomingAck = rejected || explicitAck < 0 ? -1 : read ? 3
      : ['delivered'].includes(explicitState) ? 2
      : ['accepted', 'sent'].includes(explicitState) ? 1
      : Number.isFinite(explicitAck) && explicitAck > 0 ? explicitAck : 0;
    // A reported failure remains terminal for this exact provider ID. Unlike
    // WhatsApp, no read boundary is inferred for adapters that do not provide it.
    const priorAck = Number(old?.ack ?? 0);
    const ack = priorAck < 0 ? priorAck : incomingAck < 0 ? incomingAck : Math.max(priorAck, incomingAck);
    const next = {
      id,
      timestamp: Number(message?.timestamp || old?.timestamp || 0),
      ack,
      is_read: ack >= 3,
      send_state: ack < 0 ? (explicitState === 'rejected' ? 'rejected' : 'failed') : ack >= 3 ? 'read' : ack >= 2 ? 'delivered' : ack >= 1 ? 'sent'
        : explicitState === 'unknown' ? 'unknown' : 'pending',
    };
    chat.set(id, next);
    if (!old || old.ack !== next.ack || old.timestamp !== next.timestamp || old.send_state !== next.send_state) this._emit(source, chatKey, [next]);
    return { ...message, ...next };
  }

  mergeChat(row) {
    if (!row || row.last_message_direction !== 'out' || !row.last_message_id) return row;
    const source = row.source;
    const context = row.item_context || {};
    this.merge(source, row.id, {
      id: row.last_message_id,
      timestamp: row.last_message_time,
      ack: row.last_message_ack ?? context.last_message_ack,
      send_state: row.last_message_send_state ?? context.last_message_send_state ?? row.send_state,
      is_read: row.last_message_is_read ?? context.last_message_is_read,
      direction: 'out',
    });
    return this.projectChat(row);
  }

  projectChat(row) {
    const receipt = this.get(row?.source, row?.id, row?.last_message_id);
    return receipt ? {
      ...row,
      last_message_ack: receipt.ack,
      last_message_send_state: receipt.send_state,
      last_message_is_read: receipt.is_read ? 1 : 0,
    } : row;
  }
}

export function messageStateView(source, message = {}, optimistic = false) {
  if (isWhatsApp(source)) return whatsappReceiptView(message, optimistic);
  const ack = Number(message?.ack ?? 0);
  const read = message?.is_read === true || Number(message?.is_read) === 1 || ack >= 3;
  const explicitState = String(message?.send_state || '').toLowerCase();
  const delivered = ack >= 2 || explicitState === 'delivered';
  const state = ack < 0 || ['rejected', 'failed'].includes(explicitState) ? 'failed'
    : optimistic || ['pending', 'unknown'].includes(explicitState) ? 'pending' : read ? 'read' : delivered ? 'delivered' : 'sent';
  return {
    state,
    className: { pending: 'bi bi-clock', failed: 'bi bi-exclamation-circle-fill', sent: 'bi bi-check2', delivered: 'bi bi-check2-all', read: 'bi bi-check2-all' }[state],
    title: { pending: explicitState === 'unknown' ? 'Результат отправки пока неизвестен: проверьте чат перед повтором' : 'Ожидание подтверждения сервиса', failed: 'Ошибка отправки', sent: 'Принято сервисом', delivered: 'Доставлено', read: 'Прочитано' }[state],
  };
}

export const messageStates = new MessageStateStore();
