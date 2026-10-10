import { BaseChat } from '../BaseChat.js?v=20261010-video-contract-r2';
export class AvitoChat extends BaseChat {
  constructor() { super({ provider: 'avito' }); }
}
