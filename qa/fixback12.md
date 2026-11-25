# Fix-back-12 — pay flow off the landing page, into /dashboard manual tabs

Base: d6bf785 (fix-back-11, on 3841254, main 0de5fc2). Live site still serves main 0de5fc2.
User order 2026-11-25 14:22 + 14:25 EET: the full pay flow was STILL on the landing page
(user caught it on his phone). Move it entirely into /dashboard as MANUAL tabs.

## 1. What was removed from the landing page

`frontend/src/pages/HomePage.tsx` rewritten (506 lines → 70, display-only):

| Removed | Where it lived | Where it went |
|---|---|---|
| 01 Pick an invoice (`InvoiceStep`) | HomePage | `PayFlowTabs` tab 01, /dashboard |
| 02 Check the invoice (`CheckStep`) | HomePage | `PayFlowTabs` tab 02, /dashboard |
| 03 Pay once (`PayStep`) | HomePage | `PayFlowTabs` tab 03, /dashboard |
| 04 Receipt (`ReceiptStep`, incl. home receipt verifier) | HomePage | `PayFlowTabs` tab 04, /dashboard |
| Try to break it (`TryPanel`) | HomePage | `PayFlowTabs` tab 05, /dashboard |
| Build status section (`BuildStatusCard`) | HomePage | deleted from landing; the component file is still used by JudgesPage, so it stays in the tree |
| Sidebar anchor nav (`#invoice/#check/#pay/#receipt/#try`) | HomePage | gone (no `#invoice` anchor target remains anywhere) |
| Sticky mobile pay bar (`StickyBar`) + `pb-24 md:pb-0` wrapper padding | HomePage | deleted — see §4 |
| `?payable=` preload, job SSE (`useJobEvents`), flow/sticky state | HomePage | preload lives in `PayFlowTabs`; `/?payable=N` now redirects to `/dashboard?tab=pick&payable=N#pay` |

Landing page after the change (display-only): Hero + HeroDemo (unchanged — small static
demo glimpse, props-only, zero network calls, size/behaviour untouched) + Features /
HowItWorks / HairlineFigures / InvoiceShowcase / VerifierSection / PlannerSection /
JudgesSection / CtaBand + Footer. Explanation (hairline figures + explainer sections)
is KEPT — it is explanation, not pay flow (the HowItWorks step titles 'Pick an invoice' /
'Check the invoice' / 'Pay once' / 'Receipt' still render as explainer text).

`/judges` route untouched (`JudgesPage.tsx` stays its own page).

## 2. The dashboard pay view — manual tabs

New `frontend/src/components/PayFlowTabs.tsx` (471 lines), mounted in `DashboardPage`
after the invoices/activity grid, inside `<section id="pay">` (the `#pay` anchor).

- Five tabs, one per step: **01 Pick an invoice, 02 Check, 03 Pay once, 04 Receipt,
  05 Try to break it**. Tab state is the URL query `?tab=` on /dashboard
  (`pick|check|pay|receipt|try`; anything else → `pick`), via `useSearchParams`.
  Clicking a tab updates the URL with `replace: true` (tab clicks stay out of the
  back-button history); `?payable=` is preserved across tab switches.
- MANUAL ONLY: no timer of any kind anywhere in the component (asserted by a test
  that reads the component source). No auto-rotate, no auto-advance. Completing a
  step SUGGESTS the next tab via an enabled Continue button — Pick → "Continue to
  Check →", Check → "Continue to Pay →", Pay → "View receipt →" (once the receipt
  loads) — but never switches tabs on its own. (Tests: completing step 01 enables
  Continue without switching; clicking it switches.)
- ARIA tabs pattern: `role=tablist/tab/tabpanel`, `aria-selected`, roving
  `tabIndex`, ArrowLeft/Right/Home/End keyboard navigation, focus-visible rings.
