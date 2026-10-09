# UI and server review packet — 2026-10-09

This is a restricted public snapshot for reviewing the current Unified
Messenger desktop UI and the server paths that supply MAX contacts and media.
It is not runnable against a provider and must never be used to access a
production account.

## Review goals

Please look for concrete correctness, security, lifecycle and UI-state errors
in these areas:

1. Shared UI: chat switching, history pagination, cancellation, media loading,
   loading/error states, layout consistency, accessible controls and stale
   event handlers.
2. Desktop transport: authentication boundary, response/stream ownership,
   Range requests, cancellation and disposal in the WebView2 host.
3. MAX: read-only contact profiles, avatar/media relays, history read
   isolation, attachment rendering and fallback behaviour.
4. Server facade: allowlists and error handling around `desktop_api.php`,
   `max_api.php`, `max_auth.php` and `media_stream.php`.

Prioritise reproducible findings. For each issue, include affected file and
line, impact, a minimal scenario, and a narrowly scoped patch suggestion.

## Review update

This snapshot includes the fixes for the review findings reported on
2026-10-09. The shared UI changes are in source so they can be inspected:

- `MediaUrls.js` and `ApiService.js` keep a response timeout through body
  consumption; `media_stream.php` relays headers and body from one upstream
  request and preserves Range responses.
- `MaxHistoryQueue.js` replaces an unstarted stale history request; MAX
  history reads in `max_service/app.py` use a separate lock.
- `mainPage.js` rejects non-WhatsApp events in the WhatsApp receipt path.
- `SendJournal.js` accepts MAX's one-message album confirmation; `ChatOutbox.js`
  and `MediaGallery.js` clean up Blob URLs and avoid publishing a partial ZIP.
- `max_service/app.py` reads sticker data in bounded chunks and keeps an
  opaque static preview separate from the Lottie payload.

The desktop artifact is not included in this source-only repository. A local
Release build, `desktop-win-x64-review-fixes-v35`, copied the listed UI files
without hash differences and was started successfully. Its packaging rule is
in `desktop/UnifiedMessenger.Desktop/UnifiedMessenger.Desktop.csproj`.

## Follow-up after review

The following source changes respond to the second review round:

- `ChatRealtime.js` now requires a matching provider and, when known, account
  before a desktop realtime event can match a chat ID.
- `DesktopUiHost.cs` abandons a ZIP after any entry read fails. Its archive and
  ordinary native download paths apply a two-minute body-read deadline.
- `MessageRenderer.js` escapes interpolated video/audio metadata and limits
  MIME strings to a safe media-token form.
- `max_api.php` streams the MAX sidecar response through cURL callbacks. It
  does not buffer a whole MAX video in PHP. Both MAX and external media relays
  omit Content-Length on a 416 response body that they do not send.
- `max_service/app.py` bounds read-queue waits, favours already queued short
  reads over another history page, bounds and reuses opaque media tokens, clears
  them on logout, and emits no sticker preview reference without a static URL.
- `src/Services/SendResult.php` is included for the MAX album boundary. It
  retains `single_message_album` and `attachment_count` after adapter result
  normalization, so `SendJournal.js` receives the same evidence the sidecar
  returned.

`tests/expert-review-followup-contract.cjs` covers these source boundaries.
PHP lint, Python compile, JS contracts and the private Release build passed.
The public snapshot has the desktop host source but deliberately excludes the
full desktop project file and binary, so its C# build runs only in private.

## Compatibility bridge media-reference renewal

The bridge used to retry an expired opaque media URL by appending `r=...` to
the same reference. It now has a session-bound renewal route. Telegram,
WhatsApp and local-cache attachments retain a typed attachment identity for
24 hours and receive a new opaque `/bridge-media?ref=...` URL. Concurrent
element errors reuse the same replacement reference. Provider URLs do not
leave the bridge.

MAX sidecar tokens and VK/Avito CDN URLs are excluded from that renewal store.
They may already be expired upstream capabilities. The UI stops the retry and
asks the user to update the chat, whose next history response creates a fresh
reference. The private bridge fixture checks renewal, replacement identity and
the MAX no-replay rule. `tests/bridge-media-refresh-contract.cjs` in this
snapshot checks the browser route and final UI state.

## Direct MAX renewal and slow-download follow-up

The direct desktop route now renews one expired MAX media ref from the bounded
chat, message, attachment index and account identity that came with the
history item. The sidecar rejects the request after an account switch. The UI
uses the shared body-timeout helper, cancels the request when the chat closes,
and ignores a late result from an older media attempt.

