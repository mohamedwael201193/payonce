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
