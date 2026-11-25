# Fix-back-6 evidence — PayOnce landing redesign (main 0de5fc2 → fix-back-6)

Date: 2026-11-25 ~08:00 UTC. Builder: fix-back-6 subagent. One local commit on
top of `0de5fc2`. No push, no deploy, no merge. Pay never pressed; testnet only.

## Live probes that established the mechanisms (before any fix)

All times UTC 2026-11-25, new API host `https://payonce-api-n98a.onrender.com`
(live bundle `index-CB6bABD7.js` points at it; old host `payonce-api.onrender.com`
returns "Not Found" for `/api/invoices`).

- **B1/B11 — the swing, reproduced at the API level.** `/api/invoices` returned
  51 items, then 51, then **13 items** (ids 1–1006) in the same minute;
  `/api/stats` returned 51/31, then **8/5** (voided 1→0, reserved 5→0).
  Mechanism, confirmed in code: `api/src/server.mjs` `scanPayables` iterated
  `knownIds()` and silently skipped any row whose `getPayableOrNull` threw
  (`catch {}`); `/api/invoices` uncached vs `/api/stats` cached 20 s, so the
  two endpoints were different partial scans. The frontend derived totals from
  the list, so partial lists rendered as shrunken totals — on the dashboard
  (50/30 → 51/31 → 43/25 → 51/31) and, per B11, on the home hero too (50/30
  while the dashboard showed 51/31 at 07:36).
- **B2** — dashboard first paint 50/30, list ending at Payable 1048, vs home
  51/31 with Payable 1049 paid. Live stats at probe time: 51 total / 31 paid /
  voided 1 / reserved 5 / refused 21.
- **B3** — chain `due` is a stored u64 decoded verbatim (`backend/src/v2/registry.mjs`
  `parsePayableV2`); live `/api/payables/1` due stable across 3 spaced reads
  (20 s apart): `2026-12-01T08:03:26.555Z` (payables 2, 3 same). The "08:05"
  value matches no fixture in the repo (dev stub dues were `2026-11-25T04:49:*`).
  Honest position: chain dues verified stable; the flip matches a
  stale-bundle/old-host read during the deploy window (pass-2 ran 07:28–07:34
  UTC, redesign just deployed). No mechanism invented.
- **B4** — true value `/api/config` `reservation_secs: 3600` (live, from chain
  `get_config`). The 300 s in step 03 and the judges glossary is the v1-era value.
