// PayOnce backend — HOSTED x402 facilitator client (Concordium testnet only).
//
// Talks to the hosted testnet facilitator run by Concordium:
//   base: https://x402-facilitator.testnet.concordium.com
//   auth: `X-API-Key` header on EVERY route (Bearer is wrong -> 401).
//   POST /verify  { paymentPayload, paymentRequirements } -> { isValid, payer, invalidReason? }
//   POST /settle  { paymentPayload, paymentRequirements } -> { success, network, transaction, errorReason?, payer }
//   GET  /supported -> { kinds: [{ x402Version: 2, scheme: "exact", network: "ccd:4221332d…", extra: { feePayer } }], signers }
//   GET  /health     -> { ok: true }
//
// Key handling (hard rules):
//   - The key arrives ONLY as a constructor argument, normally from
//     `process.env.X402_FACILITATOR_API_KEY`. This module NEVER reads any
//     file, never reads any other env var, never logs, prints, or returns
//     the key, and never includes it (or any request header) in an error.
//   - The key is testnet-only, issued for the hackathon, and may be revoked
//     afterwards (see X402_BUILDER_REPORT.md §8). A revoked key surfaces as
//     `hosted_auth_failed` (HTTP 401) — fail closed, never silent.
//
// Error mapping (transport vs verdict — the distinction the caller relies on):
//   - fetch throws / timeout            -> HostedFacilitatorError('hosted_unreachable')
//   - HTTP 401 or 403 (auth/forbidden)  -> HostedFacilitatorError('hosted_auth_failed')
//   - HTTP 400 (Zod body errors)        -> HostedFacilitatorError('hosted_invalid_payload')
//   - HTTP 404 (route missing at this URL — misconfigured base URL, not a
//     transport failure)                 -> HostedFacilitatorError('hosted_not_found')
//   - HTTP 429 (deliberate hosted refusal under load, NOT a transport
//     failure)                           -> HostedFacilitatorError('hosted_rate_limited')
//   - HTTP 5xx                          -> HostedFacilitatorError('hosted_unavailable')
//   - Any other non-200 status (any unmapped 4xx — 405/408/409/413/418/422… —
//     and any 3xx that surfaces despite fetch following redirects)
//                                          -> HostedFacilitatorError('hosted_unexpected_status')
//   - HTTP 200 with a malformed body    -> HostedFacilitatorError('hosted_bad_response')
//   - HTTP 200 with a well-formed body  -> returned as-is. A verdict of
//     { isValid: false } or { success: false } is NOT an error: it is the
//     facilitator's answer, and the caller must treat it as final — it is
//     never a reason to try another facilitator.
//   Fail-closed codes (never fallback-eligible — see hosted-payonce.mjs):
//     hosted_auth_failed, hosted_invalid_payload, hosted_not_found,
//     hosted_rate_limited, hosted_unexpected_status. Fallback-eligible are
//     ONLY hosted_unreachable, hosted_unavailable, hosted_bad_response.
//     (FIXBACK2, MF-X402-FB-A1: every unmapped 4xx used to land in
//     hosted_bad_response and silently fall back to owner-sponsored
//     self-hosted verify — a deliberate hosted refusal switching the sponsor,
//     the same masking class as round-1 A1/A2. No status now inherits
//     fallback by default; a future status that SHOULD fall back must be
//     mapped explicitly here AND added to FALLBACK_ELIGIBLE_CODES.)
//
// Live behaviour verified 2026-11-25 (see X402_BUILDER_REPORT.md §2, corrected
// in batch-x402/fixback/FIXBACK_REPORT.md §4):
//   - invalid reasons observed: invalid_sender_signature, amount_mismatch,
//     recipient_mismatch, missing_fee_payer, fee_payer_not_managed_by_facilitator,
//     transaction_expired, sponsor_mismatch, asset_type_mismatch, previously_failed
//   - previously_failed: the hosted facilitator remembers a (sender, nonce)
//     pair that FAILED verification here before, and after a delay answers
//     re-submits of that pair with previously_failed — REGARDLESS of whether
//     the sender's on-chain nonce has advanced (proven live: C3 nonce 38,
//     on-chain nonce unchanged 38 -> 38, still previously_failed after a
//     150 s delay and again ~20 min later). Pure staleness does NOT trigger it
//     (a never-attempted ancient nonce returns invalid_sender_signature),
//     and an immediate re-submit does NOT trigger it. So the trigger is
//     (a) prior failed attempt on that (sender, nonce) AND (b) a delay since
//     that attempt — NOT "stale nonce". Consequences: (i) once a pair is
//     poisoned, previously_failed MASKS the real reason for every later
//     payload using that pair — it is "no fresh verdict obtained", never a
//     diagnosis; to learn the underlying reason, probe with a FRESH
//     (sender, nonce) that has never failed; (ii) the sound retry rule is:
//     NEVER re-submit the same (sender, nonce); re-read the on-chain nonce
//     and rebuild ONLY if it has actually advanced — if it has not, stop and
//     wait (the sender must transact on-chain first, or the facilitator's
//     record TTL — still undetermined — must expire). Re-reading a
//     non-advanced nonce and retrying spins on previously_failed forever.
//   - Landing vs persistence are DIFFERENT quantities (FIXBACK2 correction
//     of the fix-back's "seconds to ~2 min" wording, which was ONE
//     observation, not a bound): the record-LANDING delay is variable and
//     unbounded above in the evidence — fresh pairs showed no flip at 185 s
//     nor at ~6–8 min, while other pairs flipped at ~90–150 s — so no
//     "wait and retry the same pair" interval can be relied on. Record
//     PERSISTENCE is now >= ~45 min (C3,38) / >= ~55 min (payee2,46) and
//     counting; the exact TTL remains undetermined (no pair has yet been
//     observed to expire).
//   - the hosted facilitator does NOT check the PayOnce memo or payable
//     binding — that is `binding.mjs` (hosted-payonce.mjs runs it).
export const HOSTED_FACILITATOR_DEFAULT_URL = 'https://x402-facilitator.testnet.concordium.com';
export const HOSTED_TESTNET_CAIP2 = 'ccd:4221332d34e1694168c2a0c0b3fd0f27';

