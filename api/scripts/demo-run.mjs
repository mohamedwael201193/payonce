// demo-run.mjs — one fresh, real run on the v3 DEMO book (90 s cooling-off) for /demo (GET /api/demo/run).
// Run with PAYONCE_V3_INDEX=<demo book index> (the API spawns it; or a Render one-off job).
// Steps (testnet, real transactions, nothing resubmitted):
//   setup once: seller binds its payee (labelled stand-in name); buyer agent acknowledges it (fee sponsored)
//   1 seller registers a 0.5 CCD invoice for the buyer agent
//   2 buyer agent: check_payee -> Match -> pay_ccd (fee sponsored)                      -> paid
//   3 buyer agent pays the same invoice again                                          -> chain refuses -5 WrongStatus
//   4 impostor: a brand-new account (0 CCD) is put in as payee and accepts (sponsored);
//     check_payee answers for it; an invoice to it is refused by the chain             -> -29 PayeeNotMature
// Writes the DemoRun (frontend/src/demo/demoData.ts shape) to kv demo_run/latest and prints RESULT.
import {
  AccountAddress, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy, TransactionExpiry, Transaction, Payload,
  TransactionHash, ConcordiumHdWallet, buildBasicAccountSigner, getAccountAddress,
} from '@concordium/web-sdk';
import * as sdk from '@concordium/web-sdk';
import { vClient } from '../src/consent.mjs';
import { signers } from '../src/chain-v2.mjs';
import { kvGet, kvPut } from '../src/store.mjs';
import { V3, v3Label, V3_ERRORS, getConfigV3, getPayeeRecord, getPayeeAck, getPayableV3, serProposePayee, serAcceptPayee, serRegisterPayable, serPayableKey } from '../src/vop-chain.mjs';
import { createRelayer } from '../src/relayer.mjs';
import { createVopService } from '../src/vop-service.mjs';
import { verifyPresentationKeyless } from '../src/vop-routes.mjs';
import { legalNameHash, canonicalJson, sha256Hex } from '../src/vop.mjs';
import { OWNER_TOKEN } from '../src/config.mjs';

if (String(V3.index) === '13172' && process.env.DEMO_ALLOW_LIVE_BOOK !== '1') { console.log('refusing: demo runs use the 90 s demo book (set PAYONCE_V3_INDEX)'); process.exit(1); }
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const WP = 'https://wallet-proxy.testnet.concordium.com';
const c = vClient();
const S = await signers();
const SELLER = S.owner; const BUYER = S.seller2;
const NAME = 'PayOnce Labs';
const STANDIN = { account: SELLER.address, legal_name: NAME, country: 'DK', label: 'TESTNET STAND-IN: no Global FinReg company identity issued to PayOnce yet; this name is declared by PayOnce, not proven by a business identity' };
const relayer = createRelayer({ grpc: async () => c, sponsor: async () => S.owner });
const vop = createVopService({ grpc: async () => c, kv: { get: kvGet, put: kvPut }, verifyPresentation: verifyPresentationKeyless });
const ERR = { '-5': 'WrongStatus', ...V3_ERRORS };
const log = { contract: v3Label(), started_at: new Date().toISOString(), txs: {} };

