// Handler-level tests for GET /api/payables/:id + the payableFacts
// mapping (fix-back-9 MF-4). The {kind:'voided'} mapping added in
// fix-back-8 had NO offline test: handleGetPayable read the live chain
// directly and payableFacts was not exported. Now the handler's read
// goes through the S5 seam (__setChainReaderForTests, same pattern as
// the stats/invoices handlers) and both handleGetPayable and
// payableFacts are exported, so the mapping is testable offline.
// Run: node --test test/handlers-payable.test.mjs
// (PAYONCE_BACKEND_DIR must point at a backend checkout, as for the
// handlers-stats test — the store reads are file-based, no live chain.)
//
// The mapping is the frontend's verification vocabulary: a dropped id
// that reads back 'reserved'/'voided' is genuinely excluded, one that
// reads back 'unpaid'/'paid' is still listable. A Voided row mapping
// to {kind:'unpaid'} (the pre-fix-back-8 shape) would make the
// frontend's label fallback the ONLY thing standing between a legit
// void shrink and a freeze — so all four kinds are pinned here.
//
// NOTE: the handleGetPayable success path (200) is NOT exercised here:
// after the stubbed read it calls chainNow, which needs the live
// chain. The mapping itself is covered by the direct payableFacts
// tests below, and the handler is covered at its two offline branches
// (404 absent payable, 503 unreadable payable).
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleGetPayable, payableFacts, __setChainReaderForTests } from '../src/server.mjs'

const CHAIN_TIME_MS = Date.parse('2026-11-25T10:00:00.000Z')
const DUE = '2026-12-01T08:03:26.555Z'

function view(id, status, record = undefined) {
  return {
    id,
    status,
    asset: 'CCD',
    amount: '500000',
    due: DUE,
    dueMs: Date.parse(DUE),
    payee: '4MvdMEGC',
    seller: '4MvdMEGC',
    agentToken: '1476',
    docHash: '00',
    ...(record ? { record } : {}),
  }
}

// Minimal res: the handlers only use writeHead + end (sendJson/apiError).
function fakeRes() {
  const captured = {}
  return {
    captured,
    writeHead(status) {
      captured.status = status
    },
    end(body) {
      captured.body = body
      try {
        captured.json = JSON.parse(body)
      } catch {
        captured.json = null
      }
    },
  }
}

async function callGetPayable(id) {
  const res = fakeRes()
  await handleGetPayable({}, res, id)
  return res.captured
}

test('Voided maps to {kind:voided} with the Voided label (fix-back-9 MF-4)', async () => {
  const facts = await payableFacts(null, view(99, 'Voided'), CHAIN_TIME_MS)
  assert.equal(facts.status.kind, 'voided')
  assert.ok(facts.label.startsWith('Voided on chain'))
  assert.equal(facts.payable_id, 99)
  assert.equal(facts.is_past_due, false)
})

test('Unpaid maps to {kind:unpaid} with the plain label', async () => {
  const facts = await payableFacts(null, view(99, 'Unpaid'), CHAIN_TIME_MS)
  assert.equal(facts.status.kind, 'unpaid')
  assert.ok(!facts.label.startsWith('Voided on chain'))
})

test('Reserved maps to {kind:reserved} with payer + expires', async () => {
  const facts = await payableFacts(
    null,
    view(99, 'Reserved', { payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' }),
    CHAIN_TIME_MS,
  )
  assert.equal(facts.status.kind, 'reserved')
  assert.equal(facts.status.payer, '4MvdMEGC')
  assert.equal(facts.status.expires, '2026-11-25T12:00:00Z')
})

test('Paid maps to {kind:paid} with payer + paid_at', async () => {
  const facts = await payableFacts(
    null,
    view(99, 'Paid', { payer: '4MvdMEGC', paidAt: '2026-11-25T10:00:00Z' }),
    CHAIN_TIME_MS,
  )
  assert.equal(facts.status.kind, 'paid')
  assert.equal(facts.status.payer, '4MvdMEGC')
  assert.equal(facts.status.paid_at, '2026-11-25T10:00:00Z')
})

test('handleGetPayable: stubbed reader returning null → 404 not_found (offline branch)', async () => {
  __setChainReaderForTests(async () => null)
  const res = await callGetPayable(99)
  assert.equal(res.status, 404)
  assert.equal(res.json.error.code, 'not_found')
})

test('handleGetPayable: stubbed reader throwing on all retries → 503 chain_unreachable (fail closed)', async () => {
  __setChainReaderForTests(async () => {
    throw new Error('node busy reading payable 99')
  })
  const res = await callGetPayable(99)
  assert.equal(res.status, 503)
  assert.equal(res.json.error.code, 'chain_unreachable')
  assert.equal(res.json.error.retryable, true)
})

test('cleanup: the chain stub is removed so no other test file inherits it', () => {
  __setChainReaderForTests(null)
})
