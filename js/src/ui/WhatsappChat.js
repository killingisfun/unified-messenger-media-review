import { BaseChat } from './BaseChat.js?v=20261009-document-batch-r1';
import { whatsappAlbumTransport } from './services/transports/whatsappAlbum.js';

/**
 * WhatsApp only supplies provider-specific data recovery. Rendering,
 * pagination, reactions, media and lifetime management stay in BaseChat so
 * every provider uses the same user interface and cleanup path.
 */
export class WhatsappChat extends BaseChat {
  constructor() {
    super({ provider: 'whatsapp', albumTransport: whatsappAlbumTransport });
  }

  async _getInitialMessages() {
    try {
      const data = await super._getInitialMessages();
      if (data?.success === false) {
        throw new Error(data.message || 'WhatsApp недоступен.');
      }
      return data;
    } catch (liveError) {
      // WPP may be temporarily unavailable while the local database still
      // contains a readable history. The common renderer receives the same
      // paginated shape and therefore needs no WhatsApp-specific UI branch.
      if (!this.chatDbId || typeof this.api.getLocalMessages !== 'function') {
        throw liveError;
      }
      const cached = await this.api.getLocalMessages(this.chatDbId);
      if (!this._isActiveInstance()) return { messages: [], nextCursor: null };
      return {
        messages: Array.isArray(cached?.messages) ? cached.messages : [],
        nextCursor: null,
        prevCursor: null,
        offline: true,
      };
    }
  }
}
