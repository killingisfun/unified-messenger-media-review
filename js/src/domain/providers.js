/**
 * Shared provider identities and capability readers. Runtime capabilities are
 * supplied by config/provider-capabilities.json through the local bridge; no
 * second list of provider permissions lives in JavaScript.
 */
const FEATURE_READY = 'ready';
const FEATURE_NOT_IMPLEMENTED = 'not_implemented';
const FEATURE_SERVICE_UNSUPPORTED = 'service_unsupported';
const FEATURE_UNAVAILABLE = 'unavailable';

export const PROVIDERS = Object.freeze({
  telegram: Object.freeze({
    id: 'telegram', name: 'Telegram', icon: 'bi-telegram', tone: 'telegram',
    features: {},
  }),
  whatsapp: Object.freeze({
    id: 'whatsapp', name: 'WhatsApp', icon: 'bi-whatsapp', tone: 'whatsapp',
    features: {},
  }),
  vk: Object.freeze({
    id: 'vk', name: 'VK', icon: 'bi-chat-square-text', tone: 'vk',
    features: {},
  }),
  avito: Object.freeze({
    id: 'avito', name: 'Avito', icon: 'bi-bag', tone: 'avito',
    features: {},
  }),
  max: Object.freeze({
    id: 'max', name: 'MAX', icon: 'bi-qr-code', tone: 'max',
    features: {},
  }),
});

const aliases = Object.freeze({
  telegram: 'telegram', tg: 'telegram',
  whatsapp: 'whatsapp', wpp: 'whatsapp', wa: 'whatsapp',
  vk: 'vk', vkontakte: 'vk',
  avito: 'avito',
  max: 'max', 'max messenger': 'max', 'макс': 'max',
});

const featureMessages = Object.freeze({
  reaction: {
    [FEATURE_NOT_IMPLEMENTED]: 'Реакции для этого сервиса ещё не подключены.',
    [FEATURE_SERVICE_UNSUPPORTED]: 'Этот сервис не поддерживает реакции.',
    [FEATURE_UNAVAILABLE]: 'Для этого сообщения реакция пока недоступна.',
  },
  reply: {
    [FEATURE_NOT_IMPLEMENTED]: 'Ответы ещё не связаны с идентификаторами сообщений этого сервиса.',
    [FEATURE_SERVICE_UNSUPPORTED]: 'Этот сервис не поддерживает ответы.',
    [FEATURE_UNAVAILABLE]: 'На это сообщение нельзя ответить.',
  },
  attachment: {
    [FEATURE_NOT_IMPLEMENTED]: 'Вложения для этого сервиса ещё не подключены.',
    [FEATURE_SERVICE_UNSUPPORTED]: 'Этот сервис не поддерживает вложения.',
    [FEATURE_UNAVAILABLE]: 'Вложения недоступны в этом диалоге.',
  },
});

export function providerId(source) {
  return aliases[String(source || '').trim().toLowerCase()] || String(source || '').trim().toLowerCase();
}

export function getProvider(source) {
  const id = providerId(source);
  return PROVIDERS[id] || {
    id: id || 'unknown',
    name: String(source || 'Неизвестный сервис'),
    icon: 'bi-chat-square-text',
    tone: 'unknown',
    features: {},
  };
}

function featureDefinition(source, feature, capabilityOverrides = null) {
  const provider = getProvider(source);
  const override = capabilityOverrides?.[feature];
  const declared = provider.features?.[feature];
  return override ?? declared ?? null;
}

