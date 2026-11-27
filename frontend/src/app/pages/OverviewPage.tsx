// Overview: where the app opens. StartHere, four equal stat cards, a short
// invoice list and the sellers. Live numbers carry a LIVE tag; when the API
// cannot be read the page falls back to the recorded snapshot and says so.
import { useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { useConfig } from '../../hooks/useApi'
import { overdueItems, paidItems, readyToPay } from '../../lib/dashboard'
import { InvoiceList } from '../InvoiceList'
import { StartHere } from '../StartHere'
import { useAppData, useDocumentTitle, useSellers, type DataSource } from '../hooks'
import { formatDay, recordedLabel } from '../fees'
import { clockUtc } from '../format'
import { sellerName } from '../keys'
import { Address } from '../Address'
import { Button, ButtonLink, ButtonRow, Card, EmptyState, Notice, PageHeader, Skeleton, SourceTag, StatusPill } from '../ui'
import { useBadgeStatus } from '../badge'

function StatCard({
  label,
  value,
  sub,
  loading,
  source,
  asOf,
  tag,
}: {
  /** Overrides the page-level source for this one figure (its own honesty tag). */
  tag?: DataSource
  label: string
  value: number | undefined
  sub: string
  loading: boolean
  source: DataSource
  asOf: string | null
}) {
  return (
    <div className="po-card flex h-full min-h-[172px] flex-col p-5" data-testid="stat-card">
      <div className="flex items-start justify-between gap-3">
        <p className="text-[15px] font-semibold text-po-ink">{label}</p>
        <SourceTag source={tag ?? source} asOf={asOf} />
      </div>
      <div className="mt-4">
        <p className="po-num text-[52px] leading-none font-semibold tracking-[-0.03em] text-po-ink">
          {loading || value === undefined ? <Skeleton className="h-[44px] w-[88px]" /> : value}
        </p>
      </div>
      <div className="mt-auto pt-4 text-sm leading-snug text-po-grey">{loading ? <Skeleton className="h-4 w-40" /> : sub}</div>
    </div>
  )
}

export function OverviewPage() {
  useDocumentTitle('Overview - PayOnce')
  const data = useAppData()
  const dir = useSellers()
  const config = useConfig()
  const loading = data.source === 'loading'
  const { items, stats } = data

  const [tab, setTab] = useState<'ready' | 'overdue' | 'paid'>('ready')
  const view = useMemo(() => {
    const ready = readyToPay(items)
    const overdue = overdueItems(items)
    const paidList = paidItems(items)
    const open = items.filter((i) => i.status !== 'paid')
    const byDue = [...open].sort((a, b) => a.due.localeCompare(b.due))
    return { paid: paidList.length, open: open.length, ready, overdueList: overdue, paidList, nextDue: ready[0] ?? byDue[0], overdue: overdue.length }
  }, [items])
  const TABS = [
    { id: 'ready' as const, label: 'Ready to pay', rows: view.ready },
    { id: 'overdue' as const, label: 'Overdue', rows: view.overdueList },
    { id: 'paid' as const, label: 'Paid', rows: view.paidList },
  ]
  const activeTab = TABS.find((t) => t.id === tab) ?? TABS[0]
  const preview = activeTab.rows.slice(0, 6)

  // The refusal count is not a chain counter (reverts leave no chain state): it
  // is recorded evidence plus this API's own log. The API says so in
  // stats.sources; with no statement we show RECORDED, never LIVE.
  const refusedKind = stats?.sources?.refused_on_chain_since_deploy?.kind
  const refusedTag: DataSource | undefined = loading ? undefined : refusedKind === 'live' ? 'live' : 'recorded'
  const voided = stats?.voided_total ?? 0
  const reserved = stats?.reserved_total ?? 0
  const lastRun = stats?.last_verifier_run_at

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Overview"
        lead="Every invoice here can be paid once, and only to the account the seller put on chain. Testnet only."
        actions={
          <>
            <SourceTag source={data.source} asOf={data.asOf} />
            <span className="text-sm text-po-grey">
              {data.source === 'live' && data.asOf
                ? `Updated ${clockUtc(data.asOf)}, refreshes every 30 s`
                : data.source === 'recorded'
                  ? recordedLabel(data.asOf)
                  : 'Reading the testnet'}
            </span>
          </>
        }
      />

      {data.source === 'recorded' ? (
        <Notice
          tone="warn"
          action={
            <Button small onClick={data.refetch}>
              <RefreshCw className="h-4 w-4" aria-hidden="true" /> Try again
            </Button>
          }
        >
          The live API did not answer, so these numbers are the recorded snapshot from {formatDay(data.asOf ?? '')}. They are
          not live.
        </Notice>
      ) : null}
      {data.stale ? (
        <Notice tone="warn">
          Could not refresh just now. Showing the last numbers read in this visit. The page retries every 30 s.
        </Notice>
      ) : null}
      {loading && data.slow ? <Notice>The testnet API is slow right now. Still reading.</Notice> : null}

      <StartHere items={items} />

      <section aria-label="Numbers" className="grid grid-cols-1 items-stretch gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard
          label="Payables listed"
          value={items.length}
          loading={loading}
          source={data.source}
          asOf={data.asOf}
          sub={
            voided + reserved > 0
              ? `${voided} voided and ${reserved} reserved are on chain but not listed`
              : 'All read from the test registry'
          }
        />
        <StatCard
          label="Paid once"
          value={view.paid}
          loading={loading}
          source={data.source}
          asOf={data.asOf}
          sub={`${view.paid} of ${items.length} payables are paid`}
        />
        <StatCard
          label="Open"
          value={view.open}
          loading={loading}
          source={data.source}
          asOf={data.asOf}
          sub={
            view.nextDue
              ? `Next due: payable ${view.nextDue.payable_id}, ${formatDay(view.nextDue.due)}${view.overdue > 0 ? `. ${view.overdue} overdue.` : ''}`
              : 'Nothing open right now'
          }
        />
        <StatCard
          label="Refused on chain"
          value={stats?.refused_on_chain_since_deploy}
          loading={loading}
          source={data.source}
          tag={refusedTag}
          asOf={data.asOf}
          sub={
            lastRun
              ? `Counted by the API since its last deploy. Last verifier run ${formatDay(lastRun)}.`
              : 'Counted by the API since its last deploy.'
          }
        />
      </section>

      <section aria-labelledby="inv-title" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <h2 id="inv-title" className="text-2xl font-medium tracking-[-0.01em] text-po-ink">
            Invoices
          </h2>
          <Link
            to="/app/invoices"
            className="inline-flex min-h-[44px] items-center font-medium text-po-accent-ink underline decoration-po-line-strong"
          >
            Open all invoices
          </Link>
        </div>
        {loading ? (
          <div className="po-card flex flex-col gap-4 p-5" aria-label="Loading invoices">
            {[0, 1, 2, 3].map((n) => (
              <Skeleton key={n} className="h-8 w-full" />
            ))}
          </div>
        ) : (
          <>
            <div role="tablist" aria-label="Invoice groups" className="po-btn-row">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  id={`tab-${t.id}`}
                  aria-selected={t.id === activeTab.id}
                  aria-controls="inv-panel"
                  onClick={() => setTab(t.id)}
                  className={`po-btn po-btn-sm ${t.id === activeTab.id ? 'po-btn-ink' : 'po-btn-secondary'}`}
                >
                  {t.label}
                  <span className="po-num opacity-80">{t.rows.length}</span>
                </button>
              ))}
            </div>
            <div id="inv-panel" role="tabpanel" aria-labelledby={`tab-${activeTab.id}`}>
              {preview.length === 0 ? (
                <EmptyState
                  title={activeTab.id === 'ready' ? 'Nothing is ready to pay right now' : `No ${activeTab.label.toLowerCase()} invoices`}
                  action={
                    <ButtonLink to="/app/pay" variant="primary">
                      Register a test invoice
                    </ButtonLink>
                  }
                >
                  {activeTab.id === 'ready'
                    ? 'Every open invoice is past due or already paid. Register a new one on the testnet to pay it.'
                    : 'Nothing in this group on the registry.'}
                </EmptyState>
              ) : (
                <InvoiceList items={preview} sellers={dir.sellers} />
              )}
              {activeTab.rows.length > preview.length ? (
                <p className="mt-3 text-sm text-po-grey">
                  Showing {preview.length} of {activeTab.rows.length}. Open all invoices to filter and page through the rest.
                </p>
              ) : null}
            </div>
          </>
        )}
      </section>

      <section aria-labelledby="sellers-title" className="flex flex-col gap-4">
        <h2 id="sellers-title" className="text-2xl font-medium tracking-[-0.01em] text-po-ink">
          Sellers
        </h2>
        {config.isError ? (
          <Notice tone="warn">The seller list could not be loaded from the API.</Notice>
        ) : !config.data?.sellers ? (
          <div className="grid gap-4 md:grid-cols-2">
            <Skeleton className="h-[148px] w-full" />
            <Skeleton className="h-[148px] w-full" />
          </div>
        ) : (
          <ul className="grid items-stretch gap-4 md:grid-cols-2">
            {config.data.sellers.map((s) => {
              const mine = items.filter((i) => i.seller === s.seller)
              return (
                <li key={s.seller} className="h-full">
                  <SellerCard
                    seller={s}
                    name={sellerName(s.seller, dir.sellers)}
                    loading={loading}
                    listed={mine.length}
                    paid={mine.filter((i) => i.status === 'paid').length}
                  />
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}

type ConfigSeller = NonNullable<NonNullable<ReturnType<typeof useConfig>['data']>['sellers']>[number]

function SellerCard({
  seller,
  name,
  loading,
  listed,
  paid,
}: {
  seller: ConfigSeller
  name: string
  loading: boolean
  listed: number
  paid: number
}) {
  const badge = useBadgeStatus(seller.badge_url)
  return (
    <Card as="div" className="flex h-full flex-col gap-4" data-testid="seller-card">
      <div className="flex flex-wrap items-start justify-between gap-x-3 gap-y-2">
        <h3 className="text-xl font-semibold tracking-[-0.01em] text-po-ink">{name}</h3>
        {badge.state === 'loading' ? (
          <span className="po-chip po-chip-neutral">Checking badge</span>
        ) : badge.state === 'active' ? (
          <StatusPill tone="ok">Agent badge active</StatusPill>
        ) : badge.state === 'inactive' ? (
          <StatusPill tone="bad">Badge {badge.status}</StatusPill>
        ) : (
          <StatusPill tone="warn">Badge check unavailable</StatusPill>
        )}
      </div>
      <dl className="grid gap-3 text-[15px]">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-po-grey">Account</dt>
          <dd className="min-w-0">
            <Address value={seller.seller} kind="account" label={`${name} account address`} expandable />
          </dd>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-po-grey">Agent token</dt>
          <dd className="po-num font-semibold text-po-ink">{seller.agent_token}</dd>
        </div>
      </dl>
      <div className="grid grid-cols-2 gap-3">
        <div className="po-card-sunken px-4 py-3">
          <p className="text-sm text-po-grey">Open</p>
          <p className="po-num text-2xl font-semibold text-po-ink">{loading ? '-' : listed - paid}</p>
        </div>
        <div className="po-card-sunken px-4 py-3">
          <p className="text-sm text-po-grey">Paid once</p>
          <p className="po-num text-2xl font-semibold text-po-ink">{loading ? '-' : paid}</p>
        </div>
      </div>
      <ButtonRow className="mt-auto">
        <ButtonLink to={`/app/invoices?seller=${encodeURIComponent(seller.seller)}`} variant="secondary" small>
          Its invoices
        </ButtonLink>
        <a href={seller.badge_url} target="_blank" rel="noreferrer" className="po-btn po-btn-ghost po-btn-sm">
          Badge check
        </a>
        <a href={seller.agent_card_url} target="_blank" rel="noreferrer" className="po-btn po-btn-ghost po-btn-sm">
          Agent card
        </a>
      </ButtonRow>
    </Card>
  )
}
