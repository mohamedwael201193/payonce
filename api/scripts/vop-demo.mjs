// vop-demo.mjs — on-chain Verification of Payee evidence on payable_registry_v3 (TESTNET only).
// Runs as a Render one-off job on payonce-api (keys stay in the service env, never printed).
//   node api/scripts/vop-demo.mjs <phase>
// Phases (each prints RESULT {json} with public data only; nothing is ever resubmitted):
//   status        read-only: config, balances, payee records, acks
//   standin-bind  owner binds ITSELF as payee under a clearly labelled TESTNET STAND-IN name
//   fraud-proof   headless V1 presentation for the "fraud" account (EU nationality, personal IdP 0)
//   fraud-bind    seller proposes the fraud account as new payee; the fraud account accepts (fee sponsored)
//   fraud-attempt check_payee -> NO_MATCH; relayer refuses to sponsor; a direct pay attempt reverts (-29 or -30)
//   legit         buyer: check_payee MATCH -> acknowledge (sponsored) -> seller registers -> buyer pay_ccd (sponsored)
import {
  AccountAddress, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy, SequenceNumber, TransactionExpiry,
  Transaction, Payload, TransactionHash, VerificationRequestV1, VerifiablePresentationV1, IdentityProviderDID,
  CredentialRegistrationId, ConcordiumHdWallet,
} from '@concordium/web-sdk';
import { createHash } from 'node:crypto';
import { vClient, CONSENT_DOMAIN, LAB_IDP_INDEX } from '../src/consent.mjs';
import { signers } from '../src/chain-v2.mjs';
import { kvGet, kvPut } from '../src/store.mjs';
import { V3, v3Label, getConfigV3, getPayeeRecord, getPayeeAck, getPayableV3, serProposePayee, serAcceptPayee, serRegisterPayable, serPayableKey } from '../src/vop-chain.mjs';
import { createRelayer } from '../src/relayer.mjs';
import { createVopService } from '../src/vop-service.mjs';
import { verifyPresentationKeyless } from '../src/vop-routes.mjs';
import { legalNameHash, canonicalJson, sha256Hex, vopNonceHex } from '../src/vop.mjs';
import { OWNER_TOKEN } from '../src/config.mjs';

const PHASE = process.argv[2] ?? 'status';
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const c = vClient();
const S = await signers();
// Roles: seller = owner 42jaZZ (agent token 1476); buyer agent = seller2 3ARQvc (single key);
// "fraud" payee = 4MvdME (seed identity 0/1, credential 1, single key). 3cjnRy is a 2-of-3 multisig account and is
// not used (its credential index does not match the HD path, and the JS SDK mishandles multisig contract calls).
const SELLER = S.owner; const BUYER = S.seller2; const FRAUD = S.sellerB;
const NAME = 'PayOnce Labs';
const STANDIN = { account: SELLER.address, legal_name: NAME, country: 'DK', label: 'TESTNET STAND-IN: no Global FinReg company identity issued to PayOnce yet; this name is declared by PayOnce, not proven by a business identity' };
const relayer = createRelayer({ grpc: async () => c, sponsor: async () => S.owner });
const vop = createVopService({ grpc: async () => c, kv: { get: kvGet, put: kvPut }, verifyPresentation: verifyPresentationKeyless });
const out = { phase: PHASE, contract: v3Label() };
const done = async () => { await kvPut('vop_demo', `${PHASE}-${Date.now()}`, out).catch(() => {}); console.log('RESULT', J(out)); process.exit(0); };

