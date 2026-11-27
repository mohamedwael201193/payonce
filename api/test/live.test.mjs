// PayOnce API server — live read-only integration tests (testnet).
// Every GET endpoint + the non-sending POSTs (verify, dry-run, precheck
// attacks) are exercised against the REAL testnet. NOTHING here sends a
// transaction: sends live in test/smoke.mjs (fresh payables, real fees).
// Run: node --test test/live.test.mjs
// Requires: the backend tree (PAYONCE_BACKEND_DIR or the default layout)
// and network access to grpc.testnet.concordium.com:20000.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { server, refreshScan } from '../src/server.mjs';
import { DATA_DIR } from '../src/config.mjs';

const SELLER1 = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const SELLER2 = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr';

const PORT = 17401;
const BASE = `http://127.0.0.1:${PORT}`;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

before(async () => {
  await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));
  // stats/invoices are cache-only: run the first complete scan up front (what the boot loop does).
  await refreshScan();
}, { timeout: 300_000 });
after(() => new Promise((resolve) => server.close(resolve)));

async function get(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* text body (document) */ }
  return { status: res.status, json, text };
}
async function post(path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, json };
}

test('GET /api/config reports the live v2 registry', async () => {
  const { status, json } = await get('/api/config');
  assert.equal(status, 200);
  assert.equal(json.network, 'testnet');
  assert.equal(json.registry.index, 13150);
  assert.equal(json.registry.subindex, 0);
  assert.equal(json.registry.module_ref, 'c8083a94f57495ecc0ac6b7f18eb7f5944989897929c095e638b6362d55685a8');
  assert.equal(json.cis8004_test_instance.index, 12802);
  assert.equal(json.cis8004_test_instance.is_official_registry, true);
  assert.equal(json.cis8004_test_instance.official_module_ref, '0e57473715d1c2a364fa626b8783688db32b7fac9d0e2fc97043da91e1a7d3eb');
  assert.equal(json.reservation_secs, 3600);
  assert.equal(json.co_signer_margin_secs, 60);
  // Both sellers are listed only when their on-chain vendor rows exist
  // (fix-back §4.7 — the list is enforced in code, not hardcoded).
  assert.equal(json.vendor_list.length, 2);
  assert.equal(json.vendor_list[0].seller, '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB');
  assert.equal(json.vendor_list[1].seller, '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr');
  assert.equal(json.sellers.length, 2);
  assert.equal(json.sellers[0].seller, '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB');
  assert.equal(json.sellers[0].agent_token, 1476);
  assert.equal(json.sellers[0].badge, 'JyP9XawpXHMjTN5ocrA5a');
  assert.equal(json.sellers[1].seller, '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr');
  assert.equal(json.sellers[1].agent_token, 1506);
  assert.equal(json.sellers[1].badge, 'JyP9Y9nGU4KaM7DBDXRgm');
  assert.equal(json.build.vendor_list_enforced_by_co_signer, true);
  assert.equal(json.build.confirm_by, 'payer (the reserving payer)');
  assert.equal(json.verifier.file, 'verify-payable-v2.mjs');
});

test('GET /api/health reports live balances', async () => {
  const { status, json } = await get('/api/health');
  assert.equal(status, 200);
  assert.equal(json.chain.reachable, true);
  assert.equal(json.payer.status, 'ok');
  assert.equal(json.sponsor.status, 'ok');
  assert.equal(json.wallet_eudemo.status, 'ok');
  assert.equal(json.co_signer.status, 'ok');
  assert.equal(typeof json.budget.new_invoices_left_this_hour, 'number');
});

test('GET /api/stats counts the real registry rows', async () => {
  const { status, json } = await get('/api/stats');
  assert.equal(status, 200);
  assert.ok(json.payables_total >= 7); // 1-5, 10, 11 (+ fresh ids after a smoke run)
  assert.ok(json.paid_total >= 2); // 10, 11 (+ fresh pays after a smoke run)
  assert.equal(typeof json.refused_on_chain_since_deploy, 'number');
  assert.ok(json.refused_on_chain_since_deploy >= 15); // v2 matrix rejects
  assert.equal(typeof json.last_verifier_run_at === 'string' || json.last_verifier_run_at === null, true);
});

