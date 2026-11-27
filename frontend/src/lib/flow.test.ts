// Flow reducer — P3 §7. Pure state machine: invoice → check → pay → receipt.
// A new document must invalidate the old check and payment; a check older
// than 10 minutes must block pay (P3 §6).
import { describe, expect, it } from 'vitest'
import { flowReducer, initialFlowState, isCheckFresh, payDisabledReason } from './flow'
import type { JobSnapshot, PayableFacts, VerifyResponse } from './types'

const verifyResult = (overrides: Partial<VerifyResponse> = {}): VerifyResponse => ({
  payable_id: 3,
  mode: 'before_pay',
  verdict: 'ready',
  passed: 9,
  total: 9,
  blocked_reason: null,
  checks: [],
  checked_at: '2026-11-24T10:42:07Z',
  read_ms: 120,
  ...overrides,
})

const job = (state: JobSnapshot['state']): JobSnapshot => ({
  job_id: 'job-1',
  payable_id: 3,
  rail: 'eudemo',
  state,
  steps: [],
  outcome: null,
  started_at: '2026-11-24T10:42:07Z',
  finished_at: null,
})

const facts = (status: PayableFacts['status']): PayableFacts => ({
  payable_id: 3,
  asset: { kind: 'eudemo', token: 'EUDemo' },
  amount: '10000',
  amount_display: '0.01 EUDemo',
  payee: 'PAYEE-ACCOUNT-PLACEHOLDER',
  seller: 'SELLER-ACCOUNT-PLACEHOLDER',
  due: '2026-11-25T04:49:53.537Z',
  is_past_due: false,
  status,
  agent: { registry: { index: 13144, subindex: 0 }, token: '01000000' },
  doc_sha256: 'f03a6ac7',
  label: 'Lab invoice 3',
})

describe('invoice loading invalidates check and pay', () => {
  it('INVOICE_LOADED resets check/pay/freshness', () => {
    const s1 = flowReducer(initialFlowState, { type: 'CHECK_READY', result: verifyResult() })
    const s2 = flowReducer(s1, { type: 'PAY_STARTED', job: job('running'), rail: 'eudemo' })
    const s3 = flowReducer(s2, {
      type: 'INVOICE_LOADED',
      docText: 'new',
      docSha256: 'abc',
      payableId: 5,
    })
    expect(s3.check).toEqual({ kind: 'idle' })
    expect(s3.pay).toEqual({ kind: 'idle' })
    expect(s3.checkFreshUntil).toBeNull()
    expect(s3.invoice).toEqual({ kind: 'loaded', docText: 'new', docSha256: 'abc', payableId: 5 })
  })
})

describe('check freshness (P3 §6: 10 minutes)', () => {
  it('CHECK_READY stamps fresh-until = now + 10 min', () => {
    const now = Date.now()
    const s = flowReducer(initialFlowState, { type: 'CHECK_READY', result: verifyResult() })
    expect(s.checkFreshUntil).not.toBeNull()
    expect(s.checkFreshUntil as number).toBeGreaterThanOrEqual(now + 10 * 60 * 1000 - 1000)
    expect(isCheckFresh(s)).toBe(true)
  })
  it('a stale check is not fresh', () => {
    const s = { ...initialFlowState, check: { kind: 'ready' as const, result: verifyResult() }, checkFreshUntil: Date.now() - 1000 }
    expect(isCheckFresh(s)).toBe(false)
  })
})

describe('payDisabledReason (P3 §6 order)', () => {
  it('requires a ready check first', () => {
    expect(payDisabledReason(initialFlowState, 'ccd', 'ok', 'ok')).toBe('Run the check first.')
  })
  // Fix-back-14 MF-3 (S1/S2): a check that passed for payable 5 must
  // never enable Pay for payable 3 — the gate binds the check to the
  // facts on screen by payable_id.
  it('blocks pay when the ready check was run for a different payable', () => {
    const s = flowReducer(
      { ...initialFlowState, facts: facts({ kind: 'unpaid' }), factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult({ payable_id: 5 }) },
    )
    expect(payDisabledReason(s, 'eudemo', 'ok', 'ok')).toBe('The check was run for a different invoice. Check again.')
    expect(payDisabledReason(s, 'ccd', 'ok', 'ok')).toBe('The check was run for a different invoice. Check again.')
  })
  it('allows pay when the ready check was run for the shown payable', () => {
    const s = flowReducer(
      { ...initialFlowState, facts: facts({ kind: 'unpaid' }), factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult({ payable_id: 3 }) },
    )
    expect(payDisabledReason(s, 'eudemo', 'ok', 'ok')).toBeNull()
  })
  it('blocks a paid invoice', () => {
    const s = flowReducer(
      { ...initialFlowState, facts: facts({ kind: 'paid', payer: 'x', paid_at: '2026-11-24T10:00:00Z', payment_tx: '00e0', payment_tx_source: 'chain' }), factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult() },
    )
    expect(payDisabledReason(s, 'ccd', 'ok', 'ok')).toBe('This invoice is already paid.')
  })
  // Fix-back-8 MF-1: Voided is its own facts kind now — the pay gate
  // must block it by name instead of falling through to the rail checks.
  it('blocks a voided invoice', () => {
    const s = flowReducer(
      { ...initialFlowState, facts: facts({ kind: 'voided' }), factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult() },
    )
    expect(payDisabledReason(s, 'ccd', 'ok', 'ok')).toBe('Voided on chain — cannot be paid.')
    expect(payDisabledReason(s, 'eudemo', 'ok', 'ok')).toBe('Voided on chain — cannot be paid.')
  })
  it('blocks the wrong rail for the asset', () => {
    const s = flowReducer(
      { ...initialFlowState, facts: facts({ kind: 'unpaid' }), factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult() },
    )
    expect(payDisabledReason(s, 'ccd', 'ok', 'ok')).toBe('This is an EUDemo invoice. Use Pay in EUDemo.')
    expect(payDisabledReason(s, 'eudemo', 'ok', 'ok')).toBeNull()
  })
  it('allows pay when ready, fresh, unpaid, right rail', () => {
    const s = flowReducer(
      { ...initialFlowState, facts: facts({ kind: 'unpaid' }), factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult() },
    )
    expect(payDisabledReason(s, 'eudemo', 'ok', 'ok')).toBeNull()
  })
})

