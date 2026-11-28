import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { DemoPage } from './DemoPage'
import { RECORDED_RUN, parseLiveRun, type DemoRun } from './demoData'

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })))
})

const H = 'a'.repeat(64)
const live = (o: Partial<DemoRun> & { generated_at?: string } = {}) => ({
  ...RECORDED_RUN, live: true, generated_at: new Date().toISOString(), label: 'Live', ...o,
})

describe('parseLiveRun', () => {
  it('accepts a fresh complete run', () => expect(parseLiveRun(live())).not.toBeNull())
  it('rejects a run older than an hour', () =>
    expect(parseLiveRun(live({ generated_at: new Date(Date.now() - 2 * 3_600_000).toISOString() }))).toBeNull())
  it('rejects a run that is not marked live or has a bad hash', () => {
    expect(parseLiveRun({ ...live(), live: false })).toBeNull()
    expect(parseLiveRun(live({ paid: { hash: 'xyz' } }))).toBeNull()
    expect(parseLiveRun(live({ again: { code: -5, name: 'WrongStatus', hash: H.slice(1) } }))).toBeNull()
  })
})

describe('/demo', () => {
  it('walks six screens, one button each, and labels the replay', async () => {
    const user = userEvent.setup()
    render(<MemoryRouter><DemoPage /></MemoryRouter>)
    expect(screen.getByTestId('demo-label')).toHaveTextContent('Replay')
    expect(screen.getByTestId('demo-label')).toHaveTextContent('mock identities')
    await user.click(screen.getByRole('button', { name: 'Run it' }))
    expect(await screen.findByRole('heading', { name: 'Match' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pay' }))
    expect(await screen.findByRole('heading', { name: 'Paid once.' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Payment/ })).toHaveAttribute('href', expect.stringContaining(RECORDED_RUN.paid.hash))
    await user.click(screen.getByRole('button', { name: 'Now the impostor' }))
    expect(await screen.findByRole('heading', { name: 'No match' })).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Pay it again?' }))
    expect(await screen.findByRole('heading', { name: 'Paid once means once.' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: /Refusal/ })).toHaveAttribute('href', expect.stringContaining(RECORDED_RUN.again.hash))
    await user.click(screen.getByRole('button', { name: 'What now?' }))
    expect(await screen.findByRole('link', { name: 'Run it with your wallet' })).toHaveAttribute('href', '/app')
  })
})
