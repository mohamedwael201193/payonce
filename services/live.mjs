// LIVE runner for payable_registry on Concordium TESTNET. One step per invocation: node live.mjs <step>
// Every step appends its result to out/live.json (tx hash in full, outcome, reject reason, CCD/energy cost,
// contract balance after, payee/payer deltas). Secrets (seed, A's key, agent/co-signer keys) are read in-process
// only and never printed. Nothing is registered in the official registry; no third party is paid.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { client, sdk, loadCfg, ownerAddr, ownerSigner, signerFor, sendUpdate } from '../core/lib.mjs';
import { coSignJson, decide, Refuse, viewPayable } from './cosigner-payable.mjs';
import { createHash } from 'crypto';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(DIR, '..', 'core');
const OUT = path.join(DIR, 'out');
mkdirSync(OUT, { recursive: true });
const DEPLOY = path.join(OUT, 'deploy.json');
const LIVE = path.join(OUT, 'live.json');
const cfg = loadCfg();
const T = sdk.Transaction;
const DAY = 86_400_000;
const RESERVATION_SECS = 300;
const CIS8004 = { index: 13144, subindex: 0 }; // OUR CIS-8004 instance (official module), token 0x0100.. = grocer, owner M, Active
const GROCER_TOKEN = Array.from(Buffer.from('0100000000000000', 'hex'));

const A = { address: ownerAddr(), signer: ownerSigner() };
const M = { address: cfg.M.address, signer: signerFor(cfg.M.identity, cfg.M.cred) };
const OPS = { address: cfg.ops.address, signer: signerFor(cfg.ops.identity, cfg.ops.cred) };
const D = { address: cfg.v2.D.address };
const C3 = cfg.v2.C3.address;
const agentKey = JSON.parse(readFileSync(path.join(CORE, 'agent-secrets.v2.private.json'), 'utf8')).signingKey;
const agentSigner = sdk.buildBasicAccountSigner(agentKey);
const mSponsor = M.signer;

