# Fix-back-14 — transient + settled pay-correctness (round-8 adversarial MF-1/MF-2/MF-3)

Builder round: fix-back-14 (pass-2 fix-back round 9). Base: `2637c7f`
(fix-back-13). Parent: `c18347a`. Main: `0de5fc2`. One commit, no push /
merge / deploy. Testnet only.

The round-8 panel was 2/3 SIGN-OFF (compliance ✅, honesty ✅,
adversarial ❌, 3 must-fixes). This round closes all three, plus the two
minors. Everything below is from my own runs in the patch tree (home
writes worked — no quota failure, no `/var/tmp` clone needed).

## 0. What fix-back-13 left open

Fix-back-13 closed the SETTLED stale-payable sequence (preload 3 →
hand-pick 5 → row Pay link to 3 → panel showed 5) by comparing the param
against the LOADED facts id and syncing `?payable=` on hand-pick. The
adversarial judge proved the fix incomplete: the panel could still show
(and let the user pay) a payable the URL does not name, in transient
windows AND in settled state. The judge's scratch tests did not survive
in `/var/tmp/judge-fb13-adversarial/payonce` (that copy is byte-identical
to the tree — verified with `diff -rq`, no scratch files); the T1/T2/S1/S2
regression tests below were recreated from the task descriptions of the
judge's repros.

## 1. MF-1 / T1 (TRANSIENT) — stale facts shown with enabled Pay while a reload is in flight

### The hole

`FACTS_LOADING` (`flow.ts:91-92`) kept the old facts in place, so
`PayFlowTabs.tsx:175-183` (old numbering) showed them for the whole
load (up to the 15 s fetch timeout). Repro: check 5 ready → row Pay
link to 3 with the reload held in flight → URL says `payable=3`, pay
panel still shows "Payable 5", EUDemo Pay button ENABLED.

### The fix (judge's suggestion, taken)

`FACTS_LOADING` now CLEARS the facts (`facts: null`) and resets
check/pay/freshness (`flow.ts`). While a load for id N is in flight
the pay panel shows the prerequisite note ("Pick an invoice first…"),
never a different payable's facts with an enabled Pay button.

### Regression test (permanent, `PayFlowTabs.test.tsx`, "T1")

Deferred fetch mock holds the `/api/payables/3` facts response in
flight: check 5 ready → Pay enabled for 5 → row Pay link to 3 → while
loading, the pay panel contains the prerequisite note, ZERO "Payable 5"
nodes, and NO Pay button at all → release the reload → panel shows
Payable 3, Pay DISABLED ("Run the check first." — the load reset 5's
check, §3). **Passes.**

## 2. MF-2 / T2 (TRANSIENT) — late stale resolution overwrites the current payable

### The hole

`loadFacts` had no generation guard; `FACTS_LOADED` overwrote
unconditionally. Repro: slow preload 3 → hand-pick 5 + check 5 → late
3 lands → panel shows Payable 3 while URL says `payable=5`, Pay
ENABLED (self-healed only when the effect re-loaded 5).

### The fix (judge's suggestion, taken)

Generation counter in `loadFacts` (`PayFlowTabs.tsx`): each load tags
its generation (`loadGen` ref); a resolution or failure belonging to an
older generation is ignored entirely — including a stale failure, which
must not 404 the payable the newer load is fetching.

### Regression test (permanent, "T2")

Slow preload 3 (held) → hand-pick 5 → check 5 → Pay enabled for 5,
URL says 5 → release the late 3 → panel still shows Payable 5, ZERO
"Payable 3" nodes, Pay still enabled for 5, and exactly ONE facts
fetch for 3 happened (the initial preload). **Passes.**

### Found while writing T2: the redundant-reload hazard (also fixed)

The first T2 run FAILED — not on the stale resolution, but earlier:
after hand-picking 5, the check panel showed "Pick an invoice first"
instead of the checked 5. Root cause: the hand-pick `?payable=` sync
lands through a `startTransition` navigation, a beat AFTER the facts
render (fix-back-13 finding). In that beat the preload effect saw the
STALE param (3) against the new facts (5) and fired a redundant
`loadFacts(3)` — which, now that `FACTS_LOADING` clears facts (§1),
wiped the just-loaded payable 5 until 3 resolved. The old code masked
this (it kept stale facts and the redundant load self-healed).

