// DashboardPage — separate /dashboard route, all live data.
// Mocked fetch returns stub-shaped payloads (5 payables, 3 paid). Asserts:
// the 4 stat cards show the live numbers, the table lists the live invoices
// with status pills, the search filters, the activity feed lists paid first,
// and the donut splits paid / unpaid.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'

const INVOICES = {
  items: [
    { payable_id: 1, asset: 'ccd', amount_display: '0.5 CCD', due: '2026-11-25T04:49:23.985Z', status: 'paid', label: 'Lab invoice 1' },
    { payable_id: 2, asset: 'eudemo', amount_display: '0.01 EUDemo', due: '2026-11-25T04:49:31.426Z', status: 'paid', label: 'Lab invoice 2' },
    { payable_id: 3, asset: 'eudemo', amount_display: '0.01 EUDemo', due: '2026-11-25T04:49:45.521Z', status: 'unpaid', label: 'Lab invoice 3' },
    { payable_id: 4, asset: 'ccd', amount_display: '0.5 CCD', due: '2026-11-25T04:49:39.472Z', status: 'paid', label: 'Lab invoice 4' },
    { payable_id: 5, asset: 'eudemo', amount_display: '0.01 EUDemo', due: '2026-11-25T04:49:53.537Z', status: 'unpaid', label: 'Lab invoice 5' },
  ],
}
const STATS = { payables_total: 5, paid_total: 3, refused_on_chain_since_deploy: 7, last_verifier_run_at: '2026-11-24T10:42:07Z' }
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
            : null
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('DashboardPage', () => {
  beforeEach(mockApi)
  afterEach(() => vi.unstubAllGlobals())

  it('shows the 4 live stat cards (5 payables, 3 paid, 2 unpaid, 7 refused)', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Payables on the registry')).toBeInTheDocument())
    // CountUp animates 0 → value over ~1.1 s once in view.
    await waitFor(() => expect(screen.getByTestId('stat-total')).toHaveTextContent('5'), { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('stat-paid')).toHaveTextContent('3'), { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('stat-unpaid')).toHaveTextContent('2'), { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('stat-refused')).toHaveTextContent('7'), { timeout: 3000 })
    expect(screen.getByText(/Last updated: 2026-11-24 at 10:42 UTC/)).toBeInTheDocument()
  })

  it('lists the live invoices with status pills and receipt links', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Payable 1')).toBeInTheDocument())
    expect(screen.getByText('Payable 5')).toBeInTheDocument()
    expect(screen.getAllByText('Paid').length).toBeGreaterThanOrEqual(3)
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThanOrEqual(2)
    const row = screen.getByText('Payable 1').closest('tr') as HTMLElement
    expect(within(row).getByText('View').closest('a')?.getAttribute('href')).toBe('/receipt/1')
    expect(screen.getByText('Showing 5 of 5 invoices · Live from the test registry')).toBeInTheDocument()
  })

  it('search filters the table by id', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByText('Payable 1')).toBeInTheDocument())
    await user.type(screen.getByLabelText('Search invoices'), '4')
    expect(screen.queryByText('Payable 1')).not.toBeInTheDocument()
    expect(screen.getByText('Payable 4')).toBeInTheDocument()
    expect(screen.getByText('Showing 1 of 5 invoices · Live from the test registry')).toBeInTheDocument()
  })

  it('activity feed lists paid first, newest payable first', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Payable 4 paid once')).toBeInTheDocument())
    const feed = screen.getByText('Live Activity Feed').closest('section') as HTMLElement
    const titles = within(feed).getAllByText(/Payable \d+ (paid once|open)/).map((el) => el.textContent)
    expect(titles[0]).toBe('Payable 4 paid once')
    expect(titles[1]).toBe('Payable 2 paid once')
  })

  it('donut splits the live list into paid 3 / unpaid 2', async () => {
    renderPage()
    // Wait for the live list first — the donut heading is static and would
    // otherwise assert against the empty loading state.
    await waitFor(() => expect(screen.getByText('Payable 1')).toBeInTheDocument())
    expect(screen.getByText(/Paid once ·/)).toBeInTheDocument()
    const donut = screen.getByText('Payment Split').closest('section') as HTMLElement
    expect(within(donut).getByText(/60%/)).toBeInTheDocument()
    expect(within(donut).getByText(/40%/)).toBeInTheDocument()
    expect(within(donut).getByText(/Unpaid ·/)).toBeInTheDocument()
  })

  it('sidebar links to the real routes, and Export CSV is present', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Payables on the registry')).toBeInTheDocument())
    const nav = screen.getByLabelText('Dashboard')
    expect(within(nav).getByText('Pay an invoice').closest('a')?.getAttribute('href')).toBe('/#invoice')
    expect(within(nav).getByText('For judges').closest('a')?.getAttribute('href')).toBe('/judges')
    expect(screen.getByText('Export CSV')).toBeInTheDocument()
  })
})
