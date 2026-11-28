import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
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
  it('a 404 on a route that is not shipped becomes NotShipped, naming the route', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'not_found', message: 'No route' } }, 404)))
    await expect(dashApi.parseInvoice('x')).rejects.toBeInstanceOf(NotShipped)
    await expect(dashApi.parseInvoice('x')).rejects.toThrow('POST /api/invoices/parse')
  })
  it('the age-proof routes are live: request and verify post to the real API', async () => {
    const f = vi.fn(async () => json({ request_id: 'r1', v1: {}, v0: { challenge: 'c', statements: [] }, verified: true, vaa_tx: null }))
    vi.stubGlobal('fetch', f)
    await dashApi.ageRequest(A, 'adult')
    await dashApi.ageVerify('r1', 'v1', '{}')
    expect((f.mock.calls[0] as unknown as [string])[0]).toContain('/api/wallet/age-proof/request')
    expect(JSON.parse((f.mock.calls[1] as unknown as [string, RequestInit])[1].body as string)).toMatchObject({ request_id: 'r1', version: 'v1' })
  })
  it('relay prepare sends the parameter as hex', async () => {
    const f = vi.fn(async () => json({ mode: 'sponsor-first', transaction: {}, sender: A, sponsor: S, fee_paid_by: S, expires_at: '', schema: null }))
    vi.stubGlobal('fetch', f)
    await dashApi.prepare(A, 'accept_payee', 'abcd')
    const body = JSON.parse((f.mock.calls[0] as unknown as [string, RequestInit])[1].body as string)
    expect(body).toEqual({ sender: A, entrypoint: 'accept_payee', parameter: 'abcd', book: 'demo' })
  })
})

describe('/p/<account>', () => {
  it('shows the live check_payee verdict, honestly UNVERIFIED without a name proof', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (/\/api\/p\/[^/]+$/.test(u)) return json({ account: A, exists: true, verified: false, name: null, kind: null, proof: null, bound: null, label: 'Unverified payee', testnet_note: '', links: {} })
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

  it('does not show a green Match stamp when the payee book is NotBound', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.includes('/api/payee/')) return json({ account: A, seller: S, status: 'NotBound', version: 0, hold_secs: 90, hold_ends_at: null, link: '' })
      if (/\/api\/p\/[^/]+$/.test(u)) return json({ account: A, exists: true, verified: true, name: 'Elin Berglund', kind: 'person', proof: { version: 'v1' }, bound: { status: 'NotBound' }, label: 'Elin Berglund', testnet_note: '', links: {} })
      return json({
        verdict: 'MATCH', payable: false, verified_name: 'Elin Berglund', identity_kind: 'person', standin: true, reasons: ['Match: the payee account belongs to the verified person "Elin Berglund" (DK).'],
        checks: [{ id: 'name_match', ok: true, detail: '' }, { id: 'payee_book_bound', ok: false, detail: '' }, { id: 'cooling_off_over', ok: false, detail: '' }],
        subject: { contract: '<13173,0>', seller: S, payee: A, invoice_name: 'Elin Berglund', book: { status: 'NotBound' }, proof_anchor: null }, evidence_hash: 'e', checked_at: '',
      })
    }))
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[`/p/${A}`]}><Routes><Route path="/p/:account" element={<PayeePage />} /></Routes></MemoryRouter>
      </QueryClientProvider>,
    )
    const verdict = await screen.findByTestId('verdict')
    expect(verdict).toHaveAttribute('data-verdict', 'NOT_BOUND')
    expect(verdict).toHaveTextContent('Not bound')
    expect(verdict).not.toHaveTextContent(/^Match$/)
    expect(screen.queryByText('Match', { selector: '.ds-stamp__word' })).toBeNull()
    expect(screen.getByText('NotBound')).toBeInTheDocument()
    expect(screen.queryByRole('link', { name: 'Pay with wallet' })).toBeNull()
    // the sentence under the stamp must not contradict it
    expect(screen.queryByText(/^Match: the payee account belongs/)).toBeNull()
    expect(screen.getByText(/not a payee yet/i)).toBeInTheDocument()
  })

  it('Close match stamp uses the EU did-you-mean wording', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
      if (u.includes('/api/payee/')) return json({ account: A, seller: S, status: 'Bound', version: 1, hold_secs: 90, hold_ends_at: new Date(0).toISOString(), link: '', tx_hash: 'c3a4ef722f4917b0b32e6b26106aed19ed7dec77c6c554702391bb4c008cf701' })
      if (/\/api\/p\/[^/]+$/.test(u)) return json({ account: A, exists: true, verified: true, name: 'Elin Berglund', kind: 'person', proof: { version: 'v1' }, bound: { status: 'Bound', hold_over: true, tx_hash: 'c3a4ef722f4917b0b32e6b26106aed19ed7dec77c6c554702391bb4c008cf701' }, label: 'Elin Berglund', testnet_note: '', links: {} })
      return json({
        verdict: 'CLOSE_MATCH', payable: false, verified_name: 'Elin Berglund', identity_kind: 'person', standin: false,
        reasons: ['Close match. Did you mean "Elin Berglund"? The name on the invoice is close to the verified name, not the same. Confirm with the payer before paying.'],
        checks: [{ id: 'legal_name', ok: false, detail: 'invoice "Elin Berglun" vs proven "Elin Berglund" (CLOSE_MATCH, similarity 0.96)' }],
        subject: { contract: '<13173,0>', seller: S, payee: A, invoice_name: 'Elin Berglun', book: { status: 'Bound' }, proof_anchor: null }, evidence_hash: 'e', checked_at: '',
      })
    }))
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter initialEntries={[`/p/${A}`]}><Routes><Route path="/p/:account" element={<PayeePage />} /></Routes></MemoryRouter>
      </QueryClientProvider>,
    )
    const verdict = await screen.findByTestId('verdict')
    expect(verdict).toHaveAttribute('data-verdict', 'CLOSE_MATCH')
    expect(verdict).toHaveTextContent('Close match')
    expect(verdict).toHaveTextContent(/Did you mean/)
    expect(verdict).toHaveTextContent('Elin Berglund')
    expect(screen.queryByRole('link', { name: 'Pay with wallet' })).toBeNull()
  })
})

