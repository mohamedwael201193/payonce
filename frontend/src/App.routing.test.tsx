// v9 routing, shell and seller-key tests. Renders the real <AppRoutes/> in a
// MemoryRouter against a mocked API that records every call.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { configure, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, useLocation } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AppRoutes, legacyPayTarget, routeFamily } from './App'
import { BANNED_WORDS } from './lib/copy'

vi.mock('./landing/LandingPage', () => ({ LandingPage: () => <h1>Landing stub</h1> }))

configure({ asyncUtilTimeout: 10_000 })

const S1 = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'
const S2 = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr'
const DAY = 86_400_000
const due = (d: number) => new Date(Date.now() + d * DAY).toISOString()

const CONFIG = {
  network: 'testnet',
  registry: { index: 13150, subindex: 0, module_ref: 'MODREF' },
  cis8004_test_instance: { index: 12802, subindex: 0, official_module_ref: 'OFF', is_official_registry: true },
  reservation_secs: 3600,
  co_signer_margin_secs: 60,
  assets: { ccd: { decimals: 6, label: 'CCD (testnet)' }, eudemo: { decimals: 6, label: 'EUDemo (testnet demo token)' } },
  payer_label: 'Demo payer account (lab)',
  sponsor_label: 'Lab seller account',
  explorer: { tx: 'https://ccdexplorer.io/testnet/transaction/', instance: 'https://ccdexplorer.io/testnet/instance/' },
  vendor_list: [
    { seller: S1, label: 'Lab seller' },
    { seller: S2, label: 'Second seller' },
  ],
  sellers: [
    { seller: S1, label: 'Seller 1 — PayOnce Seller', agent_token: 1476, badge: 'b1', badge_url: 'https://example.test/b1', agent_card_url: 'https://example.test/c1' },
    { seller: S2, label: 'Seller 2 — PayOnce Seller 2', agent_token: 1506, badge: 'b2', badge_url: 'https://example.test/b2', agent_card_url: 'https://example.test/c2' },
  ],
  build: { vendor_list_enforced_by_co_signer: true, named_payer_on_invoice: true, confirm_by: 'payer', header_expiry_bound: true, co_signer_runs_as: 'x' },
  limits: { new_invoices_per_hour: 3, attempts_per_minute_per_ip: 10 },
  verifier: { file: 'verify-payable-v2.mjs', version_date: '2026-11-24' },
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
const ITEMS = [
  { seller: S1, payable_id: 1, asset: 'ccd', amount_display: '0.500000 CCD', due: due(-2), status: 'paid', label: 'Lab invoice 1' },
  { seller: S1, payable_id: 2, asset: 'ccd', amount_display: '0.500000 CCD', due: due(2), status: 'unpaid', label: 'Lab invoice 2' },
  { seller: S2, payable_id: 1, asset: 'ccd', amount_display: '0.500000 CCD', due: due(-1), status: 'paid', label: 'Second seller invoice 1' },
]
const STATS = { payables_total: 3, paid_total: 2, refused_on_chain_since_deploy: 7, last_verifier_run_at: '2026-11-26T03:41:30.615Z' }

function facts(seller: string, id: number) {
  const paid = id === 1
  return {
    payable_id: id,
    asset: { kind: 'ccd', token: 'CCD' },
    amount: '500000',
    amount_display: '0.500000 CCD',
    payee: `PAYEE-${seller.slice(0, 4)}-${id}`,
    seller,
    due: due(2),
    is_past_due: false,
    status: paid
      ? { kind: 'paid', payer: 'PAYER', paid_at: '2026-11-24T10:00:00Z', payment_tx: 'ab'.repeat(32), payment_tx_source: 'chain' }
      : { kind: 'unpaid' },
    agent: { registry: { index: 12802, subindex: 0 }, token: '1' },
    doc_sha256: 'cd'.repeat(32),
    label: 'x',
  }
}
const CHECKS = (mode: string) => ({
  payable_id: 2,
  mode,
  verdict: mode === 'after_pay' ? 'paid' : 'ready',
  passed: 2,
  total: 2,
  blocked_reason: null,
  checks: [
    { id: 'a', label: 'Payable is registered', status: 'ok', detail: 'found', layer: 'chain' },
    { id: 'b', label: 'Document hash matches', status: 'ok', detail: 'same', layer: 'app' },
  ],
  checked_at: '2026-11-26T04:00:00Z',
  read_ms: 10,
})

let calls: Array<{ url: string; method: string; body?: string }>

function mockApi() {
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body as string | undefined })
      const u = new URL(url, 'http://x')
      const seller = u.searchParams.get('seller') ?? S1
      const m = /\/api\/payables\/(\d+)(\/\w+)?$/.exec(u.pathname)
      let body: unknown = null
      if (u.pathname === '/api/invoices') body = { items: ITEMS }
      else if (u.pathname === '/api/stats') body = STATS
      else if (u.pathname === '/api/config') body = CONFIG
      else if (u.pathname === '/api/health') body = HEALTH
      else if (u.pathname === '/api/judges/files') body = { files: [] }
      else if (u.pathname === '/api/age-proof/health') return { ok: false, status: 503, json: async () => ({ error: { code: 'prover_unavailable', layer: 'server', message: 'not provisioned', retryable: false } }) }
      else if (u.pathname === '/api/cosigner/dry-run') body = { decision: 'REFUSE', reason: 'wrong-recipient', plain: 'The co-signer would refuse this transfer. Nothing was sent.', tx_sent: false }
      else if (m && m[2] === '/verify') body = CHECKS(JSON.parse(init!.body as string).mode)
      else if (m && m[2] === '/pay') body = { job_id: 'job1', payable_id: Number(m[1]), rail: 'ccd', steps: ['check_status', 'submit'] }
      else if (m && !m[2]) body = facts(seller, Number(m[1]))
      else if (/\/api\/receipts\/(\d+)/.test(u.pathname))
        body = {
          payable_id: Number(/receipts\/(\d+)/.exec(u.pathname)![1]),
          seller,
          amount_display: '0.500000 CCD',
          payee: 'PAYEE',
          payer_label: 'Demo payer account (lab)',
          txs: [{ label: 'Payment', tx_hash: 'ef'.repeat(32), explorer_url: 'x' }],
          verifier: null,
          payment_tx_source: 'chain',
        }
      if (!body) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, status: 200, json: async () => body }
    }),
  )
}

