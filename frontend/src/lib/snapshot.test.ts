// Live snapshot acceptance (fix-back-6 B1/B11, corrected fix-back-7
// MF-1/MF-2/MF-4) — the numbers must never swing with no user action.
// Pins the live failure: stats 51/31 vs a 13-item list, stats 8/5 vs a
// 51-item list, and a 51 → 43 shrink. Fix-back-7 corrects the shrink
// premise: a reserve or a void legitimately removes a row from the
// listable set (Unpaid|Paid only), so a shrink exactly accounted for by
// voided+reserved growth is accepted — anything else is still a partial
// scan. Also pins: an endpoint throw retries in-loop (MF-2), and an
// empty pair on cold load is rejected, never rendered as 0/0 (MF-4).
import { describe, expect, it, vi } from 'vitest'
import { fetchLiveSnapshot, snapshotAccepts, type PrevSnapshot } from './snapshot'
import type { InvoiceItem, Stats } from './types'

const item = (id: number, status: 'paid' | 'unpaid'): InvoiceItem => ({
  payable_id: id,
  asset: 'ccd',
  amount_display: '0.500000 CCD',
  due: '2026-12-01T08:03:26.555Z',
  status,
  label: 'Lab invoice',
})

const stats = (total: number, paid: number, voided = 1, reserved = 5): Stats => ({
  payables_total: total,
  paid_total: paid,
  refused_on_chain_since_deploy: 21,
  last_verifier_run_at: '2026-11-24T17:08:24.616Z',
  voided_total: voided,
  reserved_total: reserved,
})

const prev = (count: number, voided = 1, reserved = 5): PrevSnapshot => ({
  count,
  voidedTotal: voided,
  reservedTotal: reserved,
})

const listOf = (n: number, paidCount: number): InvoiceItem[] =>
  Array.from({ length: n }, (_, i) => item(i + 1, i < paidCount ? 'paid' : 'unpaid'))

describe('snapshotAccepts', () => {
  it('accepts a pair that agrees with itself and does not shrink', () => {
    const items = [item(1, 'paid'), item(2, 'unpaid')]
    expect(snapshotAccepts(items, stats(2, 1), prev(2))).toEqual({ ok: true })
    expect(snapshotAccepts(items, stats(2, 1))).toEqual({ ok: true })
  })

  it('rejects the live partial-list case: stats 51/31 vs a 13-item list', () => {
    const items = listOf(13, 8)
    const check = snapshotAccepts(items, stats(51, 31), prev(51))
    expect(check.ok).toBe(false)
  })

  it('rejects the live partial-stats case: stats 8/5 vs a 51-item list', () => {
    const items = listOf(51, 31)
    expect(snapshotAccepts(items, stats(8, 5), prev(51)).ok).toBe(false)
  })

  it('rejects a paid-count disagreement even when the totals agree', () => {
    const items = [item(1, 'paid'), item(2, 'unpaid')]
    expect(snapshotAccepts(items, stats(2, 2), prev(0)).ok).toBe(false)
  })

  // MF-1: the adversarial judge's reserve case — a self-consistent 50/31
  // pair with reserved 5 → 6 (one payable reserved since the last
  // snapshot) is a LEGITIMATE shrink and must be accepted, not frozen.
  it('accepts a shrink exactly accounted for by a reserve (reserved 5 → 6)', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 1, 6), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // MF-1: the adversarial judge's void case — voided 1 → 2, same shape.
  it('accepts a shrink exactly accounted for by a void (voided 1 → 2)', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 2, 5), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // MF-1: two rows leave at once (one reserved, one voided) — accepted
  // only because the excluded growth (2) equals the shrink (2).
  it('accepts a shrink accounted for by one reserve plus one void', () => {
    const items = listOf(49, 30)
    expect(snapshotAccepts(items, stats(49, 30, 2, 6), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // MF-1, negative: the fix-back-6 shrink — 51 → 43 with NO excluded
  // growth — is still a partial scan and is still rejected. A partial
  // scan that drops the same rows from both endpoints agrees with
  // itself, but the shrink is the tell.
  it('rejects a shrink with no voided/reserved growth — still a partial scan', () => {
    const items = listOf(43, 25)
    expect(snapshotAccepts(items, stats(43, 25, 1, 5), prev(51, 1, 5)).ok).toBe(false)
  })

  // MF-1, negative: a shrink SMALLER than the excluded growth is also
  // inconsistent (rows cannot leave the list without leaving the count).
  it('rejects a shrink smaller than the voided/reserved growth', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 3, 6), prev(51, 1, 5)).ok).toBe(false)
  })

  // MF-4: an empty pair on cold load is rejected — with no previous
  // snapshot there is nothing to distinguish an empty registry from a
  // failed scan, and 0/0 must never render as totals.
  it('rejects an empty pair on cold load — never 0/0 as totals', () => {
    expect(snapshotAccepts([], stats(0, 0, 0, 0)).ok).toBe(false)
    expect(snapshotAccepts([], stats(0, 0, 0, 0), prev(0, 0, 0)).ok).toBe(false)
  })
})

