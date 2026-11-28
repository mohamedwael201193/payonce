import { render, screen, within, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BANNED_WORDS } from '../lib/copy'
import LandingPage from './LandingPage'
import { SNAPSHOT, verifierCommand } from './data'
import { sha256Hex } from './sha256'
import { flipChar, hashWithPayee, tamperPayee } from './Tamper'
import { faqItems } from './Closer'
import { proofItems } from './Proof'
import { docFileFor } from './Judges'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')))
  window.matchMedia = ((q: string) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia
  ;(globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
})
afterEach(() => vi.unstubAllGlobals())

const mount = () => render(<MemoryRouter><LandingPage /></MemoryRouter>)

describe('landing', () => {
  it('renders the hero, the sections and the agent inbox panel', () => {
    mount()
    expect(screen.getByRole('heading', { level: 1 })).toHaveAccessibleName('Your AI agent checks who it’s paying.')
    for (const id of ['how', 'tamper', 'proof', 'judges', 'faq']) expect(document.getElementById(id)).not.toBeNull()
    expect(screen.getByTestId('hero-inbox')).toBeInTheDocument()
  })

  it('offline, the inbox falls back to the bundled run, labelled recorded, refusals first', async () => {
    mount()
    const rows = await screen.findAllByTestId('inbox-row')
    expect(rows.length).toBeGreaterThan(2)
    const panel = screen.getByTestId('hero-inbox')
    expect(within(panel).getByText(/^Agent run, \d+ \w+ \d\d:\d\d UTC$/)).toBeInTheDocument()
    expect(within(rows[0]).getByText('No match')).toBeInTheDocument()
    expect(within(rows.at(-1)!).getByText('Match')).toBeInTheDocument()
    expect(within(panel).getByRole('link', { name: 'Open the full run' })).toHaveAttribute('href', '/app/proof/agent')
  })

  it('the hero carries no test-volume stats', () => {
    mount()
    expect(screen.queryByText(/automated test runs/)).toBeNull()
  })

  it('points CTAs at the right routes', () => {
    mount()
    const hrefs = (name: RegExp) => screen.getAllByRole('link', { name }).map((a) => a.getAttribute('href'))
    expect(new Set(hrefs(/^Run it on a real invoice/))).toEqual(new Set(['/app']))
    expect(hrefs(/^Watch the agent check$/)).toContain('/app/proof/agent')
    expect(hrefs(/^See how it works$/)).toEqual(['#how'])
    expect(hrefs(/judges/i).every((h) => h === '/app/proof/judges')).toBe(true)
  })

  it('links every proof hash to the singular explorer path', () => {
    const { a, b } = proofItems(SNAPSHOT)
    expect(a.length + b.length).toBeGreaterThan(10)
    mount()
    const links = Array.from(document.querySelectorAll<HTMLAnchorElement>('.po-hashchip'))
    expect(links.length).toBeGreaterThan(10)
    for (const l of links) expect(l.href).toMatch(/^https:\/\/ccdexplorer\.io\/testnet\/transaction\/[0-9a-f]{64}$/)
  })

  it('uses no banned claim and no emoji in visible text', () => {
    const { container } = mount()
    const text = (container.textContent ?? '') + faqItems(SNAPSHOT).map((f) => f.q + f.a).join(' ')
    for (const { word } of BANNED_WORDS) expect(text.toLowerCase()).not.toContain(word.toLowerCase())
    for (const w of ['unleash', 'seamless', 'effortless', 'revolutionize', 'supercharge', 'cutting-edge', 'trusted by'])
      expect(text.toLowerCase()).not.toContain(w)
    expect(text).not.toMatch(/\p{Extended_Pictographic}/u)
  })
})

describe('tamper test', () => {
  it('sha256 matches the known vector and the real invoice hash', () => {
    expect(sha256Hex('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const f = SNAPSHOT.facts!
    expect(sha256Hex(f.document!)).toBe(f.doc_sha256)
    expect(hashWithPayee(f, f.payee)).toBe(f.doc_sha256)
  })
  it('one changed digit changes the hash', () => {
    const f = SNAPSHOT.facts!
    const t = tamperPayee(f.payee, 3)
    expect(t).not.toBe(f.payee)
    expect(t[3]).toBe(flipChar(f.payee[3]))
    expect(hashWithPayee(f, t)).not.toBe(f.doc_sha256)
  })
  it('typing a different payee flips the verdict to refused', () => {
    mount()
    expect(screen.getByText(/Matches the hash on chain/)).toBeInTheDocument()
    fireEvent.change(screen.getByLabelText('Payee account in your copy'), { target: { value: tamperPayee(SNAPSHOT.facts!.payee, 5) } })
    expect(screen.getByText(/Refused\. This is not the document/)).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }))
    expect(screen.getByText(/Matches the hash on chain/)).toBeInTheDocument()
  })
})

describe('verifier command', () => {
  it('has one generator', () => {
    expect(verifierCommand(10, 'abc', docFileFor(10, 'ccd'))).toBe(
      'cd api && node src/verify-payable-v2.mjs 10 abc --doc ../backend/test/invoices/invoice-010-v2-ccd.txt',
    )
  })
})
