// PayOnce backend — verifier negative tests (plan P1 §6.3).
// Runs OFFLINE from fixtures saved from real testnet state
// (test/fixtures/*, see spikes/save-fixtures.mjs). No network, no keys.
// Baselines must PASS (regression); every negative must FAIL on its named check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { verifyCcd, verifyPlt, verifyPltTransfer } from '../src/verifier/checks.mjs';
import { decodeLoggedEventsV2 } from '../src/events.mjs';
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
    // G7 fix-back-3 MF-2: these offline fixtures carry no registry by
    // construction — the unbound opt-in is explicit here.
    unbound: true,
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
    // G7 fix-back-3 MF-2: see ccdCtx — registry-less offline fixture.
    unbound: true,
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

// G7 fix-back-3 MF-2: the fail-closed default — the same fixture ctx
// WITHOUT the explicit unbound opt-in fails on the binding check only.
test('MF-2 fail-closed: CCD fixture without unbound:true FAILS on CCD-03 only', () => {
  const ctx = ccdCtx();
  delete ctx.unbound;
  const r = verifyCcd(ctx);
  assert.equal(r.allPass, false);
  assert.deepEqual(failedIds(r), ['CCD-03']);
  assert.match(r.checks.find((c) => c.id === 'CCD-03').detail, /unbound/);
});

test('MF-2 fail-closed: PLT fixture with a reserve but no bound view registry FAILS on PLT-13 only', () => {
  const ctx = pltCtx();
  delete ctx.unbound;
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.deepEqual(failedIds(r), ['PLT-13']);
  assert.match(r.checks.find((c) => c.id === 'PLT-13').detail, /unbound/);
});

// G7 fix-back-2 F-A: the MCP shape — a memo-passing transfer, Paid
// view, recorded txHash, but NO reserve and NO confirm evidence. Without
// the requireEvidence flags this used to certify allPass=true (12/15,
// PLT-13/12/15 skipped): a transfer could certify with the reservation
// never checked. With the flags PLT-13 + PLT-12 FAIL (not SKIP).
test('F-A (MCP shape): verifyPlt with no reserve/confirm + requireEvidence FAILS PLT-13 + PLT-12', () => {
  const ctx = pltCtx();
  delete ctx.reserve;
  delete ctx.confirm;
  const strict = verifyPlt({ ...ctx, requireReserve: true, requireConfirm: true });
  assert.equal(strict.allPass, false);
  assert.deepEqual(failedIds(strict), ['PLT-13', 'PLT-12']);
  assert.equal(strict.passed, 12);
  assert.deepEqual(strict.checks.filter((c) => c.status === 'SKIP').map((c) => c.id), ['PLT-15']);
  const p13 = strict.checks.find((c) => c.id === 'PLT-13');
  assert.match(p13.detail, /never checked|no reserve evidence/);
  const p12 = strict.checks.find((c) => c.id === 'PLT-12');
  assert.match(p12.detail, /never checked|no confirm evidence/);
  // Same ctx without the flags keeps the old SKIP behaviour — the
  // fail-closed rule is opt-in (MCP sets both flags, the CLI sets
  // requireReserve; the co-signer recheck/snapshot and fixture paths
  // do not).
  const lax = verifyPlt(ctx);
  assert.deepEqual(lax.checks.filter((c) => c.status === 'SKIP').map((c) => c.id), ['PLT-13', 'PLT-12', 'PLT-15']);
});

// G7 fix-back-4 ADV-2: confirm evidence must be a real confirm_plt
// event, not a timestamp. The adversarial judge fabricated
// {blockTime:{slotTime:paidAt}} and got the API verifier allPass=true
// 14/14; the backend PLT-12 had the same timestamp-only shape. Each
// shape below must now FAIL PLT-12 (the baseline fixture confirm carries
// the live-decoded PltConfirmed event from real confirm tx 212f0ac7…).
test('ADV-2: fabricated timestamp-only confirm FAILS PLT-12 (no PltConfirmed event)', () => {
  const ctx = pltCtx();
  ctx.confirm = { blockTime: { slotTime: '2026-11-24T04:52:17.593Z', height: '51218664' } }; // the fabricated shape
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-12'), `expected PLT-12 in ${failedIds(r)}`);
  assert.match(r.checks.find((c) => c.id === 'PLT-12').detail, /no PltConfirmed event/);
});

