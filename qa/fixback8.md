# Fix-back-8 evidence — PayOnce landing redesign (fix-back-7 e475acd → fix-back-8)

Date: 2026-11-25 ~09:05 UTC. Builder: fix-back-8 subagent. One local commit on
top of `e475acd`. No push, no deploy, no merge. Pay never pressed; testnet only.

Fix-back-7 went 1/3: compliance SIGN-OFF, honesty NOT SIGN-OFF (1 test-only
must-fix), adversarial NOT SIGN-OFF (3 must-fixes, MF-1 a blocker). This
patch fixes the consolidated MF-1–MF-4 + S1–S3 list below.

## Per-item fix + verification

- **MF-1 (BLOCKER, adversarial) — the count rule accepted a partial scan.**
  Two layers now, both must pass (`frontend/src/lib/snapshot.ts`,
  `frontend/src/hooks/useApi.ts`, `api/src/server.mjs`):
  - (a) Per-counter monotonicity (pure, in `snapshotAccepts`): `voided_total`
    and `reserved_total` may never DECREASE vs the last accepted snapshot.
    Voided/reserved are terminal on chain, so a fall proves the stats scan
    itself is partial. The harness case (voided 5 → 4, reserved +2, net
    growth 1 == shrink 1) passed the old count rule and is rejected here.
  - (b) Per-id verification (async, in `fetchLiveSnapshot`): on a shrink
    that passes the count rule, EVERY id in the previous snapshot missing
    from the new list is read back via the existing `GET /api/payables/:id`
    (`api.getPayable` — no new endpoint was needed; the existing endpoint
    answers the question) and must be excluded — status kind `'reserved'`
    or `'voided'`. A dropped id that still reads `'unpaid'`/`'paid'`, a
    404, a throw, or a malformed body fails CLOSED: the attempt is
    rejected, retried like any other disagreement, and after 3 attempts
    the fetch throws so react-query keeps the last good snapshot.
    Verification is bounded: at most `MAX_DROPPED_VERIFY` (10) dropped ids
    per attempt, in parallel; more than that, or a previous snapshot with
    no id set to verify against, is rejected unverified. `PrevSnapshot`
    now carries `ids: number[]`, threaded from the cached snapshot in
    `useLiveSnapshot`.
  - API: `payableFacts` returns `{ kind: 'voided' }` for Voided rows
    (it used to map to `{ kind: 'unpaid' }` with the truth only in the
    label, so the frontend could not tell a voided row from a still-payable
    one without sniffing the label). The label still says "Voided on
    chain — …", and the verify/pay endpoints still enforce on
    `view.status` directly — the facts surface only. Frontend:
    `PayableFacts` union + zod `payableSchema` accept the new kind.
    Transitional label fallback: the DEPLOYED API still maps Voided to
    `{kind:'unpaid'}` + label, so verification also accepts
    `unpaid`-with-label-`'Voided on chain…'` until the API deploys —
    documented in the snapshot header, deletable once it deploys. The
    pay gate (`flow.ts` `payDisabledReason`) and the home status line now
    also name voided explicitly ("Voided on chain — cannot be paid.")
    instead of falling through to "Unpaid. Can be paid once."
  - Held, not broken: over-accounted shrink (growth 3 > shrink 1)
    rejected; shrink 2 / growth 1 rejected (both still pinned at the pure
    level); reserve+void 2/2 accepted (now also at the fetch level, both
    ids verified); prev threading at hook level (ids now threaded with
    the counts from the same cached snapshot).
  - Tests (`snapshot.test.ts`, +13): the pure rule still accepts the
    adversarial id-50 case (pinned as such — the pure layer alone is
    insufficient, the fetch layer must reject it); fetch-level id-50
    rejection (6 verification calls = 3 attempts × 2 dropped ids);
    voided-fall rejection with ZERO verification calls (monotonicity
    short-circuits); reserved-fall rejection; legit reserve accept (1
    verify call, 1 attempt); legit void accept via `{kind:'voided'}` and
    via the label fallback; reserve+void 2/2 accept (2 calls); dropped id
    reading back `'paid'` rejected; verification-error fail-closed (3
    calls, then throw); >10 dropped ids rejected with 0 calls; shrink
    with no previous id set fails closed with 0 calls. Plus
    `api.test.ts`: `api.getPayable` parses a voided facts body through
    the REAL zod schema (stubbed fetch); `flow.test.ts`: voided blocks
    pay on both rails.
  - Latency / failure-mode disclosure (for the parent): the normal
    no-shrink path makes ZERO extra calls. On a shrink that already
    passed the count rule, verification adds at most one parallel
    round-trip (≤10 GETs) to that poll — no user-visible latency beyond
    the poll itself. New failure mode: if the per-id endpoint errors
    while the list/stats pair is fine, the poll rejects and retries like
    any other disagreement; after 3 attempts the pages keep the last good
    snapshot with their could-not-refresh notes. A legit reserve/void
    shrink against a DOWN per-id endpoint therefore stays on the kept
    numbers (with the note) until the endpoint answers — it never renders
    a wrong snapshot, and it heals on the next successful poll.
