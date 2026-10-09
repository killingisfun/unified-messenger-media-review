import { messageStateView } from '../../core/messageStates.js?v=20260921-chat-list-receipts-r2';
import { getProvider } from '../../domain/providers.js';

/** Shared receipt projection and rendering without inventing delivery evidence. */
export class MessageReceipts {
  constructor(chat) { this.chat = chat; }

  _isReceiptRead(message) {
    if (!message) return false;
    if (Number(message.ack) < 0) return false;
    if (message.is_read === true || message.read === true || message.read_at || message.readAt) return true;
    const ack = Number(message.ack || 0);
    // WPPConnect/WhatsApp: 1/2 are sent/delivered, 3+ is read/played.
    return Number.isFinite(ack) && ack >= 3;
  }

  _mergeMessageState(message) {
    if (!this.chat._messageStates) return message;
    const merged = this.chat._messageStates.merge(this.chat.source, this.chat.chatDbId, message);
    const members = Array.isArray(message?._albumMessages) ? message._albumMessages : [];
    if (String(message?.direction || '') !== 'out' || members.length < 2) return merged;
    // A grouped document card is one visual message but several native
    // receipts. Its indicator must describe the weakest component, never
    // merely the last file used as the aggregate's canonical id.
    const componentStates = members.map((member) => this.chat._messageStates.merge(
      this.chat.source,
      this.chat.chatDbId,
      { ...member, direction: 'out' },
    ));
    const explicit = componentStates.map(item => String(item?.send_state || '').toLowerCase());
    const acks = componentStates.map(item => Number(item?.ack || 0));
    let ack = 0;
    let sendState = 'pending';
    if (acks.some(value => value < 0) || explicit.some(state => state === 'failed' || state === 'rejected')) {
      ack = -1;
      sendState = explicit.includes('rejected') ? 'rejected' : 'failed';
    } else if (acks.some(value => value <= 0) || explicit.some(state => state === 'pending' || state === 'unknown')) {
      sendState = explicit.includes('unknown') ? 'unknown' : 'pending';
    } else if (acks.every(value => value >= 3)) {
      ack = 3;
      sendState = 'read';
    } else if (acks.every(value => value >= 2)) {
      ack = 2;
      sendState = 'delivered';
    } else {
      ack = 1;
      sendState = 'sent';
    }
    return { ...merged, ack, is_read: ack >= 3, send_state: sendState };
  }

  _paintSharedMessageStates() {
    if (!this.chat._messageStates || !this.chat.messagesContainer) return;
    for (const node of this.chat.messagesContainer.querySelectorAll('.message.out')) {
      const id = String(node.dataset.id || node._originalData?.id || '');
      const receipt = this.chat._messageStates.get(this.chat.source, this.chat.chatDbId, id);
      if (!receipt) continue;
      node._originalData = this._mergeMessageState({ ...node._originalData, ack: receipt.ack, is_read: receipt.is_read, send_state: receipt.send_state });
      this.chat._applyReceiptIcon(node.querySelector('.read-receipt i'), node._originalData, false);
    }
    for (const [id, node] of this.chat._batchOptimisticByMessageId || []) {
      const receipt = this.chat._messageStates.get(this.chat.source, this.chat.chatDbId, id);
      if (receipt && node?.isConnected) this.chat._markBatchReceipt(node, id, receipt.is_read, receipt.ack);
    }
  }

  _mergeWhatsAppReceipt(message) { return this.chat._mergeMessageState(message); }

  _paintSharedWhatsAppReceipts() { return this.chat._paintSharedMessageStates(); }

  _applyReceiptIcon(icon, message, isOptimistic = false) {
    if (!icon) return;
    const view = messageStateView(this.chat.source, message, isOptimistic);
    icon.className = view.className;
    icon.style.color = view.state === 'read' ? '#0d6efd' : '';
    icon.title = view.title;
  }

  updateReadReceipts(ids = []) {
    if (!this.chat._isActiveInstance() || !Array.isArray(ids) || !ids.length) return;
    // MAX reads enter through the account-verified native boundary handler.
    // Generic message-ID notifications must not bypass that verification.
    if (String(getProvider(this.chat.source || '').id || '').toLowerCase() === 'max') return;
    if (this.chat._messageStates) {
      for (const id of ids) {
        const node = document.getElementById(`message-${id}`);
        const known = this.chat._messageStates.get(this.chat.source, this.chat.chatDbId, id);
        const message = node && this.chat.messagesContainer?.contains(node) ? node._originalData : known;
        this.chat._messageStates.merge(this.chat.source, this.chat.chatDbId, { ...message, id: String(id), direction: 'out', ack: 3, is_read: true });
      }
      this.chat._paintSharedMessageStates();
      return;
    }
    this.chat._logRx('updateReadReceipts: ids=', ids);
    ids.forEach((id) => {
      const batchEl = this.chat._batchOptimisticByMessageId?.get(String(id));
      if (batchEl?.isConnected) {
        this.chat._markBatchReceipt(batchEl, String(id), true);
        return;
      }
      const candidate = document.getElementById(`message-${id}`);
      const el = candidate && this.chat.messagesContainer?.contains(candidate) ? candidate : null;
      if (!el) return;
      el._originalData = { ...el._originalData, ack: 3, is_read: true };
      el.classList.remove('optimistic');
      let meta = el.querySelector('.meta');
      if (!meta) {
        meta = document.createElement('div');
        meta.className = 'meta';
        el.querySelector('.bubble')?.appendChild(meta);
      }
      let rr = meta.querySelector('.read-receipt');
      if (!rr) {
        rr = document.createElement('span');
        rr.className = 'read-receipt';
        meta.appendChild(rr);
      }
      let icon = rr.querySelector('i');
      if (!icon) {
        icon = document.createElement('i');
        rr.appendChild(icon);
      }
      icon.className = 'bi bi-check2-all';
      icon.style.color = '#0d6efd';
    });
  }
}
