// PayOnce — check_payee: Verification of Payee for an agent about to pay.
//
//   check_payee({ seller, payee, legal_name, country?, buyer? })
//     -> { verdict: MATCH | CLOSE_MATCH | NO_MATCH | UNVERIFIED, payable, evidence_hash, checks[], ... }
//
// Every input is public and re-checkable without keys:
//   1. the payee book on chain (payable_registry_v3.get_payee): bound by the
//      payee account's own signature, version, cooling-off;
//   2. the payee account's credentials on chain (identity-provider index:
//      Global FinReg = business, others = natural person);
//   3. the zero-knowledge presentation whose sha256 is the book's
//      proof_anchor, re-verified with the node on every check
//      (VerifiablePresentationV1.verifyWithNode, no key, no PayOnce trust);
//   4. the EPC-style name match of the invoice name against the proven name.
// The agent's policy (agent-side) pays only on `payable: true`.
import { decideVop, evidenceHash, presentationAnchor, canonicalJson, legalNameHash, VERDICT, VERDICT_CODE, BUSINESS_IDPS, sha256Hex } from './vop.mjs';
import { revealedAttributes } from './payee-proof.mjs';
import { V3, v3Label, getPayeeRecord, getPayeeAck, accountIdentity, serAcknowledgePayee } from './vop-chain.mjs';

export class VopError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const ADDR = /^[1-9A-HJ-NP-Za-km-z]{50}$/;

/** Public facts of a presentation JSON (V1 or V0): credential ids, issuers, revealed values, Nonce. */
export function factsFromPresentation(pres) {
  const out = { credIds: [], idpIndexes: [], revealed: revealedAttributes(pres), given: {} };
  const seen = new Set();
  const walk = (v, depth = 0) => {
    if (depth > 12 || v == null) return;
    if (typeof v === 'string') {
      const c = /did:ccd:(?:testnet|mainnet):cred:([0-9a-fA-F]{96})/.exec(v);
      if (c && !seen.has(c[1].toLowerCase())) { seen.add(c[1].toLowerCase()); out.credIds.push(c[1].toLowerCase()); }
      const i = /did:ccd:(?:testnet|mainnet):idp:(\d+)/.exec(v);
      if (i && !out.idpIndexes.includes(Number(i[1]))) out.idpIndexes.push(Number(i[1]));
      return;
    }
    if (Array.isArray(v)) { v.forEach((x) => walk(x, depth + 1)); return; }
    if (typeof v === 'object') {
      if (v.label === 'Nonce' && v.context != null) out.given.Nonce = typeof v.context === 'string' ? v.context : canonicalJson(v.context);
      for (const x of Object.values(v)) walk(x, depth + 1);
    }
  };
  walk(pres);
  return out;
}

/**
 * deps: {
 *   grpc(): node client (API SDK copy),
 *   kv: { get(ns,key), put(ns,key,val) },
 *   verifyPresentation({ version, presentation }) -> { ok, reason },   // keyless node/verifier check
 *   now(): ms, network: 'Testnet'
 * }
 */
