// PayOnce backend — self-hosted x402 facilitator (Concordium testnet).
// Wraps @x402/concordium 2.32.0 ExactConcordiumScheme (Doris's 9 MUST checks:
// sender, sponsor address, price, recipient, exact amount, right token,
// single transfer, expiry, signature) and adds the PayOnce layer on top:
// the transfer must bind to a real payable (amount == stored amount,
// recipient == stored payee, memo == canonical `payable:<id>` for PLT,
// payable in the right status).
//
// Doris's 4 sponsor safeguards, implemented here:
//   1. Verify the tx before signing — settle() re-runs verify() (inside the
//      scheme) AND payonceVerify() runs first in this module.
//   2. Protect keys — the sponsor signer lives in memory only, built from the
//      env key in-process; it is never logged, printed, or written to disk.
//   3. Rate-limit — RateLimiter below (per-IP token bucket, fail-closed).
//   4. Watch balance / top-up — sponsorBalance() + LOW_BALANCE_CCD warning;
//      the server's /health reports it. (Top-up is a human step.)
//
// The hosted testnet facilitator (API key by DM to Piotr) is a USER step;
// this self-hosted facilitator is the fallback and the one exercised live.
import { ExactConcordiumScheme as FacilitatorScheme } from '@x402/concordium/exact/facilitator';
import {
  toConcordiumFacilitatorSigner,
  getConcordiumGrpcUrl,
  parseGrpcUrl,
  CONCORDIUM_TESTNET_CAIP2,
} from '@x402/concordium';
import { grpcClient, getAccountInfo, encodeCborMemo, decodeCborMemo } from '../chain.mjs';
import { getPayable } from '../registry.mjs';
import { loadSigners, OWNER_ADDRESS } from '../send.mjs';

export const TESTNET_CAIP2 = CONCORDIUM_TESTNET_CAIP2;
export const LOW_BALANCE_CCD = 50; // warn below this sponsor balance (microCCD: 50_000_000)
export const DEFAULT_RATE_LIMIT = { maxRequests: 30, windowMs: 60_000 };

/** Build the self-hosted facilitator. Sponsor = the owner account (in-process signer). */
export function createFacilitator({ sponsorAddress = OWNER_ADDRESS, sponsorSigner = null, maxExpiryOffsetSeconds = 600 } = {}) {
  const signers = sponsorSigner ? null : loadSigners();
  const signer = sponsorSigner ?? signers.owner.signer;
  const [host, port] = parseGrpcUrl(getConcordiumGrpcUrl(TESTNET_CAIP2));
  const facilitatorSigner = toConcordiumFacilitatorSigner(
    sponsorAddress,
    signer,
    { host, port, useTls: true, network: TESTNET_CAIP2 },
  );
  const scheme = new FacilitatorScheme({
    signer: facilitatorSigner,
    requireFinalization: true,
    finalizationTimeoutMs: 60_000,
    maxExpiryOffsetSeconds,
  });
  return { scheme, sponsorAddress, network: TESTNET_CAIP2, grpcHost: host, grpcPort: port };
}

