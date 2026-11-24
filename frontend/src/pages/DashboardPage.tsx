// Dashboard (design v2) — a separate route, same sunset palette, all live
// data. Sidebar nav, 4 glass stat cards with sparklines (sequences derived
// from the live registry, in payable-id order), a searchable live invoice
// table with status pills, a live activity feed (real due dates / amounts —
// no invented timestamps), and a paid/unpaid donut from the live list.
// No invented percentages, no mock users, no fake activity.
import { useMemo, useState } from 'react'
import { Link, NavLink } from 'react-router-dom'
import { ArrowRight, Download, LayoutDashboard, Receipt, Scale, Search, Wallet } from 'lucide-react'
import { useConfig, useInvoices, useStats } from '../hooks/useApi'
import { COPY } from '../lib/copy'
import { activityFeed, dashboardStats, derivedStatus, donutSegments, filterInvoices, invoicesToCsv } from '../lib/dashboard'
import { formatUtcDateTime } from '../lib/format'
import { CountUp, Donut, InvoiceStatusPill, Reveal, Sparkline } from '../components/polish'

const NAV = [
  { to: '/dashboard', label: 'Dashboard', icon: LayoutDashboard, end: true },
  { to: '/#invoice', label: 'Pay an invoice', icon: Wallet, end: false },
  { to: '/#console', label: 'Live console', icon: Scale, end: false },
  { to: '/judges', label: 'For judges', icon: Receipt, end: false },
]

function Sidebar() {
  return (
    <aside className="shrink-0 bg-gradient-to-b from-sky-0 via-sky-1 to-sky-2 text-white lg:min-h-screen lg:w-[260px]">
      <div className="flex items-center gap-3 px-5 pt-5 pb-6 lg:px-6 lg:pt-8">
        <Link to="/" className="flex items-center gap-2.5" aria-label="PayOnce home">
          <img src="/assets/payonce-mark.webp" alt="" width={32} height={32} className="h-8 w-8 rounded-[4px]" />
          <span className="text-[18px] font-medium tracking-[-0.01em]">PayOnce</span>
        </Link>
        <span className="rounded-full border border-white/40 bg-white/15 px-2 py-0.5 text-[11px] font-semibold tracking-[0.08em]">
          {COPY.testnetBadge}
        </span>
      </div>
      <nav aria-label="Dashboard" className="flex gap-2 overflow-x-auto px-4 pb-4 lg:flex-col lg:gap-1.5 lg:overflow-visible lg:px-4 lg:pb-0">
        {NAV.map((n) => (
          <NavLink
            key={n.to}
            to={n.to}
            end={n.end}
            className={({ isActive }) =>
              `flex shrink-0 items-center gap-3 rounded-full px-4 py-2.5 text-[15px] font-medium whitespace-nowrap transition-colors ${
                isActive ? 'bg-white/20 text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.35)]' : 'text-white/85 hover:bg-white/10 hover:text-white'
              }`
            }
          >
            <n.icon className="h-5 w-5" aria-hidden="true" />
            {n.label}
          </NavLink>
        ))}
      </nav>
      <p className="hidden px-6 pt-8 pb-6 text-xs leading-relaxed text-white/70 lg:block">
        Testnet · Concordium
        <br />
        Every number on this page is live from the test registry.
      </p>
    </aside>
  )
}

export function DashboardPage() {
  const stats = useStats()
  const invoices = useInvoices()
  const config = useConfig()
  const [query, setQuery] = useState('')
  const items = invoices.data ?? []
  const cards = useMemo(() => dashboardStats(stats.data, items), [stats.data, items])
  const shown = useMemo(() => filterInvoices(items, query), [items, query])
  const feed = useMemo(() => activityFeed(items, 6), [items])
  const donut = useMemo(() => donutSegments(items), [items])
  const lastUpdated = stats.data?.last_verifier_run_at
    ? formatUtcDateTime(stats.data.last_verifier_run_at)
    : null

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
    <div className="min-h-screen bg-paper lg:flex">
      <Sidebar />
      <main id="main" className="min-w-0 flex-1 px-4 py-8 sm:px-8 sm:py-10">
        <Reveal>
          <div className="flex flex-wrap items-end justify-between gap-4">
            <div>
              <h1 className="text-[40px] leading-[1.05] font-medium tracking-[-0.03em] text-ink sm:text-[52px]">Dashboard</h1>
              <p className="mt-3 text-[15px] leading-relaxed text-muted">
                Overview of your payments and invoices ·{' '}
                {lastUpdated ? `Last updated: ${lastUpdated}` : 'Last updated: loading live numbers…'}
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

        {/* Stat cards — 4 big glass cards with sparklines. */}
        <div className="mt-8 grid grid-cols-1 gap-6 sm:grid-cols-2 xl:grid-cols-4">
          {statCards.map((c, i) => (
            <Reveal key={c.label} delay={i * 0.07}>
              <div data-testid={c.testId} className="card-glass p-6 transition-transform duration-200 hover:-translate-y-1">
                <p className="text-[15px] font-medium text-body">{c.label}</p>
                <p className="mt-3 text-[44px] leading-none font-medium tracking-[-0.02em] text-ink">
                  <CountUp value={c.value} />
                </p>
                <p className="mt-3 text-sm text-muted">{c.sub}</p>
                <div className="mt-4">
                  <Sparkline values={c.spark} width={180} height={40} />
                </div>
              </div>
            </Reveal>
          ))}
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
                <p className="px-6 py-8 text-sm text-muted">Loading invoices from the test registry…</p>
              ) : invoices.isError ? (
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
                        <tr key={inv.payable_id} className="transition-colors hover:bg-paper">
                          <td className="px-6 py-4 font-medium text-ink">Payable {inv.payable_id}</td>
                          <td className="px-4 py-4 text-body tabular-nums">{inv.amount_display}</td>
                          <td className="px-4 py-4">
                            <InvoiceStatusPill status={derivedStatus(inv)} />
                          </td>
                          <td className="px-4 py-4 text-muted">{formatUtcDateTime(inv.due)}</td>
                          <td className="px-4 py-4 text-right">
                            <Link
                              to={`/receipt/${inv.payable_id}`}
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
                  <span className="inline-flex items-center gap-2 text-sm font-medium text-verified-fg">
                    <span className="animate-live-dot h-2 w-2 rounded-full bg-verified" aria-hidden="true" /> Live
                  </span>
                </div>
                {feed.length === 0 ? (
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
                  <Donut segments={donut} />
                </div>
              </section>
            </Reveal>
          </div>
        </div>

        <p className="mt-8 text-sm text-muted">
          <Link to="/" className="font-medium text-brand-700">
            ← Back to the payment flow
          </Link>{' '}
          · <Link to="/judges" className="font-medium text-brand-700">For judges →</Link>
        </p>
      </main>
    </div>
  )
}
