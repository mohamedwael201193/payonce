// Human approval signed by the person's wallet (G11). Testnet.
// The person's wallet signs a plain-text message (Browser Wallet signMessage / WalletConnect sign_message) naming the
// payee, the invoice name, the amount, the check_payee verdict + evidence hash and an expiry. The server verifies the
// signature against the account's keys on chain (verifyMessageSignature), stores it, appends it to the hash-chained
// ledger and asks for a prompt head anchor. A Close match payment link is built only with a valid approval.
import { randomBytes } from 'node:crypto';
import { verifyMessageSignature, AccountAddress } from '@concordium/web-sdk';
import { canonicalJson, sha256Hex } from './vop.mjs';

export class ApprovalError extends Error { constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; } }
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{50}$/;
const micro = (m) => { const v = BigInt(m); const f = (v % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, ''); return `${v / 1_000_000n}${f ? `.${f}` : ''} CCD`; };

export function approvalMessage(r) {
  return [
    'PayOnce approval v1 (Concordium testnet)',
    `I approve paying ${micro(r.amount_micro)} to account ${r.payee}.`,
    `Invoice payee name: ${r.name}`,
    `check_payee verdict: ${r.verdict} (evidence ${r.evidence_hash})`,
    `Invoice hash: ${r.invoice_hash}`,
    `Payer: ${r.payer}`,
    `Expires: ${new Date(r.expires_ms).toISOString()}`,
    `Approval id: ${r.id}`,
  ].join('\n');
}

