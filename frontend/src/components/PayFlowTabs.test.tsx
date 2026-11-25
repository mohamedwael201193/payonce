// PayFlowTabs — manual tabs (fix-back-12). The pay flow lives ONLY in the
// dashboard tabs: one tab per step, clicked by the user, NEVER auto-rotating
// or auto-advancing. These tests prove the tab behaviour, the deep-link, and
// that no timer exists in the tab component at all.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PayFlowTabs } from './PayFlowTabs'
import tabsSrc from './PayFlowTabs.tsx?raw'

const DAY_MS = 24 * 60 * 60 * 1000
const dueInDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()

const INVOICES = {
  items: [
    { payable_id: 1, asset: 'ccd', amount_display: '0.5 CCD', due: dueInDays(-1), status: 'paid', label: 'Lab invoice 1' },
    { payable_id: 2, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(-2), status: 'paid', label: 'Lab invoice 2' },
    { payable_id: 3, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(2), status: 'unpaid', label: 'Lab invoice 3' },
  ],
}
const FACTS_3 = {
  payable_id: 3,
  asset: { kind: 'eudemo', token: 'TOK' },
  amount: '0.01',
  amount_display: '0.01 EUDemo',
  payee: 'PAYEE-PLACEHOLDER',
  seller: 'SELLER-PLACEHOLDER',
  due: dueInDays(2),
  is_past_due: false,
  status: { kind: 'unpaid' },
  agent: { registry: { index: 13144, subindex: 0 }, token: 'AGENTTOKEN' },
  doc_sha256: '0'.repeat(64),
  label: 'Lab invoice 3',
}
// The live snapshot only accepts a stats+list pair that AGREES
// (stats.payables_total === items.length, paid_total === paid-in-list).
const STATS = { payables_total: 3, paid_total: 2, refused_on_chain_since_deploy: 7, last_verifier_run_at: '2026-11-24T10:42:07Z' }
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
      if (url.includes('/api/payables/3/document')) {
        return { ok: true, status: 200, text: async () => 'Payable 3\nAmount 0.01 EUDemo', json: async () => ({}) }
      }
      const body = url.includes('/api/invoices')
        ? INVOICES
        : url.includes('/api/stats')
          ? STATS
          : url.includes('/api/config')
          ? CONFIG
          : url.includes('/api/payables/3')
            ? FACTS_3
            : url.includes('/api/health')
              ? HEALTH
              : null
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

function renderTabs(initialEntry = '/dashboard?tab=pick') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[initialEntry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <PayFlowTabs />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('PayFlowTabs (manual tabs)', () => {
  beforeEach(mockApi)
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('renders five tabs, pick active first, with the ARIA tabs pattern', async () => {
    renderTabs()
    await waitFor(() => expect(screen.getByLabelText('Lab invoices (testnet, not real)')).toBeInTheDocument())
    expect(screen.getByRole('tablist', { name: 'Pay flow steps' })).toBeInTheDocument()
    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((t) => t.textContent?.replace(/\s+/g, ' ').trim())).toEqual([
      '01 Pick an invoice',
      '02 Check',
      '03 Pay once',
      '04 Receipt',
      '05 Try to break it',
    ])
    expect(screen.getByRole('tab', { name: /Pick an invoice/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-pick')
  })

  it('clicking each tab shows its panel and hides the others', async () => {
    const user = userEvent.setup()
    renderTabs()
    await waitFor(() => expect(screen.getByLabelText('Lab invoices (testnet, not real)')).toBeInTheDocument())
    await user.click(screen.getByRole('tab', { name: /Try to break it/ }))
    expect(screen.getByRole('tab', { name: /Try to break it/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-try')
    expect(screen.getByText('Try to break it')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Receipt/ }))
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-receipt')
    expect(screen.getByText('Your receipt appears here after a payment. Nothing is paid until you press a pay button.')).toBeInTheDocument()
    await user.click(screen.getByRole('tab', { name: /Pick an invoice/ }))
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-pick')
  })

  it('completing step 01 enables Continue to Check without switching tabs', async () => {
    const user = userEvent.setup()
    renderTabs()
    await waitFor(() => expect(screen.getByLabelText('Lab invoices (testnet, not real)')).toBeInTheDocument())
    // Wait for the lab list itself: the select is disabled while the
    // invoices query loads, and a change on a disabled select is ignored.
    await waitFor(() => expect(screen.getByRole('option', { name: /Payable 3/ })).toBeInTheDocument())
    // Continue is disabled until an invoice is picked.
    expect(screen.getByRole('button', { name: /Continue to Check/ })).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText('Pick an invoice first.')).toBeInTheDocument()
    // Pick invoice 3 from the lab list — the facts load, the tab does NOT move.
    fireEvent.change(screen.getByLabelText('Lab invoices (testnet, not real)'), { target: { value: '3' } })
    await waitFor(() => expect(screen.getByText('Payable 3 — 0.01 EUDemo')).toBeInTheDocument())
    const cont = screen.getByRole('button', { name: /Continue to Check/ })
    expect(cont).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('tab', { name: /Pick an invoice/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-pick')
    // Clicking Continue DOES switch — the suggestion is a button, not a timer.
    await user.click(cont)
    expect(screen.getByRole('tab', { name: /Check/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-check')
  })

  it('?tab= deep-links to that tab, and an unknown tab falls back to pick', async () => {
    renderTabs('/dashboard?tab=receipt')
    await waitFor(() => expect(screen.getByRole('tab', { name: /Receipt/ })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-receipt')
  })

  it('an unknown ?tab= falls back to pick', async () => {
    renderTabs('/dashboard?tab=bogus')
    await waitFor(() => expect(screen.getByRole('tab', { name: /Pick an invoice/ })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-pick')
  })

  it('no timer ever switches tabs: 60 s of fake time leaves the user-chosen tab alone', async () => {
    renderTabs()
    await waitFor(() => expect(screen.getByLabelText('Lab invoices (testnet, not real)')).toBeInTheDocument())
    // Fake timers only AFTER the first load (waitFor needs real timers).
    vi.useFakeTimers()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(screen.getByRole('tab', { name: /Pick an invoice/ })).toHaveAttribute('aria-selected', 'true')
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-pick')
  })

  it('the tab component contains no timer call at all (source check)', () => {
    expect(tabsSrc).not.toMatch(/setTimeout|setInterval|setImmediate/)
  })

  it('arrow keys move between tabs (Home/End jump to the ends)', async () => {
    const user = userEvent.setup()
    renderTabs()
    await waitFor(() => expect(screen.getByLabelText('Lab invoices (testnet, not real)')).toBeInTheDocument())
    const pick = screen.getByRole('tab', { name: /Pick an invoice/ })
    pick.focus()
    await user.keyboard('{ArrowRight}')
    expect(screen.getByRole('tab', { name: /Check/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{End}')
    expect(screen.getByRole('tab', { name: /Try to break it/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{Home}')
    expect(screen.getByRole('tab', { name: /Pick an invoice/ })).toHaveAttribute('aria-selected', 'true')
    await user.keyboard('{ArrowLeft}')
    expect(screen.getByRole('tab', { name: /Try to break it/ })).toHaveAttribute('aria-selected', 'true')
  })
})
