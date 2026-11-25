# Fix-back-13 — pay-correctness stale `?payable=` + stale landing copy

Builder round: fix-back-13 (pass-2 fix-back round 8). Base: `c18347a`
(fix-back-12). Parent: `d6bf785`. Main: `0de5fc2`. One commit, no push /
merge / deploy. Testnet only.

The round-7 panel was 2/3 SIGN-OFF (compliance ✅, honesty ✅,
adversarial ❌, 2 must-fixes). This round fixes MF-1 + MF-2 and folds in
M-1–M-4. Everything below is from my own runs in the `/var/tmp` clone
(see §7 for why the gates ran there, not in the tree).

## 1. MF-1 (BLOCKER) — stale `?payable=` preload could pay the wrong invoice

### The mechanism

`PayFlowTabs.tsx` preloads `?payable=<id>` in an effect whose ONLY guard
was a ref holding the param value already seen:

```ts
const preloadedId = useRef<number | null>(null)
useEffect(() => {
  const id = Number.parseInt(params.get('payable') ?? '', 10)
  if (Number.isFinite(id) && id > 0 && preloadedId.current !== id) {
    preloadedId.current = id
    void loadFacts(id)
  }
}, [params, loadFacts])
```

Hand-picking an invoice (`onNumber` / `onLoaded`, via the lab list, the
number field, or a pasted/file invoice) loaded its facts but NEVER touched
`?payable=` or the ref. So after preload-3 → hand-pick-5, the ref still
said 3 and the facts said 5; a dashboard row Pay link back to
`?tab=pay&payable=3#pay` changed the param 3 → 3 (no change the ref
could see) and the effect suppressed the reload. The pay panel kept
showing "Payable 5 — 0.01 EUDemo" while the URL said payable=3. A user
who clicked Pay on row 3 and then paid would have paid 5.

### The fix (smallest correct change — two halves, both needed)

1. **The preload effect now compares the param against the LOADED facts
   id, not the ref** (`PayFlowTabs.tsx`, preload effect):
   reload whenever the URL names a payable other than the facts on screen.
   The ref keeps exactly one job — a load that 404'd is not retried on
   every tab switch — and loads in flight are not duplicated:
   ```ts
   useEffect(() => {
     const id = Number.parseInt(params.get('payable') ?? '', 10)
     if (!Number.isFinite(id) || id <= 0) return
     if (state.facts?.payable_id === id) return
     if (state.factsState === 'loading') return
     if (state.factsState === 'not-found' && preloadedId.current === id) return
     void loadFacts(id)
   }, [params, loadFacts, state.facts, state.factsState])
   ```
   The `loading` guard matters: hand-picking now syncs the URL (half 2),
   which fires this effect mid-load; without the guard the same id would
   load twice.
2. **Hand-picking syncs `?payable=`** (new `syncPayableParam`, `replace`
   so the back button is untouched), called from `onNumber`, `onLoaded`
   (when a payable id was found), and `onFresh`. The URL always names the
   loaded payable, so a later row Pay link to a different id is a real
   param change the effect can act on — a stale id can never be
   resurrected by a link the user did not click. Every load path also
   records its id in the ref (`loadFacts` sets `preloadedId.current = id`),
   so the not-found guard above sees the id actually tried.

Result: the pay panel ALWAYS shows the payable the URL names.

### Regression test (permanent, `PayFlowTabs.test.tsx`)

New describe block "PayFlowTabs ?payable= staleness (fix-back-13 MF-1) +
preservation (M-4)", 4 tests (fixture extended with payable 5:
`FACTS_5`, lab-list item 5, `STATS.payables_total` 3 → 4 to keep the
stats+list pair agreeing). A `NavCapture`/`LocationProbe` helper exposes
in-test navigation (exactly what a dashboard row Pay link does — a
react-router `Link` to `/dashboard?tab=pay&payable=<id>#pay`) and the
live URL search string.