/** deps: { kv, vop (demo book check), seller, accountInfo(address) -> AccountInfo, ledger?, hitWindow, now() } */
export function createApprovals(deps) {
  const now = deps.now ?? Date.now;
  const TTL = 10 * 60_000; const USE_TTL = 30 * 60_000;

  async function request(body, ip) {
    const payer = String(body?.payer ?? ''); const payee = String(body?.payee ?? '');
    if (!ADDR.test(payer) || !ADDR.test(payee)) throw new ApprovalError(400, 'bad_account', 'payer and payee are account addresses.');
    if (payer === payee) throw new ApprovalError(400, 'self_payment', 'payer and payee are the same account.');
    const name = String(body?.name ?? '').trim().slice(0, 140);
    if (!name) throw new ApprovalError(400, 'no_name', 'The invoice payee name is required.');
    if (!/^\d{1,13}$/.test(String(body?.amount_micro ?? ''))) throw new ApprovalError(400, 'bad_amount', 'amount_micro is a whole number of micro CCD.');
    const amount = BigInt(body.amount_micro);
    if (amount < 1n || amount > 5_000_000n) throw new ApprovalError(400, 'bad_amount', 'Testnet approvals cover 1 micro CCD to 5 CCD.');
    const w = await deps.hitWindow(`approval:req:${ip}`, 3_600_000, 12);
    if (w && w.allowed === false) throw new ApprovalError(429, 'rate_limited', 'Too many approval requests from here; try again later.');
    const check = await deps.vop.check({ seller: deps.seller, payee, legal_name: name, buyer: payer });
    if (check.verdict === 'NO_MATCH') throw new ApprovalError(409, 'no_match', 'No match: PayOnce does not ask anyone to approve a payment to a name that does not match.', { check });
    const invoice_hash = /^[0-9a-f]{64}$/.test(String(body?.invoice_hash ?? '')) ? body.invoice_hash : sha256Hex(canonicalJson({ payee, name, amount_micro: amount.toString(), reference: body?.reference ?? null }));
    const rec = { id: randomBytes(12).toString('hex'), payer, payee, name, amount_micro: amount.toString(), verdict: check.verdict, evidence_hash: check.evidence_hash, invoice_hash, expires_ms: now() + TTL, state: 'requested', created_at: new Date(now()).toISOString() };
    rec.message = approvalMessage(rec);
    await deps.kv.put('approval', rec.id, rec);
    return { approval_id: rec.id, message: rec.message, expires_at: new Date(rec.expires_ms).toISOString(), verdict: rec.verdict, evidence_hash: rec.evidence_hash, invoice_hash, check, sign_with: 'Browser Wallet: provider.signMessage(payer, message); WalletConnect: sign_message {address, message}. Then POST /api/approvals/:id/verify {signature}.' };
  }

  async function load(id) {
    if (!/^[0-9a-f]{24}$/.test(String(id))) throw new ApprovalError(400, 'bad_id', 'Unknown approval id.');
    const r = await deps.kv.get('approval', id);
    if (!r) throw new ApprovalError(404, 'not_found', 'No such approval.');
    return r;
  }

  async function verify(id, body) {
    const r = await load(id);
    if (r.state === 'approved') return view(r);
    if (now() > r.expires_ms) throw new ApprovalError(410, 'expired', 'This approval request expired; request a new one.');
    let sig = body?.signature;
    if (typeof sig === 'string') { try { sig = JSON.parse(sig); } catch { throw new ApprovalError(400, 'bad_signature', 'signature is the wallet\u2019s JSON {credIndex: {keyIndex: hex}}.'); } }
    if (!sig || typeof sig !== 'object' || !Object.values(sig).every((k) => k && typeof k === 'object' && Object.values(k).every((x) => /^[0-9a-f]{128}$/i.test(String(x))))) throw new ApprovalError(400, 'bad_signature', 'signature is the wallet\u2019s JSON {credIndex: {keyIndex: hex}}.');
    const info = await deps.accountInfo(r.payer);
    let ok = false;
    try { ok = await verifyMessageSignature(r.message, sig, info); } catch { ok = false; }
    if (!ok) throw new ApprovalError(422, 'bad_signature', 'The signature does not verify against the payer account\u2019s keys on chain.');
    const approval_hash = sha256Hex(canonicalJson({ message: r.message, signature: sig, payer: r.payer }));
    let ledger = null; let anchor = null;
    if (deps.ledger) {
      ledger = await deps.ledger.append({ kind: 'approval', approval_id: r.id, approval_hash, payer: r.payer, payee: r.payee, amount_micro: r.amount_micro, verdict: r.verdict, evidence_hash: r.evidence_hash, invoice_hash: r.invoice_hash });
      anchor = await deps.ledger.anchorHead({ urgent: true }).catch((e) => ({ error: String(e?.message ?? e).slice(0, 120) }));
    }
    Object.assign(r, { state: 'approved', signature: sig, approval_hash, approved_at: new Date(now()).toISOString(), use_until_ms: now() + USE_TTL, ledger, anchor: anchor && { seq: anchor.seq ?? null, tx_hash: anchor.tx_hash ?? null, state: anchor.state ?? null, skipped: anchor.skipped ?? null } });
    await deps.kv.put('approval', r.id, r);
    return view(r);
  }

  function view(r) {
    return { approval_id: r.id, state: r.state, approved: r.state === 'approved', payer: r.payer, payee: r.payee, name: r.name, amount_micro: r.amount_micro, verdict: r.verdict, evidence_hash: r.evidence_hash, invoice_hash: r.invoice_hash, message: r.message, signature: r.signature ?? null, approval_hash: r.approval_hash ?? null, approved_at: r.approved_at ?? null, ledger: r.ledger ?? null, anchor: r.anchor ?? null, expires_at: new Date(r.expires_ms).toISOString() };
  }
  const get = async (id) => view(await load(id));

  /** For pay-tx: a valid, unexpired approval for exactly this payer, payee and amount. */
  async function valid(id, { payer, payee, amount_micro }) {
    const r = await load(id);
    if (r.state !== 'approved') throw new ApprovalError(409, 'not_approved', 'That approval is not signed yet.');
    if (r.payer !== payer || r.payee !== payee || r.amount_micro !== String(amount_micro)) throw new ApprovalError(409, 'approval_mismatch', 'That approval is for a different payer, payee or amount.');
    if (now() > r.use_until_ms) throw new ApprovalError(410, 'expired', 'That approval is older than 30 minutes; sign a new one.');
    return view(r);
  }

  return { request, verify, get, valid };
}
// exported for tests
export const _addr = (a) => AccountAddress.fromBase58(a);
