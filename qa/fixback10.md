# Fix-back-10 evidence — PayOnce landing redesign (fix-back-9 9e1ca2a → fix-back-10)

Date: 2026-11-25 ~10:24–10:40 UTC. Builder: fix-back-10 subagent. One local commit on
top of `9e1ca2a`. No push, no deploy, no merge. Pay never pressed; testnet only.

Fix-back-9 went 0/3: compliance NOT SIGN-OFF (1 must-fix), honesty NOT SIGN-OFF
(3 must-fixes), adversarial NOT SIGN-OFF (4 must-fixes). This patch fixes the
consolidated MF-1–MF-4 list below. All three lenses converged on MF-1 — it is
one fix, not three items.

## Per-item fix + verification

- **MF-1 (a) (BLOCKER, all three lenses) — the feasibility algebra was wrong in BOTH regimes.**
  Re-read the contract first (`contracts/payable_registry_v2_1/src/lib.rs`):
  `confirm_plt` Reserved→Paid only while `now <= expires`; `expire_reservation`
  Reserved→Unpaid only past expiry; `void_payable` Unpaid→Voided and Reserved→Voided
  only after expiry (`VoidWhileReserved` before); Paid/Voided→WrongStatus. Listable
  rows are Unpaid|Paid only (`api/src/listable.mjs`). With a=reserves, b_u=Unpaid→Voided,
  b_r=Reserved→Voided, c=expiries, d=creates, e_c=confirms, e_d=direct pays, the true
  identities are `S = a + b_u − c − e_c − d`, `Δreserved = a − e_c − c − b_r`, and
  **`d = Δreserved + Δvoided − S`**. Feasible iff the TIGHT inequality
  **`Δreserved + Δvoided ≥ shrink`** holds. `snapshotAccepts`
  (`frontend/src/lib/snapshot.ts`) now applies exactly that, in one branch.
  Fix-back-9's rule (`Δreserved + Δpaid + 2·Δvoided ≥ shrink`) was a sound necessary
  condition but strictly looser: it treated a confirm as list-neutral (paid growth
  compensates a reserved fall 1:1 with no list growth) and double-counted voided growth
  (a Reserved→Voided row never was in the list). The header derivation is corrected
  (its S equation counted all voids as list exits and omitted −e_c; its Δreserved used
  all paid growth instead of confirms only), and the header wording is fixed: VOIDED
  and PAID *both* have no exit on chain (void rejects Paid and Voided with WrongStatus;
  no transition leaves Paid).
  - Independent check (my own run, `node -e` enumerator over observable triples
    −8..8, pool prev-unpaid 51 / prev-reserved 7): the tight rule has **0 false rejects**
    (every tight-reject has forced d<0) and its only tight-accepts without a witness are
    45/1869 that need >51 unpaid rows or >7 reserved — pool-limit edge artifacts of the
    ±8 range, not real false accepts (d is forced by the identities, and a witness using
    only reserves/voids/expiries/creates always exists when d≥0 within pool). The old
    rule accepts 662 infeasible (d<0) triples in the same range for some paid growth
    0..8 — same order as the lenses' 911 over 0..8 event vectors. Spot checks: H1 flat
    confirm d=−1 (tight rejects, old accepts with Δpaid=1); H2 void-of-reserved d=−1
    (tight rejects, old accepts); 7→5 flip d=0; over-accounted d=2; burst d=1.
  - Tests (snapshot pure +5, fetch +9 — see below): H1 paid-cover and H2 voided-2×-cover
    now REJECTED with 0 verify calls (pure + fetch); the three corrected fixtures; the
    flipped 7→5 ACCEPT is kept and its comment corrected (witness 1 Unpaid→Voided +
    2 Reserved→Voided, d = −2+3−1 = 0; total rows 59→59 means 0 creates, not 2);
    the "confirm plus a create" test was a bare confirm (d=0) — relabelled to the
    51→52 shape, with a TRUE confirm+create at 51→53 added (pure + fetch, 0 calls).

