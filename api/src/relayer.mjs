// PayOnce — sponsored-transaction relayer (Concordium P10 sponsored transactions).
//
// The agent (or the human's wallet) signs its own transaction as SENDER; the
// relayer co-signs as SPONSOR and pays the fees. The agent and the owner can
// hold 0 CCD and still act: accept a payee binding, acknowledge a VoP verdict,
// reserve a payable, pay it in EUDemo, confirm it.
//
// The relayer only sponsors what PayOnce is for. Everything else is refused
// before the sponsor key is touched:
//   * contract updates: payable_registry_v3 at the configured address, a
//     whitelisted entrypoint, no CCD attached except to pay_ccd;
//   * EUDemo transfers: exactly one transfer whose memo names a v3 payable
//     that is Reserved by THIS sender, to THAT payable's payee, for THAT amount;
//   * energy cap, expiry window (<= 10 min ahead), valid sender signature,
//     header sponsor = this relayer, per-sender rate limit, sponsor balance floor.
// Submission happens once. A send whose outcome is unknown is never retried.
import {
  Transaction, Payload, AccountAddress, ContractAddress, ReceiveName, Parameter, CcdAmount, Energy,
  SequenceNumber, TransactionExpiry, AccountTransactionType, Cbor, CborMemo, TokenAmount, CborAccountAddress, TokenId,
} from '@concordium/web-sdk';
import { V3, getPayableV3 } from './vop-chain.mjs';

export const RELAY_LIMITS = Object.freeze({
  maxContractEnergy: 30_000n,
  maxExpirySecs: 600,
  minExpirySecs: 30,
  perSenderPerMinute: 6,
  sponsorFloorMicroCcd: 1_000_000_000n, // stop sponsoring under 1,000 CCD
});
export const SPONSORED_ENTRYPOINTS = Object.freeze([
  'accept_payee', 'acknowledge_payee', 'propose_payee', 'revoke_payee', 'register_payable',
  'reserve_plt', 'confirm_plt', 'record_payment_tx', 'approve_vendor', 'revoke_vendor', 'set_strict', 'pay_ccd', 'void_payable',
]);
export const SPONSORED_TOKEN = 'EUDemo';

export class RelayError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}

/** BigInt-safe JSON the SDK's signableFromJSON accepts (same as the facilitator client). */
export function toJsonSafe(value) {
  if (typeof value === 'bigint') return value <= 9007199254740991n ? Number(value) : value.toString();
  if (Array.isArray(value)) return value.map(toJsonSafe);
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, toJsonSafe(v)]));
  return value;
}

/** Text of a CBOR-encoded memo (major type 3). */
export function memoText(memo) {
  const b = Buffer.from(memo?.content ?? memo ?? []);
  if (!b.length || b[0] >> 5 !== 3) return null;
  const ai = b[0] & 31; let len; let off;
  if (ai < 24) { len = ai; off = 1; } else if (ai === 24) { len = b[1]; off = 2; } else if (ai === 25) { len = b.readUInt16BE(1); off = 3; } else return null;
  if (off + len !== b.length) return null;
  return b.subarray(off, off + len).toString('utf8');
}

const addrOf = (a) => (a == null ? null : typeof a === 'string' ? a : a.address ?? a.account?.address ?? String(a));

/**
 * Static checks on a sender-signed sponsored transaction (no network).
 * Returns { kind: 'contract'|'token', entrypoint?, transfer? }.
 */
