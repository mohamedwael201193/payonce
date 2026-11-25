// Live snapshot — ONE consistent snapshot per refresh (fix-back-6 B1/B11,
// corrected in fix-back-7 MF-1/MF-4, hardened in fix-back-8 MF-1,
// corrected again in fix-back-9 MF-1 — see the model below).
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
//   2. the list may change only by legitimate on-chain transitions.
//      The API lists only Unpaid|Paid rows (api/src/listable.mjs), and
//      the contract (contracts/payable_registry_v2_1/src/lib.rs) allows
//      exactly these exits from the listable set:
//        Unpaid → Reserved (reserve), Unpaid → Voided (void),
//        Reserved → Paid (confirm_plt — the normal pay flow),
//        Reserved → Unpaid (expire_reservation, after the 3600 s window),
//        Reserved → Voided (void, only after the reservation expires).
//      Fix-back-8's premise — "reserved is terminal on chain" — was
//      FALSE, and it froze the numbers on every legit pay and every
//      legit expiry (round-3 panel, 3 lenses, proven by execution).
//      The transition model, per poll interval, with
//        a = new reserves (Unpaid→Reserved),
//        b_u = voids of Unpaid, b_r = voids of Reserved (only after its
//            expiry — void_payable rejects a Reserved row inside its
//            window with VoidWhileReserved),
//        c = expiries (Reserved→Unpaid), d = creates,
//        e_c = confirms (Reserved→Paid), e_d = direct pays (Unpaid→Paid):
//        Δreserved = a − e_c − c − b_r,
//        Δvoided = b_u + b_r,
//        shrink S = a + b_u − c − e_c − d.
//      Read the three lines exactly: S counts ONLY voids of Unpaid as
//      list exits — a Reserved→Voided row never was in the list — and
//      SUBTRACTS confirms, which re-add a row to the list as Paid; and
//      Δreserved counts confirms ONLY, not all paid growth — a direct
//      pay never touched reserved. (Fix-back-9's derivation got both
//      wrong: its S counted ALL voids as list exits and omitted −e_c,
//      and its Δreserved used all paid growth instead of confirms only.
//      That made its rule strictly looser — see below.)
//      Eliminating a: d = Δreserved + Δvoided − S, with d ≥ 0. So a pair
//      is FEASIBLE iff the TIGHT inequality holds:
//        Δreserved + Δvoided ≥ S.
//      Why the fix-back-9 rule (Δreserved + Δpaid + 2·Δvoided ≥ S) was
//      wrong in BOTH directions of cover: a confirm is NOT list-neutral
//      — reserved −1 and paid +1 cancel in the old sum, so a flat-list
//      confirm (list 51 → 51, reserved 5 → 4, paid 31 → 32) passed, but
//      the confirm re-adds the row, so the list MUST reach 52 and
//      the flat pair is infeasible; and 2·Δvoided double-counts — a
//      Reserved→Voided row contributes +1 to Δvoided but never left the
//      list, so it must not buy a unit of shrink. Brute-force
//      enumeration over all event vectors (0..8, two lenses
//      independently) confirms the tight rule is exact (0 false
//      accepts/rejects modulo pool limits) while the old rule accepts
//      911 infeasible tuples in range.
//      That inequality is the pure check in BOTH regimes (fix-back-10
//      MF-1 (b)): the fix-back-7 exact-equality shrink rule it replaces
//      assumed zero creates, but creates are routine — 1 create + 3
//      reserves (list 51 → 49, reserved 5 → 8) was REJECTED by it, and
//      the enumerator finds 669 achievable no-fall tuples false-rejected,
//      all with d ≥ 1. The over-accounted case (growth 3 > shrink 1)
//      likewise flips to ACCEPT at the pure level — a dropped id reading
//      reserved/voided confirms it, reading unpaid rejects it; per-id
//      verification arbitrates, exactly as it does for the 7 → 5 flip
//      (witness: 1 Unpaid→Voided + 2 Reserved→Voided, d = −2 + 3 − 1 = 0
//      — total rows 59 → 59, so 0 creates, not 2 as fix-back-9 claimed).
//      A fall with NO explanation still rejects (e.g. reserved 5 → 4
//      with list, paid and voided all unchanged: −1 ≥ 0 is false).
//   3. Monotonicity is on VOIDED and PAID only. VOIDED and PAID BOTH
//      have no exit on chain: void_payable rejects Paid and Voided rows
//      with WrongStatus, and no transition leaves Paid (a paid row stays
//      paid and listable), so a fall in either counter vs the last
//      accepted snapshot proves the stats scan itself is partial — the
//      adversarial harness case (voided 5 → 4, reserved +2, net growth
//      1 == shrink 1) is still rejected here, with ZERO verification
//      calls.
//   4. FIX-BACK-9 MF-1 (b): per-id verification runs whenever a dropped
//      id exists — NOT only on a net shrink. Fix-back-8 gated it on
//      `items.length < prev.count`, so a same-count swap (drop id 51,
//      create id 52) and a net-growth drop (drop 1, create 2) were
//      ACCEPTED with verifyCalls = 0. Now: dropped = prev.ids − newIds,
//      and ANY non-empty dropped set is verified before the pair is
//      accepted, whatever the net list length. This is the layer that
//      closes the id-50 hole (a new id in the list does not excuse a
//      dropped one) and the F5 harness case.
//   5. FIX-BACK-9 MF-2: verification is paged, not bounded-then-frozen.
//      Fix-back-8 rejected ANY shrink with more than MAX_DROPPED_VERIFY
//      (10) dropped ids unverified, with no in-app heal — a legit
//      11-row reserve froze the numbers until a cold load. Now dropped
//      ids are verified in pages of 10, in order, however many there
//      are (the total is bounded by the previous list size). A partial
//      scan is still rejected on first sight: its dropped ids read back
//      'unpaid'/'paid' and fail the FIRST page. A persistent partial
//      scan NEVER heals this way — it fails verification on every poll —
//      which a "same pair twice, then accept" rule would NOT guarantee.
//   6. FIX-BACK-10 MF-2: the verification deadline is PER PAGE, not per
//      round. Fix-back-9's whole-round 5 s deadline never healed a legit
//      >10 shrink on a slow host: 11 dropped ids at 3 s/page need ~6 s
//      for 2 pages, so EVERY attempt hit the deadline (33 verify calls
//      over 3 attempts, 18,015 ms, never healed) — the same freeze shape
//      as fix-back-8. Now each page races its own VERIFY_PAGE_TIMEOUT_MS
//      (5 s), so that shrink heals on attempt 1 in ~6 s. Worst case per
//      poll tick: a HUNG endpoint fails each attempt on the FIRST page
//      (5 s), so 3 attempts + 1 s + 2 s backoff = 18 s < 30 s (MF-4:
//      retry: 0 in useLiveSnapshot, so one tick is one queryFn). A
//      slow-but-answering host heals on attempt 1, so the multi-page
//      worst case (5 s × pages) is paid once, on the attempt that
//      succeeds. There is deliberately NO whole-round cap: one would
//      reintroduce the MF-2 freeze for large legit drops.
//   7. FIX-BACK-9 MF-3: verification has its own deadline. The round
//      previously awaited unbounded per-id reads (each with the 15 s
//      fetch timeout plus request retries, × 3 attempts × react-query
//      retry 1 — worst ≈ 48 s per queryFn call, past the 30 s poll).
//      The per-page deadline (rule 6) aborts the in-flight per-id reads;
//      a slow endpoint fails THAT attempt fast, the retry loop runs, and
//      a recovered endpoint heals normally. In production the abort
//      surfaces as the generic per-id failure ("The testnet did not
//      answer in time") — the "timed out after 5000 ms" wording is only
//      the fallback when a read ignores the abort signal (see the MF-3
//      tests).
//   8. an EMPTY pair on cold load is rejected: with no previous snapshot
//      there is nothing to distinguish an empty registry from a failed
//      scan, so 0/0 is never rendered as totals — the fetch throws and
//      the page shows its error state. NOTE (fix-back-8 S3): this rejects
//      ANY empty list on cold load, even when stats reports voided /
//      reserved > 0 — a legitimately fully-excluded registry would show
//      the error state, not 0/0. That is fail-closed, not wrong numbers,
//      and that state does not exist live (the registry holds listable
//      rows); a future reader must NOT "fix" this into accepting 0/0.
//   9. a rejected pair — or a throw from either endpoint — is retried
//      (fresh pair, up to 3 attempts); if it never agrees, the fetch
//      THROWS, so react-query keeps the last good snapshot. On a first
//      load with no previous snapshot, a throw means the error state —
//      never a partial render.
// Honest limit (MF-4): a coincidental partial pair on cold load — e.g.
// 8 items with stats 8/5 and no previous snapshot — still passes this
// rule: with nothing to compare against, the frontend cannot tell it
// from a small-but-real registry (and per-id verification needs a
// previous id set, so it cannot run on cold load either). That case
// closes only when the API fail-closed layer deploys (incomplete scan →
// 503, never a partial 200); the frontend alone cannot close it, and
// this file does not claim otherwise.
// Nothing here invents a number: acceptance only ever keeps or replaces
// with a server-provided pair that agrees with itself.
import { ApiError } from './types'
import type { InvoiceItem, Stats } from './types'
import { api } from './api'

