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
// fix-back-8 MF-1, corrected fix-back-9 MF-1, corrected again in
// fix-back-10 MF-1): stats and invoices are ONE query (useLiveSnapshot)
// whose queryFn fetches the pair together and only accepts it when the
// two agree with each other and the pair is FEASIBLE under the on-chain
// transition model (lib/snapshot.ts) — a shrink is accepted iff
// Δreserved + Δvoided ≥ shrink (d = Δreserved + Δvoided − shrink ≥ 0
// creates must exist), in BOTH the reserved-fall and the no-fall regime
// (the fix-back-7 exact-equality rule and the fix-back-9
// Δreserved+Δpaid+2·Δvoided rule were both wrong — see snapshot.ts
// header rule 2), the voided/paid counters never decrease, AND every
// dropped id reads back as reserved/voided via GET /api/payables/:id.
// A partial scan throws, so react-query keeps the last good snapshot on
// screen instead of rendering shrunken numbers, and the dashboard
// renders that kept snapshot with a could-not-refresh note
// (DashboardPage, MF-6). Verification pages in 10s with a 5 s deadline
// PER PAGE (fix-back-10 MF-2), so a legit >10 shrink heals on a slow
// host instead of freezing.
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
            // Fix-back-9 MF-1 (a): paid monotonicity needs the previous
            // paid total — thread it with the counts, from the same
            // cached snapshot. (Fix-back-10: the tight feasibility
            // check no longer uses paid growth — see lib/snapshot.ts.)
            paidTotal: prev.stats.paid_total,
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
    // Fix-back-10 MF-4, corrected fix-back-11 MF-2: retry: 0 —
    // fetchLiveSnapshot already retries in-loop (3 attempts with 1 s /
    // 2 s backoff). A react-query retry would run the WHOLE queryFn
    // again, doubling the worst case per poll tick. The qualified bound
    // (snapshot.ts rule 6): one queryFn spends at most 20 s of
    // verification (the whole-round tick budget) + 3 s backoff = 23 s,
    // plus the pair fetches — inside the 30 s poll; a hung first page
    // is 3 × 5 s + 3 s = 18 s. Doubled, that is ~46 s (past the poll).
    // Fix-back-10 stated this unqualified as "18 s once" — that holds
    // only for a hung first page, not for a slow host failing late.
    // The other hooks keep retry: 1 — only the snapshot queryFn
    // carries its own retry loop, so only it needs the 0.
    retry: 0,
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
