# PayOnce — Design System v1

**For:** the FRONTEND agent (React 18 + Vite + TypeScript + Tailwind port).
**Status:** 24 Nov 2026. Design source of truth. No code in this file is copied from the reference video.
**Identity:** PayOnce — "Every invoice becomes a payable that can be paid exactly once, only to the account the supplier put on chain."
**Story line (honest, post-fix):** "Every invoice paid once. Every payment provable." — NOT "never pays a fake invoice" (false per VERDICT_V5 H1) and NOT "the chain refuses, not a server" (false on Rail B).

---

## 1. What this system is mapped from

The reference is a 10 s Altura landing scroll (2160×2016, 30 fps). Studied frame by frame from 20 extracted frames (`frames/frame_01.png` … `frame_20.png`, fps=2). Sections mapped 1:1 to PayOnce per PLAN P2 §4.2:

| Altura (video) | PayOnce (this system) | File |
|---|---|---|
| Header / nav (glass pill, not sticky) | PayOnce nav + TESTNET chip, not sticky | `index.html` header |
| Hero: orange sky, white H1, 2 CTAs | Dawn-teal sky (own generated art), H1 option A, 2 CTAs | `index.html` hero |
| Floating dashboard (69% width, into clouds) | Payables console (DOM replica, real testnet data) | `index.html` hero + `dashboard.html` |
| Cloud bank → bone page transition (~150 px) | Sky → paper fade, 150 px | `index.html` hero seam |
| Features intro + 4-column card row (shared hairlines, corner handles) | 4 checks, same grid + handles | `index.html` features |
| How it works: left H2 + right paragraph, 3 step cards | 3 steps (register / verify / pay) + visuals | `index.html` steps |
| Card 04 wide bento + floating notification | Live verified payments + latest-payment card | `index.html` card 04 |
| Chat mock (streaming stages) | Receipt checker (5 real stages) | `index.html` step 03 |
| — (not in clip) | Dark ink CTA band + footer with testnet disclaimer | `index.html` |

**What changed vs the video:** palette (orange → dawn teal / ink), all copy, all numbers, all product UI, logo mark. **What did not change:** layout, section order, spacing rhythm, card geometry, corner-handle motif, motion shape.

---

## 2. Tokens

Full token file: `tokens.css` (CSS custom properties + `@theme` mapping for the Tailwind port).

### Palette ("dawn teal / ink", P2 §4.3)

| Token | Hex | Use |
|---|---|---|
| `sky-0` | `#0A2A33` | top of hero |
| `sky-1` | `#15505A` | upper hero, behind H1 (white: 9.02:1) |
| `sky-2` | `#1F6F6A` | mid hero, behind sub (white: 5.93:1) |
| `sky-3` | `#A7DCD0` | lower hero, dawn mint — ink text only (11.16:1) |
| `sky-4` | `#F7EBDD` | horizon peach, fades into page (ink: 14.47:1) |
| `cloud-white` | `#FFFFFF` | cloud highlights |
| `cloud-shadow` | `#B9D8D2` | cloud shadows |
| `cloud-shadow-2` | `#7FA9A6` | deeper cloud shadows |
| `paper` | `#F4F7F6` | page background |
| `paper-2` | `#E9F0EE` | alternating section |
| `card` | `#FFFFFF` | cards, dashboard panels |
| `line` | `#D5E0DE` | hairlines |
| `ink` | `#0B1F24` | headings, primary text (on paper: 15.77:1) |
| `body` | `#3B4F55` | body text (on paper: 8.00:1) |
| `muted` | `#4F6268` | captions, labels (on paper: 5.94:1) |
| `teal-600` | `#0F766E` | primary button (white text: 5.47:1) |
| `teal-700` | `#1F6F6A` | accent text, links on white (5.93:1) |
| `amber` | `#F2B872` | highlight chips (ink text: 9.61:1) |
| `verified` | `#14532D` on `#E7F5EC` | verified badge (8.10:1) |
| `unpaid` | `#7A4A00` on `#FFF4E0` | unpaid badge (6.86:1) |
| `refused` | `#8A1C12` on `#FDECEA` | refused badge (8.14:1) |

**Rule:** never put white body text on `sky-3`/`sky-4`. Only ink text goes on the light sky stops. No violet/lavender anywhere.

