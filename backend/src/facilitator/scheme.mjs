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
// The hosted testnet facilitator (API key via process env
// X402_FACILITATOR_API_KEY) is the DEFAULT path — see hosted.mjs /
// hosted-payonce.mjs. This self-hosted facilitator is the FALLBACK, used
// only when the hosted facilitator is unreachable (never on a hosted
// rejection); hosted-payonce.mjs owns that precedence.
import { checkPayableBinding } from './binding.mjs';
import { ExactConcordiumScheme as FacilitatorScheme } from '@x402/concordium/exact/facilitator';
import {
  toConcordiumFacilitatorSigner,
  getConcordiumGrpcUrl,
  parseGrpcUrl,
  CONCORDIUM_TESTNET_CAIP2,
} from '@x402/concordium';
import { grpcClient, getAccountInfo } from '../chain.mjs';
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
  const v = await facilitator.scheme.verify(payload, requirements);
  const client = grpcClient();
  // The payable binding lives in binding.mjs, shared with the hosted path —
  // same checks, same names, same order. See that module for the rules.
  return checkPayableBinding({
    verifyResult: v, payload, requirements, payableId, expectedStatus,
    loadPayable: (id) => getPayable(client, id),
  });
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
