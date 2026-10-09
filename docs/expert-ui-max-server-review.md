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

## Baseline

Public snapshot head: `f5cc75e` (`Preserve MAX sticker preview relay`). It
contains the reviewed UI and server paths, but is intentionally not a full
mirror. Conclusions about omitted infrastructure or provider integrations
should be marked as out of scope rather than assumed.
