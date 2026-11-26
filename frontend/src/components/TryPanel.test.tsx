// TryPanel — seller gate (B2/B-2, round-4 fix-back). The three live
// attacks POST to /api/attacks/:kind with no seller, and the server runs
// them against seller 1's same-id payable — for seller-2 facts that
// sends a REAL transaction against the wrong payable. The gate disables
// them for seller-2 facts (and while the config is unavailable, when the
// gate cannot tell seller 1 from seller 2), mirroring the F-3 pay gate.
// Tamper and injection are client-side and stay live.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { TryPanel } from './TryPanel'

const S1 = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'
const S2 = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr'
const DAY_MS = 24 * 60 * 60 * 1000

const factsFor = (seller: string, status: 'unpaid' | 'paid') => ({
  payable_id: 1,
  asset: { kind: 'ccd' as const, token: 'CCD' },
  amount: '0.5',
  amount_display: '0.5 CCD',
  payee: 'PAYEE-PLACEHOLDER',
  seller,
  due: new Date(Date.now() + DAY_MS).toISOString(),
  is_past_due: false,
  status:
    status === 'paid'
      ? { kind: 'paid' as const, payer: 'PAYER-PLACEHOLDER', paid_at: new Date().toISOString(), payment_tx: 'ab'.repeat(32), payment_tx_source: 'chain' as const }
      : { kind: 'unpaid' as const },
  agent: { registry: { index: 13144, subindex: 0 }, token: 'AGENTTOKEN' },
  doc_sha256: '0'.repeat(64),
  label: 'Lab invoice 1',
})

const HEALTH = {
  chain: { reachable: true, checked_at: '2026-11-24T10:42:07Z' },
  node_busy: false,
  payer: { status: 'ok' },
  sponsor: { status: 'ok' },
  wallet_eudemo: { status: 'ok' },
  co_signer: { status: 'ok' },
  budget: { new_invoices_left_this_hour: 3, attack_sends_left_this_hour: 10 },
}

const attackFor = (kind: string) => ({
  kind,
  payable_id: 1,
  layer: 'chain',
  live: true,
  tx_sent: true,
  outcome: 'refused',
  reject: { code: -19, name: 'Rejected', plain: 'The chain refused it.' },
  fee_testnet_ccd: '0.5',
  tx_hash: 'ab'.repeat(32),
  explorer_url: 'https://example.invalid/tx',
  plain: 'The chain refused it.',
})

