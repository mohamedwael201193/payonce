// PayOnce API - Verification of Payee, step 1: the payee proves, from its own wallet, the name its invoices carry.
//
//   person:   reveal firstName + lastName of the identity behind the account (any testnet identity provider)
//   business: reveal legalName (+ lei / registration authority when held) from a company identity (e.g. Global FinReg)
//
// Browser Wallet: V&A V1. PayOnce anchors a Verification Request (VRA) on chain, the wallet answers with
// requestVerifiablePresentationV1, the node verifies it, PayOnce anchors the audit record (VAA).
// CryptoX over WalletConnect: the V0 Web3 ID presentation (request_verifiable_presentation), checked by Concordium's
// official testnet verifier. Either way the proof must come from a credential of THIS account (holder binding), and
// the revealed name is filed for the account. check_payee then compares an invoice's payee name with it.
import { randomBytes, createHash } from 'node:crypto';
import { OpenError, isAddress } from './open-sellers.mjs';

export const PROOF_KINDS = Object.freeze({
  person: { tags: ['firstName', 'lastName'], label: 'your legal name (first and last name)' },
  business: { tags: ['legalName'], label: 'your company’s legal name' },
});
export const TESTNET_IDPS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
const TTL_MS = 10 * 60 * 1000;

/** Revealed attribute values from a V1 (AttributeValue statements) or V0 (RevealAttribute + proofValue) presentation. */
export function revealedAttributes(presentation) {
  const out = {};
  const creds = Array.isArray(presentation?.verifiableCredential) ? presentation.verifiableCredential : [];
  for (const c of creds) {
    const subj = c?.credentialSubject ?? {};
    const statements = Array.isArray(subj.statement) ? subj.statement : [];
    const proofs = Array.isArray(c?.proof?.proofValue) ? c.proof.proofValue : Array.isArray(subj?.proof?.proofValue) ? subj.proof.proofValue : [];
    statements.forEach((s, i) => {
      if (!s?.attributeTag) return;
      if (s.type === 'AttributeValue' && s.attributeValue != null) out[s.attributeTag] = String(s.attributeValue);
      else if (s.type === 'RevealAttribute' && proofs[i]?.attribute != null) out[s.attributeTag] = String(proofs[i].attribute);
    });
  }
  return out;
}

export function provenName(kind, attrs) {
  if (kind === 'business') return attrs.legalName ? attrs.legalName.trim() : null;
  const n = [attrs.firstName, attrs.lastName].filter(Boolean).join(' ').trim();
  return n || null;
}

// ---- EPC-style name matching (match / close_match / no_match) ----
const STOP = new Set(['ltd', 'limited', 'llc', 'inc', 'gmbh', 'ag', 'sa', 'bv', 'nv', 'plc', 'co', 'company', 'corp', 'corporation', 'the', 'and', 'aps', 'ab', 'oy', 'srl', 'spa', 'sarl']);
export function normalizeName(s) {
  return String(s ?? '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w));
}
function lev(a, b) {
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1) for (let j = 1; j <= b.length; j += 1) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
  return d[a.length][b.length];
}
/** match: same words after normalization; close_match: one small typo or a missing/extra word; else no_match. */
export function nameMatch(claimed, proven) {
  const a = normalizeName(claimed); const b = normalizeName(proven);
  if (!a.length || !b.length) return { verdict: 'no_match', score: 0 };
  const ja = a.join(' '); const jb = b.join(' ');
  if (ja === jb || [...a].sort().join(' ') === [...b].sort().join(' ')) return { verdict: 'match', score: 1 };
  const dist = lev(ja, jb);
  const sim = 1 - dist / Math.max(ja.length, jb.length);
  const sa = new Set(a); const common = b.filter((w) => sa.has(w)).length;
  const subset = common === Math.min(a.length, b.length) && Math.abs(a.length - b.length) === 1;
  if (sim >= 0.85 || subset) return { verdict: 'close_match', score: Number(sim.toFixed(3)) };
  return { verdict: 'no_match', score: Number(sim.toFixed(3)) };
}

/**
 * deps: { kv, now, anchorV1Request({account, kind, tags, nonceHex}) -> { request (JSON), vra_tx },
 *         verifyV1({ request, presentation }) -> { ok, reason, holderCredId? , vaa_tx? , presentationJson },
 *         verifyV0({ presentation }) -> { ok, reason, challenge },
 *         holderAccount(credIdHex) -> address | null }
 */