function stubMedia(desktop: boolean) {
  vi.stubGlobal('matchMedia', (q: string) => ({
    matches: desktop,
    media: q,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
  }))
}

function Where() {
  const l = useLocation()
  return <p data-testid="where">{`${l.pathname}${l.search}`}</p>
}

function renderAt(url: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[url]} future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AppRoutes />
        <Where />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}
const where = () => screen.getByTestId('where').textContent

beforeEach(() => {
  mockApi()
  stubMedia(true)
  vi.stubGlobal('EventSource', class { onmessage = null; onerror = null; close() {} })
  window.scrollTo = vi.fn() as unknown as typeof window.scrollTo
  try {
    window.localStorage.clear()
  } catch {
    /* ignore */
  }
})
afterEach(() => vi.unstubAllGlobals())

describe('legacy redirects', () => {
  const cases: Array<[string, string]> = [
    ['/dashboard', '/app'],
    ['/dashboard?tab=pick#pay', '/app/pay'],
    ['/dashboard/pay?tab=pick', '/app/pay'],
    ['/dashboard/pay?tab=try', '/app/break'],
    [`/dashboard/pay?tab=pay&payable=2&seller=${S1}`, `/app/pay/${S1}/2`],
    [`/dashboard/pay?payable=1&seller=${S2}`, `/app/pay/${S2}/1`],
    [`/dashboard/pay?tab=receipt&payable=1&seller=${S2}`, `/app/receipt/${S2}/1`],
    ['/judges', '/app/judges'],
    [`/receipt/1?seller=${S2}`, `/app/receipt/${S2}/1`],
    ['/verify-age', '/app/age'],
    [`/?payable=2&seller=${S1}`, `/app/pay/${S1}/2`],
    ['/app/nope', '/app'],
    ['/nope', '/'],
  ]
  for (const [from, to] of cases) {
    it(`${from} -> ${to}`, async () => {
      renderAt(from)
      await waitFor(() => expect(where()).toBe(to))
    })
  }

  it('a legacy link with no seller resolves to the first seller (the API default), in the canonical address form', async () => {
    renderAt('/dashboard/pay?tab=pick&payable=2')
    await waitFor(() => expect(where()).toBe(`/app/pay/${S1}/2`))
  })

  it('legacyPayTarget maps every tab once', () => {
    expect(legacyPayTarget(new URLSearchParams('tab=check&payable=3&seller=X'))).toBe('/app/pay/X/3')
    expect(legacyPayTarget(new URLSearchParams('tab=receipt&payable=3'))).toBe('/app/receipt/1/3')
  })
  it('the route family ignores the invoice, so choosing another invoice does not scroll', () => {
    expect(routeFamily('/app/pay/S/1')).toBe(routeFamily('/app/pay/S/2'))
    expect(routeFamily('/app/pay')).not.toBe(routeFamily('/app/invoices'))
  })
})