test('GET /api/invoices lists unpaid + paid lab payables', async () => {
  const { status, json } = await get('/api/invoices');
  assert.equal(status, 200);
  const ids = json.items.map((i) => i.payable_id);
  assert.ok(ids.includes(1) && ids.includes(2) && ids.includes(3));
  assert.ok(ids.includes(10) && ids.includes(11));
  assert.ok(!ids.includes(4)); // Voided is not listed
  const p1 = json.items.find((i) => i.payable_id === 1 && i.seller === SELLER1);
  assert.equal(p1.asset, 'ccd');
  assert.equal(p1.amount_display, '10.000000 CCD');
  // Seller 2's payable 1 (same id, different seller) is listed too, and
  // is distinguishable by its seller — the bare-id find above must not
  // pick it up (fix-back §4.5: ids collide across sellers).
  const p1s2 = json.items.find((i) => i.payable_id === 1 && i.seller === SELLER2);
  assert.equal(p1s2.asset, 'ccd');
  assert.equal(p1s2.amount_display, '0.500000 CCD');
  const p2s2 = json.items.find((i) => i.payable_id === 2 && i.seller === SELLER2);
  assert.equal(p2s2.asset, 'eudemo');
  assert.equal(p2s2.amount_display, '10.00 EUDemo');
  const p3 = json.items.find((i) => i.payable_id === 3);
  assert.equal(p3.asset, 'eudemo');
  assert.equal(p3.amount_display, '1.00 EUDemo');
});

test('GET /api/payables/:id returns live facts; matrix doc hashes match', async () => {
  const { status, json } = await get('/api/payables/1');
  assert.equal(status, 200);
  assert.equal(json.payable_id, 1);
  assert.equal(json.asset.kind, 'ccd');
  assert.equal(json.amount, '10000000');
  assert.equal(json.seller, '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB');
  assert.equal(json.payee, '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs');
  assert.equal(json.status.kind, 'unpaid');
  assert.equal(json.agent.token, '1476');
  assert.equal(json.agent.registry.index, 12802);
  // The on-chain doc_hash IS sha256(`payonce-live-matrix-1`).
  assert.equal(json.doc_sha256, sha256(Buffer.from('payonce-live-matrix-1', 'utf8')));
  const p5 = await get('/api/payables/5');
  assert.equal(p5.json.is_past_due, true);
  const p10 = await get('/api/payables/10');
  assert.equal(p10.json.status.kind, 'paid');
  assert.equal(p10.json.status.payment_tx, '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197');
  assert.equal(p10.json.status.payment_tx_source, 'server_store');
  const p11 = await get('/api/payables/11');
  assert.equal(p11.json.status.kind, 'paid');
  assert.equal(p11.json.status.payment_tx, '690c5e2beebd25554b81e18d014aa81c7adde3f35bff505fe0615efe536d2214');
  assert.equal(p11.json.status.payment_tx_source, 'chain');
  const missing = await get('/api/payables/99999');
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'not_found');
});

test('GET /api/payables/:id/document serves the exact registered bytes', async () => {
  const d1 = await get('/api/payables/1/document');
  assert.equal(d1.status, 200);
  assert.equal(d1.text, 'payonce-live-matrix-1');
  const d10 = await get('/api/payables/10/document');
  assert.equal(d10.status, 200);
  assert.match(d10.text, /PAYONCE TEST INVOICE — payable 10/);
  assert.equal(sha256(Buffer.from(d10.text, 'utf8')), 'c9fef19aa010ed3da158678cbfcafb5005699e55eef81ca1104f3250d8addb7f');
  const d11 = await get('/api/payables/11/document');
  assert.equal(sha256(Buffer.from(d11.text, 'utf8')), 'f02ed5c9305f7334ebf73d5797eeb21dd941508c7c09fb947cb1699201e2938d');
  const missing = await get('/api/payables/99999/document');
  assert.equal(missing.status, 404);
});

