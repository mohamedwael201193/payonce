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
  // N2 (round-4 fix-back): the preload effect suppresses a refetch when
  // the server answered a (payable, seller) pair with a DIFFERENT seller
  // than requested — the panel would otherwise show seller-1 facts under
  // a seller-2 URL with no word of it. The warning names the mismatch
  // instead of silently suppressing; set in the effect, cleared by a new
  // load or by a matching pair.
  const [sellerMismatch, setSellerMismatch] = useState<string | null>(null)
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
  // F-3: seller 1's address — the first entry of the config sellers list
  // (api/src/server.mjs builds it [seller 1, seller 2]). The server signs
  // payments for seller 1 only, so any loaded payable whose seller is not
  // this address is a second-seller payable. The true claim (round-4
  // fix-back, correcting round 3's "can never be paid from this UI"):
  // the UI hides the pay action for a second-seller payable AND the pay
  // step is disabled while the config is unavailable, AND the server
  // 400s any non-seller-1 write (rejectNonSeller1Write) — the threaded
  // seller in the pay body is the backstop when the client gate is
  // blind. Undefined until the config loads — while it is undefined the
  // pay step is disabled, never open.
  const seller1 = config.data?.sellers?.[0]?.seller
  const isSecondSellerPayable =
    seller1 !== undefined && state.facts !== null && state.facts.seller !== seller1
  // B1 (round-4 fix-back): while the config is pending or failed, the
  // seller-1 address is unknown and the F-3 gate cannot tell seller 1
  // from seller 2 — the pay step (and the live attacks) stay disabled
  // until the config answers. useConfig retries once, then isError.
  const configUnavailable = config.isPending || config.isError
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
      // N-3 (round-3 fix-back): thread the loaded facts' seller — a
      // just-succeeded job is always seller 1 in practice, but the
      // receipt fetch must name the seller it belongs to (same pattern
      // as TryPanel's getRecorded(id, facts?.seller)).
      void api
        .getReceipt(liveJob.payable_id, state.facts?.seller)
        .then((r) => {
          setReceipt(r)
        })
        .catch(() => setPageError('The payment succeeded, but the receipt could not be loaded. Use the transaction links above.'))
    }
    if (liveJob.state === 'succeeded' || liveJob.state === 'refused' || liveJob.state === 'failed') {
      void queryClient.invalidateQueries({ queryKey: ['live-snapshot'] })
    }
  }, [liveJob, queryClient, state.facts])

  // ?payable=<id> preload. The ref records the id of the most recent load
  // (every load path sets it — see loadFacts), so the effect below can
  // tell a failed load of an id ("do not retry it forever") from a URL
  // that names a different payable than the loaded facts. The seller
  // ref is its F-3 companion: a failed load of (id, seller 2) must not
  // suppress a later load of (id, seller 1), or vice versa — the pair,
  // not the bare id, is the load's identity.
  const preloadedId = useRef<number | null>(null)
  const preloadedSeller = useRef<string | null>(null)

  // Fix-back-14 MF-2: generation counter for loadFacts. Each load tags
  // its generation; a resolution (or failure) belonging to an older
  // generation is ignored — a slow load of payable 3 that lands AFTER
  // the user hand-picked 5 must not overwrite 5's facts. Without this,
  // the late 3 landed on screen while the URL said 5, with Pay enabled.
  const loadGen = useRef(0)

  // F-3 (round-3 fix-back): loadFacts takes the seller the URL (or the
  // picker) names and passes it to getPayable. A seller-less load is the
  // server's seller-1 default — loading seller 2's payable without it
  // silently returns seller 1's same-id payable facts. A missing seller
  // still means seller 1 (number/paste/fresh paths have no seller).
  const loadFacts = useCallback(async (id: number, seller?: string) => {
    // Fix-back-13 MF-1: record the id being loaded here, not only in the
    // preload effect — every load path (preload, hand-pick, fresh) marks
    // its id, so the effect below can tell "already loaded / loading"
    // from "the URL names a different payable than the loaded facts".
    preloadedId.current = id
    preloadedSeller.current = seller ?? null
    const gen = ++loadGen.current
    // N2: a new load supersedes any earlier mismatch warning — the
    // effect re-raises it if the new answer mismatches too.
    setSellerMismatch(null)
    dispatch({ type: 'FACTS_LOADING' })
    try {
      const facts = await api.getPayable(id, seller)
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
  // F-3 companion of pendingSyncId: the seller of the outstanding sync.
  // A hand-pick of seller 2's payable syncs ?seller= alongside ?payable=
  // — without it a reload would drop the seller and load seller 1's
  // same-id facts. null = the sync names no seller (seller-1 default).
  const pendingSyncSeller = useRef<string | null>(null)

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
    (id: number, seller?: string) => {
      // Fix-back-15 MF-1: record the pending sync SYNCHRONOUSLY — the
      // navigation lands a beat later (startTransition), and the
      // preload effect must know a sync to this id is outstanding in
      // that beat. Without this the effect cannot tell the T2 beat
      // (visible param is the stale pre-sync value) from a real param
      // change (a row Pay link that has landed).
      // F-3: the sync carries the seller too. A seller-2 hand-pick that
      // synced only the id would strand the URL seller-less — a reload
      // would then load seller 1's same-id payable. Conversely a
      // seller-less sync (number/paste/fresh — seller 1 by definition)
      // DELETES a stale ?seller=, so a previous seller-2 param can never
      // linger over a seller-1 load.
      pendingSyncId.current = id
      pendingSyncSeller.current = seller ?? null
      setParams(
        (prev) => {
          const next = new URLSearchParams(prev)
          next.set('payable', String(id))
          if (seller) next.set('seller', seller)
          else next.delete('seller')
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
      pendingSyncSeller.current = null
    }
    lastSearch.current = search
    const id = Number.parseInt(params.get('payable') ?? '', 10)
    if (!Number.isFinite(id) || id <= 0) return
    // F-3: the URL names a (payable, seller) pair. An absent ?seller=
    // is the server's seller-1 default; a present one names its seller
    // outright. The loaded facts must match BOTH — seller 2's payable
    // shares its id with seller 1's, so an id-only match would keep
    // seller 1's facts on screen while the URL names seller 2's.
    // (effectiveSeller null = config not loaded yet and no param: the
    // seller half cannot be checked until the config arrives, and the
    // effect re-runs then.)
    const paramSeller = params.get('seller')
    const effectiveSeller = paramSeller ?? seller1 ?? null
    if (state.facts?.payable_id === id && (effectiveSeller === null || state.facts.seller === effectiveSeller)) {
      // N2: the loaded pair matches the URL — any earlier mismatch
      // warning is stale. (Unconditional set: React bails out when the
      // value is already null, so this cannot loop the effect.)
      setSellerMismatch(null)
      return
    }
    // A load is in flight — do not fire a second one. The effect
    // re-runs when the load settles and retries the param then; a
    // param change that arrived mid-load is not lost.
    if (state.factsState === 'loading') return
    // The last load already requested exactly this (id, seller) and the
    // facts on screen are its answer — even if their seller disagrees
    // with the URL, a reload would fetch the same answer forever. (The
    // live server answers a seller-2 request with seller-2 facts or a
    // 404; only an inconsistent answer can land here, and looping on it
    // would spin the poll forever.) This suppresses ONLY the pair the
    // effect has already loaded — a URL naming any other pair reloads.
    // N2 (round-4 fix-back): the suppression is NOT silent any more.
    // Reaching here means the loaded facts' seller disagrees with the
    // URL's seller (the matching branch above returned otherwise) —
    // say so on screen instead of showing seller-1 facts under a
    // seller-2 URL with no word of it. (Unconditional set with a
    // deterministic string: React bails out when it is unchanged.)
    if (
      state.facts?.payable_id === id &&
      preloadedId.current === id &&
      preloadedSeller.current === paramSeller
    ) {
      setSellerMismatch(
        `The server answered payable ${id} with a different seller than the URL names (loaded ${state.facts.seller.slice(0, 8)}…, URL names ${(effectiveSeller ?? '').slice(0, 8)}…). The panel is showing the loaded payable — check it before paying anything.`,
      )
      return
    }
    if (state.factsState === 'not-found' && preloadedId.current === id && preloadedSeller.current === paramSeller) return
    // A sync to a different (id, seller) is still outstanding: the
    // visible param is the stale pre-sync value (T2 beat) — do not act
    // on it. With no sync outstanding the param is current, and a
    // mismatch against the loaded facts always reloads (X1 strand fix).
    if (
      pendingSyncId.current !== null &&
      (pendingSyncId.current !== id || pendingSyncSeller.current !== paramSeller)
    )
      return
    void loadFacts(id, paramSeller ?? undefined)
  }, [params, loadFacts, state.facts, state.factsState, seller1])

  const onLoaded = useCallback((text: string, hash: string, payableId: number | null, seller?: string) => {
    setDocText(text)
    dispatch({ type: 'INVOICE_LOADED', docText: text, docSha256: hash, payableId })
    if (payableId !== null) {
      // N1 (round-4 fix-back): the seller rides with the document load —
      // the lab picker names it (InvoiceStep passes it from the picked
      // row). A seller-less load here used to paint seller-1 facts
      // briefly and sync ?payable= without ?seller= (a reload in that
      // beat loaded seller 1); now the first load is already threaded,
      // and the onNumber load below only re-asserts the same pair.
      syncPayableParam(payableId, seller)
      void loadFacts(payableId, seller)
    }
  }, [loadFacts, syncPayableParam])

  const onNumber = useCallback(
    // F-3 sweep: the lab picker names the seller (InvoiceStep passes it
    // from the picked row) — thread it into the facts load, or picking
    // seller 2's invoice loads seller 1's same-id facts. The number
    // field has no seller and keeps the seller-1 default.
    (id: number, seller?: string) => {
      syncPayableParam(id, seller)
      void loadFacts(id, seller)
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
      // F-2: verify the loaded payable's own seller — a seller-less
      // before-pay check of seller 2's payable returns seller 1's
      // same-id verdict (and could call a seller-2 payable "ready").
      const res = await api.verify(facts.payable_id, 'before_pay', docSha256, facts.seller)
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
      // B1 (round-4 fix-back): while the config is pending or failed the
      // F-3 gate cannot tell seller 1 from seller 2 — never start a pay
      // with the gate blind. The button is disabled in that state too
      // (payDisabled); this closes the handler path, so a stale enabled
      // button could never start a pay. The seller threaded into the
      // api.pay body below is the last backstop: the server 400s a
      // non-seller-1 write even if this guard is ever bypassed.
      if (config.isPending || config.isError) return
      // F-3: second guard — a second-seller payable is not paid from
      // this UI (the server signs seller 1 only). The pay panel does not
      // render the pay action for it; this closes the handler path too,
      // so a stale enabled button could never start a pay. (Round-3's
      // headline "can never be paid from this UI" overstated this: with
      // the config down the gate was blind and the pay body carried no
      // seller, so a seller-2 pay COULD be issued as seller 1's same-id
      // payable. The true claim now: the UI gates while config is
      // unavailable AND the server 400s a non-seller-1 write.)
      if (seller1 !== undefined && facts.seller !== seller1) return
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
        // B1: thread the loaded facts' seller into the pay body — the
        // server 400s a non-seller-1 write (rejectNonSeller1Write), so a
        // seller-2 payable can never be paid as seller 1's same-id
        // payable even if the client gate was blind when Pay was pressed.
        const job = await api.pay(facts.payable_id, rail, docSha256, facts.seller)
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
    [state.facts, state.invoice, state.check, seller1, config.isPending, config.isError],
  )

  const payDisabled = useCallback(
    (rail: 'ccd' | 'eudemo') => {
      // B1 (round-4 fix-back): the pay step is disabled while the config
      // is pending or failed — the F-3 seller gate cannot run without
      // seller 1's address, and one transient /api/config failure at
      // mount used to leave the gate off for the whole session (retry:
      // 1, 5-min staleTime, no refetch). The plain message says why;
      // the check and the rest of the flow keep working.
      if (config.isPending) return 'The seller list is still loading. Pay is paused until it loads.'
      if (config.isError) return 'The seller list could not be loaded. Pay is paused — reload the page to try again.'
      if (state.check.kind !== 'ready') return 'Run the check first.'
      if (!isCheckFresh(state)) return 'The check is more than 10 minutes old. Check again.'
      return payDisabledReason(
        state,
        rail,
        health.data?.payer.status ?? 'ok',
        health.data?.wallet_eudemo.status ?? 'ok',
      )
    },
    [state, health.data, config.isPending, config.isError],
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
      {sellerMismatch ? (
        <div className="mt-4">
          <AlertInline>{sellerMismatch}</AlertInline>
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
            {isSecondSellerPayable ? (
              // F-3: a second-seller payable is not paid from this UI —
              // server writes are seller-1-only by design (the server
              // signs for seller 1 only), and the pay body carries the
              // seller so the server 400s a non-seller-1 write as the
              // backstop. Show that plainly and offer no pay action at
              // all — never silently load seller 1's same-id payable
              // instead.
              <>
                <div role="alert" className="rounded-md border border-line bg-paper-2 p-4">
                  <p className="text-[15px] font-medium text-ink">
                    This payable belongs to the second seller — it cannot be paid here.
                  </p>
                  <p className="mt-1 text-sm text-muted">
                    Payable {state.facts.payable_id} belongs to the second seller, not seller 1. This UI can only
                    pay seller 1&apos;s payables: the server signs payments for seller 1 only, so a payment for
                    this payable would be refused. You can still check it on the Check tab.
                  </p>
                </div>
                <SecondaryButton onClick={() => goTab('check')}>Back to Check →</SecondaryButton>
              </>
            ) : (
              <>
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
              </>
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
            isSecondSeller={isSecondSellerPayable}
            configUnavailable={configUnavailable}
          />
        </div>
      </div>
    </section>
  )
}