export function inspectSponsored(tx, { sponsorAddress, nowSecs = Math.floor(Date.now() / 1000), limits = RELAY_LIMITS } = {}) {
  if (tx?.version !== 1) throw new RelayError(400, 'not_sponsored', 'Only version-1 (sponsored) transactions are relayed.');
  const h = tx.header ?? {};
  if (addrOf(h.sponsor?.account) !== sponsorAddress) throw new RelayError(400, 'wrong_sponsor', `The transaction must name ${sponsorAddress} as sponsor.`);
  if (Number(h.sponsor?.numSignatures ?? 1) !== 1) throw new RelayError(400, 'bad_sponsor_sigs', 'The sponsor signs with exactly one key.');
  const exp = Number(h.expiry?.expiryEpochSeconds ?? h.expiry);
  if (!(exp > nowSecs + limits.minExpirySecs) || exp > nowSecs + limits.maxExpirySecs) throw new RelayError(400, 'bad_expiry', `Expiry must be ${limits.minExpirySecs}s-${limits.maxExpirySecs}s ahead.`);
  if (!tx.signatures?.sender || !Object.keys(tx.signatures.sender).length) throw new RelayError(400, 'unsigned', 'The sender must sign before the relayer sponsors.');
  if (tx.signatures?.sponsor && Object.keys(tx.signatures.sponsor).length) throw new RelayError(400, 'already_sponsored', 'The transaction already carries a sponsor signature.');
  const p = tx.payload ?? {};
  if (p.type === 'update' || p.type === AccountTransactionType.Update) {
    const addr = p.address;
    if (BigInt(addr?.index ?? -1) !== V3.index || BigInt(addr?.subindex ?? -1) !== V3.subindex) throw new RelayError(403, 'wrong_contract', `Only payable_registry_v3 ${`<${V3.index},${V3.subindex}>`} is sponsored.`);
    const rn = String(p.receiveName?.value ?? p.receiveName ?? '');
    const [contract, entrypoint] = rn.split('.');
    if (contract !== V3.name || !SPONSORED_ENTRYPOINTS.includes(entrypoint)) throw new RelayError(403, 'entrypoint_not_sponsored', `Entrypoint ${rn} is not sponsored.`);
    const amount = BigInt(p.amount?.microCcdAmount ?? p.amount ?? 0);
    if (amount !== 0n && entrypoint !== 'pay_ccd') throw new RelayError(403, 'ccd_attached', 'Only pay_ccd may carry CCD.');
    const energy = BigInt(h.executionEnergyAmount?.value ?? h.executionEnergyAmount ?? 0);
    if (energy > limits.maxContractEnergy + 1_000n) throw new RelayError(403, 'energy_cap', `Energy ${energy} exceeds the sponsor cap.`);
    return { kind: 'contract', entrypoint, amount };
  }
  if (p.type === 'tokenUpdate' || p.type === AccountTransactionType.TokenUpdate) {
    if (String(p.tokenId?.value ?? p.tokenId) !== SPONSORED_TOKEN) throw new RelayError(403, 'token_not_sponsored', `Only ${SPONSORED_TOKEN} transfers are sponsored.`);
    let ops;
    try { ops = Cbor.decode(p.operations); } catch { throw new RelayError(400, 'bad_operations', 'Token operations are not valid CBOR.'); }
    if (!Array.isArray(ops) || ops.length !== 1 || !ops[0]?.transfer) throw new RelayError(403, 'one_transfer_only', 'Exactly one token transfer per sponsored transaction.');
    const t = ops[0].transfer;
    const memo = memoText(t.memo);
    const m = /^payable:([1-9A-HJ-NP-Za-km-z]{50}):(\d{1,19})$/.exec(memo ?? '');
    if (!m) throw new RelayError(403, 'memo_required', 'The transfer memo must be payable:<seller>:<id>.');
    return { kind: 'token', transfer: { recipient: t.recipient.toString(), amount: BigInt(t.amount.value), decimals: Number(t.amount.decimals), seller: m[1], payable_id: m[2], memo } };
  }
  throw new RelayError(403, 'type_not_sponsored', `Transaction type ${p.type} is not sponsored.`);
}

/**
 * deps: { grpc(): client, sponsor(): {address, signer}, hitWindow(key, windowMs, limit) -> {allowed}, now() }
 */
