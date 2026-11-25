// Data hooks — react-query, one stable cadence (POLL_MS) on testnet.
// Every number on the page comes from the live API; on failure we show a
// visible error state, never stale fake data.
//
// One cadence (bug 7, browser test pass 1): health, stats and invoices used
// to poll at 15 s / 20 s / 20 s, so the three numbers on one page were
// always from different moments — the page disagreed with itself and the
// "Last updated" line did not move with the polls. All three poll together
// every 30 s now, and the dashboard's "Last updated" reads the queries'
// dataUpdatedAt, so it advances on every successful poll.
//
// One snapshot (fix-back-6 B1/B11, corrected fix-back-7 MF-1, hardened
// fix-back-8 MF-1): stats and invoices are ONE query (useLiveSnapshot)
// whose queryFn fetches the pair together and only accepts it when the two
// agree with each other and a list shrink is exactly accounted for by
// voided+reserved growth since the last accepted snapshot (lib/snapshot.ts
// — a reserve or a void legitimately removes a row from the listable set),
// the excluded counters never decrease, AND every dropped id reads back
// as reserved/voided via GET /api/payables/:id. A partial scan throws, so
// react-query keeps the last good snapshot on screen instead of rendering
// shrunken numbers, and the dashboard renders that kept snapshot with a
// could-not-refresh note (DashboardPage, MF-6).
// useStats and useInvoices are thin selects over that one query, so the
// home hero and the dashboard — and every section on one page — always
// read the SAME snapshot and can never disagree in the same minute.
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { api } from '../lib/api'
import { fetchLiveSnapshot, type LiveSnapshot, type PrevSnapshot } from '../lib/snapshot'

export const POLL_MS = 30_000

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: api.getHealth, refetchInterval: POLL_MS, retry: 1 })
}

export function useLiveSnapshot() {
  const client = useQueryClient()
  return useQuery({
    queryKey: ['live-snapshot'],
    queryFn: () => {
      const prev = client.getQueryData<LiveSnapshot>(['live-snapshot'])
      const prevSnapshot: PrevSnapshot | undefined = prev
        ? {
            count: prev.items.length,
            voidedTotal: prev.stats.voided_total ?? 0,
            reservedTotal: prev.stats.reserved_total ?? 0,
            // Fix-back-8 MF-1: the shrink rule verifies every dropped id
            // against the previous snapshot's id set — thread the ids, not
            // just the count, or a shrink fails closed for lack of an id
            // set to verify against.
            ids: prev.items.map((i) => i.payable_id),
          }
        : undefined
      return fetchLiveSnapshot(prevSnapshot)
    },
    refetchInterval: POLL_MS,
    retry: 1,
  })
}

export function useStats() {
  const snapshot = useLiveSnapshot()
  return {
    ...snapshot,
    data: snapshot.data?.stats,
  }
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: api.getConfig, staleTime: 5 * 60_000, retry: 1 })
}

export function useInvoices() {
  const snapshot = useLiveSnapshot()
  return {
    ...snapshot,
    data: snapshot.data?.items,
  }
}

export function usePayable(id: number | null, seller?: string) {
  return useQuery({
    queryKey: ['payable', id, seller ?? null],
    queryFn: () => api.getPayable(id as number, seller),
    enabled: id !== null,
    retry: 1,
  })
}

export function useReceipt(id: number | null, seller?: string) {
  return useQuery({
    queryKey: ['receipt', id, seller ?? null],
    queryFn: () => api.getReceipt(id as number, seller),
    enabled: id !== null,
    retry: 1,
  })
}