export function getFeatureConstraints(source, feature, capabilityOverrides = null) {
  const value = featureDefinition(source, feature, capabilityOverrides);
  const constraints = typeof value === 'object' && value?.constraints && typeof value.constraints === 'object'
    ? value.constraints
    : {};
  const kinds = Array.isArray(constraints.kinds)
    ? constraints.kinds.map(value => String(value || '').toLowerCase()).filter(Boolean)
    : [];
  const maxFiles = Number(constraints.max_files);
  const maxFileBytes = Number(constraints.max_file_bytes);
  const maxTotalBytes = Number(constraints.max_total_bytes);
  const reactionChoices = Array.isArray(constraints.choices)
    ? constraints.choices.map(value => String(value || '').trim()).filter(Boolean)
    : [];
  const maxOwnReactions = Number(constraints.max_own);
  return Object.freeze({
    kinds,
    maxFiles: Number.isInteger(maxFiles) && maxFiles > 0 ? maxFiles : null,
    maxFileBytes: Number.isInteger(maxFileBytes) && maxFileBytes > 0 ? maxFileBytes : null,
    maxTotalBytes: Number.isInteger(maxTotalBytes) && maxTotalBytes > 0 ? maxTotalBytes : null,
    reactionChoices,
    maxOwnReactions: Number.isInteger(maxOwnReactions) && maxOwnReactions > 0 ? maxOwnReactions : null,
    canRemove: constraints.can_remove === true,
  });
}

function hasNativeReplyTarget(source, messageId) {
  const id = String(messageId || '');
  switch (providerId(source)) {
    case 'telegram':
    case 'vk':
      return /^[1-9][0-9]{0,18}$/.test(id);
    case 'whatsapp': {
      const match = /^(?:true|false)_([^_]+)_(.+)$/i.exec(id);
      return Boolean(match
        && /^[^@_\s]+@(?:c\.us|g\.us|lid)$/i.test(match[1])
        && match[2]
        && !/[\s]/.test(match[2]));
    }
    default:
      return Boolean(id);
  }
}

export function getFeatureAvailability(source, feature, message = null, capabilityOverrides = null) {
  const provider = getProvider(source);
  const override = capabilityOverrides?.[feature];
  const declared = provider.features?.[feature];
  const value = override ?? declared ?? null;
  const state = (typeof override === 'object' ? override?.state : override)
    || (typeof declared === 'object' ? declared?.state : declared)
    || FEATURE_UNAVAILABLE;
  const overrideReason = typeof override === 'object' ? String(override?.reason || '') : '';
  const declaredReason = typeof declared === 'object' ? String(declared?.reason || '') : '';
  const messageId = String(message?.id ?? message?.message_id ?? '').trim();
  const systemMessage = Boolean(message?.is_system || message?.system);

  if ((feature === 'reaction' || feature === 'reply') && (message?.optimistic || String(messageId).startsWith('optimistic_'))) {
    return { state: FEATURE_UNAVAILABLE, enabled: false, reason: 'Сообщение ещё не синхронизировано с сервисом.' };
  }
  if ((feature === 'reaction' || feature === 'reply') && (!messageId || systemMessage)) {
    return { state: FEATURE_UNAVAILABLE, enabled: false, reason: featureMessages[feature]?.[FEATURE_UNAVAILABLE] || 'Действие недоступно.' };
  }
  if (feature === 'reply' && !hasNativeReplyTarget(source, messageId)) {
    return {
      state: FEATURE_UNAVAILABLE,
      enabled: false,
      reason: 'Это сообщение не содержит исходный идентификатор, необходимый для ответа в сервисе.',
    };
  }
  if (state !== FEATURE_READY) {
    return {
      state,
      enabled: false,
      reason: overrideReason || declaredReason || featureMessages[feature]?.[state]
        || 'Возможности этого чата ещё не получены с сервера.',
    };
  }
  const constraints = typeof value === 'object' && value?.constraints && typeof value.constraints === 'object'
    ? value.constraints
    : {};
  const allowedChats = Array.isArray(constraints.allowed_chat_ids)
    ? constraints.allowed_chat_ids.map(chatId => String(chatId ?? '').trim()).filter(Boolean)
    : [];
  if (allowedChats.length) {
    const messageChatId = String(message?.chat_id ?? message?.chatId ?? message?.conversation_id ?? '').trim();
    if (!allowedChats.includes(messageChatId)) {
      return {
        state: FEATURE_UNAVAILABLE,
        enabled: false,
        reason: 'Это действие пока разрешено только в учебном диалоге этого сервиса.',
      };
    }
  }
  return { state: FEATURE_READY, enabled: true, reason: '' };
}

