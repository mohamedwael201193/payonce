// HeroOverview — the floating hero dashboard window, rebuilt to match the
// video card's composition literally (VIDEO_ANALYSIS.md, frames 02–03):
// top bar (title + registry pill + Export + New invoice), sub-tabs,
// Cash-overview bar chart + paid-once gauge, then Payment rails / Insights /
// Next dues. Every panel is LIVE data from /api/invoices + /api/stats —
// the mapping is in lib/heroOverview.ts. No invented numbers, no fake
// mockup: the chart is the real payables list, the gauge is the real
// paid-once share, the rails are the real CCD/EUDemo split, the insights
// are computed from state, the dues are the real soonest-due invoices.
// The Refused tab shows the labelled recorded run (24 Nov 2026).
import { useRef, useState } from 'react'
import { LayoutGrid } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useConfig, useInvoices, useStats } from '../hooks/useApi'
import { COPY } from '../lib/copy'
import { invoicesToCsv } from '../lib/dashboard'
import { formatCcdTotal, heroOverview, overviewBars, type OverviewTab } from '../lib/heroOverview'
import { RECORDED_DATE, RECORDED_REFUSALS } from '../lib/recorded'
import { formatUtcDateTime, truncHash } from '../lib/format'
import { EXPLORER_TX } from '../lib/tokens'

const TABS: Array<{ id: OverviewTab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'paid', label: 'Paid' },
  { id: 'unpaid', label: 'Unpaid' },
  { id: 'refused', label: 'Refused' },
]

/** Paid-once gauge — the video's Runway arc, our paid share. */
function PaidOnceGauge({ paid, total, refused }: { paid: number; total: number; refused: number }) {
  const pct = total === 0 ? 0 : Math.round((paid / total) * 100)
  return (
    <div>
      <div className="relative mx-auto w-fit">
        <svg width="200" height="112" viewBox="0 0 200 112" role="img" aria-label={`${paid} of ${total} payables paid once (${pct} percent)`}>
          <path d="M 20 104 A 80 80 0 0 1 180 104" fill="none" stroke="#E7DDCB" strokeWidth="13" strokeLinecap="round" />
          <path
            d="M 20 104 A 80 80 0 0 1 180 104"
            fill="none"
            stroke="#171310"
            strokeWidth="13"
            strokeLinecap="round"
            strokeDasharray={`${pct} 100`}
            pathLength={100}
          />
        </svg>
        <p className="absolute inset-x-0 bottom-0 text-center text-[30px] leading-none font-medium tracking-[-0.02em] text-ink tabular-nums">
          {pct}%
        </p>
      </div>
      <p className="mt-2 text-center text-xs text-muted">
        {paid} of {total} listed payables paid once
      </p>
      <dl className="mt-4 divide-y divide-line text-sm">
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted">Paid once</dt>
          <dd className="font-medium text-ink tabular-nums">{paid}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted">Unpaid open</dt>
          <dd className="font-medium text-ink tabular-nums">{total - paid}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted">Refused on chain</dt>
          <dd className="font-medium text-ink tabular-nums">{refused}</dd>
        </div>
        <div className="flex items-center justify-between gap-3 py-2">
          <dt className="text-muted">Target</dt>
          <dd className="font-medium text-ink">Every invoice once</dd>
        </div>
      </dl>
    </div>
  )
}

