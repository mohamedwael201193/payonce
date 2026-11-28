// /demo data: one run, six screens. The page never invents values: it shows
// whatever a DemoRun holds. Source order: (1) GET /api/demo/run, a live run
// (under an hour old), (2) the last real run from the API, named by its age,
// (3) the bundled RECORDED_RUN, a real earlier run on registry v2, only when
// the API cannot answer. Whichever one is on screen is labelled.
import { timedFetch, API_BASE } from '../lib/api'

export interface DemoTx {
  hash: string
}
export interface DemoRefusal extends DemoTx {
  code: number
  name: string
}
/** live: produced by the API within the last hour. recent: a real run from the API, older than that (named by its age).
    replay: the bundled recording, shown only when the API cannot give a run. */
export type RunSource = 'live' | 'recent' | 'replay'
export interface DemoRun {
  /** true only when the API produced this run within the last hour */
  live: boolean
  source?: RunSource
  /** seconds since the API produced the run (live and recent runs only) */
  ageSecs?: number
  /** the sponsored fee of the payment, in CCD, when the run reports it */
  feeCcd?: number
  /** One line shown under the stage: what the visitor is looking at. */
  label: string
  invoice: { amount: string; due: string | null }
  good: { account: string; ticks: string[] }
  paid: DemoTx
  impostor: { account: string; headline: string; refusal: DemoRefusal | null }
  again: DemoRefusal
}

const EXPLORER = 'https://ccdexplorer.io/testnet/transaction/'
export const txUrl = (h: string) => `${EXPLORER}${h}`

/** A real run on registry v2 <13150,0>: payable 10 was paid once, a second payment was refused on chain.
    The impostor check is the same app-layer check the Run-it page runs on a forged invoice (no transaction). */
export const RECORDED_RUN: DemoRun = {
  live: false,
  source: 'replay',
  label: 'Replay of a recorded run on registry v2, 24 Nov 2026. Testnet.',
  invoice: { amount: '0.5 CCD', due: '2026-12-26' },
  good: {
    account: '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin',
    ticks: ['Invoice matches the one on chain', 'Payee fixed by the seller on chain', 'Not paid yet'],
  },
  paid: { hash: '7c204f0b1f75b5c43e655eb78e77a72205b21c1029261dcf889e1d7b12d73197' },
  impostor: {
    account: '3kBx2h5Y8v3TfqmRZ3BmvNwKUX4ZRVJcVLRsC9cBRwLX9pYgyR',
    headline: 'This account is not the one registered. Nothing sent.',
    refusal: null,
  },
  again: {
    code: -5,
    name: 'WrongStatus',
    hash: 'a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848',
  },
}

const HASH = /^[0-9a-f]{64}$/i
const isRefusal = (r: unknown): r is DemoRefusal =>
  !!r && typeof (r as DemoRefusal).code === 'number' && typeof (r as DemoRefusal).name === 'string' && HASH.test((r as DemoRefusal).hash)

/** detail.paid_fee.sponsor.cost is in microCCD. */
export function feeCcdOf(raw: unknown): number | undefined {
  const cost = (raw as { detail?: { paid_fee?: { sponsor?: { cost?: unknown } } } })?.detail?.paid_fee?.sponsor?.cost
  const n = Number(cost)
  return Number.isFinite(n) && n > 0 ? n / 1e6 : undefined
}

function complete(r: Partial<DemoRun>): boolean {
  if (!r || typeof r.label !== 'string') return false
  if (!r.invoice || !r.good || !Array.isArray(r.good.ticks) || !r.paid || !HASH.test(r.paid.hash)) return false
  if (!r.impostor || typeof r.impostor.account !== 'string' || !isRefusal(r.again)) return false
  if (r.impostor.refusal != null && !isRefusal(r.impostor.refusal)) return false
  return true
}

/** Accepts only a complete run that is under an hour old. */
export function parseLiveRun(raw: unknown, now = Date.now()): DemoRun | null {
  const r = raw as Partial<DemoRun> & { generated_at?: string }
  if (!r || r.live !== true) return null
  const at = r.generated_at ? Date.parse(r.generated_at) : NaN
  if (!Number.isFinite(at) || now - at > 3_600_000) return null
  if (!complete(r)) return null
  return { ...(r as DemoRun), live: true, source: 'live', feeCcd: feeCcdOf(r), ageSecs: Math.max(0, Math.round((now - at) / 1000)) }
}

