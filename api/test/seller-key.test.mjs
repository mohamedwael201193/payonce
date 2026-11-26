// Seller-key correctness (v9 task 2): every payable lookup is keyed by
// (seller, id). Seller 1's matrix payables 1-5 and seller 2's payables 1-2
// share ids; a seller-2 id must NEVER resolve to seller 1's document,
// payment transactions, recorded run or label, and an unknown ?seller= is
// a loud 400. No network, no sends: the chain reader is stubbed through
// the same seam the stats/payable handler tests use.
// Run: node --test test/seller-key.test.mjs
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Scratch data dir BEFORE the modules load (config reads env at import),
// so the test never touches the tracked api/data files.
process.env.PAYONCE_DATA_DIR = mkdtempSync(join(tmpdir(), 'payonce-sellerkey-'))

const { SELLER2_ADDRESS, OWNER_ADDRESS } = await import('../src/config.mjs')
const { docForPayableForSeller, recordedRunFor, recordedPaymentTx, recordedPaymentTxForSeller } = await import('../src/docs.mjs')
const { paymentTxsFor } = await import('../src/receipts.mjs')
const server = await import('../src/server.mjs')
const { handleGetPayable, handleDocument, handleInvoices, labelFor, rejectNonSeller1Write, __setChainReaderForTests } = server

const S1 = OWNER_ADDRESS
const S2 = SELLER2_ADDRESS
const DUE = '2026-12-01T08:03:26.555Z'

function view(seller, id, status = 'Paid', asset = 'CCD') {
  return {
    id, seller, status, asset, amount: '500000', due: DUE, dueMs: Date.parse(DUE),
    payee: seller, agentToken: seller === S2 ? '1506' : '1476', docHash: '00',
    ...(status === 'Paid' ? { record: { payer: '4MvdMEGC', paidAt: '2026-11-25T10:00:00Z' } } : {}),
  }
}

function fakeRes() {
  const captured = {}
  return {
    captured,
    writeHead(status) { captured.status = status },
    end(body) {
      captured.body = body
      try { captured.json = JSON.parse(body) } catch { captured.json = null }
    },
  }
}
const reqFor = (path) => ({ url: path })

test('document: seller 2 payable 1 and seller 1 payable 1 are different documents', async () => {
  const d1 = await docForPayableForSeller(S1, 1)
  const d2 = await docForPayableForSeller(S2, 1)
  assert.ok(d1 && d2)
  assert.notEqual(Buffer.from(d1).toString('hex'), Buffer.from(d2).toString('hex'))
})

test('document: a seller-2 id with no seller-2 file never falls through to seller 1 (ids 3, 4, 5, 10, 11)', async () => {
  for (const id of [3, 4, 5, 10, 11]) {
    assert.ok(await docForPayableForSeller(S1, id), `seller 1 has a document for ${id}`)
    assert.equal(await docForPayableForSeller(S2, id), null, `seller 2 id ${id} must not resolve to seller 1's document`)
  }
})

test('payment txs: seller-2 ids resolve only to seller-2 evidence', async () => {
  const s1rec = recordedPaymentTx(10)
  assert.ok(s1rec?.payTx, 'seller 1 evidence for payable 10 exists')
  const s1 = await paymentTxsFor(10, view(S1, 10))
  assert.equal(s1.txs[0][1], s1rec.payTx)
  // A hypothetical seller-2 payable 10 gets an empty list, never seller 1's tx.
  const s2 = await paymentTxsFor(10, view(S2, 10))
  assert.deepEqual(s2.txs, [])
  // Same bare id 1: each seller gets its OWN payment transaction.
  const a = await paymentTxsFor(1, view(S1, 1))
  const b = await paymentTxsFor(1, view(S2, 1))
  assert.ok(b.txs.length > 0)
  assert.equal(b.txs[0][1], recordedPaymentTxForSeller(S2, 1).payTx)
  assert.notEqual(a.txs[0]?.[1], b.txs[0][1])
  // The EUDemo seller-2 payable 2 keeps its legs; none is a seller-1 hash.
  const e2 = await paymentTxsFor(2, view(S2, 2, 'Paid', 'EUDemo'))
  const e1hashes = new Set(Object.values(recordedPaymentTx(2) ?? {}).filter((v) => typeof v === 'string'))
  assert.ok(e2.txs.length >= 1)
  for (const [, h] of e2.txs) assert.ok(!e1hashes.has(h), 'seller-2 leg must not be a seller-1 hash')
})

test('recorded run: seller 2 never gets seller 1 run for the same id', () => {
  assert.equal(recordedRunFor(10, S2), null)
  assert.equal(recordedRunFor(11, S2), null)
  assert.equal(recordedRunFor(4, S2), null)
  const r1 = recordedRunFor(1, S1)
  const r2 = recordedRunFor(1, S2)
  assert.ok(r1 && r2)
  assert.equal(r2.seller, S2)
  assert.notDeepEqual(r1.steps.map((s) => s.txHash), r2.steps.map((s) => s.txHash))
})

test('label: seller 2 payable 1/2 is a lab invoice; seller 1 payable 1/2 is a matrix payable', () => {
  assert.match(labelFor(view(S1, 1)), /Contract-matrix/)
  assert.match(labelFor(view(S2, 1)), /Lab invoice/)
  assert.match(labelFor(view(S2, 2, 'Paid', 'EUDemo')), /Lab invoice/)
})