test('ADV-2: confirm event for a DIFFERENT transfer FAILS PLT-12', () => {
  const ctx = pltCtx();
  ctx.confirm = { ...clone(ctx.confirm), logged: [{ event: 'PltConfirmed', payableId: 2, payer: '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n', txHash: 'ab'.repeat(32) }] };
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-12'));
  assert.match(r.checks.find((c) => c.id === 'PLT-12').detail, /does not bind this payment/);
});

test('ADV-2: confirm event for a DIFFERENT payable FAILS PLT-12', () => {
  const ctx = pltCtx();
  ctx.confirm = { ...clone(ctx.confirm), logged: [{ event: 'PltConfirmed', payableId: 1, payer: '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n', txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' }] };
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-12'));
});

// ---- G7 fix-back-5 MF-1/MF-2/MF-3 (adversarial 0486) ----
// The v1 fixture confirm (no schemaVersion, no seller, payer present)
// must still PASS — the seller requirement is generation-aware.
test('FB5 MF-1: v2 event with seller+payer STRIPPED FAILS PLT-12 (payer binds unconditionally)', () => {
  const ctx = pltCtx();
  ctx.confirm = { ...clone(ctx.confirm), logged: [{ event: 'PltConfirmed', schemaVersion: 2, payableId: 2, txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' }] };
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-12'));
  assert.match(r.checks.find((c) => c.id === 'PLT-12').detail, /no payer/);
});

test('FB5 MF-1: v2 event with seller STRIPPED (payer present) FAILS PLT-12', () => {
  const ctx = pltCtx();
  ctx.confirm = { ...clone(ctx.confirm), logged: [{ event: 'PltConfirmed', schemaVersion: 2, payableId: 2, payer: '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n', txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' }] };
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-12'));
  assert.match(r.checks.find((c) => c.id === 'PLT-12').detail, /no seller/);
});

test('FB5 MF-2: confirm past the event reservation expiry FAILS PLT-12; in-window expiry PASSES PLT-12', () => {
  const confirmMs = Date.parse('2026-11-24T04:52:17.593Z');
  const ctx = pltCtx();
  ctx.confirm = { ...clone(ctx.confirm), logged: [{ event: 'PltConfirmed', payableId: 2, payer: '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n', txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef', reservationExpiresMs: String(confirmMs - 60_000), reservationExpires: new Date(confirmMs - 60_000).toISOString() }] };
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-12'));
  assert.match(r.checks.find((c) => c.id === 'PLT-12').detail, /past the reservation expiry/);
  ctx.confirm.logged[0].reservationExpiresMs = String(confirmMs + 60_000);
  ctx.confirm.logged[0].reservationExpires = new Date(confirmMs + 60_000).toISOString();
  const r2 = verifyPlt(ctx);
  assert.equal(r2.checks.find((c) => c.id === 'PLT-12').status, 'PASS');
});

test('FB5 MF-3: confirm with NO blockTime FAILS PLT-12 (never throws); invalid blockTime FAILS too', () => {
  const ctx = pltCtx();
  ctx.confirm = { logged: clone(ctx.confirm.logged) }; // no blockTime at all
  let r;
  assert.doesNotThrow(() => { r = verifyPlt(ctx); });
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-12'));
  assert.match(r.checks.find((c) => c.id === 'PLT-12').detail, /missing or invalid/);
  const ctx2 = pltCtx();
  ctx2.confirm = { blockTime: { slotTime: 'not-a-date' }, logged: clone(ctx2.confirm.logged) };
  let r2;
  assert.doesNotThrow(() => { r2 = verifyPlt(ctx2); });
  assert.ok(failedIds(r2).includes('PLT-12'));
});

// ---- G7 fix-back-6 MF-2 (adversarial A2e/A2g/A2h, backend): the
// confirm-expiry check is anchored to the RESERVE (fixture reserve
// expires 2026-11-24T04:56:31.593Z, 1795496191593ms); a v2 event must
// carry a finite expiry that does not run past it. The past-expiry
// confirm time below is 05:00, with paidAt rewritten to match so only
// the expiry check can catch it. ----
function fb6PastExpiryPltCtx() {
  const ctx = pltCtx();
  ctx.confirm.blockTime = { slotTime: '2026-11-24T05:00:00.000Z' };
  ctx.view = { ...clone(ctx.view), record: { ...clone(ctx.view.record), paidAt: '2026-11-24T05:00:00.000Z', paidAtMs: String(Date.parse('2026-11-24T05:00:00.000Z')) } };
  return ctx;
}

test('FB6 MF-2: v2 event with expiry fields DELETED + confirm past the reserve expiry FAILS PLT-12', () => {
  const ctx = fb6PastExpiryPltCtx();
  ctx.confirm = { ...clone(ctx.confirm), logged: [{ event: 'PltConfirmed', schemaVersion: 2, seller: ctx.view.seller, payableId: 2, payer: '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n', txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef' }] };
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-12'));
  assert.match(r.checks.find((c) => c.id === 'PLT-12').detail, /no finite reservation expiry/);
});

test('FB6 MF-2: v2 event with expiry Ms GARBLED + confirm past the reserve expiry FAILS PLT-12', () => {
  const ctx = fb6PastExpiryPltCtx();
  ctx.confirm = { ...clone(ctx.confirm), logged: [{ event: 'PltConfirmed', schemaVersion: 2, seller: ctx.view.seller, payableId: 2, payer: '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n', txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef', reservationExpiresMs: 'not-a-number' }] };
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-12'));
  assert.match(r.checks.find((c) => c.id === 'PLT-12').detail, /no finite reservation expiry/);
});

test('FB6 MF-2: v2 event with expiry FORGED later than the reserve + confirm past the reserve expiry FAILS PLT-12', () => {
  const ctx = fb6PastExpiryPltCtx();
  ctx.confirm = { ...clone(ctx.confirm), logged: [{ event: 'PltConfirmed', schemaVersion: 2, seller: ctx.view.seller, payableId: 2, payer: '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n', txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef', reservationExpiresMs: String(Date.parse('2026-11-24T05:56:31.593Z')), reservationExpires: '2026-11-24T05:56:31.593Z' }] };
  const r = verifyPlt(ctx);
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('PLT-12'));
  assert.match(r.checks.find((c) => c.id === 'PLT-12').detail, /later than the reservation expiry/);
});

test('FB6 MF-2: v2 event with a finite expiry equal to the reserve expiry + in-window confirm PASSES PLT-12 (14/14)', () => {
  const ctx = pltCtx();
  ctx.confirm = { ...clone(ctx.confirm), logged: [{ event: 'PltConfirmed', schemaVersion: 2, seller: ctx.view.seller, payableId: 2, payer: '3cjnRyk51g6b3ox6Ez64KrFxC69TCjthnxKL2PDTA5q6rvJh8n', txHash: '7cc2f94f73f9fdb133d59c8546bdfc026a3ae91ace5f9a3716846823909632ef', reservationExpiresMs: '1795496191593', reservationExpires: '2026-11-24T04:56:31.593Z' }] };
  const r = verifyPlt(ctx);
  assert.equal(r.checks.find((c) => c.id === 'PLT-12').status, 'PASS');
  assert.equal(r.allPass, true);
  assert.equal(r.passed, 14);
});

// ---- G7 fix-back-6 MF-4 (honesty M1): the backend memo expectation
// is generation-aware — v2 expects `payable:<seller>:<id>`, v1 expects
// `payable:<id>`, keyed on ctx registryIndex (never on view.seller: a
// v1 view's seller is the payer). ----
test('FB6 MF-4: v2 ctx (registryIndex 13150) with the seller-qualified memo PASSES PLT-07/08', () => {
  const ctx = pltCtx();
  ctx.registryIndex = '13150';
  const t = ctx.summary.summary.events.find((e) => e.tag === 'TokenTransfer');
  t.memo = encodeCborMemo(`payable:${ctx.view.seller}:2`).toString('hex');
  const r = verifyPltTransfer(ctx);
  assert.equal(r.checks.find((c) => c.id === 'PLT-07').status, 'PASS');
  assert.equal(r.checks.find((c) => c.id === 'PLT-08').status, 'PASS');
});

test('FB6 MF-4: v2 ctx (registryIndex 13150) with the v1 short memo FAILS PLT-07/08', () => {
  const ctx = pltCtx();
  ctx.registryIndex = '13150';
  const r = verifyPltTransfer(ctx); // fixture memo is the v1 `payable:2`
  assert.equal(r.checks.find((c) => c.id === 'PLT-07').status, 'FAIL');
  assert.equal(r.checks.find((c) => c.id === 'PLT-08').status, 'FAIL');
});

test('FB6 MF-4: v1 ctx (registryIndex 13149) with the v1 short memo still PASSES PLT-07/08', () => {
  const ctx = pltCtx();
  ctx.registryIndex = '13149';
  const r = verifyPltTransfer(ctx); // fixture memo is the v1 `payable:2`
  assert.equal(r.checks.find((c) => c.id === 'PLT-07').status, 'PASS');
  assert.equal(r.checks.find((c) => c.id === 'PLT-08').status, 'PASS');
});

// G7 fix-back-2 A5e, CORRECTED claim (same constants as the compliance
// judge's a5e-rerun.mjs): the cross-registry failure reproduces ONLY in
// the registry-carried live-path form. The byte-literal offline form
// (no registryIndex on either side) still PASSES via the legacy
// carve-out — the fix-back-1 claim that it FAILS was false.
test('A5e (live-path form): registry-carried v1 reserve vs v2 payable FAILS PLT-13; byte-literal form PASSES (carve-out)', () => {
  const SELLER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
  const PAYER = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
  const PAYEE = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin';
  const PARAM_V2 = '8f069b2c09e479346bcf3a5a3d580fc33e26152da60a7d8a332c67e7d81b21060a00000000000000';
  const PAID_V2 = '06028f069b2c09e479346bcf3a5a3d580fc33e26152da60a7d8a332c67e7d81b21060a00000000000000ba99a32ebd8bc6fc812f4901dbf4dbe30108c8f52a8e1b9cafefa62fbf902cf420a107000000000000';
  const payerBytes = Buffer.from(PAID_V2.slice(84, 148), 'hex');
  const expiresMs = 1795564800000n;
  const expBuf = Buffer.alloc(8); expBuf.writeBigUInt64LE(expiresMs);
  const RESERVED_V2 = Buffer.concat([
    Buffer.from([0x04, 0x02]),
    Buffer.from(PARAM_V2.slice(0, 64), 'hex'),
    Buffer.from('0a00000000000000', 'hex'),
    payerBytes,
    expBuf,
  ]).toString('hex');
  const v2decoded = decodeLoggedEventsV2({ events: [RESERVED_V2] });
  const plt13 = (r) => r.checks.find((c) => c.id === 'PLT-13');
  const base = (reserve, registryIndex, unbound) => ({
    payableId: 10, txHash: 'bb'.repeat(32),
    summary: { status: 'finalized', summary: { transactionType: 'transfer', events: [
      { tag: 'TokenTransfer', tokenId: 'EUDemo', from: { address: PAYER }, to: { address: PAYEE }, amount: { value: '500000' }, memo: '' },
    ] } },
    blockTime: { slotTime: '2026-11-24T12:00:00.000Z' },
    view: { seller: SELLER, amount: '500000', payee: PAYEE, status: 'Paid', dueMs: '1798286400000', due: '2026-12-26T12:00:00.000Z', record: { payer: PAYER } },
    reserve,
    ...(registryIndex ? { registryIndex } : {}),
    ...(unbound ? { unbound } : {}),
  });
  const res = (logged, extra = {}) => ({ blockTime: { slotTime: '2026-11-24T08:00:00.000Z' }, logged, ...extra });
  const literalReserved = { event: 'Reserved', payableId: 10, payer: PAYER, expiresMs: String(expiresMs), expires: new Date(Number(expiresMs)).toISOString() };

  // Live-path form (exact invocation the corrected claim states): MCP
  // registryIndex 13150 + reserve carrying registryIndex 13149.
  const carried = verifyPltTransfer(base(res([literalReserved], { gen: 'v1', registryIndex: '13149' }), '13150'));
  assert.equal(plt13(carried).status, 'FAIL');
  assert.match(plt13(carried).detail, /does not match payable registry=<13150,0>/);

  // Byte-literal offline form: NO registryIndex on either side — still
  // PASSES PLT-13 via the legacy carve-out (fixtures have no registry),
  // now with the EXPLICIT unbound:true opt-in (G7 fix-back-3 MF-2).
  const literal = verifyPltTransfer(base(res([literalReserved]), null, true));
  assert.equal(plt13(literal).status, 'PASS');

  // MF-2: the SAME byte-literal form WITHOUT the explicit opt-in now
  // FAILS PLT-13 — the carve-out is opt-in only, never the default.
  const literalUnbound = verifyPltTransfer(base(res([literalReserved])));
  assert.equal(plt13(literalUnbound).status, 'FAIL');
  assert.match(plt13(literalUnbound).detail, /unbound/);

  // A real v2 reserve (seller + registry match) still PASSES.
  const real = verifyPltTransfer(base(res(v2decoded, { gen: 'v2', registryIndex: '13150' }), '13150'));
  assert.equal(plt13(real).status, 'PASS');
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
