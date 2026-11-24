# PayOnce frontend — report

Date: 2026-11-24. Status: **built, tested, click-tested, ready for the paired judge.**
Work dir: `~/workspace/payonce-build/frontend/`. Spec: P3 in
`~/workspace/user/files/PLAN_V5_PAYONCE_EXECUTION.md` lines 1151–1847;
design system in `~/workspace/payonce-build/design/`.

## How to run it

```bash
cd ~/workspace/payonce-build/frontend
npm install
# Against the recorded-data stub (real testnet snapshot, labelled, never sends a tx):
npm run dev:stub   # terminal 1 — http://127.0.0.1:7401
npm run dev        # terminal 2 — http://localhost:5173 (proxies /api to the stub)
# Against the real backend: set VITE_API_BASE to its origin, then `npm run dev`.
npm run build      # tsc -b && vite build → dist/
npm test           # vitest — 69 tests, all passing (2026-11-24)
npm run check:contrast  # WCAG AA on all 18 token pairs — 18/18 pass
node ../clicktest/clicktest.mjs  # headless click-test — 34 checks, all passing
```

Verified 2026-11-24: build clean in ~5–7 s (JS 484 KB / gzip 146 KB, CSS
37 KB, dist 1.4 MB); 69 vitest tests pass (format 7, flow 10, copy 4,
recorded 8, tokens 19, api 4, DashboardPreview 6, sticky 8, BudgetNote 3);
contrast 18/18 AA.

## What each screen proves

| Route | Proves |
| --- | --- |
| `/` (Home) | Compact hero (202 px) + live stats from `GET /api/stats` on a dark chip; the payables console (All/Unpaid/Paid/Refused tabs, 60% paid gauge, fees chart, 7 recorded refusals); the 4-step flow: `InvoiceStep` (lab picker, or file/paste/number behind one disclosure; SHA-256 in the browser, never uploaded) → `CheckStep` (9 checks, Pay disabled with the exact reason until ready) → `PayStep` (Rail A CCD / Rail B EUDemo, compact until actionable, job timeline, refusal card) → `ReceiptStep`; `TryPanel` (5 attacks); HowItWorks (cycling payables, connector diagram, rails, live receipt checker). |
| `/receipt/:id` | A single receipt: "Paid once.", amount, payee (from the chain), tx hashes with explorer links (Reserve / Transfer / Confirm for EUDemo), verifier re-read (`12 of 12 checks passed` for payable 2 + time), payment-tx source, "Check again on chain" re-verify, "Copy verifier command". Unpaid → "Not paid yet" + link back. |
| `/judges` | The judge console: verification spec, the 9 checks, sample transactions, the verifier re-run command, file downloads (`/api/judges/files`), known limits (H1/H2 + planned fixes), the banned-claims table, build status, and the glossary (uses "reserved", never "held"). |

## Design-judgment fixes applied (F1–F11, all verified in the click-test)

