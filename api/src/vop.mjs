// PayOnce — Verification of Payee (VoP) for AI agents: the decision core.
//
// EU Regulation (EU) 2024/886 (Instant Payments Regulation, Art. 5c) makes
// euro-area payment providers check the payee's name against the account
// before a transfer and answer Match / Close match / No match. This module
// is the same check for an agent paying an invoice on Concordium, made
// cryptographic: the answer comes from the payee account's on-chain
// identity credential and a zero-knowledge presentation that reveals the
// business's legal name and country — never from the invoice or an e-mail.
//
// Pure functions only (no network): every verdict is a deterministic
// function of facts read from the chain, so anyone can re-run it without
// keys. Chain adapters live in vop-chain.mjs.
import { createHash } from 'node:crypto';
import { nameMatch, normalizeName } from './payee-proof.mjs';

/** Identity providers that issue BUSINESS identities. Global FinReg is 4 on
 *  testnet and 3 on mainnet (Concordium workshop W5; never hard-code one). */
export const BUSINESS_IDPS = { Testnet: [4], Mainnet: [3] };

export const VERDICT = Object.freeze({
  MATCH: 'MATCH',
  CLOSE_MATCH: 'CLOSE_MATCH',
  NO_MATCH: 'NO_MATCH',
  UNVERIFIED: 'UNVERIFIED',
});
/** u8 codes the v3 contract records in `acknowledge_payee`. */
export const VERDICT_CODE = { MATCH: 0, CLOSE_MATCH: 1, NO_MATCH: 2, UNVERIFIED: 3 };

export const sha256Hex = (data) => createHash('sha256').update(data).digest('hex');

/** Stable JSON: object keys sorted recursively, bigints as strings. */
export function canonicalJson(value) {
  const norm = (v) => {
    if (typeof v === 'bigint') return v.toString();
    if (Array.isArray(v)) return v.map(norm);
    if (v && typeof v === 'object' && typeof v.toJSON === 'function' && !(v instanceof Date)) return norm(v.toJSON());
    if (v && typeof v === 'object') return Object.fromEntries(Object.keys(v).sort().map((k) => [k, norm(v[k])]));
    return v;
  };
  return JSON.stringify(norm(value));
}

// ONE name matcher for the whole product: payee-proof.mjs (EPC-style,
// shipped with the wallet name-proof flow). Legal-form words (Ltd, GmbH, ...)
// and word order are ignored; one small typo or one missing word is a
// close match. Re-exported here so check_payee and the wallet flow can never
// disagree on a verdict.
export { normalizeName } from './payee-proof.mjs';

/** Canonical form of a name: the matcher's words, sorted, space-joined.
 *  Two names the matcher calls `match` always normalise equal. */
export function normalizeLegalName(name) {
  return normalizeName(name).slice().sort().join(' ');
}

/** sha256 hex of the normalised name (what the v3 contract stores as legal_name_hash). */
export const legalNameHash = (name) => sha256Hex(normalizeLegalName(name));

const FROM_MATCHER = { match: VERDICT.MATCH, close_match: VERDICT.CLOSE_MATCH, no_match: VERDICT.NO_MATCH };
/** The invoice's payee name vs the identity-proven name: MATCH / CLOSE_MATCH / NO_MATCH. */
export function compareLegalNames(invoiceName, provenName) {
  const m = nameMatch(invoiceName, provenName);
  return { result: FROM_MATCHER[m.verdict] ?? VERDICT.NO_MATCH, similarity: m.score, invoice_normalized: normalizeLegalName(invoiceName), proven_normalized: normalizeLegalName(provenName) };
}

/** The challenge a VoP presentation must be bound to: the registry
 *  instance, the seller, the payee account, the legal name and country. A
 *  presentation made for another payee or another name cannot be replayed. */
export function vopNonceHex({ contract, seller, payee, legalName, country }) {
  return sha256Hex(['payonce-vop-v1', contract, seller, payee, normalizeLegalName(legalName), String(country ?? '').toUpperCase()].join('|'));
}

/** sha256 of the canonical presentation JSON = the `proof_anchor` stored on chain. */
export const presentationAnchor = (presentationJson) => sha256Hex(canonicalJson(presentationJson));

/** Pull the public facts out of a verified V1 presentation result
 *  (`VerifiablePresentationV1.verifyWithNode(...).result.request`). */
export function presentationFacts(request) {
  const out = { credIds: [], idpIndexes: [], revealed: {}, given: {} };
  for (const g of request?.context?.given ?? []) {
    const label = g?.label; const ctx = g?.context;
    if (!label) continue;
    out.given[label] = typeof ctx === 'string' ? ctx : (ctx instanceof Uint8Array ? Buffer.from(ctx).toString('hex') : canonicalJson(ctx));
  }
  for (const claim of request?.subjectClaims ?? []) {
    const id = String(claim?.id ?? '');
    const cred = id.match(/:cred:([0-9a-fA-F]{96})$/);
    if (cred) out.credIds.push(cred[1].toLowerCase());
    const idp = String(claim?.issuer ?? '').match(/:idp:(\d+)$/);
    if (idp) out.idpIndexes.push(Number(idp[1]));
    for (const st of claim?.statement ?? []) {
      if (st?.type === 'AttributeValue' && st.attributeTag) out.revealed[st.attributeTag] = String(st.attributeValue);
    }
  }
  return out;
}

