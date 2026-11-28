// eudemo-vop-run.mjs — Verification of Payee on the EUDemo (PLT) rail, on the v3 DEMO book (90 s cooling-off).
//   PAYONCE_V3_INDEX=13173 node api/scripts/eudemo-vop-run.mjs        (Render one-off job; testnet only)
// Steps, each a real transaction sent ONCE (never resubmitted; an unknown outcome is recorded with its hash):
//   0 setup once: the buyer agent approves the seller as a vendor (caps 1 EUDemo per payable, 5 per day)
//   1 seller registers a 0.01 EUDemo invoice, payable only by the buyer agent, to its bound payee
//   2 buyer agent: check_payee -> MATCH (payable) ; reserve_plt (fee sponsored)  -> chain re-checks the payee binding
//   3 buyer agent: EUDemo transfer, memo payable:<seller>:<id> (fee sponsored; the relayer only co-signs a
//     transfer to THAT payable's bound payee for THAT amount while it is Reserved by THIS sender)
//   4 buyer agent: confirm_plt(tx hash) (fee sponsored)                          -> Paid, tx hash recorded once
//   5 replays: reserve again -> chain refuses ; sponsor a transfer to another account -> relayer refuses (nothing sent)
// The contract cannot see PLT transfers: step 4 records the hash, and the receipt check reads that transaction
// back from the node (token, sender, recipient, amount, memo). This script does that check too.
import { AccountAddress, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy, TransactionExpiry, Transaction, Payload, TransactionHash } from '@concordium/web-sdk';
import { vClient } from '../src/consent.mjs';
import { signers } from '../src/chain-v2.mjs';
import { kvGet, kvPut } from '../src/store.mjs';
import { retryingReads } from '../src/node-retry.mjs';
import { V3, v3Label, V3_ERRORS, invokeV3, acct, getPayableV3, serRegisterPayable, serPayableKey, serConfirmPlt } from '../src/vop-chain.mjs';
import { createRelayer, RelayError } from '../src/relayer.mjs';
import { createVopService } from '../src/vop-service.mjs';
import { verifyPresentationKeyless } from '../src/vop-routes.mjs';
import { sha256Hex } from '../src/vop.mjs';
import { OWNER_TOKEN } from '../src/config.mjs';

if (String(V3.index) !== '13173') { console.log('refusing: run on the demo book (PAYONCE_V3_INDEX=13173)'); process.exit(1); }
const J = (o) => JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v));
const c = retryingReads(vClient(), { tries: 8, maxMs: 15000 });
const S = await signers();
const SELLER = S.owner; const BUYER = S.seller2; // the v3 demo pair (same as demo-run.mjs)
const NAME = 'PayOnce Labs';
const relayer = createRelayer({ grpc: async () => c, sponsor: async () => S.owner });
const vop = createVopService({ grpc: async () => c, kv: { get: kvGet, put: kvPut }, verifyPresentation: verifyPresentationKeyless });
const ERR = { '-5': 'WrongStatus', ...V3_ERRORS };
const out = { run: 'EUDemo rail with Verification of Payee', contract: v3Label(), started_at: new Date().toISOString(), seller: SELLER.address, buyer: BUYER.address, txs: {} };
const save = () => kvPut('eudemo_run', 'latest', JSON.parse(J(out)));

async function fin(h) {
  const s = JSON.parse(J(await c.waitForTransactionFinalization(TransactionHash.fromHexString(h), 180_000)));
  const sum = s.summary ?? {};
  const rr = sum.rejectReason?.rejectReason ?? sum.rejectReason?.contents?.rejectReason ?? null;
  return { hash: h, block: s.blockHash, ok: !sum.rejectReason, reject: rr != null ? Number(rr) : null, reject_name: rr != null ? (ERR[String(rr)] ?? null) : null, cost_micro: sum.cost ?? null, sponsor: sum.sponsorDetails?.sponsor ?? sum.sponsor ?? null, summary: sum };
}
async function once(label, sendFn) {
  let h;
  try { h = await sendFn(); } catch (e) { out.txs[label] = { sent: 'unknown_or_failed', error: String(e?.message ?? e).slice(0, 300) }; await save(); throw e; }
  console.log(`[${label}] ${h}`);
  try { const r = await fin(h); out.txs[label] = { ...r, summary: undefined }; await save(); return r; } catch (e) { out.txs[label] = { hash: h, sent: 'unknown', note: 'not finalized in time; NOT resubmitted' }; await save(); throw e; }
}
async function direct(from, entrypoint, param, label, { energy = 20000n } = {}) {
  return once(label, async () => {
    const info = await c.getAccountInfo(AccountAddress.fromBase58(from.address));
    const tx = Transaction.updateContract(Payload.updateContract({ amount: CcdAmount.fromMicroCcd(0n), address: ContractAddress.create(V3.index, V3.subindex), receiveName: ReceiveName.fromString(`${V3.name}.${entrypoint}`), message: Parameter.fromBuffer(param) }), Energy.create(energy))
      .addMetadata({ sender: AccountAddress.fromBase58(from.address), nonce: info.accountNonce, expiry: TransactionExpiry.futureMinutes(8) }).build();
    return (await c.sendTransaction(await Transaction.signAndFinalize(tx, from.signer))).toString();
  });
}
async function sponsored(from, body, label) {
  const p = await relayer.prepare({ sender: from.address, ...body });
  return once(label, async () => {
    const signed = await Transaction.sign(Transaction.signableFromJSON(p.transaction), from.signer);
    return (await c.sendTransaction(Transaction.finalize(signed))).toString();
  });
}
const u8 = (n) => Buffer.from([n]); const u64 = (n) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(n)); return b; };

