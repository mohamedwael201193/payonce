// Whole-project design pass (2026-11-26) — pins the landing architecture,
// copy fixes, Spec Matrix, FAQ, Proof Wall, pinned story, CtaBand glow
// removal, and the one-chrome-per-breakpoint dashboard shell.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  CtaBand,
  FaqSection,
  HairlineFigures,
  HowItWorks,
  JudgesSection,
  PlannerSection,
  ProofWall,
  SpecMatrix,
  VerifierSection,
} from './Sections'
import { DashboardShell } from './DashboardShell'

const SELLER = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'
const INVOICES = {
  items: [
    { seller: SELLER, payable_id: 1006, asset: 'ccd', amount_display: '0.500000 CCD', due: '2026-11-25T15:07:59.465Z', status: 'paid', label: 'Lab invoice 1006' },
    { seller: SELLER, payable_id: 1007, asset: 'eudemo', amount_display: '10.000000 EUDemo', due: '2026-12-26T12:00:00.000Z', status: 'unpaid', label: 'Lab invoice 1007' },
  ],
}
const STATS = { payables_total: 2, paid_total: 1, refused_on_chain_since_deploy: 21, last_verifier_run_at: '2026-11-26T00:22:00.000Z' }
const CONFIG = {
  network: 'testnet',
  registry: { index: 13150, subindex: 0, module_ref: 'c8083a94' },
  cis8004_test_instance: { index: 12802, subindex: 0, official_module_ref: 'OFFICIAL', is_official_registry: true },
  reservation_secs: 3600,
  co_signer_margin_secs: 60,
  assets: { ccd: { decimals: 6, label: 'CCD (testnet)' }, eudemo: { decimals: 6, label: 'EUDemo (testnet demo token)' } },
  payer_label: 'Demo payer account (lab)',
  sponsor_label: 'Lab seller account',
  explorer: { tx: 'https://ccdexplorer.io/testnet/transaction/', instance: 'https://ccdexplorer.io/testnet/instance/' },
  vendor_list: [{ seller: SELLER, label: 'Lab seller' }],
  sellers: [
    { seller: SELLER, label: 'Lab seller 1', agent_token: 1476, badge: 'x', badge_url: 'https://example.test/badge1', agent_card_url: 'https://example.test/card1' },
    { seller: 'other-seller', label: 'Lab seller 2', agent_token: 1506, badge: 'x', badge_url: 'https://example.test/badge2', agent_card_url: 'https://example.test/card2' },
  ],
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

function renderWithProviders(ui: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockApi()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('Design pass — copy flags (Identity Brief)', () => {
  it('cuts the hype line, the unmeasured speed claim, the 30 s / 1 min split and the ■ eyebrows', async () => {
    renderWithProviders(
      <>
        <HowItWorks />
        <HairlineFigures />
        <ProofWall />
        <VerifierSection />
        <PlannerSection />
        <JudgesSection />
        <CtaBand />
      </>,
    )
    await waitFor(() => expect(screen.getByText(/Every payment leaves a record/)).toBeInTheDocument())
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/Beautiful, transparent invoicing/)
    expect(text).not.toMatch(/Verify in seconds/)
    expect(text).not.toMatch(/thirty seconds/)
    expect(text).not.toMatch(/■/)
    // One wording for the judge time everywhere it appears.
    expect(text).toMatch(/in about a minute/)
    expect(text).not.toMatch(/in about thirty seconds/)
  })
})

describe('Design pass — Proof Wall', () => {
  it('marquees clickable real records: paid payables to receipts, refusals to explorer txs', async () => {
    renderWithProviders(<ProofWall />)
    await waitFor(() => expect(screen.getByTestId('proof-wall-paid')).toBeInTheDocument())
    const paid = screen.getByTestId('proof-wall-paid')
    const paidLink = within(paid).getByRole('link', { name: /Payable 1006/ })
    expect(paidLink).toHaveAttribute('href', `/receipt/1006?seller=${SELLER}`)
    const refused = screen.getByTestId('proof-wall-refused')
    const refusalLink = within(refused).getByRole('link', { name: /WrongStatus/ })
    expect(refusalLink.getAttribute('href')).toMatch(/^https:\/\/ccdexplorer\.io\/testnet\/transaction\/a5ec5e40/)
    expect(screen.getByText(/recorded run of 2026-11-24/)).toBeInTheDocument()
    expect(screen.getByText(/7 refusals, each with its chain code/)).toBeInTheDocument()
  })

  it('still shows the recorded refusals when the API is down — no paid rows, no collapse', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/api/invoices')) return { ok: false, status: 500, json: async () => ({}) }
        const body = url.includes('/api/stats') ? STATS : url.includes('/api/config') ? CONFIG : null
        if (!body) return { ok: false, status: 404, json: async () => ({}) }
        return { ok: true, status: 200, json: async () => body }
      }),
    )
    renderWithProviders(<ProofWall />)
    await waitFor(() => expect(screen.getByTestId('proof-wall-refused')).toBeInTheDocument())
    expect(screen.queryByTestId('proof-wall-paid')).toBeNull()
    const refused = screen.getByTestId('proof-wall-refused')
    expect(within(refused).getByRole('link', { name: /WrongStatus/ }).getAttribute('href')).toMatch(
      /^https:\/\/ccdexplorer\.io\/testnet\/transaction\/a5ec5e40/,
    )
    expect(screen.getByText(/recorded run of 2026-11-24/)).toBeInTheDocument()
    expect(screen.getByText(/7 refusals, each with its chain code/)).toBeInTheDocument()
  })
})