test('GET payable: the reader is called with the seller from ?seller=, default seller 1', async () => {
  const seen = []
  __setChainReaderForTests(async (id, seller) => { seen.push([id, seller]); return null })
  let res = fakeRes(); await handleGetPayable(reqFor('/api/payables/3'), res, 3)
  assert.equal(res.captured.status, 404)
  res = fakeRes(); await handleGetPayable(reqFor(`/api/payables/3?seller=${S2}`), res, 3)
  assert.equal(res.captured.status, 404)
  assert.deepEqual(seen, [[3, S1], [3, S2]])
})

test('GET payable / document: an unknown ?seller= is a 400, never silently seller 1', async () => {
  __setChainReaderForTests(async () => { throw new Error('must not be read') })
  for (const h of [handleGetPayable, handleDocument]) {
    const res = fakeRes()
    await h(reqFor('/api/payables/1?seller=4MvdMEGCPL9pjbN5wMxR8geX181oXMA3adC7Z2CP6gH3NS1WDs'), res, 1)
    assert.equal(res.captured.status, 400)
    assert.equal(res.captured.json.error.code, 'invalid')
  }
})

test('GET document: seller-2 id 3 is 404, seller 1 id 3 serves seller 1 document, id 1 differs per seller', async () => {
  __setChainReaderForTests(async (id, seller) => view(seller, id, 'Unpaid'))
  let res = fakeRes(); await handleDocument(reqFor('/api/payables/3/document'), res, 3)
  assert.equal(res.captured.status, 200)
  assert.ok(res.captured.body.length > 20)
  res = fakeRes(); await handleDocument(reqFor(`/api/payables/3/document?seller=${S2}`), res, 3)
  assert.equal(res.captured.status, 404)
  const r1 = fakeRes(); await handleDocument(reqFor('/api/payables/1/document'), r1, 1)
  const r2 = fakeRes(); await handleDocument(reqFor(`/api/payables/1/document?seller=${S2}`), r2, 1)
  assert.equal(r1.captured.status, 200)
  assert.equal(r2.captured.status, 200)
  assert.notEqual(r1.captured.body, r2.captured.body)
})

test('invoices list: rows carry their seller; the same bare id appears once per seller', async () => {
  __setChainReaderForTests(async (id, seller) => {
    if (seller === S2) return id <= 2 ? view(S2, id, 'Paid', id === 2 ? 'EUDemo' : 'CCD') : null
    return id === 1 ? view(S1, 1, 'Unpaid') : null
  })
  const res = fakeRes()
  await handleInvoices({}, res)
  assert.equal(res.captured.status, 200)
  const ones = res.captured.json.items.filter((i) => i.payable_id === 1)
  assert.equal(ones.length, 2)
  assert.deepEqual(ones.map((i) => i.seller).sort(), [S1, S2].sort())
  assert.equal(ones.find((i) => i.seller === S1).status, 'Unpaid')
  assert.equal(ones.find((i) => i.seller === S2).status, 'Paid')
  const s2rows = res.captured.json.items.filter((i) => i.seller === S2)
  assert.deepEqual(s2rows.map((i) => i.payable_id), [1, 2])
  assert.ok(s2rows.every((i) => /Lab invoice/.test(i.label)))
})

test('writes: a seller-2 pay / create / attack is refused with a 400, never run as seller 1', async () => {
  // pay, create and attack handlers all call rejectNonSeller1Write first.
  for (const [url, body] of [
    ['/api/payables/1/pay', { rail: 'ccd', seller: S2 }],
    ['/api/payables', { asset: 'ccd', seller: S2 }],
    ['/api/attacks/pay_twice', { payable_id: 1, seller: S2, mode: 'precheck_only' }],
    [`/api/payables/1/pay?seller=${S2}`, { rail: 'ccd' }],
  ]) {
    const res = fakeRes()
    assert.equal(rejectNonSeller1Write(reqFor(url), res, body), true, url)
    assert.equal(res.captured.status, 400)
    assert.equal(res.captured.json.error.code, 'invalid')
    assert.match(res.captured.json.error.message, /not supported for writes/)
  }
  // Seller 1 (explicit or implicit) passes the guard.
  for (const [url, body] of [['/api/payables/1/pay', { rail: 'ccd' }], [`/api/payables/1/pay?seller=${S1}`, {}]]) {
    const res = fakeRes()
    assert.equal(rejectNonSeller1Write(reqFor(url), res, body), false)
    assert.equal(res.captured.status, undefined)
  }
})

test('writes: every write handler in server.mjs calls the seller-1 guard first', async () => {
  const { readFileSync } = await import('node:fs')
  const src = readFileSync(new URL('../src/server.mjs', import.meta.url), 'utf8')
  for (const name of ['handleCreatePayable', 'handlePay', 'handleAttack']) {
    const m = src.match(new RegExp(`async function ${name}\\([^)]*\\) \\{([\\s\\S]*?)\\n\\}\\n`))
    assert.ok(m, `${name} found`)
    assert.match(m[1], /rejectNonSeller1Write\(req, res, body\)/, `${name} guards seller`)
  }
})

test('cleanup: the chain stub is removed', () => {
  __setChainReaderForTests(null)
})