function attachmentKind(file) {
  const mime = String(file?.type || '').toLowerCase();
  if (mime.startsWith('image/')) return 'photo';
  if (mime.startsWith('video/')) return 'video';
  if (mime.startsWith('audio/')) return 'audio';
  return 'document';
}

/** Validate selected files before an optimistic card or a network call exists. */
export function validateAttachmentSelection(source, files, capabilityOverrides = null, chatContext = null) {
  const availability = getFeatureAvailability(source, 'attachment', chatContext, capabilityOverrides);
  if (!availability.enabled) return availability;
  const selection = Array.from(files || []);
  const constraints = getFeatureConstraints(source, 'attachment', capabilityOverrides);
  if (constraints.maxFiles !== null && selection.length > constraints.maxFiles) {
    return {
      state: FEATURE_UNAVAILABLE,
      enabled: false,
      reason: `Можно прикрепить не более ${constraints.maxFiles} файл${constraints.maxFiles === 1 ? 'а' : 'ов'} за одну отправку.`,
    };
  }
  const oversized = selection.find(file => constraints.maxFileBytes !== null && Number(file?.size || 0) > constraints.maxFileBytes);
  if (oversized) {
    return {
      state: FEATURE_UNAVAILABLE,
      enabled: false,
      reason: `Размер файла «${String(oversized?.name || 'вложение')}» превышает лимит ${Math.ceil(constraints.maxFileBytes / 1024 / 1024)} МБ.`,
    };
  }
  const totalBytes = selection.reduce((sum, file) => sum + Math.max(0, Number(file?.size || 0) || 0), 0);
  if (constraints.maxTotalBytes !== null && totalBytes > constraints.maxTotalBytes) {
    return {
      state: FEATURE_UNAVAILABLE,
      enabled: false,
      reason: `Общий размер вложений превышает лимит ${Math.ceil(constraints.maxTotalBytes / 1024 / 1024)} МБ.`,
    };
  }
  const disallowed = selection.find(file => constraints.kinds.length && !constraints.kinds.includes(attachmentKind(file)));
  if (disallowed) {
    return {
      state: FEATURE_UNAVAILABLE,
      enabled: false,
      reason: `Этот чат не поддерживает тип файла: ${attachmentKind(disallowed)}.`,
    };
  }
  if (selection.length > 1) {
    const album = getFeatureAvailability(source, 'album', chatContext, capabilityOverrides);
    if (!album.enabled) return album;
    const albumConstraints = getFeatureConstraints(source, 'album', capabilityOverrides);
    const albumKinds = Array.isArray(albumConstraints.kinds) ? albumConstraints.kinds : [];
    const albumDisallowed = selection.find(file => albumKinds.length && !albumKinds.includes(attachmentKind(file)));
    if (albumDisallowed) {
      return {
        state: FEATURE_UNAVAILABLE,
        enabled: false,
        reason: `Этот сервис не поддерживает ${attachmentKind(albumDisallowed)} в пачке вложений.`,
      };
    }
  }
  return { state: FEATURE_READY, enabled: true, reason: '' };
}

function normalizedTimestamp(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number)) return 0;
  return number > 20_000_000_000 ? Math.floor(number / 1000) : Math.floor(number);
}

function primitiveText(value) {
  return typeof value === 'string' || typeof value === 'number' ? String(value).trim() : '';
}

function replyId(value) {
  if (value === null || value === undefined) return '';
  if (typeof value !== 'object') return primitiveText(value);

  const direct = primitiveText(value._serialized ?? value.message_id ?? value.messageId
    ?? value.reply_to_message_id ?? value.reply_to_msg_id ?? value.quotedStanzaID
    ?? value.stanza_id ?? value.id);
  if (direct) return direct;

  // WPPConnect may put the provider message id one level deeper under `id`
  // or `key`.  Preserve its full serialized form: trimming it changes a LID
  // message id and makes a later quoted send point at a different message.
  return replyId(value.id ?? value.key ?? null);
}

