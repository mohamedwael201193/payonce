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
  seller: string
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
  /** Due range of the listed payables ("Nov 2026 – Dec 2026") for the header
      strip's date pill; null when no payable has a parseable due. */
  dueRangeLabel: string | null
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
    return { payable_id: i.payable_id, seller: i.seller, amount_display: i.amount_display, due: i.due, day, mon, overdue: !Number.isNaN(dueMs) && dueMs <= nowMs }
  }
  // "Next 14 days" (the video's section): unpaid payables due within the
  // next 14 days from now, soonest first, at most 3. A payable due in 90
  // days is NOT here, and neither is an overdue one — overdue is past, not
  // next. The soonest-due unpaid overall (overdue included) still surfaces
  // in Insights via soonestDue, so an overdue payable is never hidden.
  const NEXT_14_DAYS_MS = 14 * 24 * 60 * 60 * 1000
  const unpaidSorted = [...unpaid].sort((a, b) => a.due.localeCompare(b.due))
  const soonestDue = unpaidSorted[0] ? toNextDue(unpaidSorted[0]) : null
  const nextDues = unpaidSorted
    .filter((i) => {
      const dueMs = new Date(i.due).getTime()
      return !Number.isNaN(dueMs) && dueMs >= nowMs && dueMs <= nowMs + NEXT_14_DAYS_MS
    })
    .slice(0, 3)
    .map(toNextDue)

  // Due range of the listed payables, for the header strip's date pill.
  const dueMsAll = items.map((i) => new Date(i.due).getTime()).filter((t) => !Number.isNaN(t))
  const dueRangeLabel = dueMsAll.length === 0 ? null : formatDueRange(Math.min(...dueMsAll), Math.max(...dueMsAll))

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
      detail: 'The contract stops a second payment, a wrong amount and a changed payee. A refused payment never reaches the payee.',
    })
  }
  const latestPaid = [...paid].sort((a, b) => b.payable_id - a.payable_id)[0]
  if (latestPaid) {
    insights.push({
      title: `Latest payment — payable ${latestPaid.payable_id}`,
      detail: `${latestPaid.amount_display}, paid once. The payment is recorded on chain.`,
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
    dueRangeLabel,
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

/** Due range as "Nov 2026 – Dec 2026" (one label when both ends share a month). */
function formatDueRange(minMs: number, maxMs: number): string {
  const a = new Date(minMs)
  const b = new Date(maxMs)
  const left = `${MONTHS[a.getUTCMonth()]} ${a.getUTCFullYear()}`
  const right = `${MONTHS[b.getUTCMonth()]} ${b.getUTCFullYear()}`
  return left === right ? left : `${left} – ${right}`
}

/** Nice y-axis ticks for the CCD chart: 5 ticks from 0, steps of 1 / 2 /
    2.5 / 5 / 10 × 10^n, so bar heights are readable against a real scale.
    The top tick may sit above the tallest bar (a standard axis). */
export function chartAxisTicks(items: InvoiceItem[]): { max: number; ticks: number[] } {
  const max = Math.max(
    0,
    ...items
      .filter((i) => parseAmount(i.amount_display).asset === 'CCD')
      .map((i) => parseAmount(i.amount_display).value),
  )
  if (max === 0) return { max: 0, ticks: [0] }
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const residual = raw / mag
  const step = residual <= 1 ? mag : residual <= 2 ? 2 * mag : residual <= 2.5 ? 2.5 * mag : residual <= 5 ? 5 * mag : 10 * mag
  return { max, ticks: [0, step, 2 * step, 3 * step, 4 * step] }
}

/** Format an axis tick without trailing zeros ("2.50" → "2.5", "10" → "10"). */
export function formatTick(value: number): string {
  return Number(value.toFixed(4)).toString()
}