- **MF-1 (b) (BLOCKER) — the tight check now applies in BOTH regimes.**
  The kept no-fall exact-equality rule (`excludedGrowth === shrink`) is replaced by the
  same feasibility inequality — it assumed zero creates; creates are routine. The
  over-accounted test flips to ACCEPT (pure + fetch): a dropped id reading
  reserved/voided confirms it (3 verify calls), reading unpaid rejects it (6 calls
  over 2 attempts). New: 1 create + 3 reserves (list 51→49, reserved 5→8) accepted
  pure + fetch (3 verify calls). Per-id verification still arbitrates every dropped id.
  - Corrected fixtures: pure + fetch confirm is now the 51→52 shape (flat 51 rejected);
    pure + fetch void-of-reserved (shrink 1) rejected, 0 calls; the correct void shape is
    void-of-unpaid (reserved 5→5, voided 1→2, shrink 1, 1 call); the mixed expiry+void
    shape (reserved 5→3, voided 1→3, shrink 1) rejected, 0 calls; the correct mixed shape
    is 1 expiry + 2 voids-of-unpaid (reserved 5→4, voided 1→3, shrink 1, 2 dropped ids,
    2 calls).
  - `frontend/src/hooks/useApi.ts` header comment rewritten (it still described the old
    exact-equality shrink rule); the `paidTotal` threading comment corrected (the tight
    rule does not use paid growth — paidTotal stays only for monotonicity).

- **MF-2 (adversarial H7) — deadline-vs-paging: a legit >10 shrink NEVER healed on a slow host.**
  DEADLINE SCALING RULE (flagged explicitly, as instructed): **the deadline is PER PAGE,
  5 s per page (`VERIFY_PAGE_TIMEOUT_MS`), with NO whole-round cap.** Each page of up to
  10 parallel per-id reads races its own 5 s deadline (`verifyDroppedIds` now creates a
  fresh `AbortController` per page); a hung page fails that page in 5 s, a slow-but-
  answering host heals page by page. There is deliberately no whole-round cap — one
  would reintroduce the MF-2 freeze for large legit drops. Worst case vs the 30 s poll:
  a HUNG endpoint fails every attempt on the FIRST page (5 s), so one poll tick is
  3 attempts × 5 s + 1 s + 2 s backoff = **18 s < 30 s** (MF-4: `retry: 0`, so one tick
  is one queryFn). A slow-but-answering host heals on attempt 1, so the multi-page worst
  case (5 s × pages) is paid once, on the attempt that succeeds — e.g. the repro's
  2 pages at 3 s/page heal in ~6 s. A pathological all-pages-just-under-deadline host
  could take up to 5 s × pages on the single succeeding attempt (30 s at 6 pages) — that
  is the price of healing instead of freezing, and it succeeds rather than retries.
  - Test (fetch +1): the adversarial repro — legit 11-drop shrink, per-id endpoint at
    3 s/page — HEALS on attempt 1 in ~6 s (measured 6004 ms), 11 verify calls. Under
    fix-back-9 this threw after ~18 s (33 calls over 3 attempts).

- **MF-3 (adversarial) — abort did NOT reach the fetch without `AbortSignal.any`.**
  `frontend/src/lib/api.ts` `timedFetch`: the guard silently fell back to the 15 s
  timeout signal, dropping the caller signal (jsdom 25.0.1 in the test env has
  `AbortSignal.any === undefined`; Node 24 has it). Now, when `.any` is absent, a
  forwarding `AbortController` combines the caller signal and the timeout signal
  manually (either source aborts the fetch; already-aborted callers abort at once).
  - Test (api.test.ts +2, REAL stubbed fetch, not a mocked getPayable): abort at ~100 ms
    cancels the in-flight read (measured ~100–200 ms, asserted < 2000 ms — under
    fix-back-9 this took 15,005 ms), the fetch receives a signal that is aborted
    afterwards (the old code handed it the still-pending timeout signal), the error is
    the production "did not answer in time", and fetch is called exactly once (no retry
    on timeout abort). Second test: an already-aborted caller signal rejects at once
    (< 1000 ms), 1 fetch call.
  - Works in jsdom (no `AbortSignal.any`) AND in Node/production: the jsdom path is the
    one these tests exercise (vitest runs under jsdom 25, where `.any` is undefined —
    the test would take 15 s under the old code); the native path is unchanged code
    (`AbortSignal.any([caller, timeout])`) and Node 24 was verified to have it
    (`typeof AbortSignal.any === 'function'`, node v24.22.1).
  - Minor (wording): in production a timeout surfaces as the generic per-id failure
    ("The testnet did not answer in time"), not "timed out after 5000 ms" — the MF-3
    never-answering test now uses a signal-respecting mock (emulating `request()`'s
    abort mapping) and asserts the production wording (`/could not verify dropped
    payable 51.*did not answer in time/`, ~5 s, 1 call). The "timed out after 5000 ms"
    wording is kept only for the fallback path — a read that ignores the abort signal
    and never settles, caught by the page race itself — pinned by a separate test.

