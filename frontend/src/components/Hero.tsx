// Hero — tall sunset hero, matched to the reference video (VIDEO_ANALYSIS.md).
// Full-bleed orange sunset sky (our own generated art), the pill nav in the
// sky, a huge centred white headline, centred subline + CTAs. The header
// lives INSIDE the hero, over the sky — not in a dark band above it.
// USER ORDER 2026-11-25 03:40 (DECISIVE): the real dashboard must NOT live
// in the hero or the landing — the hero gets ONLY the small Demo walkthrough
// (HeroDemo, in the small card below), and the live stats band that used to
// sit here is GONE. Live numbers appear on the landing ONLY inside that
// Demo-labeled card (its chips + invoice table, disclosed in the card
// footer) — nowhere else; the full live dashboard lives in /dashboard.
// The hero shows a glimpse, not the product.
// Design v2 polish: glossy 3D ember CTAs with a shine sweep.
import { COPY } from '../lib/copy'
import { AppHeader } from './AppHeader'

export function Hero() {
  return (
    <section className="relative overflow-hidden" aria-labelledby="hero-title">
      {/* Sunset sky — our own generated art (2352×1008, 43 KB after the
          vivid-orange regrade), preloaded.
          The CSS gradient underneath is the fallback so the sky still reads
          as sunset while the image loads or if it fails. */}
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{
          background: 'linear-gradient(180deg, #EA580C 0%, #F97316 42%, #FB923C 72%, #FDE68A 100%)',
        }}
      />
      <img
        src="/assets/hero-sky.webp"
        alt=""
        aria-hidden="true"
        width={2352}
        height={1008}
        className="absolute inset-0 h-full w-full object-cover"
      />
      {/* Ember orbs removed (UI/UX judge): the blurry smudges overlapped the
          headline — worst at 390px, on the word "once." — and read as dirt
          on the sky, not embers. The sky art carries the sunset alone. */}
      {/* Bottom fade into paper — softens the cut where the cloud band meets
          the cream section below (the small demo card covers the middle). */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[80px]"
        aria-hidden="true"
        style={{ background: 'linear-gradient(180deg, rgba(250,246,239,0) 0%, #FAF6EF 100%)' }}
      />
      <div className="relative z-10">
        <AppHeader dark skipTarget="#invoice" />
        <div className="mx-auto max-w-[1101px] px-4 pt-10 pb-[120px] text-center sm:px-6 sm:pt-12">
          <h1
            id="hero-title"
            className="mx-auto max-w-[880px] text-[40px] leading-[1.05] font-medium tracking-[-0.03em] text-white sm:text-[56px]"
          >
            Every invoice paid once. Every payment provable.
          </h1>
          <p className="mx-auto mt-5 max-w-[600px] text-[15px] leading-[1.5] text-white/90 sm:text-[17px]">
            {COPY.heroSub}
          </p>
          <div className="mt-7 flex flex-wrap items-center justify-center gap-4">
            <a href="#invoice" className="btn-ember">
              Start verifying
            </a>
            <a href="#how" className="btn-glass">
              See how it works
            </a>
          </div>
          <p className="mt-5 text-[15px]">
            <a href="/dashboard" className="font-medium text-white underline decoration-white/50 underline-offset-4 hover:decoration-white">
              Open the live dashboard →
            </a>
          </p>
        </div>
      </div>
    </section>
  )
}
