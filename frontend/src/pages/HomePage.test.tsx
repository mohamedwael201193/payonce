// HomePage — display-only landing (fix-back-12). The interactive pay flow
// is gone from the landing page: no invoice picker, no check step, no pay
// button, no receipt checker, no try panel, no build-status section, no
// '#invoice' anchor target. The explainer sections (HowItWorks step titles
// included) are explanation, not pay flow, and they stay.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HomePage } from './HomePage'

const DAY_MS = 24 * 60 * 60 * 1000
const dueInDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()

const INVOICES = {
  items: [
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1, asset: 'ccd', amount_display: '0.5 CCD', due: dueInDays(-1), status: 'paid', label: 'Lab invoice 1' },
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 2, asset: 'ccd', amount_display: '0.5 CCD', due: dueInDays(2), status: 'unpaid', label: 'Lab invoice 2' },
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1004, asset: 'ccd', amount_display: '0.500000 CCD', due: dueInDays(7), status: 'unpaid', label: 'Lab invoice' },
  ],
}
const STATS = { payables_total: 3, paid_total: 1, refused_on_chain_since_deploy: 7, last_verifier_run_at: '2026-11-24T10:42:07Z' }
const CONFIG = {
  network: 'testnet',
  registry: { index: 13149, subindex: 0, module_ref: 'MODULE-REF-PLACEHOLDER' },
  cis8004_test_instance: { index: 13144, subindex: 0, official_module_ref: 'OFFICIAL-MODULE-PLACEHOLDER', is_official_registry: false },
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
  budget: { new_invoices_left_this_hour: 3, attack_sends_left_this_hour: 10 },
}

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      const body = url.includes('/api/invoices')
        ? INVOICES
        : url.includes('/api/stats')
          ? STATS
          : url.includes('/api/config')
            ? CONFIG
            : url.includes('/api/health')
              ? HEALTH
              : null
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

function LocationProbe() {
  const loc = useLocation()
  return <p data-testid="location">{`${loc.pathname}${loc.search}${loc.hash}`}</p>
}

function renderHome(initialEntry = '/') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[initialEntry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <HomePage />
        <LocationProbe />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('HomePage (display-only landing)', () => {
  beforeEach(mockApi)
  afterEach(() => vi.unstubAllGlobals())

  it('renders the hero, the demo glimpse and the explainers', async () => {
    renderHome()
    expect(screen.getByText('Every invoice paid once. Every payment provable.')).toBeInTheDocument()
    // The tall demo dashboard loads the live list (display only).
    await waitFor(() => expect(screen.getByText('Payables overview')).toBeInTheDocument())
    // The explainer keeps its step titles — explanation, not pay flow.
    expect(screen.getByText('Pick an invoice')).toBeInTheDocument()
    expect(screen.getByText('Check the invoice')).toBeInTheDocument()
    expect(screen.getByText('Pay once')).toBeInTheDocument()
    expect(screen.getByText('Receipt')).toBeInTheDocument()
  })

  it('renders NO pay-flow section and NO link/button to a pay flow', async () => {
    renderHome()
    await waitFor(() => expect(screen.getByText('Payables overview')).toBeInTheDocument())
    // No tabs, no picker, no check/pay buttons, no try panel, no build status.
    expect(screen.queryByRole('tablist')).toBeNull()
    expect(screen.queryByText('Try to break it')).toBeNull()
    expect(screen.queryByText('Build status')).toBeNull()
    // The explainer KEEPS a "Receipt" step title (HowItWorks) — what must
    // be gone is the receipt STEP's idle text, i.e. the interactive card.
    expect(screen.queryByText('Your receipt appears here after a payment. Nothing is paid until you press a pay button.')).toBeNull()
    expect(screen.queryByRole('button', { name: /Check invoice/ })).toBeNull()
    expect(screen.queryByRole('button', { name: /Pay .* on chain/ })).toBeNull()
    // No '#invoice' href anywhere on the page.
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href') ?? '')
    expect(hrefs.filter((href) => href.includes('#invoice'))).toEqual([])
  })

  it('every "Pay an invoice" and "Verify an invoice" link points at the dashboard pay tabs', async () => {
    renderHome()
    await waitFor(() => expect(screen.getByText('Payables overview')).toBeInTheDocument())
    const payLinks = screen.getAllByRole('link', { name: 'Pay an invoice' })
    expect(payLinks.length).toBeGreaterThan(0)
    for (const link of payLinks) {
      expect(link).toHaveAttribute('href', '/dashboard?tab=pick#pay')
    }
    const verifyLinks = screen.getAllByRole('link', { name: 'Verify an invoice' })
    expect(verifyLinks.length).toBeGreaterThan(0)
    for (const link of verifyLinks) {
      expect(link).toHaveAttribute('href', '/dashboard?tab=pick#pay')
    }
  })

  it('an old /?payable= link redirects to the dashboard pay tabs', async () => {
    renderHome('/?payable=2')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('/dashboard?tab=pick&payable=2#pay'))
  })
})
