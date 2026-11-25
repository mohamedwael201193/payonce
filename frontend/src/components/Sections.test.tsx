// Sections — ReceiptChecker N2: the live after-pay verifier names the
// paid-status check 'status_paid', not 'status'. The old lookup showed a
// bare "—" after "Paid once: yes." and the verdict line read
// "Verdict: Verdict: paid …". This test pins the live after-pay shape: only
// 'status_paid' present.
// The staged reveal (5 stages, 0.9 s apart) runs on fake timers; the
// queries resolve through the mocked fetch, advanced with act +
// advanceTimersByTimeAsync (waitFor + fake timers deadlock).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VerifierSection } from './Sections'

const INVOICES = {
  items: [
    {
      payable_id: 10,
      asset: 'ccd',
      amount_display: '0.500000 CCD',
      due: '2026-12-26T12:00:00.000Z',
      status: 'Paid',
      label: 'Lab invoice',
    },
  ],
}
const STATS = {
  payables_total: 1,
  paid_total: 1,
  refused_on_chain_since_deploy: 18,
  last_verifier_run_at: '2026-11-24T17:08:24.616Z',
}
// Live after-pay shape: the paid-status check is 'status_paid' with a real
// detail — there is NO 'status' check here.
const VERIFY_AFTER_PAY = {
  payable_id: 10,
  mode: 'after_pay',
  verdict: 'paid',
  passed: 10,
  total: 10,
  blocked_reason: null,
  checks: [
    { id: 'registered', label: 'Payable is registered', status: 'ok', detail: 'seller=42jaZZgd…, id=10, asset=CCD, amount=500000', layer: 'chain' },
    { id: 'doc', label: 'Document hash matches', status: 'ok', detail: 'sha256(doc)=c9fef19aa010ed3d…, stored=c9fef19aa010ed3d…', layer: 'chain' },
    { id: 'agent', label: 'Seller agent active', status: 'ok', detail: 'Seller agent is active on the official registry.', layer: 'chain' },
    { id: 'status_paid', label: 'Registry status is Paid', status: 'ok', detail: 'Paid by 4MvdM… at 2026-11-24T08:37:45.000Z', layer: 'chain' },
    { id: 'amount', label: 'Amount matches', status: 'ok', detail: 'Amount 500000 microCCD matches the document.', layer: 'chain' },
    { id: 'payee', label: 'Payee matches', status: 'ok', detail: 'Payee on chain matches the document.', layer: 'chain' },
    { id: 'due', label: 'Due date', status: 'ok', detail: 'Due 2026-12-26T12:00:00.000Z.', layer: 'chain' },
    { id: 'seller', label: 'Seller', status: 'ok', detail: 'Seller account is the recorded seller.', layer: 'chain' },
    { id: 'reservation', label: 'Reservation', status: 'ok', detail: 'No open reservation blocks the payment.', layer: 'chain' },
    { id: 'receipt', label: 'Receipt', status: 'ok', detail: 'Receipt is re-verifiable on chain.', layer: 'chain' },
  ],
  checked_at: '2026-11-24T17:08:24.616Z',
  read_ms: 120,
}

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('/api/payables/10/verify')
        ? VERIFY_AFTER_PAY
        : url.includes('/api/invoices')
          ? INVOICES
          : url.includes('/api/stats')
            ? STATS
            : null
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

function renderVerifier() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <VerifierSection />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('VerifierSection / ReceiptChecker (N2)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockApi()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shows the real status_paid detail (never a bare dash) and a single Verdict prefix', async () => {
    renderVerifier()
    // Stepped advance: one big advanceTimersByTimeAsync(6000) leaves the
    // reveal timers unscheduled — the verify promise only settles once the
    // clock moves (React Query + React state updates resolve in microtasks
    // between timer ticks). Advance 100ms first so the queries + verify
    // settle and the 5 reveal timers are scheduled, then 5000ms to fire them.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByText(/Paid once: yes/)).toBeInTheDocument()
    expect(screen.getByText(/Paid by 4MvdM… at 2026-11-24T08:37:45/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Paid once: yes\. —/)
    // The verdict line has exactly one "Verdict" (its label), not two.
    expect(screen.getByText(/paid \(10\/10 checks passed\)/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Verdict: Verdict:/)
    expect(document.body.textContent).not.toMatch(/Verdict\. Verdict:/)
  })
})

// HowItWorks step-04 card (FIX-4) + the one "latest payment" rule (FIX-7f):
// the card must show a loading state while the list loads — never the
// "No paid invoice yet" empty state — and the checker + the card must agree
// that the latest payment is the HIGHEST-id paid payable, not paid[0].
import { HowItWorks } from './Sections'

const INVOICES_TWO_PAID = {
  items: [
    // List order is NOT id order: 10 first, 1006 second. The old paid[0]
    // rule verified 10; the one rule verifies 1006.
    {
      payable_id: 10,
      asset: 'ccd',
      amount_display: '0.500000 CCD',
      due: '2026-12-26T12:00:00.000Z',
      status: 'paid',
      label: 'Lab invoice 10',
    },
    {
      payable_id: 1006,
      asset: 'ccd',
      amount_display: '0.500000 CCD',
      due: '2026-11-25T15:07:59.465Z',
      status: 'paid',
      label: 'Lab invoice 1006',
    },
  ],
}
const VERIFY_1006 = {
  ...VERIFY_AFTER_PAY,
  payable_id: 1006,
  checks: VERIFY_AFTER_PAY.checks.map((c) =>
    c.id === 'status_paid' ? { ...c, detail: 'Paid by 9Zzz… at 2026-11-25T15:08:00.000Z' } : c,
  ),
}

function mockApiTwoPaid() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('/api/payables/1006/verify')
        ? VERIFY_1006
        : url.includes('/api/payables/10/verify')
          ? VERIFY_AFTER_PAY
          : url.includes('/api/invoices')
            ? INVOICES_TWO_PAID
            : url.includes('/api/stats')
              ? STATS
              : null
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

function renderHowItWorks() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <HowItWorks />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('HowItWorks latest-payment card (FIX-4) + one latest rule (FIX-7f)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('shows a loading state while the list loads, never the "No paid invoice yet" empty state', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn((): Promise<Response> => new Promise(() => {})),
    )
    renderHowItWorks()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    // Twice: step-01's visual slot AND the step-04 card — both must load,
    // neither may show the empty state.
    expect(screen.getAllByText(/Loading payables…/)).toHaveLength(2)
    expect(screen.queryByText(/No paid invoice yet/)).toBeNull()
    // After 15 s the slow-loader suffix appears, like its siblings.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000)
    })
    expect(screen.getAllByText(/Still loading — the test API is slow right now\./)).toHaveLength(2)
  })

  it('calls the highest-id paid payable the latest, in the card and in the checker', async () => {
    mockApiTwoPaid()
    renderHowItWorks()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    expect(screen.getByText(/Latest payment — Payable 1006/)).toBeInTheDocument()
    // Exact string: the /Payable 10/ regex would also match "Payable 1006".
    expect(screen.queryByText('Latest payment — Payable 10 · 0.500000 CCD')).toBeNull()

    renderVerifier()
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
    expect(screen.getByText(/Paid by 9Zzz… at 2026-11-25T15:08:00/)).toBeInTheDocument()
    expect(screen.queryByText(/Paid by 4MvdM…/)).toBeNull()
  })
})
