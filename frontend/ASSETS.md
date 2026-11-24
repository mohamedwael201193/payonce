# PayOnce frontend — asset register

All images are our own generated art from the design system
(`~/workspace/payonce-build/design/assets/`). Nothing is copied from the
Altura reference video. Recompression was done with Pillow (WebP, method 6)
on 2026-11-24; the originals stay in the design dir.

## Images (`public/assets/`)

| File | Source size | Shipped size | Dimensions | Use | Loading |
| --- | --- | --- | --- | --- | --- |
| `hero-sky.webp` | 395,332 B | **73,032 B** | 2048×1152 | Hero sky background (object-top cover) | `preload` + `fetchpriority="high"` in `index.html`; `<img>` in `Hero.tsx` |
| `dawn-terrain.webp` | 342,998 B | **55,748 B** | 1600×900 (resized from 2048×1152) | Step-card visual backgrounds + card 04 (`Sections.tsx`, `Terrain`) | `loading="lazy"`, below the fold |
| `payonce-mark.webp` | 48,164 B | **3,162 B** | 256×256 (resized from 1600×1600) | Header wordmark (`AppHeader.tsx`) | inline `<img>`, 32 px display |

Budget: the hero sky was 386–395 KB against the 250 KB budget (design §9) —
it now ships at **71 KB**, well inside. Total images: **129 KB**.

## Icons

**lucide-react only** (`lucide` icons in every component). No unicode-glyph
icons ship: `grep -r` for the design system's placeholder glyphs
(⌕ ▤ ⬢ ❐ ◈ ⚙ ▸) across `src/` returns nothing. The design HTML's unicode
icons were placeholders and were replaced during the port.

## Fonts

Inter via `@fontsource/inter` (SIL OFL), weights 400/500/600, latin +
latin-ext subsets. Bundled locally by Vite — no Google Fonts request at
runtime. `main.tsx` imports the three weights; the build emits 12 font files
(23–49 KB each, woff2 preferred).

## What is NOT here

- No image, frame, or asset from the Altura reference video (studied for
  visual language only).
- No stock photos. The sky and terrain are the design agent's generated art.
- No remote image/CDN: everything is served from `public/assets/`.
