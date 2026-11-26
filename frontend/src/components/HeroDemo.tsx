// HeroDemo — the TALL demo dashboard in the hero (user rulings 2026-11-26
// 00:37 + 01:24: match the Altura reference video frame by frame — the
// video is the spec; COMPACT and DENSE, not stretched and sparse). A wide
// panel with a left sidebar (the real app's nav as non-interactive labels,
// Dashboard current) plus a header strip, a Payables overview chart (CCD
// by due month, with a real axis), a paid-once gauge with stat rows,
// payment rails, insights and a Next-14-days panel, in the video's tight
// 2-row grid. Props-only, zero network calls; every number comes from
// heroOverview() over the live list + stats — nothing is invented (no "vs
// last month", no forecast, no AI: the panel is "Insights", computed lines
// only). One link out: "View the real dashboard →". No steps, no checks,
// no pay button, no receipt.
// The animated mouse is back (fix-back 2026-11-26: the merge deleted it and
// the user noticed): a tour cursor glides between the demo's landmarks and
// dwells at each stop with a soft highlight — it never presses, never
// clicks, never ripples. Labelled "Demo", never "Simulation".
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { Calendar, Home, LayoutDashboard, Receipt, ShieldCheck } from 'lucide-react'
import { chartAxisTicks, formatCcdTotal, formatTick, heroOverview, overviewBars } from '../lib/heroOverview'
import { refusedCaption } from '../lib/copy'
import { tourFrameAt, TOUR_LOOP_MS, type TourWaypoints } from '../lib/heroDemo'
import { Gauge, Skeleton } from './polish'
import type { InvoiceItem, Stats } from '../lib/types'

// The real app's nav (AppHeader NAV_ITEMS + the dashboard sidebar NAV,
// minus the pay flow) as preview labels — the demo is a picture of the
// dashboard, not a second navigation. Dashboard is the current section in
// this preview. "Search" is NOT here: it is not in the real dashboard NAV
// (it was a preview-only label — dropped). "Pay an invoice" is NOT here
// either: it names the pay flow fix-back-12 removed from the landing
// (adversarial finding #5) — the demo depicts the dashboard overview, and
// the single way out is "View the real dashboard →". "Verify age" is the
// real /verify-age page. No Altura section name is copied — that would
// fabricate navigation.
const SIDEBAR_NAV = [
  { label: 'Home', icon: Home, current: false },
  { label: 'Dashboard', icon: LayoutDashboard, current: true },
  { label: 'For judges', icon: Receipt, current: false },
  { label: 'Verify age', icon: ShieldCheck, current: false },
]

const ZERO_WAYPOINTS: TourWaypoints = {
  rest: { x: 0, y: 0 },
  sidebar: { x: 0, y: 0 },
  strip: { x: 0, y: 0 },
  chart: { x: 0, y: 0 },
  gauge: { x: 0, y: 0 },
  rails: { x: 0, y: 0 },
  insights: { x: 0, y: 0 },
  dues: { x: 0, y: 0 },
}

