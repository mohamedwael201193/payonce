// Live snapshot acceptance (fix-back-6 B1/B11, corrected fix-back-7
// MF-1/MF-2/MF-4) — the numbers must never swing with no user action.
// Pins the live failure: stats 51/31 vs a 13-item list, stats 8/5 vs a
// 51-item list, and a 51 → 43 shrink. Fix-back-7 corrects the shrink
// premise: a reserve or a void legitimately removes a row from the
// listable set (Unpaid|Paid only), so a shrink exactly accounted for by
// voided+reserved growth is accepted — anything else is still a partial
// scan. Also pins: an endpoint throw retries in-loop (MF-2), and an
// empty pair on cold load is rejected, never rendered as 0/0 (MF-4).
import { describe, expect, it, vi } from 'vitest'
import { fetchLiveSnapshot, snapshotAccepts, VERIFY_TICK_BUDGET_MS, type PrevSnapshot } from './snapshot'
import type { InvoiceItem, Stats } from './types'

const item = (id: number, status: 'paid' | 'unpaid'): InvoiceItem => ({
  payable_id: id,
  asset: 'ccd',
  amount_display: '0.500000 CCD',
  due: '2026-12-01T08:03:26.555Z',
  status,
  label: 'Lab invoice',
})

const stats = (total: number, paid: number, voided = 1, reserved = 5): Stats => ({
  payables_total: total,
  paid_total: paid,
  refused_on_chain_since_deploy: 21,
  last_verifier_run_at: '2026-11-24T17:08:24.616Z',
  voided_total: voided,
  reserved_total: reserved,
})

const prev = (count: number, voided = 1, reserved = 5, paid = 31): PrevSnapshot => ({
  count,
  voidedTotal: voided,
  reservedTotal: reserved,
  // Fix-back-9 MF-1 (a): the previous snapshot's paid total is part of
  // the fixture now — the feasibility check and paid monotonicity need it.
  paidTotal: paid,
  // Fix-back-8 MF-1: the previous snapshot's id set is part of the
  // fixture now — the verification layer needs to know which ids dropped.
  ids: Array.from({ length: count }, (_, i) => i + 1),
})

// A minimal PayableFacts body for the getPayable verification mock.
const facts = (id: number, status: { kind: 'reserved'; payer: string; expires: string } | { kind: 'voided' } | { kind: 'unpaid' } | { kind: 'paid'; payer: string; paid_at: string; payment_tx: string; payment_tx_source: 'chain' }) => ({
  payable_id: id,
  asset: { kind: 'ccd' as const, token: 'CCD' },
  amount: '500000',
  amount_display: '0.500000 CCD',
  payee: '4MvdMEGC',
  seller: '4MvdMEGC',
  due: '2026-12-01T08:03:26.555Z',
  is_past_due: false,
  status,
  agent: { registry: { index: 13144, subindex: 0 }, token: '1476' },
  doc_sha256: '00',
  label: status.kind === 'voided' ? 'Voided on chain — Lab invoice (testnet, not a real invoice)' : 'Lab invoice',
})

const listOf = (n: number, paidCount: number): InvoiceItem[] =>
  Array.from({ length: n }, (_, i) => item(i + 1, i < paidCount ? 'paid' : 'unpaid'))