One successful renewal replaces the player source, `data-download-url`, both
download links, and the lightbox download URL for that attachment. `name` and
`dl` query parameters stay intact. The MAX read scheduler has no second lock
outside its queue budget.

Desktop body copies now use a 45-second no-progress timeout and a separate
20-minute total limit. The same code covers normal downloads and archive
entries. `tests/media-refresh-followup-contract.cjs` checks these source
boundaries. It is static coverage; provider media and account switching still
need an authorised end-to-end run.

## MAX attachment send and infrastructure health

The previous review commit had two independent failures. `send_attachments`
discarded the client returned by `writable_chat`, then used an undefined name
when it prepared a reply or called MAX. The sidecar now keeps that validated
client. A partial `last_message` in the MAX chat-list response may have no
`chat_id`; serialization now omits renewable attachment identity for that
partial item instead of raising an exception.

The UI message "Не подтверждена работа провайдеров: MAX." is formed by the
health handler when `HistoryRecoveryStatus::snapshot()` marks MAX unavailable
or stale. It does not directly state that the MAX sidecar session is logged
out. The review snapshot now includes:

- `review/infrastructure-health-handler.php`, the extracted API handler;
- `src/Services/HistoryRecoveryStatus.php`, the MAX recovery-state rules;
- `tests/max-attachment-send-contract.py` and
  `tests/max-message-serialization-contract.py`, offline regressions for the
  attachment client and partial chat-list message.

The live incident that prompted this update had a connected, read-only MAX
sidecar while the recovery row retained `provider_unavailable` during its
backoff. Review the recovery path and its queue budget separately from the
session-status route.

## Deliberate privacy and safety boundaries

- MAX contact cards project only fields MAX has already returned for the
  selected profile. The server never searches, imports or resolves a phone
  number separately.
- A phone is shown only if MAX makes it visible to the connected account and
  passes basic format validation. Profile links are restricted to normal HTTPS
  URLs without credentials.
- The snapshot contains no `.env`, production configuration, device token,
  SSH key, cookies, provider session, database, user message, attachment or
  production log.
- Do not propose a change that resets a provider session/QR, marks chats read,
  sends a test message, manufactures a webhook or exposes provider URLs to the
  browser.

## Included source map

| Area | Files |
| --- | --- |
| Shared UI entry and layout | `main.php`, `js/src/` |
| Shared chat lifecycle and media UI | `js/src/ui/BaseChat.js`, `js/src/ui/chat/`, `js/src/controllers/` |
| WebView2 desktop transport | `desktop/UnifiedMessenger.Desktop/Services/DesktopUiHost.cs`, `DirectConnection.cs` |
| Desktop server facade | `desktop_api.php` |
| Active compatibility/read-only bridge | `legacy-bridge-router.php`, `live-readonly-router.php` |
| MAX PHP adapters | `max_api.php`, `max_auth.php`, `src/Services/MaxClient.php` |
| MAX private sidecar | `max_service/app.py`, `persistent_state.py`, `media_compat.py`, `upload_compat.py` |
| Infrastructure status | `review/infrastructure-health-handler.php`, `src/Services/HistoryRecoveryStatus.php` |
| External media facade | `media_stream.php` |
| Provider capability contract | `config/provider-capabilities.json` |
| Regression contracts | `tests/max-*-contract.py`, `tests/bridge-profile-contract.php`, `tests/profile-trigger-contract.cjs` |

The Telegram media files remain in the snapshot because the shared UI and
desktop transport use the same loader and response-ownership rules. Their
separate design context is in
[expert-telegram-media-review.md](expert-telegram-media-review.md).

## Current MAX contact-profile flow

```text
contact-details UI
  -> authenticated desktop facade / compatibility bridge
  -> max_api.php / MaxClient.php
  -> loopback MAX sidecar: GET /v1/chats/{chat_id}/profile
  -> existing authenticated PyMAX session
```

The contact read is intended to be read-only. The sidecar resolves only the
peer already present in the selected direct chat, serializes a limited profile
shape, and relays avatar/media through opaque references. The browser does not
receive a provider URL or session credential.

## Snapshot boundary

This document and the reviewed source changes are in the current public
commit. The snapshot is intentionally not a full mirror. Conclusions about
omitted infrastructure or provider integrations should be marked as out of
scope rather than assumed.