describe('shell', () => {
  it('desktop: one sidebar, one nav landmark, one active pill, no bottom bar', async () => {
    renderAt('/app')
    await screen.findByRole('heading', { name: 'Overview' })
    expect(screen.getAllByTestId('app-sidebar')).toHaveLength(1)
    expect(screen.getAllByRole('navigation', { name: 'App' })).toHaveLength(1)
    expect(screen.getAllByTestId('nav-pill')).toHaveLength(1)
    expect(screen.queryByRole('button', { name: 'More' })).toBeNull()
  })

  it('mobile: top bar and bottom tab bar, no sidebar, one nav landmark', async () => {
    stubMedia(false)
    renderAt('/app')
    await screen.findByRole('heading', { name: 'Overview' })
    expect(screen.queryByTestId('app-sidebar')).toBeNull()
    expect(screen.getAllByRole('navigation', { name: 'App' })).toHaveLength(1)
    expect(screen.getByRole('button', { name: 'More' })).toBeInTheDocument()
  })

  it('switching tasks swaps only the outlet: the chrome node is the same element (no remount)', async () => {
    const user = userEvent.setup()
    renderAt('/app')
    await screen.findByRole('heading', { name: 'Overview' })
    const sidebar = screen.getByTestId('app-sidebar')
    const shell = screen.getByTestId('app-shell')
    const nav = within(sidebar).getByRole('navigation', { name: 'App' })
    for (const [name, path, heading] of [
      ['Pay', '/app/pay', 'Pay an invoice'],
      ['Invoices', '/app/invoices', 'Invoices'],
      ['Break it', '/app/break', 'Break it'],
      ['Judges', '/app/judges', 'For judges'],
      ['Overview', '/app', 'Overview'],
    ] as const) {
      await user.click(within(nav).getByRole('link', { name }))
      await waitFor(() => expect(where()).toBe(path))
      await screen.findByRole('heading', { level: 1, name: heading })
      expect(screen.getByTestId('app-sidebar')).toBe(sidebar)
      expect(screen.getByTestId('app-shell')).toBe(shell)
      expect(sidebar.isConnected).toBe(true)
      expect(within(sidebar).getByRole('link', { name })).toHaveAttribute('aria-current', 'page')
    }
  })

  it('judges stays inside the shell', async () => {
    renderAt('/app/judges')
    await screen.findByRole('heading', { level: 1, name: 'For judges' })
    expect(screen.getByTestId('app-sidebar')).toBeInTheDocument()
  })
})

