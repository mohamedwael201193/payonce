# Fix-back-15 — pending-sync guard replaces seen-param (round-9 adversarial MF-1/MF-2)

Builder round: fix-back-15. Base: `a0b4c66` (fix-back-14). One commit,
no push / merge / deploy. Testnet only.

The round-9 panel was 2/3 SIGN-OFF (compliance ✅ 0759, honesty ✅ 0761,
adversarial ❌ 0763, 2 must-fixes). This round closes both. Everything
below is from my own runs in a hardlink scratch copy
(`/home/hatch/.fb15-gates`, same device as the tree — `/var/tmp` is a
different filesystem, so `cp -al` there fails with cross-device errors;
the copy was verified byte-identical to the tree before each gate run,
and the builder tree itself was never written by any test/build run:
`tsc -b`, vitest and vite build all ran in the copy only).

## 0. What fix-back-14 left open

Fix-back-14 closed the transient stale-facts windows with a generation
guard (T2) plus a `seenParamId` guard in the preload effect (the T2
beat: a hand-pick's `?payable=` sync lands a beat after its facts
render, and the effect must not reload the stale param in that beat).
The round-9 adversarial judge proved the seen guard strands the panel:
it records only params the preload effect acted on — a direct load
(`onNumber`/`onLoaded`/`onFresh`) never updates it, and the generation
guard can void a seen load's delivery — so `seen === param` no longer
means "that param's load delivered". The T2-beat state and the stranded
state are IDENTICAL (param 3, facts 5, seen 3, preloadedId 5, factsState
loaded) yet need opposite actions, so no state-based tweak of that guard
can satisfy both; it must track delivery (or the pending sync), not mere
param sightings.

## 1. MF-1 (Serious) — the seen-param guard strands the panel on the wrong payable

### The hole

