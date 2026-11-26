// PayOnce backend — hosted-FIRST x402 verify/settle with PayOnce binding (testnet only).
//
// Precedence (the whole point of this module — read it before changing it):
//   1. HOSTED is the default path. A hosted verdict (valid OR invalid) is
//      FINAL: it is never re-tried against the self-hosted facilitator.
//      A hosted rejection (isValid:false / success:false) must never be
//      silently masked by a self-hosted verdict.
//   2. SELF-HOSTED is the fallback ONLY when the hosted facilitator cannot
//      be reached at all — transport failure, timeout, HTTP 5xx, or a
//      malformed hosted response. The fallback response is always labelled
//      `facilitator: 'self-hosted-fallback'` + `fallbackReason` (the hosted
//      error code), so no caller can mistake it for a hosted verdict.
//   3. Hosted AUTH failure (401/403 — wrong/revoked key, forbidden), hosted
//      INVALID PAYLOAD (400), hosted NOT FOUND (404 — misconfigured base URL),
//      hosted RATE LIMIT (429 — deliberate refusal under load), and ANY OTHER
//      unexpected hosted status (hosted_unexpected_status — every unmapped
//      4xx, e.g. 405/408/409/413/418/422, and any surfaced 3xx) NEVER fall
//      back: they fail closed with `facilitator: 'hosted'` and the hosted
//      error code. A revoked key must be visible, not papered over by the
//      owner sponsoring instead; a 429 must not silently abandon hosted-first
//      exactly when the hosted service is stressed; a 404 must not mask a
//      misconfigured URL as a transport blip.
//   4. SETTLE never falls back. A payload built for the hosted path names
//      the hosted sponsor in its header; the self-hosted facilitator does
//      not manage that sponsor, so a settle fallback could only fail —
//      with a confusing reason — and would split verify/settle across two
//      facilitators. Verify-fallback is read-only and safe; settle stays
//      on whichever facilitator verified. (Limitation: a verify fallback
//      only helps owner-sponsored payloads — a hosted-shaped payload still
//      fails self-hosted verify with fee_payer_not_managed_by_facilitator,
//      labelled as fallback. That is the honest behaviour, not a bug.)
//   4b. A hosted SETTLE SUCCESS is never trusted blindly: the returned tx
//      hash is read back on-chain (getTxStatus — must be committed or
//      finalized in a block) AND its CONTENTS are checked against the
//      settled payload (sender, amount, recipient, asset, and for PLT the
//      canonical `payable:<id>` memo on the settled transfer) before the
//      settle is reported as success or ledgered. A success whose tx never
//      appears on chain is reported as `success:false` /
//      `hosted_settle_unconfirmed`; a success whose tx exists but belongs
//      to a DIFFERENT payment is reported as `success:false` /
//      `hosted_settle_content_mismatch`, with the claimed hash kept in
//      `claimedTransaction` for operator diagnosis. (FIXBACK2, MF-X402-FB-A2:
//      existence-only read-back was proven insufficient live — a fake hosted
//      endpoint returning the REAL finalized Rail-A settle tx
//      74a06a17… (a different payment, 2026-11-24) for payable 3 got
//      success:true AND a false ledger entry. Existence is necessary, not
//      sufficient.) The trust boundary is the configured
//      X402_FACILITATOR_URL: the default is Concordium-run over TLS; a
//      misconfigured/compromised endpoint can no longer ledger a phantom
//      OR a real-but-unrelated settle.
//   5. The PayOnce binding (binding.mjs: payable exists/status, amount,
//      payee, PLT memo) runs on BOTH paths, after the facilitator verdict.
//      The hosted facilitator never checks the memo or the payable.
//
// Callers pass a `loadPayable(payableId)` (or a gRPC `grpc` client, from
// which the default loader is built). `selfHosted` is the object returned
// by scheme.mjs createFacilitator(); omit it (or pass allowFallback:false)
// to disable the fallback entirely.
import { grpcClient, getTxStatus, decodeCborMemo } from '../chain.mjs';
import { getPayable } from '../registry.mjs';
import { checkPayableBinding } from './binding.mjs';
import { HostedFacilitatorError } from './hosted.mjs';

/** Hosted error codes on which the (read-only) self-hosted verify fallback is allowed. */
export const FALLBACK_ELIGIBLE_CODES = new Set(['hosted_unreachable', 'hosted_unavailable', 'hosted_bad_response']);

/** Hosted error codes that fail closed (never fallback-eligible). Kept as a
 *  named set so the taxonomy is explicit in one place; hosted-payonce.mjs
 *  only ever consults FALLBACK_ELIGIBLE_CODES, this set documents the rest. */
