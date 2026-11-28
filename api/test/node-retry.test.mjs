import test from 'node:test';
import assert from 'node:assert/strict';
import { withRetry, retryingReads, isTransient } from '../src/node-retry.mjs';

const noSleep = { sleep: async () => {}, random: () => 0.5 };
const e429 = () => Object.assign(new Error('Received HTTP status code 429'), { code: 8 });

test('a 429 is retried with growing waits, then succeeds', async () => {
  let n = 0; const waits = [];
  const r = await withRetry(async () => { if (++n < 3) throw e429(); return 'ok'; }, { ...noSleep, sleep: async (ms) => waits.push(ms) });
  assert.equal(r, 'ok'); assert.equal(n, 3);
  assert.ok(waits[1] > waits[0], 'backoff grows');
});

test('a persistent 429 gives up after the limit; a real error is thrown at once', async () => {
  let n = 0;
  await assert.rejects(() => withRetry(async () => { n += 1; throw e429(); }, { ...noSleep, tries: 4 }), /429/);
  assert.equal(n, 4);
  let m = 0;
  await assert.rejects(() => withRetry(async () => { m += 1; throw new Error('payee not found'); }, noSleep), /not found/);
  assert.equal(m, 1);
  assert.ok(isTransient(new Error('14 UNAVAILABLE: No connection established')));
  assert.ok(!isTransient(new Error('rejected by the node: signature')));
});

test('retryingReads retries read methods only; sendTransaction-style calls are never retried', async () => {
  const calls = { getAccountInfo: 0, sendBlockItem: 0 };
  const client = {
    async getAccountInfo() { if (++calls.getAccountInfo < 3) throw e429(); return { ok: true }; },
    async sendBlockItem() { calls.sendBlockItem += 1; throw e429(); },
    plain: 7,
  };
  const c = retryingReads(client, noSleep);
  assert.deepEqual(await c.getAccountInfo(), { ok: true }); assert.equal(calls.getAccountInfo, 3);
  await assert.rejects(() => c.sendBlockItem(), /429/); assert.equal(calls.sendBlockItem, 1, 'a send is attempted exactly once');
  assert.equal(c.plain, 7);
});
