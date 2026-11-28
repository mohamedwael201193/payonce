import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { diffPositions } from './motion'
import { acceptPayeeParamHex } from './params'
import { dashApi, NotShipped } from './contracts'
import { dashEnabled } from './flag'
import { PayeePage } from './PayeePage'

const A = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin'
const S = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })

beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('payee diff', () => {
  it('marks only the changed characters', () => {
    expect([...diffPositions('abcdef', 'abXdeY')]).toEqual([2, 5])
    expect(diffPositions(A, A).size).toBe(0)
  })
})

describe('accept_payee parameter', () => {
  it('is seller (32 bytes) + version u32 LE + anchor (32 bytes)', () => {
    const hex = acceptPayeeParamHex(S, 3, 'ab'.repeat(32))
    expect(hex).toHaveLength((32 + 4 + 32) * 2)
    expect(hex.slice(64, 72)).toBe('03000000')
    expect(hex.slice(72)).toBe('ab'.repeat(32))
  })
  it('refuses a bad anchor', () => expect(() => acceptPayeeParamHex(S, 1, 'xyz')).toThrow())
})

describe('flag', () => {
  it('is off by default, on with ?dash=1 and remembered, off again with ?dash=0', () => {
    expect(dashEnabled('')).toBe(false)
    expect(dashEnabled('?dash=1')).toBe(true)
    expect(dashEnabled('')).toBe(true)
    expect(dashEnabled('?dash=0')).toBe(false)
    expect(dashEnabled('')).toBe(false)
  })
})

describe('planned routes', () => {
  it('a 404 becomes NotShipped, naming the route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'not_found', message: 'No route' } }, 404)))
    await expect(dashApi.propose(A)).rejects.toBeInstanceOf(NotShipped)
    await expect(dashApi.propose(A)).rejects.toThrow('POST /api/payee/propose')
  })
  it('relay prepare sends the parameter as hex', async () => {
    const f = vi.fn(async () => json({ mode: 'sponsor-first', transaction: {}, sender: A, sponsor: S, fee_paid_by: S, expires_at: '', schema: null }))
    vi.stubGlobal('fetch', f)
    await dashApi.prepare(A, 'accept_payee', 'abcd')
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toEqual({ sender: A, entrypoint: 'accept_payee', parameter: 'abcd' })
  })
})

describe('/p/<account>', () => {
  it('shows the live check_payee verdict, honestly UNVERIFIED without a name proof', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.includes('/payee-proof/')) return json({ account: A, proof: null })
      return json({ verdict: 'UNVERIFIED', payable: false, verified_name: null, identity_kind: 'person', standin: false, reasons: ['Verification not possible.'],
        checks: [{ id: 'account_exists', ok: true, detail: '' }, { id: 'payee_book_bound', ok: false, detail: '' }],
        subject: { contract: '<13172,0>', seller: S, payee: A, invoice_name: '', book: { status: 'NotBound' }, proof_anchor: null }, evidence_hash: 'e', checked_at: '' })
    }))
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[`/p/${A}`]}><Routes><Route path="/p/:account" element={<PayeePage />} /></Routes></MemoryRouter>
      </QueryClientProvider>,
    )
    const user = (await import('@testing-library/user-event')).default.setup()
    await user.type(await screen.findByLabelText('Name on your invoice'), 'Nour Design')
    await user.click(screen.getByRole('button', { name: 'Check' }))
    expect(await screen.findByTestId('verdict')).toHaveAttribute('data-verdict', 'UNVERIFIED')
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Unverified payee')
    expect(screen.getByText('Not possible')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Pay with wallet' })).toBeNull()
  })
})
