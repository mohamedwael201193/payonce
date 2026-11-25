// Shared listable-rows rule (stats-vs-list reconciliation).
// The /api/invoices list shows only Unpaid|Paid rows; /api/stats must count
// the SAME rows, and report the excluded rows instead of hiding them —
// otherwise the hero chip, the card and the dashboard total disagree in the
// same render (the persistent 14-vs-13 off-by-one: payable 4 is Voided on
// chain, so the old stats counted 14 scanned rows while the list showed 13).
// Pure, zero dependencies, unit-tested in api/test/stats-reconcile.test.mjs.
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

export function statsBody({ rows, refusedCount, lastVerifierRunAt }) {
  const listable = listableRows(rows)
  return {
    payables_total: listable.length,
    paid_total: listable.filter((r) => r.status === 'Paid').length,
    voided_total: rows.filter((r) => r.status === 'Voided').length,
    reserved_total: rows.filter((r) => r.status === 'Reserved').length,
    refused_on_chain_since_deploy: refusedCount,
    last_verifier_run_at: lastVerifierRunAt,
  }
}
