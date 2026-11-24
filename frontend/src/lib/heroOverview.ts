// Hero overview derivations (design fix round 2) — pure functions over the
// LIVE invoices list + /api/stats. Nothing here invents a number.
// The video's Cash-overview card maps to our data honestly:
//   · bar chart → the CCD payables (one bar per payable, paid = solid,
//     unpaid due = hatched). The 3 EUDemo payables are a different test
//     asset, so they are NOT mixed onto one CCD axis — they are listed in
//     Payment rails and the chart says so.
//   · big balance → the summed CCD total of the listed payables, plus the
//     summed EUDemo total as a chip (each sum is real, in its own asset).
//   · Runway gauge → the paid-once share (paid of listed, same rule as the
//     dashboard donut: 8 of 13 = 62%).
//   · Bank accounts → the two payment rails (CCD / EUDemo), counts + totals.
//   · AI insights → lines computed from state (counts, soonest due,
//     refused total) — never a language model.
//   · Next 14 days → the soonest-due unpaid payables from the live list.
import type { InvoiceItem, Stats } from './types'

export interface AmountParts {
  value: number
  asset: 'CCD' | 'EUDemo' | null
}

/** "10.000000 CCD" → { value: 10, asset: 'CCD' }. Unparseable → value 0. */
export function parseAmount(amountDisplay: string): AmountParts {
  const m = amountDisplay.match(/([\d.,]+)\s*(CCD|EUDemo)/)
  if (!m) return { value: 0, asset: null }
  const value = Number.parseFloat(m[1].replace(/,/g, ''))
  return { value: Number.isFinite(value) ? value : 0, asset: m[2] as 'CCD' | 'EUDemo' }
}

export interface RailSummary {
  rail: 'A' | 'B'
  asset: 'CCD' | 'EUDemo'
  label: string
  count: number
  paidCount: number
  /** Sum of amounts in this rail's own asset, from the live list. */
  total: number
  /** Share of the listed payables on this rail (count share, labelled). */
  sharePct: number
}

export interface NextDue {
  payable_id: number
  amount_display: string
  due: string
  day: string
  mon: string
  overdue: boolean
}

export interface InsightLine {
  title: string
  detail: string
}

