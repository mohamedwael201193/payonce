// PayOnce API — V&A (age proof) wiring, G8 (testnet only).
//
// Proxies the scoped prover sidecar (services/prover.mjs) and the official
// Concordium testnet Web3 ID verifier. The prover is a loopback-only sidecar
// that holds ONLY the dob + nationality openings of one credential
// (prover-C3.private.json, a secret file on the API host — never committed,
// never in this repo). Until that sidecar is provisioned on the host, every
// route below fails closed with 503 `prover_unavailable` — EXCEPT
// POST /api/age-proof/verify-presentation (F2a), which takes a
// client-supplied presentation straight to the official verifier and needs
// no prover at all.
//
// FILING, IN MEMORY (coordinator decision, Batch C fix-back — mechanism
// change from spec §1.3B, which described an `age_proof` body field that
// does not exist): there is NO body field that files a proof and no client
// claim is ever trusted. A proof gets on file ONLY inside
// POST /api/age-proof/verify, after the official verifier returns 200 for
// a presentation the prover itself built. Filed proofs live in PROCESS
// MEMORY with a ≤10-minute freshness window; a server restart loses them
// and the payer simply re-verifies (the verify call is free). No store
// persistence is added in this fix-back (out of scope).
//
// PRECISION (BATCH-C §1.2 — non-negotiable): the "under-18 refusal" was NEVER
// run as an under-18-holder test. What the lab proves, and what this module
// may claim, is exactly:
//   - forbidden statement shapes -> HTTP 403 from the prover policy
//     (18 shapes, rules REVEAL_REFUSED / ATTRIBUTE_NOT_ALLOWED /
//     ATTRIBUTE_NOT_HELD / RANGE_TOO_NARROW / RANGE_NOT_ALLOWED /
//     STATEMENT_TYPE / SET_NOT_ALLOWED / SOURCE / ISSUER /
//     STATEMENT_COUNT / DUPLICATE);
//   - a TAMPERED presentation -> HTTP 400 from the official verifier.
// No copy, log line, or test in this module may claim a test with an
// under-18 person. A real under-18 refusal needs a second lab identity
// with dob < 18y — out of scope for this batch.
//
// Nothing here returns, logs, or echoes secret material: requests carry
// statement shapes only (no attribute values), presentations carry no dob
// value, and errors are sanitised to rule codes. Bodies are capped at
// 64 KiB, same as the prover. Node built-ins only.

export const PROVER_URL_DEFAULT = 'http://127.0.0.1:8788';
export const VERIFIER_URL =
  'https://web3id-verifier.testnet.concordium.com/v0/verify';
export const AGE_PROOF_MAX_BODY = 64 * 1024;
export const AGE_PROOF_FRESH_MS = 10 * 60 * 1000; // a verified proof is fresh for 10 minutes
export const AGE_GATE_THRESHOLD_BASE = 1_000_000n; // 1 CCD or 1.00 EUDemo (both 6 decimals)

// Anchored V&A V1 run (SCOPED_LOG A1) — public anchors, safe to display.
export const AGE_PROOF_ANCHORS = {
  vra: 'e576b2ed2a3539ecc9da872abad15a8ae1dde07c6aa946d3eb9a2b98718a17dc',
  vaa: '5dc1e9858e8740a703bc5c437d7442dc624c8afc7b1dd2bc1b6f7b6489c05f51',
  recordSha256: 'fab62d06a55399e76699c52cf64799514b2d06b0b9a0062c16d7c29d9b469d3e',
  consentVra: 'ed92afaf8b3a7806a838f96d210ae2b0ffce9769297fa38973462b1a933bee00',
  consentVaa: '2b3e6ddd84bd6a23ccb8ec395a647ed7c91c1b700cc8c751fcf4f5a7f16cbc06',
  consentSha256: '8f7bce786dcc037aee2f73da44007b7992a4b7396f91045cb496d7f00b486ff5',
  statements: ['dob AttributeInRange 18000101–20081125', 'nationality in EU 27'],
  explorerTx: 'https://ccdexplorer.io/testnet/transaction/',
};

export const AGE_PROOF_ALLOW_LIST = [
  'dob AttributeInRange, lower 18000101, upper today minus 18 or 21 years',
  'nationality AttributeInSet, set exactly the EU 27',
  'countryOfResidence AttributeInSet, set exactly the EU 27 (only if held)',
];
export const AGE_PROOF_REFUSES = [
  'RevealAttribute / AttributeValue (any attribute)',
  'attributes outside {dob, nationality, countryOfResidence}',
  'attributes not held by this prover',
  'dob ranges narrower than 1 year or with other bounds',
  'non-EU membership sets',
  'non-account sources',
  'other identity providers',
];

