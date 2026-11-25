// Receipt-verdict explanation (fix-back-6 B9/B12) — pure, unit-tested.
//
// The site's own checker flags its latest payment as "blocked": Payable
// 1049 (EUDemo, paid 2026-11-24T23:23:05Z) verifies after_pay as blocked
// 11/14, blocked_reason reservation_precedes_transfer. The transfer itself
// fully re-verifies on chain — registered, agent, registry zero, status
// paid, transfer finalized, one token transfer, EUDemo, from the payer, to
// the stored payee, exact amount, canonical memo — all ok. The ONLY fails
// are the two fail-closed evidence rows:
//   · reservation_precedes_transfer — "no reserve transaction supplied"
//   · paid_at_is_confirm_time — "no confirm transaction supplied"
// The verifier fails those rows when the API host's store holds no
// Reservation/Confirm legs for the payment (api/src/receipts.mjs
// paymentTxsFor falls back to the chain-derived Transfer leg only), so it
// cannot certify the reservation ordering — it does NOT mean the payment
// is invalid. The payment is genuine; the evidence is missing on this
// host. The display must say that, not a bare "blocked".
//
// evidenceGap() detects exactly that shape: verdict blocked, the only
// failing checks are the two evidence rows, the paid-status check is ok,
// and every transfer check is ok. Anything else returns null — a real
// failure stays a plain "blocked" with its reason.
import type { VerifyResponse } from './types'

const EVIDENCE_FAIL_IDS = ['reservation_precedes_transfer', 'paid_at_is_confirm_time'] as const

// The PLT transfer checks that must all pass for the "transfer itself
// re-verifies" claim to be true.
const TRANSFER_CHECK_IDS = [
  'tx_finalized',
  'one_token_transfer',
  'token_eudemo',
  'from_payer',
  'to_payee',
  'amount',
  'memo',
] as const

// Fix-back-7 S1, corrected fix-back-8 MF-3: the note must be accurate
// about WHICH records are missing, not just how many checks fail. Each
// evidence check fails because its own record is not on this host: the
// reservation check fails when the reservation record is missing, the
// confirm check when the confirm record is missing. The old note always
// said "the reservation and confirm records … are not on this API host"
// even when only ONE check failed and the other record EXISTS on the
// host. The single-check case now names only its own record.
const MISSING_RECORD: Record<string, string> = {
  reservation_precedes_transfer: 'the reservation record',
  paid_at_is_confirm_time: 'the confirm record',
}

export function evidenceGapNote(failedIds: string[]): string {
  const named = failedIds.join(' and ')
  const count = failedIds.length === 1 ? `the ${named} check fails closed` : 'those two checks fail closed'
  const missing =
    failedIds.length === 1
      ? `${MISSING_RECORD[failedIds[0]] ?? 'the evidence record'} for this payment is not on this API host`
      : 'the reservation and confirm records for this payment are not on this API host'
  return (
    'Paid on chain — but this host cannot certify the reservation ordering: ' +
    `${missing}, so ${count}. The transfer itself re-verifies: payer, payee, amount and memo all match the chain.`
  )
}

export function evidenceGap(result: VerifyResponse): string | null {
  if (result.verdict !== 'blocked') return null
  const byId = new Map(result.checks.map((c) => [c.id, c]))
  const fails = result.checks.filter((c) => c.status === 'fail')
  if (fails.length === 0) return null
  if (!fails.every((c) => (EVIDENCE_FAIL_IDS as readonly string[]).includes(c.id))) return null
  const paidOk = byId.get('status_paid')?.status === 'ok' || byId.get('status')?.status === 'ok'
  if (!paidOk) return null
  if (!TRANSFER_CHECK_IDS.every((id) => byId.get(id)?.status === 'ok')) return null
  return evidenceGapNote(fails.map((c) => c.id))
}
