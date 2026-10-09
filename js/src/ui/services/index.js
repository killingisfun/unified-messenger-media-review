import { BaseChat } from '../BaseChat.js?v=20261009-document-batch-r1';
import { WhatsappChat } from '../WhatsappChat.js?v=20261009-attachment-compose-r2';
import { TelegramChat } from './TelegramChat.js?v=20261009-attachment-compose-r2';
import { VKChat } from './VKChat.js?v=20261004-chat-zip-r3';
import { AvitoChat } from './AvitoChat.js?v=20261004-chat-zip-r3';

export function createChatBySource(source){
  const s = String(source||'').toLowerCase();
  if (s.startsWith('whats') || s.startsWith('wpp')) return new WhatsappChat();
  if (s.startsWith('tele')) return new TelegramChat();
  if (s.startsWith('vk')) return new VKChat();
  if (s.startsWith('avito')) return new AvitoChat();
  return new BaseChat();
}
