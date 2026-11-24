// PayOnce backend — LIVE x402 flows (testnet only).
// Rail A (CCD, payable 8): B registers -> stock x402 client builds a sponsored
//   CCD transfer to the payee (buyer B, sponsor = facilitator/owner) ->
//   facilitator verify (9 checks + PayOnce binding) -> settle -> the simple
//   transfer is verified against the payable (from/to/amount/due/doc).
//   NOTE: x402 Rail A is a DIRECT transfer to the payee, not the contract's
//   pay_ccd — the contract cannot be called by the x402 facilitator (it only
//   settles simple transfers / tokenUpdates), so payable 8 stays Unpaid
//   on-chain and the contract's pay-once guard does not apply to this rail.
//   The receipt says so honestly.
// Rail B (EUDemo, payable 9): B registers -> co-signer gate reserve ->
//   B reserves -> custom memo'd v1 transfer (memo payable:9) via the
//   facilitator -> co-signer gate confirm -> B confirms -> verifier 15/15.
//   The contract's Paid state DOES apply here (confirm marks it Paid).
// Keys load in-process only; nothing secret is printed.
// Evidence: test/x402-e2e-2026-11-24.json
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { grpcClient, getTxStatus, getBlockTime } from '../src/chain.mjs';
import { getPayable, getPayableOrNull, getRegistryBalance } from '../src/registry.mjs';
import { decodeLoggedEvents } from '../src/events.mjs';
import { verifyPlt } from '../src/verifier/checks.mjs';
import { decide } from '../src/cosigner/decide.mjs';
import { buildSnapshot } from '../src/cosigner/snapshot.mjs';
import { encodeCborMemo } from '../src/chain.mjs';
import {
  loadSigners, nextNonce, sendUpdate, waitFinalized,
  encodeRegisterPayable, encodePayableId, encodeConfirm,
  OWNER_ADDRESS, SELLER_B_ADDRESS, PAYEE2_ADDRESS,
} from '../src/send.mjs';
import { createFacilitator, payonceVerify, payonceSettle, requirementsForPayable } from '../src/facilitator/scheme.mjs';
import { buildCcdPaymentPayload, buildMemoPltPayload } from '../src/facilitator/client.mjs';

const EVIDENCE_PATH = new URL('../test/x402-e2e-2026-11-24.json', import.meta.url).pathname;
const evidence = existsSync(EVIDENCE_PATH)
  ? JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'))
  : { runAt: new Date().toISOString(), network: 'testnet', railA: {}, railB: {} };
evidence.runAt = new Date().toISOString();
evidence.railA ??= {}; evidence.railB ??= {};
const save = () => writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));
const log = (...a) => console.log(...a);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

const client = grpcClient();
const signers = loadSigners();
const facilitator = createFacilitator();
log('facilitator sponsor:', facilitator.sponsorAddress, '| network:', facilitator.network);

const FIXED_DUE_MS = Date.UTC(2026, 11, 26, 12, 0, 0);
const buildInvoice = (title, amountLine, dueMs) => [
  title, `Seller: ${SELLER_B_ADDRESS}`, `Payee: ${PAYEE2_ADDRESS}`, amountLine,
  `Due: ${new Date(dueMs).toISOString()}`,
  'Test only — Concordium testnet, no real goods or services.', '',
].join('\n');
mkdirSync(new URL('../test/invoices/', import.meta.url).pathname, { recursive: true });

const APPROVAL = { tier: 'test', legalRef: null, perPayableCap: '1000000', periodCap: '10000000', periodSecs: 86400 };
const gateBase = {
  agentAccount: SELLER_B_ADDRESS, sponsorAccount: null, signatureThreshold: 1,
  approval: APPROVAL, usage: '0', memoScan: { found: false, txHash: null },
  usedTxHashes: [], agentStatus: 'Active',
};
async function gate(kind, request, extra = {}) {
  const snapshot = await buildSnapshot(client, { payableId: 9, ...gateBase, ...extra });
  const decision = decide(snapshot, request, { unresolved: [] });
  log(`gate ${kind}: ${decision.decision}${decision.code ? ` (${decision.code})` : ''}`);
  if (decision.decision !== 'SIGN') throw new Error(`co-signer gate refused ${kind}: ${decision.code}`);
  return decision;
}