- **F1** — no invented counts: card 04 uses live counts only ("N paid once, M unpaid open right now"); the "2 payables due in 7 days" line never existed in this port.
- **F2** — gauge caption sits beside the SVG in a flex row, never under the arc. Visually confirmed in `d-console-1440.png`.
- **F3** — no white/60 caption over a cloud seam anywhere in the port.
- **F4** — skip link (first Tab stop, jumps to `#invoice`) + `aria-live="polite"` on all steps + `role="alert"` on the refusal card.
- **F5** — no dead `#s1` anchor. **F6** — hashes first 8 + last 6 (`truncHash`, tested); agent token first 4 + last 4. **F7** — no "just now"; absolute UTC dates. **F8** — hero sky 71 KB WebP, preloaded, width/height attrs. **F9** — lucide only, zero unicode-glyph icons.
- **F10** — (a) "Watch the recorded run" button; (b) empty-pool state + "Make a fresh lab invoice" buttons; (c) `BudgetNote` (fresh / attack sends / used-up); (d) mobile sticky bottom bar (derives the next action, shows the disabled reason); (e) rule-15 bracketed plain words ("Reservation (reserve) window 300s · Co-signer (the second approver) margin 60s"), glossary in `lib/copy.ts`; (f) compact hero + "Live console" section below the flow.
- **F11** — `<noscript>` block in `index.html` (React SPA: no JS = no content; the message is the port's equivalent).
- **P3 §1 fit** — steps 1–3 end at **876 px at 1440×900** (hero 202 px, invoice top 257 px). Achieved with compact idle states: step 1 hides file/paste/number behind a disclosure, step 3 is a one-line summary + two buttons until an invoice is loaded and the 9 checks pass. All load options remain present and working behind the disclosure.

## Click-test findings (user order 2026-11-24 09:31: judge by USING it)

Harness: `~/workspace/payonce-build/clicktest/` — `playwright-core` + the
cached stock Chromium (revision 1255), driving the real app against the dev
stub at 1440×900 and 390×844. 34 checks, all passing; log + 9 screenshots
in `~/workspace/payonce-build/clicktest/evidence/CLICKTEST_LOG.md`. The run
found and fixed 6 real issues (none were test-only):

1. **P3 §1 fit failed (pay bottom 1,608 px).** Fixed with the compact idle
   states above (InvoiceStep disclosure + PayStep compact mode) plus spacing
   trims (hero 202→186→202 px, StepCard p-6→p-4, flow gaps). Final: 876 px.
2. **Stub `/api/receipts/:id` regex never matched** (`/api/receipts/1` fell
   through to 404 "Unknown route"). Fixed the regex in
   `scripts/dev-api-stub.mjs`. Receipt page + receipt checker now load.
3. **Stub `checksAfter` returned `verdict: 'ready'`** for a paid payable, so
   the receipt checker showed "Status." instead of "Paid once: yes"; also
   the check id was `status_paid` while the checker looks up `status`.
   Fixed: verdict `'paid'`, id `'status'`.
4. **TryPanel outcome cards never showed the refusal code/name** (only the
   plain text). Added a "Refusal: Code −5, WrongStatus" row (P3 §9).
5. **React 18 warning: `fetchPriority` prop on `<img>`** (dropped by React,
   so the hint never rendered). Removed the prop; the `<link rel="preload"
   fetchpriority="high">` in `index.html` carries the priority.
6. **No favicon** (`/favicon.ico` 404 on every load). Added
   `<link rel="icon" href="/assets/payonce-mark.webp">`.
7. **Hero stats illegible (found visually, then measured).** White stats over
   the bright horizon measured **1.5:1**. Fixed with a dark chip
   (`bg-ink/85`); re-measured from the rendered screenshot: **12.45:1**
   (numbers) / **10.16:1** (labels).

Also verified by the click-test: Unpaid tab shows 3+5 and hides paid;
Refused tab lists all 7 refusals; pay-twice → chain −5 + fee 4.928645;
wrong amount → chain −6 + fee 4.928645; unlisted seller → app refusal, no
tx; tamper → hash mismatch, pay blocked; injection → ignored, payee is the
account on chain; payable 3 → honest "No recorded run for this payable"
(not a fake run); payable 2 → recorded run steps shown; pay against the
stub → honest 503 "The stub never sends a transaction"; zero page errors;
zero unexpected console errors; zero horizontal overflow at 1440 and 390;
sticky bar becomes "Pay in EUDemo (0.01 EUDemo)" after the check at 390 px.

## Data honesty (Gate G0 #6/#8)

- No sample/fake numbers in the production build. Every live number comes
  from the P3 §16 API. Unknown values show "—" with a reason.
- Recorded-run data (7 refusals, per-step fees) is labelled
  "Recorded run, 24 Nov 2026" only (`src/lib/recorded.ts`). The dev stub
  serves the same recorded snapshot; it never sends a transaction.
- Wording per Gate G0 #6 ("reserved", never "held"; EUDemo is a "testnet
  demo token"). Enforced by `src/lib/copy.test.ts`. The `/judges` honesty
  table deliberately *names* the banned claims to explain them.
- No addresses in source (runtime from `/api/config` + `/api/payables`).
  No secrets anywhere in the app. The `seed` strings in the bundle are the
  SVG `feTurbulence` noise seeds of the cloud art.
- Images: hero-sky.webp 73,032 B, dawn-terrain.webp 55,748 B,
  payonce-mark.webp 3,162 B (total 129 KB). Inter via `@fontsource/inter`,
  bundled locally.

## Still open

1. **Live-backend verification** — everything above is against the dev stub
   (real recorded snapshot). The moment the P3 backend is live, re-run the
   click-test against it (`VITE_API_BASE` + the same 34 checks) and expect
   the pay step to return a real job instead of the honest 503. The pay
   timeline UI is otherwise exercised only via the recorded run + unit tests.
2. **Fees chart is recorded-run data** (P3 §14) — the P3 contract has no
   per-step fee endpoint. If the backend adds one, point `FeesChart` at it
   and delete the recorded bars. Reserve (succeeded) fee was never measured
   — shown as a gap, never a number.
3. **Receipt checker runs `verify(after_pay)` on the latest paid payable**
   on view — one extra POST per landing view; watch the
   `attempts_per_minute_per_ip` budget.
4. **Hero H1 is the design's short line** ("Every invoice paid once. Every
   payment provable.") while P3 §0's long hero line lives in `COPY.heroH1`
   but is not rendered anywhere. The design judge signed off the design's
   H1; changing it is a parent decision, not mine.
5. **Staging hold still in force** — nothing was copied, built, tested, or
   run from `~/workspace/payonce-site-staging/`; this app was built from the
   design system in `~/workspace/payonce-build/design/` + the P3 spec.