Fix: the preload effect now reloads ONLY on a param CHANGE. A new
`seenParamId` ref records the param value the effect last acted on; a
re-run triggered by a facts change alone (param unchanged) returns
without reloading. A param change that arrives mid-load is NOT marked
seen, so it is retried when the in-flight load settles instead of
being lost. The fb13 sequences still work: a real row Pay link
(5 → 3, after the sync has landed) is a param change and reloads; the
not-found guard (no retry on tab switches) is preserved. Verified by
the T2 test's fetch-count assertion (exactly 1 facts fetch for 3) and
by the fb13 regression tests staying green (§6).

## 3. MF-3 / S1+S2 (SETTLED — the most serious) — the check was never bound to a payable

### The hole

`payDisabledReason` never compared `check.result.payable_id` to
`facts.payable_id`, and `FACTS_LOADING`/`FACTS_LOADED` never reset the
check; `onNumber` swapped facts without resetting it. S1: check 5
ready → row link to 3 → settled facts 3 + URL 3 + Pay ENABLED,
`verify()` called only for 5. S2: check 3 ready → number-field pick of
5 → settled facts 5 + URL 5 + Pay ENABLED, `verify()` called only
for 3.

### The fix (judge's cheapest suggestion, taken — plus a second layer)

1. **Binding in the gate** (`flow.ts`, `payDisabledReason`): after the
   facts-null check, a ready check whose `payable_id` differs from the
   shown facts blocks Pay with "The check was run for a different
   invoice. Check again."
2. **Reset on every facts change** (`flow.ts`): `FACTS_LOADING`,
   `FACTS_LOADED` and `FACTS_NOT_FOUND` all reset check/pay/freshness
   (and `FACTS_LOADING`/`FACTS_NOT_FOUND` clear facts), exactly as
   `INVOICE_LOADED` already did for a new document. The `onFresh`
   path's reset behaviour is unchanged, extended to the other
   facts-change paths.
3. **Handler guard** (`PayFlowTabs.tsx`, `onPay`): never starts a pay
   unless the check is ready AND its `payable_id` matches the shown
   facts — the button is disabled in that state; this closes the
   handler path too.

Invariant (all three layers): Pay is enabled ONLY when the check that
passed was run for the payable currently shown (and named by the URL).

### Regression tests (permanent)