/**
 * Is this payable age-gated? ADOPTED threshold (coordinator decision):
 * amount >= 1 CCD or >= 1.00 EUDemo — both are 1,000,000 base units
 * (6 decimals). Below the threshold age proof is optional.
 */
export function isAgeGated(view) {
  try {
    return BigInt(view.amount) >= AGE_GATE_THRESHOLD_BASE;
  } catch {
    return false;
  }
}

// ---- what the request actually proved (M1 fix-back) ---------------------
// The old handleVerify returned a HARDCODED `['dob>=18', 'nationality in
// EU27']` for ANY verifier-200 — so a nationality-only proof claimed an
// age it never proved and unlocked the age gate. Statements are now
// DERIVED from the request's own statements, and a proof is filed ONLY
// when a dob range proving 18+ was in the request (see provesAdult).
//
// The "+1 day" uppers: the prover's allow-list (services/prover.mjs
// decide(), and the SDK's addMinimumAge convention) accepts a dob upper of
// today−18y or today−21y, each +0 or +1 day — and the anchored V&A run
// itself used the +1-day upper (20081125). So "proves 18+" means the upper
// is one of the prover's allowed 18+ uppers, not a strict calendar
// comparison against today−18y.
const EU27 = ['AT', 'BE', 'BG', 'CY', 'CZ', 'DE', 'DK', 'EE', 'ES', 'FI', 'FR', 'GR', 'HR', 'HU', 'IE', 'IT', 'LT', 'LU', 'LV', 'MT', 'NL', 'PL', 'PT', 'RO', 'SE', 'SI', 'SK'];

function upperMinusYears(years, daysOffset, nowMs) {
  const d = new Date(nowMs);
  d.setUTCDate(d.getUTCDate() + daysOffset);
  return `${d.getUTCFullYear() - years}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`;
}
/** The prover's allowed 18+ dob uppers: today−18y / today−21y, +0/+1 day. */
export function allowedAdultUppers(nowMs = Date.now()) {
  return [18, 21].flatMap((n) => [upperMinusYears(n, 0, nowMs), upperMinusYears(n, 1, nowMs)]);
}
export function allowed21Uppers(nowMs = Date.now()) {
  return [upperMinusYears(21, 0, nowMs), upperMinusYears(21, 1, nowMs)];
}

function requestStatements(request) {
  const sc = request?.subjectClaims?.[0];
  return Array.isArray(sc?.statements) ? sc.statements : [];
}

/**
 * The statements this request actually proved, derived from its own
 * statements — never hardcoded. A dob range proves an age bound only when
 * its upper is one of the prover's allowed uppers; a nationality set
 * proves EU membership only when it is exactly the EU 27. A
 * nationality-only request returns ['nationality in EU27'] and nothing
 * about age; a dob≥21-only request returns the dob claims and nothing
 * about nationality (≥21 entails ≥18, so both dob claims are listed).
 */
export function deriveProvenStatements(request, nowMs = Date.now()) {
  const out = [];
  const uppers21 = allowed21Uppers(nowMs);
  const uppers18 = allowedAdultUppers(nowMs);
  for (const s of requestStatements(request)) {
    if (!s || typeof s !== 'object') continue;
    if (s.attributeTag === 'dob' && s.type === 'AttributeInRange' && typeof s.upper === 'string') {
      if (uppers21.includes(s.upper)) {
        if (!out.includes('dob>=18')) out.push('dob>=18');
        if (!out.includes('dob>=21')) out.push('dob>=21');
      } else if (uppers18.includes(s.upper)) {
        if (!out.includes('dob>=18')) out.push('dob>=18');
      }
    } else if (s.attributeTag === 'nationality' && s.type === 'AttributeInSet' && Array.isArray(s.set)
      && JSON.stringify([...s.set].sort()) === JSON.stringify([...EU27].sort())) {
      if (!out.includes('nationality in EU27')) out.push('nationality in EU27');
    } else if (s.attributeTag === 'countryOfResidence' && s.type === 'AttributeInSet' && Array.isArray(s.set)
      && JSON.stringify([...s.set].sort()) === JSON.stringify([...EU27].sort())) {
      if (!out.includes('countryOfResidence in EU27')) out.push('countryOfResidence in EU27');
    }
  }
  return out;
}

