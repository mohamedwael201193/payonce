// Hero overview derivations (design fix round 2) — pure functions over the
// LIVE invoices list + /api/stats. Nothing here invents a number.
// The video's Cash-overview card maps to our data honestly:
//   · bar chart → the CCD payables, bucketed by due month (12 bars at
//     most, like the video's 12 monthly bars: paid solid at the bottom,
//     unpaid hatched on top). EUDemo payables are a different test asset,
//     so they are NOT mixed onto one CCD axis — they are listed in
//     Payment rails and the chart says so.
//   · big balance → the summed CCD total of the listed payables, plus the
//     summed EUDemo total as a chip (each sum is real, in its own asset).
//   · Runway gauge → the paid-once share (paid of listed, same rule as the
//     dashboard donut).
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
  /** The soonest-due unpaid payable with a parseable due date, if any. */
  soonestDue: NextDue | null
  /** CCD payables with no parseable due date: counted in the big total
      but left out of the due-month chart (a month chart has no month for
      them) — the chart discloses them so its sum stays reconcilable. */
  excludedFromChart: { count: number; total: number }
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
  // The soonest-due unpaid with a PARSEABLE due date: picking by raw
  // string sort alone lets an unparseable due ('' sorts first) reach the
  // insight below, where toISOString() would throw and kill the whole
  // hero (adversarial B3). An unparseable due has no date to show, so it
  // is never the soonest due.
  const unpaidWithDue = unpaidSorted.filter((i) => !Number.isNaN(new Date(i.due).getTime()))
  const soonestDue = unpaidWithDue[0] ? toNextDue(unpaidWithDue[0]) : null
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
  } else if (unpaidCount > 0) {
    // Unpaid payables exist but none has a parseable due date — the
    // soonest-due line cannot be written, and "nothing unpaid" would be
    // false. Say only what is known.
    insights.push({
      title: `${unpaidCount} invoice${unpaidCount === 1 ? '' : 's'} still unpaid`,
      detail: 'No due date is listed for these payables.',
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
      detail: 'These are payments the contract refused on chain — a refused payment never reaches the payee.',
    })
  }
  const latestPaid = [...paid].sort((a, b) => b.payable_id - a.payable_id)[0]
  if (latestPaid) {
    // No paid-at time exists on the invoice list, so no "latest by time"
    // claim is made: the highest payable id is the most recently created
    // payable, and the line says only that it is paid.
    insights.push({
      title: `Payable ${latestPaid.payable_id} paid`,
      detail: `${latestPaid.amount_display}, paid once. The payment is recorded on chain.`,
    })
  }

  // CCD payables with no parseable due date: they count in the big total
  // but the due-month chart has no month for them — disclosed, not hidden.
  const ccdNoDue = items.filter(
    (i) => parseAmount(i.amount_display).asset === 'CCD' && Number.isNaN(new Date(i.due).getTime()),
  )
  const excludedFromChart = {
    count: ccdNoDue.length,
    total: ccdNoDue.reduce((acc, i) => acc + parseAmount(i.amount_display).value, 0),
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
    excludedFromChart,
  }
}

export type OverviewTab = 'overview' | 'paid' | 'unpaid' | 'refused'

export interface ChartBar {
  /** "Nov 2026" — the due month (UTC). */
  month: string
  /** Short label under the bar ("Nov 26"). */
  label: string
  /** Total CCD due in this month. */
  total: number
  /** Of the total, the paid share (solid segment at the bottom). */
  paidTotal: number
  /** Of the total, the unpaid share (hatched segment on top). */
  unpaidTotal: number
  /** Height as % of the AXIS TOP TICK (linear, one asset, one axis) —
      so a bar measured against the axis reads its true total. */
  heightPct: number
  /** Paid share of this month's total, 0–100 (the solid segment). */
  paidPct: number
  /** How many CCD payables fall in this month. */
  count: number
}

export interface OverviewBars {
  /** At most 12 bars — the latest 12 due months. */
  bars: ChartBar[]
  /** Distinct due months before the 12-month cap. */
  months: number
}

interface MonthBucket {
  key: string
  month: string
  label: string
  total: number
  paidTotal: number
  unpaidTotal: number
  count: number
}

/** Group CCD payables by due month (UTC), oldest month first. A payable
    with no parseable due date has no month and is left out of the chart
    (the chart is by due month; the big total above it still counts it). */
