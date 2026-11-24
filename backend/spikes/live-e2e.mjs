// PayOnce backend — LIVE end-to-end (testnet only).
// Rail A: B registers CCD payable 6 -> owner pays via pay_ccd -> verifier 12/12.
// Rail B: B registers EUDemo payable 7 -> B reserves (co-signer gate) ->
//         B transfers EUDemo with memo payable:7 (gate) -> B confirms (gate) ->
//         verifier 15/15.
// Keys are loaded in-process only (see src/send.mjs); this script prints
// NOTHING secret — only tx hashes, decisions and verifier results.
// Evidence is written incrementally to test/live-e2e-2026-11-24.json so a
// mid-run failure still leaves the completed steps on disk.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { grpcClient, getTxStatus, getBlockTime } from '../src/chain.mjs';
import { getPayable, getPayableOrNull, getRegistryBalance } from '../src/registry.mjs';
import { decodeLoggedEvents } from '../src/events.mjs';
import { verifyCcd, verifyPlt } from '../src/verifier/checks.mjs';
import { decide } from '../src/cosigner/decide.mjs';
import { buildSnapshot } from '../src/cosigner/snapshot.mjs';
import { encodeCborMemo } from '../src/chain.mjs';
import {
  loadSigners, nextNonce, sendUpdate, sendTokenTransfer, waitFinalized,
  encodeRegisterPayable, encodePayableId, encodeConfirm,
  OWNER_ADDRESS, SELLER_B_ADDRESS, PAYEE2_ADDRESS,
} from '../src/send.mjs';

const EVIDENCE_PATH = new URL('../test/live-e2e-2026-11-24.json', import.meta.url).pathname;
// Resume: keep a previous run's completed steps (its tx hashes are the only
// record of the CCD pay tx — the v1 Paid record stores no tx hash).
const evidence = existsSync(EVIDENCE_PATH)
  ? JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'))
  : { runAt: new Date().toISOString(), network: 'testnet', railA: {}, railB: {}, gates: {} };
evidence.runAt = new Date().toISOString();
evidence.railA ??= {}; evidence.railB ??= {}; evidence.gates ??= {};
const save = () => writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));

const log = (...a) => console.log(...a);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function updatedEvent(status, receiveName) {
  return (status.summary?.events ?? []).find(
    (e) => e.tag === 'Updated' && e.receiveName === receiveName,
  );
}
function hasLoggedEvent(status, receiveName, eventName) {
  const upd = updatedEvent(status, receiveName);
  if (!upd) return null;
  const logged = decodeLoggedEvents(upd);
  return logged.find((e) => e.event === eventName) ?? null;
}
function requireEvent(status, receiveName, eventName, label) {
  const ev = hasLoggedEvent(status, receiveName, eventName);
  if (!ev) throw new Error(`${label}: expected ${eventName} event in ${receiveName}, got status=${status.status} result=${JSON.stringify(status.summary?.result ?? null)}`);
  return ev;
}

const client = grpcClient();
const signers = loadSigners();

// ---- Test invoice documents (real files, hashed on chain) ----
// The due date is FIXED (2026-11-26T12:00:00Z) so a re-run reproduces the
// same invoice bytes and doc hash. When resuming an already-registered
// payable, the invoice is rebuilt from the stored view's dueMs instead,
// so the hash matches the on-chain doc_hash.
const FIXED_DUE_MS = Date.UTC(2026, 11, 26, 12, 0, 0);
const buildInvoice = (title, amountLine, dueMs) => [
  title,
  `Seller: ${SELLER_B_ADDRESS}`,
  `Payee: ${PAYEE2_ADDRESS}`,
  amountLine,
  `Due: ${new Date(dueMs).toISOString()}`,
  'Test only — Concordium testnet, no real goods or services.',
  '',
].join('\n');
mkdirSync(new URL('../test/invoices/', import.meta.url).pathname, { recursive: true });
const pre6 = await getPayableOrNull(client, 6);
const pre7 = await getPayableOrNull(client, 7);
const dueMs6 = pre6 ? Number(pre6.dueMs) : FIXED_DUE_MS;
const dueMs7 = pre7 ? Number(pre7.dueMs) : FIXED_DUE_MS;
const invoice6 = buildInvoice('PAYONCE TEST INVOICE — payable 6 (Rail A, CCD)', 'Amount: 0.5 CCD (500000 microCCD)', dueMs6);
const invoice7 = buildInvoice('PAYONCE TEST INVOICE — payable 7 (Rail B, EUDemo)', 'Amount: 0.01 EUDemo (10000 base units, 6 decimals)', dueMs7);
writeFileSync(new URL('../test/invoices/invoice-006-ccd.txt', import.meta.url).pathname, invoice6);
writeFileSync(new URL('../test/invoices/invoice-007-eudemo.txt', import.meta.url).pathname, invoice7);
const docHash6 = sha256(Buffer.from(invoice6, 'utf8'));
const docHash7 = sha256(Buffer.from(invoice7, 'utf8'));
log('docHash6:', docHash6.slice(0, 16) + '…', pre6 ? `(resuming, due ${new Date(dueMs6).toISOString()})` : '(fresh)');
log('docHash7:', docHash7.slice(0, 16) + '…', pre7 ? `(resuming, due ${new Date(dueMs7).toISOString()})` : '(fresh)');

