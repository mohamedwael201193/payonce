// Step 4 — Receipt (P3 §7.6). Paid facts, transaction list, verifier result.
// (Fix-back-12: rendered in the dashboard pay tabs now, not on the landing.)
// "Check again on chain" re-runs the after-pay verifier. "Copy verifier
// command" copies the keyless verifier command for the judge to run alone.
// B-5 (round-5 fix-back): the copied command threads the receipt's rail.
// It used to be the bare `node verify-payable.mjs <id> <tx>` — no --rail,
// so the v1 CLI defaulted to the CCD rail and ran verifyCcd on an EUDemo
// receipt's Transfer leg (CCD-02/CCD-03 fail, exit 1) even though the
// receipt itself says "Paid once". The command now carries --rail, and for
// EUDemo (CLI rail plt) the reservation/confirm txs from the receipt's own
// tx list (--reserve-tx is required by the CLI: PLT-13 fails closed
// without it; --confirm-tx is optional, PLT-12 skips without it). This
// corrects the round-4 commit's N4 assertion that the bare copied command
// was correct for every receipt — it was not, for EUDemo receipts.
import { useEffect, useRef, useState } from 'react'
import { useConfig } from '../hooks/useApi'
import { api } from '../lib/api'
import type { Receipt } from '../lib/types'
import { COPY } from '../lib/copy'
import { formatUtcTime } from '../lib/format'
import { AlertInline, CopyButton, HashLink, SecondaryButton, StepCard } from './ui'

/** The copied keyless verifier command for a receipt (v1 CLI,
 *  backend/src/verifier/verify-payable.mjs):
 *  `node verify-payable.mjs <payable-id> <tx-hash> [--rail ccd|plt]
 *  [--reserve-tx <hash>] [--confirm-tx <hash>]`. The positional tx is
 *  the payment leg — Transfer for EUDemo, Payment for CCD. The rail
 *  comes from the parent's loaded payable asset kind; without it, the
 *  tx labels decide — an EUDemo receipt always lists a Transfer leg
 *  (plus Reservation/Confirm), a CCD receipt lists only a Payment leg —
 *  so a bare render (e.g. the standalone receipt page before its
 *  payable loads) still copies the right rail. */
export function buildVerifierCommand(receipt: Receipt, asset?: 'ccd' | 'eudemo'): string {
  const txByLabel = (needle: string) =>
    receipt.txs.find((t) => t.label.toLowerCase().includes(needle))
  const paymentTx = txByLabel('transfer') ?? txByLabel('payment')
  const isPlt =
    asset !== undefined ? asset === 'eudemo' : paymentTx?.label.toLowerCase().includes('transfer') ?? false
  const txHash = paymentTx?.tx_hash ?? receipt.txs[0]?.tx_hash ?? ''
  let cmd = `node verify-payable.mjs ${receipt.payable_id} ${txHash} --rail ${isPlt ? 'plt' : 'ccd'}`
  if (isPlt) {
    const reserveTx = txByLabel('reserv')
    const confirmTx = txByLabel('confirm')
    if (reserveTx) cmd += ` --reserve-tx ${reserveTx.tx_hash}`
    if (confirmTx) cmd += ` --confirm-tx ${confirmTx.tx_hash}`
  }
  return cmd
}

export function ReceiptCard({
  receipt,
  explorerBase,
  reverifySignal = 0,
  asset,
}: {
  receipt: Receipt
  explorerBase: string
  /** Increment to re-run the after-pay verifier (drives the sticky bar). */
  reverifySignal?: number
  /** The loaded payable's asset kind — threads the rail into the copied
   *  verifier command (B-5). Falls back to the receipt's tx labels. */
  asset?: 'ccd' | 'eudemo'
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
      // F-2 sweep: a receipt carries its seller (Receipt.seller) — re-verify
      // that seller's payable, never the server's seller-1 default, or a
      // seller-2 receipt re-verifies against seller 1's same-id payable.
      const res = await api.verify(receipt.payable_id, 'after_pay', undefined, receipt.seller)
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

  const verifierCmd = buildVerifierCommand(receipt, asset)

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
  asset,
}: {
  receipt: Receipt | null
  explorerBase: string
  reverifySignal?: number
  /** The loaded payable's asset kind — threads the rail into the copied
   *  verifier command (B-5). */
  asset?: 'ccd' | 'eudemo'
}) {
  return (
    <StepCard
      number="04"
      title="Receipt"
      status={receipt ? 'done' : 'idle'}
    >
      {receipt ? (
        <ReceiptCard receipt={receipt} explorerBase={explorerBase} reverifySignal={reverifySignal} asset={asset} />
      ) : (
        <p className="text-[15px] text-muted">
          Your receipt appears here after a payment. Nothing is paid until you press a pay button.
        </p>
      )}
    </StepCard>
  )
}