export function HeroOverview() {
  const invoices = useInvoices()
  const stats = useStats()
  const config = useConfig()
  const [tab, setTab] = useState<OverviewTab>('overview')
  const [insightsDismissed, setInsightsDismissed] = useState(false)
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([])
  const onTabKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return
    e.preventDefault()
    const dir = e.key === 'ArrowRight' ? 1 : -1
    const cur = TABS.findIndex((t) => t.id === tab)
    const next = (cur + dir + TABS.length) % TABS.length
    setTab(TABS[next].id)
    tabRefs.current[next]?.focus()
  }

  const items = invoices.data ?? []
  const o = heroOverview(items, stats.data)
  const bars = overviewBars(items, tab)
  const maxBar = Math.max(0, ...bars.map((b) => b.amount))
  const ticks = maxBar > 0 ? [maxBar, maxBar / 2, 0] : [0]

  const exportCsv = () => {
    const blob = new Blob([invoicesToCsv(items)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'payonce-invoices.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <section aria-labelledby="hero-overview-title" className="border-b border-line bg-card">
      {/* Top bar — video: "Cash overview" + date pill + Export + New forecast. */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-4 sm:px-6">
        <h2 id="hero-overview-title" className="flex items-center gap-2 text-[16px] font-medium text-ink">
          <LayoutGrid className="h-4 w-4 text-muted" aria-hidden="true" />
          Cash overview
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          {config.data ? (
            <a
              href={`${config.data.explorer.instance}${config.data.registry.index}/${config.data.registry.subindex}`}
              target="_blank"
              rel="noreferrer"
              className="rounded-full border border-line bg-paper px-3 py-1.5 font-mono text-xs text-brand-700"
            >
              Registry &lt;{config.data.registry.index},{config.data.registry.subindex}&gt;
            </a>
          ) : null}
          <button
            type="button"
            onClick={exportCsv}
            disabled={items.length === 0}
            className="rounded-full border border-line bg-paper px-3.5 py-1.5 text-[13px] font-medium text-ink hover:bg-paper-2 disabled:opacity-50"
          >
            Export
          </button>
          <a
            href="#invoice"
            className="inline-flex items-center rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-body"
          >
            + New invoice
          </a>
        </div>
      </div>

      {/* Sub-tabs — video: Overview / Inflows / Outflows / Accounts. Ours filter
          the live chart; Refused shows the labelled recorded run. */}
      <div
        className="flex flex-wrap items-center gap-2 border-b border-line px-5 py-3 sm:px-6"
        role="tablist"
        aria-label="Cash overview filter"
        onKeyDown={onTabKeyDown}
      >
        {TABS.map((t, i) => (
          <button
            key={t.id}
            ref={(el) => {
              tabRefs.current[i] = el
            }}
            role="tab"
            aria-selected={tab === t.id}
            tabIndex={tab === t.id ? 0 : -1}
            onClick={() => setTab(t.id)}
            className={`rounded-full px-3 py-1 text-[13px] font-medium ${
              tab === t.id ? 'bg-ink text-white' : 'text-body hover:bg-paper-2'
            }`}
          >
            {t.label}
            {t.id === 'paid' ? ` (${o.paidCount})` : ''}
            {t.id === 'unpaid' ? ` (${o.unpaidCount})` : ''}
            {t.id === 'refused' ? ` (${RECORDED_REFUSALS.length})` : ''}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted">
          {tab === 'refused'
            ? `Recorded run, ${RECORDED_DATE}`
            : stats.data?.last_verifier_run_at
              ? `Live from the test registry · last verifier run ${formatUtcDateTime(stats.data.last_verifier_run_at)}`
              : 'Live from the test registry'}
        </span>
      </div>

      <div className="grid gap-px bg-line lg:grid-cols-[2fr_1fr]">
        {/* Chart panel — video: big balance + Actual/Forecast bar chart. */}
        <div className="bg-card p-5 sm:p-6">
          {invoices.isLoading ? (
            <p className="py-10 text-sm text-muted" role="status">Loading live numbers…</p>
          ) : invoices.isError ? (
            <p className="py-10 text-sm text-muted">{COPY.statsNoData}</p>
          ) : tab === 'refused' ? (
            <div>
              <p className="text-sm font-medium text-ink">Refused on chain — recorded run, {RECORDED_DATE}</p>
              <p className="mt-1 text-xs text-muted">
                {stats.data ? `${stats.data.refused_on_chain_since_deploy} refused since deploy.` : ''} The 7 refusals
                below are the recorded run; each one stopped before any money moved.
              </p>
              <ul className="mt-4 divide-y divide-line">
                {RECORDED_REFUSALS.map((r) => (
                  <li key={r.txHash} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5">
                    <span className="rounded-full bg-refused-bg px-2 py-0.5 text-[11px] font-semibold text-refused-fg">
                      {r.code} · {r.name}
                    </span>
                    <span className="min-w-0 flex-1 text-[13px] text-body">{r.plain}</span>
                    <a
                      href={`${EXPLORER_TX}${r.txHash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="font-mono text-xs text-brand-700"
                    >
                      {truncHash(r.txHash)}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <div>
              <div className="flex flex-wrap items-end justify-between gap-3">
                <div>
                  <p className="text-xs text-muted">Registry total · CCD payables</p>
                  <p className="mt-1 text-[30px] leading-none font-medium tracking-[-0.02em] text-ink tabular-nums">
                    {formatCcdTotal(o.ccdTotal)}{' '}
                    <span className="rounded-full bg-paper-2 px-2 py-0.5 align-middle text-[11px] font-semibold text-body">
                      + {o.eudemoTotal.toFixed(2)} EUDemo on Rail B
                    </span>
                  </p>
                  <p className="mt-2 text-xs text-muted">
                    {o.listed} listed payables · {o.paidCount} paid once · {o.unpaidCount} unpaid
                  </p>
                </div>
                <p className="flex items-center gap-4 text-xs text-muted">
                  <span className="flex items-center gap-1.5">
                    <span className="inline-block h-3 w-3 rounded-[2px] bg-ink/70" aria-hidden="true" /> Paid (actual)
                  </span>
                  <span className="flex items-center gap-1.5">
                    <span className="bar-hatch inline-block h-3 w-3 rounded-[2px] border border-line" aria-hidden="true" /> Unpaid due
                  </span>
                </p>
              </div>
              {bars.length === 0 ? (
                <p className="py-10 text-sm text-muted">No payables in this state right now.</p>
              ) : (
                <div className="mt-5 flex gap-3">
                  <div className="flex h-[150px] w-8 shrink-0 flex-col justify-between py-1 text-right text-[11px] text-muted tabular-nums" aria-hidden="true">
                    {ticks.map((t) => (
                      <span key={t}>{t === 0 ? '0' : t % 1 === 0 ? `${t}` : t.toFixed(1)}</span>
                    ))}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex h-[150px] items-end gap-1.5 sm:gap-2.5" role="img" aria-label={`Bar chart of CCD payable amounts: ${bars.map((b) => b.label).join('; ')}`}>
                      {bars.map((b) => (
                        <div key={b.payable_id} className="flex h-full min-w-0 flex-1 items-end justify-center">
                          <div
                            className={`w-full max-w-[36px] rounded-t-[3px] ${b.paid ? 'bg-ink/70' : 'bar-hatch border border-line border-b-0'}`}
                            style={{ height: `${Math.max(b.heightPct, 2)}%` }}
                            title={b.label}
                          />
                        </div>
                      ))}
                    </div>
                    <div className="mt-1.5 flex gap-1.5 border-t border-line pt-1.5 sm:gap-2.5" aria-hidden="true">
                      {bars.map((b) => (
                        <span key={b.payable_id} className="min-w-0 flex-1 text-center text-[11px] text-muted tabular-nums">
                          {b.payable_id}
                        </span>
                      ))}
                    </div>
                    <p className="mt-1.5 text-[11px] text-muted">
                      Payable — CCD payables only. The {o.eudemoCount} EUDemo payable{o.eudemoCount === 1 ? '' : 's'} ({o.eudemoTotal.toFixed(2)} EUDemo) are a different test asset, so they are not mixed onto one CCD axis — see Payment rails.
                    </p>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>

        {/* Gauge panel — video: Runway 18 mo. Ours: the paid-once share. */}
        <div className="bg-card p-5 sm:p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-[15px] font-medium text-ink">Paid once</h3>
            <span className="rounded-full bg-verified-bg px-2 py-0.5 text-[11px] font-semibold text-verified-fg">Live</span>
          </div>
          <div className="mt-4">
            <PaidOnceGauge paid={o.paidCount} total={o.listed} refused={o.refusedTotal} />
          </div>
        </div>
      </div>

      {/* Bottom row — video: Bank accounts / AI insights / Next 14 days. */}
      <div className="grid gap-px bg-line md:grid-cols-3">
        <div className="bg-card p-5 sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-medium text-ink">Payment rails</h3>
            <span className="text-xs text-muted">2 connected</span>
          </div>
          <ul className="mt-4 space-y-4">
            {o.rails.map((r) => (
              <li key={r.rail}>
                <div className="flex items-baseline justify-between gap-2 text-sm">
                  <span className="font-medium whitespace-nowrap text-ink">{r.label}</span>
                  <span className="shrink-0 font-medium text-ink tabular-nums">
                    {r.total.toFixed(2)} {r.asset}
                  </span>
                </div>
                <div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-paper-2">
                  <div className="h-full rounded-full bg-brand-600" style={{ width: `${r.sharePct}%` }} />
                </div>
                <p className="mt-1 text-xs text-muted">
                  {r.count} payable{r.count === 1 ? '' : 's'} · {r.paidCount} of {r.count} paid once · {r.sharePct}% of listed payables
                </p>
              </li>
            ))}
          </ul>
          {config.data ? (
            <p className="mt-4 font-mono text-xs text-muted">
              Registry &lt;{config.data.registry.index},{config.data.registry.subindex}&gt;
            </p>
          ) : null}
        </div>

        <div className="bg-card p-5 sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-medium text-ink">Insights</h3>
            <span className="text-xs text-muted">Computed from state</span>
          </div>
          {insightsDismissed ? (
            <div className="mt-4">
              <p className="text-sm text-muted">Insights dismissed for now.</p>
              <button
                type="button"
                onClick={() => setInsightsDismissed(false)}
                className="mt-3 rounded-full border border-line px-3 py-1.5 text-[13px] font-medium text-ink hover:bg-paper-2"
              >
                Show insights again
              </button>
            </div>
          ) : o.insights.length === 0 ? (
            <p className="mt-4 text-sm text-muted">
              {invoices.isLoading ? 'Loading live numbers…' : 'No insights yet — the registry is still loading.'}
            </p>
          ) : (
            <div>
              <ul className="mt-4 space-y-3.5">
                {o.insights.map((ins) => (
                  <li key={ins.title} className="rounded-[6px] bg-paper px-3 py-2.5">
                    <p className="text-[13px] leading-snug font-medium text-ink">{ins.title}</p>
                    <p className="mt-0.5 text-xs leading-relaxed text-muted">{ins.detail}</p>
                  </li>
                ))}
              </ul>
              <div className="mt-4 flex flex-wrap items-center gap-3">
                <Link to="/dashboard" className="inline-flex items-center rounded-full bg-ink px-3.5 py-1.5 text-[13px] font-medium text-white hover:bg-body">
                  Review all
                </Link>
                <button
                  type="button"
                  onClick={() => setInsightsDismissed(true)}
                  className="text-[13px] font-medium text-muted hover:text-ink"
                >
                  Dismiss
                </button>
              </div>
              <p className="mt-3 text-[11px] leading-relaxed text-muted">
                Insight lines are computed from state, not from a language model.
              </p>
            </div>
          )}
        </div>

        <div className="bg-card p-5 sm:p-6">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[15px] font-medium text-ink">Next dues</h3>
            <Link to="/dashboard" className="text-xs font-medium text-brand-700">
              View all
            </Link>
          </div>
          {o.nextDues.length === 0 ? (
            <p className="mt-4 text-sm text-muted">
              {invoices.isLoading ? 'Loading live numbers…' : 'Nothing due — every listed payable is paid.'}
            </p>
          ) : (
            <ul className="mt-4 space-y-3.5">
              {o.nextDues.map((d) => (
                <li key={d.payable_id} className="flex items-center gap-3">
                  <span className="flex h-11 w-11 shrink-0 flex-col items-center justify-center rounded-[6px] border border-line bg-paper">
                    <span className="text-[15px] leading-none font-medium text-ink tabular-nums">{d.day}</span>
                    <span className="mt-0.5 text-[10px] leading-none text-muted">{d.mon}</span>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block text-[13px] font-medium whitespace-nowrap text-ink">Payable {d.payable_id}</span>
                    <span className="block text-xs text-muted">
                      Due {d.day} {d.mon} · {d.overdue ? 'past due' : 'coming due'}
                    </span>
                  </span>
                  <span className="shrink-0 text-[12px] font-medium whitespace-nowrap text-ink tabular-nums">{d.amount_display}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-4 text-[11px] leading-relaxed text-muted">
            From the live invoice list — soonest-due unpaid first.
          </p>
        </div>
      </div>
    </section>
  )
}