/** True iff the request proved a dob range of 18+ (an allowed 18+ upper). */
export function provesAdult(request, nowMs = Date.now()) {
  const uppers = allowedAdultUppers(nowMs);
  return requestStatements(request).some(
    (s) => s && s.attributeTag === 'dob' && s.type === 'AttributeInRange'
      && typeof s.upper === 'string' && uppers.includes(s.upper),
  );
}

// ---- who the presentation belongs to (M2 fix-back) ----------------------
// The old handleVerify filed a proof for ANY client-supplied payer string
// without ever looking at the presentation — so a proof could be filed for
// an arbitrary payer ('4AnyoneAtAll') and the gate would pass for them.
// The filed record is now bound to the presentation's credential holder
// and must equal the payer; otherwise nothing is filed (fail closed).
//
// Ground truth (@concordium/web-sdk 12.0.3, installed): a V1 account
// credential carries `credentialSubject.id` =
// `did:ccd:<net>:cred:<64-hex credId>` — the credential DID, NOT the
// account address — and there is no top-level `holder` field in a V1
// presentation. The account address is NOT in the presentation at all; it
// is resolved on chain via getAccountInfo(credId), which the SDK accepts
// as an account identifier. That resolution is injected as
// `deps.resolveHolderAccount(credIdHex) -> account address | null` (the
// API server wires it to its live gRPC client). Without a resolver, or
// when the credential cannot be resolved, filing is refused — the verify
// itself still returns 200 valid:true, but filed_for_payable stays null
// and the gate still 409s.
//
// Fix-back-2 MF1: the earlier code ALSO trusted a bare top-level `holder`
// account DID verbatim (kind 'account', no chain check) — a presentation
// with only `holder: did:ccd:testnet:acc:<payer>` and zero credentials
// filed a proof for that payer. That shortcut is REMOVED: an account DID
// is never trusted on its own, and an account address is accepted only
// as the result of resolving a credential DID on chain.
const DID_CRED_RE = /^did:ccd:[a-z]+:cred:([0-9a-fA-F]{64})$/;
const HEX64_RE = /^[0-9a-fA-F]{64}$/;

/**
 * Extract the holder from a V1 presentation.
 * Returns { kind: 'cred', credId } when it names a credential DID (the
 * real V1 shape — needs chain resolution), or null when no holder can be
 * extracted.
 *
 * Fix-back-2 MF1: a bare top-level `holder` account DID
 * (did:ccd:<net>:acc:<address>) is NEVER trusted and is ignored here.
 * It carries no chain check — trusting it verbatim let a presentation
 * with only `holder` and zero credentials file a proof for any payer.
 * An account address is accepted only as the RESULT of resolving a
 * credential DID on chain (resolvePresentationHolder, via
 * deps.resolveHolderAccount).
 */
export function extractPresentationHolder(presentation) {
  if (!presentation || typeof presentation !== 'object') return null;
  const candidates = [];
  const creds = Array.isArray(presentation.verifiableCredential) ? presentation.verifiableCredential : [];
  for (const c of creds) {
    if (c?.credentialSubject?.id) candidates.push(c.credentialSubject.id);
    if (c?.id) candidates.push(c.id);
  }
  if (typeof presentation.holder === 'string') candidates.push(presentation.holder);
  for (const cand of candidates) {
    if (typeof cand !== 'string') continue;
    const cred = DID_CRED_RE.exec(cand);
    if (cred) return { kind: 'cred', credId: cred[1].toLowerCase() };
    if (HEX64_RE.test(cand)) return { kind: 'cred', credId: cand.toLowerCase() };
  }
  return null;
}

/**
 * Resolve the presentation's holder to an account address.
 * Returns { address } on success, or { address: null, reason } where
 * reason is 'holder_missing' (no holder in the presentation — including
 * a bare account DID, which is never trusted) or 'holder_unresolved' (a
 * credId was found but no resolver is configured or it could not be
 * resolved on chain). Never throws.
 */
export async function resolvePresentationHolder(presentation, resolveHolderAccount) {
  const holder = extractPresentationHolder(presentation);
  if (!holder) return { address: null, reason: 'holder_missing' };
  if (typeof resolveHolderAccount !== 'function') return { address: null, reason: 'holder_unresolved' };
  try {
    const address = await resolveHolderAccount(holder.credId);
    if (typeof address === 'string' && address) return { address, reason: null };
  } catch { /* resolution failure is fail-closed, not an error */ }
  return { address: null, reason: 'holder_unresolved' };
}

