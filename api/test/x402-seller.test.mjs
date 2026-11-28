import test from 'node:test';
import assert from 'node:assert/strict';
import { createX402Seller, SellerError, TESTNET_CAIP2 } from '../src/x402-seller.mjs';

const PAYTO = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const PAYEE = '3okVZTaSqFtzNMZfbst1pyweWMQZBkgTWSp5fqnJTkDtxRLMYJ';
const FEE = '3U1m4EhpixbWB3d4qqNZkTzapzcWFjVobwkV1kEyLjiQFGGrS1';
const pay = (over = {}) => Buffer.from(JSON.stringify({ x402Version: 2, accepted: { scheme: 'exact', network: TESTNET_CAIP2, amount: '10000', payTo: PAYTO, ...over }, payload: { signedTransaction: {} } })).toString('base64');

function mk(over = {}) {
  const log = { verify: 0, settle: 0, checks: 0, rows: [] };
  const s = createX402Seller({
    facilitator: { verify: async () => { log.verify++; return { isValid: true, payer: PAYEE }; }, settle: async () => { log.settle++; return { success: true, transaction: 'ab'.repeat(32), payer: PAYEE }; } },
    check: async (i) => { log.checks++; return { verdict: 'UNVERIFIED', subject: i.payee }; },
    payTo: PAYTO, feePayer: FEE, resourceUrl: () => 'https://api.test/x', record: async (r) => log.rows.push(r), ...over,
  });
  return { s, log };
}
const q = { payee: PAYEE, name: 'Acme ApS' };

test('no payment header: 402 with PAYMENT-REQUIRED (CCD, payTo, fee payer), nothing checked or settled', async () => {
  const { s, log } = mk();
  const r = await s.handle({ query: q, headers: {} });
  assert.equal(r.status, 402);
  const pr = JSON.parse(Buffer.from(r.headers['PAYMENT-REQUIRED'], 'base64').toString());
  assert.deepEqual({ a: pr.accepts[0].amount, p: pr.accepts[0].payTo, n: pr.accepts[0].network, f: pr.accepts[0].extra.feePayer, as: pr.accepts[0].asset }, { a: '10000', p: PAYTO, n: TESTNET_CAIP2, f: FEE, as: 'CCD' });
  assert.equal(log.verify + log.settle + log.checks, 0);
});

test('a valid payment is verified, settled once, and returns the verdict with the tx hash', async () => {
  const { s, log } = mk();
  const r = await s.handle({ query: q, headers: { 'payment-signature': pay() } });
  assert.equal(r.status, 200); assert.equal(r.body.epc_verdict, 'unverified'); assert.equal(r.body.paid.tx_hash, 'ab'.repeat(32));
  assert.equal(JSON.parse(Buffer.from(r.headers['PAYMENT-RESPONSE'], 'base64').toString()).success, true);
  assert.deepEqual([log.verify, log.settle, log.rows.length], [1, 1, 1]);
});

test('a payment for a different payTo or amount is refused before the facilitator is called', async () => {
  const { s, log } = mk();
  for (const over of [{ payTo: PAYEE }, { amount: '1' }, { network: 'eip155:1' }]) {
    const r = await s.handle({ query: q, headers: { 'payment-signature': pay(over) } });
    assert.equal(r.status, 402);
  }
  assert.equal(log.verify + log.settle, 0);
});

test('an invalid or unsettled payment gets no verdict body; a reused tx is refused; bad input is 400', async () => {
  const bad = mk({ facilitator: { verify: async () => ({ isValid: false, invalidReason: 'amount_mismatch' }), settle: async () => { throw new Error('never'); } } });
  const r = await bad.s.handle({ query: q, headers: { 'payment-signature': pay() } });
  assert.equal(r.status, 402); assert.equal(r.body.verdict, undefined); assert.match(r.body.error, /amount_mismatch/);
  const unsettled = mk({ facilitator: { verify: async () => ({ isValid: true }), settle: async () => ({ success: false, errorReason: 'insufficient_funds' }) } });
  assert.equal((await unsettled.s.handle({ query: q, headers: { 'payment-signature': pay() } })).status, 402);
  const { s } = mk();
  await s.handle({ query: q, headers: { 'payment-signature': pay() } });
  assert.match((await s.handle({ query: q, headers: { 'payment-signature': pay() } })).body.error, /already used/);
  await assert.rejects(() => s.handle({ query: { payee: 'x', name: 'n' }, headers: {} }), SellerError);
  await assert.rejects(() => s.handle({ query: { payee: PAYEE }, headers: {} }), SellerError);
});
