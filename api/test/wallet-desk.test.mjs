// Own-wallet desk: starter CCD, visitor invoices and the pay_ccd transaction, offline with stubs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createWalletDesk } from '../src/wallet-desk.mjs';
import { initSchemas, registryParamSchema } from '../src/open-wiring.mjs';
import { serializeTypeValue } from '@concordium/web-sdk';
import { encodeV2PayableKey } from '../../backend/src/v2/encoders.mjs';

const V = '3S86n9LzC4H8NVYWASGpnUUaRpXxKgb4pdKkHM5EQAeYGRVvVN';
const B = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
const S1 = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const NOW = Date.parse('2026-11-28T08:00:00Z');

function memKv() {
  const m = new Map();
  return {
    async get(ns, k) { return m.get(`${ns}|${k}`) ?? null; },
    async put(ns, k, v) { m.set(`${ns}|${k}`, v); },
    async putIfAbsent(ns, k, v) { if (m.has(`${ns}|${k}`)) return false; m.set(`${ns}|${k}`, v); return true; },
  };
}
function windows() {
  const hits = new Map();
  return async (key, ms, limit) => { const n = (hits.get(key) ?? 0) + 1; hits.set(key, n); return { allowed: n <= limit, resetMs: ms }; };
}
function make(over = {}) {
  const sent = [];
  const balances = new Map([[V, 100_000n]]);
  const rows = new Map();
  const desk = createWalletDesk({
    kv: memKv(), hitWindow: windows(), now: () => NOW, internalAccounts: [B, S1],
    registry: { index: 13150, subindex: 0, name: 'payable_registry_v2' },
    schemas: { payCcd: 'AAAA' },
    chain: {
      balanceMicro: async (a) => (balances.has(a) ? balances.get(a) : null),
      sendTransfer: async (to, micro) => { sent.push({ to, micro }); return { txHash: 'ab'.repeat(32) }; },
      registerInvoiceFor: async (payer) => ({ seller: S1, payable_id: 1100 + sent.length, tx_hash: 'cd'.repeat(32), payer }),
      getPayable: async (s, id) => rows.get(`${s}:${id}`) ?? null,
    },
    ...over,
  });
  return { desk, sent, balances, rows };
}

test('account: balance and the low-balance hint; unknown accounts say so', async () => {
  const { desk } = make();
  const a = await desk.account(V);
  assert.equal(a.exists, true);
  assert.equal(a.balance_ccd, '0.1');
  assert.equal(a.needs_funds, true);
  const none = await desk.account(B);
  assert.equal(none.exists, false);
  await assert.rejects(desk.account('nope'), /not a Concordium/);
});

test('faucet: once per account, never to internal or funded accounts', async () => {
  const { desk, sent, balances } = make();
  const r = await desk.faucet(V, '1.1.1.1');
  assert.equal(r.sent, true);
  assert.deepEqual(sent, [{ to: V, micro: 150_000_000n }]);
  const again = await desk.faucet(V, '1.1.1.1');
  assert.equal(again.sent, false);
  assert.equal(again.reason, 'already_sent');
  await assert.rejects(desk.faucet(B, '1.1.1.1'), /own demo accounts/);
  const rich = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin';
  balances.set(rich, 500_000_000n);
  assert.equal((await desk.faucet(rich, '1.1.1.2')).reason, 'already_funded');
  assert.equal(sent.length, 1);
});

test('faucet: a failed send is not retried for that account', async () => {
  const { desk } = make({ chain: { balanceMicro: async () => 0n, sendTransfer: async () => { throw new Error('node said no'); } } });
  await assert.rejects(desk.faucet(V, 'x'), /could not be sent/);
  assert.equal((await desk.faucet(V, 'x')).reason, 'already_sent');
});

test('visitor invoice: names the visitor as the only payer; per-account daily cap', async () => {
  const { desk } = make();
  const inv = await desk.invoiceFor(V, 'ip');
  assert.equal(inv.expected_payer, V);
  await desk.invoiceFor(V, 'ip');
  await desk.invoiceFor(V, 'ip');
  await assert.rejects(desk.invoiceFor(V, 'ip'), /already has 3/);
  await assert.rejects(desk.invoiceFor(B, 'ip'), /own demo accounts/);
});

test('pay transaction: only for an unpaid CCD invoice the visitor may pay', async () => {
  const { desk, rows } = make();
  const row = { seller: S1, id: 1101, payee: B, amount: '500000', asset: 'CCD', due: '2026-11-29T08:00:00Z', dueMs: String(Date.parse('2026-11-29T08:00:00Z')), expectedPayer: V, status: 'Unpaid', docHash: 'aa'.repeat(32), agentToken: '1476' };
  rows.set(`${S1}:1101`, row);
  const t = await desk.payTransaction(S1, '1101', V);
  assert.equal(t.transaction.amount_micro, '500000');
  assert.equal(t.transaction.receive_name, 'payable_registry_v2.pay_ccd');
  assert.deepEqual(t.transaction.parameter_json, { seller: S1, payable_id: 1101 });
  await assert.rejects(desk.payTransaction(S1, '1101', B), /names a different payer/);
  await assert.rejects(desk.payTransaction(S1, '9', V), /No invoice 9/);
  rows.set(`${S1}:1101`, { ...row, status: 'Paid' });
  await assert.rejects(desk.payTransaction(S1, '1101', V), /exactly once/);
  rows.set(`${S1}:1101`, { ...row, dueMs: String(NOW - 1) });
  await assert.rejects(desk.payTransaction(S1, '1101', V), /past its due date/);
  rows.set(`${S1}:1101`, { ...row, asset: 'EUDemo' });
  await assert.rejects(desk.payTransaction(S1, '1101', V), /EUDemo/);
});

test('pay_ccd JSON + committed schema serialize to the proven encoder bytes', async () => {
  await initSchemas();
  const b64 = registryParamSchema('pay_ccd');
  assert.ok(b64);
  const got = Buffer.from(serializeTypeValue({ seller: S1, payable_id: 1101 }, Buffer.from(b64, 'base64')).buffer).toString('hex');
  assert.equal(got, encodeV2PayableKey({ seller: S1, id: 1101 }));
});
