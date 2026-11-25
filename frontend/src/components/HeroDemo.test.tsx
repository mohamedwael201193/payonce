// HeroDemo — the looping "Demo" walkthrough inside the hero card.
// Asserts: the demo mirrors the real dashboard + the real 01–04 flow,
// the label is "Demo" (never "Simulation"), the timeline runs a full
// loop and wraps, hovering pauses it, reduced motion shows a static
// finished frame, and the demo makes ZERO network calls (no fetch, no
// pay POST) and shows no real-looking transaction hash.
import { act } from 'react'
import { fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeroDemo } from './HeroDemo'
import {
  DEMO_CHECK_COUNT,
  DEMO_LOOP_MS,
  curvedPoint,
  demoCheckRows,
  demoFrameAt,
  demoInvoice,
  type DemoWaypoints,
} from '../lib/heroDemo'
import type { InvoiceItem, Stats } from '../lib/types'

// Same live shape as HeroOverview.test.tsx: 13 payables, 8 paid, 5
// unpaid, 18 refused.
//
// TWO fixtures, deliberately split (fix-back-5 MF-H4 — the trap that
// killed the naive fix): the lib tests pin NOW to 2026-11-24T12:00Z and
// call demoInvoice(items, NOW) with an explicit now, so their fixture
// MUST stay fixed — relativizing it would make payable 5 future vs the
// pinned NOW once real time passes 2026-11-25T12:00Z and the lib pick
// would flip 1004 → 5. The rendered-component tests run on REAL now
// (HeroDemo.tsx calls demoInvoice(items) / derivedStatus(inv) with no
// now arg), so their fixture MUST be relative to Date.now() — the old
// fixed 1004 due 2026-11-25T10:58:25.269Z detonated the pick-identity
// assertions the morning it passed. LIB_INVOICES is used ONLY with the
// pinned NOW; COMPONENT_INVOICES is used ONLY by the rendered tests.
const LIB_INVOICES: InvoiceItem[] = [
  { payable_id: 1, asset: 'ccd', amount_display: '10.000000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'unpaid', label: 'Lab invoice' },
  { payable_id: 2, asset: 'ccd', amount_display: '5.000000 CCD', due: '2026-12-01T08:03:26.555Z', status: 'unpaid', label: 'Lab invoice' },
  { payable_id: 3, asset: 'eudemo', amount_display: '1.00 EUDemo', due: '2026-12-01T08:03:26.555Z', status: 'unpaid', label: 'Lab invoice' },
  { payable_id: 5, asset: 'ccd', amount_display: '1.000000 CCD', due: '2026-11-24T08:05:59.988Z', status: 'unpaid', label: 'Lab invoice' },
  { payable_id: 10, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-12-26T12:00:00.000Z', status: 'paid', label: 'Lab invoice' },
  { payable_id: 11, asset: 'eudemo', amount_display: '0.01 EUDemo', due: '2026-12-26T12:00:00.000Z', status: 'paid', label: 'Lab invoice' },
  { payable_id: 1000, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-11-25T10:50:03.797Z', status: 'paid', label: 'Lab invoice' },
  { payable_id: 1001, asset: 'eudemo', amount_display: '0.01 EUDemo', due: '2026-11-25T10:50:40.533Z', status: 'paid', label: 'Lab invoice' },
  { payable_id: 1002, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-11-25T10:56:58.441Z', status: 'paid', label: 'Lab invoice' },
  { payable_id: 1003, asset: 'eudemo', amount_display: '0.01 EUDemo', due: '2026-11-25T10:57:38.512Z', status: 'paid', label: 'Lab invoice' },
  { payable_id: 1004, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-11-25T10:58:25.269Z', status: 'unpaid', label: 'Lab invoice' },
  { payable_id: 1005, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-11-25T13:11:46.300Z', status: 'paid', label: 'Lab invoice' },
  { payable_id: 1006, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-11-25T15:07:59.465Z', status: 'paid', label: 'Lab invoice' },
]

const DAY_MS = 24 * 60 * 60 * 1000
// Relative dues (same dueInDays pattern as MF-H1): payable 5 is past due
// (−1 d, skipped by the pick, Overdue pill, first in the table), payable
// 1004 is the soonest-due unpaid CCD payable that is not past due (+1 d,
// the pick), 1/2/3 sit at +7 d (table order 5/1004/1 preserved, Unpaid
// pills preserved). Paid items sit in the past — status is 'paid'
// regardless of due. Computed from Date.now() at import, so this fixture
// can never expire: at any run date the pick is still 1004.
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
const NOW = new Date('2026-11-24T12:00:00.000Z').getTime()

const W: DemoWaypoints = {
  rest: { x: 0, y: 0 },
  invoice: { x: 100, y: 0 },
  check: { x: 100, y: 100 },
  pay: { x: 0, y: 100 },
  receipt: { x: 50, y: 50 },
}

function renderDemo() {
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <section>
        <HeroDemo items={COMPONENT_INVOICES} stats={STATS} />
      </section>
    </MemoryRouter>,
  )
}

describe('heroDemo lib', () => {
  it('picks the soonest-due unpaid CCD payable that is not past due (1004, not 5)', () => {
    const inv = demoInvoice(LIB_INVOICES, NOW)
    expect(inv?.payable_id).toBe(1004)
    expect(inv?.amount_display).toBe('0.500000 CCD')
  })

  it('returns null when no unpaid CCD payable is due in the future', () => {
    const allPast = LIB_INVOICES.map((i) => ({ ...i, due: '2026-11-01T00:00:00.000Z' }))
    expect(demoInvoice(allPast, NOW)).toBeNull()
    const allPaid = LIB_INVOICES.map((i) => ({ ...i, status: 'paid' as const }))
    expect(demoInvoice(allPaid, NOW)).toBeNull()
  })

  it('shows the 9 real before-pay checks with the real verdict rule', () => {
    const rows = demoCheckRows(LIB_INVOICES.find((i) => i.payable_id === 1004)!)
    expect(rows).toHaveLength(DEMO_CHECK_COUNT)
    expect(rows.map((r) => r.label)).toEqual([
      'Payable is registered on the test registry',
      'Invoice document matches the on-chain hash',
      'Seller agent is Active on the official CIS-8004 registry',
      'Seller identity',
      'Payee on the invoice',
      'Amount on the invoice',
      'Invoice is not past due',
      'Payable is Unpaid',
      'Payer balance covers the payment',
    ])
    // Gating checks pass, doc is not run, identity/payee/amount are info.
    expect(rows.filter((r) => r.status === 'ok')).toHaveLength(5)
    expect(rows.find((r) => r.id === 'doc')?.status).toBe('not_run')
    expect(rows.filter((r) => r.status === 'info')).toHaveLength(3)
    expect(rows.every((r) => r.detail.startsWith('Demo:'))).toBe(true)
  })

  it('runs the timeline pick → check → pay → receipt and wraps the loop', () => {
    expect(demoFrameAt(0, W).phase).toBe('rest')
    expect(demoFrameAt(2000, W).phase).toBe('pick')
    expect(demoFrameAt(3000, W).phase).toBe('pick')
    expect(demoFrameAt(3000, W).picked).toBe(true)
    expect(demoFrameAt(6000, W).phase).toBe('checking')
    expect(demoFrameAt(6000, W).checksShown).toBeGreaterThan(0)
    expect(demoFrameAt(6000, W).checksShown).toBeLessThanOrEqual(DEMO_CHECK_COUNT)
    const checked = demoFrameAt(9000, W)
    expect(checked.phase).toBe('checked')
    expect(checked.verdict).toBe(true)
    expect(checked.checksShown).toBe(DEMO_CHECK_COUNT)
    const paying = demoFrameAt(12000, W)
    expect(paying.phase).toBe('paying')
    expect(paying.payProgress).toBeGreaterThan(0)
    expect(paying.payProgress).toBeLessThan(1)
    const paid = demoFrameAt(15000, W)
    expect(paid.phase).toBe('paid')
    expect(paid.paid).toBe(true)
    expect(paid.payProgress).toBe(1)
    const receipt = demoFrameAt(18000, W)
    expect(receipt.phase).toBe('receipt')
    expect(receipt.receipt).toBe(true)
    // Loop wraps: one millisecond past the loop is rest again.
    expect(demoFrameAt(DEMO_LOOP_MS, W).phase).toBe('rest')
    expect(demoFrameAt(DEMO_LOOP_MS, W).picked).toBe(false)
    expect(demoFrameAt(DEMO_LOOP_MS + 3000, W).picked).toBe(true)
  })

  it('curves the cursor path instead of a robotic straight line', () => {
    const from = { x: 0, y: 0 }
    const to = { x: 100, y: 0 }
    const mid = curvedPoint(from, to, 0.5)
    // Straight-line midpoint would be (50, 0); the bow pushes it off-axis.
    expect(Math.abs(mid.y)).toBeGreaterThan(1)
    expect(mid.x).toBeGreaterThan(40)
    expect(mid.x).toBeLessThan(60)
  })
})

describe('HeroDemo component', () => {
  let fetchSpy: ReturnType<typeof vi.fn>
  let rafCb: FrameRequestCallback | null
  let now: number

  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }))
    vi.stubGlobal('fetch', fetchSpy)
    rafCb = null
    now = 1000
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCb = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      rafCb = null
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Advance the rAF clock by ms (100ms steps — the engine caps dt at 100). */
  const advance = (ms: number) => {
    const steps = Math.ceil(ms / 100)
    for (let i = 0; i < steps; i++) {
      now += 100
      const cb = rafCb
      rafCb = null
      act(() => {
        cb?.(now)
      })
    }
  }

  it('labels itself Demo (never Simulation) and mirrors the dashboard + flow', () => {
    const { container } = renderDemo()
    expect(screen.getByText('Demo')).toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Live Invoices')).toBeInTheDocument()
    expect(screen.getByText(/Showing 3 of 13 invoices/)).toBeInTheDocument()
    // The 4 stat chips mirror the real dashboard's 4 stat cards.
    expect(screen.getByText('Total')).toBeInTheDocument()
    expect(screen.getByText('Paid')).toBeInTheDocument()
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThanOrEqual(2)
    expect(screen.getByText('Refused')).toBeInTheDocument()
    // The 4 flow steps mirror the real 01–04 steps.
    expect(screen.getByText('Pick an invoice')).toBeInTheDocument()
    expect(screen.getByText('Check the invoice')).toBeInTheDocument()
    expect(screen.getByText('Pay once')).toBeInTheDocument()
    expect(screen.getByText('Receipt')).toBeInTheDocument()
    // The demo table shows the soonest-due unpaid payables, with pills.
    expect(screen.getByText('Payable 1004')).toBeInTheDocument()
    expect(screen.getByText('Payable 5')).toBeInTheDocument()
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThanOrEqual(2)
    // The demo buttons mirror the real flow buttons.
    expect(screen.getByRole('button', { name: 'Check invoice (demo)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay on chain (demo)' })).toBeInTheDocument()
    // No "Simulation" anywhere, no real-looking transaction hash.
    expect(container.textContent).not.toMatch(/simulat/i)
    expect(document.body.textContent).not.toMatch(/[0-9a-f]{64}/)
  })

  it('makes zero network calls through a full loop — no fetch, no pay POST', () => {
    renderDemo()
    advance(DEMO_LOOP_MS + 2000)
    expect(fetchSpy).not.toHaveBeenCalled()
    // Clicking the demo buttons also does nothing (they are inert props).
    fireEvent.click(screen.getByRole('button', { name: 'Check invoice (demo)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Pay on chain (demo)' }))
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  it('runs the loop pick → verdict → paid → receipt, then wraps', () => {
    renderDemo()
    expect(screen.queryByText('Demo pick')).toBeNull()
    advance(3500)
    expect(screen.getByText('Demo pick')).toBeInTheDocument()
    expect(screen.getByText('Payable 1004 · 0.500000 CCD')).toBeInTheDocument()
    advance(6000)
    expect(screen.getByText(/Demo verdict: ready/)).toBeInTheDocument()
    advance(6000)
    expect(screen.getByText('Paid once — demo.')).toBeInTheDocument()
    advance(3000)
    expect(screen.getByText('Demo receipt — not a real payment. No money moved.')).toBeInTheDocument()
    // The receipt slot is reserved, not conditionally rendered: after the
    // loop wraps the receipt text is still in the DOM but invisible, and
    // the empty-state text is visible again — the box never changes
    // height mid-loop (FIX-3: the old conditional render grew it ~100 px).
    expect(screen.getByTestId('demo-receipt-body')).not.toHaveClass('invisible')
    expect(screen.getByTestId('demo-receipt-empty')).toHaveClass('invisible')
    // Loop wraps: the receipt is hidden again, then the pick happens again.
    advance(6000)
    expect(screen.getByTestId('demo-receipt-body')).toHaveClass('invisible')
    expect(screen.getByTestId('demo-receipt-empty')).not.toHaveClass('invisible')
    expect(screen.queryByText('Demo pick')).toBeNull()
    advance(3500)
    expect(screen.getByText('Demo pick')).toBeInTheDocument()
  })

  it('shows the N1 refused caption under the live chips (one refused number + its basis)', () => {
    renderDemo()
    expect(screen.getByText('Recorded run, 24 Nov 2026 · 18 refused on chain since deploy')).toBeInTheDocument()
  })

  it('shows the N1 caption with no number while the stats have not loaded', () => {
    render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <section>
          <HeroDemo items={COMPONENT_INVOICES} stats={undefined} />
        </section>
      </MemoryRouter>,
    )
    expect(screen.getByText('Recorded run, 24 Nov 2026')).toBeInTheDocument()
  })

  it('renames the buttons once their step is done (Checked ✓ / Paid ✓ — demo)', () => {
    renderDemo()
    // Before the verdict the buttons carry their action labels…
    expect(screen.getByRole('button', { name: 'Check invoice (demo)' })).toHaveTextContent('Check invoice')
    expect(screen.getByRole('button', { name: 'Pay on chain (demo)' })).toHaveTextContent('Pay 0.500000 CCD on chain')
    advance(3500)
    advance(6000)
    expect(screen.getByText(/Demo verdict: ready/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check invoice (demo)' })).toHaveTextContent('Checked ✓')
    // …and once paid, the pay button says so (its accessible name never changes).
    advance(6000)
    expect(screen.getByText('Paid once — demo.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay on chain (demo)' })).toHaveTextContent('Paid ✓ — demo')
  })

  it('pauses on hover and resumes on leave', () => {
    renderDemo()
    advance(6000)
    // Mid-check: some checks revealed, verdict not yet shown.
    const shown = screen.getAllByText('Passed').length
    expect(shown).toBeGreaterThan(0)
    expect(screen.queryByText(/Demo verdict: ready/)).toBeNull()
    // Hover the hero card → the clock freezes.
    fireEvent.mouseEnter(document.querySelector('section')!)
    advance(5000)
    expect(screen.getAllByText('Passed').length).toBe(shown)
    expect(screen.queryByText(/Demo verdict: ready/)).toBeNull()
    // Leave → the loop resumes and reaches the verdict.
    fireEvent.mouseLeave(document.querySelector('section')!)
    advance(3000)
    expect(screen.getByText(/Demo verdict: ready/)).toBeInTheDocument()
  })

  it('shows the finished demo as a static frame under reduced motion', () => {
    vi.stubGlobal(
      'matchMedia',
      (q: string) => ({
        matches: q.includes('reduce'),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        // framer-motion 11 calls the deprecated addListener/removeListener;
        // keep the stub complete so no run logs "addListener is not a function".
        addListener: () => {},
        removeListener: () => {},
      }),
    )
    const { container } = renderDemo()
    expect(container.querySelector('[data-demo-mode="static"]')).toBeTruthy()
    // Finished demo: receipt visible at once, no cursor overlay.
    expect(screen.getByText('Demo receipt — not a real payment. No money moved.')).toBeInTheDocument()
    expect(screen.getByText(/Demo verdict: ready/)).toBeInTheDocument()
    expect(document.querySelector('.demo-ripple')).toBeNull()
    expect(document.querySelector('[data-demo-cursor]')).toBeNull()
    expect(fetchSpy).not.toHaveBeenCalled()
  })

  // Compact mode (the hero card, ~60% width): same walkthrough, same
  // strings, tighter spacing — and a refused count that is unknown shows
  // "—", never a 0 (bug 4).
  function renderCompact(stats?: Stats) {
    return render(
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <section>
          <HeroDemo items={COMPONENT_INVOICES} stats={stats} compact />
        </section>
      </MemoryRouter>,
    )
  }

  it('compact mode keeps the same demo strings and marks itself compact', () => {
    const { container } = renderCompact(STATS)
    expect(container.querySelector('[data-demo-compact="true"]')).toBeTruthy()
    expect(screen.getByText('Demo')).toBeInTheDocument()
    expect(screen.getByText('Dashboard')).toBeInTheDocument()
    expect(screen.getByText('Live Invoices')).toBeInTheDocument()
    expect(screen.getByText(/Showing 3 of 13 invoices/)).toBeInTheDocument()
    expect(screen.getByText('Refused')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Check invoice (demo)' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Pay on chain (demo)' })).toBeInTheDocument()
    // 20 s into the 24 s loop the receipt is on screen (it appears at
    // ~18.5 s and wraps at 24 s).
    advance(20000)
    expect(screen.getByText('Demo receipt — not a real payment. No money moved.')).toBeInTheDocument()
    expect(container.textContent).not.toMatch(/simulat/i)
  })

  it('shows "—" for Refused when the stats have not loaded (never 0)', () => {
    renderCompact(undefined)
    const list = screen.getByLabelText('Live totals')
    const refused = within(list).getByText('Refused').closest('li') as HTMLElement
    expect(refused).toHaveTextContent('—')
    expect(refused).not.toHaveTextContent('0')
    // The other chips still show live counts from the list.
    expect(within(list).getByText('Total').closest('li')).toHaveTextContent('13')
  })
})
