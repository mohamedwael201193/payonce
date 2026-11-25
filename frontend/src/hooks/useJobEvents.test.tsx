// useJobEvents — the snapshot poll after the SSE `done` event.
// Pins the FIX-2 regression: the poll must go through timedFetch (15 s
// AbortSignal.timeout — the old bare fetch() hung forever with no error),
// a failed/timed-out poll must surface as `error` (the page turns it into
// a failed pay state), and a non-OK poll must not be treated as a snapshot.
import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useJobEvents } from './useJobEvents'
import type { JobSnapshot } from '../lib/types'

const SNAPSHOT: JobSnapshot = {
  job_id: 'job-1',
  payable_id: 1006,
  rail: 'ccd',
  state: 'succeeded',
  steps: [],
  outcome: 'paid',
  started_at: '2026-11-24T10:00:00.000Z',
  finished_at: '2026-11-24T10:00:05.000Z',
}

class MockEventSource {
  static instances: MockEventSource[] = []
  onmessage: ((ev: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  closed = false
  constructor(public url: string) {
    MockEventSource.instances.push(this)
  }
  close() {
    this.closed = true
  }
  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) })
  }
}

describe('useJobEvents snapshot poll (FIX-2)', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    vi.stubGlobal('EventSource', MockEventSource)
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('polls the snapshot through a timed fetch after `done` and sets the job', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200, json: async () => SNAPSHOT }) as Response)
    vi.stubGlobal('fetch', fetchSpy)
    const { result } = renderHook(() => useJobEvents('job-1'))
    const es = MockEventSource.instances[0]
    expect(es.url).toContain('/api/jobs/job-1/events')
    await act(async () => {
      es.emit({ type: 'done', outcome: 'paid', receipt_url: '/receipt/1006' })
    })
    await waitFor(() => expect(result.current.job).toEqual(SNAPSHOT))
    expect(result.current.error).toBeNull()
    expect(es.closed).toBe(true)
    // The poll carries an abort signal (timedFetch, 15 s) — a bare fetch()
    // call has no signal at all.
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const calls = fetchSpy.mock.calls as unknown as Array<[unknown, RequestInit | undefined]>
    const init = calls[0][1] as RequestInit
    expect(init.signal).toBeInstanceOf(AbortSignal)
    expect(String(calls[0][0])).toContain('/api/jobs/job-1')
  })

  it('surfaces an error when the poll rejects (hang/timeout), instead of leaving the job running forever', async () => {
    const timeoutError = new DOMException('The operation timed out.', 'TimeoutError')
    vi.stubGlobal('fetch', vi.fn(async () => {
      throw timeoutError
    }))
    const { result } = renderHook(() => useJobEvents('job-1'))
    await act(async () => {
      MockEventSource.instances[0].emit({ type: 'done', outcome: 'paid', receipt_url: '/receipt/1006' })
    })
    await waitFor(() =>
      expect(result.current.error).toBe('The test node stayed busy, so we cannot confirm the status yet.'),
    )
    expect(result.current.job).toBeNull()
  })

  it('surfaces an error when the poll answers non-OK, instead of treating the error body as a snapshot', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ ok: false, status: 500, json: async () => ({ code: 'node_busy' }) }) as Response),
    )
    const { result } = renderHook(() => useJobEvents('job-1'))
    await act(async () => {
      MockEventSource.instances[0].emit({ type: 'done', outcome: 'failed', receipt_url: '' })
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.job).toBeNull()
  })
})

describe('useJobEvents never-done path (FIX-2 fix-back-2)', () => {
  beforeEach(() => {
    MockEventSource.instances = []
    vi.stubGlobal('EventSource', MockEventSource)
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, json: async () => SNAPSHOT }) as Response))
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('fails the pay when the stream stays silent past the watchdog — no `done`, no hang', async () => {
    const { result } = renderHook(() => useJobEvents('job-1', { streamTimeoutMs: 50 }))
    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: 3000 })
    expect(result.current.error).toContain('went quiet')
    expect(result.current.job).toBeNull()
    expect(MockEventSource.instances[0].closed).toBe(true)
  })

  it('fails the pay after consecutive stream errors with no event between them', async () => {
    const { result } = renderHook(() => useJobEvents('job-1', { streamTimeoutMs: 60_000 }))
    const es = MockEventSource.instances[0]
    await act(async () => {
      es.onerror?.()
      es.onerror?.()
      es.onerror?.()
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())
    expect(result.current.error).toContain('went quiet')
    expect(es.closed).toBe(true)
  })

  it('a single stream error stays silent (transient reconnect), and an event resets the failure count', async () => {
    const { result } = renderHook(() => useJobEvents('job-1', { streamTimeoutMs: 60_000 }))
    const es = MockEventSource.instances[0]
    await act(async () => {
      es.onerror?.()
      es.onerror?.()
    })
    expect(result.current.error).toBeNull()
    // An event between failures proves the stream alive: the count restarts.
    await act(async () => {
      es.emit({ type: 'step', step: { step: 'reserve', status: 'running' } })
      es.onerror?.()
      es.onerror?.()
    })
    expect(result.current.error).toBeNull()
    await act(async () => {
      es.onerror?.()
    })
    await waitFor(() => expect(result.current.error).not.toBeNull())
  })

  it('a step event restarts the silence watchdog — a live job is not failed early', async () => {
    const { result } = renderHook(() => useJobEvents('job-1', { streamTimeoutMs: 200 }))
    const es = MockEventSource.instances[0]
    // Emit a step every 100 ms: the stream never goes quiet for 200 ms, so
    // the watchdog must not fire even though `done` never arrives.
    for (let i = 0; i < 4; i++) {
      await new Promise((r) => setTimeout(r, 100))
      await act(async () => {
        es.emit({ type: 'step', step: { step: 'reserve', status: 'running' } })
      })
    }
    expect(result.current.error).toBeNull()
    // Then stop emitting: silence past the watchdog fails the pay.
    await waitFor(() => expect(result.current.error).not.toBeNull(), { timeout: 3000 })
  })
})
