// Visitor-wallet 18+ proof (WS1): POST /api/wallet/age-proof/request, POST /api/wallet/age-proof/verify.
// The visitor's OWN wallet proves "18 or older" (nothing else is revealed): the server anchors a V&A V1 request
// (VRA) that asks for exactly one dob range, the wallet answers, the node verifies the presentation, the
// credential holder must be the connected account, and an audit record (VAA) is anchored. A V0 (Web3 ID)
// fallback is offered for wallets without V1: Concordium's testnet verifier checks the proof and the request's
// one-time challenge, and the presentation's own statement must be a dob range proving 18+.
// This is NOT the hosted prover check (/api/age-proof/v1, one PayOnce credential): it is the visitor's credential.
import { randomBytes, createHash } from 'node:crypto';
import { provesAdult } from './age-proof.mjs';

export class AgeError extends Error {
  constructor(status, code, message, extra) { super(message); this.status = status; this.code = code; this.extra = extra; }
}
export const AGE_TTL_MS = 10 * 60_000;
export const AGE_FRESH_MS = 10 * 60_000;
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{50}$/;
const SELLER_ID = /^[a-zA-Z0-9_.:-]{1,48}$/;

const ymd = (nowMs, years, plusDays = 0) => {
  const d = new Date(nowMs); d.setUTCDate(d.getUTCDate() + plusDays);
  return `${d.getUTCFullYear() - years}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
};
/** V0 statements for 18+: a dob range, upper = today minus 18 years (the same bound the V1 builder uses). */
export const ageStatementsV0 = (issuers, nowMs) => [{ idQualifier: { type: 'cred', issuers }, statement: [{ type: 'AttributeInRange', attributeTag: 'dob', lower: '18000101', upper: ymd(nowMs, 18, 1) }] }];

function credIdOf(p) {
  for (const c of Array.isArray(p?.verifiableCredential) ? p.verifiableCredential : []) {
    const m = /cred:([0-9a-fA-F]{96})/.exec(String(c?.credentialSubject?.id ?? c?.id ?? ''));
    if (m) return m[1].toLowerCase();
  }
  return null;
}
/** The statements a V0 presentation itself proves, shaped like a V1 request so provesAdult can read them. */
function v0AsRequest(p) {
  const st = [];
  for (const c of Array.isArray(p?.verifiableCredential) ? p.verifiableCredential : []) for (const s of c?.credentialSubject?.statement ?? []) st.push(s);
  return { subjectClaims: [{ statements: st }] };
}

/**
 * deps: { kv, now, issuers, anchorV1Request({account, seller_id, nonceHex}) -> { request, vra_tx },
 *         verifyV1({request, presentation}) -> { ok, reason, vaa_tx }, verifyV0({presentation}) -> { ok, reason, challenge },
 *         holderAccount(credIdHex) -> address|null, hitWindow(key, windowMs, limit) }
 */
export function createWalletAge(deps) {
  const { kv } = deps; const now = deps.now ?? Date.now;
  const budget = async (key, ms, limit, msg) => { const w = await deps.hitWindow?.(key, ms, limit); if (w && w.allowed === false) throw new AgeError(429, 'rate_limited', msg, { retryable: true, retry_after_s: Math.ceil((w.resetMs ?? 60_000) / 1000) }); };

  async function request({ account, seller_id, wallet = 'browser' } = {}, ip = 'ip') {
    if (!ADDR.test(String(account ?? ''))) throw new AgeError(400, 'bad_account', 'Connect a Concordium account first.');
    if (!SELLER_ID.test(String(seller_id ?? ''))) throw new AgeError(400, 'bad_seller', 'seller_id is missing or malformed.');
    await budget(`age:req:ip:${ip}`, 3_600_000, 6, 'Too many 18+ requests from here this hour (each anchors a small transaction).');
    await budget(`age:req:acct:${account}`, 86_400_000, 10, 'This account asked for several 18+ proofs today; try tomorrow.');
    const id = randomBytes(12).toString('hex'); const nonceHex = randomBytes(32).toString('hex');
    const challenge = createHash('sha256').update(`payonce-age:${account}:${seller_id}:${nonceHex}`).digest('hex');
    const rec = { id, account, seller_id, challenge, created_ms: now(), expires_ms: now() + AGE_TTL_MS, used: false };
    const out = { request_id: id, expires_at: new Date(rec.expires_ms).toISOString(), reveals: [], proves: 'age 18 or older (nothing else is revealed)' };
    if (wallet === 'browser') {
      const a = await deps.anchorV1Request({ account, seller_id, nonceHex });
      rec.v1 = a.request; rec.vra_tx = a.vra_tx; out.v1 = a.request; out.vra_tx = a.vra_tx;
    }
    out.v0 = { challenge, statements: ageStatementsV0(deps.issuers ?? [0], now()) };
    await kv.put('age_wallet_req', id, rec);
    return out;
  }

  async function verify({ request_id, version, presentation } = {}, ip = 'ip') {
    await budget(`age:verify:ip:${ip}`, 60_000, 12, 'Too many verify attempts; wait a minute.');
    const rec = await kv.get('age_wallet_req', String(request_id ?? ''));
    if (!rec) throw new AgeError(404, 'no_request', 'Unknown 18+ request. Start again.');
    if (rec.used) throw new AgeError(409, 'request_used', 'This 18+ request was already answered. Start again.');
    if (rec.expires_ms < now()) throw new AgeError(410, 'request_expired', 'The 18+ request expired (10 minutes). Start again.');
    let pres;
    try { pres = typeof presentation === 'string' ? JSON.parse(presentation) : presentation; } catch { throw new AgeError(400, 'bad_presentation', 'The wallet returned a presentation that is not JSON.'); }
    if (!pres || typeof pres !== 'object') throw new AgeError(400, 'bad_presentation', 'No presentation.');
    await kv.put('age_wallet_req', rec.id, { ...rec, used: true });
    const checks = []; const add = (id, label, ok, detail) => checks.push({ id, label, status: ok ? 'ok' : 'fail', detail });
    let vaa = null;
    if (version === 'v1') {
      if (!rec.v1) throw new AgeError(409, 'no_v1', 'This request has no anchored V1 request.');
      add('asks_18', 'The anchored request asks for a dob range proving 18+ and nothing else', provesAdult(rec.v1, now()) && !(rec.v1.subjectClaims?.[0]?.statements ?? []).some((s) => s.type === 'RevealAttribute'), 'request statements checked');
      const r = await deps.verifyV1({ request: rec.v1, presentation: pres });
      add('verified', 'The node verified the presentation against the anchored request (V&A V1)', r.ok, r.ok ? 'VerifiablePresentationV1.verifyWithNode: success' : r.reason);
      vaa = r.vaa_tx ?? null;
    } else {
      const r = await deps.verifyV0({ presentation: pres });
      add('verified', 'Concordium’s testnet verifier accepted the presentation', r.ok, r.ok ? 'web3id-verifier: valid' : r.reason);
      if (r.ok) add('challenge', 'The presentation answers this request’s one-time challenge', r.challenge === rec.challenge, r.challenge === rec.challenge ? 'challenge matches' : 'challenge differs');
      add('asks_18', 'The proven statement is a dob range proving 18+', provesAdult(v0AsRequest(pres), now()), 'statement read from the presentation');
    }
    const credId = credIdOf(pres);
    const holder = credId ? await deps.holderAccount(credId).catch(() => null) : null;
    add('holder', 'The proof comes from a credential of the connected account', holder === rec.account, holder ? (holder === rec.account ? 'holder account matches' : `holder is ${holder.slice(0, 10)}…`) : 'holder could not be resolved');
    const ok = checks.every((c) => c.status === 'ok');
    if (!ok) return { verified: false, vaa_tx: null, checks };
    const proof = { account: rec.account, seller_id: rec.seller_id, version: version === 'v1' ? 'v1' : 'v0', vra_tx: rec.vra_tx ?? null, vaa_tx: vaa, verified_at: new Date(now()).toISOString(), verified_ms: now(), request_id: rec.id };
    await kv.put('age_wallet_proof', `${rec.account}:${rec.seller_id}`, proof);
    return { verified: true, vaa_tx: vaa, valid_for_seconds: AGE_FRESH_MS / 1000, checks, proof };
  }

  /** For gated services: a fresh (10 min) 18+ proof of this account for this seller, or null. */
  async function fresh(account, seller_id) {
    const p = await kv.get('age_wallet_proof', `${account}:${seller_id}`);
    return p && now() - Number(p.verified_ms ?? 0) <= AGE_FRESH_MS ? p : null;
  }
  return { request, verify, fresh };
}