describe('fetchLiveSnapshot', () => {
  it('retries a disagreeing pair and returns the first agreeing one', async () => {
    const { api } = await import('./api')
    const full = listOf(3, 2)
    const partial = [item(1, 'paid')]
    let calls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => {
      calls += 1
      return calls === 1 ? partial : full
    })
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(3, 2))
    const snap = await fetchLiveSnapshot(undefined, 3)
    expect(snap.items).toHaveLength(3)
    expect(calls).toBe(2)
    vi.restoreAllMocks()
  })

  it('throws after the attempts are exhausted, so the caller keeps the last good snapshot', async () => {
    const { api } = await import('./api')
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [item(1, 'paid')])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(51, 31))
    await expect(fetchLiveSnapshot(prev(51), 2)).rejects.toThrow(/disagreed/)
    vi.restoreAllMocks()
  })

  // MF-2: a throw from either endpoint retries in-loop (3 attempts),
  // instead of aborting after 1 call.
  it('retries when an endpoint throws, and succeeds when it recovers', async () => {
    const { api } = await import('./api')
    const full = listOf(3, 2)
    let calls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => {
      calls += 1
      if (calls < 3) throw new Error('invoices 503')
      return full
    })
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(3, 2))
    const snap = await fetchLiveSnapshot(undefined, 3)
    expect(snap.items).toHaveLength(3)
    expect(calls).toBe(3)
    vi.restoreAllMocks()
  })

  it('throws after 3 attempts when an endpoint keeps throwing', async () => {
    const { api } = await import('./api')
    let calls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => {
      calls += 1
      throw new Error('invoices 503')
    })
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(3, 2))
    await expect(fetchLiveSnapshot(undefined, 3)).rejects.toThrow(/disagreed/)
    expect(calls).toBe(3)
    vi.restoreAllMocks()
  })

  // MF-4 at the fetch level: an empty cold-load pair is retried and then
  // throws — the page shows its error state, never 0/0 as totals.
  it('rejects an empty cold-load pair after the attempts are exhausted', async () => {
    const { api } = await import('./api')
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(0, 0, 0, 0))
    await expect(fetchLiveSnapshot(undefined, 2)).rejects.toThrow(/disagreed/)
    vi.restoreAllMocks()
  })

  // MF-1 at the fetch level: a legit reserve shrink is accepted on the
  // first attempt — no freeze, no retry storm.
  it('accepts a legit reserve shrink without retrying', async () => {
    const { api } = await import('./api')
    let calls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => {
      calls += 1
      return listOf(50, 31)
    })
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 1, 6))
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(50)
    expect(calls).toBe(1)
    vi.restoreAllMocks()
  })
})
