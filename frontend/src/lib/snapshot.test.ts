// Live snapshot acceptance (fix-back-6 B1/B11) — the numbers must never
// swing with no user action. Pins the live failure: stats 51/31 vs a
// 13-item list, stats 8/5 vs a 51-item list, and a 51 → 43 shrink.
import { describe, expect, it, vi } from 'vitest'
import { fetchLiveSnapshot, snapshotAccepts } from './snapshot'
import type { InvoiceItem, Stats } from './types'

const item = (id: number, status: 'paid' | 'unpaid'): InvoiceItem => ({
  payable_id: id,
  asset: 'ccd',
  amount_display: '0.500000 CCD',
  due: '2026-12-01T08:03:26.555Z',
  status,
  label: 'Lab invoice',
})

const stats = (total: number, paid: number): Stats => ({
  payables_total: total,
  paid_total: paid,
  refused_on_chain_since_deploy: 21,
  last_verifier_run_at: '2026-11-24T17:08:24.616Z',
  voided_total: 1,
  reserved_total: 5,
})

describe('snapshotAccepts', () => {
  it('accepts a pair that agrees with itself and does not shrink', () => {
    const items = [item(1, 'paid'), item(2, 'unpaid')]
    expect(snapshotAccepts(items, stats(2, 1), 2)).toEqual({ ok: true })
    expect(snapshotAccepts(items, stats(2, 1), 0)).toEqual({ ok: true })
  })

  it('rejects the live partial-list case: stats 51/31 vs a 13-item list', () => {
    const items = Array.from({ length: 13 }, (_, i) => item(i + 1, i < 8 ? 'paid' : 'unpaid'))
    const check = snapshotAccepts(items, stats(51, 31), 51)
    expect(check.ok).toBe(false)
  })

  it('rejects the live partial-stats case: stats 8/5 vs a 51-item list', () => {
    const items = Array.from({ length: 51 }, (_, i) => item(i + 1, i < 31 ? 'paid' : 'unpaid'))
    expect(snapshotAccepts(items, stats(8, 5), 51).ok).toBe(false)
  })

  it('rejects a paid-count disagreement even when the totals agree', () => {
    const items = [item(1, 'paid'), item(2, 'unpaid')]
    expect(snapshotAccepts(items, stats(2, 2), 0).ok).toBe(false)
  })

  it('rejects a shrink even when stats and list agree — payables are append-only', () => {
    // A partial scan that drops the same rows from both endpoints agrees
    // with itself but is still partial: the shrink is the tell.
    const items = Array.from({ length: 43 }, (_, i) => item(i + 1, i < 25 ? 'paid' : 'unpaid'))
    expect(snapshotAccepts(items, stats(43, 25), 51).ok).toBe(false)
  })
})

describe('fetchLiveSnapshot', () => {
  it('retries a disagreeing pair and returns the first agreeing one', async () => {
    const { api } = await import('./api')
    const full = Array.from({ length: 3 }, (_, i) => item(i + 1, i < 2 ? 'paid' : 'unpaid'))
    const partial = [item(1, 'paid')]
    let calls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => {
      calls += 1
      return calls === 1 ? partial : full
    })
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(3, 2))
    const snap = await fetchLiveSnapshot(0, 3)
    expect(snap.items).toHaveLength(3)
    expect(calls).toBe(2)
    vi.restoreAllMocks()
  })

  it('throws after the attempts are exhausted, so the caller keeps the last good snapshot', async () => {
    const { api } = await import('./api')
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [item(1, 'paid')])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(51, 31))
    await expect(fetchLiveSnapshot(51, 2)).rejects.toThrow(/disagreed/)
    vi.restoreAllMocks()
  })
})
