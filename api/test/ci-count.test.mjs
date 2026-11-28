import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLog } from '../../qa/ci/count-tests.mjs';
import { aggregate, badge } from '../../qa/ci/aggregate-tests.mjs';

test('parses node --test (tap and spec), vitest and cargo summaries; the last node run wins', () => {
  assert.deepEqual(parseLog('node', '1..3\n# tests 3\n# suites 0\n# pass 3\n# fail 0\n# cancelled 0\n'), { tests: 3, pass: 3, fail: 0 });
  assert.deepEqual(parseLog('node', 'ℹ tests 10\nℹ suites 1\nℹ pass 9\nℹ fail 1\nretrying\nℹ tests 10\nℹ pass 10\nℹ fail 0\n'), { tests: 10, pass: 10, fail: 0 });
  assert.deepEqual(parseLog('vitest', '\x1b[2m Test Files \x1b[22m 2 passed (2)\n      Tests  1 failed | 41 passed | 2 skipped (44)\n'), { tests: 44, pass: 41, fail: 1 });
  assert.deepEqual(parseLog('vitest', ' Tests  61 passed (61)\n'), { tests: 61, pass: 61, fail: 0 });
  assert.deepEqual(parseLog('cargo', 'test result: ok. 100 passed; 0 failed; 0 ignored\ntest result: ok. 1 passed; 0 failed; 0 ignored\n'), { tests: 101, pass: 101, fail: 0 });
  assert.equal(parseLog('node', 'nothing here'), null);
});
test('skipped tests are counted as skipped, not as passing', () => {
  const a = aggregate([{ label: 'x', runner: 'node', tests: 10, pass: 8, fail: 0 }]);
  assert.equal(a.skipped, 2); assert.equal(badge(a).message, '8 passing, 2 skipped');
});
test('aggregate sums the suites; the badge goes red on any failure', () => {
  const a = aggregate([{ label: 'api', runner: 'node', tests: 5, pass: 5, fail: 0 }, { label: 'frontend', runner: 'vitest', tests: 3, pass: 3, fail: 0 }]);
  assert.equal(a.total, 8); assert.equal(a.skipped, 0); assert.deepEqual(badge(a), { schemaVersion: 1, label: 'tests (CI)', message: '8 passing', color: 'brightgreen' });
  assert.equal(badge(aggregate([{ label: 'x', runner: 'node', tests: 2, pass: 1, fail: 1 }])).color, 'red');
});