// ---- on-file verified proofs (in-memory, process-local) ------------------
// A proof gets on file ONLY via POST /api/age-proof/verify, which itself
// re-verifies through the official verifier. A client-supplied presentation
// is never trusted on its own — there is no body field that files a proof.
// Process-local is the honest V1: a restart clears the file, so a payer
// re-verifies (the verify call is free). Keyed by payer + payable.
const verifiedProofs = new Map(); // `${payer}:${payableId}` -> { verifiedAtMs, payableId, payer, holder }

export function recordVerifiedAgeProof({ payer, payableId, verifiedAtMs = Date.now(), holder = null }) {
  if (typeof payer !== 'string' || !payer || !Number.isInteger(payableId) || payableId < 1) return false;
  verifiedProofs.set(`${payer}:${payableId}`, { payer, payableId, verifiedAtMs, holder: holder ?? payer });
  return true;
}

export function findFreshAgeProof(payer, payableId, nowMs = Date.now()) {
  const rec = verifiedProofs.get(`${payer}:${payableId}`);
  if (!rec) return null;
  if (nowMs - rec.verifiedAtMs > AGE_PROOF_FRESH_MS) return null;
  return rec;
}

export function clearAgeProofs() {
  verifiedProofs.clear();
}

/** Gate decision for handlePay: null = pass, otherwise the 409 payload. */
export function ageGateCheck(view, payer, nowMs = Date.now()) {
  if (!isAgeGated(view)) return null;
  if (findFreshAgeProof(payer, view.id, nowMs)) return null;
  return {
    status: 409,
    code: 'age_proof_required',
    layer: 'app',
    message: `Payable ${view.id} is ${view.asset === 'CCD'
      ? `${(Number(view.amount) / 1e6).toFixed(6)} CCD`
      : `${(Number(view.amount) / 1e6).toFixed(2)} EUDemo`} — payments of 1 CCD or 1.00 EUDemo or more need a fresh (within 10 minutes) verified 18+ age proof for the payer. Verify first at /verify-age?payable=${view.id}, then pay within 10 minutes.`,
    verify_url: `/verify-age?payable=${view.id}`,
    payable_id: view.id,
  };
}