export interface LiveSnapshot {
  items: InvoiceItem[]
  stats: Stats
}

/** What the last accepted snapshot looked like — the shrink rule compares
    the new pair against this, not just against a bare count. `ids` is the
    previous list's payable ids: the per-id verification layer (fix-back-8
    MF-1) needs to know exactly which rows dropped, and a count alone
    cannot say that. `paidTotal` is the previous stats paid_total:
    paid monotonicity (rule 3) needs it — a paid fall proves the stats
    scan is partial. (Fix-back-9 threaded it for the feasibility check
    too; fix-back-10's tight rule does not use paid growth — a confirm
    is a reserved fall plus a list re-add, and an expiry explains the
    same fall with no paid growth — so paidTotal stays only for
    monotonicity.) */
export interface PrevSnapshot {
  count: number
  voidedTotal: number
  reservedTotal: number
  paidTotal: number
  ids: number[]
}

export const EMPTY_PREV: PrevSnapshot = { count: 0, voidedTotal: 0, reservedTotal: 0, paidTotal: 0, ids: [] }

/** Dropped ids verified per page (fix-back-9 MF-2). Was a hard bound in
    fix-back-8: any shrink with more dropped ids than this was rejected
    unverified, with no heal. Now it is only the page size — verification
    runs page by page however many dropped ids there are, so a legit
    >10-row shrink heals on the same poll instead of freezing until a
    cold load, while a partial scan still fails on the first page. */
