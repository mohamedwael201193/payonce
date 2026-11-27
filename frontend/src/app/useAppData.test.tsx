// First paint without long skeletons, and no silent dataset flips.
//  - nothing cached, API slow: skeleton, then the labelled RECORDED snapshot
//    after FALLBACK_AFTER_MS, then ONE switch to live with a notice
//  - cached copy in this browser: painted at once as CACHED (no skeleton)
//  - successive polls of the same API scan: byte-identical numbers, no notice
//  - a cached/live pair with the same totals switches without a notice
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { api } from '../lib/api'
import type { InvoiceItem, Stats } from '../lib/types'
import { FALLBACK_AFTER_MS, useAppData } from './hooks'

const SELLER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'
const item = (id: number, status: 'paid' | 'unpaid', kind: 'demo' | 'lab' = 'lab'): InvoiceItem => ({
  seller: SELLER,
  payable_id: id,
  asset: 'ccd',
  amount_display: '0.500000 CCD',
  due: '2030-12-01T08:03:26.555Z',
  status,
  label: 'Lab invoice',
  kind,
})
const LIVE_ITEMS = [item(10, 'paid', 'demo'), item(11, 'unpaid', 'demo'), item(1000, 'paid'), item(1001, 'unpaid'), item(1002, 'paid')]
const liveStats = (scan = 's1'): Stats => ({
  payables_total: 5,
  paid_total: 3,
  refused_on_chain_since_deploy: 23,
  last_verifier_run_at: null,
  voided_total: 0,
  reserved_total: 0,
  scan_id: scan,
  complete: true,
  generated_at: '2026-11-27T10:00:00.000Z',
  by_kind: { demo: { total: 2, paid: 1 }, matrix: { total: 0, paid: 0 }, lab: { total: 3, paid: 2 }, test_runs: { total: 3, paid: 2 } },
})
function mockApi(scan = 's1', delayMs = 0) {
  vi.spyOn(api, 'getInvoices').mockImplementation(async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    const items = [...LIVE_ITEMS]
    Object.defineProperty(items, 'scanMeta', { value: { scan_id: scan, complete: true, generated_at: '2026-11-27T10:00:00.000Z' }, enumerable: false })
    return items
  })
  vi.spyOn(api, 'getStats').mockImplementation(async () => {
    if (delayMs) await new Promise((r) => setTimeout(r, delayMs))
    return liveStats(scan)
  })
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}
const advance = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })

beforeEach(() => {
  vi.useFakeTimers()
  window.localStorage.clear()
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

describe('useAppData first paint', () => {
  it('nothing cached and a slow API: loading, then RECORDED, then ONE switch to live with a notice', async () => {
    mockApi('s1', 6_000)
    const { result } = renderHook(() => useAppData(), { wrapper })
    expect(result.current.source).toBe('loading')
    await advance(FALLBACK_AFTER_MS + 100)
    expect(result.current.source).toBe('recorded')
    expect(result.current.switched).toBeNull()
    const recordedTotal = result.current.stats?.payables_total
    await advance(7_000)
    expect(result.current.source).toBe('live')
    expect(result.current.stats?.payables_total).toBe(5)
    expect(result.current.switched).toMatchObject({ from: 'recorded', fromTotal: recordedTotal, toTotal: 5, toPaid: 3 })
  })

  it('a fast API paints live straight away: no recorded snapshot, no notice', async () => {
    mockApi('s1', 0)
    const { result } = renderHook(() => useAppData(), { wrapper })
    await advance(50)
    expect(result.current.source).toBe('live')
    await advance(FALLBACK_AFTER_MS + 100)
    expect(result.current.source).toBe('live')
    expect(result.current.switched).toBeNull()
  })

  it('a cached copy paints at once as CACHED and is replaced by live with a notice when totals differ', async () => {
    const items = [item(10, 'paid', 'demo'), item(1000, 'unpaid')]
    window.localStorage.setItem(
      'po.app-snapshot.v1',
      JSON.stringify({ items, stats: { ...liveStats('old'), payables_total: 2, paid_total: 1 }, scanId: 'old', generatedAt: '2026-11-26T09:00:00.000Z', savedAt: '2026-11-26T09:00:05.000Z' }),
    )
    mockApi('s1', 3_000)
    const { result } = renderHook(() => useAppData(), { wrapper })
    expect(result.current.source).toBe('cached')
    expect(result.current.stats?.payables_total).toBe(2)
    expect(result.current.asOf).toBe('2026-11-26T09:00:00.000Z')
    await advance(4_000)
    expect(result.current.source).toBe('live')
    expect(result.current.switched).toMatchObject({ from: 'cached', fromTotal: 2, toTotal: 5 })
    // The notice clears itself; the numbers do not move again.
    await advance(16_000)
    expect(result.current.switched).toBeNull()
    expect(result.current.stats?.payables_total).toBe(5)
  })

  it('cached and live with the same totals switch silently (nothing changed, nothing to say)', async () => {
    window.localStorage.setItem(
      'po.app-snapshot.v1',
      JSON.stringify({ items: LIVE_ITEMS, stats: liveStats('s0'), scanId: 's0', generatedAt: '2026-11-27T09:59:00.000Z', savedAt: '2026-11-27T09:59:05.000Z' }),
    )
    mockApi('s1', 1_000)
    const { result } = renderHook(() => useAppData(), { wrapper })
    expect(result.current.source).toBe('cached')
    await advance(2_000)
    expect(result.current.source).toBe('live')
    expect(result.current.switched).toBeNull()
  })

  it('a corrupt or self-contradicting cache is ignored, never shown', async () => {
    window.localStorage.setItem('po.app-snapshot.v1', JSON.stringify({ items: [item(1, 'paid')], stats: liveStats('x'), scanId: 'x', generatedAt: null, savedAt: 'now' }))
    mockApi('s1', 6_000)
    const { result } = renderHook(() => useAppData(), { wrapper })
    expect(result.current.source).toBe('loading')
  })
})

describe('useAppData polls do not flip', () => {
  it('5 polls of the same scan: identical numbers, same object, no notice', async () => {
    mockApi('s1', 0)
    const { result } = renderHook(() => useAppData(), { wrapper })
    await advance(50)
    const first = result.current
    expect(first.source).toBe('live')
    const seen = new Set<string>()
    for (let i = 0; i < 5; i += 1) {
      await advance(30_000)
      const d = result.current
      seen.add(`${d.stats?.payables_total}/${d.stats?.paid_total}/${d.items.length}/${d.asOf}`)
      expect(d.source).toBe('live')
      expect(d.switched).toBeNull()
    }
    expect(seen.size).toBe(1)
    expect(api.getStats).toHaveBeenCalledTimes(6)
  })

  it('live data is saved for the next visit, once per scan', async () => {
    mockApi('s1', 0)
    renderHook(() => useAppData(), { wrapper })
    await advance(50)
    const saved = JSON.parse(window.localStorage.getItem('po.app-snapshot.v1') ?? 'null')
    expect(saved.scanId).toBe('s1')
    expect(saved.items).toHaveLength(5)
    expect(saved.stats.payables_total).toBe(5)
  })
})
