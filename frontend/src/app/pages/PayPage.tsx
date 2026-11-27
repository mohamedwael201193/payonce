// Pay: one screen. Pick an invoice, read the checks, review before paying,
// pay once, and see the verified receipt, without leaving the page. The
// invoice is named by (seller, id) in the URL, so a link always opens the
// invoice it names, and the seller travels on every API call.
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { Navigate, useNavigate, useParams } from 'react-router-dom'
import { useQueryClient } from '@tanstack/react-query'
import { Plus, RefreshCw } from 'lucide-react'
import { api } from '../../lib/api'
import { sha256Hex } from '../../lib/hash'
import { flowReducer, initialFlowState, isCheckFresh, payDisabledReason, type FlowState } from '../../lib/flow'
import { COPY } from '../../lib/copy'
import { formatCountdown, truncHash } from '../../lib/format'
import { ApiError, type PayableFacts } from '../../lib/types'
import { useConfig, useHealth, usePayable, useReceipt } from '../../hooks/useApi'
import { useJobEvents } from '../../hooks/useJobEvents'
import { CheckRows, CheckRowsSkeleton, blockedText } from '../Checks'
import { PayTimeline, RefusalNotice } from '../PayTimeline'
import { ReceiptView } from '../ReceiptView'
import { ccdPayFeeSentence } from '../fees'
import { tidyAmount } from '../format'
import { markMilestone, useAppData, useDocumentTitle, useNow, useSellers, type SellerDirectory } from '../hooks'
import { keyStr, parseKeyPath, payPath, receiptPath, resolveSeller, sellerName, type PayableKey } from '../keys'
import { Address } from '../Address'
import { overdueItems, paidItems, readyToPay } from '../../lib/dashboard'
import {
  Button,
  ButtonLink,
  Card,
  CopyButton,
  EmptyState,
  ExplorerTx,
  KeyValue,
  Notice,
  PageHeader,
  Sheet,
  Skeleton,
  StatusPill,
  useExplorerBase,
} from '../ui'

export function PayPage() {
  useDocumentTitle('Pay - PayOnce')
  const splat = useParams()['*']
  const dir = useSellers()
  const parsed = parseKeyPath(splat)
  const seller = parsed ? resolveSeller(parsed.sellerParam, dir.sellers) : null
  const key: PayableKey | null = parsed && seller ? { seller, id: parsed.id } : null

  // "1" and "2" are shorthand for the sellers in /api/config: the address is
  // the canonical form, so rewrite the URL once it can be resolved.
  if (key && parsed && parsed.sellerParam !== key.seller) {
    return <Navigate to={payPath(key)} replace />
  }

  let body
  if (splat && !parsed) {
    body = (
      <Notice tone="error">
        This pay link is incomplete. A pay link names a seller and a payable number. Pick an invoice below.
      </Notice>
    )
  } else if (parsed && !seller) {
    body = dir.error ? (
      <Notice tone="error">The seller list could not be loaded, so this link cannot be resolved yet. Try again in a moment.</Notice>
    ) : dir.ready ? (
      <Notice tone="error">No seller matches &ldquo;{parsed.sellerParam.slice(0, 24)}&rdquo;. Check the link or pick an invoice below.</Notice>
    ) : (
      <Skeleton className="h-[320px] w-full" />
    )
  } else if (key) {
    body = <PayFlow key={keyStr(key)} k={key} dir={dir} />
  } else {
    body = (
      <EmptyState title="Pick an invoice to start">
        Choose one above. The checks run as soon as it loads, and nothing is paid until you review and confirm.
      </EmptyState>
    )
  }

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Pay an invoice"
        lead="Pick an invoice, read the checks, review, and pay once. Testnet only, and no wallet is needed."
      />
      <Picker current={key} dir={dir} />
      {body}
    </div>
  )
}

// ---------------------------------------------------------------- picker

