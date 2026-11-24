// Home page — the one-screen judge flow (P3 §4) under the P2 landing hero.
// Regions: A header, B hero, C step 1, D step 2, E step 3, F step 4,
// G side column (Try to break it + build status), H footer.
// Accepts ?payable=<id> to preload an invoice (P3 §3).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { AppHeader } from '../components/AppHeader'
import { BudgetNote } from '../components/BudgetNote'
import { DashboardPreview } from '../components/DashboardPreview'
import { Hero } from '../components/Hero'
import { InvoiceStep } from '../components/InvoiceStep'
import { CheckStep } from '../components/CheckStep'
import { PayStep } from '../components/PayStep'
import { ReceiptStep } from '../components/ReceiptStep'
import { TryPanel } from '../components/TryPanel'
import { CtaBand, Features, Footer, HowItWorks } from '../components/Sections'
import { AlertInline, StepCard } from '../components/ui'
import { api } from '../lib/api'
import { ApiError, type Receipt } from '../lib/types'
import { flowReducer, initialFlowState, isCheckFresh, payDisabledReason } from '../lib/flow'
import { stickyActionFor, type StickyAction } from '../lib/sticky'
import { useConfig, useHealth } from '../hooks/useApi'
import { useJobEvents } from '../hooks/useJobEvents'