// ---- prover / verifier transport ----------------------------------------
async function proverFetch(fetchImpl, proverUrl, path, body, timeoutMs = 10_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(`${proverUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

async function proverHealthFetch(fetchImpl, proverUrl, timeoutMs = 5_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(`${proverUrl}/health`, { signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function verifierFetch(fetchImpl, verifierUrl, presentation, timeoutMs = 30_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetchImpl(verifierUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(presentation),
      signal: ctrl.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

function proverDown(deps, res) {
  return deps.apiError(res, 503, 'prover_unavailable', 'server',
    'The age-proof prover is not reachable on this host. The prover sidecar has not been provisioned yet — age verification is unavailable, and age-gated payments stay refused. Nothing was sent.',
    { retryable: true });
}

/** The health probe answers 200 with prover_available:false (a status, not a failure), so a page that
 *  only asks "is the prover there?" does not log a 503 in the browser console. Every action route
 *  still fails closed with 503 prover_unavailable. */
function proverUnavailableStatus(deps, res) {
  return deps.sendJson(res, 200, {
    service: 'payonce-age-proof',
    prover_available: false,
    error: { code: 'prover_unavailable', layer: 'server', retryable: true,
      message: 'The age-proof prover is not reachable on this host. The prover sidecar has not been provisioned yet — age verification is unavailable, and age-gated payments stay refused. Nothing was sent.' },
  });
}

/**
 * Build the four age-proof route handlers.
 * deps: { proverUrl, verifierUrl, fetchImpl, readBody, sendJson, apiError,
 *         rateLimited, hitWindow, clientIp, attemptsPerMinutePerIp, now,
 *         resolveHolderAccount? }
 * resolveHolderAccount (optional): async (credIdHex) -> account address |
 * null — the M2 holder binding. The API server wires it to its live gRPC
 * client (getAccountInfo accepts a credId); without it, a credential-DID
 * holder cannot be resolved and no proof is ever filed (fail closed).
 * readBody / sendJson / apiError / rateLimited are the server.mjs helpers,
 * so the envelope and the 64 KiB cap match every other route.
 */
export function createAgeProofHandlers(deps) {
  const proverUrl = deps.proverUrl ?? process.env.PROVER_URL ?? PROVER_URL_DEFAULT;
  const verifierUrl = deps.verifierUrl ?? VERIFIER_URL;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  async function handleHealth(req, res) {
    let health;
    try {
      const r = await proverHealthFetch(fetchImpl, proverUrl);
      if (!r.ok) return proverUnavailableStatus(deps, res);
      health = await r.json();
    } catch {
      return proverUnavailableStatus(deps, res);
    }
    return deps.sendJson(res, 200, {
      service: 'payonce-age-proof',
      prover_available: true,
      prover: {
        service: health.service ?? 'scoped-prover',
        network: health.network ?? 'Testnet',
        attributes_held: health.attributesHeld ?? ['dob', 'nationality'],
        issuer_did: typeof health.issuerDid === 'string' ? health.issuerDid : null,
        allow_list: AGE_PROOF_ALLOW_LIST,
        refuses: AGE_PROOF_REFUSES,
      },
      anchored_run: {
        vra: AGE_PROOF_ANCHORS.vra,
        vaa: AGE_PROOF_ANCHORS.vaa,
        record_sha256: AGE_PROOF_ANCHORS.recordSha256,
        statements: AGE_PROOF_ANCHORS.statements,
      },
      // Precision (§1.2): the proven live rejection is a tampered
      // presentation (verifier 400) + forbidden shapes (prover 403).
      // No under-18-holder test exists anywhere; none is claimed here.
      proven_rejections: [
        'forbidden statement shape -> HTTP 403 from the prover policy',
        'tampered presentation -> HTTP 400 from the official testnet verifier',
      ],
      checked_at: new Date(now()).toISOString(),
    });
  }

  async function handlePolicyCheck(req, res) {
    const ip = deps.clientIp(req);
    const attempt = await deps.hitWindow(`age:${ip}`, 60_000, deps.attemptsPerMinutePerIp);
    if (!attempt.allowed) return deps.rateLimited(res, Math.ceil(attempt.resetMs / 1000));
    const body = await deps.readBody(req, AGE_PROOF_MAX_BODY).catch(() => null);
    if (!body || typeof body !== 'object' || !body.request || typeof body.request !== 'object') {
      return deps.apiError(res, 400, 'invalid', 'app', 'policy-check needs { request: <VerificationRequestV1 JSON> }.');
    }
    let r;
    try {
      r = await proverFetch(fetchImpl, proverUrl, '/policy-check', { request: body.request });
    } catch {
      return proverDown(deps, res);
    }
    let decision;
    try {
      decision = await r.json();
    } catch {
      return proverDown(deps, res);
    }
    if (r.status === 200 || r.status === 403) {
      // Pass the prover's decision through verbatim — this is the live
      // 403 path: a reveal request returns 403 REVEAL_REFUSED here.
      res.writeHead(r.status, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(decision));
    }
    return proverDown(deps, res);
  }

  async function handleVerify(req, res) {
    const ip = deps.clientIp(req);
    const attempt = await deps.hitWindow(`age:${ip}`, 60_000, deps.attemptsPerMinutePerIp);
    if (!attempt.allowed) return deps.rateLimited(res, Math.ceil(attempt.resetMs / 1000));
    const body = await deps.readBody(req, AGE_PROOF_MAX_BODY).catch(() => null);
    if (!body || typeof body !== 'object' || !body.request || typeof body.request !== 'object') {
      return deps.apiError(res, 400, 'invalid', 'app', 'verify needs { request: <VerificationRequestV1 JSON> }.');
    }
    const payableId = Number.isInteger(body.payable_id) && body.payable_id >= 1 ? body.payable_id : null;
    const payer = typeof body.payer === 'string' && body.payer ? body.payer : null;

    // (1) Policy-check via the prover.
    let policy;
    try {
      policy = await proverFetch(fetchImpl, proverUrl, '/policy-check', { request: body.request });
    } catch {
      return proverDown(deps, res);
    }
    let decision;
    try {
      decision = await policy.json();
    } catch {
      return proverDown(deps, res);
    }
    if (policy.status === 403) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(decision));
    }
    if (!policy.ok) return proverDown(deps, res);

    // (2) Ask the prover for the presentation.
    let presRes;
    try {
      presRes = await proverFetch(fetchImpl, proverUrl, '/presentation', { request: body.request });
    } catch {
      return proverDown(deps, res);
    }
    if (presRes.status === 403) {
      res.writeHead(403, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify(await presRes.json().catch(() => ({ refused: true, rule: 'REVEAL_REFUSED' }))));
    }
    if (!presRes.ok) {
      return deps.sendJson(res, 400, { valid: false, reason: 'presentation_failed' });
    }
    let presentation;
    try {
      ({ presentation } = await presRes.json());
    } catch {
      return deps.sendJson(res, 400, { valid: false, reason: 'presentation_failed' });
    }
    if (!presentation || typeof presentation !== 'object') {
      return deps.sendJson(res, 400, { valid: false, reason: 'presentation_failed' });
    }

    // (3) Submit to the official testnet verifier.
    let verdict;
    try {
      verdict = await verifierFetch(fetchImpl, verifierUrl, presentation);
    } catch {
      return deps.apiError(res, 503, 'verifier_unavailable', 'node',
        'The official testnet verifier is not answering. Nothing was filed.', { retryable: true });
    }
    if (verdict.ok) {
      // M1: the statements are DERIVED from the request's own statements —
      // a nationality-only proof claims no age, a dob≥21-only proof claims
      // no nationality. M2: the proof is filed ONLY when the request proved
      // 18+ AND the presentation's credential holder resolves to the payer.
      // Anything else verifies (200 valid:true) but files NOTHING, so the
      // gate still 409s. `binding` says why: 'bound' | 'not_requested' (no
      // payable+payer supplied — verify-only) | 'no_dob_proof' |
      // 'holder_missing' | 'holder_unresolved' | 'holder_mismatch'.
      const statements = deriveProvenStatements(body.request, now());
      let filedFor = null;
      let holder = null;
      let binding = 'not_requested';
      if (payableId && payer) {
        if (!provesAdult(body.request, now())) {
          binding = 'no_dob_proof';
        } else {
          const resolved = await resolvePresentationHolder(presentation, deps.resolveHolderAccount);
          holder = resolved.address;
          if (!resolved.address) {
            binding = resolved.reason;
          } else if (resolved.address !== payer) {
            binding = 'holder_mismatch';
          } else {
            recordVerifiedAgeProof({ payer, payableId, verifiedAtMs: now(), holder });
            filedFor = payableId;
            binding = 'bound';
          }
        }
      }
      return deps.sendJson(res, 200, {
        valid: true,
        statements,
        filed_for_payable: filedFor,
        holder,
        binding,
        verified_at: new Date(now()).toISOString(),
      });
    }
    // Rejection: the live HTTP 400 path (tampered-presentation shape, T7).
    return deps.sendJson(res, 400, { valid: false, verifier_status: verdict.status });
  }

  /**
   * F2a — verify-only path for a CLIENT-SUPPLIED presentation.
   * POST /api/age-proof/verify-presentation, body { presentation }.
   * The presentation goes STRAIGHT to the official testnet verifier —
   * no prover call, so this works while the sidecar is unprovisioned, and
   * a tampered presentation returns the REAL live 400 from the verifier
   * through the API (the leg /verify cannot provide: it generates its own
   * presentation and ignores any client-supplied one). Verification ONLY:
   * nothing is filed, the gate is untouched. The presentation is forwarded
   * as-is and never logged or echoed back.
   */
  async function handleVerifyPresentation(req, res) {
    const ip = deps.clientIp(req);
    const attempt = await deps.hitWindow(`age:${ip}`, 60_000, deps.attemptsPerMinutePerIp);
    if (!attempt.allowed) return deps.rateLimited(res, Math.ceil(attempt.resetMs / 1000));
    const body = await deps.readBody(req, AGE_PROOF_MAX_BODY).catch(() => null);
    if (!body || typeof body !== 'object' || !body.presentation || typeof body.presentation !== 'object') {
      return deps.apiError(res, 400, 'invalid', 'app', 'verify-presentation needs { presentation: <VerifiablePresentation JSON> }.');
    }
    let verdict;
    try {
      verdict = await verifierFetch(fetchImpl, verifierUrl, body.presentation);
    } catch {
      return deps.apiError(res, 503, 'verifier_unavailable', 'node',
        'The official testnet verifier is not answering. Nothing was filed.', { retryable: true });
    }
    if (verdict.ok) {
      return deps.sendJson(res, 200, { valid: true, filed_for_payable: null, verified_at: new Date(now()).toISOString() });
    }
    return deps.sendJson(res, 400, { valid: false, verifier_status: verdict.status, filed_for_payable: null });
  }

  return { handleHealth, handlePolicyCheck, handleVerify, handleVerifyPresentation };
}
