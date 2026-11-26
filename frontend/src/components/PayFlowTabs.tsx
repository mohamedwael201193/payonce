// Pay flow as MANUAL tabs (fix-back-12) — the whole flow lives ONLY on
// /dashboard/pay. One tab per step (01 Pick an invoice, 02 Check, 03 Pay once,
// 04 Receipt) plus a tab for Try to break it. Tabs are clicked by the user,
// NEVER auto-rotating and never auto-advancing: there is no timer anywhere
// in this file (no timer of any kind). Completing a
// step SUGGESTS the next tab via an enabled Continue button but never
// switches tabs on its own. Tab state is the URL query ?tab= on
// /dashboard/pay (pick|check|pay|receipt|try; anything else falls back to
// pick), so a tab is deep-linkable and survives reloads; tab clicks use
// replace so they stay out of the back-button history, and ?payable= is
// preserved.
//
// The step components and the flow logic are moved VERBATIM from the old
// HomePage (which is display-only now) — not duplicated, not rewritten —
// minus the sticky mobile pay bar, minus the reverify tick, minus the
// success scrollIntoView (the receipt is a tab now, not a scroll target).
import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Bug, CheckCircle2, FileText, Receipt as ReceiptIcon, Wallet } from 'lucide-react'
import { CheckStep } from './CheckStep'
import { InvoiceStep } from './InvoiceStep'
import { PayStep } from './PayStep'
import { ReceiptStep } from './ReceiptStep'
import { TryPanel } from './TryPanel'
import { AlertInline, PrimaryButton, SecondaryButton } from './ui'
import { api } from '../lib/api'
import { flowReducer, initialFlowState, isCheckFresh, payDisabledReason } from '../lib/flow'
import { ApiError, type PayableFacts, type Receipt } from '../lib/types'
import { useConfig, useHealth } from '../hooks/useApi'
import { useJobEvents } from '../hooks/useJobEvents'

export type PayTabId = 'pick' | 'check' | 'pay' | 'receipt' | 'try'

const PAY_TABS: { id: PayTabId; num: string; label: string; icon: typeof FileText }[] = [
  { id: 'pick', num: '01', label: 'Pick an invoice', icon: FileText },
  { id: 'check', num: '02', label: 'Check', icon: CheckCircle2 },
  { id: 'pay', num: '03', label: 'Pay once', icon: Wallet },
  { id: 'receipt', num: '04', label: 'Receipt', icon: ReceiptIcon },
  { id: 'try', num: '05', label: 'Try to break it', icon: Bug },
]

const TAB_IDS: PayTabId[] = ['pick', 'check', 'pay', 'receipt', 'try']

export function payTabIdFromSearch(params: URLSearchParams): PayTabId {
  const tab = params.get('tab')
  return (TAB_IDS as string[]).includes(tab ?? '') ? (tab as PayTabId) : 'pick'
}

// One tab style, one radius scale (tasteskill 2.5 + Tailwind v4): the tab
// bar is a paper pill row (the Altura reference's pill row, in cream);
// the active tab is a white card pill, inactive tabs are muted text.
function payTabClass(active: boolean) {
  return `flex items-center gap-2 rounded-full px-3.5 py-2 text-sm whitespace-nowrap focus-visible:outline-2 focus-visible:outline-ember ${
    active ? 'bg-card font-medium text-ink shadow-sm ring-1 ring-line' : 'text-body hover:bg-card/70'
  }`
}

function FactsLine({ facts }: { facts: PayableFacts }) {
  const status =
    facts.status.kind === 'paid'
      ? 'Paid'
      : facts.status.kind === 'reserved'
        ? 'Reserved'
        : facts.status.kind === 'voided'
          ? 'Voided'
          : 'Unpaid'
  return (
    <p className="text-sm text-muted">
      Payable {facts.payable_id} — {facts.amount_display} · {status}
    </p>
  )
}

function PrerequisiteNote({ goTab }: { goTab: (tab: PayTabId) => void }) {
  return (
    <div className="space-y-4">
      <p className="text-[15px] text-muted">Pick an invoice first — this step needs a payable loaded from the test registry.</p>
      <SecondaryButton onClick={() => goTab('pick')}>Pick an invoice →</SecondaryButton>
    </div>
  )
}