export const FAIL_CLOSED_CODES = new Set(['hosted_auth_failed', 'hosted_invalid_payload', 'hosted_not_found', 'hosted_rate_limited', 'hosted_unexpected_status']);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Check a settled tx's on-chain summary against the payload it claims to
 * settle. `expected` is { sender, amount, recipient, asset, payableId } —
 * sender from the signed payload header (fallback: the verified payer),
 * amount/recipient/asset from the payment requirements.
 * `expected` is REQUIRED and must be COMPLETE (FIXBACK3 A2a/A2b): a missing
 * or empty `sender` is a mismatch for any asset (a tx from ANY sender must
 * never confirm when the payload sender is unknown), and a missing
 * `payableId` is a mismatch for a PLT asset (the memo check is never
 * skippable — a PLT transfer carrying the WRONG memo must not confirm just
 * because no payableId was supplied to check it against).
 * Returns null when the contents match, else a human-readable mismatch
 * detail (first difference found). Exported for tests.
 * Shapes (verified live against real testnet summaries):
 *   - CCD: summary.transactionType === 'transfer',
 *     summary.transfer == { tag: 'Transferred', amount, to }.
 *   - PLT: summary.transactionType === 'tokenUpdate', with EXACTLY ONE
 *     TokenTransfer event for that token (FIXBACK3 OB-1: a second transfer
 *     in the same tx — e.g. a drain to an attacker — is a mismatch, not
 *     something to ignore by find()ing the matching event first) whose
 *     from/to/amount match AND whose memo bytes decode to exactly
 *     `payable:<payableId>`.
 * Anything else (unknown tx type, missing fields, a second transfer in the
 * same tx with different contents) is a mismatch: fail closed, never pass
 * a summary this function cannot read.
 */
export function matchSettleTxContents(summary, expected) {
  if (!summary || typeof summary !== 'object') return 'no tx summary returned by the node';
  if (!expected || typeof expected !== 'object') return 'no expected settle contents supplied — existence alone is not a confirmation';
  const sender = summary.sender;
  if (typeof sender !== 'string' || !sender) return 'tx summary has no sender';
  // FIXBACK3 A2a: a missing/empty expected sender is a mismatch, never "skip
  // the check" — the old `if (expected.sender && ...)` let a tx from ANY
  // sender confirm when expected.sender was absent.
  if (typeof expected.sender !== 'string' || !expected.sender) return 'expected settle contents have no sender — cannot confirm the tx belongs to this payload';
  if (sender !== expected.sender) return `tx sender ${sender} != payload sender ${expected.sender}`;
  const amount = String(expected.amount);
  const recipient = expected.recipient;
  if (expected.asset === 'CCD') {
    if (summary.transactionType !== 'transfer') return `tx type ${summary.transactionType ?? '(none)'} is not a CCD transfer`;
    const t = summary.transfer ?? {};
    if (String(t.amount ?? '') !== amount) return `tx amount ${t.amount ?? '(none)'} != settled amount ${amount}`;
    if (t.to !== recipient) return `tx recipient ${t.to ?? '(none)'} != settled recipient ${recipient}`;
    return null;
  }
  // PLT token transfer.
  if (summary.transactionType !== 'tokenUpdate') return `tx type ${summary.transactionType ?? '(none)'} is not a tokenUpdate for ${expected.asset}`;
  const events = Array.isArray(summary.events) ? summary.events : [];
  const transfers = events.filter((e) => e?.tag === 'TokenTransfer' && e?.tokenId === expected.asset);
  if (transfers.length === 0) return `tx has no ${expected.asset} TokenTransfer event`;
  // FIXBACK3 MF-X402-FB2-A2c (non-blocking; adversarial verdict line 90):
  // exactly one settled transfer is expected. A second
  // transfer in the same tx (e.g. a drain to an attacker address) is a
  // mismatch — the old code find()ed the matching event and ignored the rest,
  // contradicting this function's own docstring.
  if (transfers.length > 1) return `tx has ${transfers.length} ${expected.asset} TokenTransfer events — expected exactly one settled transfer`;
  const match = transfers.find((e) => {
    const from = e.from?.address ?? e.from;
    const to = e.to?.address ?? e.to;
    return from === sender && to === recipient && String(e.amount?.value ?? e.amount ?? '') === amount;
  });
  if (!match) {
    const first = transfers[0];
    return `no ${expected.asset} transfer of ${amount} from ${sender} to ${recipient} in tx (first event: ${String(first?.amount?.value ?? first?.amount ?? '')} from ${first?.from?.address ?? first?.from ?? '?'} to ${first?.to?.address ?? first?.to ?? '?'})`;
  }
  // The settled transfer must carry the canonical payable memo. The memo
  // check is NEVER skipped (FIXBACK3 A2b): a missing payableId is a mismatch.
  if (expected.payableId === undefined || expected.payableId === null || String(expected.payableId) === '') {
    return 'expected settle contents have no payableId — cannot check the settled transfer memo';
  }
  const memoHex = typeof match.memo === 'string' ? match.memo : '';
  // On chain the memo is CBOR (a text-string header, e.g. 0x78 0x40 for a 64-byte text), so decode it as
  // CBOR first; the raw-UTF-8 reading is kept only for legacy fixtures whose memo hex is plain text.
  // (Found by the first real hosted settle, 2026-11-26: a real memo never matched the raw reading.)
  let memoText = '';
  try {
    memoText = decodeCborMemo(memoHex).text;
    if (!memoText && memoHex) memoText = Buffer.from(memoHex, 'hex').toString('utf8');
  } catch { memoText = ''; }
  if (memoText !== `payable:${expected.payableId}`) return `settled transfer memo is ${memoText ? `'${memoText}'` : '(missing)'} != 'payable:${expected.payableId}'`;
  return null;
}

