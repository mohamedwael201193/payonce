// Receipt-verdict evidence gap (fix-back-6 B9/B12) — pins the live
// Payable 1049 shape: blocked 11/14, the only fails are the two
// missing-evidence rows, the transfer fully re-verifies.
import { describe, expect, it } from 'vitest'
import { evidenceGap } from './receiptVerdict'
import type { VerifyResponse } from './types'

function check(id: string, status: 'ok' | 'fail' | 'not_run' | 'info', detail = '') {
  return { id, label: id, status, detail, layer: 'chain' as const }
}

function result(overrides: Partial<VerifyResponse>): VerifyResponse {
  return {
    payable_id: 1049,
    mode: 'after_pay',
    verdict: 'blocked',
    passed: 11,
    total: 14,
    blocked_reason: 'reservation_precedes_transfer',
    checks: [
      check('registered', 'ok'),
      check('doc', 'not_run'),
      check('agent', 'ok'),
      check('registry_zero', 'ok'),
      check('status_paid', 'ok', 'Paid by 4MvdMEGC… at 2026-11-24T23:23:05.593Z'),
      check('tx_finalized', 'ok'),
      check('one_token_transfer', 'ok'),
      check('token_eudemo', 'ok'),
      check('from_payer', 'ok'),
      check('to_payee', 'ok'),
      check('amount', 'ok'),
      check('memo', 'ok'),
      check('reservation_precedes_transfer', 'fail', 'no reserve transaction supplied'),
      check('paid_at_is_confirm_time', 'fail', 'no confirm transaction supplied'),
    ],
    checked_at: '2026-11-25T07:40:00.000Z',
    read_ms: 120,
    ...overrides,
  }
}

describe('evidenceGap', () => {
  it('explains the live 1049 shape: blocked, but only the evidence rows fail', () => {
    const note = evidenceGap(result({}))
    expect(note).toContain('Paid on chain')
    expect(note).toContain('cannot certify the reservation ordering')
    expect(note).toContain('transfer itself re-verifies')
  })

  it('returns null for a paid verdict', () => {
    expect(evidenceGap(result({ verdict: 'paid', blocked_reason: null }))).toBeNull()
  })

  it('returns null when a transfer check fails — then the payment itself is suspect', () => {
    const r = result({})
    r.checks = r.checks.map((c) => (c.id === 'amount' ? { ...c, status: 'fail' as const } : c))
    expect(evidenceGap(r)).toBeNull()
  })

  it('returns null when the paid-status check is not ok', () => {
    const r = result({})
    r.checks = r.checks.map((c) => (c.id === 'status_paid' ? { ...c, status: 'fail' as const } : c))
    expect(evidenceGap(r)).toBeNull()
  })

  it('returns null when only one evidence row fails but a third check fails too', () => {
    const r = result({})
    r.checks = r.checks.map((c) => (c.id === 'agent' ? { ...c, status: 'fail' as const } : c))
    expect(evidenceGap(r)).toBeNull()
  })

  it('accepts a single evidence-row failure (only the reservation row)', () => {
    const r = result({})
    r.checks = r.checks.map((c) =>
      c.id === 'paid_at_is_confirm_time' ? { ...c, status: 'ok' as const } : c,
    )
    expect(evidenceGap(r)).toContain('Paid on chain')
  })

  // Fix-back-7 S1: the note is count-accurate — one failing check names
  // its check and never says "those two checks".
  it('names the single failing check instead of saying "those two checks"', () => {
    const r = result({})
    r.checks = r.checks.map((c) =>
      c.id === 'paid_at_is_confirm_time' ? { ...c, status: 'ok' as const } : c,
    )
    const note = evidenceGap(r)
    expect(note).toContain('the reservation_precedes_transfer check fails closed')
    expect(note).not.toContain('those two checks')
  })

  it('says "those two checks" only when both evidence rows fail', () => {
    expect(evidenceGap(result({}))).toContain('those two checks fail closed')
  })

  // Fix-back-8 MF-3: the missing-records clause is per failed id. When
  // only the reservation check fails, the confirm record EXISTS on the
  // host — the note must name only the reservation record, never "the
  // reservation and confirm records".
  it('names only the reservation record when only the reservation check fails', () => {
    const r = result({})
    r.checks = r.checks.map((c) =>
      c.id === 'paid_at_is_confirm_time' ? { ...c, status: 'ok' as const } : c,
    )
    const note = evidenceGap(r)
    expect(note).toContain('the reservation record for this payment is not on this API host')
    expect(note).not.toContain('the reservation and confirm records')
    expect(note).not.toContain('the confirm record for this payment')
  })

  it('names only the confirm record when only the confirm check fails', () => {
    const r = result({})
    r.checks = r.checks.map((c) =>
      c.id === 'reservation_precedes_transfer' ? { ...c, status: 'ok' as const } : c,
    )
    const note = evidenceGap(r)
    expect(note).toContain('the confirm record for this payment is not on this API host')
    expect(note).not.toContain('the reservation and confirm records')
    expect(note).not.toContain('the reservation record for this payment')
  })

  it('names both records only when both evidence rows fail', () => {
    const note = evidenceGap(result({}))
    expect(note).toContain('the reservation and confirm records for this payment are not on this API host')
  })
})
