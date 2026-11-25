// DashboardPage — separate /dashboard route, all live data.
// Mocked fetch returns stub-shaped payloads (5 payables, 3 paid). Asserts:
// the 4 stat cards show the live numbers, the table lists the live invoices
// with status pills, the search filters, the activity feed lists paid first,
// and the donut splits paid / unpaid. Fix-back-2 adds the FIX-4 sibling
// gates: the feed and the donut must show skeletons while loading and the
// error on failure — never a false "No activity yet" / false-zero donut.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DashboardPage } from './DashboardPage'
import { COPY } from '../lib/copy'

const DAY_MS = 24 * 60 * 60 * 1000
// Mock dues are computed relative to Date.now() — NOT fixed calendar dates.
// derivedStatus() (lib/dashboard.ts) renders an unpaid item "Overdue" once
// its due passes, so fixed dues planted in 2026-11-25 turned both unpaid
// pills "Overdue" the morning they expired and failed the 'Unpaid' pill
// assertion on EVERY run after 04:49 UTC 25 Nov (round-4 MF-H1). Relative
// dues can never expire: paid items sit in the past (status is 'paid'
// regardless of due), unpaid items sit 2–3 days out, 3 due before 5.
const dueInDays = (days: number) => new Date(Date.now() + days * DAY_MS).toISOString()