const sha = s => createHash('sha256').update(s).digest('hex');
const bytes32 = hex => Array.from(Buffer.from(hex, 'hex'));
const ccdOf = micro => Number(micro) / 1e6;
const loadJson = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : d);
const save = (f, v) => writeFileSync(f, JSON.stringify(v, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
const sanitize = m => String(m).replace(/\b[0-9a-f]{64}\b/gi, '<64hex>').replace(/(\S+\s+){11,}\S+/g, '<redacted-sequence>');

const deploy = () => loadJson(DEPLOY, null);
const reg = () => { const d = deploy(); return sdk.ContractAddress.create(d.instance.index, d.instance.subindex); };
const RN = sdk.ContractName.fromStringUnchecked('payable_registry');
let _s;
async function schema() { const d = deploy(); return (_s ??= await client.getEmbeddedSchema(sdk.ModuleReference.fromHexString(d.moduleRef))); }
async function enc(entry, value) {
  const s = await schema();
  return sdk.serializeUpdateContractParameters(RN, sdk.EntrypointName.fromStringUnchecked(entry), value, s.buffer, s.version);
}
async function encInit(value) {
  const s = await schema();
  return sdk.serializeInitContractParameters(RN, value, s.buffer, s.version);
}
async function regBalanceMicro() {
  const i = await client.getInstanceInfo(reg());
  return BigInt(i.amount.microCcdAmount ?? i.amount);
}
async function accBal(addr) {
  const ai = await client.getAccountInfo(sdk.AccountAddress.fromBase58(addr));
  return { ccd: BigInt(ai.accountAmount.microCcdAmount), eudemo: BigInt(ai.accountTokens?.find(x => String(x.id) === 'EUDemo')?.state.balance.value ?? 0) };
}
const nextNonce = async addr => (await client.getNextAccountNonce(sdk.AccountAddress.fromBase58(addr))).nonce;

function record(step, data) {
  const all = loadJson(LIVE, []);
  all.push({ step, at: new Date().toISOString(), ...data });
  save(LIVE, all);
  console.log(JSON.stringify({ step, ...data }, (k, x) => (typeof x === 'bigint' ? x.toString() : x), 2));
}

// Contract update from a plain account (A or M or OPS). Returns outcome and records it.
async function contractCall(step, who, entry, value, { amount = 0n, energy = 6000n, expectRevert = false, note = '' } = {}) {
  const payeeBefore = step.payeeBefore;
  const before = await regBalanceMicro();
  const r = await sendUpdate({ senderAddr: who.address, signer: who.signer, contract: reg(), method: `payable_registry.${entry}`, param: await enc(entry, value), energy, amount: amount });
  const rr = r.summary.rejectReason;
  const out = {
    hash: r.hash,
    entry,
    sender: who.address,
    outcome: rr ? 'reverted' : 'success',
    rejectReason: rr ? JSON.stringify(rr, (k, x) => (typeof x === 'bigint' ? x.toString() : x)) : null,
    ccdCostMicro: String(r.summary.cost),
    energy: String(r.summary.energyCost ?? ''),
    attachedMicro: String(amount),
    contractBalanceBeforeMicro: before.toString(),
    contractBalanceAfterMicro: (await regBalanceMicro()).toString(),
    note,
  };
  if (expectRevert !== !!rr) out.unexpected = true;
  return out;
}

const steps = {};

steps.deploy = async () => {
  if (deploy()) return console.log('already deployed', deploy().instance);
  const wasm = readFileSync(path.join(DIR, 'contracts', 'payable_registry', 'payable_registry.wasm.v1'));
  const nn = await nextNonce(A.address);
  const dtx = { type: sdk.AccountTransactionType.DeployModule, header: { sender: sdk.AccountAddress.fromBase58(A.address), nonce: nn, expiry: sdk.TransactionExpiry.futureMinutes(10) }, payload: { source: new Uint8Array(wasm.subarray(8)), version: 1 } };
  const dh = await client.sendAccountTransaction(dtx, await sdk.signTransaction(dtx, A.signer));
  const ds = await client.waitForTransactionFinalization(dh, 300000);
  const moduleRef = (ds.summary.moduleDeployed?.contents ?? ds.summary.moduleDeployed).toString();
  const moduleCost = String(ds.summary.cost);
  const sNow = await client.getEmbeddedSchema(sdk.ModuleReference.fromHexString(moduleRef));
  const param = sdk.serializeInitContractParameters(RN, { cis8004: CIS8004, reservation_secs: RESERVATION_SECS }, sNow.buffer, sNow.version);
  const nn2 = await nextNonce(A.address);
  const itx = { type: sdk.AccountTransactionType.InitContract, header: { sender: sdk.AccountAddress.fromBase58(A.address), nonce: nn2, expiry: sdk.TransactionExpiry.futureMinutes(10) }, payload: { amount: sdk.CcdAmount.zero(), moduleRef: sdk.ModuleReference.fromHexString(moduleRef), initName: RN, param, maxContractExecutionEnergy: sdk.Energy.create(6000) } };
  const ih = await client.sendAccountTransaction(itx, await sdk.signTransaction(itx, A.signer));
  const is = await client.waitForTransactionFinalization(ih, 300000);
  const addr = is.summary.contractInitialized?.address;
  if (!addr) throw new Error('init did not create an instance: ' + JSON.stringify(is.summary.rejectReason ?? is.summary.type));
  const d = { moduleRef, moduleSize: wasm.length - 8, deployTx: dh.toString(), deployCostMicro: moduleCost, instance: { index: Number(addr.index), subindex: Number(addr.subindex) }, initTx: ih.toString(), initCostMicro: String(is.summary.cost), cis8004: CIS8004, reservationSecs: RESERVATION_SECS };
  save(DEPLOY, d);
  record('deploy', { deployTx: d.deployTx, deployCostMicro: moduleCost, moduleRef, initTx: d.initTx, initCostMicro: d.initCostMicro, instance: d.instance, contractBalanceAfterMicro: (await regBalanceMicro()).toString() });
};

const DUE = () => new Date(Date.now() + DAY).toISOString();
const reg1 = (id, asset, amount, payee) => ({ payable_id: id, payee, amount, asset, due: DUE(), doc_hash: bytes32(sha(`PAYABLE-LAB invoice #${id} amount ${amount} asset ${JSON.stringify(asset)} (testnet, not a real invoice)`)), agent_token: GROCER_TOKEN });
const invoiceDoc = (id, amount, asset, payee) => ({ invoice: id, seller: M.address, payee, amount, asset, note: 'PAYABLE-LAB testnet invoice, not a real invoice' });

steps.regCcd1 = async () => { const p = reg1(1, { Ccd: [] }, 500_000, D.address); save(path.join(OUT, 'invoice-1.json'), invoiceDoc(1, 500_000, 'CCD', D.address)); record('register-ccd-1', await contractCall({}, M, 'register_payable', p, { note: 'seller M, agent token 0100.. (grocer, Active, owner M)' })); };
steps.regPlt2 = async () => { const p = reg1(2, { Plt: ['EUDemo'] }, 10_000, OPS.address); save(path.join(OUT, 'invoice-2.json'), invoiceDoc(2, 10_000, 'EUDemo', OPS.address)); record('register-plt-2', await contractCall({}, M, 'register_payable', p, { note: 'seller M, payee OPS (allow-listed for EUDemo)' })); };
steps.regCcd4 = async () => { record('register-ccd-4', await contractCall({}, M, 'register_payable', reg1(4, { Ccd: [] }, 500_000, D.address))); };
steps.regPlt3 = async () => { record('register-plt-3', await contractCall({}, M, 'register_payable', reg1(3, { Plt: ['EUDemo'] }, 10_000, OPS.address))); };
steps.regPlt5 = async () => { record('register-plt-5', await contractCall({}, M, 'register_payable', reg1(5, { Plt: ['EUDemo'] }, 10_000, OPS.address))); };

// CCD rail. Payee D balance delta is recorded for the correct payment.
steps.payCcd1 = async () => {
  const before = await accBal(D.address);
  const c = await contractCall({}, A, 'pay_ccd', 1n, { amount: 500_000n, energy: 6000n });
  const after = await accBal(D.address);
  record('pay-ccd-1-correct', { ...c, payeeDeltaMicro: (after.ccd - before.ccd).toString(), payer: A.address, expectPayeeDelta: '500000' });
};
steps.payCcdDup = async () => {
  const before = await accBal(D.address); const aBefore = await accBal(A.address);
  const c = await contractCall({}, A, 'pay_ccd', 1n, { amount: 500_000n, energy: 6000n, expectRevert: true, note: 'second payment of the same payable' });
  const after = await accBal(D.address); const aAfter = await accBal(A.address);
  record('pay-ccd-1-second-reverts', { ...c, payeeDeltaMicro: (after.ccd - before.ccd).toString(), payerDeltaMicro: (aAfter.ccd - aBefore.ccd).toString() });
};
steps.payCcdWrong = async () => {
  const before = await accBal(D.address);
  const c = await contractCall({}, A, 'pay_ccd', 4n, { amount: 400_000n, energy: 6000n, expectRevert: true, note: 'attached 0.4 CCD, stored 0.5 CCD' });
  record('pay-ccd-4-wrong-amount-reverts', { ...c, payeeDeltaMicro: ((await accBal(D.address)).ccd - before.ccd).toString() });
};
steps.payCcd4 = async () => {
  const before = await accBal(D.address);
  const c = await contractCall({}, A, 'pay_ccd', 4n, { amount: 500_000n, energy: 6000n, note: 'correct amount after the rejected wrong attempt' });
  record('pay-ccd-4-correct', { ...c, payeeDeltaMicro: ((await accBal(D.address)).ccd - before.ccd).toString() });
};
steps.payCcdUnreg = async () => { record('pay-ccd-999-unregistered-reverts', await contractCall({}, A, 'pay_ccd', 999n, { amount: 500_000n, expectRevert: true, note: 'no such payable' })); };

// PLT rail: C3 (2-of-3) sends sponsored, co-signed transactions. Helper builds, co-signs, sponsors, sends.
async function c3Tx(build, label) {
  const nonce = await nextNonce(C3);
  const tx = build({ sender: sdk.AccountAddress.fromBase58(C3), nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) })
    .addMultiSig(2n)
    .addSponsor(sdk.AccountAddress.fromBase58(M.address))
    .build();
  const json = T.toJSONString(tx);
  const co = await coSignJson(json); // co-signer decides on the JSON the agent sends; refuses by throwing a verdict
  if (!co.signature) return { refused: true, verdict: co.verdict };
  const combo = { getSignatureCount: () => 2n, sign: async d => ({ 0: { 0: (await agentSigner.sign(d))[0][0], 1: co.signature } }) };
  const signed = await T.sponsor(await T.sign(tx, combo), mSponsor);
  const mBefore = (await accBal(M.address)).ccd;
  const h = await client.sendTransaction(T.finalize(signed));
  const st = await client.waitForTransactionFinalization(h, 300000);
  const mAfter = (await accBal(M.address)).ccd;
  return { hash: h.toString(), label, summary: st.summary, verdict: co.verdict, rejectReason: st.summary.rejectReason ?? null, cost: String(st.summary.cost), sponsorDeltaMicro: String(mAfter - mBefore), energy: String(st.summary.energyCost ?? '') };
}
const reserveTx = async id => { const message = await enc('reserve_plt', BigInt(id)); return { build: hdr => T.updateContract({ amount: sdk.CcdAmount.zero(), address: reg(), receiveName: sdk.ReceiveName.fromStringUnchecked('payable_registry.reserve_plt'), message }, sdk.Energy.create(6000)).addMetadata(hdr) }; };
const transferTx = (to, amount, memoText, hdrOverride) => ({
  build: hdr => {
    const memo = sdk.CborMemo.fromString(memoText);
    const ops = [{ [sdk.TokenOperationType.Transfer]: { amount: sdk.TokenAmount.create(BigInt(amount), 6), recipient: sdk.CborAccountAddress.fromAccountAddress(sdk.AccountAddress.fromBase58(to)), memo } }];
    return T.tokenUpdate({ tokenId: sdk.TokenId.fromString('EUDemo'), operations: sdk.Cbor.encode(ops) }).addMetadata(hdr);
  },
});

steps.reserve2 = async () => {
  const r = await c3Tx((await reserveTx(2)).build, 'reserve_plt 2 by C3');
  const out = r.refused ? { refusedByCosigner: r.verdict } : { hash: r.hash, outcome: r.rejectReason ? 'reverted' : 'success', rejectReason: r.rejectReason ? JSON.stringify(r.rejectReason) : null, ccdCostMicro: r.cost, energy: r.energy, verdict: r.verdict, contractBalanceAfterMicro: (await regBalanceMicro()).toString() };
  record('reserve-plt-2-by-C3-cosigned', out);
};
// build helper for a payable-reserve transaction body (kept for the refusal cases)
steps.negCosign = async () => {
  const cases = [];
  const memo2 = 'payable:2';
  const tryDecide = async (label, to, amount, memo) => {
    const nonce = await nextNonce(C3);
    const tx = T.tokenUpdate({ tokenId: sdk.TokenId.fromString('EUDemo'), operations: sdk.Cbor.encode([{ [sdk.TokenOperationType.Transfer]: { amount: sdk.TokenAmount.create(BigInt(amount), 6), recipient: sdk.CborAccountAddress.fromAccountAddress(sdk.AccountAddress.fromBase58(to)), memo: sdk.CborMemo.fromString(memo) } }]) })
      .addMetadata({ sender: sdk.AccountAddress.fromBase58(C3), nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) }).addMultiSig(2n).addSponsor(sdk.AccountAddress.fromBase58(M.address)).build();
    const co = await coSignJson(T.toJSONString(tx));
    cases.push({ label, cosigned: !!co.signature, refusal: co.verdict.refused ?? null });
  };
  await tryDecide('transfer to another address (D) instead of payee OPS', D.address, 10_000, memo2);
  await tryDecide('amount 0.0099 instead of 0.01', OPS.address, 9_900, memo2);
  await tryDecide('amount 0.02 instead of 0.01', OPS.address, 20_000, memo2);
  await tryDecide('memo for another payable (payable:3, not reserved by C3)', OPS.address, 10_000, 'payable:3');
  await tryDecide('memo without the payable id', OPS.address, 10_000, 'order 42');
  await tryDecide('payable 5: registered but never reserved', OPS.address, 10_000, 'payable:5');
  // a reserve of payable 2 while it is already Reserved
  {
    const nonce = await nextNonce(C3);
    const tx = T.updateContract({ amount: sdk.CcdAmount.zero(), address: reg(), receiveName: sdk.ReceiveName.fromStringUnchecked('payable_registry.reserve_plt'), message: await enc('reserve_plt', 2n) }, sdk.Energy.create(6000))
      .addMetadata({ sender: sdk.AccountAddress.fromBase58(C3), nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) }).addMultiSig(2n).addSponsor(sdk.AccountAddress.fromBase58(M.address)).build();
    const co = await coSignJson(T.toJSONString(tx));
    cases.push({ label: 'reserve_plt 2 again while Reserved by C3', cosigned: !!co.signature, refusal: co.verdict.refused ?? null });
  }
  // a plain CCD transfer from the agent wallet (not allowed at all)
  record('cosigner-refusals', { cases, note: 'no transaction was sent for these; each refusal is the co-signer decision on the transaction JSON' });
};

