// HeroDemo — the TALL demo dashboard in the hero card (user rulings
// 2026-11-26 00:37 + 01:24: match the Altura reference video frame by
// frame — COMPACT and DENSE, with the animated mouse back).
// Asserts: the panel is a tall, dense dashboard preview — real-nav sidebar,
// header strip, Payables overview chart WITH an axis, paid-once gauge with
// stat rows, payment rails, insights and Next-14-days panels — with live
// numbers only, and a tour cursor that glides between the landmarks. Still
// a glimpse, not a walkthrough: no steps, no checks, no pay button, no
// receipt; the label is "Demo" (never "Simulation"); the demo makes ZERO
// network calls (no fetch, no pay POST) and shows no real-looking
// transaction hash. Numbers are asserted SCOPED (within a testid or a
// section) — bare length-2 counts pass even when the demo is wrong.
import { render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeroDemo } from './HeroDemo'
import type { InvoiceItem, Stats } from '../lib/types'

// Same live shape as HeroOverview.test.tsx: 13 payables, 8 paid, 5
// unpaid, 18 refused. Dues are relative to Date.now() (MF-H1 pattern):
// payable 5 is past due (−1 d, in Insights but NOT in Next 14 days),
// payable 1004 is the soonest-due upcoming (+1 d), 1/2/3 sit at +7 d.
const DAY_MS = 24 * 60 * 60 * 1000
const dueInDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()
const COMPONENT_INVOICES: InvoiceItem[] = [
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1, asset: 'ccd', amount_display: '10.000000 CCD', due: dueInDays(7), status: 'unpaid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 2, asset: 'ccd', amount_display: '5.000000 CCD', due: dueInDays(7), status: 'unpaid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 3, asset: 'eudemo', amount_display: '1.00 EUDemo', due: dueInDays(7), status: 'unpaid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 5, asset: 'ccd', amount_display: '1.000000 CCD', due: dueInDays(-1), status: 'unpaid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 10, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 11, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1000, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1001, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1002, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1003, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1004, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(1), status: 'unpaid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1005, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1006, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
]
// CCD-only list (no EUDemo payables at all) for the EUDemo-zero case.
const CCD_ONLY: InvoiceItem[] = [
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1, asset: 'ccd', amount_display: '10.000000 CCD', due: dueInDays(7), status: 'unpaid', label: 'Lab invoice' },
  { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 10, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(-2), status: 'paid', label: 'Lab invoice' },
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

