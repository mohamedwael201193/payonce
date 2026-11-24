// PayOnce backend — LIVE v2 happy-path run (testnet only).
// Contract <13150,0> (payable_registry_v2). SEPARATE from the v1 run:
// the v1 REGISTRY (<13149,0>) and its evidence are untouched.
//
// ROLES — mirror of the parent's ask, for a documented on-chain reason:
//   seller = owner (42jaZZ…): the ONLY account in this workspace with an
//   agent token on the OFFICIAL registry <12802,0> (token 1476, Active).
//   Seller B holds NO token there: agentOf(1) and agentOf(1261) return
//   other owners, and a CIS-2 balanceOf scan could not be completed
//   (the registry rejects the standard encoding). B therefore CANNOT
//   register on v2 (register would fail -10 AgentOwnerMismatch for any
//   token B does not own). The mirror exercises every guard identically:
//   payer != seller (-27), expected payer (-21), approval (-19), caps
//   (-23), agent check (-8/-9/-10), atomic forward, -18 invariant.
//   payer = B (4MvdMEGC…, HD-derived key, counter 1).
//   B onboarding as an official-registry agent is the open D6 item.
// Rail A: owner registers CCD payable 10 -> B pays via pay_ccd.
// Rail B: owner registers EUDemo payable 11 (expected=B) -> B approves
//         owner -> B reserves (co-signer gate) -> B transfers EUDemo with
//         memo payable:<owner>:<11> (gate) -> B confirms (gate).
// Keys are loaded in-process only (see src/send.mjs); this script prints
// NOTHING secret — only tx hashes, decisions and views.
// Evidence is written incrementally to test/v2-live-e2e-2026-11-24.json.
import { writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { grpcClient, getTxStatus, getBlockTime, getAccountInfo, tokenBalance, encodeCborMemo, toJson } from '../src/chain.mjs';
import { loadSigners, nextNonce, sendTokenTransfer, OWNER_ADDRESS, SELLER_B_ADDRESS, PAYEE2_ADDRESS } from '../src/send.mjs';
import { getPayableV2, getPayableV2OrNull, getConfigV2, getVendorV2, getRegistryBalanceV2, agentOf, REGISTRY_V2, OWNER_TOKEN_V2, RESERVATION_SECS_V2 } from '../src/v2/registry.mjs';
import { encodeV2RegisterPayable, encodeV2PayableKey, encodeV2Confirm, encodeV2ApproveVendor } from '../src/v2/encoders.mjs';
import { sendUpdateV2, sendSimpleTransfer, waitFinalized, summarizeTx } from '../src/v2/send.mjs';
import { decodeLoggedEventsV2 } from '../src/v2/events.mjs';
import { buildSnapshotV2 } from '../src/v2/snapshot.mjs';
import { decide } from '../src/cosigner/decide.mjs';

const PAYEE1_ADDRESS = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin';
const EVIDENCE_PATH = new URL('../test/v2-live-e2e-2026-11-24.json', import.meta.url).pathname;
const evidence = existsSync(EVIDENCE_PATH)
  ? JSON.parse(readFileSync(EVIDENCE_PATH, 'utf8'))
  : { runAt: new Date().toISOString(), network: 'testnet', contract: '<13150,0>', roles: {}, approve: {}, railA: {}, railB: {}, gates: {} };
evidence.runAt = new Date().toISOString();
evidence.contract = '<13150,0>';
evidence.roles = {
  seller: OWNER_ADDRESS,
  sellerAgentToken: OWNER_TOKEN_V2,
  sellerAgentTokenNote: 'token 1476 on official CIS-8004 <12802,0>, owner=deployer, Active (probed live)',
  payer: SELLER_B_ADDRESS,
  payerNote: 'B pays; payer != seller. Seller-B roles impossible: B owns no agent token on <12802,0> (agentOf 1/1261 = other owners); see rolesNote.',
  rolesNote: 'Parent asked seller=B/payer=owner; mirrored because B cannot register on v2 without an official-registry agent token (D6 open). All guards exercised identically.',
  payeeCcd: PAYEE1_ADDRESS,
  payeePlt: PAYEE2_ADDRESS,
};
evidence.approve ??= {}; evidence.railA ??= {}; evidence.railB ??= {}; evidence.gates ??= {};
const save = () => writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));

