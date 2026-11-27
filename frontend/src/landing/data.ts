// Landing data: a committed snapshot of the live testnet API (captured by
// capture-snapshot.mjs) that paints immediately, upgraded in place by the
// live API when it answers. Nothing here is typed by hand.
import { useEffect, useState } from 'react'
import { api } from '../lib/api'
import type { InvoiceItem, Stats } from '../lib/types'
import snapshotJson from '../../public/landing/snapshot.json'

export interface SnapshotReceipt {
  payable_id: number
  seller: string
  amount_display: string
  payee: string
  txs: { label: string; tx_hash: string }[]
  verifier: { passed: number; total: number; checked_at: string } | null
}

export interface SnapshotFacts {
  payable_id: number
  seller: string
  payee: string
  amount_display: string
  asset: 'ccd' | 'eudemo'
  due: string
  doc_sha256: string
  label: string
  status: string
  document?: string
  document_matches_chain?: boolean
}

export interface Snapshot {
  captured_at: string
  api_base: string
  stats: Stats
  invoices: InvoiceItem[]
  facts: SnapshotFacts | null
  receipts: SnapshotReceipt[]
  recorded_run_date: string | null
  recorded_steps: { payable_id: number; steps: { step: string; detail: string; txHash: string | null }[] } | null
  verify: {
    payable_id: number
    verdict: string
    passed: number
    total: number
    checked_at: string
    checks: { id: string; label: string; status: string }[]
  } | null
  config: {
    network: string
    registry: { index: number; subindex: number; module_ref: string }
    explorer: { tx: string; instance: string }
    reservation_secs: number
    verifier: { file: string; version_date: string }
  } | null
  tests: { frontend: { files: number; cases: number }; api: { files: number; cases: number } }
  counts: { listed: number; paid: number; unpaid: number }
}

export const SNAPSHOT = snapshotJson as unknown as Snapshot

/** The headline counts. Demo invoices lead; the automated test runs on the same registry are counted
    apart and always named. Without a kind split (an old API or snapshot) the plain totals are used. */
export interface Headline {
  total: number
  paid: number
  pct: number
  testTotal: number
  testPaid: number
  allTotal: number
  split: boolean
}
export function headline(stats: Stats): Headline {
  const k = stats.by_kind
  if (!k) {
    const pct = stats.payables_total ? Math.round((stats.paid_total / stats.payables_total) * 100) : 0
    return { total: stats.payables_total, paid: stats.paid_total, pct, testTotal: 0, testPaid: 0, allTotal: stats.payables_total, split: false }
  }
  const pct = k.demo.total ? Math.round((k.demo.paid / k.demo.total) * 100) : 0
  return { total: k.demo.total, paid: k.demo.paid, pct, testTotal: k.test_runs.total, testPaid: k.test_runs.paid, allTotal: stats.payables_total, split: true }
}

export const TX_URL = 'https://ccdexplorer.io/testnet/transaction/'
export const txUrl = (hash: string) => `${TX_URL}${hash}`
export const instanceUrl = (index: number, sub = 0) => `https://ccdexplorer.io/testnet/instance/${index}/${sub}`

export interface LandingData {
  source: 'live' | 'snapshot'
  /** ISO time of the data on screen: live fetch time, or the snapshot capture time. */
  at: string
  stats: Stats
  invoices: InvoiceItem[]
  snapshot: Snapshot
}

const POLL_MS = 60_000

/**
 * Paints the snapshot at once. Upgrades to live data only when stats and the
 * invoice list agree with each other: the API's list scan can silently drop
 * rows on a busy node, and a partial list must never replace a full one.
 */
export function useLandingData(snapshot: Snapshot = SNAPSHOT): LandingData {
  const [state, setState] = useState<LandingData>({
    source: 'snapshot',
    at: snapshot.captured_at,
    stats: snapshot.stats,
    invoices: snapshot.invoices,
    snapshot,
  })
  useEffect(() => {
    let alive = true
    let timer: ReturnType<typeof setTimeout> | undefined
    const tick = async () => {
      try {
        const [stats, invoices] = await Promise.all([api.getStats(), api.getInvoices()])
        const paid = invoices.filter((i) => i.status === 'paid').length
        const consistent = invoices.length > 0 && stats.payables_total === invoices.length && stats.paid_total === paid
        if (alive && consistent) {
          setState({ source: 'live', at: new Date().toISOString(), stats, invoices, snapshot })
        }
      } catch {
        // Keep what is on screen, honestly labelled.
      }
      if (alive) timer = setTimeout(tick, POLL_MS)
    }
    void tick()
    return () => {
      alive = false
      if (timer) clearTimeout(timer)
    }
  }, [snapshot])
  return state
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** "26 Nov 2026" */
export function formatDay(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  const [y, m, dd] = d.toISOString().slice(0, 10).split('-')
  return `${Number(dd)} ${MONTHS[Number(m) - 1]} ${y}`
}

/** "26 Nov 2026 04:30 UTC" */
export function formatStamp(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'unknown time'
  return `${formatDay(iso)} ${d.toISOString().slice(11, 16)} UTC`
}

/**
 * One generator for the verifier command (SPEC section 5, item 5). The app's
 * receipt and judges pages should import this instead of keeping their own.
 */
export function verifierCommand(payableId: number, txHash: string, docFile: string): string {
  return `cd api && node src/verify-payable-v2.mjs ${payableId} ${txHash} --doc ${docFile}`
}

export const shortSeller = (s: string) => `${s.slice(0, 4)}…${s.slice(-4)}`
export const shortHash = (h: string) => (h.length > 16 ? `${h.slice(0, 8)}…${h.slice(-6)}` : h)
