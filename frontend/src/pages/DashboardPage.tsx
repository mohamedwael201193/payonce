// Dashboard (design v2) — a separate route, same sunset palette, all live
// data. Sidebar nav, 4 glass stat cards with sparklines (sequences derived
// from the live registry, in payable-id order), a searchable live invoice
// table with status pills, a live activity feed (real due dates / amounts —
// no invented timestamps), and a paid/unpaid donut from the live list.
// No invented percentages, no mock users, no fake activity.
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { ArrowRight, Download, Search } from 'lucide-react'
import { useConfig, useInvoices, useStats } from '../hooks/useApi'
import { COPY } from '../lib/copy'
import { DashboardShell } from '../components/DashboardShell'
import { activityFeed, dashboardStats, derivedStatus, donutSegments, filterInvoices, invoicesToCsv } from '../lib/dashboard'
import { heroOverview } from '../lib/heroOverview'
import { formatUtcDateTime, formatUtcTime } from '../lib/format'
import { CountUp, Donut, Gauge, InvoiceStatusPill, Reveal, Skeleton, Sparkline, useSlowLoad } from '../components/polish'

function sellerShort(seller: string, sellers?: Array<{ seller: string; label: string }>): string {
  const found = sellers?.find((s) => s.seller === seller)
  if (found) return found.label.split(' — ')[0]
  return `Seller ${seller.slice(0, 8)}…`
}