### Type (Inter / Inter Display, SIL OFL — bundle via `@fontsource`)

| Role | Size | Leading | Tracking | Weight |
|---|---|---|---|---|
| H1 (hero) | 60–64 px (`clamp(2.75rem, 5vw, 4rem)`) | 1.02 | −0.03em | 400–500 |
| H2 | 44 px | 1.0 | −0.02em | 400 |
| Step title | 30–32 px | 1.13 | −0.02em | 400 |
| Card title | 20 px | 1.4 | −0.01em | 400 |
| Body | 15 px | 1.45 | 0 | 400 |
| Hero sub | 17 px | 1.3 | 0 | 400 |
| Eyebrow | 14 px | — | 0 | 400–500, with 6 px square bullet |
| KPI number | 28 px | 1 | −0.02em | 400 |
| Micro labels | 10–11 px | — | 0 | 400 |
| Keyword emphasis | same as body | — | 0 | 600, ink |

One family only. One H1 per page. H2 per section, H3 for step titles.

### Spacing & geometry (P2 §2.3–2.4)

- Content wrap: **1101 px** at 1280 viewport; equal left/right edges everywhere.
- Header height ~75 px. Card padding 24 px. Section gap (features bottom → next eyebrow) 114 px. Eyebrow→H2 24 px, H2→sub 24 px, sub→cards 58 px.
- Feature/step cards: **0 px radius**, 1 px hairline borders, shared borders via the `-ml-px -mt-px` trick (`.hairline-grid` in the HTML).
- **Corner handle squares:** 5 px solid ink squares on every outer corner and grid intersection (`.handles` in the HTML). Signature motif — keep it.
- Buttons: 4 px radius. Nav pill: 6 px radius, `bg-white/15`, 1 px `white/25` border. Dashboard frame: 10 px radius, 6 px translucent white frame, `0 30px 80px rgba(11,31,36,0.35)`. Panels: 6 px radius, 1 px `#E6E6E4`-style border.
- Dashboard width: ~69% of viewport (883 px at 1280). Sidebar 164 px, hidden below 768 px.

---

## 3. Components

### Nav (not sticky — scrolls away, matches reference)
Glass pill, logo mark 32 px + "PayOnce" + TESTNET chip. Items: Invoices, Verify, Pay, Receipts, Docs. Active item: white pill, dark text. Right: ghost "Connect wallet" + primary white "Verify an invoice".

### Hero
Sky image (`assets/hero-sky.webp`, object-top cover) + H1 (2 lines, centred, white) + sub (max 460 px, white 90%) + primary white CTA with trailing arrow + secondary translucent CTA. Dashboard below, sitting into the cloud bank; 150 px fade to `paper`.

### Dashboard frame (the product, DOM replica — NOT a screenshot)
Structure (see `index.html` hero and `dashboard.html` for the full flow):
- Sidebar: workspace switcher, nav groups (Search `/`, Reports, Verify; Payables active, Receipts, Refusals, Settings; folders + "Create folder").
- Top bar: "Payables console" + "Concordium Testnet" chip; date chip, Export (outline), "+ New payable" (ink).
- Tabs: All / Unpaid / Paid / Refused (active = white pill) + sync caption ("Synced with testnet · 2 min ago").
- Row 1: left — "Paid once" KPI (3 of 5) + fees-by-step bar chart (real fees, §5); right — "Paid once" half-donut gauge (3/5 = 60% ink arc, hatched remainder) + rows (Refused on chain: 7 recorded; Verifier: 12/12).
- Row 2: Payables list (5 rows, status chips) / Live verified payments (2 insight tiles + "Review all" ink button + "Dismiss") / Next due (date chips + labels + values).
- Bar chart: solid bars for CCD steps, hatched bars for the refused bar. Axis note states the source ("Fees by step, testnet CCD — recorded run, 24 Nov 2026").

### Feature cards (4-col)
Icon (top), title at bottom, 3-line body. Min height 258 px at desktop. Hover: lift 2 px + soft shadow. No radius, shared hairlines, corner handles.