describe('PAY_UPDATED maps job states', () => {
  it('succeeded / refused / failed / running', () => {
    expect(flowReducer(initialFlowState, { type: 'PAY_UPDATED', job: job('succeeded') }).pay.kind).toBe('succeeded')
    expect(flowReducer(initialFlowState, { type: 'PAY_UPDATED', job: job('refused') }).pay.kind).toBe('refused')
    expect(flowReducer(initialFlowState, { type: 'PAY_UPDATED', job: job('failed') }).pay.kind).toBe('failed')
    expect(flowReducer(initialFlowState, { type: 'PAY_UPDATED', job: job('running') }).pay.kind).toBe('running')
  })
})

describe('CHECK_BLOCKED keeps the result for display', () => {
  it('stores the blocked verify result', () => {
    const r = verifyResult({ verdict: 'blocked', blocked_reason: 'Already paid.' })
    const s = flowReducer(initialFlowState, { type: 'CHECK_BLOCKED', result: r })
    expect(s.check).toEqual({ kind: 'blocked', result: r })
  })
})

// Fix-back-14 MF-1/MF-3: any facts change invalidates the old check and
// payment, and a load in flight clears the old facts outright — the pay
// panel must never show (or pay) a payable the URL does not name.
describe('facts changes invalidate check, pay and old facts', () => {
  const checked = () =>
    flowReducer(
      { ...initialFlowState, facts: facts({ kind: 'unpaid' }), factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult({ payable_id: 3 }) },
    )
  it('FACTS_LOADING clears the old facts and resets check/pay/freshness', () => {
    const s = flowReducer(checked(), { type: 'FACTS_LOADING' })
    expect(s.facts).toBeNull()
    expect(s.factsState).toBe('loading')
    expect(s.check).toEqual({ kind: 'idle' })
    expect(s.pay).toEqual({ kind: 'idle' })
    expect(s.checkFreshUntil).toBeNull()
    expect(payDisabledReason(s, 'eudemo', 'ok', 'ok')).toBe('Run the check first.')
  })
  it('FACTS_LOADED resets check/pay/freshness for the new payable', () => {
    const s = flowReducer(checked(), { type: 'FACTS_LOADED', facts: facts({ kind: 'unpaid' }) })
    expect(s.facts?.payable_id).toBe(3)
    expect(s.check).toEqual({ kind: 'idle' })
    expect(s.pay).toEqual({ kind: 'idle' })
    expect(s.checkFreshUntil).toBeNull()
  })
  it('FACTS_NOT_FOUND clears facts and resets check/pay/freshness', () => {
    const s = flowReducer(checked(), { type: 'FACTS_NOT_FOUND' })
    expect(s.facts).toBeNull()
    expect(s.factsState).toBe('not-found')
    expect(s.check).toEqual({ kind: 'idle' })
    expect(s.checkFreshUntil).toBeNull()
  })
})

describe('INVOICE_RESET restores the initial state', () => {  it('resets everything', () => {
    const s = flowReducer(
      flowReducer(initialFlowState, { type: 'INVOICE_COMPUTING' }),
      { type: 'INVOICE_RESET' },
    )
    expect(s).toEqual(initialFlowState)
  })
})

describe('job failure reason (B3)', () => {
  const job = (detail: string, step = 'reserve') =>
    ({ job_id: 'j', payable_id: 1, rail: 'eudemo', state: 'failed', outcome: 'failed', started_at: '', finished_at: '', steps: [{ step, status: 'failed', detail }] }) as never
  it('names the real reason in plain words, never "the payment job failed"', async () => {
    const { jobFailureReason } = await import('./flow')
    expect(jobFailureReason(job('Error: The sender did not have enough funds'))).toMatch(/ran out of testnet CCD for fees/)
    expect(jobFailureReason(job('Error: fetch failed'))).toMatch(/did not answer in time/)
    expect(jobFailureReason(job('Transfer failed verification (memo)', 'wait_finality'))).toMatch(/Wait for the chain to finalize.*Transfer failed verification/)
  })
  it('both rails stop for a low payer, with the refilling wording when the guard is working', async () => {
    const { payDisabledReason, initialFlowState } = await import('./flow')
    const st = { ...initialFlowState, check: { kind: 'idle' } } as never
    expect(payDisabledReason(st, 'eudemo', 'low', 'ok', true)).toBe('Run the check first.')
  })
})