// ---- 0 vendor approval (once) ----
const vend = await invokeV3(c, 'get_vendor', Buffer.concat([acct(BUYER.address), acct(SELLER.address)]));
out.vendor_before = vend[0] === 1 ? 'approved' : 'none';
if (vend[0] !== 1) {
  const param = Buffer.concat([acct(SELLER.address), u8(0), u8(0), u64(1_000_000), u64(5_000_000), u64(86_400)]);
  const r = await sponsored(BUYER, { entrypoint: 'approve_vendor', parameter: param.toString('hex') }, 'approve_vendor');
  if (!r.ok) throw new Error(`approve_vendor rejected ${r.reject}`);
}

// ---- 1 invoice in EUDemo ----
const id = Number((await kvGet('eudemo_run', 'next_id'))?.n ?? 9000);
await kvPut('eudemo_run', 'next_id', { n: id + 1 });
const AMOUNT = 10_000n; // 0.01 EUDemo (6 decimals)
out.invoice = { payable_id: id, amount: '0.01 EUDemo', amount_minor: String(AMOUNT), payee: SELLER.address, payee_name: NAME };
const reg = await direct(SELLER, 'register_payable', serRegisterPayable({ payable_id: id, payee: SELLER.address, amount: AMOUNT, asset: 'EUDemo', due_ms: Date.now() + 7 * 864e5, doc_hash: sha256Hex(`payonce EUDemo invoice ${id} ${NAME} ${Date.now()}`), agent_token: OWNER_TOKEN, expected_payer: BUYER.address, legal_ref: null }), 'register');
if (!reg.ok) throw new Error(`register rejected ${reg.reject}`);

// ---- 2 check_payee, then reserve ----
const chk = await vop.check({ seller: SELLER.address, payee: SELLER.address, legal_name: NAME, buyer: BUYER.address });
out.check_payee = { verdict: chk.verdict, payable: chk.payable, evidence_hash: chk.evidence_hash ?? null, buyer_ack_current: chk.buyer_ack?.current ?? null };
await save();
if (chk.verdict !== 'MATCH' || !chk.payable || !chk.buyer_ack?.current) throw new Error(`not payable: ${J(out.check_payee)}`);
const key = serPayableKey({ seller: SELLER.address, payable_id: id });
const res = await sponsored(BUYER, { entrypoint: 'reserve_plt', parameter: key.toString('hex') }, 'reserve_plt');
if (!res.ok) throw new Error(`reserve_plt rejected ${res.reject}`);

// ---- 3 the EUDemo transfer (sponsored, memo names the payable) ----
const memo = `payable:${SELLER.address}:${id}`;
// a transfer to any other account is refused before the sponsor key is touched (nothing is sent):
try { await relayer.prepare({ sender: BUYER.address, kind: 'token', amount: String(AMOUNT), recipient: BUYER.address, memo }); out.wrong_recipient = 'NOT refused (bug)'; }
catch (e) { out.wrong_recipient = e instanceof RelayError ? { refused: true, code: e.code, message: e.message } : { refused: true, error: String(e.message).slice(0, 160) }; }
const tr = await sponsored(BUYER, { kind: 'token', amount: String(AMOUNT), recipient: SELLER.address, memo }, 'eudemo_transfer');
if (!tr.ok) throw new Error(`EUDemo transfer rejected (${tr.hash})`);

// ---- 4 confirm ----
const conf = await sponsored(BUYER, { entrypoint: 'confirm_plt', parameter: serConfirmPlt({ seller: SELLER.address, payable_id: id, tx_hash: tr.hash }).toString('hex') }, 'confirm_plt');
if (!conf.ok) throw new Error(`confirm_plt rejected ${conf.reject}`);
const p = await getPayableV3(c, SELLER.address, id);
out.payable_after = { status: p.status.tag, payer: p.status.payer, tx_hash: p.status.tx_hash ?? null, asset: p.asset };

// ---- read the transfer back from the node ----
const t = await c.waitForTransactionFinalization(TransactionHash.fromHexString(tr.hash), 60_000);
const tj = JSON.parse(J(t.summary));
const evs = JSON.stringify(tj);
out.transfer_readback = {
  token: /EUDemo/.test(evs), sender_is_buyer: tj.sender === BUYER.address || evs.includes(BUYER.address), to_payee: evs.includes(SELLER.address),
  memo_present: evs.includes(Buffer.from(memo).toString('hex')) || evs.includes(memo), sponsored: !!(tj.sponsorDetails || tj.sponsor),
  raw_type: tj.transactionType ?? tj.type ?? null,
};

// ---- 5 replay: the chain refuses a second reservation of a Paid payable ----
const again = await direct(BUYER, 'reserve_plt', key, 'reserve_again', { energy: 8000n });
out.replay = { ok: again.ok, reject: again.reject, reject_name: again.reject_name };
out.go = out.payable_after.status === 'Paid' && out.payable_after.tx_hash === tr.hash && !again.ok && out.wrong_recipient?.refused === true;
out.finished_at = new Date().toISOString();
await save();
console.log('RESULT', J(out));
process.exit(0);
