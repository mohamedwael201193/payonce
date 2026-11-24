// PayOnce backend — MCP tool tests (node --test).
// LIVE tests against Concordium testnet registry <13149,0>: every
// verify/receipt/list assertion reads real chain state. The pay_payable
// tests are INPUT-VALIDATION ONLY: each case must refuse (throw) before
// any signer is loaded or any transaction is sent — no live payment is
// ever submitted by this file. A stdio smoke test spawns the real server
// and exercises tools/list + a tools/call over MCP.
//
// Proof anchors (test/live-e2e-2026-11-24.json):
//   payable 6 (CCD, Paid) pay tx 828ebd253b02626bb470169bbce114691f16d55d560ed9750df197d1198e875a
//   payable 7 (EUDemo, Paid) transfer 1badea8286a6beb49ff46fbe5c51fed66e3d630fc8a3b206eac9801d0864c04b
//   payable 7 confirm 459734c3a20cc15d503b7ca10b2fed3aec363109813dd95f6347d829890a6068
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import {
  verifyInvoice,
  payPayable,
  getReceipt,
  listPayables,
} from '../src/mcp/server.mjs';

const DOC6 = new URL('./invoices/invoice-006-ccd.txt', import.meta.url).pathname;
const DOC7 = new URL('./invoices/invoice-007-eudemo.txt', import.meta.url).pathname;
const SERVER_PATH = new URL('../src/mcp/server.mjs', import.meta.url).pathname;

const PAY6_TX = '828ebd253b02626bb470169bbce114691f16d55d560ed9750df197d1198e875a';
const TRANSFER7_TX = '1badea8286a6beb49ff46fbe5c51fed66e3d630fc8a3b206eac9801d0864c04b';
const CONFIRM7_TX = '459734c3a20cc15d503b7ca10b2fed3aec363109813dd95f6347d829890a6068';
// Payable-4 pay tx (same payer/payee/amount family as payable 1/6 — the F10 trap).
const PAY4_TX = '78377f18f61f6ef475bc9176240e876ed18d31e461ffbeb43858a4fb17551a6e';

const failedIds = (r) => r.checks.filter((c) => c.status === 'FAIL').map((c) => c.id);

/** Assert a pay_payable call refuses: rejects, names the reason, returns no tx hash. */
async function assertRefusesWithoutSend(promise, reasonPattern) {
  await assert.rejects(promise, (err) => {
    assert.match(err.message, reasonPattern, `expected refusal matching ${reasonPattern}, got: ${err.message}`);
    assert.doesNotMatch(err.message, /[0-9a-f]{64}/, `refusal must not carry a tx hash: ${err.message}`);
    return true;
  });
}

// ---- verify_invoice (live) ----

test('verify_invoice live: payable 6 + pay tx + doc passes 12/12', async () => {
  const r = await verifyInvoice({ payableId: 6, txHash: PAY6_TX, docPath: DOC6 });
  assert.equal(r.allPass, true, JSON.stringify(r.checks.filter((c) => c.status !== 'PASS')));
  assert.equal(r.passed, 12);
  assert.equal(r.failed, 0);
  assert.deepEqual(failedIds(r), []);
  assert.equal(r.asset, 'CCD');
});

test('verify_invoice live: payable 7 + transfer tx + doc passes 15/15', async () => {
  const r = await verifyInvoice({ payableId: 7, txHash: TRANSFER7_TX, docPath: DOC7 });
  assert.equal(r.allPass, true, JSON.stringify(r.checks.filter((c) => c.status !== 'PASS')));
  assert.equal(r.passed, 15);
  assert.equal(r.failed, 0);
  assert.deepEqual(failedIds(r), []);
  assert.equal(r.asset, 'EUDemo');
});

