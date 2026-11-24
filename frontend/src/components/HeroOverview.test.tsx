// HeroOverview — the video-card rebuild, fed by mocked live API data
// (13 payables, 8 paid, 5 unpaid, 18 refused — the live shape).
// Asserts: the chart shows the real CCD totals, the gauge shows the real
// paid-once share, the rails split CCD/EUDemo, the next dues are the real
// soonest-due unpaid payables, and the Refused tab shows the labelled
// recorded run.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeroOverview } from './HeroOverview'

const INVOICES = {
  items: [
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
  ],
}
const STATS = { payables_total: 14, paid_total: 8, refused_on_chain_since_deploy: 18, last_verifier_run_at: '2026-11-24T17:08:24.616Z' }
const CONFIG = {
  network: 'testnet',
  registry: { index: 13150, subindex: 0, module_ref: 'MODULE-REF' },
  cis8004_test_instance: { index: 12802, subindex: 0, official_module_ref: 'OFFICIAL', is_official_registry: true },
  reservation_secs: 3600,
  co_signer_margin_secs: 60,
  assets: { ccd: { decimals: 6, label: 'CCD (testnet)' }, eudemo: { decimals: 6, label: 'EUDemo (testnet demo token)' } },
  payer_label: 'Demo payer',
  sponsor_label: 'Lab seller',
  explorer: { tx: 'https://ccdexplorer.io/testnet/transaction/', instance: 'https://ccdexplorer.io/testnet/instance/' },
  vendor_list: [],
  build: { vendor_list_enforced_by_co_signer: true, named_payer_on_invoice: true, confirm_by: 'payer', header_expiry_bound: true, co_signer_runs_as: 'in_process' },
  limits: { new_invoices_per_hour: 3, attempts_per_minute_per_ip: 10 },
  verifier: { file: 'verify-payable-v2.mjs', version_date: '2026-11-24' },
  as_of: '2026-11-24T17:13:32.096Z',
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

function renderOverview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <HeroOverview />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('HeroOverview', () => {
  beforeEach(mockApi)
  afterEach(() => vi.unstubAllGlobals())

  it('shows the real CCD registry total and the live split', async () => {
    renderOverview()
    await waitFor(() => expect(screen.getAllByText(/19\.00 CCD/)).toHaveLength(2))
    expect(screen.getByText(/13 listed payables · 8 paid once · 5 unpaid/)).toBeInTheDocument()
    expect(screen.getByText(/1\.03 EUDemo on Rail B/)).toBeInTheDocument()
  })

  it('shows the real paid-once gauge (62%) and the rails split', async () => {
    renderOverview()
    await waitFor(() => expect(screen.getByRole('heading', { name: 'Paid once' })).toBeInTheDocument())
    await waitFor(() =>
      expect(screen.getByLabelText(/8 of 13 payables paid once \(62 percent\)/)).toBeInTheDocument(),
    )
    expect(screen.getByText('Rail A · CCD')).toBeInTheDocument()
    const rails = screen.getByText('Rail A · CCD').closest('ul')
    expect(rails).toBeTruthy()
    const railsEl = rails as HTMLElement
    expect(within(railsEl).getByText('19.00 CCD')).toBeInTheDocument()
    expect(within(railsEl).getByText(/9 payables · 5 of 9 paid once/)).toBeInTheDocument()
    expect(screen.getByText('Rail B · EUDemo')).toBeInTheDocument()
    expect(within(railsEl).getByText('1.03 EUDemo')).toBeInTheDocument()
    expect(within(railsEl).getByText(/4 payables · 3 of 4 paid once/)).toBeInTheDocument()
  })

  it('lists the soonest-due unpaid payables with the overdue one first', async () => {
    renderOverview()
    await waitFor(() => expect(screen.getByText('Payable 5')).toBeInTheDocument())
    const section = screen.getByText('Next dues').closest('div')?.parentElement
    expect(section).toBeTruthy()
    const rows = within(section as HTMLElement).getAllByText(/Payable \d+/)
    expect(rows.map((r) => r.textContent)).toEqual(['Payable 5', 'Payable 1004', 'Payable 1'])
    expect(within(section as HTMLElement).getByText(/past due/)).toBeInTheDocument()
  })

  it('computes insight lines from state and labels them as computed', async () => {
    renderOverview()
    await waitFor(() => expect(screen.getByText('5 invoices still unpaid')).toBeInTheDocument())
    expect(screen.getByText('18 payments refused on chain since deploy')).toBeInTheDocument()
    expect(screen.getByText('Latest payment — payable 1006')).toBeInTheDocument()
    expect(screen.getByText(/computed from state, not from a language model/)).toBeInTheDocument()
  })

  it('filters the chart by tab and shows the recorded run on Refused', async () => {
    const user = userEvent.setup()
    renderOverview()
    await waitFor(() => expect(screen.getAllByText(/19\.00 CCD/)).toHaveLength(2))
    await user.click(screen.getByRole('tab', { name: /Paid/ }))
    expect(screen.getByRole('img', { name: /Bar chart of CCD payable amounts/ })).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Payable 1006'),
    )
    await user.click(screen.getByRole('tab', { name: /Refused/ }))
    expect(screen.getByText(/Refused on chain — recorded run, 2026-11-24/)).toBeInTheDocument()
    expect(screen.getByText(/already paid, so the chain refused a second payment/)).toBeInTheDocument()
  })

  it('dismisses insights and brings them back', async () => {
    const user = userEvent.setup()
    renderOverview()
    await waitFor(() => expect(screen.getByText('5 invoices still unpaid')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(screen.getByText('Insights dismissed for now.')).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show insights again' }))
    expect(screen.getByText('5 invoices still unpaid')).toBeInTheDocument()
  })
})
