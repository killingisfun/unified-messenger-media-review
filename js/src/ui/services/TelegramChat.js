import { BaseChat } from '../BaseChat.js?v=20261009-capability-refresh-r1';
export class TelegramChat extends BaseChat {
  constructor() { super({ provider: 'telegram' }); }
}
