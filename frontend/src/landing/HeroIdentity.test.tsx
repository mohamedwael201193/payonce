import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HeroIdentity } from './HeroIdentity'
import { headline } from './data'
import type { Stats } from '../lib/types'

afterEach(() => vi.unstubAllGlobals())

const good = (n = 15) => ({ badge_valid: true, on_chain: { status: 'Active' }, checks: Object.fromEntries(Array.from({ length: n }, (_, i) => [`c${i}`, true])), issues: [] })

describe('hero identity', () => {
  it('shows the three agents with no verdict before any check', () => {
    render(<MemoryRouter><HeroIdentity /></MemoryRouter>)
    const items = screen.getAllByTestId('hero-agent')
    expect(items).toHaveLength(4)
    expect(items.map((i) => /#(\d+)/.exec(i.textContent ?? '')?.[1])).toEqual(['1476', '1506', '1488', '1554'])
    expect(document.body.textContent).not.toMatch(/Verified by Concordium/)
  })

  it('says Verified by Concordium only from a live badge_valid true, and calls the official endpoint', async () => {
    const f = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => good() })
    vi.stubGlobal('fetch', f)
    render(<MemoryRouter><HeroIdentity /></MemoryRouter>)
    const first = screen.getAllByTestId('hero-agent')[0]
    fireEvent.click(within(first).getByRole('button', { name: 'Check badge' }))
    await waitFor(() => expect(first.textContent).toMatch(/Verified by Concordium: badge_valid true, 15\/15/))
    expect(f.mock.calls[0][0]).toBe('https://agent-registry-mcp.concordium.com/v1/badge-check/JyP9XawpXHMjTN5ocrA5a?network=testnet')
  })

  it('never says verified when the registry says badge_valid false or is unreachable', async () => {
    const f = vi.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ badge_valid: false, checks: { a: true, b: false }, issues: [{ message: 'card URL did not return HTTP 200' }] }) })
      .mockRejectedValueOnce(new Error('offline'))
    vi.stubGlobal('fetch', f)
    render(<MemoryRouter><HeroIdentity /></MemoryRouter>)
    const items = screen.getAllByTestId('hero-agent')
    fireEvent.click(within(items[2]).getByRole('button', { name: 'Check badge' }))
    await waitFor(() => expect(items[2].textContent).toMatch(/Not verified: badge_valid false, 1\/2/))
    fireEvent.click(within(items[0]).getByRole('button', { name: 'Check badge' }))
    await waitFor(() => expect(items[0].textContent).toMatch(/could not be reached/))
    expect(document.body.textContent).not.toMatch(/Verified by Concordium/)
  })
})

describe('headline counts', () => {
  const base = { payables_total: 435, paid_total: 199, refused_on_chain_since_deploy: 30 } as Stats
  it('leads with demo invoices and names the test runs', () => {
    const h = headline({ ...base, by_kind: { demo: { total: 12, paid: 7 }, matrix: { total: 4, paid: 4 }, lab: { total: 419, paid: 188 }, test_runs: { total: 423, paid: 192 } } })
    expect(h).toMatchObject({ total: 12, paid: 7, pct: 58, testTotal: 423, testPaid: 192, allTotal: 435, split: true })
  })
  it('falls back to the plain totals without a kind split', () => {
    expect(headline(base)).toMatchObject({ total: 435, paid: 199, split: false })
  })
})