- Tab bar design (Altura reference: `~/workspace/altura-frames/` — huge centred
  headline on orange sky, small dashboard glimpse on clouds fading to cream
  paper): a paper pill bar (`rounded-full border border-line bg-paper-2 p-1`),
  active tab a white card pill (`bg-card text-ink shadow-sm ring-1 ring-line`),
  inactive tabs muted body text with a card hover; step numbers 01–05 muted;
  lucide icons reused from the old home sidebar. Cream/ember token system only,
  no hardcoded colours, one tab style, one radius scale.
- Step components moved VERBATIM (not duplicated): `InvoiceStep`, `CheckStep`,
  `PayStep`, `ReceiptStep`, `TryPanel` + the flow reducer and API callbacks from
  HomePage, minus the sticky bar, minus `reverifyTick`, minus the success
  `scrollIntoView` (the receipt is a tab now). The facts card lives INSIDE the
  Pick panel; other panels get a slim `FactsLine` ("Payable N — amount · status").
  Check/Pay panels show a prerequisite note + link-button when no invoice is
  picked (their step components are not rendered without facts); ReceiptStep and
  TryPanel always render (they handle idle/no-facts internally).
- `?payable=` preload uses a `preloadedId` ref: it loads only when the param value
  itself is new, so tab switches never re-load or clobber a hand-picked invoice.

Dashboard nav (`DashboardPage.tsx`): 'Pay an invoice' now points to
`/dashboard?tab=pick#pay` and stays on /dashboard (default tab 01). The sidebar
active-state bug (NavLink prefix-matching) is fixed for BOTH pills: Dashboard and
Pay are plain Links with explicit active logic — `payView` is true when the path
is `/dashboard` AND (`tab` param present OR hash is `#pay`); `overviewView` is
`/dashboard` AND NOT `payView`. Home/Judges keep NavLink. Per-invoice rows gained
a **Pay** link for unpaid/overdue rows only → `/dashboard?tab=pay&payable=<id>#pay`
(paid rows: View only). Bottom link "← Back to the payment flow" → "↑ Pay an invoice"
(`#pay`).

## 3. Link inventory — before / after (every `/#invoice` link at d6bf785)

Grep audit after the change: **zero `#invoice` in href/to attributes anywhere in
`frontend/src`** (remaining mentions are explanatory comments + the routing test
that asserts the absence).

| Location (d6bf785) | Was | Now |
|---|---|---|
| `AppHeader.tsx:120,126` (two CTAs) | `/#invoice` | `/dashboard?tab=pick#pay` |
| `Hero.tsx:61` (hero CTA 'Start verifying') | `<a href="#invoice">` | `<Link to="/dashboard?tab=pick#pay">Pay an invoice</Link>` |
| `Hero.tsx:49` (skip link target) | `skipTarget="#invoice"` | removed — skip link now targets `#main` ('Skip to main content') |
| `Sections.tsx:606` ('Open the payment list') | `/#invoice` | `/dashboard?tab=pick#pay` |
| `Sections.tsx:854` (CtaBand 'Verify an invoice') | `/#invoice` | `/dashboard?tab=pick#pay` |
| `Sections.tsx:883` (footer 'Pay an invoice') | `/#invoice` | `/dashboard?tab=pick#pay` |
| `DashboardPage.tsx:21` (sidebar) | `/#invoice` | `/dashboard?tab=pick#pay` |
| `ReceiptPage.tsx` (unpaid text + link) | "can be paid once, on the home page" + `/?payable=<id>` | "on the dashboard" + `/dashboard?tab=pay&payable=<id>#pay` |
| `ReceiptPage.tsx` (error text) | "transaction links on the home page" | "transaction links in the dashboard pay flow" |
| `/?payable=N` (shared links) | landed on the home flow | `<Navigate to={/dashboard?tab=pick&payable=N#pay} replace />` |

`lib/copy.ts`, README.md, VERIFY.md, `frontend/README.md`: no `#invoice` at d6bf785.
`qa/*.md` history files mention it (left untouched — history).

## 4. Deleted vs kept