export function createPayeeProofs(deps) {
  const { kv, now = Date.now } = deps;

  async function request({ account, kind = 'person', wallet = 'browser' }) {
    if (!isAddress(account)) throw new OpenError(400, 'bad_account', 'Connect a Concordium account first.');
    const k = PROOF_KINDS[kind];
    if (!k) throw new OpenError(400, 'bad_kind', 'kind must be "person" or "business".');
    const id = randomBytes(12).toString('hex');
    const nonceHex = randomBytes(32).toString('hex');
    const challenge = createHash('sha256').update(`payonce-payee-proof:${account}:${nonceHex}`).digest('hex');
    const rec = { id, account, kind, tags: k.tags, challenge, created_ms: now(), expires_ms: now() + TTL_MS, used: false };
    const out = { request_id: id, kind, reveals: k.tags, expires_at: new Date(rec.expires_ms).toISOString() };
    if (wallet === 'browser') {
      const anchored = await deps.anchorV1Request({ account, kind, tags: k.tags, nonceHex });
      rec.v1 = anchored.request; rec.vra_tx = anchored.vra_tx;
      out.v1 = anchored.request; out.vra_tx = anchored.vra_tx;
    }
    out.v0 = { challenge, statements: [{ idQualifier: { type: 'cred', issuers: TESTNET_IDPS }, statement: k.tags.map((t) => ({ type: 'RevealAttribute', attributeTag: t })) }] };
    await kv.put('payee_proof_req', id, rec);
    return out;
  }

  async function verify({ request_id, version, presentation }) {
    const rec = await kv.get('payee_proof_req', String(request_id ?? ''));
    if (!rec) throw new OpenError(404, 'no_request', 'Unknown proof request. Start again.');
    if (rec.used) throw new OpenError(409, 'request_used', 'This proof request was already answered. Start again.');
    if (rec.expires_ms < now()) throw new OpenError(410, 'request_expired', 'The proof request expired (10 minutes). Start again.');
    let pres;
    try { pres = typeof presentation === 'string' ? JSON.parse(presentation) : presentation; } catch { throw new OpenError(400, 'bad_presentation', 'The wallet returned a presentation that is not JSON.'); }
    if (!pres || typeof pres !== 'object') throw new OpenError(400, 'bad_presentation', 'No presentation.');
    await kv.put('payee_proof_req', rec.id, { ...rec, used: true });
    const checks = [];
    const add = (id, label, ok, detail) => checks.push({ id, label, status: ok ? 'ok' : 'fail', detail });
    let vaa = null;
    if (version === 'v1') {
      if (!rec.v1) throw new OpenError(409, 'no_v1', 'This request has no anchored V1 request.');
      const r = await deps.verifyV1({ request: rec.v1, presentation: pres });
      add('verified', 'The node verified the presentation against the anchored request (V&A V1)', r.ok, r.ok ? 'VerifiablePresentationV1.verifyWithNode: success' : r.reason);
      vaa = r.vaa_tx ?? null;
    } else {
      const r = await deps.verifyV0({ presentation: pres });
      add('verified', 'Concordium’s testnet verifier accepted the presentation', r.ok, r.ok ? 'web3id-verifier: valid' : r.reason);
      if (r.ok) add('challenge', 'The presentation answers this request’s one-time challenge', r.challenge === rec.challenge, r.challenge === rec.challenge ? 'challenge matches' : 'challenge differs');
    }
    const credId = extractCredId(pres);
    const holder = credId ? await deps.holderAccount(credId).catch(() => null) : null;
    add('holder', 'The proof comes from a credential of the connected account', holder === rec.account, holder ? (holder === rec.account ? 'holder account matches' : `holder is ${holder.slice(0, 10)}…`) : 'holder could not be resolved');
    const attrs = revealedAttributes(pres);
    const name = provenName(rec.kind, attrs);
    add('name', `The wallet revealed ${PROOF_KINDS[rec.kind].label}`, Boolean(name), name ? 'revealed' : 'no name in the presentation');
    const ok = checks.every((c) => c.status === 'ok');
    if (!ok) return { verified: false, checks };
    const proof = { account: rec.account, kind: rec.kind, name, attributes: Object.fromEntries(rec.tags.map((t) => [t, attrs[t] ?? null])), version: version === 'v1' ? 'v1' : 'v0', vra_tx: rec.vra_tx ?? null, vaa_tx: vaa, verified_at: new Date(now()).toISOString(), issuer: issuerOf(pres) };
    await kv.put('payee_proof', rec.account, proof);
    return { verified: true, checks, proof };
  }

  async function get(account) {
    if (!isAddress(account)) throw new OpenError(400, 'bad_account', 'That is not a Concordium account address.');
    return { account, proof: await kv.get('payee_proof', account) };
  }

  async function match(account, claimed) {
    const { proof } = await get(account);
    if (!proof) return { account, verdict: 'unverified', claimed_name: claimed ?? null, proven_name: null, proof: null };
    const m = nameMatch(claimed, proof.name);
    return { account, verdict: m.verdict, score: m.score, claimed_name: claimed, proven_name: m.verdict === 'match' ? proof.name : m.verdict === 'close_match' ? proof.name : null, proof: { kind: proof.kind, version: proof.version, vra_tx: proof.vra_tx, vaa_tx: proof.vaa_tx, verified_at: proof.verified_at, issuer: proof.issuer } };
  }

  return { request, verify, get, match };
}

function extractCredId(p) {
  const creds = Array.isArray(p?.verifiableCredential) ? p.verifiableCredential : [];
  for (const c of creds) {
    const id = String(c?.credentialSubject?.id ?? c?.id ?? '');
    const m = /cred:([0-9a-fA-F]{96})/.exec(id);
    if (m) return m[1].toLowerCase();
  }
  return null;
}
function issuerOf(p) {
  const creds = Array.isArray(p?.verifiableCredential) ? p.verifiableCredential : [];
  return creds[0]?.issuer ?? null;
}
