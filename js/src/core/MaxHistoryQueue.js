/**
 * One MAX history RPC is allowed at a time in this browser tab.
 *
 * The MAX sidecar has the authoritative process-wide gate too. This smaller
 * client queue keeps rapid SPA navigation from filling that gate with history
 * requests for chats which have already been closed. A stale queued request
 * is never started.
 */
function staleRequestError() {
  const error = new Error('MAX history request is no longer needed.');
  error.name = 'AbortError';
  error.code = 'max_history_stale';
  return error;
}

export class MaxHistoryQueue {
  constructor() {
    this.pending = [];
    this.byKey = new Map();
    this.running = false;
  }

  enqueue(key, run, isCurrent = () => true) {
    const normalizedKey = String(key || '');
    if (!normalizedKey) return Promise.reject(new Error('MAX history queue key is required.'));
    const existing = this.byKey.get(normalizedKey);
    if (existing) return existing.promise;

    let resolve;
    let reject;
    const job = {
      key: normalizedKey,
      run,
      isCurrent,
      promise: new Promise((ok, fail) => { resolve = ok; reject = fail; }),
      resolve,
      reject,
    };
    this.byKey.set(normalizedKey, job);
    this.pending.push(job);
    void this._drain();
    return job.promise;
  }

  async _drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const job = this.pending.shift();
        try {
          if (typeof job.isCurrent === 'function' && !job.isCurrent()) {
            throw staleRequestError();
          }
          job.resolve(await job.run());
        } catch (error) {
          job.reject(error);
        } finally {
          this.byKey.delete(job.key);
        }
      }
    } finally {
      this.running = false;
      // A request can be appended after the final loop condition and before
      // `running` is reset. Start a fresh drain without running two jobs.
      if (this.pending.length) void this._drain();
    }
  }
}

export const maxHistoryQueue = new MaxHistoryQueue();
