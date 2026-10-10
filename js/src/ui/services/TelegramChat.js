import { BaseChat } from '../BaseChat.js?v=20261010-video-contract-r2';
export class TelegramChat extends BaseChat {
  constructor() { super({ provider: 'telegram' }); }
}