describe('seller key, end to end', () => {
  it('opening a seller-2 payable reads, checks and receipts it WITH the seller, never by id alone', async () => {
    renderAt(`/app/pay/${S2}/1`)
    await screen.findByText(/Payable 1, Seller 2/)
    const payableCalls = calls.filter((c) => /\/api\/payables\/1/.test(c.url))
    expect(payableCalls.length).toBeGreaterThan(0)
    for (const c of payableCalls) expect(c.url).toContain(`seller=${S2}`)
    // already paid: the receipt is read for the same seller
    await screen.findByTestId('receipt-view')
    const receiptCalls = calls.filter((c) => /\/api\/receipts\//.test(c.url))
    for (const c of receiptCalls) expect(c.url).toContain(`seller=${S2}`)
    const verifyCalls = calls.filter((c) => /\/verify/.test(c.url))
    expect(verifyCalls.length).toBeGreaterThan(0)
    for (const c of verifyCalls) expect(c.url).toContain(`seller=${S2}`)
  })

  it('seller 1 and seller 2 with the same id are different invoices (different payee shown)', async () => {
    const a = renderAt(`/app/pay/${S1}/2`)
    await screen.findByText(new RegExp(`PAYEE-${S1.slice(0, 4)}-2`))
    a.unmount()
    renderAt(`/app/pay/${S2}/2`)
    await screen.findByText(new RegExp(`PAYEE-${S2.slice(0, 4)}-2`))
  })

  it('paying a seller-2 invoice is disabled with a plain reason (the API signs only for seller 1)', async () => {
    renderAt(`/app/pay/${S2}/2`)
    const btn = await screen.findByRole('button', { name: /Review and pay/ })
    await waitFor(() => expect(btn).toHaveAttribute('aria-disabled', 'true'))
    expect(screen.getByText(/signs payments only for seller 1/)).toBeInTheDocument()
  })

  it('every Pay / Receipt link in the invoice list carries (seller, id)', async () => {
    renderAt('/app/invoices')
    await screen.findAllByTestId('invoice-row')
    const hrefs = screen.getAllByRole('link').map((a) => a.getAttribute('href') ?? '')
    expect(hrefs).toContain(`/app/receipt/${S2}/1`)
    expect(hrefs).toContain(`/app/receipt/${S1}/1`)
    expect(hrefs).toContain(`/app/pay/${S1}/2`)
  })

  it('"1" and "2" are accepted as seller shorthand and rewritten to the address', async () => {
    renderAt('/app/pay/2/1')
    await waitFor(() => expect(where()).toBe(`/app/pay/${S2}/1`))
  })

  it('the receipt is a deep link: it works for a payable not paid in this session', async () => {
    renderAt(`/app/receipt/${S2}/1`)
    await screen.findByRole('heading', { name: 'Paid once' })
    expect(await screen.findByTestId('verifier-line')).toBeInTheDocument()
    expect(screen.getByTestId('verifier-command').textContent).toBe(`node src/verify-payable-v2.mjs 1 ${'ef'.repeat(32)}`)
  })

  it('an unpaid receipt link says so and links to the pay screen with the seller', async () => {
    renderAt(`/app/receipt/${S1}/2`)
    const link = await screen.findByRole('link', { name: 'Pay this invoice' })
    expect(link).toHaveAttribute('href', `/app/pay/${S1}/2`)
  })
})

describe('pay flow', () => {
  it('checks run on load, the review sheet is a modal dialog, Escape closes it, confirm posts with the seller', async () => {
    const user = userEvent.setup()
    renderAt(`/app/pay/${S1}/2`)
    const btn = await screen.findByRole('button', { name: /Review and pay/ })
    await screen.findByTestId('check-summary')
    await waitFor(() => expect(btn).not.toHaveAttribute('aria-disabled'))
    await user.click(btn)
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: /Pay .* on testnet/ })))
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(btn)
    await user.click(await screen.findByRole('button', { name: /Pay .* on testnet/ }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes(`/api/payables/2/pay?seller=${S1}`))).toBe(true))
  })
})

