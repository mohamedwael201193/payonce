// Dashboard helpers (design v2) — pure functions over the LIVE invoices
// list. Nothing here invents a number: every value is derived from
// /api/invoices + /api/stats, or from the labelled recorded run.
import { RECORDED_REFUSALS } from './recorded'
import { refusedCaption } from './copy'
import type { InvoiceItem, Stats } from './types'

export type DerivedStatus = 'paid' | 'unpaid' | 'overdue'

/** Status for display: paid, unpaid, or unpaid + past due = overdue.
    Derived from the live due date, never from a label. */
export function derivedStatus(item: InvoiceItem, nowMs = Date.now()): DerivedStatus {
  if (item.status === 'paid') return 'paid'
  const due = new Date(item.due).getTime()
  if (!Number.isNaN(due) && due <= nowMs) return 'overdue'
  return 'unpaid'
}

/** Running count of items matching `pred`, in payable-id order.
    Used for the stat-card sparklines: the sequence is the registry itself,
    in the order the payables were created. */
export function cumulativeSeries(items: InvoiceItem[], pred: (item: InvoiceItem) => boolean): number[] {
  const sorted = [...items].sort((a, b) => a.payable_id - b.payable_id)
  const out: number[] = []
  let n = 0
  for (const item of sorted) {
    if (pred(item)) n += 1
    out.push(n)
  }
  return out
}

/** Donut segments for the paid / unpaid split, from the live list. */
export function donutSegments(items: InvoiceItem[]): Array<{ label: string; value: number; color: string }> {
  const paid = items.filter((i) => i.status === 'paid').length
  const unpaid = items.length - paid
  return [
    { label: 'Paid once', value: paid, color: '#B4430F' },
    { label: 'Unpaid', value: unpaid, color: '#FDBA74' },
  ]
}

/** Activity feed, newest first by payable id (ids are sequential, so the
    highest paid id is the most recent payment — same rule as the
    "Latest payment" card). Paid items first, then the soonest-due unpaid
    ones. Details are real due dates / amounts — no invented timestamps. */
export function activityFeed(
  items: InvoiceItem[],
  limit = 6,
): Array<{ payable_id: number; title: string; detail: string; tone: DerivedStatus }> {
  const paid = [...items]
    .filter((i) => i.status === 'paid')
    .sort((a, b) => b.payable_id - a.payable_id)
  const unpaid = [...items]
    .filter((i) => i.status !== 'paid')
    .sort((a, b) => a.due.localeCompare(b.due))
  const feed = [
    ...paid.map((i) => ({
      payable_id: i.payable_id,
      title: `Payable ${i.payable_id} paid once`,
      detail: `${i.amount_display} · ${i.label}`,
      tone: 'paid' as DerivedStatus,
    })),
    ...unpaid.map((i) => ({
      payable_id: i.payable_id,
      title: `Payable ${i.payable_id} open — due ${new Date(i.due).toISOString().slice(0, 10)}`,
      detail: `${i.amount_display} · ${i.label}`,
      tone: derivedStatus(i),
    })),
  ]
  return feed.slice(0, limit)
}

/** Case-insensitive filter of the live table by id, amount or label. */
export function filterInvoices(items: InvoiceItem[], query: string): InvoiceItem[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items.filter(
    (i) =>
      String(i.payable_id).includes(q) ||
      i.amount_display.toLowerCase().includes(q) ||
      i.label.toLowerCase().includes(q) ||
      i.asset.toLowerCase().includes(q),
  )
}