function mockApi() {
  const fetchMock = vi.fn(async (url: string) => {
    if (url.includes('/api/health')) {
      return { ok: true, status: 200, json: async () => HEALTH }
    }
    const m = /\/api\/attacks\/(\w+)/.exec(url)
    if (m) {
      return { ok: true, status: 200, json: async () => attackFor(m[1]) }
    }
    return { ok: false, status: 404, json: async () => ({}) }
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

function renderPanel(props: {
  facts: ReturnType<typeof factsFor>
  isSecondSeller?: boolean
  configUnavailable?: boolean
  configPending?: boolean
  hasPaidInSession?: boolean
}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <TryPanel
        facts={props.facts}
        docText="Payable 1\nAmount 0.5 CCD"
        docSha256={'0'.repeat(64)}
        explorerBase="https://ccdexplorer.io/testnet/transaction/"
        hasPaidInSession={props.hasPaidInSession ?? false}
        isSecondSeller={props.isSecondSeller ?? false}
        configUnavailable={props.configUnavailable ?? false}
        configPending={props.configPending ?? false}
      />
    </QueryClientProvider>,
  )
}

const GATE_MESSAGE =
  'These live attacks run against seller 1’s payables only — this payable belongs to the second seller, so they are disabled here.'
const CONFIG_MESSAGE = 'The seller list could not be loaded, so the live attacks are paused — reload the page to try again.'

describe('TryPanel seller gate (B2)', () => {
  // NOTE: wrap in an arrow — beforeEach treats a hook's RETURNED function
  // as a cleanup hook, and mockApi returns the fetch mock (vitest would
  // call it with no args after every test).
  beforeEach(() => {
    mockApi()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('seller-2 facts → the three live attack buttons are disabled with the gate message; tamper and injection stay live', async () => {
    renderPanel({ facts: factsFor(S2, 'unpaid'), isSecondSeller: true })
    await waitFor(() => expect(screen.getByText(/Budget this hour:/)).toBeInTheDocument())
    // The gate message is shown (banner + one reason under each gated button).
    expect(screen.getAllByText(GATE_MESSAGE).length).toBeGreaterThanOrEqual(1)
    for (const name of [/Pay it twice/, /Wrong amount/, /Pay a fraudster’s invoice/]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true')
    }
    // Client-side scenarios are untouched by the gate.
    expect(screen.getByRole('button', { name: /Tamper with the invoice/ })).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: /Injection: tell the agent/ })).not.toHaveAttribute('aria-disabled', 'true')
  })

  it('seller-2 facts → no attack POST is issued (the buttons have no handler while disabled)', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApi()
    renderPanel({ facts: factsFor(S2, 'unpaid'), isSecondSeller: true })
    await waitFor(() => expect(screen.getByText(/Budget this hour:/)).toBeInTheDocument())
    // Clicks on aria-disabled buttons fire no handler (onClick is undefined).
    await user.click(screen.getByRole('button', { name: /Wrong amount/ }))
    await user.click(screen.getByRole('button', { name: /Pay a fraudster’s invoice/ }))
    expect(fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/attacks/')).length).toBe(0)
  })

  it('seller-1 facts → the live attacks work as before (wrong amount + pay twice POST, outcome shown)', async () => {
    const user = userEvent.setup()
    const fetchMock = mockApi()
    renderPanel({ facts: factsFor(S1, 'unpaid'), hasPaidInSession: true })
    await waitFor(() => expect(screen.getByText(/Budget this hour:/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Wrong amount/ })).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: /Pay it twice/ })).not.toHaveAttribute('aria-disabled', 'true')
    expect(screen.getByRole('button', { name: /Pay a fraudster’s invoice/ })).not.toHaveAttribute('aria-disabled', 'true')
    await user.click(screen.getByRole('button', { name: /Wrong amount/ }))
    // The outcome card renders 'Real' (live) — the button label alone
    // cannot prove the attack ran (it shares the card title's text).
    await waitFor(() => expect(screen.getByText('Real')).toBeInTheDocument())
    expect(screen.getAllByText('Wrong amount').length).toBeGreaterThanOrEqual(2)
    const attackCalls = fetchMock.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('/api/attacks/'))
    expect(attackCalls.some((u) => u.includes('/api/attacks/wrong_amount'))).toBe(true)
    expect(screen.getByText('Real')).toBeInTheDocument()
  })

  it('config unavailable → the three live attacks are disabled with the config message, even for seller-1 facts', async () => {
    renderPanel({ facts: factsFor(S1, 'unpaid'), configUnavailable: true })
    await waitFor(() => expect(screen.getByText(/Budget this hour:/)).toBeInTheDocument())
    expect(screen.getAllByText(CONFIG_MESSAGE).length).toBeGreaterThanOrEqual(1)
    for (const name of [/Pay it twice/, /Wrong amount/, /Pay a fraudster’s invoice/]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true')
    }
  })

  it('N-10: config still loading → the gate says “still loading”, not “could not be loaded”', async () => {
    renderPanel({ facts: factsFor(S1, 'unpaid'), configUnavailable: true, configPending: true })
    await waitFor(() => expect(screen.getByText(/Budget this hour:/)).toBeInTheDocument())
    expect(
      screen.getAllByText('The seller list is still loading, so the live attacks are paused until it loads.').length,
    ).toBeGreaterThanOrEqual(1)
    expect(screen.queryByText(CONFIG_MESSAGE)).toBeNull()
    for (const name of [/Pay it twice/, /Wrong amount/, /Pay a fraudster’s invoice/]) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-disabled', 'true')
    }
  })

  it('B-2: the unlisted-seller known limit states the live truth — a second seller DOES hold an Active agent token (token 1506)', async () => {
    const user = userEvent.setup()
    mockApi()
    renderPanel({ facts: factsFor(S1, 'unpaid') })
    await waitFor(() => expect(screen.getByText(/Budget this hour:/)).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: /Pay a fraudster’s invoice/ }))
    // The outcome card's known-limit names the live token (the button
    // shares the card title's text, so wait on the limit itself).
    await waitFor(() => expect(screen.getByText(/token 1506/)).toBeInTheDocument())
    expect(screen.queryByText(/no second seller holds an Active agent token/)).toBeNull()
  })
})