function replyText(value) {
  if (!value || typeof value !== 'object') return '';
  const content = value.content && typeof value.content === 'object' ? value.content : {};
  return primitiveText(value.text ?? value.message ?? value.body ?? value.caption
    ?? content.text ?? content.body ?? content.caption);
}

function replyAuthor(value) {
  if (!value || typeof value !== 'object') return '';
  const sender = value.sender && typeof value.sender === 'object' ? value.sender : {};
  const author = value.author && typeof value.author === 'object' ? value.author : {};
  return primitiveText(value.author_name ?? value.sender_name ?? value.senderName
    ?? sender.pushname ?? sender.name ?? author.name ?? value.author);
}

function normalizeReply(raw) {
  // Each adapter emits `reply_to`, but retaining these native spellings makes
  // realtime and cached provider payloads render consistently during a
  // staged rollout.  The selected value is never an internal SQLite id.
  const candidate = raw?.replyTo ?? raw?.reply_to ?? raw?.reply_to_message
    ?? raw?.reply_message ?? raw?.replyMessage ?? raw?.quotedMsgObj
    ?? raw?.quoted_message ?? raw?.quotedMessage ?? raw?.quote ?? null;
  const fallbackId = raw?.reply_to_message_id ?? raw?.reply_to_msg_id
    ?? raw?.quotedStanzaID ?? raw?.quoted_message_id ?? raw?.quote_id ?? null;
  const id = replyId(candidate) || replyId(fallbackId);
  if (!id) return null;

  return {
    id,
    text: replyText(candidate),
    author: replyAuthor(candidate),
  };
}

function hasOwn(raw, field) {
  return Boolean(raw && Object.prototype.hasOwnProperty.call(raw, field));
}

/** Distinguish an explicit cleared text from a partial event with no text. */
export function hasKnownText(raw = {}) {
  if (typeof raw?.textKnown === 'boolean') return raw.textKnown;
  if (hasOwn(raw, 'text') || hasOwn(raw, 'message') || hasOwn(raw, 'body') || hasOwn(raw, 'message_text')) return true;
  const content = raw?.content;
  return Boolean(content && typeof content === 'object'
    && (hasOwn(content, 'text') || hasOwn(content, 'body') || hasOwn(content, 'caption')));
}

/**
 * A reaction array is meaningful only when its producer explicitly supplied a
 * snapshot. `[]` means “there are no reactions”; an omitted field means “we
 * do not know yet”. This prevents a lightweight realtime event from clearing
 * reaction actors already loaded with history.
 */
export function hasKnownReactions(raw = {}) {
  if (typeof raw?.reactionsKnown === 'boolean') return raw.reactionsKnown;
  return hasOwn(raw, 'reactionsDetailed') || hasOwn(raw, 'reactions');
}

/** The equivalent presence marker for media payloads. */
export function hasKnownAttachments(raw = {}) {
  if (typeof raw?.attachmentsKnown === 'boolean') return raw.attachmentsKnown;
  return hasOwn(raw, 'attachments') || hasOwn(raw, 'items') || hasOwn(raw, 'files');
}

function normalizeAttachments(raw) {
  if (Array.isArray(raw.attachments)) return raw.attachments;
  if (Array.isArray(raw.items)) return raw.items;
  if (Array.isArray(raw.files)) return raw.files;
  // An explicit empty media list is authoritative. Its presence marker above
  // distinguishes it from an update which has no media information at all.
  return [];
}

function normalizedGroupId(raw) {
  const value = raw?.groupId ?? raw?.group_id ?? raw?.media_group_id
    ?? raw?.album_id ?? raw?.media_group ?? null;
  return value === true || value === false || value == null ? '' : String(value).trim();
}