async function fin(h) {
  const s = JSON.parse(J(await c.waitForTransactionFinalization(TransactionHash.fromHexString(h), 180_000)));
  const sum = s.summary ?? {};
  const rr = sum.rejectReason?.rejectReason ?? sum.rejectReason?.contents?.rejectReason ?? null;
  return { hash: h, ok: !sum.rejectReason, reject: rr != null ? Number(rr) : null, cost_micro: sum.cost ?? null, sponsor: sum.sponsor ?? null };
}
async function send(from, entrypoint, param, { amount = 0n, energy = 20000n, expectReject = false } = {}) {
  const info = await c.getAccountInfo(AccountAddress.fromBase58(from.address));
  const tx = Transaction.updateContract(Payload.updateContract({ amount: CcdAmount.fromMicroCcd(amount), address: ContractAddress.create(V3.index, V3.subindex), receiveName: ReceiveName.fromString(`${V3.name}.${entrypoint}`), message: Parameter.fromBuffer(param) }), Energy.create(energy))
    .addMetadata({ sender: AccountAddress.fromBase58(from.address), nonce: info.accountNonce, expiry: TransactionExpiry.futureMinutes(8) }).build();
  const h = (await c.sendTransaction(await Transaction.signAndFinalize(tx, from.signer))).toString();
  console.log(`[${entrypoint}] ${h}`);
  const r = await fin(h);
  if (!expectReject && !r.ok) throw new Error(`${entrypoint} rejected ${r.reject} (${h})`);
  return r;
}
async function sponsored(from, entrypoint, param, amount = 0n) {
  const p = await relayer.prepare({ sender: from.address, entrypoint, parameter: param.toString('hex'), amount_micro_ccd: amount.toString() });
  const signed = await Transaction.sign(Transaction.signableFromJSON(p.transaction), from.signer);
  const h = (await c.sendTransaction(Transaction.finalize(signed))).toString();
  console.log(`[${entrypoint} sponsored] ${h}`);
  const r = await fin(h);
  if (!r.ok) throw new Error(`${entrypoint} rejected ${r.reject} (${h})`);
  return r;
}
async function ccdMicro(a) { const i = JSON.parse(J(await c.getAccountInfo(AccountAddress.fromBase58(a)))); return BigInt(i.accountAmount?.microCcdAmount ?? i.accountAmount); }

/** A brand-new account from the seed's identity 1 (recovered from the testnet IdP), next free credential number. */
async function freshAccount() {
  const hd = ConcordiumHdWallet.fromSeedPhrase((process.env.CONCORDIUM_WALLET_SEED_PHRASE || '').trim(), 'Testnet');
  const g = (await (await fetch(`${WP}/v0/global`)).json()).value;
  const ips = await (await fetch(`${WP}/v2/ip_info`)).json();
  const ip = ips.find((x) => x.ipInfo.ipIdentity === 0);
  const req = sdk.createIdentityRecoveryRequestWithKeys({ idCredSec: hd.getIdCredSec(0, 1).toString('hex'), ipInfo: ip.ipInfo, globalContext: g, timestamp: Math.floor(Date.now() / 1000) });
  const rr = await fetch(`${ip.metadata.recoveryStart}?state=${encodeURIComponent(JSON.stringify({ idRecoveryRequest: req }))}`, { redirect: 'follow' });
  const rtext = await rr.text();
  let idObj; try { idObj = JSON.parse(rtext); } catch { throw new Error(`identity recovery: HTTP ${rr.status} ${rtext.slice(0, 160)}`); }
  idObj = idObj.value ?? idObj;
  if (!idObj?.attributeList) throw new Error(`identity recovery: no identity object (HTTP ${rr.status}) ${rtext.slice(0, 160)}`);
  let cred = Number((await kvGet('demo_run', 'next_cred'))?.n ?? 20);
  for (;; cred++) {
    const addr = getAccountAddress(Buffer.from(hd.getCredentialId(0, 1, cred, g)).toString('hex')).address;
    const ex = await fetch(`${WP}/v0/accBalance/${addr}`).then((x) => x.json()).catch(() => null);
    if (!(ex?.finalizedBalance || ex?.currentBalance)) break;
  }
  await kvPut('demo_run', 'next_cred', { n: cred + 1 });
  const cdp = sdk.createCredentialPayload({ ipInfo: ip.ipInfo, globalContext: g, arsInfos: ip.arsInfos, idObject: idObj, revealedAttributes: [], credNumber: cred, seedAsHex: hd.seedAsHex, net: 'Testnet', identityIndex: 1 }, sdk.TransactionExpiry.futureMinutes(10));
  const address = sdk.getAccountAddress(cdp.unsignedCdi.credId).address;
  const sig = await sdk.signCredentialTransaction(cdp, hd.getAccountSigningKey(0, 1, cred).toString('hex'));
  const bytes = Buffer.from(sdk.serializeCredentialDeploymentTransactionForSubmission(cdp, [sig]));
  const s = await fetch(`${WP}/v0/submitRawTransaction`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: bytes });
  const t = await s.json().catch(() => ({}));
  if (!s.ok || !t.submissionId) throw new Error(`credential deployment not accepted (${s.status} ${J(t).slice(0, 160)})`);
  for (let i = 0; i < 40; i++) {
    await sleep(4000);
    const st = await fetch(`${WP}/v0/submissionStatus/${t.submissionId}`).then((x) => x.json()).catch(() => ({}));
    if (st.status === 'finalized') { if (st.outcome !== 'success') throw new Error(`credential deployment failed ${J(st).slice(0, 160)}`); break; }
    if (i === 39) throw new Error(`credential deployment not finalized after 160 s (submission ${t.submissionId})`);
  }
  return { address, cred, deploy_tx: t.submissionId, signer: buildBasicAccountSigner(hd.getAccountSigningKey(0, 1, cred).toString('hex')) };
}

