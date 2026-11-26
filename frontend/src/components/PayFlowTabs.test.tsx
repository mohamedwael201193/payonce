// PayFlowTabs — manual tabs (fix-back-12). The pay flow lives ONLY in the
// dashboard tabs: one tab per step, clicked by the user, NEVER auto-rotating
// or auto-advancing. These tests prove the tab behaviour, the deep-link, and
// that no timer exists in the tab component at all.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useEffect } from 'react'
import { MemoryRouter, useLocation, useNavigate, type NavigateFunction } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PayFlowTabs } from './PayFlowTabs'
import tabsSrc from './PayFlowTabs.tsx?raw'

const DAY_MS = 24 * 60 * 60 * 1000
const dueInDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()

const INVOICES = {
  items: [
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1, asset: 'ccd', amount_display: '0.5 CCD', due: dueInDays(-1), status: 'paid', label: 'Lab invoice 1' },
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 2, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(-2), status: 'paid', label: 'Lab invoice 2' },
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 3, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(2), status: 'unpaid', label: 'Lab invoice 3' },
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 5, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(2), status: 'unpaid', label: 'Lab invoice 5' },
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
// Fix-back-13 MF-1: the second payable the stale test hand-picks.
const FACTS_5 = {
  ...FACTS_3,
  payable_id: 5,
  label: 'Lab invoice 5',
}
// The live snapshot only accepts a stats+list pair that AGREES
// (stats.payables_total === items.length, paid_total === paid-in-list).
const STATS = { payables_total: 4, paid_total: 2, refused_on_chain_since_deploy: 7, last_verifier_run_at: '2026-11-24T10:42:07Z' }
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

// Fix-back-14 MF-3: verify fixtures — a ready check run for a given
// payable, so S1/S2 can prove Pay is bound to the checked payable.
const verifyFor = (payable_id: number) => ({
  payable_id,
  mode: 'before_pay',
  verdict: 'ready',
  passed: 9,
  total: 9,
  blocked_reason: null,
  checks: [],
  checked_at: '2026-11-24T10:42:07Z',
  read_ms: 120,
})
const VERIFY_3 = verifyFor(3)
const VERIFY_5 = verifyFor(5)

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.includes('/api/payables/3/document')) {
        return { ok: true, status: 200, text: async () => 'Payable 3\nAmount 0.01 EUDemo', json: async () => ({}) }
      }
      if (url.includes('/api/payables/5/document')) {
        return { ok: true, status: 200, text: async () => 'Payable 5\nAmount 0.01 EUDemo', json: async () => ({}) }
      }
      // Fix-back-14 MF-3: the verify endpoint must answer BEFORE the
      // facts branch below — '/api/payables/5/verify' contains
      // '/api/payables/5', which would otherwise return the facts body
      // and fail verify-schema parsing.
      if (url.includes('/api/payables/3/verify')) {
        return { ok: true, status: 200, json: async () => VERIFY_3 }
      }
      if (url.includes('/api/payables/5/verify')) {
        return { ok: true, status: 200, json: async () => VERIFY_5 }
      }
      const body = url.includes('/api/invoices')
        ? INVOICES
        : url.includes('/api/stats')
          ? STATS
          : url.includes('/api/config')
          ? CONFIG
          : url.includes('/api/payables/3')
            ? FACTS_3
            : url.includes('/api/payables/5')
              ? FACTS_5
              : url.includes('/api/health')
                ? HEALTH
                : null
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

