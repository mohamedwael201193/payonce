// DashboardPreview — design §3 structure, real data only.
// Mocked fetch returns stub-shaped payloads (5 payables, 3 paid). Asserts:
// tabs filter the list, the gauge shows the paid share, the fees chart shows
// the recorded run, the refused tab lists the 7 recorded refusals.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPreview } from './DashboardPreview'

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
const RECEIPT_1 = {
  payable_id: 1,
  amount_display: '0.5 CCD',
  payee: 'PAYEE-PLACEHOLDER',
  payer_label: 'Demo payer account (lab)',
  txs: [{ label: 'Payment (pay_ccd)', tx_hash: '00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6', explorer_url: 'https://ccdexplorer.io/testnet/transaction/00e0ac1daca4a5ec7a6513d6b2b6b51b93dea4f9e8ecb6fff7cc4597041272f6' }],
  verifier: { passed: 12, total: 12, checked_at: '2026-11-24T10:42:07Z' },
  payment_tx_source: 'chain',
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
            : url.includes('/api/receipts/1')
              ? RECEIPT_1
              : null
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

function renderPreview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <DashboardPreview />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('DashboardPreview', () => {
  beforeEach(mockApi)
  afterEach(() => vi.unstubAllGlobals())

  it('shows the live counts, the 60% gauge and the 5-row list', async () => {
    renderPreview()
    await waitFor(() => expect(screen.getByText(/3 paid · 2 unpaid · 7 refused on chain/)).toBeInTheDocument())
    expect(screen.getByText('60%')).toBeInTheDocument()
    expect(screen.getByText('3 of 5 paid once')).toBeInTheDocument()
    expect(screen.getByText('Payable 1')).toBeInTheDocument()
    expect(screen.getByText('Payable 5')).toBeInTheDocument()
    await waitFor(() => expect(screen.getByText(/12\/12 checks passed/)).toBeInTheDocument())
    expect(screen.getByText(/Next due: payable 3/)).toBeInTheDocument()
  })

  it('tabs filter the list (Unpaid shows only 3 and 5)', async () => {
    const user = userEvent.setup()
    renderPreview()
    await waitFor(() => expect(screen.getByText('Payable 1')).toBeInTheDocument())
    await user.click(screen.getByRole('tab', { name: /Unpaid/ }))
    expect(screen.queryByText('Payable 1')).not.toBeInTheDocument()
    expect(screen.getByText('Payable 3')).toBeInTheDocument()
    expect(screen.getByText('Payable 5')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Paid/ }))
    expect(screen.getByText('Payable 1')).toBeInTheDocument()
    expect(screen.queryByText('Payable 3')).not.toBeInTheDocument()
  })

  it('refused tab lists the 7 recorded refusals, labelled as the recorded run', async () => {
    const user = userEvent.setup()
    renderPreview()
    await waitFor(() => expect(screen.getByText('Payable 1')).toBeInTheDocument())
    await user.click(screen.getByRole('tab', { name: /Refused/ }))
    // The tab label AND the fees-chart heading both carry the recorded-run label.
    expect(screen.getAllByText(/Recorded run, 2026-11-24/).length).toBeGreaterThanOrEqual(1)
    expect(screen.getByText(/-5 · WrongStatus/)).toBeInTheDocument()
    expect(screen.getByText(/-13 · NotExpired/)).toBeInTheDocument()
    expect(screen.getByText(/already paid, so the chain refused a second payment/)).toBeInTheDocument()
  })

  it('fees chart shows the recorded run, including "not measured" for the reserve', async () => {
    renderPreview()
    await waitFor(() => expect(screen.getByText(/Fees by step/)).toBeInTheDocument())
    expect(screen.getByText('16.205')).toBeInTheDocument()
    expect(screen.getByText(/not measured — no bar, never a number/)).toBeInTheDocument()
    expect(screen.getByText(/more than the 0.5 CCD invoice/)).toBeInTheDocument()
  })

  it('registry link points at the live registry from config', async () => {
    renderPreview()
    await waitFor(() => expect(screen.getByText(/Registry <13149,0>/)).toBeInTheDocument())
    const link = screen.getByText(/Registry <13149,0>/).closest('a')
    expect(link?.getAttribute('href')).toBe('https://ccdexplorer.io/testnet/instance/13149/0')
  })

  it('receipt links go to the receipt pages', async () => {
    renderPreview()
    await waitFor(() => expect(screen.getByText('Payable 1')).toBeInTheDocument())
    const row = screen.getByText('Payable 1').closest('li') as HTMLElement
    expect(within(row).getByText('Receipt').closest('a')?.getAttribute('href')).toBe('/receipt/1')
  })
})