function ccdMonthly(items: InvoiceItem[], tab: OverviewTab): MonthBucket[] {
  const ccd = items.filter((i) => parseAmount(i.amount_display).asset === 'CCD')
  const filtered =
    tab === 'paid' ? ccd.filter((i) => i.status === 'paid') : tab === 'unpaid' ? ccd.filter((i) => i.status !== 'paid') : ccd
  const byMonth = new Map<string, MonthBucket>()
  for (const i of filtered) {
    const d = new Date(i.due)
    if (Number.isNaN(d.getTime())) continue
    const key = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`
    const amount = parseAmount(i.amount_display).value
    const bucket = byMonth.get(key) ?? {
      key,
      month: `${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`,
      label: `${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`,
      total: 0,
      paidTotal: 0,
      unpaidTotal: 0,
      count: 0,
    }
    bucket.total += amount
    if (i.status === 'paid') bucket.paidTotal += amount
    else bucket.unpaidTotal += amount
    bucket.count += 1
    byMonth.set(key, bucket)
  }
  return [...byMonth.values()].sort((a, b) => a.key.localeCompare(b.key))
}

/** The latest 12 due months (oldest first) — the ONE month set the chart
    and its axis share. The axis used to scale over ALL months while the
    chart showed only the latest 12, so a dropped 100-CCD month could make
    every displayed 1-CCD bar fill the full height against a 100 axis
    (adversarial B2). */
function latestCcdMonthly(items: InvoiceItem[], tab: OverviewTab): MonthBucket[] {
  return ccdMonthly(items, tab).slice(-12)
}

/** Nice y-axis ticks for a monthly max: 5 ticks from 0, steps of 1 / 2 /
    2.5 / 5 / 10 × 10^n. The top tick may sit above the tallest bar — and
    it really does now, because bar heights are scaled to the top tick
    (adversarial B1: the tallest bar used to fill the full height whatever
    the top tick said). */
function ticksForMax(max: number): { max: number; ticks: number[] } {
  if (max === 0) return { max: 0, ticks: [0] }
  const raw = max / 4
  const mag = 10 ** Math.floor(Math.log10(raw))
  const residual = raw / mag
  const step = residual <= 1 ? mag : residual <= 2 ? 2 * mag : residual <= 2.5 ? 2.5 * mag : residual <= 5 ? 5 * mag : 10 * mag
  return { max, ticks: [0, step, 2 * step, 3 * step, 4 * step] }
}

/** Bars for the Cash-overview chart: CCD payables only (one asset, one
    axis), bucketed by due month, filtered by tab. One bar per payable is
    unreadable at the live scale (53 payables ≈ 10 px per slot, labels
    truncated to one character), so the demo buckets like the video's chart
    does — 12 wide monthly bars with month labels, paid solid at the
    bottom and unpaid hatched on top, so the paid/unpaid encoding survives
    the bucketing. EUDemo payables are excluded here by design and the
    panel says so — they are in Payment rails.
    Heights are scaled to the AXIS TOP TICK, not to the tallest month:
    a tallest month of 15.5 CCD against a top tick of 20 renders at 78%
    of the chart height, so a reader measuring the bar against the axis
    reads 15.5 — not 20. */
export function overviewBars(items: InvoiceItem[], tab: OverviewTab): OverviewBars {
  const buckets = ccdMonthly(items, tab)
  const latest = buckets.slice(-12)
  const { ticks } = ticksForMax(Math.max(0, ...latest.map((b) => b.total)))
  const topTick = ticks[ticks.length - 1]
  return {
    bars: latest.map((b) => ({
      month: b.month,
      label: b.label,
      total: b.total,
      paidTotal: b.paidTotal,
      unpaidTotal: b.unpaidTotal,
      heightPct: topTick === 0 ? 0 : Math.round((b.total / topTick) * 100),
      paidPct: b.total === 0 ? 0 : Math.round((b.paidTotal / b.total) * 100),
      count: b.count,
    })),
    months: buckets.length,
  }
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
    The scale is the tallest DISPLAYED monthly total — the same latest-12
    months the bars show (adversarial B2: the axis used to scale over all
    months, including dropped ones). The top tick may sit above the
    tallest bar (a standard axis), and the bars are scaled to it. */
export function chartAxisTicks(items: InvoiceItem[]): { max: number; ticks: number[] } {
  const buckets = latestCcdMonthly(items, 'overview')
  return ticksForMax(Math.max(0, ...buckets.map((b) => b.total)))
}

/** Format an axis tick without trailing zeros ("2.50" → "2.5", "10" → "10"). */
export function formatTick(value: number): string {
  return Number(value.toFixed(4)).toString()
}
