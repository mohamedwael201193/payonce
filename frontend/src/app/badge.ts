// Badge status for a seller, read from the badge_url the API gives us
// (the agent registry's public badge-check). Shown as returned: a failed or
// unreadable check is "unavailable", never "active".
import { useQuery } from '@tanstack/react-query'

export type BadgeState =
  | { state: 'loading' }
  | { state: 'active' }
  | { state: 'inactive'; status: string }
  | { state: 'unavailable' }

export function parseBadge(body: unknown): BadgeState {
  const b = body as { on_chain?: { status?: unknown } } | null
  const status = b?.on_chain?.status
  if (typeof status !== 'string') return { state: 'unavailable' }
  return status === 'Active' ? { state: 'active' } : { state: 'inactive', status: status.toLowerCase() }
}

export function useBadgeStatus(url: string): BadgeState {
  const q = useQuery({
    queryKey: ['badge', url],
    staleTime: 5 * 60_000,
    retry: 1,
    queryFn: async () => {
      const res = await fetch(url, { headers: { accept: 'application/json' } })
      if (!res.ok) throw new Error(String(res.status))
      return (await res.json()) as unknown
    },
  })
  if (q.isLoading) return { state: 'loading' }
  if (q.isError || q.data === undefined) return { state: 'unavailable' }
  return parseBadge(q.data)
}