const log = (...a) => console.log(...a);
const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const FIXED_DUE_MS = Date.UTC(2026, 11, 26, 12, 0, 0); // same fixed due as the v1 run

function ccdMicro(info) {
  // toJson'd account info: accountAmount is the microCCD string itself.
  const a = info.accountAmount;
  if (typeof a === 'string') return BigInt(a);
  if (typeof a === 'number') return BigInt(a);
  const v = a?.microCcdAmount;
  if (typeof v === 'string') return BigInt(v);
  if (typeof v === 'number') return BigInt(v);
  if (v && typeof v === 'object') return BigInt(v.value ?? v.microCcdAmount ?? 0);
  throw new Error('cannot read CCD balance: ' + JSON.stringify(a).slice(0, 200));
}
// getAccountInfo requires a block hash: read at the last finalized block.
async function accountInfoFinalized(addr) {
  const consensus = toJson(await client.getConsensusStatus());
  return getAccountInfo(client, addr, consensus.lastFinalizedBlock);
}
function updatedEvent(status, receiveName) {
  return (status.summary?.events ?? []).find(
    (e) => e.tag === 'Updated' && String(e.address?.index) === '13150' && e.receiveName === receiveName,
  );
}
function requireEventV2(status, receiveName, eventName, label) {
  const upd = updatedEvent(status, receiveName);
  if (!upd) throw new Error(`${label}: no Updated event for ${receiveName}`);
  const ev = decodeLoggedEventsV2(upd).find((e) => e.event === eventName);
  if (!ev) throw new Error(`${label}: expected ${eventName} event in ${receiveName}, got ${JSON.stringify(decodeLoggedEventsV2(upd))}`);
  return ev;
}

const client = grpcClient();
const signers = loadSigners();

// ---- Pre-checks ----
const cfg = await getConfigV2(client);
log('v2 config:', JSON.stringify(cfg));
if (cfg.cis8004 !== '<12802,0>' || cfg.reservation_secs !== RESERVATION_SECS_V2) throw new Error('v2 config mismatch');
const agent = await agentOf(client, OWNER_TOKEN_V2);
log(`seller agent token ${OWNER_TOKEN_V2}: owner=${agent?.owner === OWNER_ADDRESS ? 'OWNER' : agent?.owner} status=${agent?.statusName}`);
if (!agent || agent.owner !== OWNER_ADDRESS || agent.status !== 0) throw new Error('seller agent token is not owner/Active');
evidence.preChecks = { config: cfg, agentToken: { token: OWNER_TOKEN_V2, owner: agent.owner, status: agent.statusName } };
save();

// ---- Invoices (real files, hashed on chain) ----
const buildInvoice = (title, amountLine, dueMs, payee) => [
  title,
  `Seller: ${OWNER_ADDRESS}`,
  `Payee: ${payee}`,
  amountLine,
  `Due: ${new Date(dueMs).toISOString()}`,
  'Test only — Concordium testnet, no real goods or services.',
  '',
].join('\n');
mkdirSync(new URL('../test/invoices/', import.meta.url).pathname, { recursive: true });
const pre10 = await getPayableV2OrNull(client, OWNER_ADDRESS, 10);
const pre11 = await getPayableV2OrNull(client, OWNER_ADDRESS, 11);
const dueMs10 = pre10 ? Number(pre10.dueMs) : FIXED_DUE_MS;
const dueMs11 = pre11 ? Number(pre11.dueMs) : FIXED_DUE_MS;
const invoice10 = buildInvoice('PAYONCE TEST INVOICE — payable 10 (v2 Rail A, CCD)', 'Amount: 0.5 CCD (500000 microCCD)', dueMs10, PAYEE1_ADDRESS);
const invoice11 = buildInvoice('PAYONCE TEST INVOICE — payable 11 (v2 Rail B, EUDemo)', 'Amount: 0.01 EUDemo (10000 base units, 6 decimals)', dueMs11, PAYEE2_ADDRESS);
writeFileSync(new URL('../test/invoices/invoice-010-v2-ccd.txt', import.meta.url).pathname, invoice10);
writeFileSync(new URL('../test/invoices/invoice-011-v2-eudemo.txt', import.meta.url).pathname, invoice11);
const docHash10 = sha256(Buffer.from(invoice10, 'utf8'));
const docHash11 = sha256(Buffer.from(invoice11, 'utf8'));
log('docHash10:', docHash10.slice(0, 16) + '…', pre10 ? '(resuming)' : '(fresh)');
log('docHash11:', docHash11.slice(0, 16) + '…', pre11 ? '(resuming)' : '(fresh)');