- **Stale repro (adversarial sequence, verbatim):** preload
  `?tab=pick&payable=3` → hand-pick 5 in the Pick tab (facts show
  Payable 5, URL now names 5) → row Pay link to `?tab=pay&payable=3#pay`
  → pay panel shows "Payable 3 — 0.01 EUDemo", and the panel contains
  ZERO "Payable 5" nodes. **Passes.**
- **Reverse:** preload 3 → hand-pick 5 → Pay link to payable=5 → pay
  panel shows Payable 5, zero Payable 3 nodes. **Passes.**
- **No-payable:** `?tab=pay` with no payable → PrerequisiteNote
  ("Pick an invoice first — this step needs a payable loaded from the
  test registry."). **Passes.**
- **M-4:** `?payable=` survives a tab click (see §5).

**Negative controls (both run, both failed as required, fix restored
after each):**

- With the fix stashed (old component, new tests), the stale test FAILS
  at the URL-sync assertion — the old code never syncs `?payable=`.
- With the fix stashed AND the sync assertion temporarily skipped, the
  stale test FAILS at the panel assertion with "Unable to find an element
  with the text: /Payable 3 — 0.01 EUDemo/" — the exact judge repro: the
  pay panel still showed 5 after navigating to payable=3.

**Timing finding (test-only, not a product issue):** the hand-pick URL
sync lands through a `startTransition` navigation (React Router 6.30.6
with the `v7_startTransition` future flag), so it can arrive a beat
after the facts render. The first version of the test asserted the URL
synchronously and failed even with the fix in place; the test now
`waitFor`s the location. In a real browser the navigation flushes within
a frame; and even inside that window the fix holds — a row Pay link
lands on the effect, which compares against the loaded facts, not the
ref. The debug logging used to establish this lived only in the clone
and was removed before commit.

## 2. MF-2 — stale landing copy + full sweep

Fixed (all in `frontend/src/components/Sections.tsx`, each now linking
to the dashboard pay tabs):

| Location | Was | Now |
|---|---|---|
| VerifierSection empty state (`:475`) | "No paid invoice yet — pay one in the flow above and the checker runs here." | "No paid invoice yet — [pay one on the dashboard](/dashboard?tab=pick#pay) and the checker runs here." |
| Step-04 receipt card (`:644`) | "No paid invoice yet. Pay one above and it appears here." | "No paid invoice yet. [Pay one on the dashboard](/dashboard?tab=pick#pay) and it appears here." |
| How-it-works header (`:559`) | "A judge can run the whole flow in about thirty seconds…" (no location — the flow is no longer on this page) | "A judge can run the whole flow **on the dashboard** in about thirty seconds…" |
| File header comment (`:1`) | "Landing sections below the flow" | "Landing sections — the pay flow lives on /dashboard now (fix-back-12); nothing on this page pays anything." |

**Sweep results — everything else checked, left as-is, with reasons:**

- `Sections.tsx:587` comment "fourth step of the flow" — code comment
  about the how-it-works steps bento, which still describes the flow.
  Not user copy.
- `HeroDemo.tsx:161` "the table and chips above show live numbers" —
  a spatial reference INSIDE the hero demo card; the table/chips are
  literally above that caption in the same component. Still true.
- `Hero.tsx:4,43` comments ("not in a dark band above it", "the cream
  section below") — layout comments, still true.
- `PayFlowTabs.tsx:266`, `ReceiptStep.tsx:37`, `lib/api.ts:460,475`
  "transaction link(s) above" — dashboard pay-step context; the links
  literally render above the message. Still true.
- `DashboardPage.tsx` "above" references — dashboard-internal, still
  true.
- Grep after the fix: `Sections.tsx` contains zero "above"; no "flow
  above" / "try it above" anywhere in `frontend/src` (the one "try it"
  grep hit is the code comment "do not retry it forever" in
  `PayFlowTabs.tsx`).

No test asserted the old copy (grep over `*.test.*` for the old strings:
zero hits), so no test updates were needed for MF-2.

## 3. M-1 — snapshot test name qualified

`frontend/src/lib/snapshot.test.ts:621` (was: "…3 attempts x 5 s + backoff
= 18 s (MF-1 tick budget)"): now "…3 attempts x 5 s **verification** +
backoff = 18 s (**verification+backoff only — pair fetches can add up to
15 s each**) (MF-1 tick budget)". Pins unchanged (elapsed bounds,
verify-call counts); the test body and its comment already stated the
qualification — only the name did not.

## 4. M-2 — Pay-tab h2 heading scale

Confirmed inconsistency: the Pay-tab h2 was `text-[24px]
tracking-[-0.02em]` while every dashboard section h2 is `text-[22px]
tracking-[-0.01em]` (`DashboardPage.tsx:252,269,301,340,421,492`). Aligned
to the dashboard scale: `text-[22px] leading-[1.15] font-medium
tracking-[-0.01em] text-ink` (leading kept — the dashboard h2s carry no
leading class and `1.15` is the same tight leading the pay title had).
The facts-card h2 inside the Pick panel (`text-xl`) is a sub-heading,
not a section h2 — left alone.

**CSS effect (explained, not a regression):** `text-[24px]` was used
NOWHERE else in `frontend/src`, so Tailwind drops its rule: CSS
50,196 B → 50,166 B (−30 B), filename/hash changed
(`index-DGZdVGFE.css` → `index-DSO8HUzO.css`). Verified in the built
CSS: no `font-size:24px` rule remains (the remaining "24px" strings are
`h-[24px]` height and `rounded-[24px]` radius); `.text-\[22px\]{font-size:22px}`
was already in the bundle from the dashboard h2s. (Fix-back-12 §9 noted
`.text-[24px]` as one of the 8 rules the tab bar ADDED; this round removes
it again.)

## 5. M-3 — fix-back-12 §6(4) `.wrap` citation corrected

The citation was wrong: **no `.wrap` class exists anywhere** — grep for
`\.wrap` in `frontend/src/index.css`, `DashboardPage.tsx`,
`Sections.tsx`: zero hits. Corrected `qa/fixback12.md` §6(3) and §6(4)
in place (marked `[CORRECTED fix-back-13 M-3]`): the equal edges come
from the dashboard's single `<main id="main" className="min-w-0 flex-1
px-4 py-8 sm:px-8 sm:py-10">` (`DashboardPage.tsx:168`, closing `:525`),
with `<PayFlowTabs />` rendered inside it at `:517` — the same `<main>`
and the same `px-4 sm:px-8` edges as every other dashboard section. The
substance (equal edges) still holds; only the citation was false. The
landing sections' shared shell (`mx-auto max-w-[1101px] px-4 sm:px-6`)
was corrected the same way in §6(3).

## 6. M-4 — `?payable=` preservation test (permanent)

New test in the M-1/MF-1 block (see §1): render
`/dashboard?tab=pick&payable=3`, wait for Payable 3 facts, click the
Check tab — the location still reads `tab=check&payable=3` and the Check
panel still shows Payable 3. **Passes.** This pins `goTab`'s
param-preserving behaviour (`new URLSearchParams(prev)` + `tab` set)
that both the compliance and honesty judges noted was only proved by a
scratch test in round 7.

## 7. Gates

All gates ran in the `/var/tmp/payonce-fb13` clone (see §11 for why);
the clone's 5 changed files were verified byte-identical to the tree
(`cmp`) before every gate run, and the commit is made in the tree
(git writes work there) — change set in §10.

- `tsc -b` (frontend, clone): **CLEAN**, first attempt (~11 s). (In
  the tree, `tsc -b` cannot write its `tsconfig.tsbuildinfo` — the file
  is root-owned and every write to it returns EPERM, see §8; the
  identical check `tsc --noEmit -p tsconfig.json` in the tree is also
  clean, 15.4 s.)
- Frontend vitest (CLI `./node_modules/.bin/vitest run`, default pool):
  targeted `PayFlowTabs.test.tsx` **12/12**; full suite **261/261
  (24 files) TWICE** — run 1: 97.17 s, run 2: 97.52 s. (Baseline at
  c18347a: 257/257, 24 files; +4 tests, same file count: the 4 new
  MF-1/M-4 tests. The two mid-round failures were test bugs, not product
  bugs — see §8 — and the fix for each is in the committed test file.)
- `vite build` ×2 (scratch outDirs `/var/tmp/fb13-dist-a`,
  `/var/tmp/fb13-dist-b`): **IDENTICAL both builds** — JS
  `assets/index-DlYEx3rJ.js` 547.70 kB (547,702 B), sha256
  `8c133af88399adbdf1bdd948d763cba48137a149d007a1fb65f1ef0a47356d08`;
  CSS `assets/index-DSO8HUzO.css` 50.17 kB (50,166 B), sha256
  `1e29c3aa7789d2a34ae43a14d564c7c22014a826ae690f98224c55884ead2638`.
  vs fix-back-12 baseline: JS 547,060 B → 547,702 B (+642 B: the
  `syncPayableParam` helper + rewritten preload effect + call sites);
  CSS 50,196 B → 50,166 B (−30 B: `text-[24px]` dropped, §4). Build
  times 6.17 s / 6.02 s. The in-tree `frontend/dist/` is still the older
  stale build and was intentionally left untouched (quota-blocked by
  design, same as fix-back-12).
- API tests (`node --test test/stats-reconcile.test.mjs
  test/handlers-stats.test.mjs test/handlers-payable.test.mjs`):
  **15/15 PASSED** (stats-reconcile 3/3, handlers-stats 5/5,
  handlers-payable 7/7) in 7.5 s, from the clone's `api/` with a fresh
  `npm ci` `api/node_modules` (74 packages) and `backend/node_modules`
  symlinked to the existing lockfile-exact copy (web-sdk 12.0.3 — see
  §8; the clone's own backend `npm ci` could not complete in the EPERM
  waves). The diff touches no `api/` or `backend/` file.
- Secrets scan (`node qa/ci/secrets-scan.mjs .`): **0 genuine hits in
  the diff.** The scan reports the same 6 findings on the changed tree
  as on a pristine `c18347a` worktree (byte-identical output) — all the
  "mnemonic/seed phrase" regex firing on English prose, e.g.
  `Sections.tsx:716` "runs the verifier live from chain state and
  returns the full check list" (pre-existing UI string, not my lines).
  No key/token/seed/PEM/DOB pattern fires anywhere in the diff
  (separate `git diff` grep for api-key/secret/token/password/seed/
  private-key/bearer/PEM: zero hits).
- Grep audits (final, on the committed diff): `#invoice` in href/to in
  `frontend/src` = **0** (only comments and the routing test asserting
  zero); "flow above" / "try it above" = **0**; "above" remaining on the
  landing page = 2, both documented fine (§2).

## 8. CHECKER — NOT RUN (explicit, as required)

The skill's browser checker (`consistency.mjs`, `check.mjs`, `shoot.mjs`,
`perf.mjs`) runs in headless Chrome, which DOES NOT EXIST on this VM. It
was NOT run and is NOT claimed to have passed. It must run in a
browser-capable session after merge + deploy — this is a panel gate, not
a builder gate. The same applies to the clicktest. Visual/mobile claims
in this round are verified by code + unit tests only.