/** Transport/auth failure from the hosted facilitator. `code` is the only thing callers branch on. */
export class HostedFacilitatorError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'HostedFacilitatorError';
    this.code = code;
  }
}

/**
 * Build a hosted facilitator client. `apiKey` is required; there is no
 * default, no fallback key, and no file lookup. `fetchImpl` is injectable
 * for tests (pass a stub; the real key is never used in a test).
 */
export function createHostedFacilitator({ apiKey, baseUrl = HOSTED_FACILITATOR_DEFAULT_URL, fetchImpl = globalThis.fetch, timeoutMs = 30_000 } = {}) {
  if (!apiKey || typeof apiKey !== 'string' || !apiKey.trim()) {
    throw new Error('hosted facilitator: X402_FACILITATOR_API_KEY is required (process env only, never committed)');
  }
  const base = String(baseUrl).replace(/\/+$/, '');

  async function request(method, path, body) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers: { 'Content-Type': 'application/json', 'X-API-Key': apiKey },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (e) {
      // Network/DNS/timeout. The message never contains the key or the body.
      throw new HostedFacilitatorError('hosted_unreachable', `hosted facilitator unreachable (${method} ${path}): ${e.name === 'AbortError' ? 'timeout' : 'network error'}`);
    } finally {
      clearTimeout(timer);
    }
    let text = '';
    try { text = await res.text(); } catch { text = ''; }
    let parsed = null;
    try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
    if (res.status === 401 || res.status === 403) throw new HostedFacilitatorError('hosted_auth_failed', `hosted facilitator rejected the API key (HTTP ${res.status}); check X402_FACILITATOR_API_KEY — it may have been revoked or lack scope`);
    if (res.status === 400) {
      const issues = parsed?.details?.issues?.length ?? 0;
      throw new HostedFacilitatorError('hosted_invalid_payload', `hosted facilitator rejected the request body (HTTP 400${issues ? `, ${issues} validation issue(s)` : ''})`);
    }
    if (res.status === 404) throw new HostedFacilitatorError('hosted_not_found', `hosted facilitator has no such route (HTTP 404 on ${method} ${path}); check X402_FACILITATOR_URL`);
    if (res.status === 429) throw new HostedFacilitatorError('hosted_rate_limited', 'hosted facilitator rate-limited this client (HTTP 429); retry later, do not fall back');
    if (res.status >= 500) throw new HostedFacilitatorError('hosted_unavailable', `hosted facilitator returned HTTP ${res.status}`);
    // FIXBACK2 A1: ANY other non-200 status fails closed. An unmapped 4xx
    // (405/408/409/413/418/422…) is a deliberate hosted refusal, not a
    // transport failure — falling back would silently switch the verify
    // sponsor to the owner. A 3xx surfacing here (fetch normally follows
    // redirects) is likewise not a transport failure. Only 5xx stays
    // fallback-eligible, via hosted_unavailable above.
    if (res.status !== 200) throw new HostedFacilitatorError('hosted_unexpected_status', `hosted facilitator returned unexpected HTTP ${res.status}; failing closed, no fallback`);
    if (res.status !== 200 || parsed === null || typeof parsed !== 'object') {
      throw new HostedFacilitatorError('hosted_bad_response', `hosted facilitator returned unexpected HTTP ${res.status}`);
    }
    return parsed;
  }

  return {
    baseUrl: base,
    network: HOSTED_TESTNET_CAIP2,

    /** GET /health -> { ok: true }. Throws HostedFacilitatorError on transport/auth failure. */
    async health() { return request('GET', '/health'); },

    /** GET /supported -> { kinds, extensions, signers }. */
    async supported() { return request('GET', '/supported'); },

    /**
     * The hosted sponsor/feePayer address for testnet (from /supported).
     * Payloads for the hosted path MUST name this address as sponsor/feePayer —
     * the PayOnce owner address is NOT managed by the hosted facilitator.
     */
    async feePayer() {
      const sup = await this.supported();
      const kind = (sup.kinds ?? []).find((k) => k.network === HOSTED_TESTNET_CAIP2) ?? (sup.kinds ?? [])[0];
      const feePayer = kind?.extra?.feePayer;
      if (typeof feePayer !== 'string' || !feePayer) throw new HostedFacilitatorError('hosted_bad_response', 'hosted /supported returned no feePayer for testnet');
      return feePayer;
    },

    /**
     * POST /verify. Returns the facilitator's verdict as-is
     * ({ isValid, payer, invalidReason?, invalidMessage? }).
     * A verdict of isValid:false is a final answer, not an error.
     */
    async verify(paymentPayload, paymentRequirements) {
      const out = await request('POST', '/verify', { paymentPayload, paymentRequirements });
      if (typeof out.isValid !== 'boolean') throw new HostedFacilitatorError('hosted_bad_response', 'hosted /verify returned no isValid boolean');
      return out;
    },

    /**
     * POST /settle. Returns the facilitator's result as-is
     * ({ success, network, transaction, errorReason?, payer }).
     * success:false with transaction:"" means nothing was submitted.
     */
    async settle(paymentPayload, paymentRequirements) {
      const out = await request('POST', '/settle', { paymentPayload, paymentRequirements });
      if (typeof out.success !== 'boolean') throw new HostedFacilitatorError('hosted_bad_response', 'hosted /settle returned no success boolean');
      return out;
    },
  };
}

/** Build x402 PaymentRequirements for a payable against the HOSTED facilitator. */
export function requirementsForHostedPayable(view, { feePayer, maxTimeoutSeconds = 300 } = {}) {
  if (!feePayer || typeof feePayer !== 'string') throw new Error('requirementsForHostedPayable: feePayer (hosted /supported address) is required');
  return {
    scheme: 'exact',
    network: HOSTED_TESTNET_CAIP2,
    amount: String(view.amount),
    asset: view.asset === 'CCD' ? 'CCD' : view.asset,
    payTo: view.payee,
    maxTimeoutSeconds,
    extra: { feePayer, payableId: view.id },
  };
}
