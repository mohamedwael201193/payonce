// Sections — ReceiptChecker N2: the live after-pay verifier names the
// paid-status check 'status_paid', not 'status'. The old lookup showed a
// bare "—" after "Paid once: yes." and the verdict line read
// "Verdict: Verdict: paid …". This test pins the live after-pay shape: only
// 'status_paid' present.
// The staged reveal (5 stages, 0.9 s apart) runs on fake timers; the
// queries resolve through the mocked fetch, advanced with act +
// advanceTimersByTimeAsync (waitFor + fake timers deadlock).
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { VerifierSection } from './Sections'

const INVOICES = {
  items: [
    {
      seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 10,
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
  seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 10,
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
      seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 10,
      asset: 'ccd',
      amount_display: '0.500000 CCD',
      due: '2026-12-26T12:00:00.000Z',
      status: 'paid',
      label: 'Lab invoice 10',
    },
    {
      seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1006,
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
// The two-paid list (2 items, both paid) needs its own agreeing stats —
// the unified snapshot (fix-back-6 B1) rejects a stats/list pair that
// disagrees, so the shared 1/1 STATS would fail this mock.
const STATS_TWO_PAID = { ...STATS, payables_total: 2, paid_total: 2 }

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
              ? STATS_TWO_PAID
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

// ReceiptChecker stability + truth (fix-back-6 B9/B12): a blocked verdict
// whose only fails are the missing reservation/confirm evidence rows (the
// live Payable 1049 shape) must explain itself, and a failed re-check
// must keep the last verified verdict instead of swapping in the generic
// error.
const INVOICES_1049 = {
  items: [
    {
      seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB',
      payable_id: 1049,
      asset: 'eudemo',
      amount_display: '0.01 EUDemo',
      due: '2026-11-25T23:22:18.281Z',
      status: 'Paid',
      label: 'Lab invoice',
    },
  ],
}
const STATS_1049 = { ...STATS, payables_total: 1, paid_total: 1 }
// Live after_pay shape for 1049: blocked 11/14, the transfer fully
// re-verifies, only the two fail-closed evidence rows fail.
const VERIFY_1049_BLOCKED = {
  payable_id: 1049,
  mode: 'after_pay',
  verdict: 'blocked',
  passed: 11,
  total: 14,
  blocked_reason: 'reservation_precedes_transfer',
  checks: [
    { id: 'registered', label: 'Payable is registered', status: 'ok', detail: 'seller=42jaZZgd…, id=1049', layer: 'chain' },
    { id: 'doc', label: 'Document hash matches', status: 'not_run', detail: 'no invoice document supplied; stored doc_hash recorded, not passed', layer: 'chain' },
    { id: 'agent', label: 'Seller agent active', status: 'ok', detail: 'token 1476 on <12802,0>: owner=42jaZZgd… (matches seller), status=Active', layer: 'chain' },
    { id: 'registry_zero', label: 'Registry balance is zero', status: 'ok', detail: 'balance=0 microCCD', layer: 'chain' },
    { id: 'status_paid', label: 'Registry status is Paid', status: 'ok', detail: 'Paid by 4MvdMEGC… at 2026-11-24T23:23:05.593Z', layer: 'chain' },
    { id: 'tx_finalized', label: 'Transfer finalized', status: 'ok', detail: 'status=finalized', layer: 'chain' },
    { id: 'one_token_transfer', label: 'Exactly one token transfer', status: 'ok', detail: 'TokenTransfer events=1', layer: 'chain' },
    { id: 'token_eudemo', label: 'Token is EUDemo', status: 'ok', detail: 'tokenId=EUDemo', layer: 'chain' },
    { id: 'from_payer', label: 'Transfer sender is the reserving payer', status: 'ok', detail: 'from=4MvdMEGC…, payer=4MvdMEGC…', layer: 'chain' },
    { id: 'to_payee', label: 'Transfer recipient is the stored payee', status: 'ok', detail: 'to=4Vtd6WnC…, payee=4Vtd6WnC…', layer: 'chain' },
    { id: 'amount', label: 'Transfer amount is the stored amount', status: 'ok', detail: 'amount=10000, stored=10000', layer: 'chain' },
    { id: 'memo', label: 'Transfer memo is the canonical payable memo', status: 'ok', detail: 'memo="payable:42jaZZgd…:1049"', layer: 'chain' },
    { id: 'reservation_precedes_transfer', label: 'Reservation precedes the transfer inside its window', status: 'fail', detail: 'no reserve transaction supplied — the reservation was never checked', layer: 'chain' },
    { id: 'paid_at_is_confirm_time', label: 'Paid at is the confirm time', status: 'fail', detail: 'no confirm transaction supplied — paid_at was never checked against a confirm block', layer: 'chain' },
  ],
  checked_at: '2026-11-25T07:40:00.000Z',
  read_ms: 120,
}

describe('VerifierSection / ReceiptChecker stability + evidence gap (B9/B12)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  const settle = async () => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000)
    })
  }

  it('explains a blocked verdict that is only missing reservation evidence (live 1049)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const body = url.includes('/api/payables/1049/verify')
          ? VERIFY_1049_BLOCKED
          : url.includes('/api/invoices')
            ? INVOICES_1049
            : url.includes('/api/stats')
              ? STATS_1049
              : null
        if (!body) return { ok: false, status: 404, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => body }
      }),
    )
    renderVerifier()
    await settle()
    // The verdict itself is still shown, with its reason and count…
    expect(screen.getByText(/blocked — reservation_precedes_transfer \(11\/14 checks passed\)/)).toBeInTheDocument()
    // …but the page now says what it means: paid on chain, the reservation
    // ordering just cannot be certified from this host's records.
    expect(screen.getByText(/Paid on chain — but this host cannot certify the reservation ordering/)).toBeInTheDocument()
    expect(screen.getByText(/The transfer itself re-verifies/)).toBeInTheDocument()
  })

  it('keeps the last verified verdict when a re-check fails, instead of the generic error', async () => {
    let verifyCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/payables/10/verify')) {
          verifyCalls += 1
          // First verify succeeds; the Replay re-check fails (flaky API).
          if (verifyCalls > 1) return { ok: false, status: 500, json: async () => ({}) }
          return { ok: true, status: 200, json: async () => VERIFY_AFTER_PAY }
        }
        const body = url.includes('/api/invoices') ? INVOICES : url.includes('/api/stats') ? STATS : null
        if (!body) return { ok: false, status: 404, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => body }
      }),
    )
    renderVerifier()
    await settle()
    expect(screen.getByText(/paid \(10\/10 checks passed\)/)).toBeInTheDocument()
    // Replay → the re-check fails…
    fireEvent.click(screen.getByRole('button', { name: /Replay/ }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(100)
    })
    // …but the verdict stays, with a re-check note — never the generic
    // "Something went wrong on our side" in place of the verdict.
    expect(screen.getByText(/paid \(10\/10 checks passed\)/)).toBeInTheDocument()
    expect(screen.getByText(/Could not re-check just now — showing the last verified result/)).toBeInTheDocument()
    expect(document.body.textContent).not.toMatch(/Something went wrong on our side/)
  })
})
