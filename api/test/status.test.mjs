import test from 'node:test';
import assert from 'node:assert/strict';
import { createStatus, AGENTS } from '../src/status.mjs';

const okFetch = (valid = true) => async (url) => ({ ok: true, json: async () => (String(url).includes('check-badge') ? { agents: [{ badge_valid: valid, issues: valid ? [] : [{ field: 'metadata_hash' }] }] } : { networks: { testnet: { agents: 1 }, mainnet: { agents: 2 } } }) });
const deps = (over = {}) => ({ fetchImpl: okFetch(), loadCensus: async () => ({ served: { stale: false, age_hours: 2, source: 'github' } }), testnetNode: async () => ({ detail: 'h1' }), mainnetNode: async () => ({ detail: 'h2' }), now: () => 1000, ...over });

test('status: everything up -> ok, not degraded, three badges valid', async () => {
  const s = await createStatus(deps())();
  assert.equal(s.ok, true); assert.equal(s.degraded, false); assert.equal(s.badges.length, AGENTS.length); assert.ok(s.badges.every((b) => b.valid));
});
test('status: a lost badge makes it NOT ok and names the issue (badge continuity)', async () => {
  const s = await createStatus(deps({ fetchImpl: okFetch(false) }))();
  assert.equal(s.ok, false); assert.equal(s.checks.find((c) => c.id === 'badges').ok, false); assert.deepEqual(s.badges[0].issues, ['metadata_hash']);
});
test('status: a stale census is not ok; a dead node only degrades', async () => {
  const stale = await createStatus(deps({ loadCensus: async () => ({ served: { stale: true, age_hours: 30, source: 'bundled' } }) }))();
  assert.equal(stale.ok, false);
  const degraded = await createStatus(deps({ testnetNode: async () => { throw new Error('UNAVAILABLE'); } }))();
  assert.equal(degraded.ok, true); assert.equal(degraded.degraded, true);
});
test('status: cached for 60 s', async () => {
  let t = 1000; let n = 0;
  const st = createStatus(deps({ now: () => t, testnetNode: async () => { n++; return {}; } }));
  await st(); t += 30_000; const b = await st(); assert.equal(b.cached, true); assert.equal(n, 1);
  t += 40_000; await st(); assert.equal(n, 2);
});
