// Handler-level tests for /api/stats + /api/invoices (fix-back-7 S5).
// The stats-reconcile test covers only the pure scanIsComplete function;
// the 503/fallback paths live in the handlers and had no test. These run
// against the real handlers with a STUBBED chain reader (server.mjs
// __setChainReaderForTests) — no network, no live chain, no sends.
// Run: node --test test/handlers-stats.test.mjs
//
// The stubbed registry mirrors the known ids (KNOWN_IDS 1,2,3,4,5,10,11):
//   1 Paid CCD · 2 Paid EUDemo · 3 Unpaid · 4 Voided · 5 Reserved ·
//   10 Paid CCD · 11 Unpaid
// Listable (Unpaid|Paid): 1,2,3,10,11 → totals 5/3, voided 1, reserved 1.
// Tests run in file order (node:test default): the incomplete-first test
// proves the no-prior-scan 503s, the complete test seeds lastCompleteScan,
// the incomplete-again test proves the stats fallback + invoices 503,
// and the changed-state test proves MF-3 (no 20 s stats cache: fresh
// totals are served immediately).
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleStats, handleInvoices, __setChainReaderForTests } from '../src/server.mjs'
import { OWNER_ADDRESS } from '../src/config.mjs'

function view(id, status, asset = 'CCD', amount = '500000') {
  return { id, status, asset, amount, due: '2026-12-01T08:03:26.555Z' }
}

// The stubbed chain state. Tests mutate it between calls; the reader
// throws for ids in `failIds` (a busy node that never answers that row).
const state = {
  views: new Map([
    [1, view(1, 'Paid')],
    [2, view(2, 'Paid', 'EUDemo', '10000')],
    [3, view(3, 'Unpaid')],
    [4, view(4, 'Voided')],
    [5, view(5, 'Reserved')],
    [10, view(10, 'Paid')],
    [11, view(11, 'Unpaid', 'EUDemo', '10000')],
  ]),
  failIds: new Set(),
}
// The reader is keyed by (seller, id): the stubbed registry holds seller 1's
// rows only, so seller 2's known ids (1, 2) read back as absent -- exactly a
// registry where seller 2 has no payables. (A seller-blind stub used to
// answer seller 2's ids with seller 1's rows and double-counted them.)
__setChainReaderForTests(async (id, seller) => {
  if (seller !== OWNER_ADDRESS) return null
  if (state.failIds.has(id)) throw new Error(`node busy reading payable ${id}`)
  return state.views.get(id) ?? null
})

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

async function callStats() {
  const res = fakeRes()
  await handleStats({}, res)
  return res.captured
}

async function callInvoices() {
  const res = fakeRes()
  await handleInvoices({}, res)
  return res.captured
}

test('incomplete scan with no prior complete scan: stats 503 + invoices 503, never a partial 200', async () => {
  state.failIds = new Set([3])
  const stats = await callStats()
  assert.equal(stats.status, 503)
  assert.equal(stats.json.error.code, 'node_busy')
  assert.equal(stats.json.error.retryable, true)
  const invoices = await callInvoices()
  assert.equal(invoices.status, 503)
  assert.equal(invoices.json.error.code, 'node_busy')
  state.failIds = new Set()
})

test('complete scan: stats 200 with reconciled totals, invoices 200 with the listable rows only', async () => {
  const stats = await callStats()
  assert.equal(stats.status, 200)
  assert.equal(stats.json.payables_total, 5)
  assert.equal(stats.json.paid_total, 3)
  assert.equal(stats.json.voided_total, 1)
  assert.equal(stats.json.reserved_total, 1)
  const invoices = await callInvoices()
  assert.equal(invoices.status, 200)
  assert.deepEqual(
    invoices.json.items.map((i) => i.payable_id),
    [1, 2, 3, 10, 11],
  )
  assert.deepEqual(
    invoices.json.items.map((i) => i.status),
    ['Paid', 'Paid', 'Unpaid', 'Paid', 'Unpaid'],
  )
})

test('incomplete scan after a complete one: stats serves the last complete scan, invoices 503', async () => {
  state.failIds = new Set([10])
  const stats = await callStats()
  assert.equal(stats.status, 200)
  assert.equal(stats.json.payables_total, 5)
  assert.equal(stats.json.paid_total, 3)
  const invoices = await callInvoices()
  assert.equal(invoices.status, 503)
  assert.equal(invoices.json.error.code, 'node_busy')
  state.failIds = new Set()
})

test('MF-3: a state change is served immediately — no 20 s stats cache', async () => {
  // Payable 3 pays: the next stats call must report paid 4 at once, not
  // the warm-cached 5/3 body. (Before fix-back-7 the 20 s cache served
  // the stale body while invoices re-scanned fresh, failing all 3
  // frontend attempts inside the cache window.)
  state.views.set(3, view(3, 'Paid'))
  const stats = await callStats()
  assert.equal(stats.status, 200)
  assert.equal(stats.json.payables_total, 5)
  assert.equal(stats.json.paid_total, 4)
  const invoices = await callInvoices()
  assert.equal(invoices.status, 200)
  assert.equal(invoices.json.items.find((i) => i.payable_id === 3).status, 'Paid')
  state.views.set(3, view(3, 'Unpaid'))
})

test('cleanup: the chain stub is removed so no other test file inherits it', () => {
  __setChainReaderForTests(null)
})