## 9. No-regression items held (spot-checked, all green)

- Landing display-only: zero `#invoice` in href/to (§7); the landing
  still has no pay flow (MF-2 only changed copy).
- Manual tabs: **zero timers** in `PayFlowTabs.tsx` (`grep -c
  setTimeout|setInterval|setImmediate` = 0); Continue only suggests;
  ARIA + keyboard untouched (all 8 original tab tests still pass).
- Wording restatement, snapshot rule, tick budget untouched:
  `VERIFY_TICK_BUDGET_MS = 20_000`, `POLL_MS = 30_000`,
  `retry: 0` in `useLiveSnapshot` (`useApi.ts:86`); M-1 renamed one test
  only, pins unchanged.
- CSS token system untouched; B1 single `['live-snapshot']` query, B6
  small static hero glimpse, B9/B12 ReceiptChecker logic, refused
  single source (`copy.ts:67` "One refused number, one basis,
  everywhere"), cold-load coincidental partial pair admission — none
  touched by this diff (`git diff --stat`: 5 files, all listed in §10).
- `Reveal`/`whileInView` pre-existing usage in `Sections.tsx` /
  `DashboardPage.tsx` left untouched (known non-compliance for a later
  round, flagged in `qa/fixback12.md`).
- The `Sections.tsx:216` (cycling highlight) and `:423` (checker
  replay) `setInterval`/`setTimeout` calls are pre-existing landing
  behaviour, not tab timers — untouched.

## 10. Change set (one commit)

```
 frontend/src/components/PayFlowTabs.test.tsx | 144 ++++--
 frontend/src/components/PayFlowTabs.tsx      |  67 ++++--
 frontend/src/components/Sections.tsx         |  27 ++++-
 frontend/src/lib/snapshot.test.ts            |   2 +-
 qa/fixback12.md                              |  14 ++-
 qa/fixback13.md                              | 335 +++++++++++++++++++++++++++
 6 files changed, 561 insertions(+), 28 deletions(-)
```

## 11. Environment incidents (this session)

- **EPERM waves, worse than the fix-back-12 notes:** `write()` returns
  EPERM in waves flipping on a seconds timescale, hitting shell builtins,
  `cp`, `tar`, `rsync`, `node`, `npm`, `tsc`, and `vitest` in turn — in
  BOTH the home tree and `/var/tmp`. Evidence: `tsc -b` in the tree fails
  ONLY on writing the root-owned `frontend/tsconfig.tsbuildinfo`
  (appending to it as root also fails); `vitest run` in the tree fails
  at config load writing `vitest.config.ts.timestamp-*.mjs` next to the
  config (3 consecutive retries failed, so the tree was abandoned for
  gates); a `tar` copy to `/var/tmp` failed on ~every file while a
  single-file `echo >` in the same directory succeeded seconds apart.
  `rsync` needed 16 attempts to complete the clone sync.
- **Gates ran in `/var/tmp/payonce-fb13`** (rsync copy of the tree at
  `c18347a` + my 5 changed files, byte-verified with `cmp`);
  `frontend/node_modules` is a symlink to the tree's (read-only use).
  `tsc -b` and both `vitest`/`vite` gates passed there on first attempt.
- **API `node_modules`:** in-tree `api/node_modules` AND
  `backend/node_modules` are both absent. `npm ci` in the clone's `api/`
  worked first try (74 packages, 3 s). Backend `npm ci` failed 12+3
  attempts in the EPERM waves (truncated `@concordium/web-sdk`
  package.json — `ERR_INVALID_PACKAGE_CONFIG`); fell back to symlinking
  `backend/node_modules` to the existing
  `~/workspace/payonce-build/api-persist/work/backend/node_modules`,
  whose web-sdk is exactly the lockfile version (12.0.3, verified).
  The API 15/15 then passed. The symlinked `node_modules` dirs were
  NOT committed (they are gitignored; the clone keeps them only for
  gates — the patch/commit contains source only).
- **Two mid-round test failures, both test bugs** (fixed in the committed
  test file, product code unchanged by either): (1) the FactsLine in
  check/pay panels reads "Payable N — … · Unpaid", so exact-text
  assertions inside those panels failed — switched to substring regex;
  the no-payable assertion matched 3 elements (disabled-reason span +
  two PrerequisiteNotes in hidden panels) — scoped it to the visible
  tabpanel. (2) the URL-sync assertion, made synchronous first — see
  the `startTransition` finding in §1.
- No `/dev/null` used anywhere; no `pkill -f`; nothing pushed / merged /
  deployed; `~/workspace/payonce-site-staging/` untouched.