- **MF-4 (minor, adversarial) — `retry: 1` doubled the MF-3 worst case.**
  `retry: 0` in `useLiveSnapshot` only (`frontend/src/hooks/useApi.ts`) —
  `fetchLiveSnapshot` already retries 3× in-loop. Worst case per poll tick is now one
  queryFn: 3 attempts × 5 s page deadline + 1 s + 2 s backoff = **18 s < 30 s**
  (hung endpoint, 1 page). The other hooks keep `retry: 1` — only the snapshot queryFn
  carries its own retry loop.
  - Test (useApi.test.tsx +1): a plain `QueryClient` with NO `retry: false` default, a
    disagreeing pair, fake timers — the query settles in error after exactly 3 in-loop
    attempts (6 fetch calls, `isError` true); advancing 5 s past the failure proves no
    react-query retry runs a second queryFn (that would be 12 calls).

## Gates (my own runs, 2026-11-25 ~10:24–10:40 UTC)

- `npx tsc -b` (from `frontend/`) — clean. `tsc --noEmit -p tsconfig.json` — clean.
  (Verified again: this repo has NO `tsconfig.app.json` and no root tsconfig — only
  `frontend/tsconfig.json`.)
- Frontend vitest — **244/244 (23 files), TWICE in a row** (run 1: 56.72 s, run 2:
  56.29 s), up from 228/228 (+16 new tests: snapshot +13 — pure +4 and fetch +9 net
  after flips; api.test +2; useApi +1). Snapshot file alone: 60/60. Targeted 3-file
  run before the full runs: 72/72 (snapshot 60 + api 8 + useApi 4).
- `vite build` ×2 on the final code — identical: `assets/index-DT97w9nz.js`, 547.99 kB
  (547,992 B, gzip 163.54 kB), sha256
  `50bbeaf8c28281575147788ce3b3ec71c016565b16dac12bead7bb05365bb510`;
  CSS `index-BfgKWpQD.css` 50.23 kB (50,211 B), sha256
  `1805692b7f9e1a5ccfce9dcddc89793839ff7ea737de8e6ea697ab7a0697a9c0`
  — byte-identical to fix-back-9 (see the CSS note below). Build 1: 6.67 s, build 2: 7.20 s.
  (Two earlier builds on the pre-fix code had the same JS content sha256 with a different
  asset filename — the filename hash follows the CSS asset name; content is what matters.)
- API tests (combined run, 5.49 s) from a fresh `/tmp/fb10-api` copy of the patched `api/`
  with node_modules symlinked read-only to the existing
  `/home/hatch/workspace/payonce-fb3-merge/api/node_modules` install and
  `PAYONCE_BACKEND_DIR=~/workspace/payonce-build/backend`:
  `node --test test/stats-reconcile.test.mjs test/handlers-stats.test.mjs test/handlers-payable.test.mjs`
  — **15/15** (stats-reconcile 3/3, handlers-stats 5/5, handlers-payable 7/7).
  `api/node_modules` in-tree is still absent; nothing was `npm ci`'d in-tree.
- Secrets scan of the diff — 0 genuine hits. No `password|seed|private key|bearer|api
  key|secret` matches; no long hex values; no `token:` lines at all in the diff (the
  public on-chain agent id `agentToken: '1476'` fixture is pre-existing and untouched).
  `git diff --check` clean.
