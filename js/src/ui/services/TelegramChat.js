import { BaseChat } from '../BaseChat.js?v=20261010-video-contract-r3';
export class TelegramChat extends BaseChat {
  constructor() { super({ provider: 'telegram' }); }
}
