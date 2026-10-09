# Follow-up for expert review: document batch still splits in the desktop UI

## Observed result

On 2026-10-10 the Windows WebView desktop build was restarted from the latest
private source.  In a Telegram chat, selecting several images, enabling
**Send as file**, and sending them still leaves one card per confirmed file.
The desired result is one outgoing file card with all selected documents and
one `Download all` action.  This report is intentionally limited to UI source
and tests; it contains no provider credentials, database, session, or logs.

## Provider fact already established

Telegram sends document-mode selections as separate native messages.  That is
expected: they are not a native Telegram media album.  The UI therefore must
preserve the user's single selection as one request-scoped visual group without
guessing from timestamps.  A successful HTTP response is not a delivery
receipt; the relevant evidence is the individual native message IDs.

## Current implementation to review

1. `ChatOutbox._registerBatchExpectedId` records every known native ID before
   realtime/history can render a duplicate.
2. `ChatOutbox._completeBatchReconciliation` is meant to replace the one
   optimistic node with a combined message after all expected IDs arrive.
3. `SendJournal` persists component IDs per request and account.
4. `ChatAlbums._collapseLocalOutgoingDocumentBatches` is meant to combine the
   matching history rows again after reopening a chat.
5. `MessageRenderer.renderMessagesBatch` calls this reconstruction before
   provider-specific album handling.

Despite those paths, the actual WebView result is still separate cards.  Do
not assume the synthetic group works merely because the focused unit contracts
pass.  Please trace the live ordering and module loading end-to-end:

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
  partial, and unknown-outcome cases.

They establish intended local invariants, not proof of the full WebView flow.
