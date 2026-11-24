// Data hooks — react-query, polling every 15–30 s on testnet (P2 §5.7).
// Every number on the page comes from the live API; on failure we show a
// visible error state, never stale fake data.
import { useQuery } from '@tanstack/react-query'
import { api } from '../lib/api'

export function useHealth() {
  return useQuery({ queryKey: ['health'], queryFn: api.getHealth, refetchInterval: 15_000, retry: 1 })
}

export function useStats() {
  return useQuery({ queryKey: ['stats'], queryFn: api.getStats, refetchInterval: 20_000, retry: 1 })
}

export function useConfig() {
  return useQuery({ queryKey: ['config'], queryFn: api.getConfig, staleTime: 5 * 60_000, retry: 1 })
}

export function useInvoices() {
  return useQuery({ queryKey: ['invoices'], queryFn: api.getInvoices, refetchInterval: 20_000, retry: 1 })
}

export function usePayable(id: number | null) {
  return useQuery({
    queryKey: ['payable', id],
    queryFn: () => api.getPayable(id as number),
    enabled: id !== null,
    retry: 1,
  })
}

export function useReceipt(id: number | null) {
  return useQuery({
    queryKey: ['receipt', id],
    queryFn: () => api.getReceipt(id as number),
    enabled: id !== null,
    retry: 1,
  })
}