// The header strip is the video's tabs/header row, restored as a clearly-
// labelled PREVIEW (adversarial finding #1): the tabs are the frame's tab
// strip, the date pill is the live list's real due range, the synced line
// is the live poll time. The "Preview" tag sits at the head of the strip
// and the strip container carries aria-label="Header preview", so the tag
// scopes the WHOLE strip — not just the tabs. Nothing in the strip is a
// control — the tabs and the date pill are spans. The frame's "Export" and
// "+ New forecast" actions are NOT here: PayOnce has no export or forecast
// feature, and a dark primary-styled "+ New forecast" pill reads as a real
// action for a feature that does not exist (honesty + adversarial
// re-review, main 63a7eee). To remove the strip later, delete the single
// <DemoHeaderStrip … /> line below — one change, nothing else moves.
function DemoHeaderStrip({ dueRangeLabel, lastUpdated }: { dueRangeLabel: string | null; lastUpdated: string | null }) {
  return (
    <div data-testid="demo-header-strip" aria-label="Header preview" className="mt-3 rounded-[10px] border border-line bg-paper px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="rounded-full bg-paper-2 px-2 py-0.5 text-[10px] font-semibold text-body">Preview</span>
        <div className="flex flex-wrap items-center gap-1">
          {['Overview', 'Inflows', 'Outflows', 'Accounts'].map((tab, i) => (
            <span
              key={tab}
              data-demo-target={i === 0 ? 'strip' : undefined}
              className={`rounded-full px-3 py-1 text-[13px] whitespace-nowrap ${
                i === 0 ? 'border border-line bg-card font-semibold text-ink' : 'font-medium text-body'
              }`}
            >
              {tab}
            </span>
          ))}
        </div>
        <span className="flex items-center gap-1.5 rounded-full border border-line bg-card px-3 py-1 text-[13px] font-medium text-body">
          <Calendar className="h-3.5 w-3.5" aria-hidden="true" />
          {dueRangeLabel ?? 'No payables yet'}
        </span>
        <span className="ml-auto text-xs text-muted">
          {lastUpdated ? `Last updated: ${lastUpdated} · refreshing every 30 s` : 'Live from the test registry'}
        </span>
      </div>
    </div>
  )
}

