// Verdict receipts: anchor a check_payee `evidence_hash` on chain (testnet registerData, ~0.02 CCD each).
//
//   POST /api/vop/anchor     { payee, name, seller?, country? }   runs check_payee ITSELF (testnet), then anchors its evidence_hash
//   GET  /api/vop/anchor/<evidence_hash>                          the receipt: tx, live chain status, the stored evidence, hash recomputed
//
// What it proves: that PayOnce's check_payee returned THIS verdict, with THESE checks, for THIS payee at (or before) the block time.
// Anyone can recompute sha256(canonicalJson(evidence)) from the stored evidence and compare it with the DataRegistered bytes on chain.
// What it does not prove: that the verdict was right (testnet names are self-asserted mock identities; the chain does not verify the ZK proof).
//
// Safety: the caller cannot choose what is anchored (the server computes the verdict). One anchor per evidence_hash (claimed in the
// store BEFORE the send, so a retry can never double-send). A send whose outcome is unknown is reported, never resubmitted.
// Budget: 3 per IP per hour and 60 per day for the whole API. Mainnet verdicts are not anchored (testnet chain, testnet owner key).
import { canonicalJson, sha256Hex } from './vop.mjs';

export const ANCHOR_PREFIX = Buffer.from('PVOP1');           // 5 bytes: "PayOnce VoP v1"
export const ANCHOR_NS = 'vop_anchor';
export const anchorBytesHex = (evidenceHashHex) => Buffer.concat([ANCHOR_PREFIX, Buffer.from(evidenceHashHex, 'hex')]).toString('hex'); // 37 bytes
const HASH = /^[0-9a-f]{64}$/;
export class AnchorError extends Error { constructor(status, code, message, extra = {}) { super(message); this.status = status; this.code = code; Object.assign(this, extra); } }

/** The part of a check result the evidence_hash covers (same fields as evidenceHash() in vop.mjs). */
export const evidenceOf = ({ verdict, verified_name, verified_country, identity_kind, standin, checks, subject }) => ({ verdict, verified_name, verified_country, identity_kind, standin, checks, subject });
export const recomputeEvidenceHash = (evidence) => sha256Hex(canonicalJson(evidence));

/**
 * deps: { check(input)->vop result, kv: { get, putIfAbsent, put }, send(dataHex)->{ txHash } (throws when the send is not accepted),
 *         status(txHash)->{ status, dataHex? }, budget(ip)->{allowed}, dayCount()/bumpDay(), now() }
 */
