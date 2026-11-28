// One source for the fee figure. It is a measured value from the recorded
// run, with its date and source, and every surface reads it from here
// (previously 16.2 and 19.6 both appeared). It is a testnet fee, not a
// mainnet estimate.
import { RECORDED_DATE, RECORDED_FEES } from '../lib/recorded'
import { eurOfCcd } from '../lib/feeEur'

const ccdPay = RECORDED_FEES.find((f) => f.step === 'Pay in CCD' && f.note === 'success')

/** Testnet CCD, rounded to one decimal. */
export const CCD_PAY_FEE = ccdPay ? ccdPay.min.toFixed(1) : null

export const FEE_SOURCE = {
  date: RECORDED_DATE,
  source: 'recorded lab run (lib/recorded.ts, from the run log)',
}

export function ccdPayFeeSentence(): string {
  return CCD_PAY_FEE
    ? `A successful CCD payment cost ${CCD_PAY_FEE} testnet CCD (about ${eurOfCcd(Number(CCD_PAY_FEE))}) in the recorded run of ${formatDay(FEE_SOURCE.date)}. Fees vary per transaction. CCD figures are testnet fees; the euro figure is what that energy costs at Concordium's on-chain price.`
    : 'Fees are testnet fees and vary per transaction.'
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
/** "2026-11-24" or any ISO string to "24 Nov 2026" (UTC). */
export function formatDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${String(d.getUTCDate()).padStart(2, '0')} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`
}

/** "Recorded run, 24 Nov 2026": the date always comes from a timestamp the
    API (or the capture) supplies, never from a literal. */
export function recordedLabel(iso: string | null | undefined): string {
  return iso ? `Recorded run, ${formatDay(iso)}` : 'Recorded run'
}
