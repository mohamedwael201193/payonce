# PayOnce — Asset inventory & provenance

**Rule (P2 §6):** do not copy any asset from the reference video. Do not use the reference's painted landscapes, cloud photo, logo mark, or product screenshot. Every visual on the PayOnce pages is either generated for PayOnce, drawn in code (SVG/CSS), or a labelled placeholder.

## Generated images (own, original)

All three were generated 24 Nov 2026 with the workspace media pipeline (image generation subagent). No reference frame, screenshot, or asset from the Altura video was passed in, and no prompt names the reference or its style.

| File (clean name) | Original output | Prompt (verbatim) | Use | Size |
|---|---|---|---|---|
| `assets/hero-sky.webp` | `media-generation-hero-sky-dawn-teal-0-84cb7f06-06da-4c4b-a312-f80b841458ec.webp` (+ `.json` metadata) | "Painted dawn sky, wide panoramic 16:9 landscape, original artwork. Deep dark teal at the top (#0A2A33) fading down through muted teal (#15505A) and deep green-teal (#1F6F6A) into soft mint (#A7DCD0) and a pale peach horizon (#F7EBDD) at the bottom. Soft billowing white clouds with cool teal-grey shadows gather along the bottom third and at both lower sides, like a cloud bank seen from above, leaving the top half of the sky clear and dark for white headline text. Painterly, soft visible brushstrokes, calm and airy, impressionist sky study. No sun disc, no birds, no text, no buildings, no people, no watermark." | Hero background (`index.html`) | 395 KB — **must be recompressed ≤ 250 KB for production** |
| `assets/dawn-terrain.webp` | `media-generation-dawn-terrain-teal-0-20e6e0e3-7604-46e4-824c-489c2286e9dc.webp` (+ `.json`) | "Painted dawn landscape, wide 16:9 landscape, original artwork. Rolling low hills in deep teal (#15505A) and muted green-teal (#1F6F6A), a pale mint sky (#A7DCD0) across the upper third, soft peach dawn light (#F7D9C0) touching the hilltops and a calm pale-peach river path winding through the middle distance. Painterly impressionist brushstrokes, soft and atmospheric, quiet and hopeful. No text, no people, no buildings, no animals, no watermark." | Step visuals (3×, different crops) + card 04 background (`index.html`) | 343 KB |
| `assets/payonce-mark.webp` | `media-generation-payonce-mark-0-88a05b47-2480-4e7c-88a8-2ece1f3c25c9.webp` (+ `.json`) | "A minimal mark for PayOnce: one single bold check stroke drawn once inside a rounded square, confident and final, warm amber check on a deep ink-teal background" (icon art direction applied by the pipeline: centred, simple, high contrast, readable at small sizes) | Logo mark, nav / dashboard / footer / checker | 48 KB |

Verified by eye after generation: hero sky is dark teal on top (clear for white H1) with white clouds along the bottom; terrain is teal hills with a peach river path; the mark is a single amber check on ink-teal. None resembles the reference's orange sky, orange terrain, or dot-grid mark.

## Drawn in code (original, no files)

- Cloud seam: CSS gradient (`transparent → sky-4 → paper`, 150 px) — `index.html` hero.
- Connector diagram (step 02): inline SVG paths + SMIL `animateMotion` dots.
- Half-donut gauge (hero dashboard): inline SVG arc, 60% ink + hatched remainder (SVG pattern).
- Bar chart (hero dashboard): HTML/CSS bars; the refused bar uses a CSS diagonal hatch.
- Corner handle squares: CSS `::before`/`::after` (5 px, ink).

## Type & icons

| Asset | Source | Licence | Note |
|---|---|---|---|
| Inter / Inter Display | Google Fonts in this static preview; `@fontsource` in the React port | SIL OFL | Bundle the licence file in the repo. |
| Icons | Unicode glyphs in this preview ONLY (⌕ ▤ ✓ ⬢ ❐ ◈ ⚙ ▸) | — | **Placeholder.** Frontend agent must replace with lucide line icons (ISC) before shipping. Do not ship the glyphs. |

## Stock photography

None used. No Unsplash/Pexels images, no third-party logos.

## Frames (study material only — never shipped)

`frames/frame_01.png` … `frames/frame_20.png` — extracted from the reference video at fps=2, 1280 px wide, for frame-by-frame study. They are design working material in this directory only. They must NOT be copied into the public repo or any shipped page.
