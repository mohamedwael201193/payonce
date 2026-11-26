// Step 4 — Receipt (P3 §7.6). Paid facts, transaction list, verifier result.
// (Fix-back-12: rendered in the dashboard pay tabs now, not on the landing.)
// "Check again on chain" re-runs the after-pay verifier. "Copy verifier
// command" copies the keyless verifier command for the judge to run alone.
// B-5 (round-5 fix-back): the copied command threads the receipt's rail.
// It used to be the bare `node verify-payable.mjs <id> <tx>` — no --rail,
// so the v1 CLI defaulted to the CCD rail and ran verifyCcd on an EUDemo
// receipt's Transfer leg (CCD-03 fails — no pay_ccd Updated event on a
// transfer leg — exit 1) even though the receipt itself says "Paid once".
// (CCD-02 is not the failing gate: it tests the tx type against /update/i
// and a CIS-2 transfer invocation IS an update, so it passes.) The
// command now carries --rail, and for EUDemo (CLI rail plt) the
// reservation/confirm txs from the receipt's own tx list (--reserve-tx is
// required by the CLI: PLT-13 fails closed without it; --confirm-tx is
// optional, PLT-12 skips without it).
// B-5 (round-6 fix-back): the rail is derived from the RECEIPT's own tx
// labels, never from the parent's loaded payable — the receipt is
// component state set only on pay success, and a new pick used to leave
// it on screen under the new payable's asset kind, so the copied command
// ran the wrong rail. The parent now also clears the receipt on every
// new load (PayFlowTabs loadFacts) and the step below refuses a receipt
// whose payable does not match the loaded one; the rail derivation here
// is the last layer, so even a stale receipt still copies the command
// for ITS OWN rail (pay EUDemo 11, pick CCD 10, copy → --rail plt).
// H-R7 (round-7 fix-back): the round-6 disclosure for a Transfer-only
// EUDemo receipt was wrong about the copied command — it said the
// command "fails PLT-13", but executing the exact copied command for
// receipt 2001 throws an uncaught 'payable view is None (byte 0 = 0)'
// (backend/src/registry.mjs:47), exit 1, zero check lines: with no
// --reserve-tx/--confirm-tx the verifier reads the v1 registry
// <13149,0>, where 2001 does not exist, so the PLT-13 guard the
// comments describe never fires. The same shape on payable 11 runs
// against the wrong (v1) payable-11 view and fails 4 of 13 (PLT-07,
// PLT-08, PLT-13, PLT-11), three of them wrong-registry artifacts;
// with --reserve-tx and --confirm-tx the same command passes 14/14.
// The card therefore offers NO copy button for a Transfer-only receipt
// and says so plainly, instead of handing over a command that crashes
// or checks the wrong payable. The Judges page's 2001 paragraph says
// the same, with the same verified numbers.
// Attribution (round-6 N-2): round-4's N4 was about seller-decoding in
// the v1 CLI — it decodes the seller from the tx's 40-byte
// PayableKeyParam and throws rather than defaulting to seller 1 — not a
// claim that the bare copied command was correct for every receipt. The
// rail gap was unexamined in round 4, not asserted; round 5 found it.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useConfig } from '../hooks/useApi'
import { api } from '../lib/api'
import type { Receipt } from '../lib/types'
import { COPY } from '../lib/copy'
import { formatUtcTime } from '../lib/format'
import { AlertInline, CopyButton, HashLink, SecondaryButton, StepCard } from './ui'

/** The rail of a receipt, from the receipt's own tx labels first. A
 *  Transfer leg is the EUDemo payment leg; a Payment leg is the CCD one.
 *  The parent's asset kind is only the fallback for a receipt with
 *  neither label — it must never override the receipt, or a receipt left
 *  on screen under a newly picked payable copies the wrong rail (B-5
 *  round-6: pay EUDemo 11, pick CCD 10, copy → --rail plt, from the
 *  receipt, not --rail ccd from the new facts; and the reverse).
 *  The label fallback is a heuristic, not a guarantee (round-6 N-1): a
 *  Payment-labelled EUDemo leg is a shape the backend's own
 *  defense-in-depth accepts (receipts.mjs buildReceiptFor), and the old
 *  seller-2 shape was one too — the current live shape lists a Transfer
 *  leg for EUDemo, but no label rule can promise it for every receipt. */