describe('Design pass — pinned scroll story (HowItWorks)', () => {
  it('is a 300vh sticky story with 4 step buttons, a progress bar, and the latest-payment card', async () => {
    renderWithProviders(<HowItWorks />)
    await waitFor(() => expect(screen.getByText(/Latest payment — Payable 1006/)).toBeInTheDocument())
    const section = document.querySelector('section#how')
    expect(section?.classList.contains('po-story')).toBe(true)
    expect(document.querySelector('.po-story__bar')).not.toBeNull()
    for (const title of ['Pick an invoice', 'Check the invoice', 'Pay once', 'Receipt']) {
      expect(screen.getByRole('button', { name: new RegExp(title) })).toBeInTheDocument()
    }
    // Exactly one step is current at a time (which one is scroll-driven;
    // in jsdom there is no layout, so the scroll position is meaningless).
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1)
  })

  it('step buttons do not throw where matchMedia is absent (jsdom)', async () => {
    renderWithProviders(<HowItWorks />)
    await waitFor(() => expect(screen.getByText(/Latest payment — Payable 1006/)).toBeInTheDocument())
    expect(() => fireEvent.click(screen.getByRole('button', { name: /Pay once/ }))).not.toThrow()
    expect(document.querySelectorAll('[aria-current="step"]')).toHaveLength(1)
  })
})

describe('Design pass — Spec Matrix', () => {
  it('states the live bounds from config and the recorded bounds with their source', async () => {
    renderWithProviders(<SpecMatrix />)
    await waitFor(() => expect(screen.getByText(/The numbers the chain holds us to/)).toBeInTheDocument())
    await waitFor(() => expect(screen.getByText(/3600 s \(60 minutes\)/)).toBeInTheDocument())
    expect(screen.getByText(/60 s/)).toBeInTheDocument()
    expect(screen.getByText(/€0.01 per transaction on Concordium/)).toBeInTheDocument()
    expect(screen.getByText(/9 checks run against the chain/)).toBeInTheDocument()
    expect(screen.getByText(/7 refusals in the recorded run/)).toBeInTheDocument()
    expect(screen.getByText(/16.2 testnet CCD in the recorded run/)).toBeInTheDocument()
    expect(screen.getByText('<13150,0>')).toBeInTheDocument()
    expect(screen.getByText(/2 sellers on the test registry — agent tokens 1476, 1506/)).toBeInTheDocument()
    // The declared 27-code set is not shown as an observed count: the
    // section states only the 7 refusals observed in the recorded run
    // (the 27 declared codes exist in the contract — README.md:32,
    // contracts/CONTRACT_REPORT.md:38).
    expect(document.body.textContent).not.toMatch(/27 reject codes/)
  })
})

