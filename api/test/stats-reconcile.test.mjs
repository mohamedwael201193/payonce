// Stats-vs-list reconciliation (node:test, no deps, no network).
// The old /api/stats counted every scanned row (14: payable 4 is Voided on
// chain) while /api/invoices listed only Unpaid|Paid (13) — the same render
// showed two totals. statsBody must count the listable rows only and report
// the excluded rows as voided_total / reserved_total.
import test from 'node:test'
import assert from 'node:assert/strict'
import { listableRows, scanIsComplete, statsBody } from '../src/listable.mjs'

const ROWS = [
  { id: 1, status: 'Unpaid' },
  { id: 2, status: 'Paid' },
  { id: 4, status: 'Voided' },
  { id: 5, status: 'Reserved' },
  { id: 10, status: 'Paid' },
]

test('listableRows keeps only Unpaid|Paid rows', () => {
  assert.deepEqual(
    listableRows(ROWS).map((r) => r.id),
    [1, 2, 10],
  )
})

test('statsBody counts the listable rows and reports the excluded ones', () => {
  assert.deepEqual(statsBody({ rows: ROWS, refusedCount: 21, lastVerifierRunAt: '2026-11-24T22:55:58.259Z' }), {
    payables_total: 3,
    paid_total: 2,
    voided_total: 1,
    reserved_total: 1,
    refused_on_chain_since_deploy: 21,
    last_verifier_run_at: '2026-11-24T22:55:58.259Z',
  })
})

// Fix-back-6 B1: a scan that skipped any id is incomplete and must never
// be served as totals — the live failure was a scan that read 13 of 51
// rows (and a stats scan that read 8 of 51) and served the remainder as
// 200 OK, so the numbers swung with no user action.
test('scanIsComplete is false when any expected id was skipped', () => {
  assert.equal(scanIsComplete([]), true)
  assert.equal(scanIsComplete([1000, 1001]), false)
  assert.equal(scanIsComplete([1049]), false)
})