async function ccd(addr) { const i = await c.getAccountInfo(AccountAddress.fromBase58(addr)); return (Number(i.accountAmount.microCcdAmount) / 1e6).toFixed(6); }
async function finalized(hash, ms = 180_000) {
  const st = await c.waitForTransactionFinalization(TransactionHash.fromHexString(hash), ms);
  const s = JSON.parse(J(st));
  const sum = s.summary ?? s;
  const reject = sum?.transactionType && sum?.rejectReason ? sum.rejectReason : null;
  return { hash, block: s.blockHash ?? null, outcome: reject ? 'rejected' : 'success', reject, cost_ccd: sum?.cost ? (Number(sum.cost) / 1e6).toFixed(6) : null, sponsor: sum?.sponsorDetails ?? null };
}
async function invoke(sender, entrypoint, paramBuf, amount = 0n) {
  const r = await c.invokeContract({ invoker: AccountAddress.fromBase58(sender), contract: ContractAddress.create(V3.index, V3.subindex), method: ReceiveName.fromString(`${V3.name}.${entrypoint}`), parameter: Parameter.fromBuffer(paramBuf), amount: CcdAmount.fromMicroCcd(amount) });
  return r.tag === 'success' ? { ok: true, energy: Number(r.usedEnergy.value) } : { ok: false, reject: r.reason?.rejectReason ?? J(r.reason).slice(0, 200) };
}
async function direct(from, entrypoint, paramBuf, { amount = 0n, energy = 20000n, mustSucceed = true } = {}) {
  const pre = await invoke(from.address, entrypoint, paramBuf, amount);
  if (mustSucceed && !pre.ok) throw new Error(`${entrypoint} would reject (${pre.reject}); not sent`);
  const info = await c.getAccountInfo(AccountAddress.fromBase58(from.address));
  const tx = Transaction.updateContract(Payload.updateContract({ amount: CcdAmount.fromMicroCcd(amount), address: ContractAddress.create(V3.index, V3.subindex), receiveName: ReceiveName.fromString(`${V3.name}.${entrypoint}`), message: Parameter.fromBuffer(paramBuf) }), Energy.create(energy))
    .addMetadata({ sender: AccountAddress.fromBase58(from.address), nonce: info.accountNonce, expiry: TransactionExpiry.futureMinutes(8) }).build();
  const f = await Transaction.signAndFinalize(tx, from.signer);
  const h = (await c.sendTransaction(f)).toString();
  console.log(`[${entrypoint}] sent ${h}`);
  return { entrypoint, sender: from.address, invoke_preview: pre, ...(await finalized(h)) };
}
async function sponsored(from, entrypoint, paramBuf, amount = 0n) {
  const before = await ccd(from.address);
  const b = await relayer.build({ sender: from.address, entrypoint, parameter: paramBuf.toString('hex'), amount_micro_ccd: amount.toString() });
  const signed = await Transaction.sign(Transaction.signableFromJSON(b.transaction), from.signer);
  const sub = await relayer.submit({ transaction: J(Transaction.toJSON(signed)) });
  console.log(`[${entrypoint}] sponsored ${sub.tx_hash} (${sub.submitted})`);
  const fin = await finalized(sub.tx_hash);
  return { entrypoint, sender: from.address, sponsor: sub.sponsor, sender_ccd_before: before, sender_ccd_after: await ccd(from.address), attached_micro_ccd: amount.toString(), ...fin };
}

if (PHASE === 'status') {
  out.config = await getConfigV3(c);
  out.accounts = {};
  for (const [k, a] of Object.entries({ seller: SELLER.address, buyer: BUYER.address, fraud: FRAUD.address })) out.accounts[k] = { address: a, ccd: await ccd(a) };
  out.book_seller_self = await getPayeeRecord(c, SELLER.address, SELLER.address);
  out.book_fraud = await getPayeeRecord(c, SELLER.address, FRAUD.address);
  out.ack_buyer_self = await getPayeeAck(c, BUYER.address, SELLER.address, SELLER.address);
  for (const id of [1, 2, 3]) out[`payable_${id}`] = await getPayableV3(c, SELLER.address, id).catch((e) => String(e.message));
  await done();
}

if (PHASE === 'standin-bind') {
  const existing = await getPayeeRecord(c, SELLER.address, SELLER.address);
  if (existing) { out.skipped = 'already proposed'; out.record = existing; await done(); }
  await kvPut('vop_standin', SELLER.address, STANDIN);
  const anchor = sha256Hex(canonicalJson(STANDIN));
  const identity = { kind: 1, idp_index: LAB_IDP_INDEX, legal_name_hash: legalNameHash(NAME), country: 'DK', proof_anchor: anchor, anchor_tx: null };
  out.standin = STANDIN; out.anchor = anchor; out.identity = identity;
  out.propose = await direct(SELLER, 'propose_payee', serProposePayee({ payee: SELLER.address, agent_token: OWNER_TOKEN, identity }));
  out.record = await getPayeeRecord(c, SELLER.address, SELLER.address);
  await done();
}

if (PHASE === 'fraud-proof' && process.env.FRESH !== '1' && (await kvGet('vop_demo_pres', FRAUD.address))) {
  // Resume: the presentation was built before (its VRA is on chain); only the keyless intake is retried.
  const saved = await kvGet('vop_demo_pres', FRAUD.address);
  out.resumed = true; out.vra_tx = saved.vra_tx;
  out.submit = await vop.submitProof({ payee: FRAUD.address, presentation: saved.presentation, version: 'v1', nonce_expected: saved.nonce, anchor_tx: null });
  await done();
}