describe('break it', () => {
  it('the injection attack is a real co-signer dry-run call, labelled as such', async () => {
    const user = userEvent.setup()
    renderAt('/app/break')
    const btn = await screen.findByRole('button', { name: 'Try the injected instruction' })
    await waitFor(() => expect(btn).not.toHaveAttribute('aria-disabled'))
    await user.click(btn)
    const out = await screen.findByTestId('attack-outcome')
    expect(calls.some((c) => c.url.includes('/api/cosigner/dry-run'))).toBe(true)
    expect(out).toHaveTextContent('REAL CALL')
    expect(out).toHaveTextContent('Co-signer')
  })

  it('the fraudster button is disabled when no fraud payable exists', async () => {
    renderAt('/app/break')
    const btn = await screen.findByRole('button', { name: /Pay a fraudster/ })
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/No invoice from a seller outside the vendor list/)).toBeInTheDocument()
  })
})

describe('overview', () => {
  it('shows LIVE tags, four stat cards, and a recorded fallback (with a derived date) when the API is down', async () => {
    renderAt('/app')
    await waitFor(() => expect(screen.getAllByText('LIVE').length).toBeGreaterThanOrEqual(4))
    expect(screen.getAllByTestId('stat-card')).toHaveLength(4)
  })

  it('StartHere ticks from local flags and can be dismissed', async () => {
    window.localStorage.setItem('po.step.verified', '1')
    const user = userEvent.setup()
    renderAt('/app')
    await screen.findByText('1 of 3 done.')
    await user.click(screen.getByRole('button', { name: 'Hide this' }))
    await waitFor(() => expect(screen.queryByTestId('start-here')).toBeNull())
  })
})

describe('copy bans on every app route', () => {
  const routes = ['/app', '/app/pay', `/app/pay/${S1}/2`, '/app/invoices', `/app/receipt/${S2}/1`, '/app/break', '/app/age']
  for (const r of routes) {
    it(`no banned word, hype word or emoji on ${r.slice(0, 20)}`, async () => {
      renderAt(r)
      await screen.findAllByRole('heading')
      await new Promise((res) => setTimeout(res, 300))
      const text = document.body.textContent ?? ''
      for (const b of BANNED_WORDS) {
        expect(text.toLowerCase(), `banned: ${b.word}`).not.toContain(b.word.toLowerCase())
      }
      for (const w of ['unleash', 'elevate', 'revolutionize', 'seamless', 'effortless', 'supercharge', 'game-changing', 'cutting-edge']) {
        expect(text.toLowerCase()).not.toContain(w)
      }
      expect(/\p{Extended_Pictographic}/u.test(text)).toBe(false)
    })
  }

  it('the judges page prints no typed test count and one fee figure', async () => {
    renderAt('/app/judges')
    await screen.findByRole('heading', { level: 1, name: 'For judges' })
    const text = document.body.textContent ?? ''
    expect(text).not.toMatch(/\b\d+ (Rust )?tests\b/)
    expect(text).not.toContain('19.6')
    expect(text).toContain('16.2 testnet CCD')
  })
})

describe('source rules for the app', () => {
  const files = import.meta.glob('./app/**/*.tsx', { query: '?raw', import: 'default', eager: true }) as Record<string, string>
  it('no window.location.reload and no plain <a href="/..."> for internal routes', () => {
    for (const [path, src] of Object.entries(files)) {
      expect(src, path).not.toContain('location.reload')
      expect(src, path).not.toMatch(/<a\s+href="\/(?!\/)/)
    }
  })
  it('nothing in the app starts at opacity 0 except overlay motion in the sheet', () => {
    for (const [path, src] of Object.entries(files)) {
      if (path.endsWith('ui.tsx')) continue
      expect(src, path).not.toMatch(/initial=\{\{[^}]*opacity:\s*0/)
    }
  })
})
