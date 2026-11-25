// PayOnce backend — v2/v2.1 CCD verifier tests (G7 verifier-fix, 2026-11-24).
// Runs OFFLINE from bytes probed live from payable 10's v2 pay tx
// 7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197
// (pay_ccd on <13150,0>, 500000 microCCD, 2026-11-24T08:37:45.593Z).
// No network, no keys. The v1 baseline still lives in
// verify-negatives.test.mjs and must keep passing unchanged.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verifyCcd } from '../src/verifier/checks.mjs';
import { decodeContractEventV2 } from '../src/events.mjs';

const SELLER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const PAYER = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
const PAYEE = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin';
// PayableKeyParam: seller 32B + payable_id u64 LE (10).
const PARAM_V2 = '8f069b2c09e479346bcf3a5a3d580fc33e26152da60a7d8a332c67e7d81b21060a00000000000000';
// v2 Paid event, tag 0x06: schema_version 2 + seller + id 10 + payer +
// amount 500000 + asset 0 (Ccd). Copied verbatim from the live tx.
const PAID_V2 =
  '06028f069b2c09e479346bcf3a5a3d580fc33e26152da60a7d8a332c67e7d81b21060a' +
  '00000000000000ba99a32ebd8bc6fc812f4901dbf4dbe30108c8f52a8e1b9cafefa62fbf902cf4' +
  '20a107000000000000';

const clone = (v) => JSON.parse(JSON.stringify(v));

/** Minimal verifyCcd context for payable 10's real v2 pay tx. */
function v2Ctx({ registryIndex = '13150', receiveName = 'payable_registry_v2.pay_ccd', message = PARAM_V2, logged = [PAID_V2], fromIndex = '13150' } = {}) {
  return {
    payableId: 10,
    txHash: '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197',
    // G7 fix-back-3 MF-2: the ctx carries the view registry (the Updated
    // event's own index, by construction) — the binding is real, and the
    // F-B tests below override it to create the mismatch.
    registryIndex,
    summary: {
      status: 'finalized',
      summary: {
        transactionType: 'update',
        sender: PAYER,
        events: [
          {
            tag: 'Updated',
            address: { index: registryIndex },
            receiveName,
            message,
            events: logged,
          },
          { tag: 'Transferred', from: { index: fromIndex }, amount: '500000', to: PAYEE },
        ],
      },
    },
    blockTime: { slotTime: '2026-11-24T08:37:45.593Z' },
    view: {
      seller: SELLER,
      amount: '500000',
      payee: PAYEE,
      status: 'Paid',
      dueMs: '1798286400000',
      due: '2026-12-26T12:00:00.000Z',
      docHash: 'c9fef19aa010ed3da158678cbfcafb5005699e55eef81ca1104f3250d8addb7f',
    },
    balance: '0',
  };
}
const failedIds = (r) => r.checks.filter((c) => c.status === 'FAIL').map((c) => c.id);

test('v2 decoder: the real Paid event hex decodes to seller/id/payer/amount', () => {
  const e = decodeContractEventV2(PAID_V2);
  assert.equal(e.event, 'Paid');
  assert.equal(e.schemaVersion, 2);
  assert.equal(e.seller, SELLER);
  assert.equal(e.payableId, 10);
  assert.equal(e.payer, PAYER);
  assert.equal(e.amount, '500000');
  assert.equal(e.asset, 'Ccd');
});

test('v2 decoder: a v1 Paid event (tag 0x01) is NOT a v2 event', () => {
  // v1 Paid: tag 0x01 + id u64 LE + payer 32B + amount u64 LE (49 B).
  // Payer bytes sit at hex chars 84..148 of the v2 Paid event.
  const payerBytes = Buffer.from(PAID_V2.slice(84, 148), 'hex');
  const v1Paid = Buffer.concat([Buffer.from([0x01]), Buffer.from('0a00000000000000', 'hex'), payerBytes, Buffer.from('20a1070000000000', 'hex')]).toString('hex');
  assert.throws(() => decodeContractEventV2(v1Paid), /unknown v2 contract event tag 0x1/);
});

test('baseline v2: payable 10 + 7c204f0b passes (11/11, doc skipped)', () => {
  const r = verifyCcd(v2Ctx());
  assert.equal(r.allPass, true, JSON.stringify(r.checks));
  assert.equal(r.passed, 11);
  assert.deepEqual(failedIds(r), []);
});

test('v2.1 shape: same bytes on <13152,0> / payable_registry_v2_1.pay_ccd pass (11/11)', () => {
  // Shape-equivalence only: no live v2.1 CCD pay tx is known, so this
  // proves the verifier accepts the v2.1 shape (same enum order, same
  // PayableKeyParam), not that a v2.1 payment exists.
  const r = verifyCcd(
    v2Ctx({ registryIndex: '13152', receiveName: 'payable_registry_v2_1.pay_ccd', fromIndex: '13152' }),
  );
  assert.equal(r.allPass, true, JSON.stringify(r.checks));
  assert.equal(r.passed, 11);
});

test('v2 negative: param binds payable 11 FAILS on CCD-04 only', () => {
  const ctx = v2Ctx();
  // Flip the payable_id in the PayableKeyParam (last 8 bytes: 10 -> 11).
  const upd = ctx.summary.summary.events[0];
  upd.message = PARAM_V2.slice(0, -16) + '0b00000000000000';
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  assert.deepEqual(failedIds(r), ['CCD-04']);
});