- **B7** — `/api/age-proof/health` returns `prover_unavailable` ("The age-proof
  prover is not reachable on this host. The prover sidecar has not been
  provisioned yet…"). Targeted workspace search: the sidecar file
  `prover-C3.private.json` is NOT present anywhere (only unrelated prover
  scripts in remit-* dirs and `payonce-private/services/prover.mjs`, the service
  code). Page fix, not provisioning; the material is not in the workspace and
  must not be invented.
- **B9/B12** — live, 3× `POST /api/payables/1049/verify` after_pay, stable:
  blocked 11/14; 11 checks ok (registered, agent, registry_zero, status_paid,
  tx_finalized, one_token_transfer, token_eudemo, from_payer, to_payee, amount,
  memo); `doc` not_run; only 2 fail: `reservation_precedes_transfer` ("no
  reserve transaction supplied — the reservation was never checked") and
  `paid_at_is_confirm_time` ("no confirm transaction supplied"). Cause:
  `pltEvidenceFor` (`server.mjs:356-400`) gets reserve/confirm legs from
  `paymentTxsFor` (server store / recorded evidence); the new API host's store
  has no Reservation/Confirm legs for 1049 (paid 2026-11-24), so
  `verifyPltV2` fail-closes by design (MF-3). The payment is genuine; the
  checker cannot certify reservation ordering from this host's evidence.
  B12 flip mechanism: `ReceiptChecker`'s effect depended on the invoice object
  (`target`), a new object every 30 s poll → re-fired verify every poll,
  resetting result to null; any flaky re-fetch replaced the verdict with the
  generic error. Also `target` (latest paid id) flips 1049↔1048 with partial lists.

## Per-bug fix + verification

- **B1/B11 (unified snapshot, frontend)** — one react-query query
  `['live-snapshot']` (`useLiveSnapshot`, `lib/snapshot.ts`): fetches invoices +
  stats together and accepts the pair only when `stats.payables_total ===
  items.length`, `stats.paid_total === paid-in-list`, and `items.length >=
  prevCount` (append-only; a shrink is always a partial scan). Rejected pairs
  retry (fresh pair, up to 3 attempts, 1 s/2 s gaps); after exhaustion it throws
  `ApiError` chain_unreachable and react-query keeps the last good snapshot.
  `useStats`/`useInvoices` are thin spreads over the shared query, so home and
  dashboard share one cache entry and can never disagree.
  *API fail-closed scan (deploys later; frontend guard holds the line live now):*
  `api/src/listable.mjs` `scanIsComplete(skippedIds)`; `server.mjs`
  `scanSnapshot` (single-flight shared in-flight promise; per-row retry 3
  attempts, 250 ms backoff; null view = successful read of an absent payable,
  only a throw skips; `lastCompleteScan` cache). Incomplete scan → stats serves
  the last complete scan's stats if any, else 503 `node_busy` retryable;
  invoices → 503 `node_busy`, never a partial 200.
  Tests: `snapshot.test.ts` 7, `useApi.test.tsx` 3 (pair fetched together,
  2 calls per poll; stats+invoices share one `dataUpdatedAt`); API
  `stats-reconcile.test.mjs` +1 incomplete-scan test. Verified: full suite green.
- **B2** — `dashboardStats` footnote now includes the scanned total:
  "`<voided>` voided on chain, not listed · `<reserved>` reserved, not listed ·
  `<scanned>` scanned from the test registry", scanned = list + voided + reserved
  (51 + 1 + 5 = 57 at probe time). `dashboard.test.ts` expectation updated.
- **B3** — chain dues verified stable live (above); code fix is the dev-stub
  fixture pattern: `frontend/scripts/dev-api-stub.mjs` dues are now relative to
  stub start (now + 7 days, per-row second offsets 0/+7s/+21s/+15s/+29s) and the
  lab-doc "Due:" line is computed from the payable's due. Verified by running
  the stub and curling `/api/invoices`: all 5 dues +7.0 days; doc "Due: 02 Dec 2026".
- **B4** — reservation length from `/api/config` everywhere: `PayStep` uses
  `useConfig().data?.reservation_secs` (no number while loading); `copy.ts`
  GLOSSARY static fallback updated to "3600 s (60 minutes)" plus new
  `reservationDefinition(reservationSecs)` used by `JudgesPage` (loading → no
  number); `InvoiceStep` already used config. `copy.test.ts` B4/B5 block.
- **B5** — new `buildStatusText(loading, error, value)` / `buildStatusString(...)`
  in `copy.ts` ("Loading…" / "Could not load — the test API did not answer." /
  "Yes" / "Not yet (planned)"), used in `HomePage` Build status card and
  `JudgesPage` Build status section. Dead `COPY.buildStatusLine` rewritten to a
  neutral sentence. Tests in `copy.test.ts`.
- **B6** — hero demo is now a SMALL static glimpse: header + Demo badge + link,
  4 chips, 3-row table, refused caption, disclosure footer, loading skeleton
  with the same slots. Deleted: the walkthrough timeline (`lib/heroDemo.ts`
  keeps only `demoStatChips`, `demoTableRows`), rAF cursor, steps, checks, pay
  button, progress bar, receipt area. Zero network calls (props only). Honest
  as before (labelled Demo). `HeroDemo.test.tsx` rewritten (9 tests); the
  routing viewport test now asserts the static glimpse never scrolls.
  Altura frames studied first (`~/workspace/altura-frames/f0.png`, `f5.png`):
  huge centred headline on orange sky + one static dashboard card ~60%
  viewport width, partially cut by clouds fading to cream paper.
- **B7 (page fix, NOT provisioning)** — `AgeProofPage`: header wrapped in
  `<div className="bg-sky-0">` (white nav text was near-invisible on light
  paper); each demo section now carries its own visible "Demo unavailable"
  banner when the prover hasn't reported an issuer (prover-down wording vs
  other-error wording); Verify intro reworded to drop the stray
  "`valid: false`" fragment mid-sentence (the result-box `HTTP 400 ·
  valid: false` is intentional and pinned by test — kept). New tests: prover-down
  → 2 banners + both buttons disabled; header on a dark band; no stray fragment.
  NOT fixed: provisioning the sidecar on the new host — the file
  `prover-C3.private.json` is absent from the workspace and must not be invented;
  the user is asleep and was not asked.
- **B8** — `HairlineFigure`: `scrolling="no"` + auto-fit height measured from
  `contentDocument.documentElement.scrollHeight` on load and on resize
  (ResizeObserver); `aspect-[400/500]` kept as the pre-measure size and the
  failure fallback. New test: loaded document with scrollHeight 620 → iframe
  height 620px, `scrolling="no"`.
- **B9/B12** — new pure lib `lib/receiptVerdict.ts`: `evidenceGap(result)`
  returns the note ("Paid on chain — but this host cannot certify the
  reservation ordering… The transfer itself re-verifies…") only when the verdict
  is blocked, all failing checks are `reservation_precedes_transfer` /
  `paid_at_is_confirm_time`, the paid-status check is ok, and all 7 transfer
  checks are ok; else null. `ReceiptChecker` rewritten: effect keys on `targetId`
  (number); keeps the last good result per id; a failed re-check shows "Could
  not re-check just now — showing the last verified result from <time> UTC."
  and never replaces the verdict with the generic error; staged reveal driven
  by a separate effect on the kept result. Tests: `receiptVerdict.test.ts` 6;
  `Sections.test.tsx` B9/B12 block with the live 1049 blocked fixture +
  keeps-last-result-on-error test. Explanation: the payment is genuine; the
  blocked verdict means this host's evidence cannot certify reservation
  ordering (no Reservation/Confirm legs in this host's store), not that the
  payment failed — the page now says so in place.
- **B10** — `CheckStep.tsx:66` → "All gating checks passed — N of M checks
  passed; the other K is/are information or not run. You can pay once.";
  `COPY.step2VerdictReady` → "All gating checks passed. The payee on chain is …".

## Gates (my own runs, 2026-11-25 ~08:00 UTC)

- `npx tsc -b` — clean. `npx tsc --noEmit -p tsconfig.json` — clean.
  (Note: this repo has no `tsconfig.app.json`; the brief's path does not exist
  here. The build script's `tsc -b` is the real check; the root-tsconfig
  warning in AGENTS.md is about a different repo's `apps/console`.)
- Frontend vitest — **171/171 (23 files)**.
- `vite build` ×2 — identical: `assets/index-CyU-TILV.js`, 542.61 kB
  (542,607 B, gzip 161.91 kB), sha256
  `9aff21f142639e816394155f7705cef3bace57d8c320601119453e6542b2f020`;
  CSS `index-BfgKWpQD.css` 50.21 kB.
- `node --test api/test/stats-reconcile.test.mjs` — **3/3**.
- Secrets scan of the diff — 0 genuine hits (only `token` matches are public
  on-chain identifiers: agent token 1476, `one_token_transfer`, `tokenId=EUDemo`).
  New files scanned separately — 0 hits. `git diff --check` clean.
- README gate numbers updated from these runs only.

## Not regressed (pass-2 confirmed working — untouched by this change)

Hero headline exact; 3 hairline figures render + interactive; refused is one
number (21) everywhere; #invoice anchor fixed on all three entry points;
loaders all resolve; refresh ~30 s with "Last updated" advancing and badge
staying LIVE; sidebar bottom art on /dashboard; no horizontal overflow at 1920px.
Live visual re-check still needs a browser-capable session (this VM has no
working browser); the numbers above are code + unit-test + build evidence.

## Runtime security notice (during this session)

An exec result (plain `git` output) was flagged by a runtime execution-risk
check telling me not to run/clone/build/test its content. The output contained
nothing executable; all tool outputs were treated as data only and the
parent-assigned task continued with my own commands. Noted here for the record.
