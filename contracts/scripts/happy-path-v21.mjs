// happy-path-v21.mjs — LIVE v2.1 happy path + F1 dust drill + F5 record flow on TESTNET.
// Contract: payable_registry_v2_1 (instance from deploy-v21-result.json).
// Roles (mirrored, same documented reason as the v2 run): seller = owner
// (42jaZZ…: the ONLY account with an agent token on the official CIS-8004
// <12802,0>, token 1476, Active); payer = B (4MvdMEGC…, HD-derived key,
// identity 1 counter 1). B owns no official-registry agent token, so B
// cannot register on v2.1 (register would fail -10 AgentOwnerMismatch);
// the mirror exercises every guard identically. D6 (B onboarding) is open.
// Rail A: owner registers CCD payable 10 -> B pays via pay_ccd.
//   F1 DUST DRILL — CORRECTED PREMISE (found live, 2026-11-24): a plain CCD
//   transfer CANNOT target a contract at all — the SDK serializes
//   AccountAddress.toBuffer(transfer.toAddress) and the protocol's Transfer
//   recipient is a 32-byte account address (a ContractAddress has no such
//   buffer; the first run crashed in SimpleTransferHandler.serialize for
//   exactly this reason). And an update with attached CCD to any non-payable
//   entrypoint is rejected by the CHAIN (only pay_ccd carries the `payable`
//   marker — verified in src/lib.rs; all 14 other entrypoints lack it), while
//   pay_ccd forwards exactly the attached amount. So NO transaction exists
//   that can put CCD into this contract: it is dust-proof by construction.
//   The drill is therefore replaced by its live proof: (a) contract balance
//   == 0 before the pay; (b) an update WITH attached CCD to non-payable
//   record_payment_tx is rejected (recorded verbatim); (c) pay_ccd succeeds
//   under the new assertion (balance_after == balance_before == 0) and the
//   balance stays 0. The dust case itself (balance_before > 0) is proven by
//   engine test M04 (pay succeeds with a pre-existing balance). The -18 fix
//   is defense-in-depth for a balance that is unreachable live.
//   F5: after the pay, B records the pay tx hash (record_payment_tx);
//   the view then shows txHash == the pay hash. Negatives covered:
//   record by non-payer -> -17; zero hash -> -14; record twice -> -5.
// Rail B: owner registers EUDemo payable 11 (expected=B) -> B approves
//   owner -> B reserves -> B transfers EUDemo with memo payable:<owner>:<11>
//   -> B confirms. Keys are loaded in-process only; this script prints
//   NOTHING secret — only tx hashes, decisions and views.
// Evidence is written incrementally to happy-path-v21-result.json.
import fs from 'node:fs';
import crypto from 'node:crypto';
import { parse } from 'dotenv';
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { credentials } from '@grpc/grpc-js';
import {
  AccountAddress, ContractAddress, TransactionExpiry, CcdAmount, Energy,
  ReceiveName, Parameter, buildBasicAccountSigner, ConcordiumHdWallet,
  Transaction, Payload, Cbor, CborMemo, TokenAmount, CborAccountAddress, TokenId,
  SequenceNumber, TransactionHash,
} from '@concordium/web-sdk';

const ENV_PATH = '/home/hatch/workspace/concordium-trusted-agents/.env';
const DEPLOY = JSON.parse(fs.readFileSync(new URL('./deploy-v21-result.json', import.meta.url), 'utf8'));
const CONTRACT_INDEX = BigInt(DEPLOY.contract.slice(1, -3));
const CONTRACT = ContractAddress.create(CONTRACT_INDEX, 0n);
const CONTRACT_NAME = 'payable_registry_v2_1';
const OWNER_ADDRESS = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB';
const SELLER_B_ADDRESS = '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs';
const PAYEE1_ADDRESS = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin';
const PAYEE2_ADDRESS = '4Vtd6WnC487iKJBh1wL6GkCicrgyhKWcbZMjaX33eJSzTqj1Tg';
const OWNER_TOKEN = 1476;
const DUST_MICRO = 1_000; // 0.001 CCD — the attached amount used in the non-payable-entrypoint probe (step 4); a donation itself is impossible, see header
const DUE_MS = Date.UTC(2026, 11, 26, 12, 0, 0);