// ================= RAIL A: x402 CCD, payable 8 =================
log('\n=== X402 RAIL A: payable 8 (CCD, direct transfer) ===');
const pre8 = await getPayableOrNull(client, 8);
const dueMs8 = pre8 ? Number(pre8.dueMs) : FIXED_DUE_MS;
const invoice8 = buildInvoice('PAYONCE TEST INVOICE — payable 8 (x402 Rail A, CCD)', 'Amount: 0.5 CCD (500000 microCCD)', dueMs8);
writeFileSync(new URL('../test/invoices/invoice-008-ccd.txt', import.meta.url).pathname, invoice8);
const docHash8 = sha256(Buffer.from(invoice8, 'utf8'));
let reg8Tx = process.env.REGISTER8_TX || null;
if (pre8 && pre8.docHash === docHash8) {
  log('payable 8 already registered (resuming)');
} else {
  const param = encodeRegisterPayable({ payableId: 8, payee: PAYEE2_ADDRESS, amount: 500000, asset: 'CCD', dueMs: dueMs8, docHashHex: docHash8, agentToken: 1 });
  const reg = await sendUpdate(client, { from: signers.sellerB, receiveName: 'register_payable', parameterHex: param });
  const st = await waitFinalized(client, reg.txHash);
  const ev = decodeLoggedEvents((st.summary?.events ?? []).find((e) => e.tag === 'Updated' && e.receiveName === 'payable_registry.register_payable'));
  if (!ev.find((e) => e.event === 'Registered')) throw new Error('register 8: no Registered event');
  reg8Tx = reg.txHash;
  log('register payable 8 tx:', reg8Tx);
}
evidence.railA.registerTx = reg8Tx;
save();

