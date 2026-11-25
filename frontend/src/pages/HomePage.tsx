// Home page — the one-screen judge flow (P3 §4) under the P2 landing hero.
// Regions: A header, B hero, C step 1, D step 2, E step 3, F step 4,
// G side column (Try to break it + build status), H footer.
// Accepts ?payable=<id> to preload an invoice (P3 §3).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Bug, CheckCircle2, FileText, LayoutDashboard, Receipt as ReceiptIcon, Scale, ShieldCheck, Wallet } from 'lucide-react'
import { BudgetNote } from '../components/BudgetNote'
import { Hero } from '../components/Hero'
import { HeroDemo } from '../components/HeroDemo'
import { Logo } from '../components/Logo'
import { InvoiceStep } from '../components/InvoiceStep'
import { CheckStep } from '../components/CheckStep'
import { PayStep } from '../components/PayStep'
import { ReceiptStep } from '../components/ReceiptStep'
import { TryPanel } from '../components/TryPanel'
import { CtaBand, Features, Footer, HairlineFigures, HowItWorks, InvoiceShowcase, JudgesSection, PlannerSection, VerifierSection } from '../components/Sections'
import { AlertInline, StepCard } from '../components/ui'
import { api } from '../lib/api'
import { buildStatusText, coSignerRunsAsSentence } from '../lib/copy'
import { formatUtcTime } from '../lib/format'
import { ApiError, type Receipt } from '../lib/types'
import { flowReducer, initialFlowState, isCheckFresh, payDisabledReason } from '../lib/flow'
import { stickyActionFor, type StickyAction } from '../lib/sticky'
import { useConfig, useHealth, useInvoices, useStats } from '../hooks/useApi'
import { useJobEvents } from '../hooks/useJobEvents'