// cross-process single flight with the API's GET /api/demo/run (and Render one-off jobs)
const lock = await kvGet('demo_run', 'lock');
if (lock?.until_ms > Date.now() && process.env.DEMO_IGNORE_LOCK !== '1') { console.log(`another demo run holds the lock until ${new Date(lock.until_ms).toISOString()}`); process.exit(3); }
await kvPut('demo_run', 'lock', { until_ms: Date.now() + 12 * 60_000, pid: process.pid, started_at: log.started_at });
let step = 'setup';
process.on('uncaughtException', async (e) => { await fail(e); });
process.on('unhandledRejection', async (e) => { await fail(e); });
async function fail(e) {
  const err = { at: new Date().toISOString(), step, error: String(e?.message ?? e).slice(0, 500), txs: log.txs };
  console.error('DEMO_RUN_FAILED', J(err));
  await kvPut('demo_run', 'last_error', err).catch(() => {});
  await kvPut('demo_run', 'lock', { until_ms: 0 }).catch(() => {});
  process.exit(1);
}

// ---- setup (idempotent): seller's payee bound + matured; buyer agent's acknowledgment current ----
log.config = await getConfigV3(c);
let rec = await getPayeeRecord(c, SELLER.address, SELLER.address);
if (!rec) {
  await kvPut('vop_standin', SELLER.address, STANDIN);
  const identity = { kind: 1, idp_index: 0, legal_name_hash: legalNameHash(NAME), country: 'DK', proof_anchor: sha256Hex(canonicalJson(STANDIN)), anchor_tx: null };
  log.txs.bind = (await send(SELLER, 'propose_payee', serProposePayee({ payee: SELLER.address, agent_token: OWNER_TOKEN, identity }))).hash;
  rec = await getPayeeRecord(c, SELLER.address, SELLER.address);
}
while (Date.now() < rec.mature_at_ms + 3000) await sleep(5000);
let chk = await vop.check({ seller: SELLER.address, payee: SELLER.address, legal_name: NAME, buyer: BUYER.address });
if (!chk.buyer_ack?.current) {
  log.txs.ack = (await sponsored(BUYER, 'acknowledge_payee', Buffer.from(chk.acknowledge.parameter, 'hex'))).hash;
  chk = await vop.check({ seller: SELLER.address, payee: SELLER.address, legal_name: NAME, buyer: BUYER.address });
}
if (!chk.payable || !chk.buyer_ack?.current) throw new Error(`setup: not payable (${chk.verdict}, ack ${J(chk.buyer_ack)})`);
if (await ccdMicro(BUYER.address) < 30_000_000n) throw new Error('buyer agent below 30 CCD: top up before demo runs');

