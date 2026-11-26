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
