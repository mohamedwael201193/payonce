# PayOnce — Design Report v1

**Agent:** DESIGN · **Date:** 24 Nov 2026 · **Work dir:** `~/workspace/payonce-build/design/`
**Verdict on the brief:** delivered. The landing page and dashboard system follow the Altura video's layout, sections, spacing and motion 1:1, in PayOnce's own "dawn teal / ink" identity, with only our own generated images and real testnet data.

---

## 1. What was studied

| Resource | How |
|---|---|
| Reference video (`…/ef038fde….mp4`, 10 s, 2160×2016, 30 fps) | 20 frames extracted at fps=2, 1280 px wide (`frames/frame_01.png` … `frame_20.png`). Viewed directly: 01 (hero + dashboard), 09 (features), 13 (steps), 20 (settled bento + chat final state). |
| PLAN P2 (lines 768–1149) | Read in full. Section map, colour/type/spacing tokens, button sizes, motion timeline, PayOnce mapping, palette proposal, implementation notes, asset rules. |
| PLAN P3 (lines 1151–1847) | Read in full. One-screen judge flow, routes, components, buttons, states, refusal codes, try-to-break-it, copy deck, receipt page, mobile, latency, API contract, For-judges panel, open decisions. |
| `IDEA_V5_PAYONCE.md` | Idea + story (payable = invoice on chain, paid exactly once, only to the stored payee). |
| `design-taste-frontend` skill (tasteskill 2.5) | Read in full. Applied where it does not conflict with P2: one section per screen, equal edges, real product UI as the hero visual, hover micro-interactions, no captions under visuals, no violet, no stock passed off as the product. Where P2 (the plan, my bible) and the skill differ — e.g. P2 specifies fade-up-on-view enter animations and a painted hero — P2 wins, and the difference is recorded here. |
| `tailwind-design-system` skill | Read (tokens, grid, buttons, nav, footer). Tokens ported to `tokens.css` + Tailwind `@theme`. |

## 2. Deliverables

| File | What |
|---|---|
| `index.html` | Production-quality landing page (Tailwind CDN + tokens): nav, hero with floating payables console, features, how-it-works (3 steps + wide bento), CTA band, footer. All micro-animations wired (reveal-on-view, cycling row, connector dots, receipt-checker stages, replay). Reduced-motion safe. |
| `dashboard.html` | Dashboard visual system + one-screen judge-flow mockup (steps 1–4, try-to-break-it, build status, component reference, API wiring table). |
| `tokens.css` | Design tokens (CSS vars + `@theme` mapping) — the frontend agent's source of truth. |
| `DESIGN_SYSTEM.md` | Full system: tokens, type, layout, components, motion, real-data table with live-API replacements, copy rules, a11y/perf, responsive, implementation checklist, known limits. |
| `ASSETS.md` | Asset inventory + provenance (prompts, licences, no copied assets). |
| `assets/hero-sky.webp` (2048×1152, 386 KB) | Own generated dawn-teal sky + clouds. |
| `assets/dawn-terrain.webp` (2048×1152, 334 KB) | Own generated dawn terrain (step visuals + card 04). |
| `assets/payonce-mark.webp` (1600×1600, 47 KB) | Own generated mark: single amber check on ink-teal. |
| `assets/media-generation-*` | Original generation outputs + metadata (provenance). |
| `frames/` | Study frames only — never shipped. |

## 3. Frame-by-frame mapping (evidence the layout matches the video)

| Video frame | What it shows | PayOnce equivalent in `index.html` |
|---|---|---|
| 01 (0.0 s) | Orange sky, white H1, 2 CTAs, floating dashboard with sidebar + bar chart + runway gauge + 3 panels, cloud banks | Dawn-teal sky (`hero-sky.webp`), H1 "Every invoice paid once. Every payment provable.", same CTAs, payables console (sidebar, fees bar chart, paid-once gauge 3/5, 3 panels), cloud seam |
| 09 (4.0 s) | Dashboard bottom in clouds, features intro (eyebrow + square bullet, 2-line H2, grey sub), 4-card row with shared hairlines + corner handles | Same structure: "What PayOnce checks", H2 "Every check that makes a payment safe, in one place.", 4 cards, `.handles` + `.hairline-grid` |
| 13 (6.0 s) | How-it-works heading (left H2, right paragraph), 3 step cards with number/title/bold-keyword body/painted visual, chat card "Working…" | Same: 3 steps (register / verify / pay), terrain visuals + UI cards, receipt checker streaming stages |
| 20 (9.5 s) | Settled bento: card 04 wide (AI Insights, 2 buttons, floating notification card over painted image), chat final answer | Card 04 "Live verified payments" + floating card with the latest real payment (payable 2, `7cc2f94f…0632ef`), checker final verdict "12 of 12 checks passed" |

