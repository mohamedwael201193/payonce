import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { JudgePath, TryCheck, TRY_ACCOUNT, stampText } from './TryCheck'

const ok = (o: object) => new Response(JSON.stringify(o), { status: 200 })
const base = { payable: false, verified_name: 'PayOnce Labs', identity_kind: 'business', standin: true, reasons: [], checks: [], subject: {}, evidence_hash: 'e'.repeat(64), checked_at: '2026-11-28T12:00:00Z' }

beforeEach(() => vi.stubGlobal('fetch', vi.fn()))

describe('stampText', () => {
  it('Match only when payable', () => {
    expect(stampText({ verdict: 'MATCH', payable: true, verified_name: 'A' }).word).toBe('Match')
    expect(stampText({ verdict: 'MATCH', payable: false, verified_name: 'A' }).word).toBe('Not payable yet')
  })
  it('Close match uses the EU wording and the agent asks first', () => {
    const s = stampText({ verdict: 'CLOSE_MATCH', payable: false, verified_name: 'PayOnce Labs' })
    expect(s.word).toBe('Close match')
    expect(s.line).toBe('Did you mean “PayOnce Labs”? The agent asks you first.')
  })
  it('No match pays nothing', () => expect(stampText({ verdict: 'NO_MATCH', payable: false, verified_name: 'A' }).line).toBe('The agent pays nothing.'))
})

describe('TryCheck', () => {
  it('one click on an example runs a real check and shows the stamp', async () => {
    const f = vi.fn(async (_u: string) => ok({ ...base, verdict: 'NO_MATCH' }))
    vi.stubGlobal('fetch', f)
    render(<MemoryRouter><TryCheck /></MemoryRouter>)
    await userEvent.click(screen.getByRole('button', { name: /A different company/ }))
    expect(await screen.findByRole('heading', { name: 'No match' })).toBeInTheDocument()
    expect(screen.getByText('The agent pays nothing.')).toBeInTheDocument()
    expect(String(f.mock.calls[0]![0])).toContain(`/api/p/${TRY_ACCOUNT}/check?name=Northwind%20Office%20Supplies`)
    expect(screen.getByRole('link', { name: /Open this payee/ })).toHaveAttribute('href', expect.stringContaining(`/p/${TRY_ACCOUNT}`))
    expect(screen.getByText(/stand-in/i)).toBeInTheDocument()
  })
  it('shows an honest error and no verdict when the API is unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('down') }))
    render(<MemoryRouter><TryCheck /></MemoryRouter>)
    await userEvent.click(screen.getByRole('button', { name: /The registered name/ }))
    expect(await screen.findByRole('alert')).toHaveTextContent(/could not reach/i)
    expect(screen.queryByRole('heading', { name: /match/i })).toBeNull()
  })
})

describe('JudgePath', () => {
  it('lists the steps with real links', () => {
    render(<MemoryRouter><JudgePath /></MemoryRouter>)
    expect(screen.getByRole('link', { name: /Watch the live run/ })).toHaveAttribute('href', '/demo')
    expect(screen.getByRole('link', { name: /Re-run the proof/ })).toHaveAttribute('href', '/app/proof/judges')
    expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(4)
  })
})