/**
 * The VoP decision. Inputs are facts already read from the chain:
 *  invoice: { legal_name, country }                — what the invoice claims
 *  account: { exists, credentials: [{credId, idp}] } — payee account on chain
 *  proof:   null | { valid, error, anchor, anchorOnChain, facts, nonceExpected }
 *  book:    null | v3 payee record (status, version, mature_at_ms, identity)
 *  nowMs, network, standin: null | { legal_name, country, label }
 * Returns { verdict, payable, verified_name, verified_country, identity_kind, reasons, checks }.
 */
export function decideVop({ invoice, account, proof = null, book = null, nowMs = Date.now(), network = 'Testnet', standin = null }) {
  const checks = [];
  const reasons = [];
  const add = (id, ok, detail) => { checks.push({ id, ok, detail }); return ok; };
  const businessIdps = BUSINESS_IDPS[network] ?? [];
  const out = { verdict: VERDICT.UNVERIFIED, payable: false, verified_name: null, verified_country: null, identity_kind: 'unknown', standin: false, reasons, checks };

  if (!invoice?.legal_name || !normalizeLegalName(invoice.legal_name)) {
    add('invoice_name', false, 'the invoice names no payee legal name');
    reasons.push('Nothing to verify: the invoice carries no payee legal name.');
    return out;
  }
  if (!add('account_exists', !!account?.exists, account?.exists ? 'payee account exists on chain' : 'payee account not found on chain')) {
    out.verdict = VERDICT.NO_MATCH;
    reasons.push('The payee account does not exist on Concordium.');
    return out;
  }
  const idps = [...new Set((account.credentials ?? []).map((c) => Number(c.idp)))];
  const isBusiness = idps.some((i) => businessIdps.includes(i));
  out.identity_kind = isBusiness ? 'business' : 'person';
  add('account_identity', true, `payee account credential issued by identity provider ${idps.join(', ') || '?'} (${isBusiness ? 'business identity provider' : 'personal identity provider'})`);

  // Payee book (v3): bound by the payee's own signature, cooling-off, version.
  if (book) {
    add('payee_book_bound', book.status === 'Bound', `payee book status ${book.status} (version ${book.version})`);
    const mature = book.mature_at_ms != null && nowMs >= Number(book.mature_at_ms);
    add('cooling_off_over', mature, book.mature_at_ms == null ? 'not bound yet' : mature ? `cooling-off ended ${new Date(Number(book.mature_at_ms)).toISOString()}` : `cooling-off until ${new Date(Number(book.mature_at_ms)).toISOString()}`);
    if (book.identity?.legal_name_hash) {
      add('book_name_matches_invoice', book.identity.legal_name_hash === legalNameHash(invoice.legal_name), 'payee book legal-name hash vs the invoice name');
    }
  }

  // Stand-in (clearly labelled, testnet only): used until a Global FinReg
  // business identity exists for this payee. Never claims a real KYB.
  if (standin && !proof) {
    out.standin = true;
    const cmp = compareLegalNames(invoice.legal_name, standin.legal_name);
    add('standin_name', cmp.result !== VERDICT.NO_MATCH, `TESTNET STAND-IN: legal name "${standin.legal_name}" is declared by PayOnce for this test account, not proven by a business identity`);
    out.verified_name = standin.legal_name;
    out.verified_country = standin.country ?? null;
    out.verdict = cmp.result;
    reasons.push(`TESTNET STAND-IN (${standin.label ?? 'no business identity issued yet'}): the name is declared, not proven. Real VoP needs a Global FinReg presentation.`);
    const agrees = book?.identity?.legal_name_hash ? add('book_name_matches_proof', book.identity.legal_name_hash === legalNameHash(standin.legal_name), 'the legal-name hash the payee signed into the payee book equals the stand-in name') : true;
    out.payable = cmp.result === VERDICT.MATCH && agrees && bookPayable(book, nowMs);
    return out;
  }

  if (!proof) {
    // No presentation: "verification not possible" (EPC), never a match. The
    // agent refuses UNVERIFIED exactly like NO_MATCH.
    out.verdict = VERDICT.UNVERIFIED;
    reasons.push(isBusiness
      ? 'Verification not possible: the payee is a business identity, but no legal-name proof is anchored for it yet.'
      : `Verification not possible: the payee account is backed by a personal identity (provider ${idps.join(', ')}) and has presented no name proof, so nothing stands behind "${invoice.legal_name}".`);
    return out;
  }

  // Proof present: it must verify with the node, match its on-chain anchor,
  // belong to THIS account, be bound to this payee/name, and come from a
  // business identity provider.
  const valid = add('proof_valid', !!proof.valid, proof.valid ? 'presentation verified against the chain (keyless)' : `presentation did not verify: ${proof.error ?? 'unknown error'}`);
  if (proof.anchorOnChain != null) add('proof_anchor', proof.anchor === proof.anchorOnChain, 'sha256(presentation) equals the proof_anchor in the payee book');
  const f = proof.facts ?? { credIds: [], idpIndexes: [], revealed: {}, given: {} };
  const accountCreds = new Set((account.credentials ?? []).map((c) => String(c.credId).toLowerCase()));
  const owns = f.credIds.length > 0 && f.credIds.every((id) => accountCreds.has(id));
  add('proof_belongs_to_payee', owns, owns ? 'the presenting credential is a credential of the payee account' : 'the presenting credential is not on the payee account');
  if (proof.nonceExpected) add('proof_bound', String(f.given?.Nonce ?? '').toLowerCase() === proof.nonceExpected, 'presentation challenge bound to (registry, seller, payee, legal name, country)');
  const proofBusiness = f.idpIndexes.length > 0 && f.idpIndexes.every((i) => businessIdps.includes(i));
  add('proof_issuer', true, `proof issuer identity provider ${f.idpIndexes.join(', ') || '?'} (${proofBusiness ? 'business identity provider' : 'personal identity provider'})`);
  const failed = checks.filter((c) => !c.ok && ['proof_valid', 'proof_anchor', 'proof_belongs_to_payee', 'proof_bound'].includes(c.id));
  if (!valid || failed.length) {
    out.verdict = VERDICT.UNVERIFIED;
    reasons.push(`The anchored proof failed: ${failed.map((c) => c.id).join(', ')}.`);
    return out;
  }
  // Business identity: legalName (+ legalCountry). Natural person (sole
  // trader): firstName + lastName, from any identity provider. A personal
  // identity that reveals no name cannot stand behind a company name.
  const personName = [f.revealed.firstName, f.revealed.lastName].filter(Boolean).join(' ').trim() || null;
  const provenName = proofBusiness ? (f.revealed.legalName ?? null) : personName;
  const provenCountry = proofBusiness ? (f.revealed.legalCountry ?? null) : null;
  out.identity_kind = proofBusiness ? 'business' : 'person';
  out.verified_name = provenName; out.verified_country = provenCountry ?? (proofBusiness ? null : f.revealed.nationality ?? null);
  if (!provenName) {
    out.verdict = proofBusiness ? VERDICT.UNVERIFIED : VERDICT.NO_MATCH;
    reasons.push(proofBusiness
      ? 'The business proof does not reveal a legal name.'
      : `No match: the proof comes from a personal identity (provider ${f.idpIndexes.join(', ')}${f.revealed.nationality ? `, nationality ${f.revealed.nationality}` : ''}), not from a business identity named "${invoice.legal_name}".`);
    return out;
  }
  const cmp = compareLegalNames(invoice.legal_name, provenName);
  add('legal_name', cmp.result !== VERDICT.NO_MATCH, `invoice "${invoice.legal_name}" vs proven "${provenName}" (${cmp.result}, similarity ${cmp.similarity})`);
  let verdict = cmp.result;
  if (invoice.country && provenCountry) {
    const sameCountry = String(invoice.country).toUpperCase() === String(provenCountry).toUpperCase();
    add('legal_country', sameCountry, `invoice country ${invoice.country} vs proven ${provenCountry}`);
    if (!sameCountry) verdict = VERDICT.NO_MATCH;
  }
  out.verdict = verdict;
  if (verdict === VERDICT.MATCH) reasons.push(`Match: the payee account belongs to the verified ${out.identity_kind === 'business' ? 'business' : 'person'} "${provenName}"${provenCountry ? ` (${provenCountry})` : ''}.`);
  else if (verdict === VERDICT.CLOSE_MATCH) reasons.push(`Close match: the verified legal name is "${provenName}". Confirm with the payer before paying.`);
  else reasons.push(`No match: the payee account belongs to "${provenName}"${provenCountry ? ` (${provenCountry})` : ''}, not "${invoice.legal_name}".`);
  let bookAgrees = true;
  if (book?.identity?.legal_name_hash) {
    bookAgrees = add('book_name_matches_proof', book.identity.legal_name_hash === legalNameHash(provenName), 'the legal-name hash the payee signed into the payee book equals the proven name');
    if (!bookAgrees) reasons.push('The payee book was bound to a different name than the one proven: not payable.');
  }
  out.payable = verdict === VERDICT.MATCH && bookAgrees && bookPayable(book, nowMs);
  return out;
}

function bookPayable(book, nowMs) {
  if (!book) return true; // no payee book given: identity verdict only
  return book.status === 'Bound' && book.mature_at_ms != null && nowMs >= Number(book.mature_at_ms);
}

/** sha256 of the canonical VoP result: the `evidence_hash` a buyer records on chain. */
export function evidenceHash(result) {
  const { verdict, verified_name, verified_country, identity_kind, standin, checks, subject } = result;
  return sha256Hex(canonicalJson({ verdict, verified_name, verified_country, identity_kind, standin, checks, subject }));
}