export function HeroDemo({
  items,
  stats,
  error = false,
  lastUpdated = null,
}: {
  items: InvoiceItem[]
  stats: Stats | undefined
  error?: boolean
  /** Last successful poll, pre-formatted ("10:42:07 UTC") — the dashboard
      shows this; home showed no "Last updated" line at all (fix-back-8
      MF-4). Null while nothing has loaded yet. */
  lastUpdated?: string | null
}) {
  const overview = useMemo(() => heroOverview(items, stats), [items, stats])
  const { bars, months, droppedTotal } = useMemo(() => overviewBars(items), [items])
  const axis = useMemo(() => chartAxisTicks(items), [items])
  // The axis top tick is what the bars are scaled to (adversarial B1) —
  // the aria name and the label positions both use it, never axis.max.
  const topTick = axis.ticks[axis.ticks.length - 1]
  // CCD payables with no due date are counted in the big total but have
  // no month to chart — one disclosure, rendered in the legend when bars
  // exist AND in the empty-chart branch when the whole chart is excluded
  // (adversarial B-F1: the legend-only copy never rendered in that branch).
  const excludedNote =
    overview.excludedFromChart.count > 0 ? (
      <span>
        {overview.excludedFromChart.count} CCD payable{overview.excludedFromChart.count === 1 ? '' : 's'} (
        {overview.excludedFromChart.total.toFixed(2)} CCD) {overview.excludedFromChart.count === 1 ? 'has' : 'have'} no due date and{' '}
        {overview.excludedFromChart.count === 1 ? 'is' : 'are'} not in this chart — counted in the totals above.
      </span>
    ) : null
  // The refused caption derives its date from stats.last_verifier_run_at
  // and is empty while the stats have not loaded (finding #6) — the
  // component renders no caption at all in that case.
  const caption = refusedCaption(stats?.refused_on_chain_since_deploy, stats?.last_verifier_run_at)
  // Fix-back-7 MF-7: an error with no data is an error, not an endless
  // loading skeleton — the hero used to show "still loading" forever on
  // a first-load failure. An error WITH data (a failed background
  // refresh) still renders the kept panels.
  const loading = items.length === 0 && stats === undefined && !error
  const loadFailed = error && items.length === 0 && stats === undefined
  // Fix-back-8 MF-4: an error WITH kept data used to render the panels
  // labelled live with NO staleness disclosure — while the dashboard
  // showed its could-not-refresh banner for the same failure. The pages
  // disagreed about whether the numbers were fresh. The hero now renders
  // the same note as the dashboard banner when it shows kept data after
  // a failed refresh.
  const stale = error && !loadFailed && !loading
  const hasData = !loading && !loadFailed

  // The tour cursor (restored fix-back 2026-11-26): a requestAnimationFrame
  // clock drives the pure timeline in lib/heroDemo.ts. The cursor position
  // is written straight to the DOM (no React re-render per frame); the
  // dwell highlight is a class toggled on the cursor element. Hovering the
  // demo panel pauses the clock; the prefers-reduced-motion static render
  // has no cursor. The cursor never presses, never clicks, never ripples.
  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [paused, setPaused] = useState(false)
  const [measured, setMeasured] = useState(false)

  const panelRef = useRef<HTMLDivElement | null>(null)
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const clockRef = useRef(0)
  const waypointsRef = useRef<TourWaypoints>(ZERO_WAYPOINTS)
  const pausedRef = useRef(false)

  // Reduced-motion preference (live: follows the OS setting).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
    return () => mq.removeEventListener('change', onChange)
  }, [])

  // Hovering the demo panel pauses the tour (so the user can inspect it).
  useEffect(() => {
    const panel = panelRef.current
    if (!panel) return
    const onEnter = () => {
      pausedRef.current = true
      setPaused(true)
    }
    const onLeave = () => {
      pausedRef.current = false
      setPaused(false)
    }
    panel.addEventListener('mouseenter', onEnter)
    panel.addEventListener('mouseleave', onLeave)
    return () => {
      panel.removeEventListener('mouseenter', onEnter)
      panel.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  // Waypoints: centres of the tour landmarks, relative to the demo panel.
  // Re-measured on layout, on resize, and whenever the list or stats
  // change (the invoice list loads async). Below md the sidebar is
  // display:none (zero rect) — the sidebar waypoint then falls back to the
  // mobile nav strip's Dashboard row, the same landmark.
  useLayoutEffect(() => {
    if (!hasData) return
    const panel = panelRef.current
    if (!panel) return
    const measure = () => {
      const s = panel.getBoundingClientRect()
      const at = (target: string, fallback?: string): { x: number; y: number } => {
        let el = panel.querySelector(`[data-demo-target="${target}"]`)
        if (el && fallback) {
          const r = el.getBoundingClientRect()
          if (r.width === 0 && r.height === 0) el = panel.querySelector(`[data-demo-target="${fallback}"]`)
        }
        if (!el) return waypointsRef.current.rest
        const r = el.getBoundingClientRect()
        return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 }
      }
      waypointsRef.current = {
        rest: at('rest'),
        sidebar: at('sidebar', 'sidebar-mobile'),
        strip: at('strip'),
        chart: at('chart'),
        gauge: at('gauge'),
        rails: at('rails'),
        insights: at('insights'),
        dues: at('dues'),
      }
      setMeasured(true)
    }
    measure()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    if (ro) ro.observe(panel)
    return () => ro?.disconnect()
  }, [hasData, items.length, stats])

  // The clock: rAF, paused on hover, frozen for reduced motion. The tour
  // NEVER scrolls the page: it only writes the cursor transform and toggles
  // the dwell highlight — a user reading below the demo is never yanked
  // back up.
  useEffect(() => {
    if (reduced || !measured || !hasData) return
    let raf = 0
    let last = typeof performance !== 'undefined' ? performance.now() : 0
    const tick = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      if (!pausedRef.current) {
        clockRef.current = (clockRef.current + dt) % TOUR_LOOP_MS
        const f = tourFrameAt(clockRef.current, waypointsRef.current)
        const el = cursorRef.current
        if (el) {
          el.style.transform = `translate(${f.cursor.x}px, ${f.cursor.y}px)`
          el.classList.toggle('demo-cursor-dwell', f.dwelling)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
    }
  }, [reduced, measured, hasData])

  return (
    <div ref={panelRef} className="relative flex flex-col md:flex-row">
      {/* Sidebar — the video's left nav, PayOnce's real labels only.
          Hidden below the md breakpoint: on phones the demo shows the
          mobile nav strip instead (finding #9). */}
      {hasData ? (
        <div data-testid="demo-sidebar" className="hidden w-[200px] shrink-0 flex-col border-r border-line bg-paper px-3 py-4 md:flex">
          <p className="px-2 text-[13px] font-semibold tracking-[0.08em] text-muted">PAYONCE</p>
          <nav aria-label="Demo navigation (preview)" className="mt-3 space-y-1">
            {SIDEBAR_NAV.map((n) => (
              <span
                key={n.label}
                data-demo-target={n.label === 'Dashboard' ? 'sidebar' : undefined}
                className={`flex items-center gap-3 rounded-full px-3 py-2 text-[14px] whitespace-nowrap ${
                  n.current
                    ? 'border border-line bg-card font-semibold text-ink'
                    : 'font-medium text-body'
                }`}
              >
                <n.icon className="h-5 w-5" aria-hidden="true" />
                {n.label}
              </span>
            ))}
          </nav>
          {/* The bottom of the sidebar was a long empty stretch (the
              user's screenshot). The real dashboard's sidebar solves the
              same gap with decorative hairline art pinned to the bottom —
              this is the same device in the demo's light theme:
              decorative only (aria-hidden), no nav, no claim. */}
          <div className="mt-auto px-2 pt-6" aria-hidden="true">
            <svg viewBox="0 0 200 90" className="w-full text-muted/40" fill="none" stroke="currentColor" strokeWidth="1.25" strokeLinecap="round">
              <circle cx="100" cy="30" r="12" />
              <path d="M 100 12 v -5 M 100 53 v -5 M 82 30 h -5 M 123 30 h -5" opacity="0.7" />
              <path d="M 0 62 C 40 50, 70 70, 100 60 S 160 48, 200 62" opacity="0.8" />
              <path d="M 0 74 C 45 62, 80 80, 115 70 S 170 64, 200 74" opacity="0.55" />
              <rect x="90" y="40" width="20" height="24" rx="2" />
              <path d="M 94 47 h 12 M 94 52 h 12 M 94 57 h 8" opacity="0.8" />
            </svg>
            <p className="px-2 pt-2 text-xs leading-relaxed text-muted">
              Testnet · Concordium
              <br />
              Every number here is live from the test registry.
            </p>
          </div>
        </div>
      ) : null}

      <div className="min-w-0 flex-1 px-4 py-4 sm:px-5">
        {loadFailed ? (
          <div role="alert">
            <p className="mt-5 text-sm text-muted">
              Could not load the live numbers — the test API did not answer. Try refreshing the page.
            </p>
          </div>
        ) : loading ? (
          <div role="status">
            <p className="mt-5 text-sm text-muted">Demo unavailable — the live invoice list is still loading.</p>
            <div className="mt-4" aria-hidden="true">
              <Skeleton className="h-[40px] w-[220px]" />
              <Skeleton className="mt-4 h-[180px] w-full" />
              <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-[180px] w-full" />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Mobile nav — below md the sidebar is hidden, so the phone
                render gets the same real nav as a horizontal strip
                (finding #9): the phone demo keeps the spec's structure. */}
            <div data-testid="demo-mobile-nav" className="flex gap-2 overflow-x-auto md:hidden" aria-label="Demo navigation (preview)">
              {SIDEBAR_NAV.map((n) => (
                <span
                  key={n.label}
                  data-demo-target={n.label === 'Dashboard' ? 'sidebar-mobile' : undefined}
                  className={`shrink-0 rounded-full border px-3 py-1.5 text-[13px] whitespace-nowrap ${
                    n.current ? 'border-line bg-card font-semibold text-ink' : 'border-line bg-paper font-medium text-body'
                  }`}
                >
                  {n.label}
                </span>
              ))}
            </div>

            {/* Fix-back-8 MF-4: staleness disclosure for kept data after a
                failed refresh — same wording as the dashboard's
                could-not-refresh banner. */}
            {stale ? (
              <p role="status" className="mt-3 rounded-[8px] border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-body">
                Could not refresh the live numbers just now — showing the last verified numbers
                {lastUpdated ? ` from ${lastUpdated}` : ''}. The page retries every 30 s.
              </p>
            ) : null}

            {/* Header — the demo dashboard's title, with the Demo badge.
                The frame has the title row ABOVE the tabs strip (finding
                M5): the strip used to sit above the title. */}
            <div className="mt-3 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="flex flex-wrap items-center gap-2 text-[20px] font-medium text-ink">
                  Payables overview
                  <span className="rounded-full bg-brand-600 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                    Demo
                  </span>
                  {paused && !reduced ? (
                    <span className="rounded-full bg-paper-2 px-2.5 py-0.5 text-[11px] font-semibold text-body">
                      Paused — move away to resume
                    </span>
                  ) : null}
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">
                  Live invoices on the test registry — CCD payables, paid solid, unpaid hatched.
                </p>
              </div>
              <Link to="/dashboard" className="shrink-0 text-[13px] font-medium text-brand-700 hover:underline">
                View the real dashboard →
              </Link>
            </div>

            <DemoHeaderStrip dueRangeLabel={overview.dueRangeLabel} lastUpdated={lastUpdated} />

            {/* Row 1 — the video's chart + gauge row: the CCD chart (with
                the big total) beside the paid-once gauge. */}
            <div className="mt-3 grid grid-cols-1 gap-3 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
              <section aria-labelledby="demo-chart-title" data-demo-target="chart" className="rounded-[12px] border border-line bg-paper p-3 sm:p-4">
                <p className="text-xs text-muted">CCD total</p>
                <div className="mt-1 flex flex-wrap items-end gap-3">
                  <p data-testid="demo-big-total" data-demo-target="rest" className="text-[36px] leading-none font-medium tracking-[-0.02em] text-ink tabular-nums">
                    {formatCcdTotal(overview.ccdTotal)}
                  </p>
                  {/* The EUDemo chip is ALWAYS shown, even at zero
                      (finding #11): hiding it at zero contradicted the
                      rails panel, which shows "0 payables · 0 paid —
                      0.00 EUDemo" in the same render. */}
                  <p data-testid="demo-eudemo-chip" className="rounded-full border border-line bg-paper px-3 py-1 text-xs font-medium text-body tabular-nums">
                    {overview.eudemoTotal.toFixed(2)} EUDemo
                  </p>
                </div>
                <p className="mt-2 text-sm text-muted">
                  {overview.paidCount} paid once · {overview.unpaidCount} unpaid · {overview.listed} listed
                </p>
                <h4 id="demo-chart-title" className="sr-only">
                  CCD payables chart
                </h4>
                {bars.length === 0 ? (
                  overview.ccdCount > 0 ? (
                    <>
                      <p className="mt-4 text-sm text-muted">
                        CCD payables exist, but none has a due date to chart.
                      </p>
                      {excludedNote ? <p className="mt-2 text-xs text-muted">{excludedNote}</p> : null}
                    </>
                  ) : (
                    <p className="mt-4 text-sm text-muted">No CCD payables on the test registry yet.</p>
                  )
                ) : (
                  <div className="mt-3">
                    <div className="flex items-start gap-2">
                      {/* Y-axis — real CCD ticks (finding #3): without a
                          scale the bar heights were uninterpretable. Each
                          label is centred on its gridline (M3): the top
                          label sits on the top line, the bottom label
                          under the bottom line, the middle ones straddling
                          theirs. The scale is the tallest DISPLAYED
                          monthly total, and the bars are scaled to the
                          top tick — a bar measured against the axis reads
                          its true total (adversarial B1/B2). */}
                      <div data-testid="demo-chart-axis" className="relative h-[180px] w-[36px] shrink-0" aria-hidden="true">
                        {[...axis.ticks].reverse().map((t, i, arr) => {
                          const pct = topTick === 0 ? 0 : (1 - t / topTick) * 100
                          const transform = i === 0 ? undefined : i === arr.length - 1 ? 'translateY(-100%)' : 'translateY(-50%)'
                          return (
                            <span
                              key={t}
                              className="absolute right-0 text-[10px] leading-none text-muted tabular-nums"
                              style={{ top: `${pct}%`, transform }}
                            >
                              {formatTick(t)}
                            </span>
                          )
                        })}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="relative">
                          <div className="absolute inset-0 flex flex-col justify-between" aria-hidden="true">
                            {axis.ticks.map((t) => (
                              <div key={t} className="border-t border-line/60" />
                            ))}
                          </div>
                          <div
                            className="relative flex h-[180px] items-end gap-2"
                            role="img"
                            aria-label={`CCD payables by due month, paid solid, unpaid hatched, up to ${formatTick(topTick)} CCD`}
                          >
                            {bars.map((b) => (
                              <div
                                key={b.month}
                                data-testid="demo-chart-bar"
                                className="flex min-w-0 flex-1 flex-col items-center justify-end"
                                title={`${b.month} · ${b.total.toFixed(2)} CCD (${b.paidTotal.toFixed(2)} paid, ${b.unpaidTotal.toFixed(2)} unpaid, ${b.count} payable${b.count === 1 ? '' : 's'})`}
                              >
                                <div
                                  className="flex w-full max-w-[64px] flex-col-reverse overflow-hidden rounded-t-[2px]"
                                  // Pixel height straight from total/topTick — not via the
                                  // rounded heightPct, which would double-round (±1 px).
                                  // topTick is 0 only when every month totals 0.
                                  style={{ height: `${Math.max(b.total > 0 ? 3 : 0, topTick === 0 ? 0 : Math.round((b.total / topTick) * 180))}px` }}
                                >
                                  <div className="w-full bg-brand-600" style={{ height: `${b.paidPct}%` }} />
                                  <div className="w-full flex-1 border border-line bar-hatch" />
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                        <div className="mt-1 flex gap-2" aria-hidden="true">
                          {bars.map((b) => (
                            <span key={b.month} className="min-w-0 flex-1 truncate text-center text-[10px] text-muted">
                              {b.label}
                            </span>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-3 w-3 bg-brand-600" aria-hidden="true" /> Paid
                      </span>
                      <span className="flex items-center gap-1.5">
                        <span className="inline-block h-3 w-3 border border-line bar-hatch" aria-hidden="true" /> Unpaid
                      </span>
                      <span>EUDemo payables are not on this axis — they are in Payment rails.</span>
                      {months > 12 ? (
                        <span>
                          Showing the latest 12 months of {months} ({droppedTotal.toFixed(2)} CCD in earlier months not shown).
                        </span>
                      ) : null}
                      {/* CCD payables with no due date are counted in the
                          totals above but have no month to chart (B3) —
                          disclosed here so the chart sum stays
                          reconcilable with the big total. */}
                      {excludedNote}
                    </div>
                  </div>
                )}
              </section>

              <section aria-labelledby="demo-gauge-title" data-demo-target="gauge" className="rounded-[12px] border border-line bg-paper p-3 sm:p-4">
                <h4 id="demo-gauge-title" className="text-[15px] font-medium text-ink">
                  Paid once
                </h4>
                <p className="mt-1 text-[13px] text-muted">Share of the listed payables paid once, live.</p>
                <div className="mt-3">
                  <Gauge pct={overview.paidPct} label={`${overview.paidCount} of ${overview.listed} payables paid once`} />
                </div>
                {/* The frame's two-row stat table (finding #8): the
                    configured stats are the two asset totals, each real,
                    in its own asset. There is no configured "target" — the
                    old aspirational "Target: every invoice paid once."
                    line is gone. */}
                <dl data-testid="demo-gauge-stats" className="mt-3 space-y-2 border-t border-line pt-3">
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <dt className="text-muted">CCD total</dt>
                    <dd className="font-medium text-ink tabular-nums">{formatCcdTotal(overview.ccdTotal)}</dd>
                  </div>
                  <div className="flex items-baseline justify-between gap-3 text-[13px]">
                    <dt className="text-muted">EUDemo total</dt>
                    <dd className="font-medium text-ink tabular-nums">{overview.eudemoTotal.toFixed(2)} EUDemo</dd>
                  </div>
                </dl>
                {caption ? <p className="mt-3 text-xs leading-relaxed text-muted">{caption}</p> : null}
              </section>
            </div>

            {/* Row 2 — the video's bottom row: rails / insights / next 14
                days, three columns, no full-width section below. */}
            <div className="mt-3 grid grid-cols-1 gap-3 sm:grid-cols-3">
              <section aria-labelledby="demo-rails-title" data-demo-target="rails" className="rounded-[12px] border border-line bg-paper p-3 sm:p-4">
                <h4 id="demo-rails-title" className="text-[15px] font-medium text-ink">
                  Payment rails
                </h4>
                <p className="mt-1 text-[13px] text-muted">CCD and EUDemo are different test assets — never mixed on one axis.</p>
                <ul className="mt-3 space-y-2.5">
                  {overview.rails.map((r) => (
                    <li key={r.rail} className="flex items-baseline justify-between gap-3 border-b border-line pb-2.5 last:border-b-0 last:pb-0">
                      <div>
                        <p className="text-[14px] font-medium text-ink">{r.label}</p>
                        <p className="mt-0.5 text-xs text-muted">
                          {r.count} payables · {r.paidCount} paid
                        </p>
                      </div>
                      <p className="shrink-0 text-[14px] font-medium text-ink tabular-nums">
                        {r.total.toFixed(2)} {r.asset}
                      </p>
                    </li>
                  ))}
                </ul>
              </section>

              <section aria-labelledby="demo-insights-title" data-demo-target="insights" className="rounded-[12px] border border-line bg-paper p-3 sm:p-4">
                <h4 id="demo-insights-title" className="text-[15px] font-medium text-ink">
                  Insights
                </h4>
                <p className="mt-1 text-[13px] text-muted">Computed from the live list — never a language model.</p>
                {overview.insights.length === 0 ? (
                  <p className="mt-3 text-sm text-muted">Nothing to show yet — the list is empty.</p>
                ) : (
                  <ul className="mt-3 space-y-2.5">
                    {overview.insights.map((line) => (
                      <li key={line.title} className="border-b border-line pb-2.5 last:border-b-0 last:pb-0">
                        <p className="text-[14px] font-medium text-ink">{line.title}</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted">{line.detail}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section aria-labelledby="demo-dues-title" data-demo-target="dues" className="rounded-[12px] border border-line bg-paper p-3 sm:p-4">
                <h4 id="demo-dues-title" className="text-[15px] font-medium text-ink">
                  Next 14 days
                </h4>
                <p className="mt-1 text-[13px] text-muted">Unpaid payables due in the next 14 days, soonest first.</p>
                {overview.nextDues.length === 0 ? (
                  <p className="mt-3 text-sm text-muted">
                    {overview.listed === 0
                      ? 'No payables on the test registry yet.'
                      : 'Nothing due in the next 14 days.'}
                  </p>
                ) : (
                  <ul className="mt-3 space-y-2.5">
                    {overview.nextDues.map((d) => (
                      <li key={d.payable_id} className="flex items-center gap-3">
                        <span className="flex h-[36px] w-[36px] shrink-0 flex-col items-center justify-center rounded-[6px] border border-line bg-card leading-none">
                          <span className="text-[13px] font-semibold text-ink">{d.day}</span>
                          <span className="text-[10px] text-muted">{d.mon}</span>
                        </span>
                        <span className="min-w-0 flex-1 truncate text-[14px] font-medium text-ink">Payable {d.payable_id}</span>
                        <span className="shrink-0 text-[13px] text-body tabular-nums">{d.amount_display}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            <p className="mt-4 border-t border-line pt-3 text-[11px] leading-relaxed text-muted">
              Demo — the panels above show live numbers from the test registry. Open the real
              dashboard to pick, check and pay — nothing here pays anything.
            </p>
          </>
        )}
      </div>

      {/* Tour cursor — absolute over the demo panel, above the content,
          never intercepting pointer events. Rendered only in live mode
          once the landmarks are measured. It glides and dwells with a soft
          highlight — it never presses, never clicks, never ripples. */}
      {!reduced && measured && hasData ? (
        <div aria-hidden="true" data-demo-cursor="true" className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          <div
            ref={cursorRef}
            className="demo-cursor absolute top-0 left-0 will-change-transform"
            style={{ transform: 'translate(0px, 0px)' }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" style={{ margin: '-2px 0 0 -2px', filter: 'drop-shadow(0 1px 2px rgba(23,19,16,0.4))' }}>
              <path
                d="M5 3 L5 19 L9.5 14.5 L12.5 21 L15 19.8 L12 13.5 L19 13.5 Z"
                fill="#B4430F"
                stroke="#FFFFFF"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      ) : null}
    </div>
  )
}