export interface HeroOverviewData {
  listed: number
  paidCount: number
  unpaidCount: number
  /** Paid share of the listed payables, 0–100 (same rule as the donut). */
  paidPct: number
  refusedTotal: number
  ccdTotal: number
  eudemoTotal: number
  ccdCount: number
  eudemoCount: number
  rails: RailSummary[]
  nextDues: NextDue[]
  insights: InsightLine[]
  /** The soonest-due unpaid payable, if any. */
  soonestDue: NextDue | null
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export function dayMonth(iso: string): { day: string; mon: string } {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return { day: '—', mon: '' }
  return { day: String(d.getUTCDate()).padStart(2, '0'), mon: MONTHS[d.getUTCMonth()] }
}

export function heroOverview(items: InvoiceItem[], stats: Stats | undefined, nowMs = Date.now()): HeroOverviewData {
  const listed = items.length
  const paid = items.filter((i) => i.status === 'paid')
  const unpaid = items.filter((i) => i.status !== 'paid')
  const paidCount = paid.length
  const unpaidCount = unpaid.length
  const paidPct = listed === 0 ? 0 : Math.round((paidCount / listed) * 100)
  const refusedTotal = stats?.refused_on_chain_since_deploy ?? 0

  const sumAsset = (asset: 'CCD' | 'EUDemo') =>
    items.reduce((acc, i) => (parseAmount(i.amount_display).asset === asset ? acc + parseAmount(i.amount_display).value : acc), 0)
  const countAsset = (asset: 'CCD' | 'EUDemo') =>
    items.filter((i) => parseAmount(i.amount_display).asset === asset).length
  const ccdTotal = sumAsset('CCD')
  const eudemoTotal = sumAsset('EUDemo')
  const ccdCount = countAsset('CCD')
  const eudemoCount = countAsset('EUDemo')

  const rail = (railId: 'A' | 'B', asset: 'CCD' | 'EUDemo', label: string): RailSummary => {
    const onRail = items.filter((i) => parseAmount(i.amount_display).asset === asset)
    return {
      rail: railId,
      asset,
      label,
      count: onRail.length,
      paidCount: onRail.filter((i) => i.status === 'paid').length,
      total: sumAsset(asset),
      sharePct: listed === 0 ? 0 : Math.round((onRail.length / listed) * 100),
    }
  }
  const rails = [rail('A', 'CCD', 'Rail A · CCD'), rail('B', 'EUDemo', 'Rail B · EUDemo')]

  const toNextDue = (i: InvoiceItem): NextDue => {
    const { day, mon } = dayMonth(i.due)
    const dueMs = new Date(i.due).getTime()
    return { payable_id: i.payable_id, amount_display: i.amount_display, due: i.due, day, mon, overdue: !Number.isNaN(dueMs) && dueMs <= nowMs }
  }
  const nextDues = [...unpaid].sort((a, b) => a.due.localeCompare(b.due)).slice(0, 3).map(toNextDue)
  const soonestDue = nextDues[0] ?? null

  const insights: InsightLine[] = []
  if (soonestDue) {
    insights.push({
      title: `${unpaidCount} invoice${unpaidCount === 1 ? '' : 's'} still unpaid`,
      detail: `The soonest, payable ${soonestDue.payable_id} (${soonestDue.amount_display}), was due ${new Date(soonestDue.due).toISOString().slice(0, 10)}${soonestDue.overdue ? ' — past due' : ''}.`,
    })
  } else if (listed > 0) {
    insights.push({
      title: 'Nothing unpaid right now',
      detail: `All ${listed} listed payables are paid once.`,
    })
  }
  if (refusedTotal > 0) {
    insights.push({
      title: `${refusedTotal} payments refused on chain since deploy`,
      detail: 'The contract stops a second payment, a wrong amount and a changed payee. Nothing moved on any of them.',
    })
  }
  const latestPaid = [...paid].sort((a, b) => b.payable_id - a.payable_id)[0]
  if (latestPaid) {
    insights.push({
      title: `Latest payment — payable ${latestPaid.payable_id}`,
      detail: `${latestPaid.amount_display}, paid once. Its receipt re-verifies on chain.`,
    })
  }

  return {
    listed,
    paidCount,
    unpaidCount,
    paidPct,
    refusedTotal,
    ccdTotal,
    eudemoTotal,
    ccdCount,
    eudemoCount,
    rails,
    nextDues,
    insights,
    soonestDue,
  }
}

export type OverviewTab = 'overview' | 'paid' | 'unpaid' | 'refused'

export interface ChartBar {
  payable_id: number
  amount: number
  paid: boolean
  /** Height as % of the tallest CCD bar (linear, one asset, one axis). */
  heightPct: number
  label: string
}

/** Bars for the Cash-overview chart: CCD payables only (one asset, one
    axis), filtered by tab. EUDemo payables are excluded here by design and
    the panel says so — they are in Payment rails. */
export function overviewBars(items: InvoiceItem[], tab: OverviewTab): ChartBar[] {
  const ccd = items
    .filter((i) => parseAmount(i.amount_display).asset === 'CCD')
    .sort((a, b) => a.payable_id - b.payable_id)
  const filtered =
    tab === 'paid' ? ccd.filter((i) => i.status === 'paid') : tab === 'unpaid' ? ccd.filter((i) => i.status !== 'paid') : ccd
  const max = Math.max(0, ...filtered.map((i) => parseAmount(i.amount_display).value))
  return filtered.map((i) => {
    const amount = parseAmount(i.amount_display).value
    return {
      payable_id: i.payable_id,
      amount,
      paid: i.status === 'paid',
      heightPct: max === 0 ? 0 : Math.round((amount / max) * 100),
      label: `Payable ${i.payable_id} · ${i.amount_display}`,
    }
  })
}

/** Format a CCD total the way the chart shows it (2 decimals, no inventing). */
export function formatCcdTotal(value: number): string {
  return `${value.toFixed(2)} CCD`
}
