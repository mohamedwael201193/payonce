# Fix-back-11 evidence — PayOnce landing redesign (fix-back-10 3841254 → fix-back-11)

Date: 2026-11-25 ~11:47–12:20 UTC. Builder: fix-back-11 subagent. One local commit on
top of `3841254`. No push, no deploy, no merge. Pay never pressed; testnet only.

Fix-back-10 went 0/3: compliance NOT SIGN-OFF (1 must-fix), honesty NOT SIGN-OFF
(1 must-fix), adversarial NOT SIGN-OFF (1 must-fix). All three judges converged on
the SAME defect — one code fix (MF-1) plus its wording correction (MF-2). This patch
fixes both. `qa/fixback10.md` is kept as the fix-back-10 record, untouched.

## MF-1 (BLOCKER, all three lenses) — no whole-round verification budget: a slow host failing late blew the 30 s poll

The defect, as measured by the panel: `verifyDroppedIds`
(`frontend/src/lib/snapshot.ts`) pages sequentially at 5 s/page
(`VERIFY_PAGE_TIMEOUT_MS`) with NO whole-round cap, and `fetchLiveSnapshot`
re-runs the whole pair fetch + re-pays every page on each of 3 attempts
(backoffs 1 s + 2 s). General form 3 × 5 s × pages + 3 s: 2 pages ≈ 33 s,
5 pages ≈ 78 s, 6 pages ≈ 93 s. The adversarial judge's measured repro (real
timers): 11 dropped ids, pages answering at 4.9 s/page, page 2 reading unpaid
(the ordinary partial-scan rejection path — verification fails LATE, so every
attempt re-pays both pages) → one poll tick = **32,492 ms, 33 verify calls**.
The "18 s" bound fix-back-10 stated holds ONLY for a hung first page
(18,088 ms / 30 calls in the control). The compounding needs no knife-edge
timeout.

### The fix

A whole-round verification budget per poll tick, on top of the per-page
deadline — `VERIFY_TICK_BUDGET_MS = 20_000` (`frontend/src/lib/snapshot.ts`):

- The budget is created once per `fetchLiveSnapshot` call (one poll tick =
  one queryFn; `retry: 0`, `refetchInterval` counts from completion) and
  shared across the 3 in-loop attempts. A fresh tick gets a fresh 20 s; a
  tick never borrows from the next one.
- `verifyDroppedIds(dropped, budget)` deducts each page's actual elapsed time
  from the budget. A page that starts with R ms left races a
  `min(5 s, R)` deadline — the per-page 5 s deadline is kept, shortened only
  by what the tick still allows. The timeout wording states the deadline
  actually raced (`pageDeadlineMs`), not the nominal 5 s, when the two differ.
- Once the budget is spent, later attempts fail immediately with zero further
  verify calls (budget-exhausted rejection, fail-closed).

Bound arithmetic (verification + backoff, pair fetches fast — see the
scoping note below):

- Attempt 1 may spend up to `min(5 s × pages, 20 s)` to heal. The MF-2 heal
  (11-drop at 3 s/page, ~6 s, 11 calls) is untouched, and so is any legit
  heal needing ≤ 20 s of verification on attempt 1 (e.g. 6 pages at
  3 s/page = 18 s).
- Attempts 2–3 share only the remainder: a slow host failing late cannot
  re-pay full slow pages on every attempt.
- Worst case per poll tick, verification + backoff ONLY: verification ≤ 20 s + backoff 3 s = **23 s**.
  The pair fetches sit OUTSIDE the budget (Promise.all, no deadline, each capped only by the
  15 s fetch timeout) — whole-tick worst case 68 s (3 × 15 s pair + 20 s verify + 3 s backoff);
  "inside the 30 s poll" holds only when the pair fetches are fast. Measured break: pair fetches
  at 10 s/attempt with instant-fail verification = one tick of 33,033 ms.
- Hung-first-page stays 3 × 5 s + 3 s = **18 s** (the budget never binds there).
- Fail-late 2-page at 4.9 s/page now tops out at **~23 s of verification + backoff**, not 32.5 s.

Measured evidence (real timers, targeted runs before the full runs):

- (b) fail-late shape, NEW test — 11 dropped ids, 4.9 s/page, page 2 unpaid:
  **23,018 ms**, rejects, 22–32 verify calls (attempts 1–2 verify both pages;
  attempt 3 starts at most one more page on a sub-second shortened deadline,
  or none if the budget is already spent). Old code on this shape: 32,492 ms /
  33 calls. The test pins `elapsed < 30_000` and `elapsed > 15_000` (proving
  it exercised the slow path, not a fast fail).