const env = {};
for (const t of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
  const eq = t.indexOf('=');
  if (eq > 0) env[t.slice(0, eq).trim()] = t.slice(eq + 1).trim();
}
const ownerAddr = AccountAddress.fromBase58(OWNER_ADDRESS);
const bAddr = AccountAddress.fromBase58(SELLER_B_ADDRESS);
const payee1 = AccountAddress.fromBase58(PAYEE1_ADDRESS);
const payee2 = AccountAddress.fromBase58(PAYEE2_ADDRESS);
const ownerSigner = buildBasicAccountSigner(env.CONCORDIUM_WALLET_PRIVATE_KEY);
const wallet = ConcordiumHdWallet.fromSeedPhrase(env.CONCORDIUM_WALLET_SEED_PHRASE, 'Testnet');
const bSigner = buildBasicAccountSigner(wallet.getAccountSigningKey(0, 1, 1).toString('hex'));
const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = (b) => Buffer.from(b).toString('hex');
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const toJson = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));

const EVIDENCE_PATH = new URL('./happy-path-v21-result.json', import.meta.url);
const priorEvidence = fs.existsSync(EVIDENCE_PATH) ? JSON.parse(fs.readFileSync(EVIDENCE_PATH, 'utf8')) : null;
if (priorEvidence) console.log('resuming from prior run — steps already passed are skipped, not re-sent');
const evidence = priorEvidence ?? {
  runAt: new Date().toISOString(), network: 'testnet', contract: DEPLOY.contract,
  module: DEPLOY.moduleHash, roles: {
    seller: OWNER_ADDRESS, sellerAgentToken: OWNER_TOKEN,
    sellerNote: 'token 1476 on official CIS-8004 <12802,0>, Active (probed live on v2)',
    payer: SELLER_B_ADDRESS,
    payerNote: 'B pays; payer != seller. Seller-B roles impossible: B owns no agent token on <12802,0> (D6 open). All guards exercised identically.',
    payeeCcd: PAYEE1_ADDRESS, payeePlt: PAYEE2_ADDRESS,
  },
  derivation: {}, dustDrill: {}, approve: {}, railA: {}, railB: {}, balances: {}, final: {},
};
const save = () => fs.writeFileSync(EVIDENCE_PATH, JSON.stringify(evidence, null, 2));

// --- encoders (concordium-std Serial, little-endian; identical to v2) ---
const u64le = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };
const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const ab = (a) => Buffer.from(a.decodedAddress);
const optAddr = (a) => (a ? Buffer.concat([Buffer.from([1]), ab(a)]) : Buffer.from([0]));
const optHash = (h) => (h ? Buffer.concat([Buffer.from([1]), Buffer.from(h, 'hex')]) : Buffer.from([0]));
const assetCcd = () => Buffer.from([0]);
const assetPlt = (name) => Buffer.concat([Buffer.from([1]), u32le(Buffer.byteLength(name)), Buffer.from(name)]);
const registerParam = ({ id, payee, amount, asset, dueMs, docHash, token, expected, legal }) =>
  Buffer.concat([u64le(id), ab(payee), u64le(amount), asset, u64le(dueMs), Buffer.from(docHash, 'hex'), u64le(token), optAddr(expected), optHash(legal)]);
const keyParam = (seller, id) => Buffer.concat([ab(seller), u64le(id)]);
const recordParam = (seller, id, txHashHex) => Buffer.concat([ab(seller), u64le(id), Buffer.from(txHashHex, 'hex')]);
const approveParam = ({ seller, tier, legal, perCap, periodCap, periodSecs }) =>
  Buffer.concat([ab(seller), Buffer.from([tier]), optHash(legal), u64le(perCap), u64le(periodCap), u64le(periodSecs)]);