import { BindProgress, FullTx, CCDSCAN_TX, recallBindTx, rememberBindTx, checksOf, AckLeg, PayLegs, CcdRailNote, DashPage } from './DashPage'

const TXH = 'c3a4ef722f4917b0b32e6b26106aed19ed7dec77c6c554702391bb4c008cf701'
const ACC = '4ANkHiBERTZUsU3HHy99hrQQbzrGJLzqBdkoqmW9pXFtb89MEL'
const wrap = (ui: React.ReactElement) => render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter>{ui}</MemoryRouter></QueryClientProvider>)
const route = (status: object, check?: object) => vi.stubGlobal('fetch', vi.fn(async (u: string) => {
  if (u.includes('/status')) return json({ tx_hash: TXH, status: 'finalized', reject: null })
  if (u.includes('/api/payee/')) return json(status)
  if (u.includes('/check')) return json(check)
  return json({}, 404)
}))
const stRec = (o: object) => ({ account: ACC, seller: S, version: 1, hold_secs: 90, hold_ends_at: null, link: '', ...o })

describe('accept_payee progress (QA R3c)', () => {
  it('shows the full tx hash with a CCDScan link and remembers it per account', () => {
    render(<FullTx hash={TXH} label="accept_payee" />)
    expect(screen.getByText(TXH)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /CCDScan/ })).toHaveAttribute('href', CCDSCAN_TX + TXH)
    rememberBindTx(ACC, TXH)
    expect(recallBindTx(ACC)).toBe(TXH)
    expect(recallBindTx(S)).toBeNull()
  })

  it('NotBound after Sent: says it is waiting for the chain, never Match', async () => {
    route(stRec({ status: 'NotBound' }))
    wrap(<BindProgress account={ACC} name="Elin Berglund" txHash={TXH} />)
    expect(await screen.findByText(/waiting for the chain/i)).toBeInTheDocument()
    expect(screen.queryByText('Match', { selector: '.ds-stamp__word' })).toBeNull()
  })

  it('Bound inside the hold: shows the hold countdown, still not Match', async () => {
    route(stRec({ status: 'Bound', hold_ends_at: new Date(Date.now() + 60_000).toISOString() }))
    wrap(<BindProgress account={ACC} name="Elin Berglund" txHash={TXH} />)
    expect(await screen.findByRole('timer')).toBeInTheDocument()
    expect(screen.getByTestId("bound-label")).toHaveTextContent(/Bound by your signature/i)
    expect(screen.queryByText('Match', { selector: '.ds-stamp__word' })).toBeNull()
  })

  it('an already-bound account shows Bound and the accept_payee hash from the API, with no local hash', async () => {
    route(stRec({ status: 'Bound', hold_ends_at: new Date(Date.now() - 1000).toISOString(), tx_hash: TXH }), {
      verdict: 'MATCH', payable: true, verified_name: 'Elin Berglund', identity_kind: 'person', standin: false, reasons: [],
      checks: [{ id: 'payee_book_bound', ok: true, detail: '' }, { id: 'cooling_off_over', ok: true, detail: '' }],
      subject: { contract: '<13173,0>', seller: S, payee: ACC, invoice_name: 'Elin Berglund', book: { status: 'Bound' }, proof_anchor: null }, evidence_hash: 'e', checked_at: '',
    })
    wrap(<BindProgress account={ACC} name="Elin Berglund" txHash={null} />)
    expect(await screen.findByText(TXH)).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /CCDScan/ })).toHaveAttribute('href', CCDSCAN_TX + TXH)
    expect(screen.getByTestId('bound-label')).toHaveTextContent(/Bound/)
  })

  it('shows the Match caption only once after the hold', async () => {
    const why = 'Match: the payee account belongs to the verified person "Elin Berglund".'
    route(stRec({ status: 'Bound', hold_ends_at: new Date(Date.now() - 1000).toISOString(), tx_hash: TXH }), {
      verdict: 'MATCH', payable: true, verified_name: 'Elin Berglund', identity_kind: 'person', standin: false, reasons: [why],
      checks: [{ id: 'payee_book_bound', ok: true, detail: '' }, { id: 'cooling_off_over', ok: true, detail: '' }, { id: 'legal_name', ok: true, detail: '' }, { id: 'book_name_matches_invoice', ok: true, detail: '' }],
      subject: { contract: '<13173,0>', seller: S, payee: ACC, invoice_name: 'Elin Berglund', book: { status: 'Bound' }, proof_anchor: null }, evidence_hash: 'e', checked_at: '',
    })
    wrap(<BindProgress account={ACC} name="Elin Berglund" txHash={TXH} />)
    await screen.findByTestId('verdict')
    expect(screen.getAllByText(/Match: the payee account belongs/)).toHaveLength(1)
  })


  it('Bound and hold over: runs the real check and shows green Match only when payable', async () => {
    route(stRec({ status: 'Bound', hold_ends_at: new Date(Date.now() - 1000).toISOString() }), {
      verdict: 'MATCH', payable: true, verified_name: 'Elin Berglund', identity_kind: 'person', standin: true, reasons: [],
      checks: [{ id: 'payee_book_bound', ok: true, detail: '' }, { id: 'cooling_off_over', ok: true, detail: '' }],
      subject: { contract: '<13173,0>', seller: S, payee: ACC, invoice_name: 'Elin Berglund', book: { status: 'Bound' }, proof_anchor: null }, evidence_hash: 'e', checked_at: '',
    })
    wrap(<BindProgress account={ACC} name="Elin Berglund" txHash={TXH} />)
    const v = await screen.findByTestId('verdict')
    expect(v).toHaveAttribute('data-verdict', 'MATCH')
  })
})


