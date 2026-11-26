// AgeProofPage — mocked API responses shaped exactly like the real ones:
// the 403 REVEAL_REFUSED from the prover policy, the 200 valid:true and
// the 400 valid:false from the official verifier, and the 503
// prover_unavailable when the sidecar is not provisioned.
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
let lastVerifyBody: unknown = null

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
      if (url.includes('/api/age-proof/verify')) {
        lastVerifyBody = init?.body ? JSON.parse(String(init.body)) : null
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
    lastVerifyBody = null
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

  it('shows the 200 valid:true from the verify panel', async () => {
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Verify the 18+ proof' }))
    await waitFor(() => expect(screen.getByText(/valid: true/)).toBeInTheDocument())
    expect(screen.getByText(/Valid 18\+ proof/)).toBeInTheDocument()
  })

  it('shows the 400 valid:false when the verifier rejects', async () => {
    verifyStatus = 400
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    await user.click(screen.getByRole('button', { name: 'Verify the 18+ proof' }))
    await waitFor(() => expect(screen.getByText('HTTP 400 · valid: false')).toBeInTheDocument())
    expect(screen.getByText(/Rejected by the official testnet verifier/)).toBeInTheDocument()
  })

  it('M3: sends the payable id + payer with the verify call and shows the filing', async () => {
    verifyFiled = true
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    await user.type(screen.getByLabelText('Payable to unlock'), '1007')
    await user.type(screen.getByLabelText('Payer account'), '4TestPayer')
    await user.click(screen.getByRole('button', { name: 'Verify the 18+ proof' }))
    await waitFor(() => expect(screen.getByText(/valid: true/)).toBeInTheDocument())
    expect(screen.getByText(/Filed for payable 1007/)).toBeInTheDocument()
    expect(lastVerifyBody).toMatchObject({ payable_id: 1007, payer: '4TestPayer' })
  })

  // Fix-back-2 MF2: the filed copy says "filed for this payer" — never
  // "the age gate is open for this payer" (the pay gate honours only
  // proofs filed for its fixed payer, so that sentence was false for
  // any other payer). A proof filed for another payer surfaces the
  // API's binding/holder reason instead of the generic nothing-filed
  // text.
  it('MF2: a filed proof says "filed for this payer", never "the age gate is open"', async () => {
    verifyFiled = true
    verifyHolder = '4TestPayer'
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    await user.type(screen.getByLabelText('Payable to unlock'), '1007')
    await user.type(screen.getByLabelText('Payer account'), '4TestPayer')
    await user.click(screen.getByRole('button', { name: 'Verify the 18+ proof' }))
    await waitFor(() => expect(screen.getByText(/Filed for payable 1007 for this payer/)).toBeInTheDocument())
    expect(screen.queryByText(/the age gate is open for this payer/)).not.toBeInTheDocument()
  })

  it('MF2: a proof for another payer shows the binding + holder reason, not the generic text', async () => {
    verifyFiled = false
    verifyBinding = 'holder_mismatch'
    verifyHolder = '4OtherHolder'
    const user = userEvent.setup()
    renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    await user.type(screen.getByLabelText('Payable to unlock'), '1007')
    await user.type(screen.getByLabelText('Payer account'), '4TestPayer')
    await user.click(screen.getByRole('button', { name: 'Verify the 18+ proof' }))
    await waitFor(() => expect(screen.getByText(/holder_mismatch/)).toBeInTheDocument())
    expect(screen.getByText(/belongs to holder 4OtherHolder, not the payer entered/)).toBeInTheDocument()
    expect(screen.getByText(/never opens the gate/)).toBeInTheDocument()
    expect(screen.queryByText(/no payable \+ payer were given/)).not.toBeInTheDocument()
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
    expect(screen.getAllByText(/Demo unavailable — The prover is not provisioned on this API host yet/)).toHaveLength(2)
    expect(screen.getByRole('button', { name: 'Reveal the first name' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Verify the 18+ proof' })).toBeDisabled()
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
    expect(screen.getByRole('button', { name: 'Verify the 18+ proof' })).toBeDisabled()
  })

  it('B7: the verify intro has no stray valid:false fragment', async () => {
    const { container } = renderPage()
    await waitFor(() => expect(screen.getByText('Prover live — Testnet')).toBeInTheDocument())
    // v9: the page lives inside the app shell, so it renders no header of its own.
    expect(container.querySelector('header')).toBeNull()
    expect(screen.queryByText(/returns HTTP 400 with/)).toBeNull()
  })
})