export function HomePage() {
  const [state, dispatch] = useReducer(flowReducer, initialFlowState)
  const [params] = useSearchParams()
  const queryClient = useQueryClient()
  const health = useHealth()
  const config = useConfig()
  // Live inputs for the small demo card only (HeroDemo's chips + table).
  // No other live-dashboard surface is rendered on the landing.
  const demoInvoices = useInvoices()
  const demoStats = useStats()
  // Fix-back-8 MF-4: home shows a "Last updated" line for the demo card
  // (it had none — the dashboard's line is the last successful poll, so
  // this one reads the same dataUpdatedAt, not the server's verifier
  // run). demoInvoices and demoStats are the same underlying
  // ['live-snapshot'] query, so either dataUpdatedAt is the poll time.
  const demoUpdatedAt = Math.max(demoInvoices.dataUpdatedAt ?? 0, demoStats.dataUpdatedAt ?? 0)
  const demoLastUpdated = demoUpdatedAt > 0 ? `${formatUtcTime(new Date(demoUpdatedAt).toISOString())} UTC` : null
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [docText, setDocText] = useState<string | null>(null)
  const [reverifyTick, setReverifyTick] = useState(0)
  // Sidebar active section (video card's sidebar highlights the current
  // item). Anchors are real links; the highlight follows the last click.
  const [activeSection, setActiveSection] = useState('invoice')
  const resultRef = useRef<HTMLDivElement>(null)

  const explorerBase = config.data?.explorer.tx ?? 'https://ccdexplorer.io/testnet/transaction/'
  const runningJobId = state.pay.kind === 'running' ? state.pay.job.job_id : null
  const { job: liveJob, error: jobError } = useJobEvents(runningJobId)

  // The snapshot poll after the SSE `done` event can fail or time out
  // (15 s, timedFetch): the job would otherwise sit on `running` forever
  // with no error and no receipt. A poll failure fails the pay step
  // outright — PayStep renders the message with a Try again button.
  useEffect(() => {
    if (!jobError) return
    dispatch({ type: 'PAY_FAILED', message: jobError })
  }, [jobError])

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
      void queryClient.invalidateQueries({ queryKey: ['live-snapshot'] })
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
    <div id="top" className="page-enter min-h-screen bg-paper pb-24 md:pb-0">
      <main id="main">
        <Hero />
        {/* Small demo card — the ONLY dashboard in the hero (user order
            2026-11-25 03:40: the real dashboard lives only in /dashboard;
            the landing shows a demo, small and clearly Demo-labeled). The
            static demo glimpse, reshaped small (~60% width), pulled up
            over the hero's cloud band. */}
        <section aria-label="Demo dashboard" className="relative z-10 mx-auto max-w-[820px] px-4 sm:px-6">
          <div className="relative -mt-[100px] overflow-hidden rounded-[24px] border border-line bg-card shadow-[0_30px_80px_rgba(23,19,16,0.25)]">
            <HeroDemo items={demoInvoices.data ?? []} stats={demoStats.data} error={demoInvoices.isError || demoStats.isError} lastUpdated={demoLastUpdated} />
          </div>
        </section>
        {/* The real payment flow — pick, check, pay, receipt — with a slim
            anchor sidebar on the left. This is the judge flow, not a
            dashboard: no Cash overview, no console, no stats band here;
            those live only in /dashboard. */}
        <div className="relative z-10 mx-auto mt-14 max-w-[1101px] px-4 sm:px-6">
          <div
            id="invoice"
            className="relative scroll-mt-4 overflow-hidden rounded-[24px] border border-line bg-card shadow-[0_30px_80px_rgba(23,19,16,0.25)]"
          >
            <div className="flex">
              <nav
                aria-label="Dashboard"
                className="hidden w-[200px] shrink-0 flex-col border-r border-line bg-paper px-3 py-5 lg:flex"
              >
                <Link to="/" aria-label="PayOnce home" title="PayOnce — back to home" className="mb-4 px-3">
                  <Logo size={28} />
                </Link>
                <p className="px-3 pb-3 text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
                  Dashboard
                </p>
                {[
                  { id: 'invoice', href: '#invoice', label: 'Pick an invoice', icon: FileText },
                  { id: 'check', href: '#check', label: 'Check', icon: CheckCircle2 },
                  { id: 'pay', href: '#pay', label: 'Pay', icon: Wallet },
                  { id: 'receipt', href: '#receipt', label: 'Receipt', icon: ReceiptIcon },
                  { id: 'try', href: '#try', label: 'Try to break it', icon: Bug },
                ].map((item) => (
                  <a
                    key={item.id}
                    href={item.href}
                    aria-current={activeSection === item.id ? 'true' : undefined}
                    onClick={() => setActiveSection(item.id)}
                    className={`flex items-center gap-2.5 rounded-[4px] px-3 py-2 text-sm hover:bg-paper-2 ${
                      activeSection === item.id ? 'bg-paper-2 font-medium text-ink' : 'text-body'
                    }`}
                  >
                    <item.icon className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                    {item.label}
                  </a>
                ))}
                <Link
                  to="/dashboard"
                  className="flex items-center gap-2.5 rounded-[4px] px-3 py-2 text-sm text-body hover:bg-paper-2"
                >
                  <LayoutDashboard className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                  Dashboard
                </Link>
                <Link
                  to="/judges"
                  className="flex items-center gap-2.5 rounded-[4px] px-3 py-2 text-sm text-body hover:bg-paper-2"
                >
                  <Scale className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                  For judges
                </Link>
                <Link
                  to="/verify-age"
                  className="flex items-center gap-2.5 rounded-[4px] px-3 py-2 text-sm text-body hover:bg-paper-2"
                >
                  <ShieldCheck className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                  Verify age
                </Link>
                <p className="mt-auto px-3 pt-6 text-xs text-muted">Testnet · Concordium</p>
              </nav>
              <div className="min-w-0 flex-1">
                <div className="p-5 sm:p-8">
                <div className="grid gap-8 lg:grid-cols-[2fr_1fr]">
            <div className="space-y-6" aria-live="polite">
              {pageError ? <AlertInline>{pageError}</AlertInline> : null}
              <InvoiceStep onLoaded={onLoaded} onNumber={onNumber} onFresh={onFresh} budgetLeft={budgetLeft} />
              {/* Payable facts — shown once a payable is loaded (P3 §5). */}
              {state.facts ? (
                <div className="rounded-[20px] border border-line bg-card p-6 sm:p-8">
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
                            // Fix-back-8 MF-1: Voided is its own facts kind
                            // now — it must not render as "Unpaid. Can be
                            // paid once." (the old fallback, which was
                            // correct only while voided mapped to 'unpaid').
                            : state.facts.status.kind === 'voided'
                              ? 'Voided on chain — cannot be paid.'
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
              <div id="receipt" ref={resultRef} className="scroll-mt-4">
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
                    <span className="text-ink">{buildStatusText(config.isLoading, config.isError, build?.vendor_list_enforced_by_co_signer)}</span>
                  </li>
                  <li>
                    Named payer on invoice:{' '}
                    <span className="text-ink">{buildStatusText(config.isLoading, config.isError, build?.named_payer_on_invoice)}</span>
                  </li>
                  <li>
                    Transaction expiry bounded by the reservation:{' '}
                    <span className="text-ink">{buildStatusText(config.isLoading, config.isError, build?.header_expiry_bound)}</span>
                  </li>
                  <li>
                    Co-signer runs as:{' '}
                    <span className="text-ink">{coSignerRunsAsSentence()}</span>
                  </li>
                </ul>
                <p className="mt-3 text-sm">
                  <Link to="/judges" className="font-medium text-brand-700">
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
      </div>
    </div>
  </div>
  </div>
        {/* The live console and the live stats band used to sit here; per
            the user order 2026-11-25 03:40 they live ONLY in /dashboard now
            — the landing embeds no real dashboard. Live numbers appear on
            the landing only inside the Demo-labeled hero card (chips +
            table, disclosed in its footer). */}
        <Features />
        <HowItWorks />
        <HairlineFigures />
        <InvoiceShowcase />
        <VerifierSection />
        <PlannerSection />
        <JudgesSection />
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
          className="btn-ember w-full"
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
