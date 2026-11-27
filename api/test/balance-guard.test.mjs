import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planRefill, GUARD } from '../src/balance-guard.mjs';

const ccd = (n) => BigInt(n) * 1_000_000n;
const base = { payer: ccd(1000), owner: ccd(100000), seller2: ccd(500) };

test('guard: nothing to do when everyone is above their low mark', () => {
  assert.equal(planRefill({ balances: base, history: [] }).action, 'none');
});
test('guard: a low payer is topped up to the target from the owner', () => {
  const p = planRefill({ balances: { ...base, payer: ccd(40) }, history: [] });
  assert.equal(p.action, 'refill');
  assert.equal(p.wants[0].role, 'payer');
  assert.equal(p.wants[0].amount, GUARD.payerTarget - ccd(40));
});
test('guard: rate limited by interval, by day, and by the owner floor', () => {
  const low = { ...base, payer: ccd(10) };
  const now = Date.now();
  assert.equal(planRefill({ balances: low, history: [{ at: new Date(now - 1000).toISOString() }], now }).reason, 'rate_limited_interval');
  const many = Array.from({ length: GUARD.maxPerDay }, (_, i) => ({ at: new Date(now - (i + 2) * 600_000).toISOString() }));
  assert.equal(planRefill({ balances: low, history: many, now }).reason, 'rate_limited_daily');
  assert.equal(planRefill({ balances: { ...low, owner: ccd(5100) }, history: [], now }).reason, 'owner_below_floor');
});
test('guard: the second seller account is refilled too', () => {
  const p = planRefill({ balances: { ...base, seller2: ccd(5) }, history: [] });
  assert.deepEqual(p.wants.map((w) => w.role), ['seller2']);
});

test('send failures: a funds error is recognised (typed 503 refilling_fees, never a bare 500)', async () => {
  const { isFundsError } = await import('../src/server.mjs');
  assert.equal(isFundsError(new Error('The sender did not have enough funds to cover the transaction')), true);
  assert.equal(isFundsError(new Error('something else')), false);
});