/**
 * Read a claimed settle tx back on-chain AND check its contents against
 * the payload it claims to settle. Returns
 * `{ confirmed: true, status, blockHash }` only when the tx is in a block
 * (committed or finalized) AND its contents match `expected`.
 * Otherwise `{ confirmed: false, reason, contentMismatch }` — contentMismatch
 * is true when the tx EXISTS but belongs to a different payment.
 * `expected` ({ sender, amount, recipient, asset, payableId }) is REQUIRED
 * for a confirmation: without a payload to check against, existence alone
 * is not a confirmation (FIXBACK2 A2). Polls briefly because a just-settled
 * tx can take seconds to land in a block; a hash that never appears (wrong
 * hash, phantom success from a misconfigured endpoint) is unconfirmed, not
 * successful. A contents mismatch is final — it is returned at once, not
 * re-polled (the tx will not change its contents by landing later).
 * `grpc` is an existing gRPC client (server passes its own); otherwise a
 * fresh client is built. Exported for tests.
 */
export async function confirmSettleTxOnChain(txHash, { grpc = null, expected = null } = {}) {
  const hash = typeof txHash === 'string' ? txHash.trim() : '';
  if (!/^[0-9a-fA-F]{64}$/.test(hash)) return { confirmed: false, reason: `claimed settle transaction is not a 64-hex hash: ${String(txHash).slice(0, 40)}` };
  const client = grpc ?? grpcClient();
  // Poll at 0s, 2s, 4s, 7s, 11s (~11 s budget): a real settle lands in a
  // block within seconds on testnet; a phantom hash never lands.
  const delaysMs = [0, 2000, 2000, 3000, 4000];
  let lastError = null;
  for (let attempt = 0; attempt < delaysMs.length; attempt += 1) {
    if (delaysMs[attempt] > 0) await sleep(delaysMs[attempt]);
    try {
      const { status, blockHash, summary } = await getTxStatus(client, hash);
      if (status === 'committed' || status === 'finalized') {
        if (!expected) return { confirmed: false, reason: 'no expected settle contents supplied — existence alone is not a confirmation' };
        const mismatch = matchSettleTxContents(summary, expected);
        if (mismatch) return { confirmed: false, contentMismatch: true, reason: `settle tx contents do not match the settled payload: ${mismatch}` };
        return { confirmed: true, status, blockHash };
      }
      lastError = new Error(`tx status is ${status}, not committed/finalized`);
    } catch (e) {
      lastError = e; // not found yet / no outcome yet — retry until the budget runs out
    }
  }
  return { confirmed: false, reason: `transaction ${hash.slice(0, 12)}… not found committed on chain after read-back (${lastError ? String(lastError.message).slice(0, 120) : 'unknown'})` };
}

function defaultLoadPayable(grpc) {
  const client = grpc ?? grpcClient();
  return (id) => getPayable(client, id);
}

/**
 * Verify a payable's payment, hosted-first.
 * Returns the payonceVerify-shaped result plus `facilitator`:
 *   'hosted' | 'self-hosted-fallback', and `fallbackReason` when fallen back.
 */
