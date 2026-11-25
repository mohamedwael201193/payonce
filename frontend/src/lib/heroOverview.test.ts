// heroOverview — pure derivations over a live-shaped fixture (13 items:
// 8 paid, 5 unpaid; 9 CCD, 4 EUDemo; dues 24 Nov – 26 Dec 2026).
import { describe, expect, it } from 'vitest'
import { chartAxisTicks, dayMonth, formatCcdTotal, formatTick, heroOverview, overviewBars, parseAmount } from './heroOverview'
import type { InvoiceItem } from './types'

const NOW = new Date('2026-11-24T17:30:00.000Z').getTime()
const STATS = { payables_total: 14, paid_total: 8, refused_on_chain_since_deploy: 18, last_verifier_run_at: '2026-11-24T17:08:24.616Z' }

function item(payable_id: number, asset: 'ccd' | 'eudemo', amount_display: string, due: string, status: 'paid' | 'unpaid'): InvoiceItem {
  return { payable_id, seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', asset, amount_display, due, status, label: 'Lab invoice (testnet, not a real invoice)' }
}

const ITEMS: InvoiceItem[] = [
  item(1, 'ccd', '10.000000 CCD', '2026-12-01T08:03:26.555Z', 'unpaid'),
  item(2, 'ccd', '5.000000 CCD', '2026-12-01T08:03:26.555Z', 'unpaid'),
  item(3, 'eudemo', '1.00 EUDemo', '2026-12-01T08:03:26.555Z', 'unpaid'),
  item(5, 'ccd', '1.000000 CCD', '2026-11-24T08:05:59.988Z', 'unpaid'),
  item(10, 'ccd', '0.500000 CCD', '2026-12-26T12:00:00.000Z', 'paid'),
  item(11, 'eudemo', '0.01 EUDemo', '2026-12-26T12:00:00.000Z', 'paid'),
  item(1000, 'ccd', '0.500000 CCD', '2026-11-25T10:50:03.797Z', 'paid'),
  item(1001, 'eudemo', '0.01 EUDemo', '2026-11-25T10:50:40.533Z', 'paid'),
  item(1002, 'ccd', '0.500000 CCD', '2026-11-25T10:56:58.441Z', 'paid'),
  item(1003, 'eudemo', '0.01 EUDemo', '2026-11-25T10:57:38.512Z', 'paid'),
  item(1004, 'ccd', '0.500000 CCD', '2026-11-25T10:58:25.269Z', 'unpaid'),
  item(1005, 'ccd', '0.500000 CCD', '2026-11-25T13:11:46.300Z', 'paid'),
  item(1006, 'ccd', '0.500000 CCD', '2026-11-25T15:07:59.465Z', 'paid'),
]

describe('parseAmount', () => {
  it('parses CCD and EUDemo displays', () => {
    expect(parseAmount('10.000000 CCD')).toEqual({ value: 10, asset: 'CCD' })
    expect(parseAmount('0.01 EUDemo')).toEqual({ value: 0.01, asset: 'EUDemo' })
    expect(parseAmount('nonsense')).toEqual({ value: 0, asset: null })
  })
})

describe('heroOverview', () => {
  it('derives the live 13/8/5 split and the 62% paid-once share', () => {
    const o = heroOverview(ITEMS, STATS, NOW)
    expect(o.listed).toBe(13)
    expect(o.paidCount).toBe(8)
    expect(o.unpaidCount).toBe(5)
    expect(o.paidPct).toBe(62)
    expect(o.refusedTotal).toBe(18)
  })

  it('sums each asset separately, never mixing them', () => {
    const o = heroOverview(ITEMS, STATS, NOW)
    expect(o.ccdTotal).toBeCloseTo(19)
    expect(o.eudemoTotal).toBeCloseTo(1.03)
    expect(o.ccdCount).toBe(9)
    expect(o.eudemoCount).toBe(4)
    expect(formatCcdTotal(o.ccdTotal)).toBe('19.00 CCD')
  })

  it('splits the rails by count and total', () => {
    const o = heroOverview(ITEMS, STATS, NOW)
    expect(o.rails[0]).toMatchObject({ rail: 'A', asset: 'CCD', count: 9, paidCount: 5, total: 19, sharePct: 69 })
    expect(o.rails[1]).toMatchObject({ rail: 'B', asset: 'EUDemo', count: 4, paidCount: 3, total: 1.03, sharePct: 31 })
  })

  it('lists the unpaid payables due in the next 14 days, soonest first (the overdue one is not "next")', () => {
    const o = heroOverview(ITEMS, STATS, NOW)
    expect(o.nextDues.map((d) => d.payable_id)).toEqual([1004, 1, 2])
    expect(o.nextDues[0]).toMatchObject({ day: '25', mon: 'Nov', overdue: false })
    expect(o.nextDues[1]).toMatchObject({ day: '01', mon: 'Dec', overdue: false })
    // The soonest-due unpaid overall (overdue included) still surfaces in Insights.
    expect(o.soonestDue?.payable_id).toBe(5)
  })

  it('bounds Next 14 days to the window: a payable due in 90 days is not listed', () => {
    const far = item(2000, 'ccd', '1.000000 CCD', '2027-02-22T08:00:00.000Z', 'unpaid')
    const o = heroOverview([...ITEMS, far], STATS, NOW)
    expect(o.nextDues.map((d) => d.payable_id)).toEqual([1004, 1, 2])
    expect(o.nextDues.map((d) => d.payable_id)).not.toContain(2000)
  })

  it('derives the header strip date range from the listed dues', () => {
    expect(heroOverview(ITEMS, STATS, NOW).dueRangeLabel).toBe('Nov 2026 – Dec 2026')
    expect(heroOverview([], undefined, NOW).dueRangeLabel).toBeNull()
  })

  it('computes insight lines from state (unpaid, refused, latest paid) — worded to what the inputs support', () => {
    const o = heroOverview(ITEMS, STATS, NOW)
    expect(o.insights).toHaveLength(3)
    expect(o.insights[0].title).toBe('5 invoices still unpaid')
    expect(o.insights[0].detail).toContain('payable 5')
    expect(o.insights[0].detail).toContain('past due')
    expect(o.insights[1].title).toBe('18 payments refused on chain since deploy')
    // A bare refused count supports "a refused payment never reaches the
    // payee" — not a per-refusal outcome claim ("Nothing moved on any of
    // them" is gone) and not the three refusal causes (the count alone
    // does not evidence which cause refused which payment).
    expect(o.insights[1].detail).toContain('never reaches the payee')
    expect(o.insights[1].detail).not.toContain('Nothing moved')
    expect(o.insights[1].detail).not.toContain('wrong amount')
    // No paid-at time exists on the invoice list, so no "latest by time"
    // claim: the line says only that the highest-id payable is paid.
    expect(o.insights[2].title).toBe('Payable 1006 paid')
    expect(o.insights[2].title).not.toContain('Latest')
    // Paid status supports "recorded on chain" — not "receipt re-verifies"
    // (receipt verification is a separate check, not in the invoice list).
    expect(o.insights[2].detail).toContain('recorded on chain')
    expect(o.insights[2].detail).not.toContain('re-verifies')
  })

  it('handles an empty list without inventing numbers', () => {
    const o = heroOverview([], undefined, NOW)
    expect(o).toMatchObject({ listed: 0, paidCount: 0, unpaidCount: 0, paidPct: 0, ccdTotal: 0, eudemoTotal: 0 })
    expect(o.nextDues).toEqual([])
    expect(o.insights).toEqual([])
  })
})

describe('overviewBars', () => {
  it('buckets CCD payables by due month (video shape: 12 wide monthly bars), paid solid / unpaid hatched', () => {
    const { bars, months } = overviewBars(ITEMS, 'overview')
    expect(months).toBe(2)
    expect(bars).toHaveLength(2)
    // Nov 2026: 6 CCD payables, 3.50 CCD (2.00 paid, 1.50 unpaid).
    expect(bars[0]).toMatchObject({ month: 'Nov 2026', label: 'Nov 26', total: 3.5, paidTotal: 2, unpaidTotal: 1.5, count: 6, paidPct: 57 })
    // Dec 2026: 3 CCD payables, 15.50 CCD (0.50 paid, 15.00 unpaid) — the tallest month.
    expect(bars[1]).toMatchObject({ month: 'Dec 2026', label: 'Dec 26', total: 15.5, paidTotal: 0.5, unpaidTotal: 15, count: 3, paidPct: 3, heightPct: 100 })
    expect(bars[0].heightPct).toBe(23)
    // Paid + unpaid always sums back to the month total.
    for (const b of bars) expect(b.paidTotal + b.unpaidTotal).toBeCloseTo(b.total)
  })

  it('filters by tab', () => {
    const paid = overviewBars(ITEMS, 'paid')
    expect(paid.bars.map((b) => b.month)).toEqual(['Nov 2026', 'Dec 2026'])
    expect(paid.bars[0]).toMatchObject({ total: 2, paidTotal: 2, unpaidTotal: 0 })
    expect(paid.bars[1]).toMatchObject({ total: 0.5, paidTotal: 0.5, unpaidTotal: 0 })
    const unpaid = overviewBars(ITEMS, 'unpaid')
    expect(unpaid.bars[0]).toMatchObject({ total: 1.5, paidTotal: 0, unpaidTotal: 1.5 })
    expect(unpaid.bars[1]).toMatchObject({ total: 15, paidTotal: 0, unpaidTotal: 15 })
  })

  it('stays readable at the live scale: 53 payables across 3 months → 3 wide bars with month labels', () => {
    const many: InvoiceItem[] = []
    for (let i = 0; i < 53; i++) {
      const month = ['2026-11-15', '2026-12-10', '2027-01-05'][i % 3]
      many.push(item(2000 + i, 'ccd', i % 5 === 0 ? '10.000000 CCD' : '0.500000 CCD', `${month}T08:00:00.000Z`, i % 2 === 0 ? 'paid' : 'unpaid'))
    }
    const { bars, months } = overviewBars(many, 'overview')
    expect(months).toBe(3)
    expect(bars).toHaveLength(3)
    expect(bars.map((b) => b.label)).toEqual(['Nov 26', 'Dec 26', 'Jan 27'])
    // Labels are distinct month names — never "#1006" truncated to one character.
    expect(new Set(bars.map((b) => b.label)).size).toBe(3)
    // Every payable is in exactly one bar: the bar totals sum to the CCD total.
    const ccdTotal = many.reduce((acc, x) => acc + parseAmount(x.amount_display).value, 0)
    expect(bars.reduce((acc, b) => acc + b.total, 0)).toBeCloseTo(ccdTotal)
    for (const b of bars) expect(b.paidTotal + b.unpaidTotal).toBeCloseTo(b.total)
  })

  it('caps at the latest 12 months and reports the uncapped month count', () => {
    const many: InvoiceItem[] = []
    for (let m = 0; m < 14; m++) {
      const year = 2026 + Math.floor(m / 12)
      const month = String((m % 12) + 1).padStart(2, '0')
      many.push(item(3000 + m, 'ccd', '1.000000 CCD', `${year}-${month}-10T08:00:00.000Z`, 'unpaid'))
    }
    const { bars, months } = overviewBars(many, 'overview')
    expect(months).toBe(14)
    expect(bars).toHaveLength(12)
    expect(bars[0].month).toBe('Mar 2026')
    expect(bars[11].month).toBe('Feb 2027')
  })
})

describe('chartAxisTicks', () => {
  it('returns 5 nice ticks from 0 for the CCD chart scale (tallest MONTHLY total)', () => {
    // Monthly totals are Nov 3.50 / Dec 15.50 — the axis scales to 15.50,
    // not to the tallest single payable (10).
    expect(chartAxisTicks(ITEMS)).toEqual({ max: 15.5, ticks: [0, 5, 10, 15, 20] })
    expect(chartAxisTicks([])).toEqual({ max: 0, ticks: [0] })
  })

  it('formats ticks without trailing zeros', () => {
    expect(formatTick(2.5)).toBe('2.5')
    expect(formatTick(10)).toBe('10')
    expect(formatTick(0)).toBe('0')
  })
})

describe('dayMonth', () => {
  it('formats UTC day/month', () => {
    expect(dayMonth('2026-11-25T10:58:25.269Z')).toEqual({ day: '25', mon: 'Nov' })
    expect(dayMonth('2026-12-01T08:03:26.555Z')).toEqual({ day: '01', mon: 'Dec' })
  })
})