// Test approval policy for the co-signer gates (TEST VALUES, not owner decisions).
const APPROVAL = { tier: 'test', legalRef: null, perPayableCap: '1000000', periodCap: '10000000', periodSecs: 86400 };

// ================= RAIL A =================
log('\n=== RAIL A: payable 6 (CCD) ===');
// 1. Register as B (seller). B is a proven Active agent (registered 1-5).
const reg6Param = encodeRegisterPayable({
  payableId: 6, payee: PAYEE2_ADDRESS, amount: 500000, asset: 'CCD',
  dueMs: dueMs6, docHashHex: docHash6, agentToken: 1,
});
const view6pre = pre6;
let reg6Tx = process.env.REGISTER6_TX || null;
if (view6pre && view6pre.docHash === docHash6) {
  log('payable 6 already registered (resuming); register tx:', reg6Tx ?? 'unknown-pre-existing');
} else {
  const reg6 = await sendUpdate(client, { from: signers.sellerB, receiveName: 'register_payable', parameterHex: reg6Param });
  log('register payable 6 tx:', reg6.txHash);
  const reg6Status = await waitFinalized(client, reg6.txHash);
  requireEvent(reg6Status, 'payable_registry.register_payable', 'Registered', 'register 6');
  reg6Tx = reg6.txHash;
  evidence.railA.registerBlock = reg6Status.blockHash;
}
evidence.railA.registerTx = reg6Tx;
save();

const view6 = await getPayable(client, 6);
if ((view6.status !== 'Unpaid' && view6.status !== 'Paid') || view6.amount !== '500000' || view6.docHash !== docHash6) {
  throw new Error(`payable 6 row mismatch: ${JSON.stringify(view6)}`);
}
log(`payable 6 row: ${view6.status}, 500000 microCCD, doc hash matches.`);

// 2. Owner pays via pay_ccd (payer != seller). Resume-safe: if already Paid,
// reuse the pay tx hash — from the Paid record (PLT only) or, for CCD, from
// the previous run's evidence file (the v1 Paid record stores no tx hash).
let pay6Tx = null;
let pay6Status = null;
let paid6 = null;
if (view6.status === 'Paid') {
  pay6Tx = view6.record?.txHash || evidence.railA.payTx || process.env.PAY6_TX || null;
  if (!pay6Tx) throw new Error('payable 6 is Paid but no pay tx hash is known (evidence file / PAY6_TX)');
  log('payable 6 already Paid (resuming); pay tx:', pay6Tx);
  pay6Status = await getTxStatus(client, pay6Tx);
  paid6 = hasLoggedEvent(pay6Status, 'payable_registry.pay_ccd', 'Paid');
} else {
  const pay6 = await sendUpdate(client, {
    from: signers.owner, receiveName: 'pay_ccd',
    parameterHex: encodePayableId(6), amountMicroCcd: 500000n,
  });
  log('pay_ccd payable 6 tx:', pay6.txHash);
  pay6Status = await waitFinalized(client, pay6.txHash);
  paid6 = requireEvent(pay6Status, 'payable_registry.pay_ccd', 'Paid', 'pay_ccd 6');
  log('Paid event:', JSON.stringify(paid6));
  pay6Tx = pay6.txHash;
}
evidence.railA.payTx = pay6Tx;
evidence.railA.payBlock = pay6Status.blockHash;
save();

// 3. Verify (live, with the invoice document).
const pay6BlockTime = await getBlockTime(client, pay6Status.blockHash);
const view6After = await getPayable(client, 6);
const balance = await getRegistryBalance(client);
const ccdResult = verifyCcd({
  payableId: 6, txHash: pay6Tx, summary: pay6Status,
  blockTime: pay6BlockTime, view: view6After, balance,
  docBytes: Buffer.from(invoice6, 'utf8'),
});
for (const c of ccdResult.checks) log(`  [${c.status}] CCD ${c.id} ${c.name} — ${c.detail}`);
log(`RAIL A VERDICT: ${ccdResult.passed}/${ccdResult.passed + ccdResult.failed} passed, allPass=${ccdResult.allPass}`);
evidence.railA.verify = ccdResult;
save();
if (!ccdResult.allPass) throw new Error('Rail A verification failed');

