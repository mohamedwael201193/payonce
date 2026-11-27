// PayOnce API — fee guard (B1 self-healing). Keeps the demo payer (and the
// second seller's account, which pays its own register fees) funded from the
// owner/treasury account. Testnet CCD only.
//   - Refills when an account is below its LOW mark, up to its TARGET, in
//     one plain transfer from the owner (in-process signer, never logged).
//   - Rate limited: at most one refill per MIN_INTERVAL_MS, at most
//     MAX_PER_DAY per rolling 24 h, and never when the owner would fall
//     under OWNER_FLOOR. Single-flight.
//   - Every refill is logged and recorded in the counters (last 50) so
//     /api/health can show it; errors never echo keys (messages are cut and
//     scrubbed of 64-hex strings).
import { AccountAddress, Transaction, Payload, TransactionExpiry, CcdAmount, SequenceNumber } from '@concordium/web-sdk';
import { OWNER_ADDRESS, PAYER_ADDRESS, SELLER2_ADDRESS, ENV, txUrl } from './config.mjs';
import { getAccount, microCcdOf, grpc, nextNonce, signers, waitFinalized } from './chain-v2.mjs';
import { updateCounters, loadCounters } from './store.mjs';

const ccd = (n) => BigInt(Math.round(Number(n) * 1e6));
export const GUARD = {
  payerLow: ccd(ENV.PAYONCE_PAYER_LOW_CCD ?? 300),
  payerTarget: ccd(ENV.PAYONCE_PAYER_TARGET_CCD ?? 1500),
  seller2Low: ccd(ENV.PAYONCE_SELLER2_LOW_CCD ?? 100),
  seller2Target: ccd(ENV.PAYONCE_SELLER2_TARGET_CCD ?? 300),
  ownerFloor: ccd(ENV.PAYONCE_OWNER_FLOOR_CCD ?? 5000),
  minIntervalMs: Number(ENV.PAYONCE_REFILL_MIN_INTERVAL_MS ?? 120_000),
  maxPerDay: Number(ENV.PAYONCE_REFILL_MAX_PER_DAY ?? 12),
  loopMs: Number(ENV.PAYONCE_GUARD_LOOP_MS ?? 60_000),
};
// Below this the pay verifier blocks (amount + fee headroom); kept in one place.
export const FEE_HEADROOM_MICROCCD = 50_000_000n;

const scrub = (e) => String(e?.message ?? e).replace(/\b[0-9a-fA-F]{64}\b/g, '<hex>').slice(0, 200);

let state = { refilling: false, lastCheckAt: null, lastRefillAt: null, lastError: null, lastSkip: null };
let inFlight = null;

async function availableOf(c, address) {
  const info = await getAccount(c, address);
  return BigInt(microCcdOf(info.accountAvailableBalance ?? info.accountAmount));
}

async function transferFromOwner(c, to, amount) {
  const { owner } = await signers();
  const nonce = await nextNonce(c, owner.address);
  const tx = Transaction.transfer(Payload.transfer({
    toAddress: AccountAddress.fromBase58(to), amount: CcdAmount.fromMicroCcd(amount),
  })).addMetadata({
    sender: AccountAddress.fromBase58(owner.address), nonce: SequenceNumber.create(nonce),
    expiry: TransactionExpiry.fromDate(new Date(Date.now() + 10 * 60 * 1000)),
  });
  const finalized = await Transaction.signAndFinalize(tx.build(), owner.signer);
  const hash = await c.sendTransaction(finalized);
  const txHash = (typeof hash === 'string' ? hash : hash.toString()).toLowerCase();
  await waitFinalized(c, txHash);
  return txHash;
}