/** Convert provider-shaped data into the message shape expected by common UI. */
export function normalizeMessage(source, raw = {}) {
  const id = String(raw.id ?? raw.message_id ?? raw.messageId ?? raw.uid ?? '').trim();
  const direction = raw.direction === 'out' || raw.out === true || raw.fromMe === true ? 'out' : 'in';
  const reactionsKnown = hasKnownReactions(raw);
  const attachmentsKnown = hasKnownAttachments(raw);
  const textKnown = hasKnownText(raw);
  const reactions = reactionsKnown ? (raw.reactionsDetailed ?? raw.reactions ?? []) : [];
  return {
    ...raw,
    id,
    text: String(raw.text ?? raw.message ?? raw.body ?? raw.message_text
      ?? raw.content?.text ?? raw.content?.body ?? raw.content?.caption ?? ''),
    textKnown,
    timestamp: normalizedTimestamp(raw.timestamp ?? raw.date ?? raw.created ?? raw.t),
    direction,
    attachments: normalizeAttachments(raw),
    attachmentsKnown,
    reactions,
    reactionsKnown,
    replyTo: normalizeReply(raw),
    groupId: normalizedGroupId(raw),
    provider: getProvider(source).id,
  };
}

/**
 * Apply a partial event to a canonical message without treating omitted rich
 * fields as empty snapshots. It is shared by history hydration, realtime
 * patches and send-confirmation reconciliation.
 */
export function mergeMessageUpdate(source, previous = {}, patch = {}) {
  const before = normalizeMessage(source, previous);
  const incomingHasText = hasKnownText(patch);
  const incomingHasReactions = hasKnownReactions(patch);
  const incomingHasAttachments = hasKnownAttachments(patch);
  // Normalize alternate transport names before spreading a patch over prior
  // data. Otherwise stale `reactionsDetailed` or `attachments` in `before`
  // wins over a new `{ reactions: [] }` or `{ items: [...] }` snapshot.
  const incoming = normalizeMessage(source, patch);
  const overlay = { ...patch };
  if (incomingHasText) {
    overlay.text = incoming.text;
  } else {
    delete overlay.text;
    delete overlay.message;
    delete overlay.body;
    delete overlay.message_text;
    if (overlay.content && typeof overlay.content === 'object') {
      const content = { ...overlay.content };
      delete content.text;
      delete content.body;
      delete content.caption;
      overlay.content = content;
    }
  }
  if (incomingHasReactions) {
    // Assign `undefined`, rather than delete: `before` is spread first and
    // may carry an old alternate property that must be masked explicitly.
    overlay.reactionsDetailed = undefined;
    overlay.reactions = incoming.reactions;
  }
  if (incomingHasAttachments) {
    overlay.items = undefined;
    overlay.files = undefined;
    overlay.attachments = incoming.attachments;
  }
  const merged = normalizeMessage(source, {
    ...before,
    ...overlay,
    textKnown: incomingHasText ? true : before.textKnown,
    reactionsKnown: incomingHasReactions ? true : before.reactionsKnown,
    attachmentsKnown: incomingHasAttachments ? true : before.attachmentsKnown,
  });

  if (!incomingHasReactions) {
    merged.reactions = before.reactions;
    merged.reactionsKnown = before.reactionsKnown;
  }
  if (!incomingHasAttachments) {
    merged.attachments = before.attachments;
    merged.attachmentsKnown = before.attachmentsKnown;
  }
  if (!incomingHasText) {
    merged.text = before.text;
    merged.textKnown = before.textKnown;
  }
  return merged;
}

/** Normalize list records while preserving source-specific extra data. */
export function normalizeChat(source, raw = {}) {
  const provider = getProvider(source || raw.source);
  return {
    ...raw,
    source: provider.name,
    provider: provider.id,
    chat_id: String(raw.chat_id ?? raw.chatId ?? raw.id ?? ''),
    name: String(raw.name ?? raw.title ?? raw.display_name ?? 'Без названия'),
    last_message_time: normalizedTimestamp(raw.last_message_time ?? raw.updated_at ?? raw.timestamp),
  };
}

export const FeatureState = Object.freeze({
  READY: FEATURE_READY,
  NOT_IMPLEMENTED: FEATURE_NOT_IMPLEMENTED,
  SERVICE_UNSUPPORTED: FEATURE_SERVICE_UNSUPPORTED,
  UNAVAILABLE: FEATURE_UNAVAILABLE,
});
