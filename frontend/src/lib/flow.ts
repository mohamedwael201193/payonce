// Flow state machine for the one-screen judge flow (P3 §7).
// Pure reducer — unit-tested in src/lib/flow.test.ts. No API calls here;
// the page dispatches actions around api calls.

import type { JobSnapshot, PayableFacts, VerifyResponse } from './types'

export type InvoiceState =
  | { kind: 'idle' }
  | { kind: 'computing' }
  | { kind: 'loaded'; docText: string; docSha256: string; payableId: number | null }
  | { kind: 'error'; message: string }
  | { kind: 'empty-pool' }

export type CheckState =
  | { kind: 'idle' }
  | { kind: 'running'; done: number; total: number }
  | { kind: 'ready'; result: VerifyResponse }
  | { kind: 'blocked'; result: VerifyResponse }
  | { kind: 'read-failed'; message: string }

export type PayState =
  | { kind: 'idle' }
  | { kind: 'running'; job: JobSnapshot }
  | { kind: 'succeeded'; job: JobSnapshot }
  | { kind: 'refused'; job: JobSnapshot }
  | { kind: 'failed'; job: JobSnapshot | null; message: string }

export interface FlowState {
  invoice: InvoiceState
  facts: PayableFacts | null
  factsState: 'idle' | 'loading' | 'loaded' | 'not-found'
  check: CheckState
  pay: PayState
  /** The verify result is fresh for 10 minutes (P3 §6, Pay in CCD). */
  checkFreshUntil: number | null
  selectedRail: 'ccd' | 'eudemo' | null
}

export const initialFlowState: FlowState = {
  invoice: { kind: 'idle' },
  facts: null,
  factsState: 'idle',
  check: { kind: 'idle' },
  pay: { kind: 'idle' },
  checkFreshUntil: null,
  selectedRail: null,
}

export type FlowAction =
  | { type: 'INVOICE_COMPUTING' }
  | { type: 'INVOICE_LOADED'; docText: string; docSha256: string; payableId: number | null }
  | { type: 'INVOICE_ERROR'; message: string }
  | { type: 'INVOICE_EMPTY_POOL' }
  | { type: 'INVOICE_RESET' }
  | { type: 'FACTS_LOADING' }
  | { type: 'FACTS_LOADED'; facts: PayableFacts }
  | { type: 'FACTS_NOT_FOUND' }
  | { type: 'CHECK_RUNNING'; done: number; total: number }
  | { type: 'CHECK_READY'; result: VerifyResponse }
  | { type: 'CHECK_BLOCKED'; result: VerifyResponse }
  | { type: 'CHECK_READ_FAILED'; message: string }
  | { type: 'PAY_STARTED'; job: JobSnapshot; rail: 'ccd' | 'eudemo' }
  | { type: 'PAY_UPDATED'; job: JobSnapshot }
  | { type: 'PAY_FAILED'; message: string }
  | { type: 'RESET_PAY' }

export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case 'INVOICE_COMPUTING':
      return { ...state, invoice: { kind: 'computing' } }
    case 'INVOICE_LOADED':
      return {
        ...state,
        invoice: {
          kind: 'loaded',
          docText: action.docText,
          docSha256: action.docSha256,
          payableId: action.payableId,
        },
        // A new document invalidates the old check and payment.
        check: { kind: 'idle' },
        pay: { kind: 'idle' },
        checkFreshUntil: null,
      }
    case 'INVOICE_ERROR':
      return { ...state, invoice: { kind: 'error', message: action.message } }
    case 'INVOICE_EMPTY_POOL':
      return { ...state, invoice: { kind: 'empty-pool' } }
    case 'INVOICE_RESET':
      return { ...initialFlowState }
    case 'FACTS_LOADING':
      return { ...state, factsState: 'loading' }
    case 'FACTS_LOADED':
      return { ...state, facts: action.facts, factsState: 'loaded' }
    case 'FACTS_NOT_FOUND':
      return { ...state, facts: null, factsState: 'not-found' }
    case 'CHECK_RUNNING':
      return { ...state, check: { kind: 'running', done: action.done, total: action.total } }
    case 'CHECK_READY':
      return {
        ...state,
        check: { kind: 'ready', result: action.result },
        checkFreshUntil: Date.now() + 10 * 60 * 1000,
      }
    case 'CHECK_BLOCKED':
      return { ...state, check: { kind: 'blocked', result: action.result } }
    case 'CHECK_READ_FAILED':
      return { ...state, check: { kind: 'read-failed', message: action.message } }
    case 'PAY_STARTED':
      return { ...state, pay: { kind: 'running', job: action.job }, selectedRail: action.rail }
    case 'PAY_UPDATED': {
      const job = action.job
      if (job.state === 'succeeded') return { ...state, pay: { kind: 'succeeded', job } }
      if (job.state === 'refused') return { ...state, pay: { kind: 'refused', job } }
      if (job.state === 'failed') return { ...state, pay: { kind: 'failed', job, message: 'The payment job failed.' } }
      return { ...state, pay: { kind: 'running', job } }
    }
    case 'PAY_FAILED':
      return { ...state, pay: { kind: 'failed', job: null, message: action.message } }
    case 'RESET_PAY':
      return { ...state, pay: { kind: 'idle' } }
    default:
      return state
  }
}

/** Is the check fresh enough to pay (P3 §6: check older than 10 min blocks pay)? */
export function isCheckFresh(state: FlowState): boolean {
  return (
    state.check.kind === 'ready' &&
    state.checkFreshUntil !== null &&
    Date.now() < state.checkFreshUntil
  )
}

/** First failing rule for the Pay button, in P3 §6 order. */
export function payDisabledReason(
  state: FlowState,
  rail: 'ccd' | 'eudemo',
  payerStatus: 'ok' | 'low' | 'empty',
  walletEudemoStatus: 'ok' | 'low',
): string | null {
  if (state.check.kind !== 'ready') return 'Run the check first.'
  if (!isCheckFresh(state)) return 'The check is more than 10 minutes old. Check again.'
  const facts = state.facts
  if (!facts) return 'Load an invoice first (step 1).'
  if (facts.status.kind === 'paid') return 'This invoice is already paid.'
  if (facts.status.kind === 'reserved') return 'Reserved for another payment.'
  // Fix-back-8 MF-1: Voided is its own facts kind now — it can never be
  // paid, and the check endpoint blocks it, but the pay gate must say so
  // itself rather than falling through to the rail checks.
  if (facts.status.kind === 'voided') return 'Voided on chain — cannot be paid.'
  if (rail === 'ccd' && facts.asset.kind !== 'ccd')
    return 'This is an EUDemo invoice. Use Pay in EUDemo.'
  if (rail === 'eudemo' && facts.asset.kind !== 'eudemo')
    return 'This is a CCD invoice. Use Pay in CCD.'
  if (rail === 'ccd' && payerStatus !== 'ok')
    return 'The demo payer account is low on testnet CCD.'
  if (rail === 'eudemo' && walletEudemoStatus !== 'ok')
    return 'The demo wallet holds less EUDemo than this invoice.'
  if (state.pay.kind === 'running') return 'A payment is already running.'
  return null
}
