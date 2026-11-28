import { describe, expect, it, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { WalletProvider } from '../wallet/WalletContext'
import census from './fixtures/census.json'
import { CensusPage, headline } from './CensusPage'
import { HumanGate, AgeGate } from './gates'
import { Services } from './Services'
import { lookalike, sharedEnds, validChecksum } from './lookalike'
import { badgeColors, badgeKind, badgeMarkdown, badgeSvg } from './badge'

const A = '4gedLUopV5kUSqNBhsdeBDz3ffztkayNFe4hUpHCngEQmGjtin'
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } })
const wrap = (ui: React.ReactNode) => render(
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}><MemoryRouter><WalletProvider>{ui}</WalletProvider></MemoryRouter></QueryClientProvider>,
)
beforeEach(() => localStorage.clear())
afterEach(() => vi.unstubAllGlobals())

describe('census page', () => {
  it('states an upper bound, with the exact numbers, and never says verified or safe', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(census)))
    wrap(<CensusPage />)
    await waitFor(() => expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('At most 5 of 5,501 registered agents on mainnet meet the preconditions of a Verification-of-Payee check today.'))
    expect(screen.getByText('SNAPSHOT')).toBeTruthy()
    expect(screen.getByText(/Accounts, not people or companies/)).toBeTruthy()
    expect(screen.getByText(/Read from CCDExplorer/)).toBeTruthy()
    const text = document.body.textContent ?? ''
    for (const bad of [/\bsafe\b/i, /legitimate/i, /fraudulent/i, /dishonest/i, /\bunsafe\b/i, /nobody can be trusted/i]) expect(text).not.toMatch(bad)
    expect(text).not.toMatch(/are verified/i)
    expect(text).toMatch(/no name proof exists yet/i)
  })
  it('switches to testnet and shows the live check result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(census)))
    wrap(<CensusPage />)
    await screen.findByText('SNAPSHOT')
    fireEvent.click(screen.getByRole('radio', { name: 'Testnet' }))
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('At most 3 of 1,553 registered agents on testnet')
    expect(screen.getByText(/We ran the check on them/)).toBeTruthy()
    fireEvent.click(screen.getByRole('radio', { name: 'Mainnet' }))
    expect(screen.getAllByText(/identity-only/).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('radio', { name: 'Testnet' }))
    expect(screen.getByText(/testnet issuer approves automatically/)).toBeTruthy()
  })
  it('headline helper', () => expect(headline('testnet', census.networks.testnet as never)).toMatch(/^At most 3 of 1,553/))
  it('shows an error with retry when the API is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'x', message: 'down' } }, 500)))
    wrap(<CensusPage />)
    expect(await screen.findByRole('alert')).toBeTruthy()
  })
})

describe('HumanGate', () => {
  it('needs the consent box before approving, and can decline', () => {
    const ok = vi.fn(); const no = vi.fn()
    render(<HumanGate outcome="close_match" why="Names differ by one letter" facts={[{ label: 'Name on invoice', value: 'Acme Ltd' }]} confirmLabel="Pay 1 CCD anyway" onApprove={ok} onDecline={no} />)
    const pay = screen.getByRole('button', { name: 'Pay 1 CCD anyway' }) as HTMLButtonElement
    expect(pay.disabled).toBe(true)
    fireEvent.click(screen.getByRole('checkbox'))
    expect(pay.disabled).toBe(false)
    fireEvent.click(pay)
    expect(ok).toHaveBeenCalledOnce()
    fireEvent.click(screen.getByRole('button', { name: /Don.t pay/ }))
    expect(no).toHaveBeenCalledOnce()
  })
})

describe('AgeGate', () => {
  it('asks to connect a wallet rather than claiming success, and never fakes a result', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ error: { code: 'not_found', message: 'No route' } }, 404)))
    const onVerified = vi.fn()
    wrap(<AgeGate sellerId="adult" onVerified={onVerified} />)
    const btn = await screen.findByRole('button', { name: /18\+/ })
    // no wallet session in the test: the gate asks to connect rather than claiming success
    fireEvent.click(btn)
    await waitFor(() => expect(onVerified).not.toHaveBeenCalled())
  })
})

describe('Services', () => {
  const seller = { id: 'adult', name: 'Age-gated demo', team: 'PayOnce', url: 'https://x/y', method: 'GET', price_ccd: 1, note: 'n', needs_age: true }
  it('lists sellers and shows the age gate when a seller needs 18+', async () => {
    vi.stubGlobal('fetch', vi.fn(async (u: string) => (u.includes('/api/x402/sellers') ? json({ sellers: [seller], policy: { network: 'testnet', max_ccd_per_purchase: '2.5', asset: 'CCD', payer: 'PayOnce reference buyer pays only on Match', outcomes: [] } }) : json({}, 404))))
    wrap(<Services />)
    expect(await screen.findByText('Age-gated demo')).toBeTruthy()
    expect(screen.getByText(/PayOnce reference buyer/)).toBeTruthy()
  })
})

describe('lookalike', () => {
  it('keeps the first 6 and last 2 characters and a valid checksum', () => {
    const f = lookalike(A)!
    expect(validChecksum(f)).toBe(true)
    expect(f).not.toBe(A)
    const { head, tail } = sharedEnds(A, f)
    expect(head).toBeGreaterThanOrEqual(6)
    expect(tail).toBeGreaterThanOrEqual(2)
  })
  it('returns null for a bad address', () => expect(lookalike('nope')).toBeNull())
})

describe('badge svg', () => {
  it('only Match uses the green pass colour', () => {
    expect(badgeKind({ verdict: 'MATCH', payable: true })).toBe('MATCH')
    expect(badgeKind({ verdict: 'MATCH', payable: false })).toBe('NOT_BOUND')
    expect(badgeColors('MATCH').bg).toBe('#e8f6ee')
    expect(badgeColors('NOT_BOUND').bg).not.toBe(badgeColors('MATCH').bg)
    for (const k of ['CLOSE_MATCH', 'NO_MATCH', 'UNVERIFIED', 'PROVEN', 'UNPROVEN'] as const) {
      expect(badgeColors(k).bg).not.toBe('#e8f6ee')
      expect(badgeSvg(k)).toContain(k === 'CLOSE_MATCH' ? 'Close match' : k === 'NO_MATCH' ? 'No match' : k === 'UNVERIFIED' ? 'Not possible' : k === 'PROVEN' ? 'Name proven' : 'Unverified payee')
    }
  })
  it('a name-proven badge is never labelled Match, and the snippet points at /p/', () => {
    expect(badgeKind({ verified: true, named: true })).toBe('PROVEN')
    expect(badgeSvg('PROVEN')).not.toContain('>Match<')
    expect(badgeMarkdown(A)).toContain(`/p/${A}`)
    expect(badgeMarkdown(A)).toContain('/api/badge/')
  })
  it('the accessible name is a statement, not a question', () => {
    expect(badgeSvg('MATCH')).toContain('The receiving account belongs to the name on the invoice.')
    expect(badgeSvg('MATCH')).not.toMatch(/invoice\?/)
    expect(badgeSvg('CLOSE_MATCH')).toContain('close to the verified name, not the same.')
  })
})
