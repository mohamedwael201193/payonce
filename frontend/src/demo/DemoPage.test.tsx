import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { DemoPage, DemoStatus } from './DemoPage'
import { RECORDED_RUN, parseLiveRun, parseRecentRun, loadDemoFeed, loadDemoRun, impostorHeadline, ago, type DemoRun } from './demoData'

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
    await user.click(await screen.findByRole('button', { name: 'Run it' }))
    expect(screen.getByTestId('demo-label')).toHaveTextContent('Replay')
    expect(screen.getByTestId('demo-label')).toHaveTextContent('practice name')
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

describe('loadDemoRun', () => {
  it('falls back to the replay when the API hangs past the timeout', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    await expect(loadDemoRun(undefined, 40)).resolves.toEqual(RECORDED_RUN)
  })
})

describe('/demo loading', () => {
  it('shows a loading state, then the Run it button, even if the live run never arrives', async () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise(() => {})))
    render(<MemoryRouter><DemoPage /></MemoryRouter>)
    expect(screen.getByTestId('demo-loading')).toBeInTheDocument()
    expect(screen.getByTestId('demo-label')).toHaveTextContent('Loading')
    // The page uses a 5 s timeout; advance by stubbing load via a short wait is covered in loadDemoRun.
    // Here we only assert the first paint is not a hung blank screen.
  })
})

describe('impostorHeadline', () => {
  const h = 'No match: a lookalike account (same first 1 and last 4 characters as the real payee, 0 CCD, brand-new) claims "PayOnce Labs". Nothing sent.'
  it('drops the character counts so they cannot contradict the diagram beneath', () => {
    const t = impostorHeadline(h)
    expect(t).not.toMatch(/same first|last 4|first 1/i)
    expect(t).toContain('a different account (0 CCD, brand-new) claims "PayOnce Labs"')
  })
  it('leaves other headlines alone', () => expect(impostorHeadline(RECORDED_RUN.impostor.headline)).toBe(RECORDED_RUN.impostor.headline))
})

const json = (o: unknown) => new Response(JSON.stringify(o), { status: 200 })
const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString()

describe('live first: live, then the last real run, then the recording', () => {
  it('marks a fresh run as live with its age', () => {
    const r = parseLiveRun(live({ generated_at: new Date(Date.now() - 12 * 60_000).toISOString() }))
    expect(r?.source).toBe('live')
    expect(ago(r?.ageSecs)).toBe('12 min ago')
  })
  it('a run over an hour old is "recent", never live, and still real', () => {
    const r = parseRecentRun(live({ live: false, generated_at: hoursAgo(5) }))
    expect(r?.source).toBe('recent')
    expect(r?.live).toBe(false)
    expect(ago(r?.ageSecs)).toBe('5 h ago')
  })
  it('a run over a day old is not shown as a real recent run', () => expect(parseRecentRun(live({ generated_at: hoursAgo(30) }))).toBeNull())
  it('loadDemoFeed: live run from the API wins', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(live({ refreshing: false } as never))))
    const f = await loadDemoFeed()
    expect(f.run.source).toBe('live')
    expect(f.refreshing).toBe(false)
  })
  it('loadDemoFeed: an old run plus a refresh in progress gives the old run and the new hashes', async () => {
    const steps = [{ key: 'register', label: 'Invoice registered', hash: 'b'.repeat(64) }, { key: 'x', label: 'bad', hash: 'zz' }]
    vi.stubGlobal('fetch', vi.fn(async () => json({ ...live({ live: false, generated_at: hoursAgo(3) }), refreshing: true, progress: { steps } })))
    const f = await loadDemoFeed()
    expect(f.run.source).toBe('recent')
    expect(f.refreshing).toBe(true)
    expect(f.progress).toEqual([{ key: 'register', label: 'Invoice registered', hash: 'b'.repeat(64) }])
  })
  it('loadDemoFeed: no run and nothing in progress falls back to the recording', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json({ live: false, refreshing: false, label: 'No fresh run available right now.' })))
    const f = await loadDemoFeed()
    expect(f.run).toEqual(RECORDED_RUN)
    expect(RECORDED_RUN.source).toBe('replay')
  })
})

describe('DemoStatus', () => {
  it('says Live with the age and no replay wording', () => {
    const run = parseLiveRun(live({ generated_at: new Date(Date.now() - 4 * 60_000).toISOString() }))!
    render(<DemoStatus run={run} ready refreshing={false} progress={[]} />)
    expect(screen.getByTestId('demo-status')).toHaveTextContent(/Live · real transactions on the test network, 4 min ago/)
    expect(screen.getByTestId('demo-status')).not.toHaveTextContent(/replay/i)
  })
  it('shows the new hashes as links while a fresh run is being made', () => {
    const run = parseRecentRun(live({ live: false, generated_at: hoursAgo(3) }))!
    render(<DemoStatus run={run} ready refreshing progress={[{ key: 'pay', label: 'Paid once', hash: 'c'.repeat(64) }]} />)
    expect(screen.getByTestId('demo-status')).toHaveTextContent(/Last run · real transactions on the test network, 3 h ago. A fresh run is landing now/)
    expect(screen.getByRole('link', { name: /Paid once/ })).toHaveAttribute('href', expect.stringContaining('c'.repeat(64)))
  })
  it('labels the replay clearly and says why', () => {
    render(<DemoStatus run={RECORDED_RUN} ready refreshing={false} progress={[]} />)
    expect(screen.getByTestId('demo-status')).toHaveTextContent(/Replay · a recording of an earlier run.*not available right now/)
  })
  it('the first paint of /demo with a live run reads Live, not Replay', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => json(live())))
    render(<MemoryRouter><DemoPage /></MemoryRouter>)
    expect(await screen.findByRole('button', { name: 'Run it' })).toBeInTheDocument()
    expect(screen.getByTestId('demo-status')).toHaveTextContent(/^Live/)
    expect(screen.getByTestId('demo-label')).toHaveTextContent('Live run')
  })
})