export const MAX_DROPPED_VERIFY = 10

/** Deadline for ONE verification page (fix-back-10 MF-2 — was a
    whole-round deadline in fix-back-9, which never healed a legit >10
    shrink on a slow host: 2 pages at 3 s/page need ~6 s > 5 s). Each
    page of up to MAX_DROPPED_VERIFY parallel per-id reads races its own
    5 s deadline (see verifyDroppedIds): a hung page fails THAT page in
    5 s, a slow-but-answering host heals page by page. 5 s is ~5× the
    normal per-page latency (well under 1 s on the same host that just
    served the list+stats pair). Worst case for the verification
    component is 3 attempts × 5 s (hung first page) + 3 s backoff =
    18 s, versus ≈48 s unbounded before fix-back-9. */
export const VERIFY_PAGE_TIMEOUT_MS = 5_000

export type SnapshotRejection = { ok: false; reason: string }

/** Pure acceptance rule for one (list, stats) pair against the last
    accepted snapshot. NOTE: this is only the pure layer of the shrink
    rule — the count rule plus monotonicity plus the feasibility check.
    A pair that passes here can STILL be a partial scan (the id-50 case:
    counts agree exactly while a still-listable row is missing); the per-id
    verification in fetchLiveSnapshot is what closes that hole. Do not
    call this "the" acceptance check on its own. */
