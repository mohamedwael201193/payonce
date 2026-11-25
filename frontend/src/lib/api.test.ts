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

describe('api seller threading (second-seller fix-back §4.3/§4.5)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const S1 = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'
  const S2 = '3ARQvcVD68vDEkHLcNjfec3G7GVtAPMTqZ3uhcy33PLya2uExr'

  it('getDocument appends ?seller= when a seller is given, and omits it otherwise', async () => {
    const fn = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => 'PAYONCE LAB INVOICE' })
    vi.stubGlobal('fetch', fn)
    await expect(api.getDocument(2, S2)).resolves.toBe('PAYONCE LAB INVOICE')
    expect(fn).toHaveBeenCalledWith(expect.stringContaining(`/api/payables/2/document?seller=${encodeURIComponent(S2)}`), expect.anything())
    fn.mockClear()
    await expect(api.getDocument(1)).resolves.toBe('PAYONCE LAB INVOICE')
    expect(fn).toHaveBeenCalledWith(expect.stringContaining('/api/payables/1/document'), expect.anything())
    expect(fn.mock.calls[0][0]).not.toContain('?seller=')
  })

  it('getRecorded appends ?seller= and parses the seller-2 run', async () => {
    const run = {
      payable_id: 2,
      seller: S2,
      date: '2026-11-25',
      steps: [
        { step: 'register', detail: 'Payable 2 registered (seller 2, EUDemo 10)', txHash: '00'.repeat(32), layer: 'chain' },
        { step: 'verify', detail: 'Verifier re-run: 12/12 checks pass (EUDemo branch)', txHash: null, layer: 'app' },
      ],
    }
    mockFetchOnce({ ok: true, status: 200, json: run })
    await expect(api.getRecorded(2, S2)).resolves.toEqual(run)
  })

  it('getReceipt parses the receipt seller', async () => {
    const receipt = {
      payable_id: 1,
      seller: S2,
      amount_display: '0.500000 CCD',
      payee: S2,
      payer_label: 'Demo payer account (lab)',
      txs: [{ label: 'Payment', tx_hash: '51'.repeat(32), explorer_url: 'https://example.invalid/tx' }],
      verifier: { passed: 10, total: 10, checked_at: '2026-11-25T17:11:16.000Z' },
      payment_tx_source: 'server_store',
    }
    mockFetchOnce({ ok: true, status: 200, json: receipt })
    await expect(api.getReceipt(1, S2)).resolves.toEqual(receipt)
  })

  it('getPayable without a seller keeps the old URL (no ?seller=)', async () => {
    const payable = {
      payable_id: 1,
      asset: { kind: 'ccd', token: 'CCD' },
      amount: '10000000',
      amount_display: '10.000000 CCD',
      payee: S1,
      seller: S1,
      due: '2026-12-01T08:03:26.555Z',
      is_past_due: false,
      status: { kind: 'unpaid' },
      agent: { registry: { index: 12802, subindex: 0 }, token: '1476' },
      doc_sha256: '00'.repeat(32),
      label: 'Lab invoice',
    }
    const fn = mockFetchOnce({ ok: true, status: 200, json: payable })
    await expect(api.getPayable(1)).resolves.toEqual(payable)
    expect(fn.mock.calls[0][0]).not.toContain('?seller=')
  })
})

describe('api.getPayable', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  // Fix-back-8 MF-1: the API reports Voided as its own facts kind now
  // (payableFacts returns {kind:'voided'}) — the client's zod schema
  // must parse that body instead of rejecting it as malformed. This runs
  // the REAL parse boundary (stubbed fetch, real schema).
  it('parses a voided facts body (new {kind: voided})', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: {
        payable_id: 4,
        asset: { kind: 'ccd', token: 'CCD' },
        amount: '500000',
        amount_display: '0.500000 CCD',
        payee: '4MvdMEGC',
        seller: '4MvdMEGC',
        due: '2026-12-01T08:03:26.555Z',
        is_past_due: false,
        status: { kind: 'voided' },
        agent: { registry: { index: 13144, subindex: 0 }, token: '1476' },
        doc_sha256: '00',
        label: 'Voided on chain — Lab invoice (testnet, not a real invoice)',
      },
    })
    await expect(api.getPayable(4)).resolves.toMatchObject({
      payable_id: 4,
      status: { kind: 'voided' },
    })
  })

  it('still parses an unpaid facts body', async () => {
    mockFetchOnce({
      ok: true,
      status: 200,
      json: {
        payable_id: 3,
        asset: { kind: 'ccd', token: 'CCD' },
        amount: '500000',
        amount_display: '0.500000 CCD',
        payee: '4MvdMEGC',
        seller: '4MvdMEGC',
        due: '2026-12-01T08:03:26.555Z',
        is_past_due: false,
        status: { kind: 'unpaid' },
        agent: { registry: { index: 13144, subindex: 0 }, token: '1476' },
        doc_sha256: '00',
        label: 'Lab invoice',
      },
    })
    await expect(api.getPayable(3)).resolves.toMatchObject({
      payable_id: 3,
      status: { kind: 'unpaid' },
    })
  })
})