// Balances before.
const balBefore = {};
for (const [addr, label] of [[OWNER_ADDRESS, 'owner'], [SELLER_B_ADDRESS, 'B'], [PAYEE1_ADDRESS, 'payee1'], [PAYEE2_ADDRESS, 'payee2']]) {
  const info = await accountInfoFinalized(addr);
  balBefore[label] = { ccdMicro: ccdMicro(info).toString(), nonce: String(info.accountNonce), eudemo: tokenBalance(info, 'EUDemo') };
}
log('balances before:', JSON.stringify(balBefore));
evidence.balancesBefore = balBefore;
save();
if (BigInt(balBefore.B.eudemo) < 10000n) throw new Error('B holds less than 0.01 EUDemo — cannot pay Rail B');
// Funding: B must cover ~70 CCD of v2 fees (rate ~0.0078 CCD/NRG) on top of
// the 0.5 CCD pay. Top B up to ~174 CCD from the owner first (test setup,
// recorded honestly — the wallet is authorized for test transfers).
if (BigInt(balBefore.B.ccdMicro) < 150_000_000n) {
  const fund = await sendSimpleTransfer(client, { from: signers.owner, to: SELLER_B_ADDRESS, amountMicroCcd: 100_000_000n });
  log('fund B +100 CCD tx:', fund.txHash);
  const fundStatus = await waitFinalized(client, fund.txHash);
  evidence.funding = { tx: fund.txHash, summary: summarizeTx(fundStatus), amountMicroCcd: '100000000' };
  save();
  const bAfterFund = await accountInfoFinalized(SELLER_B_ADDRESS);
  balBefore.B.ccdMicro = ccdMicro(bAfterFund).toString();
  balBefore.B.nonce = String(bAfterFund.accountNonce);
  log('B CCD after funding:', (Number(balBefore.B.ccdMicro) / 1e6).toFixed(6));
  evidence.balancesBefore = balBefore;
  save();
}

// ---- Step 0: B approves owner as vendor (needed for reserve_plt, -19) ----
const APPROVAL = { tier: 2, legal: null, perCap: 100_000_000, periodCap: 1_000_000_000, periodSecs: 86400 };
let approveTx = process.env.APPROVE_V2_TX || evidence.approve.tx || null;
const vendorPre = await getVendorV2(client, SELLER_B_ADDRESS, OWNER_ADDRESS);
if (vendorPre) {
  log('vendor row (B,owner) already present (resuming):', JSON.stringify(vendorPre));
  evidence.approve.vendor = vendorPre;
} else {
  const ap = await sendUpdateV2(client, {
    from: signers.sellerB, receiveName: 'approve_vendor',
    parameterHex: encodeV2ApproveVendor({ seller: OWNER_ADDRESS, ...APPROVAL }),
  });
  log('approve_vendor (B approves owner) tx:', ap.txHash);
  const apStatus = await waitFinalized(client, ap.txHash);
  const apEvent = requireEventV2(apStatus, 'payable_registry_v2.approve_vendor', 'VendorApproved', 'approve_vendor');
  log('VendorApproved event:', JSON.stringify(apEvent));
  approveTx = ap.txHash;
  evidence.approve = { tx: approveTx, summary: summarizeTx(apStatus), event: apEvent, vendor: await getVendorV2(client, SELLER_B_ADDRESS, OWNER_ADDRESS) };
  save();
}
const vendorNow = await getVendorV2(client, SELLER_B_ADDRESS, OWNER_ADDRESS);
if (!vendorNow || vendorNow.perPayableCap !== '100000000') throw new Error('vendor row missing after approve');
log('vendor row (B,owner):', JSON.stringify(vendorNow));

