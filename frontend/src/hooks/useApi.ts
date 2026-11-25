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
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

export const POLL_MS = 30_000

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: api.getHealth, refetchInterval: POLL_MS, retry: 1 })
}

export function useStats() {
  return useQuery({ queryKey: ['stats'], queryFn: api.getStats, refetchInterval: POLL_MS, retry: 1 })
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: api.getConfig, staleTime: 5 * 60_000, retry: 1 })
}

export function useInvoices() {
  return useQuery({ queryKey: ['invoices'], queryFn: api.getInvoices, refetchInterval: POLL_MS, retry: 1 })
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