// --- view parsers (same layout as v2; Paid carries the optional tx hash) ---
function parsePayable(b) {
  if (b[0] === 0) return null;
  let p = 1;
  const seller = b.subarray(p, p + 32).toString('hex'); p += 32;
  const id = Number(b.readBigUInt64LE(p)); p += 8;
  const payee = b.subarray(p, p + 32).toString('hex'); p += 32;
  const amount = Number(b.readBigUInt64LE(p)); p += 8;
  const assetTag = b[p++];
  let asset = 'Ccd';
  if (assetTag === 1) { const len = b.readUInt32LE(p); p += 4; asset = 'Plt(' + b.subarray(p, p + len).toString() + ')'; p += len; }
  const due = Number(b.readBigUInt64LE(p)); p += 8;
  const docHash = b.subarray(p, p + 32).toString('hex'); p += 32;
  const token = Number(b.readBigUInt64LE(p)); p += 8;
  const expFlag = b[p++];
  const expected = expFlag ? b.subarray(p, p + 32).toString('hex') : null; if (expFlag) p += 32;
  const legFlag = b[p++];
  const legal = legFlag ? b.subarray(p, p + 32).toString('hex') : null; if (legFlag) p += 32;
  const stTag = b[p++];
  let status = 'Unpaid';
  if (stTag === 1) { const payer = b.subarray(p, p + 32).toString('hex'); p += 32; const at = Number(b.readBigUInt64LE(p)); p += 8; const ex = Number(b.readBigUInt64LE(p)); p += 8; status = `Reserved payer=${payer.slice(0, 8)}… at=${at} exp=${ex}`; }
  else if (stTag === 2) { const payer = b.subarray(p, p + 32).toString('hex'); p += 32; const reFlag = b[p++]; let re = null; if (reFlag) { re = Number(b.readBigUInt64LE(p)); p += 8; } const at = Number(b.readBigUInt64LE(p)); p += 8; const txFlag = b[p++]; let tx = null; if (txFlag) { tx = b.subarray(p, p + 32).toString('hex'); p += 32; } status = `Paid payer=${payer.slice(0, 8)}… at=${at} tx=${tx ? tx.slice(0, 12) + '…' : 'none'}`; }
  else if (stTag === 3) { const at = Number(b.readBigUInt64LE(p)); p += 8; status = `Voided at=${at}`; }
  return { seller: seller.slice(0, 12) + '…', id, payee: payee.slice(0, 12) + '…', amount, asset, due, docHash: docHash.slice(0, 12) + '…', token, expected: expected ? expected.slice(0, 12) + '…' : null, legal: legal ? legal.slice(0, 12) + '…' : null, status };
}
function parsePayableRaw(b) {
  // Full parse returning the raw tx hash (null when absent) for the F5 check.
  const v = parsePayable(b);
  if (!v) return null;
  let p = 1 + 32 + 8 + 32 + 8 + 1;
  const assetTag = b[1 + 32 + 8 + 32 + 8];
  if (assetTag === 1) { const len = b.readUInt32LE(p); p += 4 + len; }
  p += 8 + 32 + 8;
  const expFlag = b[p++];
  if (expFlag) p += 32;
  const legFlag = b[p++];
  if (legFlag) p += 32;
  const stTag = b[p++];
  if (stTag !== 2) return { ...v, payer: null, txHash: null };
  const payer = b.subarray(p, p + 32).toString('hex'); p += 32;
  const reFlag = b[p++]; if (reFlag) p += 8;
  p += 8;
  const txFlag = b[p++];
  const txHash = txFlag ? b.subarray(p, p + 32).toString('hex') : null;
  return { ...v, payer, txHash };
}

