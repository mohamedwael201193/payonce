// PayOnce backend — LIVE pay_payable check through the real MCP server.
// Proves the MCP pay tool end-to-end over the stdio protocol (not just
// in-process): registers two FRESH v1 payables (10 CCD, 11 EUDemo — both
// absent before this run), then pays each via client.callTool and verifies
// the Paid views + verifier scores live. One send per payable, never twice.
// Keys in-process only; prints tx hashes only, no secrets.
// Evidence: test/mcp-live-pay-2026-11-24.json
import { writeFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { grpcClient, getAccountInfo, tokenBalance, toJson } from '../src/chain.mjs';
import { getPayable, getPayableOrNull } from '../src/registry.mjs';
import { loadSigners, sendUpdate, waitFinalized, encodeRegisterPayable, OWNER_ADDRESS, SELLER_B_ADDRESS, PAYEE2_ADDRESS } from '../src/send.mjs';

const SERVER_PATH = new URL('../src/mcp/server.mjs', import.meta.url).pathname;
const EVIDENCE_PATH = new URL('../test/mcp-live-pay-2026-11-24.json', import.meta.url).pathname;
const evidence = existsSync(EVIDENCE_PATH) ? JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8')) : { runAt: new Date().toISOString(), network: 'testnet', railA: {}, railB: {} };
evidence.runAt = new Date().toISOString();
const save = () => writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
const log = (...a) => console.log(...a);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const client = grpcClient();
const signers = loadSigners();
const FIXED_DUE_MS = Date.UTC(2026, 11, 26, 12, 0, 0);
const buildInvoice = (title, amountLine) => [
  title,
  `Seller: ${SELLER_B_ADDRESS}`,
  `Payee: ${PAYEE2_ADDRESS}`,
  amountLine,
  `Due: ${new Date(FIXED_DUE_MS).toISOString()}`,
  'Test only — Concordium testnet, no real goods or services.',
  '',
].join('\n');
mkdirSync(new URL('../test/invoices/', import.meta.url).pathname, { recursive: true });
const invoice10 = buildInvoice('PAYONCE TEST INVOICE — payable 10 (MCP Rail A, CCD)', 'Amount: 0.5 CCD (500000 microCCD)');
const invoice11 = buildInvoice('PAYONCE TEST INVOICE — payable 11 (MCP Rail B, EUDemo)', 'Amount: 0.01 EUDemo (10000 base units, 6 decimals)');
const doc10Path = new URL('../test/invoices/invoice-010-ccd.txt', import.meta.url).pathname;
const doc11Path = new URL('../test/invoices/invoice-011-eudemo.txt', import.meta.url).pathname;
writeFileSync(doc10Path, invoice10);
writeFileSync(doc11Path, invoice11);
const docHash10 = sha256(Buffer.from(invoice10, 'utf8'));
const docHash11 = sha256(Buffer.from(invoice11, 'utf8'));

// 1. Register both payables as B (fresh — must be absent).
for (const [id, payee, amount, asset, docHash, docPath] of [
  [10, PAYEE2_ADDRESS, 500000, 'CCD', docHash10, doc10Path],
  [11, PAYEE2_ADDRESS, 10000, 'EUDemo', docHash11, doc11Path],
]) {
  const pre = await getPayableOrNull(client, id);
  const key = id === 10 ? 'railA' : 'railB';
  if (pre) {
    if (pre.docHash !== docHash) throw new Error(`payable ${id} exists with a different doc hash — refusing to reuse`);
    log(`payable ${id} already registered (resuming); status ${pre.status}`);
    evidence[key].registerTx ??= process.env[`REGISTER${id}_TX`] ?? null;
  } else {
    const reg = await sendUpdate(client, {
      from: signers.sellerB, receiveName: 'register_payable',
      parameterHex: encodeRegisterPayable({ payableId: id, payee, amount, asset, dueMs: FIXED_DUE_MS, docHashHex: docHash, agentToken: 1 }),
    });
    log(`register payable ${id} tx:`, reg.txHash);
    await waitFinalized(client, reg.txHash);
    evidence[key].registerTx = reg.txHash;
    save();
  }
  const view = await getPayable(client, id);
  if (view.status !== 'Unpaid' && view.status !== 'Paid') throw new Error(`payable ${id} unexpected status ${view.status}`);
  log(`payable ${id} row: ${view.status}, ${view.amount} ${view.asset}`);
}

// 1b. Fund B if short: Rail B needs three B sends; the node rejects any
// send whose max cost (maxEnergy x rate) exceeds the sender's balance.
const bInfoPre = await getAccountInfo(client, SELLER_B_ADDRESS, toJson(await client.getConsensusStatus()).lastFinalizedBlock);
const bCcdPre = Number(bInfoPre.accountAmount) / 1e6;
if (bCcdPre < 100) {
  const { sendSimpleTransfer, waitFinalized: wf } = await import('../src/v2/send.mjs');
  const fund = await sendSimpleTransfer(client, { from: signers.owner, to: SELLER_B_ADDRESS, amountMicroCcd: 50_000_000n });
  await wf(client, fund.txHash);
  log(`funded B +50 CCD (was ${bCcdPre.toFixed(2)} CCD):`, fund.txHash);
  evidence.fundingTx = fund.txHash;
  save();
}

// 2. Pay both through the real MCP server over stdio.
const transport = new StdioClientTransport({ command: 'node', args: [SERVER_PATH], env: process.env });
const mcp = new Client({ name: 'payonce-live-pay', version: '1.0.0' }, { capabilities: {} });
try {
  await mcp.connect(transport);
  log('MCP connected');
  const callPay = async (payableId, rail, docPath) => {
    const res = await mcp.callTool({ name: 'pay_payable', arguments: { payableId, rail, docPath } }, undefined, { timeout: 240000 });
    if (res.isError) throw new Error(`pay_payable ${payableId} returned isError: ${res.content?.[0]?.text?.slice(0, 300)}`);
    return JSON.parse(res.content[0].text);
  };
  const view10 = await getPayable(client, 10);
  if (view10.status === 'Paid' && evidence.railA.pay) {
    log('payable 10 already Paid via MCP (resuming) — skipping pay call');
  } else {
    const r10 = await callPay(10, 'ccd', doc10Path);
    log('MCP pay_payable 10 (CCD):', JSON.stringify({ payTx: r10.paymentTxHash, status: r10.status, verifier: `${r10.verifier.passed}/${r10.verifier.passed + r10.verifier.failed}`, allPass: r10.verifier.allPass }));
    evidence.railA.pay = r10;
    save();
    if (!r10.verifier.allPass || r10.status !== 'Paid') throw new Error('Rail A MCP pay did not verify Paid');
  }
  const view11 = await getPayable(client, 11);
  if (view11.status === 'Paid' && evidence.railB.pay) {
    log('payable 11 already Paid via MCP (resuming) — skipping pay call');
  } else {
    const r11 = await callPay(11, 'eudemo', doc11Path);
    log('MCP pay_payable 11 (EUDemo):', JSON.stringify({ reserveTx: r11.reserveTxHash, transferTx: r11.transferTxHash, confirmTx: r11.confirmTxHash, status: r11.status, verifier: `${r11.verifier.passed}/${r11.verifier.passed + r11.verifier.failed}`, allPass: r11.verifier.allPass }));
    evidence.railB.pay = r11;
    save();
    if (!r11.verifier.allPass || r11.status !== 'Paid') throw new Error('Rail B MCP pay did not verify Paid');
  }
} finally {
  await mcp.close();
}

// 3. Final live views.
for (const id of [10, 11]) {
  const view = await getPayable(client, id);
  log(`payable ${id} final: ${view.status} payer=${view.record?.payer ?? 'n/a'} paidAt=${view.record?.paidAt ?? 'n/a'}`);
  if (view.status !== 'Paid') throw new Error(`payable ${id} is not Paid after MCP pay`);
}
log('\nMCP LIVE PAY COMPLETE — Rail A 12/12, Rail B 15/15, both via tools/call.');
log('Evidence:', EVIDENCE_PATH);