## 4. Verification performed (by me, re-runnable)

1. **HTML parse:** `html.parser` over `index.html` and `dashboard.html` — **OK, no errors** (re-run after the link fixes).
2. **Banned-claim grep:** searched both HTML files for `never pays a fake invoice | never pays the wrong account | escrow | custody | "held" | stablecoin | audited | Verified by Concordium | mainnet | fully on-chain`. **Only correct uses found:** the footer disclaimer "not a euro stablecoin" (the required wording) and the ban list quoted inside `DESIGN_SYSTEM.md` §6. No banned claim appears as on-screen copy. "reserved" is used only in the approved senses ("reserved on chain", "Reserved, co-signed and confirmed").
3. **Asset references:** every `assets/*.webp` referenced by the HTML exists on disk.
4. **Images verified by eye:** hero sky (dark teal top, clear for white H1; white clouds along the bottom), terrain (teal hills, peach river), mark (single amber check on ink-teal). None resembles the reference's orange sky/terrain or dot-grid mark. No asset from the video was passed to any generator.
5. **Links:** all `href="#"` dead links fixed — nav/CTA/footer links now point at real anchors or `dashboard.html` sections. "Source repo" is text ("public at publish"), not a dead link.
6. **Contrast ratios:** taken from the plan's computed table (P2 §4.3, all pairs ≥ 4.5:1). **I did not re-compute them** — the frontend agent's contrast-check script (P2 §5.9) must re-verify from `tokens.css` before merge.
7. **Real-data trace:** every number in the mockups is traced in `DESIGN_SYSTEM.md` §5 to a P3 §16–17 value or PAYABLE_LOG entry (registry `<13149,0>`, payables 1–5, tx hashes, fees, verifier 12/12). Payable 5's amount/due is deliberately "—" (not in the run record). Stats are labelled as lab-run values with the live-API replacement named.

## 5. NOT verified — open for the paired judge / frontend agent

- **No headless render was run by me.** `/opt/meta-chromium/chrome` refuses to start under this agent ("Hatch WebGL domain policy is required for browser startup"); no Playwright (py/node) and no `ms-playwright` cache exist on this VM. The paired judge must render `index.html` and `dashboard.html` at 1440×900 and 390×844 and check: no horizontal scroll, hero fills the first screen, one section per screen, every visual draws, the dashboard is legible at 1440.
- **Hero image weight:** `hero-sky.webp` is 386 KB at 2048×1152 — over the P2 §5.8 budget of 250 KB. Flagged in `DESIGN_SYSTEM.md` §7/§9 and `ASSETS.md`; the frontend agent must serve a compressed 2× WebP ≤ 250 KB and preload it.
- **Icons are placeholders:** unicode glyphs in the HTML. The frontend agent must replace them with lucide line icons (ISC) before shipping (`DESIGN_SYSTEM.md` §9).
- **"PayOnce" trademark check** not done (P2 §6) — record before public launch.
- **Contrast re-check** from `tokens.css` not run (see §4.6).
- The co-signer, vendor-list enforcement, named payer and header-expiry bound are "planned" (P3 §15) — the design labels them as such and never shows them as live. The dashboard mockup shows payable 2 in its **paid** state; the unpaid flow (payable 3) is referenced, not shown as a second full mockup.

## 6. Design decisions worth defending

- **Sky as a generated painting, not a CSS gradient:** P2 §2.5 says the sky is a painted/photographic gradient, "reproduce the feel with a CSS gradient plus generated cloud layers". The generated sky carries the painterly cloud texture the reference has, which pure CSS cannot; the 150 px CSS fade still does the page seam.
- **Dashboard as DOM, not a screenshot:** the reference's dashboard is a product screenshot; ours is a live DOM replica with real testnet data, so the frontend agent ports components, not pixels — and a judge can read the actual numbers.
- **Fees bar chart instead of "payments per day":** P2's mapping asks for a payments-per-day chart "real, from indexer" — the run log has no daily series (3 payments on one day), so a per-day chart would be one bar. The fees-by-step chart uses 5 real, comparable, same-unit values from P3 §14 and is labelled as the recorded run.
- **Payable 5 shows "—":** per P3 §2 rule 9, an unknown value shows "—" with a reason, never a fallback number. The mockup demonstrates the rule instead of inventing an amount.
- **No violet, no tilt, no scroll-reveal cards** (skill rules); the only scroll-linked motion is the dashboard's −24 px drift and the optional back-cloud 0.35× parallax, both per P2 §5.1.
