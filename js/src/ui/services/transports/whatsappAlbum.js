/**
 * Translate WPP's album markers into the provider-neutral shape consumed by
 * BaseChat. The shared renderer only receives a group id plus the fact that
 * a record is a technical parent or a displayable image member.
 */
import { isDocumentAttachment } from '../../../domain/providers.js';

function rawGroupId(message = {}) {
  return String(message.groupId ?? message.media_group_id ?? message.group_id ?? '').trim();
}

function isPhotoAttachment(attachment = {}) {
  const type = String(attachment.type || '').toLowerCase();
  const kind = String(attachment.kind || '').toLowerCase();
  const mime = String(attachment.mime || '').toLowerCase();
  return !isDocumentAttachment(attachment)
    && (type === 'photo' || type === 'image' || kind === 'photo' || kind === 'image' || mime.startsWith('image/'));
}

export const whatsappAlbumTransport = Object.freeze({
  describeIncomingAlbum(message = {}) {
    const raw = rawGroupId(message);
    if (!raw) return null;
    const technicalParent = raw.startsWith('wa-native-parent:');
    return {
      groupId: technicalParent ? raw.replace('wa-native-parent:', 'wa-native:') : raw,
      technicalParent,
      native: technicalParent || raw.startsWith('wa-native:'),
    };
  },

  isPhotoAlbumMember(message = {}) {
    const attachments = Array.isArray(message.attachments) ? message.attachments : [];
    return attachments.length > 0 && attachments.every(isPhotoAttachment);
  },
});