const view8 = await getPayable(client, 8);
if (view8.docHash !== docHash8 || view8.amount !== '500000') throw new Error('payable 8 row mismatch');
const req8 = requirementsForPayable(view8, { maxTimeoutSeconds: 300 });
log('requirements:', JSON.stringify({ ...req8, extra: { feePayer: req8.extra.feePayer.slice(0, 8) + '…', payableId: 8 } }));
// Resume: a previous run already settled Rail A (the direct transfer does
// not change the payable row, so re-running would pay the payee again).
let settle8 = null;
if (evidence.railA.settleTx) {
  log('Rail A already settled (resuming); tx:', evidence.railA.settleTx);
  settle8 = { transaction: evidence.railA.settleTx, payer: SELLER_B_ADDRESS };
} else {
  // Buyer = B (seller in the lab setup); sponsor = facilitator (owner).
  const payload8 = await buildCcdPaymentPayload({ buyer: signers.sellerB, requirements: req8 });
  const verify8 = await payonceVerify(facilitator, payload8, req8, { payableId: 8, expectedStatus: 'Unpaid' });
  log('facilitator verify Rail A:', verify8.isValid ? 'VALID' : `INVALID: ${verify8.invalidReason}`);
  for (const c of verify8.payonce?.checks ?? []) log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name} — ${c.detail}`);
  if (!verify8.isValid) throw new Error(`Rail A facilitator verify failed: ${verify8.invalidReason}`);
  settle8 = await payonceSettle(facilitator, payload8, req8, { payableId: 8, expectedStatus: 'Unpaid' });
  if (!settle8.success) throw new Error(`Rail A settle failed: ${settle8.errorReason} ${settle8.errorMessage ?? ''}`);
  evidence.railA.verify = verify8.payonce;
}
log('Rail A settled tx:', settle8.transaction, '| payer:', settle8.payer);
evidence.railA.settleTx = settle8.transaction;
save();
// Verify the simple transfer against the payable (direct-transfer checks).
const st8 = await getTxStatus(client, settle8.transaction);
const bt8 = await getBlockTime(client, st8.blockHash);
// A simple transfer's summary carries `transfer: {tag:'Transferred', amount, to}`
// (not an events array) plus `sender` and `sponsor: {cost, sponsor}`.
const transferred = st8.summary?.transfer ?? {};
const railAChecks = [
  { id: 'X402-A1', name: 'tx-finalized', ok: st8.status === 'finalized', detail: `status=${st8.status}` },
  { id: 'X402-A2', name: 'transfer-to-is-payee', ok: transferred.to === PAYEE2_ADDRESS, detail: `to=${transferred.to}` },
  { id: 'X402-A3', name: 'transfer-amount-is-stored', ok: String(transferred.amount) === '500000', detail: `amount=${transferred.amount}` },
  { id: 'X402-A4', name: 'transfer-from-is-buyer', ok: st8.summary?.sender === SELLER_B_ADDRESS, detail: `from=${st8.summary?.sender}` },
  { id: 'X402-A5', name: 'transfer-before-due', ok: new Date(bt8.slotTime).getTime() <= dueMs8, detail: `block=${bt8.slotTime} due=${new Date(dueMs8).toISOString()}` },
  { id: 'X402-A6', name: 'doc-hash-matches', ok: sha256(Buffer.from(invoice8, 'utf8')) === view8.docHash, detail: `doc=${docHash8.slice(0, 16)}…` },
  { id: 'X402-A7', name: 'contract-payable-stays-unpaid', ok: view8.status === 'Unpaid', detail: 'x402 direct transfer does not call pay_ccd — documented, not hidden' },
  { id: 'X402-A8', name: 'sponsor-paid-the-fee', ok: st8.summary?.sponsor?.sponsor === OWNER_ADDRESS && BigInt(st8.summary?.sponsor?.cost ?? 0) > 0n && String(st8.summary?.cost) === '0', detail: `sponsor=${st8.summary?.sponsor?.sponsor?.slice(0, 8)}… cost=${st8.summary?.sponsor?.cost} senderCost=${st8.summary?.cost}` },
];
for (const c of railAChecks) log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.id} ${c.name} — ${c.detail}`);
if (!railAChecks.every((c) => c.ok)) throw new Error('Rail A transfer verification failed');
evidence.railA.checks = railAChecks;
evidence.railA.blockTime = bt8;
save();
log('RAIL A VERDICT: 8/8 transfer checks passed (direct transfer; contract guard N/A by design).');

// ================= RAIL B: x402 EUDemo, payable 9 =================
log('\n=== X402 RAIL B: payable 9 (EUDemo, memo via facilitator) ===');
const pre9 = await getPayableOrNull(client, 9);
const dueMs9 = pre9 ? Number(pre9.dueMs) : FIXED_DUE_MS;
const invoice9 = buildInvoice('PAYONCE TEST INVOICE — payable 9 (x402 Rail B, EUDemo)', 'Amount: 0.01 EUDemo (10000 base units, 6 decimals)', dueMs9);
writeFileSync(new URL('../test/invoices/invoice-009-eudemo.txt', import.meta.url).pathname, invoice9);
const docHash9 = sha256(Buffer.from(invoice9, 'utf8'));
let reg9Tx = process.env.REGISTER9_TX || null;
if (pre9 && pre9.docHash === docHash9) {
  log('payable 9 already registered (resuming)');
} else {
  const param = encodeRegisterPayable({ payableId: 9, payee: PAYEE2_ADDRESS, amount: 10000, asset: 'EUDemo', dueMs: dueMs9, docHashHex: docHash9, agentToken: 1 });
  const reg = await sendUpdate(client, { from: signers.sellerB, receiveName: 'register_payable', parameterHex: param });
  const st = await waitFinalized(client, reg.txHash);
  const ev = decodeLoggedEvents((st.summary?.events ?? []).find((e) => e.tag === 'Updated' && e.receiveName === 'payable_registry.register_payable'));
  if (!ev.find((e) => e.event === 'Registered')) throw new Error('register 9: no Registered event');
  reg9Tx = reg.txHash;
  log('register payable 9 tx:', reg9Tx);
}
evidence.railB.registerTx = reg9Tx;
save();
const view9 = await getPayable(client, 9);
if (view9.docHash !== docHash9 || view9.amount !== '10000') throw new Error('payable 9 row mismatch');