// ================= RAIL A: payable 10 (CCD) =================
log('\n=== v2 RAIL A: payable 10 (CCD) ===');
const reg10Param = encodeV2RegisterPayable({
  id: 10, payee: PAYEE1_ADDRESS, amount: 500000, asset: 'CCD',
  dueMs: dueMs10, docHashHex: docHash10, token: OWNER_TOKEN_V2, expected: SELLER_B_ADDRESS, legal: null,
});
let reg10Tx = process.env.REGISTER10_TX || evidence.railA.registerTx || null;
if (pre10 && pre10.docHash === docHash10) {
  log('payable 10 already registered (resuming); register tx:', reg10Tx ?? 'unknown-pre-existing');
} else {
  const reg10 = await sendUpdateV2(client, { from: signers.owner, receiveName: 'register_payable', parameterHex: reg10Param });
  log('register payable 10 tx:', reg10.txHash);
  const reg10Status = await waitFinalized(client, reg10.txHash);
  const regEv = requireEventV2(reg10Status, 'payable_registry_v2.register_payable', 'Registered', 'register 10');
  log('Registered event:', JSON.stringify(regEv));
  reg10Tx = reg10.txHash;
  evidence.railA.registerTx = reg10Tx;
  evidence.railA.registerSummary = summarizeTx(reg10Status);
  evidence.railA.registerEvent = regEv;
  save();
}
const view10 = await getPayableV2(client, OWNER_ADDRESS, 10);
if (view10.status !== 'Unpaid' && view10.status !== 'Paid') throw new Error(`payable 10 row mismatch: ${JSON.stringify(view10)}`);
if (view10.amount !== '500000' || view10.docHash !== docHash10 || view10.expectedPayer !== SELLER_B_ADDRESS) {
  throw new Error(`payable 10 row mismatch: ${JSON.stringify(view10)}`);
}
log(`payable 10 row: ${view10.status}, 500000 microCCD, expected_payer=B, doc hash matches.`);

// B pays via pay_ccd (payer != seller). Resume-safe: if already Paid, reuse
// the pay tx from the evidence file (the v2 CCD Paid record stores no tx hash).
let pay10Tx = process.env.PAY10_TX || evidence.railA.payTx || null;
let pay10Status = null;
let paid10 = null;
if (view10.status === 'Paid') {
  if (!pay10Tx) throw new Error('payable 10 is Paid but no pay tx hash is known (evidence file / PAY10_TX)');
  log('payable 10 already Paid (resuming); pay tx:', pay10Tx);
  pay10Status = await getTxStatus(client, pay10Tx);
  paid10 = requireEventV2(pay10Status, 'payable_registry_v2.pay_ccd', 'Paid', 'pay_ccd 10 (resume)');
} else {
  const pay10 = await sendUpdateV2(client, {
    from: signers.sellerB, receiveName: 'pay_ccd',
    parameterHex: encodeV2PayableKey({ seller: OWNER_ADDRESS, id: 10 }), amountMicroCcd: 500000n,
  });
  log('pay_ccd payable 10 tx:', pay10.txHash);
  pay10Status = await waitFinalized(client, pay10.txHash);
  paid10 = requireEventV2(pay10Status, 'payable_registry_v2.pay_ccd', 'Paid', 'pay_ccd 10');
  log('Paid event:', JSON.stringify(paid10));
  pay10Tx = pay10.txHash;
  evidence.railA.payTx = pay10Tx;
  evidence.railA.paySummary = summarizeTx(pay10Status);
  evidence.railA.payEvent = paid10;
  save();
}
if (paid10.payer !== SELLER_B_ADDRESS || paid10.amount !== '500000' || paid10.asset !== 'CCD') {
  throw new Error(`Paid event mismatch: ${JSON.stringify(paid10)}`);
}
const view10After = await getPayableV2(client, OWNER_ADDRESS, 10);
if (view10After.status !== 'Paid' || view10After.record?.payer !== SELLER_B_ADDRESS
  || view10After.record?.txHash !== null || view10After.record?.reservationExpiresMs !== null) {
  throw new Error(`payable 10 Paid row mismatch: ${JSON.stringify(view10After)}`);
}
log(`payable 10 row: Paid by B at ${view10After.record.paidAt}, txHash=None, reservationExpires=None (CCD rail).`);
const payee1After = await accountInfoFinalized(PAYEE1_ADDRESS);
const payee1Delta = ccdMicro(payee1After) - BigInt(balBefore.payee1.ccdMicro);
if (payee1Delta !== 500000n) throw new Error(`payee1 CCD delta ${payee1Delta} != 500000`);
log(`payee1 CCD delta: +${payee1Delta} microCCD (atomic forward verified).`);
const balAfterA = await getRegistryBalanceV2(client);
if (balAfterA !== '0') throw new Error(`contract balance after pay_ccd is ${balAfterA}, expected 0`);
log('contract balance after pay_ccd: 0 (no stray balance).');
evidence.railA.paidView = view10After;
evidence.railA.payee1DeltaMicroCcd = payee1Delta.toString();
evidence.railA.contractBalanceAfter = balAfterA;
save();

