// Dashboard helpers (design v2) — pure functions over the LIVE invoices
// list. Nothing here invents a number: every value is derived from
// /api/invoices + /api/stats, or from the labelled recorded run.
import { RECORDED_REFUSALS } from './recorded'
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

/** The four dashboard stat cards, from live stats + the live list.
    `refusedSpark` is the recorded-run refusal sequence (7 entries, labelled
    on the card) — the live refused total (18) has no per-item series. */
export function dashboardStats(stats: Stats | undefined, items: InvoiceItem[]) {
  const paid = items.filter((i) => i.status === 'paid').length
  const unpaid = items.filter((i) => i.status !== 'paid')
  const nextDue = [...unpaid].sort((a, b) => a.due.localeCompare(b.due))[0] ?? null
  return {
    total: {
      value: stats?.payables_total ?? items.length,
      label: 'Payables on the registry',
      sub: 'Live from /api/stats',
      spark: cumulativeSeries(items, () => true),
    },
    paid: {
      value: stats?.paid_total ?? paid,
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
      label: 'Refused on chain',
      sub: `${RECORDED_REFUSALS.length} in the recorded run, 24 Nov 2026`,
      spark: RECORDED_REFUSALS.map((_, i) => i + 1),
    },
  }
}