### Step cards (3-col) + bento card 04
- Step number (13 px, grey, "01"), title 30–32 px, body with bold keyword phrases, visual slot 180–260 px tall.
- Visuals: `assets/dawn-terrain.webp` (same image, different `object-position` per card) + a white UI card on top:
  - Step 01: payables list; the highlighted row cycles every 1.2 s (only while in view).
  - Step 02: connector diagram — 3 source chips (Invoice file / Seller badge / Chain) → centre tile "Payable 2 · Ready"; amber dots travel the wires (SMIL `animateMotion`, 2.2 s loop, staggered).
  - Step 03: receipt checker — 5 stages, 0.9 s apart, starts on view, replay button.
- Card 04 (spans 2 cols, row 2): "Live verified payments" copy + 2 buttons; right cell: terrain image + floating notification card (latest real payment + "Confirm receipt" + "Explorer ↗").

### CTA band / footer
Dark ink band, centred H2 + sub + white primary + translucent secondary. Footer: logo + TESTNET chip, explorer/spec/judges/repo links, testnet disclaimer, image/type licence line.

### Chips, badges, buttons (dashboard)
- Status chips: Paid / Verified 12/12 (verified), Unpaid / Reserved (unpaid), Refused −5 (refused). Always a word with the colour.
- Layer badges (every refusal carries exactly one): **Chain** / **Co-signer** / **This app**.
- Buttons: primary ink bg + white text; secondary white bg + hairline border; hero primary white bg + ink text; hero secondary translucent. Hover: step up 1 px; active: press back. Disabled: 50% opacity + `aria-disabled` + the reason shown next to it (never a dead end).
- Status pill states: `LIVE · 12 s ago` / `LAST VERIFIED · 4 min ago (refresh paused)` / `CONNECTING` / `NO LIVE DATA`.
- Refusal card: layer badge + code + plain sentence + "Nothing moved" / "No transaction was sent" + fee line + explorer link.
- Receipt card: "Paid once", facts, tx list (reserve / transfer / confirm), verifier line "12 of 12 checks passed when we re-read the chain at 10:42:07 UTC", footer "Testnet receipt. It is not a legal invoice, a tax document or proof of delivery."

---

## 4. Motion

- Enter: `opacity 0 → 1, y 16 → 0`, 0.6 s, `cubic-bezier(0.22, 1, 0.36, 1)`, stagger 80 ms, once, `whileInView` (IntersectionObserver, threshold 0.3).
- Scroll: 1:1 (no parallax on content). Optional back-cloud layer at 0.35× only. Dashboard: `y 0 → −24` over the hero scroll, no tilt. Smooth with a spring (stiffness 120, damping 30, mass 0.6) in the React port.
- Micro-loops (start only when visible, stop when out of view): row highlight 1.2 s; connector dots 2.2 s; checker stages 0.9 s each.
- **Reduced motion:** all transforms skipped, loops set to final state (checker fully answered, row at the active position, dots hidden), stagger off. Gate with `prefers-reduced-motion` (and `@media` in CSS).
- No scroll-reveal cards, no tilt, no carousels, no timed tabs. Hover only: lift 2 px (cards), zoom 1.02–1.03 inside frames, buttons step/press, underlines draw.

---

## 5. Real data used in the mockups — and what replaces it live

Every number below is from the lab run, 24 Nov 2026 (PLAN P3 §16–17 / PAYABLE_LOG). The frontend agent MUST replace each with the live API call listed; unknown values show "—" with a reason, never a fallback number.