describe('snapshotAccepts', () => {
  it('accepts a pair that agrees with itself and does not shrink', () => {
    const items = [item(1, 'paid'), item(2, 'unpaid')]
    expect(snapshotAccepts(items, stats(2, 1), prev(2, 1, 5, 1))).toEqual({ ok: true })
    expect(snapshotAccepts(items, stats(2, 1))).toEqual({ ok: true })
  })

  it('rejects the live partial-list case: stats 51/31 vs a 13-item list', () => {
    const items = listOf(13, 8)
    const check = snapshotAccepts(items, stats(51, 31), prev(51))
    expect(check.ok).toBe(false)
  })

  it('rejects the live partial-stats case: stats 8/5 vs a 51-item list', () => {
    const items = listOf(51, 31)
    expect(snapshotAccepts(items, stats(8, 5), prev(51)).ok).toBe(false)
  })

  it('rejects a paid-count disagreement even when the totals agree', () => {
    const items = [item(1, 'paid'), item(2, 'unpaid')]
    expect(snapshotAccepts(items, stats(2, 2), prev(0)).ok).toBe(false)
  })

  // MF-1: the adversarial judge's reserve case — a self-consistent 50/31
  // pair with reserved 5 → 6 (one payable reserved since the last
  // snapshot) is a LEGITIMATE shrink and must be accepted, not frozen.
  it('accepts a shrink exactly accounted for by a reserve (reserved 5 → 6)', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 1, 6), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // MF-1: the adversarial judge's void case — voided 1 → 2, same shape.
  it('accepts a shrink exactly accounted for by a void (voided 1 → 2)', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 2, 5), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // MF-1: two rows leave at once (one reserved, one voided) — accepted
  // only because the excluded growth (2) equals the shrink (2).
  // Fix-back-9: the fixture keeps paid at 31 — a paid row never leaves
  // the list, so a 31 → 30 paid fall would be a partial scan on its own
  // (pinned separately below), not a reserve+void.
  it('accepts a shrink accounted for by one reserve plus one void', () => {
    const items = listOf(49, 31)
    expect(snapshotAccepts(items, stats(49, 31, 2, 6), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // MF-1, negative: the fix-back-6 shrink — 51 → 43 with NO excluded
  // growth — is still a partial scan and is still rejected. A partial
  // scan that drops the same rows from both endpoints agrees with
  // itself, but the shrink is the tell. Fix-back-9: the fixture keeps
  // paid at 31, so this pins the shrink rule alone (a paid fall rejects
  // on its own, pinned separately below).
  it('rejects a shrink with no voided/reserved growth — still a partial scan', () => {
    const items = listOf(43, 31)
    expect(snapshotAccepts(items, stats(43, 31, 1, 5), prev(51, 1, 5)).ok).toBe(false)
  })

  // Fix-back-10 MF-1 (b): the over-accounted case FLIPS to accept.
  // A shrink SMALLER than the excluded growth is feasible once creates
  // are allowed: 1 reserve + 2 voids-of-unpaid + 2 creates (list
  // 51 → 50, reserved 5 → 6, voided 1 → 3) has d = 1 + 2 − 1 = 2. The
  // fix-back-7 exact-equality rule rejected it for assuming zero
  // creates; per-id verification arbitrates the dropped ids instead
  // (fetch level below — a dropped id reading reserved/voided confirms
  // it, reading unpaid rejects it).
  it('accepts a shrink smaller than the voided/reserved growth — over-accounted is feasible with creates', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 3, 6), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // Fix-back-10 MF-1 (b): 1 create + 3 reserves in one poll — list
  // 51 → 49, reserved 5 → 8. The fix-back-7 exact-equality rule
  // REJECTED this (excluded growth 3 ≠ shrink 2); the tight rule
  // accepts it (d = 3 + 0 − 2 = 1). The enumerator finds 669 such
  // achievable no-fall tuples false-rejected by the old rule, all
  // with d ≥ 1.
  it('accepts a no-fall create+exclusion burst: 1 create + 3 reserves, list 51 -> 49', () => {
    const items = listOf(49, 31)
    expect(snapshotAccepts(items, stats(49, 31, 1, 8), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // Fix-back-8 MF-1 (a): per-counter monotonicity. The adversarial
  // harness case — voided FALLS 5 → 4 while reserved rises +2, so the net
  // excluded growth (1) still equals the shrink (1) and the old count
  // rule ACCEPTED it. Voided is terminal on chain: a fall proves the
  // stats scan itself is partial, so the pair is rejected.
  it('rejects a shrink whose net growth hides a voided_total fall (5 -> 4)', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 4, 7), prev(51, 5, 5)).ok).toBe(false)
  })

  // Fix-back-9 MF-1 (a): the reserved-fall case the old test pinned as a
  // REJECTION now ACCEPTS at the pure level — the old invariant was
  // wrong. Reserved 7 → 5 with voided 1 → 4 and shrink 1 IS explainable
  // (witness: 1 Unpaid→Voided + 2 Reserved→Voided, d = −2 + 3 − 1 = 0 —
  // total rows 59 → 59, so 0 creates, NOT 2 as fix-back-9's comment
  // claimed), so the pure rule must not reject it. Per-id verification
  // guards the dropped rows instead (fetch level below); a fall with NO
  // explanation still rejects.
  it('accepts a shrink whose net growth hides a reserved_total fall (7 -> 5) — the fall is explained by voided growth', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 4, 5), prev(51, 1, 7))).toEqual({ ok: true })
  })

  // Fix-back-9 MF-1 (a): the three legitimate reserved exits, each
  // accepted at the pure level. Expiry: reserved 5 → 4, list 50 → 51
  // (the released row returns to the list). Confirm: reserved 5 → 4,
  // paid 31 → 32, list unchanged (the row stays listable as Paid).
  // Void-of-reserved: reserved 5 → 4, voided 1 → 2, shrink 1.
  it('accepts a legit expiry: reserved 5 -> 4 with the list growing 50 -> 51', () => {
    const items = listOf(51, 31)
    expect(snapshotAccepts(items, stats(51, 31, 1, 4), prev(50, 1, 5))).toEqual({ ok: true })
  })

  // Fix-back-10 MF-1 (a) H1, paid-cover: a confirm is NOT list-neutral.
  // Reserved 5 → 4, paid 31 → 32, list FLAT at 51: the confirm re-adds
  // the row to the list as Paid, so the list MUST reach 52 — the
  // flat pair has no event vector (d = −1 + 0 − 0 = −1) and is
  // infeasible. Fix-back-9's rule (Δreserved + Δpaid + 2·Δvoided ≥
  // shrink) accepted this: −1 + 1 = 0 ≥ 0. The tight rule rejects it.
  it('rejects a flat-list confirm: paid-cover is not an explanation (H1)', () => {
    const items = listOf(51, 32)
    expect(snapshotAccepts(items, stats(51, 32, 1, 4), prev(51, 1, 5)).ok).toBe(false)
  })

  // Fix-back-10 MF-1 (c): the correct confirm shape — reserved 5 → 4,
  // paid 31 → 32, list grows 51 → 52 as the confirmed row re-enters
  // the list. (Fix-back-9 filed this same shape as "confirm plus a
  // create"; it is a BARE confirm, d = −1 − (−1) = 0 — relabelled here,
  // with a true confirm+create as the next test.)
  it('accepts a legit confirm after reserve: reserved 5 -> 4, paid 31 -> 32, list grows 51 -> 52', () => {
    const items = listOf(52, 32)
    expect(snapshotAccepts(items, stats(52, 32, 1, 4), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // Fix-back-10 MF-1 (c): a TRUE confirm plus a create in the same
  // poll — list 51 → 53 (confirm re-adds one row, the create adds
  // another), paid 31 → 32, reserved 5 → 4. d = −1 − (−2) = 1.
  it('accepts a legit confirm plus a create: list 51 -> 53, paid 31 -> 32', () => {
    const items = listOf(53, 32)
    expect(snapshotAccepts(items, stats(53, 32, 1, 4), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // Fix-back-10 MF-1 (a) H2, voided-2×-cover: a Reserved→Voided row
  // never was in the list, so its voided growth must not buy a unit of
  // shrink. Reserved 5 → 4, voided 1 → 2, shrink 1: Δreserved +
  // Δvoided = 0 < 1 — infeasible. Fix-back-9's rule (2·Δvoided)
  // accepted this: −1 + 2 = 1 ≥ 1. The tight rule rejects it.
  it('rejects a void-of-reserved shrink: voided growth does not buy shrink (H2)', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 2, 4), prev(51, 1, 5)).ok).toBe(false)
  })

  // Fix-back-10 MF-1 (c): the correct void shape — a void OF UNPAID.
  // Reserved untouched (5 → 5), voided 1 → 2, shrink 1: the voided row
  // really left the list, d = 0 + 1 − 1 = 0.
  it('accepts a legit void-of-unpaid: reserved 5 -> 5, voided 1 -> 2, shrink 1', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 2, 5), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // Fix-back-10 MF-1 (c): fix-back-9's mixed expiry+void shape is
  // infeasible — no event vector produces (Δreserved −2, Δvoided +2,
  // shrink 1): d = −2 + 2 − 1 = −1. Two Reserved→Voided rows never
  // touched the list, so they cannot explain a shrink of 1.
  it('rejects the mixed expiry+void shape with two reserved voids: no event vector produces it', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 3, 3), prev(51, 1, 5)).ok).toBe(false)
  })

  // Fix-back-10 MF-1 (c): the correct mixed shape — 1 expiry (reserved
  // 5 → 4, the released row returns to the list) + 2 voids-of-unpaid
  // (voided 1 → 3), shrink 1: d = −1 + 2 − 1 = 0.
  it('accepts a mixed legit expiry + 2 voids-of-unpaid: reserved 5 -> 4, voided 1 -> 3, shrink 1', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 3, 4), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // Fix-back-9 MF-1 (a), negative: a reserved fall with NO explanation
  // — list, paid and voided all unchanged — is still a partial stats
  // scan and is still rejected.
  it('rejects an unexplained reserved fall: reserved 5 -> 4, everything else unchanged', () => {
    const items = listOf(51, 31)
    expect(snapshotAccepts(items, stats(51, 31, 1, 4), prev(51, 1, 5)).ok).toBe(false)
  })

  // Fix-back-9 MF-1 (a): paid has no exit on chain either — a paid
  // fall vs the last accepted snapshot proves the stats scan is partial.
  it('rejects a paid_total fall: paid 31 -> 30 with the list otherwise agreeing', () => {
    const items = listOf(51, 30)
    expect(snapshotAccepts(items, stats(51, 30, 1, 5), prev(51, 1, 5)).ok).toBe(false)
  })

  // Fix-back-8 MF-1: the PURE rule still accepts the adversarial id-50
  // case — prev 51 (voided 1, reserved 5), new 50 items (ids 1..49 + 52:
  // id 51 genuinely reserved, id 52 genuinely created, id 50 dropped by
  // BOTH scans yet still Unpaid) with stats 50/31, voided 1, reserved 6.
  // Counts agree exactly, so the pure layer cannot tell it from a legit
  // reserve. This test PINS that the pure layer alone is insufficient:
  // the fetch layer (below) must reject this pair via per-id
  // verification. If this ever flips to a rejection, the fetch-level
  // test below is testing nothing — update both together.
  it('PURE RULE ONLY: still accepts the adversarial id-50 case (counts agree) — the fetch layer must reject it', () => {
    const items = [...listOf(49, 31), item(52, 'unpaid')]
    expect(snapshotAccepts(items, stats(50, 31, 1, 6), prev(51, 1, 5))).toEqual({ ok: true })
  })

  // MF-4: an empty pair on cold load is rejected — with no previous
  // snapshot there is nothing to distinguish an empty registry from a
  // failed scan, and 0/0 must never render as totals.
  it('rejects an empty pair on cold load — never 0/0 as totals', () => {
    expect(snapshotAccepts([], stats(0, 0, 0, 0)).ok).toBe(false)
    expect(snapshotAccepts([], stats(0, 0, 0, 0), prev(0, 0, 0, 0)).ok).toBe(false)
  })
})