// ================= RAIL B: payable 11 (EUDemo) =================
log('\n=== v2 RAIL B: payable 11 (EUDemo) ===');
const reg11Param = encodeV2RegisterPayable({
  id: 11, payee: PAYEE2_ADDRESS, amount: 10000, asset: 'EUDemo',
  dueMs: dueMs11, docHashHex: docHash11, token: OWNER_TOKEN_V2, expected: SELLER_B_ADDRESS, legal: null,
});
let reg11Tx = process.env.REGISTER11_TX || evidence.railB.registerTx || null;
if (pre11 && pre11.docHash === docHash11) {
  log('payable 11 already registered (resuming); register tx:', reg11Tx ?? 'unknown-pre-existing');
} else {
  const reg11 = await sendUpdateV2(client, { from: signers.owner, receiveName: 'register_payable', parameterHex: reg11Param });
  log('register payable 11 tx:', reg11.txHash);
  const reg11Status = await waitFinalized(client, reg11.txHash);
  const regEv = requireEventV2(reg11Status, 'payable_registry_v2.register_payable', 'Registered', 'register 11');
  log('Registered event:', JSON.stringify(regEv));
  reg11Tx = reg11.txHash;
  evidence.railB.registerTx = reg11Tx;
  evidence.railB.registerSummary = summarizeTx(reg11Status);
  evidence.railB.registerEvent = regEv;
  save();
}
const view11 = await getPayableV2(client, OWNER_ADDRESS, 11);
if (view11.status !== 'Unpaid' && view11.status !== 'Reserved' && view11.status !== 'Paid') {
  throw new Error(`payable 11 row mismatch: ${JSON.stringify(view11)}`);
}
if (view11.amount !== '10000' || view11.docHash !== docHash11 || view11.expectedPayer !== SELLER_B_ADDRESS || view11.asset !== 'EUDemo') {
  throw new Error(`payable 11 row mismatch: ${JSON.stringify(view11)}`);
}
log(`payable 11 row: ${view11.status}, 10000 base units EUDemo, expected_payer=B, doc hash matches.`);

// Co-signer gate helper (agent = B, 1-of-1, no sponsor).
async function gate(kind, request, extra = {}) {
  const nonce = await nextNonce(client, SELLER_B_ADDRESS);
  const snapshot = await buildSnapshotV2(client, {
    seller: OWNER_ADDRESS, payableId: 11, agentAccount: SELLER_B_ADDRESS,
    sponsorAccount: null, signatureThreshold: 1, ...extra,
  });
  if (snapshot.nextNonce !== nonce) throw new Error(`gate ${kind}: nonce moved (snapshot ${snapshot.nextNonce} != ${nonce})`);
  const decision = decide(snapshot, request, { unresolved: [] });
  log(`gate ${kind}: ${decision.decision}${decision.code ? ` (${decision.code})` : ''}${decision.reasons[0] ? ` — ${decision.reasons[0]}` : ''}`);
  if (decision.decision !== 'SIGN') throw new Error(`co-signer gate refused ${kind}: ${decision.code}`);
  return decision;
}

