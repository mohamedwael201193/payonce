// Sticky bottom bar derivation (P3 §12) — the bar carries the current
// primary action only.
import { describe, expect, it } from 'vitest'
import { flowReducer, initialFlowState } from './flow'
import { stickyActionFor } from './sticky'
import type { PayableFacts, VerifyResponse } from './types'

const verifyResult = (): VerifyResponse => ({
  payable_id: 3,
  mode: 'before_pay',
  verdict: 'ready',
  passed: 9,
  total: 9,
  blocked_reason: null,
  checks: [],
  checked_at: '2026-11-24T10:42:07Z',
  read_ms: 120,
})

const facts = (status: PayableFacts['status'], asset: 'ccd' | 'eudemo' = 'eudemo'): PayableFacts => ({
  payable_id: 3,
  asset: { kind: asset, token: asset === 'ccd' ? 'CCD' : 'EUDemo' },
  amount: '10000',
  amount_display: asset === 'ccd' ? '0.5 CCD' : '0.01 EUDemo',
  payee: 'PAYEE-PLACEHOLDER',
  seller: 'SELLER-PLACEHOLDER',
  due: '2026-11-25T04:49:53.537Z',
  is_past_due: false,
  status,
  agent: { registry: { index: 13144, subindex: 0 }, token: '01000000' },
  doc_sha256: 'f03a6ac7',
  label: 'Lab invoice 3',
})

const noPayBlock = () => null

describe('stickyActionFor', () => {
  it('asks to check first when nothing is loaded', () => {
    const a = stickyActionFor(initialFlowState, null, false, noPayBlock)
    expect(a).toEqual({ kind: 'check', label: 'Check invoice', disabledReason: 'Load an invoice first (step 1).' })
  })

  it('offers Check invoice when facts are loaded but the check has not run', () => {
    const a = stickyActionFor(initialFlowState, facts({ kind: 'unpaid' }), false, noPayBlock)
    expect(a.kind).toBe('check')
    expect(a.disabledReason).toBeNull()
  })

  it('offers Pay in EUDemo with the amount once the check is ready and fresh', () => {
    const s = flowReducer(
      { ...initialFlowState, facts: facts({ kind: 'unpaid' }), factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult() },
    )
    const a = stickyActionFor(s, facts({ kind: 'unpaid' }), false, noPayBlock)
    expect(a).toEqual({
      kind: 'pay',
      label: 'Pay in EUDemo (0.01 EUDemo)',
      rail: 'eudemo',
      disabledReason: null,
    })
  })

  it('offers Pay in CCD for a CCD invoice', () => {
    const s = flowReducer(
      { ...initialFlowState, facts: facts({ kind: 'unpaid' }, 'ccd'), factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult() },
    )
    const a = stickyActionFor(s, facts({ kind: 'unpaid' }, 'ccd'), false, noPayBlock)
    expect(a.kind).toBe('pay')
    expect((a as { label: string }).label).toBe('Pay in CCD (0.5 CCD)')
  })

  it('does not offer Pay for an already-paid invoice', () => {
    const paid = facts({
      kind: 'paid',
      payer: 'x',
      paid_at: '2026-11-24T10:00:00Z',
      payment_tx: '00e0',
      payment_tx_source: 'chain',
    })
    const s = flowReducer(
      { ...initialFlowState, facts: paid, factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult() },
    )
    const a = stickyActionFor(s, paid, false, noPayBlock)
    expect(a.kind).toBe('check')
  })

  it('carries the pay-disabled reason through (e.g. low payer)', () => {
    const s = flowReducer(
      { ...initialFlowState, facts: facts({ kind: 'unpaid' }), factsState: 'loaded' },
      { type: 'CHECK_READY', result: verifyResult() },
    )
    const a = stickyActionFor(s, facts({ kind: 'unpaid' }), false, () => 'The demo wallet holds less EUDemo than this invoice.')
    expect(a.kind).toBe('pay')
    expect(a.disabledReason).toBe('The demo wallet holds less EUDemo than this invoice.')
  })

  it('offers Check again on chain once a receipt exists', () => {
    const a = stickyActionFor(initialFlowState, facts({ kind: 'paid', payer: 'x', paid_at: '2026-11-24T10:00:00Z', payment_tx: '00e0', payment_tx_source: 'chain' }), true, noPayBlock)
    expect(a).toEqual({ kind: 'check-again', label: 'Check again on chain', disabledReason: null })
  })

  it('shows a busy state while a payment runs', () => {
    const s = { ...initialFlowState, pay: { kind: 'running' as const, job: { job_id: 'j', payable_id: 3, rail: 'eudemo' as const, state: 'running' as const, steps: [], outcome: null, started_at: '2026-11-24T10:42:07Z', finished_at: null } } }
    const a = stickyActionFor(s, facts({ kind: 'unpaid' }), false, noPayBlock)
    expect(a.kind).toBe('busy')
    expect(a.label).toBe('Payment running…')
  })
})