export function receiptRail(receipt: Receipt, asset?: 'ccd' | 'eudemo'): 'plt' | 'ccd' {
  const labels = receipt.txs.map((t) => t.label.toLowerCase())
  if (labels.some((l) => l.includes('transfer'))) return 'plt'
  if (labels.some((l) => l.includes('payment'))) return 'ccd'
  return asset === 'eudemo' ? 'plt' : 'ccd'
}

/** The copied keyless verifier command for a receipt (v1 CLI,
 *  backend/src/verifier/verify-payable.mjs — run from the repo root,
 *  after `cd backend && npm install`; the script imports the backend
 *  modules beside it, so the bare filename alone cannot run):
 *  `node backend/src/verifier/verify-payable.mjs <payable-id> <tx-hash>
 *  [--rail ccd|plt] [--reserve-tx <hash>] [--confirm-tx <hash>]`. The
 *  positional tx is the payment leg — Transfer for EUDemo, Payment for
 *  CCD. The rail comes from the receipt itself (receiptRail above). */
export function buildVerifierCommand(receipt: Receipt, asset?: 'ccd' | 'eudemo'): string {
  const txByLabel = (needle: string) =>
    receipt.txs.find((t) => t.label.toLowerCase().includes(needle))
  const paymentTx = txByLabel('transfer') ?? txByLabel('payment')
  const isPlt = receiptRail(receipt, asset) === 'plt'
  const txHash = paymentTx?.tx_hash ?? receipt.txs[0]?.tx_hash ?? ''
  let cmd = `node backend/src/verifier/verify-payable.mjs ${receipt.payable_id} ${txHash} --rail ${isPlt ? 'plt' : 'ccd'}`
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
  // H-R7 (round-7 fix-back): a Transfer-only EUDemo receipt has no
  // reservation leg to pass, so NO verifier command is offered for it
  // at all — the round-6 note said the copied command "fails PLT-13",
  // but the exact copied command for receipt 2001 crashes before any
  // check runs (uncaught 'payable view is None', exit 1: no
  // --reserve-tx means the verifier reads the v1 registry, where 2001
  // does not exist), and for an id that does exist in v1 it checks the
  // wrong payable. The card below renders the explanation instead of
  // the copy button. (Live receipt 2001 has exactly this shape:
  // Transfer only.)
  const missingReserve =
    receiptRail(receipt, asset) === 'plt' &&
    !receipt.txs.some((t) => t.label.toLowerCase().includes('reserv'))

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
          {/* H-R7: no copy button for a Transfer-only receipt — the
              command it would copy cannot re-verify this receipt (see
              missingReserve above); the explanation below says why. */}
          {missingReserve ? null : <CopyButton value={verifierCmd} label="verifier command" />}
        </div>
        {missingReserve ? (
          <p className="mt-2 text-xs text-muted" role="note">
            No verifier command is offered for this receipt: it lists no reservation transaction, so the command
            would have no --reserve-tx — and without one the verifier reads the v1 registry view instead of this
            receipt&apos;s registry. For receipt 2001 that view holds no such payable, so the command crashes
            (&apos;payable view is None&apos;, exit 1) before any check runs; for an id that does exist in v1 it
            would check the wrong payable.
          </p>
        ) : (
          /* H-3 (round-6): one line of run instructions, matching the
             Judges page's v2 standard (cd + npm install). The copied
             command carries the repo-relative path; it runs from the repo
             root only after the backend deps are installed. */
          <p className="mt-2 text-xs text-muted">
            Run from the repo root, after <code className="font-mono text-ink">cd backend &amp;&amp; npm install</code>.
          </p>
        )}
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
  forPayableId,
  forSeller,
  forPaid,
  jobPayableId,
  jobSeller,
}: {
  receipt: Receipt | null
  explorerBase: string
  reverifySignal?: number
  /** The loaded payable's asset kind — only the fallback for a receipt
   *  with no recognizable payment leg (B-5 round-6: the rail comes from
   *  the receipt itself). */
  asset?: 'ccd' | 'eudemo'
  /** The payable the tab is showing. A receipt for any other payable is
   *  stale (B-5 round-6: a pay that lands after the user picked another
   *  payable, or any path that sets a receipt without a new load) — it
   *  is never rendered with a copy button, so no stale command can be
   *  copied. Only compared when both sides name a seller. */
  forPayableId?: number
  forSeller?: string
  /** N-R7-1 (round-7): the loaded payable is already Paid on chain.
   *  With no receipt in this tab (e.g. after a reload — the receipt is
   *  component state, never re-fetched on mount), the empty copy must
   *  not claim nothing is paid: the step links to the receipt page
   *  instead. */
  forPaid?: boolean
  /** B-5-R7 (round-7): the pay captured at initiation — the (payable,
   *  seller) the user actually paid. A receipt that mismatches the job
   *  pair is never the payment just made, even if it happens to match
   *  the loaded facts. Only compared when both sides name a seller. */
  jobPayableId?: number
  jobSeller?: string
}) {
  // B-5 (round-6): the parent clears the receipt on every new load, so
  // this branch is the backstop for the one path that can still strand a
  // receipt — a pay job that succeeds after the user picked another
  // payable. The stale receipt is named, never rendered as the current
  // one, and the copy button is withheld with it.
  // B-5-R7 (round-7): the gate also compares against the job pair —
  // the fetch already uses the job's seller, so a receipt that
  // mismatches the job pair is never the payment just made. (The
  // round-6 gate alone was defeated by the fetch itself: it fetched
  // with the CURRENT facts' seller, so a same-id seller-2 receipt
  // passed the gate by construction.)
  const factsMismatch =
    receipt !== null &&
    forPayableId !== undefined &&
    (receipt.payable_id !== forPayableId ||
      (receipt.seller !== undefined && forSeller !== undefined && receipt.seller !== forSeller))
  const jobMismatch =
    receipt !== null &&
    jobPayableId !== undefined &&
    (receipt.payable_id !== jobPayableId ||
      (receipt.seller !== undefined && jobSeller !== undefined && receipt.seller !== jobSeller))
  const stale = factsMismatch || jobMismatch
  // The stale notice names the seller when the ids match but the
  // sellers differ (B-5-R7 twin: seller 1's payable 1 vs seller 2's
  // payable 1) — "for payable 1, you picked payable 1" would say
  // nothing. Otherwise it names the ids.
  const staleText =
    receipt !== null &&
    receipt.payable_id === forPayableId &&
    receipt.seller !== undefined &&
    forSeller !== undefined &&
    receipt.seller !== forSeller
      ? `This receipt is for seller ${receipt.seller.slice(0, 8)}…’s payable ${receipt.payable_id} — the payable you picked belongs to a different seller (seller ${forSeller.slice(0, 8)}…). Its receipt appears here after a payment.`
      : receipt !== null && receipt.payable_id !== jobPayableId && jobPayableId !== undefined && !factsMismatch
        ? `This receipt is for payable ${receipt.payable_id} — it is not the payment just made (you paid payable ${jobPayableId}). Its receipt appears here after a payment.`
        : `This receipt is for payable ${receipt?.payable_id} — you picked payable ${forPayableId}. Its receipt appears here after a payment.`
  return (
    <StepCard
      number="04"
      title="Receipt"
      status={receipt && !stale ? 'done' : 'idle'}
    >
      {receipt && stale ? (
        <p className="text-[15px] text-muted">{staleText}</p>
      ) : receipt ? (
        <ReceiptCard receipt={receipt} explorerBase={explorerBase} reverifySignal={reverifySignal} asset={asset} />
      ) : forPaid && forPayableId !== undefined ? (
        // N-R7-1: the loaded payable is already Paid, but this tab holds
        // no receipt (after a reload the receipt is gone — it is
        // component state, never re-fetched on mount). Link to the
        // receipt page instead of claiming nothing is paid.
        <p className="text-[15px] text-muted">
          This payable is already paid — its receipt lives on the receipt page, not in this tab.{' '}
          <Link
            to={`/receipt/${forPayableId}${forSeller ? `?seller=${encodeURIComponent(forSeller)}` : ''}`}
            className="font-medium text-brand-700"
          >
            Receipt for payable {forPayableId} →
          </Link>
        </p>
      ) : (
        <p className="text-[15px] text-muted">
          Your receipt appears here after a payment. Nothing is paid until you press a pay button.
        </p>
      )}
    </StepCard>
  )
}
