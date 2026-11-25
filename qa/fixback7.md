# Fix-back-7 evidence — PayOnce landing redesign (fix-back-6 d6e2be5 → fix-back-7)

Date: 2026-11-25 ~08:40 UTC. Builder: fix-back-7 subagent. One local commit on
top of `d6e2be5`. No push, no deploy, no merge. Pay never pressed; testnet only.

Fix-back-6 went 1/3: compliance SIGN-OFF, adversarial NOT SIGN-OFF (4
must-fixes, MF-1 a blocker), honesty NOT SIGN-OFF (3 minor must-fixes). This
patch fixes the consolidated 7+5 list below.

## Per-item fix + verification

- **MF-1 (BLOCKER, adversarial) — exclusion-aware shrink rule.**
  `frontend/src/lib/snapshot.ts`: `snapshotAccepts` now takes the previous
  snapshot (`{ count, voidedTotal, reservedTotal }`, threaded through
  `useLiveSnapshot` from the cached snapshot) instead of a bare count. A
  shrink is accepted iff `voided_total + reserved_total` grew by exactly
  the shrink since the last accepted snapshot AND stats agrees with the
  list — a reserve or a void legitimately removes the row from the
  listable set (Unpaid|Paid only, `api/src/listable.mjs:9-11`). Any other
  shrink (no growth, or growth ≠ shrink) is still a partial scan and is
  rejected. The fix-back-6 premise ("payables are append-only") and the
  pinning test ("rejects a shrink even when stats and list agree") are
  updated with it. The header comment now states the corrected rule.
  Tests: `snapshot.test.ts` — reserve shrink (reserved 5→6) accepted,
  void shrink (voided 1→2) accepted, reserve+void shrink accepted,
  no-growth shrink rejected, over-accounted shrink rejected, plus a
  fetch-level test (reserve shrink accepted on the first attempt, no
  retry storm). Home/dashboard consistency in this path is healed by MF-6
  (below): a legit reserve no longer throws at all, and a failed poll now
  renders the kept snapshot with a note on the dashboard instead of dashes.
- **MF-2 (minor, adversarial) — fetch errors retry in-loop.**
  `snapshot.ts` `fetchLiveSnapshot`: the `Promise.all` is now inside a
  try/catch in the attempt loop; a throw from either endpoint records the
  reason and retries (up to 3 attempts) instead of aborting after 1 call.
  Tests: endpoint throws twice then recovers → succeeds on attempt 3
  (3 calls); endpoint keeps throwing → 3 calls, then throws.
  Side effect, disclosed: the pre-existing DashboardPage "API fails" test
  needed its waitFor timeout raised 5 s → 10 s, because the error state
  now lands after the 3 in-loop attempts (~3 s of 1 s + 2 s gaps) instead
  of after 1 call. That is the MF-2 fix working, not a regression.
- **MF-3 (minor, adversarial) — the 20 s stats cache is gone.**
  `api/src/server.mjs` `handleStats`: `statsCache` removed entirely
  (declaration, warm-serve early return, write-back, and the
  create-payable invalidation that referenced it). Scans are
  single-flighted, so the cache bought nothing and only hid fresh state.
  Verified at handler level (S5 test): a state change (payable 3 pays)
  is served immediately by the next stats call — paid 3 → 4, no 20 s
  stale body.
- **MF-4 (minor, adversarial) — cold-load pairs.**
  `snapshotAccepts` rejects an empty pair on cold load (0 items, stats
  0/0, no previous snapshot) — 0/0 is never rendered as totals; the fetch
  retries, then throws, and the page shows its error state. Tests at
  both levels (acceptance + fetch). Honest limit, stated in the
  `snapshot.ts` header and here, NOT claimed fixed: a coincidental
  partial pair on cold load (e.g. 8 items with stats 8/5 and no previous
  snapshot) still passes this rule — with nothing to compare against, the
  frontend cannot tell it from a small-but-real registry. That case
  closes only when the API fail-closed layer deploys (incomplete scan →
  503, never a partial 200); the frontend alone cannot close it.
- **MF-5 (minor, honesty) — B3 sentence corrected in `qa/fixback6.md`.**
  The sentence "The '08:05' value matches no fixture in the repo" was
  FALSE. Verified live in the tree: `frontend/src/lib/heroOverview.test.ts:18`
  has a due of `2026-11-24T08:05:59.988Z`, and
  `backend/test/receipts/receipt-007.json:82` +
  `backend/test/live-e2e-2026-11-24.json:159` carry a reservation expiry
  of `2026-11-24T08:05:09.593Z`. The sentence now says the value exists
  in test fixtures only — neither ships in the bundle nor is a live
  source — so the stale-bundle / no-mechanism-invented position survives
  unchanged.
