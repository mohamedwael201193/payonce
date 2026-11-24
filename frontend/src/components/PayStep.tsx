// Step 3 — Pay (P3 §7.3, §7.4, §7.5) + StepTimeline + RefusalCard.
// Two cards: Rail A (CCD, one transaction) and Rail B (EUDemo, 3 steps).
// After any pay click the button is disabled at once, so a double click
// cannot create a second job (the server also de-duplicates by payable+rail).
import { useEffect, useState } from 'react'
import { Loader2 } from 'lucide-react'
import type { JobSnapshot, PayableFacts } from '../lib/types'
import { COPY } from '../lib/copy'
import { formatCountdown } from '../lib/format'
import { AlertInline, HashLink, LayerBadge, PrimaryButton, SecondaryButton, StepCard } from './ui'

const RAIL_A_STEPS = ['check_status', 'check_agent', 'submit', 'wait_finality', 'read_back', 'verify']
const RAIL_B_STEPS = ['check_wallet', 'reserve', 'co_sign_decide', 'submit_transfer', 'wait_finality', 'confirm', 'verify']

const STEP_LABELS: Record<string, string> = {
  check_status: 'Check status',
  check_agent: 'Check agent',
  submit: 'Submit payment',
  wait_finality: 'Wait for finality',
  read_back: 'Read back from chain',
  verify: 'Verify receipt',
  check_wallet: 'Check wallet',
  reserve: 'Reserve on chain',
  co_sign_decide: 'Co-signer decision',
  submit_transfer: 'Submit transfer',
  confirm: 'Confirm payment',
}

