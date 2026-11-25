// HeroDemo — the TALL demo dashboard in the hero (user ruling 2026-11-26
// 00:37: match the Altura reference video frame by frame — the video is
// the spec; the old short card was the wrong shape). A wide panel with a
// left sidebar (the real dashboard's nav as non-interactive labels,
// Dashboard current) plus Payables overview chart, paid-once gauge,
// payment rails, insights and due-soon panels, extending below the fold.
// Props-only, zero network calls; every number comes from heroOverview()
// over the live list + stats — nothing is invented (no "vs last month",
// no forecast, no AI: the panel is "Insights", computed lines only).
// One link out: "View the real dashboard →". No steps, no checks, no pay
// button, no receipt, no cursor, no tab row (tabs would be dead controls
// in a glimpse). Labelled "Demo", never "Simulation".
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { Home, LayoutDashboard, Receipt, Search, Wallet } from 'lucide-react'
import { formatCcdTotal, heroOverview, overviewBars } from '../lib/heroOverview'
import { refusedCaption } from '../lib/copy'
import { Gauge, Skeleton } from './polish'
import type { InvoiceItem, Stats } from '../lib/types'

// The real dashboard's nav (DashboardPage NAV) as preview labels — the
// demo is a picture of the dashboard, not a second navigation. Dashboard
// is the current section in this preview.
const SIDEBAR_NAV = [
  { label: 'Search', icon: Search, current: false },
  { label: 'Home', icon: Home, current: false },
  { label: 'Dashboard', icon: LayoutDashboard, current: true },
  { label: 'Pay an invoice', icon: Wallet, current: false },
  { label: 'For judges', icon: Receipt, current: false },
]

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
  const bars = useMemo(() => overviewBars(items, 'overview'), [items])
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

  return (
    <div className="flex flex-col md:flex-row">
      {/* Sidebar — the video's left nav, PayOnce labels. Hidden below the
          md breakpoint: on phones the demo is the panels only. */}
      {!loading && !loadFailed ? (
        <div className="hidden w-[220px] shrink-0 flex-col border-r border-line bg-paper px-4 py-5 md:flex">
          <p className="px-2 text-[13px] font-semibold tracking-[0.08em] text-muted">PAYONCE</p>
          <nav aria-label="Demo navigation (preview)" className="mt-4 space-y-1">
            {SIDEBAR_NAV.map((n) => (
              <span
                key={n.label}
                className={`flex items-center gap-3 rounded-full px-4 py-2.5 text-[15px] whitespace-nowrap ${
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
          <p className="mt-auto px-2 pt-6 text-xs leading-relaxed text-muted">
            Testnet · Concordium
            <br />
            Every number here is live from the test registry.
          </p>
        </div>
      ) : null}

      <div className="min-w-0 flex-1 px-4 py-5 sm:px-6">
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
              <Skeleton className="mt-5 h-[180px] w-full" />
              <div className="mt-5 grid grid-cols-1 gap-4 sm:grid-cols-3">
                {[0, 1, 2].map((i) => (
                  <Skeleton key={i} className="h-[180px] w-full" />
                ))}
              </div>
            </div>
          </div>
        ) : (
          <>
            {/* Fix-back-8 MF-4: staleness disclosure + "Last updated" for
                kept data after a failed refresh — same wording as the
                dashboard's could-not-refresh banner, so the two pages no
                longer disagree about whether the numbers are fresh. */}
            {stale ? (
              <p role="status" className="rounded-[8px] border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-body">
                Could not refresh the live numbers just now — showing the last verified numbers
                {lastUpdated ? ` from ${lastUpdated}` : ''}. The page retries every 30 s.
              </p>
            ) : null}
            {lastUpdated && !stale ? (
              <p className="text-xs text-muted">Last updated: {lastUpdated} · refreshing every 30 s</p>
            ) : null}

            {/* Header — the demo dashboard's title, with the Demo badge. */}
            <div className="mt-4 flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <h3 className="flex flex-wrap items-center gap-2 text-[20px] font-medium text-ink">
                  Payables overview
                  <span className="rounded-full bg-brand-600 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                    Demo
                  </span>
                </h3>
                <p className="mt-1 text-[13px] leading-relaxed text-muted">
                  Live invoices on the test registry — CCD payables, paid solid, unpaid hatched.
                </p>
              </div>
              <Link to="/dashboard" className="shrink-0 text-[13px] font-medium text-brand-700 hover:underline">
                View the real dashboard →
              </Link>
            </div>

            {/* Big number — the summed CCD total of the listed payables,
                plus the summed EUDemo total as a chip (each sum is real,
                in its own asset). No invented "vs last month". */}
            <div className="mt-5 flex flex-wrap items-end gap-3">
              <p className="text-[40px] leading-none font-medium tracking-[-0.02em] text-ink tabular-nums">
                {formatCcdTotal(overview.ccdTotal)}
              </p>
              {overview.eudemoCount > 0 ? (
                <p className="rounded-full border border-line bg-paper px-3 py-1 text-xs font-medium text-body tabular-nums">
                  {overview.eudemoTotal.toFixed(2)} EUDemo
                </p>
              ) : null}
            </div>
            <p className="mt-2 text-sm text-muted">
              {overview.paidCount} paid once · {overview.unpaidCount} unpaid · {overview.listed} listed
            </p>

            {/* Chart — CCD payables only (one asset, one axis), one bar
                per payable, paid solid, unpaid hatched. EUDemo payables
                are excluded by design; the legend says where they are. */}
            <div className="mt-5">
              {bars.length === 0 ? (
                <p className="text-sm text-muted">No CCD payables on the test registry yet.</p>
              ) : (
                <div
                  className="flex h-[200px] items-end gap-2"
                  role="img"
                  aria-label="CCD payables, paid solid, unpaid hatched"
                >
                  {bars.map((b) => (
                    <div
                      key={b.payable_id}
                      className="flex min-w-0 flex-1 flex-col items-center justify-end gap-1"
                      title={b.label}
                    >
                      <div
                        className={`w-full max-w-[48px] ${b.paid ? 'bg-brand-600' : 'bar-hatch border border-line'}`}
                        style={{ height: `${Math.max(4, Math.round((b.heightPct / 100) * 160))}px` }}
                      />
                      <span className="text-[11px] text-muted">#{b.payable_id}</span>
                    </div>
                  ))}
                </div>
              )}
              <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 bg-brand-600" aria-hidden="true" /> Paid
                </span>
                <span className="flex items-center gap-1.5">
                  <span className="inline-block h-3 w-3 border border-line bar-hatch" aria-hidden="true" /> Unpaid
                </span>
                <span>EUDemo payables are not on this axis — they are in Payment rails.</span>
              </div>
            </div>

            {/* Panels — gauge, rails, insights: the video's Runway /
                Bank accounts / AI insights row, PayOnce data. */}
            <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-3">
              <section aria-labelledby="demo-gauge-title" className="rounded-[12px] border border-line bg-paper p-4">
                <h4 id="demo-gauge-title" className="text-[15px] font-medium text-ink">
                  Paid once
                </h4>
                <p className="mt-1 text-[13px] text-muted">Share of the listed payables paid once, live.</p>
                <div className="mt-4">
                  <Gauge pct={overview.paidPct} label={`${overview.paidCount} of ${overview.listed} payables paid once`} />
                </div>
                <p className="mt-3 text-xs leading-relaxed text-muted">{refusedCaption(stats?.refused_on_chain_since_deploy)}</p>
                <p className="mt-1 text-xs text-muted">Target: every invoice paid once.</p>
              </section>

              <section aria-labelledby="demo-rails-title" className="rounded-[12px] border border-line bg-paper p-4">
                <h4 id="demo-rails-title" className="text-[15px] font-medium text-ink">
                  Payment rails
                </h4>
                <p className="mt-1 text-[13px] text-muted">CCD and EUDemo are different test assets — never mixed on one axis.</p>
                <ul className="mt-4 space-y-3">
                  {overview.rails.map((r) => (
                    <li key={r.rail} className="flex items-baseline justify-between gap-3 border-b border-line pb-3 last:border-b-0 last:pb-0">
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

              <section aria-labelledby="demo-insights-title" className="rounded-[12px] border border-line bg-paper p-4">
                <h4 id="demo-insights-title" className="text-[15px] font-medium text-ink">
                  Insights
                </h4>
                <p className="mt-1 text-[13px] text-muted">Computed from the live list — never a language model.</p>
                {overview.insights.length === 0 ? (
                  <p className="mt-4 text-sm text-muted">No payables on the test registry yet.</p>
                ) : (
                  <ul className="mt-4 space-y-3">
                    {overview.insights.map((line) => (
                      <li key={line.title} className="border-b border-line pb-3 last:border-b-0 last:pb-0">
                        <p className="text-[14px] font-medium text-ink">{line.title}</p>
                        <p className="mt-0.5 text-xs leading-relaxed text-muted">{line.detail}</p>
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>

            {/* Due soon — the video's Next 14 days: the soonest-due unpaid
                payables, plain text (the demo links nowhere but the real
                dashboard). */}
            <section aria-labelledby="demo-dues-title" className="mt-4 rounded-[12px] border border-line bg-paper p-4">
              <h4 id="demo-dues-title" className="text-[15px] font-medium text-ink">
                Due soon
              </h4>
              <p className="mt-1 text-[13px] text-muted">The soonest-due unpaid payables, from the live list.</p>
              {overview.nextDues.length === 0 ? (
                <p className="mt-4 text-sm text-muted">
                  {overview.listed === 0
                    ? 'No payables on the test registry yet.'
                    : 'Nothing open right now — every listed payable is paid once.'}
                </p>
              ) : (
                <ul className="mt-4 space-y-3">
                  {overview.nextDues.map((d) => (
                    <li key={d.payable_id} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 text-[14px]">
                      <span className="font-medium text-ink">Payable {d.payable_id}</span>
                      <span className="text-body tabular-nums">{d.amount_display}</span>
                      <span className={d.overdue ? 'shrink-0 text-refused-fg' : 'shrink-0 text-muted'}>
                        {d.day} {d.mon}
                        {d.overdue ? ' — past due' : ''}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <p className="mt-6 border-t border-line pt-4 text-[11px] leading-relaxed text-muted">
              Demo — the panels above show live numbers from the test registry. Open the real
              dashboard to pick, check and pay — nothing here pays anything.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