export function snapshotAccepts(
  items: InvoiceItem[],
  stats: Stats,
  prev: PrevSnapshot = EMPTY_PREV,
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
  // MF-4: an empty pair on cold load is not a snapshot — with no previous
  // snapshot there is nothing to distinguish an empty registry from a
  // failed scan, and 0/0 must never render as totals. (S3: this rejects
  // ANY empty list on cold load, even when stats reports voided/reserved
  // > 0 — fail-closed, not wrong numbers; see the header.)
  if (items.length === 0 && prev.count === 0) {
    return {
      ok: false,
      reason: 'empty pair on cold load — cannot tell an empty registry from a failed scan, so 0/0 is never rendered as totals',
    }
  }
  // Fix-back-9 MF-1 (a): monotonicity is on VOIDED and PAID only.
  // Voided has no exit on chain and Paid has none either, so a DECREASE
  // in either counter vs the last accepted snapshot proves the stats
  // scan itself is partial, whatever the net growth says. RESERVED is
  // NOT monotonic: confirm_plt (Reserved → Paid), expire_reservation
  // (Reserved → Unpaid) and void (Reserved → Voided) all lower it
  // legitimately — fix-back-8 rejected those transitions and froze the
  // numbers on every pay and every expiry. A reserved fall is governed
  // by the feasibility check below instead.
  const voidedNow = stats.voided_total ?? 0
  const reservedNow = stats.reserved_total ?? 0
  const paidNow = stats.paid_total
  if (voidedNow < prev.voidedTotal || paidNow < prev.paidTotal) {
    return {
      ok: false,
      reason: `voided/paid totals fell vs the last accepted snapshot (voided ${prev.voidedTotal} -> ${voidedNow}, paid ${prev.paidTotal} -> ${paidNow}) — voided and paid have no exit on chain, so the stats scan is partial`,
    }
  }
  const shrink = prev.count - items.length
  // Fix-back-10 MF-1 (a)+(b): the TIGHT feasibility check, in BOTH
  // regimes — no reserved-fall / no-fall split any more. With the
  // transition model (header rule 2), d = Δreserved + Δvoided − shrink
  // is the number of creates the pair REQUIRES, so the pair is feasible
  // iff Δreserved + Δvoided ≥ shrink. The old no-fall exact-equality
  // rule (excluded growth === shrink) assumed zero creates and rejected
  // e.g. 1 create + 3 reserves (list 51 → 49, reserved 5 → 8); the old
  // fall-branch rule (Δreserved + Δpaid + 2·Δvoided ≥ shrink) treated a
  // confirm as list-neutral and double-counted voided growth. Both are
  // replaced by this one inequality; per-id verification (rule 4) still
  // arbitrates every dropped id afterwards.
  if (reservedNow - prev.reservedTotal + (voidedNow - prev.voidedTotal) < shrink) {
    return {
      ok: false,
      reason: `list shrank ${prev.count} -> ${items.length} (shrink ${shrink}) but reserved+voided grew by only ${reservedNow - prev.reservedTotal + (voidedNow - prev.voidedTotal)} — no event vector produces that pair, so the stats scan is partial`,
    }
  }
  return { ok: true }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/** Fix-back-9 MF-1 (b) + MF-2 + MF-3, corrected fix-back-10 MF-2: verify
    every dropped id is genuinely excluded from the listable set.
    `dropped` is prev-ids minus new-ids — its size is the shrink PLUS
    any rows created since the last snapshot (a new id in the list does
    not excuse a dropped one). Each dropped id is read back via GET
    /api/payables/:id and must come back 'reserved' or 'voided'. Anything
    else — 'unpaid'/'paid' (a row the scans lost), a 404, a throw, a
    malformed body — fails CLOSED: the whole pair is rejected, never
    accepted on a partial verification. Verification runs in pages of
    MAX_DROPPED_VERIFY (MF-2), however many dropped ids there are, and
    EACH page races its own VERIFY_PAGE_TIMEOUT_MS deadline (fix-back-10
    MF-2 — the fix-back-9 whole-round deadline never healed a legit >10
    shrink on a slow host, because 2 pages at 3 s/page need ~6 s > 5 s):
    on a page timeout the in-flight reads are aborted and THAT page —
    hence the attempt — fails fast instead of stalling the poll. In
    production the abort surfaces as the generic per-id failure ("The
    testnet did not answer in time"); the "timed out after 5000 ms"
    reason below is only the fallback for a read that ignores the abort
    signal and never settles. */
async function verifyDroppedIds(dropped: number[]): Promise<{ ok: true } | SnapshotRejection> {
  const pages = Math.ceil(dropped.length / MAX_DROPPED_VERIFY)
  for (let pageIndex = 0; pageIndex < pages; pageIndex++) {
    const page = dropped.slice(pageIndex * MAX_DROPPED_VERIFY, (pageIndex + 1) * MAX_DROPPED_VERIFY)
    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), VERIFY_PAGE_TIMEOUT_MS)
    const verifyOne = async (id: number) => {
      try {
        const facts = await api.getPayable(id, { signal: controller.signal })
        // Transitional label fallback (see header): the deployed API still
        // maps Voided to {kind:'unpaid'} with the truth only in the label.
        // Delete the label branch once the API deploys {kind:'voided'}.
        const excluded =
          facts.status.kind === 'reserved' ||
          facts.status.kind === 'voided' ||
          (facts.status.kind === 'unpaid' && facts.label.startsWith('Voided on chain'))
        return excluded
          ? { id, ok: true as const }
          : { id, ok: false as const, reason: `dropped payable ${id} still reads '${facts.status.kind}' on GET /api/payables/${id} — it is still listable, so the scans lost a row` }
      } catch (e) {
        // A timeout abort lands here too (AbortError): the page already
        // failed fast on the deadline, and this attempt fails closed.
        return {
          id,
          ok: false as const,
          reason: `could not verify dropped payable ${id} (GET /api/payables/${id} failed: ${e instanceof Error ? e.message : 'unknown error'}) — failing closed rather than accepting the shrink unverified`,
        }
      }
    }
    try {
      const pageResult = await Promise.race([
        Promise.all(page.map(verifyOne)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), VERIFY_PAGE_TIMEOUT_MS)),
      ])
      if (pageResult === null) {
        return {
          ok: false,
          reason: `per-id verification timed out after ${VERIFY_PAGE_TIMEOUT_MS} ms on page ${pageIndex + 1} of ${pages} with ${dropped.length} dropped ids to check — failing closed rather than accepting the pair unverified`,
        }
      }
      const failed = pageResult.find((r) => !r.ok)
      if (failed && !failed.ok) return { ok: false, reason: failed.reason }
      if (controller.signal.aborted) {
        return {
          ok: false,
          reason: `per-id verification timed out after ${VERIFY_PAGE_TIMEOUT_MS} ms on page ${pageIndex + 1} of ${pages} with ${dropped.length} dropped ids to check — failing closed rather than accepting the pair unverified`,
        }
      }
    } finally {
      clearTimeout(timeout)
    }
  }
  return { ok: true }
}

