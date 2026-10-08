// One browser-local authority for compact AI queue status.  Views may keep
// their own conversation details, but they must use this snapshot for queue
// progress and freshness so the header and list cannot disagree about it.
let snapshot = Object.freeze({ chats: {}, settings: {}, stale: true, loading: true, updatedAt: 0 });
const listeners = new Set();

export function aiStatusSnapshot() { return snapshot; }

export function publishAiStatuses(next) {
  snapshot = Object.freeze({
    chats: next?.chats && typeof next.chats === 'object' ? next.chats : {},
    settings: next?.settings && typeof next.settings === 'object' ? next.settings : {},
    stale: next?.stale === true,
    loading: next?.loading === true,
    updatedAt: Number(next?.updatedAt || 0),
  });
  // The inbox renderer is intentionally independent from the AI module.  A
  // tiny read-only bridge lets it choose an honest empty state while list
  // sections are being rebuilt.
  if (typeof window !== 'undefined') window.__unifiedAiStatusSnapshot = snapshot;
  for (const listener of listeners) listener(snapshot);
  document.dispatchEvent(new CustomEvent('ai:statuses', { detail: snapshot }));
}

export function subscribeAiStatuses(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
