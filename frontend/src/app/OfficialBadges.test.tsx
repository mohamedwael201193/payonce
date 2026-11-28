import { render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { OfficialBadges } from './OfficialBadges'
import { AGENTS } from './identity'

const valid = {
  badge_valid: true,
  checks: Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`c${i}`, true])),
  on_chain: { status: 'Active', agent_uri: 'https://example.test/card.json' },
  issues: [],
}

describe('OfficialBadges', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(valid), { status: 200, headers: { 'content-type': 'application/json' } })))
  })

  it('shows all four agents and prints 15/15 only from a live valid check', async () => {
    render(<OfficialBadges />)
    const cards = screen.getAllByTestId('official-badge')
    expect(cards).toHaveLength(4)
    expect(cards.map((c) => c.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining('#1476'),
      expect.stringContaining('#1506'),
      expect.stringContaining('#1488'),
      expect.stringContaining('#1554'),
    ]))
    expect(screen.queryByTestId('official-badge-score')).not.toBeInTheDocument()
    await waitFor(() => expect(screen.getAllByTestId('official-badge-score')).toHaveLength(4))
    for (const el of screen.getAllByTestId('official-badge-score')) expect(el).toHaveTextContent('15/15')
    expect(screen.getAllByText(/Verified by Concordium/).length).toBe(4)
    expect((fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(AGENTS.length)
  })

  it('does not print Verified by Concordium when the registry disagrees', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...valid, badge_valid: false, issues: [{ message: 'uri mismatch' }] }), { status: 200 })))
    render(<OfficialBadges />)
    await waitFor(() => expect(screen.getAllByText(/Not verified/).length).toBe(4))
    expect(screen.queryByText(/Verified by Concordium/)).not.toBeInTheDocument()
    expect(screen.queryByTestId('official-badge-score')).not.toBeInTheDocument()
  })
})
