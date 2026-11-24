// PayOnce backend — co-signer decision tests C-01..C-34 (+ confirm cases).
// Pure function: no network, no keys, no clock. Grounded values are taken
// from the live v1 fixtures (test/fixtures/*): payable 2's stored fields,
// the agent C3, seller B, payee 4Vtd…, amount 10000 base units (0.01 EUDemo),
// the 300 s reservation window (reserved 04:51:31.593Z, expires 04:56:31.593Z).
// TEST POLICY values (not owner decisions, not on-chain): the approval caps,
// the agent's EUDemo balance, the nonce 42, the sponsor account M-test.
// Every case mutates exactly one field from the valid base case.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decide, MARGIN_MS } from '../src/cosigner/decide.mjs';
import { encodeCborMemo } from '../src/chain.mjs';

const C3 = '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n';
const SELLER_B = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
const PAYEE2 = '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg';
const SPONSOR = SELLER_B; // live fact: the seller sponsored the v1 transfer (fee 7073229 microCCD)
const VIEW = JSON.parse(readFileSync(new URL('./fixtures/plt-payable2-view.json', import.meta.url), 'utf8'));
// Live values from the fixture: amount 10000, due 2026-11-25T04:49:31.426Z,
// seller B, payee 4Vtd…, status Paid (we reset to Unpaid/Reserved per case).

const RESERVE_AT = Date.parse('2026-11-24T04:51:31.593Z');
const EXPIRES_MS = RESERVE_AT + 300_000; // 04:56:31.593Z, the live v1 window
const DUE_MS = Number(VIEW.dueMs);

function baseSnapshot(over = {}) {
  return {
    version: 1,
    blockHash: 'eacbb02d3b5b4f3c37dfbbf7f7e5b4b8b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9b9',
    slotTime: '2026-11-24T04:50:00.000Z', // before the reserve, inside the due window
    agentAccount: C3,
    sponsorAccount: SPONSOR,
    nextNonce: 42,
    agentStatus: 'Active',
    eudemoBalance: '1000000',
    payable: {
      seller: SELLER_B,
      id: 2,
      payee: PAYEE2,
      amount: '10000',
      asset: 'PLT',
      dueMs: String(DUE_MS),
      status: 'Unpaid',
      payer: null,
      expiresMs: null,
      expectedPayer: C3,
      legalRef: 'TEST-ONLY',
    },
    approval: { tier: 'test', legalRef: 'TEST-ONLY', perPayableCap: '1000000', periodCap: '10000000', periodSecs: 86400 },
    usage: '0',
    memoScan: { found: false, txHash: null },
    usedTxHashes: [],
    transfer: null,
    ...over,
  };
}
function baseReserveReq(over = {}) {
  return { kind: 'reserve_plt', sender: C3, nonce: 42, txVersion: 1, sponsor: SPONSOR, numSignatures: 2, ...over };
}
function reservedSnapshot(over = {}) {
  const s = baseSnapshot({
    slotTime: '2026-11-24T04:52:00.000Z',
    payable: {
      seller: SELLER_B, id: 2, payee: PAYEE2, amount: '10000', asset: 'PLT',
      dueMs: String(DUE_MS), status: 'Reserved', payer: C3, expiresMs: String(EXPIRES_MS),
      expectedPayer: C3, legalRef: 'TEST-ONLY',
    },
    transfer: { found: true, from: C3, to: PAYEE2, amount: '10000', memo: 'payable:2', blockTimeMs: String(Date.parse('2026-11-24T04:51:55.593Z')) },
  });
  return { ...s, ...over };
}
function baseTransferReq(over = {}) {
  return {
    kind: 'transfer', sender: C3, nonce: 42, txVersion: 1, sponsor: SPONSOR,
    recipient: PAYEE2, amount: '10000', token: 'EUDemo',
    memo: encodeCborMemo('payable:2').toString('hex'),
    headerExpirySeconds: Math.floor((EXPIRES_MS - MARGIN_MS) / 1000),
    operations: 1,
    ...over,
  };
}
const EMPTY_LEDGER = { unresolved: [] };
const expectRefuse = (t, r, code) => {
  assert.equal(r.decision, 'REFUSE', `${t}: expected REFUSE, got ${JSON.stringify(r)}`);
  assert.equal(r.code, code, `${t}: expected code ${code}, got ${r.code}`);
};

