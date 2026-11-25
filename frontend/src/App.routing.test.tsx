// App routing — REPRODUCTION of the user-reported tab bug (2026-11-25 03:24 EET):
// clicking "Pay an invoice" or any tab bounces back to the landing page and
// nothing works. Renders the REAL <App/> (BrowserRouter) and clicks every tab
// from every start page, asserting the URL, the rendered view, and that the
// anchor scroll actually fires. Scroll is observed, not assumed: window.scrollTo
// and Element.scrollIntoView are stubbed spies, because jsdom has no layout.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, configure, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import App from './App'

// The full suite runs 19+ files in parallel on 1.5 shared CPUs; the first
// render + mocked fetch + navigation in this file can take over the
// 1 s default waitFor timeout under that load (the same two tests failed
// twice in full runs and passed in isolation, then failed 3 of 4 full runs
// across the landing judges — all pure 5 s timeouts, no assertion ever
// failed). 10 s waitFor + the 15 s testTimeout in vitest.config.ts are
// headroom for the loaded VM, not for a slow app.
configure({ asyncUtilTimeout: 10_000 })

const CONFIG = {
  network: 'testnet',
  registry: { index: 13150, subindex: 0, module_ref: 'MODULE-REF-PLACEHOLDER' },
  cis8004_test_instance: { index: 12802, subindex: 0, official_module_ref: 'OFFICIAL-MODULE-PLACEHOLDER', is_official_registry: true },
  reservation_secs: 300,
  co_signer_margin_secs: 60,
  assets: { ccd: { decimals: 6, label: 'CCD (testnet)' }, eudemo: { decimals: 6, label: 'EUDemo (testnet demo token)' } },
  payer_label: 'Demo payer account (lab)',
  sponsor_label: 'Lab seller account',
  explorer: { tx: 'https://ccdexplorer.io/testnet/transaction/', instance: 'https://ccdexplorer.io/testnet/instance/' },
  vendor_list: [{ seller: 'SELLER-PLACEHOLDER', label: 'Lab seller' }],
  build: { vendor_list_enforced_by_co_signer: false, named_payer_on_invoice: false, confirm_by: 'payer_or_seller', header_expiry_bound: false, co_signer_runs_as: 'in_process_lab' },
  limits: { new_invoices_per_hour: 3, attempts_per_minute_per_ip: 10 },
  verifier: { file: 'verify-payable.mjs', version_date: '2026-11-24' },
  as_of: '2026-11-24T10:42:07Z',
}
const HEALTH = {
  chain: { reachable: true, checked_at: '2026-11-24T10:42:07Z' },
  node_busy: false,
  payer: { status: 'ok' },
  sponsor: { status: 'ok' },
  wallet_eudemo: { status: 'ok' },
  co_signer: { status: 'ok' },
  budget: { new_invoices_left_this_hour: 3, attack_sends_left_this_hour: 5 },
}
const STATS = { payables_total: 5, paid_total: 3, refused_on_chain_since_deploy: 7, last_verifier_run_at: '2026-11-24T10:42:07Z' }
const DAY_MS = 24 * 60 * 60 * 1000
// Mock dues are relative to Date.now() — NOT fixed calendar dates
// (fix-back-5 O4a, same dueInDays pattern as MF-H1/MF-H4). These items
// feed the REAL App: HomePage's HeroDemo (real-now pick) and
// InvoiceShowcase + DashboardPage (real-now derivedStatus pills). Fixed
// dues would flip the pick 2 → 1004 after Dec 1 and, after Dec 26, leave
// NO future unpaid CCD payable — the demo would render "Demo unavailable"
// and the 'Live Invoices' wait in the viewport test below would time out.
// Relative dues preserve the pick (2, soonest-due unpaid CCD), the order
// 2 < 1004, and both Unpaid pills at any run date. (The 'Due
// 2026-12-01…' string in VERIFY_AFTER_PAY below is a canned verify-response
// detail, not derived from these dues — it stays fixed.)
const dueInDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()
const INVOICES = {
  items: [
    { payable_id: 1, asset: 'ccd', amount_display: '0.5 CCD', due: dueInDays(-1), status: 'paid', label: 'Lab invoice 1' },
    { payable_id: 2, asset: 'ccd', amount_display: '0.5 CCD', due: dueInDays(2), status: 'unpaid', label: 'Lab invoice 2' },
    { payable_id: 1004, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(7), status: 'unpaid', label: 'Lab invoice' },
  ],
}
const VERIFY_AFTER_PAY = {
  payable_id: 1,
  mode: 'after_pay',
  verdict: 'paid',
  passed: 10,
  total: 10,
  blocked_reason: null,
  checks: [
    { id: 'registered', label: 'Payable is registered', status: 'ok', detail: 'seller=42jaZZgd…, id=1, asset=CCD, amount=500000', layer: 'chain' },
    { id: 'doc', label: 'Document hash matches', status: 'ok', detail: 'sha256(doc)=c9fef19aa010ed3d…, stored=c9fef19aa010ed3d…', layer: 'chain' },
    { id: 'agent', label: 'Seller agent active', status: 'ok', detail: 'Seller agent is active on the official registry.', layer: 'chain' },
    { id: 'status_paid', label: 'Registry status is Paid', status: 'ok', detail: 'Paid by 4MvdM… at 2026-11-24T08:37:45.000Z', layer: 'chain' },
    { id: 'amount', label: 'Amount matches', status: 'ok', detail: 'Amount 500000 microCCD matches the document.', layer: 'chain' },
    { id: 'payee', label: 'Payee matches', status: 'ok', detail: 'Payee on chain matches the document.', layer: 'chain' },
    { id: 'due', label: 'Due date', status: 'ok', detail: 'Due 2026-12-01T08:03:26.555Z.', layer: 'chain' },
    { id: 'seller', label: 'Seller', status: 'ok', detail: 'Seller account is the recorded seller.', layer: 'chain' },
    { id: 'reservation', label: 'Reservation', status: 'ok', detail: 'No open reservation blocks the payment.', layer: 'chain' },
    { id: 'receipt', label: 'Receipt', status: 'ok', detail: 'Receipt is re-verifiable on chain.', layer: 'chain' },
  ],
  checked_at: '2026-11-24T17:08:24.616Z',
  read_ms: 120,
}
const AGE_HEALTH = {
  service: 'age-proof',
  prover_available: false,
  prover: { service: 'prover', network: 'testnet', attributes_held: ['date_of_birth'], issuer_did: null, allow_list: [], refuses: [] },
  anchored_run: { vra: 'vra', vaa: 'vaa', record_sha256: 'abc', statements: [] },
  proven_rejections: [],
  checked_at: '2026-11-24T10:42:07Z',
}

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('/api/payables/1/verify')
        ? VERIFY_AFTER_PAY
        : url.includes('/api/invoices')
          ? INVOICES
          : url.includes('/api/stats')
            ? STATS
            : url.includes('/api/config')
              ? CONFIG
              : url.includes('/api/health')
                ? HEALTH
                : url.includes('/api/age-proof/health')
                  ? AGE_HEALTH
                  : url.includes('/api/judges/files')
                    ? { files: [] }
                    : null
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

