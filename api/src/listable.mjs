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
// The chain has no "test" flag, so provenance is recorded server-side:
//   demo    curated demo invoices (seller 1 ids 10, 11; seller 2 ids 1, 2),
//           the open payables seeded for judges (SEEDED_DEMO, evidence
//           qa/out/seed-open-payables.json), and every payable a visitor
//           registers through POST /api/payables (its id is appended to the
//           persisted counters.demoIds list as "<seller>:<id>")
//   matrix  contract-matrix test payables: seller 1 ids 1..5
//   lab     every other row: registered by automated e2e / test runs
//           (requests carrying header x-payonce-run: test are never demo)
// matrix + lab are the "automated test runs", ALWAYS counted in the
// headline totals. Kind never depends on status, so a row cannot change
// bucket when it is paid.
export const KIND_RULE = 'demo = curated demo invoices (seller 1 ids 10, 11; seller 2 ids 1, 2), the open payables seeded for judges (seller 1 ids 1095-1098, seller 2 ids 5002-5005) and every payable registered through the app (recorded in the server list counters.demoIds); matrix = seller 1 ids 1-5 (contract-matrix tests); lab = every other row (automated test runs, registered with x-payonce-run: test or before provenance was recorded). Never depends on status.'
export const SEEDED_DEMO = [
  ...[1095, 1096, 1097, 1098].map((id) => ({ seller: OWNER_ADDRESS, id })),
  ...[5002, 5003, 5004, 5005].map((id) => ({ seller: SELLER2_ADDRESS, id })),
]
const DEMO_S1 = new Set([10, 11])
const DEMO_S2 = new Set([1, 2])
/** Set of "<seller>:<id>" keys for the recorded demo provenance. */
export function demoKeySet(recorded = []) {
  return new Set([...SEEDED_DEMO, ...(recorded ?? [])].map((d) => `${d.seller}:${d.id}`))
}
export function rowKind(r, demoKeys = demoKeySet()) {
  const seller = r.seller ?? OWNER_ADDRESS
  if (demoKeys.has(`${seller}:${r.id}`)) return 'demo'
  if (seller === SELLER2_ADDRESS) return DEMO_S2.has(r.id) ? 'demo' : 'lab'
  if (DEMO_S1.has(r.id)) return 'demo'
  if (r.id >= 1 && r.id <= 5) return 'matrix'
  return 'lab'
}
export function kindCounts(rows, demoKeys = demoKeySet()) {
  const out = { demo: { total: 0, paid: 0 }, matrix: { total: 0, paid: 0 }, lab: { total: 0, paid: 0 } }
  for (const r of listableRows(rows)) {
    const k = out[rowKind(r, demoKeys)]
    k.total += 1
    if (r.status === 'Paid') k.paid += 1
  }
  return {
    ...out,
    test_runs: { total: out.matrix.total + out.lab.total, paid: out.matrix.paid + out.lab.paid },
    rule: KIND_RULE,
  }
}
/** The numbers to quote. /api/stats' top-level payables_total / paid_total count EVERY row on the
    registry, and most rows are PayOnce's own automated test runs (lab + matrix). The headline counts the
    demo kind only (curated demo, judge-seeded and app-registered invoices) and always names what it
    excludes. Every row is PayOnce's own: no outside user is counted here. */
export function statsHeadline(byKind, totals) {
  const d = byKind.demo, t = byKind.test_runs
  return {
    basis: 'demo_kind_only',
    label: 'Invoices made through the app and the demo (test runs excluded)',
    payables: d.total,
    paid: d.paid,
    excluded_test_runs: { payables: t.total, paid: t.paid },
    all_rows: { payables: totals.payables_total, paid: totals.paid_total },
    test_run_share_pct: totals.payables_total ? Math.round((t.total / totals.payables_total) * 100) : 0,
    outside_users_counted: false,
    note: 'Quote headline.payables / headline.paid. The top-level payables_total and paid_total include the automated test runs. All rows are PayOnce\'s own; outside users are not counted separately yet.',
  }
}
export function invoiceItem(r, { label, amountDisplay, demoKeys }) {
  return {
    payable_id: r.id,
    seller: r.seller,
    asset: r.asset === 'CCD' ? 'ccd' : 'eudemo',
    amount_display: amountDisplay,
    due: r.due,
    status: r.status,
    label,
    kind: rowKind(r, demoKeys),
  }
}