test('POST /api/payables/:id/verify before_pay: ready / blocked / paid', async () => {
  const ready = await post('/api/payables/1/verify', { mode: 'before_pay' });
  assert.equal(ready.status, 200);
  assert.equal(ready.json.verdict, 'ready');
  assert.equal(ready.json.mode, 'before_pay');
  assert.equal(ready.json.total, 9);
  const byId = Object.fromEntries(ready.json.checks.map((c) => [c.id, c]));
  assert.equal(byId.registered.status, 'ok');
  assert.equal(byId.doc.status, 'ok');
  assert.equal(byId.agent.status, 'ok');
  assert.equal(byId.identity.status, 'info');
  assert.equal(byId.due.status, 'ok');
  assert.equal(byId.status.status, 'ok');
  assert.equal(byId.balance.status, 'ok');

  const pastDue = await post('/api/payables/5/verify', { mode: 'before_pay' });
  assert.equal(pastDue.json.verdict, 'blocked');
  assert.equal(pastDue.json.blocked_reason, 'due');

  const voided = await post('/api/payables/4/verify', { mode: 'before_pay' });
  assert.equal(voided.json.verdict, 'blocked');
  assert.equal(voided.json.blocked_reason, 'status');

  const paid = await post('/api/payables/10/verify', { mode: 'before_pay' });
  assert.equal(paid.json.verdict, 'paid');

  const mismatch = await post('/api/payables/1/verify', { mode: 'before_pay', doc_sha256: '00'.repeat(32) });
  assert.equal(mismatch.json.verdict, 'blocked');
  assert.equal(mismatch.json.blocked_reason, 'doc');
});

test('POST /api/payables/:id/verify after_pay: 10/10 CCD, 14/14 EUDemo', async () => {
  const ccd = await post('/api/payables/10/verify', { mode: 'after_pay' });
  assert.equal(ccd.status, 200);
  assert.equal(ccd.json.verdict, 'paid');
  assert.equal(ccd.json.total, 10);
  assert.equal(ccd.json.passed, 10);
  const ccdIds = ccd.json.checks.map((c) => c.id);
  assert.deepEqual(ccdIds, ['registered', 'doc', 'agent', 'registry_zero', 'status_paid', 'tx_finalized', 'invoked_pay_ccd', 'sender_is_payer', 'single_transfer_to_payee', 'no_other_transfer']);

  const plt = await post('/api/payables/11/verify', { mode: 'after_pay' });
  assert.equal(plt.json.verdict, 'paid');
  assert.equal(plt.json.total, 14);
  assert.equal(plt.json.passed, 14);
  const pltIds = plt.json.checks.map((c) => c.id);
  // G7 fix-back-3 MF-3: the 12 P3 checks plus the fail-closed
  // reservation + paid_at rows; the handler supplies the stored
  // reserve/confirm evidence, so the real p11 payment still verifies.
  assert.deepEqual(pltIds, ['registered', 'doc', 'agent', 'registry_zero', 'status_paid', 'tx_finalized', 'one_token_transfer', 'token_eudemo', 'from_payer', 'to_payee', 'amount', 'memo', 'reservation_precedes_transfer', 'paid_at_is_confirm_time']);

  const unpaid = await post('/api/payables/1/verify', { mode: 'after_pay' });
  assert.equal(unpaid.json.verdict, 'blocked');
  assert.equal(unpaid.json.blocked_reason, 'status');
});