- **DELETED**: `frontend/src/lib/sticky.ts` + `frontend/src/lib/sticky.test.ts`
  (used ONLY by HomePage; the sticky mobile pay bar is gone with the landing flow).
- **KEPT (moved, not duplicated)**: `InvoiceStep`, `CheckStep`, `PayStep`,
  `ReceiptStep`, `TryPanel` — all now rendered only inside `PayFlowTabs`.
- **KEPT (still used elsewhere)**: `buildStatusText`/`coSignerRunsAsSentence`
  (JudgesPage), `BudgetNote` (TryPanel), `BuildStatusCard` (JudgesPage).
- **KEPT, rewired**: `ReceiptPage.tsx` route (entry points now dashboard-only).
- **KEPT**: InvoiceShowcase 'Confirm receipt' link → `/receipt/:id`. Judgment call:
  it displays a COMPLETED payment's receipt — it is not a pay-flow entry and no
  pay action is reachable from the landing via it (an unpaid receipt page now
  links to the dashboard). Flagged for the round-7 judges if they disagree.
- **Left alone**: `buildStatusLine` in `copy.ts:50` (dead already at d6bf785, not
  made unused by this change).

## 5. Clicktest updates (not run — no browser on this VM)

`clicktest/clicktest.mjs`: 'P3 §1 fit' → 'pay tabs fit' on
`/dashboard?tab=pick#pay` (tab bar visible + no overflow at 1440); 'skip link (F4)'
now asserts 'Skip to main content' → `#main` (and returns to home first);
'invoice 3 + 9 checks + honest pay 503' drives the dashboard tabs (select invoice
3 → 'Continue to Check →' → 'Check invoice' in `#panel-check` → 'Continue to Pay →'
→ `#pay-eudemo`, 503 expectation kept); 'mobile 390' asserts NO sticky pay bar on
the landing (`div.fixed.inset-x-0.bottom-0` count 0), then drives the tabs at 390
(final assertion 'Pay 0.01 EUDemo (3 steps)'; screenshot renamed
`m-sticky-pay-390.png` → `m-flow-pay-390.png`).
`clicktest/measure.mjs`: ids `['invoice','check','pay']` → `['pay']` on the
dashboard-tabs URL; `stepCards` from `#pay section`; hero height → tablist height.
The 'dashboard console tabs' section is NOT touched — it references `#console-title`,
which does not exist anywhere in `frontend/src` at d6bf785 (pre-existing staleness).

## 6. Skill application — tasteskill 2.5 + Tailwind v4 (read in full first)

House rules applied, with locations:

- **(1) No caption/description under any image/render/visual.** The only visuals
  are the HeroDemo glimpse (no caption) and the hairline-figure diagrams (no
  captions). `PayFlowTabs.tsx`, `Hero.tsx`, `Sections.tsx` — no caption added.