`PayFlowTabs.tsx:259` (fb14 numbering): `if (seenParamId.current === id) return`.
Repro (judge scratch X1, durable copy
`~/workspace/judge-fb14-adversarial/JudgeFb14Adversarial.test.tsx`):
preload 3 → number-field pick 5 with `/api/payables/5` held → row Pay
link to 3 while 5 is in flight → release 5. Observed on fb14 code:
panel shows Payable 5 while URL says `payable=3`; facts fetches for 3
= 1 (only the initial preload — no retry ever fires); tab switches do
not heal it (X1b); checking the shown 5 re-enables Pay for 5 while the
URL still says 3. This breaks the fb13 MF-1 settled invariant ("URL
always names the loaded payable").

Negative-control reproduction (source fix stashed, tests kept — §6):
X1 fails on fb14 code at `expect(ctl.factsCalls(3)).toBe(2)` with
`expected 1 to be 2` — the retry never fires, exactly as the judge
described.

### The fix (judge's suggested direction (a), taken)

The `seenParamId` ref is REMOVED entirely (zero references remain in
`frontend/src`). In its place:

- `pendingSyncId` (`PayFlowTabs.tsx:217`) — the id of the most recent
  `?payable=` sync not yet observed to land. `syncPayableParam`
  (`:237`) records it SYNCHRONOUSLY, before the startTransition
  navigation lands.
- `lastSearch` (`PayFlowTabs.tsx:227`) — the query string the preload
  effect last observed. Any observed change resolves a pending sync:
  it either landed (param now names the pending id) or a later
  navigation superseded it (a row link / tab click issued before the
  sync landed — the router's final URL names something else). Either
  way the sync is over and must not suppress a later load; without
  this a superseded sync would strand the panel exactly like
  `seenParamId` did.
- The preload effect (`:258-286`) now suppresses a reload ONLY while a
  sync to a DIFFERENT id is outstanding (`:284`). With no sync
  outstanding the param is current, and a mismatch against the loaded
  facts always reloads — including a param change that arrived mid-load
  and is retried when the in-flight load settles. The loading guard
  (no duplicate loads) and the not-found + `preloadedId` guard (a 404'd
  id is not retried on tab switches) are unchanged.

Why this distinguishes the two identical-looking states: in the T2
beat the visible param (3) is stale because a sync to 5 is
outstanding (`pendingSyncId = 5 ≠ 3` → suppress); in X1 the sync to 5
has already landed (pending cleared on the observed search change)
and the row link to 3 has landed too, so when 5 settles there is no
sync outstanding (`pendingSyncId = null` → reload 3).

### Regression tests (permanent, `PayFlowTabs.test.tsx:699-824`)

- **X1** (`:703`, judge scratch verbatim, including the transient-5
  waitFor — the transient render IS observable, the first run passed):
  3 → 5 (held) → row link to 3 mid-load → release 5 → panel settles
  on Payable 3, URL `payable=3`, facts fetches for 3 = 2. **Passes.**
- **X1b** (`:728`, judge scratch ADAPTED — the scratch version asserts
  the strand itself as a diagnostic, so it cannot pass on fixed code;
  see §5): same setup → healed panel stays on 3 across Check/Pay tab
  switches (facts fetches for 3 stay 2), Pay DISABLED ("Run the check
  first.") until 3 is checked, checking 3 enables Pay for 3 with URL
  still `payable=3`. **Passes.**
- **X2** (`:767`, judge scratch verbatim): 3 fails, 5 fails, explicit
  re-select of 3 re-fetches it (facts fetches for 3 = 2). **Passes —
  but see §5: it also passes on fb14 code, so it is a regression guard,
  not a discriminator.**
- **X6** (`:807`, judge scratch verbatim, control): a 404'd id is
  fetched exactly once across tab switches. **Passes.**

### T2-vs-X1 both-cases proof (the judge's required (a) + (b))

- (a) T2 still heals: the existing T2 regression test
  (`PayFlowTabs.test.tsx`, "T2: a late stale load of 3 never overwrites
  the checked payable 5") stays green in both full runs — slow preload
  3 → hand-pick/check 5 → late 3 lands: panel never shows 3, Pay stays
  enabled for 5, exactly 1 facts fetch for 3. The pending-sync guard
  suppresses the redundant reload in the T2 beat exactly as the seen
  guard did.
- (b) The X1 strand is gone: X1 + adapted X1b above — after the
  sequence the panel shows Payable 3 with URL `payable=3`
  (facts fetches for 3 = 2), and the healed state survives tab
  switches.
- Severity bound preserved in every transient mismatch: while a reload
  is in flight the pay/check panels show the prerequisite note (zero
  stale payable, no Pay button — T1 test green); Pay stays DISABLED
  ("Run the check first") until the shown payable is checked, and the
  fb14 S1/S2 binding (check bound to facts by `payable_id` in both
  `payDisabledReason` and `onPay`) is untouched — all S1/S2 tests
  green.
## 2. MF-2 (Minor) — a failed load's error banner survives the next successful load

### The hole

`PayFlowTabs.tsx:184-190` (fb14 numbering): the catch sets `pageError`;
the success path never cleared it. Repro (judge scratch X3): preload
3, reject its fetch with a `TimeoutError` → banner "The testnet did not
answer in time. Showing the last verified data." appears → number-pick
5, loads fine → banner still on screen (count 1, expected 0).

### The fix (one line, `PayFlowTabs.tsx:185`)

`setPageError(null)` on successful `FACTS_LOADED`, in `loadFacts`,
after the generation check — so a stale resolution (which returns
before the dispatch) can never clear an error belonging to the current
load. No other success path needed it: `onFresh` already clears before
its create call.

### Regression test (permanent, `PayFlowTabs.test.tsx:787`)

**X3** (judge scratch verbatim): failed load of 3 → banner shown →
successful load of 5 → banner count 0 AND "No payable with this number
is on the test registry." count 0 (the latter disappears because
factsState leaves `not-found`). **Passes.**

### The adjacent wart — LEFT UNFIXED, deliberately

Every load failure dispatches `FACTS_NOT_FOUND`, so the pick panel also
shows "No payable with this number is on the test registry." for a
network error on a payable that may exist. Fixing it needs a distinct
factsState value (new reducer action + effect branch + render branch),
which touches the exact no-loop invariant X6 guards — not a zero-risk
change, so per the brief it is left as-is and recorded here. The
failing-load banner itself is now correct (timeout wording for
timeouts, via `api.request` → `ApiError`), and a later success clears
it (X3).

## 3. No regressions — everything round-8/round-9 held

- MF-1/T1: while a reload is in flight the pay/check panels show the
  prerequisite note, zero stale payable, no Pay button (T1 green).
- MF-2/T2: generation incremented on every `loadFacts` call (single
  entry point, untouched); stale resolutions AND stale failures ignored
  (T2 + judge X4 verbatim green — see §5).
- MF-3/S1+S2: binding in BOTH `payDisabledReason` (`flow.ts:162`,
  untouched) and `onPay` (`PayFlowTabs.tsx:359`, untouched); Pay
  enabled ONLY when the check that passed was run for the payable shown
  (S1/S2 + judge X7 verbatim green — see §5).
- 404 no-loop: exactly 1 fetch for a 404'd id across tab switches
  (X6, folded in).
- Landing display-only: zero `#invoice` in `href`/`to` in
  `frontend/src` (the only `#invoice` hits are comments and test
  assertions); zero timers in `PayFlowTabs.tsx` (grep count 0);
  dashboard manual tabs only (user-clicked, never auto-advancing).
- B1 snapshot rule + B6 small hero unchanged: diff vs `a0b4c66` touches
  ONLY `frontend/src/components/PayFlowTabs.tsx`,
  `frontend/src/components/PayFlowTabs.test.tsx`, and this qa doc —
  no snapshot/hero/flow/api files in the diff.
- No Pay button was ever pressed in any test: tests assert the button
  is DISABLED (aria-disabled) or absent. Testnet only throughout; no
  seed/key/token printed, logged or committed.

## 4. Gates (all run in the hardlink scratch copy — never in the builder tree)

- **tsc**: `npx tsc -b` from `frontend/` — exit 0, no output.
  (No EPERM fallback needed; the copy's `tsconfig.tsbuildinfo` was
  deleted before the run so the tree's copy was untouched.)
- **Frontend vitest, full, run 1**: 24 files, **275/275 passed**
  (270 baseline + 5 new), duration 97.85 s.
- **Frontend vitest, full, run 2**: 24 files, **275/275 passed**,
  duration 96.92 s.
- **Vite build ×2**: build 1 in 6.42 s, build 2 in 5.11 s — identical
  output both times: `dist/assets/index-CssXNZVX.js`, 548.37 kB
  (548,370 bytes), sha256
  `a6ddefd57b92ed299e8cbf4a2a1bb88c2b073c269c4d45d75b9141c7a84cf734`;
  `dist/assets/index-DSO8HUzO.css`, 50.17 kB (50,166 bytes), sha256
  `1e29c3aa7789d2a34ae43a14d564c7c22014a826ae690f98224c55884ead2638`
  (CSS name/hash identical to fb14 — no style change; JS name/size
  changed, +103 bytes vs fb14's 548,267, as expected for the new
  guard). The >500 kB single-chunk warning is pre-existing.
- **API tests** (`node --test` on stats-reconcile + handlers-stats +
  handlers-payable): **15/15 pass** (3/3 + 5/5 + 7/7), 5.37 s. Run
  from a `/tmp/fb15-api` copy of `api/` with a fresh `npm ci`
  (`/var/tmp/payonce-fb13/api/node_modules` no longer exists — the
  VM reboot wiped `/var/tmp` — and in-tree `api/node_modules` is
  absent), `PAYONCE_BACKEND_DIR=~/workspace/payonce-build/backend`.
- **Secrets scan of the diff**: 0 genuine hits (pattern scan for
  keys/tokens/secrets/Bearer/PEM/AKIA/ghp_/xox + ≥40-char token scan;
  the only long string is the comment fragment
  "Verify/document/invoices/stats/config/health", as in fb14).
- **Grep audit `'#invoice'`**: zero `href`/`to` hits in source (see §3).

## 5. Judge scratch file, verbatim, against the fixed code

The durable judge file
(`~/workspace/judge-fb14-adversarial/JudgeFb14Adversarial.test.tsx`)
was copied into the scratch copy only, run, and deleted (it is not in
the tree): **7/8 pass** — X1, X2, X3, X4, X5, X6, X7 all green. The
single failure is X1b VERBATIM, which asserts the old stranded state
as a diagnostic (`expect(ctl.factsCalls(3)).toBe(1)`); it fails with
`expected 2 to be 1` — the retry fired, i.e. the strand is gone. That
is the intended failure: the folded in-tree X1b (`PayFlowTabs.test.tsx:728`)
asserts the healed state instead.

## 6. Negative control (fix stashed, tests kept)

With the source fix stashed (`git stash push` on
`PayFlowTabs.tsx` only) and the new tests in place, the
`PayFlowTabs.test.tsx` file run gives **3 failed / 18 passed**: X1,
X1b-adapted and X3 FAIL on fb14 code (X1 at `factsCalls(3)` 1 vs 2 —
§1), while all 16 pre-existing tests in the file still pass and X6
passes (control). Fix restored with `git stash pop`; file re-run
21/21 green; working tree verified identical to before the stash
(`pendingSyncId` ×5, `seenParamId` ×0, stash list empty).

Correction to the judge's prediction, found by this control: **X2
passes on fb14 code too** (it was listed as "expected to FAIL"). The
judge's analysis said "seen=3 from the first load" eats the re-select,
but the effect overwrites `seen` to 5 when it fires the 5-load, so the
re-select of 3 is not eaten. X2 is kept as a regression guard for the
fail → re-select → re-fetch path, not claimed as a discriminator.

## 7. Honest limits

- **No live browser on this VM** — visual claims verified by code +
  unit tests only. No visual check was run; the browser-session step
  remains post-deploy work, as in fb14.
- **No superseding-navigation live test**: the `lastSearch` rule (a
  sync superseded by a row link issued before it lands) is covered by
  reasoning + the X1/X2 paths, not by a dedicated test — the
  interleaving needs a hand-pick whose sync has not landed when a row
  link fires, which the judge's tests never construct (they wait for
  `payable=5` first). If round-10 wants it, the test is: hold facts 5,
  hand-pick 5, row-link to 3 WITHOUT waiting for `payable=5`, release
  5 → must settle on 3.
- **Server gap (fb14 §4) still open**: `handlePay` still never calls
  `verifyBeforePay` server-side. Deliberately NOT changed here.
- **The MF-2 wart (§2) is left open** by design (see above).

## 8. Files changed

- `frontend/src/components/PayFlowTabs.tsx` — MF-1: `seenParamId`
  removed; `pendingSyncId` (`:217`) + `lastSearch` (`:227`) added;
  `syncPayableParam` records the pending sync synchronously (`:237`);
  preload effect suppresses reloads only while a sync to a different
  id is outstanding (`:284`). MF-2: `setPageError(null)` on successful
  `FACTS_LOADED` (`:185`).
- `frontend/src/components/PayFlowTabs.test.tsx` — new describe block
  (`:699-824`): judge X1/X2/X3/X6 folded in verbatim, X1b folded in
  adapted to the healed state, with the judge's hold/reject mock
  factory. 5 new tests (275 total, was 270).
- `qa/fixback15.md` — this file.