/** CSV export of the live table (downloaded client-side, no server call). */
export function invoicesToCsv(items: InvoiceItem[]): string {
  const esc = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`
  const rows = items.map((i) =>
    [i.payable_id, i.asset, i.amount_display, i.due, i.status, i.label].map(esc).join(','),
  )
  return ['payable_id,asset,amount_display,due,status,label', ...rows].join('\n')
}

/** The refused card's sub: the refused caption (live total + last-run date)
    followed by what a refusal means. While the stats have not loaded the
    caption is empty, so the sub is the mechanism sentence alone — never a
    date-like claim with no data behind it. */
function refusedCardSub(stats: Stats | undefined): string {
  const caption = refusedCaption(stats?.refused_on_chain_since_deploy, stats?.last_verifier_run_at)
  return caption
    ? `${caption} — a wrong amount, a second payment or a changed payee stops before any money moves.`
    : 'A wrong amount, a second payment or a changed payee stops before any money moves.'
}

/** The four dashboard stat cards, from the live list + live stats.
    ONE source of truth (bug 2 + bug 5, browser test pass 1): every card
    value that the list can answer is counted FROM THE LIST ITSELF — the
    total, the paid count, the unpaid count. The list is what the page
    renders, so the cards, their subtexts, the table footer, the donut and
    the feed can never disagree within one render, even when the two
    queries resolve at different moments. Only the refused total comes from
    /api/stats (it has no per-item series), and the voided/reserved counts
    come from stats only as the named exclusion — never as a competing
    total. The API side is reconciled the same way (api/src/listable.mjs):
    /api/stats counts the same listable rows the list shows.
    N1 (one refused number + always-visible caption): the refused card
    shows ONE number — the on-chain refusals since deploy — and its sub is
    refusedCaption(): the recorded run named as the basis, with the live
    chain total restated (the SAME number as the card value, never a second
    one). The spark is that run's sequence, and the sub names it as a spark,
    without a numeral of its own. */
export function dashboardStats(stats: Stats | undefined, items: InvoiceItem[]) {
  const paid = items.filter((i) => i.status === 'paid').length
  const unpaid = items.filter((i) => i.status !== 'paid')
  const nextDue = [...unpaid].sort((a, b) => a.due.localeCompare(b.due))[0] ?? null
  const voided = stats?.voided_total ?? 0
  const reserved = stats?.reserved_total ?? 0
  // B2: the footnote must reconcile in one view — the live list (51) +
  // the excluded rows (1 voided + 5 reserved) = the rows the API scanned
  // (57). The old note named only the exclusions, so "51 listed + 1
  // voided" read as if the total should be 52. The scanned total closes
  // the arithmetic: list + excluded = scanned.
  const scanned = items.length + voided + reserved
  const excludedNote =
    voided + reserved > 0
      ? [
          voided > 0 ? `${voided} voided on chain, not listed` : null,
          reserved > 0 ? `${reserved} reserved, not listed` : null,
          `${scanned} scanned from the test registry`,
        ]
          .filter(Boolean)
          .join(' · ')
      : 'Live from the test registry'
  return {
    total: {
      value: items.length,
      label: 'Payables in the live list',
      sub: excludedNote,
      spark: cumulativeSeries(items, () => true),
    },
    paid: {
      value: paid,
      label: 'Paid once',
      sub: `${paid} of ${items.length} payables paid`,
      spark: cumulativeSeries(items, (i) => i.status === 'paid'),
    },
    unpaid: {
      value: unpaid.length,
      label: 'Unpaid open',
      sub: nextDue
        ? `Next due: payable ${nextDue.payable_id} · ${new Date(nextDue.due).toISOString().slice(0, 10)}`
        : 'Nothing open right now',
      spark: cumulativeSeries(items, (i) => i.status !== 'paid'),
    },
    refused: {
      value: stats?.refused_on_chain_since_deploy ?? 0,
      label: 'Refused on chain (since deploy)',
      sub: refusedCardSub(stats),
      spark: RECORDED_REFUSALS.map((_, i) => i + 1),
    },
  }
}

/** "Ready to pay": open and not past due, soonest due first. This is the
    list a payer wants; overdue and paid rows sit behind filters and tabs. */
export function readyToPay(items: InvoiceItem[], nowMs = Date.now()): InvoiceItem[] {
  return items
    .filter((i) => derivedStatus(i, nowMs) === 'unpaid')
    .sort((a, b) => a.due.localeCompare(b.due) || a.payable_id - b.payable_id)
}

/** Overdue (open, past due): most recently due first. */
export function overdueItems(items: InvoiceItem[], nowMs = Date.now()): InvoiceItem[] {
  return items.filter((i) => derivedStatus(i, nowMs) === 'overdue').sort((a, b) => b.due.localeCompare(a.due) || b.payable_id - a.payable_id)
}

/** Paid, newest payable first. */
export function paidItems(items: InvoiceItem[]): InvoiceItem[] {
  return items.filter((i) => i.status === 'paid').sort((a, b) => b.payable_id - a.payable_id)
}

/** Default order of the Invoices table: ready to pay, then overdue, then paid. */
export function defaultOrder(items: InvoiceItem[], nowMs = Date.now()): InvoiceItem[] {
  return [...readyToPay(items, nowMs), ...overdueItems(items, nowMs), ...paidItems(items)]
}

// ---- demo invoices vs automated test runs ----

export interface KindSummary {
  demo: { total: number; paid: number }
  tests: { total: number; paid: number }
  total: number
  paid: number
}

/** Demo vs automated-test-run counts from the API's by_kind (the API owns the
    rule). Null when the data has no kind split (old API, recorded snapshot):
    callers then show the plain total and claim no split. Tests are always
    INCLUDED in total; this never hides them. */
export function kindSummary(stats: Stats | undefined): KindSummary | null {
  const k = stats?.by_kind
  if (!stats || !k) return null
  return { demo: k.demo, tests: k.test_runs, total: stats.payables_total, paid: stats.paid_total }
}

export type InvoiceScope = 'default' | 'tests' | 'all'

/** The Invoices page scope. Default: demo invoices plus anything ready to pay.
    "tests": the automated test runs (lab + contract-matrix). "all": everything.
    Rows with no kind (old API, recorded snapshot) are never filtered out. */
export function inScope(item: InvoiceItem, scope: InvoiceScope, nowMs = Date.now()): boolean {
  if (scope === 'all' || item.kind === undefined) return true
  if (scope === 'tests') return item.kind !== 'demo'
  return item.kind === 'demo' || derivedStatus(item, nowMs) === 'unpaid'
}
