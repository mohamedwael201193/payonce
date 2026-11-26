// App hooks: live data with an honest recorded fallback, the seller
// directory, a media query, and the small local flags behind StartHere.
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { useConfig, useLiveSnapshot } from '../hooks/useApi'
import type { InvoiceItem, Stats } from '../lib/types'
import { useSlowLoad } from '../components/polish'
import snapshotJson from './data/appSnapshot.json'
import type { SellerInfo } from './keys'

// ---- data: live, kept, or recorded ----

interface AppSnapshotFile {
  captured_at: string
  source: string
  stats: Stats
  items: InvoiceItem[]
}
const RECORDED = snapshotJson as unknown as AppSnapshotFile

export type DataSource = 'live' | 'recorded' | 'loading'

export interface AppData {
  items: InvoiceItem[]
  stats: Stats | undefined
  source: DataSource
  /** ISO time of the data: last successful poll when live, capture time when recorded. */
  asOf: string | null
  /** A background refresh failed and the numbers are the last ones read this visit. */
  stale: boolean
  slow: boolean
  refetch: () => void
}

/** Live data first. With nothing loaded and the API failing (or very slow),
    the bundled snapshot is used and tagged RECORDED with its capture date.
    While the first answer is still on its way, source is "loading" and the
    page shows skeletons: never a zero. */
export function useAppData(): AppData {
  const snap = useLiveSnapshot()
  const slow = useSlowLoad(snap.isLoading, 12_000)
  const live = snap.data
  return useMemo<AppData>(() => {
    if (live) {
      return {
        items: live.items,
        stats: live.stats,
        source: 'live',
        asOf: snap.dataUpdatedAt ? new Date(snap.dataUpdatedAt).toISOString() : null,
        stale: snap.isError,
        slow,
        refetch: () => void snap.refetch(),
      }
    }
    if (snap.isError || slow) {
      return {
        items: RECORDED.items,
        stats: RECORDED.stats,
        source: 'recorded',
        asOf: RECORDED.captured_at,
        stale: false,
        slow,
        refetch: () => void snap.refetch(),
      }
    }
    return { items: [], stats: undefined, source: 'loading', asOf: null, stale: false, slow, refetch: () => void snap.refetch() }
  }, [live, snap.isError, snap.dataUpdatedAt, snap.refetch, slow])
}

// ---- sellers ----

export interface SellerDirectory {
  sellers: SellerInfo[]
  ready: boolean
  error: boolean
  extra: Map<string, { agent_token: number; badge_url: string; agent_card_url: string }>
}

export function useSellers(): SellerDirectory {
  const config = useConfig()
  return useMemo(() => {
    const list = config.data?.sellers ?? []
    return {
      sellers: list.map((s) => ({ seller: s.seller, label: s.label })),
      ready: Boolean(config.data),
      error: config.isError,
      extra: new Map(list.map((s) => [s.seller, { agent_token: s.agent_token, badge_url: s.badge_url, agent_card_url: s.agent_card_url }])),
    }
  }, [config.data, config.isError])
}

// ---- breakpoint: one chrome per breakpoint ----

const DESKTOP_QUERY = '(min-width: 1024px)'

function subscribeMedia(cb: () => void): () => void {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => {}
  const mq = window.matchMedia(DESKTOP_QUERY)
  mq.addEventListener('change', cb)
  return () => mq.removeEventListener('change', cb)
}
function mediaSnapshot(): boolean {
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return true
  return window.matchMedia(DESKTOP_QUERY).matches
}

export function useIsDesktop(): boolean {
  return useSyncExternalStore(subscribeMedia, mediaSnapshot, () => true)
}

// ---- local flags (StartHere, sidebar collapse). Always try/catch. ----

const FLAG_EVENT = 'po-flags-changed'

function readFlag(name: string): string | null {
  try {
    return window.localStorage.getItem(`po.${name}`)
  } catch {
    return null
  }
}
function writeFlag(name: string, value: string | null): void {
  try {
    if (value === null) window.localStorage.removeItem(`po.${name}`)
    else window.localStorage.setItem(`po.${name}`, value)
  } catch {
    /* storage blocked: the flag just does not persist */
  }
  window.dispatchEvent(new Event(FLAG_EVENT))
}

/** Persisted string flag, shared across components in this tab. */
export function useFlag(name: string): [string | null, (v: string | null) => void] {
  const subscribe = useCallback((cb: () => void) => {
    window.addEventListener(FLAG_EVENT, cb)
    window.addEventListener('storage', cb)
    return () => {
      window.removeEventListener(FLAG_EVENT, cb)
      window.removeEventListener('storage', cb)
    }
  }, [])
  const value = useSyncExternalStore(subscribe, () => readFlag(name), () => null)
  const set = useCallback((v: string | null) => writeFlag(name, v), [name])
  return [value, set]
}

/** Mark a StartHere milestone from anywhere (pay flow, receipt page). */
export function markMilestone(name: 'verified' | 'paid' | 'receipt'): void {
  writeFlag(`step.${name}`, '1')
}

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    const prev = document.title
    document.title = title
    return () => {
      document.title = prev
    }
  }, [title])
}

export function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), intervalMs)
    return () => window.clearInterval(t)
  }, [intervalMs])
  return now
}
