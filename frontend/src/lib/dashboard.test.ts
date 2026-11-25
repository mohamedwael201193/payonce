// Dashboard helpers — derived only from the live list; no invented numbers.
import { describe, expect, it } from 'vitest'
import {
  activityFeed,
  cumulativeSeries,
  dashboardStats,
  derivedStatus,
  donutSegments,
  filterInvoices,
  invoicesToCsv,
} from './dashboard'
import type { InvoiceItem, Stats } from './types'

const ITEMS: InvoiceItem[] = [
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1, asset: 'ccd', amount_display: '10.000000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'unpaid', label: 'Lab invoice 1' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 2, asset: 'ccd', amount_display: '5.000000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'paid', label: 'Lab invoice 2' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 3, asset: 'eudemo', amount_display: '1.00 EUDemo', due: '2026-11-20T08:03:26.555Z', status: 'unpaid', label: 'Lab invoice 3' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 4, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-12-26T12:00:00.000Z', status: 'paid', label: 'Lab invoice 4' },
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

describe('dashboardStats (honesty: one total, one source)', () => {
  const STATS: Stats = {
    payables_total: 4,
    paid_total: 2,
    refused_on_chain_since_deploy: 21,
    last_verifier_run_at: '2026-11-24T17:08:24.616Z',
    voided_total: 1,
    reserved_total: 0,
  }
  it('labels the total as the live list and names the excluded rows', () => {
    const cards = dashboardStats(STATS, ITEMS)
    expect(cards.total.label).toBe('Payables in the live list')
    expect(cards.total.value).toBe(4)
    expect(cards.total.sub).toBe('1 voided on chain, not listed · 5 scanned from the test registry')
    expect(cards.refused.label).toBe('Refused on chain (since deploy)')
    expect(cards.refused.value).toBe(21)
    // N1: one refused number + an always-visible caption — the sub IS
    // refusedCaption(): the recorded run named as the basis, with the live
    // chain total restated (the SAME number as the card value, 21, never a
    // second one). No numeral from the recorded run itself appears.
    expect(cards.refused.sub).toBe(
      'Recorded run, 24 Nov 2026 · 21 refused on chain since deploy — a wrong amount, a second payment or a changed payee stops before any money moves.',
    )
  })
  it('counts the paid sub from the list, not from stats alone', () => {
    const cards = dashboardStats(STATS, ITEMS)
    expect(cards.paid.sub).toBe('2 of 4 payables paid')
  })
  it('never lets stats disagree with the list: the list is the source', () => {
    // The live bug: stats said 57 payables / 31 paid while the list showed
    // 51 (25, then 51) — two sources in one render. Cards now derive from
    // the list itself, so a stale or larger stats snapshot cannot move them.
    const stale = { ...STATS, payables_total: 10, paid_total: 9 }
    const cards = dashboardStats(stale, ITEMS)
    expect(cards.total.value).toBe(4)
    expect(cards.paid.value).toBe(2)
    expect(cards.paid.sub).toBe('2 of 4 payables paid')
    expect(cards.unpaid.value).toBe(2)
  })
  it('names nothing excluded when nothing is excluded', () => {
    const cards = dashboardStats({ ...STATS, voided_total: 0 }, ITEMS)
    expect(cards.total.sub).toBe('Live from the test registry')
  })
})