test('GET /api/tx/:hash/status reads a real finalized tx; unknown hash 404s', async () => {
  const { status, json } = await get('/api/tx/7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197/status');
  assert.equal(status, 200);
  assert.equal(json.status, 'finalized');
  assert.equal(json.reject, null);
  assert.equal(typeof json.fee_testnet_ccd, 'string');
  assert.ok(Number(json.fee_testnet_ccd) > 0);
  const missing = await get(`/api/tx/${'00'.repeat(32)}/status`);
  assert.equal(missing.status, 404);
  const bad = await get('/api/tx/not-a-hash/status');
  assert.equal(bad.status, 400);
});

test('POST /api/cosigner/dry-run decides live (no tx sent)', async () => {
  // Payable 3 is Unpaid EUDemo: a transfer dry run refuses `not-reserved`
  // (the transfer gate needs a Reserved payable) — the real decision.
  const r = await post('/api/cosigner/dry-run', {
    payable_id: 3,
    to: '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg',
    amount: '1000000',
    memo: 'payable:42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB:3',
  });
  assert.equal(r.status, 200);
  assert.equal(r.json.decision, 'REFUSE');
  assert.equal(r.json.reason, 'not-reserved');
  assert.equal(r.json.tx_sent, false);
  // Payable 11 is Paid: the same dry run refuses `already-paid`.
  const r2 = await post('/api/cosigner/dry-run', {
    payable_id: 11,
    to: '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg',
    amount: '10000',
    memo: 'payable:42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB:11',
  });
  assert.equal(r2.json.decision, 'REFUSE');
  assert.equal(r2.json.reason, 'already-paid');
  const bad = await post('/api/cosigner/dry-run', { payable_id: 99999, to: 'x', amount: '1', memo: 'm' });
  assert.equal(bad.status, 404);
});

test('POST /api/attacks/pay_twice precheck_only sends nothing', async () => {
  const { status, json } = await post('/api/attacks/pay_twice', { payable_id: 10, mode: 'precheck_only' });
  assert.equal(status, 200);
  assert.equal(json.live, false);
  assert.equal(json.tx_sent, false);
  assert.equal(json.layer, 'app');
  assert.match(json.plain, /already Paid/);
  const unknown = await post('/api/attacks/nope', { payable_id: 10 });
  assert.equal(unknown.status, 404);
});

test('POST /api/attacks/unlisted_seller reports the missing setup + live checks', async () => {
  const { status, json } = await post('/api/attacks/unlisted_seller', { payable_id: 1 });
  assert.equal(status, 200);
  assert.equal(json.live, false);
  assert.equal(json.tx_sent, false);
  assert.equal(json.outcome, 'not_set_up');
  assert.match(json.plain, /No lab fraud invoice exists on this registry/);
  assert.equal(json.recorded_example.vendor_list_live.length, 2);
  assert.equal(json.recorded_example.cosigner_dry_run_live.decision, 'REFUSE');
  assert.equal(json.recorded_example.cosigner_dry_run_live.code, 'no-approval');
});

test('GET /api/receipts/:id rebuilds the receipt live; unpaid 404s', async () => {
  const r10 = await get('/api/receipts/10');
  assert.equal(r10.status, 200);
  assert.equal(r10.json.payable_id, 10);
  assert.equal(r10.json.amount_display, '0.500000 CCD');
  assert.equal(r10.json.txs.length, 1);
  assert.equal(r10.json.txs[0].tx_hash, '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197');
  assert.equal(r10.json.payment_tx_source, 'server_store');
  assert.equal(r10.json.verifier.passed, 10);
  assert.equal(r10.json.verifier.total, 10);

  const r11 = await get('/api/receipts/11');
  assert.equal(r11.status, 200);
  assert.equal(r11.json.txs.length, 3);
  assert.equal(r11.json.payment_tx_source, 'chain');
  assert.equal(r11.json.verifier.passed, 15); // 14 after-pay (12 P3 + reservation + paid_at) + 1 stored-tx-hash extra
  assert.equal(r11.json.verifier.total, 15);

  const unpaid = await get('/api/receipts/1');
  assert.equal(unpaid.status, 404);
});

