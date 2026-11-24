// Hero — tall sunset hero, matched to the reference video (VIDEO_ANALYSIS.md).
// Full-bleed orange sunset sky (our own generated art), the pill nav in the
// sky, a huge centred white headline, centred subline + CTAs, live stats.
// The header lives INSIDE the hero, over the sky — not in a dark band above
// it. The floating dashboard card (the live flow) is rendered by HomePage
// directly below, pulled up over the clouds with a negative margin.
// Design v2 polish: glossy 3D ember CTAs with a shine sweep, count-up live
// stats in glass chips, floating ember orbs (pure CSS, aria-hidden).
import { useStats } from '../hooks/useApi'
import { COPY } from '../lib/copy'
import { AppHeader } from './AppHeader'
import { CountUp } from './polish'

function Stat({ label, value }: { label: string; value: number | null }) {
  return (
    <div className="flex flex-col items-center gap-1 px-4 py-2 sm:px-5">
      <span className="text-[26px] leading-none font-medium tracking-[-0.02em] text-white tabular-nums">
        {value === null ? '—' : <CountUp value={value} />}
      </span>
      <span className="text-[12px] text-white/85">{label}</span>
    </div>
  )
}

export function Hero() {
  const stats = useStats()
  const s = stats.data

  return (
    <section className="relative overflow-hidden" aria-labelledby="hero-title">
      {/* Sunset sky — our own generated art (2352×1008, 169 KB), preloaded.
          The CSS gradient underneath is the fallback so the sky still reads
          as sunset while the image loads or if it fails. */}
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{
          background: 'linear-gradient(180deg, #7C2D12 0%, #C2410C 42%, #F59E0B 72%, #FDE68A 100%)',
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
      {/* Floating ember orbs — pure CSS, decorative only. */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0">
        <span className="animate-float absolute top-[18%] left-[8%] h-16 w-16 rounded-full bg-white/25 blur-[2px]" />
        <span className="animate-float-slow absolute top-[30%] right-[10%] h-10 w-10 rounded-full bg-white/30 blur-[1px]" />
        <span className="animate-float absolute top-[55%] left-[16%] h-6 w-6 rounded-full bg-amber/60 blur-[1px]" />
        <span className="animate-float-slow absolute top-[22%] right-[26%] h-5 w-5 rounded-full bg-white/35" />
      </div>
      {/* Bottom fade into paper — softens the cut where the cloud band meets
          the cream section below (the floating card covers the middle). */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[80px]"
        aria-hidden="true"
        style={{ background: 'linear-gradient(180deg, rgba(250,246,239,0) 0%, #FAF6EF 100%)' }}
      />
      <div className="relative z-10">
        <AppHeader dark skipTarget="#invoice" />
        <div className="mx-auto max-w-[1101px] px-4 pt-14 pb-[190px] text-center sm:px-6 sm:pt-20">
          <h1
            id="hero-title"
            className="mx-auto max-w-[880px] text-[40px] leading-[1.05] font-medium tracking-[-0.03em] text-white sm:text-[64px]"
          >
            Every invoice paid once. Every payment provable.
          </h1>
          <p className="mx-auto mt-5 max-w-[600px] text-[15px] leading-[1.5] text-white/90 sm:text-[17px]">
            {COPY.heroSub}
          </p>
          <div className="mt-10 flex flex-wrap items-center justify-center gap-4">
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
          {/* Stats band — live only, count-up numbers in glass chips. */}
          <div
            className="mx-auto mt-10 flex w-fit max-w-full flex-wrap items-stretch justify-center gap-2 rounded-[20px] border border-white/25 bg-ink/60 p-2 shadow-[0_20px_50px_rgba(23,19,16,0.35)] backdrop-blur"
            aria-label="Live registry stats"
          >
            <Stat label="payables on the registry" value={s ? s.payables_total : null} />
            <Stat label="paid" value={s ? s.paid_total : null} />
            <Stat label="refused on chain" value={s ? s.refused_on_chain_since_deploy : null} />
            <div className="flex flex-col items-center gap-1 px-4 py-2 sm:px-5">
              <span className="text-[26px] leading-none font-medium tracking-[-0.02em] text-white tabular-nums">
                {s?.last_verifier_run_at ? new Date(s.last_verifier_run_at).toISOString().slice(11, 16) + ' UTC' : '—'}
              </span>
              <span className="text-[12px] text-white/85">last verifier run</span>
            </div>
          </div>
          {stats.isError ? (
            <p className="mt-2 text-sm text-white/80" role="status">
              {COPY.statsNoData}
            </p>
          ) : null}
        </div>
      </div>
    </section>
  )
}
