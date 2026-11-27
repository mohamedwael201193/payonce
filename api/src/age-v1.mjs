// PayOnce API - V&A V1 age proof for a payable (L2). Testnet only.
//
//   POST /api/age-proof/v1   { payable_id, payer? }
//
// The SELLER side issues the request: it anchors a Verification Request (VRA) on chain (age >= 18 and EU
// nationality, nothing else) signed by the owner account. The BUYER side answers: the scoped prover (which holds
// only the dob and nationality openings of the paying account's credential) builds the V1 presentation from that
// anchor. The server verifies the presentation against the node, resolves the credential to its account, anchors
// the audit record (VAA), and files the proof for that payer and payable ONLY if the holder account equals the
// payer. The pay path then finds the proof on file (age-proof.mjs ageGateCheck).
//
// What this proves, and what it does not: the proof is zero-knowledge about dob and nationality. On the CCD rail
// the contract cannot verify it; the gate is this server plus the verifier. On the EUDemo rail the co-signer gate
// sits behind the same check. Nothing here reveals an attribute value.
import { randomBytes } from 'node:crypto';
import {
  VerificationRequestV1, VerificationAuditRecordV1, VerifiablePresentationV1, IdentityProviderDID, AccountAddress,
} from '@concordium/web-sdk';
import { vClient, verifyV1PresentationWithNode, assertContextsMatch, CONSENT_DOMAIN } from './consent.mjs';
import { resolvePresentationHolder, provesAdult, recordVerifiedAgeProof, deriveProvenStatements, PROVER_URL_DEFAULT } from './age-proof.mjs';

