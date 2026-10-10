import { BaseChat } from '../BaseChat.js?v=20261010-video-contract-r2';
export class VKChat extends BaseChat {
  constructor() { super({ provider: 'vk' }); }
}