- README gate numbers updated from these runs only.

## CSS note (caught by the gates, fixed in the same commit)

The first two builds showed CSS 50,229 B vs fix-back-9's 50,211 B. Rule-by-rule diff of
the built CSS against a scratch worktree build at 9e1ca2a (read-only check, worktree
removed + pruned afterwards) showed exactly one added rule: `.grow{flex-grow:1}`.
Cause: Tailwind v4's scanner extracts the bare word `grow` as a utility candidate — my
header/test comments said "the list MUST grow 51 → 52". Fixed by rewording all three
occurrences to "must reach 52" (the token, not just the phrase, had to go — "grow to"
still contains bare `grow`). Final builds: CSS byte-identical to fix-back-9
(`index-BfgKWpQD.css`, sha `1805692b…9c0`), JS content sha unchanged. No visual change;
the stray rule was unused (no element carries `grow`).

## Environment incidents

None. No quota/EPERM/write-block hit in this run (home disk 43G free at start). The
`/tmp` API copy and the scratch CSS-check worktree were removed after use (`git worktree
prune` run; the patch tree shows only the 6 modified source files + README + this file).

## Honest limits (not claimed fixed)

- Cold-load coincidental partial pair (e.g. 8 items with stats 8/5, no previous snapshot)
  still passes — per-id verification needs a previous id set, so it cannot run on cold
  load either. Closes only when the API fail-closed layer deploys (incomplete scan → 503,
  never a partial 200).
- The `handleGetPayable` 200 path has no offline test (needs `chainNow` — live chain);
  see fix-back-9 MF-4.
- Live visual re-check still needs a browser-capable session; the numbers above are code
  + unit-test + build evidence.
- The tight rule is exact modulo pool limits (a confirm/expiry/reserve/void needs a row
  in the right prior state); the pure check cannot see pool exhaustion, so a pair
  requiring more prior Reserved rows than existed would pass the pure layer — per-id
  verification is the layer that catches dropped ids in practice.
- The MF-3 native-`AbortSignal.any` path (Node/production) is the pre-existing code path,
  verified present in Node 24 but not executed by a test — the tests execute the jsdom
  manual-combine path. The two paths differ only in how the combined signal is built.

## Not regressed (fix-back-6/7/8/9 list, re-verified in this run by the full suite)

MF-1(b) ungated verification (same-count swap / net-growth drop / F5 all REJECTED with
verifyCalls 3/2/6); MF-2 paging (F4 51→40 heals same poll, 11 calls; partial >10 fails
page 1, 20 calls over 2 attempts, never heals); MF-3 deadline wiring (never-answering
fails ~5.0 s, slow-then-answering heals attempt 2 ~6 s); MF-4 seam test-only,
payableFacts exactly one consumer, 200-path offline gap genuine; paid fall rejected with
0 verify calls (paid terminal, confirmed in contract); single-id verification failure
fails the whole attempt; contract has no payables.remove (insert-only) so a dropped id
can never legitimately 404; B1 single ['live-snapshot'] query shared by home + dashboard;
B6 small static hero glimpse (props-only, zero network calls); B9/B12 ReceiptChecker; B2
footnote math; B3 relative dues; B4 3600 s from /api/config; B5 skeleton/loading states;
B7 /verify-age banners + disabled buttons; B10 wording; #invoice anchor; loaders; refused
= 21 single source; 30 s poll. Round-3 held items re-verified: id-50 fetch rejection
(6 calls); dropped-id-reads-paid rejected; dropped-id 404 fail-closed (3 calls then
throw); voided-fall 0 verify calls; first-shrink-after-load id threading; MF-2 suite
green 2× (full runs, this round); MF-3 all four evidenceGap combinations; MF-4 hero
stale note byte-identical wording, home "Last updated" from max(dataUpdatedAt) = kept
time, note clears when error clears, error+no-data still role="alert"; pay gate
(flow.ts:152 voided check after paid/reserved, before rail checks; server handlePay
enforces on view.status directly — Paid/Reserved/Voided → 409); zod rejects unknown
kinds, accepts the transitional shape; payableFacts has exactly one consumer
(handleGetPayable).