- **(2) Every visual renders at 1440/1024/768/390.** HeroDemo is the one visual;
  it is a live-HTML app frame (the skill's "software's own UI as live HTML in one
  app-frame"), unchanged in size/behaviour; the tab bar is a flex pill row with
  `overflow-x-auto` so it cannot overflow at 390. VERIFY-BY-BROWSER — see §8.
- **(3) One section per screen.** Landing structure unchanged (hero alone on the
  first screen; sections are 1–2 screens at 1440×900 by the shared `.wrap` grid).
  The dashboard tabs show ONE step panel at a time — the old stacked-cards
  layout (all steps on one page) is gone. VERIFY-BY-BROWSER — see §8.
- **(4) Equal left and right content edges.** Tabs section uses the dashboard's
  shared `.wrap` (`mx-auto max-w-[1101px] px-4 sm:px-6`) — same edges as every
  other dashboard section. `PayFlowTabs.tsx:1–30`, `DashboardPage.tsx`.
- **(5) Hover micro-animations, no tilt/carousels/TIMED tabs.** Tab buttons:
  inactive `hover:bg-card/70`, active is a static pill; no transform, no tilt.
  Buttons keep the existing `PrimaryButton` hover/press. The tabs are MANUAL —
  the skill bans TIMED tabs, not manual ones (no conflict).
- **(6) More/better real photographs where they fit.** No new photography: the
  brief supplies none and there is no picture library — every picture comes from
  the brief or the user's own files. The dashboard tabs are product UI, which is
  the right visual for a software page. No stock photo used. See client slots (§7).
- **(7) Real full-colour icons; small diagram visuals in cards.** Tab icons are
  the existing lucide icons (full colour via the ember token); the facts card
  keeps its diagram visuals. No new icon set introduced.
- **(8) Effects: one only, tech subject.** No new shader/effect added; the
  existing hero glimpse is untouched. No effect on non-tech surfaces.
- **(9) Addresses/phones.** No address or phone anywhere in the changed files.
- **Checklist §5 — one system:** one tab style, one radius scale
  (`rounded-full` tab bar, `rounded-2xl` panels matching the dashboard card
  radius), one button pair (existing `PrimaryButton`/`GhostButton`), one link
  look, two boxes deep at most, one heading scale, text contrast via the
  existing cream/ember tokens. **Copy:** headings name things, buttons are
  verb + object ("Continue to Check", "View receipt"), at most two hero actions
  (unchanged).
- **Tailwind v4:** semantic tokens only (`bg-card`, `text-ink`, `border-line`,
  `bg-paper-2`, `text-body`, `text-muted`, `text-ember`) — no hardcoded colours
  in the new component; CVA-style variants as a plain variant function (no
  `cva`/`clsx`/`tailwind-merge` in `package.json`, so no new dependency);
  ARIA roles for tabs with keyboard navigation and focus-visible rings
  (`PayFlowTabs.tsx`).

House rules that could NOT be verified without a browser (see §8): (2) visuals at
all four widths, (3) section-per-screen heights at 1440×900, (5) hover behaviour,
plus the whole checker (§6 below).

**Conflict — skill vs user order:** the skill §6 bans scroll-reveal/fade-in/parallax.
The existing `Reveal`/`whileInView` (framer-motion) in `Sections.tsx`/`DashboardPage.tsx`
predates this round. The user order for this round is the pay-flow move, NOT a
motion strip — the user order wins (conflict rule) and the reveal code is NOT
removed here. Flagged as a known non-compliance for a later round.

## 7. Client slots / missing visuals

None. No new visual was needed: the only visual in the changed surface is the
existing HeroDemo glimpse (already supplied by the brief's earlier rounds), and
the dashboard tabs are live product UI. No stock/library image was invented or
hotlinked. If the round-7 judges want a hero photograph for the landing, that is
a client slot — the brief must supply the picture.

## 8. CHECKER — NOT RUN (explicit, as required)

The skill's browser checker (`consistency.mjs`, `check.mjs`, `shoot.mjs`,
`perf.mjs`) runs in headless Chrome, which DOES NOT EXIST on this VM. It was NOT
run and is NOT claimed to have passed. It must run in a browser-capable session
after merge + deploy — this is a panel gate, not a builder gate. The same applies
to the clicktest (`clicktest/clicktest.mjs`, `measure.mjs`): updated for the new
flow, NOT executed. Visual/mobile claims in this round (no horizontal overflow
at 390, tab bar fit, one-section-per-screen) are verified by code + unit tests
only.

## 9. Gates

- `npx tsc -b` (frontend): CLEAN (post-rebuild, after the PayFlowTabs
  import fix; re-run clean after the round-6 wording restatement, §12).
- Frontend vitest (CLI `npx vitest run`, `--pool=vmThreads` — see §10 for why):
  targeted 5 files **41/41** (20.11 s); full suite **257/257 (24 files) TWICE**
  — run 1: 98.54 s, run 2: 105.18 s. (Baseline at d6bf785: 246/246, 23 files;
  +11 tests, +1 file: new PayFlowTabs suite 8/8 + HomePage suite, minus the
  deleted sticky suite. The one mid-round failure — PayFlowTabs step-01 —
  was a missing `/api/stats` mock: `useInvoices` needs the agreeing
  stats+invoices pair; fixed in the test mock, not the component.)
- `vite build` ×2 (CJS gate config): IDENTICAL both builds — JS
  `dist/assets/index-BcWdgTs-.js` 547.06 kB (547,060 B, gzip 163.53 kB),
  sha256 `0916be6ee81f42c9378a336a8a069ed5a8eb5d7265721afe6198a1ca0341a525`;
  CSS `dist/assets/index-DGZdVGFE.css` 50.20 kB (50,196 B), sha256
  `47236f54bd727f4b1921e21efb638cf87254f0081742ed28f5f886329874f558`.
  Baseline at d6bf785 (rebuilt in a pristine extraction to confirm the
  method): JS 548.33 kB (548,331 B), sha256 `514cbfda…0063`; CSS 50.21 kB
  (50,211 B), sha256 `1805692b…9c0`. JS is 1,271 B SMALLER (the removed
  home flow — sticky bar, sidebar nav, job logic — outweighed the new tab
  component). CSS is 15 B smaller and the hash CHANGED — pure Tailwind v4
  tree-shaking, no style source touched: 12 rules dropped (utilities only
  the removed home flow used — `.border-r`, `.border-white/20`,
  `.text-white/80`, `.w-[200px]`, `.z-40`, `.lg:grid-cols-[2fr_1fr]`,
  `.mb-4`, `.p-5`, `.hover:bg-paper-2`), 8 rules added (utilities only the
  new tab bar uses — `.ring-1`, `.ring-line`, `.shadow-sm`,
  `.hover:bg-card/70`, `.mr-3`, `.leading-[1.15]`, `.text-[24px]`).
  The cream/ember token system is untouched.
- API tests (`node --test test/stats-reconcile.test.mjs test/handlers-stats.test.mjs
  test/handlers-payable.test.mjs`): **15/15 PASSED** 2026-11-25 13:26 UTC
  (6.32 s) from a fresh `/var/tmp/fb12-api` copy of the (unchanged) `api/`
  with read-only symlinked node_modules — re-run after the rebuild, as
  required (the 13:02 UTC 15/15 was from the pre-restart copy).
- Secrets scan of the diff: 0 genuine hits. The only key/token-looking
  lines are REMOVED lines (test-mock values 'TOK', 'AGENTTOKEN',
  '01000000' in fixtures, deleted with the old HomePage code).
- Grep audits (final, on the committed diff): `#invoice` in href/to in
  `frontend/src` = 0; 'Pay an invoice' outside /dashboard = 0 except
  dashboard + its links TO the dashboard (footer/Hero links, tests,
  comments, and TryPanel's disabled-reason text inside the dashboard tabs).
- Round-6 restatement (§12): wording-only; verified by reading all 7
  locations + a final sweep — no unqualified "inside the 30 s poll"
  remains; the renamed snapshot test pins the same assertions.

## 10. Environment incidents (this session)

- EPERM waves all day: `write()` on files opened O_RDWR returns EPERM, in waves
  that flip on a seconds timescale — shell builtins, python, node and git are all
  hit in turn. `git clone`/`git init` fail VM-wide during a wave. The first
  working clone was assembled by `git archive` + `cp -a .git` (HEAD set by shell
  write). A gate-only vitest config with `cacheDir` → `/var/tmp` was used
  (`vitest.fb12.config.mjs`, later `.cjs` — see below).
- The forks/threads vitest pools write every fetched module to a per-run
  `/tmp/<random>/web/<sha1>` cache dir (`cacheFs: true` is hardcoded in
  vitest's `createMethodsRPC` — no config knob disables it), and that write is
  what the EPERM wave blocks. The `--pool=vmThreads` pool fetches modules
  in-process and needs no such writes: the targeted 5 files ran 38/38 green
  under it during the wave, while the forks pool failed 9 consecutive attempts
  on the first fetch-cache write. Test bodies, config and counts are identical;
  only the pool differs. The full-suite gates therefore run under
  `--pool=vmThreads`, stated explicitly here (not silently).
- Vite bundles ANY config file, ESM included, into a timestamped `.mjs` next
  to it (`loadConfigFromBundledFile`) — a write the wave blocks at config load.
  A CJS config is loaded in-memory via `require.extensions` with NO file write,
  so the gate configs are CJS with an async export (dynamic `import()` for the
  ESM-only `@tailwindcss/vite` plugin, which a static `require()` refuses):
  `vitest.fb12.config.cjs`, `vite.fb12.config.cjs`. Deleted before commit.
- **Service restart 2026-11-25 ~13:03 UTC wiped /var/tmp entirely** (fresh
  tmpfs, 2% used): the first clone, all gate configs, the API copy and the
  first full-suite run (in progress) were lost. Home (`~/workspace`) survived
  intact; the patch tree stayed clean at d6bf785. The change set was rebuilt
  from scratch in a fresh `git clone` (clone works again post-restart) from
  the builder's own records — same design, same tests, plus the two fixes
  found in the first pass (tab-number space `{tab.num}{' '}` so the tab's
  textContent reads "01 Pick an invoice", and the HomePage test asserting the
  receipt STEP's idle text instead of the kept explainer "Receipt" heading).
  The API 15/15 result above is from the pre-restart copy (identical `api/`
  code — the diff touches no `api/` file); it is re-run after the rebuild.
- `node_modules` in the clone is a symlink to the patch tree's
  `frontend/node_modules` (fix-back-11 pattern). A baseline vitest run wrote
  `node_modules/.vite/vitest/results.json` through the symlink into the patch
  tree in the first pass; it was deleted (mtime proved it was mine) and the
  source tree verified clean. Post-rebuild runs use the CJS gate-only config
  with `cacheDir` → `/var/tmp`.
- No `/dev/null` used anywhere; no `pkill -f`; nothing pushed/merged/deployed;
  the patch tree was never written to.

## 11. No-regression items held

Tight snapshot rule; MF-1 tick budget VERIFY_TICK_BUDGET_MS=20_000 (bound
restated per §12 — 23 s is verification + backoff only; whole-tick worst
case 68 s); MF-3 manual AbortSignal combine; MF-4 retry 0 in useLiveSnapshot
ONLY; B1 single ['live-snapshot'] query shared home+dashboard (home still
shows display-only live totals in the hero — display, not interaction); B6
static hero glimpse unchanged; B2 footnote math; B3 relative dues; B4 3600 s;
B5 skeleton/loading; B7 /verify-age; B10 wording; refused=21 single source;
30 s poll; cold-load partial pair admission (NOT claimed fixed). The pass-1
`#invoice` anchor fix is MOOT (the anchor is removed, not preserved).

## 12. Round-6 panel must-fix — bound restatement (wording only, no code change)

The round-6 panel (honesty 0704, compliance 0706, adversarial 0715) closed
0/3 on ONE defect in fix-back-11 (d6bf785, this round's base): the "23 s +
pair fetches, inside the 30 s poll" bound was overstated. The adversarial
judge proved it with a MEASURED break (not arithmetic): pair fetches at
10 s/attempt — each under the 15 s cap — verification instant-fail → one
poll tick = 33,033 ms > 30,000 ms (3×10 s + 3 s backoff). Worst-case
arithmetic from the code: one hung pair fetch ≈ 38 s; worst tick = 3×15 s
pair + 20 s verify + 3 s backoff = 68 s. The pair fetches sit OUTSIDE the
tick budget (`snapshot.ts:439` Promise.all, no deadline, no budget
deduction; each capped only by the 15 s `FETCH_TIMEOUT_MS` in `api.ts:377`).

The fix restates the bound EVERYWHERE as verification+backoff only (23 s)
with the true whole-tick worst case (68 s; 38 s for one hung pair fetch),
and conditions any "inside the 30 s poll" claim on fast pair fetches. No
code budget was added around the pair fetches (that would be a new
mechanism needing its own tests). The 7 locations, each verified by
reading before editing:

1. `frontend/src/lib/snapshot.ts` header rule 6 — "inside the 30 s poll
   for ANY page count" restated: 23 s is verification + backoff only; the
   pair fetches sit outside the budget; whole-tick worst case 68 s; one
   hung pair fetch ≈ 38 s; measured break 33,033 ms; "inside the 30 s
   poll" holds ONLY when the pair fetches are fast; hung-first-page
   verification 18 s (63 s with a hung pair on top).
2. `frontend/src/lib/snapshot.ts` `VERIFY_TICK_BUDGET_MS` comment — same
   restatement; the heal sentence now adds "and under a sustained slow
   host it stays stale".
3. `README.md` fix-back-11 paragraph — restated + the pair-fetch qualifier
   the paragraph previously lacked (whole-tick worst case 68 s; heal
   > 20 s fails closed that tick and stays stale under a sustained slow
   host).
4. `frontend/src/hooks/useApi.ts` retry: 0 comment — restated; the
   "hung-first-page 18 s" figure is now pair-conditional (63 s with a
   hung pair on top); doubled whole-tick worst is 136 s.
5. `frontend/src/hooks/useApi.test.tsx` comment — "~23 s to ~46 s"
   corrected: verification+backoff doubles ~23 s → ~46 s, and the
   whole-tick worst doubles 68 s → 136 s.
6. `frontend/src/lib/snapshot.test.ts` test name — renamed to "caps
   fail-late verification+backoff at ~23 s (pair fetches mocked instant
   — outside the budget)"; the pins are unchanged (the test mocks pair
   fetches as instant, so it proves verification+backoff only). Its
   framing comment restated the same way.
7. `qa/fixback11.md` :52-53, :73-74, :92 — corrected in place; the
   :52-53/:73-74 lines directly contradicted the file's own scoping note
   (:86-90) admitting a hung pair fetch can push a tick past 30 s, and
   the :92 claim ("no unqualified 'one poll tick tops out at X s'
   remains") was false while those two lines stood.

Follow-on spots found by sweep and fixed the same way (same bound, same
overstatement): `README.md` fix-back-10 paragraph tail ("23 s, plus the
pair fetches"), `qa/fixback11.md` MF-2 section (misdescribed the corrected
bound as "23 s, plus the pair fetches"), `qa/fixback11.md` :58 bullet
("tops out at ~23 s" → "~23 s of verification + backoff"),
`frontend/src/lib/snapshot.ts` `MAX_DROPPED_VERIFY` comment and
`README.md` fix-back-9 paragraph ("heals on the same poll" → qualified
with the 20 s budget), and `frontend/src/lib/snapshot.test.ts:969`
(per-attempt fast-fail qualified as ~5 s, per-attempt not per-tick).

Heal-price qualification: no sentence anywhere now claims the heal path
is unaffected beyond 20 s or always lands eventually. The disclosures
already stated a > 20 s heal fails closed that tick and "while the host
stays that slow it never heals"; the adversarial two-consecutive-tick
simulation (50 dropped ids at 4.9 s/page → tick 1 23,004 ms / 50 calls
rejects, tick 2 23,045 ms rejects — permanent staleness under a sustained
slow host) is now cited in the header rule 6 price paragraph, exactly as
disclosed. The `qa/fixback11.md` price paragraph already said the same
and needed no change. Final sweep: no unqualified "inside the 30 s poll"
remains in `frontend/src`, `README.md`, `qa/fixback11.md` or this file —
the four remaining matches are either qualified in the same sentence
("only when the pair fetches are fast") or a quote of the old fix-back-10
claim as the thing being corrected.