- **MF-6 (minor, honesty — RENDER FIX, as preferred).**
  `frontend/src/pages/DashboardPage.tsx`: the gate now distinguishes
  three states — `failed` (error with NO data: dashes + `COPY.statsNoData`,
  as before), `stale` (error WITH kept data: the kept snapshot keeps
  rendering, plus a could-not-refresh note), `loading` (skeletons). The
  note is a banner under the header: "Could not refresh the live numbers
  just now — showing the last verified numbers from <last success UTC>.
  The page retries every 30 s." The activity badge shows Paused on a
  failed refresh even with kept data, and the invoice table's error
  branch now keys on `failed` (no data) instead of `invoices.isError`,
  so the kept table renders while stale. This heals the MF-1 UX split
  (dashboard dashes vs HeroDemo stale chips) in the failure path too.
  A "Fix-back-7 corrections" section was appended to `qa/fixback6.md`
  recording that the B1 "react-query keeps the last good snapshot on
  screen" claim was untrue for the dashboard at fix-back-6 time and is
  true only after this fix; `useApi.ts`'s header now says the same.
  Test: `DashboardPage.test.tsx` — first poll succeeds, forced refetch
  fails → banner appears, stat-total still 5, stat-paid still 3,
  Payable 1 still listed, no `statsNoData` text, badge Paused.
- **MF-7 (minor, honesty) — hero error state.**
  `HeroDemo` takes an optional `error` prop; `HomePage.tsx:262` passes
  `demoInvoices.isError || demoStats.isError`. Error with no data renders
  "Could not load the live numbers — the test API did not answer. Try
  refreshing the page." (role="alert") instead of the loading skeleton
  forever. Error WITH kept data still renders the chips and table.
  Tests: both cases in `HeroDemo.test.tsx`.
- **S1 — `evidenceGap` note is count-accurate.** `receiptVerdict.ts`
  builds the note from the failing checks: two failures → "those two
  checks fail closed"; one failure → "the {id} check fails closed".
  Tests: single-check note names `reservation_precedes_transfer` and
  never says "those two"; two-check note keeps "those two checks".
- **S2 — AgeProofPage loading banner.** Both demo sections now show a
  loading banner while health loads ("Checking the age-proof prover…
  The demo buttons stay disabled until it answers.", role="status") —
  the buttons were disabled but unexplained and the intro copy still
  read live. Test: on first render both banners present, both buttons
  disabled.
- **S3 — recorded 300 s gloss, verified accurate, wording clarified.**
  Verified: the recorded tx `8902c4f1…` is a v1-registry (`<13149,0>`)
  refusal — `qa/out/baseline-verify.json` puts the
  `early_expiry_reject` tx on contract index 13149, and
  `api/src/attacks.mjs` labels these "the v1 recorded refusals" — so
  "300 s window" IS accurate for that recorded tx (the v1-era window).
  But bare "300 s" feeds the B4 confusion next to the live 3600 s, so
  the gloss in both `frontend/src/lib/recorded.ts:63` and
  `api/src/attacks.mjs:51` now reads "…its 300 s window (v1 recorded
  run; the live registry reserves for 3600 s)". (The v2 run on the same
  date already recorded `reservation_secs: 3600` —
  `backend/test/v2-live-e2e-2026-11-24.json:231`.) Test pins the wording.
- **S4 — HairlineFigure inner observer.** Investigated: the B8 fix's
  `ResizeObserver` watched the OUTER iframe only. Post-load inner growth
  is real: the inner page reflows (controls, rules) when its own width
  changes, and nothing fires the outer observer if the iframe width stays
  put — so the figure would clip silently behind `scrolling="no"` with
  no scrollbar. Fixed: the inner `documentElement` gets its own
  `ResizeObserver` (attached on load, same-origin); either observer
  re-fits. The fit logic is now one shared `fitHeight()`. Test (mocked
  `ResizeObserver`): load at 620 px, inner growth to 700 px → iframe
  re-fits to 700 px with no outer resize; the inner element is observed.
