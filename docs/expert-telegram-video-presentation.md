# Telegram video presentation update

This review update covers the recently reported desktop/WebView video path:
an outgoing Telegram video could first render as a black player, use the wrong
aspect ratio, and leave an extra optimistic bubble while the confirmed message
arrived. The package contains source and deterministic contracts only; it does
not contain a Telegram session, device credentials, customer media, logs, or
production configuration.

## Code included in this update

- `telegram_service/rest.php` recognises a Telegram document with a
  `documentAttributeVideo` as video even when its MIME metadata is incomplete,
  and exposes width, height, duration, and a separate preview URL.
- `src/Services/TelegramClient.php` preserves that normalized metadata when
  converting the REST response into the shared message format.
- `MessageRenderer.js`, `MediaLoader.js`, `ChatOutbox.js`, and
  `chat-runtime.css` keep a local outgoing blob playable before confirmation,
  prefer an image poster over video bytes, apply provider dimensions before
  network loading, and avoid a fixed thumbnail geometry.
- `tests/telegram-video-presentation-contract.cjs` and the extended
  `tests/telegram-document-read-contract.php` cover the server and UI
  normalization boundaries without talking to Telegram.

## Reconciliation and poster follow-up

The latest update closes two UI boundaries that were not covered by the first
video snapshot:

- Every provider, including WhatsApp, now uses exact native-message identity
  when a realtime/history record reaches the UI before the send response. The
  local operation card is retained and absorbs the provider record instead of
  leaving two cards or throwing away its local Blob preview.
- An attachment confirmation updates the existing card's available URL,
  download target, poster and dimensions in place. It does not restart active
  playback. A video poster is accepted only after a separate image decode;
  missing, failed or transparent 1x1 thumbnails get an explicit preview-not-
  available surface instead of a black player.

The fixture contracts deliberately cover both realtime-before-response and
poster unavailable/ready transitions. They require no provider account.

The current update also preserves the local decoded `width`, `height`, and
`duration` only when the incoming server attachment omits those values. The
server record still owns its native ID, MIME, remote URL and download action.
This prevents the transient hybrid where a provider-confirmed message had a
local frame but lost its portrait/square geometry while server metadata was
still incomplete.

## Review questions

1. Is the attachment contract sufficiently explicit to distinguish a video
   document, an ordinary document, a photo, and a browser-unsupported video?
2. Can a delayed history/realtime confirmation still cause the optimistic
   outgoing video and confirmed server message to coexist? In particular,
   assess the native-ID reconciliation path shared with other attachment types.
3. Are poster selection, fallback download behavior, and dimensions safe for
   absent thumbnails, malformed MIME values, portrait video, and square video?
4. Does any provider-specific adapter bypass the shared attachment fields and
   reintroduce a black `<video>` element or an incorrect media classification?

## Reproduce only with fixtures

Run the two contracts independently:

```powershell
node tests/telegram-video-presentation-contract.cjs
php tests/telegram-document-read-contract.php
```

Do not use this public snapshot to send messages or access a production
account. A successful provider HTTP response is not a delivery confirmation.