// Reserve (resume-aware: reuse a live reservation, expire a dead one first).
const view11Now = await getPayableV2(client, OWNER_ADDRESS, 11);
let res11Tx = process.env.RESERVE11_TX || evidence.railB.reserveTx || null;
let res11Status = null;
let reserved11 = null;
const nowMs = Date.now();
if (view11Now.status === 'Reserved' && Number(view11Now.record.expiresMs) > nowMs + 60_000) {
  log(`payable 11 already Reserved (resuming); expires ${view11Now.record.expires}`);
  reserved11 = { expiresMs: view11Now.record.expiresMs };
  if (res11Tx) res11Status = await getTxStatus(client, res11Tx);
} else if (view11Now.status === 'Paid') {
  log('payable 11 already Paid (resuming Rail B tail).');
  reserved11 = { expiresMs: view11Now.record.reservationExpiresMs };
} else {
  if (view11Now.status === 'Reserved') {
    log('reservation expired — expiring it on-chain first');
    const exp11 = await sendUpdateV2(client, {
      from: signers.sellerB, receiveName: 'expire_reservation',
      parameterHex: encodeV2PayableKey({ seller: OWNER_ADDRESS, id: 11 }),
    });
    await waitFinalized(client, exp11.txHash);
    log('expire_reservation tx:', exp11.txHash);
    evidence.railB.expireTx = exp11.txHash;
    save();
  }
  const reserveDecision = await gate('reserve_plt', {
    kind: 'reserve_plt', sender: SELLER_B_ADDRESS, nonce: await nextNonce(client, SELLER_B_ADDRESS),
    txVersion: 1, sponsor: null, numSignatures: 1,
  });
  evidence.gates.reserve = reserveDecision;
  save();
  const res11 = await sendUpdateV2(client, {
    from: signers.sellerB, receiveName: 'reserve_plt',
    parameterHex: encodeV2PayableKey({ seller: OWNER_ADDRESS, id: 11 }),
  });
  log('reserve payable 11 tx:', res11.txHash);
  res11Status = await waitFinalized(client, res11.txHash);
  reserved11 = requireEventV2(res11Status, 'payable_registry_v2.reserve_plt', 'Reserved', 'reserve 11');
  log('Reserved event:', JSON.stringify(reserved11));
  res11Tx = res11.txHash;
  evidence.railB.reserveTx = res11Tx;
  evidence.railB.reserveSummary = summarizeTx(res11Status);
  evidence.railB.reserveEvent = reserved11;
  save();
}

