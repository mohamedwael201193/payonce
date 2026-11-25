# Fix-back-9 evidence — PayOnce landing redesign (fix-back-8 c669432 → fix-back-9)

Date: 2026-11-25 ~09:25–09:50 UTC. Builder: fix-back-9 subagent. One local commit on
top of `c669432`. No push, no deploy, no merge. Pay never pressed; testnet only.

Fix-back-8 went 0/3: compliance NOT SIGN-OFF (2 must-fixes), honesty NOT SIGN-OFF
(1 must-fix), adversarial NOT SIGN-OFF (5 must-fixes). This patch fixes the
consolidated MF-1–MF-4 list below. The three lenses converged on MF-1 — the two
sub-fixes are one fix, not two items.

## Per-item fix + verification

- **MF-1 (a) (BLOCKER, all three lenses) — reserved is NOT terminal on chain.**
  Verified in the contract first (`contracts/payable_registry_v2_1/src/lib.rs`):
  `confirm_plt` requires `Status::Reserved` and sets `Status::Paid`;
  `expire_reservation` requires `Status::Reserved` past its expiry and sets
  `Status::Unpaid`; `void_payable` maps `Unpaid → Voided` and
  `Reserved → Voided` (only after expiry — `VoidWhileReserved` before it).
  Only `Voided` has no exit (`Paid`/`Voided → WrongStatus`). The fix-back-8
  comment and rejection string claiming reserved is "terminal" were false,
  and they froze the numbers on every legit pay and every legit expiry.
  - Pure rule (`frontend/src/lib/snapshot.ts`, `snapshotAccepts`):
    monotonicity is now on `voided_total` AND `paid_total` only (paid has
    no exit either — a paid row stays paid and listable; `PrevSnapshot`
    gains `paidTotal`, threaded from the cached snapshot's `stats.paid_total`
    in `useLiveSnapshot`). A reserved fall is governed by the feasibility
    check derived from the transition model (header rule 2): with
    a = new reserves, b = voids, b_r = Reserved→Voided, c = expiries,
    d = creates, e = paid growth (confirms + direct Unpaid→Paid pays —
    paid growth is an UPPER bound on confirms, so the inequality stays a
    sound necessary condition either way), the observables satisfy
    d = Δreserved + Δpaid + Δvoided + b_r − shrink, so a pair is feasible
    iff **Δreserved + Δpaid + 2·Δvoided ≥ shrink**. List growth explains a
    release, paid growth a confirm, voided growth a void-of-reserved; a
    fall with none of those is still rejected as a partial stats scan.
    When reserved did NOT fall, the tighter fix-back-7 exact-equality
    shrink rule is kept (see "Not regressed" — the over-accounted case).
  - The pinned test `rejects a shrink whose net growth hides a reserved_total
    fall (7 -> 5)` is FIXED, not kept: the pair IS explainable (3 voids, 2
    of them Reserved→Voided, 2 creates), so the pure rule now accepts it and
    per-id verification guards the dropped rows instead. The old invariant
    is documented as wrong in the test comment and the file header.
  - Two fixture corrections the new paid-monotonicity rule caught: the
    reserve+void fixtures (pure + fetch) had paid 31 → 30, which is itself
    a partial-scan signal (a paid row never leaves the list) — now
    listOf(49, 31); the MF-2 fixtures had paid 31 → 25 for the same reason
    (see MF-2). Both are pinned separately now (paid-fall rejection test).
  - Tests (`snapshot.test.ts`, pure +7): legit expiry (reserved 5→4, list
    50→51), legit confirm (reserved 5→4, paid 31→32, list unchanged),
    legit confirm+create (list 51→52, paid 31→32 — the judges' shape),
    legit void-of-reserved (reserved 5→4, voided 1→2, shrink 1), mixed
    expiry+void (reserved 5→3, voided 1→3, shrink 1), unexplained reserved
    fall rejected, paid fall rejected; plus the flipped 7→5 test (now
    accepts). Fetch +6: expiry / confirm / void-of-reserved / mixed
    expiry+void accepted end to end (0/0/1/2 verify calls respectively),
    same legit pair accepted again on the next poll once prev advanced
    (the fix-back-8 freeze cannot recur for a legit transition),
    unexplained reserved fall rejected with ZERO verify calls.
  - Held: voided 5→4 still rejected with 0 verify calls (control — Voided
    IS terminal); over-accounted shrink still rejected (no-fall regime).

- **MF-1 (b) (BLOCKER, all three lenses) — per-id verification gated on net shrink.**
  `fetchLiveSnapshot` now computes `dropped = prev.ids − newIds` on EVERY
  pair and verifies whenever the set is non-empty, whatever the net list
  length. The old `items.length < prev.count` gate is gone. A previous
  snapshot with `count > 0` but no matching id set still fails closed
  (now for any pair, not only shrinks — without an id set a same-count
  swap is unverifiable too). Cold load is unaffected (`prev.ids` is `[]`,
  so `dropped` is `[]`).
  - Tests (fetch +3): same-count swap (drop 51 still Unpaid, create 52,
    stats unchanged 51/31) REJECTED, verifyCalls = 3; net-growth-with-drop
    (drop 51, create 52+53) REJECTED, verifyCalls = 2; the F5 harness case
    (drop 50 still Unpaid + reserve 51 + create 52/53, stats 51/31, voided
    1, reserved 6) REJECTED, verifyCalls = 6. All three were ACCEPTED with
    verifyCalls = 0 under fix-back-8.
  - Held, not broken: id-50 rejection (6 calls = 3 attempts × 2 ids);
    dropped-id-reads-paid rejected; dropped-id 404 / verification-error
    fail-closed (3 calls then throw); no-id-set shrink fails closed with
    0 calls; first-shrink-after-load id threading.

- **MF-2 (adversarial #3, NEW) — >10 legit shrink freezes with no in-app heal.**
  HEALING-PATH DESIGN (flagged explicitly, as instructed): verification
  pages in 10s instead of refusing. `MAX_DROPPED_VERIFY` (10) is now the
  PAGE SIZE, not a hard bound — `verifyDroppedIds` walks the dropped set
  page by page, however many dropped ids there are (the total is bounded
  by the previous list size). I chose paging over the alternative in the
  brief ("accept a >10-drop pair identical across two consecutive polls")
  deliberately: a persistent PARTIAL scan presents the same pair on every
  poll, so two-poll acceptance would heal WRONG numbers after two polls —
  it trades one freeze for a hole the adversarial lens would (rightly)
  re-open. Paging has no such hole: a partial >10 drop fails on the FIRST
  page (its dropped ids read back 'unpaid'/'paid'), on first sight and on
  every poll thereafter, while a legit >10 shrink verifies and heals on
  the SAME poll. The fail-closed property for a one-off partial >10 drop
  is therefore kept exactly, and the legit case heals faster than the
  two-poll design would.
  - Tests (fetch +2, replacing the old `rejects a shrink larger than the
    verification bound without verifying` test): F4 harness shape — prev
    51 → new 40, 11 rows genuinely reserved (reserved 5→16) — ACCEPTED,
    verifyCalls = 11 (2 pages, 10+1); partial >10 drop (id 41 still
    Unpaid) REJECTED on first sight, verifyCalls = 20 (page 1 fails on
    both attempts; page 2 never reached).

- **MF-3 (minor, adversarial #4) — verification can stall the poll past the 30 s budget.**
  DEADLINE VALUE (flagged explicitly, as instructed): **VERIFY_TIMEOUT_MS
  = 5_000 ms** for the WHOLE verification round. Per-id reads go to the
  same API host that just served the list+stats pair, normally in well
  under 1 s for a parallel page; 5 s is ~5× that headroom and 6× inside
  the 30 s poll budget. Worst case for the verification component is now
  3 attempts × 5 s + 3 s backoff = 18 s, versus ≈48 s unbounded before.
  The deadline is enforced two ways: the round races a 5 s timer, AND the
  timer aborts an `AbortController` whose signal is threaded through
  `api.getPayable(id, {signal})` → `request(..., init)` →
  `timedFetch`, which combines it with the 15 s fetch timeout via
  `AbortSignal.any` (guarded for runtimes without it), so in-flight reads
  really cancel instead of lingering in the background — including inside
  `request()`'s retry loop, where a timeout abort throws at once (no
  retry on timeout). A timed-out attempt fails closed like any other
  disagreement; the retry loop runs and a recovered endpoint heals.
  - Tests (fetch +2, real timers): a never-answering per-id endpoint fails
    the attempt in ~5.0 s (asserted < 8 s, message names the 5 s timeout),
    1 verify call, attempts = 1; a slow-then-answering endpoint (first
    call never resolves, second answers at once) heals on attempt 2 in
    ~6 s (asserted < 15 s), 2 verify calls.

- **MF-4 (minor, adversarial #5) — API `{kind:'voided'}` mapping has no offline test.**
  `api/src/server.mjs`: `handleGetPayable`'s read now goes through the S5
  seam (`readPayableWithRetry`, the same seam the stats/invoices handlers
  use) — a read failing all 3 retries is a 503 `chain_unreachable`
  (retryable) instead of propagating to a 500, and a null view is still
  the same 404. Export line is now
  `export { server, handleStats, handleInvoices, handleGetPayable, payableFacts }`.
  The live-chain path is unchanged when no override is set
  (`readPayableWithRetry` calls `getPayableOrNull` exactly as before).
  - Tests (new file `api/test/handlers-payable.test.mjs`, 7/7): direct
    `payableFacts` mapping for all four kinds — Voided →
    `{kind:'voided'}` + label `startsWith('Voided on chain')`, Unpaid →
    `{kind:'unpaid'}` (label NOT voided), Reserved → `{kind:'reserved'}`
    with payer + expires, Paid → `{kind:'paid'}` with payer + paid_at;
    `handleGetPayable` offline branches — stubbed reader returning null
    → 404 `not_found`, stubbed reader throwing on all retries → 503
    `chain_unreachable` (retryable); cleanup test removes the stub.
  - Honest limit (stated, not hidden): the `handleGetPayable` 200 path is
    NOT exercised offline — after the stubbed read it calls `chainNow`,
    which needs the live chain. The mapping itself is covered by the
    direct `payableFacts` tests and the handler by its two offline
    branches. `payableFacts` still has exactly one consumer
    (`handleGetPayable`, `server.mjs:425`); the export adds none.

## Gates (my own runs, 2026-11-25 ~09:25–09:50 UTC)

- `npx tsc -b` (from `frontend/`) — clean. `tsc --noEmit -p tsconfig.json` —
  clean. (Verified again: this repo has NO `tsconfig.app.json` and no root
  tsconfig — only `frontend/tsconfig.json`; a bare `npx tsc` at the repo
  root resolves to the unrelated npm `tsc@2.0.4` package — do not use it.)
- Frontend vitest — **228/228 (23 files), TWICE in a row** (run 1: 61.86 s,
  run 2: 96.98 s), up from 209/209 (+19 new tests: snapshot +19 — pure +7
  and fetch +12; the >10-bound rejection test was replaced by the MF-2
  paging-accept test, net 0). Snapshot file alone: 47/47 (41.06 s).
- `vite build` ×2 — identical: `assets/index-BpaXc6RM.js`, 547.98 kB
  (547,977 B, gzip 163.55 kB), sha256
  `9fd3ddf5706753c49895b678f83b5469912c76580e8aac8cd258fce195f35fd2`;
  CSS `index-BfgKWpQD.css` 50.21 kB, sha256
  `1805692b7f9e1a5ccfce9dcddc89793839ff7ea737de8e6ea697ab7a0697a9c0`
  (unchanged from fix-back-8 — no CSS changed). Build 1: 30.29 s, build 2:
  12.38 s.
- API tests (combined run, 11.58 s) from a fresh `/tmp/fb9-api` copy of the
  patched `api/` with node_modules symlinked read-only to the existing
  `/home/hatch/workspace/payonce-fb3-merge/api/node_modules` install and
  `PAYONCE_BACKEND_DIR=~/workspace/payonce-build/backend` (the work-tree
  backend, which has `@concordium/web-sdk` installed — the in-tree
  `backend/` has no node_modules, so pointing at it fails module
  resolution; `api/node_modules` in-tree is still absent, home quota
  still tight — do not `npm ci` in-tree):
  `node --test test/stats-reconcile.test.mjs test/handlers-stats.test.mjs test/handlers-payable.test.mjs`
  — **15/15** (stats-reconcile 3/3, handlers-stats 5/5, handlers-payable
  7/7).
- Secrets scan of the diff + the new untracked test file — 0 genuine hits.
  No `password|seed|private key|bearer|api key|secret` matches; no long
  hex values. The only `token` line is the public on-chain agent id
  `agentToken: '1476'` in the new test's view fixture (a small integer
  identifier already in the repo's fixtures and README, not a credential).
  `git diff --check` clean.
- README gate numbers updated from these runs only.

## Environment incidents (EDQUOT, stated plainly)

Home quota hit three times during this run (errno -122, `Disk quota
exceeded`): once writing vitest's results cache, once loading the vitest
config, once loading the vite config for the build. The quota flaps —
writes fail, then succeed minutes later — and `~/workspace/payonce-build`
measures 24G. I freed headroom only from MY OWN regenerable files, never
another agent's tree: the patch tree's `frontend/dist/` (4.9M, rebuilt
twice for the gates afterwards) and the npm cache (`npm cache clean
--force`, 51M → 12M). The 700M `~/.cache/ms-playwright` shared browser
cache was left alone. No test result above depends on the quota: every
gate number is from a run that completed with exit 0 after headroom was
restored.

## Honest limits (not claimed fixed)

- Cold-load coincidental partial pair (e.g. 8 items with stats 8/5, no
  previous snapshot) still passes — per-id verification needs a previous
  id set, so it cannot run on cold load either. Closes only when the API
  fail-closed layer deploys (incomplete scan → 503, never a partial 200).
- The API `{kind:'voided'}` change is code-only until the API deploys;
  the frontend accepts both the new kind and the old label shape, so a
  legit void shrink heals against either deployed API version.
- The `handleGetPayable` 200 path has no offline test (needs `chainNow` —
  live chain); see MF-4 above.
- Live visual re-check still needs a browser-capable session (this VM has
  no working browser); the numbers above are code + unit-test + build
  evidence.

## Not regressed (fix-back-6/7/8 list, untouched by this change unless noted)

B1 single `['live-snapshot']` query shared by home + dashboard; B6 small
static hero glimpse (props-only, zero network calls); B9/B12 ReceiptChecker
(keys on targetId, keeps last good, evidence-gap note); B2 footnote math;
B3 relative dues; B4 3600 s from /api/config; B5 skeleton/loading states;
B7 /verify-age banners + disabled buttons; B10 wording; #invoice anchor;
loaders; refused = 21 single source; 30 s poll; MF-2/MF-3/MF-4/MF-6/MF-7
from fix-back-7 (retry loop, cache deletion, cold-load empty reject,
kept-snapshot rendering, hero error state). Round-3 held items re-verified
in this run: id-50 fetch rejection (6 calls); dropped-id-reads-paid
rejected; dropped-id 404 fail-closed (3 calls then throw); voided-fall
0 verify calls; label fallback exact prefix (`startsWith('Voided on
chain')`, emitted only for view.status==='Voided', boolean OR, no
double-count); first-shrink-after-load id threading; MF-2 suite green 2×
(full runs, this round); MF-3 all four evidenceGap combinations; MF-4
hero stale note byte-identical wording, home "Last updated" from
max(dataUpdatedAt) = kept time, note clears when error clears, error+no-data
still role="alert"; pay gate (flow.ts:152 voided check after paid/reserved,
before rail checks; server handlePay enforces on view.status directly —
Paid/Reserved/Voided → 409); zod rejects unknown kinds, accepts the
transitional shape; payableFacts has exactly one consumer
(handleGetPayable). Over-accounted shrink (growth 3 > shrink 1) still
rejected at the pure level (no-fall regime keeps exact equality).