if (PHASE === 'fraud-proof') {
  // Headless V1 presentation from the seed-derived credential of the fraud account (identity 0/1, credential 1):
  // it proves EU nationality and reveals no name. Anchored request (VRA) sent by the owner.
  const nonce = vopNonceHex({ contract: v3Label(), seller: SELLER.address, payee: FRAUD.address, legalName: NAME, country: 'DK' });
  const context = VerificationRequestV1.createSimpleContext(new Uint8Array(Buffer.from(nonce, 'hex')), `payonce-vop:${FRAUD.address}`, CONSENT_DOMAIN, `PayOnce Verification of Payee: account ${FRAUD.address} proves its identity facts`);
  const claims = VerificationRequestV1.claimsBuilder().addAccountClaims([new IdentityProviderDID('Testnet', 0)], (b) => b.addEUNationality()).getClaims();
  const req = await VerificationRequestV1.createAndAnchor(c, { sender: AccountAddress.fromBase58(SELLER.address), signer: SELLER.signer }, context, claims, { app: 'payonce-vop', payee: FRAUD.address });
  const vra = (req.transactionRef?.toString?.() ?? String(req.transactionRef)).toLowerCase();
  console.log('[vra] sent', vra);
  out.vra = await finalized(vra);
  const request = VerificationRequestV1.fromJSON(JSON.parse(J(req.toJSON())));
  const sc = request.subjectClaims?.[0];
  const statements = VerifiablePresentationV1.noRevealRequestedStatements(sc.statements);
  const acctInfo = JSON.parse(J(await c.getAccountInfo(AccountAddress.fromBase58(FRAUD.address))));
  const credIdHex = Object.values(acctInfo.accountCredentials ?? {})[0]?.value?.contents?.credId;
  const vclaims = [VerifiablePresentationV1.createAccountClaims('Testnet', CredentialRegistrationId.fromHexString(credIdHex), 0, statements)];
  const hd = ConcordiumHdWallet.fromSeedPhrase((process.env.CONCORDIUM_WALLET_SEED_PHRASE || '').trim(), 'Testnet');
  const rand = Buffer.from(hd.getAttributeCommitmentRandomness(0, 1, 1, 'nationality')).toString('hex');
  const presentation = await VerifiablePresentationV1.createFromAnchor(c, request, vclaims, [{ type: 'account', issuer: 0, values: { nationality: 'DK' }, randomness: { nationality: rand } }], []);
  const direct0 = await VerifiablePresentationV1.verifyWithNode(presentation, c, 'Testnet').catch((e) => ({ type: 'threw', error: String(e?.message ?? e) }));
  out.verify_direct = { type: direct0?.type, error: direct0?.error ? String(direct0.error?.message ?? direct0.error).slice(0, 300) : null };
  console.log('[verify direct]', J(out.verify_direct));
  const pj = JSON.parse(J(presentation.toJSON ? presentation.toJSON() : presentation));
  const rt = await VerifiablePresentationV1.verifyWithNode(VerifiablePresentationV1.fromJSON(pj), c, 'Testnet').catch((e) => ({ type: 'threw', error: String(e?.message ?? e) }));
  out.verify_roundtrip = { type: rt?.type, error: rt?.error ? String(rt.error?.message ?? rt.error).slice(0, 300) : null };
  console.log('[verify roundtrip]', J(out.verify_roundtrip));
  await kvPut('vop_demo_pres', FRAUD.address, { presentation: pj, nonce, vra_tx: vra });
  out.vra_tx = vra;
  out.submit = await vop.submitProof({ payee: FRAUD.address, presentation: pj, version: 'v1', nonce_expected: nonce, anchor_tx: null });
  await done();
}