test('v2 negative: param seller is another account FAILS on CCD-04 only', () => {
  const ctx = v2Ctx();
  // Flip the first seller byte in the PayableKeyParam (8f -> 8e).
  const upd = ctx.summary.summary.events[0];
  upd.message = '8e' + PARAM_V2.slice(2);
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  assert.deepEqual(failedIds(r), ['CCD-04']);
});

test('v2 negative: Paid event binds payable 11 FAILS on CCD-05 (the binding check)', () => {
  const ctx = v2Ctx();
  const upd = ctx.summary.summary.events[0];
  // Payable id sits at bytes 34..42 of the Paid event (hex 68..84): 10 -> 11.
  upd.events = ['06' + PAID_V2.slice(2, 68) + '0b00000000000000' + PAID_V2.slice(84)];
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  // CCD-05 is the binding check; CCD-06/07 still pass on the wrong-id
  // event's payer/amount (same as the v1 N-01 pattern) — allPass is
  // false either way, which is the gate that matters.
  assert.deepEqual(failedIds(r), ['CCD-05']);
  assert.ok(!failedIds(r).includes('CCD-04'), 'param still binds payable 10');
});

test('v2 negative: Paid event payer is not the sender FAILS on CCD-06 only', () => {
  const ctx = v2Ctx();
  const upd = ctx.summary.summary.events[0];
  // Payer sits at bytes 42..74 of the Paid event (hex 84..148): flip one byte.
  upd.events = [PAID_V2.slice(0, 84) + 'bb' + PAID_V2.slice(86)];
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  assert.deepEqual(failedIds(r), ['CCD-06']);
});

test('v2 negative: transfer leaves the v1 contract, not the v2 registry, FAILS on CCD-08 only', () => {
  const ctx = v2Ctx({ fromIndex: '13149' });
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  assert.deepEqual(failedIds(r), ['CCD-08']);
});

test('v2 negative: transfer to the wrong payee FAILS on CCD-08 only', () => {
  const ctx = v2Ctx();
  ctx.summary.summary.events[1].to = PAYER;
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  assert.deepEqual(failedIds(r), ['CCD-08']);
});

// ---- G7 fix-back-3 MF-2: the registry binding fails closed by
// default — no registryIndex and no explicit unbound opt-in FAILS
// CCD-03, even when every other check would pass.
test('MF-2 fail-closed: no registryIndex and no unbound flag FAILS on CCD-03 only', () => {
  const ctx = v2Ctx();
  delete ctx.registryIndex;
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  assert.deepEqual(failedIds(r), ['CCD-03']);
  const c03 = r.checks.find((c) => c.id === 'CCD-03');
  assert.match(c03.detail, /unbound/);
});

test('MF-2 unbound opt-in: unbound:true keeps the old pass (11/11)', () => {
  const ctx = v2Ctx();
  delete ctx.registryIndex;
  ctx.unbound = true;
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, true, JSON.stringify(r.checks));
  assert.equal(r.passed, 11);
});

// ---- G7 fix-back-2 F-B: the tx's target registry must match the
// registry the payable view was read from (ctx.registryIndex). Without
// the binding both shapes below certified against a v2 view.
test('F-B cross-registry: v2.1 target + v2 view FAILS on CCD-03 (registry mismatch named)', () => {
  const ctx = v2Ctx({ registryIndex: '13152', receiveName: 'payable_registry_v2_1.pay_ccd', fromIndex: '13152' });
  ctx.registryIndex = '13150';
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  assert.deepEqual(failedIds(r), ['CCD-03']);
  const c03 = r.checks.find((c) => c.id === 'CCD-03');
  assert.match(c03.detail, /registry mismatch/);
  assert.match(c03.detail, /<13152,0>/);
  assert.match(c03.detail, /<13150,0>/);
});

test('F-B cross-registry: v1 target + v2 view FAILS on CCD-03 only (every other check would pass)', () => {
  // A v1 pay_ccd for the same id/amount/payee: bare-u64 param, v1 Paid
  // (tag 0x01), transfer from <13149,0>. Against the v2 view every
  // check except the registry binding passes — the binding is the gate.
  const payerBytes = Buffer.from(PAID_V2.slice(84, 148), 'hex');
  const v1Paid = Buffer.concat([Buffer.from([0x01]), Buffer.from('0a00000000000000', 'hex'), payerBytes, Buffer.from('20a1070000000000', 'hex')]).toString('hex');
  const ctx = v2Ctx();
  ctx.summary.summary.events[0] = {
    tag: 'Updated',
    address: { index: '13149' },
    receiveName: 'payable_registry.pay_ccd',
    message: '0a00000000000000',
    events: [v1Paid],
  };
  ctx.summary.summary.events[1] = { tag: 'Transferred', from: { index: '13149' }, amount: '500000', to: PAYEE };
  ctx.registryIndex = '13150';
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  assert.deepEqual(failedIds(r), ['CCD-03']);
  const c03 = r.checks.find((c) => c.id === 'CCD-03');
  assert.match(c03.detail, /registry mismatch/);
  assert.match(c03.detail, /<13149,0>/);
  assert.match(c03.detail, /<13150,0>/);
});
