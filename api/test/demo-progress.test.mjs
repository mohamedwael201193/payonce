import test from 'node:test';
import assert from 'node:assert/strict';
import { progressFor } from '../src/demo-progress.mjs';

const H = (c) => c.repeat(64);
const lock = { until_ms: 2_000, started_at: 'T0' };

test('progress is returned in visitor order, only valid hashes, only for the run that holds the lock', () => {
  const p = progressFor({ lock, now: 1_000, progress: { started_at: 'T0', at: 'T1', step: 'invoice', txs: { pay: H('b'), register: H('a'), bind: 'nope', junk: H('c') } } });
  assert.deepEqual(p.steps.map((s) => s.key), ['register', 'pay']);
  assert.equal(p.steps[1].label, 'Paid once');
  assert.equal(p.steps[0].hash, H('a'));
});

test('no progress when the lock is over or belongs to another run', () => {
  const progress = { started_at: 'T0', txs: { register: H('a') } };
  assert.equal(progressFor({ lock, now: 3_000, progress }), null);
  assert.equal(progressFor({ lock: { ...lock, started_at: 'T9' }, now: 1_000, progress }), null);
  assert.equal(progressFor({ lock, now: 1_000, progress: null }), null);
});
