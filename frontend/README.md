# PayOnce frontend

The PayOnce dashboard + judge console (Concordium Trusted Agents hackathon,
testnet only). One screen: paste an invoice → run the 9 checks → pay → get a
verified receipt → "try to break it". Plus a judge console (the judge types
a request and plays shop / owner / attacker) and receipt pages.

Stack: React 18 + Vite 6 + TypeScript + Tailwind v4 + framer-motion +
react-query + zod + vitest + lucide-react. Design system: "dawn teal / ink"
(`../design/` — tokens verified against `design/tokens.css`, 2026-11-24).

## Run it

```bash
npm install
# 1. Dev against the recorded-data stub (real testnet snapshot, labelled):
npm run dev:stub   # terminal 1 — http://127.0.0.1:7401
npm run dev        # terminal 2 — http://localhost:5173 (proxies /api to the stub)
# 2. Dev against the real backend: set VITE_API_BASE to its origin and run `npm run dev`.
#    (Same-origin /api in production; no proxy needed.)
npm run build      # tsc -b && vite build → dist/
npm run preview    # serve dist/ on :4173
npm test           # vitest run — 69 tests
npm run check:contrast  # WCAG AA check on all 18 token pairs
node ../clicktest/clicktest.mjs  # headless click-test (Playwright + cached Chromium) — 34 checks, all passing 2026-11-24; log + screenshots in ../clicktest/evidence/
```

## What each screen proves

| Route | Proves |
| --- | --- |
| `/` (Home) | Hero + live stats strip from `GET /api/stats`; the payables console (tabs, gauge, fees chart, refused list); the 4-step flow: `InvoiceStep` (paste/drop a lab invoice or file, SHA-256 in the browser, never uploaded) → `CheckStep` (9 checks, Pay disabled with the exact reason until ready + fresh) → `PayStep` (Rail A CCD / Rail B EUDemo, job SSE, receipt) → `ReceiptStep`; `TryPanel` ("try to break it": pay twice, wrong amount, unlisted seller, tamper, co-signer dry run); how-it-works visuals (cycling payables, connector diagram, rails, live receipt checker). |
| `/receipt/:id` | A single receipt: amount, payee (from the chain), tx hashes with explorer links, verifier re-read (`passed/total` + time), payment-tx source (`chain` vs `server_store`). |
| `/judges` | The judge console: verification spec, the 9 checks, the banned-claims table, the honesty gaps (H1/H2), file downloads (`/api/judges/files`), and the "play shop / owner / attacker" scenarios. |

## Data honesty (Gate G0 #6/#8)

- **No sample/fake numbers in the production build.** Every live number comes
  from the P3 §16 API (`/api/config`, `/api/health`, `/api/stats`,
  `/api/invoices`, `/api/payables/:id`, `/api/payables/:id/verify`,
  `/api/payables/:id/pay`, `/api/jobs/:id` SSE, `/api/tx/:hash/status`,
  `/api/cosigner/dry-run`, `/api/attacks/:kind`, `/api/receipts/:id`,
  `/api/recorded/:id`, `/api/judges/files`). Unknown values show "—" with a
  reason, never a fallback number.
- **Recorded-run data is labelled.** The 7 on-chain refusals (P3 §9) and the
  per-step fees (P3 §14) come from the lab run of 24 Nov 2026 and are shown
  only with the label "Recorded run, 24 Nov 2026" (`src/lib/recorded.ts`).
  The dev stub serves the same recorded snapshot; it never sends a
  transaction — `POST /pay` and `POST /payables` return an honest 503.
- **Wording:** "reserved by the co-signer", never "held"; no "never pays a
  fake invoice" as an on-chain claim; EUDemo is a "testnet demo token", never
  a stablecoin. Enforced by `src/lib/copy.test.ts` (scans every COPY string
  for the banned words). The `/judges` honesty table deliberately *names*
  the banned claims to explain them — that is documentation, not copy.
- **No addresses in source.** Account addresses come from `/api/config`
  (vendor list) and `/api/payables` (payee/seller) at runtime. The only
  addresses in the app source are the explorer fallback URLs in
  `src/lib/tokens.ts`. One exception: the dev-only stub
  (`scripts/dev-api-stub.mjs`) hardcodes the recorded run's seller address
  (`4MvdMEGC…WDs`) — public on-chain data from the 24 Nov 2026 lab run,
  same category as the tx hashes in `src/lib/recorded.ts`. Test fixtures
  use `PLACEHOLDER` strings.
- **No secrets.** Nothing in this app reads, prints, or ships a seed, private
  key, or token. The `seed` strings in the bundle are the SVG
  `feTurbulence` noise seeds of the cloud art.

## Layout / responsive

Content width 1101 px at 1280 viewport; single column below the `md`
breakpoint; the flow is one screen on desktop and a stacked scroll on mobile.
Measured 2026-11-24 (headless Chromium, 1440×900): steps 1–3 end at 876 px,
hero 202 px, zero horizontal overflow at 1440 and at 390. Touch targets
≥ 36 px (44 px for primary CTAs). Reduced motion respected
everywhere (framer-motion `useReducedMotion`, SMIL dots become static,
cycling highlight stops). All contrast pairs pass WCAG AA — see
`npm run check:contrast`. The hero stats strip sits on a dark chip
(`bg-ink/85`): measured 12.45:1 (numbers) / 10.16:1 (labels) from the rendered
screenshot, after the bare-white version measured 1.5:1 over the cloud seam.

## Open items (for the paired judge / integration lead)

1. **Live-backend verification not done yet** — the app is verified against
   the dev stub (real recorded snapshot). The moment the P3 backend is live,
   re-run the whole flow against it; `FRONTEND_REPORT.md` lists the exact
   checks.
2. **Headless click-test done 2026-11-24** (`../clicktest/`, 34/34 checks
   pass, screenshots in `../clicktest/evidence/`): full judge flow clicked
   through at 1440×900 and 390×844, zero page/console errors, F2 gauge and
   F3 caption verified visually. It caught and fixed 6 real issues (see
   `FRONTEND_REPORT.md` § "Click-test findings").
3. **Fees chart is recorded-run data** (P3 §14), not live API data — the P3
   contract has no per-step fee endpoint. If the backend adds one, point
   `FeesChart` at it and delete the recorded bars.
4. **Receipt checker runs `verify(after_pay)` on the latest paid payable**
   on view — one extra POST per landing view; acceptable, but watch the
   `attempts_per_minute_per_ip` budget.