export function PayFlowTabs() {
  const [state, dispatch] = useReducer(flowReducer, initialFlowState)
  const [params, setParams] = useSearchParams()
  const queryClient = useQueryClient()
  const health = useHealth()
  const config = useConfig()
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [pageError, setPageError] = useState<string | null>(null)
  const [docText, setDocText] = useState<string | null>(null)
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([])

  const activeTab = payTabIdFromSearch(params)

  const goTab = useCallback(
    (tab: PayTabId) => {
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('tab', tab)
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  const onTabKeyDown = (e: React.KeyboardEvent, index: number) => {
    let next: number | null = null
    if (e.key === 'ArrowRight') next = (index + 1) % PAY_TABS.length
    else if (e.key === 'ArrowLeft') next = (index - 1 + PAY_TABS.length) % PAY_TABS.length
    else if (e.key === 'Home') next = 0
    else if (e.key === 'End') next = PAY_TABS.length - 1
    if (next === null) return
    e.preventDefault()
    goTab(PAY_TABS[next].id)
    tabRefs.current[next]?.focus()
  }

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
        })
        .catch(() => setPageError('The payment succeeded, but the receipt could not be loaded. Use the transaction links above.'))
    }
    if (liveJob.state === 'succeeded' || liveJob.state === 'refused' || liveJob.state === 'failed') {
      void queryClient.invalidateQueries({ queryKey: ['live-snapshot'] })
    }
  }, [liveJob, queryClient])

  // ?payable=<id> preload. The ref records the id of the most recent load
  // (every load path sets it — see loadFacts), so the effect below can
  // tell a failed load of an id ("do not retry it forever") from a URL
  // that names a different payable than the loaded facts.
  const preloadedId = useRef<number | null>(null)

  // Fix-back-14 MF-2: generation counter for loadFacts. Each load tags
  // its generation; a resolution (or failure) belonging to an older
  // generation is ignored — a slow load of payable 3 that lands AFTER
  // the user hand-picked 5 must not overwrite 5's facts. Without this,
  // the late 3 landed on screen while the URL said 5, with Pay enabled.
  const loadGen = useRef(0)

  const loadFacts = useCallback(async (id: number) => {
    // Fix-back-13 MF-1: record the id being loaded here, not only in the
    // preload effect — every load path (preload, hand-pick, fresh) marks
    // its id, so the effect below can tell "already loaded / loading"
    // from "the URL names a different payable than the loaded facts".
    preloadedId.current = id
    const gen = ++loadGen.current
    dispatch({ type: 'FACTS_LOADING' })
    try {
      const facts = await api.getPayable(id)
      // Fix-back-14 MF-2: ignore a stale resolution — a newer load has
      // been requested since this one started.
      if (loadGen.current !== gen) return null
      dispatch({ type: 'FACTS_LOADED', facts })
      // Fix-back-15 MF-2: a successful load clears the banner a failed
      // load left behind. The catch below sets pageError, and nothing
      // cleared it — so "The testnet did not answer in time…" survived
      // on screen after a later load succeeded. The stale-resolution
      // return above must NOT clear it: a stale success belongs to an
      // older load, not to the error the current load may have set.
      setPageError(null)
      return facts
    } catch (e) {
      // Fix-back-14 MF-2: a stale failure must not 404 the payable the
      // newer load is fetching either.
      if (loadGen.current !== gen) return null
      dispatch({ type: 'FACTS_NOT_FOUND' })
      setPageError(
        e instanceof ApiError
          ? e.body.message
          : 'No payable with this number is on the test registry.',
      )
      return null
    }
  }, [])

  // Fix-back-13 MF-1: the URL always names the loaded payable. A hand-pick
  // (lab list, number field, pasted/file invoice, fresh invoice) writes
  // its id into ?payable= (replace, so the back button is untouched), so
  // a later dashboard row Pay link to a different id is a real param
  // change the preload effect below can act on — a stale id can never
  // be resurrected by a link the user did not click.
  // Fix-back-15 MF-1: the id of the most recent ?payable= sync that has
  // not yet been observed to land. syncPayableParam sets it
  // synchronously (below); the preload effect clears it the moment a
  // navigation is observed (see lastSearch). It tracks the pending
  // sync, not mere param sightings — the fix-back-14 seen-param guard
  // recorded only params the effect acted on, never the id a direct
  // load delivered, so after preload 3 -> hand-pick 5 -> row link to 3
  // mid-load -> release 5, seen was still 3 and the effect refused to
  // reload 3 forever: the panel stranded on Payable 5 while the URL
  // said 3, and tab switches re-ran the same guard.
  const pendingSyncId = useRef<number | null>(null)

  // Fix-back-15 MF-1: the query string the preload effect last
  // observed. Any observed change resolves a pending sync: it either
  // landed (the param now names the pending id) or a later navigation
  // superseded it (a row link / tab click issued before the sync
  // landed — the router's final URL names something else). Either way
  // the sync is over and must not suppress a later load; without this
  // a superseded sync would strand the panel exactly like the
  // seen-param guard did.
  const lastSearch = useRef<string | null>(null)

  const syncPayableParam = useCallback(
    (id: number) => {
      // Fix-back-15 MF-1: record the pending sync SYNCHRONOUSLY — the
      // navigation lands a beat later (startTransition), and the
      // preload effect must know a sync to this id is outstanding in
      // that beat. Without this the effect cannot tell the T2 beat
      // (visible param is the stale pre-sync value) from a real param
      // change (a row Pay link that has landed).
      pendingSyncId.current = id
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('payable', String(id))
          return next
        },
        { replace: true },
      )
    },
    [setParams],
  )

  // ?payable=<id> preload. The guard compares the param against the
  // LOADED facts id: any param that names a different payable than the
  // facts on screen reloads — EXCEPT in the one beat where a hand-pick
  // has rendered its facts but its ?payable= sync has not landed yet
  // (the visible param is the stale pre-sync value, and a sync to a
  // different id is outstanding — pendingSyncId). That beat is the
  // fix-back-14 T2 hazard: suppressing it there is the ONLY job the
  // old seen-param guard had, and the pending-sync ref does it without
  // the strand — a param that names a different payable than the
  // loaded facts, with NO sync outstanding, always reloads, including
  // a param change that arrived mid-load and is retried when the
  // in-flight load settles. Loads in flight are not duplicated, and a
  // load that 404'd is not retried on every tab switch (preloadedId).
  useEffect(() => {
    // A navigation has landed since this effect last ran: any sync
    // issued before it has landed or been superseded — resolve it, so
    // a superseded sync can never suppress a later load.
    const search = params.toString()
    if (lastSearch.current !== null && lastSearch.current !== search) {
      pendingSyncId.current = null
    }
    lastSearch.current = search
    const id = Number.parseInt(params.get('payable') ?? '', 10)
    if (!Number.isFinite(id) || id <= 0) return
    if (state.facts?.payable_id === id) return
    // A load is in flight — do not fire a second one. The effect
    // re-runs when the load settles and retries the param then; a
    // param change that arrived mid-load is not lost.
    if (state.factsState === 'loading') return
    if (state.factsState === 'not-found' && preloadedId.current === id) return
    // A sync to a different id is still outstanding: the visible param
    // is the stale pre-sync value (T2 beat) — do not act on it.
    // With no sync outstanding the param is current, and a mismatch
    // against the loaded facts always reloads (X1 strand fix).
    if (pendingSyncId.current !== null && pendingSyncId.current !== id) return
    void loadFacts(id)
  }, [params, loadFacts, state.facts, state.factsState])

  const onLoaded = useCallback((text: string, hash: string, payableId: number | null) => {
    setDocText(text)
    dispatch({ type: 'INVOICE_LOADED', docText: text, docSha256: hash, payableId })
    if (payableId !== null) {
      syncPayableParam(payableId)
      void loadFacts(payableId)
    }
  }, [loadFacts, syncPayableParam])

  const onNumber = useCallback(
    (id: number) => {
      syncPayableParam(id)
      void loadFacts(id)
    },
    [loadFacts, syncPayableParam],
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
        syncPayableParam(created.payable_id)
        await loadFacts(created.payable_id)
      } catch (e) {
        setPageError(
          e instanceof ApiError
            ? e.body.message
            : 'The demo’s budget for new invoices is used up for this hour.',
        )
      }
    },
    // Fix-back-14 N2: onFresh uses syncPayableParam — it belongs in the
    // deps (harmless omission before: setParams is stable — but the
    // exhaustive-deps rule is right and the dep costs nothing).
    [loadFacts, syncPayableParam],
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
      // Fix-back-14 MF-3: second guard — never start a pay for a payable
      // the ready check was not run for. The button is disabled in that
      // state (payDisabledReason binds check to facts); this closes the
      // handler path too, so a stale enabled button could never pay.
      if (state.check.kind !== 'ready' || state.check.result.payable_id !== facts.payable_id) return
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
    [state.facts, state.invoice, state.check],
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
  const paid = state.pay.kind === 'succeeded'
  const checkReady = state.check.kind === 'ready'

  return (
    <section aria-labelledby="pay-title" className="card-glass p-6 sm:p-8">
      <h2 id="pay-title" className="text-[22px] leading-[1.15] font-medium tracking-[-0.01em] text-ink">
        Pay an invoice
      </h2>
      <p className="mt-2 text-[15px] text-muted">
        Pick an invoice, check it on chain, pay once, keep the receipt. Testnet only — nothing here is real money.
      </p>
      {pageError ? (
        <div className="mt-4">
          <AlertInline>{pageError}</AlertInline>
        </div>
      ) : null}
      <div role="tablist" aria-label="Pay flow steps" className="mt-6 flex gap-1 overflow-x-auto rounded-full border border-line bg-paper-2 p-1">
        {PAY_TABS.map((tab, i) => {
          const active = activeTab === tab.id
          const Icon = tab.icon
          return (
            <button
              key={tab.id}
              ref={(el) => {
                tabRefs.current[i] = el
              }}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`panel-${tab.id}`}
              tabIndex={active ? 0 : -1}
              onClick={() => goTab(tab.id)}
              onKeyDown={(e) => onTabKeyDown(e, i)}
              className={payTabClass(active)}
            >
              <span className="text-xs font-normal text-muted" aria-hidden="true">
                {tab.num}{' '}
              </span>
              <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
              {tab.label}
            </button>
          )
        })}
      </div>

      <div role="tabpanel" id="panel-pick" aria-labelledby="tab-pick" hidden={activeTab !== 'pick'} className="pt-6">
        <div aria-live="polite" className="space-y-6">
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
          <PrimaryButton
            onClick={() => goTab('check')}
            disabled={!state.facts}
            disabledReason={!state.facts ? 'Pick an invoice first.' : null}
          >
            Continue to Check →
          </PrimaryButton>
        </div>
      </div>

      <div role="tabpanel" id="panel-check" aria-labelledby="tab-check" hidden={activeTab !== 'check'} className="pt-6">
        {state.facts ? (
          <div className="space-y-6">
            <FactsLine facts={state.facts} />
            <CheckStep onCheck={onCheck} state={state.check} />
            <PrimaryButton
              onClick={() => goTab('pay')}
              disabled={!checkReady}
              disabledReason={!checkReady ? 'Run the check first.' : null}
            >
              Continue to Pay →
            </PrimaryButton>
          </div>
        ) : (
          <PrerequisiteNote goTab={goTab} />
        )}
      </div>

      <div role="tabpanel" id="panel-pay" aria-labelledby="tab-pay" hidden={activeTab !== 'pay'} className="pt-6">
        {state.facts ? (
          <div className="space-y-6">
            <FactsLine facts={state.facts} />
            <PayStep
              facts={state.facts}
              payState={state.pay}
              liveJob={liveJob}
              onPay={onPay}
              payDisabled={payDisabled}
              explorerBase={explorerBase}
            />
            {paid && receipt ? (
              <PrimaryButton onClick={() => goTab('receipt')}>View receipt →</PrimaryButton>
            ) : paid ? (
              <PrimaryButton disabled disabledReason={null}>
                Loading receipt…
              </PrimaryButton>
            ) : (
              <SecondaryButton onClick={() => goTab('check')}>Back to Check →</SecondaryButton>
            )}
          </div>
        ) : (
          <PrerequisiteNote goTab={goTab} />
        )}
      </div>

      <div role="tabpanel" id="panel-receipt" aria-labelledby="tab-receipt" hidden={activeTab !== 'receipt'} className="pt-6">
        {state.facts ? <FactsLine facts={state.facts} /> : null}
        <div className={state.facts ? 'mt-6' : ''}>
          <ReceiptStep receipt={receipt} explorerBase={explorerBase} />
        </div>
      </div>

      <div role="tabpanel" id="panel-try" aria-labelledby="tab-try" hidden={activeTab !== 'try'} className="pt-6">
        {state.facts ? <FactsLine facts={state.facts} /> : null}
        <div className={state.facts ? 'mt-6' : ''}>
          <TryPanel
            facts={state.facts}
            docText={docText}
            docSha256={state.invoice.kind === 'loaded' ? state.invoice.docSha256 : null}
            explorerBase={explorerBase}
            hasPaidInSession={state.pay.kind === 'succeeded'}
          />
        </div>
      </div>
    </section>
  )
}