steps.transfer2 = async () => {
  const r = await c3Tx(transferTx(OPS.address, 10_000, 'payable:2').build, 'EUDemo 0.01 C3 -> OPS memo payable:2');
  const hashNote = r.hash;
  const rec = { hash: r.hash ?? null, refusedByCosigner: r.refused ? r.verdict : undefined, verdict: r.verdict, rejectReason: r.rejectReason ? JSON.stringify(r.rejectReason) : null, ccdCostMicro: r.cost, sponsorDeltaMicro: r.sponsorDeltaMicro, energy: r.energy };
  if (r.hash) {
    const item = await client.getBlockItemStatus(sdk.TransactionHash.fromHexString(r.hash));
    const ev = (item.outcome?.summary?.events ?? []).find(e => e.tag === 'TokenTransfer');
    rec.readback = ev ? { from: String(ev.from?.address ?? ev.from), to: String(ev.to?.address ?? ev.to), amountRaw: String(ev.amount?.value), memoHex: ev.memo ? Buffer.from(ev.memo.content ?? ev.memo).toString('hex') : null, memoText: sdk.CborMemo.parse(ev.memo).toString?.() ?? null } : null;
    rec.status = item.status;
  }
  rec.note = hashNote;
  record('transfer-plt-2-cosigned', rec);
};

