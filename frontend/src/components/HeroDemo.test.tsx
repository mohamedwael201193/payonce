// HeroDemo — the SMALL demo glimpse in the hero card (fix-back-6 B6).
// Asserts: the card is a glimpse only — stat chips + a 3-row invoice
// table + a link to the real dashboard. No walkthrough, no checks, no pay
// button, no progress bar, no receipt box, no cursor, no auto-play; the
// label is "Demo" (never "Simulation"); the demo makes ZERO network calls
// (no fetch, no pay POST) and shows no real-looking transaction hash.
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeroDemo } from './HeroDemo'
import { demoStatChips, demoTableRows } from '../lib/heroDemo'
import type { InvoiceItem, Stats } from '../lib/types'

// Same live shape as HeroOverview.test.tsx: 13 payables, 8 paid, 5
// unpaid, 18 refused. Dues are relative to Date.now() (MF-H1 pattern):
// payable 5 is past due (−1 d, Overdue pill, first in the table),
// payable 1004 is the soonest-due unpaid (+1 d), 1/2/3 sit at +7 d.
const DAY_MS = 24 * 60 * 60 * 1000
const dueInDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()
const COMPONENT_INVOICES: InvoiceItem[] = [
  { payable_id: 1, asset: 'ccd', amount_display: '10.000000 CCD', due: dueInDays(7), status: 'unpaid', label: 'Lab invoice' },
  { payable_id: 2, asset: 'ccd', amount_display: '5.000000 CCD', due: dueInDays(7), status: 'unpaid', label: 'Lab invoice' },
  { payable_id: 3, asset: 'eudemo', amount_display: '1.00 EUDemo', due: dueInDays(7), status: 'unpaid', label: 'Lab invoice' },
  { payable_id: 5, asset: 'ccd', amount_display: '1.000000 CCD', due: dueInDays(-1), status: 'unpaid', label: 'Lab invoice' },
  { payable_id: 10, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { payable_id: 11, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { payable_id: 1000, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { payable_id: 1001, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { payable_id: 1002, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { payable_id: 1003, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { payable_id: 1004, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(1), status: 'unpaid', label: 'Lab invoice' },
  { payable_id: 1005, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { payable_id: 1006, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
]
const STATS: Stats = {
  payables_total: 14,
  paid_total: 8,
  refused_on_chain_since_deploy: 18,
  last_verifier_run_at: '2026-11-24T17:08:24.616Z',
}

function renderDemo(items: InvoiceItem[], stats: Stats | undefined) {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <section>
        <HeroDemo items={items} stats={stats} />
      </section>
    </MemoryRouter>,
  )
}

describe('heroDemo lib (glimpse only)', () => {
  it('counts the 4 stat chips from the live list, refused null until stats load', () => {
    expect(demoStatChips(COMPONENT_INVOICES, STATS)).toEqual([
      { label: 'Total', value: 13 },
      { label: 'Paid', value: 8 },
      { label: 'Unpaid', value: 5 },
      { label: 'Refused', value: 18 },
    ])
    expect(demoStatChips(COMPONENT_INVOICES, undefined)[3]).toEqual({ label: 'Refused', value: null })
  })

  it('shows the 3 soonest-due unpaid payables, soonest first', () => {
    expect(demoTableRows(COMPONENT_INVOICES).map((i) => i.payable_id)).toEqual([5, 1004, 1])
  })
})

describe('HeroDemo component (small glimpse, B6)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchSpy)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('labels itself Demo (never Simulation) and shows chips + a 3-row table + the real-dashboard link', () => {
    const { container } = renderDemo(COMPONENT_INVOICES, STATS)
    expect(screen.getByText('Demo')).toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Live Invoices')).toBeInTheDocument()
    expect(screen.getByText(/Showing 3 of 13 invoices/)).toBeInTheDocument()
    // The 4 stat chips mirror the real dashboard's 4 stat cards.
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('Paid')).toBeInTheDocument()
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Refused')).toBeInTheDocument()
    // The table shows the soonest-due unpaid payables, with pills.
    expect(screen.getByText('Payable 1004')).toBeInTheDocument()
    expect(screen.getByText('Payable 5')).toBeInTheDocument()
    expect(screen.getByText('View the real dashboard →')).toBeInTheDocument()
    // No "Simulation" anywhere, no real-looking transaction hash.
    expect(container.textContent).not.toMatch(/simulat/i)
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{64}/)
  })

  it('is a glimpse, not a walkthrough: no steps, no checks, no pay button, no receipt, no cursor', () => {
    const { container } = renderDemo(COMPONENT_INVOICES, STATS)
    expect(screen.queryByText('Pick an invoice')).toBeNull()
    expect(screen.queryByText('Check the invoice')).toBeNull()
    expect(screen.queryByText('Pay once')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByText(/Demo verdict/)).toBeNull()
    expect(screen.queryByText(/Demo receipt/)).toBeNull()
    expect(screen.queryByText(/Paid once — demo/)).toBeNull()
    expect(document.querySelector('[data-demo-cursor]')).toBeNull()
    expect(document.querySelector('.demo-ripple')).toBeNull()
    expect(container.querySelector('[data-demo-phase]')).toBeNull()
  })

  it('makes zero network calls — it only renders props', () => {
    renderDemo(COMPONENT_INVOICES, STATS)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('shows the N1 refused caption under the live chips (one refused number + its basis)', () => {
    renderDemo(COMPONENT_INVOICES, STATS)
    expect(screen.getByText('Recorded run, 24 Nov 2026 · 18 refused on chain since deploy')).toBeInTheDocument()
  })

  it('shows the N1 caption with no number while the stats have not loaded', () => {
    renderDemo(COMPONENT_INVOICES, undefined)
    expect(screen.getByText('Recorded run, 24 Nov 2026')).toBeInTheDocument()
  })

  it('shows "—" for Refused when the stats have not loaded (never 0)', () => {
    renderDemo(COMPONENT_INVOICES, undefined)
    const list = screen.getByLabelText('Live totals')
    const refused = within(list).getByText('Refused').closest('li') as HTMLElement
    expect(refused).toHaveTextContent('—')
    expect(refused).not.toHaveTextContent('0')
    // The other chips still show live counts from the list.
    expect(within(list).getByText('Total').closest('li')).toHaveTextContent('13')
  })

  it('shows the loading skeleton while the live list loads', () => {
    renderDemo([], undefined)
    expect(screen.getByText(/Demo unavailable — the live invoice list is still loading/)).toBeInTheDocument()
    expect(screen.queryByText('Live Invoices')).toBeNull()
  })

  // Fix-back-7 MF-7: a first-load error is an error, not an endless
  // loading skeleton — and an error WITH kept data still renders the
  // chips and table, never the error box.
  it('shows a load error — not the loading skeleton — when the snapshot errors with no data', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <section>
          <HeroDemo items={[]} stats={undefined} error />
        </section>
      </MemoryRouter>,
    )
    expect(screen.getByRole('alert')).toHaveTextContent('Could not load the live numbers — the test API did not answer.')
    expect(screen.queryByText(/still loading/)).toBeNull()
  })

  it('still renders kept data when the snapshot errors after a successful load', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <section>
          <HeroDemo items={COMPONENT_INVOICES} stats={STATS} error />
        </section>
      </MemoryRouter>,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('Live Invoices')).toBeInTheDocument()
  })
})