const INVOICES = {
  items: [
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 1, asset: 'ccd', amount_display: '0.5 CCD', due: dueInDays(-1), status: 'paid', label: 'Lab invoice 1' },
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 2, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(-2), status: 'paid', label: 'Lab invoice 2' },
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 3, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(2), status: 'unpaid', label: 'Lab invoice 3' },
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 4, asset: 'ccd', amount_display: '0.5 CCD', due: dueInDays(-3), status: 'paid', label: 'Lab invoice 4' },
    { seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB', payable_id: 5, asset: 'eudemo', amount_display: '0.01 EUDemo', due: dueInDays(3), status: 'unpaid', label: 'Lab invoice 5' },
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
  sellers: [
    {
      seller: '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB',
      label: 'Seller 1 — PayOnce Seller',
      agent_token: 1476,
      badge: 'JyP9XawpXHMjTN5ocrA5a',
      badge_url: 'https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9XawpXHMjTN5ocrA5a',
      agent_card_url: 'https://payonce-tau.vercel.app/.well-known/agent-card.json',
    },
    {
      seller: '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr',
      label: 'Seller 2 — PayOnce Seller 2',
      agent_token: 1506,
      badge: 'JyP9Y9nGU4KaM7DBDXRgm',
      badge_url: 'https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9Y9nGU4KaM7DBDXRgm',
      agent_card_url: 'https://payonce-tau.vercel.app/.well-known/agent-card-seller2.json',
    },
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

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const rendered = render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <DashboardPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { client, ...rendered }
}

describe('DashboardPage', () => {
  beforeEach(mockApi)
  afterEach(() => vi.unstubAllGlobals())

  it('shows the 4 live stat cards (5 payables, 3 paid, 2 unpaid, 7 refused)', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Payables in the live list')).toBeInTheDocument())
    // CountUp animates 0 → value over ~1.1 s once in view.
    await waitFor(() => expect(screen.getByTestId('stat-total')).toHaveTextContent('5'), { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('stat-paid')).toHaveTextContent('3'), { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('stat-unpaid')).toHaveTextContent('2'), { timeout: 3000 })
    await waitFor(() => expect(screen.getByTestId('stat-refused')).toHaveTextContent('7'), { timeout: 3000 })
    expect(screen.getByText(/Last updated: \d{2}:\d{2}:\d{2} UTC · refreshing every 30 s/)).toBeInTheDocument()
  })

  it('shows the live overview cards (paid-once gauge, rails, next dues)', async () => {
    renderPage()
    // Wait for LIVE data (not the static card labels): '1.00 CCD' only
    // renders once the rails card has the live list.
    await waitFor(() => expect(screen.getByText('1.00 CCD')).toBeInTheDocument())
    // Gauge: 3 of 5 paid once → 60%. (The stat card is also called
    // "Paid once" — scope by the heading role.)
    const gauge = screen.getByRole('heading', { name: 'Paid once' }).closest('section') as HTMLElement
    expect(within(gauge).getByText('3 of 5 payables paid once')).toBeInTheDocument()
    expect(within(gauge).getByText('60%')).toBeInTheDocument()
    // Rails: Rail A · CCD, 2 payables / 2 paid / 1.00 CCD; Rail B ·
    // EUDemo, 3 / 1 / 0.03 EUDemo.
    const rails = screen.getByText('Payment rails').closest('section') as HTMLElement
    expect(within(rails).getByText('Rail A · CCD')).toBeInTheDocument()
    expect(within(rails).getByText('1.00 CCD')).toBeInTheDocument()
    expect(within(rails).getByText('Rail B · EUDemo')).toBeInTheDocument()
    expect(within(rails).getByText('0.03 EUDemo')).toBeInTheDocument()
    // Next dues: the two unpaid payables, soonest due first (3 due in
    // 2 days, 5 due in 3 days — relative dues, see the fixture above).
    const dues = screen.getByText('Next dues').closest('section') as HTMLElement
    const dueLinks = within(dues).getAllByRole('link').map((a) => a.getAttribute('href'))
    expect(dueLinks).toEqual([
      '/receipt/3?seller=42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB',
      '/receipt/5?seller=42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB',
    ])
  })

  it('never renders a zero count while the live numbers load', async () => {
    renderPage()
    // Before the mocked fetch resolves, every card shows a skeleton and
    // the sub-line says the numbers are loading — not "0 of 0".
    expect(screen.getAllByText('Loading live numbers…').length).toBe(4)
    expect(screen.queryByText('0 of 0 payables paid')).not.toBeInTheDocument()
  })

  it('lists the live invoices with status pills and receipt links', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Payable 1')).toBeInTheDocument())
    // "Payable 5" also appears in the Next dues card — scope to the table.
    const table = screen.getByRole('table')
    expect(within(table).getByText('Payable 5')).toBeInTheDocument()
    expect(screen.getAllByText('Paid').length).toBeGreaterThanOrEqual(3)
    expect(screen.getAllByText('Unpaid').length).toBeGreaterThanOrEqual(2)
    const row = within(table).getByText('Payable 1').closest('tr') as HTMLElement
    expect(within(row).getByText('View').closest('a')?.getAttribute('href')).toBe(
      '/receipt/1?seller=42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB',
    )
    expect(screen.getByText('Showing 5 of 5 invoices · Live from the test registry')).toBeInTheDocument()
  })

  it('shows the Sellers section with both sellers and a Seller column (fix-back §4.5)', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Sellers')).toBeInTheDocument())
    // Both sellers from /api/config, with their agent tokens and live
    // badge-check links (neutral label — the UI never asserts validity).
    expect(screen.getByText('Seller 1 — PayOnce Seller')).toBeInTheDocument()
    expect(screen.getByText('Seller 2 — PayOnce Seller 2')).toBeInTheDocument()
    expect(screen.getByText(/Agent token 1476/)).toBeInTheDocument()
    expect(screen.getByText(/Agent token 1506/)).toBeInTheDocument()
    expect(screen.getAllByText('Badge check — live').length).toBe(2)
    // Seller column: the seller-1 fixture rows resolve to the "Seller 1"
    // short label from the config sellers list.
    const table = screen.getByRole('table')
    expect(within(table).getAllByText('Seller 1').length).toBeGreaterThanOrEqual(5)
    // Every receipt link in the table carries its row's seller.
    const receiptLinks = within(table)
      .getAllByText('View')
      .map((el) => el.closest('a')?.getAttribute('href'))
    expect(receiptLinks).toHaveLength(5)
    for (const href of receiptLinks) {
      expect(href).toMatch(/^\/receipt\/\d+\?seller=42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB$/)
    }
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

  it('feed and donut show skeletons — not false-empty / false-zero — while the live list loads', async () => {
    renderPage()
    // Before the mocked fetch resolves: no "No activity yet" assertion
    // (the feed is empty only because nothing arrived yet) and no donut
    // at all — in particular no "No payables yet" aria-label and no big
    // "0 payables" centre number. (Skeleton is aria-hidden, so the
    // absence of the false states is the assertion.)
    const feed = screen.getByText('Live Activity Feed').closest('section') as HTMLElement
    expect(within(feed).queryByText('No activity yet — pay an invoice and it appears here.')).not.toBeInTheDocument()
    expect(within(feed).getByText('Loading…')).toBeInTheDocument()
    const donut = screen.getByText('Payment Split').closest('section') as HTMLElement
    expect(within(donut).queryByLabelText('No payables yet')).not.toBeInTheDocument()
    // Once loaded, the real content appears — guards against asserting on
    // a page that never loads at all.
    await waitFor(() => expect(screen.getByText('Payable 4 paid once')).toBeInTheDocument())
    expect(within(donut).getByText(/60%/)).toBeInTheDocument()
  })

  it('feed and donut show the error — not false-empty / false-zero — when the API fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({}) }) as Response),
    )
    renderPage()
    const feed = screen.getByText('Live Activity Feed').closest('section') as HTMLElement
    const donut = screen.getByText('Payment Split').closest('section') as HTMLElement
    // The hooks retry once (retry: 1) with backoff, and the snapshot fetch
    // retries its 3 in-loop attempts (~3 s of 1 s + 2 s gaps, fix-back-7
    // MF-2), so the error state lands ~3–4 s after the failed fetch.
    await waitFor(() => expect(within(feed).getByText(COPY.statsNoData)).toBeInTheDocument(), { timeout: 10000 })
    expect(within(donut).getByText(COPY.statsNoData)).toBeInTheDocument()
    expect(within(feed).getByText('Paused')).toBeInTheDocument()
    expect(within(feed).queryByText('No activity yet — pay an invoice and it appears here.')).not.toBeInTheDocument()
    expect(within(donut).queryByLabelText('No payables yet')).not.toBeInTheDocument()
  })

  // Fix-back-7 MF-6: a failed BACKGROUND refresh must not hide the kept
  // snapshot behind dashes. The first poll succeeds; the refetch fails —
  // the cards keep their numbers, the table keeps its rows, and a
  // could-not-refresh note appears instead of the error text.
  it('keeps the last good snapshot with a could-not-refresh note when a background refresh fails', async () => {
    let snapCalls = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const isSnapshot = url.includes('/api/invoices') || url.includes('/api/stats')
        if (isSnapshot) snapCalls += 1
        // The first pair succeeds; every later snapshot poll fails.
        if (isSnapshot && snapCalls > 2) return { ok: false, status: 500, json: async () => ({}) }
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
    const { client } = renderPage()
    await waitFor(() => expect(screen.getByTestId('stat-total')).toHaveTextContent('5'), { timeout: 3000 })
    await act(async () => {
      await client.invalidateQueries({ queryKey: ['live-snapshot'] })
    })
    // The snapshot fetch retries its 3 in-loop attempts (~3 s) before it
    // throws and react-query keeps the last good data with isError set.
    await waitFor(() => expect(screen.getByText(/Could not refresh the live numbers just now/)).toBeInTheDocument(), { timeout: 10000 })
    // Fix-back-8 MF-2: these assertions used to run synchronously right
    // after the banner appeared, and the CountUp numbers had not settled
    // yet — the honesty judge's full-suite run 1 failed here (expected
    // '5', got the still-counting chip text). Wait for the settled values
    // exactly as the file's other CountUp assertions do (lines 90-93).
    await waitFor(
      () => {
        expect(screen.getByTestId('stat-total')).toHaveTextContent('5')
        expect(screen.getByTestId('stat-paid')).toHaveTextContent('3')
      },
      { timeout: 3000 },
    )
    expect(screen.getByText('Payable 1')).toBeInTheDocument()
    expect(screen.queryByText(COPY.statsNoData)).not.toBeInTheDocument()
    expect(screen.getByText('Paused')).toBeInTheDocument()
  })

  it('sidebar links to the real routes, and Export CSV is present', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Payables in the live list')).toBeInTheDocument())
    const nav = screen.getByLabelText('Dashboard')
    expect(within(nav).getByText('Pay an invoice').closest('a')?.getAttribute('href')).toBe('/#invoice')
    expect(within(nav).getByText('For judges').closest('a')?.getAttribute('href')).toBe('/judges')
    expect(screen.getByText('Export CSV')).toBeInTheDocument()
  })
})