| Value | Where used | Source (real) | Live replacement |
|---|---|---|---|
| Registry `<13149,0>`, module `9b5b27fa…` | hero note, footer, judges | P3 §17 | `GET /api/config` |
| CIS-8004 test instance `<13144,0>` | check row 3 | P3 §17 | `GET /api/config` |
| Payables 5 total; paid 1, 2, 4 (3 paid); unpaid 3, 5 | hero dashboard, stats, lists | PAYABLE_LOG state | `GET /api/stats`, `GET /api/invoices` |
| Payable 1: 0.5 CCD, paid, tx `00e0ac1d…272f6`, fee 16.205 | dashboard list, next-due | P3 §17 | `GET /api/payables/1` |
| Payable 2: 0.01 EUDemo, paid, payee `4Vtd6W…Tg`, seller `4MvdMEGC…WDs`, doc `3b5b27da…a1f9e0`, due 25 Nov 04:49 UTC | steps 1–4, receipt | P3 §16.5 | `GET /api/payables/2` |
| Payable 2: reserve `ee56c0cc…`, transfer `7cc2f94f…0632ef` (memo `payable:2`), confirm `212f0ac7…310bde` | receipt, card 04 | P3 §17 | `GET /api/receipts/2` |
| Verifier 12/12, re-run 24 Nov, 13.6 s | dashboard, receipt | P3 §17 | `POST /api/payables/2/verify` |
| Refusals: second pay −5 `a5ec5e40…` fee 4.93; wrong amount −6 `52f3b4aa…`; unknown id −3 `d906c0b3…`; second reserve −16 `ae62175f…`; reused hash −12 `02ad7347…`; stranger confirm −17 `8ee531f2…`; early expiry −13 `8902c4f1…` | try-to-break-it, gauge rows | P3 §8, §17 | `POST /api/attacks/:kind` |
| Fees: register 14.2, pay CCD 16.2, confirm 10.98, transfer 7.07 (sponsor), refused 4.93 | fees bar chart | P3 §14 | recorded run (labelled) |
| Payable 3: 0.01 EUDemo, unpaid, due 25 Nov 04:49 UTC | picker, next-due | P3 §16.4 | `GET /api/payables/3` |
| Payable 5: unpaid, **amount/due "—"** (not in the run record) | picker, lists | P3 §18.1 | `GET /api/payables/5` (shows "—" until read) |
| Agent token `0100000000000000` | check row 3 | P3 §16.5 | `GET /api/payables/:id` |

**Placeholders that MUST be replaced by the live API (labelled in the HTML):** stats strip ("live app replaces them with GET /api/stats"), sync caption ("Synced with testnet · 2 min ago"), "Source repo" footer link (wire to the real public repo at publish), "Connect wallet" (dashboard is walletless for judges — the button is a nav affordance; in the app it opens the verify flow, it never asks a judge to sign).

---

## 6. Copy rules (binding — P3 §2)

1. Every refusal names exactly one layer: **Chain** (chain reverted, explorer-visible), **Co-signer** (refused before signing, no tx sent), **This app** (our page/server, nothing sent).
2. "The chain refuses" ONLY for a tx the chain actually reverted. Co-signer refusals say "Refused by the co-signer. No transaction was sent."
3. **Banned on screen:** "never pays a fake invoice", "never pays the wrong account", "escrow", "custody", "held" (say "reserved"), "stablecoin" (say "testnet demo token"), "mainnet", "production", "audited", "secure", "instant" (without a measured number), "fully on-chain", "Verified by Concordium".
4. Reservation wording: "Reserved for this payment. The co-signer approved the reservation and the transfer." Never present "reserved by the co-signer" as a contract fact.
5. Testnet everywhere: TESTNET badge in the header; EUDemo always "EUDemo (testnet demo token, not a euro stablecoin)"; fees are "testnet CCD".
6. Seller: (superseded in v10) the sellers and the payer are registered on the official registry `<12802,0>`. "Verified by Concordium" is printed only from a live badge-check that returns `badge_valid: true`.
7. Seller identity: "Not verified. No company (LEI) or identity proof is attached to this seller."
8. Payer: "Paid from the demo payer account (a lab account). You sign nothing."
9. Refused txs still cost a fee — say so with the amount.
10. Lab invoices labelled: "Lab invoice (testnet, not a real invoice)".
11. Explorer links: `https://ccdexplorer.io/testnet/transaction/<hash>` and `…/instance/<index>/<sub>`. Never the plural `transactions` path.
12. Hashes display as first 8 + last 6; copy gives the full value.
13. Recorded results labelled "Recorded run, 24 Nov 2026", never shown as live.

---

## 7. Accessibility & performance

- One H1; H2 per section; step titles H3. Landmarks: header / main / aside / footer. Skip link "Skip to the invoice".
- Step status changes announced via a polite live region once per status change; failed payments use `role="alert"`.
- Focus moves to the result heading when a job finishes. Disabled buttons stay focusable (`aria-disabled` + `aria-describedby` to the reason). Visible focus ring on every control.
- Icons always come with text; status colours always come with a word. Contrast ≥ 4.5:1 in both states (see §2 table).
- Drop zone is a real button and accepts drag-and-drop. Input font ≥ 16 px (no iOS zoom). Timers announced at 60 s and at expiry only.
- Charts are not used on the judge page (the landing bar chart is a labelled mockup with a text equivalent in the caption).
- Performance: hero image budget < 250 KB (hero-sky.webp is 395 KB at full res — the frontend agent must serve a compressed 2× WebP ≤ 250 KB and preload it; see §9). LCP target < 2.5 s. Lazy-load everything below the fold. No horizontal scroll at 375 px or 1280 px.