function renderTabs(initialEntry = '/dashboard/pay?tab=pick') {
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

// Fix-back-13 MF-1/M-4: a render that also exposes in-test navigation (what
// a dashboard row Pay link does — a react-router Link to
// /dashboard/pay?tab=pay&payable=<id>) and the live URL search string.
function NavCapture({ onReady }: { onReady: (nav: NavigateFunction) => void }) {
  const navigate = useNavigate()
  useEffect(() => {
    onReady(navigate)
  }, [navigate, onReady])
  return null
}

function LocationProbe() {
  const { search } = useLocation()
  return <p data-testid="location">{search}</p>
}

function renderTabsWithNav(initialEntry = '/dashboard/pay?tab=pick') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  let navigate!: NavigateFunction
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter
        initialEntries={[initialEntry]}
        future={{ v7_startTransition: true, v7_relativeSplatPath: true }}
      >
        <NavCapture onReady={(nav) => { navigate = nav }} />
        <LocationProbe />
        <PayFlowTabs />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { go: (to: string) => navigate(to) }
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
    fireEvent.change(screen.getByLabelText('Lab invoices (testnet, not real)'), { target: { value: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB:3' } })
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
    renderTabs('/dashboard/pay?tab=receipt')
    await waitFor(() => expect(screen.getByRole('tab', { name: /Receipt/ })).toHaveAttribute('aria-selected', 'true'))
    expect(screen.getByRole('tabpanel')).toHaveAttribute('id', 'panel-receipt')
  })

  it('an unknown ?tab= falls back to pick', async () => {
    renderTabs('/dashboard/pay?tab=bogus')
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

describe('PayFlowTabs ?payable= staleness (fix-back-13 MF-1) + preservation (M-4)', () => {
  beforeEach(mockApi)
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // The adversarial round-7 repro, made permanent: preload payable=3,
  // hand-pick 5 in the Pick tab, then follow a dashboard row Pay link to
  // payable=3. The old ref-only preload guard suppressed the reload (3
  // had been preloaded), so the pay panel kept showing Payable 5 while
  // the URL said 3 — a user clicking Pay on row 3 would have paid 5.
  it('a row Pay link to a previously preloaded id reloads it (preload 3 -> hand-pick 5 -> Pay link to 3 shows 3, not 5)', async () => {
    const { go } = renderTabsWithNav('/dashboard/pay?tab=pick&payable=3')
    await waitFor(() => expect(screen.getByText('Payable 3 — 0.01 EUDemo')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('option', { name: /Payable 5/ })).toBeInTheDocument())
    // Hand-pick 5 in the Pick tab — facts show Payable 5, and the URL
    // must now name 5 too (hand-pick syncs ?payable=).
    fireEvent.change(screen.getByLabelText('Lab invoices (testnet, not real)'), { target: { value: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB:5' } })
    await waitFor(() => expect(screen.getByText('Payable 5 — 0.01 EUDemo')).toBeInTheDocument())
    // The sync lands through a startTransition navigation, so it can
    // arrive a beat after the facts render — wait for it, do not assert
    // it synchronously.
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('payable=5'))
    // A dashboard row Pay link to payable=3 — the pay panel must follow
    // the URL, not the stale hand-picked facts. (The pay panel shows the
    // FactsLine "Payable 3 — 0.01 EUDemo · Unpaid", so the assertions use
    // a substring match, not the facts-card h2's exact text.)
    go('/dashboard/pay?tab=pay&payable=3')
    const payPanel = await waitFor(() => {
      const panel = screen.getByRole('tabpanel')
      expect(panel).toHaveAttribute('id', 'panel-pay')
      return panel
    })
    await waitFor(() => expect(within(payPanel).getByText(/Payable 3 — 0.01 EUDemo/)).toBeInTheDocument())
    expect(within(payPanel).queryByText(/Payable 5 — 0.01 EUDemo/)).toBeNull()
  })

  it('the reverse sequence keeps the hand-picked id (preload 3 -> hand-pick 5 -> Pay link to 5 shows 5)', async () => {
    const { go } = renderTabsWithNav('/dashboard/pay?tab=pick&payable=3')
    await waitFor(() => expect(screen.getByText('Payable 3 — 0.01 EUDemo')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByRole('option', { name: /Payable 5/ })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Lab invoices (testnet, not real)'), { target: { value: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB:5' } })
    await waitFor(() => expect(screen.getByText('Payable 5 — 0.01 EUDemo')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('payable=5'))
    go('/dashboard/pay?tab=pay&payable=5')
    const payPanel = await waitFor(() => {
      const panel = screen.getByRole('tabpanel')
      expect(panel).toHaveAttribute('id', 'panel-pay')
      return panel
    })
    await waitFor(() => expect(within(payPanel).getByText(/Payable 5 — 0.01 EUDemo/)).toBeInTheDocument())
    expect(within(payPanel).queryByText(/Payable 3 — 0.01 EUDemo/)).toBeNull()
  })

  it('?tab=pay with no payable shows the prerequisite note (nothing to pay yet)', async () => {
    renderTabsWithNav('/dashboard/pay?tab=pay')
    // Scoped to the visible (pay) panel: the hidden pick panel holds a
    // "Pick an invoice first." disabled-reason and the hidden check panel
    // holds a second copy of the note, so a global query would match 3.
    await waitFor(() =>
      expect(
        within(screen.getByRole('tabpanel')).getByText(
          'Pick an invoice first — this step needs a payable loaded from the test registry.',
        ),
      ).toBeInTheDocument(),
    )
    expect(screen.getByRole('button', { name: 'Pick an invoice →' })).toBeInTheDocument()
  })

  it('?payable= survives a tab click (goTab preserves previous params)', async () => {
    const user = userEvent.setup()
    renderTabsWithNav('/dashboard/pay?tab=pick&payable=3')
    await waitFor(() => expect(screen.getByText('Payable 3 — 0.01 EUDemo')).toBeInTheDocument())
    await user.click(screen.getByRole('tab', { name: /Check/ }))
    expect(screen.getByTestId('location')).toHaveTextContent('tab=check')
    expect(screen.getByTestId('location')).toHaveTextContent('payable=3')
    // The Check panel still shows the same loaded payable (FactsLine:
    // "Payable 3 — 0.01 EUDemo · Unpaid", so a substring match).
    await waitFor(() =>
      expect(within(screen.getByRole('tabpanel')).getByText(/Payable 3 — 0.01 EUDemo/)).toBeInTheDocument(),
    )
  })
})

describe('PayFlowTabs fix-back-14: transient + settled pay-correctness (MF-1/MF-2/MF-3)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // The adversarial judge's T1/T2 repros need a load that stays in
  // flight while the user acts. This mock is mockApi with holdable
  // facts responses: any id in holdIds never answers until the test
  // calls release(id). Verify/document/invoices/stats/config/health
  // always answer at once.
  function mockApiDeferred(holdIds: number[]) {
    const pending = new Map<number, () => void>()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/payables/3/document')) {
        return { ok: true, status: 200, text: async () => 'Payable 3\nAmount 0.01 EUDemo', json: async () => ({}) }
      }
      if (url.includes('/api/payables/5/document')) {
        return { ok: true, status: 200, text: async () => 'Payable 5\nAmount 0.01 EUDemo', json: async () => ({}) }
      }
      if (url.includes('/api/payables/3/verify')) {
        return { ok: true, status: 200, json: async () => VERIFY_3 }
      }
      if (url.includes('/api/payables/5/verify')) {
        return { ok: true, status: 200, json: async () => VERIFY_5 }
      }
      const held = holdIds.find((id) => url.includes(`/api/payables/${id}`))
      if (held !== undefined) {
        const facts = held === 3 ? FACTS_3 : FACTS_5
        return new Promise((resolve) => {
          pending.set(held, () => resolve({ ok: true, status: 200, json: async () => facts }))
        })
      }
      const body = url.includes('/api/invoices')
        ? INVOICES
        : url.includes('/api/stats')
          ? STATS
          : url.includes('/api/config')
            ? CONFIG
            : url.includes('/api/payables/3')
              ? FACTS_3
              : url.includes('/api/payables/5')
                ? FACTS_5
                : url.includes('/api/health')
                  ? HEALTH
                  : null
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    })
    vi.stubGlobal('fetch', fetchMock)
    return {
      fetchMock,
      release: (id: number) => pending.get(id)?.(),
    }
  }

  // Run the check for the payable currently loaded, from the Check tab.
  async function runCheck(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('tab', { name: /Check/ }))
    await user.click(screen.getByRole('button', { name: 'Check invoice' }))
    await waitFor(() => expect(screen.getByText(/All gating checks passed/)).toBeInTheDocument())
  }

  // The visible (active) tab panel, scoped for every pay-panel assertion.
  function activePanel() {
    return screen.getByRole('tabpanel')
  }

  function payEudemoButton() {
    return within(activePanel()).getByRole('button', { name: /Pay 0.01 EUDemo \(3 steps\)/ })
  }

  function expectPayDisabled(reason: string) {
    expect(payEudemoButton()).toHaveAttribute('aria-disabled', 'true')
    expect(within(activePanel()).getAllByText(reason).length).toBeGreaterThanOrEqual(1)
  }

  function expectPayEnabled() {
    expect(payEudemoButton()).not.toHaveAttribute('aria-disabled', 'true')
  }

  // T1 (MF-1, TRANSIENT): check 5 ready → row Pay link to 3 with the
  // reload held in flight → the pay panel must NEVER show Payable 5
  // with an enabled Pay button while the URL says payable=3. The old
  // code kept the old facts (FACTS_LOADING left them in place), so the
  // panel showed "Payable 5" with EUDemo Pay ENABLED for the whole load
  // (up to the 15 s fetch timeout). The fix clears facts on
  // FACTS_LOADING, so the panel shows the prerequisite note instead.
  it('T1: while a reload for 3 is in flight, the pay panel shows no stale payable 5 with an enabled Pay (then shows 3, Pay disabled)', async () => {
    const user = userEvent.setup()
    const controls = mockApiDeferred([3])
    const { go } = renderTabsWithNav('/dashboard/pay?tab=pick&payable=5')
    await waitFor(() => expect(screen.getByText('Payable 5 — 0.01 EUDemo')).toBeInTheDocument())
    await runCheck(user)
    await user.click(screen.getByRole('button', { name: /Continue to Pay/ }))
    expectPayEnabled()
    // A dashboard row Pay link to payable=3 — the reload is held in
    // flight by the deferred mock.
    go('/dashboard/pay?tab=pay&payable=3')
    await waitFor(() =>
      expect(
        within(activePanel()).getByText(
          'Pick an invoice first — this step needs a payable loaded from the test registry.',
        ),
      ).toBeInTheDocument(),
    )
    expect(screen.getByTestId('location')).toHaveTextContent('payable=3')
    // While loading: no stale payable and no enabled Pay anywhere in
    // the pay panel (there is no Pay button at all until facts load).
    expect(within(activePanel()).queryByText(/Payable 5 — 0.01 EUDemo/)).toBeNull()
    expect(within(activePanel()).queryByRole('button', { name: /Pay 0.01 EUDemo \(3 steps\)/ })).toBeNull()
    // Resolve the reload: the panel shows 3 — and Pay is DISABLED,
    // because the load reset the check that had passed for 5.
    controls.release(3)
    await waitFor(() =>
      expect(within(activePanel()).getByText(/Payable 3 — 0.01 EUDemo/)).toBeInTheDocument(),
    )
    expect(within(activePanel()).queryByText(/Payable 5 — 0.01 EUDemo/)).toBeNull()
    expectPayDisabled('Run the check first.')
  })

  // T2 (MF-2, TRANSIENT): slow preload 3 → hand-pick 5 + check 5 → the
  // late 3 lands → the panel must NEVER show Payable 3 with an enabled
  // Pay while the URL says 5. The old code overwrote facts
  // unconditionally on FACTS_LOADED, so the late 3 landed on screen
  // (self-healing only when the effect re-loaded 5). The generation
  // guard ignores the stale resolution, so 3 never lands at all.
  it('T2: a late stale load of 3 never overwrites the checked payable 5 (URL says 5, Pay stays enabled for 5)', async () => {
    const user = userEvent.setup()
    const controls = mockApiDeferred([3])
    const { go } = renderTabsWithNav('/dashboard/pay?tab=pick&payable=3')
    // The preload of 3 is in flight (held by the mock).
    await waitFor(() =>
      expect(controls.fetchMock).toHaveBeenCalledWith(
        expect.stringContaining('/api/payables/3'),
        expect.anything(),
      ),
    )
    // Hand-pick 5 in the Pick tab, then check 5.
    await waitFor(() => expect(screen.getByRole('option', { name: /Payable 5/ })).toBeInTheDocument())
    fireEvent.change(screen.getByLabelText('Lab invoices (testnet, not real)'), { target: { value: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB:5' } })
    await waitFor(() => expect(screen.getByText('Payable 5 — 0.01 EUDemo')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('payable=5'))
    await runCheck(user)
    await user.click(screen.getByRole('button', { name: /Continue to Pay/ }))
    // During the window (3 still in flight): panel shows 5, Pay enabled.
    await waitFor(() =>
      expect(within(activePanel()).getByText(/Payable 5 — 0.01 EUDemo/)).toBeInTheDocument(),
    )
    expect(within(activePanel()).queryByText(/Payable 3 — 0.01 EUDemo/)).toBeNull()
    expectPayEnabled()
    expect(screen.getByTestId('location')).toHaveTextContent('payable=5')
    // The late 3 lands — the generation guard must ignore it.
    controls.release(3)
    await new Promise((r) => setTimeout(r, 100))
    expect(within(activePanel()).getByText(/Payable 5 — 0.01 EUDemo/)).toBeInTheDocument()
    expect(within(activePanel()).queryByText(/Payable 3 — 0.01 EUDemo/)).toBeNull()
    expectPayEnabled()
    expect(screen.getByTestId('location')).toHaveTextContent('payable=5')
    // The stale load must not have triggered any reload of 3 either:
    // exactly one facts fetch for 3 (the initial preload) happened —
    // the hand-pick must not fire a redundant loadFacts(3) while the
    // ?payable= sync is still in flight (fix-back-14 seen-param guard).
    // (Facts fetches for 5 are 2, not 1: the lab-list path calls
    // loadFacts once via onLoaded and once via onNumber — pre-existing,
    // harmless under the generation guard — so no count is asserted
    // for 5.)
    expect(
      controls.fetchMock.mock.calls.filter(([url]) => url.includes('/api/payables/3') && !url.includes('/verify') && !url.includes('/document')).length,
    ).toBe(1)
    void go
  })

  // S1 (MF-3, SETTLED): check 5 ready → row Pay link to 3 → settled
  // facts 3 + URL 3, but verify() was called only for 5. The old code
  // never compared check.result.payable_id to facts.payable_id and never
  // reset the check on a facts change, so Pay stayed ENABLED for 3 on
  // the strength of 5's check. Now Pay is DISABLED until 3 is checked.
  it('S1: check 5 ready, then a row Pay link to 3 leaves Pay DISABLED until 3 is checked', async () => {
    const user = userEvent.setup()
    mockApi()
    const { go } = renderTabsWithNav('/dashboard/pay?tab=pick&payable=5')
    await waitFor(() => expect(screen.getByText('Payable 5 — 0.01 EUDemo')).toBeInTheDocument())
    await runCheck(user)
    await user.click(screen.getByRole('button', { name: /Continue to Pay/ }))
    expectPayEnabled()
    go('/dashboard/pay?tab=pay&payable=3')
    await waitFor(() =>
      expect(within(activePanel()).getByText(/Payable 3 — 0.01 EUDemo/)).toBeInTheDocument(),
    )
    expect(within(activePanel()).queryByText(/Payable 5 — 0.01 EUDemo/)).toBeNull()
    expect(screen.getByTestId('location')).toHaveTextContent('payable=3')
    expectPayDisabled('Run the check first.')
    // Checking 3 re-enables Pay — for 3, on the strength of 3's check.
    await runCheck(user)
    await user.click(screen.getByRole('button', { name: /Continue to Pay/ }))
    expect(within(activePanel()).getByText(/Payable 3 — 0.01 EUDemo/)).toBeInTheDocument()
    expectPayEnabled()
  })

  // S2 (MF-3, SETTLED): check 3 ready → number-field pick of 5 →
  // settled facts 5 + URL 5, but verify() was called only for 3. The
  // old onNumber path swapped facts without resetting the check, so Pay
  // stayed ENABLED for 5 on the strength of 3's check. Now Pay is
  // DISABLED until 5 is checked.
  it('S2: check 3 ready, then a number-field pick of 5 leaves Pay DISABLED until 5 is checked', async () => {
    const user = userEvent.setup()
    mockApi()
    renderTabsWithNav('/dashboard/pay?tab=pick&payable=3')
    await waitFor(() => expect(screen.getByText('Payable 3 — 0.01 EUDemo')).toBeInTheDocument())
    await runCheck(user)
    await user.click(screen.getByRole('button', { name: /Continue to Pay/ }))
    expectPayEnabled()
    // Back to Pick, open the number field, pick 5.
    await user.click(screen.getByRole('tab', { name: /Pick an invoice/ }))
    await user.click(
      screen.getByRole('button', { name: 'Other ways to load an invoice (file, paste, number)' }),
    )
    fireEvent.change(screen.getByLabelText('Or type a payable number'), { target: { value: '5' } })
    await user.click(screen.getByRole('button', { name: 'Use this number' }))
    await waitFor(() => expect(screen.getByText('Payable 5 — 0.01 EUDemo')).toBeInTheDocument())
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('payable=5'))
    // Pay tab: facts 5, URL 5 — Pay DISABLED (3's check does not carry).
    await user.click(screen.getByRole('tab', { name: /Pay once/ }))
    await waitFor(() =>
      expect(within(activePanel()).getByText(/Payable 5 — 0.01 EUDemo/)).toBeInTheDocument(),
    )
    expect(within(activePanel()).queryByText(/Payable 3 — 0.01 EUDemo/)).toBeNull()
    expectPayDisabled('Run the check first.')
    // Checking 5 re-enables Pay — for 5, on the strength of 5's check.
    await runCheck(user)
    await user.click(screen.getByRole('button', { name: /Continue to Pay/ }))
    expect(within(activePanel()).getByText(/Payable 5 — 0.01 EUDemo/)).toBeInTheDocument()
    expectPayEnabled()
  })
})

describe('PayFlowTabs fix-back-15: seen-guard strand + stale error banner (X1/X1b/X2/X3/X6)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // The round-9 adversarial judge's scratch mock, folded in: facts
  // responses for held ids never answer until the test releases (or
  // rejects) them. Verify/document/invoices/stats/config/health always
  // answer at once.
  function mockApiAttack(opts: { holdFacts?: number[] } = {}) {
    const pendingFacts = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>()
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/api/payables/3/document')) {
        return { ok: true, status: 200, text: async () => 'Payable 3\nAmount 0.01 EUDemo', json: async () => ({}) }
      }
      if (url.includes('/api/payables/5/document')) {
        return { ok: true, status: 200, text: async () => 'Payable 5\nAmount 0.01 EUDemo', json: async () => ({}) }
      }
      if (url.includes('/api/payables/3/verify')) {
        return { ok: true, status: 200, json: async () => VERIFY_3 }
      }
      if (url.includes('/api/payables/5/verify')) {
        return { ok: true, status: 200, json: async () => VERIFY_5 }
      }
      const heldFacts = [3, 5].find((id) => url.includes(`/api/payables/${id}`))
      if (heldFacts !== undefined && opts.holdFacts?.includes(heldFacts)) {
        return new Promise((resolve, reject) => {
          pendingFacts.set(heldFacts, { resolve, reject })
        })
      }
      const body = url.includes('/api/invoices')
        ? INVOICES
        : url.includes('/api/stats')
          ? STATS
          : url.includes('/api/config')
            ? CONFIG
            : url.includes('/api/payables/3')
              ? FACTS_3
              : url.includes('/api/payables/5')
                ? FACTS_5
                : url.includes('/api/health')
                  ? HEALTH
                  : null
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    })
    vi.stubGlobal('fetch', fetchMock)
    return {
      fetchMock,
      releaseFacts: (id: number) =>
        pendingFacts.get(id)?.resolve({ ok: true, status: 200, json: async () => (id === 3 ? FACTS_3 : FACTS_5) }),
      rejectFacts: (id: number, err = new Error('network down')) => pendingFacts.get(id)?.reject(err),
      factsCalls: (id: number) =>
        fetchMock.mock.calls.filter(
          ([url]) => url.includes(`/api/payables/${id}`) && !url.includes('/verify') && !url.includes('/document'),
        ).length,
    }
  }

  async function runCheck(user: ReturnType<typeof userEvent.setup>) {
    await user.click(screen.getByRole('tab', { name: /Check/ }))
    await user.click(screen.getByRole('button', { name: 'Check invoice' }))
    await waitFor(() => expect(screen.getByText(/All gating checks passed/)).toBeInTheDocument())
  }

  function activePanel() {
    return screen.getByRole('tabpanel')
  }

  function payEudemoButton() {
    return within(activePanel()).getByRole('button', { name: /Pay 0.01 EUDemo \(3 steps\)/ })
  }

  function expectPayDisabled(reason: string) {
    expect(payEudemoButton()).toHaveAttribute('aria-disabled', 'true')
    expect(within(activePanel()).getAllByText(reason).length).toBeGreaterThanOrEqual(1)
  }

  function expectPayEnabled() {
    expect(payEudemoButton()).not.toHaveAttribute('aria-disabled', 'true')
  }

  async function numberPick(user: ReturnType<typeof userEvent.setup>, id: string) {
    await user.click(screen.getByRole('button', { name: 'Other ways to load an invoice (file, paste, number)' }))
    fireEvent.change(screen.getByLabelText('Or type a payable number'), { target: { value: id } })
    await user.click(screen.getByRole('button', { name: 'Use this number' }))
  }

  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
  const timeoutErr = () => new DOMException('The operation timed out.', 'TimeoutError')

  // X1 (judge scratch, verbatim): the seen-param guard stranded the
  // panel. Preload 3, number-pick 5 while its load is held, click a row
  // Pay link back to 3 WHILE 5 is still in flight, release 5. On the
  // fix-back-14 code the panel showed Payable 5 while the URL said
  // payable=3, with facts fetches for 3 stuck at 1 (only the initial
  // preload — no retry ever fired). Fixed: the pending-sync guard
  // knows no sync is outstanding once 5 settles, so the effect reloads
  // 3 and the panel settles on 3.
  it('X1: 3 -> 5 (held) -> row link to 3 mid-load -> release 5 must settle on 3, not strand on 5', async () => {
    const user = userEvent.setup()
    const ctl = mockApiAttack({ holdFacts: [5] })
    const { go } = renderTabsWithNav('/dashboard/pay?tab=pick&payable=3')
    await waitFor(() => expect(screen.getByText('Payable 3 — 0.01 EUDemo')).toBeInTheDocument())
    await numberPick(user, '5')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('payable=5'))
    // 5 is in flight (held). Row Pay link back to 3, mid-load.
    go('/dashboard/pay?tab=pay&payable=3')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('payable=3'))
    ctl.releaseFacts(5)
    await waitFor(() => expect(within(activePanel()).getByText(/Payable 5 — 0.01 EUDemo/)).toBeInTheDocument())
    await sleep(200)
    // Correct behaviour: a retry load of 3 fired after 5 settled.
    expect(ctl.factsCalls(3)).toBe(2)
    expect(within(activePanel()).queryByText(/Payable 5 — 0.01 EUDemo/)).toBeNull()
    expect(within(activePanel()).getByText(/Payable 3 — 0.01 EUDemo/)).toBeInTheDocument()
  })

  // X1b (judge scratch, ADAPTED to the healed state — the scratch
  // version asserts the strand itself as a diagnostic, so it cannot
  // pass on fixed code): same setup as X1, then the healed panel must
  // stay healed across tab switches, Pay must stay disabled until the
  // SHOWN payable (3) is checked, and checking 3 must enable Pay for
  // 3 — never for 5 while the URL says 3.
  it('X1b: the healed X1 panel stays on 3 across tab switches; Pay stays disabled until 3 is checked', async () => {
    const user = userEvent.setup()
    const ctl = mockApiAttack({ holdFacts: [5] })
    const { go } = renderTabsWithNav('/dashboard/pay?tab=pick&payable=3')
    await waitFor(() => expect(screen.getByText('Payable 3 — 0.01 EUDemo')).toBeInTheDocument())
    await numberPick(user, '5')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('payable=5'))
    go('/dashboard/pay?tab=pay&payable=3')
    await waitFor(() => expect(screen.getByTestId('location')).toHaveTextContent('payable=3'))
    ctl.releaseFacts(5)
    await waitFor(() => expect(within(activePanel()).getByText(/Payable 3 — 0.01 EUDemo/)).toBeInTheDocument())
    await sleep(200)
    expect(screen.getByTestId('location')).toHaveTextContent('payable=3')
    expect(ctl.factsCalls(3)).toBe(2)
    expect(within(activePanel()).queryByText(/Payable 5 — 0.01 EUDemo/)).toBeNull()
    // Tab switches keep the healed state: still 3, no extra fetch.
    await user.click(screen.getByRole('tab', { name: /Check/ }))
    await user.click(screen.getByRole('tab', { name: /Pay once/ }))
    await sleep(200)
    expect(within(activePanel()).getByText(/Payable 3 — 0.01 EUDemo/)).toBeInTheDocument()
    expect(within(activePanel()).queryByText(/Payable 5 — 0.01 EUDemo/)).toBeNull()
    expect(ctl.factsCalls(3)).toBe(2)
    expect(screen.getByTestId('location')).toHaveTextContent('payable=3')
    // Severity bound, healed: Pay is DISABLED until 3 is checked.
    expectPayDisabled('Run the check first.')
    // Checking the SHOWN payable re-enables Pay for 3, URL still 3.
    await runCheck(user)
    await user.click(screen.getByRole('button', { name: /Continue to Pay/ }))
    expect(within(activePanel()).getByText(/Payable 3 — 0.01 EUDemo/)).toBeInTheDocument()
    expectPayEnabled()
    expect(screen.getByTestId('location')).toHaveTextContent('payable=3')
  })

  // X2 (judge scratch, verbatim): 3 fails, 5 fails, explicit re-select
  // of 3 must re-fetch 3. On the fix-back-14 code the seen guard
  // (seen=3 from the first load) ate the re-select, so factsCalls(3)
  // stayed 1. Fixed: with no sync outstanding the effect reloads any
  // param that names a different payable than the loaded facts — and a
  // failed load is not "loaded", so the re-select fires.
  it('X2: 3 fails, 5 fails, explicit re-select of 3 must re-fetch 3', async () => {
    const ctl = mockApiAttack({ holdFacts: [3, 5] })
    const { go } = renderTabsWithNav('/dashboard/pay?tab=pick&payable=3')
    await waitFor(() => expect(ctl.factsCalls(3)).toBe(1))
    go('/dashboard/pay?tab=pick&payable=5')
    await sleep(50)
    ctl.rejectFacts(3, timeoutErr())
    await waitFor(() => expect(ctl.factsCalls(5)).toBe(1))
    go('/dashboard/pay?tab=pick&payable=3')
    await sleep(50)
    ctl.rejectFacts(5, timeoutErr())
    await sleep(200)
    // Correct behaviour: the re-select of 3 re-fetches it (2nd facts fetch).
    expect(ctl.factsCalls(3)).toBe(2)
  })

  // X3 (judge scratch, verbatim): a failed load sets pageError; a later
  // successful load never cleared it, so the stale banner survived on
  // screen. Fixed: loadFacts clears pageError on successful
  // FACTS_LOADED.
  it('X3: after a failed load of 3, a successful load of 5 must clear the error banner', async () => {
    const user = userEvent.setup()
    const ctl = mockApiAttack({ holdFacts: [3] })
    renderTabsWithNav('/dashboard/pay?tab=pick&payable=3')
    await waitFor(() => expect(ctl.factsCalls(3)).toBe(1))
    ctl.rejectFacts(3, timeoutErr())
    await waitFor(() =>
      expect(screen.getByText('The testnet did not answer in time. Showing the last verified data.')).toBeInTheDocument(),
    )
    await numberPick(user, '5')
    await waitFor(() => expect(screen.getByText('Payable 5 — 0.01 EUDemo')).toBeInTheDocument())
    await sleep(100)
    expect(screen.queryAllByText('The testnet did not answer in time. Showing the last verified data.').length).toBe(0)
    expect(screen.queryAllByText('No payable with this number is on the test registry.').length).toBe(0)
  })

  // X6 (judge scratch, verbatim — control): a 404d id is fetched
  // exactly once across tab switches. Guards the not-found +
  // preloadedId branch that fix-back-15 kept while removing the
  // seen-param guard.
  it('X6: a 404d id is fetched exactly once across tab switches (no loop)', async () => {
    const user = userEvent.setup()
    const ctl = mockApiAttack()
    renderTabsWithNav('/dashboard/pay?tab=pick&payable=999')
    await waitFor(() =>
      expect(screen.getAllByText('No payable with this number is on the test registry.').length).toBeGreaterThanOrEqual(1),
    )
    expect(ctl.factsCalls(999)).toBe(1)
    await user.click(screen.getByRole('tab', { name: /Check/ }))
    await user.click(screen.getByRole('tab', { name: /Pay once/ }))
    await user.click(screen.getByRole('tab', { name: /Try to break it/ }))
    await user.click(screen.getByRole('tab', { name: /Pick an invoice/ }))
    await sleep(100)
    expect(ctl.factsCalls(999)).toBe(1)
  })
})

