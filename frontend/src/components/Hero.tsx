// Hero — tall sunset hero, matched to the reference video (VIDEO_ANALYSIS.md).
// Full-bleed orange sunset sky (our own generated art), the pill nav in the
// sky, a huge centred white headline, centred subline + CTAs, live stats.
// The header lives INSIDE the hero, over the sky — not in a dark band above
// it. The floating dashboard card (the live flow) is rendered by HomePage
// directly below, pulled up over the clouds with a negative margin.
import { useStats } from '../hooks/useApi'
import { COPY } from '../lib/copy'
import { AppHeader } from './AppHeader'

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline gap-1.5 px-3 first:pl-0 sm:px-4">
      <span className="text-[20px] leading-none font-normal tracking-[-0.02em] text-white tabular-nums">
        {value}
      </span>
      <span className="text-[11px] text-white/80">{label}</span>
    </div>
  )
}

export function Hero() {
  const stats = useStats()
  const s = stats.data
  const stat = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(v))

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
          <div className="mt-8 flex flex-wrap items-center justify-center gap-3">
            <a
              href="#invoice"
              className="inline-flex min-h-[44px] items-center rounded-full bg-white px-6 py-2.5 text-[15px] font-medium text-ink"
            >
              Start verifying
            </a>
            <a
              href="#how"
              className="inline-flex min-h-[44px] items-center rounded-full border border-white/30 bg-ink/85 px-6 py-2.5 text-[15px] font-medium text-white"
            >
              See how it works
            </a>
          </div>
          {/* Stats strip — live only, one inline row, centred. The dark chip
              keeps the white numbers at ~7:1 over the bright sky. */}
          <div
            className="mx-auto mt-8 flex w-fit flex-wrap items-baseline justify-center divide-x divide-white/20 rounded-md bg-ink/85 px-3 py-2"
            aria-label="Live registry stats"
          >
            <Stat label="payables on the registry" value={s ? stat(s.payables_total) : '—'} />
            <Stat label="paid" value={s ? stat(s.paid_total) : '—'} />
            <Stat label="refused on chain" value={s ? stat(s.refused_on_chain_since_deploy) : '—'} />
            <Stat
              label="last verifier run"
              value={s?.last_verifier_run_at ? new Date(s.last_verifier_run_at).toISOString().slice(11, 16) + ' UTC' : '—'}
            />
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