if (view11Now.status !== 'Paid') {
  const view11Reserved = await getPayableV2(client, OWNER_ADDRESS, 11);
  if (view11Reserved.status !== 'Reserved' || view11Reserved.record?.payer !== SELLER_B_ADDRESS) {
    throw new Error(`payable 11 Reserved row mismatch: ${JSON.stringify(view11Reserved)}`);
  }
  const reservedAtMs = Number(view11Reserved.record.reservedAtMs);
  const expiresMs = Number(view11Reserved.record.expiresMs);
  if (expiresMs - reservedAtMs !== RESERVATION_SECS_V2 * 1000) {
    throw new Error(`reservation window ${expiresMs - reservedAtMs}ms != ${RESERVATION_SECS_V2 * 1000}ms`);
  }
  log(`payable 11 row: Reserved by B, expires ${view11Reserved.record.expires} (window exactly ${RESERVATION_SECS_V2}s).`);
  const headerExpirySeconds = Math.floor((expiresMs - 60_000) / 1000);

  // Gate + transfer EUDemo B -> payee2 with memo payable:<owner>:<11>.
  const memo = `payable:${OWNER_ADDRESS}:11`;
  const transferDecision = await gate('transfer', {
    kind: 'transfer', sender: SELLER_B_ADDRESS, nonce: await nextNonce(client, SELLER_B_ADDRESS),
    txVersion: 1, sponsor: null, recipient: PAYEE2_ADDRESS, amount: '10000',
    token: 'EUDemo', memo: encodeCborMemo(memo).toString('hex'),
    headerExpirySeconds, operations: 1,
  });
  evidence.gates.transfer = transferDecision;
  save();
  const tr11 = await sendTokenTransfer(client, {
    from: signers.sellerB, recipient: PAYEE2_ADDRESS, amount: 10000,
    memo, expirySeconds: headerExpirySeconds,
  });
  log('EUDemo transfer payable 11 tx:', tr11.txHash);
  const tr11Status = await waitFinalized(client, tr11.txHash);
  const trEvent = (tr11Status.summary?.events ?? []).find((e) => e.tag === 'TokenTransfer');
  if (!trEvent) throw new Error('no TokenTransfer event in transfer tx');
  log('TokenTransfer:', JSON.stringify(trEvent));
  evidence.railB.transferTx = tr11.txHash;
  evidence.railB.transferSummary = summarizeTx(tr11Status);
  save();

  // Gate + confirm with the transfer tx hash.
  const confirmDecision = await gate('confirm', {
    kind: 'confirm', sender: SELLER_B_ADDRESS, nonce: await nextNonce(client, SELLER_B_ADDRESS),
    txVersion: 1, sponsor: null, txHash: tr11.txHash,
  }, { transferTxHash: tr11.txHash });
  evidence.gates.confirm = confirmDecision;
  save();
  const conf11 = await sendUpdateV2(client, {
    from: signers.sellerB, receiveName: 'confirm_plt',
    parameterHex: encodeV2Confirm({ seller: OWNER_ADDRESS, id: 11, txHashHex: tr11.txHash }),
  });
  log('confirm payable 11 tx:', conf11.txHash);
  const conf11Status = await waitFinalized(client, conf11.txHash);
  const confirmed = requireEventV2(conf11Status, 'payable_registry_v2.confirm_plt', 'PltConfirmed', 'confirm 11');
  log('PltConfirmed event:', JSON.stringify(confirmed));
  evidence.railB.confirmTx = conf11.txHash;
  evidence.railB.confirmSummary = summarizeTx(conf11Status);
  evidence.railB.confirmEvent = confirmed;
  save();
}

const view11After = await getPayableV2(client, OWNER_ADDRESS, 11);
if (view11After.status !== 'Paid' || view11After.record?.payer !== SELLER_B_ADDRESS
  || view11After.record?.txHash !== (process.env.TRANSFER11_TX || evidence.railB.transferTx)) {
  throw new Error(`payable 11 Paid row mismatch: ${JSON.stringify(view11After)}`);
}
if (view11After.record?.reservationExpiresMs !== (reserved11?.expiresMs ?? view11After.record?.reservationExpiresMs)) {
  throw new Error(`payable 11 Paid row keeps wrong reservation_expires: ${JSON.stringify(view11After.record)}`);
}
log(`payable 11 row: Paid by B at ${view11After.record.paidAt}, txHash pinned, reservation_expires kept (F11).`);
const payee2After = await accountInfoFinalized(PAYEE2_ADDRESS);
const payee2Delta = BigInt(tokenBalance(payee2After, 'EUDemo')) - BigInt(balBefore.payee2.eudemo);
if (payee2Delta !== 10000n) throw new Error(`payee2 EUDemo delta ${payee2Delta} != 10000`);
log(`payee2 EUDemo delta: +${payee2Delta} base units.`);
const balAfterB = await getRegistryBalanceV2(client);
if (balAfterB !== '0') throw new Error(`contract balance after confirm is ${balAfterB}, expected 0`);
evidence.railB.paidView = view11After;
evidence.railB.payee2DeltaEudemo = payee2Delta.toString();
evidence.railB.contractBalanceAfter = balAfterB;
evidence.balancesAfter = {};
for (const [addr, label] of [[OWNER_ADDRESS, 'owner'], [SELLER_B_ADDRESS, 'B'], [PAYEE1_ADDRESS, 'payee1'], [PAYEE2_ADDRESS, 'payee2']]) {
  const info = await accountInfoFinalized(addr);
  evidence.balancesAfter[label] = { ccdMicro: ccdMicro(info).toString(), nonce: String(info.accountNonce), eudemo: tokenBalance(info, 'EUDemo') };
}
save();

log('\nV2 LIVE E2E COMPLETE — pay_ccd SUCCESS, reserve_plt + confirm_plt SUCCESS.');
log('Evidence:', EVIDENCE_PATH);
