// HeroDemo — the SMALL demo glimpse in the hero card (fix-back-6 B6).
// User order 2026-11-25 03:40: the hero gets ONLY a small demo dashboard,
// a glimpse, like the Altura video (huge headline on the orange sky + a
// small dashboard card, ~60% viewport width, on clouds fading to cream).
// This is a static glimpse — stat chips + a 3-row invoice table + a link
// to the real dashboard. No walkthrough, no checks, no pay button, no
// progress bar, no receipt box, no virtual cursor, no auto-play loop.
// HONESTY: the chips and the table are LIVE data (the same unified
// snapshot as the dashboard). The panel is labelled "Demo" (user order
// 2026-11-24 21:49: the word is "Demo", never "Simulation"), the footer
// discloses that the numbers are live, and the demo makes ZERO network
// calls: no fetch, no pay POST, no chain call — it only renders props.
// Loading: the skeleton holds the same slots (chips + 3 rows) so the card
// holds its height while the live list loads and the flow section below
// does not jump (bug 1: an anchor scroll to #invoice landed short because
// the card grew under it).
import { Link } from 'react-router-dom'
import { InvoiceStatusPill, Skeleton } from './polish'
import { derivedStatus } from '../lib/dashboard'
import { refusedCaption } from '../lib/copy'
import type { InvoiceItem, Stats } from '../lib/types'
import { demoStatChips, demoTableRows } from '../lib/heroDemo'

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
  const chips = demoStatChips(items, stats)
  const rows = demoTableRows(items)
  // Fix-back-7 MF-7: an error with no data is an error, not an endless
  // loading skeleton — the hero used to show "still loading" forever on
  // a first-load failure. An error WITH data (a failed background
  // refresh) still renders the kept chips and table.
  const loading = items.length === 0 && stats === undefined && !error
  const loadFailed = error && items.length === 0 && stats === undefined
  // Fix-back-8 MF-4: an error WITH kept data used to render the chips and
  // table labelled "Live totals" with NO staleness disclosure — while the
  // dashboard showed its could-not-refresh banner for the same failure.
  // The pages disagreed about whether the numbers were fresh. The hero
  // now renders the same note as the dashboard banner when it shows kept
  // data after a failed refresh.
  const stale = error && !loadFailed && !loading

  return (
    <div className="px-4 py-5 sm:px-5">
      <div className="rounded-[12px] border border-dashed border-brand-600/50 bg-card p-4 sm:p-5">
        {/* Header — the demo dashboard's title, with the Demo badge. */}
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="flex flex-wrap items-center gap-2 text-[18px] font-medium text-ink">
              Dashboard
              <span className="rounded-full bg-brand-600 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                Demo
              </span>
            </h3>
            <p className="mt-1 text-[13px] leading-relaxed text-muted">
              A glimpse of the real dashboard. No real payment.
            </p>
          </div>
          <Link to="/dashboard" className="shrink-0 text-[13px] font-medium text-brand-700 hover:underline">
            View the real dashboard →
          </Link>
        </div>

        {loadFailed ? (
          <div role="alert">
            <p className="mt-5 text-sm text-muted">
              Could not load the live numbers — the test API did not answer. Try refreshing the page.
            </p>
          </div>
        ) : loading ? (
          <div role="status">
            <p className="mt-5 text-sm text-muted">Demo unavailable — the live invoice list is still loading.</p>
            <div className="mt-4 flex flex-wrap gap-2" aria-hidden="true">
              {[0, 1, 2, 3].map((i) => (
                <Skeleton key={i} className="h-[28px] w-[90px] !rounded-full" />
              ))}
            </div>
            <div className="mt-5" aria-hidden="true">
              <Skeleton className="h-[20px] w-[120px]" />
              <div className="mt-2 divide-y divide-line overflow-hidden rounded-[8px] border border-line bg-card">
                {[0, 1, 2].map((i) => (
                  <div key={i} className="px-3 py-2">
                    <Skeleton className="h-[24px] w-full" />
                  </div>
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
              <p role="status" className="mt-4 rounded-[8px] border border-line bg-paper px-3 py-2 text-xs leading-relaxed text-body">
                Could not refresh the live numbers just now — showing the last verified numbers
                {lastUpdated ? ` from ${lastUpdated}` : ''}. The page retries every 30 s.
              </p>
            ) : null}
            {lastUpdated && !stale ? (
              <p className="mt-4 text-xs text-muted">Last updated: {lastUpdated} · refreshing every 30 s</p>
            ) : null}
            {/* Stat chips — mirror the real dashboard's 4 stat cards. */}
            <ul className="mt-4 flex flex-wrap gap-2" aria-label="Live totals">
              {chips.map((c) => (
                <li
                  key={c.label}
                  className="rounded-full border border-line bg-paper px-3 py-1.5 text-xs text-body tabular-nums"
                >
                  {c.label} <span className="font-semibold text-ink">{c.value ?? '—'}</span>
                </li>
              ))}
            </ul>
            {/* N1 caption, always visible under the chips: the one refused
                number and what it counts (same refusedCaption() as the
                dashboard refused card). */}
            <p className="mt-2 text-xs text-muted">{refusedCaption(stats?.refused_on_chain_since_deploy)}</p>

            {/* Mini invoice table — mirrors "Live Invoices": the 3
                soonest-due unpaid payables. */}
            <div className="mt-5">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <h4 className="text-[15px] font-medium text-ink">Live Invoices</h4>
                <p className="text-xs text-muted">
                  Showing {rows.length} of {items.length} invoices · Live from the test registry
                </p>
              </div>
              <ul className="mt-2 divide-y divide-line overflow-hidden rounded-[8px] border border-line bg-card">
                {rows.map((inv) => (
                  <li
                    key={inv.payable_id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-3 py-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center"
                  >
                    <span className="min-w-0 truncate text-[13px] font-medium text-ink">
                      Payable {inv.payable_id}
                    </span>
                    <span className="text-[13px] text-body tabular-nums">{inv.amount_display}</span>
                    <span>
                      <InvoiceStatusPill status={derivedStatus(inv)} />
                    </span>
                    <span className="text-xs text-muted">{inv.due.slice(0, 10)}</span>
                  </li>
                ))}
              </ul>
            </div>

            <p className="mt-4 text-[11px] leading-relaxed text-muted">
              Demo — the table and chips above show live numbers from the test registry. Open the real
              dashboard to pick, check and pay — nothing here pays anything.
            </p>
          </>
        )}
      </div>
    </div>
  )
}
