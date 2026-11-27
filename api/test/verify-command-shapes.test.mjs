// The keyless verifier CLI: every command shape the app prints must parse, failures must be one clean line
// (never a stack), and (opt-in, PAYONCE_LIVE=1, reads the public testnet) the judges commands must pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { parseVerifyArgs, UsageError } from '../src/verify-args.mjs';

const CLI = fileURLToPath(new URL('../src/verify-payable-v2.mjs', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [CLI, ...args], { encoding: 'utf8', timeout: 120_000 });
const H = (c) => c.repeat(64);
const S2 = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';

test('parser: CCD, seller 2, and EUDemo shapes', () => {
  assert.equal(parseVerifyArgs(['10', H('a'), '--doc', 'd.txt']).docPath, 'd.txt');
  assert.equal(parseVerifyArgs(['5010', H('b'), '--seller', S2, '--doc', 'x']).seller, S2);
  const eu = parseVerifyArgs(['11', H('c'), '--doc', 'd', '--reserve', H('d'), '--confirm', H('e')]);
  assert.equal(eu.reserve, H('d'));
  assert.equal(eu.confirm, H('e'));
});

test('parser: bad input is a UsageError with a plain message', () => {
  for (const argv of [[], ['x', H('a')], ['5', 'short'], ['5', H('a'), '--nope'], ['5', H('a'), '--seller'], ['5', H('a'), '--rail', 'btc'], ['5', H('a'), '--reserve', 'zz']]) {
    assert.throws(() => parseVerifyArgs(argv), UsageError);
  }
});

test('CLI: usage errors print one clean message, exit 2, no stack trace', () => {
  for (const args of [['abc'], ['5', 'nothex'], ['5', H('a'), '--bogus'], ['5', H('a'), '--seller']]) {
    const r = run(...args);
    assert.equal(r.status, 2, args.join(' '));
    assert.match(r.stderr, /^error: /);
    assert.doesNotMatch(r.stderr + r.stdout, /\n\s+at |node:internal|file:\/\//);
  }
});

test('CLI: an unreadable --doc file is a clean message', () => {
  const r = run('5', H('a'), '--doc', 'no-such-file.txt');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /cannot read the --doc file/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});

const live = process.env.PAYONCE_LIVE === '1';
test('LIVE: judges payable 10 (CCD) and 11 (EUDemo) commands pass as printed', { skip: !live }, () => {
  const doc10 = '../backend/test/invoices/invoice-010-v2-ccd.txt';
  const doc11 = '../backend/test/invoices/invoice-011-v2-eudemo.txt';
  const a = run('10', '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197', '--doc', doc10);
  assert.equal(a.status, 0, a.stdout + a.stderr);
  assert.match(a.stdout, /ALL CHECKS PASS \(10\/10\)/);
  const b = run('11', '690c5e2beebd25554b81e18d014aa81c7adde3f35bff505fe0615efe536d2214', '--doc', doc11,
    '--reserve', 'a36aa1e0d2ea71a4702075cd0d94752fac7f088dfb52d4038322b7e617180f0d', '--confirm', 'adf55f61c1345d14f05c6c0ee59b996dae8aaef06213e485a17cfb96376100c2');
  assert.equal(b.status, 0, b.stdout + b.stderr);
  assert.match(b.stdout, /ALL CHECKS PASS \(14\/14\)/);
});
test('LIVE: a seller-2 payable without --seller is a clean "add --seller" message', { skip: !live }, () => {
  const r = run('5010', H('a'));
  assert.equal(r.status, 3);
  assert.match(r.stderr, /--seller/);
  assert.doesNotMatch(r.stderr, /\n\s+at /);
});
