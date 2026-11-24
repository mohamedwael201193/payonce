// CO-SIGNER for the 2-of-3 agent wallet C3 (key 1), payable_registry edition.
//
// It is a deterministic decision over (the transaction it is asked to sign, the registry's view state).
// It co-signs exactly two things, and refuses everything else:
//   (1) payable_registry.reserve_plt(id) sent by C3, for a PLT payable with status Unpaid, not past due,
//       and a C3 EUDemo balance that covers the amount;
//   (2) a sponsored EUDemo transfer from C3 with exactly one Transfer operation whose recipient is the
//       stored payee, whose amount is the stored amount, and whose memo is exactly "payable:<id>",
//       only while the payable is Reserved by C3 and its reservation window has not nearly closed.
// It holds no funds and cannot move anything alone (threshold 2). It never loads .env or the seed.
// Keys: only cosigner.private.json (C3 key 1), read in this process and never printed.
import { readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import * as sdk from '@concordium/web-sdk';
import { ConcordiumGRPCNodeClient } from '@concordium/web-sdk/nodejs';
import { credentials } from '@grpc/grpc-js';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const CORE = path.resolve(DIR, '..', 'core');
const cfg = JSON.parse(readFileSync(path.join(CORE, 'cfg.json'), 'utf8'));
const loadDeploy = () => JSON.parse(readFileSync(path.join(DIR, 'out', 'deploy.json'), 'utf8'));
const coKey = JSON.parse(readFileSync(path.join(CORE, 'cosigner.private.json'), 'utf8')).signingKey; // C3 key 1 (never printed)
const coSigner = sdk.buildBasicAccountSigner(coKey);
const C3 = cfg.v2.C3.address;
const EUDEMO = 'EUDemo';
const MARGIN_MS = 60_000; // refuse if the reservation window closes within this margin
const regAddr = () => { const d = loadDeploy(); return sdk.ContractAddress.create(d.instance.index, d.instance.subindex); };
const REG_NAME = sdk.ContractName.fromStringUnchecked('payable_registry');
const T = sdk.Transaction;

export const client = new ConcordiumGRPCNodeClient('grpc.testnet.concordium.com', 20000, credentials.createSsl());
let _schema;
const schema = async () => (_schema ??= await client.getEmbeddedSchema(sdk.ModuleReference.fromHexString(loadDeploy().moduleRef)));

class Refuse extends Error {}
const refuse = m => { throw new Refuse(m); };

const toHex = x => (typeof x === 'string' ? x : Buffer.from(x).toString('hex'));
const toBuf = x => (typeof x === 'string' ? Buffer.from(x, 'hex') : Buffer.from(x.buffer ?? x));
const tagOf = o => Object.keys(o)[0];

// Registry view: get_payable(id) -> Option<Payable>. Read-only, no state change.
export async function viewPayable(id) {
  const s = await schema();
  const ep = sdk.EntrypointName.fromStringUnchecked('get_payable');
  const r = await client.invokeContract({
    contract: regAddr(),
    method: sdk.ReceiveName.fromStringUnchecked('payable_registry.get_payable'),
    parameter: sdk.serializeUpdateContractParameters(REG_NAME, ep, BigInt(id), s.buffer, s.version),
  });
  if (r.tag !== 'success') throw new Error('view get_payable failed');
  const v = sdk.deserializeReceiveReturnValue(r.returnValue.buffer, s.buffer, REG_NAME, ep, s.version);
  return v?.Some?.[0] ?? null;
}

async function eudemoBalance(addr) {
  const ai = await client.getAccountInfo(sdk.AccountAddress.fromBase58(addr));
  const t = ai.accountTokens?.find(x => String(x.id) === EUDEMO);
  return t ? BigInt(t.state.balance.value) : 0n;
}

function assetIsEudemo(p) {
  return tagOf(p.asset) === 'Plt' && p.asset.Plt[0] === EUDEMO;
}

// Decide on a signable transaction (as received from the agent, i.e. parsed from its JSON).
export async function decide(signable, now = Date.now()) {
  const h = signable.header;
  if (signable.version !== 1) refuse('only V1 (sponsored) transactions are co-signed');
  if (String(h.sender) !== C3) refuse('sender is not the agent wallet C3');
  if (!h.sponsor) refuse('sponsored transaction required');
  if (Number(h.numSignatures) !== 2) refuse('header must declare 2 sender signatures');
  const p = signable.payload;

  if (p.type === sdk.AccountTransactionType.Update) {
    // (1) reserve_plt(id) only
    if (String(p.address.index) !== String(regAddr().index) || Number(p.address.subindex) !== 0) refuse('contract is not the payable registry');
    if (String(p.amount.microCcdAmount ?? p.amount) !== '0') refuse('reserve_plt carries no CCD');
    if (String(p.receiveName) !== 'payable_registry.reserve_plt') refuse(`only payable_registry.reserve_plt may be co-signed (got ${p.receiveName})`);
    const msg = toBuf(p.message);
    if (msg.length !== 8) refuse('reserve_plt takes one u64');
    const id = msg.readBigUInt64LE(0);
    const rec = await viewPayable(id);
    if (!rec) refuse(`no payable ${id}`);
    if (!assetIsEudemo(rec)) refuse('payable is not an EUDemo PLT payable');
    if (tagOf(rec.status) !== 'Unpaid') refuse(`payable ${id} is ${tagOf(rec.status)}, not Unpaid: no reservation co-signed`);
    if (now > new Date(rec.due).getTime()) refuse('payable is past due');
    const bal = await eudemoBalance(C3);
    if (bal < BigInt(rec.amount)) refuse(`agent wallet EUDemo balance ${bal} is below the payable amount ${rec.amount}`);
    return { kind: 'reserve_plt', payable_id: id.toString(), payer: C3 };
  }

  if (p.type === sdk.AccountTransactionType.TokenUpdate) {
    // (2) exactly one EUDemo transfer of the stored amount to the stored payee, memo "payable:<id>"
    if (String(p.tokenId) !== EUDEMO) refuse('only EUDemo may be moved');
    const ops = sdk.Cbor.decode(p.operations);
    if (!Array.isArray(ops) || ops.length !== 1 || !ops[0].transfer) refuse('exactly one plain transfer operation required');
    const t = ops[0].transfer;
    const to = String(t.recipient.address ?? t.recipient);
    const amount = BigInt(t.amount.value);
    const memoHex = toHex(t.memo?.content ?? t.memo ?? '');
    const m = /^payable:(\d+)$/.exec(Buffer.from(memoHex.slice(2), 'hex').toString('utf8'));
    // the CBOR text header byte must match the text length (the memo must be exactly the canonical "payable:<id>")
    if (!m) refuse('memo must be exactly payable:<id>');
    const id = m[1];
    const expectMemo = toHex(sdk.CborMemo.fromString(`payable:${id}`).content);
    if (memoHex !== expectMemo) refuse('memo is not the canonical payable memo');
    const rec = await viewPayable(id);
    if (!rec) refuse(`no payable ${id}`);
    if (!assetIsEudemo(rec)) refuse('payable is not an EUDemo PLT payable');
    if (to !== rec.payee) refuse(`recipient ${to} is not the stored payee ${rec.payee}`);
    if (amount !== BigInt(rec.amount)) refuse(`amount ${amount} is not the stored amount ${rec.amount}`);
    const st = rec.status;
    if (tagOf(st) !== 'Reserved') refuse(`payable ${id} is ${tagOf(st)}, not Reserved: no payment co-signed`);
    const body = st.Reserved;
    if (body.payer !== C3) refuse('payable is reserved by another payer');
    if (now > new Date(body.expires).getTime() - MARGIN_MS) refuse('reservation window is closing: no payment co-signed');
    return { kind: 'payable_plt_transfer', payable_id: id, to, amount: amount.toString() };
  }
  refuse('only reserve_plt and the exact payable EUDemo transfer may be co-signed');
}

// Wire entry: the agent sends the JSON of the signable tx; the co-signer decides, then signs ONLY if the decision passes.
export async function coSignJson(json) {
  let verdict;
  try {
    const received = T.fromJSONString(json, T.signableFromJSON);
    verdict = { ok: true, ...(await decide(received)) };
    const s = await T.sign(received, coSigner);
    return { signature: s.signatures.sender[0][0], keyIndex: 1, verdict };
  } catch (e) {
    if (e instanceof Refuse) return { signature: null, verdict: { ok: false, refused: e.message } };
    throw e;
  }
}

export { Refuse };
