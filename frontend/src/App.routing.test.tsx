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
  { seller: S1, payable_id: 2, asset: 'ccd', amount_display: '0.500000 CCD', due: due(2), status: 'Unpaid', label: 'Lab invoice 2', kind: 'demo' },
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
      else if (u.pathname === '/api/cosigner/dry-run') body = { decision: 'REFUSE', reason: 'wrong-recipient', plain: 'The policy gate would refuse this transfer. Nothing was sent.', tx_sent: false }
      else if (m && m[2] === '/verify') body = CHECKS(JSON.parse(init!.body as string).mode)
      else if (m && m[2] === '/pay') body = { job_id: 'job1', payable_id: Number(m[1]), rail: 'ccd', steps: ['check_status', 'submit'] }
      else if (m && !m[2]) body = facts(seller, Number(m[1]))
      else if (m && m[2] === '/document') return { ok: true, status: 200, text: async () => `Payee: PAYEE-${seller.slice(0, 4)}-${m[1]}\n`, json: async () => ({}) }
      else if (u.pathname === '/api/jobs/job1') body = { job_id: 'job1', payable_id: 2, rail: 'ccd', state: 'running', steps: [], outcome: null, started_at: '2026-11-28T06:00:00Z', finished_at: null }
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
    ['/dashboard?tab=pick#pay', '/app'],
    ['/dashboard/pay?tab=pick', '/app'],
    ['/dashboard/pay?tab=try', '/app/proof/break'],
    [`/dashboard/pay?tab=receipt&payable=1&seller=${S2}`, `/app/receipt/${S2}/1`],
    ['/judges', '/app/proof/judges'],
    [`/receipt/1?seller=${S2}`, `/app/receipt/${S2}/1`],
    ['/verify-age', '/app/proof/age'],
    [`/?payable=2&seller=${S1}`, `/app/receipt/${S1}/2`],
    ['/app/agent', '/app/proof/agent'],
    ['/app/break', '/app/proof/break'],
    ['/app/judges', '/app/proof/judges'],
    ['/app/age?x=1', '/app/proof/age?x=1'],
    [`/app/pay/${S1}/2`, '/app'],
    ['/app/invoices', '/app'],
    ['/app/x402', '/app/proof/x402'],
    ['/nope', '/'],
  ]
  for (const [from, to] of cases) {
    it(`${from} -> ${to}`, async () => {
      renderAt(from)
      await waitFor(() => expect(where()).toBe(to))
    })
  }

  it('an unknown /app address shows a real not-found view, not the flow', async () => {
    renderAt('/app/nope')
    expect(await screen.findByTestId('not-found')).toBeInTheDocument()
    expect(where()).toBe('/app/nope')
  })

  it('legacyPayTarget maps every tab once', () => {
    expect(legacyPayTarget(new URLSearchParams('tab=check&payable=3&seller=X'))).toBe('/app')
    expect(legacyPayTarget(new URLSearchParams('tab=receipt&payable=3'))).toBe('/app/receipt/any/3')
  })
  it('the route family ignores the invoice', () => {
    expect(routeFamily('/app/receipt/S/1')).toBe(routeFamily('/app/receipt/S/2'))
  })
})

describe('shell', () => {
  it('one slim bar: brand, two tabs (Run it, Proof), the network; no sidebar', async () => {
    renderAt('/app')
    await screen.findByRole('heading', { level: 1, name: /checks who it’s paying/ })
    const nav = screen.getByRole('navigation', { name: 'App' })
    expect(within(nav).getAllByRole('link').map((l) => l.textContent)).toEqual(['Run it', 'Proof'])
    expect(within(nav).getByRole('link', { name: 'Run it' })).toHaveAttribute('aria-current', 'page')
    expect(screen.queryByTestId('app-sidebar')).toBeNull()
  })

  it('switching tabs swaps only the outlet: the shell node is the same element', async () => {
    const user = userEvent.setup()
    renderAt('/app')
    await screen.findByRole('heading', { level: 1, name: /checks who it’s paying/ })
    const shell = screen.getByTestId('app-shell')
    await user.click(within(screen.getByRole('navigation', { name: 'App' })).getByRole('link', { name: 'Proof' }))
    await screen.findByRole('heading', { level: 1, name: 'Proof' })
    expect(screen.getByTestId('app-shell')).toBe(shell)
    expect(within(screen.getByRole('navigation', { name: 'App' })).getByRole('link', { name: 'Proof' })).toHaveAttribute('aria-current', 'page')
  })

  it('judges stays inside the shell, under Proof', async () => {
    renderAt('/app/proof/judges')
    await screen.findByRole('heading', { level: 1, name: 'For judges' })
    expect(screen.getByTestId('app-shell')).toBeInTheDocument()
    expect(within(screen.getByRole('navigation', { name: 'App' })).getByRole('link', { name: 'Proof' })).toHaveAttribute('aria-current', 'page')
  })
})

