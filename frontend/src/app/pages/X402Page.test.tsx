import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { X402Page } from './X402Page'
import evidence from '../../../public/evidence/x402-hosted-settle-2026-11-26.json'

afterEach(() => vi.unstubAllGlobals())

describe('x402 receipt page', () => {
  it('shows the recorded settle with its tx links, the verifier result and the honest not-found note', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => evidence }))
    render(
      <QueryClientProvider client={new QueryClient()}>
        <MemoryRouter><X402Page /></MemoryRouter>
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText(/Verifier result: ALL CHECKS PASS \(14\/14\)/)).toBeInTheDocument())
    expect(screen.getByText(/transaction not found/)).toBeInTheDocument()
    expect(screen.getByText(/while the transfer was already finalized on chain/)).toBeInTheDocument()
    expect(screen.getByTestId('x402-binding').querySelectorAll('li')).toHaveLength(7)
    const hrefs = Array.from(document.querySelectorAll('a')).map((a) => a.getAttribute('href') ?? '')
    expect(hrefs.some((h) => h.endsWith('/3bf4d852ed62247a3e5c0473749198b833b190a16b84be5a20d19c9c8ef3de2b'))).toBe(true)
    expect(document.body.textContent).toMatch(/node src\/verify-payable-v2\.mjs 97592 3bf4d852/)
  })
})