/** Pure decision, exported for tests. */
export function planRefill({ balances, history, now = Date.now(), cfg = GUARD }) {
  const recent = (history ?? []).filter((h) => now - Date.parse(h.at) < 86_400_000);
  const last = recent.length ? Math.max(...recent.map((h) => Date.parse(h.at))) : 0;
  const wants = [];
  if (balances.payer < cfg.payerLow) wants.push({ role: 'payer', to: PAYER_ADDRESS, amount: cfg.payerTarget - balances.payer });
  if (balances.seller2 != null && balances.seller2 < cfg.seller2Low) wants.push({ role: 'seller2', to: SELLER2_ADDRESS, amount: cfg.seller2Target - balances.seller2 });
  if (!wants.length) return { action: 'none', wants };
  if (now - last < cfg.minIntervalMs) return { action: 'skip', reason: 'rate_limited_interval', wants };
  if (recent.length >= cfg.maxPerDay) return { action: 'skip', reason: 'rate_limited_daily', wants };
  const total = wants.reduce((s, w) => s + w.amount, 0n);
  if (balances.owner - total < cfg.ownerFloor) return { action: 'skip', reason: 'owner_below_floor', wants };
  return { action: 'refill', wants };
}

/** One guard pass (single-flight). Never throws. */
export function ensureFunded({ reason = 'loop' } = {}) {
  if (inFlight) return inFlight;
  inFlight = (async () => {
    try {
      const c = await grpc();
      const [payer, owner, seller2] = await Promise.all([
        availableOf(c, PAYER_ADDRESS), availableOf(c, OWNER_ADDRESS), availableOf(c, SELLER2_ADDRESS).catch(() => null),
      ]);
      state.lastCheckAt = new Date().toISOString();
      const counters = await loadCounters();
      const plan = planRefill({ balances: { payer, owner, seller2 }, history: counters.refills ?? [] });
      state.lastSkip = plan.action === 'skip' ? plan.reason : null;
      if (plan.action === 'skip') console.warn(`[guard] refill needed but skipped (${plan.reason})`);
      if (plan.action !== 'refill') return plan;
      state.refilling = true;
      for (const w of plan.wants) {
        const txHash = await transferFromOwner(c, w.to, w.amount);
        const entry = { at: new Date().toISOString(), role: w.role, amount_micro_ccd: w.amount.toString(), tx_hash: txHash, reason };
        await updateCounters((cn) => { cn.refills = [...(cn.refills ?? []), entry].slice(-50); });
        state.lastRefillAt = entry.at;
        state.lastError = null;
        console.log(`[guard] refilled ${w.role} +${Number(w.amount) / 1e6} CCD tx ${txHash.slice(0, 10)}…`);
      }
      return plan;
    } catch (e) {
      state.lastError = scrub(e);
      console.error('[guard] refill failed:', state.lastError);
      return { action: 'error' };
    } finally {
      state.refilling = false;
      inFlight = null;
    }
  })();
  return inFlight;
}

let loopStarted = false;
export function startGuardLoop() {
  if (loopStarted || process.env.PAYONCE_GUARD === 'off') return;
  loopStarted = true;
  const tick = async () => {
    try { await ensureFunded({ reason: 'loop' }); } catch { /* never throws */ }
    setTimeout(tick, GUARD.loopMs).unref?.();
  };
  setTimeout(tick, 5_000).unref?.();
}

/** Health field: no balances beyond status words, tx hashes are public. */
export async function guardHealth() {
  const counters = await loadCounters().catch(() => ({}));
  const refills = counters.refills ?? [];
  const day = refills.filter((h) => Date.now() - Date.parse(h.at) < 86_400_000);
  const last = refills[refills.length - 1] ?? null;
  return {
    enabled: process.env.PAYONCE_GUARD !== 'off',
    refilling: state.refilling,
    last_check_at: state.lastCheckAt,
    last_refill_at: last?.at ?? state.lastRefillAt,
    last_refill_tx: last?.tx_hash ?? null,
    last_refill_explorer_url: last ? txUrl(last.tx_hash) : null,
    refills_24h: day.length,
    max_per_day: GUARD.maxPerDay,
    skipped: state.lastSkip,
    last_error: state.lastError,
  };
}
export const __guardStateForTests = () => state;