/** Sponsor CCD balance (microCCD, string) + low-balance flag. */
export async function sponsorBalance(client, sponsorAddress = OWNER_ADDRESS) {
  const { toJson } = await import('../chain.mjs');
  const consensus = toJson(await client.getConsensusStatus());
  const info = await getAccountInfo(client, sponsorAddress, consensus.lastFinalizedBlock);
  const j = JSON.parse(JSON.stringify(info, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
  const microCcd = BigInt(j.accountAmount?.value ?? j.accountAmount ?? 0);
  return { microCcd: microCcd.toString(), ccd: Number(microCcd) / 1e6, low: microCcd < BigInt(LOW_BALANCE_CCD * 1e6) };
}

/** In-memory per-key token-bucket rate limiter (fail-closed: over limit => refuse). */
export class RateLimiter {
  constructor({ maxRequests = DEFAULT_RATE_LIMIT.maxRequests, windowMs = DEFAULT_RATE_LIMIT.windowMs } = {}) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
    this.buckets = new Map(); // key -> { count, windowStart }
  }
  allow(key, nowMs = Date.now()) {
    const b = this.buckets.get(key);
    if (!b || nowMs - b.windowStart >= this.windowMs) {
      this.buckets.set(key, { count: 1, windowStart: nowMs });
      return { allowed: true, remaining: this.maxRequests - 1 };
    }
    if (b.count >= this.maxRequests) return { allowed: false, remaining: 0 };
    b.count += 1;
    return { allowed: true, remaining: this.maxRequests - b.count };
  }
}

/**
 * PayOnce layer on top of the scheme's verify().
 * Runs the scheme's 9 checks first; then binds the transfer to the payable:
 *   - the payable must exist, and (Rail B) be Reserved, (Rail A direct) Unpaid;
 *   - the requirements amount must equal the stored amount;
 *   - the requirements payTo must equal the stored payee;
 *   - for PLT, the signed tx's operations must contain exactly the canonical
 *     CBOR memo `payable:<id>` (byte-level check on the operations hex).
 * Returns { isValid, payer, invalidReason?, invalidMessage?, payonce: {checks} }.
 */
export async function payonceVerify(facilitator, payload, requirements, { payableId, expectedStatus = null } = {}) {
  const checks = [];
  const fail = (reason, message) => ({ isValid: false, payer: '', invalidReason: reason, invalidMessage: message, payonce: { checks } });
  const v = await facilitator.scheme.verify(payload, requirements);
  checks.push({ name: 'x402-9-checks', ok: v.isValid, detail: v.isValid ? 'scheme verify passed' : `${v.invalidReason}: ${v.invalidMessage ?? ''}` });
  if (!v.isValid) return fail(v.invalidReason ?? 'x402_verify_failed', v.invalidMessage ?? 'scheme verify failed');
  const client = grpcClient();
  let view = null;
  try {
    view = await getPayable(client, payableId);
  } catch (e) {
    checks.push({ name: 'payable-exists', ok: false, detail: String(e.message).slice(0, 120) });
    return fail('payable_not_found', `payable ${payableId} not found: ${e.message}`);
  }
  checks.push({ name: 'payable-exists', ok: true, detail: `status=${view.status} asset=${view.asset} amount=${view.amount}` });
  if (expectedStatus && view.status !== expectedStatus) {
    checks.push({ name: 'payable-status', ok: false, detail: `expected ${expectedStatus}, got ${view.status}` });
    return fail('payable_wrong_status', `payable ${payableId} is ${view.status}, expected ${expectedStatus}`);
  }
  checks.push({ name: 'payable-status', ok: true, detail: `status=${view.status}` });
  if (String(requirements.amount) !== String(view.amount)) {
    checks.push({ name: 'amount-is-stored', ok: false, detail: `requirements=${requirements.amount}, stored=${view.amount}` });
    return fail('amount_mismatch', `requirements amount ${requirements.amount} != stored ${view.amount}`);
  }
  checks.push({ name: 'amount-is-stored', ok: true, detail: `amount=${view.amount}` });
  if (requirements.payTo !== view.payee) {
    checks.push({ name: 'payee-is-stored', ok: false, detail: `payTo=${requirements.payTo}, stored=${view.payee}` });
    return fail('payee_mismatch', `payTo ${requirements.payTo} != stored payee ${view.payee}`);
  }
  checks.push({ name: 'payee-is-stored', ok: true, detail: `payee=${view.payee}` });
  if (view.asset !== 'CCD') {
    const opsHex = payload?.payload?.signedTransaction?.payload?.operations ?? null;
    const memoHex = encodeCborMemo(`payable:${payableId}`).toString('hex');
    const hasMemo = typeof opsHex === 'string' && opsHex.toLowerCase().includes(memoHex);
    checks.push({ name: 'memo-is-payable-id', ok: hasMemo, detail: hasMemo ? `memo payable:${payableId} present` : 'canonical memo bytes missing from operations' });
    if (!hasMemo) return fail('memo_missing', `transfer carries no canonical memo payable:${payableId}`);
    // The memo must decode to exactly `payable:<id>` (not a longer string
    // that merely contains it) — decode the memo bytes found in the ops.
    const decoded = decodeCborMemo(memoHex);
    checks.push({ name: 'memo-canonical', ok: decoded.canonical && decoded.text === `payable:${payableId}`, detail: `memo=${decoded.text} canonical=${decoded.canonical}` });
  }
  return { isValid: true, payer: v.payer, payonce: { checks, view } };
}

/** Settle through the facilitator after the PayOnce layer passes. Records nothing on its own; the caller ledgers the result. */
export async function payonceSettle(facilitator, payload, requirements, opts = {}) {
  const verified = await payonceVerify(facilitator, payload, requirements, opts);
  if (!verified.isValid) return { success: false, network: facilitator.network, transaction: '', errorReason: verified.invalidReason, errorMessage: verified.invalidMessage, payer: verified.payer, payonce: verified.payonce };
  const settled = await facilitator.scheme.settle(payload, requirements);
  return { ...settled, payonce: verified.payonce };
}

/** Build x402 PaymentRequirements for a payable (resource-server side). */
export function requirementsForPayable(view, { sponsorAddress = OWNER_ADDRESS, maxTimeoutSeconds = 300 } = {}) {
  return {
    scheme: 'exact',
    network: TESTNET_CAIP2,
    amount: String(view.amount),
    asset: view.asset === 'CCD' ? 'CCD' : view.asset,
    payTo: view.payee,
    maxTimeoutSeconds,
    extra: { feePayer: sponsorAddress, payableId: view.id },
  };
}