describe('App routing (tab bug repro)', () => {
  let scrollToSpy: ReturnType<typeof vi.fn>
  let scrollIntoViewSpy: ReturnType<typeof vi.fn>
  // rAF as a QUEUE, not a single slot: the whole HomePage renders, and
  // CountUp registers its own rAF ticks too. A one-slot stub only ever
  // drives the last registrant, so the demo clock would never advance and
  // the scroll-hijack test would pass vacuously.
  let rafQueue: Array<{ id: number; cb: FrameRequestCallback }>
  let rafId: number
  let now: number

  beforeEach(() => {
    mockApi()
    scrollToSpy = vi.fn()
    scrollIntoViewSpy = vi.fn()
    window.scrollTo = scrollToSpy as unknown as typeof window.scrollTo
    Element.prototype.scrollIntoView = scrollIntoViewSpy as unknown as typeof Element.prototype.scrollIntoView
    rafQueue = []
    rafId = 0
    now = 1000
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafQueue.push({ id: ++rafId, cb })
      return rafId
    })
    vi.stubGlobal('cancelAnimationFrame', (id: number) => {
      rafQueue = rafQueue.filter((x) => x.id !== id)
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
    vi.stubGlobal(
      'matchMedia',
      (q: string) => ({
        matches: false,
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        // framer-motion 11 calls the deprecated addListener/removeListener
        // (initPrefersReducedMotion); without them every run logs
        // "motionMediaQuery.addListener is not a function" to stderr.
        addListener: () => {},
        removeListener: () => {},
      }),
    )
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
    window.history.pushState({}, '', '/')
  })

  const renderApp = (startUrl: string) => {
    window.history.pushState({}, '', startUrl)
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    return render(
      <QueryClientProvider client={client}>
        <App />
      </QueryClientProvider>,
    )
  }

  /** Advance the rAF clock by ms (100ms steps — the demo engine caps dt at 100). Every queued callback runs each frame, like a real rAF loop. */
  const advanceDemo = (ms: number) => {
    const steps = Math.ceil(ms / 100)
    for (let i = 0; i < steps; i++) {
      now += 100
      const q = rafQueue
      rafQueue = []
      act(() => {
        q.forEach(({ cb }) => cb(now))
      })
    }
  }

  it('dashboard sidebar "Pay an invoice" lands on /#invoice and scrolls to the invoice section', async () => {
    const user = userEvent.setup()
    renderApp('/dashboard')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument())
    scrollIntoViewSpy.mockClear()
    await user.click(screen.getByRole('link', { name: 'Pay an invoice' }))
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(window.location.hash).toBe('#invoice')
    // The invoice flow (not just the hero) is on screen: the step-1 heading.
    expect(screen.getAllByText('Pick an invoice').length).toBeGreaterThan(0)
    // And the page actually scrolled to the #invoice anchor.
    expect(scrollIntoViewSpy).toHaveBeenCalled()
    const targets = scrollIntoViewSpy.mock.instances as unknown as Element[]
    expect(targets.some((el) => el?.id === 'invoice')).toBe(true)
  })

  it('dashboard sidebar has no dead "Live console" tab — the console lives here, in /dashboard', async () => {
    const user = userEvent.setup()
    renderApp('/dashboard')
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument())
    // The old sidebar pointed "Live console" at /#console, an anchor that no
    // longer exists on the landing (the console moved into /dashboard). The
    // tab is gone instead of dead — and the remaining tabs all land.
    expect(screen.queryByRole('link', { name: 'Live console' })).toBeNull()
    await user.click(screen.getByRole('link', { name: 'For judges' }))
    await waitFor(() => expect(window.location.pathname).toBe('/judges'))
    expect(screen.getByRole('heading', { name: 'For judges' })).toBeInTheDocument()
  })

  it('every header tab lands on its own working view (Home / Dashboard / For judges)', async () => {
    const user = userEvent.setup()
    renderApp('/')
    await waitFor(() => expect(screen.getByText('Every invoice paid once. Every payment provable.')).toBeInTheDocument())
    await user.click(screen.getAllByRole('link', { name: 'Dashboard' })[0])
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Dashboard' })).toBeInTheDocument())
    expect(window.location.pathname).toBe('/dashboard')
    await user.click(screen.getAllByRole('link', { name: 'For judges' })[0])
    await waitFor(() => expect(window.location.pathname).toBe('/judges'))
    expect(screen.getByRole('heading', { name: 'For judges' })).toBeInTheDocument()
    await user.click(screen.getAllByRole('link', { name: 'Home' })[0])
    await waitFor(() => expect(window.location.pathname).toBe('/'))
    expect(screen.getByText('Every invoice paid once. Every payment provable.')).toBeInTheDocument()
  })

  it('verify-age route renders its own view', async () => {
    renderApp('/verify-age')
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: /Prove you are 18\+ without revealing your birthday/ })).toBeInTheDocument(),
    )
    expect(window.location.pathname).toBe('/verify-age')
  })

  it('clicking "Pay an invoice" twice scrolls the second time too (same-hash re-click)', async () => {
    const user = userEvent.setup()
    renderApp('/#invoice')
    await waitFor(() => expect(screen.getAllByText('Pick an invoice').length).toBeGreaterThan(0))
    scrollIntoViewSpy.mockClear()
    // Footer "Pay an invoice" link, same URL as the current one.
    const footerLink = screen.getByRole('link', { name: 'Pay an invoice' })
    await user.click(footerLink)
    expect(window.location.pathname).toBe('/')
    expect(window.location.hash).toBe('#invoice')
    const targets = scrollIntoViewSpy.mock.instances as unknown as Element[]
    expect(targets.some((el) => el?.id === 'invoice')).toBe(true)
  })

  it('footer "Pay an invoice" scrolls to the invoice section from the home page (bug 1c)', async () => {
    const user = userEvent.setup()
    renderApp('/')
    await waitFor(() => expect(screen.getByText('Every invoice paid once. Every payment provable.')).toBeInTheDocument())
    scrollIntoViewSpy.mockClear()
    // The footer's "Pay an invoice" link: the page is already at /, so the
    // click only adds the hash — the scroll must still fire (the old
    // ScrollToTop stayed put because the URL "did not change").
    const footerLink = screen.getByRole('link', { name: 'Pay an invoice' })
    await user.click(footerLink)
    expect(window.location.pathname).toBe('/')
    expect(window.location.hash).toBe('#invoice')
    expect(screen.getAllByText('Pick an invoice').length).toBeGreaterThan(0)
    expect(scrollIntoViewSpy).toHaveBeenCalled()
    const targets = scrollIntoViewSpy.mock.instances as unknown as Element[]
    expect(targets.some((el) => el?.id === 'invoice')).toBe(true)
  })

  it('the hero demo never yanks the viewport while the user reads below it', async () => {
    renderApp('/#invoice')
    // Wait for LIVE data (not the static sidebar text): 'Live Invoices' only
    // renders once the demo invoice exists and the loop is running. Waiting
    // for the static 'Pick an invoice' text resolves before the fetch lands,
    // and then the demo is still in its static frame and the test is vacuous.
    await waitFor(() => expect(screen.getByText('Live Invoices')).toBeInTheDocument())
    // Let the demo loop run through several phases (24s loop).
    scrollIntoViewSpy.mockClear()
    advanceDemo(20000)
    // No scrollIntoView from the demo at all: the walkthrough is a visual
    // loop, it must never move the user's viewport.
    expect(scrollIntoViewSpy).not.toHaveBeenCalled()
  })
})