describe('run it: the one guided flow', () => {
  it('payer -> invoice -> check (Match) -> review sheet (modal, Escape closes) -> pay posts with the seller', async () => {
    const user = userEvent.setup()
    renderAt('/app')
    await user.click(await screen.findByRole('button', { name: 'Use the testnet buyer agent' }))
    await user.click(await screen.findByRole('button', { name: 'Get an invoice' }))
    // createPayable is not mocked (404), so the flow falls back to an open demo invoice from the list
    await user.click(await screen.findByRole('button', { name: 'Let the agent check it' }))
    const verdict = await screen.findByTestId('run-verdict')
    expect(verdict).toHaveTextContent('Match')
    const v = calls.find((c) => c.url.includes('/verify'))!
    expect(v.url).toContain(`seller=${S1}`)
    await user.click(screen.getByRole('button', { name: 'Approve and pay' }))
    const dialog = await screen.findByRole('dialog')
    expect(dialog).toHaveAttribute('aria-modal', 'true')
    await user.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    await user.click(screen.getByRole('button', { name: 'Approve and pay' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Approve and pay' }))
    await waitFor(() => expect(calls.some((c) => c.method === 'POST' && c.url.includes(`/api/payables/2/pay?seller=${S1}`))).toBe(true))
  })
})

describe('receipt deep links', () => {
  it('the receipt is a deep link: it works for a payable not paid in this session', async () => {
    renderAt(`/app/receipt/${S2}/1`)
    await screen.findByRole('heading', { name: 'Paid once' })
    expect(await screen.findByTestId('verifier-line')).toBeInTheDocument()
    expect(screen.getByTestId('verifier-command').textContent).toBe(
      `curl -s "https://payonce-api-n98a.onrender.com/api/payables/1/document?seller=${S2}" -o invoice-s2-1.txt
node src/verify-payable-v2.mjs 1 ${'ef'.repeat(32)} --seller ${S2} --doc invoice-s2-1.txt`,
    )
    for (const c of calls.filter((c) => /\/api\/receipts\//.test(c.url))) expect(c.url).toContain(`seller=${S2}`)
  })

  it('an unpaid receipt link says so and sends you to the flow', async () => {
    renderAt(`/app/receipt/${S1}/2`)
    const link = await screen.findByRole('link', { name: 'Pay this invoice' })
    expect(link).toHaveAttribute('href', '/app')
  })
})

describe('try to fool it', () => {
  it('the injection attack is a real policy gate dry-run call, labelled as such', async () => {
    const user = userEvent.setup()
    renderAt('/app/proof/break')
    const btn = await screen.findByRole('button', { name: 'Try the injected instruction' })
    await waitFor(() => expect(btn).not.toHaveAttribute('aria-disabled'))
    await user.click(btn)
    const out = await screen.findByTestId('attack-outcome')
    expect(calls.some((c) => c.url.includes('/api/cosigner/dry-run'))).toBe(true)
    expect(out).toHaveTextContent('REAL CALL')
    expect(out).toHaveTextContent('Policy gate')
  })

  it('the fraudster button is disabled when no fraud payable exists', async () => {
    renderAt('/app/proof/break')
    const btn = await screen.findByRole('button', { name: /Pay a fraudster/ })
    expect(btn).toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByText(/No invoice from a seller outside the vendor list/)).toBeInTheDocument()
  })
})

describe('copy bans on every app route', () => {
  const routes = ['/app', '/app/proof', `/app/receipt/${S2}/1`, '/app/proof/break', '/app/proof/age', '/app/proof/agent']
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
    renderAt('/app/proof/judges')
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