- **S5 — handler-level stats/invoices test (stubbed chain).**
  New `api/test/handlers-stats.test.mjs` (node:test, no network, no live
  chain, no sends): a `__setChainReaderForTests` seam in `server.mjs`
  (inside the per-row retry, so the 503/fallback paths run exactly as
  the handlers run them) stubs the chain reader; `handleStats` /
  `handleInvoices` are exported and called directly with fake req/res.
  Four ordered tests: incomplete scan with no prior complete scan →
  stats 503 + invoices 503 (never a partial 200); complete scan → stats
  200 (5/3, voided 1, reserved 1) + invoices 200 (5 listable rows);
  incomplete scan after a complete one → stats 200 (last-complete
  fallback) + invoices 503; MF-3 state change → paid 4 served
  immediately. RUN 2026-11-25 ~08:40 UTC — **5/5 pass** (5.7 s total)
  from a `/tmp` copy of `api/` (`npm ci` there: 74 packages, 232 MB;
  `PAYONCE_BACKEND_DIR` pointed at the real backend tree; stubbed chain,
  JSON store, no network, no sends). It could not run in-tree because
  `api/node_modules` is absent and the home-filesystem quota blocks
  `npm ci` there — see "Quota" below.

## Gates (my own runs, 2026-11-25 ~08:35 UTC)

- `npx tsc -b` — clean. `npx tsc --noEmit -p tsconfig.json` — clean.
  (Confirmed again: this repo has no `tsconfig.app.json`; the build
  script's `tsc -b` is the real check.)
- Frontend vitest — **188/188 (23 files)**, up from 171/171 (+17 new
  tests: snapshot +9, DashboardPage +1, HeroDemo +2, AgeProofPage +1,
  receiptVerdict +2, recorded +1, HairlineFigure +1).
- `vite build` ×2 — identical: `assets/index-BHumCPmU.js`, 544.57 kB
  (544,569 B, gzip 162.47 kB), sha256
  `2822d07f67d7968a9839457a4bb604491d1b4ec4284495f962fe3f8a1dac3f94`;
  CSS `index-BfgKWpQD.css` 50.21 kB, sha256
  `1805692b7f9e1a5ccfce9dcddc89793839ff7ea737de8e6ea697ab7a0697a9c0`.
- `node --test api/test/stats-reconcile.test.mjs` — **3/3**.
- `node --test api/test/handlers-stats.test.mjs` (S5, from the `/tmp`
  install) — **5/5** (5.7 s).
- Secrets scan of the diff — 0 genuine hits (no `token` matches at all
  in the diff; the only "secret" grep hit is the pre-existing comment
  word "secret sidecar file" in `server.mjs:94`, not a value).
  New file scanned separately — 0 hits. `git diff --check` clean.
- README gate numbers updated from these runs only.

## Quota incident (during this session — environment, not the patch)

- **Home-filesystem quota exhausted mid-task.** `api/node_modules` did
  not exist in this tree, so the S5 test could not import `server.mjs`.
  Four `npm ci` attempts in-tree all failed at tar extraction with
  errno -122 (EDQUOT, "Disk quota exceeded") — writes to all of
  `/home/hatch` failed while only `/tmp` worked, even though the device
  reports 43 GB free, so this is a quota, not disk-full. The quota
  cleared after I deleted my own `~/.npm/_cacache` (69 MB); the partial
  `api/node_modules` (149 MB, from my own failed installs, useless —
  extraction never completed) was also removed to protect headroom for
  the rest of this patch. A full in-tree `npm ci` was NOT retried after
  the commit: re-filling the quota mid-patch would have blocked the
  commit itself. The S5 test was instead run from a `/tmp` copy of
  `api/` (5/5, see S5 above) — the in-tree `api/node_modules` is still
  absent, so a future session must install it (or reuse the `/tmp`
  method) before running any API test that imports `server.mjs`.
- Live visual re-check still needs a browser-capable session (this VM has
  no working browser); the numbers above are code + unit-test + build
  evidence.

## Not regressed (fix-back-6 list, untouched by this change unless noted)

B6 small static hero glimpse (props-only HeroDemo, zero network calls —
MF-7 adds only an error prop, no fetch); B9/B12 ReceiptChecker behaviour
(keys on targetId, keeps last good per id, evidence-gap note — S1 only
changes the note's count wording); B2 footnote math; B3 relative dues;
B4 3600 s from /api/config (S3's gloss now agrees with it); B5
skeleton/loading states (MF-7 adds the error state beside them, the
loading skeleton is unchanged); B7 /verify-age banners + disabled buttons
(S2 adds a loading banner beside them); B10 wording; #invoice anchor;
loaders; refused = 21 single source; 30 s poll.
