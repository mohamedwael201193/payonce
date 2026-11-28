// A spend mandate for a buyer agent: signed by the agent's own account key, anchored on chain, enforced, verifiable. Testnet.
//
//   message   plain text naming the account, the agent token, a per-purchase cap, a total budget and an expiry
//   signature the account's own key signs the message (Concordium account message signature; anyone re-checks it
//             against the account's keys on chain with verifyMessageSignature)
//   anchor    registerData "PMD1" (4 bytes) + sha256(message) (32 bytes), sent BY THE BUYER ACCOUNT, so the chain itself
//             records who anchored which mandate and when
//   enforce   the buyer agent refuses any purchase above the cap, above the remaining budget or after the expiry
//             (before it signs anything), and presents the mandate hash to the seller; a seller can re-check the same
//             facts (verifyForSale) before it settles
//   verify    GET /api/mandate/<hash> returns message + signature + anchor tx + every spend; api/scripts/verify-mandate.mjs
//             re-checks signature, anchor and each spend against the chain, keyless
//
// Limits (stated, not hidden): a seller can enforce the per-purchase cap and the expiry; the TOTAL budget is enforced by
// the buyer agent and is checkable from the public spend list and the chain, not by an unrelated seller.
import { verifyMessageSignature } from '@concordium/web-sdk';
import { randomBytes } from 'node:crypto';
import { sha256Hex } from './vop.mjs';

export const NS = 'buyer_mandate';
export const ANCHOR_PREFIX = Buffer.from('PMD1');
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{50}$/;
const HASH = /^[0-9a-f]{64}$/;

export class MandateError extends Error { constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; } }

export const anchorDataHex = (hash) => Buffer.concat([ANCHOR_PREFIX, Buffer.from(hash, 'hex')]).toString('hex');
const microText = (m) => String(m);

/** m = { account, agent_token, per_purchase_micro, total_micro, expires_ms, id } -> the exact text the account signs. */
export function mandateMessage(m) {
  return [
    'PayOnce spend mandate v1 (Concordium testnet)',
    `Account: ${m.account}`,
    `Agent token: ${m.agent_token}`,
    `Per purchase cap: ${microText(m.per_purchase_micro)} micro CCD`,
    `Total budget: ${microText(m.total_micro)} micro CCD`,
    `Expires: ${new Date(m.expires_ms).toISOString()}`,
    `Mandate id: ${m.id}`,
  ].join('\n');
}

/** Strict parse: the text must be exactly what mandateMessage() builds from the parsed fields. */
export function parseMandateMessage(text) {
  const t = String(text ?? '');
  const re = /^PayOnce spend mandate v1 \(Concordium testnet\)\nAccount: ([1-9A-HJ-NP-Za-km-z]{50})\nAgent token: (\d{1,9})\nPer purchase cap: (\d{1,15}) micro CCD\nTotal budget: (\d{1,15}) micro CCD\nExpires: (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)\nMandate id: ([0-9a-f]{24})$/;
  const x = re.exec(t);
  if (!x) return null;
  const m = { account: x[1], agent_token: Number(x[2]), per_purchase_micro: x[3], total_micro: x[4], expires_ms: Date.parse(x[5]), id: x[6] };
  if (!Number.isFinite(m.expires_ms) || mandateMessage(m) !== t) return null;
  if (BigInt(m.per_purchase_micro) < 1n || BigInt(m.total_micro) < BigInt(m.per_purchase_micro)) return null;
  return m;
}

const sigOk = (sig) => sig && typeof sig === 'object' && Object.values(sig).length > 0 && Object.values(sig).every((k) => k && typeof k === 'object' && Object.values(k).every((x) => /^[0-9a-f]{128}$/i.test(String(x))));

/**
 * deps: {
 *   kv {get, put, putIfAbsent, list}, now(),
 *   accountInfo(address) -> AccountInfo,
 *   anchorStatus(txHash) -> { status: 'finalized'|..., dataHex, sender }   (null/throws when unknown to the node),
 *   explorer(txHash) -> url,
 *   // used by bootstrap only (the buyer account signs and sends):
 *   buyer?: { account, agent_token, sign(message) -> signature JSON, sendAnchor(dataHex) -> { txHash } (throws .notSent when refused before acceptance) },
 *   defaults?: { per_purchase_micro, total_micro, ttl_ms },
 * }
 */