export function createVopService(deps) {
  const now = deps.now ?? Date.now;
  const network = deps.network ?? 'Testnet';
  const verifyCache = new Map(); // anchor -> { at, ok, reason }

  async function reverify(anchor, version, presentation) {
    const hit = verifyCache.get(anchor);
    if (hit && now() - hit.at < 10 * 60_000) return hit;
    const r = await deps.verifyPresentation({ version, presentation });
    const v = { at: now(), ok: !!r.ok, reason: r.reason ?? null };
    if (r.ok) verifyCache.set(anchor, v);
    return v;
  }

  /** Find the proof the book's anchor points at (VoP store, the wallet name-proof store, or a labelled stand-in). */
  async function proofFor(payee, anchorOnChain) {
    if (anchorOnChain) {
      const rec = await deps.kv.get('vop_proof', anchorOnChain);
      if (rec?.presentation) return { source: 'vop_proof', ...rec, anchor: anchorOnChain };
      const st = await deps.kv.get('vop_standin', payee);
      if (st && sha256Hex(canonicalJson(st)) === anchorOnChain) return { source: 'standin', standin: st, anchor: anchorOnChain };
    }
    const wp = await deps.kv.get('payee_proof_presentation', payee);
    if (wp?.presentation) return { source: 'wallet_name_proof', version: wp.version, presentation: wp.presentation, anchor: presentationAnchor(wp.presentation) };
    return null;
  }

  async function check(input) {
    const seller = String(input?.seller ?? ''); const payee = String(input?.payee ?? '');
    const legalName = String(input?.legal_name ?? input?.name ?? '').trim();
    const buyer = input?.buyer ? String(input.buyer) : null;
    if (!ADDR.test(seller) || !ADDR.test(payee)) throw new VopError(400, 'bad_address', 'seller and payee must be Concordium account addresses.');
    if (buyer && !ADDR.test(buyer)) throw new VopError(400, 'bad_address', 'buyer must be a Concordium account address.');
    if (!legalName || legalName.length > 200) throw new VopError(400, 'bad_name', 'legal_name (the payee name on the invoice) is required, up to 200 characters.');
    const c = await deps.grpc();
    const [account, rec] = await Promise.all([accountIdentity(c, payee), getPayeeRecord(c, seller, payee)]);
    const book = rec ?? { status: 'NotBound', version: 0, mature_at_ms: null, identity: null };
    const anchorOnChain = rec?.identity?.proof_anchor ?? null;
    const found = await proofFor(payee, anchorOnChain);
    let proof = null; let standin = null;
    if (found?.source === 'standin') standin = found.standin;
    else if (found) {
      const v = await reverify(found.anchor, found.version ?? 'v1', found.presentation);
      proof = { valid: v.ok, error: v.reason, anchor: found.anchor, anchorOnChain, facts: factsFromPresentation(found.presentation), nonceExpected: found.nonce_expected ?? null };
    }
    const result = decideVop({ invoice: { legal_name: legalName, country: input?.country ?? null }, account, proof, book, nowMs: now(), network, standin });
    if (rec && anchorOnChain && proof && proof.anchor !== anchorOnChain) {
      result.checks.push({ id: 'proof_anchor', ok: false, detail: 'the only proof on file is not the one the payee bound on chain' });
      result.payable = false;
      if (result.verdict === VERDICT.MATCH) result.reasons.push('The payee book points at a different proof: not payable until the payee re-binds.');
    }
    const subject = {
      network, contract: v3Label(), seller, payee, invoice_name: legalName,
      book: rec ? { status: rec.status, version: rec.version, mature_at_ms: rec.mature_at_ms, proof_anchor: anchorOnChain, idp_index: rec.identity.idp_index, kind: rec.identity.kind } : { status: 'NotBound' },
      proof_source: found?.source ?? null, proof_anchor: found?.anchor ?? null,
    };
    result.subject = subject;
    const evidence_hash = evidenceHash(result);
    let ack = null;
    if (buyer) {
      const a = await getPayeeAck(c, buyer, seller, payee);
      ack = a ? { ...a, current: rec ? a.version === rec.version : false } : null;
    }
    const recordable = [VERDICT.MATCH, VERDICT.CLOSE_MATCH].includes(result.verdict) && rec?.status === 'Bound';
    return {
      verdict: result.verdict,
      payable: result.payable,
      verified_name: result.verified_name,
      verified_country: result.verified_country,
      identity_kind: result.identity_kind,
      standin: result.standin,
      reasons: result.reasons,
      checks: result.checks,
      subject,
      evidence_hash,
      checked_at: new Date(now()).toISOString(),
      buyer_ack: ack,
      acknowledge: recordable ? {
        entrypoint: `${V3.name}.acknowledge_payee`, contract: v3Label(),
        parameter: serAcknowledgePayee({ seller, payee, version: rec.version, verdict: VERDICT_CODE[result.verdict], evidence_hash }).toString('hex'),
        note: 'The buyer records the verdict and this evidence hash on chain; pay_ccd / reserve_plt refuse (-30) without it.',
      } : null,
    };
  }

  /** Intake of a presentation from the payee's wallet: verify keylessly, store by anchor, return the identity tuple for propose_payee. */
  async function submitProof(body) {
    const version = body?.version === 'v0' ? 'v0' : 'v1';
    let pres = body?.presentation;
    if (typeof pres === 'string') { try { pres = JSON.parse(pres); } catch { throw new VopError(400, 'bad_presentation', 'presentation is not JSON.'); } }
    if (!pres || typeof pres !== 'object') throw new VopError(400, 'bad_presentation', 'presentation required.');
    const payee = String(body?.payee ?? '');
    if (!ADDR.test(payee)) throw new VopError(400, 'bad_address', 'payee (the account the proof is for) is required.');
    const v = await deps.verifyPresentation({ version, presentation: pres });
    if (!v.ok) throw new VopError(422, 'proof_invalid', `The presentation did not verify: ${String(v.reason ?? '').slice(0, 200)}`);
    const facts = factsFromPresentation(pres);
    const c = await deps.grpc();
    const account = await accountIdentity(c, payee);
    const creds = new Set(account.credentials.map((x) => x.credId));
    if (!facts.credIds.length || !facts.credIds.every((id) => creds.has(id))) throw new VopError(422, 'not_holder', 'The presenting credential is not a credential of that account.');
    const anchor = presentationAnchor(pres);
    const business = facts.idpIndexes.length > 0 && facts.idpIndexes.every((i) => (BUSINESS_IDPS[network] ?? []).includes(i));
    const name = business ? facts.revealed.legalName : [facts.revealed.firstName, facts.revealed.lastName].filter(Boolean).join(' ') || null;
    const country = (business ? facts.revealed.legalCountry : facts.revealed.nationality) ?? null;
    await deps.kv.put('vop_proof', anchor, { payee, version, presentation: pres, nonce_expected: body?.nonce_expected ?? null, stored_at: new Date(now()).toISOString(), anchor_tx: body?.anchor_tx ?? null });
    return {
      anchor, payee, kind: business ? 'business' : 'person', idp_index: facts.idpIndexes[0] ?? null, revealed: facts.revealed,
      identity: name ? { kind: business ? 1 : 2, idp_index: facts.idpIndexes[0], legal_name_hash: legalNameHash(name), country: /^[A-Z]{2}$/.test(String(country ?? '')) ? country : 'ZZ', proof_anchor: anchor, anchor_tx: body?.anchor_tx ?? null } : null,
      note: name ? 'Pass `identity` to propose_payee (seller), then the payee calls accept_payee with the same proof_anchor.' : 'This proof reveals no name: it cannot stand behind an invoice name (check_payee answers No match for a company name).',
    };
  }

  async function getProof(anchor) {
    if (!/^[0-9a-f]{64}$/.test(String(anchor))) throw new VopError(400, 'bad_anchor', 'anchor is a sha256 hex.');
    const rec = await deps.kv.get('vop_proof', anchor);
    if (!rec) throw new VopError(404, 'no_proof', 'No presentation stored under that anchor.');
    return { anchor, recomputed_anchor: presentationAnchor(rec.presentation), ...rec };
  }

  return { check, submitProof, getProof };
}
