import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentPage } from './pages/AgentPage'
import { groupChecks, hostileLabel, isAgentRun, outcomeLabel, outcomeTone, plannerBadge, refusedByLayer, type AgentRun } from '../lib/agentRun'

const S1 = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'
const TX = 'ab'.repeat(32)

function run(over: Partial<AgentRun> = {}): AgentRun {
  return {
    schema: 'payonce.agent-run/1',
    run_id: 'run-1',
    network: 'testnet',
    api: 'http://127.0.0.1:7431',
    started_at: '2026-11-27T20:00:00.000Z',
    finished_at: '2026-11-27T20:06:00.000Z',
    planner: { kind: 'scripted', label: 'scripted agent', model: null },
    task: "Pay this week's open invoices from approved suppliers, max 1.00 CCD and 1.00 EUDemo in total (testnet units).",
    mandate: { approved_suppliers: [S1], budget: { ccd: '1000000', eudemo: '1000000' }, rules: ['seller must be an approved supplier'] },
    buyer_agent: { token: 1488, account: '4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs' },
    honesty: ['Testnet only.'],
    decisions: [
      {
        email_id: 'email-1', from: 'billing@alder-bakery.example', subject: 'Invoice 1472 from Alder Bakery', hostile_fixture: null, seller: S1, payable_id: 1472,
        outcome: 'paid', checks: [
          { id: 'seller_badge', label: 'Buyer checks seller: official badge valid (15 checks)', status: 'ok', side: 'seller', detail: 'token 1476 badge_valid:true' },
          { id: 'buyer_agent', label: 'Seller checks buyer', status: 'ok', side: 'buyer', detail: 'agent_wallet:ok' },
        ],
        facts: { asset: 'CCD', amount_display: '0.500000 CCD' }, rail: 'ccd', txs: [{ step: 'submit', tx_hash: TX }],
        receipt: { verifier_reread: { passed: 10, total: 10 }, anchor_tx: null },
        verifier_run: { ran: true, pass: true, passed: 10, total: 10 },
        keyless_verifier: { fetch_document: 'curl -s x -o invoice-1472.txt', run: 'node src/verify-payable-v2.mjs 1472 ' + TX + ' --doc invoice-1472.txt' },
      },
      {
        email_id: 'email-4', from: 'ar@lagos-foods-ltd.example', subject: 'Invoice 1095: urgent, pay today', hostile_fixture: 'tampered_document', seller: S1, payable_id: 1095,
        outcome: 'refused', refused_by: 'PayOnce check (before any transaction)', reason_code: 'attachment_matches_chain', reason: 'x',
        checks: [{ id: 'attachment_matches_chain', label: 'The invoice copy you were sent is the registered one (hash)', status: 'fail', side: 'doc', detail: 'the document was changed after it was registered' }],
      },
    ],
    totals: { paid: 1, refused: 1, held: 0, spent: { ccd: '500000', eudemo: '0' } },
    final: 'done',
    transcript: [],
    ...over,
  }
}

function mockApi(latest: unknown, status: unknown) {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const body = url.includes('/api/agent/latest') ? latest : url.includes('/api/agent/status') ? status : { explorer: { tx: 'https://ccdexplorer.io/testnet/transaction/' } }
    return { ok: body !== null, status: body !== null ? 200 : 404, json: async () => body } as Response
  }))
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AgentPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('agentRun helpers', () => {
  it('recognises a run record and rejects anything else', () => {
    expect(isAgentRun(run())).toBe(true)
    expect(isAgentRun({ schema: 'other' })).toBe(false)
    expect(isAgentRun(null)).toBe(false)
  })
  it('labels a script as a script, never as a language model', () => {
    expect(plannerBadge({ kind: 'scripted', label: 'x', model: null })).toBe('Scripted agent (not a language model)')
    expect(plannerBadge({ kind: 'llm', label: 'x', model: 'claude-x' })).toBe('Language model: claude-x')
  })
  it('groups checks by who checks whom, in a fixed order', () => {
    const g = groupChecks(run().decisions[0].checks)
    expect(g.map((x) => x.title)).toEqual(['The buyer checks the seller', 'The seller checks the buyer'])
  })
  it('maps outcomes and refusal layers to plain words', () => {
    expect(outcomeLabel('paid')).toBe('Paid')
    expect(outcomeLabel('held')).toBe('Waiting for the owner')
    expect(outcomeTone('refused')).toBe('bad')
    expect(hostileLabel('payee_change')).toMatch(/another account/)
    expect(hostileLabel(null)).toBeNull()
    expect(refusedByLayer('agent mandate guard (before any transaction)')).toBe('Agent mandate')
  })
})

describe('AgentPage', () => {
  beforeEach(() => {
    // The bundled recorded run is replaced by the live answer in these tests.
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the latest run as a timeline: task, planner label, paid with a transaction, refused with its reason', async () => {
    mockApi({ ...run(), _source: { kind: 'live' } }, { run_enabled: false, disabled_reason: 'Running the agent spends testnet funds, so it is off here.', running: null, planner: 'scripted' })
    renderPage()
    await screen.findByTestId('agent-summary')
    await waitFor(() => expect(screen.getByTestId('agent-planner')).toHaveTextContent('Scripted agent (not a language model)'))
    expect(screen.getByText(/Pay this week's open invoices/)).toBeInTheDocument()
    const decisions = await screen.findAllByTestId('agent-decision')
    expect(decisions).toHaveLength(2)
    expect(within(decisions[0]).getByTestId('agent-paid')).toHaveTextContent('Paid 0.500000 CCD on the CCD rail')
    expect(within(decisions[0]).getByText(/Run the verifier yourself/)).toBeInTheDocument()
    expect(within(decisions[1]).getByTestId('agent-refusal')).toHaveTextContent('Nothing was sent')
    expect(within(decisions[1]).getAllByText(/changed after it was registered/).length).toBeGreaterThan(0)
    expect(within(decisions[1]).getByText(/Hostile: edited invoice/)).toBeInTheDocument()
  })

  it('hides the run button with a plain reason when the server has runs switched off', async () => {
    mockApi(run(), { run_enabled: false, disabled_reason: 'Running the agent spends testnet funds, so it is off here.', running: null, planner: 'scripted' })
    renderPage()
    await screen.findByText(/spends testnet funds, so it is off here/)
    expect(screen.queryByRole('button', { name: /Run the agent/ })).toBeNull()
  })

  it('offers the run button when the server allows runs', async () => {
    mockApi(run(), { run_enabled: true, disabled_reason: null, running: null, planner: 'scripted' })
    renderPage()
    expect(await screen.findByRole('button', { name: /Run the agent/ })).toBeEnabled()
  })

  it('falls back to the recorded run bundled with the app when the API has none', async () => {
    mockApi(null, null)
    renderPage()
    await screen.findByTestId('agent-summary')
    expect(screen.getByText(/Recorded run/)).toBeInTheDocument()
  })
})