// Resume: if payable 9 is already Paid, skip reserve/transfer/confirm and
// verify from the recorded tx hashes.
let settle9 = null;
let res9Tx = evidence.railB.reserveTx || process.env.RESERVE9_TX || null;
let confStatus = null;
let confTx = evidence.railB.confirmTx || process.env.CONFIRM9_TX || null;
if (view9.status === 'Paid' && evidence.railB.transferTx && confTx) {
  log('payable 9 already Paid (resuming); transfer:', evidence.railB.transferTx, '| confirm:', confTx);
  settle9 = { transaction: evidence.railB.transferTx, payer: SELLER_B_ADDRESS };
  confStatus = await getTxStatus(client, confTx);
} else {
// Reserve (co-signer gate), resume-aware.
const view9Now = await getPayable(client, 9);
let reserved = null;
if (view9Now.status === 'Reserved' && Number(view9Now.record.expiresMs) > Date.now() + 60_000) {
  log(`payable 9 already Reserved (resuming); expires ${view9Now.record.expires}`);
  reserved = { expiresMs: view9Now.record.expiresMs };
} else {
  if (view9Now.status === 'Reserved') {
    const exp = await sendUpdate(client, { from: signers.sellerB, receiveName: 'expire_reservation', parameterHex: encodePayableId(9) });
    await waitFinalized(client, exp.txHash);
    log('expire_reservation tx:', exp.txHash);
  }
  const reserveNonce = await nextNonce(client, SELLER_B_ADDRESS);
  const d = await gate('reserve_plt', { kind: 'reserve_plt', sender: SELLER_B_ADDRESS, nonce: reserveNonce, txVersion: 1, sponsor: null, numSignatures: 1 });
  evidence.railB.gateReserve = d;
  const res = await sendUpdate(client, { from: signers.sellerB, receiveName: 'reserve_plt', parameterHex: encodePayableId(9) });
  const st = await waitFinalized(client, res.txHash);
  reserved = decodeLoggedEvents((st.summary?.events ?? []).find((e) => e.tag === 'Updated' && e.receiveName === 'payable_registry.reserve_plt')).find((e) => e.event === 'Reserved');
  if (!reserved) throw new Error('reserve 9: no Reserved event');
  res9Tx = res.txHash;
  log('reserve payable 9 tx:', res9Tx, '| expires:', reserved.expires);
  evidence.railB.reserveTx = res9Tx;
  evidence.railB.expiresMs = reserved.expiresMs;
  save();
}
const expiresMs = Number(reserved.expiresMs);
const headerExpirySeconds = Math.floor((expiresMs - 60_000) / 1000);

// x402 transfer with memo payable:9 (custom builder — stock client has no memo).
const req9 = requirementsForPayable(await getPayable(client, 9), { maxTimeoutSeconds: 300 });
const payload9 = await buildMemoPltPayload({
  grpc: client, sender: signers.sellerB, sponsorAddress: OWNER_ADDRESS,
  recipient: PAYEE2_ADDRESS, amount: 10000, tokenId: 'EUDemo',
  memo: 'payable:9', expirySeconds: headerExpirySeconds,
});
const verify9 = await payonceVerify(facilitator, payload9, req9, { payableId: 9, expectedStatus: 'Reserved' });
log('facilitator verify Rail B:', verify9.isValid ? 'VALID' : `INVALID: ${verify9.invalidReason}`);
for (const c of verify9.payonce?.checks ?? []) log(`  [${c.ok ? 'PASS' : 'FAIL'}] ${c.name} — ${c.detail}`);
if (!verify9.isValid) throw new Error(`Rail B facilitator verify failed: ${verify9.invalidReason}`);
settle9 = await payonceSettle(facilitator, payload9, req9, { payableId: 9, expectedStatus: 'Reserved' });
if (!settle9.success) throw new Error(`Rail B settle failed: ${settle9.errorReason} ${settle9.errorMessage ?? ''}`);
log('Rail B settled tx:', settle9.transaction, '| payer:', settle9.payer);
evidence.railB.transferTx = settle9.transaction;
evidence.railB.verify = verify9.payonce;
save();

// Confirm (co-signer gate, transfer verified from chain).
const confirmNonce = await nextNonce(client, SELLER_B_ADDRESS);
const confirmDecision = await gate('confirm', {
  kind: 'confirm', sender: SELLER_B_ADDRESS, nonce: confirmNonce,
  txVersion: 1, sponsor: null, txHash: settle9.transaction,
}, { transferTxHash: settle9.transaction, reserveTxHash: res9Tx });
evidence.railB.gateConfirm = confirmDecision;
save();
const conf = await sendUpdate(client, {
  from: signers.sellerB, receiveName: 'confirm_plt',
  parameterHex: encodeConfirm({ payableId: 9, txHashHex: settle9.transaction }),
});
confStatus = await waitFinalized(client, conf.txHash);
const confirmed = decodeLoggedEvents((confStatus.summary?.events ?? []).find((e) => e.tag === 'Updated' && e.receiveName === 'payable_registry.confirm_plt')).find((e) => e.event === 'PltConfirmed');
if (!confirmed) throw new Error('confirm 9: no PltConfirmed event');
log('confirm payable 9 tx:', conf.txHash);
confTx = conf.txHash;
evidence.railB.confirmTx = confTx;
save();
} // end resume-else for Rail B

