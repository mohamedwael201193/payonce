// API client — P3 §16. fetch is mocked; no network, no stub needed.
// Verifies: happy-path parsing, error-body mapping, malformed-payload
// rejection, and the network-failure → chain_unreachable mapping.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from './api'
import { ApiError } from './types'

function mockFetchOnce(response: { ok: boolean; status: number; json: unknown }) {
  const fn = vi.fn().mockResolvedValue({
    ok: response.ok,
    status: response.status,
    json: async () => response.json,
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

const statsJson = {
  payables_total: 5,
  paid_total: 3,
  refused_on_chain_since_deploy: 7,
  last_verifier_run_at: '2026-11-24T10:42:07Z',
}

describe('api.getStats', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('parses a valid stats payload', async () => {
    mockFetchOnce({ ok: true, status: 200, json: statsJson })
    await expect(api.getStats()).resolves.toEqual(statsJson)
  })

  it('maps a 404 error body to ApiError with the server code', async () => {
    mockFetchOnce({
      ok: false,
      status: 404,
      json: {
        error: {
          code: 'not_found',
          layer: 'server',
          message: 'No payable with this number is on the test registry.',
          retryable: false,
          reject: null,
          fee_testnet_ccd: null,
          tx_hash: null,
          explorer_url: null,
        },
      },
    })
    const err = await api.getStats().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).status).toBe(404)
    expect((err as ApiError).body.code).toBe('not_found')
  })

  it('rejects a malformed 200 payload as an internal error (nothing sent)', async () => {
    mockFetchOnce({ ok: true, status: 200, json: { paid_total: 'three' } })
    const err = await api.getStats().catch((e) => e)
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).body.code).toBe('internal')
  })

  it('maps a network failure to chain_unreachable after retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')))
    // Attach the handler BEFORE advancing timers, or the rejection is unhandled.
    const caught = api.getStats().catch((e) => e)
    // 3 retries at 1s / 2s / 4s — advance through all of them.
    await vi.runAllTimersAsync()
    const err = await caught
    expect(err).toBeInstanceOf(ApiError)
    expect((err as ApiError).body.code).toBe('chain_unreachable')
    expect((err as ApiError).status).toBe(0)
  })
})
