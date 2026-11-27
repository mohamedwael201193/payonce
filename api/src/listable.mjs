// Shared listable-rows rule (stats-vs-list reconciliation).
// The /api/invoices list shows only Unpaid|Paid rows; /api/stats must count
// the SAME rows, and report the excluded rows instead of hiding them —
// otherwise the hero chip, the card and the dashboard total disagree in the
// same render (the persistent 14-vs-13 off-by-one: payable 4 is Voided on
// chain, so the old stats counted 14 scanned rows while the list showed 13).
// Pure, zero dependencies, unit-tested in api/test/stats-reconcile.test.mjs.
import { OWNER_ADDRESS, SELLER2_ADDRESS } from './config.mjs'

export function listableRows(rows) {
  return rows.filter((r) => r.status === 'Unpaid' || r.status === 'Paid')
}

// Fix-back-6 B1: a scan is complete only when NO expected id was skipped.
// The old scan silently dropped any row whose chain read threw, and both
// endpoints served the partial remainder as 200 OK — so /api/stats swung
// 51/31 → 8/5 and /api/invoices 51 → 13 items in the same minute, and the
// frontend rendered the shrunken numbers. A partial scan is never a
// snapshot: the handlers serve the last complete scan, or 503 node_busy.
export function scanIsComplete(skippedIds) {
  return skippedIds.length === 0
}

// Every number in the body is derived from a named source, and the body
// says which (v9 stats honesty). `sources[field]` carries:
//   kind  'live'      read from the chain by this request's scan
//         'recorded'  a count of recorded evidence + this server's own log,
//                     NOT a chain counter (the chain has none)
//         'server'    a timestamp this API keeps itself (not chain state)
//   basis one sentence a reader can check
// `generated_at` is when this body was built; `scanned_at` is when the
// chain was read (older than generated_at, and `stale: true`, when the
// last complete scan is served because the current one was incomplete).
// The frontend labels LIVE / RECORDED from `sources[field].kind`.
// The legacy fields keep their names and meaning, so older clients work.
export function statsBody({
  rows, refusedCount, lastVerifierRunAt,
  generatedAt = null, scannedAt = null, stale = false,
  recordedRefusals = null, liveRefusals = null, sellers = null,
}) {
  const listable = listableRows(rows)
  const body = {
    payables_total: listable.length,
    paid_total: listable.filter((r) => r.status === 'Paid').length,
    voided_total: rows.filter((r) => r.status === 'Voided').length,
    reserved_total: rows.filter((r) => r.status === 'Reserved').length,
    refused_on_chain_since_deploy: refusedCount,
    last_verifier_run_at: lastVerifierRunAt,
  }
  if (generatedAt === null) return body
  const scanBasis = `payable rows read from the registry contract by the scan at scanned_at (${rows.length} rows read; ids known to this server, both sellers)`
  const chainRow = (extra = '') => ({ kind: 'live', basis: scanBasis + extra, as_of: scannedAt })
  return {
    ...body,
    generated_at: generatedAt,
    scanned_at: scannedAt,
    stale,
    rows_scanned: rows.length,
    by_seller: sellers ?? null,
    sources: {
      payables_total: chainRow('; counts rows whose status is Unpaid or Paid (the rows /api/invoices lists)'),
      paid_total: chainRow('; counts rows whose status is Paid'),
      voided_total: chainRow('; counts rows whose status is Voided'),
      reserved_total: chainRow('; counts rows whose status is Reserved'),
      refused_on_chain_since_deploy: {
        kind: 'recorded',
        basis: `distinct transaction hashes the chain rejected: ${recordedRefusals ?? 'n/a'} from recorded evidence files + ${liveRefusals ?? 'n/a'} logged live by this server. Not a chain counter (the chain has none); every hash is listed at /api/stats/refusals and re-checkable on chain.`,
        recorded_count: recordedRefusals,
        live_count: liveRefusals,
        list_url: '/api/stats/refusals',
        as_of: generatedAt,
      },
      last_verifier_run_at: {
        kind: 'server',
        basis: 'time of the last verifier run this API performed (before_pay or after_pay); a server timestamp, not chain state',
        as_of: lastVerifierRunAt,
      },
    },
  }
}

// ---- demo vs automated test runs (2026-11-27) ----
// The chain has no "this was a test" flag, so the split is an explicit,
// stable, id-based rule (it never depends on status, so a row does not
// change bucket when it is paid and the numbers cannot jump):
//   demo    the curated demo invoices: seller 1 ids 10, 11 and seller 2
//           ids 1, 2 (the invoices the guided flow was built around)
//   matrix  contract-matrix test payables: seller 1 ids 1..5
//   lab     every other row: lab invoices registered by automated test
//           runs ("Lab invoice (testnet, not a real invoice)")
// matrix + lab together are the "automated test runs" and are ALWAYS
// counted in the headline totals; the split is shown, never hidden.
export const KIND_RULE = 'demo = seller 1 ids 10, 11 and seller 2 ids 1, 2; matrix = seller 1 ids 1-5 (contract-matrix tests); lab = every other row (automated test runs). Id-based, so a row never changes bucket when its status changes.'
const DEMO_S1 = new Set([10, 11])
const DEMO_S2 = new Set([1, 2])
export function rowKind(r) {
  const isS2 = r.seller === SELLER2_ADDRESS
  if (isS2) return DEMO_S2.has(r.id) ? 'demo' : 'lab'
  if (DEMO_S1.has(r.id)) return 'demo'
  if (r.id >= 1 && r.id <= 5) return 'matrix'
  return 'lab'
}
export function kindCounts(rows) {
  const out = { demo: { total: 0, paid: 0 }, matrix: { total: 0, paid: 0 }, lab: { total: 0, paid: 0 } }
  for (const r of listableRows(rows)) {
    const k = out[rowKind(r)]
    k.total += 1
    if (r.status === 'Paid') k.paid += 1
  }
  return {
    ...out,
    test_runs: { total: out.matrix.total + out.lab.total, paid: out.matrix.paid + out.lab.paid },
    rule: KIND_RULE,
  }
}
export function invoiceItem(r, { label, amountDisplay }) {
  return {
    payable_id: r.id,
    seller: r.seller,
    asset: r.asset === 'CCD' ? 'ccd' : 'eudemo',
    amount_display: amountDisplay,
    due: r.due,
    status: r.status,
    label,
    kind: rowKind(r),
  }
}