/** A complete real run from the API that is over an hour old but under a day: shown with its age, never as live. */
export const RECENT_MAX_MS = 24 * 3_600_000
export function parseRecentRun(raw: unknown, now = Date.now()): DemoRun | null {
  const r = raw as Partial<DemoRun> & { generated_at?: string }
  if (!r) return null
  const at = r.generated_at ? Date.parse(r.generated_at) : NaN
  if (!Number.isFinite(at) || now - at > RECENT_MAX_MS || !complete(r)) return null
  return { ...(r as DemoRun), live: false, source: 'recent', feeCcd: feeCcdOf(r), ageSecs: Math.max(0, Math.round((now - at) / 1000)) }
}

export interface DemoProgressStep { key: string; label: string; hash: string }
export interface DemoFeed {
  run: DemoRun
  /** the API is producing a fresh run right now */
  refreshing: boolean
  /** transactions of that fresh run, in the order they landed */
  progress: DemoProgressStep[]
}

export function parseProgress(raw: unknown): DemoProgressStep[] {
  const steps = (raw as { steps?: unknown })?.steps
  if (!Array.isArray(steps)) return []
  return steps.filter((x): x is DemoProgressStep => !!x && typeof x.label === 'string' && typeof x.key === 'string' && HASH.test(String(x.hash)))
    .map((x) => ({ key: x.key, label: x.label, hash: x.hash.toLowerCase() }))
}

/** "just now", "12 min ago", "3 h ago", "2 days ago". */
export function ago(secs: number | undefined): string {
  if (secs == null || !Number.isFinite(secs)) return ''
  if (secs < 90) return 'just now'
  const m = Math.round(secs / 60)
  if (m < 90) return `${m} min ago`
  const h = Math.round(secs / 3600)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`
}

/** The run's sentence counts shared characters of the real impostor; the diagram under it may show a different,
    clearly labelled lookalike. Keep the counts in the diagram only so the two never disagree. */
export function impostorHeadline(h: string): string {
  return h.replace(/a lookalike account \(same first \d+ and last \d+ characters as the real payee,\s*/i, 'a different account (')
}

/** Give up on a fresh run quickly: the page must always be clickable. */
export const DEMO_LOAD_MS = 5_000

function deadline(ms: number, signal?: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    const t = setTimeout(() => reject(new DOMException('Timeout', 'TimeoutError')), ms)
    if (!signal) return
    const onAbort = () => {
      clearTimeout(t)
      reject(signal.reason ?? new DOMException('Aborted', 'AbortError'))
    }
    if (signal.aborted) { onAbort(); return }
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** The run to show, whether the API is making a fresh one, and the hashes of that one as they land.
    Order: a live run, else the last real run (with its age), else the labelled recording. */
export async function loadDemoFeed(signal?: AbortSignal, timeoutMs = DEMO_LOAD_MS): Promise<DemoFeed> {
  try {
    const res = await Promise.race([
      timedFetch(`${API_BASE}/api/demo/run`, signal ? { signal } : undefined),
      deadline(timeoutMs, signal),
    ])
    if (res.ok) {
      const raw = await res.json()
      const refreshing = (raw as { refreshing?: unknown })?.refreshing === true
      const progress = refreshing ? parseProgress((raw as { progress?: unknown }).progress) : []
      const run = parseLiveRun(raw) ?? parseRecentRun(raw)
      if (run) return { run, refreshing, progress }
      return { run: RECORDED_RUN, refreshing, progress }
    }
  } catch {
    /* timeout, abort, or API busy: labelled replay */
  }
  return { run: RECORDED_RUN, refreshing: false, progress: [] }
}

export async function loadDemoRun(signal?: AbortSignal, timeoutMs = DEMO_LOAD_MS): Promise<DemoRun> {
  return (await loadDemoFeed(signal, timeoutMs)).run
}

/** Ask for the demo run early (landing page) so the API wakes up and, if the last run is old, starts a fresh one before the visitor opens /demo. Never throws. */
export function warmDemoRun(): void {
  if (typeof fetch !== 'function') return
  void loadDemoFeed(undefined, 15_000).catch(() => {})
}