const toJsonSafe = (o) => JSON.parse(JSON.stringify(o, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
/** The public node answers 429 under load; nothing was accepted when it does, so a bounded retry is safe. */
export async function retryBusy(fn, { tries = 5, baseMs = 2500 } = {}) {
  let last;
  for (let i = 0; i < tries; i += 1) {
    try { return await fn(); } catch (e) {
      last = e;
      const busy = /RESOURCE_EXHAUSTED|UNAVAILABLE|HTTP status code (429|502|503|504)|ECONNRESET|ETIMEDOUT|DEADLINE/i.test(String(e?.message ?? e)) || [8, 14, 4].includes(Number(e?.code));
      if (!busy || i === tries - 1) throw e;
      await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
    }
  }
  throw last;
}
const hashOf = (ref) => (ref?.toString?.() ?? String(ref ?? '')).toLowerCase();

/**
 * @returns {Promise<object>} { ok, ... } - never throws for an expected failure; every failure names its step.
 */
export async function runAgeProofV1({ waitTx, signers, payableId, payer, resolveHolderAccount, proverUrl = PROVER_URL_DEFAULT, fetchImpl = fetch, now = Date.now }) {
  const steps = [];
  const step = (name, ok, detail) => steps.push({ step: name, ok, detail });
  const { owner } = await signers();
  const sender = AccountAddress.fromBase58(owner.address);

  // 1. The seller side anchors the request (VRA).
  let request;
  let vraTx;
  try {
    const nonce = randomBytes(32);
    const context = VerificationRequestV1.createSimpleContext(
      new Uint8Array(nonce), `payonce-age-${payableId}`, CONSENT_DOMAIN,
      `PayOnce payable ${payableId}: the payer proves age 18+ and EU nationality, nothing else is revealed`,
    );
    const claims = VerificationRequestV1.claimsBuilder()
      .addAccountClaims([new IdentityProviderDID('Testnet', 0)], (b) => b.addMinimumAge(18).addEUNationality())
      .getClaims();
    request = await retryBusy(() => VerificationRequestV1.createAndAnchor(vClient(), { sender, signer: owner.signer }, context, claims, { app: 'payonce-age', payable: payableId }));
    vraTx = hashOf(request.transactionRef);
    await waitTx(vraTx);
    step('vra_anchored', true, vraTx);
  } catch (e) {
    return { ok: false, step: 'vra', error: `could not anchor the verification request: ${String(e?.message ?? e).slice(0, 160)}`, steps };
  }
  const reqJson = toJsonSafe(request.toJSON());

  // 2. The buyer side answers through the scoped prover (policy check, then proof).
  let presJson;
  try {
    const r = await fetchImpl(`${proverUrl}/presentation`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ request: reqJson }), signal: AbortSignal.timeout(60_000) });
    const body = await r.json().catch(() => ({}));
    if (r.status === 403) return { ok: false, step: 'prover', refused: true, rule: body.rule ?? null, error: `the scoped prover refused the request (${body.rule ?? 'policy'})`, vra_tx: vraTx, steps };
    if (!r.ok || !body.presentation) return { ok: false, step: 'prover', error: `the prover could not build a presentation (HTTP ${r.status})`, vra_tx: vraTx, steps };
    presJson = body.presentation;
    step('presentation_built', true, 'by the scoped prover (dob + nationality openings only)');
  } catch (e) {
    return { ok: false, step: 'prover', error: 'prover_unavailable: the scoped prover is not reachable from this API host', vra_tx: vraTx, steps };
  }

  // 3. The server verifies it against the node.
  let presentation;
  try { presentation = VerifiablePresentationV1.fromJSON(presJson); } catch (e) { return { ok: false, step: 'presentation', error: 'malformed presentation', vra_tx: vraTx, steps }; }
  let node = await verifyV1PresentationWithNode(presentation);
  if (!node.ok && /429|UNAVAILABLE|RESOURCE_EXHAUSTED/.test(node.reason)) { await new Promise((r) => setTimeout(r, 4000)); node = await verifyV1PresentationWithNode(presentation); }
  step('node_verified', node.ok, node.ok ? 'VerifiablePresentationV1.verifyWithNode: success' : node.reason);
  if (!node.ok) return { ok: false, step: 'node_verify', error: `the node rejected the presentation (${node.reason})`, vra_tx: vraTx, steps };

  // 4. The holder account must be the paying account.
  const holder = await resolvePresentationHolder(presJson, resolveHolderAccount);
  const adult = provesAdult(reqJson, now());
  const statements = deriveProvenStatements(reqJson, now());
  let binding = 'bound';
  if (!adult) binding = 'no_dob_proof';
  else if (!holder.address) binding = holder.reason;
  else if (holder.address !== payer) binding = 'holder_mismatch';
  step('holder_bound', binding === 'bound', `holder account ${holder.address ?? 'unknown'}, paying account ${payer}`);

  // 5. Anchor the audit record (VAA), so a third party can re-verify from the chain.
  let vaaTx = null;
  try {
    assertContextsMatch(request, presentation);
    const result = await retryBusy(() => VerificationAuditRecordV1.createAndAnchor(
      `payonce-age-${payableId}`, request, presentation, vClient(),
      { metadata: { sender, signer: owner.signer }, info: { app: 'payonce-age', payable: payableId } }, { network: 'Testnet' },
    ));
    if (result?.type === 'success') { vaaTx = hashOf(result.result?.anchorTransactionRef); step('vaa_anchored', true, vaaTx); }
    else step('vaa_anchored', false, 'audit record anchor failed');
  } catch (e) {
    step('vaa_anchored', false, String(e?.message ?? e).slice(0, 120));
  }

  if (binding === 'bound') recordVerifiedAgeProof({ payer, payableId, verifiedAtMs: now(), holder: holder.address });
  return {
    ok: binding === 'bound', binding, statements, holder: holder.address, payer, payable_id: payableId,
    vra_tx: vraTx, vaa_tx: vaaTx, verified_at: new Date(now()).toISOString(), valid_for_seconds: 600, steps,
    note: 'Zero-knowledge: no attribute value was revealed. The CCD contract cannot verify this proof; the server and the verifier enforce the gate.',
  };
}