export function StepTimeline({ job, explorerBase }: { job: JobSnapshot; explorerBase: string }) {
  const expected = job.rail === 'ccd' ? RAIL_A_STEPS : RAIL_B_STEPS
  const byId = new Map(job.steps.map((s) => [s.step, s]))
  return (
    <ol className="mt-4 space-y-2" aria-label="Payment steps">
      {expected.map((id) => {
        const s = byId.get(id)
        const status = s?.status ?? 'pending'
        return (
          <li key={id} className="flex items-start gap-3 text-sm">
            <span className="mt-0.5 shrink-0" aria-hidden="true">
              {status === 'ok' ? (
                <span className="inline-block h-4 w-4 rounded-full bg-verified-bg text-center text-[10px] leading-4 text-verified">✓</span>
              ) : status === 'running' || status === 'retrying' ? (
                <Loader2 className="h-4 w-4 animate-spin text-teal-700" />
              ) : status === 'failed' || status === 'refused' ? (
                <span className="inline-block h-4 w-4 rounded-full bg-refused-bg text-center text-[10px] leading-4 text-refused">✕</span>
              ) : (
                <span className="inline-block h-4 w-4 rounded-full border border-line bg-paper" />
              )}
            </span>
            <div className="min-w-0">
              <span className="font-medium text-ink">{STEP_LABELS[id] ?? id}</span>
              {s?.detail ? <span className="text-muted"> — {s.detail}</span> : null}
              {status === 'retrying' ? (
                <span className="block text-muted">Retrying. The public test node is busy.</span>
              ) : null}
              {s?.txHash ? (
                <span className="block">
                  <HashLink hash={s.txHash} explorerBase={explorerBase} />
                </span>
              ) : null}
            </div>
            <span className="ml-auto shrink-0 text-xs text-muted">
              {status === 'ok' ? 'Done' : status === 'running' ? 'Running' : status === 'retrying' ? 'Retrying' : status === 'failed' ? 'Failed' : status === 'refused' ? 'Refused' : 'Waiting'}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

export function RefusalCard({ job, explorerBase }: { job: JobSnapshot; explorerBase: string }) {
  const failed = job.steps.find((s) => s.status === 'refused' || s.status === 'failed')
  const reject = failed?.reject
  const layer = failed?.layer ?? 'chain'
  const fee = (failed as { fee_testnet_ccd?: string } | undefined)?.fee_testnet_ccd
  return (
    <div role="alert" className="mt-4 rounded-md border border-refused bg-refused-bg p-4">
      <div className="flex items-center gap-2">
        <LayerBadge layer={layer} />
        {reject ? (
          <span className="text-sm font-medium text-refused">
            Code {reject.code}, {reject.name}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[15px] text-refused">
        {layer === 'chain'
          ? COPY.chainRefused(reject?.code ?? 0, reject?.name ?? 'Rejected', reject?.plain ?? 'The chain refused this payment.', fee ?? null)
          : layer === 'co_signer'
            ? COPY.coSignerRefused(failed?.detail ?? 'The co-signer refused this transfer.')
            : COPY.appRefused(failed?.detail ?? 'This app refused the payment.')}
      </p>
      {failed?.txHash ? (
        <p className="mt-2 text-sm">
          <HashLink hash={failed.txHash} explorerBase={explorerBase} />
        </p>
      ) : (
        <p className="mt-2 text-sm text-refused">No transaction was sent.</p>
      )}
    </div>
  )
}

export function PayStep({
  facts,
  payState,
  liveJob,
  onPay,
  payDisabled,
  explorerBase,
}: {
  facts: PayableFacts | null
  payState:
    | { kind: 'idle' }
    | { kind: 'running'; job: JobSnapshot }
    | { kind: 'succeeded'; job: JobSnapshot }
    | { kind: 'refused'; job: JobSnapshot }
    | { kind: 'failed'; job: JobSnapshot | null; message: string }
  liveJob: JobSnapshot | null
  onPay: (rail: 'ccd' | 'eudemo') => void
  payDisabled: (rail: 'ccd' | 'eudemo') => string | null
  explorerBase: string
}) {
  const job = liveJob ?? (payState.kind !== 'idle' && payState.kind !== 'failed' ? payState.job : null)
  const done = payState.kind === 'succeeded' || payState.kind === 'refused' || payState.kind === 'failed'
  const reservedUntil =
    facts?.status.kind === 'reserved' ? new Date(facts.status.expires).getTime() : null
  const [countdown, setCountdown] = useState<number | null>(null)
  useEffect(() => {
    if (!reservedUntil) {
      setCountdown(null)
      return
    }
    const tick = () => setCountdown(Math.max(0, Math.floor((reservedUntil - Date.now()) / 1000)))
    tick()
    const t = setInterval(tick, 1000)
    return () => clearInterval(t)
  }, [reservedUntil])

  const ccdReason = payDisabled('ccd')
  const eudReason = payDisabled('eudemo')
  const amount = facts?.amount_display ?? '—'
  // P3 §1: steps 1–3 fit without scrolling at 1440×900. Until an invoice is
  // loaded and the 9 checks pass, this card is a compact summary with the two
  // pay buttons (disabled, with reasons). The full rail cards appear the
  // moment the step becomes actionable, or once a payment exists.
  const actionable = ccdReason === null || eudReason === null
  const showFull = actionable || !!job || done
  const ccdButton = (
    <PrimaryButton
      id="pay-ccd"
      onClick={() => onPay('ccd')}
      disabled={ccdReason !== null || payState.kind === 'running'}
      disabledReason={ccdReason}
    >
      Pay {amount} on chain
    </PrimaryButton>
  )
  const eudButton = (
    <PrimaryButton
      id="pay-eudemo"
      onClick={() => onPay('eudemo')}
      disabled={eudReason !== null || payState.kind === 'running'}
      disabledReason={eudReason}
    >
      Pay {amount} (3 steps)
    </PrimaryButton>
  )

  return (
    <StepCard
      number="03"
      title="Pay once"
      status={payState.kind === 'succeeded' ? 'done' : payState.kind === 'refused' || payState.kind === 'failed' ? 'error' : payState.kind === 'running' ? 'active' : 'idle'}
    >
      {!showFull ? (
        <div>
          <p className="text-sm text-muted">
            Two rails: CCD in one transaction, or EUDemo in three steps (reserve, co-sign, confirm).
          </p>
          <div className="mt-3 grid gap-3 sm:grid-cols-2">
            <div>{ccdButton}</div>
            <div>{eudButton}</div>
          </div>
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-2">
          {/* Rail A */}
          <div className="rounded-md border border-line bg-card p-4">
            <h3 className="text-base font-medium text-ink">Pay in CCD</h3>
            <p className="mt-1 text-sm text-muted">
              The contract checks the invoice and sends the full amount to the payee in the same transaction. It
              keeps no balance.
            </p>
            <p className="mt-2 text-sm text-muted">{COPY.step3RailANote}</p>
            <p className="mt-2 text-xs text-muted">
              This sends a real testnet transaction. Fee in our recorded run: 16.2 testnet CCD.
            </p>
            <div className="mt-4">{ccdButton}</div>
          </div>
          {/* Rail B */}
          <div className="rounded-md border border-line bg-card p-4">
            <h3 className="text-base font-medium text-ink">Pay in EUDemo</h3>
            <p className="mt-1 text-sm text-muted">
              1. The invoice is reserved on chain for 300 seconds. 2. A co-signer approves one transfer of this
              exact amount to this payee, with the invoice number in the memo. 3. The transfer is confirmed
              against this invoice. The chain refuses a second reservation. The co-signer refuses any other
              transfer.
            </p>
            <p className="mt-2 text-sm text-muted">{COPY.step3RailBNote}</p>
            {countdown !== null && countdown > 0 ? (
              <p className="mt-2 text-sm font-medium text-unpaid" aria-live="polite">
                Reserved — {formatCountdown(countdown)} left. Under 60 s the co-signer stops approving.
              </p>
            ) : null}
            <div className="mt-4">{eudButton}</div>
          </div>
        </div>
      )}

      {job ? <StepTimeline job={job} explorerBase={explorerBase} /> : null}
      {payState.kind === 'refused' && payState.job ? (
        <RefusalCard job={payState.job} explorerBase={explorerBase} />
      ) : null}
      {payState.kind === 'failed' ? (
        <AlertInline>
          {payState.message}{' '}
          <SecondaryButton onClick={() => window.location.reload()}>Try again</SecondaryButton>
        </AlertInline>
      ) : null}
      {done || !showFull ? null : (
        <p className="mt-3 text-xs text-muted">
          Watch the recorded run instead? See “Try to break it” — every recorded step is labelled “Recorded run, 24
          Nov 2026”.
        </p>
      )}
    </StepCard>
  )
}