/** Fetch one consistent (list, stats) pair. Retries a disagreeing pair —
    and a throw from either endpoint (MF-2) — so a transient partial scan
    or a 503 never reaches the screen. Throws after the attempts are
    exhausted — the caller (react-query) then keeps the last good snapshot.
    On a pair whose dropped-id set is non-empty, every dropped id is
    verified (fix-back-9 MF-1 (b)) before the pair is accepted, whatever
    the net list length; a failed verification rejects the attempt exactly
    like a disagreeing pair. */
export async function fetchLiveSnapshot(prev: PrevSnapshot = EMPTY_PREV, attempts = 3): Promise<LiveSnapshot> {
  let lastReason = 'the live numbers disagreed just now'
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const [items, stats] = await Promise.all([api.getInvoices(), api.getStats()])
      const check = snapshotAccepts(items, stats, prev)
      if (check.ok) {
        // Fix-back-9 MF-1 (b): verify the dropped ids whenever ANY exist
        // — a same-count swap or a net-growth drop hides a lost row just
        // as a shrink does. Without a previous id set there is nothing
        // to verify against, so any pair after a non-empty previous
        // snapshot that carries no id set fails closed.
        if (prev.count > 0 && prev.ids.length !== prev.count) {
          lastReason =
            'the previous snapshot carried no id set to verify the dropped rows against — failing closed rather than accepting the pair unverified'
        } else {
          const newIds = new Set(items.map((i) => i.payable_id))
          const dropped = prev.ids.filter((id) => !newIds.has(id))
          if (dropped.length === 0) return { items, stats }
          const verified = await verifyDroppedIds(dropped)
          if (verified.ok) return { items, stats }
          lastReason = verified.reason
        }
      } else {
        lastReason = check.reason
      }
    } catch (e) {
      // MF-2: a throw from either endpoint used to abort after 1 call,
      // not 3 attempts — the exact failure the API's 503-on-partial-scan
      // fix introduces got zero in-loop retries.
      lastReason = `fetch failed (${e instanceof Error ? e.message : 'unknown error'})`
    }
    if (attempt < attempts - 1) await sleep(1000 * (attempt + 1))
  }
  throw new ApiError(0, {
    code: 'chain_unreachable',
    layer: 'server',
    message: `The live numbers disagreed just now (${lastReason}). Showing the last verified numbers.`,
    retryable: true,
  })
}
