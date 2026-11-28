// AgeProofPage — mocked API responses shaped exactly like the real ones:
// the 403 REVEAL_REFUSED from the prover policy, the 200 valid:true and
// the 400 valid:false from the official verifier, and the 503
// prover_unavailable when the prover is not reachable.
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { AgeProofPage, AGE_PROOF_VRA, AGE_PROOF_VAA } from './AgeProofPage'

const HEALTH = {
  chain: { reachable: true, checked_at: '2026-11-24T10:42:07Z' },
  node_busy: false,
  payer: { status: 'ok' },
  sponsor: { status: 'ok' },
  wallet_eudemo: { status: 'ok' },
  co_signer: { status: 'ok' },
  budget: { new_invoices_left_this_hour: 3, attack_sends_left_this_hour: 5 },
}

const AGE_HEALTH = {
  service: 'payonce-age-proof',
  prover_available: true,
  prover: {
    service: 'scoped-prover',
    network: 'Testnet',
    attributes_held: ['dob', 'nationality'],
    issuer_did: 'did:ccd:testnet:idp:0',
    allow_list: [
      'dob AttributeInRange, lower 18000101, upper today minus 18 or 21 years',
      'nationality AttributeInSet, set exactly the EU 27',
    ],
    refuses: ['RevealAttribute / AttributeValue (any attribute)'],
  },
  anchored_run: {
    vra: AGE_PROOF_VRA,
    vaa: AGE_PROOF_VAA,
    record_sha256: 'fab62d06a55399e76699c52cf64799514b2d06b0b9a0062c16d7c29d9b469d3e',
    statements: ['dob AttributeInRange 18000101–20081125', 'nationality in EU 27'],
  },
  proven_rejections: [
    'forbidden statement shape -> HTTP 403 from the prover policy',
    'tampered presentation -> HTTP 400 from the official testnet verifier',
  ],
  checked_at: '2026-11-24T10:42:07Z',
}

let verifyStatus = 200
let ageHealthStatus = 200
let verifyFiled = false
let verifyBinding: string | null = null
let verifyHolder: string | null = null
let lastV1Body: unknown = null
let v1Status = 200

function mockApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes('/api/age-proof/health')) {
        if (ageHealthStatus !== 200) {
          return {
            ok: false,
            status: 503,
            json: async () => ({
              error: {
                code: 'prover_unavailable',
                layer: 'server',
                message: 'The age-proof prover is not reachable on this host.',
                retryable: true,
              },
            }),
          }
        }
        return { ok: true, status: 200, json: async () => AGE_HEALTH }
      }
      if (url.includes('/api/age-proof/policy-check')) {
        return {
          ok: false,
          status: 403,
          json: async () => ({ allowed: false, rule: 'REVEAL_REFUSED', reason: 'reveal of firstName is refused by policy' }),
        }
      }
      if (url.includes('/api/age-proof/v1')) {
        lastV1Body = init?.body ? JSON.parse(String(init.body)) : null
        if (v1Status === 200) {
          return { ok: true, status: 200, json: async () => ({ ok: true, binding: 'bound', statements: ['dob >= 18', 'nationality in EU27'], payable_id: 1007, vra_tx: 'aa'.repeat(32), vaa_tx: 'bb'.repeat(32), valid_for_seconds: 600 }) }
        }
        return { ok: false, status: 400, json: async () => ({ ok: false, step: 'node_verify', error: 'the node rejected the presentation (bad proof)' }) }
      }
      if (url.includes('/api/age-proof/verify')) {
        if (verifyStatus === 200) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              valid: true,
              statements: ['dob>=18', 'nationality in EU27'],
              filed_for_payable: verifyFiled ? 1007 : null,
              holder: verifyHolder ?? (verifyFiled ? '4TestPayer' : null),
              binding: verifyBinding ?? (verifyFiled ? 'bound' : 'not_requested'),
              verified_at: '2026-11-24T10:42:07Z',
            }),
          }
        }
        return {
          ok: false,
          status: 400,
          json: async () => ({ valid: false, verifier_status: 400 }),
        }
      }
      if (url.includes('/api/health')) return { ok: true, status: 200, json: async () => HEALTH }
      return { ok: false, status: 404, json: async () => ({}) }
    }),
  )
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
        <AgeProofPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('AgeProofPage', () => {
  beforeEach(() => {
    verifyStatus = 200
    ageHealthStatus = 200
    verifyFiled = false
    verifyBinding = null
    verifyHolder = null
    lastV1Body = null
    v1Status = 200
    mockApi()
  })
  afterEach(() => vi.unstubAllGlobals())

  it('shows the allow-list and the anchored VRA/VAA with explorer links', async () => {
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    expect(screen.getByText(/dob AttributeInRange, lower 18000101/)).toBeInTheDocument()
    const vra = screen.getByText(AGE_PROOF_VRA)
    expect(vra.closest('a')?.getAttribute('href')).toBe(
      `https://ccdexplorer.io/testnet/transaction/${AGE_PROOF_VRA}`,
    )
    const vaa = screen.getByText(AGE_PROOF_VAA)
    expect(vaa.closest('a')?.getAttribute('href')).toBe(
      `https://ccdexplorer.io/testnet/transaction/${AGE_PROOF_VAA}`,
    )
    // Precision copy: no under-18-holder test is claimed.
    expect(screen.getByText(/No under-18 identity exists in the lab/)).toBeInTheDocument()
  })

  it('shows the 403 REVEAL_REFUSED when trying a forbidden shape', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Reveal the first name' }))
    await waitFor(() => expect(screen.getByText('HTTP 403 · rule REVEAL_REFUSED')).toBeInTheDocument())
    expect(screen.getByText('reveal of firstName is refused by policy')).toBeInTheDocument()
  })

  it('the 18+ check needs an invoice number: the button stays disabled until one is typed', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    const btn = screen.getByRole('button', { name: 'Run the 18+ check' })
    expect(btn).toBeDisabled()
    await user.type(screen.getByLabelText('Invoice number'), 'abc')
    expect(screen.getByRole('alert')).toHaveTextContent('Enter an invoice number')
    expect(btn).toBeDisabled()
    expect(lastV1Body).toBeNull()
  })

  it('runs the real V1 check for the invoice and shows Match with both anchors', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    await user.type(screen.getByLabelText('Invoice number'), '1007')
    await user.click(screen.getByRole('button', { name: 'Run the 18+ check' }))
    await waitFor(() => expect(screen.getByText('Match: 18+ proven for invoice 1007')).toBeInTheDocument())
    expect(lastV1Body).toEqual({ payable_id: 1007 })
    expect(screen.getByRole('link', { name: 'Request anchored on CCDExplorer' })).toHaveAttribute('href', expect.stringContaining('aa'.repeat(32)))
    expect(screen.getByRole('link', { name: 'Result anchored on CCDExplorer' })).toHaveAttribute('href', expect.stringContaining('bb'.repeat(32)))
  })

  it('a failed check says No match and nothing was filed, with the step', async () => {
    v1Status = 400
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    await user.type(screen.getByLabelText('Invoice number'), '1007')
    await user.click(screen.getByRole('button', { name: 'Run the 18+ check' }))
    await waitFor(() => expect(screen.getByText('No match: nothing was filed')).toBeInTheDocument())
    expect(screen.getByText(/the node rejected the presentation/)).toBeInTheDocument()
  })

  it('says plainly the prover is not provisioned yet when the API returns 503', async () => {
    ageHealthStatus = 503
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover not provisioned yet')).toBeInTheDocument(), {
      timeout: 5000,
    })
    expect(screen.getByText(/does not pretend to verify live/)).toBeInTheDocument()
  })

  // Fix-back-6 B7: a dead demo must not present as a live one — when the
  // prover is down, BOTH demo sections carry their own "Demo unavailable"
  // banner and their buttons stay disabled; and the header sits on a dark
  // band (white nav text on light paper was near-invisible).
  it('B7: when the prover is down, both demos say unavailable and stay disabled', async () => {
    ageHealthStatus = 503
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover not provisioned yet')).toBeInTheDocument(), {
      timeout: 5000,
    })
    expect(screen.getAllByText(/Demo unavailable — The prover service is not reachable or not configured for this API/)).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Reveal the first name' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run the 18+ check' })).toBeDisabled()
  })

  // Fix-back-7 S2: while health is loading, both demo sections carry a
  // loading banner explaining the disabled buttons — not silence under
  // live-looking intro copy.
  it('S2: while health loads, both demos show a loading banner and stay disabled', () => {
    renderPage()
    expect(
      screen.getAllByText('Checking the age-proof prover… The demo buttons stay disabled until it answers.'),
    ).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Reveal the first name' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Run the 18+ check' })).toBeDisabled()
  })

  it('B7: the verify intro has no stray valid:false fragment', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    // v9: the page lives inside the app shell, so it renders no header of its own.
    expect(container.querySelector('header')).toBeNull()
    expect(screen.queryByText(/returns HTTP 400 with/)).toBeNull()
  })
})