export function createMandates(deps) {
  const now = deps.now ?? Date.now;
  let chain = Promise.resolve();
  const serial = (fn) => { const p = chain.then(fn, fn); chain = p.catch(() => {}); return p; };
  const curKey = (account) => `current:${account}`;

  async function anchorView(a) {
    if (!a?.tx_hash) return { state: a?.state ?? 'none', tx_hash: null };
    let status = a.finalized ? { status: 'finalized' } : null;
    if (!a.finalized) { try { status = await deps.anchorStatus(a.tx_hash); } catch { status = null; } }
    return { state: status?.status ?? a.state ?? 'sent', tx_hash: a.tx_hash, explorer_url: deps.explorer?.(a.tx_hash) ?? null, data_hex: a.data_hex, sender: a.sender ?? status?.sender ?? null };
  }

  async function anchorOk(rec) {
    const a = rec.anchor;
    if (!a?.tx_hash) return { ok: false, why: 'the mandate is not anchored on chain yet' };
    if (a.finalized) return { ok: true };
    let s; try { s = await deps.anchorStatus(a.tx_hash); } catch { return { ok: false, why: 'the anchor transaction could not be read from the node' }; }
    if (s?.status !== 'finalized') return { ok: false, why: `the anchor transaction is ${s?.status ?? 'unknown'}, not finalized` };
    if (String(s.dataHex ?? '').toLowerCase() !== anchorDataHex(rec.hash)) return { ok: false, why: 'the anchor transaction does not carry this mandate hash' };
    if (s.sender && s.sender !== rec.account) return { ok: false, why: 'the anchor transaction was not sent by the mandate account' };
    rec.anchor = { ...a, finalized: true, sender: s.sender ?? a.sender ?? null };
    await deps.kv.put(NS, rec.hash, rec);
    return { ok: true };
  }

  async function checkSignature(message, signature, account) {
    if (!sigOk(signature)) throw new MandateError(400, 'bad_signature', 'signature is the account\u2019s JSON {credIndex: {keyIndex: hex}}.');
    const info = await deps.accountInfo(account);
    let ok = false;
    try { ok = await verifyMessageSignature(message, signature, info); } catch { ok = false; }
    if (!ok) throw new MandateError(422, 'bad_signature', 'The signature does not verify against the account\u2019s keys on chain.');
  }

  async function spentOf(hash) {
    const rows = await deps.kv.list(`${NS}_spend`);
    return rows.map((r) => r.value).filter((r) => r.mandate === hash && r.state !== 'failed').reduce((a, r) => a + BigInt(r.amount_micro), 0n);
  }

  /** Register a signed mandate (any account): signature checked against the account's keys, anchor checked on chain. */
  async function register({ message, signature, anchor_tx }) {
    const m = parseMandateMessage(message);
    if (!m) throw new MandateError(400, 'bad_message', 'The mandate text is not the PayOnce spend mandate v1 format.');
    if (!ADDR.test(m.account)) throw new MandateError(400, 'bad_account', 'Bad account.');
    if (m.expires_ms <= now()) throw new MandateError(410, 'expired', 'That mandate is already expired.');
    await checkSignature(message, signature, m.account);
    const hash = sha256Hex(message);
    const existing = await deps.kv.get(NS, hash);
    if (existing?.anchor?.finalized) return view(existing);
    if (!HASH.test(String(anchor_tx ?? ''))) throw new MandateError(400, 'anchor_required', 'anchor_tx (the finalized registerData transaction, sent by the account) is required.');
    let s; try { s = await deps.anchorStatus(anchor_tx); } catch { s = null; }
    if (!s || s.status !== 'finalized') throw new MandateError(409, 'anchor_not_final', `The anchor transaction is ${s?.status ?? 'not known to the node'}; wait for finalization.`);
    if (String(s.dataHex ?? '').toLowerCase() !== anchorDataHex(hash)) throw new MandateError(422, 'anchor_mismatch', 'The anchor transaction does not carry PMD1 + sha256(message).');
    if (!s.sender || s.sender !== m.account) throw new MandateError(422, 'anchor_sender', 'The anchor transaction was not sent by the mandate account.');
    const rec = { hash, ...m, message, signature, created_at: new Date(now()).toISOString(), anchor: { tx_hash: anchor_tx, finalized: true, data_hex: anchorDataHex(hash), sender: s.sender, state: 'finalized' } };
    await deps.kv.put(NS, hash, rec);
    await deps.kv.put(NS, curKey(m.account), { hash, at: rec.created_at });
    return view(rec);
  }

  async function view(rec) {
    const spent = await spentOf(rec.hash);
    const cur = await deps.kv.get(NS, curKey(rec.account));
    return {
      hash: rec.hash, account: rec.account, agent_token: rec.agent_token, per_purchase_micro: String(rec.per_purchase_micro), total_micro: String(rec.total_micro),
      expires_at: new Date(rec.expires_ms).toISOString(), expired: now() >= rec.expires_ms, current: cur?.hash === rec.hash,
      message: rec.message, signature: rec.signature, anchor: await anchorView(rec.anchor), anchor_data_format: 'registerData = "PMD1" (4 bytes) + sha256(message) (32 bytes), sent by the account',
      spent_micro: spent.toString(), remaining_micro: (BigInt(rec.total_micro) - spent).toString(),
    };
  }

  async function get(hashOrCurrent, account = deps.buyer?.account) {
    let hash = hashOrCurrent;
    if (hash === 'current') { const c = await deps.kv.get(NS, curKey(account)); if (!c) return null; hash = c.hash; }
    if (!HASH.test(String(hash))) return null;
    const rec = await deps.kv.get(NS, hash);
    return rec ? view(rec) : null;
  }

  /**
   * One-time setup for PayOnce's reference buyer: build the mandate with fixed defaults, sign it with the buyer account,
   * send ONE anchor from the buyer account and register it. The send is claimed in the store before it happens and is never
   * repeated: if its outcome is unknown, a later call only re-reads the same transaction.
   */
  function bootstrap() {
    return serial(async () => {
      const b = deps.buyer; if (!b) throw new MandateError(503, 'no_buyer', 'No buyer account is configured.');
      const cur = await deps.kv.get(NS, curKey(b.account));
      if (cur) { const v = await get(cur.hash); if (v && !v.expired) return { state: 'ready', ...v }; }
      const claim = await deps.kv.get(NS, `pending:${b.account}`);
      let pending = claim;
      if (!pending) {
        const d = deps.defaults ?? {};
        const m = { account: b.account, agent_token: b.agent_token, per_purchase_micro: String(d.per_purchase_micro ?? '100000'), total_micro: String(d.total_micro ?? '1000000'), expires_ms: now() + (d.ttl_ms ?? 14 * 86_400_000), id: randomBytes(12).toString('hex') };
        const message = mandateMessage(m);
        const signature = await b.sign(message);
        await checkSignature(message, signature, m.account);
        pending = { hash: sha256Hex(message), message, signature, tx_hash: null, state: 'claimed', at: new Date(now()).toISOString() };
        await deps.kv.put(NS, `pending:${b.account}`, pending);
      }
      if (!pending.tx_hash) {
        if (pending.state === 'sending') return { state: 'anchor_unknown', hash: pending.hash, note: 'An anchor send was started and its outcome is not known. It is not repeated. Pass the transaction to POST /api/mandate/register once you have it.' };
        pending.state = 'sending'; await deps.kv.put(NS, `pending:${b.account}`, pending);
        try { const { txHash } = await b.sendAnchor(anchorDataHex(pending.hash)); pending.tx_hash = txHash; pending.state = 'sent'; }
        catch (e) { if (e?.notSent) { pending.state = 'claimed'; await deps.kv.put(NS, `pending:${b.account}`, pending); throw new MandateError(503, 'anchor_not_sent', 'The node refused the anchor before accepting it; nothing was sent. Try again.'); } throw e; }
        await deps.kv.put(NS, `pending:${b.account}`, pending);
      }
      let s; try { s = await deps.anchorStatus(pending.tx_hash); } catch { s = null; }
      if (s?.status !== 'finalized') return { state: 'anchor_pending', hash: pending.hash, tx_hash: pending.tx_hash, explorer_url: deps.explorer?.(pending.tx_hash), note: 'The anchor is sent and not finalized yet. Call again in a few seconds; nothing is sent twice.' };
      const out = await register({ message: pending.message, signature: pending.signature, anchor_tx: pending.tx_hash });
      return { state: 'ready', ...out };
    });
  }

  /** Buyer side: may this purchase happen? Reserves the amount so two purchases cannot overspend. */
  function authorize({ amount_micro, pay_to = null, purpose = null }) {
    return serial(async () => {
      const b = deps.buyer; if (!b) return { ok: false, code: 'no_mandate', reason: 'No spend mandate is configured for this buyer agent.' };
      const cur = await deps.kv.get(NS, curKey(b.account));
      if (!cur) return { ok: false, code: 'no_mandate', reason: 'This buyer agent has no spend mandate, so it spends nothing.' };
      const rec = await deps.kv.get(NS, cur.hash);
      const amount = BigInt(amount_micro);
      if (!rec) return { ok: false, code: 'no_mandate', reason: 'The mandate record is missing.' };
      if (now() >= rec.expires_ms) return { ok: false, code: 'mandate_expired', reason: `The mandate expired at ${new Date(rec.expires_ms).toISOString()}.`, mandate: rec.hash };
      const a = await anchorOk(rec);
      if (!a.ok) return { ok: false, code: 'mandate_not_anchored', reason: `The mandate cannot be used: ${a.why}.`, mandate: rec.hash };
      if (amount > BigInt(rec.per_purchase_micro)) return { ok: false, code: 'over_per_purchase_cap', reason: `${amount} micro CCD is above the mandate's per-purchase cap of ${rec.per_purchase_micro} micro CCD. A person approving it does not change that.`, mandate: rec.hash };
      const spent = await spentOf(rec.hash);
      if (spent + amount > BigInt(rec.total_micro)) return { ok: false, code: 'over_total_budget', reason: `${amount} micro CCD would take the total to ${spent + amount}, above the mandate's budget of ${rec.total_micro} micro CCD.`, mandate: rec.hash, spent_micro: spent.toString() };
      const rid = `${rec.hash}:${String(Date.now())}:${randomBytes(3).toString('hex')}`;
      await deps.kv.put(`${NS}_spend`, rid, { id: rid, mandate: rec.hash, amount_micro: amount.toString(), pay_to, purpose, state: 'reserved', at: new Date(now()).toISOString(), tx_hash: null });
      return { ok: true, reservation: rid, mandate: rec.hash, headers: { 'x-buyer-agent': String(rec.agent_token), 'x-buyer-mandate': rec.hash } };
    });
  }
  /** After the purchase: record the settled tx, or release the reservation when nothing was settled and the seller said no. */
  async function settle(reservation, { tx_hash = null, released = false } = {}) {
    const r = await deps.kv.get(`${NS}_spend`, reservation);
    if (!r) return null;
    r.state = tx_hash ? 'settled' : released ? 'failed' : 'unknown'; r.tx_hash = tx_hash;
    await deps.kv.put(`${NS}_spend`, reservation, r);
    return r;
  }
  async function spends(hash) { return (await deps.kv.list(`${NS}_spend`)).map((x) => x.value).filter((x) => x.mandate === hash).sort((a, b) => String(a.at).localeCompare(String(b.at))); }

  /** Seller side: is this payer a mandated buyer for this price? Re-checks signature and anchor, never trusts the header alone. */
  async function verifyForSale({ hash, token, payer, amount_micro }) {
    const reasons = [];
    if (!HASH.test(String(hash ?? ''))) return { ok: false, reasons: ['X-Buyer-Mandate is not a 64-hex mandate hash'] };
    const rec = await deps.kv.get(NS, hash);
    if (!rec) return { ok: false, reasons: ['this mandate is not registered with PayOnce (POST /api/mandate/register)'] };
    if (rec.account !== payer) reasons.push('the mandate belongs to a different account than the one paying');
    if (token != null && Number(token) !== rec.agent_token) reasons.push('the mandate names a different agent token');
    if (now() >= rec.expires_ms) reasons.push('the mandate is expired');
    const cur = await deps.kv.get(NS, curKey(rec.account));
    if (cur?.hash !== hash) reasons.push('the mandate was superseded by a newer one');
    if (BigInt(amount_micro) > BigInt(rec.per_purchase_micro)) reasons.push(`the price ${amount_micro} is above the mandate's per-purchase cap ${rec.per_purchase_micro}`);
    try { await checkSignature(rec.message, rec.signature, rec.account); } catch { reasons.push('the mandate signature does not verify against the account keys'); }
    const a = await anchorOk(rec); if (!a.ok) reasons.push(a.why);
    return { ok: reasons.length === 0, reasons, mandate: { hash, per_purchase_micro: String(rec.per_purchase_micro), total_micro: String(rec.total_micro), expires_at: new Date(rec.expires_ms).toISOString() } };
  }

  return { register, get, bootstrap, authorize, settle, spends, verifyForSale };
}
