// Step 4 — Receipt (P3 §7.6). Paid facts, transaction list, verifier result.
// "Check again on chain" re-runs the after-pay verifier. "Copy verifier
// command" copies the keyless verifier command for the judge to run alone.
import { useEffect, useRef, useState } from 'react'
import { useConfig } from '../hooks/useApi'
import { api } from '../lib/api'
import type { Receipt } from '../lib/types'
import { COPY } from '../lib/copy'
import { formatUtcTime } from '../lib/format'
import { AlertInline, CopyButton, HashLink, SecondaryButton, StepCard } from './ui'

export function ReceiptCard({
  receipt,
  explorerBase,
  reverifySignal = 0,
}: {
  receipt: Receipt
  explorerBase: string
  /** Increment to re-run the after-pay verifier (drives the sticky bar). */
  reverifySignal?: number
}) {
  const config = useConfig()
  const [verifying, setVerifying] = useState(false)
  const [verifyResult, setVerifyResult] = useState<{ passed: number; total: number; checked_at: string } | null>(
    receipt.verifier,
  )
  const [verifyError, setVerifyError] = useState<string | null>(null)

  const reverify = async () => {
    setVerifying(true)
    setVerifyError(null)
    try {
      const res = await api.verify(receipt.payable_id, 'after_pay')
      setVerifyResult({ passed: res.passed, total: res.total, checked_at: res.checked_at })
    } catch {
      setVerifyError('The verifier could not finish. The transaction links above are still correct. Check again.')
    } finally {
      setVerifying(false)
    }
  }

  // The sticky bottom bar (P3 §12) re-runs the verifier through this signal.
  const firstSignal = useRef(true)
  useEffect(() => {
    if (firstSignal.current) {
      firstSignal.current = false
      return
    }
    if (reverifySignal > 0) void reverify()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reverifySignal])

  const verifierCmd = `node verify-payable.mjs ${receipt.payable_id} ${
    receipt.txs.find((t) => t.label.toLowerCase().includes('transfer') || t.label.toLowerCase().includes('payment'))
      ?.tx_hash ?? receipt.txs[0]?.tx_hash ?? ''
  }`

  return (
    <div>
      <h3 className="text-lg font-medium text-ink">Paid once.</h3>
      <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
        <div>
          <dt className="text-muted">Payable</dt>
          <dd className="font-medium text-ink">{receipt.payable_id}</dd>
        </div>
        <div>
          <dt className="text-muted">Amount</dt>
          <dd className="font-medium text-ink">{receipt.amount_display}</dd>
        </div>
        <div>
          <dt className="text-muted">Payee (from the chain)</dt>
          <dd className="font-mono text-xs text-ink break-all">{receipt.payee}</dd>
        </div>
        <div>
          <dt className="text-muted">Paid from</dt>
          <dd className="text-ink">{receipt.payer_label}</dd>
        </div>
      </dl>
      <div className="mt-4">
        <h4 className="text-sm font-medium text-ink">Transactions</h4>
        <ul className="mt-1 space-y-1">
          {receipt.txs.map((t) => (
            <li key={t.tx_hash} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-muted">{t.label}:</span>
              <HashLink hash={t.tx_hash} explorerBase={explorerBase} />
            </li>
          ))}
        </ul>
        {receipt.payment_tx_source === 'server_store' ? (
          <p className="mt-2 text-xs text-muted">
            Payment hash source: our receipt store. The payment hash is not stored on chain for CCD payments. Check the
            payee’s history on the explorer to confirm.
          </p>
        ) : null}
      </div>
      <div className="mt-4">
        {verifyResult ? (
          <p className="text-sm text-ink" aria-live="polite">
            {COPY.verifierLine(verifyResult.passed, verifyResult.total, formatUtcTime(verifyResult.checked_at))}
          </p>
        ) : (
          <p className="text-sm text-muted">Verifier has not run on this receipt yet.</p>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          <SecondaryButton onClick={() => void reverify()} disabled={verifying}>
            {verifying ? 'Re-reading the chain…' : 'Check again on chain'}
          </SecondaryButton>
          <CopyButton value={verifierCmd} label="verifier command" />
        </div>
        {verifyError ? <AlertInline>{verifyError}</AlertInline> : null}
      </div>
      <p className="mt-4 border-t border-line pt-3 text-xs text-muted">{COPY.receiptFooter}</p>
      {config.data ? (
        <p className="mt-1 text-xs text-muted">
          Registry &lt;{config.data.registry.index},{config.data.registry.subindex}&gt; · Verifier{' '}
          {config.data.verifier.file} ({config.data.verifier.version_date})
        </p>
      ) : null}
    </div>
  )
}

export function ReceiptStep({
  receipt,
  explorerBase,
  reverifySignal = 0,
}: {
  receipt: Receipt | null
  explorerBase: string
  reverifySignal?: number
}) {
  return (
    <StepCard
      number="04"
      title="Receipt"
      status={receipt ? 'done' : 'idle'}
    >
      {receipt ? (
        <ReceiptCard receipt={receipt} explorerBase={explorerBase} reverifySignal={reverifySignal} />
      ) : (
        <p className="text-[15px] text-muted">
          Your receipt appears here after a payment. Nothing is paid until you press a pay button.
        </p>
      )}
    </StepCard>
  )
}