const chk = (id: string, ok: boolean, detail = '') => ({ id, ok, detail })
const baseCheck = {
  payable: false, verified_name: 'Elin Berglund', identity_kind: 'person' as const, standin: false, reasons: [],
  subject: { contract: '<13173,0>', seller: S, payee: A, invoice_name: 'Elin Berglun', book: { status: 'Bound' }, proof_anchor: null },
  evidence_hash: 'e', checked_at: '',
}

describe('checksOf', () => {
  it('dedupes Name matches the invoice and fails it on Close match even if legal_name is ok', () => {
    const rows = checksOf({
      ...baseCheck, verdict: 'CLOSE_MATCH',
      checks: [
        chk('payee_book_bound', true),
        chk('cooling_off_over', true),
        chk('book_name_matches_invoice', false, 'hash vs invoice'),
        chk('legal_name', true, 'invoice "Elin Berglun" vs proven "Elin Berglund" (CLOSE_MATCH, similarity 0.923)'),
        chk('book_name_matches_proof', true),
      ],
    })
    const name = rows.filter((r) => r.text === 'Name matches the invoice')
    expect(name).toHaveLength(1)
    expect(name[0].ok).toBe(false)
  })
  it('a Match keeps a single passing Name matches the invoice row', () => {
    const rows = checksOf({
      ...baseCheck, verdict: 'MATCH', payable: true, subject: { ...baseCheck.subject, invoice_name: 'Elin Berglund' },
      checks: [chk('book_name_matches_invoice', true), chk('legal_name', true), chk('proof_valid', true), chk('proof_valid', true)],
    })
    expect(rows.filter((r) => r.text === 'Name matches the invoice')).toEqual([{ ok: true, text: 'Name matches the invoice' }])
    expect(rows.filter((r) => r.text === 'Name proven by the payee')).toHaveLength(1)
  })
})

describe('pay progress shows every sponsored transaction (R13 #10)', () => {
  it('the acknowledge_payee hash is shown as a transaction link', () => {
    render(<AckLeg hash={TXH} />)
    expect(screen.getByRole('link', { name: /acknowledge_payee/ })).toHaveAttribute('href', expect.stringContaining(TXH))
  })
  it('shows nothing before the acknowledgment is sent', () => {
    const { container } = render(<AckLeg />)
    expect(container).toBeEmptyDOMElement()
  })
  it('the EUDemo legs follow, in order', () => {
    render(<PayLegs legs={{ reserve: 'a'.repeat(64), confirm: 'b'.repeat(64) }} />)
    const links = screen.getAllByRole('link')
    expect(links[0]).toHaveTextContent('reserve_plt')
    expect(links[1]).toHaveTextContent('confirm_plt')
  })
  it('the CCD rail states the fee in CCD and euros, with the source', () => {
    render(<CcdRailNote />)
    expect(screen.getByText(/about 20 CCD \(€0\.05\)/)).toBeInTheDocument()
    expect(screen.getByText(/How is the euro figure computed/)).toBeInTheDocument()
  })
})

describe('dashboard connect step', () => {
  it('points a visitor without a wallet to the no-wallet path', () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({}, 404)))
    wrap(<DashPage />)
    const line = screen.getByTestId('no-wallet')
    expect(within(line).getByRole('link', { name: 'Try a check' })).toHaveAttribute('href', '/#try')
    expect(within(line).getByRole('link', { name: 'watch the live run' })).toHaveAttribute('href', '/demo')
  })
})
