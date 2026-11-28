import { FEE_EUR_SOURCE } from '../lib/feeEur'

/** "How is this computed?" under any euro fee: the rate, its date and where it comes from. */
export function FeeEurSource() {
  return (
    <details className="fee-src">
      <summary>How is the euro figure computed?</summary>
      <p>{FEE_EUR_SOURCE}</p>
    </details>
  )
}
