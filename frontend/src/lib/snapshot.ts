// Live snapshot — ONE consistent snapshot per refresh (fix-back-6 B1/B11).
//
// The live API's list scan is flaky: /api/invoices and /api/stats are
// separate scans of the same registry, and a scan that hits a busy node
// silently drops the rows it could not read — returning a PARTIAL list as
// 200 OK (verified live 2026-11-25 09:37 UTC: /api/invoices returned 51,
// then 51, then 13 items; /api/stats swung 51/31 to 8/5 in the same
// minute). The dashboard and the home hero each polled those endpoints
// on their own, so the two pages disagreed in the same minute (home 50/30,
// dashboard 51/31) and one page swung 50 → 51 → 43 → 51 with no user
// action — the user's original complaint, still live.
//
// The rule, enforced here and in useLiveSnapshot:
//   1. stats + invoices are fetched TOGETHER and only accepted as a pair
//      when they agree with each other (stats total == list length,
//      stats paid == paid in the list);
//   2. payables are append-only, so a list SHORTER than the last accepted
//      one is always a partial scan and is never accepted;
//   3. a rejected pair is retried (fresh pair, up to 3 attempts); if it
//      never agrees, the fetch THROWS, so react-query keeps the last good
//      snapshot on screen instead of rendering shrunken numbers. On a
//      first load with no previous snapshot, a throw means the error state
//      — never a partial render.
// Nothing here invents a number: acceptance only ever keeps or replaces
// with a server-provided pair that agrees with itself.
import { ApiError } from './types'
import type { InvoiceItem, Stats } from './types'
import { api } from './api'

export interface LiveSnapshot {
  items: InvoiceItem[]
  stats: Stats
}

export type SnapshotRejection = { ok: false; reason: string }

/** Pure acceptance rule for one (list, stats) pair against the last
    accepted list length. */
export function snapshotAccepts(
  items: InvoiceItem[],
  stats: Stats,
  prevCount: number,
): { ok: true } | SnapshotRejection {
  if (stats.payables_total !== items.length) {
    return {
      ok: false,
      reason: `stats total ${stats.payables_total} != list length ${items.length} — one of the two scans is partial`,
    }
  }
  const paid = items.filter((i) => i.status === 'paid').length
  if (stats.paid_total !== paid) {
    return {
      ok: false,
      reason: `stats paid ${stats.paid_total} != paid in list ${paid} — one of the two scans is partial`,
    }
  }
  if (items.length < prevCount) {
    return {
      ok: false,
      reason: `list shrank ${prevCount} -> ${items.length} — payables are append-only, so this is a partial scan`,
    }
  }
  return { ok: true }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fetch one consistent (list, stats) pair. Retries a disagreeing pair so
    a transient partial scan never reaches the screen. Throws after the
    attempts are exhausted — the caller (react-query) then keeps the last
    good snapshot. */
export async function fetchLiveSnapshot(prevCount = 0, attempts = 3): Promise<LiveSnapshot> {
  let lastReason = 'the live numbers disagreed just now'
  for (let attempt = 0; attempt < attempts; attempt++) {
    const [items, stats] = await Promise.all([api.getInvoices(), api.getStats()])
    const check = snapshotAccepts(items, stats, prevCount)
    if (check.ok) return { items, stats }
    lastReason = check.reason
    if (attempt < attempts - 1) await sleep(1000 * (attempt + 1))
  }
  throw new ApiError(0, {
    code: 'chain_unreachable',
    layer: 'server',
    message: `The live numbers disagreed just now (${lastReason}). Showing the last verified numbers.`,
    retryable: true,
  })
}