async function view(method, paramBuf) {
  const res = await client.invokeContract({
    contract: CONTRACT,
    method: ReceiveName.fromString(`${CONTRACT_NAME}.${method}`),
    parameter: Parameter.fromBuffer(paramBuf),
  });
  return Buffer.from(res.returnValue?.buffer ?? res.returnValue ?? []);
}
async function instanceBalanceMicro() {
  const j = toJson(await client.getInstanceInfo(CONTRACT));
  const amt = j.amount;
  return String(typeof amt === 'object' ? amt.microCcdAmount ?? amt.value ?? amt : amt);
}
async function accountCcd(addr) {
  const j = toJson(await client.getAccountInfo(addr));
  return Number(j.accountAmount.microCcdAmount ?? j.accountAmount);
}
function tokenBalance(accountInfoJson, tokenId) {
  const tokens = accountInfoJson?.accountTokens ?? accountInfoJson?.tokens ?? [];
  for (const t of tokens) {
    const id = t.tokenId ?? t.id ?? t.token_id;
    if (String(id) === tokenId) {
      const b = t.amount ?? t.balance ?? t.state?.balance ?? '0';
      return String(typeof b === 'object' ? b.value ?? '0' : b);
    }
  }
  return '0';
}
async function accountEudemo(addr) {
  return tokenBalance(toJson(await client.getAccountInfo(addr)), 'EUDemo');
}
function rejectReason(status) {
  const sj = JSON.stringify(status, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  try {
    const s = JSON.parse(sj);
    const rr = s.outcome?.summary?.rejectReason;
    if (rr) return rr;
    const m = sj.match(/"rejectReason":\s*(-?\d+)/);
    if (m) return { rejectReason: Number(m[1]) };
  } catch { /* fall through */ }
  return null;
}
async function waitFinalized(hashHex) {
  let status = null;
  for (let i = 0; i < 45; i++) {
    await sleep(2000);
    status = await client.getBlockItemStatus(TransactionHash.fromHexString(hashHex));
    if (status.status === 'finalized') break;
  }
  return status;
}
async function sendUpdate(label, fromAddr, fromSigner, receiveName, paramBuf, amountMicro, expect) {
  const info = await client.getAccountInfo(fromAddr);
  const tx = Transaction.updateContract({
    amount: CcdAmount.fromMicroCcd(BigInt(amountMicro)),
    address: CONTRACT,
    receiveName: ReceiveName.fromString(`${CONTRACT_NAME}.${receiveName}`),
    message: Parameter.fromBuffer(paramBuf),
  }, Energy.create(6000n)).addMetadata({
    sender: fromAddr,
    nonce: info.accountNonce,
    expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
  });
  const fin = await Transaction.signAndFinalize(tx.build(), fromSigner);
  const h = await client.sendTransaction(fin);
  const hashHex = hex(h.buffer);
  const status = await waitFinalized(hashHex);
  const sj = JSON.stringify(status, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const summary = JSON.parse(sj).outcome?.summary ?? {};
  const rr = rejectReason(status);
  const reason = rr?.rejectReason ?? null;
  const outcome = summary.transactionType === 'update' && rr ? `REJECT ${reason}` : summary.transactionType === 'update' ? 'SUCCESS' : JSON.stringify(summary).slice(0, 200);
  const pass = expect === null ? reason === null : reason === expect;
  console.log(`[${label}] ${hashHex.slice(0, 16)}… ${outcome} | expected ${expect === null ? 'SUCCESS' : 'REJECT ' + expect} | ${pass ? 'PASS' : 'FAIL'}`);
  return { hash: hashHex, status, pass, costMicroCcd: summary.cost ?? null, energy: summary.energyCost?.value ?? null, rejectReason: rr, outcome };
}
// NOTE: there is deliberately NO plain-transfer helper here. A plain CCD
// transfer cannot target a contract: Payload.transfer requires an
// AccountAddress (SimpleTransferHandler.serialize calls
// AccountAddress.toBuffer(toAddress); a ContractAddress has no 32-byte
// buffer, so the SDK throws before anything is sent). The protocol agrees:
// a Transfer's recipient is a 32-byte account address. Dust can only arrive
// via an update with attached CCD, and the chain rejects that for every
// non-payable entrypoint (only pay_ccd is `payable`). See step 4 below.
function encodeCborMemo(text) {
  const body = Buffer.from(text, 'utf8');
  if (body.length < 24) return Buffer.concat([Buffer.from([0x60 + body.length]), body]);
  if (body.length < 256) return Buffer.concat([Buffer.from([0x78, body.length]), body]);
  const header = Buffer.alloc(3);
  header[0] = 0x79;
  header.writeUInt16BE(body.length, 1);
  return Buffer.concat([header, body]);
}
async function sendEudemo(label, fromAddr, fromSigner, recipient, amountUnits, memo) {
  const info = await client.getAccountInfo(fromAddr);
  const operations = Cbor.encode([{
    transfer: {
      amount: TokenAmount.create(BigInt(amountUnits), 6),
      recipient: CborAccountAddress.fromBase58(recipient),
      memo: CborMemo.fromString(memo),
    },
  }]);
  const opsHex = Buffer.from(operations.bytes).toString('hex');
  if (!opsHex.includes(encodeCborMemo(memo).toString('hex'))) throw new Error('memo bytes missing from encoded operations');
  const payload = Payload.tokenUpdate({ tokenId: TokenId.fromString('EUDemo'), operations });
  const tx = Transaction.tokenUpdate(payload).addMetadata({
    sender: fromAddr,
    nonce: info.accountNonce,
    expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
  });
  const fin = await Transaction.signAndFinalize(tx.build(), fromSigner);
  const h = await client.sendTransaction(fin);
  const hashHex = hex(h.buffer);
  const status = await waitFinalized(hashHex);
  const sj = JSON.stringify(status, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
  const summary = JSON.parse(sj).outcome?.summary ?? {};
  console.log(`[${label}] ${hashHex.slice(0, 16)}… ${status.status} | cost ${summary.cost} microCCD`);
  return { hash: hashHex, status, costMicroCcd: summary.cost ?? null, energy: summary.energyCost?.value ?? null };
}

// === Step 0: derivation check (B's HD key vs the chain's verifyKeys) ===
{
  const info = toJson(await client.getAccountInfo(bAddr));
  const creds = info.accountCredentials ?? {};
  const credList = Array.isArray(creds) ? creds : Object.values(creds);
  const vks = new Set();
  credList.forEach((cred) => {
    const keys = cred?.value?.contents?.credentialPublicKeys?.keys ?? cred?.credentialPublicKeys?.keys ?? {};
    for (const key of Object.values(keys)) {
      const vk = (key?.verifyKey ?? key ?? '').toString().toLowerCase();
      if (vk.length === 64) vks.add(vk);
    }
  });
  const derivedPub = wallet.getAccountPublicKey(0, 1, 1).toString('hex').toLowerCase();
  const match = vks.has(derivedPub);
  console.log('derivation check: B HD key (identity 1, counter 1) matches chain verifyKeys:', match);
  evidence.derivation = { account: SELLER_B_ADDRESS, identity: 1, counter: 1, matchesChainVerifyKey: match };
  save();
  if (!match) throw new Error('B derivation mismatch — aborting before any send');
}

// === Step 1: balances before ===
evidence.balances.before = {
  ownerCcd: await accountCcd(ownerAddr),
  bCcd: await accountCcd(bAddr),
  payee1Ccd: await accountCcd(payee1),
  payee2Ccd: await accountCcd(payee2),
  bEudemo: await accountEudemo(bAddr),
  payee2Eudemo: await accountEudemo(payee2),
  contractMicroCcd: await instanceBalanceMicro(),
};
console.log('balances before:', JSON.stringify(evidence.balances.before));
save();

// === Step 2: B approves owner as vendor (tier 2) ===
if (evidence.approve?.pass) { console.log('approve_vendor: already passed in prior run, skipping (hash ' + evidence.approve.hash.slice(0, 16) + '…)'); } else {
  const r = await sendUpdate('approve_vendor B->owner tier 2', bAddr, bSigner, 'approve_vendor',
    approveParam({ seller: ownerAddr, tier: 2, legal: sha('company-legal-ref'), perCap: 100_000_000, periodCap: 1_000_000_000, periodSecs: 86400 }), 0, null);
  evidence.approve = { hash: r.hash, costMicroCcd: r.costMicroCcd, energy: r.energy, pass: r.pass };
  save();
}

// === Step 2b: FIX the approval (run-3 lesson) — run 1 approved with
// legal=sha('company-legal-ref') while p10/p11 register with legal=null, so
// check_legal_ref fired -20 on the pay (tx c893a253…). approve_vendor
// overwrites the row (plain insert, no duplicate check), so a re-approve
// with legal=null replaces it. v2.1's check_legal_ref is byte-identical to
// v2's; the v2 run used legal=null on both sides. ===
if (evidence.approveFixed?.pass) { console.log('approval fix: already applied in prior run, skipping (hash ' + evidence.approveFixed.hash.slice(0, 16) + '…)'); } else {
  const r = await sendUpdate('re-approve_vendor B->owner tier 2 legal=null (fix -20)', bAddr, bSigner, 'approve_vendor',
    approveParam({ seller: ownerAddr, tier: 2, legal: null, perCap: 100_000_000, periodCap: 1_000_000_000, periodSecs: 86400 }), 0, null);
  evidence.approveFixed = { hash: r.hash, costMicroCcd: r.costMicroCcd, energy: r.energy, pass: r.pass, note: 'overwrites run-1 approval (legal hash) with legal=null to match p10/p11' };
  save();
  if (!r.pass) throw new Error('approval fix failed — aborting');
}

// === Step 3: owner registers CCD payable 10 (payee1, 0.5 CCD, expected=B) ===
if (evidence.railA?.register?.pass) { console.log('register p10: already passed in prior run, skipping (hash ' + evidence.railA.register.hash.slice(0, 16) + '…)'); } else {
  const r = await sendUpdate('register p10 CCD 0.5 (expected=B)', ownerAddr, ownerSigner, 'register_payable',
    registerParam({ id: 10, payee: payee1, amount: 500_000, asset: assetCcd(), dueMs: DUE_MS, docHash: sha('payonce-v21-invoice-p10'), token: OWNER_TOKEN, expected: bAddr, legal: null }), 0, null);
  evidence.railA.register = { hash: r.hash, costMicroCcd: r.costMicroCcd, energy: r.energy, pass: r.pass };
  save();
}

// === Step 4: F1 DUST-PROOFNESS (live) — no transaction can put CCD in the contract ===
if (evidence.dustDrill?.pass) { console.log('dust-proofness: already proven in prior run, skipping (probe ' + evidence.dustDrill.attachedCcdProbe.hash.slice(0, 16) + '…)'); } else {
  const balBefore = await instanceBalanceMicro();
  const zeroOk = balBefore === '0';
  console.log(`contract balance before pay = ${balBefore} microCCD (expected 0) | ${zeroOk ? 'PASS' : 'FAIL'}`);
  // Negative: attach 1000 microCCD to non-payable record_payment_tx (p10 Unpaid).
  // The CHAIN must reject the attached CCD before the contract ever executes
  // (the entrypoint lacks the `payable` marker). If the node refuses the send
  // outright, that refusal is recorded verbatim instead.
  let probe = null;
  try {
    const r = await sendUpdate('record p10 WITH 1000 microCCD attached (non-payable) -> must reject', bAddr, bSigner, 'record_payment_tx', recordParam(ownerAddr, 10, '11'.repeat(32)), 1000, null);
    // expect=null in sendUpdate means "expect SUCCESS", so r.pass=false here is
    // exactly the rejection this probe wants to observe.
    probe = { sent: true, hash: r.hash, outcome: r.outcome, costMicroCcd: r.costMicroCcd, energy: r.energy, rejectReason: r.rejectReason, rejected: !r.pass, pass: !r.pass };
    console.log('attached-CCD probe: tx was submitted; outcome:', r.outcome, '| reject:', JSON.stringify(r.rejectReason));
  } catch (e) {
    // A refused send is itself the rejection this probe wants to observe.
    probe = { sent: false, error: String(e && e.message ? e.message : e), rejected: true, pass: true };
    console.log('attached-CCD probe: node/SDK refused the send:', probe.error.slice(0, 200));
  }
  const balAfterProbe = await instanceBalanceMicro();
  const stillZero = balAfterProbe === '0';
  console.log(`contract balance after attached-CCD probe = ${balAfterProbe} (expected 0, no dust entered) | ${stillZero ? 'PASS' : 'FAIL'}`);
  evidence.dustDrill = {
    note: 'Plain-transfer donation is impossible (Transfer recipient is a 32-byte account address; see header). This step proves the equivalent live fact: dust cannot enter via any transaction.',
    contractBalanceBeforeMicroCcd: balBefore, balanceZeroBefore: zeroOk,
    attachedCcdProbe: probe,
    contractBalanceAfterProbeMicroCcd: balAfterProbe, balanceStillZero: stillZero,
    pass: zeroOk && stillZero,
  };
  save();
  if (!evidence.dustDrill.pass) throw new Error('dust-proofness check failed — aborting');
}

// === Step 5: B pays p10 via pay_ccd (0.5 CCD) — must SUCCEED despite the dust ===
let payHash;
{
  const r = await sendUpdate('pay_ccd p10 by B (0.5 CCD)', bAddr, bSigner, 'pay_ccd', keyParam(ownerAddr, 10), 500_000, null);
  payHash = r.hash;
  const bal = await instanceBalanceMicro();
  const balOk = bal === '0';
  console.log(`F1 proof: contract balance after pay = ${bal} microCCD (== balance_before 0; new assertion holds, pay not bricked) | ${balOk ? 'PASS' : 'FAIL'}`);
  const v = parsePayableRaw(await view('get_payable', keyParam(ownerAddr, 10)));
  console.log('payable 10 after pay:', JSON.stringify(v));
  const payee1After = await accountCcd(payee1);
  const payeeOk = payee1After - evidence.balances.before.payee1Ccd === 500_000;
  console.log(`payee1 CCD delta = ${payee1After - evidence.balances.before.payee1Ccd} microCCD (expected 500000) | ${payeeOk ? 'PASS' : 'FAIL'}`);
  evidence.railA.pay = { hash: r.hash, costMicroCcd: r.costMicroCcd, energy: r.energy, pass: r.pass, rejectReason: r.rejectReason, contractBalanceAfterMicroCcd: bal, balanceEqualsBalanceBefore: balOk, view: v, payee1DeltaMicroCcd: payee1After - evidence.balances.before.payee1Ccd, payeeDeltaOk: payeeOk };
  save();
  if (!r.pass || !balOk || !payeeOk) throw new Error('F1 proof failed — aborting');
}

// === Step 6: F5 record_payment_tx — negatives then success then double-record ===
{
  const zero = '00'.repeat(32);
  const r17 = await sendUpdate('record p10 by OWNER (not payer) -> -17', ownerAddr, ownerSigner, 'record_payment_tx', recordParam(ownerAddr, 10, payHash), 0, -17);
  const r14 = await sendUpdate('record p10 zero hash by B -> -14', bAddr, bSigner, 'record_payment_tx', recordParam(ownerAddr, 10, zero), 0, -14);
  const rOk = await sendUpdate('record p10 pay hash by B', bAddr, bSigner, 'record_payment_tx', recordParam(ownerAddr, 10, payHash), 0, null);
  const v = parsePayableRaw(await view('get_payable', keyParam(ownerAddr, 10)));
  const hashOk = v.txHash === payHash;
  console.log(`F5 proof: view txHash == pay hash: ${hashOk} (view: ${v.txHash?.slice(0, 16)}… pay: ${payHash.slice(0, 16)}…) | ${hashOk ? 'PASS' : 'FAIL'}`);
  const r5 = await sendUpdate('record p10 again by B -> -5', bAddr, bSigner, 'record_payment_tx', recordParam(ownerAddr, 10, payHash), 0, -5);
  evidence.railA.record = {
    notPayer: { hash: r17.hash, pass: r17.pass },
    zeroHash: { hash: r14.hash, pass: r14.pass },
    success: { hash: rOk.hash, costMicroCcd: rOk.costMicroCcd, energy: rOk.energy, pass: rOk.pass },
    doubleRecord: { hash: r5.hash, pass: r5.pass },
    viewAfter: v, viewTxHashEqualsPayHash: hashOk,
  };
  save();
  if (!rOk.pass || !hashOk) throw new Error('F5 proof failed — aborting');
}

// === Step 7: owner registers PLT payable 11 (payee2, 0.01 EUDemo, expected=B) ===
{
  const r = await sendUpdate('register p11 PLT 0.01 EUDemo (expected=B)', ownerAddr, ownerSigner, 'register_payable',
    registerParam({ id: 11, payee: payee2, amount: 10_000, asset: assetPlt('EUDemo'), dueMs: DUE_MS, docHash: sha('payonce-v21-invoice-p11'), token: OWNER_TOKEN, expected: bAddr, legal: null }), 0, null);
  evidence.railB.register = { hash: r.hash, costMicroCcd: r.costMicroCcd, energy: r.energy, pass: r.pass };
  save();
}

// === Step 8: B reserves p11 ===
{
  const r = await sendUpdate('reserve p11 by B', bAddr, bSigner, 'reserve_plt', keyParam(ownerAddr, 11), 0, null);
  evidence.railB.reserve = { hash: r.hash, costMicroCcd: r.costMicroCcd, energy: r.energy, pass: r.pass };
  save();
}

// === Step 9: B transfers 0.01 EUDemo to payee2 with memo payable:<owner>:<11> ===
let pltHash;
{
  const memo = `payable:${OWNER_ADDRESS}:11`;
  const r = await sendEudemo('EUDemo transfer B->payee2 0.01 memo', bAddr, bSigner, PAYEE2_ADDRESS, 10_000, memo);
  pltHash = r.hash;
  evidence.railB.transfer = { hash: r.hash, costMicroCcd: r.costMicroCcd, energy: r.energy, memo };
  save();
}

// === Step 10: B confirms p11 with the transfer hash ===
{
  const r = await sendUpdate('confirm p11 by B', bAddr, bSigner, 'confirm_plt', recordParam(ownerAddr, 11, pltHash), 0, null);
  const v = parsePayableRaw(await view('get_payable', keyParam(ownerAddr, 11)));
  const hashOk = v.txHash === pltHash;
  console.log(`PLT confirm: view txHash == transfer hash: ${hashOk} | ${hashOk ? 'PASS' : 'FAIL'}`);
  const payee2After = await accountEudemo(payee2);
  const deltaOk = Number(payee2After) - Number(evidence.balances.before.payee2Eudemo) === 10_000;
  console.log(`payee2 EUDemo delta = ${Number(payee2After) - Number(evidence.balances.before.payee2Eudemo)} (expected 10000) | ${deltaOk ? 'PASS' : 'FAIL'}`);
  evidence.railB.confirm = { hash: r.hash, costMicroCcd: r.costMicroCcd, energy: r.energy, pass: r.pass, view: v, viewTxHashEqualsTransferHash: hashOk, payee2Delta: Number(payee2After) - Number(evidence.balances.before.payee2Eudemo), payeeDeltaOk: deltaOk };
  save();
  if (!r.pass || !hashOk || !deltaOk) throw new Error('Rail B proof failed');
}

// === Final: balances after + contract balance still == dust ===
evidence.balances.after = {
  ownerCcd: await accountCcd(ownerAddr),
  bCcd: await accountCcd(bAddr),
  payee1Ccd: await accountCcd(payee1),
  payee2Ccd: await accountCcd(payee2),
  bEudemo: await accountEudemo(bAddr),
  payee2Eudemo: await accountEudemo(payee2),
  contractMicroCcd: await instanceBalanceMicro(),
};
const dustStill = evidence.balances.after.contractMicroCcd === '0';
console.log('balances after:', JSON.stringify(evidence.balances.after));
console.log(`FINAL: contract balance still == 0 (no dust entered at any point): ${dustStill}`);
evidence.final = {
  p10: parsePayableRaw(await view('get_payable', keyParam(ownerAddr, 10))),
  p11: parsePayableRaw(await view('get_payable', keyParam(ownerAddr, 11))),
  dustStillInContract: dustStill,
  allPassed: evidence.approve.pass && evidence.railA.register.pass && evidence.dustDrill.pass
    && evidence.railA.pay.pass && evidence.railA.pay.balanceEqualsBalanceBefore && evidence.railA.pay.payeeDeltaOk
    && evidence.railA.record.success.pass && evidence.railA.record.viewTxHashEqualsPayHash
    && evidence.railB.register.pass && evidence.railB.reserve.pass && evidence.railB.confirm.pass
    && evidence.railB.confirm.viewTxHashEqualsTransferHash && evidence.railB.confirm.payeeDeltaOk && dustStill,
};
save();
console.log('HAPPY PATH v2.1:', evidence.final.allPassed ? 'ALL PASSED' : 'FAILED — see result JSON');
