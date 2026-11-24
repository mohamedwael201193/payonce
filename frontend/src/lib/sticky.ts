// Sticky bottom bar action (P3 §12, mobile only) — pure derivation so it can
// be unit-tested. The bar carries the current primary action only:
// "Check invoice", then "Pay in CCD" / "Pay in EUDemo" (with the amount),
// then "Check again on chain" once a receipt exists.
import { isCheckFresh, type FlowState } from './flow'
import type { PayableFacts } from './types'

export type StickyAction =
  | { kind: 'check'; label: 'Check invoice'; disabledReason: string | null }
  | { kind: 'pay'; label: string; rail: 'ccd' | 'eudemo'; disabledReason: string | null }
  | { kind: 'check-again'; label: 'Check again on chain'; disabledReason: null }
  | { kind: 'busy'; label: string; disabledReason: string }

export function stickyActionFor(
  state: FlowState,
  facts: PayableFacts | null,
  hasReceipt: boolean,
  payDisabled: (rail: 'ccd' | 'eudemo') => string | null,
): StickyAction {
  if (hasReceipt) {
    return { kind: 'check-again', label: 'Check again on chain', disabledReason: null }
  }
  if (state.pay.kind === 'running') {
    return { kind: 'busy', label: 'Payment running…', disabledReason: 'A payment is already running.' }
  }
  if (state.check.kind === 'running') {
    return { kind: 'busy', label: 'Checking…', disabledReason: 'The check is running.' }
  }
  if (state.check.kind === 'ready' && isCheckFresh(state) && facts && facts.status.kind === 'unpaid') {
    const rail = facts.asset.kind === 'ccd' ? 'ccd' : 'eudemo'
    return {
      kind: 'pay',
      label: `Pay in ${rail === 'ccd' ? 'CCD' : 'EUDemo'} (${facts.amount_display})`,
      rail,
      disabledReason: payDisabled(rail),
    }
  }
  return {
    kind: 'check',
    label: 'Check invoice',
    disabledReason: !facts ? 'Load an invoice first (step 1).' : null,
  }
}