---

## 8. Responsive

- ≥ 1024 px: full layout (wrap 1101 px, dashboard 883 px, 4-col features, 3-col steps, bento 2+1).
- 768–1024 px: dashboard sidebar hidden, panels stack 2-col → 1-col; features 2-col.
- < 768 px: one column everywhere; dashboard panels stack; steps stack; sticky bottom bar carries the current primary action only ("Check invoice" → "Pay in CCD" / "Pay in EUDemo" → "Check again on chain"), 44 px touch targets, 16 px side gutter, hashes truncated with copy button, tables become label/value rows.
- Never create horizontal page scroll at any width.

---

## 9. Assets

| File | What | Source / licence |
|---|---|---|
| `assets/hero-sky.webp` (395 KB) | Hero sky, dawn teal + clouds | Generated for PayOnce (media pipeline). Must be recompressed ≤ 250 KB for production. |
| `assets/dawn-terrain.webp` (343 KB) | Step visuals + card 04 background | Generated for PayOnce (media pipeline). |
| `assets/payonce-mark.webp` (48 KB) | Logo mark: single amber check on ink-teal | Generated for PayOnce (media pipeline, icon art direction). |
| `assets/media-generation-*.webp` + `*.json` | Original generation outputs + metadata | Provenance only; the clean names above are what the pages reference. |
| Icons in the HTML | Unicode glyphs (⌕ ▤ ✓ ⬢ ❐ ◈ ⚙ ▸) as **placeholders** | **Frontend agent: replace with lucide line icons (ISC) before shipping.** Do not ship the glyphs as the icon system. |
| Type | Inter (SIL OFL) via `@fontsource` in the React port; Google Fonts in this static preview | Bundle the licence file. |

No asset from the reference video is used. No stock photography. See `ASSETS.md` for the generation prompts and full provenance.

---

## 10. Frontend implementation checklist (React port)

1. Port tokens: `tokens.css` → Tailwind `@theme` (already mapped) + `tailwind.config` colours.
2. `index.html` → landing page components: `Nav`, `Hero` (sky image + dashboard), `Features`, `HowItWorks` (steps + bento), `CtaBand`, `Footer`.
3. `dashboard.html` → judge flow: `AppHeader`, `HeroStrip`, `StepCard`, `InvoiceSource`, `DocFingerprint`, `PayableFacts`, `CheckList`, `PayCardCcd`, `PayCardEudemo`, `StepTimeline`, `RefusalCard`, `ReceiptCard`, `TryPanel`, `BudgetNote` (P3 §5). Routes: `/`, `/receipt/:payableId`, `/judges`, `*` → `/`.
4. Wire every value in §5 to the P3 §16 API contract. Validate responses with zod before rendering. On failure show a visible error state, never stale fake data.
5. Motion: framer-motion equivalents of §4 (enter 0.6 s / stagger 80 ms / `useInView`; checker 0.9 s stages; row cycle 1.2 s; connector dots via SVG `animateMotion` or framer `offsetDistance`). `useReducedMotion()` gates everything.
6. Replace glyph icons with lucide. Compress hero-sky ≤ 250 KB (2× WebP). Preload it.
7. Tests: vitest for the verification-stage reducer + reduced-motion branch; Playwright screenshots at 375 px and 1280 px, no horizontal scroll; contrast check script over the palette (fail < 4.5:1).
8. Honesty audit: grep the built copy for every banned phrase in §6 before every deploy.

---

## 11. Known limits / open items

- The hero dashboard is a static DOM replica: the numbers are the 24 Nov lab run. The live app must replace them (§5). Nothing here pretends to be live.
- The "Connect wallet" nav button is a landing affordance; the judge flow is walletless (P3 §3). The frontend agent must not make a judge sign anything.
- "PayOnce" trademark check is not done (P2 §6) — record before public launch.
- Playwright screenshots at 375/1280 px were NOT run by the design agent (no headless browser in this environment) — the frontend/QA agent must run them before merge.
- The co-signer, vendor-list enforcement, named payer and header-expiry bound are "planned" (P3 §15) — the design labels them as such and never shows them as live.