test('GET /api/recorded/:id returns the recorded run; unknown 404s', async () => {
  const r10 = await get('/api/recorded/10');
  assert.equal(r10.status, 200);
  assert.equal(r10.json.date, '2026-11-24');
  assert.ok(r10.json.steps.some((s) => s.txHash === '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197'));
  const r11 = await get('/api/recorded/11');
  assert.ok(r11.json.steps.some((s) => s.txHash === '690c5e2beebd25554b81e18d014aa81c7adde3f35bff505fe0615efe536d2214'));
  const missing = await get('/api/recorded/99999');
  assert.equal(missing.status, 404);
});

test('GET /api/judges/files lists real files with real SHA-256; download serves bytes', async () => {
  const { status, json } = await get('/api/judges/files');
  assert.equal(status, 200);
  assert.ok(json.files.length >= 6);
  for (const f of json.files) {
    assert.match(f.sha256, /^[0-9a-f]{64}$/);
    assert.ok(f.url.startsWith('/api/judges/files/'));
  }
  const v2 = json.files.find((f) => f.name === 'v2-live-e2e-2026-11-24.json');
  assert.ok(v2);
  const dl = await get(v2.url);
  assert.equal(dl.status, 200);
  assert.equal(sha256(Buffer.from(dl.text, 'utf8')), v2.sha256);
  const missing = await get('/api/judges/files/nope.txt');
  assert.equal(missing.status, 404);
});

test('GET /api/jobs/:id 404s for an unknown job', async () => {
  const { status, json } = await get('/api/jobs/job_nope');
  assert.equal(status, 404);
  assert.equal(json.error.code, 'not_found');
});

// ---- second-seller wiring (fix-back §4.1–§4.6; live, testnet) ----
// NOTE: the receipt GETs below trigger the server's normal Art. 12
// anchoring (one registerData tx each, owner-signed, no funds moved) —
// the same side effect the adversarial wiring judge disclosed for its
// three anchor txs. No pay/create/attack-send calls are made here.

test('seller-2 read endpoints resolve (seller, id) on chain', async () => {
  const p1 = await get(`/api/payables/1?seller=${SELLER2}`);
  assert.equal(p1.status, 200);
  assert.equal(p1.json.seller, SELLER2);
  assert.equal(p1.json.amount_display, '0.500000 CCD');
  assert.equal(p1.json.status.kind, 'paid');
  // agent.token is a string in the payable-facts shape (the frontend's
  // payableSchema declares token: z.string()); the chain view returns
  // the seller-2 token id as '1506'.
  assert.equal(p1.json.agent.token, '1506');
  const p2 = await get(`/api/payables/2?seller=${SELLER2}`);
  assert.equal(p2.status, 200);
  assert.equal(p2.json.seller, SELLER2);
  assert.equal(p2.json.amount_display, '10.00 EUDemo');
  assert.equal(p2.json.status.kind, 'paid');
  assert.equal(p2.json.agent.token, '1506');
  // And the same ids without a seller are still seller 1's (Unpaid).
  const s1 = await get('/api/payables/1');
  assert.equal(s1.json.seller, SELLER1);
  assert.equal(s1.json.status.kind, 'unpaid');
  // Seller-2 documents serve seller 2's invoice text (token 1506).
  const doc = await get(`/api/payables/2/document?seller=${SELLER2}`);
  assert.equal(doc.status, 200);
  assert.match(doc.text, /10\.00 EUDemo/);
});

