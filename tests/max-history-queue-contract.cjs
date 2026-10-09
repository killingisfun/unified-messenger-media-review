const assert = require('node:assert/strict');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

(async () => {
  const moduleUrl = pathToFileURL(path.resolve(__dirname, '../js/src/core/MaxHistoryQueue.js')).href;
  const { MaxHistoryQueue } = await import(moduleUrl);
  const queue = new MaxHistoryQueue();
  const started = [];
  let active = 0;
  let peak = 0;
  const run = (name, delay) => async () => {
    started.push(name);
    peak = Math.max(peak, ++active);
    await new Promise(resolve => setTimeout(resolve, delay));
    active--;
    return name;
  };

  const first = queue.enqueue('first', run('first', 25));
  const stale = queue.enqueue('stale', run('stale', 1), () => false);
  const third = queue.enqueue('third', run('third', 1));
  const sameThird = queue.enqueue('third', run('third-duplicate', 1));

  assert.equal(sameThird, third, 'duplicate MAX page request shares the same queued result');
  assert.equal(await first, 'first');
  await assert.rejects(stale, error => error?.name === 'AbortError' && error?.code === 'max_history_stale');
  assert.equal(await third, 'third');
  assert.equal(peak, 1, 'only one MAX history request runs at a time');
  assert.deepEqual(started, ['first', 'third'], 'stale non-active chat never reaches its provider request');

  // Navigation can leave a stale page queued and then return to the same
  // cursor before the first active request drains. The fresh view must get a
  // new job, not inherit the stale promise's AbortError.
  const replacementQueue = new MaxHistoryQueue();
  let oldStillCurrent = true;
  const blocker = replacementQueue.enqueue('blocker', run('blocker', 15));
  const oldPage = replacementQueue.enqueue('same-page', run('old-page', 1), () => oldStillCurrent);
  const oldPageRejected = assert.rejects(oldPage, error => error?.code === 'max_history_stale');
  oldStillCurrent = false;
  const freshPage = replacementQueue.enqueue('same-page', run('fresh-page', 1), () => true);
  await blocker;
  await oldPageRejected;
  assert.equal(await freshPage, 'fresh-page', 'fresh navigation replaces only a stale queued duplicate');
  assert.ok(!started.includes('old-page'), 'replaced stale page never starts a provider read');
  console.log('max-history-queue-contract-ok');
})().catch(error => { console.error(error); process.exit(1); });
