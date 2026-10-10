# Follow-up for expert review: Telegram document batch protocol and UI identity

## Observed result

On 2026-10-10 the Windows WebView desktop build was restarted from the latest
private source.  In a Telegram chat, selecting several images, enabling
**Send as file**, and sending them still leaves one card per confirmed file.
The desired result is one outgoing file card with all selected documents and
one `Download all` action.  This report is intentionally limited to UI source
and tests; it contains no provider credentials, database, session, or logs.

## Corrected provider fact

Telegram `messages.sendMultiMedia` does support grouped documents, but every
item must first go through `messages.uploadMedia`; the returned document/photo
reference, not raw `inputMediaUploaded*`, belongs in the album call. This
package now contains that server-side conversion in `telegram_service/rest.php`
and routes «Send as file» multi-selection to the native batch path.

A successful HTTP response is still not a delivery receipt. Each native ID is
kept as a child of one user operation, and the visual card groups only exact
native `grouped_id` or exact, fully confirmed operation membership. It never
uses a time window for outgoing documents.

## Current implementation to review

1. `ChatOutbox` uses the durable native batch route for Telegram files,
   including the explicit `attachment_as_file` mode.
2. A `source_type: document` attachment now wins over image MIME, a legacy
   `photo` type and animation detection. It must render as a file row, never
   as a large gallery image.
3. `MessageRenderer` expands an aggregate into individual native children
   before reconciliation and merges duplicated native IDs, so a preceding
   receipt cannot discard the later attachment snapshot.
4. Every native ID returned as accepted is written as a sent (`ack: 1`) state,
   not delivery or read. A multi-file card derives its indicator from every
   child, rather than only the final child.
5. `ChatAlbums._collapseLocalOutgoingDocumentBatches` combines exact native
   grouped IDs even when another message is interleaved, and retains a
   per-open-chat exact-ID registry so a sibling arriving in a later
   history/realtime update refreshes one existing card. Synthetic
   request-scoped groups still require all expected IDs.
6. Receipt-only events update delivery status but cannot replace an attachment
   snapshot or prematurely complete a batch. If provider children share an
   authoritative native group ID, optimistic reconciliation preserves it
   rather than replacing it with a local identity.
7. The read-back path now has one Telegram document classifier. A
   `messageMediaDocument` whose bytes are JPEG/PNG remains `document` with
   `source_type: document` in history, `get_messages_by_ids` and webhook;
   only explicit Telegram attributes retain sticker/animation/video-note
   presentation. The PHP adapter preserves that source field.
8. Updating an already displayed document group is two-phase: native members
   are first merged from the registry, current page and old DOM card; the old
   card is removed only after a new aggregate DOM node has been constructed.
   An omitted member of a partial page is never interpreted as deletion.
9. The generic replacement path is now restricted to explicit document
   groups. Incoming WhatsApp photo albums stay with their existing native
   upsert, so a partial `[B, C]` update cannot remove an existing `[A, B, C]`
   card. The same shared document predicate is used by renderer, media helper
   and WhatsApp album transport; `kind: document` with image MIME is excluded
   from photo albums.
10. This review branch now includes the current MAX adapter, relay and sidecar
    sources. `attachment_as_file` is propagated as `send_as_file` to the
    sidecar; JPG/PNG select `File` rather than `Photo`. MAX deliberately
    sends multiple documents sequentially because its native batch endpoint
    permits photo albums only.

The native flow has not been exercised against a production chat in this
package. Do not assume it is verified merely because focused contracts pass.
Please trace the live ordering and module loading end-to-end:

- whether the UI entrypoint imports the same `BaseChat`, `ChatOutbox`, and
  `ChatAlbums` revisions that the desktop package serves;
- whether each sequential document result reaches `element._batchMessages`
  before the optimistic element is removed or morphed elsewhere;
- whether realtime/history sees native IDs before the batch is bound and
  bypasses `_consumeOptimisticMessage`;
- whether a later history refresh replaces the aggregate with individual rows;
- whether the journal's account scoping or component status prevents exact-ID
  reconstruction;
- whether another render path, including provider subclasses, operates on a
  different chat instance or DOM root.

## Reproduction

1. Open a Telegram direct chat in the desktop WebView client.
2. Use the paperclip, select two or more image files, enable **Send as file**,
   and send once.
3. Wait for all send/realtime/history updates, then close and reopen the chat.
4. Inspect whether the outgoing selection remains a single file batch both
   immediately and after history reload.

## Included focused tests

- `tests/local-document-batch-reconciliation-contract.cjs` executes the real
  `ChatOutbox._completeBatchReconciliation` method with a narrow DOM seam.
- `tests/local-document-batch-history-contract.cjs` executes the real
  `ChatAlbums._collapseLocalOutgoingDocumentBatches` method for complete,
  partial, unknown-outcome and interleaved native-group cases.
- `tests/document-batch-event-order-contract.cjs` verifies that a presentation
  aggregate never becomes a single snapshot keyed by its last native ID, and
  that receipt-plus-full-message snapshots merge their attachments.
- `tests/document-batch-receipt-state-contract.cjs` verifies accepted vs
  delivered/failed state aggregation across a single visible file card.
- `tests/telegram-document-read-contract.php` drives the real document
  classifier with JPG, PNG, video, sticker and animation fixtures, and checks
  that the three read routes use it and retain `source_type` through the
  adapter.
- `tests/attachment-classification-contract.cjs` checks agreement between the
  shared document predicate and the WhatsApp album transport.
- `tests/max-attachment-send-contract.py` checks both JPG and PNG forced to
  `File` through the current MAX sidecar method.

They establish intended local invariants, not proof of the full WebView flow.
