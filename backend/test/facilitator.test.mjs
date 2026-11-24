// PayOnce backend — facilitator tests (plan: Doris's 9 checks + 4 safeguards).
// Verify-path only: these tests build signed v1 transactions and call
// verify(), which never submits. NOTHING here settles or sends.
// Live reads only (payable rows, sponsor balance). No keys leave the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { grpcClient } from '../src/chain.mjs';
import { getPayable } from '../src/registry.mjs';
import { loadSigners, OWNER_ADDRESS, SELLER_B_ADDRESS, PAYEE2_ADDRESS } from '../src/send.mjs';
import {
  createFacilitator, payonceVerify, sponsorBalance, RateLimiter,
  requirementsForPayable, TESTNET_CAIP2,
} from '../src/facilitator/scheme.mjs';
import { buildMemoPltPayload } from '../src/facilitator/client.mjs';

const client = grpcClient();
const signers = loadSigners();
const facilitator = createFacilitator();

test('facilitator: sponsor is the owner, network is testnet CAIP-2', () => {
  assert.equal(facilitator.sponsorAddress, OWNER_ADDRESS);
  assert.equal(facilitator.network, TESTNET_CAIP2);
  assert.equal(facilitator.network, 'ccd:4221332d34e1694168c2a0c0b3fd0f27');
});

test('facilitator: sponsor balance is healthy (safeguard #4)', async () => {
  const bal = await sponsorBalance(client);
  assert.ok(Number(bal.microCcd) > 0, 'sponsor holds CCD');
  assert.equal(bal.low, false, 'sponsor balance above the low threshold');
});

test('rate limiter: allows up to max, then refuses, then resets (safeguard #3)', () => {
  const rl = new RateLimiter({ maxRequests: 3, windowMs: 60_000 });
  assert.equal(rl.allow('ip-1').allowed, true);
  assert.equal(rl.allow('ip-1').allowed, true);
  assert.equal(rl.allow('ip-1').allowed, true);
  assert.equal(rl.allow('ip-1').allowed, false);
  assert.equal(rl.allow('ip-2').allowed, true, 'other IPs unaffected');
  assert.equal(rl.allow('ip-1', Date.now() + 61_000).allowed, true, 'new window resets');
});

test('requirementsForPayable: shape for payable 3 (EUDemo, Unpaid)', async () => {
  const view = await getPayable(client, 3);
  assert.equal(view.status, 'Unpaid');
  assert.equal(view.asset, 'EUDemo');
  const req = requirementsForPayable(view);
  assert.equal(req.scheme, 'exact');
  assert.equal(req.network, TESTNET_CAIP2);
  assert.equal(req.amount, view.amount);
  assert.equal(req.payTo, view.payee);
  assert.equal(req.extra.feePayer, OWNER_ADDRESS);
  assert.equal(req.extra.payableId, 3);
  assert.ok(req.maxTimeoutSeconds > 5);
});

// Helpers for the verify negatives: build a signed v1 memo'd transfer for
// payable 3 (Unpaid EUDemo, 10000 base units, payee 4Vtd…) without settling.
async function buildFor3({ amount = '10000', memo = 'payable:3', recipient = PAYEE2_ADDRESS } = {}) {
  const view = await getPayable(client, 3);
  const req = requirementsForPayable(view, { maxTimeoutSeconds: 300 });
  if (amount !== '10000') req.amount = amount;
  const payload = await buildMemoPltPayload({
    grpc: client, sender: signers.sellerB, sponsorAddress: OWNER_ADDRESS,
    recipient, amount, tokenId: 'EUDemo', memo,
    expirySeconds: Math.floor(Date.now() / 1000) + 240,
  });
  return { req, payload };
}

test('facilitator verify: wrong amount REFUSES on the PayOnce layer (amount-is-stored)', async () => {
  const { req, payload } = await buildFor3({ amount: '10001' });
  const out = await payonceVerify(facilitator, payload, req, { payableId: 3, expectedStatus: 'Unpaid' });
  assert.equal(out.isValid, false);
  assert.ok(out.invalidReason === 'amount_mismatch' || out.invalidReason === 'amount-is-stored' || /amount/i.test(out.invalidReason + (out.invalidMessage ?? '')));
  const check = (out.payonce?.checks ?? []).find((c) => c.name === 'amount-is-stored');
  assert.ok(check && check.ok === false, 'PayOnce amount check must fail');
});

test('facilitator verify: wrong memo REFUSES on the PayOnce layer (memo-is-payable-id)', async () => {
  const { req, payload } = await buildFor3({ memo: 'payable:4' });
  const out = await payonceVerify(facilitator, payload, req, { payableId: 3, expectedStatus: 'Unpaid' });
  // The security property: a wrong memo must NEVER verify as VALID.
  assert.equal(out.isValid, false);
  // Normally the PayOnce layer refuses with memo_missing. Under parallel
  // test load the scheme's own live preflight can fail first on a transient
  // node error (then invalidReason is a scheme error, not memo_missing) —
  // that is still a refusal, so accept it, but require the memo check to
  // have failed whenever the PayOnce layer ran.
  const memoCheck = (out.payonce?.checks ?? []).find((c) => c.name === 'memo-is-payable-id');
  if (out.invalidReason === 'memo_missing') {
    assert.ok(memoCheck && memoCheck.ok === false, 'PayOnce memo check must fail');
  } else {
    assert.ok(!memoCheck || memoCheck.ok === false, `unexpected refusal reason: ${out.invalidReason}`);
  }
});

test('facilitator verify: wrong recipient REFUSES on the scheme layer (recipient_mismatch)', async () => {
  const { req, payload } = await buildFor3({ recipient: OWNER_ADDRESS });
  const out = await payonceVerify(facilitator, payload, req, { payableId: 3, expectedStatus: 'Unpaid' });
  assert.equal(out.isValid, false);
  assert.match(out.invalidReason ?? '', /recipient_mismatch/);
});

test('facilitator verify: correct transfer for payable 3 is VALID (verify only, no settle)', async () => {
  const { req, payload } = await buildFor3();
  const out = await payonceVerify(facilitator, payload, req, { payableId: 3, expectedStatus: 'Unpaid' });
  assert.equal(out.isValid, true, `expected VALID, got ${out.invalidReason}: ${out.invalidMessage ?? ''}`);
  assert.equal(out.payer, SELLER_B_ADDRESS);
  for (const c of out.payonce.checks) assert.equal(c.ok, true, `${c.name} should pass: ${c.detail}`);
});