export async function verifyPayableHostedFirst({ hosted, selfHosted = null, grpc = null, loadPayable = null, payload, requirements, payableId, expectedStatus = null, allowFallback = true } = {}) {
  const load = loadPayable ?? defaultLoadPayable(grpc);
  let hostedOut;
  try {
    hostedOut = await hosted.verify(payload, requirements);
  } catch (e) {
    if (e instanceof HostedFacilitatorError && FALLBACK_ELIGIBLE_CODES.has(e.code) && allowFallback && selfHosted) {
      // Read-only fallback: the self-hosted scheme verifies, then the SAME
      // binding runs (identical to payonceVerify, via the injected loader).
      const fbVerify = await selfHosted.scheme.verify(payload, requirements);
      const fb = await checkPayableBinding({ verifyResult: fbVerify, payload, requirements, payableId, expectedStatus, loadPayable: load });
      return { ...fb, facilitator: 'self-hosted-fallback', fallbackReason: e.code };
    }
    const code = e instanceof HostedFacilitatorError ? e.code : 'hosted_error';
    return {
      isValid: false, payer: '', invalidReason: code,
      invalidMessage: e instanceof Error ? e.message : 'hosted verify failed',
      facilitator: 'hosted',
      payonce: { checks: [{ name: 'hosted-verify', ok: false, detail: code }] },
    };
  }
  const bound = await checkPayableBinding({ verifyResult: hostedOut, payload, requirements, payableId, expectedStatus, loadPayable: load });
  return { ...bound, facilitator: 'hosted' };
}

/**
 * Settle a payable's payment, hosted-first. NO fallback (see header rule 4).
 * Returns the settle-shaped result plus `facilitator: 'hosted'`.
 * The caller should have verified first; settle re-verifies server-side.
 * A hosted settle SUCCESS is truth-gated by on-chain read-back + contents
 * check (header rule 4b): `confirmTx` defaults to confirmSettleTxOnChain
 * (real gRPC read-back + contents match against the payload/requirements);
 * pass a stub only in tests. The stub receives (txHash, expected). On
 * read-back failure the settle is reported as `success:false` /
 * `hosted_settle_unconfirmed` (tx never appeared) or
 * `hosted_settle_content_mismatch` (tx exists but belongs to a different
 * payment) — never ledgered as settled.
 */
export async function settlePayableHostedFirst({ hosted, grpc = null, loadPayable = null, payload, requirements, payableId, expectedStatus = null, confirmTx = null } = {}) {
  const load = loadPayable ?? defaultLoadPayable(grpc);
  const verified = await verifyPayableHostedFirst({ hosted, selfHosted: null, loadPayable: load, payload, requirements, payableId, expectedStatus, allowFallback: false });
  if (!verified.isValid) {
    return {
      success: false, network: hosted.network ?? 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
      transaction: '', errorReason: verified.invalidReason, errorMessage: verified.invalidMessage,
      payer: verified.payer, facilitator: verified.facilitator ?? 'hosted', payonce: verified.payonce,
    };
  }
  // The payload names the hosted sponsor: only the hosted facilitator can settle it.
  let settled;
  try {
    settled = await hosted.settle(payload, requirements);
  } catch (e) {
    const code = e instanceof HostedFacilitatorError ? e.code : 'hosted_error';
    return {
      success: false, network: hosted.network ?? 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
      transaction: '', errorReason: code, errorMessage: e instanceof Error ? e.message : 'hosted settle failed',
      payer: verified.payer, facilitator: 'hosted', payonce: verified.payonce,
    };
  }
  if (settled.success) {
    // Truth-gate (header rule 4b): do NOT report success — and never let a
    // caller ledger it — until the tx hash reads back on-chain AND its
    // contents match this payload. The expected sender is the signed
    // payload's header sender, falling back to the verified payer (unit
    // fixtures carry a minimal signedTransaction without a header).
    const signedTx = payload?.payload?.signedTransaction ?? {};
    const expected = {
      sender: signedTx?.header?.sender ?? verified.payer ?? '',
      amount: requirements?.amount,
      recipient: requirements?.payTo,
      asset: requirements?.asset,
      payableId,
    };
    const confirm = confirmTx ?? ((tx, exp) => confirmSettleTxOnChain(tx, { grpc, expected: exp }));
    let confirmation;
    try {
      confirmation = await confirm(settled.transaction, expected);
    } catch (e) {
      confirmation = { confirmed: false, reason: `settle read-back failed: ${String(e.message).slice(0, 120)}` };
    }
    if (!confirmation?.confirmed) {
      return {
        success: false, network: settled.network ?? hosted.network ?? 'ccd:4221332d34e1694168c2a0c0b3fd0f27',
        transaction: '', errorReason: confirmation?.contentMismatch ? 'hosted_settle_content_mismatch' : 'hosted_settle_unconfirmed',
        errorMessage: confirmation?.reason ?? 'settle transaction did not read back on chain',
        claimedTransaction: typeof settled.transaction === 'string' ? settled.transaction : '',
        payer: verified.payer, facilitator: 'hosted', payonce: verified.payonce,
      };
    }
    return { ...settled, facilitator: 'hosted', payonce: verified.payonce, settleConfirmation: { status: confirmation.status, blockHash: confirmation.blockHash } };
  }
  return { ...settled, facilitator: 'hosted', payonce: verified.payonce };
}
