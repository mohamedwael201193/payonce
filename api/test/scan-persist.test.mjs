// Persisted last-complete scan: boot warm-up answers from the store with no
// chain read, only COMPLETE scans are persisted, and the cache-only handlers
// answer in well under 500 ms even while a slow scan is running.
// Runs against the JSON store in a temp dir (PAYONCE_DATA_DIR) so the repo's
// api/data is untouched. Run: node --test test/scan-persist.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'payonce-scan-'))
process.env.PAYONCE_DATA_DIR = dir
process.env.PAYONCE_STORE = 'json'
const { handleStats, handleInvoices, __setChainReaderForTests, __setScanPersistenceForTests, refreshScan, __resetScanForTests, warmScanFromStore } =
  await import('../src/server.mjs')
const { OWNER_ADDRESS } = await import('../src/config.mjs')

const view = (id, status) => ({ id, status, asset: 'CCD', amount: '500000', due: '2026-12-01T08:03:26.555Z', seller: OWNER_ADDRESS })
const chain = new Map([[1, view(1, 'Paid')], [3, view(3, 'Unpaid')], [10, view(10, 'Paid')]])
let fail = new Set()
__setChainReaderForTests(async (id, seller) => {
  if (seller !== OWNER_ADDRESS) return null
  if (fail.has(id)) throw new Error('node busy')
  return chain.get(id) ?? null
})
__setScanPersistenceForTests(true)

function fakeRes() {
  const c = {}
  return { captured: c, setHeader() {}, writeHead(s) { c.status = s }, end(b) { c.json = JSON.parse(b) } }
}
const call = async (h) => { const r = fakeRes(); await h({}, r); return r.captured }

test('a partial scan is never persisted', async () => {
  __resetScanForTests()
  fail = new Set([3])
  const s = await refreshScan()
  assert.equal(s.complete, false)
  assert.equal(existsSync(join(dir, 'scan.json')), false)
  fail = new Set()
})

test('a complete scan is persisted, and a fresh process state warms from it with zero chain reads', async () => {
  const s = await refreshScan()
  assert.equal(s.complete, true)
  assert.ok(existsSync(join(dir, 'scan.json')))
  const saved = JSON.parse(readFileSync(join(dir, 'scan.json'), 'utf8'))
  assert.equal(saved.rows.length, 3)
  const live = await call(handleStats)

  // "Restart": drop the in-memory copy, make the chain unreadable, warm from the store.
  __resetScanForTests()
  assert.equal((await call(handleStats)).status, 503, 'nothing served before warm-up')
  __setChainReaderForTests(async () => { throw new Error('chain must not be read at boot') })
  const warmed = await warmScanFromStore()
  assert.equal(warmed.rows.length, 3)
  const stats = await call(handleStats)
  const invoices = await call(handleInvoices)
  assert.equal(stats.status, 200)
  assert.equal(stats.json.payables_total, 3)
  assert.equal(stats.json.scan_id, live.json.scan_id, 'the persisted scan keeps its identity')
  assert.equal(stats.json.scan_id, invoices.json.scan_id)
  assert.equal(invoices.json.items.length, 3)
})

test('answers in under 500 ms while a slow scan is in flight, and the old numbers stay put', async () => {
  __setChainReaderForTests(async (id, seller) => {
    await new Promise((r) => setTimeout(r, 40))
    if (seller !== OWNER_ADDRESS) return null
    return chain.get(id) ?? null
  })
  const before = await call(handleStats)
  chain.set(11, view(11, 'Unpaid'))
  const running = refreshScan() // slow: many ids x 40 ms
  const t0 = Date.now()
  const stats = await call(handleStats)
  const invoices = await call(handleInvoices)
  assert.ok(Date.now() - t0 < 500)
  assert.equal(stats.json.scan_id, before.json.scan_id, 'in-progress scan is not served')
  assert.equal(invoices.json.items.length, 3)
  await running
  const after = await call(handleStats)
  assert.notEqual(after.json.scan_id, before.json.scan_id)
  assert.equal(after.json.payables_total, 4)
})

test('cleanup', () => { __setChainReaderForTests(null); __setScanPersistenceForTests(null) })