step = 'invoice';
// ---- 1 invoice ----
const id = Number((await kvGet('demo_run', 'next_id'))?.n ?? 100);
await kvPut('demo_run', 'next_id', { n: id + 2 });
const AMOUNT = 500_000n; const due = Date.now() + 7 * 864e5;
log.txs.register = (await send(SELLER, 'register_payable', serRegisterPayable({ payable_id: id, payee: SELLER.address, amount: AMOUNT, asset: 'CCD', due_ms: due, doc_hash: sha256Hex(`payonce demo invoice ${id} ${NAME} ${Date.now()}`), agent_token: OWNER_TOKEN, expected_payer: BUYER.address, legal_ref: null }))).hash;
// ---- 2 pay once (sponsored fee) ----
const paid = await sponsored(BUYER, 'pay_ccd', serPayableKey({ seller: SELLER.address, payable_id: id }), AMOUNT);
// ---- 3 pay again: the chain refuses ----
const again = await send(BUYER, 'pay_ccd', serPayableKey({ seller: SELLER.address, payable_id: id }), { amount: AMOUNT, energy: 6000n, expectReject: true });
step = 'impostor_account';
// ---- 4 impostor ----
const imp = await freshAccount();
step = 'impostor_bind';
const impStandin = { account: imp.address, legal_name: NAME, country: 'DK', label: 'IMPOSTOR: claims the seller name; no proof' };
const impIdentity = { kind: 1, idp_index: 0, legal_name_hash: legalNameHash(NAME), country: 'DK', proof_anchor: sha256Hex(canonicalJson(impStandin)), anchor_tx: null };
log.txs.impostor_propose = (await send(SELLER, 'propose_payee', serProposePayee({ payee: imp.address, agent_token: OWNER_TOKEN, identity: impIdentity }))).hash;
const impRec = await getPayeeRecord(c, SELLER.address, imp.address);
log.txs.impostor_accept = (await sponsored(imp, 'accept_payee', serAcceptPayee({ seller: SELLER.address, version: impRec.version, proof_anchor: impIdentity.proof_anchor }))).hash;
log.impostor_ccd_micro = String(await ccdMicro(imp.address));
step = 'impostor_check';
const impCheck = await vop.check({ seller: SELLER.address, payee: imp.address, legal_name: NAME, buyer: BUYER.address });
log.txs.impostor_register = (await send(SELLER, 'register_payable', serRegisterPayable({ payable_id: id + 1, payee: imp.address, amount: AMOUNT, asset: 'CCD', due_ms: due, doc_hash: sha256Hex(`payonce demo impostor invoice ${id + 1} ${Date.now()}`), agent_token: OWNER_TOKEN, expected_payer: BUYER.address, legal_ref: null }))).hash;
const impPay = await send(BUYER, 'pay_ccd', serPayableKey({ seller: SELLER.address, payable_id: id + 1 }), { amount: AMOUNT, energy: 6000n, expectReject: true });

const verdictWord = { MATCH: 'Match', CLOSE_MATCH: 'Close match', NO_MATCH: 'No match', UNVERIFIED: 'Verification not possible' };
const run = {
  live: true,
  generated_at: new Date().toISOString(),
  label: `Fresh run on the v3 demo book ${v3Label()} (cooling-off 90 s; production 24 h+). Testnet. "PayOnce Labs" is a labelled testnet stand-in name.`,
  invoice: { amount: '0.5 CCD', due: new Date(due).toISOString().slice(0, 10) },
  good: { account: SELLER.address, ticks: [`${verdictWord[chk.verdict]}: ${NAME} (testnet stand-in)`, `Payee bound on chain, v${chk.subject.book.version}`, 'Cooling-off over', 'Acknowledged on chain by the buyer agent'] },
  paid: { hash: paid.hash },
  impostor: {
    account: imp.address,
    headline: `${verdictWord[impCheck.verdict]}: a brand-new account (0 CCD) claims "${NAME}". Nothing sent.`,
    refusal: impPay.reject != null ? { code: impPay.reject, name: ERR[String(impPay.reject)] ?? 'Rejected', hash: impPay.hash } : null,
  },
  again: { code: again.reject ?? 0, name: ERR[String(again.reject)] ?? 'Rejected', hash: again.hash },
  detail: {
    ...log, payable_id: id, impostor_payable_id: id + 1, check: { verdict: chk.verdict, payable: chk.payable, evidence_hash: chk.evidence_hash },
    impostor_check: { verdict: impCheck.verdict, payable: impCheck.payable, reasons: impCheck.reasons },
    impostor_account: { address: imp.address, credential: `seed identity 1, credential ${imp.cred}`, deploy_tx: imp.deploy_tx },
    paid_fee: { sponsor: paid.sponsor }, again_reject: again.reject, impostor_reject: impPay.reject,
  },
};
await kvPut('demo_run', 'latest', run);
await kvPut('demo_run', 'lock', { until_ms: 0 });
console.log('RESULT', J(run));
process.exit(0);
