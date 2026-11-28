// App hooks: live data with an honest recorded fallback, the seller
// directory, a media query, and the small local flags behind StartHere.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { useConfig, useLiveSnapshot } from '../hooks/useApi'
import type { InvoiceItem, Stats } from '../lib/types'
import { useSlowLoad } from '../components/polish'
import snapshotJson from './data/appSnapshot.json'
import type { SellerInfo } from './keys'

// ---- data: live, cached, or recorded ----

interface AppSnapshotFile {
  captured_at: string
  source: string
  stats: Stats
  items: InvoiceItem[]
}
const RECORDED = snapshotJson as unknown as AppSnapshotFile

export type DataSource = 'live' | 'cached' | 'recorded' | 'loading'

/** One-time notice when the numbers on screen change dataset (recorded or
    cached -> live) and the totals differ. Shown once per change, never a
    silent swap. */
export interface DatasetSwitch {
  from: 'cached' | 'recorded'
  fromTotal: number
  fromPaid: number
  toTotal: number
  toPaid: number
  /** ISO time of the live scan that replaced it. */
  at: string | null
}

export interface AppData {
  items: InvoiceItem[]
  stats: Stats | undefined
  source: DataSource
  /** ISO time of the data itself: when the API scanned the chain (live), when this browser last saved it (cached), or the capture time (recorded). */
  asOf: string | null
  /** A background refresh failed and the numbers are the last ones read this visit. */
  stale: boolean
  slow: boolean
  /** Set once, for a few seconds, when the dataset on screen changed to live and the totals differ. */
  switched: DatasetSwitch | null
  refetch: () => void
}

// ---- last live answer, kept in this browser so the next visit paints at once ----
const CACHE_KEY = 'po.app-snapshot.v1'
export interface CachedSnapshot {
  items: InvoiceItem[]
  stats: Stats
  scanId: string | null
  generatedAt: string | null
  savedAt: string
}

export function readCachedSnapshot(): CachedSnapshot | null {
  try {
    const raw = window.localStorage.getItem(CACHE_KEY)
    if (!raw) return null
    const c = JSON.parse(raw) as CachedSnapshot
    if (!Array.isArray(c.items) || !c.stats || typeof c.stats.payables_total !== 'number' || typeof c.stats.paid_total !== 'number') return null
    // A cached pair must agree with itself, or it is dropped (never shown).
    if (c.stats.payables_total !== c.items.length) return null
    return c
  } catch {
    return null
  }
}
function writeCachedSnapshot(c: CachedSnapshot): void {
  try {
    window.localStorage.setItem(CACHE_KEY, JSON.stringify(c))
  } catch {
    /* storage blocked or full: the next visit simply has no cache */
  }
}

/** After this long with no answer and nothing cached, the recorded snapshot is
    shown (labelled RECORDED). Short on purpose: the API answers from a cached
    scan in well under a second, so anything slower is a cold start. */
export const FALLBACK_AFTER_MS = 2_500
const SWITCH_NOTICE_MS = 15_000

/** First paint never waits on the chain:
      1. live answer (the API serves its last complete scan, < 500 ms), else
      2. the last live answer this browser saved (CACHED, with its scan time), else
      3. after FALLBACK_AFTER_MS, the bundled snapshot (RECORDED, with its date).
    Moving from 2 or 3 to live changes the dataset exactly once; when the
    totals differ the page says so (`switched`) instead of swapping silently.
    The API only ever serves complete scans and stats + list share one scan,
    so successive polls return identical numbers until the chain changes. */
export function useAppData(): AppData {
  const snap = useLiveSnapshot()
  const slow = useSlowLoad(snap.isLoading, 12_000)
  const fallback = useSlowLoad(snap.isLoading, FALLBACK_AFTER_MS)
  const live = snap.data
  const cached = useMemo(() => readCachedSnapshot(), [])

  // Save every NEW live scan for the next visit.
  const savedScan = useRef<string | null>(null)
  useEffect(() => {
    if (!live) return
    const key = live.scanId ?? `${live.stats.payables_total}/${live.stats.paid_total}/${live.items.length}`
    if (savedScan.current === key) return
    savedScan.current = key
    writeCachedSnapshot({ items: live.items, stats: live.stats, scanId: live.scanId ?? null, generatedAt: live.generatedAt ?? null, savedAt: new Date().toISOString() })
  }, [live])

  const base = useMemo<Omit<AppData, 'switched' | 'refetch'>>(() => {
    if (live) {
      return {
        items: live.items,
        stats: live.stats,
        source: 'live',
        // The scan time when the API gives one (it only moves when the chain was re-read),
        // otherwise the time of the last successful poll.
        asOf: live.generatedAt ?? (snap.dataUpdatedAt ? new Date(snap.dataUpdatedAt).toISOString() : null),
        stale: snap.isError,
        slow,
      }
    }
    if (cached) {
      return { items: cached.items, stats: cached.stats, source: 'cached', asOf: cached.generatedAt ?? cached.savedAt, stale: false, slow }
    }
    if (snap.isError || fallback) {
      return { items: RECORDED.items, stats: RECORDED.stats, source: 'recorded', asOf: RECORDED.captured_at, stale: false, slow }
    }
    return { items: [], stats: undefined, source: 'loading', asOf: null, stale: false, slow }
  }, [live, cached, snap.isError, snap.dataUpdatedAt, slow, fallback])

  // One-time dataset switch notice.
  const [switched, setSwitched] = useState<DatasetSwitch | null>(null)
  const shown = useRef<{ source: DataSource; total: number; paid: number } | null>(null)
  useEffect(() => {
    const prev = shown.current
    if (base.stats) shown.current = { source: base.source, total: base.stats.payables_total, paid: base.stats.paid_total }
    if (base.source !== 'live' || !base.stats || !prev) return
    if ((prev.source === 'cached' || prev.source === 'recorded') && (prev.total !== base.stats.payables_total || prev.paid !== base.stats.paid_total)) {
      setSwitched({ from: prev.source, fromTotal: prev.total, fromPaid: prev.paid, toTotal: base.stats.payables_total, toPaid: base.stats.paid_total, at: base.asOf })
    }
  }, [base])
  useEffect(() => {
    if (!switched) return
    const t = window.setTimeout(() => setSwitched(null), SWITCH_NOTICE_MS)
    return () => window.clearTimeout(t)
  }, [switched])

  const refetch = useCallback(() => void snap.refetch(), [snap])
  return useMemo(() => ({ ...base, switched, refetch }), [base, switched, refetch])
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
export function markMilestone(name: 'verified' | 'paid' | 'receipt' | 'agent'): void {
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
