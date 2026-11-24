// DashboardPreview — P3 §4 region B + design §3.
// The app's live mirror: tabs filter the real payables list; the gauge is the
// paid share from /api/stats; the fees chart is the recorded run (P3 §14,
// labelled); the refused tab lists the 7 recorded on-chain refusals (P3 §9).
// Every number is either live from the API or labelled "Recorded run".
import { useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import { Link } from 'react-router-dom'
import { useConfig, useInvoices, useReceipt, useStats } from '../hooks/useApi'
import { COPY } from '../lib/copy'
import { FEE_HEADLINE, RECORDED_DATE, RECORDED_FEES, RECORDED_REFUSALS } from '../lib/recorded'
import { formatDueIn, truncHash } from '../lib/format'
import { EXPLORER_TX } from '../lib/tokens'
import type { InvoiceItem } from '../lib/types'

type Tab = 'all' | 'unpaid' | 'paid' | 'refused'

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'unpaid', label: 'Unpaid' },
  { id: 'paid', label: 'Paid' },
  { id: 'refused', label: 'Refused' },
]

function StatusChip({ status }: { status: InvoiceItem['status'] }) {
  if (status === 'paid')
    return (
      <span className="rounded-full bg-verified-bg px-2 py-0.5 text-[11px] font-semibold text-verified-fg">Paid</span>
    )
  return (
    <span className="rounded-full bg-unpaid-bg px-2 py-0.5 text-[11px] font-semibold text-unpaid-fg">Unpaid</span>
  )
}

/** Half-donut gauge: paid share of all payables, from /api/stats. */
function PaidGauge({ paid, total }: { paid: number; total: number }) {
  const pct = total === 0 ? 0 : Math.round((paid / total) * 100)
  return (
    <div className="flex items-center gap-4">
      <svg width="120" height="66" viewBox="0 0 120 66" role="img" aria-label={`${paid} of ${total} payables paid (${pct} percent)`}>
        <path d="M 10 60 A 50 50 0 0 1 110 60" fill="none" stroke="#E7DDCB" strokeWidth="10" strokeLinecap="round" />
        <path
          d="M 10 60 A 50 50 0 0 1 110 60"
          fill="none"
          stroke="#B4430F"
          strokeWidth="10"
          strokeLinecap="round"
          strokeDasharray={`${pct} 100`}
          pathLength={100}
        />
      </svg>
      <div>
        <p className="text-[28px] leading-none font-normal tracking-[-0.02em] text-ink tabular-nums">{pct}%</p>
        <p className="mt-1 text-xs text-muted">
          {paid} of {total} paid once
        </p>
      </div>
    </div>
  )
}

/** Fees by step — recorded run (P3 §14), labelled. Ranges render as range bars. */
function FeesChart() {
  const max = Math.max(...RECORDED_FEES.filter((f) => f.state === 'measured').map((f) => f.max ?? f.min))
  return (
    <div>
      <p className="text-[11px] font-semibold tracking-[0.08em] text-muted uppercase">
        Fees by step · testnet CCD · Recorded run, {RECORDED_DATE}
      </p>
      <div className="mt-3 space-y-2.5">
        {RECORDED_FEES.map((f) => (
          <div key={`${f.step}-${f.note}`} className="flex items-center gap-3">
            <span className="w-[104px] shrink-0 text-right text-xs text-body">
              {f.step} <span className="text-muted">· {f.note}</span>
            </span>
            <div className="relative h-4 flex-1 bg-paper-2">
              {f.state === 'measured' && f.max ? (
                <div
                  className="absolute inset-y-0 rounded-[2px] bg-brand-600"
                  style={{ left: `${(f.min / max) * 100}%`, width: `${((f.max - f.min) / max) * 100}%` }}
                />
              ) : null}
              {f.state === 'measured' && !f.max ? (
                <div
                  className="absolute inset-y-0 left-0 rounded-[2px] bg-brand-600"
                  style={{ width: `${(f.min / max) * 100}%` }}
                />
              ) : null}
              {f.state === 'not_measured' ? (
                <span className="absolute inset-y-0 left-0 flex items-center pl-2 text-[11px] text-muted">
                  not measured — no bar, never a number
                </span>
              ) : null}
            </div>
            <span className="w-[76px] shrink-0 text-xs font-medium text-ink tabular-nums">
              {f.state === 'measured' ? (f.max ? `${f.min}–${f.max}` : `${f.min}`) : '—'}
            </span>
          </div>
        ))}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-muted">{FEE_HEADLINE}</p>
    </div>
  )
}