test('C-01: sender is not the agent account -> REFUSE', () => {
  expectRefuse('C-01', decide(baseSnapshot(), baseReserveReq({ sender: SELLER_B }), EMPTY_LEDGER), 'sender-not-agent');
});
test('C-02: tx version 0 -> REFUSE', () => {
  expectRefuse('C-02', decide(baseSnapshot(), baseReserveReq({ txVersion: 0 }), EMPTY_LEDGER), 'bad-tx-version');
});
test('C-03: no sponsor -> REFUSE', () => {
  expectRefuse('C-03', decide(baseSnapshot(), baseReserveReq({ sponsor: null }), EMPTY_LEDGER), 'sponsor-mismatch');
});
test('C-04: one signature only (2-of-3 needs 2) -> REFUSE', () => {
  expectRefuse('C-04', decide(baseSnapshot(), baseReserveReq({ numSignatures: 1 }), EMPTY_LEDGER), 'single-signature');
});
test('C-04b: 1-of-1 buyer account (signatureThreshold 1) with 1 signature -> SIGN', () => {
  const s = baseSnapshot({ signatureThreshold: 1 });
  const r = decide(s, baseReserveReq({ numSignatures: 1 }), EMPTY_LEDGER);
  assert.equal(r.decision, 'SIGN', JSON.stringify(r));
});
test('C-04c: 1-of-1 buyer account with 2 signatures -> REFUSE', () => {
  const s = baseSnapshot({ signatureThreshold: 1 });
  expectRefuse('C-04c', decide(s, baseReserveReq({ numSignatures: 2 }), EMPTY_LEDGER), 'single-signature');
});
test('C-05: reserve on a CCD payable -> REFUSE', () => {
  const s = baseSnapshot({ payable: { ...baseSnapshot().payable, asset: 'CCD' } });
  expectRefuse('C-05', decide(s, baseReserveReq(), EMPTY_LEDGER), 'wrong-asset');
});
test('C-06: payable already Reserved -> REFUSE', () => {
  const s = baseSnapshot({ payable: { ...baseSnapshot().payable, status: 'Reserved' } });
  expectRefuse('C-06', decide(s, baseReserveReq(), EMPTY_LEDGER), 'already-reserved');
});
test('C-07: payable Voided -> REFUSE', () => {
  const s = baseSnapshot({ payable: { ...baseSnapshot().payable, status: 'Voided' } });
  expectRefuse('C-07', decide(s, baseReserveReq(), EMPTY_LEDGER), 'voided');
});
test('C-08: expected_payer is not C3 -> REFUSE', () => {
  const s = baseSnapshot({ payable: { ...baseSnapshot().payable, expectedPayer: SELLER_B } });
  expectRefuse('C-08', decide(s, baseReserveReq(), EMPTY_LEDGER), 'not-expected-payer');
});
test('C-09: no vendor approval row -> REFUSE', () => {
  expectRefuse('C-09', decide(baseSnapshot({ approval: null }), baseReserveReq(), EMPTY_LEDGER), 'no-approval');
});
test('C-10: legal_ref mismatch -> REFUSE', () => {
  expectRefuse('C-10', decide(baseSnapshot({ approval: { tier: 'test', legalRef: 'OTHER', perPayableCap: '1000000', periodCap: '10000000', periodSecs: 86400 } }), baseReserveReq(), EMPTY_LEDGER), 'legal-ref-mismatch');
});
test('C-11: period cap exceeded -> REFUSE', () => {
  expectRefuse('C-11', decide(baseSnapshot({ usage: '9999999' }), baseReserveReq(), EMPTY_LEDGER), 'cap-exceeded');
});
test('C-12: agent not Active (Revoked) -> REFUSE', () => {
  expectRefuse('C-12', decide(baseSnapshot({ agentStatus: 'Revoked' }), baseReserveReq(), EMPTY_LEDGER), 'agent-not-active');
});
test('C-13: EUDemo balance below amount -> REFUSE', () => {
  expectRefuse('C-13', decide(baseSnapshot({ eudemoBalance: '9999' }), baseReserveReq(), EMPTY_LEDGER), 'insufficient-balance');
});
test('C-14: memo scan found a finalized transfer for this payable -> REFUSE', () => {
  expectRefuse('C-14', decide(baseSnapshot({ memoScan: { found: true, txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' } }), baseReserveReq(), EMPTY_LEDGER), 'memo-scan-hit');
});
test('C-15: unresolved ledger entry for the same payable -> REFUSE', () => {
  const ledger = { unresolved: [{ payableKey: `${SELLER_B}:2`, txHash: 'aa'.repeat(32), headerExpiry: 1, reservationExpires: 1 }] };
  expectRefuse('C-15', decide(baseSnapshot(), baseReserveReq(), ledger), 'ledger-unresolved');
});
test('C-16: nonce != next_nonce -> REFUSE', () => {
  expectRefuse('C-16', decide(baseSnapshot(), baseReserveReq({ nonce: 43 }), EMPTY_LEDGER), 'bad-nonce');
});
test('C-17: payable past due -> REFUSE', () => {
  expectRefuse('C-17', decide(baseSnapshot({ slotTime: '2026-11-26T00:00:00.000Z' }), baseReserveReq(), EMPTY_LEDGER), 'past-due');
});
test('C-18: valid reserve -> SIGN', () => {
  const r = decide(baseSnapshot(), baseReserveReq(), EMPTY_LEDGER);
  assert.equal(r.decision, 'SIGN', JSON.stringify(r));
});
test('C-19: transfer to a different recipient -> REFUSE', () => {
  expectRefuse('C-19', decide(reservedSnapshot(), baseTransferReq({ recipient: SELLER_B }), EMPTY_LEDGER), 'wrong-recipient');
});
test('C-20: transfer amount off by one -> REFUSE', () => {
  expectRefuse('C-20', decide(reservedSnapshot(), baseTransferReq({ amount: '10001' }), EMPTY_LEDGER), 'wrong-amount');
});
test('C-21: memo for a different payable -> REFUSE', () => {
  expectRefuse('C-21', decide(reservedSnapshot(), baseTransferReq({ memo: encodeCborMemo('payable:1').toString('hex') }), EMPTY_LEDGER), 'wrong-memo');
});
test('C-22: memo missing -> REFUSE', () => {
  expectRefuse('C-22', decide(reservedSnapshot(), baseTransferReq({ memo: null }), EMPTY_LEDGER), 'memo-missing');
});
test('C-23: memo with non-canonical CBOR header -> REFUSE', () => {
  const nonCanon = Buffer.concat([Buffer.from([0x78, 9]), Buffer.from('payable:2', 'utf8')]);
  expectRefuse('C-23', decide(reservedSnapshot(), baseTransferReq({ memo: nonCanon.toString('hex') }), EMPTY_LEDGER), 'memo-non-canonical');
});
test('C-24: two operations in the transfer -> REFUSE', () => {
  expectRefuse('C-24', decide(reservedSnapshot(), baseTransferReq({ operations: 2 }), EMPTY_LEDGER), 'multi-operation');
});
test('C-25: token other than EUDemo -> REFUSE', () => {
  expectRefuse('C-25', decide(reservedSnapshot(), baseTransferReq({ token: 'EURQ' }), EMPTY_LEDGER), 'wrong-token');
});
test('C-26: transfer while payable Unpaid (no reservation) -> REFUSE', () => {
  expectRefuse('C-26', decide(baseSnapshot(), baseTransferReq(), EMPTY_LEDGER), 'not-reserved');
});
test('C-27: payable reserved by another payer -> REFUSE', () => {
  const s = reservedSnapshot({ payable: { ...reservedSnapshot().payable, payer: SELLER_B } });
  expectRefuse('C-27', decide(s, baseTransferReq(), EMPTY_LEDGER), 'reserved-by-other');
});
test('C-28: header expiry = expires - 60s (boundary) -> SIGN', () => {
  const r = decide(reservedSnapshot(), baseTransferReq(), EMPTY_LEDGER);
  assert.equal(r.decision, 'SIGN', JSON.stringify(r));
});
test('C-29: header expiry = expires - 59s -> REFUSE', () => {
  expectRefuse('C-29', decide(reservedSnapshot(), baseTransferReq({ headerExpirySeconds: Math.floor((EXPIRES_MS - 59_000) / 1000) }), EMPTY_LEDGER), 'header-expiry-too-late');
});
test('C-30: header expiry after the window ends -> REFUSE', () => {
  expectRefuse('C-30', decide(reservedSnapshot(), baseTransferReq({ headerExpirySeconds: Math.floor(EXPIRES_MS / 1000) + 60 }), EMPTY_LEDGER), 'header-expiry-too-late');
});
test('C-31: snapshot time within 60s of the window end -> REFUSE', () => {
  const s = reservedSnapshot({ slotTime: '2026-11-24T04:55:32.593Z' }); // 59 s before expiry
  expectRefuse('C-31', decide(s, baseTransferReq({ headerExpirySeconds: Math.floor((EXPIRES_MS - 30_000) / 1000) }), EMPTY_LEDGER), 'insufficient-margin');
});
test('C-32: approval revoked after reserve, before transfer -> REFUSE', () => {
  expectRefuse('C-32', decide(reservedSnapshot({ approval: null }), baseTransferReq(), EMPTY_LEDGER), 'approval-revoked');
});
test('C-33: transfer on an already-Paid payable -> REFUSE', () => {
  const s = reservedSnapshot({ payable: { ...reservedSnapshot().payable, status: 'Paid' } });
  expectRefuse('C-33', decide(s, baseTransferReq(), EMPTY_LEDGER), 'already-paid');
});
test('C-34: the decision never reads the local clock (no Date.now; deterministic)', () => {
  const src = readFileSync(new URL('../src/cosigner/decide.mjs', import.meta.url), 'utf8');
  assert.ok(!src.includes('Date.now'), 'decide.mjs must not read Date.now');
  const r1 = decide(reservedSnapshot(), baseTransferReq(), EMPTY_LEDGER);
  const r2 = decide(reservedSnapshot(), baseTransferReq(), EMPTY_LEDGER);
  assert.deepEqual(r1, r2);
});
test('confirm: valid confirm after a verified transfer -> SIGN', () => {
  const r = decide(reservedSnapshot({ slotTime: '2026-11-24T04:52:30.000Z' }), { kind: 'confirm', sender: C3, nonce: 42, txVersion: 1, sponsor: SPONSOR, txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' }, EMPTY_LEDGER);
  assert.equal(r.decision, 'SIGN', JSON.stringify(r));
});
test('confirm: transfer not verified -> REFUSE', () => {
  const s = reservedSnapshot({ transfer: null });
  const r = decide(s, { kind: 'confirm', sender: C3, nonce: 42, txVersion: 1, sponsor: SPONSOR, txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' }, EMPTY_LEDGER);
  expectRefuse('confirm-no-transfer', r, 'transfer-not-verified');
});
test('confirm: tx hash already used -> REFUSE', () => {
  const s = reservedSnapshot({ usedTxHashes: ['7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef'] });
  const r = decide(s, { kind: 'confirm', sender: C3, nonce: 42, txVersion: 1, sponsor: SPONSOR, txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' }, EMPTY_LEDGER);
  expectRefuse('confirm-reused', r, 'tx-reused');
});
test('confirm: chain time past the reservation window -> REFUSE', () => {
  const s = reservedSnapshot({ slotTime: '2026-11-24T04:57:00.000Z' });
  const r = decide(s, { kind: 'confirm', sender: C3, nonce: 42, txVersion: 1, sponsor: SPONSOR, txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' }, EMPTY_LEDGER);
  expectRefuse('confirm-late', r, 'confirm-after-window');
});
test('confirm: transfer with the wrong memo -> REFUSE', () => {
  const s = reservedSnapshot({ transfer: { found: true, from: C3, to: PAYEE2, amount: '10000', memo: 'payable:1', blockTimeMs: String(Date.parse('2026-11-24T04:51:55.593Z')) } });
  const r = decide(s, { kind: 'confirm', sender: C3, nonce: 42, txVersion: 1, sponsor: SPONSOR, txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' }, EMPTY_LEDGER);
  expectRefuse('confirm-wrong-memo', r, 'transfer-not-verified');
});
