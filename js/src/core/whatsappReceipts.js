// Receipt metadata only. Both views subscribe to the same synchronous state.
export function whatsappReceiptView(message = {}, optimistic = false) {
  const ack = Number(message.ack ?? 0);
  const read = message.is_read === true || Number(message.is_read) === 1 || ack >= 3;
  const state = ack < 0 ? 'failed' : optimistic ? 'pending' : read ? 'read' : ack >= 2 ? 'delivered' : ack > 0 ? 'sent' : 'pending';
  return {
    state,
    icon: { pending: 'clock', failed: 'error', sent: 'check', delivered: 'checkAll', read: 'checkAll' }[state],
    className: { pending: 'bi bi-clock', failed: 'bi bi-exclamation-circle-fill', sent: 'bi bi-check2', delivered: 'bi bi-check2-all', read: 'bi bi-check2-all' }[state],
    title: { pending: 'Ожидание подтверждения WhatsApp', failed: 'Ошибка отправки WhatsApp', sent: 'Отправлено', delivered: 'Доставлено', read: 'Прочитано' }[state],
  };
}

export class WhatsAppReceiptStore {
  constructor() { this.chats = new Map(); this.listeners = new Set(); }
  subscribe(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  chat(key) {
    key = String(key || '');
    if (!this.chats.has(key)) this.chats.set(key, { messages: new Map(), readThrough: 0 });
    return this.chats.get(key);
  }
  get(key, id) { return this.chat(key).messages.get(String(id)) || null; }
  merge(key, message) {
    const id = String(message?.id ?? message?.message_id ?? '');
    if (!key || !id || id.startsWith('optimistic_') || message.direction === 'in') return message;
    const chat = this.chat(key);
    const old = chat.messages.get(id);
    const incomingRead = message.is_read === true || Number(message.is_read) === 1;
    const explicitAck = Number(message.ack ?? 0);
    const incomingAck = explicitAck < 0 ? explicitAck : incomingRead ? 3 : explicitAck;
    const ack = Number.isFinite(incomingAck) ? incomingAck : 0;
    // A provider failure is terminal for this exact native message. A late
    // snapshot may omit ACK or still report an earlier positive ACK; neither
    // proves that the failed message was ever delivered.
    const previousAck = Number(old?.ack ?? 0);
    const next = {
      id, timestamp: Number(message.timestamp || old?.timestamp || 0),
      ack: previousAck < 0 ? previousAck : (ack < 0 ? ack : previousAck > 0 ? Math.max(previousAck, ack) : ack),
    };
    if (next.ack >= 3 && next.timestamp) chat.readThrough = Math.max(chat.readThrough, next.timestamp);
    if (next.ack > 0 && next.timestamp && next.timestamp <= chat.readThrough) next.ack = Math.max(3, next.ack);
    next.is_read = next.ack >= 3;
    chat.messages.set(id, next);
    const changed = [];
    if (!old || old.ack !== next.ack || old.timestamp !== next.timestamp) changed.push(next);
    // A read boundary covers earlier successful outgoing messages, including
    // history loaded later. Failed/pending sends never become read by inference.
    for (const [otherId, value] of chat.messages) {
      if (value.ack > 0 && value.ack < 3 && value.timestamp && value.timestamp <= chat.readThrough) {
        const read = { ...value, ack: 3, is_read: true };
        chat.messages.set(otherId, read); changed.push(read);
      }
    }
    if (changed.length) for (const listener of this.listeners) listener(String(key), changed);
    return { ...message, ...chat.messages.get(id) };
  }
  mergeChat(row) {
    if (!['whatsapp', 'wa', 'wpp'].includes(String(row?.source || '').toLowerCase())
        || row.last_message_direction !== 'out' || !row.last_message_id) return row;
    this.merge(row.id, { id: row.last_message_id, timestamp: row.last_message_time,
      ack: row.last_message_ack, is_read: row.last_message_is_read, direction: 'out' });
    return this.projectChat(row);
  }
  projectChat(row) {
    const receipt = this.get(row.id, row.last_message_id);
    return receipt ? { ...row, last_message_ack: receipt.ack, last_message_is_read: receipt.is_read ? 1 : 0 } : row;
  }
}

export const whatsappReceipts = new WhatsAppReceiptStore();
