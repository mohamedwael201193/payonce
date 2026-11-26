// Fresh payable id allocation (v9): no lost updates, no Duplicate loop.
// Regression for the live failure of 2026-11-26: POST /api/payables answered
// 409 "chain refused (-2 Duplicate)" forever, because payables 1050-1052
// existed on chain but the server counter said 1050 (a stale whole-document
// save moved it backwards) and discovery stopped at id 1049.
// Offline: scratch data dir, stubbed chain reader / sender.
// Run: node --test test/fresh-id.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PAYONCE_DATA_DIR = mkdtempSync(join(tmpdir(), 'payonce-freshid-'))
const { loadCounters, updateCounters } = await import('../src/store.mjs')
const { allocateFreshId, registerWithFreshId, releaseFreshId } = await import('../src/fresh-id.mjs')
const { OWNER_ADDRESS: S1, FRESH_ID_START } = await import('../src/config.mjs')
const { handleStats, handleInvoices, __setChainReaderForTests } = await import('../src/server.mjs')

const reset = (nextFreshId, freshIds = []) => updateCounters((c) => { c.nextFreshId = nextFreshId; c.freshIds = freshIds })

test('parallel allocations never hand out the same id', async () => {
  await reset(2000)
  const ids = await Promise.all(Array.from({ length: 12 }, () => allocateFreshId()))
  assert.equal(new Set(ids).size, 12)
  assert.deepEqual([...ids].sort((a, b) => a - b), Array.from({ length: 12 }, (_, i) => 2000 + i))
  assert.equal((await loadCounters()).nextFreshId, 2012)
})

test('a chain Duplicate (-2) counts the existing id and moves on to the next free one', async () => {
  await reset(3000)
  const tried = []
  const out = await registerWithFreshId(async (id) => {
    tried.push(id)
    return { txHash: `tx${id}`, rejected: id < 3002 ? { code: -2, name: 'Duplicate' } : null }
  })
  assert.equal(out.ok, true)
  assert.equal(out.id, 3002)
  assert.deepEqual(tried, [3000, 3001, 3002])
  const c = await loadCounters()
  assert.deepEqual(c.freshIds, [3000, 3001, 3002])
  assert.equal(c.nextFreshId, 3003)
})

test('a concurrent counters write during the registration is not overwritten, and nextFreshId never moves backwards', async () => {
  await reset(4000)
  const before = (await loadCounters()).verifierRuns
  const out = await registerWithFreshId(async (id) => {
    // while the registration is "finalizing", a verify run records itself
    await updateCounters((c) => { c.verifierRuns += 1 })
    await allocateFreshId() // and another create takes the next id
    return { txHash: `tx${id}`, rejected: null }
  })
  const c = await loadCounters()
  assert.equal(out.id, 4000)
  assert.equal(c.verifierRuns, before + 1, 'the verify increment survived')
  assert.equal(c.nextFreshId, 4002, 'the other create keeps its id: counter is 4002, not 4001')
  assert.ok(c.freshIds.includes(4000))
})

test('a non-duplicate refusal releases the id; a transport failure releases it and rethrows', async () => {
  await reset(5000)
  const refused = await registerWithFreshId(async () => ({ txHash: 't', rejected: { code: -8, name: 'AgentNotFound' } }))
  assert.equal(refused.ok, false)
  assert.equal((await loadCounters()).nextFreshId, 5000)
  await assert.rejects(registerWithFreshId(async () => { throw new Error('node unavailable') }), /node unavailable/)
  assert.equal((await loadCounters()).nextFreshId, 5000)
  const id = await allocateFreshId()
  await releaseFreshId(id)
  assert.equal((await loadCounters()).nextFreshId, 5000)
})

test('registration gives up after the attempt bound when every id is a duplicate', async () => {
  await reset(6000)
  const out = await registerWithFreshId(async (id) => ({ txHash: `t${id}`, rejected: { code: -2, name: 'Duplicate' } }), { attempts: 3 })
  assert.equal(out.ok, false)
  assert.equal(out.rejected.code, -2)
  assert.equal((await loadCounters()).nextFreshId, 6003)
})

test('stats discover payables on chain beyond a regressed counter and fold them in (1050-1052 case)', async () => {
  await reset(FRESH_ID_START, [])
  const live = new Set([1000, 1001, 1002, 1050, 1051, 1052])
  // ids 1003..1049 exist too (a contiguous run), so the probe reaches 1052
  for (let i = 1003; i < 1050; i += 1) live.add(i)
  __setChainReaderForTests(async (id, seller) => {
    if (seller !== S1 || !live.has(id)) return null
    return { id, seller: S1, status: id === 1052 ? 'Paid' : 'Unpaid', asset: 'CCD', amount: '500000', due: '2026-12-01T00:00:00.000Z' }
  })
  const res = { captured: {}, writeHead(s) { this.captured.status = s }, end(b) { this.captured.json = JSON.parse(b) } }
  await handleStats({}, res)
  assert.equal(res.captured.status, 200)
  assert.equal(res.captured.json.payables_total, live.size)
  assert.equal(res.captured.json.paid_total, 1)
  const c = await loadCounters()
  assert.ok(c.freshIds.includes(1052))
  assert.equal(c.nextFreshId, 1053, 'the next create starts after the highest payable on chain')
  const res2 = { captured: {}, writeHead(s) { this.captured.status = s }, end(b) { this.captured.json = JSON.parse(b) } }
  await handleInvoices({}, res2)
  assert.equal(res2.captured.json.items.length, live.size, 'stats and list agree')
  __setChainReaderForTests(null)
})