steps.agentAloneReject = async () => {
  // the agent key alone, same transaction shape (2 signatures declared): the node must reject it
  const nonce = await nextNonce(C3);
  const tx = T.tokenUpdate({ tokenId: sdk.TokenId.fromString('EUDemo'), operations: sdk.Cbor.encode([{ [sdk.TokenOperationType.Transfer]: { amount: sdk.TokenAmount.create(10_000n, 6), recipient: sdk.CborAccountAddress.fromAccountAddress(sdk.AccountAddress.fromBase58(OPS.address)), memo: sdk.CborMemo.fromString('payable:2') } }]) })
    .addMetadata({ sender: sdk.AccountAddress.fromBase58(C3), nonce, expiry: sdk.TransactionExpiry.futureMinutes(10) }).addMultiSig(2n).addSponsor(sdk.AccountAddress.fromBase58(M.address)).build();
  const combo = { getSignatureCount: () => 2n, sign: async d => ({ 0: { 0: (await agentSigner.sign(d))[0][0] } }) };
  const signed = await T.sponsor(await T.sign(tx, combo), mSponsor);
  let result;
  try {
    const h = await client.sendTransaction(T.finalize(signed));
    const st = await client.waitForTransactionFinalization(h, 300000);
    result = { accepted: true, hash: h.toString(), rejectReason: st.summary.rejectReason ?? null, note: 'UNEXPECTED: node did not reject' };
  } catch (e) {
    result = { accepted: false, nodeError: sanitize(e.message ?? e).slice(0, 200), note: 'rejected by node before inclusion' };
  }
  record('agent-alone-signature', result);
};

