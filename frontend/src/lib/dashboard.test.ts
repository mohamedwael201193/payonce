// Dashboard helpers — derived only from the live list; no invented numbers.
import { describe, expect, it } from 'vitest'
import {
  activityFeed,
  cumulativeSeries,
  derivedStatus,
  donutSegments,
  filterInvoices,
  invoicesToCsv,
} from './dashboard'
import type { InvoiceItem } from './types'

const ITEMS: InvoiceItem[] = [
  { payable_id: 1, asset: 'ccd', amount_display: '10.000000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'unpaid', label: 'Lab invoice 1' },
  { payable_id: 2, asset: 'ccd', amount_display: '5.000000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'paid', label: 'Lab invoice 2' },
  { payable_id: 3, asset: 'eudemo', amount_display: '1.00 EUDemo', due: '2026-11-20T08:03:26.555Z', status: 'unpaid', label: 'Lab invoice 3' },
  { payable_id: 4, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-12-26T12:00:00.000Z', status: 'paid', label: 'Lab invoice 4' },
]

describe('derivedStatus', () => {
  it('paid stays paid, past-due unpaid is overdue, future unpaid is unpaid', () => {
    const now = new Date('2026-11-24T12:00:00.000Z').getTime()
    expect(derivedStatus(ITEMS[1], now)).toBe('paid')
    expect(derivedStatus(ITEMS[2], now)).toBe('overdue')
    expect(derivedStatus(ITEMS[0], now)).toBe('unpaid')
  })
})

describe('cumulativeSeries', () => {
  it('counts in payable-id order', () => {
    expect(cumulativeSeries(ITEMS, (i) => i.status === 'paid')).toEqual([0, 1, 1, 2])
    expect(cumulativeSeries(ITEMS, () => true)).toEqual([1, 2, 3, 4])
  })
})

describe('donutSegments', () => {
  it('splits the live list into paid / unpaid counts', () => {
    expect(donutSegments(ITEMS)).toEqual([
      { label: 'Paid once', value: 2, color: '#B4430F' },
      { label: 'Unpaid', value: 2, color: '#FDBA74' },
    ])
  })
})

describe('activityFeed', () => {
  it('paid first (highest id first), then unpaid by due date, no timestamps invented', () => {
    const feed = activityFeed(ITEMS, 10)
    expect(feed.map((f) => f.payable_id)).toEqual([4, 2, 3, 1])
    expect(feed[0].title).toBe('Payable 4 paid once')
    expect(feed[2].title).toContain('due 2026-11-20')
    expect(feed.every((f) => !/minute|hour ago/.test(f.title + f.detail))).toBe(true)
  })
})

describe('filterInvoices', () => {
  it('matches id, amount, label and asset; empty query returns all', () => {
    expect(filterInvoices(ITEMS, '').length).toBe(4)
    expect(filterInvoices(ITEMS, '4').map((i) => i.payable_id)).toEqual([4])
    expect(filterInvoices(ITEMS, 'eudemo').map((i) => i.payable_id)).toEqual([3])
    expect(filterInvoices(ITEMS, 'lab invoice 2').map((i) => i.payable_id)).toEqual([2])
  })
})

describe('invoicesToCsv', () => {
  it('emits a header plus one row per invoice, quoted', () => {
    const csv = invoicesToCsv(ITEMS)
    const lines = csv.split('\n')
    expect(lines[0]).toBe('payable_id,asset,amount_display,due,status,label')
    expect(lines.length).toBe(5)
    expect(lines[1]).toContain('"1","ccd","10.000000 CCD"')
  })
})