test('seller-2 receipts re-verify live: payable 1 is 10/10, payable 2 has a real verifier', async () => {
  const r1 = await get(`/api/receipts/1?seller=${SELLER2}`);
  assert.equal(r1.status, 200);
  assert.equal(r1.json.seller, SELLER2);
  assert.equal(r1.json.txs[0].tx_hash, '51dbf9547fedc5e515d1205404b772c1e96d61c7f1ef4c72d635bf2cf3e8b96f');
  assert.notEqual(r1.json.verifier, null);
  assert.equal(r1.json.verifier.passed, 10);
  assert.equal(r1.json.verifier.total, 10);
  assert.equal(r1.json.art12.agent.registry_token, 1506);
  const r2 = await get(`/api/receipts/2?seller=${SELLER2}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.seller, SELLER2);
  // The transfer leg is labelled 'Transfer' (not 'Payment') and the
  // verifier actually ran: passed === total (the served total is 14 —
  // the standalone 12 plus receipt extras — see fix-back §4.1).
  assert.equal(r2.json.txs.find((t) => t.label === 'Transfer')?.tx_hash, '5f5edd7bc9d8a7b0f31143e569456a17dabaadbe7c6b514a5dc50a778ad5cb72');
  assert.ok(r2.json.txs.some((t) => t.label === 'Reservation'));
  assert.ok(r2.json.txs.some((t) => t.label === 'Confirm'));
  assert.notEqual(r2.json.verifier, null);
  assert.equal(r2.json.verifier.passed, r2.json.verifier.total);
  assert.equal(r2.json.art12.agent.registry_token, 1506);
  // Seller 1's payables 1/2 are Unpaid — no receipt, 404.
  const unpaid = await get('/api/receipts/1');
  assert.equal(unpaid.status, 404);
});

test('seller-2 after_pay verify runs the verifier (not blocked/no_payment_tx)', async () => {
  const v = await post(`/api/payables/2/verify?seller=${SELLER2}`, { mode: 'after_pay' });
  assert.equal(v.status, 200);
  assert.equal(v.json.verdict, 'paid');
  assert.equal(v.json.passed, v.json.total);
});

test('unknown ?seller= fails closed with 400 on read endpoints', async () => {
  for (const path of ['/api/payables/1?seller=garbage', '/api/payables/1/document?seller=garbage', `/api/receipts/1?seller=${SELLER1.slice(0, 20)}`, '/api/recorded/1?seller=garbage']) {
    const r = await get(path);
    assert.equal(r.status, 400, path);
    assert.equal(r.json.error.code, 'invalid');
  }
});

test('write endpoints 400 on ?seller= naming seller 2 (never silently seller 1)', async () => {
  const pay = await post(`/api/payables/1/pay?seller=${SELLER2}`, { rail: 'ccd', doc_sha256: '6b6a232426a6bbd1f8b5467c17e379e92e53248a383aa707b4a78387b630900f' });
  assert.equal(pay.status, 400);
  assert.equal(pay.json.error.code, 'invalid');
  const atk = await post(`/api/attacks/pay_twice?seller=${SELLER2}`, { payable_id: 1, mode: 'precheck_only' });
  assert.equal(atk.status, 400);
  assert.equal(atk.json.error.code, 'invalid');
  const dry = await post(`/api/cosigner/dry-run?seller=${SELLER2}`, { payable_id: 1, to: SELLER2, amount: '10000', memo: `payable:${SELLER2}:1` });
  assert.equal(dry.status, 400);
  assert.equal(dry.json.error.code, 'invalid');
  const consent = await post('/api/consent/request?seller=' + SELLER2, { payable_id: 1 });
  assert.equal(consent.status, 400);
  assert.equal(consent.json.error.code, 'invalid');
  // A body `seller` naming seller 2 is refused the same way.
  const payBody = await post('/api/payables/1/pay', { rail: 'ccd', seller: SELLER2 });
  assert.equal(payBody.status, 400);
  assert.equal(payBody.json.error.code, 'invalid');
});

test('recorded runs are seller-aware: seller 2 gets its own runs, never seller 1’s v1 run', async () => {
  const r1 = await get(`/api/recorded/1?seller=${SELLER2}`);
  assert.equal(r1.status, 200);
  assert.equal(r1.json.seller, SELLER2);
  assert.deepEqual(r1.json.steps.map((s) => s.step), ['register', 'pay', 'verify']);
  assert.equal(r1.json.steps[1].txHash, '51dbf9547fedc5e515d1205404b772c1e96d61c7f1ef4c72d635bf2cf3e8b96f');
  const r2 = await get(`/api/recorded/2?seller=${SELLER2}`);
  assert.equal(r2.status, 200);
  assert.equal(r2.json.seller, SELLER2);
  assert.deepEqual(r2.json.steps.map((s) => s.step), ['register', 'reserve', 'transfer', 'confirm', 'verify']);
  assert.equal(r2.json.steps[2].txHash, '5f5edd7bc9d8a7b0f31143e569456a17dabaadbe7c6b514a5dc50a778ad5cb72');
  // No seller → seller 1's v1 run for id 1 (no seller field, 'run' step).
  const s1 = await get('/api/recorded/1');
  assert.equal(s1.status, 200);
  assert.equal(s1.json.steps[0].step, 'run');
  // Seller 2 has no recorded run for id 10 → 404, not seller 1's run.
  const miss = await get(`/api/recorded/10?seller=${SELLER2}`);
  assert.equal(miss.status, 404);
});

test('planted legacy seller-less receipt never poisons seller 2 (fix-back §4.2)', async () => {
  const receiptsPath = join(DATA_DIR, 'receipts.json');
  const countersPath = join(DATA_DIR, 'counters.json');
  const beforeReceipts = readFileSync(receiptsPath, 'utf8');
  let beforeCounters = null;
  try { beforeCounters = readFileSync(countersPath, 'utf8'); } catch { /* counters file may not exist yet */ }
  try {
    // Plant exactly what the adversarial judge planted: a legacy
    // seller-less receipt for id 1 naming seller 1's payable-10 pay tx
    // and seller 1's Art. 12 record (token 1476).
    const planted = JSON.parse(beforeReceipts);
    // Drop any already-saved seller-2 receipt for id 1 first, so the
    // GET must rebuild from the evidence index (not a cached row) — the
    // planted legacy row is the only stored candidate for id 1.
    delete planted[`${SELLER2}:1`];
    planted['1'] = {
      payable_id: 1,
      amount_display: '0.500000 CCD',
      payee: SELLER1,
      payer_label: 'Demo payer account (lab)',
      txs: [{ label: 'Payment', tx_hash: '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197', explorer_url: 'https://ccdexplorer.io/testnet/transaction/7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197' }],
      verifier: { passed: 7, total: 10, checked_at: '2026-11-25T00:00:00.000Z' },
      payment_tx_source: 'server_store',
      art12: { agent: { registry_token: 1476, badge: 'JyP9XawpXHMjTN5ocrA5a', owner: SELLER1 }, task: 'Verify & Pay payable 10 (0.500000 CCD)', anchor_status: 'verified' },
    };
    writeFileSync(receiptsPath, JSON.stringify(planted, null, 2), 'utf8');
    const r = await get(`/api/receipts/1?seller=${SELLER2}`);
    assert.equal(r.status, 200);
    // Seller 2's OWN receipt — never the planted row.
    assert.equal(r.json.txs[0].tx_hash, '51dbf9547fedc5e515d1205404b772c1e96d61c7f1ef4c72d635bf2cf3e8b96f');
    assert.notEqual(r.json.verifier, null);
    assert.equal(r.json.verifier.passed, 10);
    assert.equal(r.json.verifier.total, 10);
    assert.equal(r.json.art12.agent.registry_token, 1506);
    assert.equal(r.json.art12.agent.badge, 'JyP9Y9nGU4KaM7DBDXRgm');
  } finally {
    // Restore the store files byte-for-byte (also drops the S2 receipt
    // this GET saved under its composite key).
    writeFileSync(receiptsPath, beforeReceipts, 'utf8');
    if (beforeCounters !== null) writeFileSync(countersPath, beforeCounters, 'utf8');
  }
});