test('verify_invoice negative: payable-4 tx checked against payable 6 FAILS (CCD-04 + CCD-05), no crash', async () => {
  const r = await verifyInvoice({ payableId: 6, txHash: PAY4_TX, docPath: DOC6 });
  assert.equal(r.allPass, false);
  assert.ok(failedIds(r).includes('CCD-04'), `expected CCD-04 in ${failedIds(r)}`);
  assert.ok(failedIds(r).includes('CCD-05'), `expected CCD-05 in ${failedIds(r)}`);
});

test('verify_invoice refuses unknown payable (no crash)', async () => {
  await assert.rejects(verifyInvoice({ payableId: 999, txHash: PAY6_TX }), /unknown payable 999/);
});

test('verify_invoice refuses unknown tx (no crash)', async () => {
  await assert.rejects(verifyInvoice({ payableId: 6, txHash: '0'.repeat(64) }), /unknown tx/);
});

test('verify_invoice refuses doc mismatch (no crash)', async () => {
  await assert.rejects(
    verifyInvoice({ payableId: 6, txHash: PAY6_TX, docPath: DOC7 }),
    /doc mismatch for payable 6/,
  );
});

// ---- receipt (live) ----

test('receipt live: payable 6 is Paid, pay tx + verifier 12/12', async () => {
  const r = await getReceipt({ payableId: 6 });
  assert.equal(r.paid, true);
  assert.equal(r.status, 'Paid');
  assert.equal(r.paymentTxHash, PAY6_TX);
  assert.ok(r.paymentBlockTime);
  assert.equal(r.verifier.allPass, true);
  assert.equal(r.verifier.passed, 12);
});

test('receipt live: payable 7 is Paid, transfer + confirm tx + verifier 15/15', async () => {
  const r = await getReceipt({ payableId: 7 });
  assert.equal(r.paid, true);
  assert.equal(r.status, 'Paid');
  assert.equal(r.transferTxHash, TRANSFER7_TX);
  assert.equal(r.confirmTxHash, CONFIRM7_TX);
  assert.ok(r.transferBlockTime);
  assert.ok(r.confirmBlockTime);
  assert.equal(r.verifier.allPass, true);
  assert.equal(r.verifier.passed, 15);
});

test('receipt: Unpaid payable says "not paid yet"', async () => {
  const r = await getReceipt({ payableId: 3 });
  assert.equal(r.paid, false);
  assert.equal(r.status, 'Unpaid');
  assert.equal(r.message, 'not paid yet');
});

test('receipt refuses unknown payable (no crash)', async () => {
  await assert.rejects(getReceipt({ payableId: 999 }), /unknown payable 999/);
});

// ---- list_payables (live) ----

test('list_payables live 1..11: 1,2,4,6,7,9,10,11 Paid; 3,5,8 Unpaid', async () => {
  const r = await listPayables({ ids: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] });
  assert.equal(r.network, 'testnet');
  const byId = Object.fromEntries(r.payables.map((p) => [p.id, p]));
  assert.equal(byId[1].status, 'Paid');
  assert.equal(byId[2].status, 'Paid');
  assert.equal(byId[3].status, 'Unpaid');
  assert.equal(byId[4].status, 'Paid');
  assert.equal(byId[5].status, 'Unpaid');
  assert.equal(byId[6].status, 'Paid');
  assert.equal(byId[7].status, 'Paid');
  // 8/9 were registered by the x402 E2E run (2026-11-24): 8 is CCD, Unpaid
  // by design (x402 Rail A pays the payee directly, not via pay_ccd);
  // 9 is EUDemo, Paid via reserve -> transfer -> confirm.
  assert.equal(byId[8].status, 'Unpaid');
  assert.equal(byId[8].asset, 'CCD');
  assert.equal(byId[8].amount, '500000');
  assert.equal(byId[9].status, 'Paid');
  assert.equal(byId[9].asset, 'EUDemo');
  assert.equal(byId[9].amount, '10000');
  // 10/11 were registered + paid by the MCP live-pay run (2026-11-24):
  // 10 is CCD 500000, Paid via pay_payable rail ccd (pay 83b11aff...);
  // 11 is EUDemo 10000, Paid via pay_payable rail eudemo (reserve 39312e6d...,
  // transfer 6986b191..., confirm 8464b885...).
  assert.equal(byId[10].status, 'Paid');
  assert.equal(byId[10].asset, 'CCD');
  assert.equal(byId[10].amount, '500000');
  assert.equal(byId[11].status, 'Paid');
  assert.equal(byId[11].asset, 'EUDemo');
  assert.equal(byId[11].amount, '10000');
  assert.equal(byId[6].amount, '500000');
  assert.equal(byId[6].asset, 'CCD');
  assert.equal(byId[7].amount, '10000');
  assert.equal(byId[7].asset, 'EUDemo');
  assert.equal(byId[6].payee, '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg');
});

