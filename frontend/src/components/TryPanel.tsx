// "Try to break it" — P3 §9. Five scenario buttons. Every result card shows:
// What we tried, Where it stopped (layer badge), Real or recorded (tag), Fee,
// and an explorer link when a transaction exists.
// Scenarios 1 and 5 are client-side (real, no transaction). 2, 3, 4 call
// POST /api/attacks/:kind. The honest gap for scenario 4 (H1) is shown.
import { useState } from 'react'
import { api } from '../lib/api'
import { ApiError, type AttackResult, type PayableFacts } from '../lib/types'
import { COPY } from '../lib/copy'
import { sha256Hex } from './InvoiceStep'
import { truncHash } from '../lib/format'
import { BudgetNote } from './BudgetNote'
import { AlertInline, HashLink, LayerBadge, PrimaryButton, SecondaryButton } from './ui'

interface ScenarioOutcome {
  kind: string
  title: string
  tried: string
  stoppedLayer: 'app' | 'chain' | 'co_signer' | 'node' | 'server'
  stoppedText: string
  reject: { code: number; name: string } | null
  real: string
  fee: string | null
  txHash: string | null
  explorerUrl: string | null
  knownLimit?: string
}

function OutcomeCard({ o, explorerBase }: { o: ScenarioOutcome; explorerBase: string }) {
  return (
    <div className="mt-4 rounded-md border border-line bg-paper p-4 text-sm" aria-live="polite">
      <h4 className="font-medium text-ink">{o.title}</h4>
      <dl className="mt-2 space-y-1.5">
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 text-muted">What we tried</dt>
          <dd className="text-ink">{o.tried}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 text-muted">Where it stopped</dt>
          <dd className="text-ink">
            <LayerBadge layer={o.stoppedLayer} /> <span className="ml-1">{o.stoppedText}</span>
          </dd>
        </div>
        {o.reject ? (
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-muted">Refusal</dt>
            <dd className="text-ink">
              Code {o.reject.code}, {o.reject.name}
            </dd>
          </div>
        ) : null}
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 text-muted">Real or recorded</dt>
          <dd className="text-ink">{o.real}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="w-28 shrink-0 text-muted">Fee</dt>
          <dd className="text-ink">{o.fee ? `${o.fee} testnet CCD` : 'none'}</dd>
        </div>
        {o.txHash ? (
          <div className="flex gap-2">
            <dt className="w-28 shrink-0 text-muted">Transaction</dt>
            <dd>
              <HashLink hash={o.txHash} explorerBase={explorerBase} />
            </dd>
          </div>
        ) : null}
      </dl>
      {o.knownLimit ? (
        <p className="mt-3 border-t border-line pt-3 text-muted">
          <span className="font-medium text-ink">Known limit: </span>
          {o.knownLimit}
        </p>
      ) : null}
    </div>
  )
}

