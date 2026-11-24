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
import { server } from '../src/server.mjs';

const PORT = 17401;
const BASE = `http://127.0.0.1:${PORT}`;
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

before(() => new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve)));
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
  assert.equal(json.vendor_list.length, 1);
  assert.equal(json.vendor_list[0].seller, '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB');
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
  const p1 = json.items.find((i) => i.payable_id === 1);
  assert.equal(p1.asset, 'ccd');
  assert.equal(p1.amount_display, '10.000000 CCD');
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

test('POST /api/payables/:id/verify after_pay: 10/10 CCD, 12/12 EUDemo', async () => {
  const ccd = await post('/api/payables/10/verify', { mode: 'after_pay' });
  assert.equal(ccd.status, 200);
  assert.equal(ccd.json.verdict, 'paid');
  assert.equal(ccd.json.total, 10);
  assert.equal(ccd.json.passed, 10);
  const ccdIds = ccd.json.checks.map((c) => c.id);
  assert.deepEqual(ccdIds, ['registered', 'doc', 'agent', 'registry_zero', 'status_paid', 'tx_finalized', 'invoked_pay_ccd', 'sender_is_payer', 'single_transfer_to_payee', 'no_other_transfer']);

  const plt = await post('/api/payables/11/verify', { mode: 'after_pay' });
  assert.equal(plt.json.verdict, 'paid');
  assert.equal(plt.json.total, 12);
  assert.equal(plt.json.passed, 12);
  const pltIds = plt.json.checks.map((c) => c.id);
  assert.deepEqual(pltIds, ['registered', 'doc', 'agent', 'registry_zero', 'status_paid', 'tx_finalized', 'one_token_transfer', 'token_eudemo', 'from_payer', 'to_payee', 'amount', 'memo']);

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
  assert.match(json.plain, /not set up on this registry yet/);
  assert.equal(json.recorded_example.vendor_list_live.length, 1);
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
  assert.equal(r11.json.verifier.passed, 14); // 12 after-pay + 2 receipt-binding extras
  assert.equal(r11.json.verifier.total, 14);

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
