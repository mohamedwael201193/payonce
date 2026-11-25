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
import { fetchLiveSnapshot, snapshotAccepts, type PrevSnapshot } from './snapshot'
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

  // MF-1, negative: a shrink SMALLER than the excluded growth is also
  // inconsistent (rows cannot leave the list without leaving the count).
  it('rejects a shrink smaller than the voided/reserved growth', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 3, 6), prev(51, 1, 5)).ok).toBe(false)
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
  // (3 voids, 2 of them Reserved→Voided, 2 creates: list 51 − 3 + 2 =
  // 50, reserved 7 − 2 = 5, voided 1 + 3 = 4), so the pure rule must
  // not reject it. Per-id verification guards the dropped rows instead
  // (fetch level below); a fall with NO explanation still rejects.
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

  it('accepts a legit confirm after reserve: reserved 5 -> 4, paid 31 -> 32, list unchanged', () => {
    const items = listOf(51, 32)
    expect(snapshotAccepts(items, stats(51, 32, 1, 4), prev(51, 1, 5))).toEqual({ ok: true })
  })

  it('accepts a legit confirm plus a create in the same poll: list 51 -> 52, paid 31 -> 32', () => {
    const items = listOf(52, 32)
    expect(snapshotAccepts(items, stats(52, 32, 1, 4), prev(51, 1, 5))).toEqual({ ok: true })
  })

  it('accepts a legit void-of-reserved: reserved 5 -> 4, voided 1 -> 2, shrink 1', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 2, 4), prev(51, 1, 5))).toEqual({ ok: true })
  })

  it('accepts a mixed legit expiry+void: reserved 5 -> 3, voided 1 -> 3, shrink 1', () => {
    const items = listOf(50, 31)
    expect(snapshotAccepts(items, stats(50, 31, 3, 3), prev(51, 1, 5))).toEqual({ ok: true })
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

  // Fix-back-8 MF-1: a shrink with no previous id set to verify against
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

  // Fix-back-9 MF-1 (a): a legit confirm after reserve is accepted end
  // to end — reserved falls 5 → 4, paid rises 31 → 32, the list is
  // unchanged in size and no id dropped.
  it('accepts a legit confirm after reserve: reserved 5 -> 4, paid 31 -> 32', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(51, 32))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(51, 32, 1, 4))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'reserved', payer: '4MvdMEGC', expires: '2026-11-25T12:00:00Z' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(51)
    expect(verifyCalls).toBe(0)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-1 (a): a legit void-of-reserved is accepted — the
  // dropped id verifies as voided (reserved falls AND voided rises).
  it('accepts a legit void-of-reserved: reserved 5 -> 4, voided 1 -> 2', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => listOf(50, 31))
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 2, 4))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'voided' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(50)
    expect(verifyCalls).toBe(1)
    vi.restoreAllMocks()
  })

  // Fix-back-9 MF-1 (a): a mixed legit expiry+void is accepted — two
  // rows voided (ids 50, 51) and one released row returning (id 52).
  it('accepts a mixed legit expiry+void: reserved 5 -> 3, voided 1 -> 3', async () => {
    const { api } = await import('./api')
    let verifyCalls = 0
    vi.spyOn(api, 'getInvoices').mockImplementation(async () => [...listOf(49, 31), item(52, 'unpaid')])
    vi.spyOn(api, 'getStats').mockImplementation(async () => stats(50, 31, 3, 3))
    vi.spyOn(api, 'getPayable').mockImplementation(async (id: number) => {
      verifyCalls += 1
      return facts(id, { kind: 'voided' })
    })
    const snap = await fetchLiveSnapshot(prev(51, 1, 5), 3)
    expect(snap.items).toHaveLength(50)
    expect(verifyCalls).toBe(2)
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

  // Fix-back-9 MF-3: a per-id endpoint that never answers must fail the
  // attempt FAST — well inside the 30 s poll — instead of stalling it.
  // The mock never resolves, so without the deadline this attempt would
  // hang until the 15 s fetch timeout (and worse across retries).
  it('fails fast when the per-id endpoint never answers (MF-3 deadline)', async () => {
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