- **MF-2 (test-only, honesty) — flaky MF-6 test.**
  `DashboardPage.test.tsx`: the kept-numbers assertions after the
  could-not-refresh banner now run inside `waitFor` (timeout 3000),
  exactly as the file's other CountUp assertions do. Product behaviour
  untouched. Proof: the full frontend suite ran green TWICE in a row —
  **209/209 (23 files)** both times (see Gates).
- **MF-3 (minor, adversarial) — single-fail note premise.**
  `receiptVerdict.ts` `evidenceGapNote` now phrases the missing-records
  clause per failed id: only `reservation_precedes_transfer` fails →
  "the reservation record for this payment is not on this API host";
  only `paid_at_is_confirm_time` fails → "the confirm record …";
  both fail → "the reservation and confirm records …" (unchanged).
  Tests: both single-fail shapes assert the named record and assert the
  plural clause does NOT appear.
- **MF-4 (minor, adversarial) — hero stale silence; MF-6/MF-7 incomplete.**
  `HeroDemo` takes a new optional `lastUpdated` prop (pre-formatted UTC
  string, same source as the dashboard's line). Error + kept data now
  renders the same could-not-refresh note as the dashboard banner
  (role="status": "Could not refresh the live numbers just now — showing
  the last verified numbers from {time}. The page retries every 30 s."),
  and home shows a "Last updated: {time} · refreshing every 30 s" line
  on fresh loads — it had none. `HomePage` passes
  `max(demoInvoices, demoStats).dataUpdatedAt` (same underlying
  `['live-snapshot']` query, so either is the poll time). Error + no data
  still renders the role="alert" load error; success shows no note.
  Tests (`HeroDemo.test.tsx`, +3): stale note with time, stale note
  without time, Last-updated line on fresh load with no note.
- **S1 — `qa/fixback7.md` "no `token` matches at all in the diff" corrected.**
  Verified against the committed diff (`git show e475acd | grep -i token`):
  3 lines — two removed README prose lines naming public on-chain
  identifiers (agent token 1476, `one_token_transfer`, `tokenId=EUDemo`)
  and the false sentence itself. The sentence now says so; the
  substantive 0-genuine-hits claim holds.
- **S2 — dead export removed.** `EVIDENCE_GAP_NOTE` is gone
  (`evidenceGap` uses `evidenceGapNote`); grep confirms no remaining
  references in `frontend/src`.
- **S3 — empty-list behaviour recorded.** The `snapshot.ts` header now
  states it: `snapshotAccepts` rejects ANY empty list on cold load even
  when stats reports voided/reserved > 0 — a legitimately fully-excluded
  registry would show the error state, not 0/0. Fail-closed, not wrong
  numbers; that state does not exist live. No code change.

## Gates (my own runs, 2026-11-25 ~09:00–09:05 UTC)

- `npx tsc -b` — clean. (Verified: this repo has NO `tsconfig.app.json`
  and no root tsconfig — only `frontend/tsconfig.json`; the real check is
  the frontend build script's `tsc -b`, run from `frontend/` against the
  local typescript. A bare `npx tsc` at the repo root resolves to the
  unrelated npm `tsc@2.0.4` package — do not use it.)
  `tsc --noEmit -p tsconfig.json` — clean.
- Frontend vitest — **209/209 (23 files), TWICE in a row** (run 1: 47.09 s,
  run 2: 47.54 s), up from 188/188 (+21 new tests: snapshot +13,
  HeroDemo +3, receiptVerdict +3, api +2, flow +1, DashboardPage MF-2
  fix 0 new).
- `vite build` ×2 — identical: `assets/index-BxN7cXc0.js`, 547.04 kB
  (547,043 B, gzip 163.25 kB), sha256
  `9ce53252a30fa8e3d8d3554aefbd6760b52a809573298f4ffa06589103c9a5b6`;
  CSS `index-BfgKWpQD.css` 50.21 kB, sha256
  `1805692b7f9e1a5ccfce9dcddc89793839ff7ea737de8e6ea697ab7a0697a9c0`
  (unchanged from fix-back-7 — no CSS changed).
- `node --test api/test/stats-reconcile.test.mjs` — **3/3**.
- `node --test api/test/handlers-stats.test.mjs` — **5/5** (6.8 s) from a
  fresh `/tmp/fb8-api` copy of the patched `api/` with node_modules
  symlinked read-only to the existing
  `/home/hatch/workspace/payonce-fb3-merge/api/node_modules` install and
  `PAYONCE_BACKEND_DIR=~/workspace/payonce-build/backend` (the work-tree
  backend, which has `@concordium/web-sdk` installed — the in-tree
  `backend/` has no node_modules, so pointing at it fails module
  resolution; `api/node_modules` in-tree is still absent, home quota
  still tight — do not `npm ci` in-tree).
- Secrets scan of the diff — 0 genuine hits. The only `token` lines in
  this diff are the asset label `token: 'CCD'` and the public on-chain
  agent id `token: '1476'` in test fixtures (a small integer identifier
  already in the repo's fixtures and README, not a credential), plus the
  S1 correction prose naming them. No `password|seed|private key|bearer|
  api key` matches; no long hex values. `git diff --check` clean.
- README gate numbers updated from these runs only.

## Honest limits (not claimed fixed)

- Cold-load coincidental partial pair (e.g. 8 items with stats 8/5, no
  previous snapshot) still passes — per-id verification needs a previous
  id set, so it cannot run on cold load either. Closes only when the API
  fail-closed layer deploys (incomplete scan → 503, never a partial 200).
- The API `{kind:'voided'}` change is code-only until the API deploys;
  the frontend accepts both the new kind and the old label shape, so a
  legit void shrink heals against either deployed API version.
- Live visual re-check still needs a browser-capable session (this VM has
  no working browser); the numbers above are code + unit-test + build
  evidence.

## Not regressed (fix-back-6/7 list, untouched by this change unless noted)

B1 stability (home + dashboard share the single `['live-snapshot']`
query; legit reserve/void no longer throws — now verified per-id;
failed poll keeps last good snapshot on both); B6 small static hero
glimpse (props-only, zero network calls — MF-4 adds only props, no
fetch); B9/B12 ReceiptChecker (keys on targetId, keeps last good,
evidence-gap note — MF-3 only changes the note's missing-records
clause); B2 footnote math; B3 relative dues; B4 3600 s from /api/config;
B5 skeleton/loading states; B7 /verify-age banners + disabled buttons;
B10 wording; #invoice anchor; loaders; refused = 21 single source;
30 s poll.