describe('HeroDemo component (tall, dense dashboard preview)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('matchMedia', (_q: string) => ({
      matches: false,
      media: _q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('labels itself Demo (never Simulation) and shows the dense tall shape: real-nav sidebar, header strip, chart with axis, gauge stats, rails, insights, next 14 days', () => {
    const { container } = renderDemo(COMPONENT_INVOICES, STATS)
    expect(screen.getByText('Demo')).toBeInTheDocument()
    // Sidebar — the real app's nav only (no Search, no pay-flow row).
    const sidebar = screen.getByTestId('demo-sidebar')
    expect(within(sidebar).getByText('Home')).toBeInTheDocument()
    expect(within(sidebar).getByText('Dashboard')).toBeInTheDocument()
    expect(within(sidebar).getByText('For judges')).toBeInTheDocument()
    expect(within(sidebar).getByText('Verify age')).toBeInTheDocument()
    expect(within(sidebar).queryByText('Search')).toBeNull()
    expect(within(sidebar).queryByText('Pay an invoice')).toBeNull()
    expect(screen.queryByText('Search')).toBeNull()
    expect(screen.queryByText('Pay an invoice')).toBeNull()
    // Header strip — the video's tabs/header row, labelled Preview at
    // strip level (the tag scopes the whole strip), with the live list's
    // real due range as the date pill. The frame's "Export" / "+ New
    // forecast" actions are NOT here: PayOnce has no export or forecast
    // feature, and a dark primary-styled pill would read as a real action
    // for a feature that does not exist (honesty + adversarial re-review).
    const strip = screen.getByTestId('demo-header-strip')
    expect(within(strip).getByText('Overview')).toBeInTheDocument()
    expect(within(strip).getByText('Inflows')).toBeInTheDocument()
    expect(within(strip).getByText('Outflows')).toBeInTheDocument()
    expect(within(strip).getByText('Accounts')).toBeInTheDocument()
    expect(within(strip).getByText('Preview')).toBeInTheDocument()
    expect(within(strip).queryByText('Export')).toBeNull()
    expect(within(strip).queryByText('New forecast')).toBeNull()
    expect(within(strip).getByText(/\w{3} \d{4}/)).toBeInTheDocument()
    // Chart — big CCD total + EUDemo chip, each asserted in its own
    // element (a bare length-2 count would pass even if the demo is wrong).
    expect(within(screen.getByTestId('demo-big-total')).getByText('19.00 CCD')).toBeInTheDocument()
    expect(within(screen.getByTestId('demo-eudemo-chip')).getByText('1.03 EUDemo')).toBeInTheDocument()
    expect(screen.getByText('8 paid once · 5 unpaid · 13 listed')).toBeInTheDocument()
    expect(screen.getByRole('img', { name: /CCD payables by due month, paid solid, unpaid hatched, up to .* CCD/ })).toBeInTheDocument()
    // The axis ticks render as real text (5 ticks, 0 at the bottom) and
    // the bars are monthly — wide bars with month labels, never one stub
    // per payable.
    const axis = screen.getByTestId('demo-chart-axis')
    expect(within(axis).getAllByText(/^\d+(\.\d+)?$/)).toHaveLength(5)
    expect(within(axis).getByText('0')).toBeInTheDocument()
    // One bar per due month in the fixture (dues are relative to now, so
    // the month split is computed, not hardcoded).
    const fixtureMonths = new Set(
      COMPONENT_INVOICES.filter((i) => i.asset === 'ccd').map((i) => new Date(i.due).toISOString().slice(0, 7)),
    )
    expect(screen.getAllByTestId('demo-chart-bar')).toHaveLength(fixtureMonths.size)
    expect(screen.getByText('EUDemo payables are not on this axis — they are in Payment rails.')).toBeInTheDocument()
    // Gauge — stat rows are the two real asset totals; no aspirational Target line.
    expect(screen.getByText('Paid once')).toBeInTheDocument()
    expect(screen.getByText('8 of 13 payables paid once')).toBeInTheDocument()
    const gaugeStats = screen.getByTestId('demo-gauge-stats')
    expect(within(gaugeStats).getByText('CCD total')).toBeInTheDocument()
    expect(within(gaugeStats).getByText('19.00 CCD')).toBeInTheDocument()
    expect(within(gaugeStats).getByText('EUDemo total')).toBeInTheDocument()
    expect(within(gaugeStats).getByText('1.03 EUDemo')).toBeInTheDocument()
    expect(screen.queryByText(/Target:/)).toBeNull()
    // Rails / insights / next 14 days.
    expect(screen.getByText('Payment rails')).toBeInTheDocument()
    expect(screen.getByText('Rail A · CCD')).toBeInTheDocument()
    expect(screen.getByText('Rail B · EUDemo')).toBeInTheDocument()
    expect(screen.getByText('Insights')).toBeInTheDocument()
    expect(screen.getByText('5 invoices still unpaid')).toBeInTheDocument()
    expect(screen.getByText('18 payments refused on chain since deploy')).toBeInTheDocument()
    expect(screen.getByText('Next 14 days')).toBeInTheDocument()
    expect(screen.getByText('Payable 1004')).toBeInTheDocument()
    expect(screen.getByText('Payable 1')).toBeInTheDocument()
    expect(screen.getByText('Payable 2')).toBeInTheDocument()
    expect(screen.queryByText('Payable 5')).toBeNull() // overdue: past, not next
    expect(screen.getByText('View the real dashboard →')).toBeInTheDocument()
    // Footer disclosure.
    expect(screen.getByText(/Demo — the panels above show live numbers from the test registry/)).toBeInTheDocument()
    // No "Simulation" anywhere, no real-looking transaction hash, no AI.
    expect(container.textContent).not.toMatch(/simulat/i)
    expect(container.textContent).not.toMatch(/AI insights/i)
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{64}/)
  })

  it('is a glimpse with a tour cursor, not a walkthrough: no steps, no checks, no pay button, no receipt, no tablist', () => {
    const { container } = renderDemo(COMPONENT_INVOICES, STATS)
    expect(screen.queryByText('Pick an invoice')).toBeNull()
    expect(screen.queryByText('Check the invoice')).toBeNull()
    expect(screen.queryByText('Pay once')).toBeNull()
    expect(screen.queryByRole('button')).toBeNull()
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByText(/Demo verdict/)).toBeNull()
    expect(screen.queryByText(/Demo receipt/)).toBeNull()
    expect(screen.queryByText(/Paid once — demo/)).toBeNull()
    // The tour cursor is back (fix-back 2026-11-26): an overlay over the
    // panel, present in live mode — and it never scrolls the page. It
    // glides and dwells; it never presses, never clicks, never ripples.
    expect(document.querySelector('[data-demo-cursor]')).not.toBeNull()
    expect(document.querySelector('.demo-ripple')).toBeNull()
    expect(document.querySelector('[data-demo-phase]')).toBeNull()
    expect(container.querySelector('[data-demo-phase]')).toBeNull()
  })

  it('shows no cursor when reduced motion is preferred', () => {
    vi.stubGlobal('matchMedia', (q: string) => ({
      matches: q.includes('prefers-reduced-motion'),
      media: q,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
    }))
    renderDemo(COMPONENT_INVOICES, STATS)
    expect(document.querySelector('[data-demo-cursor]')).toBeNull()
  })

  it('has exactly one link out (the real dashboard)', () => {
    renderDemo(COMPONENT_INVOICES, STATS)
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', '/dashboard')
  })

  it('makes zero network calls — it only renders props', () => {
    renderDemo(COMPONENT_INVOICES, STATS)
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('shows the N1 refused caption under the gauge (one refused number + its basis)', () => {
    renderDemo(COMPONENT_INVOICES, STATS)
    expect(screen.getByText('Recorded run, 24 Nov 2026 · 18 refused on chain since deploy')).toBeInTheDocument()
  })

  it('shows NO refused caption while the stats have not loaded (never a hardcoded date, never 0)', () => {
    renderDemo(COMPONENT_INVOICES, undefined)
    expect(screen.queryByText(/Recorded run/)).toBeNull()
    expect(screen.queryByText(/refused on chain/)).toBeNull()
  })

  it('shows the EUDemo chip at zero instead of hiding it (the rails panel agrees)', () => {
    renderDemo(CCD_ONLY, STATS)
    expect(within(screen.getByTestId('demo-eudemo-chip')).getByText('0.00 EUDemo')).toBeInTheDocument()
    const rails = document.querySelector('[data-demo-target="rails"]') as HTMLElement
    expect(within(rails).getByText('0.00 EUDemo')).toBeInTheDocument()
  })

  it('shows the empty-state gauge at 0 of 0 (never a loading skeleton)', () => {
    renderDemo([], STATS)
    expect(screen.getByText('0 of 0 payables paid once')).toBeInTheDocument()
    expect(within(screen.getByTestId('demo-eudemo-chip')).getByText('0.00 EUDemo')).toBeInTheDocument()
    expect(screen.queryByText(/still loading/)).toBeNull()
  })

  it('stays readable at the live scale: 53 payables render as 3 wide monthly bars, never 53 stubs', () => {
    const many: InvoiceItem[] = []
    for (let i = 0; i < 53; i++) {
      const month = ['2026-11-15', '2026-12-10', '2027-01-05'][i % 3]
      many.push({
        seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB',
        payable_id: 2000 + i,
        asset: 'ccd',
        amount_display: i % 5 === 0 ? '10.000000 CCD' : '0.500000 CCD',
        due: `${month}T08:00:00.000Z`,
        status: i % 2 === 0 ? 'paid' : 'unpaid',
        label: 'Lab invoice',
      })
    }
    renderDemo(many, STATS)
    const bars = screen.getAllByTestId('demo-chart-bar')
    expect(bars).toHaveLength(3)
    expect(screen.getByText('Nov 26')).toBeInTheDocument()
    expect(screen.getByText('Dec 26')).toBeInTheDocument()
    expect(screen.getByText('Jan 27')).toBeInTheDocument()
    // The axis still renders its 5 ticks against the monthly scale.
    expect(within(screen.getByTestId('demo-chart-axis')).getAllByText(/^\d+(\.\d+)?$/)).toHaveLength(5)
  })

  it('shows the mobile nav strip with the real nav (finding #9)', () => {
    renderDemo(COMPONENT_INVOICES, STATS)
    const strip = screen.getByTestId('demo-mobile-nav')
    expect(within(strip).getByText('Home')).toBeInTheDocument()
    expect(within(strip).getByText('Dashboard')).toBeInTheDocument()
    expect(within(strip).getByText('For judges')).toBeInTheDocument()
    expect(within(strip).getByText('Verify age')).toBeInTheDocument()
    expect(within(strip).queryByText('Pay an invoice')).toBeNull()
  })

  it('shows the loading skeleton while the live list loads', () => {
    renderDemo([], undefined)
    expect(screen.getByText(/Demo unavailable — the live invoice list is still loading/)).toBeInTheDocument()
    expect(screen.queryByText('Payables overview')).toBeNull()
  })

  it('shows an honest empty state when the list loads empty (never a loading skeleton)', () => {
    renderDemo([], STATS)
    expect(screen.queryByText(/still loading/)).toBeNull()
    expect(screen.getByText('No CCD payables on the test registry yet.')).toBeInTheDocument()
    expect(screen.getByText('No payables on the test registry yet.')).toBeInTheDocument()
    // The refused total still comes from stats — an empty list hides nothing.
    expect(screen.getByText('18 payments refused on chain since deploy')).toBeInTheDocument()
  })

  // Fix-back-7 MF-7: a first-load error is an error, not an endless
  // loading skeleton — and an error WITH kept data still renders the
  // panels, never the error box.
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
    expect(screen.getByText('Payables overview')).toBeInTheDocument()
  })

  // Fix-back-8 MF-4: an error WITH kept data must disclose the staleness
  // — the same could-not-refresh note as the dashboard banner — instead
  // of silently labelling kept numbers live. The note names the kept
  // time when the caller passes it.
  it('shows a could-not-refresh note (not an alert) when the snapshot errors with kept data', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <section>
          <HeroDemo items={COMPONENT_INVOICES} stats={STATS} error lastUpdated="10:42:07 UTC" />
        </section>
      </MemoryRouter>,
    )
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByRole('status')).toHaveTextContent(
      'Could not refresh the live numbers just now — showing the last verified numbers from 10:42:07 UTC. The page retries every 30 s.',
    )
    expect(screen.getByText('Payables overview')).toBeInTheDocument()
  })

  it('shows the stale note without a time when no last-updated time is passed', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <section>
          <HeroDemo items={COMPONENT_INVOICES} stats={STATS} error />
        </section>
      </MemoryRouter>,
    )
    expect(screen.getByRole('status')).toHaveTextContent('Could not refresh the live numbers just now')
    expect(screen.getByRole('status')).not.toHaveTextContent('from')
  })

  // Fix-back-8 MF-4: home shows a "Last updated" line for the demo
  // (it had none); on a fresh load there is no stale note.
  it('shows a Last updated line on a fresh load and no stale note', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <section>
          <HeroDemo items={COMPONENT_INVOICES} stats={STATS} lastUpdated="10:42:07 UTC" />
        </section>
      </MemoryRouter>,
    )
    expect(screen.getByText('Last updated: 10:42:07 UTC · refreshing every 30 s')).toBeInTheDocument()
    expect(screen.queryByText(/Could not refresh/)).toBeNull()
  })
})