- **S1** (`PayFlowTabs.test.tsx`): check 5 ready → Pay enabled for 5
  → row Pay link to 3 → settled facts 3, URL 3, Pay DISABLED ("Run the
  check first.") → check 3 → Pay enabled for 3. **Passes.**
- **S2**: check 3 ready → Pay enabled for 3 → number-field pick of 5
  ("Other ways…" → type 5 → "Use this number") → settled facts 5, URL
  5, Pay DISABLED → check 5 → Pay enabled for 5. **Passes.**
- **Unit** (`flow.test.ts`): `payDisabledReason` blocks a ready check
  for payable 5 against facts 3 (both rails) and allows it when the
  ids match; `FACTS_LOADING` clears old facts and resets
  check/pay/freshness; `FACTS_LOADED` resets check/pay/freshness;
  `FACTS_NOT_FOUND` clears facts and resets check/pay/freshness.
  **Passes.**

### Negative controls (fix stashed, tests kept)

With the source fixes stashed (`git stash push` on `flow.ts`,
`PayFlowTabs.tsx`, `HeroDemo.tsx` only) and the new tests in place,
all 8 new tests FAIL (4 flow unit + T1/T2/S1/S2) while the 24
pre-existing tests in those files still pass — the new tests are the
discriminating ones. Fix restored with `git stash pop` afterwards;
working tree verified identical to before the stash.

## 4. Server gap — OPEN ITEM (not fixed in this round)

`api/src/server.mjs` `handlePay` (~635) still never calls
`verifyBeforePay` (only asset/status/doc-hash-if-supplied checks, plus
the G8 age gate). The client-side binding in §3 is the fix for this
round; **the server is NOT protected by it** — a client that calls
`POST /api/payables/<id>/pay` directly, without a prior verify for
that payable, is not stopped server-side. Deliberately NOT changed
here: adding the call changes API behaviour and needs its own proof
with the API tests. Left as a known open item for a later round. Do
not claim the server is protected.

Verified by reading `handlePay` at `api/src/server.mjs:635-700`:
asset check, doc-hash-if-supplied check, Paid/Reserved/Voided checks,
age gate, then `createOrReturnJob` — no `verifyBeforePay` call.
(`verifyBeforePay` is imported and used at line ~505 in the verify
handler only.)

## 5. Minors

- **N1** — `HeroDemo.tsx:14`: stale comment "the flow section below"
  fixed — the comment now says the skeleton holds the card's height
  "so the sections below it do not jump". Comment-only; no flow
  section exists below the hero on the landing anymore.
- **N2** — `onFresh`'s `useCallback` deps now include
  `syncPayableParam` (`PayFlowTabs.tsx`, was `[loadFacts]` only).
  Harmless before (`setParams` is stable); added for hygiene.

## 6. No regressions — everything round-8 held

- MF-1 settled sequence (preload 3 → hand-pick 5 → Pay link to 3 →
  shows 3) stays green (fb13 regression tests, in both vitest runs).
- Landing display-only: zero `'#invoice'` in `href`/`to` in source
  (the 5 grep hits are all in TEST files asserting exactly that).
- Manual tabs: zero timers in `PayFlowTabs.tsx` (grep: 0
  `setTimeout|setInterval`); Continue only suggests; ARIA + keyboard
  tests green.
- `payDisabledReason` P3 §6 order otherwise unchanged (existing
  flow tests green, including the "allows pay" guard test against
  over-blocking).
- No Pay button was ever pressed in any test: tests assert the button
  is DISABLED (aria-disabled + dropped onClick, `ui.tsx:103-108`) or
  absent. Testnet only throughout; no seed/key/token printed, logged
  or committed.

## 7. Gates (all run in the patch tree, except API tests — see below)

- **tsc**: `npx tsc -b` from `frontend/` — exit 0, no output.
  (No `tsconfig.app.json` / root tsconfig; `tsc -b` is the real check
  and it worked — no EPERM fallback needed. Tree stayed clean of
  build artifacts afterwards.)
- **Frontend vitest, full, run 1**: 24 files, **270/270 passed**,
  duration 154.80 s (wall 2m47.7s).
- **Frontend vitest, full, run 2**: 24 files, **270/270 passed**,
  duration 105.21 s.
- **Vite build ×2**: build 1 in 21.59 s, build 2 in 6.63 s — identical
  output both times: `dist/assets/index-BdpF3XaB.js`, 548.27 kB
  (548,267 bytes), sha256
  `431a194f8e85152d83de87a20375f43849af064f5df5d808aa80275661568822`;
  `dist/assets/index-DSO8HUzO.css`, 50.17 kB (50,166 bytes), sha256
  `1e29c3aa7789d2a34ae43a14d564c7c22014a826ae690f98224c55884ead2638`.
  (The >500 kB single-chunk warning is pre-existing, unchanged by
  this round.) `dist/` is gitignored — the tree stayed clean of it.
- **API tests** (`node --test` on stats-reconcile + handlers-stats +
  handlers-payable): **15/15 pass** (3/3 + 5/5 + 7/7), 8.9 s.
  Run from a `/tmp/fixback14-api` copy of `api/` (in-tree
  `api/node_modules` is absent) with `node_modules` symlinked
  read-only from `/var/tmp/payonce-fb13/api/node_modules`; no install
  into the builder tree, no writes through the symlink.
- **Secrets scan of the diff**: 0 genuine hits (pattern scan for
  keys/tokens/secrets/Bearer/PEM/AKIA/ghp_/xox + ≥40-char token scan;
  the only long string is the comment fragment
  "Verify/document/invoices/stats/config/health").
- **Grep audit `'#invoice'`**: zero `href`/`to` hits in source (see §6).
- **Browser**: no working browser on this VM — visual claims verified
  by code + unit tests only. The browser checker claim remains a
  post-deploy browser-session step (untouched, as instructed).

## 8. Files changed

- `frontend/src/lib/flow.ts` — FACTS_LOADING clears facts + resets
  check/pay/freshness; FACTS_LOADED / FACTS_NOT_FOUND reset
  check/pay/freshness; `payDisabledReason` binds check to facts by
  `payable_id`.
- `frontend/src/components/PayFlowTabs.tsx` — generation guard in
  `loadFacts`; seen-param guard in the preload effect; `onPay`
  check-binding guard (+ `state.check` dep); `onFresh` deps + N2.
- `frontend/src/components/HeroDemo.tsx` — N1 comment fix.
- `frontend/src/lib/flow.test.ts` — 5 new unit tests (mismatch block
  ×2 directions incl. allow-when-matching, FACTS_LOADING /
  FACTS_LOADED / FACTS_NOT_FOUND reset).
- `frontend/src/components/PayFlowTabs.test.tsx` — verify fixtures in
  `mockApi` (verify endpoint answered before the facts branch), a
  deferred-facts mock factory, `runCheck` helper, and the 4 permanent
  regression tests T1/T2/S1/S2.