// ================= RAIL B =================
log('\n=== RAIL B: payable 7 (EUDemo) ===');
// 1. Register as B.
const reg7Param = encodeRegisterPayable({
  payableId: 7, payee: PAYEE2_ADDRESS, amount: 10000, asset: 'EUDemo',
  dueMs: dueMs7, docHashHex: docHash7, agentToken: 1,
});
const view7pre = pre7;
let reg7Tx = process.env.REGISTER7_TX || null;
if (view7pre && view7pre.docHash === docHash7) {
  log('payable 7 already registered (resuming); register tx:', reg7Tx ?? 'unknown-pre-existing');
} else {
  const reg7 = await sendUpdate(client, { from: signers.sellerB, receiveName: 'register_payable', parameterHex: reg7Param });
  log('register payable 7 tx:', reg7.txHash);
  const reg7Status = await waitFinalized(client, reg7.txHash);
  requireEvent(reg7Status, 'payable_registry.register_payable', 'Registered', 'register 7');
  reg7Tx = reg7.txHash;
  evidence.railB.registerBlock = reg7Status.blockHash;
}
evidence.railB.registerTx = reg7Tx;
save();

const view7 = await getPayable(client, 7);
if ((view7.status !== 'Unpaid' && view7.status !== 'Reserved' && view7.status !== 'Paid') || view7.amount !== '10000' || view7.docHash !== docHash7) {
  throw new Error(`payable 7 row mismatch: ${JSON.stringify(view7)}`);
}
log(`payable 7 row: ${view7.status}, 10000 base units, doc hash matches.`);

// Co-signer gate helper. Agent = B (proven Active by the register — the
// register does the CIS-8004 agentOf cross-call). B is 1-of-1, so
// signatureThreshold 1. No sponsor in this live run (B pays its own fees).
const gateBase = {
  agentAccount: SELLER_B_ADDRESS, sponsorAccount: null, signatureThreshold: 1,
  approval: APPROVAL, usage: '0', memoScan: { found: false, txHash: null },
  usedTxHashes: [], agentStatus: 'Active',
};
async function gate(kind, request, extra = {}) {
  const snapshot = await buildSnapshot(client, {
    payableId: 7, ...gateBase, ...extra,
  });
  const decision = decide(snapshot, request, { unresolved: [] });
  log(`gate ${kind}: ${decision.decision}${decision.code ? ` (${decision.code})` : ''}${decision.reasons[0] ? ` — ${decision.reasons[0]}` : ''}`);
  if (decision.decision !== 'SIGN') throw new Error(`co-signer gate refused ${kind}: ${decision.code}`);
  return decision;
}

// 2-3. Co-signer gate + reserve. Resume-aware: if a live reservation already
// exists (status Reserved, expires > now + 60s), reuse it; if it expired,
// expire it on-chain first, then reserve fresh.
const view7Now = await getPayable(client, 7);
let res7Tx = evidence.railB.reserveTx || process.env.RESERVE7_TX || null;
let res7Status = null;
let reserved = null;
const nowMs = Date.now();
if (view7Now.status === 'Reserved' && Number(view7Now.record.expiresMs) > nowMs + 60_000) {
  log(`payable 7 already Reserved (resuming); expires ${view7Now.record.expires}`);
  reserved = { expiresMs: view7Now.record.expiresMs };
  if (res7Tx) res7Status = await getTxStatus(client, res7Tx);
} else {
  if (view7Now.status === 'Reserved') {
    log('reservation expired — expiring it on-chain first');
    const exp7 = await sendUpdate(client, {
      from: signers.sellerB, receiveName: 'expire_reservation', parameterHex: encodePayableId(7),
    });
    const exp7Status = await waitFinalized(client, exp7.txHash);
    log('expire_reservation tx:', exp7.txHash);
    evidence.railB.expireTx = exp7.txHash;
    save();
  }
  const reserveNonce = await nextNonce(client, SELLER_B_ADDRESS);
  const reserveDecision = await gate('reserve_plt', {
    kind: 'reserve_plt', sender: SELLER_B_ADDRESS, nonce: reserveNonce,
    txVersion: 1, sponsor: null, numSignatures: 1,
  });
  evidence.gates.reserve = reserveDecision;
  save();
  const res7 = await sendUpdate(client, {
    from: signers.sellerB, receiveName: 'reserve_plt', parameterHex: encodePayableId(7),
  });
  log('reserve payable 7 tx:', res7.txHash);
  res7Status = await waitFinalized(client, res7.txHash);
  reserved = requireEvent(res7Status, 'payable_registry.reserve_plt', 'Reserved', 'reserve 7');
  log('Reserved event:', JSON.stringify(reserved));
  res7Tx = res7.txHash;
  evidence.railB.reserveTx = res7Tx;
  evidence.railB.reserveBlock = res7Status.blockHash;
  evidence.railB.expiresMs = reserved.expiresMs;
  save();
}