export function createRelayer(deps) {
  const now = deps.now ?? Date.now;
  const limits = deps.limits ?? RELAY_LIMITS;

  async function sponsorAddress() { return (await deps.sponsor()).address; }

  async function config() {
    return {
      sponsor: await sponsorAddress(),
      contract: { index: V3.index.toString(), subindex: V3.subindex.toString(), name: V3.name },
      entrypoints: SPONSORED_ENTRYPOINTS,
      token: { id: SPONSORED_TOKEN, rule: 'one transfer, memo payable:<seller>:<id>, payable Reserved by the sender, exact payee and amount' },
      limits: { max_contract_energy: limits.maxContractEnergy.toString(), expiry_secs: [limits.minExpirySecs, limits.maxExpirySecs], per_sender_per_minute: limits.perSenderPerMinute },
      flow: ['POST /api/relay/build -> unsigned sponsored tx JSON', 'sender signs (Transaction.sign) and posts it', 'POST /api/relay/submit -> relayer validates, co-signs as sponsor, submits once'],
    };
  }

  async function estimateEnergy(c, { sender, entrypoint, paramHex, amount }) {
    const res = await c.invokeContract({
      invoker: AccountAddress.fromBase58(sender),
      contract: ContractAddress.create(V3.index, V3.subindex),
      method: ReceiveName.fromString(`${V3.name}.${entrypoint}`),
      parameter: Parameter.fromHexString(paramHex),
      amount: CcdAmount.fromMicroCcd(BigInt(amount ?? 0)),
    });
    if (res.tag !== 'success') {
      const code = res.reason?.rejectReason ?? res.reason?.contents?.rejectReason;
      throw new RelayError(409, 'would_reject', `The contract would reject this call${code != null ? ` (reject code ${code})` : ''}; nothing was sponsored.`);
    }
    const used = BigInt(res.usedEnergy?.value ?? res.usedEnergy ?? 0);
    const e = used + used / 5n + 500n;
    if (e > limits.maxContractEnergy) throw new RelayError(403, 'energy_cap', `Estimated energy ${e} exceeds the sponsor cap.`);
    return e;
  }

  /** Build an unsigned sponsored transaction for `sender`. */
  async function build(body) {
    const c = await deps.grpc();
    const sender = String(body?.sender ?? '');
    try { AccountAddress.fromBase58(sender); } catch { throw new RelayError(400, 'bad_sender', 'sender must be a Concordium account address.'); }
    const sponsor = await sponsorAddress();
    const info = await c.getAccountInfo(AccountAddress.fromBase58(sender));
    const nonce = BigInt(info.accountNonce?.value ?? info.accountNonce);
    const expiry = TransactionExpiry.fromEpochSeconds(BigInt(Math.floor(now() / 1000) + Math.min(Number(body?.expiry_secs ?? 300), limits.maxExpirySecs - 5)));
    let tx;
    if (body?.kind === 'token') {
      const operations = Cbor.encode([{ transfer: {
        amount: TokenAmount.create(BigInt(body.amount), 6),
        recipient: CborAccountAddress.fromBase58(String(body.recipient)),
        memo: CborMemo.fromString(String(body.memo)),
      } }]);
      tx = Transaction.tokenUpdate(Payload.tokenUpdate({ tokenId: TokenId.fromString(SPONSORED_TOKEN), operations }));
    } else {
      const entrypoint = String(body?.entrypoint ?? '');
      if (!SPONSORED_ENTRYPOINTS.includes(entrypoint)) throw new RelayError(403, 'entrypoint_not_sponsored', `Entrypoint ${entrypoint} is not sponsored.`);
      const paramHex = String(body?.parameter ?? '');
      if (!/^([0-9a-f]{2})*$/i.test(paramHex)) throw new RelayError(400, 'bad_parameter', 'parameter must be hex.');
      const amount = BigInt(body?.amount_micro_ccd ?? 0);
      const energy = await estimateEnergy(c, { sender, entrypoint, paramHex, amount });
      tx = Transaction.updateContract(Payload.updateContract({
        amount: CcdAmount.fromMicroCcd(amount), address: ContractAddress.create(V3.index, V3.subindex),
        receiveName: ReceiveName.fromString(`${V3.name}.${entrypoint}`), message: Parameter.fromHexString(paramHex),
      }), Energy.create(energy));
    }
    const built = tx.addMetadata({ sender: AccountAddress.fromBase58(sender), nonce: SequenceNumber.create(nonce), expiry })
      .addSponsor(AccountAddress.fromBase58(sponsor)).build();
    const json = toJsonSafe(Transaction.toJSON(built));
    inspectSponsored({ ...Transaction.signableFromJSON(json), signatures: { sender: { 0: { 0: 'x' } } } }, { sponsorAddress: sponsor, nowSecs: Math.floor(now() / 1000), limits });
    return { transaction: json, sponsor, sign_with: 'Transaction.sign(Transaction.signableFromJSON(transaction), senderSigner)', fee_paid_by: sponsor };
  }

  /** Validate, co-sign as sponsor, submit ONCE. */
  async function submit(body) {
    let tx;
    try { tx = Transaction.signableFromJSON(typeof body?.transaction === 'string' ? JSON.parse(body.transaction) : body?.transaction); } catch (e) {
      throw new RelayError(400, 'bad_transaction', `Not a signable transaction: ${String(e?.message ?? e).slice(0, 120)}`);
    }
    const sp = await deps.sponsor();
    const facts = inspectSponsored(tx, { sponsorAddress: sp.address, nowSecs: Math.floor(now() / 1000), limits });
    const sender = addrOf(tx.header.sender);
    if (deps.hitWindow) {
      const w = await deps.hitWindow(`relay:${sender}`, 60_000, limits.perSenderPerMinute);
      if (w && w.allowed === false) throw new RelayError(429, 'rate_limited', 'Too many sponsored transactions from this sender; wait a minute.');
    }
    const c = await deps.grpc();
    const senderInfo = await c.getAccountInfo(AccountAddress.fromBase58(sender));
    const okSig = await Transaction.verifySignature(tx, tx.signatures.sender, senderInfo).catch(() => false);
    if (!okSig) throw new RelayError(400, 'bad_signature', 'The sender signature does not verify against the sender account keys.');
    const expectedNonce = BigInt(senderInfo.accountNonce?.value ?? senderInfo.accountNonce);
    const txNonce = BigInt(tx.header.nonce?.value ?? tx.header.nonce);
    if (txNonce !== expectedNonce) throw new RelayError(409, 'stale_nonce', `Nonce ${txNonce} is not the sender's next nonce (${expectedNonce}); rebuild.`);
    if (facts.kind === 'token') {
      const t = facts.transfer;
      const p = await getPayableV3(c, t.seller, t.payable_id);
      if (!p) throw new RelayError(404, 'no_payable', `No v3 payable ${t.seller.slice(0, 8)}…/${t.payable_id}.`);
      if (p.asset !== SPONSORED_TOKEN) throw new RelayError(403, 'wrong_asset', 'That payable is not an EUDemo payable.');
      if (p.status.tag !== 'Reserved' || p.status.payer !== sender) throw new RelayError(403, 'not_reserved_by_sender', 'The payable must be Reserved by this sender (reserve_plt first).');
      if (p.status.expires_ms <= now()) throw new RelayError(409, 'reservation_expired', 'The reservation expired.');
      if (p.payee !== t.recipient) throw new RelayError(403, 'wrong_recipient', 'The transfer must go to the payable’s bound payee.');
      if (String(p.amount) !== t.amount.toString() || t.decimals !== 6) throw new RelayError(403, 'wrong_amount', 'The transfer amount must equal the payable amount.');
      const exp = Number(tx.header.expiry?.expiryEpochSeconds ?? tx.header.expiry) * 1000;
      if (exp > p.status.expires_ms) throw new RelayError(400, 'expiry_after_reservation', 'The transaction must expire before the reservation does.');
    }
    const spInfo = await c.getAccountInfo(AccountAddress.fromBase58(sp.address));
    const avail = BigInt(spInfo.accountAvailableBalance?.microCcdAmount ?? spInfo.accountAvailableBalance ?? spInfo.accountAmount?.microCcdAmount ?? 0);
    if (avail < limits.sponsorFloorMicroCcd) throw new RelayError(503, 'sponsor_low', 'The sponsor balance is under its floor; sponsoring paused.');
    const sponsored = await Transaction.sponsor(tx, sp.signer);
    const finalized = Transaction.finalize(sponsored);
    const hash = Buffer.from(Transaction.getAccountTransactionHash(finalized)).toString('hex');
    // One submission. If the node call fails, the hash is still returned so
    // the caller checks its status; the relayer never resubmits.
    try {
      await c.sendTransaction(finalized);
    } catch (e) {
      return { submitted: 'unknown', tx_hash: hash, sender, sponsor: sp.address, error: String(e?.message ?? e).slice(0, 200), note: 'Status unknown: check the hash; do not resubmit.' };
    }
    return { submitted: true, tx_hash: hash, sender, sponsor: sp.address, kind: facts.kind, entrypoint: facts.entrypoint ?? null, sender_paid_ccd: (facts.amount ?? 0n).toString() };
  }

  return { config, build, submit };
}