describe('fetchLiveSnapshot', () => {
  it('retries a disagreeing pair and returns the first agreeing one', async () => {
    const { api } = await import('./api')
    const full = listOf(3, 2)
    const partial = [item(1, 'paid')]
    let calls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => {
      calls += 1
      return calls === 1 ? partial : full
    })
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(3, 2))
    const snap = await fetchLiveSnapshot(undefined, 3)
    expect(snap.items).toHaveLength(3)
    expect(calls).toBe(2)
    vi.restoreAllMocks()
  })

  it('throws after the attempts are exhausted, so the caller keeps the last good snapshot', async () => {
    const { api } = await import('./api')
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [item(1, 'paid')])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(51, 31))
    await expect(fetchLiveSnapshot(prev(51), 2)).rejects.toThrow(/disagreed/)
    vi.restoreAllMocks()
  })

  // MF-2: a throw from either endpoint retries in-loop (3 attempts),
  // instead of aborting after 1 call.
  it('retries when an endpoint throws, and succeeds when it recovers', async () => {
    const { api } = await import('./api')
    const full = listOf(3, 2)
    let calls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => {
      calls += 1
      if (calls < 3) throw new Error('invoices 503')
      return full
    })
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(3, 2))
    const snap = await fetchLiveSnapshot(undefined, 3)
    expect(snap.items).toHaveLength(3)
    expect(calls).toBe(3)
    vi.restoreAllMocks()
  })

  it('throws after 3 attempts when an endpoint keeps throwing', async () => {
    const { api } = await import('./api')
    let calls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => {
      calls += 1
      throw new Error('invoices 503')
    })
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(3, 2))
    await expect(fetchLiveSnapshot(undefined, 3)).rejects.toThrow(/disagreed/)
    expect(calls).toBe(3)
    vi.restoreAllMocks()
  })

  // MF-4 at the fetch level: an empty cold-load pair is retried and then
  // throws — the page shows its error state, never 0/0 as totals.
  it('rejects an empty cold-load pair after the attempts are exhausted', async () => {
    const { api } = await import('./api')
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(0, 0, 0, 0))
    await expect(fetchLiveSnapshot(undefined, 2)).rejects.toThrow(/disagreed/)
    vi.restoreAllMocks()
  })

  // MF-1 at the fetch level: a legit reserve shrink is accepted on the
  // first attempt — no freeze, no retry storm. Fix-back-8: the dropped
  // id (51) is verified via GET /api/payables/51 (one call, 'reserved')
  // before the pair is accepted.
  it('accepts a legit reserve shrink without retrying', async () => {
    const { api } = await import('./api')
    let calls = 0
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => {
      calls += 1
      return listOf(50, 31)
    })
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 1, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(50)
    expect(calls).toBe(1)
    expect(verifyCalls).toBe(1)
    vi.restoreAllMocks()
  })

  // Fix-back-8 MF-1: the adversarial harness, replayed end to end. Prev
  // 51 items (ids 1..51, voided 1, reserved 5); the new pair is 50 items
  // (ids 1..49 + 52) with stats 50/31, voided 1, reserved 6 — id 51
  // genuinely reserved, id 52 genuinely created, but id 50 was dropped
  // by BOTH scans while still Unpaid. The count rule passes (net growth
  // 1 == shrink 1), so the pair MUST be rejected by per-id verification
  // (id 50 reads back 'unpaid'), retried, and finally thrown — the kept
  // snapshot survives instead of the id-50-less one.
  it('rejects the adversarial id-50 drop: counts agree but the dropped id still reads unpaid', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [...listOf(49, 31), item(52, 'unpaid')])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 1, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return id === 51
        ? facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
        : facts(id, { kind: 'unpaid' })
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 3)).rejects.toThrow(/disagreed/)
    // Both dropped ids are verified on every attempt (3 attempts × 2 ids).
    expect(verifyCalls).toBe(6)
    vi.restoreAllMocks()
  })

  // Fix-back-8 MF-1 (a): the voided-fall pair is rejected by the pure
  // monotonicity check BEFORE any verification runs — no per-id calls.
  it('rejects the voided-fall pair without any per-id verification calls', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 4, 7))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'unpaid' })
    })
    await expect(fetchLiveSnapshot(prev(51, 5, 5), 2)).rejects.toThrow(/disagreed/)
    expect(verifyCalls).toBe(0)
    vi.restoreAllMocks()
  })

  // Fix-back-8 MF-1: a legit void shrink is accepted when the dropped id
  // reads back with the new {kind:'voided'} facts kind.
  it('accepts a legit void shrink when the dropped id reads back voided', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 2, 5))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'voided' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(50)
    expect(verifyCalls).toBe(1)
    vi.restoreAllMocks()
  })

  // Fix-back-8 MF-1: the same void shrink against the NOT-YET-DEPLOYED
  // API shape — Voided still maps to {kind:'unpaid'} with the truth only
  // in the label. The transitional label fallback accepts it.
  it('accepts a legit void shrink via the transitional label fallback (pre-deploy API shape)', async () => {
    const { api } = await import('./api')
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 2, 5))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => ({
      ...facts(id, { kind: 'unpaid' }),
      label: 'Voided on chain — Lab invoice (testnet, not a real invoice)',
    }))
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(50)
    vi.restoreAllMocks()
  })

  // Fix-back-8 MF-1: a shrink of two rows (one reserve + one void) is
  // accepted only when BOTH dropped ids verify as excluded.
  // Fix-back-9: paid stays 31 in the fixture (see the pure test above).
  it('accepts a reserve+void shrink when both dropped ids verify as excluded', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(49, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(49, 31, 2, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return id === 50
        ? facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
        : facts(id, { kind: 'voided' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(49)
    expect(verifyCalls).toBe(2)
    vi.restoreAllMocks()
  })

  // Fix-back-8 MF-1: a dropped id that reads back 'paid' is still
  // listable — the pair is rejected (a paid row never leaves the list).
  it('rejects a shrink when a dropped id reads back paid', async () => {
    const { api } = await import('./api')
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 1, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) =>
      facts(id, { kind: 'paid', payer: '4MvdMEGC', paid_at: '2026-11-25T10:00:00Z', payment_tx: '00e0', payment_tx_source: 'chain' }),
    )
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 2)).rejects.toThrow(/disagreed/)
    vi.restoreAllMocks()
  })

  // Fix-back-8 MF-1: verification itself failing (the endpoint throws)
  // fails CLOSED — the attempt is rejected, retried, and the fetch
  // throws, so the caller keeps the last good snapshot. It never accepts
  // the shrink unverified.
  it('fails closed when per-id verification itself errors', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 1, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async () => {
      verifyCalls += 1
      throw new Error('payables 503')
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 3)).rejects.toThrow(/disagreed/)
    expect(verifyCalls).toBe(3)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-2: a legit shrink with MORE dropped ids than the old
  // bound is now accepted — verification runs in pages of 10 instead
  // of refusing the shrink unverified. Harness F4: prev 51 → new 40,
  // 11 rows genuinely reserved (reserved 5 → 16), all 11 dropped ids
  // verify as reserved, in 2 pages (10 + 1).
  it('accepts a legit >10 shrink by paging verification (11 dropped ids, 11 calls)', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    // The 11 reserved rows were unpaid rows, so paid stays 31 — a paid
    // fall would reject on its own before verification ever runs.
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(40, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(40, 31, 1, 16))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(40)
    expect(verifyCalls).toBe(11)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-2: a genuinely partial >10 drop is still rejected on
  // first sight — its dropped ids read back 'unpaid' on the FIRST page,
  // so the pair is never accepted, however many polls repeat it.
  it('rejects a partial >10 drop on first sight: a dropped id reads back unpaid on page 1', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    // The 11 reserved rows were unpaid rows, so paid stays 31 — a paid
    // fall would reject on its own before verification ever runs.
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(40, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(40, 31, 1, 16))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return id === 41
        ? facts(id, { kind: 'unpaid' })
        : facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 2)).rejects.toThrow(/disagreed/)
    // Page 1 (10 ids) fails on both attempts; page 2 is never reached.
    expect(verifyCalls).toBe(20)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-2, kept by fix-back-11 MF-1 (a): the adversarial
  // repro — a legit 11-drop shrink on a SLOW host (per-id endpoint at
  // 3 s/page) must HEAL. Under the fix-back-9 whole-round 5 s deadline
  // every attempt hit the deadline (2 pages need ~6 s > 5 s; 33 verify
  // calls over 3 attempts, 18,015 ms, never healed). With the per-page
  // deadline each page gets its own 5 s, so the round heals on attempt
  // 1 in ~6 s — and the fix-back-11 whole-round budget must NOT kill
  // that heal: attempt 1 may spend up to min(5 s × pages, 20 s).
  it('heals a legit 11-drop shrink on a slow host: 3 s/page, 2 pages, ~6 s (MF-2 per-page deadline)', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(40, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(40, 31, 1, 16))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    const start = Date.now()
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    const elapsed = Date.now() - start
    expect(snap.items).toHaveLength(40)
    expect(verifyCalls).toBe(11)
    // Two sequential pages at ~3 s each: ~6 s total. Under the old
    // whole-round deadline this threw after ~18 s instead of healing.
    expect(elapsed).toBeGreaterThan(4000)
    expect(elapsed).toBeLessThan(12000)
    // Fix-back-11 MF-1 (a): the heal lands well inside the 20 s
    // whole-round tick budget — the budget caps later attempts, never
    // attempt 1's heal.
    expect(elapsed).toBeLessThan(VERIFY_TICK_BUDGET_MS)
    vi.restoreAllMocks()
  })

  // Fix-back-11 MF-1 (b): the adversarial judge's measured shape — 11
  // dropped ids, pages answering at 4.9 s/page, verification failing
  // LATE (page 2 reads unpaid, so every attempt re-pays both pages).
  // Under fix-back-10 this blew the poll: 32,492 ms / 33 verify calls.
  // With the 20 s whole-round tick budget, attempt 1 spends ~9.8 s,
  // attempt 2 spends the ~10.2 s that is left, and attempt 3 fails
  // immediately on the exhausted budget (or on a sub-second shortened
  // page deadline) — the tick stays inside the 30 s poll. Real timers:
  // the 15 s default test timeout cannot hold this shape, so the test
  // carries its own 60 s timeout.
  it('caps a fail-late slow host inside the 30 s poll: 4.9 s/page, page 2 unpaid (MF-1 tick budget)', { timeout: 60_000 }, async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(40, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(40, 31, 1, 16))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      await new Promise((resolve) => setTimeout(resolve, 4900))
      return id === 51
        ? facts(id, { kind: 'unpaid' })
        : facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    const start = Date.now()
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 3)).rejects.toThrow(/disagreed/)
    const elapsed = Date.now() - start
    // THE PIN: the old code measured 32,492 ms on this shape. The
    // budget caps verification at 20 s + 3 s backoff ≈ 23 s.
    expect(elapsed).toBeLessThan(30_000)
    // ...and it is genuinely the slow shape, not a fast fail: two
    // full slow attempts ran before the budget ran out.
    expect(elapsed).toBeGreaterThan(15_000)
    // Attempts 1–2 verify both pages (22 calls); attempt 3 starts at
    // most one more page (10 calls) before its shortened deadline
    // fires, or none at all if the budget is already spent — either
    // way strictly fewer than the old code's 33.
    expect(verifyCalls).toBeGreaterThanOrEqual(22)
    expect(verifyCalls).toBeLessThanOrEqual(32)
    vi.restoreAllMocks()
  })

  // Fix-back-11 MF-1 (c): the hung-first-page shape still fails fast.
  // Each attempt dies on page 1 at the 5 s deadline (the budget never
  // binds: 3 × 5 s verification), so the tick is 3 × 5 s + 1 s + 2 s
  // backoff = 18 s — the same bound fix-back-10 stated, now qualified
  // as the hung shape only. Real timers: own 40 s timeout, as above.
  it('still fails fast on a hung first page: 3 attempts x 5 s + backoff = 18 s (MF-1 tick budget)', { timeout: 40_000 }, async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 1, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async () => {
      verifyCalls += 1
      return new Promise<never>(() => {})
    })
    const start = Date.now()
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 3)).rejects.toThrow(/timed out after 5000 ms/)
    const elapsed = Date.now() - start
    expect(elapsed).toBeGreaterThan(15_000)
    expect(elapsed).toBeLessThan(25_000)
    expect(verifyCalls).toBe(3)
    vi.restoreAllMocks()
  })
  // fails closed instead of accepting on the counts alone.
  it('fails closed on a shrink when the previous snapshot carries no id set', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 1, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    await expect(fetchLiveSnapshot({ count: 51, voidedTotal: 1, reservedTotal: 5, paidTotal: 31, ids: [] }, 2)).rejects.toThrow(
      /disagreed/,
    )
    expect(verifyCalls).toBe(0)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-1 (a): a legit expiry is accepted end to end — the
  // released row returns to the list (list 50 → 51), reserved falls
  // 5 → 4, and no dropped id exists to verify (zero verification calls).
  it('accepts a legit expiry: reserved 5 -> 4, list grows 50 -> 51 as the released row returns', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(51, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(51, 31, 1, 4))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    const snap = await fetchLiveSnapshot(prev(50, 1, 5), 3)
    expect(snap.items).toHaveLength(51)
    expect(verifyCalls).toBe(0)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-1 (a) H1 at the fetch level: a flat-list confirm is
  // infeasible (the confirm re-adds the row, so the list must reach 52) and
  // is rejected by the pure rule BEFORE any verification runs — 0
  // verify calls. Fix-back-9 accepted this pair end to end.
  it('rejects a flat-list confirm without any per-id verification calls (H1)', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(51, 32))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(51, 32, 1, 4))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 2)).rejects.toThrow(/disagreed/)
    expect(verifyCalls).toBe(0)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-1 (c): the correct confirm shape end to end — the
  // confirmed row re-enters the list (51 → 52), no id dropped, 0 calls.
  it('accepts a legit confirm after reserve: reserved 5 -> 4, paid 31 -> 32, list grows 51 -> 52', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(52, 32))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(52, 32, 1, 4))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(52)
    expect(verifyCalls).toBe(0)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-1 (c): a true confirm plus a create end to end —
  // list 51 → 53, no id dropped, 0 calls.
  it('accepts a legit confirm plus a create: list 51 -> 53, paid 31 -> 32', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(53, 32))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(53, 32, 1, 4))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(53)
    expect(verifyCalls).toBe(0)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-1 (a) H2 at the fetch level: a void-of-reserved
  // shrink is infeasible (the row never was in the list) and is
  // rejected by the pure rule BEFORE any verification runs — 0 verify
  // calls. Fix-back-9 accepted this pair end to end.
  it('rejects a void-of-reserved shrink without any per-id verification calls (H2)', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 2, 4))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'voided' })
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 2)).rejects.toThrow(/disagreed/)
    expect(verifyCalls).toBe(0)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-1 (c): the correct void shape end to end — a void
  // OF UNPAID. Reserved untouched, voided 1 → 2, shrink 1, the dropped
  // id verifies as voided (1 call).
  it('accepts a legit void-of-unpaid: reserved 5 -> 5, voided 1 -> 2, shrink 1', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 2, 5))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'voided' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(50)
    expect(verifyCalls).toBe(1)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-1 (c): fix-back-9's mixed shape is infeasible — no
  // event vector produces (Δreserved −2, Δvoided +2, shrink 1) — and is
  // rejected by the pure rule BEFORE any verification runs, 0 calls.
  it('rejects the mixed expiry+void shape with two reserved voids without any per-id verification calls', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [...listOf(49, 31), item(52, 'unpaid')])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 3, 3))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'voided' })
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 2)).rejects.toThrow(/disagreed/)
    expect(verifyCalls).toBe(0)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-1 (c): the correct mixed shape end to end — 1 expiry
  // (id 52 is the released row returning to the list) + 2 voids-of-
  // unpaid (ids 50, 51): reserved 5 → 4, voided 1 → 3, shrink 1,
  // 2 dropped ids, 2 verify calls.
  it('accepts a mixed legit expiry + 2 voids-of-unpaid: reserved 5 -> 4, voided 1 -> 3', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [...listOf(49, 31), item(52, 'unpaid')])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 3, 4))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'voided' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(50)
    expect(verifyCalls).toBe(2)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-1 (b): the over-accounted case flips to ACCEPT at
  // the fetch level too — per-id verification arbitrates. 1 reserve +
  // 2 voids-of-unpaid + 2 creates: list 51 → 50 with ids 49/50 voided,
  // id 51 reserved, ids 52/53 created. All three dropped ids verify
  // as excluded (3 calls), so the pair is accepted.
  it('accepts an over-accounted shrink when every dropped id verifies as excluded', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [
      ...listOf(48, 31),
      item(52, 'unpaid'),
      item(53, 'unpaid'),
    ])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 3, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return id === 51
        ? facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
        : facts(id, { kind: 'voided' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(50)
    expect(verifyCalls).toBe(3)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-1 (b): the same over-accounted pair is REJECTED when
  // a dropped id reads back unpaid — per-id verification, not the pure
  // rule, is what arbitrates it.
  it('rejects an over-accounted shrink when a dropped id still reads unpaid', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [
      ...listOf(48, 31),
      item(52, 'unpaid'),
      item(53, 'unpaid'),
    ])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 3, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return id === 49
        ? facts(id, { kind: 'unpaid' })
        : facts(id, { kind: 'voided' })
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 2)).rejects.toThrow(/disagreed/)
    // One page (3 ids) verified on both attempts.
    expect(verifyCalls).toBe(6)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-1 (b): a no-fall create+exclusion burst end to end —
  // 1 create (id 52) + 3 reserves (ids 49, 50, 51): list 51 → 49,
  // reserved 5 → 8, all three dropped ids verify as reserved.
  it('accepts a no-fall create+exclusion burst: 1 create + 3 reserves, list 51 -> 49', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [...listOf(48, 31), item(52, 'unpaid')])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(49, 31, 1, 8))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(49)
    expect(verifyCalls).toBe(3)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-1 (a): the same legit pair is accepted again on the
  // next poll once the previous snapshot has advanced to it — the
  // fix-back-8 freeze (same pair rejected again because prev never
  // advanced) does not recur for a legitimate transition.
  it('accepts the same legit pair again on the next poll once prev has advanced to it', async () => {
    const { api } = await import('./api')
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(51, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(51, 31, 1, 4))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) =>
      facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' }),
    )
    const first = await fetchLiveSnapshot(prev(50, 1, 5), 3)
    expect(first.items).toHaveLength(51)
    const advanced: PrevSnapshot = {
      count: 51,
      voidedTotal: 1,
      reservedTotal: 4,
      paidTotal: 31,
      ids: Array.from({ length: 51 }, (_, i) => i + 1),
    }
    const second = await fetchLiveSnapshot(advanced, 3)
    expect(second.items).toHaveLength(51)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-1 (a), negative: an unexplained reserved fall is
  // rejected by the pure rule BEFORE any verification runs.
  it('rejects an unexplained reserved fall without any per-id verification calls', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(51, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(51, 31, 1, 4))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'unpaid' })
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 2)).rejects.toThrow(/disagreed/)
    expect(verifyCalls).toBe(0)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-1 (b): a same-count swap — id 51 dropped (still
  // Unpaid), id 52 genuinely created, stats unchanged 51/31 — is
  // REJECTED by per-id verification. Fix-back-8 accepted it with
  // verifyCalls = 0 because verification was gated on a net shrink.
  it('rejects a same-count swap: id 51 dropped yet still unpaid, id 52 created', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [...listOf(50, 31), item(52, 'unpaid')])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(51, 31, 1, 5))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'unpaid' })
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 3)).rejects.toThrow(/disagreed/)
    expect(verifyCalls).toBe(3)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-1 (b): a net-GROWTH drop — id 51 dropped (still
  // Unpaid), ids 52 and 53 created — is REJECTED the same way.
  it('rejects a net-growth drop: id 51 dropped yet still unpaid, ids 52+53 created', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [
      ...listOf(50, 31),
      item(52, 'unpaid'),
      item(53, 'unpaid'),
    ])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(52, 31, 1, 5))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'unpaid' })
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 2)).rejects.toThrow(/disagreed/)
    expect(verifyCalls).toBe(2)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-1 (b): the F5 harness case — prev 51; new 51 items
  // (ids 1..49 + 52 + 53): id 50 dropped yet still Unpaid, id 51
  // genuinely reserved, ids 52/53 created; stats 51/31, voided 1,
  // reserved 6. The old gate accepted it with verifyCalls = 0.
  it('rejects the F5 harness case: id 50 dropped yet still unpaid while id 51 reserved', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [
      ...listOf(49, 31),
      item(52, 'unpaid'),
      item(53, 'unpaid'),
    ])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(51, 31, 1, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return id === 51
        ? facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
        : facts(id, { kind: 'unpaid' })
    })
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 3)).rejects.toThrow(/disagreed/)
    expect(verifyCalls).toBe(6)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-3: a per-id endpoint that never answers must fail the
  // attempt FAST — well inside the 30 s poll — instead of stalling it.
  // The mock respects the abort signal exactly as the production
  // getPayable does (request() maps an abort to "The testnet did not
  // answer in time"), so the rejection carries the PRODUCTION wording —
  // the generic per-id failure — not the "timed out after 5000 ms"
  // wording fix-back-9 asserted, which only the signal-ignoring
  // fallback path produces (see the next test).
  it('fails fast when the per-id endpoint never answers (MF-3 deadline, production wording)', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 1, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async (_id: number, init?: RequestInit) => {
      verifyCalls += 1
      return new Promise<never>((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(new Error('The testnet did not answer in time. Showing the last verified data.')),
          { once: true },
        )
      })
    })
    const start = Date.now()
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 1)).rejects.toThrow(
      /could not verify dropped payable 51.*did not answer in time/,
    )
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(8000)
    expect(verifyCalls).toBe(1)
    vi.restoreAllMocks()
  })

  // Fix-back-10 MF-3, fallback path: a read that IGNORES the abort
  // signal and never settles is caught by the page race itself, which
  // resolves with the "timed out after 5000 ms" wording. This is the
  // backstop, not the production path — production reads go through
  // timedFetch, which honours the signal (api.test.ts pins that).
  it('fails fast with the timeout wording when a read ignores the abort signal (MF-3 fallback)', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 1, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async () => {
      verifyCalls += 1
      return new Promise<never>(() => {})
    })
    const start = Date.now()
    await expect(fetchLiveSnapshot(prev(51, 1, 5), 1)).rejects.toThrow(/timed out after 5000 ms/)
    const elapsed = Date.now() - start
    expect(elapsed).toBeLessThan(8000)
    expect(verifyCalls).toBe(1)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-3: the same slow endpoint, once it answers again,
  // heals on the next attempt — the timeout fails the attempt, it does
  // not poison the poll.
  it('heals on retry when the slow per-id endpoint answers again', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 1, 6))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      if (verifyCalls === 1) return new Promise<never>(() => {})
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    const start = Date.now()
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 2)
    const elapsed = Date.now() - start
    expect(snap.items).toHaveLength(50)
    expect(verifyCalls).toBe(2)
    // Attempt 1 times out at 5 s + 1 s backoff, attempt 2 is fast.
    expect(elapsed).toBeLessThan(15000)
    vi.restoreAllMocks()
  })
})