function Picker({ current, dir }: { current: PayableKey | null; dir: SellerDirectory }) {
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const data = useAppData()
  const health = useHealth()
  const [creating, setCreating] = useState<'ccd' | 'eudemo' | null>(null)
  const [createError, setCreateError] = useState<string | null>(null)

  const ready = useMemo(() => readyToPay(data.items), [data.items])
  const overdue = useMemo(() => overdueItems(data.items).slice(0, 40), [data.items])
  const paid = useMemo(() => paidItems(data.items).slice(0, 40), [data.items])
  const open = ready
  const known = current ? data.items.some((i) => i.seller === current.seller && i.payable_id === current.id) : true
  const label = (i: { seller: string; payable_id: number; amount_display: string; due: string }) =>
    `${sellerName(i.seller, dir.sellers)}, payable ${i.payable_id}, ${tidyAmount(i.amount_display)}`

  const budget = health.data?.budget.new_invoices_left_this_hour
  const createDisabled = budget === 0 ? 'The budget for new invoices is used up for this hour.' : null

  const create = async (asset: 'ccd' | 'eudemo') => {
    setCreating(asset)
    setCreateError(null)
    try {
      const created = await api.createPayable(asset)
      const first = dir.sellers[0]?.seller
      void queryClient.invalidateQueries({ queryKey: ['live-snapshot'] })
      if (first) navigate(payPath({ seller: first, id: created.payable_id }))
    } catch (e) {
      setCreateError(e instanceof ApiError ? e.body.message : 'The testnet did not accept a new invoice just now.')
    } finally {
      setCreating(null)
    }
  }

  return (
    <Card aria-labelledby="picker-title">
      <h2 id="picker-title" className="text-lg font-medium text-po-ink">
        Invoice
      </h2>
      <div className="mt-3 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end">
        <label className="flex flex-col gap-1.5 text-sm text-po-grey">
          Choose from the registry
          <select
            className="po-input"
            value={current ? `${current.seller}|${current.id}` : ''}
            disabled={data.source === 'loading'}
            onChange={(e) => {
              const [s, id] = e.target.value.split('|')
              if (s && id) navigate(payPath({ seller: s, id: Number(id) }))
            }}
          >
            <option value="" disabled>
              {data.source === 'loading' ? 'Reading the registry' : 'Pick an invoice'}
            </option>
            {current && !known ? (
              <option value={`${current.seller}|${current.id}`}>
                {sellerName(current.seller, dir.sellers)}, payable {current.id}
              </option>
            ) : null}
            <optgroup label={`Ready to pay (${ready.length})`}>
              {ready.map((i) => (
                <option key={`${i.seller}|${i.payable_id}`} value={`${i.seller}|${i.payable_id}`}>
                  {label(i)}, due {i.due.slice(0, 10)}
                </option>
              ))}
            </optgroup>
            <optgroup label={`Overdue, latest 40 (${data.items.filter((i) => i.status !== 'paid').length - ready.length} in all)`}>
              {overdue.map((i) => (
                <option key={`${i.seller}|${i.payable_id}`} value={`${i.seller}|${i.payable_id}`}>
                  {label(i)}, due {i.due.slice(0, 10)}
                </option>
              ))}
            </optgroup>
            <optgroup label="Paid, latest 40">
              {paid.map((i) => (
                <option key={`${i.seller}|${i.payable_id}`} value={`${i.seller}|${i.payable_id}`}>
                  {label(i)}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <ButtonLink to="/app/invoices">Browse all invoices</ButtonLink>
      </div>
      {data.source === 'recorded' ? (
        <div className="mt-3">
          <Notice tone="warn">The live API did not answer, so this list is the recorded snapshot. Paying needs the live API.</Notice>
        </div>
      ) : null}
      {open.length === 0 && data.source !== 'loading' ? (
        <p className="mt-3 text-[15px] text-po-grey">No listed invoice is ready to pay: each is paid or past due. Register a new test invoice to pay one.</p>
      ) : null}
      <details className="mt-4">
        <summary className="inline-flex min-h-[44px] cursor-pointer items-center gap-2 text-[15px] font-medium text-po-accent-ink">
          <Plus className="h-4 w-4" aria-hidden="true" /> Register a new test invoice
        </summary>
        <div className="mt-3 flex flex-col gap-3">
          <p className="text-sm text-po-grey">
            This writes a real invoice to the testnet registry for seller 1.{' '}
            {budget !== undefined ? `${budget} left this hour.` : ''}
          </p>
          <div className="flex flex-wrap gap-3">
            <Button small onClick={() => void create('ccd')} busy={creating === 'ccd'} disabled={Boolean(createDisabled) || creating !== null} disabledReason={createDisabled}>
              New CCD invoice
            </Button>
            <Button small onClick={() => void create('eudemo')} busy={creating === 'eudemo'} disabled={Boolean(createDisabled) || creating !== null}>
              New EUDemo invoice
            </Button>
          </div>
          {createError ? <Notice tone="error">{createError}</Notice> : null}
        </div>
      </details>
    </Card>
  )
}

// ---------------------------------------------------------------- flow

function PayFlow({ k, dir }: { k: PayableKey; dir: SellerDirectory }) {
  const payable = usePayable(k.id, k.seller)
  if (payable.isLoading) {
    return (
      <div className="flex flex-col gap-4" aria-label="Loading the invoice" role="status">
        <Skeleton className="h-[200px] w-full" />
        <Skeleton className="h-[260px] w-full" />
      </div>
    )
  }
  if (payable.isError || !payable.data) {
    return (
      <Notice
        tone="error"
        action={
          <Button small onClick={() => void payable.refetch()}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
          </Button>
        }
      >
        {payable.error instanceof ApiError ? payable.error.body.message : 'No payable with this number is on the test registry.'}
      </Notice>
    )
  }
  if (payable.data.seller !== k.seller) {
    return (
      <Notice tone="error">
        This payable belongs to a different seller than the link asked for, so it is not loaded. Check the link.
      </Notice>
    )
  }
  return <PayFlowLoaded k={k} facts={payable.data} dir={dir} />
}

function PayFlowLoaded({ k, facts, dir }: { k: PayableKey; facts: PayableFacts; dir: SellerDirectory }) {
  const [state, dispatch] = useReducer(flowReducer, {
    ...initialFlowState,
    facts,
    factsState: 'loaded',
  } satisfies FlowState)
  const queryClient = useQueryClient()
  const health = useHealth()
  const config = useConfig()
  const explorer = useExplorerBase()
  const [sheetOpen, setSheetOpen] = useState(false)
  const [docText, setDocText] = useState('')
  const [docHash, setDocHash] = useState<string | undefined>(undefined)
  const [payError, setPayError] = useState<string | null>(null)
  const autoRan = useRef(false)
  const receiptRef = useRef<HTMLDivElement>(null)

  const alreadyPaid = facts.status.kind === 'paid'
  const rail = facts.asset.kind
  const sellerOneAddress = dir.sellers[0]?.seller
  // The API signs only for seller 1 ("rejectNonSeller1Write" in the server).
  // Reads, checks and receipts work for every seller.
  const writeUnsupported = Boolean(dir.ready && sellerOneAddress && k.seller !== sellerOneAddress)

  // ---- checks
  const runCheck = useCallback(
    async (hash?: string) => {
      dispatch({ type: 'CHECK_RUNNING', done: 0, total: 9 })
      try {
        const res = await api.verify(facts.payable_id, 'before_pay', hash, k.seller)
        if (res.verdict === 'ready') {
          dispatch({ type: 'CHECK_READY', result: res })
          markMilestone('verified')
        } else {
          dispatch({ type: 'CHECK_BLOCKED', result: res })
        }
      } catch (e) {
        dispatch({
          type: 'CHECK_READ_FAILED',
          message: e instanceof ApiError ? e.body.message : 'We could not read the testnet just now.',
        })
      }
    },
    [facts.payable_id, k.seller],
  )

  useEffect(() => {
    if (autoRan.current || alreadyPaid) return
    autoRan.current = true
    void runCheck(undefined)
  }, [alreadyPaid, runCheck])

  // ---- pay job
  const runningJobId = state.pay.kind === 'running' ? state.pay.job.job_id : null
  const { job: liveJob, error: jobError } = useJobEvents(runningJobId)
  useEffect(() => {
    if (jobError) dispatch({ type: 'PAY_FAILED', message: jobError })
  }, [jobError])
  useEffect(() => {
    if (!liveJob) return
    dispatch({ type: 'PAY_UPDATED', job: liveJob })
    if (liveJob.state === 'succeeded') markMilestone('paid')
    if (liveJob.state !== 'running') {
      void queryClient.invalidateQueries({ queryKey: ['live-snapshot'] })
      void queryClient.invalidateQueries({ queryKey: ['payable', k.id, k.seller] })
      void queryClient.invalidateQueries({ queryKey: ['receipt', k.id, k.seller] })
    }
  }, [liveJob, queryClient, k.id, k.seller])

  const paidNow = state.pay.kind === 'succeeded'
  const showReceipt = alreadyPaid || paidNow
  const receipt = useReceipt(showReceipt ? k.id : null, k.seller)

  const payDisabled = (): string | null => {
    if (writeUnsupported) {
      return 'This API signs payments only for seller 1. Checks and receipts work for every seller.'
    }
    if (state.check.kind === 'running') return 'Reading the chain.'
    if (state.check.kind === 'idle') return 'The checks have not run yet.'
    if (state.check.kind === 'blocked') return `Cannot pay: ${blockedText(state.check.result)}`
    if (state.check.kind === 'read-failed') return 'The checks could not read the chain. Check again.'
    return payDisabledReason(
      { ...state, facts } as FlowState,
      rail,
      health.data?.payer.status ?? 'ok',
      health.data?.wallet_eudemo.status ?? 'ok',
    )
  }
  const reason = payDisabled()

  const onConfirm = async () => {
    setPayError(null)
    if (reason !== null || !isCheckFresh({ ...state, facts } as FlowState)) {
      setPayError(reason ?? 'The check is more than 10 minutes old. Check again.')
      return
    }
    dispatch({ type: 'RESET_PAY' })
    try {
      const job = await api.pay(facts.payable_id, rail, docHash, k.seller)
      dispatch({
        type: 'PAY_STARTED',
        rail,
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
      })
    } catch (e) {
      dispatch({
        type: 'PAY_FAILED',
        message:
          e instanceof ApiError
            ? e.body.message
            : 'Something went wrong on our side. Nothing was sent unless a transaction link appears.',
      })
    }
  }

  const checkOwnCopy = async () => {
    if (!docText.trim()) return
    const hash = await sha256Hex(docText)
    setDocHash(hash)
    await runCheck(hash)
  }
  const useRegistered = () => {
    setDocText('')
    setDocHash(undefined)
    void runCheck(undefined)
  }

  const job = liveJob ?? (state.pay.kind !== 'idle' && state.pay.kind !== 'failed' ? state.pay.job : null)
  const amount = tidyAmount(facts.amount_display)
  const assetLabel = config.data?.assets[rail]?.label ?? (rail === 'ccd' ? 'CCD (testnet)' : 'EUDemo (testnet demo token)')
  const rawPayload = JSON.stringify(
    {
      method: 'POST',
      path: `/api/payables/${facts.payable_id}/pay?seller=${k.seller}`,
      body: { rail, ...(docHash ? { doc_sha256: docHash } : {}) },
    },
    null,
    2,
  )
  const now = useNow(1000)
  const reservedLeft =
    facts.status.kind === 'reserved' ? Math.max(0, Math.floor((new Date(facts.status.expires).getTime() - now) / 1000)) : null

  return (
    <div className="flex flex-col gap-6">
      {/* ---- the invoice */}
      <Card aria-labelledby="inv-facts-title">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h2 id="inv-facts-title" className="text-lg font-medium text-po-ink">
            Payable {facts.payable_id}, {sellerName(k.seller, dir.sellers)}
          </h2>
          <StatusPill tone={facts.status.kind === 'paid' ? 'ok' : facts.status.kind === 'voided' ? 'bad' : 'warn'}>
            {facts.status.kind === 'paid' ? 'Paid' : facts.status.kind === 'reserved' ? 'Reserved' : facts.status.kind === 'voided' ? 'Voided' : 'Open'}
          </StatusPill>
        </div>
        <dl className="mt-2 divide-y divide-po-line">
          <KeyValue label="Amount">{amount}</KeyValue>
          <KeyValue label="Payee, from the chain">
            <Address value={facts.payee} kind="account" label="payee account" expandable />
          </KeyValue>
          <KeyValue label="Invoice hash on chain">
            <Address value={facts.doc_sha256} kind="hash" label="invoice hash" expandable />
          </KeyValue>
          <KeyValue label="Due">{facts.due.slice(0, 10)}</KeyValue>
        </dl>
        {facts.status.kind === 'reserved' ? (
          <div className="mt-3">
            <Notice tone="warn">
              Reserved for another payment{reservedLeft !== null && reservedLeft > 0 ? `, ${formatCountdown(reservedLeft)} left` : ''}. It cannot be paid again until the
              reservation ends.
            </Notice>
          </div>
        ) : null}
        {facts.status.kind === 'voided' ? (
          <div className="mt-3">
            <Notice tone="error">This payable was voided on chain and can never be paid.</Notice>
          </div>
        ) : null}
      </Card>

      {alreadyPaid && !paidNow ? (
        <Notice tone="info">This invoice is already paid, so it cannot be paid again. Its receipt is below.</Notice>
      ) : null}

      {/* ---- checks */}
      {alreadyPaid ? null : (
        <Card aria-labelledby="checks-title">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 id="checks-title" className="text-lg font-medium text-po-ink">
                Checks
              </h2>
              <p className="mt-1 text-[15px] text-po-grey">{COPY.step2Helper}</p>
            </div>
            <Button small onClick={() => void runCheck(docHash)} busy={state.check.kind === 'running'}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Check again
            </Button>
          </div>
          <div className="mt-4 flex flex-col gap-3" aria-live="polite">
            {state.check.kind === 'running' || state.check.kind === 'idle' ? <CheckRowsSkeleton /> : null}
            {state.check.kind === 'read-failed' ? (
              <Notice tone="error">{state.check.message} Nothing was paid. Try again.</Notice>
            ) : null}
            {state.check.kind === 'ready' || state.check.kind === 'blocked' ? (
              <>
                <p className="text-[15px] font-medium text-po-ink" data-testid="check-summary">
                  {state.check.kind === 'ready'
                    ? `All gating checks passed: ${state.check.result.passed} of ${state.check.result.total} checks passed. You can pay once.`
                    : `Cannot pay yet. ${blockedText(state.check.result)}`}
                </p>
                <CheckRows result={state.check.result} />
              </>
            ) : null}
          </div>
          <details className="mt-4">
            <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-[15px] font-medium text-po-accent-ink">
              Check my own copy of the invoice
            </summary>
            <div className="mt-3 flex flex-col gap-3">
              <p className="text-sm text-po-grey">
                Paste the invoice text, or choose a file. Its fingerprint is computed here and compared with the hash on chain.
                The text is not uploaded.
              </p>
              <label className="flex flex-col gap-1.5 text-sm text-po-grey">
                Invoice text
                <textarea
                  className="po-input"
                  value={docText}
                  onChange={(e) => setDocText(e.target.value)}
                  spellCheck={false}
                />
              </label>
              <label className="flex flex-col gap-1.5 text-sm text-po-grey">
                Or choose a text file
                <input
                  type="file"
                  accept=".txt,text/plain"
                  className="po-input py-2"
                  onChange={async (e) => {
                    const f = e.target.files?.[0]
                    if (f) setDocText(await f.text())
                  }}
                />
              </label>
              <div className="flex flex-wrap gap-3">
                <Button small onClick={() => void checkOwnCopy()} disabled={!docText.trim()} disabledReason={!docText.trim() ? 'Paste or choose a copy first.' : null}>
                  Check this copy
                </Button>
                {docHash ? (
                  <Button small onClick={useRegistered}>
                    Use the registered invoice
                  </Button>
                ) : null}
              </div>
              {docHash ? (
                <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-po-ink" data-testid="own-copy-hash">
                  Your copy: <Address value={docHash} kind="hash" label="hash of your copy" explorer={false} />
                  {docHash === facts.doc_sha256 ? 'It matches the hash on chain.' : 'It does not match the hash on chain.'}
                </p>
              ) : null}
            </div>
          </details>
        </Card>
      )}

      {/* ---- pay */}
      {alreadyPaid ? null : (
        <Card aria-labelledby="pay-title">
          <h2 id="pay-title" className="text-lg font-medium text-po-ink">
            Pay
          </h2>
          <p className="mt-1 text-[15px] text-po-grey">
            {rail === 'ccd'
              ? 'CCD rail: one transaction. The contract checks the invoice and sends the full amount to the payee.'
              : 'EUDemo rail: three steps. Reserve the invoice, a co-signer approves one exact transfer, then confirm it on chain.'}
          </p>
          <div className="mt-4 flex flex-wrap items-start gap-4">
            <Button
              id="review-pay"
              variant="primary"
              onClick={() => {
                setPayError(null)
                setSheetOpen(true)
              }}
              disabled={reason !== null || state.pay.kind === 'running'}
              disabledReason={reason}
            >
              Review and pay {amount}
            </Button>
          </div>
          {job && !sheetOpen ? (
            <div className="mt-5 flex flex-col gap-4" aria-live="polite">
              <PayTimeline job={job} explorerBase={explorer} />
              {state.pay.kind === 'refused' ? <RefusalNotice job={state.pay.job} explorerBase={explorer} /> : null}
            </div>
          ) : null}
          {state.pay.kind === 'failed' && !sheetOpen ? (
            <div className="mt-4">
              <Notice
                tone="error"
                action={
                  <Button small onClick={() => dispatch({ type: 'RESET_PAY' })}>
                    Try again
                  </Button>
                }
              >
                {state.pay.message}
              </Notice>
            </div>
          ) : null}
        </Card>
      )}

      {/* ---- verified receipt, inline */}
      {showReceipt ? (
        <div ref={receiptRef} className="flex flex-col gap-4">
          {receipt.isLoading ? (
            <Skeleton className="h-[320px] w-full" />
          ) : receipt.isError || !receipt.data ? (
            <Notice
              tone="error"
              action={
                <Button small onClick={() => void receipt.refetch()}>
                  Try again
                </Button>
              }
            >
              The payment is recorded, but the receipt could not be loaded just now.
            </Notice>
          ) : (
            <ReceiptView keyOf={k} receipt={receipt.data} facts={facts} sellers={dir.sellers} />
          )}
          <div>
            <ButtonLink to={receiptPath(k)}>Open the receipt page</ButtonLink>
          </div>
        </div>
      ) : null}

      {/* ---- review sheet */}
      <Sheet
        open={sheetOpen}
        onClose={() => setSheetOpen(false)}
        title="Review before paying"
        initialFocusId={state.pay.kind === 'idle' ? 'sheet-confirm' : 'sheet-close'}
      >
        {state.pay.kind === 'idle' ? (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-2xl font-medium tracking-[-0.01em] text-po-ink">Review before paying</h2>
              <p className="mt-1 text-[15px] text-po-grey">Nothing moves until you confirm. This is a testnet payment.</p>
            </div>
            <dl className="divide-y divide-po-line rounded-[10px] border border-po-line bg-po-paper px-4">
              <KeyValue label="Payee">
                <Address value={facts.payee} kind="account" label="payee account" expandable />
              </KeyValue>
              <KeyValue label="Amount">{amount}</KeyValue>
              <KeyValue label="Currency">{assetLabel}</KeyValue>
              <KeyValue label="Network">Concordium testnet</KeyValue>
              <KeyValue label="Invoice hash">
                <Address value={docHash ?? facts.doc_sha256} kind="hash" label="invoice hash" expandable />
              </KeyValue>
              <KeyValue label="Seller">{sellerName(k.seller, dir.sellers)}</KeyValue>
            </dl>
            <p className="text-sm text-po-grey">
              {rail === 'ccd' ? `${COPY.step3RailANote} ${ccdPayFeeSentence()}` : COPY.step3RailBNote}
            </p>
            <details>
              <summary className="inline-flex min-h-[44px] cursor-pointer items-center text-[15px] font-medium text-po-accent-ink">
                Show the exact request
              </summary>
              <pre className="mt-2 overflow-x-auto rounded-[10px] bg-po-ink p-3 font-mono text-xs text-po-paper">{rawPayload}</pre>
              <div className="mt-2">
                <CopyButton value={rawPayload} label="request" />
              </div>
            </details>
            {payError ? <Notice tone="error">{payError}</Notice> : null}
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button onClick={() => setSheetOpen(false)}>Cancel</Button>
              <Button id="sheet-confirm" variant="primary" onClick={() => void onConfirm()}>
                Pay {amount} on testnet
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            <div>
              <h2 className="text-2xl font-medium tracking-[-0.01em] text-po-ink">
                {state.pay.kind === 'succeeded' ? 'Paid once' : state.pay.kind === 'running' ? 'Paying' : state.pay.kind === 'refused' ? 'Refused' : 'Payment stopped'}
              </h2>
              <p className="mt-1 text-[15px] text-po-grey" aria-live="polite">
                {state.pay.kind === 'running'
                  ? job?.steps.some((s) => s.txHash)
                    ? 'A transaction is on the chain. Waiting for it to finalize.'
                    : 'Pending. No transaction has been seen yet.'
                  : state.pay.kind === 'succeeded'
                    ? 'The chain confirmed the payment.'
                    : null}
              </p>
            </div>
            {job ? <PayTimeline job={job} explorerBase={explorer} /> : null}
            {state.pay.kind === 'refused' ? <RefusalNotice job={state.pay.job} explorerBase={explorer} /> : null}
            {state.pay.kind === 'failed' ? <Notice tone="error">{state.pay.message}</Notice> : null}
            {job?.steps
              .filter((s) => s.txHash)
              .slice(-1)
              .map((s) => (
                <p key={s.txHash} className="text-sm text-po-grey">
                  Latest transaction: <ExplorerTx hash={s.txHash as string} base={explorer} label={truncHash(s.txHash as string)} />
                </p>
              ))}
            <div className="flex flex-col-reverse gap-3 sm:flex-row sm:justify-end">
              <Button
                id="sheet-close"
                variant={state.pay.kind === 'succeeded' ? 'primary' : 'ghost'}
                onClick={() => {
                  setSheetOpen(false)
                  if (state.pay.kind === 'succeeded') {
                    window.setTimeout(() => receiptRef.current?.scrollIntoView({ block: 'start' }), 50)
                  }
                  if (state.pay.kind === 'failed' || state.pay.kind === 'refused') dispatch({ type: 'RESET_PAY' })
                }}
                disabled={state.pay.kind === 'running'}
                disabledReason={state.pay.kind === 'running' ? 'The payment is still running.' : null}
              >
                {state.pay.kind === 'succeeded' ? 'See the receipt' : 'Close'}
              </Button>
            </div>
          </div>
        )}
      </Sheet>
    </div>
  )
}

