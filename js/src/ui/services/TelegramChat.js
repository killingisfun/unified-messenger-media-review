import { BaseChat } from '../BaseChat.js?v=20261004-chat-zip-r3';
export class TelegramChat extends BaseChat {
  constructor() { super({ provider: 'telegram' }); }
}