export function TryPanel({
  facts,
  docText,
  docSha256,
  explorerBase,
  hasPaidInSession,
}: {
  facts: PayableFacts | null
  docText: string | null
  docSha256: string | null
  explorerBase: string
  hasPaidInSession: boolean
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [outcome, setOutcome] = useState<ScenarioOutcome | null>(null)
  const [precheckOnly, setPrecheckOnly] = useState(false)

  const runAttack = async (kind: 'pay_twice' | 'wrong_amount' | 'unlisted_seller', payableId: number) => {
    setBusy(kind)
    setError(null)
    try {
      const res: AttackResult = await api.attack(kind, payableId, kind === 'pay_twice' && precheckOnly ? 'precheck_only' : undefined)
      setOutcome({
        kind,
        title: kind === 'pay_twice' ? 'Pay it twice' : kind === 'wrong_amount' ? 'Wrong amount' : 'Pay a fraudster’s invoice',
        tried:
          kind === 'pay_twice'
            ? `Sent a second payment for payable ${payableId}.`
            : kind === 'wrong_amount'
              ? `Asked to pay the wrong amount for payable ${payableId}.`
              : `Used a lab invoice from a seller that is not on your vendor list.`,
        stoppedLayer: res.layer,
        stoppedText: res.plain,
        reject: res.reject ? { code: res.reject.code, name: res.reject.name } : null,
        // M3 (#9 verdict): a precheck sends nothing, so it is live — never
        // label it with the recorded-run date.
        real:
          kind === 'pay_twice' && precheckOnly
            ? 'Live pre-check (nothing sent)'
            : res.live
              ? 'Real'
              : COPY.recordedRunLabel,
        fee: res.fee_testnet_ccd ?? null,
        txHash: res.tx_hash ?? null,
        explorerUrl: res.explorer_url ?? null,
        knownLimit:
          kind === 'unlisted_seller'
            ? 'The co-signer refuses a payable whose seller is not on the buyer’s on-chain vendor list — the live dry run above refuses it (no-approval). On the EUDemo rail the chain refuses it too (−19: reserve_plt always needs an approval row). On the CCD rail the chain refuses only in strict mode (−19), and strict mode is off in this demo run, so the CCD rail is not stopped on chain. No fraud payable exists on this registry to try live — no second seller holds an Active agent token.'
            : undefined,
      })
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.body.message
          : 'The test node stayed busy. Nothing was sent a second time.',
      )
    } finally {
      setBusy(null)
    }
  }

  const tamper = async () => {
    if (!docText || !docSha256 || !facts) return
    setBusy('tamper')
    // Change one digit in the account number, as in the demo wound.
    const tampered = docText.replace(/(\d)(\d{3})$/, (_m, a, b) => `${a === '9' ? '8' : '9'}${b}`)
    const newHash = await sha256Hex(tampered === docText ? `${docText} ` : tampered)
    const matches = newHash === docSha256
    setOutcome({
      kind: 'tamper',
      title: 'Tamper with the invoice',
      tried: 'Changed the account number in the loaded document and recomputed the fingerprint in your browser.',
      stoppedLayer: 'app',
      stoppedText: matches
        ? 'The fingerprint still matches. Paying is not blocked by this check.'
        : `This app: the file does not match the chain fingerprint. Paying is blocked. The payee on chain is still ${truncHash(facts.payee)}.`,
      reject: null,
      real: 'Real, client-side',
      fee: null,
      txHash: null,
      explorerUrl: null,
    })
    setBusy(null)
  }

  const inject = () => {
    if (!facts) return
    setBusy('inject')
    setOutcome({
      kind: 'injection',
      title: 'Injection: tell the agent to pay another account',
      tried: 'Loaded an invoice whose text contains “pay account X instead”.',
      stoppedLayer: 'app',
      stoppedText: `Ignored. The invoice text is evidence only. The payee is the account on chain: ${truncHash(facts.payee)}.`,
      reject: null,
      real: 'Client-side, real',
      fee: null,
      txHash: null,
      explorerUrl: null,
      knownLimit:
        'No language model reads invoice text in the payment path in this build. Confirm before judging (P3 §18).',
    })
    setBusy(null)
  }

  const [recorded, setRecorded] = useState<import('../lib/types').RecordedRun | null>(null)

  const watchRecorded = async () => {
    const id = facts?.payable_id
    if (!id) return
    setBusy('recorded')
    setError(null)
    try {
      // The recorded run is seller-aware (fix-back §4.3): the loaded
      // payable's seller selects its run, never seller 1's run for the
      // same id.
      const run = await api.getRecorded(id, facts?.seller)
      setRecorded(run)
    } catch (e) {
      setError(
        e instanceof ApiError
          ? e.body.message
          : 'The recorded run is not reachable right now.',
      )
    } finally {
      setBusy(null)
    }
  }

  const paidId = facts?.status.kind === 'paid' ? facts.payable_id : null
  const unpaidLoaded = facts && facts.status.kind !== 'paid'

  return (
    <aside id="try" aria-labelledby="try-panel-title" className="scroll-mt-4 rounded-none border border-line bg-card p-6">
      <h2 id="try-panel-title" className="text-xl font-medium tracking-[-0.01em] text-ink">
        Try to break it.
      </h2>
      <p className="mt-1 text-sm text-muted">
        Each attempt is real or clearly labelled. Some cost a testnet fee, and the chain keeps the fee even when it
        refuses.
      </p>

      <div className="mt-4 space-y-2">
        <PrimaryButton
          id="attack-tamper"
          onClick={() => void tamper()}
          disabled={!docText || !facts || busy !== null}
          disabledReason={!docText || !facts ? 'Load an invoice first (step 1).' : null}
          className="w-full justify-start"
        >
          {busy === 'tamper' ? 'Checking the tampered file…' : 'Tamper with the invoice'}
        </PrimaryButton>
        <PrimaryButton
          id="attack-pay-twice"
          onClick={() => {
            const id = paidId ?? facts?.payable_id
            if (id) void runAttack('pay_twice', id)
          }}
          disabled={(!paidId && !hasPaidInSession) || busy !== null}
          disabledReason={!paidId && !hasPaidInSession ? 'Pay an invoice first, or use Watch the recorded run.' : null}
          className="w-full justify-start"
        >
          {busy === 'pay_twice' ? 'Sending a second payment…' : 'Pay it twice'}
        </PrimaryButton>
        <label className="flex items-center gap-2 text-sm text-muted">
          <input
            type="checkbox"
            checked={precheckOnly}
            onChange={(e) => setPrecheckOnly(e.target.checked)}
            className="h-4 w-4 accent-brand-600"
          />
          Stop before sending (no fee) — show the app pre-check instead
        </label>
        <PrimaryButton
          id="attack-wrong-amount"
          onClick={() => facts && void runAttack('wrong_amount', facts.payable_id)}
          disabled={!unpaidLoaded || busy !== null}
          disabledReason={!unpaidLoaded ? 'Load an unpaid invoice first.' : null}
          className="w-full justify-start"
        >
          {busy === 'wrong_amount' ? 'Sending the wrong amount…' : 'Wrong amount'}
        </PrimaryButton>
        <PrimaryButton
          id="attack-unlisted"
          onClick={() => facts && void runAttack('unlisted_seller', facts.payable_id)}
          disabled={busy !== null}
          className="w-full justify-start"
        >
          {busy === 'unlisted_seller' ? 'Checking the seller…' : 'Pay a fraudster’s invoice'}
        </PrimaryButton>
        <PrimaryButton
          id="attack-injection"
          onClick={inject}
          disabled={!docText || !facts || busy !== null}
          disabledReason={!docText || !facts ? 'Load an invoice first (step 1).' : null}
          className="w-full justify-start"
        >
          {busy === 'injection' ? 'Testing the injection…' : 'Injection: tell the agent to pay another account'}
        </PrimaryButton>
      </div>

      {error ? <AlertInline>{error}</AlertInline> : null}
      {outcome ? <OutcomeCard o={outcome} explorerBase={explorerBase} /> : null}
      <div className="mt-4">
        <BudgetNote showFresh={false} />
      </div>
      <div className="mt-4">
        <SecondaryButton
          onClick={() => void watchRecorded()}
          disabled={!facts || busy !== null}
          disabledReason={!facts ? 'Load an invoice first (step 1).' : null}
        >
          {busy === 'recorded' ? 'Loading the recorded run…' : 'Watch the recorded run'}
        </SecondaryButton>
        <p className="mt-2 text-xs text-muted">Recorded run, 24 Nov 2026 — labelled, never shown as live.</p>
        {recorded ? (
          <ol className="mt-3 space-y-1.5 border-t border-line pt-3 text-sm" aria-live="polite">
            {recorded.steps.map((s, i) => (
              <li key={i} className="flex items-start gap-2">
                <span className="mt-0.5 inline-block h-4 w-4 shrink-0 rounded-full bg-verified-bg text-center text-[10px] leading-4 text-verified" aria-hidden="true">✓</span>
                <span className="text-ink">
                  <span className="font-medium">{s.step}</span>
                  {s.detail ? <span className="text-muted"> — {s.detail}</span> : null}
                  {s.txHash ? (
                    <span className="block">
                      <HashLink hash={s.txHash} explorerBase={explorerBase} />
                    </span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </aside>
  )
}