export function DashboardPreview() {
  const invoices = useInvoices()
  const stats = useStats()
  const config = useConfig()
  const [tab, setTab] = useState<Tab>('all')
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
  const paid = items.filter((i) => i.status === 'paid')
  const unpaid = items.filter((i) => i.status !== 'paid')
  const latestPaid = paid[0]
  const receipt = useReceipt(latestPaid ? latestPaid.payable_id : null)
  const nextDue = [...unpaid].sort((a, b) => a.due.localeCompare(b.due))[0] ?? null

  const shown: InvoiceItem[] = tab === 'all' ? items : tab === 'unpaid' ? unpaid : tab === 'paid' ? paid : []

  return (
    <div className="overflow-hidden rounded-[10px] border border-line bg-card text-left shadow-[0_30px_80px_rgba(11,31,36,0.35)]">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-5 py-3">
        <div className="flex items-center gap-3">
          <p className="text-[15px] font-medium text-ink">Invoices</p>
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
        <p className="text-xs text-muted">
          {stats.data
            ? `${stats.data.paid_total} paid · ${unpaid.length} unpaid · ${stats.data.refused_on_chain_since_deploy} refused on chain`
            : 'Loading live numbers…'}
        </p>
      </div>

      <div
        className="flex flex-wrap items-center gap-1 border-b border-line px-5 py-2"
        role="tablist"
        aria-label="Invoice filter"
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
            {t.id === 'unpaid' ? ` (${unpaid.length})` : ''}
            {t.id === 'paid' ? ` (${paid.length})` : ''}
            {t.id === 'refused' ? ` (${RECORDED_REFUSALS.length})` : ''}
          </button>
        ))}
        <span className="ml-auto text-xs text-muted">
          {tab === 'refused' ? `Recorded run, ${RECORDED_DATE}` : 'Live from the test registry'}
        </span>
      </div>

      {tab === 'refused' ? (
        <ul className="divide-y divide-line">
          {RECORDED_REFUSALS.map((r) => (
            <li key={r.txHash} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
              <span className="rounded-full bg-refused-bg px-2 py-0.5 text-[11px] font-semibold text-refused-fg">
                {r.code} · {r.name}
              </span>
              <span className="min-w-0 flex-1 text-sm text-body">{r.plain}</span>
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
      ) : (
        <ul className="divide-y divide-line">
          {invoices.isLoading ? (
            <li className="px-5 py-4 text-sm text-muted">Loading invoices from the test registry…</li>
          ) : invoices.isError ? (
            <li className="px-5 py-4 text-sm text-muted">{COPY.statsNoData}</li>
          ) : shown.length === 0 ? (
            <li className="px-5 py-4 text-sm text-muted">No invoices in this state right now.</li>
          ) : (
            shown.map((inv) => (
              <li key={inv.payable_id} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 py-3">
                <span className="w-28 shrink-0 text-sm font-medium text-ink">Payable {inv.payable_id}</span>
                <span className="text-sm text-body">{inv.amount_display}</span>
                <StatusChip status={inv.status} />
                <span className="text-xs text-muted">
                  {inv.status === 'paid' ? 'Paid once' : `Due ${formatDueIn(inv.due)}`}
                </span>
                <Link to={`/receipt/${inv.payable_id}`} className="ml-auto inline-flex items-center gap-1 text-sm font-medium text-brand-700">
                  Receipt <ArrowRight className="h-4 w-4" aria-hidden="true" />
                </Link>
              </li>
            ))
          )}
        </ul>
      )}

      <div className="grid gap-6 border-t border-line bg-paper px-5 py-4 sm:grid-cols-2">
        <div>
          <PaidGauge paid={stats.data?.paid_total ?? paid.length} total={stats.data?.payables_total ?? items.length} />
          <p className="mt-3 text-xs text-muted">
            Verifier:{' '}
            {receipt.data?.verifier
              ? `${receipt.data.verifier.passed}/${receipt.data.verifier.total} checks passed (payable ${latestPaid?.payable_id}, ${receipt.data.verifier.checked_at.slice(0, 10)})`
              : 'latest receipt verifier loads with the paid list.'}
          </p>
          {nextDue ? (
            <p className="mt-1 text-xs text-muted">
              Next due: payable {nextDue.payable_id} · {nextDue.amount_display} · {formatDueIn(nextDue.due)}
            </p>
          ) : null}
        </div>
        <FeesChart />
      </div>
    </div>
  )
}