export function HomePage() {
  const [state, dispatch] = useReducer(flowReducer, initialFlowState)
  const [params] = useSearchParams()
  const queryClient = useQueryClient()
  const health = useHealth()
  const config = useConfig()
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [docText, setDocText] = useState<string | null>(null)
  const [reverifyTick, setReverifyTick] = useState(0)
  const resultRef = useRef<HTMLDivElement>(null)

  const explorerBase = config.data?.explorer.tx ?? 'https://ccdexplorer.io/testnet/transaction/'
  const runningJobId = state.pay.kind === 'running' ? state.pay.job.job_id : null
  const { job: liveJob } = useJobEvents(runningJobId)

  // Job outcome: update the flow state, and load the receipt on success.
  useEffect(() => {
    if (!liveJob) return
    dispatch({ type: 'PAY_UPDATED', job: liveJob })
    if (liveJob.state === 'succeeded') {
      void api
        .getReceipt(liveJob.payable_id)
        .then((r) => {
          setReceipt(r)
          resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        })
        .catch(() => setPageError('The payment succeeded, but the receipt could not be loaded. Use the transaction links above.'))
    }
    if (liveJob.state === 'succeeded' || liveJob.state === 'refused' || liveJob.state === 'failed') {
      void queryClient.invalidateQueries({ queryKey: ['stats'] })
      void queryClient.invalidateQueries({ queryKey: ['invoices'] })
    }
  }, [liveJob, queryClient])

  const loadFacts = useCallback(async (id: number) => {
    dispatch({ type: 'FACTS_LOADING' })
    try {
      const facts = await api.getPayable(id)
      dispatch({ type: 'FACTS_LOADED', facts })
      return facts
    } catch (e) {
      dispatch({ type: 'FACTS_NOT_FOUND' })
      setPageError(
        e instanceof ApiError
          ? e.body.message
          : 'No payable with this number is on the test registry.',
      )
      return null
    }
  }, [])

  // ?payable=<id> preload (P3 §3).
  const preloaded = useRef(false)
  useEffect(() => {
    const id = Number.parseInt(params.get('payable') ?? '', 10)
    if (!preloaded.current && Number.isFinite(id) && id > 0) {
      preloaded.current = true
      void loadFacts(id)
    }
  }, [params, loadFacts])

  const onLoaded = useCallback((text: string, hash: string, payableId: number | null) => {
    setDocText(text)
    dispatch({ type: 'INVOICE_LOADED', docText: text, docSha256: hash, payableId })
    if (payableId !== null) void loadFacts(payableId)
  }, [loadFacts])

  const onNumber = useCallback(
    (id: number) => {
      void loadFacts(id)
    },
    [loadFacts],
  )

  const onFresh = useCallback(
    async (asset: 'ccd' | 'eudemo') => {
      setPageError(null)
      try {
        const created = await api.createPayable(asset)
        dispatch({
          type: 'INVOICE_LOADED',
          docText: '',
          docSha256: '',
          payableId: created.payable_id,
        })
        await loadFacts(created.payable_id)
      } catch (e) {
        setPageError(
          e instanceof ApiError
            ? e.body.message
            : 'The demo’s budget for new invoices is used up for this hour.',
        )
      }
    },
    [loadFacts],
  )

  const onCheck = useCallback(async () => {
    const facts = state.facts
    if (!facts) return
    dispatch({ type: 'CHECK_RUNNING', done: 0, total: 9 })
    try {
      const docSha256 =
        state.invoice.kind === 'loaded' && state.invoice.docSha256 ? state.invoice.docSha256 : undefined
      const res = await api.verify(facts.payable_id, 'before_pay', docSha256)
      if (res.verdict === 'ready') dispatch({ type: 'CHECK_READY', result: res })
      else if (res.verdict === 'paid') dispatch({ type: 'CHECK_BLOCKED', result: res })
      else dispatch({ type: 'CHECK_BLOCKED', result: res })
    } catch (e) {
      dispatch({
        type: 'CHECK_READ_FAILED',
        message: e instanceof ApiError ? e.body.message : 'We could not read the testnet just now.',
      })
    }
  }, [state.facts, state.invoice])

  const onPay = useCallback(
    async (rail: 'ccd' | 'eudemo') => {
      const facts = state.facts
      if (!facts) return
      // The button is disabled at once in the UI; this is the second guard.
      dispatch({ type: 'RESET_PAY' })
      try {
        const docSha256 =
          state.invoice.kind === 'loaded' && state.invoice.docSha256 ? state.invoice.docSha256 : undefined
        const job = await api.pay(facts.payable_id, rail, docSha256)
        dispatch({
          type: 'PAY_STARTED',
          job: {
            job_id: job.job_id,
            payable_id: job.payable_id,
            rail: job.rail,
            state: 'running',
            steps: job.steps.map((step) => ({ step, status: 'pending' as const, detail: '' })),
            outcome: null,
            started_at: new Date().toISOString(),
            finished_at: null,
          },
          rail,
        })
      } catch (e) {
        dispatch({
          type: 'PAY_FAILED',
          message:
            e instanceof ApiError
              ? e.body.message
              : 'Something went wrong on our side. Nothing was sent unless a transaction link appears above.',
        })
      }
    },
    [state.facts, state.invoice],
  )

  const payDisabled = useCallback(
    (rail: 'ccd' | 'eudemo') => {
      if (state.check.kind !== 'ready') return 'Run the check first.'
      if (!isCheckFresh(state)) return 'The check is more than 10 minutes old. Check again.'
      return payDisabledReason(
        state,
        rail,
        health.data?.payer.status ?? 'ok',
        health.data?.wallet_eudemo.status ?? 'ok',
      )
    },
    [state, health.data],
  )

  const budgetLeft = health.data?.budget.new_invoices_left_this_hour ?? null
  const build = config.data?.build

  // Sticky bottom bar (P3 §12, mobile only): the current primary action.
  // Derivation lives in lib/sticky.ts (unit-tested); this maps kind → click.
  const stickyAction = (): { label: string; disabledReason: string | null; onClick: () => void } => {
    const a: StickyAction = stickyActionFor(state, state.facts, receipt !== null, payDisabled)
    if (a.kind === 'pay') {
      return {
        label: a.label,
        disabledReason: a.disabledReason,
        onClick: () => {
          onPay(a.rail)
          document.getElementById('pay')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        },
      }
    }
    if (a.kind === 'check-again') {
      return {
        label: a.label,
        disabledReason: null,
        onClick: () => {
          setReverifyTick((t) => t + 1)
          resultRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
        },
      }
    }
    if (a.kind === 'busy') {
      return { label: a.label, disabledReason: a.disabledReason, onClick: () => {} }
    }
    return {
      label: a.label,
      disabledReason: a.disabledReason,
      onClick: () => {
        if (state.facts) onCheck()
        document.getElementById('check')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
      },
    }
  }

  return (
    <div id="top" className="min-h-screen bg-paper pb-24 md:pb-0">
      <div className="bg-sky-0">
        <AppHeader dark skipTarget="#invoice" />
      </div>
      <main id="main">
        <Hero />
        <div id="invoice" className="mx-auto max-w-[1101px] scroll-mt-4 px-4 pt-4 sm:px-6">
          <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
            <div className="space-y-3" aria-live="polite">
              {pageError ? <AlertInline>{pageError}</AlertInline> : null}
              <InvoiceStep onLoaded={onLoaded} onNumber={onNumber} onFresh={onFresh} budgetLeft={budgetLeft} />
              {/* Payable facts — shown once a payable is loaded (P3 §5). */}
              {state.facts ? (
                <div className="rounded-none border border-line bg-card p-6">
                  <h2 className="text-xl font-medium tracking-[-0.01em] text-ink">
                    Payable {state.facts.payable_id} — {state.facts.amount_display}
                  </h2>
                  <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                    <div>
                      <dt className="text-muted">Payee (from the chain)</dt>
                      <dd className="font-mono text-xs text-ink break-all">{state.facts.payee}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Seller</dt>
                      <dd className="font-mono text-xs text-ink break-all">{state.facts.seller}</dd>
                    </div>
                    <div>
                      <dt className="text-muted">Due date</dt>
                      <dd className="text-ink">
                        {new Date(state.facts.due).toISOString().slice(0, 10)} at{' '}
                        {new Date(state.facts.due).toISOString().slice(11, 16)} UTC
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Status</dt>
                      <dd className="text-ink">
                        {state.facts.status.kind === 'paid'
                          ? `Paid${state.facts.status.paid_at ? ` on ${new Date(state.facts.status.paid_at).toISOString().slice(0, 10)}` : ''}`
                          : state.facts.status.kind === 'reserved'
                            ? `Reserved for another payment until ${new Date(state.facts.status.expires).toISOString().slice(11, 16)} UTC`
                            : 'Unpaid. Can be paid once.'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Seller’s agent</dt>
                      <dd className="text-ink">
                        Token {state.facts.agent.token.slice(0, 4)}…{state.facts.agent.token.slice(-4)} active on the
                        test CIS-8004 instance &lt;{state.facts.agent.registry.index},
                        {state.facts.agent.registry.subindex}&gt;.
                      </dd>
                    </div>
                    <div>
                      <dt className="text-muted">Seller identity</dt>
                      <dd className="text-ink">
                        Not verified. No company (LEI) or identity proof is attached to this seller.
                      </dd>
                    </div>
                  </dl>
                  <p className="mt-3 text-xs text-muted">Lab invoice (testnet, not a real invoice)</p>
                </div>
              ) : state.factsState === 'not-found' ? (
                <AlertInline>No payable with this number is on the test registry.</AlertInline>
              ) : null}
              <div id="check" className="scroll-mt-4">
                <CheckStep onCheck={onCheck} state={state.check} />
              </div>
              <div id="pay" className="scroll-mt-4">
                <PayStep
                  facts={state.facts}
                  payState={state.pay}
                  liveJob={liveJob}
                  onPay={onPay}
                  payDisabled={payDisabled}
                  explorerBase={explorerBase}
                />
              </div>
              <div ref={resultRef}>
                <ReceiptStep receipt={receipt} explorerBase={explorerBase} reverifySignal={reverifyTick} />
              </div>
            </div>
            <div className="space-y-6">
              <TryPanel
                facts={state.facts}
                docText={docText}
                docSha256={state.invoice.kind === 'loaded' ? state.invoice.docSha256 : null}
                explorerBase={explorerBase}
                hasPaidInSession={state.pay.kind === 'succeeded'}
              />
              {/* Build status summary (P3 §4 region G). */}
              <StepCard number="—" title="Build status" status="idle">
                <ul className="space-y-1.5 text-sm text-muted">
                  <li>
                    Vendor list enforced by the co-signer:{' '}
                    <span className="text-ink">{build?.vendor_list_enforced_by_co_signer ? 'Yes' : 'Not yet (planned)'}</span>
                  </li>
                  <li>
                    Named payer on invoice:{' '}
                    <span className="text-ink">{build?.named_payer_on_invoice ? 'Yes' : 'Not yet (planned)'}</span>
                  </li>
                  <li>
                    Transaction expiry bounded by the reservation:{' '}
                    <span className="text-ink">{build?.header_expiry_bound ? 'Yes' : 'Not yet (planned)'}</span>
                  </li>
                  <li>
                    Co-signer runs as:{' '}
                    <span className="text-ink">{build?.co_signer_runs_as ?? '—'}</span>
                  </li>
                </ul>
                <p className="mt-3 text-sm">
                  <Link to="/judges" className="font-medium text-teal-700">
                    Details: For judges →
                  </Link>
                </p>
                <div className="mt-2">
                  <BudgetNote />
                </div>
              </StepCard>
            </div>
          </div>
        </div>
        {/* Live console — the payables console, below the flow (design F10f:
            the compact hero cannot hold it and steps 1–3 must fit at 1440×900). */}
        <section aria-labelledby="console-title" className="mx-auto max-w-[1101px] px-4 pt-16 sm:px-6">
          <p className="text-sm font-medium tracking-[0.02em] text-ink">
            <span className="mr-2 inline-block h-[6px] w-[6px] bg-ink align-middle" aria-hidden="true" />
            Live console
          </p>
          <h2
            id="console-title"
            className="mt-6 max-w-[640px] text-[44px] leading-[1.0] font-normal tracking-[-0.02em] text-ink"
          >
            The registry, live.
          </h2>
          <p className="mt-6 max-w-[560px] text-[15px] leading-[1.5] text-muted">
            Every number below is live from the test registry — except the fees chart and the refused tab, which are
            the recorded run of 24 Nov 2026 and are labelled as such.
          </p>
          <div className="mt-8">
            <DashboardPreview />
          </div>
        </section>
        <Features />
        <HowItWorks />
        <CtaBand />
      </main>
      <Footer />
      <StickyBar action={stickyAction()} />
    </div>
  )
}

function StickyBar({ action }: { action: { label: string; disabledReason: string | null; onClick: () => void } }) {
  const disabled = action.disabledReason !== null
  return (
    <div
      className="fixed inset-x-0 bottom-0 z-40 md:hidden"
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
    >
      <div className="border-t border-white/20 bg-ink px-4 py-3">
        <button
          type="button"
          onClick={disabled ? undefined : action.onClick}
          aria-disabled={disabled ? 'true' : undefined}
          aria-describedby={disabled ? 'sticky-bar-reason' : undefined}
          className="flex min-h-[44px] w-full items-center justify-center rounded-[4px] bg-white px-5 text-[15px] font-medium text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          {action.label}
        </button>
        {disabled ? (
          <p id="sticky-bar-reason" className="mt-1.5 text-center text-xs text-white/80">
            {action.disabledReason}
          </p>
        ) : null}
      </div>
    </div>
  )
}