export function createAnchorService(deps) {
  const now = deps.now ?? Date.now;
  const dayKey = () => new Date(now()).toISOString().slice(0, 10);
  const view = (rec, live) => ({
    evidence_hash: rec.evidence_hash, anchored: rec.state === 'finalized' || live?.status === 'finalized',
    state: rec.state, tx_hash: rec.tx_hash ?? null, explorer_url: rec.tx_hash ? deps.explorer?.(rec.tx_hash) ?? null : null,
    registered_data_hex: rec.data_hex, format: 'registerData = "PVOP1" (5 bytes) + evidence_hash (32 bytes)',
    anchored_at: rec.at, network: 'testnet', chain_status: live?.status ?? null,
    chain_data_matches: live?.dataHex != null ? live.dataHex.toLowerCase() === rec.data_hex : null,
    evidence: rec.evidence, recomputed_hash_matches: recomputeEvidenceHash(rec.evidence) === rec.evidence_hash,
    how_to_verify: 'sha256 of the canonical JSON (keys sorted, no spaces) of `evidence` must equal evidence_hash, and the transaction must carry registered_data_hex. GET /api/vop/anchor/<evidence_hash> does both and shows the result.',
    note: rec.note ?? undefined,
  });

  async function anchor(input, { ip = 'unknown' } = {}) {
    if (String(input?.network ?? 'testnet').toLowerCase() === 'mainnet') throw new AnchorError(400, 'testnet_only', 'Verdict receipts are anchored on testnet only; a mainnet verdict is not anchored.');
    const w = await deps.budget(ip); if (!w.allowed) throw new AnchorError(429, 'rate_limited', 'Verdict anchors are limited to 3 per hour per address.', { retry_after_s: w.retryAfterS });
    const result = await deps.check({ ...input, network: 'testnet' });
    if (!HASH.test(result?.evidence_hash ?? '')) throw new AnchorError(502, 'no_evidence', 'check_payee returned no evidence_hash.');
    const evidence = evidenceOf(result);
    const hash = result.evidence_hash;
    if (recomputeEvidenceHash(evidence) !== hash) throw new AnchorError(500, 'hash_mismatch', 'The evidence does not recompute to the evidence_hash; nothing was anchored.');
    const existing = await deps.kv.get(ANCHOR_NS, hash);
    const retryable = existing?.state === 'failed_not_sent'; // rejected before acceptance: nothing was ever on chain, so a retry is safe
    if (existing && !retryable) return { ...view(existing, await liveOf(existing)), already_anchored: true, check: { verdict: result.verdict, checked_at: result.checked_at } };
    // global daily budget (checked after the cheap paths so an already anchored hash is always free to read)
    const day = `day:${dayKey()}`;
    const used = (await deps.kv.get(ANCHOR_NS, day))?.n ?? 0;
    if (used >= (deps.perDay ?? 60)) throw new AnchorError(429, 'daily_budget_used', 'The daily budget for verdict anchors (60) is used up. Try again tomorrow (UTC).', { retryable: true });
    const dataHex = anchorBytesHex(hash);
    // Claim BEFORE sending: a crash or a lost answer leaves a claim without a tx, which is reported and never resent.
    const claim = { evidence_hash: hash, state: 'claimed', data_hex: dataHex, evidence, at: new Date(now()).toISOString(), tx_hash: null };
    const won = retryable ? (await deps.kv.put(ANCHOR_NS, hash, claim), true) : await deps.kv.putIfAbsent(ANCHOR_NS, hash, claim);
    if (won === false) { const cur = await deps.kv.get(ANCHOR_NS, hash); return { ...view(cur, await liveOf(cur)), already_anchored: true }; }
    await deps.kv.put(ANCHOR_NS, day, { n: used + 1 });
    let sent;
    try { sent = await deps.send(dataHex); }
    catch (e) {
      // The send was rejected before acceptance (the sender throws only then): release the claim so the next call may retry.
      if (e?.notSent === true) { await deps.kv.put(ANCHOR_NS, hash, { ...claim, state: 'failed_not_sent', note: String(e.message).slice(0, 160) }); throw new AnchorError(503, 'anchor_not_sent', `The anchor was not sent (${String(e.message).slice(0, 120)}). Nothing is on chain; retry later.`, { retryable: true }); }
      await deps.kv.put(ANCHOR_NS, hash, { ...claim, state: 'unknown', note: 'The send returned no answer. Its status is unknown, so it is NOT resubmitted.' });
      throw new AnchorError(502, 'anchor_status_unknown', 'The anchor transaction may or may not have been accepted. It is not resent. Look up the receipt later with GET /api/vop/anchor/<evidence_hash>.', { evidence_hash: hash });
    }
    const rec = { ...claim, state: 'sent', tx_hash: sent.txHash };
    await deps.kv.put(ANCHOR_NS, hash, rec);
    const fin = await deps.waitFinalized(sent.txHash).catch(() => ({ ok: false }));
    const done = fin.ok ? { ...rec, state: 'finalized' } : { ...rec, note: 'Sent; not finalized yet. Poll GET /api/vop/anchor/<evidence_hash>.' };
    await deps.kv.put(ANCHOR_NS, hash, done);
    const live = await liveOf(done); // an independent read of the chain, not our own bytes
    return { ...view(done, live ?? (fin.ok ? { status: 'finalized', dataHex: null } : null)), already_anchored: false, check: { verdict: result.verdict, checked_at: result.checked_at } };
  }

  async function liveOf(rec) { if (!rec.tx_hash) return null; try { return await deps.status(rec.tx_hash); } catch { return null; } }

  async function get(hash) {
    const h = String(hash ?? '').toLowerCase();
    if (!HASH.test(h)) throw new AnchorError(400, 'bad_hash', 'evidence_hash must be 64 hex characters.');
    const rec = await deps.kv.get(ANCHOR_NS, h);
    if (!rec) throw new AnchorError(404, 'not_anchored', 'No verdict receipt is anchored for this evidence_hash.');
    const live = await liveOf(rec);
    if (live?.status === 'finalized' && rec.state !== 'finalized') { rec.state = 'finalized'; await deps.kv.put(ANCHOR_NS, h, rec); }
    return view(rec, live);
  }
  return { anchor, get };
}
