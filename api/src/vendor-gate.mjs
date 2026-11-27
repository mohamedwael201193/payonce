// PayOnce API - strict vendor-list gate (default ON).
// The buyer's vendor list is the set of on-chain approval rows (buyer, seller). Two layers:
//   1. EUDemo rail: the co-signer decision table refuses an unlisted seller (`no-approval`), and the
//      contract refuses too (-19, reserve_plt always needs an approval row).
//   2. CCD rail: pay_ccd refuses an unlisted seller on chain only when the buyer's on-chain policy is
//      strict (set_strict). That flag is contract state and is NOT flipped by this API. Until it is, this
//      gate makes the API refuse before it signs, so an unlisted seller is not paid through PayOnce.
//      It is an API-side refusal (a policy key we run), not a chain revert, and is labelled that way.
// Set PAYONCE_STRICT_VENDOR_LIST=0 to turn the API gate off (the old behaviour).
import { getVendor, getBuyerPolicy } from './chain-v2.mjs';
import { PAYER_ADDRESS } from './config.mjs';

export const strictVendorListEnabled = (env = process.env) => String(env.PAYONCE_STRICT_VENDOR_LIST ?? '1') !== '0';

/** Pure decision: { allow, code, reason }. `approval` is the on-chain vendor row or null. */
export function vendorGateDecision({ strict, approval, seller }) {
  if (!strict) return { allow: true, code: 'gate-off', reason: 'strict vendor list is off' };
  if (approval) return { allow: true, code: 'listed', reason: 'seller has an on-chain approval row' };
  return {
    allow: false,
    code: 'seller-not-on-vendor-list',
    reason: `seller ${seller} is not on the buyer's vendor list (no on-chain approval row), so the payment is refused before signing`,
  };
}

export async function checkVendorForCcd(c, seller, { buyer = PAYER_ADDRESS, env = process.env } = {}) {
  const strict = strictVendorListEnabled(env);
  if (!strict) return vendorGateDecision({ strict, approval: null, seller });
  const approval = await getVendor(c, buyer, seller);
  return vendorGateDecision({ strict, approval, seller });
}

/** Live read of the buyer's on-chain strict flag, for the trust-model display. null when unreadable. */
export async function onChainStrict(c, buyer = PAYER_ADDRESS) {
  try {
    return (await getBuyerPolicy(c, buyer)).strict;
  } catch {
    return null;
  }
}