// ---- pay_payable: input validation ONLY — nothing is ever sent ----

test('pay_payable refuses wrong rail without sending', async () => {
  await assertRefusesWithoutSend(
    payPayable({ payableId: 6, rail: 'eudemo', docPath: DOC6 }),
    /wrong rail "eudemo" for payable 6: payable asset is CCD/,
  );
});

test('pay_payable refuses already-Paid payable without sending', async () => {
  await assertRefusesWithoutSend(
    payPayable({ payableId: 6, rail: 'ccd', docPath: DOC6 }),
    /payable 6 is Paid, not Unpaid/,
  );
});

test('pay_payable refuses nonexistent payable without sending', async () => {
  await assertRefusesWithoutSend(
    payPayable({ payableId: 999, rail: 'ccd', docPath: DOC6 }),
    /unknown payable 999/,
  );
});

test('pay_payable refuses mismatched doc without sending', async () => {
  await assertRefusesWithoutSend(
    payPayable({ payableId: 6, rail: 'ccd', docPath: DOC7 }),
    /doc mismatch for payable 6/,
  );
});

test('pay_payable refuses an invalid rail value without sending', async () => {
  await assertRefusesWithoutSend(
    payPayable({ payableId: 6, rail: 'btc', docPath: DOC6 }),
    /invalid rail "btc"/,
  );
});

test('pay_payable refusals sent nothing: payables 6 and 7 are still Paid, unchanged', async () => {
  const r = await listPayables({ ids: [6, 7] });
  const byId = Object.fromEntries(r.payables.map((p) => [p.id, p]));
  assert.equal(byId[6].status, 'Paid');
  assert.equal(byId[7].status, 'Paid');
});

// ---- stdio smoke test: real server process over MCP ----

test('stdio smoke: server lists all 4 tools and answers list_payables over MCP', async () => {
  // The SDK's StdioClientTransport spawns the server with ONLY
  // HOME/LOGNAME/PATH/SHELL/TERM/USER (getDefaultEnvironment) — it strips
  // the proxy vars (https_proxy, NODE_EXTRA_CA_CERTS, SSL_CERT_FILE) this
  // sandbox needs to reach grpc.testnet.concordium.com. Without them the
  // server's first gRPC call hangs forever (diagnosed via wire log: the
  // tools/call arrived, the handler entered, the invoke never returned).
  // Pass the ambient env through so the server can reach the node.
  const transport = new StdioClientTransport({ command: 'node', args: [SERVER_PATH], env: process.env });
  const client = new Client({ name: 'payonce-test', version: '1.0.0' });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort();
    assert.deepEqual(names, ['list_payables', 'pay_payable', 'receipt', 'verify_invoice']);
    const res = await client.callTool({ name: 'list_payables', arguments: { ids: [6, 7, 8] } });
    assert.equal(res.isError, undefined);
    const parsed = JSON.parse(res.content[0].text);
    const byId = Object.fromEntries(parsed.payables.map((p) => [p.id, p]));
    assert.equal(byId[6].status, 'Paid');
    assert.equal(byId[7].status, 'Paid');
    assert.equal(byId[8].status, 'Unpaid');
  } finally {
    await client.close();
  }
});
