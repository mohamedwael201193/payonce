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
// Handlers are CACHE-ONLY (2026-11-27): they never scan. refreshScan() (the
// background loop's unit of work) promotes a COMPLETE scan to the one served
// copy; an incomplete scan is discarded. Stats and invoices read that same
// copy, so they always describe the same scan.
import test from 'node:test'
import assert from 'node:assert/strict'
import { handleStats, handleInvoices, __setChainReaderForTests, refreshScan, __resetScanForTests } from '../src/server.mjs'
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

async function callBoth() {
  return { stats: await callStats(), invoices: await callInvoices() }
}

test('no complete scan yet: both endpoints answer 503 warming_up at once, never a partial 200', async () => {
  __resetScanForTests()
  state.failIds = new Set([3])
  const t0 = Date.now()
  const { stats, invoices } = await callBoth()
  assert.ok(Date.now() - t0 < 500, 'answers immediately, does not scan')
  assert.equal(stats.status, 503)
  assert.equal(stats.json.error.code, 'warming_up')
  assert.equal(stats.json.error.retryable, true)
  assert.equal(invoices.status, 503)
  // An incomplete refresh still serves nothing.
  const partial = await refreshScan()
  assert.equal(partial.complete, false)
  assert.equal((await callStats()).status, 503)
  assert.equal((await callInvoices()).status, 503)
  state.failIds = new Set()
})

test('complete scan: stats and invoices answer from cache, same scan_id, reconciled totals', async () => {
  const scan = await refreshScan()
  assert.equal(scan.complete, true)
  const { stats, invoices } = await callBoth()
  assert.equal(stats.status, 200)
  assert.equal(stats.json.complete, true)
  assert.equal(stats.json.payables_total, 5)
  assert.equal(stats.json.paid_total, 3)
  assert.equal(stats.json.voided_total, 1)
  assert.equal(stats.json.reserved_total, 1)
  assert.equal(invoices.status, 200)
  assert.equal(invoices.json.complete, true)
  assert.deepEqual(invoices.json.items.map((i) => i.payable_id), [1, 2, 3, 10, 11])
  assert.deepEqual(invoices.json.items.map((i) => i.status), ['Paid', 'Paid', 'Unpaid', 'Paid', 'Unpaid'])
  // Same scan: identical ids and timestamps, counts that agree line by line.
  assert.equal(stats.json.scan_id, invoices.json.scan_id)
  assert.equal(stats.json.generated_at, invoices.json.generated_at)
  assert.equal(stats.json.payables_total, invoices.json.items.length)
  assert.equal(stats.json.paid_total, invoices.json.items.filter((i) => i.status === 'Paid').length)
  // Demo vs automated test runs are both reported, never hidden.
  assert.equal(stats.json.by_kind.demo.total + stats.json.by_kind.test_runs.total, stats.json.payables_total)
  assert.deepEqual(invoices.json.items.map((i) => i.kind), ['matrix', 'matrix', 'matrix', 'demo', 'demo'])
})

test('cache-only: a chain change is NOT visible until a refresh promotes a new complete scan', async () => {
  await new Promise((r) => setTimeout(r, 5)) // a new scan gets a new scan_id
  state.views.set(3, view(3, 'Paid'))
  const before = await callBoth()
  assert.equal(before.stats.json.paid_total, 3, 'handlers do not re-read the chain')
  assert.equal(before.invoices.json.items.find((i) => i.payable_id === 3).status, 'Unpaid')
  await refreshScan()
  const after = await callBoth()
  assert.equal(after.stats.json.paid_total, 4)
  assert.equal(after.invoices.json.items.find((i) => i.payable_id === 3).status, 'Paid')
  assert.equal(after.stats.json.scan_id, after.invoices.json.scan_id)
  assert.notEqual(after.stats.json.scan_id, before.stats.json.scan_id)
  state.views.set(3, view(3, 'Unpaid'))
})

test('an incomplete refresh never replaces the served scan: no flip to shrunken numbers', async () => {
  await refreshScan()
  const good = await callBoth()
  state.failIds = new Set([10])
  state.views.delete(11) // a partial scan would also look smaller
  const partial = await refreshScan()
  assert.equal(partial.complete, false)
  const now = await callBoth()
  assert.equal(now.stats.status, 200)
  assert.equal(now.invoices.status, 200)
  assert.equal(now.stats.json.scan_id, good.stats.json.scan_id)
  assert.equal(now.invoices.json.scan_id, good.invoices.json.scan_id)
  assert.equal(now.stats.json.payables_total, good.stats.json.payables_total)
  assert.equal(now.invoices.json.items.length, good.invoices.json.items.length)
  state.failIds = new Set()
  state.views.set(11, view(11, 'Unpaid', 'EUDemo', '10000'))
})

test('polling 10 times between refreshes returns identical numbers (no flip-flop)', async () => {
  await refreshScan()
  const first = await callBoth()
  for (let i = 0; i < 10; i += 1) {
    const { stats, invoices } = await callBoth()
    assert.equal(stats.json.scan_id, first.stats.json.scan_id)
    assert.equal(stats.json.payables_total, first.stats.json.payables_total)
    assert.equal(stats.json.paid_total, first.stats.json.paid_total)
    assert.deepEqual(invoices.json.items, first.invoices.json.items)
  }
})

test('cleanup: the chain stub is removed so no other test file inherits it', () => {
  __setChainReaderForTests(null)
})