describe('Design pass — FAQ', () => {
  it('is a single-column accordion: first item open, click switches the open item', async () => {
    renderWithProviders(<FaqSection />)
    const first = screen.getByRole('button', { name: /What happens if I pay the same invoice twice?/ })
    expect(first).toHaveAttribute('aria-expanded', 'true')
    const second = screen.getByRole('button', { name: /Where does the money actually go?/ })
    expect(second).toHaveAttribute('aria-expanded', 'false')
    fireEvent.click(second)
    expect(second).toHaveAttribute('aria-expanded', 'true')
    expect(first).toHaveAttribute('aria-expanded', 'false')
    expect(screen.getByText(/The payee is read from the chain, never from the document/)).toBeInTheDocument()
  })

  it('attributes only the second-payment refusal to double payment, and says the receipt page needs the API', async () => {
    renderWithProviders(<FaqSection />)
    expect(screen.getByText(/7 refusals in total, including one for a second payment/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: /What if the test API is down/ }))
    expect(screen.getByText(/the receipt page itself loads through the API/)).toBeInTheDocument()
    expect(screen.getByText(/Only the on-chain record and the downloadable verifier are API-independent/)).toBeInTheDocument()
  })
})

describe('Design pass — CtaBand', () => {
  it('has no radial glow (halo ban) — flat sky only', () => {
    const { container } = renderWithProviders(<CtaBand />)
    expect(container.innerHTML).not.toMatch(/radial-gradient/)
    expect(screen.getByText(/Verify your first invoice in about a minute/)).toBeInTheDocument()
  })
})

describe('Design pass — dashboard shell, one chrome per breakpoint', () => {
  it('renders only the desktop chrome in jsdom (no matchMedia): sidebar nav + Verify age + live status card', async () => {
    renderWithProviders(
      <DashboardShell>
        <p>Dashboard child</p>
      </DashboardShell>,
    )
    expect(screen.getByTestId('app-chrome-desktop')).toBeInTheDocument()
    expect(screen.queryByTestId('app-chrome-tablet')).toBeNull()
    expect(screen.queryByTestId('app-chrome-mobile')).toBeNull()
    const nav = screen.getByLabelText('Dashboard')
    expect(within(nav).getByText('Verify age').closest('a')).toHaveAttribute('href', '/verify-age')
    expect(within(nav).getByText('Pay an invoice').closest('a')).toHaveAttribute('href', '/dashboard/pay?tab=pick')
    // Exactly one "Pay an invoice" link in the whole shell.
    expect(screen.getAllByRole('link', { name: 'Pay an invoice' })).toHaveLength(1)
    await waitFor(() => expect(screen.getByText(/1 of 2 paid once/)).toBeInTheDocument())
    expect(screen.getByText('Registry status')).toBeInTheDocument()
  })

  it('renders only the mobile chrome when the mobile query matches', async () => {
    vi.stubGlobal(
      'matchMedia',
      (q: string) => ({
        matches: q.includes('max-width: 767px'),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }),
    )
    renderWithProviders(
      <DashboardShell>
        <p>Dashboard child</p>
      </DashboardShell>,
    )
    expect(screen.getByTestId('app-chrome-mobile')).toBeInTheDocument()
    expect(screen.queryByTestId('app-chrome-desktop')).toBeNull()
    expect(screen.queryByTestId('app-chrome-tablet')).toBeNull()
    const tabs = screen.getByLabelText('Sections')
    expect(within(tabs).getAllByRole('link')).toHaveLength(5)
    expect(within(tabs).getByRole('link', { name: 'Verify age' })).toHaveAttribute('href', '/verify-age')
  })

  it('renders only the icon rail when the tablet query matches', async () => {
    vi.stubGlobal(
      'matchMedia',
      (q: string) => ({
        matches: q.includes('min-width: 768px') && q.includes('max-width: 1023px'),
        media: q,
        addEventListener: () => {},
        removeEventListener: () => {},
        addListener: () => {},
        removeListener: () => {},
      }),
    )
    renderWithProviders(
      <DashboardShell>
        <p>Dashboard child</p>
      </DashboardShell>,
    )
    expect(screen.getByTestId('app-chrome-tablet')).toBeInTheDocument()
    expect(screen.queryByTestId('app-chrome-desktop')).toBeNull()
    expect(screen.queryByTestId('app-chrome-mobile')).toBeNull()
    const nav = screen.getByLabelText('Dashboard')
    expect(within(nav).getByRole('link', { name: 'Verify age' })).toHaveAttribute('href', '/verify-age')
  })
})