// Verify PLT 15/15 live.
const trStatus = await getTxStatus(client, settle9.transaction);
const trBlockTime = await getBlockTime(client, trStatus.blockHash);
const confBlockTime = await getBlockTime(client, confStatus.blockHash);
const view9After = await getPayable(client, 9);
const balance = await getRegistryBalance(client);
const resStatus = res9Tx ? await getTxStatus(client, res9Tx) : null;
const resBlockTime = resStatus ? await getBlockTime(client, resStatus.blockHash) : null;
const reserve = resStatus ? {
  blockTime: resBlockTime,
  logged: decodeLoggedEvents((resStatus.summary?.events ?? []).find((e) => e.tag === 'Updated' && e.receiveName === 'payable_registry.reserve_plt')),
} : null;
const confirm = { blockTime: confBlockTime, logged: decodeLoggedEvents((confStatus.summary?.events ?? []).find((e) => e.tag === 'Updated' && e.receiveName === 'payable_registry.confirm_plt')) };
const pltResult = verifyPlt({
  payableId: 9, txHash: settle9.transaction, summary: trStatus,
  blockTime: trBlockTime, view: view9After, balance,
  docBytes: Buffer.from(invoice9, 'utf8'), reserve, confirm,
});
for (const c of pltResult.checks) log(`  [${c.status}] PLT ${c.id} ${c.name} — ${c.detail}`);
log(`RAIL B VERDICT: ${pltResult.passed}/${pltResult.passed + pltResult.failed} passed, allPass=${pltResult.allPass}`);
evidence.railB.verifyPlt = pltResult;
save();
if (!pltResult.allPass) throw new Error('Rail B verification failed');

log('\nX402 E2E COMPLETE — Rail A 8/8 direct-transfer checks, Rail B 15/15.');
log('Evidence:', EVIDENCE_PATH);