// The Reserved view layout is validated here for the first time (it was
// unconfirmed before this run: no live Reserved payable existed in v1).
const view7Reserved = await getPayable(client, 7);
if (view7Reserved.status !== 'Reserved' || view7Reserved.record?.payer !== SELLER_B_ADDRESS) {
  throw new Error(`payable 7 Reserved row mismatch: ${JSON.stringify(view7Reserved)}`);
}
log(`payable 7 row: Reserved by B, expires ${view7Reserved.record.expires}. (Reserved view layout VALIDATED live.)`);
const expiresMs = Number(reserved.expiresMs);
const headerExpirySeconds = Math.floor((expiresMs - 60_000) / 1000);

// 4. Co-signer gate: transfer.
const transferNonce = await nextNonce(client, SELLER_B_ADDRESS);
const transferDecision = await gate('transfer', {
  kind: 'transfer', sender: SELLER_B_ADDRESS, nonce: transferNonce,
  txVersion: 1, sponsor: null, recipient: PAYEE2_ADDRESS, amount: '10000',
  token: 'EUDemo', memo: encodeCborMemo('payable:7').toString('hex'),
  headerExpirySeconds, operations: 1,
});
evidence.gates.transfer = transferDecision;
save();

// 5. Transfer EUDemo B -> payee2 with memo payable:7.
const tr7 = await sendTokenTransfer(client, {
  from: signers.sellerB, recipient: PAYEE2_ADDRESS, amount: 10000,
  memo: 'payable:7', expirySeconds: headerExpirySeconds,
});
log('EUDemo transfer payable 7 tx:', tr7.txHash);
const tr7Status = await waitFinalized(client, tr7.txHash);
const tr7BlockTime = await getBlockTime(client, tr7Status.blockHash);
const transferEvent = (tr7Status.summary?.events ?? []).find((e) => e.tag === 'TokenTransfer');
if (!transferEvent) throw new Error('no TokenTransfer event in transfer tx');
log('TokenTransfer:', JSON.stringify(transferEvent));
evidence.railB.transferTx = tr7.txHash;
evidence.railB.transferBlock = tr7Status.blockHash;
save();

// 6. Co-signer gate: confirm (transfer verified from chain, reserve included).
const confirmNonce = await nextNonce(client, SELLER_B_ADDRESS);
const confirmDecision = await gate('confirm', {
  kind: 'confirm', sender: SELLER_B_ADDRESS, nonce: confirmNonce,
  txVersion: 1, sponsor: null, txHash: tr7.txHash,
}, { transferTxHash: tr7.txHash, reserveTxHash: res7Tx });
evidence.gates.confirm = confirmDecision;
save();

// 7. Confirm as B (seller) with the transfer tx hash.
const conf7 = await sendUpdate(client, {
  from: signers.sellerB, receiveName: 'confirm_plt',
  parameterHex: encodeConfirm({ payableId: 7, txHashHex: tr7.txHash }),
});
log('confirm payable 7 tx:', conf7.txHash);
const conf7Status = await waitFinalized(client, conf7.txHash);
const confirmed = requireEvent(conf7Status, 'payable_registry.confirm_plt', 'PltConfirmed', 'confirm 7');
log('PltConfirmed event:', JSON.stringify(confirmed));
evidence.railB.confirmTx = conf7.txHash;
evidence.railB.confirmBlock = conf7Status.blockHash;
save();

// 8. Verify (live, full receipt with document + reserve + confirm).
const conf7BlockTime = await getBlockTime(client, conf7Status.blockHash);
const res7BlockTime = await getBlockTime(client, res7Status.blockHash);
const view7After = await getPayable(client, 7);
const balanceAfter = await getRegistryBalance(client);
const reserveCtx = {
  blockTime: res7BlockTime,
  logged: decodeLoggedEvents(updatedEvent(res7Status, 'payable_registry.reserve_plt')),
};
const pltResult = verifyPlt({
  payableId: 7, txHash: tr7.txHash, summary: tr7Status, blockTime: tr7BlockTime,
  view: view7After, balance: balanceAfter, reserve: reserveCtx,
  confirm: { blockTime: conf7BlockTime }, docBytes: Buffer.from(invoice7, 'utf8'),
});
for (const c of pltResult.checks) log(`  [${c.status}] PLT ${c.id} ${c.name} — ${c.detail}`);
log(`RAIL B VERDICT: ${pltResult.passed}/${pltResult.passed + pltResult.failed} passed, allPass=${pltResult.allPass}`);
evidence.railB.verify = pltResult;
save();
if (!pltResult.allPass) throw new Error('Rail B verification failed');

log('\nLIVE E2E COMPLETE — Rail A 12/12, Rail B 15/15.');
log('Evidence:', EVIDENCE_PATH);
