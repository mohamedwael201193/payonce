// Stats honesty (v9 task 4): every number /api/stats returns is derivable
// from chain / registry state, and the body says where each number comes
// from (generated_at, scanned_at, stale, sources[field].kind) so the
// frontend can label LIVE / RECORDED. Offline: the chain reader is stubbed.
// Run: node --test test/stats-honesty.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

process.env.PAYONCE_DATA_DIR = mkdtempSync(join(tmpdir(), 'payonce-stats-'))
const { OWNER_ADDRESS: S1, SELLER2_ADDRESS: S2 } = await import('../src/config.mjs')
const { statsBody } = await import('../src/listable.mjs')
const { handleStats, handleStatsRefusals, handleInvoices, __setChainReaderForTests } = await import('../src/server.mjs')
const { recordedRefusals } = await import('../src/docs.mjs')

const DUE = '2026-12-01T08:03:26.555Z'
const row = (seller, id, status) => ({ seller, id, status, asset: 'CCD', amount: '500000', due: DUE })
const ROWS = {
  [`${S1}:1`]: row(S1, 1, 'Paid'), [`${S1}:2`]: row(S1, 2, 'Unpaid'), [`${S1}:4`]: row(S1, 4, 'Voided'),
  [`${S1}:5`]: row(S1, 5, 'Reserved'), [`${S1}:10`]: row(S1, 10, 'Paid'),
  [`${S2}:1`]: row(S2, 1, 'Paid'), [`${S2}:2`]: row(S2, 2, 'Paid'),
}
__setChainReaderForTests(async (id, seller) => ROWS[`${seller}:${id}`] ?? null)

function fakeRes() {
  const captured = {}
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(body) { captured.body = body; try { captured.json = JSON.parse(body) } catch { captured.json = null } },
  }
}

test('legacy statsBody call (no provenance args) keeps the exact legacy shape', () => {
  const b = statsBody({ rows: Object.values(ROWS), refusedCount: 3, lastVerifierRunAt: null })
  assert.deepEqual(Object.keys(b).sort(), ['last_verifier_run_at', 'paid_total', 'payables_total', 'refused_on_chain_since_deploy', 'reserved_total', 'voided_total'])
})

test('every counted number equals a recount of the listed rows (both sellers)', async () => {
  const sres = fakeRes(); await handleStats({}, sres)
  const ires = fakeRes(); await handleInvoices({}, ires)
  assert.equal(sres.captured.status, 200)
  const s = sres.captured.json
  const items = ires.captured.json.items
  assert.equal(s.payables_total, items.length)
  assert.equal(s.paid_total, items.filter((i) => i.status === 'Paid').length)
  // Independent recount straight from the stubbed registry rows.
  const all = Object.values(ROWS)
  assert.equal(s.payables_total, all.filter((r) => r.status === 'Unpaid' || r.status === 'Paid').length)
  assert.equal(s.paid_total, all.filter((r) => r.status === 'Paid').length)
  assert.equal(s.voided_total, all.filter((r) => r.status === 'Voided').length)
  assert.equal(s.reserved_total, all.filter((r) => r.status === 'Reserved').length)
  assert.equal(s.rows_scanned, all.length)
  // Per-seller totals add up to the headline.
  assert.equal(s.by_seller.seller_1.payables_total + s.by_seller.seller_2.payables_total, s.payables_total)
  assert.equal(s.by_seller.seller_1.paid_total + s.by_seller.seller_2.paid_total, s.paid_total)
  assert.equal(s.by_seller.seller_2.payables_total, 2)
})

test('provenance: generated_at, scanned_at, stale and a source for every numeric field', async () => {
  const res = fakeRes(); await handleStats({}, res)
  const s = res.captured.json
  assert.ok(!Number.isNaN(Date.parse(s.generated_at)))
  assert.ok(!Number.isNaN(Date.parse(s.scanned_at)))
  assert.ok(Date.parse(s.scanned_at) <= Date.parse(s.generated_at) + 1000)
  assert.equal(s.stale, false)
  const numeric = Object.keys(s).filter((k) => /_total$|^refused_on_chain_since_deploy$|^last_verifier_run_at$/.test(k))
  assert.ok(numeric.length >= 6)
  for (const k of numeric) {
    assert.ok(s.sources[k], `source for ${k}`)
    assert.ok(['live', 'recorded', 'server'].includes(s.sources[k].kind), `${k} kind`)
    assert.ok(s.sources[k].basis.length > 20, `${k} basis`)
  }
  for (const k of ['payables_total', 'paid_total', 'voided_total', 'reserved_total']) assert.equal(s.sources[k].kind, 'live')
  // The refusal count is honestly NOT labelled live: the chain has no counter.
  assert.equal(s.sources.refused_on_chain_since_deploy.kind, 'recorded')
  assert.equal(s.sources.last_verifier_run_at.kind, 'server')
})

test('refused count is exactly the length of the listed hashes, each a 64-hex tx hash', async () => {
  const sres = fakeRes(); await handleStats({}, sres)
  const rres = fakeRes(); await handleStatsRefusals({}, rres)
  const s = sres.captured.json
  const r = rres.captured.json
  assert.equal(r.count, r.items.length)
  assert.equal(s.refused_on_chain_since_deploy, r.count)
  assert.equal(new Set(r.items.map((i) => i.tx_hash)).size, r.items.length, 'hashes are distinct')
  for (const i of r.items) assert.match(i.tx_hash, /^[0-9a-f]{64}$/)
  assert.equal(s.sources.refused_on_chain_since_deploy.recorded_count + s.sources.refused_on_chain_since_deploy.live_count, r.count)
  assert.equal(r.items.filter((i) => i.origin === 'recorded_evidence').length, recordedRefusals().size)
  assert.ok(r.items.every((i) => /^https:\/\//.test(i.explorer_url)))
})

test('an incomplete scan after a complete one serves the last scan labelled stale, with its read time', async () => {
  const first = fakeRes(); await handleStats({}, first)
  __setChainReaderForTests(async (id, seller) => {
    if (id === 10) throw new Error('node busy')
    return ROWS[`${seller}:${id}`] ?? null
  })
  const res = fakeRes(); await handleStats({}, res)
  const s = res.captured.json
  assert.equal(res.captured.status, 200)
  assert.equal(s.stale, true)
  assert.equal(s.payables_total, first.captured.json.payables_total)
  assert.ok(Date.parse(s.scanned_at) <= Date.parse(s.generated_at))
  __setChainReaderForTests(async (id, seller) => ROWS[`${seller}:${id}`] ?? null)
})

test('cleanup: the chain stub is removed', () => { __setChainReaderForTests(null) })