export function DashboardPage() {
  const stats = useStats()
  const invoices = useInvoices()
  const config = useConfig()
  const [query, setQuery] = useState('')
  const items = invoices.data ?? []
  const cards = useMemo(() => dashboardStats(stats.data, items), [stats.data, items])
  const overview = useMemo(() => heroOverview(items, stats.data), [items, stats.data])
  const shown = useMemo(() => filterInvoices(items, query), [items, query])
  const feed = useMemo(() => activityFeed(items, 6), [items])
  const donut = useMemo(() => donutSegments(items), [items])
  // One source, one gate (bugs 2 + 4): no count renders until BOTH queries
  // have data — never a 0, never a -1, never a half-loaded card.
  // Fix-back-7 MF-6: a background poll failure is NOT the same as no data.
  // react-query keeps the last good snapshot in cache, so the dashboard
  // renders it with a could-not-refresh note (stale) instead of hiding it
  // behind dashes — the old gate hid kept data, so the dashboard dashed
  // while the home hero kept showing the stale chips. Only a failure with
  // NO data at all (failed) shows the error.
  const loading = !stats.data || !invoices.data
  const hasData = Boolean(stats.data && invoices.data)
  const failed = (stats.isError || invoices.isError) && !hasData
  const stale = (stats.isError || invoices.isError) && hasData
  const tableSlow = useSlowLoad(invoices.isLoading)
  // "Last updated" is the last SUCCESSFUL poll (bug 7): the old line read
  // the server's last verifier run, which does not move when the page
  // polls — so it sat at 01:45 while the watch ran to 01:46. This one
  // advances on every 30 s poll.
  const updatedAt = Math.max(stats.dataUpdatedAt ?? 0, invoices.dataUpdatedAt ?? 0)
  const lastUpdated = updatedAt > 0 ? `${formatUtcTime(new Date(updatedAt).toISOString())} UTC` : null

  const exportCsv = () => {
    const blob = new Blob([invoicesToCsv(shown)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'payonce-invoices.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const statCards = [
    { ...cards.total, testId: 'stat-total' },
    { ...cards.paid, testId: 'stat-paid' },
    { ...cards.unpaid, testId: 'stat-unpaid' },
    { ...cards.refused, testId: 'stat-refused' },
  ]

  return (
    <DashboardShell>
        <Reveal>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-[40px] leading-[1.05] font-medium tracking-[-0.03em] text-ink sm:text-[52px]">Dashboard</h1>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">
                Overview of your payments and invoices ·{' '}
                {lastUpdated ? `Last updated: ${lastUpdated} · refreshing every 30 s` : 'Last updated: loading live numbers…'}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <label className="relative">
                <span className="sr-only">Search invoices</span>
                <Search className="pointer-events-none absolute top-1/2 left-4 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden="true" />
                <input
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search invoices, amounts…"
                  className="min-h-[48px] w-[260px] max-w-full rounded-full border border-line bg-card pr-4 pl-11 text-[15px] text-ink placeholder:text-muted focus-visible:outline-2 focus-visible:outline-brand-600"
                />
              </label>
              <button type="button" onClick={exportCsv} className="btn-ember !min-h-[48px] !px-5 !py-2.5">
                <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
              </button>
            </div>
          </div>
        </Reveal>

        {/* MF-6: a failed background refresh with kept data — the numbers
            below are the last verified snapshot, not fresh. The page keeps
            retrying every 30 s; "Last updated" above is the last success. */}
        {stale ? (
          <p role="status" className="mt-6 rounded-[12px] border border-line bg-card px-4 py-3 text-sm text-body">
            Could not refresh the live numbers just now — showing the last verified numbers
            {lastUpdated ? ` from ${lastUpdated}` : ''}. The page retries every 30 s.
          </p>
        ) : null}

        {/* Stat cards — 4 big glass cards with sparklines. While the live
            numbers load, skeletons — never "0" (the old cards showed four
            0s for 5–8 s). On error with no data, the error — never a zero.
            On a failed background refresh (stale), the kept snapshot keeps
            rendering and the banner above says so. */}
        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
          {statCards.map((c, i) => {
            return (
              <Reveal key={c.label} delay={i * 0.07}>
                <div data-testid={c.testId} className="card-glass p-6 transition-transform duration-200 hover:-translate-y-1">
                  <p className="text-[15px] font-medium text-body">{c.label}</p>
                  <p className="mt-3 text-[44px] leading-none font-medium tracking-[-0.02em] text-ink">
                    {failed ? (
                      <span aria-label="Live numbers unavailable">—</span>
                    ) : loading ? (
                      <Skeleton className="h-[44px] w-[96px]" />
                    ) : (
                      <CountUp value={c.value} />
                    )}
                  </p>
                  <p className="mt-3 text-sm text-muted">
                    {failed ? COPY.statsNoData : loading ? 'Loading live numbers…' : c.sub}
                  </p>
                  <div className="mt-4">
                    {failed ? (
                      <p className="text-sm text-muted">Refresh the page to retry.</p>
                    ) : loading ? (
                      <Skeleton className="h-[40px] w-full" />
                    ) : (
                      <Sparkline values={c.spark} width={180} height={40} />
                    )}
                  </div>
                </div>
              </Reveal>
            )
          })}
        </div>

        {/* Sellers — the marketplace has two distinct sellers plus the demo
            buyer. Live from /api/config: agent token + badge link for each
            seller. Seller 2's payables (id 1, 0.5 CCD; id 2, 10 EUDemo)
            are paid; their receipts re-verify 10/10 and 12/12. */}
        {config.data?.sellers ? (
          <Reveal>
            <section aria-labelledby="dash-sellers-title" className="card-glass mt-8 p-6">
              <h2 id="dash-sellers-title" className="text-[22px] font-medium tracking-[-0.01em] text-ink">
                Sellers
              </h2>
              <p className="mt-2 text-sm text-muted">
                Two distinct sellers on the test registry — each with its own agent token and verified badge. The demo
                buyer pays both.
              </p>
              <ul className="mt-5 space-y-4">
                {config.data.sellers.map((s) => (
                  <li
                    key={s.seller}
                    className="flex flex-wrap items-baseline justify-between gap-3 border-b border-line pb-4 last:border-b-0 last:pb-0"
                  >
                    <div>
                      <p className="text-[15px] font-medium text-ink">{s.label}</p>
                      <p className="mt-1 font-mono text-xs text-muted">{s.seller}</p>
                    </div>
                    <p className="text-sm text-body">
                      Agent token {s.agent_token} ·{' '}
                      <a href={s.badge_url} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                        Badge check — live
                      </a>{' '}
                      ·{' '}
                      <a href={s.agent_card_url} target="_blank" rel="noreferrer" className="font-medium text-brand-700 hover:underline">
                        Agent card
                      </a>
                    </p>
                  </li>
                ))}
              </ul>
            </section>
          </Reveal>
        ) : null}

        {/* Live overview — the paid-once gauge, the payment rails and the
            next dues, all from the same live list as the cards above (one
            source: heroOverview over items + stats). Same loading/error
            gate: skeletons while loading, the error on failure, never a 0. */}
        <div className="mt-8 grid grid-cols-1 gap-6 md:grid-cols-3">
          <Reveal>
            <section aria-labelledby="dash-gauge-title" className="card-glass p-6">
              <h2 id="dash-gauge-title" className="text-[22px] font-medium tracking-[-0.01em] text-ink">
                Paid once
              </h2>
              <p className="mt-2 text-sm text-muted">Share of the listed payables paid once, live.</p>
              <div className="mt-5">
                {failed ? (
                  <p className="text-sm text-muted">{COPY.statsNoData}</p>
                ) : loading ? (
                  <Skeleton className="h-[104px] w-[180px]" />
                ) : (
                  <Gauge pct={overview.paidPct} label={`${overview.paidCount} of ${overview.listed} payables paid once`} />
                )}
              </div>
            </section>
          </Reveal>
          <Reveal delay={0.07}>
            <section aria-labelledby="dash-rails-title" className="card-glass p-6">
              <h2 id="dash-rails-title" className="text-[22px] font-medium tracking-[-0.01em] text-ink">
                Payment rails
              </h2>
              <p className="mt-2 text-sm text-muted">CCD and EUDemo are different test assets — never mixed on one axis.</p>
              {failed ? (
                <p className="mt-5 text-sm text-muted">{COPY.statsNoData}</p>
              ) : loading ? (
                <div className="mt-5 space-y-3">
                  <Skeleton className="h-[44px] w-full" />
                  <Skeleton className="h-[44px] w-full" />
                </div>
              ) : (
                <ul className="mt-5 space-y-4">
                  {overview.rails.map((r) => (
                    <li key={r.rail} className="flex items-baseline justify-between gap-3 border-b border-line pb-3 last:border-b-0 last:pb-0">
                      <div>
                        <p className="text-[15px] font-medium text-ink">{r.label}</p>
                        <p className="mt-1 text-sm text-muted">
                          {r.count} payables · {r.paidCount} paid
                        </p>
                      </div>
                      <p className="shrink-0 text-[15px] font-medium text-ink tabular-nums">
                        {r.total.toFixed(2)} {r.asset}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </Reveal>
          <Reveal delay={0.14}>
            <section aria-labelledby="dash-dues-title" className="card-glass p-6">
              <h2 id="dash-dues-title" className="text-[22px] font-medium tracking-[-0.01em] text-ink">
                Next dues
              </h2>
              <p className="mt-2 text-sm text-muted">The soonest-due unpaid payables, from the live list.</p>
              {failed ? (
                <p className="mt-5 text-sm text-muted">{COPY.statsNoData}</p>
              ) : loading ? (
                <div className="mt-5 space-y-3">
                  <Skeleton className="h-[36px] w-full" />
                  <Skeleton className="h-[36px] w-full" />
                  <Skeleton className="h-[36px] w-full" />
                </div>
              ) : overview.nextDues.length === 0 ? (
                <p className="mt-5 text-sm text-muted">Nothing open right now — every listed payable is paid once.</p>
              ) : (
                <ul className="mt-5 space-y-3">
                  {overview.nextDues.map((d) => (
                    <li key={d.payable_id} className="flex items-baseline justify-between gap-3 text-[15px]">
                      <Link to={`/receipt/${d.payable_id}?seller=${d.seller}`} className="font-medium text-brand-700 hover:underline">
                        Payable {d.payable_id}
                      </Link>
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
          </Reveal>
        </div>

        <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-[2fr_1fr]">
          {/* Live invoice table. */}
          <Reveal>
            <section aria-labelledby="dash-invoices-title" className="card-glass overflow-hidden">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-6 py-5">
                <h2 id="dash-invoices-title" className="text-[22px] font-medium tracking-[-0.01em] text-ink">
                  Live Invoices
                </h2>
                {config.data ? (
                  <a
                    href={`${config.data.explorer.instance}${config.data.registry.index}/${config.data.registry.subindex}`}
                    target="_blank"
                    rel="noreferrer"
                    className="font-mono text-xs text-brand-700"
                  >
                    Registry &lt;{config.data.registry.index},{config.data.registry.subindex}&gt;
                  </a>
                ) : null}
              </div>
              {invoices.isLoading ? (
                <p className="px-6 py-8 text-sm text-muted">
                  Loading invoices from the test registry…
                  {tableSlow ? ' Still loading — the test API is slow right now.' : null}
                </p>
              ) : failed ? (
                <p className="px-6 py-8 text-sm text-muted">{COPY.statsNoData}</p>
              ) : shown.length === 0 ? (
                <p className="px-6 py-8 text-sm text-muted">
                  {query ? `No invoices match “${query}”.` : 'No invoices in this state right now.'}
                </p>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[640px] text-left text-sm">
                    <thead>
                      <tr className="border-b border-line text-xs tracking-[0.06em] text-muted uppercase">
                        <th scope="col" className="px-6 py-3 font-semibold">Invoice</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Seller</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Amount</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Status</th>
                        <th scope="col" className="px-4 py-3 font-semibold">Due</th>
                        <th scope="col" className="px-4 py-3 font-semibold">
                          <span className="sr-only">Receipt</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-line">
                      {shown.map((inv) => (
                        <tr key={`${inv.seller}:${inv.payable_id}`} className="transition-colors hover:bg-paper">
                          <td className="px-6 py-4 font-medium text-ink">Payable {inv.payable_id}</td>
                          <td className="px-4 py-4 text-body">{sellerShort(inv.seller, config.data?.sellers)}</td>
                          <td className="px-4 py-4 text-body tabular-nums">{inv.amount_display}</td>
                          <td className="px-4 py-4">
                            <InvoiceStatusPill status={derivedStatus(inv)} />
                          </td>
                          <td className="px-4 py-4 text-muted">{formatUtcDateTime(inv.due)}</td>
                          <td className="px-4 py-4 text-right">
                            {derivedStatus(inv) !== 'paid' ? (
                              <Link
                                to={`/dashboard/pay?tab=pay&payable=${inv.payable_id}&seller=${inv.seller}`}
                                className="mr-3 inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
                              >
                                Pay <ArrowRight className="h-4 w-4" aria-hidden="true" />
                              </Link>
                            ) : null}
                            <Link
                              to={`/receipt/${inv.payable_id}?seller=${inv.seller}`}
                              className="inline-flex items-center gap-1 font-medium text-brand-700 hover:underline"
                            >
                              View <ArrowRight className="h-4 w-4" aria-hidden="true" />
                            </Link>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="border-t border-line px-6 py-4 text-sm text-muted">
                Showing {shown.length} of {items.length} invoices · Live from the test registry
              </p>
            </section>
          </Reveal>

          <div className="space-y-6">
            {/* Live activity feed. */}
            <Reveal delay={0.1}>
              <section aria-labelledby="dash-activity-title" className="card-glass p-6">
                <div className="flex items-center justify-between gap-3">
                  <h2 id="dash-activity-title" className="text-[22px] font-medium tracking-[-0.01em] text-ink">
                    Live Activity Feed
                  </h2>
                  {/* One badge, and it explains itself (bug 7): the old page
                      flipped between "LIVE" and "LAST VERIFIED · refresh
                      paused" with no reason given. Live means the 30 s poll
                      is answering; Paused means it is not, and the page
                      keeps retrying. */}
                  {/* MF-6: the badge is Paused on a failed refresh even
                      when kept data is on screen — Live means the 30 s
                      poll is answering. */}
                  {failed || stale ? (
                    <span
                      className="inline-flex items-center gap-2 text-sm font-medium text-refused-fg"
                      title="Paused — the test API did not answer; the page retries every 30 s."
                    >
                      <span className="h-2 w-2 rounded-full bg-refused-solid" aria-hidden="true" /> Paused
                    </span>
                  ) : loading ? (
                    <span className="inline-flex items-center gap-2 text-sm font-medium text-muted">Loading…</span>
                  ) : (
                    <span
                      className="inline-flex items-center gap-2 text-sm font-medium text-verified-fg"
                      title="Live — refreshing every 30 s from the test registry."
                    >
                      <span className="animate-live-dot h-2 w-2 rounded-full bg-verified" aria-hidden="true" /> Live
                    </span>
                  )}
                </div>
                {/* FIX-4 sibling (fix-back-2): the feed used to assert
                    "No activity yet" whenever it was empty — including
                    during the 5–8 s load and on API error, while the badge
                    directly above said "Loading…" / "Paused". Same gate as
                    the stat cards / gauge / rails / dues: skeleton while
                    loading, the error on failure, "No activity yet" only
                    when loaded and truly empty. */}
                {failed ? (
                  <p className="mt-5 text-sm text-muted">{COPY.statsNoData}</p>
                ) : loading ? (
                  <div className="mt-5 space-y-3">
                    <Skeleton className="h-[36px] w-full" />
                    <Skeleton className="h-[36px] w-full" />
                    <Skeleton className="h-[36px] w-full" />
                  </div>
                ) : feed.length === 0 ? (
                  <p className="mt-5 text-sm text-muted">No activity yet — pay an invoice and it appears here.</p>
                ) : (
                  <ul className="mt-5 space-y-5">
                    {feed.map((f) => (
                      <li key={f.payable_id} className="flex items-start gap-3">
                        <span
                          className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${
                            f.tone === 'paid' ? 'bg-verified' : f.tone === 'overdue' ? 'bg-refused-solid' : 'bg-brand-600'
                          }`}
                          aria-hidden="true"
                        />
                        <div className="min-w-0">
                          <p className="text-[15px] leading-snug font-medium text-ink">{f.title}</p>
                          <p className="mt-1 text-sm text-muted">{f.detail}</p>
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
                <p className="mt-5 text-xs text-muted">Paid first, newest payable first — then the soonest-due open invoices.</p>
              </section>
            </Reveal>

            {/* Payment split donut. */}
            <Reveal delay={0.15}>
              <section aria-labelledby="dash-donut-title" className="card-glass p-6">
                <h2 id="dash-donut-title" className="text-[22px] font-medium tracking-[-0.01em] text-ink">
                  Payment Split
                </h2>
                <p className="mt-2 text-sm text-muted">Paid once vs unpaid, from the live invoice list.</p>
                <div className="mt-5">
                  {/* FIX-4 sibling (fix-back-2): the donut used to render
                      ungated, so during load and on error it showed a big
                      "0 payables" centre number, "Paid once · 0" /
                      "Unpaid · 0" and aria-label "No payables yet" — a
                      false zero. Same gate as the gauge: skeleton while
                      loading, the error on failure, the donut only once
                      the live list is in. */}
                  {failed ? (
                    <p className="text-sm text-muted">{COPY.statsNoData}</p>
                  ) : loading ? (
                    <Skeleton className="h-[180px] w-[180px] rounded-full" />
                  ) : (
                    <Donut segments={donut} />
                  )}
                </div>
              </section>
            </Reveal>
          </div>
        </div>

    </DashboardShell>
  )
}