steps.confirm2 = async () => {
  const transfers = loadJson(LIVE, []).find(x => x.step === 'transfer-plt-2-cosigned');
  const h = transfers?.hash;
  if (!h) throw new Error('no transfer hash recorded');
  record('confirm-plt-2-by-seller', await contractCall({}, M, 'confirm_plt', { payable_id: 2, tx_hash: bytes32(h) }, { note: `tx ${h}` }));
};

steps.reserveSecondA = async () => {
  record('reserve-plt-2-second-by-A-reverts', await contractCall({}, A, 'reserve_plt', 2n, { expectRevert: true, note: 'second reserve while Reserved/Paid' }));
};

steps.reserve3A = async () => { record('reserve-plt-3-by-A', await contractCall({}, A, 'reserve_plt', 3n, { note: 'plain account reservation to exercise expiry and tx reuse' })); };
steps.confirmReusedAndStranger = async () => {
  const h = loadJson(LIVE, []).find(x => x.step === 'transfer-plt-2-cosigned')?.hash;
  record('confirm-plt-3-with-reused-hash-reverts', await contractCall({}, M, 'confirm_plt', { payable_id: 3, tx_hash: bytes32(h) }, { expectRevert: true, note: 'hash already backs payable 2' }));
  record('confirm-plt-3-by-stranger-reverts', await contractCall({}, OPS, 'confirm_plt', { payable_id: 3, tx_hash: bytes32(sha('stranger')) }, { expectRevert: true, note: 'OPS is neither payer nor seller' }));
};
steps.expireEarly = async () => { record('expire-plt-3-inside-window-reverts', await contractCall({}, OPS, 'expire_reservation', 3n, { expectRevert: true, note: 'OPS is a third party; window not over' })); };
steps.expireLate = async () => {
  const reserved = loadJson(LIVE, []).find(x => x.step === 'reserve-plt-3-by-A');
  const at = new Date(reserved.at).getTime();
  const wait = at + (RESERVATION_SECS + 15) * 1000 - Date.now();
  if (wait > 0) { console.log('waiting', Math.round(wait / 1000), 's for the reservation window'); await new Promise(r => setTimeout(r, wait)); }
  record('expire-plt-3-after-window-by-third-party', await contractCall({}, OPS, 'expire_reservation', 3n, { note: 'released to Unpaid' }));
  const p = await viewPayable(3);
  record('payable-3-after-expiry', { status: Object.keys(p.status)[0] });
};

steps.payCcdAfter = async () => {
  record('final-states', { p1: await viewPayable(1), p2: await viewPayable(2), p3: await viewPayable(3), p4: await viewPayable(4), contractBalanceMicro: (await regBalanceMicro()).toString() });
};

const step = process.argv[2];
if (!steps[step]) { console.error('unknown step', step, Object.keys(steps).join(' ')); process.exit(2); }
try {
  await steps[step]();
} catch (e) {
  console.error('STEP FAILED', step, sanitize(e?.message ?? e).slice(0, 400));
  record(step + '-error', { error: sanitize(e?.message ?? e).slice(0, 400) });
  process.exit(1);
}
process.exit(0);
