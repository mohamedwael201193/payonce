// useApi — one stable polling cadence (bug 7: stale refresh; item 3:
// numbers re-rendering). Health, stats and invoices all poll every
// POLL_MS (30 s); no second interval, no staggered cadence.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { POLL_MS, useHealth, useInvoices, useStats } from './useApi'

const STATS = { payables_total: 5, paid_total: 3, refused_on_chain_since_deploy: 7, last_verifier_run_at: '2026-11-24T10:42:07Z' }
const INVOICES = { items: [] }
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
    expect(fetch).toHaveBeenCalledTimes(1)
    expect(result.current.data).toEqual(STATS)
    // Nothing refetches before the interval.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(29_999)
    })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(1)
    // At 30 s the poll fires once.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('health and invoices poll on the same 30 s cadence', async () => {
    const health = renderHook(() => useHealth(), { wrapper })
    const invoices = renderHook(() => useInvoices(), { wrapper })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(health.result.current.data).toEqual(HEALTH)
    // useInvoices returns the parsed items array, not the raw payload.
    expect(invoices.result.current.data).toEqual([])
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000)
    })
    await flush()
    expect(fetch).toHaveBeenCalledTimes(4)
  })
})
