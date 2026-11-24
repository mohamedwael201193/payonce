// heroOverview — pure derivations over a live-shaped fixture (13 items:
// 8 paid, 5 unpaid; 10 CCD, 3 EUDemo; dues 24 Nov – 1 Dec 2026).
import { describe, expect, it } from 'vitest'
import { dayMonth, formatCcdTotal, heroOverview, overviewBars, parseAmount } from './heroOverview'
import type { InvoiceItem } from './types'

const NOW = new Date('2026-11-24T17:30:00.000Z').getTime()
const STATS = { payables_total: 14, paid_total: 8, refused_on_chain_since_deploy: 18, last_verifier_run_at: '2026-11-24T17:08:24.616Z' }

function item(payable_id: number, asset: 'ccd' | 'eudemo', amount_display: string, due: string, status: 'paid' | 'unpaid'): InvoiceItem {
  return { payable_id, asset, amount_display, due, status, label: 'Lab invoice (testnet, not a real invoice)' }
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

  it('lists the soonest-due unpaid payables first, flagging the overdue one', () => {
    const o = heroOverview(ITEMS, STATS, NOW)
    expect(o.nextDues.map((d) => d.payable_id)).toEqual([5, 1004, 1])
    expect(o.nextDues[0]).toMatchObject({ day: '24', mon: 'Nov', overdue: true })
    expect(o.nextDues[1]).toMatchObject({ day: '25', mon: 'Nov', overdue: false })
    expect(o.soonestDue?.payable_id).toBe(5)
  })

  it('computes insight lines from state (unpaid, refused, latest paid)', () => {
    const o = heroOverview(ITEMS, STATS, NOW)
    expect(o.insights).toHaveLength(3)
    expect(o.insights[0].title).toBe('5 invoices still unpaid')
    expect(o.insights[0].detail).toContain('payable 5')
    expect(o.insights[0].detail).toContain('past due')
    expect(o.insights[1].title).toBe('18 payments refused on chain since deploy')
    expect(o.insights[2].title).toBe('Latest payment — payable 1006')
  })

  it('handles an empty list without inventing numbers', () => {
    const o = heroOverview([], undefined, NOW)
    expect(o).toMatchObject({ listed: 0, paidCount: 0, unpaidCount: 0, paidPct: 0, ccdTotal: 0, eudemoTotal: 0 })
    expect(o.nextDues).toEqual([])
    expect(o.insights).toEqual([])
  })
})

describe('overviewBars', () => {
  it('charts CCD payables only, paid solid / unpaid hatched, linear heights', () => {
    const bars = overviewBars(ITEMS, 'overview')
    expect(bars).toHaveLength(9)
    expect(bars[0]).toMatchObject({ payable_id: 1, amount: 10, paid: false, heightPct: 100 })
    expect(bars[1]).toMatchObject({ payable_id: 2, amount: 5, paid: false, heightPct: 50 })
    expect(bars.find((b) => b.payable_id === 1006)).toMatchObject({ paid: true, heightPct: 5 })
  })

  it('filters by tab', () => {
    expect(overviewBars(ITEMS, 'paid').map((b) => b.payable_id)).toEqual([10, 1000, 1002, 1005, 1006])
    expect(overviewBars(ITEMS, 'unpaid').map((b) => b.payable_id)).toEqual([1, 2, 5, 1004])
  })
})

describe('dayMonth', () => {
  it('formats UTC day/month', () => {
    expect(dayMonth('2026-11-25T10:58:25.269Z')).toEqual({ day: '25', mon: 'Nov' })
    expect(dayMonth('2026-12-01T08:03:26.555Z')).toEqual({ day: '01', mon: 'Dec' })
  })
})
