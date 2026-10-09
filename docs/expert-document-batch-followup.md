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
2. `MessageRenderer` expands an aggregate into individual native children
   before reconciliation; it then creates presentation groups only afterwards.
3. `ChatAlbums._collapseLocalOutgoingDocumentBatches` combines exact native
   grouped IDs even when another message is interleaved, while synthetic
   request-scoped groups require all expected IDs.
4. Receipt-only events update delivery status but cannot replace an attachment
   snapshot or prematurely complete a batch.

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
  aggregate never becomes a single snapshot keyed by its last native ID.

They establish intended local invariants, not proof of the full WebView flow.
