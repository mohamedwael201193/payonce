// useApi — one stable polling cadence (bug 7: stale refresh; item 3:
// numbers re-rendering) and ONE consistent snapshot (fix-back-6 B1/B11):
// stats + invoices are a single query whose pair must agree before it
// renders, so home and dashboard can never disagree in the same minute
// and a partial scan never overwrites good numbers.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { POLL_MS, useHealth, useInvoices, useLiveSnapshot, useStats } from './useApi'

const ITEMS = [
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'paid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 2, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'paid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 3, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'paid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 4, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'unpaid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 5, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'unpaid', label: 'Lab invoice' },
]
// The pair must agree (B1): stats 5/3 matches the 5-item list, 3 paid.
const STATS = { payables_total: 5, paid_total: 3, refused_on_chain_since_deploy: 7, last_verifier_run_at: '2026-11-24T10:42:07Z' }
const INVOICES = { items: ITEMS }
const HEALTH = {
  chain: { reachable: true, checked_at: '2026-11-24T10:42:07Z' },
  node_busy: false,
  payer: { status: 'ok' },
  sponsor: { status: 'ok' },
  wallet_eudemo: { status: 'ok' },
  co_signer: { status: 'ok' },
  budget: { new_invoices_left_this_hour: 3, attack_sends_left_this_hour: 5 },
}

describe('useApi polling', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.includes('/api/stats') ? STATS : url.includes('/api/invoices') ? INVOICES : HEALTH
        return { ok: true, status: 200, json: async () => body }
      }),
    )
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  function wrapper({ children }: { children: ReactNode }) {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }

  // Drain the fetch → json → setState promise chain under fake timers:
  // advancing the clock alone does not flush it.
  const flush = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }

  it('polls every 30 s — one stable cadence, not staggered', async () => {
    expect(POLL_MS).toBe(30_000)
    const { result } = renderHook(() => useStats(), { wrapper })
    await flush()
    // One snapshot fetch = the pair (invoices + stats) together.
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result.current.data).toEqual(STATS)
    // Nothing refetches before the interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999)
    })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    // At 30 s the poll fires once (the pair again).
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(4)
  })

  it('health and invoices poll on the same 30 s cadence', async () => {
    const health = renderHook(() => useHealth(), { wrapper })
    const invoices = renderHook(() => useInvoices(), { wrapper })
    await flush()
    // Health (1) + the snapshot pair (2).
    expect(fetch).toHaveBeenCalledTimes(3)
    expect(health.result.current.data).toEqual(HEALTH)
    // useInvoices returns the parsed items array, not the raw payload.
    expect(invoices.result.current.data).toEqual(ITEMS)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(6)
  })

  it('stats and invoices read the same snapshot — they cannot disagree', async () => {
    // One wrapper (one QueryClient, like the real app root): both hooks
    // subscribe to the same query, so the pair is fetched once and the
    // two slices share one dataUpdatedAt.
    const { result } = renderHook(() => ({ stats: useStats(), invoices: useInvoices() }), { wrapper })
    await flush()
    // One query, one fetch of the pair — the second hook subscribes, it
    // does not fetch again.
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(result.current.stats.data).toEqual(STATS)
    expect(result.current.invoices.data).toEqual(ITEMS)
    expect(result.current.stats.dataUpdatedAt).toBe(result.current.invoices.dataUpdatedAt)
  })
})

describe('useLiveSnapshot retry (fix-back-10 MF-4)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const flush = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await Promise.resolve()
      })
    }
  }

  // The wrapper here uses a PLAIN QueryClient — no retry:false default
  // — so the hook's own retry: 0 is what stops a second queryFn run.
  // A disagreeing pair (stats 51/31 vs a 1-item list) makes
  // fetchLiveSnapshot throw after its 3 in-loop attempts (1 s + 2 s
  // backoff); with retry: 0 the query settles in error after exactly
  // those 3 attempts (6 fetch calls). With retry: 1 the whole queryFn
  // would run a second time (12 calls) — doubling the worst case per
  // poll tick from ~23 s of verification + backoff (20 s verification
  // budget + 3 s backoff) to ~46 s, and the whole-tick worst (pair
  // fetches included) from 68 s to 136 s, past the 30 s poll budget
  // either way. (Fix-back-10 stated this as 18 s to ~36 s — that holds
  // only for a hung first page; see snapshot.ts rule 6, fix-back-11 MF-2.)
  it('does not retry a failed snapshot at the react-query level (retry: 0)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.includes('/api/stats')
          ? { payables_total: 51, paid_total: 31, refused_on_chain_since_deploy: 7, last_verifier_run_at: '2026-11-24T10:42:07Z' }
          : { items: [ITEMS[0]] }
        return { ok: true, status: 200, json: async () => body }
      }),
    )
    function defaultWrapper({ children }: { children: ReactNode }) {
      const client = new QueryClient()
      return <QueryClientProvider client={client}>{children}</QueryClientProvider>
    }
    const { result } = renderHook(() => useLiveSnapshot(), { wrapper: defaultWrapper })
    await flush()
    // Attempt 1 fails the pure check, then the 1 s backoff.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000)
    })
    await flush()
    // Attempt 2 fails, then the 2 s backoff.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000)
    })
    await flush()
    // Attempt 3 fails and the query settles in error. Advance 4 s more
    // (the empty-state poll, every 5 s, is a refetch not a retry):
    // a react-query retry (default delay ~1 s) would have started a
    // second queryFn by now — 6 more fetch calls — if retry were not 0.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000)
    })
    await flush()
    expect(result.current.isError).toBe(true)
    // Exactly 3 in-loop attempts × the pair (invoices + stats).
    expect(fetch).toHaveBeenCalledTimes(6)
  })
})