- (c) hung-first-page, NEW test — never-settling per-id reads, 3 attempts:
  **18,094 ms**, 3 verify calls, `/timed out after 5000 ms/` wording.
- (a) MF-2 heal, KEPT test, strengthened — 11-drop at 3 s/page:
  **6,097 ms**, 11 verify calls, heals on attempt 1, now also asserting
  `elapsed < VERIFY_TICK_BUDGET_MS` (the budget caps later attempts, never
  attempt 1's heal).

Why 20 s, not 15 s or 25 s: 20 s leaves the MF-2 heal (6 s) with 14 s of
headroom and still heals 6 pages at 3 s/page (18 s), while the worst case
of verification + backoff (23 s) keeps ~7 s of margin inside the 30 s poll
WHEN the pair fetches are fast. A 25 s budget would put the
verification+backoff worst case at 28 s — no margin even before the pair fetches.

Disclosed price (stated in the code, header rule 6, and here): a legit heal
needing MORE than 20 s of verification on attempt 1 (≥ 5 pages at
~4.9 s/page) fails closed that tick and retries on the NEXT tick with a
fresh budget; while the host stays that slow it never heals. That is
staleness, not wrong numbers — the alternative (no whole-round cap) blew
the poll for the common 2-page shape instead. A whole-round cap that killed
attempt 1's heal would have been the MF-2 freeze again; this cap does not —
attempt 1 keeps up to min(5 s × pages, 20 s).

Scoping note on the bound: the 23 s covers verification + backoff. The pair
fetches (`getInvoices` + `getStats`) are outside this budget — each is
capped by the API client's own 15 s fetch timeout (`FETCH_TIMEOUT_MS`), and
in every measured shape they answer in milliseconds. A pair fetch that hung
for its full 15 s could still push a tick past 30 s; that is pre-existing,
outside this defect, and unchanged by this patch — and the round-6 panel
measured exactly that break (pair fetches at 10 s/attempt, instant-fail
verification: one tick of 33,033 ms). The bound is stated this way
everywhere it appears (code, README, this file): 23 s is verification +
backoff only; the whole-tick worst case is 68 s, and "inside the 30 s
poll" is conditioned on fast pair fetches — no unqualified "one poll tick
tops out at X s" remains.

## MF-2 (wording — honesty + compliance + adversarial): the three unqualified "18 s" claims are corrected

- `README.md:179` (fix-back-10 paragraph): the "one poll tick tops out at
  18 s, inside the 30 s poll" clause is corrected in place — it now says
  fix-back-10 stated 18 s, that it holds only for a hung first page, and
  that fix-back-11 corrects it to the qualified bound (verification ≤ 20 s
  + 3 s backoff = 23 s of verification + backoff only; whole-tick worst
  case 68 s with the pair fetches). A new fix-back-11 paragraph
  (newest first) states the bound the same way, and the "Verified by my own
  runs" paragraph carries the fix-back-11 gate numbers.
- `frontend/src/hooks/useApi.ts:69-76` (retry: 0 comment): rewritten — one
  queryFn spends at most 20 s verification + 3 s backoff = 23 s of
  verification + backoff only (whole-tick worst case 68 s; "inside the
  30 s poll" only when the pair fetches are fast); hung first page is
  18 s of verification (63 s with a hung pair on top); doubled (retry: 1)
  would be ~46 s of verification + backoff, 136 s whole-tick. The old
  "18 s once / ~36 s doubled" is named as the unqualified statement it was.
- `frontend/src/lib/snapshot.ts` header rule 6: rewritten as the fix-back-11
  rule (see the MF-1 section above) — hung-first-page 18 s vs slow-host
  5 s × pages per attempt, capped by the 20 s tick budget, new bound
  23 s + pair fetches. The `VERIFY_PAGE_TIMEOUT_MS` comment is corrected
  the same way (the per-page deadline alone does not bound the tick), and
  the new `VERIFY_TICK_BUDGET_MS` constant carries its own bound comment.
- Also corrected: `frontend/src/hooks/useApi.test.tsx:145` ("18 s to ~36 s"
  → "~23 s to ~46 s", with the hung-first-page qualification).
- Remaining "18 s" mentions in the tree were grepped: every one now states
  its scope (hung-first-page, or the correction of the old claim). No bare
  "grow" token anywhere in `frontend/src` (the fix-back-10 CSS-leak guard).

## Gates (my own runs, 2026-11-25 ~11:47–12:20 UTC)

All gates ran in a `/var/tmp` clone of the patch tree at `3841254`
(see "Environment incidents" for why the builder tree itself could not be
written, and how the clone was built). The clone's HEAD is `3841254`,
status clean before my edits; the commit below is made in that clone.

- `npx tsc -b` (from `frontend/`) — clean. `tsc --noEmit -p tsconfig.json` —
  clean. (No `tsconfig.app.json`, no root tsconfig — `tsc -b` is the check.)
- Frontend vitest — **246/246 (23 files), TWICE in a row** (run 1: 138.22 s,
  run 2: 140.62 s), up from 244/244 (+2 new tests: snapshot 60 → 62; the
  +41 s of real-timer tests is why the runs are slower than fix-back-10's
  ~56 s). Snapshot file alone: 62/62. Targeted runs before the full runs:
  fail-late 23,018 ms, hung 18,094 ms, heal 6,097 ms (each 1 passed).
  Run via `npx vitest run` (CLI) with a temporary gate-only config
  (`vitest.fb11.config.ts`, deleted before commit) identical to
  `vitest.config.ts` except top-level `cacheDir` → `/var/tmp`, so vitest
  never writes its results cache through the symlinked `node_modules` into
  the quota-blocked home tree.
- `vite build` ×2 — identical: `assets/index-L0LS_bTJ.js`, 548.33 kB
  (548,331 B, gzip 163.64 kB), sha256
  `514cbfda8de4f35750ef36a94276e01f1404603cfbdd4a19612d507553ff0063`;
  CSS `index-BfgKWpQD.css` 50.23 kB (50,211 B), sha256
  `1805692b7f9e1a5ccfce9dcddc89793839ff7ea737de8e6ea697ab7a0697a9c0`
  — byte-identical to fix-back-9 / fix-back-10 (same filename, same sha).
  Build 1: 6.97 s, build 2: 16.92 s. JS grew 547,992 → 548,331 B (+339 B:
  the budget code — expected; CSS unchanged proves no style change).
  Builds used a temporary gate-only plain-ESM-JS config
  (`vite.fb11.config.mjs`, deleted before commit) with the same plugins as
  `vite.config.ts`: vite 6.4.6 bundles a TS config into
  `node_modules/.vite-temp`, which would write through the symlinked
  `node_modules` into the quota-blocked home tree and fail with -122; a
  `.mjs` config is imported directly instead. The CSS hash being
  byte-identical to the fix-back-9/10 builds (made with the TS config)
  corroborates that the two configs build the same output.
- API tests (combined run, 7.68 s) from a fresh `/var/tmp/fb11-api` copy of
  the patched `api/` with node_modules symlinked read-only to the existing
  `/home/hatch/workspace/payonce-fb3-merge/api/node_modules` install and
  `PAYONCE_BACKEND_DIR=~/workspace/payonce-build/backend`:
  `node --test test/stats-reconcile.test.mjs test/handlers-stats.test.mjs test/handlers-payable.test.mjs`
  — **15/15** (stats-reconcile 3/3, handlers-stats 5/5, handlers-payable 7/7).
  `api/node_modules` in-tree is still absent; nothing was `npm ci`'d in-tree.
- Secrets scan of the diff — 0 genuine hits. No `password|seed|private key|
  bearer|api key|secret` matches except the word "secret" in the README's
  pre-existing "secret scan clean on the diff" sentence; no long hex values;
  no `token:` lines at all in the diff (the public on-chain agent id
  `agentToken: '1476'` fixture is pre-existing and untouched).
  `git diff --check` clean.
- README gate numbers updated from these runs only.

## Environment incidents (why the work is in a /var/tmp clone, not the builder tree)

- HOME WRITES BLOCKED BY QUOTA for the whole session: every write under
  `~` fails with "Disk quota exceeded" (EDQUOT, error -122) — the
  `muse.edit` on the builder tree, the `.quota-probe` file, and the
  `EXECUTION_HISTORY.md` append (entry 0687 saved instead to
  `/var/tmp/fixback11-builder-entry-0687.md`; 0686 is the compliance
  judge's preserved entry at
  `/var/tmp/judge-fb10-compliance/EXECUTION_HISTORY-entry-0686.md`, so
  0687 was taken to avoid collision). Nothing was deleted to free quota.
- `/var/tmp` and `/tmp` (tmpfs) additionally refuse writes in bursts with
  EPERM ("Operation not permitted") under load (load average 4–7 on 1.5
  shared CPUs): a write creates the file (0 bytes) but the content write
  is denied, then the same write succeeds minutes later. `git clone`,
  `git init`, `cp -a`, `cp -r` and `rsync` all failed repeatedly this way
  (a `cp -r` of `node_modules` stalled at 60/224 MB with 8,753 empty
  files; 15 rsync passes made zero progress). Working method: retry loops
  for the small operations (clone via `git init` + local-path `git fetch
  HEAD` + `git checkout FETCH_HEAD`, each retried until it landed), and
  the `node_modules` copy was ABANDONED — the clone uses a read-only
  symlink to the builder tree's `frontend/node_modules` instead (vitest
  and vite were pointed at `/var/tmp` cache dirs so they never write
  through it; the one earlier vitest run that did write through it left
  an untracked `node_modules/.vite/results.json` in the builder tree's
  install — cache output only, no source touched).
- The fix-back-11 commit below is therefore made in the `/var/tmp` clone,
  NOT in `~/workspace/payonce-build/road-to-1/batch-uiux-fixback/payonce`:
  the clone is at the same base (`3841254`, verified by `git rev-parse`
  and a clean status before editing), contains exactly the fix-back-11
  diff, and the parent must apply it to the builder tree (cherry-pick /
  format-patch) once home writes work again. The commit hash in the report
  is the clone's hash; its parent is `3841254`.

## Honest limits (not claimed fixed)

- Cold-load coincidental partial pair (e.g. 8 items with stats 8/5, no previous snapshot)
  still passes — per-id verification needs a previous id set, so it cannot run on cold
  load either. Closes only when the API fail-closed layer deploys (incomplete scan →
  503, never a partial 200).
- The `handleGetPayable` 200 path has no offline test (needs `chainNow` — live chain);
  see fix-back-9 MF-4.
- Live visual re-check still needs a browser-capable session; the numbers above are code
  + unit-test + build evidence. No working browser on this VM.
- The MF-3 native-`AbortSignal.any` path (Node/production) is the pre-existing code path,
  verified present in Node 24 but not executed by a test — the tests execute the jsdom
  manual-combine path. The two paths differ only in how the combined signal is built.
- The 23 s bound covers verification + backoff; the pair fetches are outside it (see
  the scoping note in MF-1). A legit heal needing > 20 s of verification on attempt 1
  fails closed that tick (see the disclosed price in MF-1).
- The tight rule is exact modulo pool limits (a confirm/expiry/reserve/void needs a row
  in the right prior state); the pure check cannot see pool exhaustion, so a pair
  requiring more prior Reserved rows than existed would pass the pure layer — per-id
  verification is the layer that catches dropped ids in practice.

## Not regressed (fix-back-6/7/8/9/10 list, re-verified in this run by the full suite, 246/246 twice)

Tight rule exact in both regimes (Δreserved + Δvoided ≥ shrink, 0 false
accepts/rejects over all observables −8..8 — fixtures: H1 flat confirm d=−1
reject, confirm 51→52 d=0, confirm+create 51→53 d=1, void-of-unpaid d=0,
mixed d=0, 7→5 d=0, over-accounted d=2, burst d=1); MF-3 manual AbortSignal
combine (works in jsdom; native `AbortSignal.any` path untested by any test
— disclosed limit, do not claim otherwise); MF-4 retry: 0 in useLiveSnapshot
ONLY (other hooks retry: 1; exactly 3 in-loop attempts / 6 calls / no second
queryFn run); CSS byte-identical to fix-back-9 (no `.grow` leak — no bare
"grow" in `frontend/src`); B1 single `['live-snapshot']` query shared by
home + dashboard; B6 small static hero glimpse (props-only, zero network
calls); B9/B12 ReceiptChecker unchanged; B2 footnote math; B3 relative dues;
B4 3600 s; B5 skeleton/loading; B7 `/verify-age` banners + disabled buttons;
B10 wording; `#invoice` anchor; loaders; refused = 21 single source; 30 s
poll; cold-load coincidental partial pair still passes (admission stays, NOT
claimed fixed).
