// PayOnce backend — verifier negative tests (plan P1 §6.3).
// Runs OFFLINE from fixtures saved from real testnet state
// (test/fixtures/*, see spikes/save-fixtures.mjs). No network, no keys.
// Baselines must PASS (regression); every negative must FAIL on its named check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyCcd, verifyPlt } from '../src/verifier/checks.mjs';
import { decodeCborMemo, encodeCborMemo } from '../src/chain.mjs';

const F = (name) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), 'utf8'));
const clone = (v) => JSON.parse(JSON.stringify(v));

function ccdCtx() {
  return {
    payableId: 1,
    txHash: '00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6',
    summary: F('ccd-payable1-tx.json'),
    blockTime: F('ccd-payable1-blockTime.json'),
    view: F('ccd-payable1-view.json'),
    balance: readFileSync(new URL('./fixtures/ccd-balance.txt', import.meta.url), 'utf8').trim(),
  };
}
function pltCtx() {
  return {
    payableId: 2,
    txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef',
    summary: F('plt-payable2-tx.json'),
    blockTime: F('plt-payable2-blockTime.json'),
    view: F('plt-payable2-view.json'),
    balance: readFileSync(new URL('./fixtures/plt-balance.txt', import.meta.url), 'utf8').trim(),
    reserve: F('plt-payable2-reserve.json'),
    confirm: F('plt-payable2-confirm.json'),
  };
}
const failedIds = (r) => r.checks.filter((c) => c.status === 'FAIL').map((c) => c.id);

test('baseline CCD: payable 1 + 00e0ac1d passes (11/11, doc skipped)', () => {
  const r = verifyCcd(ccdCtx());
  assert.equal(r.allPass, true);
  assert.equal(r.passed, 11);
  assert.deepEqual(failedIds(r), []);
});

test('baseline PLT: payable 2 + 7cc2f94f passes (14/14, doc skipped)', () => {
  const r = verifyPlt(pltCtx());
  assert.equal(r.allPass, true);
  assert.equal(r.passed, 14);
  assert.deepEqual(failedIds(r), []);
});

test('N-01 (F10): payable 1 checked against payable-4 tx 78377f18 FAILS on CCD-04 + CCD-05', () => {
  const ctx = ccdCtx();
  ctx.summary = F('ccd-payable4-tx.json');
  ctx.blockTime = F('ccd-payable4-blockTime.json');
  ctx.txHash = '78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e';
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('CCD-04'), `expected CCD-04 in ${failedIds(r)}`);
  assert.ok(failedIds(r).includes('CCD-05'), `expected CCD-05 in ${failedIds(r)}`);
  // The old verifier passed this input 10/10: same payer/payee/amount is why.
  assert.ok(!failedIds(r).includes('CCD-08'), 'transferred-to-payee still passes (same payee/amount — the trap)');
});

test('N-02: PLT memo for payable 1 checked against payable 2 FAILS on PLT-07', () => {
  const ctx = pltCtx();
  const t = ctx.summary.summary.events.find((e) => e.tag === 'TokenTransfer');
  t.memo = encodeCborMemo('payable:1').toString('hex');
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-07'));
});

test('N-03: PLT amount off by one base unit FAILS on PLT-06', () => {
  const ctx = pltCtx();
  const t = ctx.summary.summary.events.find((e) => e.tag === 'TokenTransfer');
  t.amount.value = '10001';
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-06'));
});

test('N-04: PLT transfer from another account FAILS on PLT-04', () => {
  const ctx = pltCtx();
  const t = ctx.summary.summary.events.find((e) => e.tag === 'TokenTransfer');
  t.from = { type: 'account', address: '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs' };
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-04'));
});

test('N-05: PLT transfer after the reservation window FAILS on PLT-13', () => {
  const ctx = pltCtx();
  ctx.blockTime = { ...ctx.blockTime, slotTime: '2026-11-24T05:00:00.000Z' }; // expires 04:56:31
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-13'));
});

test('N-06: altered invoice document FAILS on the doc-hash check', () => {
  const c = ccdCtx();
  c.docBytes = Buffer.from('INVOICE TAMPERED — one digit changed in the account number');
  const rc = verifyCcd(c);
  assert.equal(rc.allPass, false);
  assert.ok(failedIds(rc).includes('CCD-12'));
  const p = pltCtx();
  p.docBytes = Buffer.from('INVOICE TAMPERED — one digit changed in the account number');
  const rp = verifyPlt(p);
  assert.equal(rp.allPass, false);
  assert.ok(failedIds(rp).includes('PLT-15'));
});

test('N-07: non-zero registry balance FAILS on the balance check', () => {
  const c = ccdCtx();
  c.balance = '1';
  assert.ok(failedIds(verifyCcd(c)).includes('CCD-10'));
  const p = pltCtx();
  p.balance = '1';
  assert.ok(failedIds(verifyPlt(p)).includes('PLT-14'));
});

test('N-08: status Reserved, not Paid, FAILS on the status check', () => {
  const c = ccdCtx();
  c.view = { ...clone(c.view), status: 'Reserved', record: null };
  assert.ok(failedIds(verifyCcd(c)).includes('CCD-09'));
  const p = pltCtx();
  p.view = { ...clone(p.view), status: 'Reserved', record: null };
  assert.ok(failedIds(verifyPlt(p)).includes('PLT-10'));
});

test('memo: CBOR canonical encoding round-trips; non-canonical header is not canonical', () => {
  assert.equal(decodeCborMemo(encodeCborMemo('payable:2').toString('hex')).text, 'payable:2');
  assert.equal(decodeCborMemo(encodeCborMemo('payable:2').toString('hex')).canonical, true);
  // 0x78-length encoding of a 9-char string is valid CBOR but NOT canonical.
  const nonCanon = Buffer.concat([Buffer.from([0x78, 9]), Buffer.from('payable:2', 'utf8')]);
  assert.equal(decodeCborMemo(nonCanon.toString('hex')).text, 'payable:2');
  assert.equal(decodeCborMemo(nonCanon.toString('hex')).canonical, false);
  // v2 memo with seller.
  assert.equal(decodeCborMemo(encodeCborMemo('payable:4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs:2').toString('hex')).canonical, true);
});

test('view: a 151-byte Unpaid view parses (regression: old 161-byte minimum rejected it)', async () => {
  const { parsePayableView } = await import('../src/registry.mjs');
  const { AccountAddress } = await import('@concordium/web-sdk');
  // Rebuild the Unpaid prefix (151 bytes) of the real payable-1 Paid view
  // from the saved fixture fields, with status flipped to Unpaid.
  const v = F('ccd-payable1-view.json');
  const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
  const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
  const buf = Buffer.concat([
    Buffer.from([0x01]),
    u64(v.id),
    Buffer.from(AccountAddress.toBuffer(AccountAddress.fromBase58(v.seller))),
    Buffer.from(AccountAddress.toBuffer(AccountAddress.fromBase58(v.payee))),
    u64(v.amount),
    Buffer.from([0x00]), // CCD
    u64(v.dueMs),
    Buffer.from(v.docHash, 'hex'),
    u64(v.agentRegistry.index), u64(v.agentRegistry.subindex),
    u32(8), u64(v.agentToken),
    Buffer.from([0x00]), // status = Unpaid
  ]);
  assert.equal(buf.length, 151);
  const parsed = parsePayableView(buf, 1);
  assert.equal(parsed.status, 'Unpaid');
  assert.equal(parsed.record, null);
  assert.equal(parsed.amount, '500000');
  assert.equal(parsed.docHash, v.docHash);
});