if (PHASE === 'fraud-bind') {
  const proofAnchor = process.env.FRAUD_ANCHOR;
  if (!/^[0-9a-f]{64}$/.test(proofAnchor ?? '')) throw new Error('FRAUD_ANCHOR env (from fraud-proof) required');
  const existing = await getPayeeRecord(c, SELLER.address, FRAUD.address);
  // The attacker claims the seller's company name for its own account.
  const identity = { kind: 1, idp_index: 0, legal_name_hash: legalNameHash(NAME), country: 'DK', proof_anchor: proofAnchor, anchor_tx: null };
  if (!existing) out.propose = await direct(SELLER, 'propose_payee', serProposePayee({ payee: FRAUD.address, agent_token: OWNER_TOKEN, identity }));
  const rec = await getPayeeRecord(c, SELLER.address, FRAUD.address);
  if (rec.status === 'Proposed') out.accept = await sponsored(FRAUD, 'accept_payee', serAcceptPayee({ seller: SELLER.address, version: rec.version, proof_anchor: proofAnchor }));
  out.record = await getPayeeRecord(c, SELLER.address, FRAUD.address);
  await done();
}

if (PHASE === 'fraud-attempt') {
  out.check = await vop.check({ seller: SELLER.address, payee: FRAUD.address, legal_name: NAME, buyer: BUYER.address });
  const id = 1;
  let p = await getPayableV3(c, SELLER.address, id);
  if (!p) {
    out.register = await direct(SELLER, 'register_payable', serRegisterPayable({ payable_id: id, payee: FRAUD.address, amount: 1_000_000n, asset: 'CCD', due_ms: Date.now() + 7 * 864e5, doc_hash: sha256Hex(`payonce-vop-demo fraud invoice ${NAME}`), agent_token: OWNER_TOKEN, expected_payer: BUYER.address, legal_ref: null }));
    p = await getPayableV3(c, SELLER.address, id);
  }
  out.payable = p;
  try { await relayer.build({ sender: BUYER.address, entrypoint: 'pay_ccd', parameter: serPayableKey({ seller: SELLER.address, payable_id: id }).toString('hex'), amount_micro_ccd: p.amount }); out.relayer = 'UNEXPECTED: built'; } catch (e) { out.relayer_refused = { code: e.code, message: e.message }; }
  if (process.env.SEND_REVERT === '1') out.revert = await direct(BUYER, 'pay_ccd', serPayableKey({ seller: SELLER.address, payable_id: id }), { amount: BigInt(p.amount), energy: 8000n, mustSucceed: false });
  else out.revert_preview = await invoke(BUYER.address, 'pay_ccd', serPayableKey({ seller: SELLER.address, payable_id: id }), BigInt(p.amount));
  await done();
}

if (PHASE === 'register-legit') {
  const id = 2;
  let p = await getPayableV3(c, SELLER.address, id);
  if (!p) out.register = await direct(SELLER, 'register_payable', serRegisterPayable({ payable_id: id, payee: SELLER.address, amount: 1_000_000n, asset: 'CCD', due_ms: Date.now() + 7 * 864e5, doc_hash: sha256Hex(`payonce-vop-demo invoice ${NAME} #2`), agent_token: OWNER_TOKEN, expected_payer: BUYER.address, legal_ref: null }));
  out.payable = await getPayableV3(c, SELLER.address, id);
  await done();
}

if (PHASE === 'legit') {
  const chk = await vop.check({ seller: SELLER.address, payee: SELLER.address, legal_name: NAME, buyer: BUYER.address });
  out.check = { verdict: chk.verdict, payable: chk.payable, standin: chk.standin, evidence_hash: chk.evidence_hash, reasons: chk.reasons, checks: chk.checks, buyer_ack: chk.buyer_ack };
  if (!chk.payable) { out.stopped = 'agent policy: not payable'; await done(); }
  if (!chk.buyer_ack?.current) out.ack = await sponsored(BUYER, 'acknowledge_payee', Buffer.from(chk.acknowledge.parameter, 'hex'));
  const id = 2;
  let p = await getPayableV3(c, SELLER.address, id);
  if (!p) {
    out.register = await direct(SELLER, 'register_payable', serRegisterPayable({ payable_id: id, payee: SELLER.address, amount: 1_000_000n, asset: 'CCD', due_ms: Date.now() + 7 * 864e5, doc_hash: sha256Hex(`payonce-vop-demo invoice ${NAME} #2`), agent_token: OWNER_TOKEN, expected_payer: BUYER.address, legal_ref: null }));
    p = await getPayableV3(c, SELLER.address, id);
  }
  if (p.status.tag === 'Unpaid') out.pay = await sponsored(BUYER, 'pay_ccd', serPayableKey({ seller: SELLER.address, payable_id: id }), BigInt(p.amount));
  out.payable = await getPayableV3(c, SELLER.address, id);
  await done();
}
console.log('unknown phase', PHASE); process.exit(1);
