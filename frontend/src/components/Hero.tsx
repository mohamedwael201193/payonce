// HeroStrip — P3 §5 (HeroStrip) + design F10f: the live port needs a COMPACT
// hero so steps 1–3 fit without scrolling at 1440×900. H1 is 32 px, the
// stats are one inline row, the whole strip is ~200 px. The tall hero with
// the floating dashboard is a mockup artefact — the dashboard lives in its
// own "Live console" section below the flow (HomePage). No CTAs here: the
// header already carries "Verify an invoice" and the flow starts right below.
import { useStats } from '../hooks/useApi'
import { COPY } from '../lib/copy'
import { CloudBanks } from './Clouds'

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
      {/* Dawn sky — our own generated art (design §9), preloaded, 71 KB.
          object-top cover; the CSS gradient underneath is the fallback.
          The <link rel="preload" fetchpriority="high"> in index.html carries
          the priority hint; React 18 does not support the fetchPriority prop
          on <img> (it warns and drops it), so it is deliberately absent here. */}
      <img
        src="/assets/hero-sky.webp"
        alt=""
        aria-hidden="true"
        width={2048}
        height={1152}
        className="absolute inset-0 h-full w-full object-cover object-top"
      />
      <div
        className="absolute inset-0"
        aria-hidden="true"
        style={{
          background:
            'linear-gradient(180deg, rgba(10,42,51,0.35) 0%, rgba(21,80,90,0.15) 34%, rgba(31,111,106,0.05) 58%, rgba(167,220,208,0) 78%, rgba(247,235,221,0) 100%)',
        }}
      />
      <div className="relative z-10 mx-auto max-w-[1101px] px-4 pt-6 pb-4 sm:px-6">
        <h1
          id="hero-title"
          className="max-w-[720px] text-[32px] leading-[1.05] font-medium tracking-[-0.03em] text-white"
        >
          Every invoice paid once. Every payment provable.
        </h1>
        <p className="mt-3 max-w-[560px] text-[15px] leading-[1.4] text-white/90">{COPY.heroSub}</p>
        {/* Stats strip — live only, one inline row. The dawn sky brightens
            toward the horizon, so the stats sit on a dark chip: measured
            1.5:1 without it (white/80 over the cloud seam), ~7:1 with it. */}
        <div
          className="mt-4 flex w-fit flex-wrap items-baseline divide-x divide-white/20 rounded-md bg-ink/85 px-3 py-2"
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
      <CloudBanks className="h-[48px]" />
      {/* Bottom fade into paper (P2 §2.5). */}
      <div
        className="pointer-events-none absolute inset-x-0 bottom-0 h-[60px]"
        aria-hidden="true"
        style={{ background: 'linear-gradient(180deg, rgba(244,247,246,0) 0%, #F4F7F6 100%)' }}
      />
    </section>
  )
}
