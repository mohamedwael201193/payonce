// Overview: where the app opens. StartHere, four equal stat cards, a short
// invoice list and the sellers. Live numbers carry a LIVE tag; when the API
// cannot be read the page falls back to the recorded snapshot and says so.
import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { RefreshCw } from 'lucide-react'
import { useConfig } from '../../hooks/useApi'
import { derivedStatus } from '../../lib/dashboard'
import { InvoiceList } from '../InvoiceList'
import { StartHere } from '../StartHere'
import { useAppData, useDocumentTitle, useSellers, type DataSource } from '../hooks'
import { formatDay, recordedLabel } from '../fees'
import { clockUtc } from '../format'
import { sellerName } from '../keys'
import { Button, ButtonLink, Card, EmptyState, Notice, PageHeader, Skeleton, SourceTag } from '../ui'

function StatCard({
  label,
  value,
  sub,
  loading,
  source,
  asOf,
}: {
  label: string
  value: number | undefined
  sub: string
  loading: boolean
  source: DataSource
  asOf: string | null
}) {
  return (
    <div className="po-card flex h-full min-h-[148px] flex-col p-5" data-testid="stat-card">
      <p className="text-[15px] text-po-grey">{label}</p>
      <div className="mt-3 flex items-end justify-between gap-3">
        <p className="po-num text-[44px] leading-none font-medium tracking-[-0.02em] text-po-ink">
          {loading || value === undefined ? <Skeleton className="h-[44px] w-[88px]" /> : value}
        </p>
        <SourceTag source={source} asOf={asOf} />
      </div>
      <div className="mt-auto pt-3 text-sm text-po-grey">{loading ? <Skeleton className="h-4 w-40" /> : sub}</div>
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

  const view = useMemo(() => {
    const paid = items.filter((i) => i.status === 'paid').length
    const open = items.filter((i) => i.status !== 'paid')
    const byDue = [...open].sort((a, b) => a.due.localeCompare(b.due))
    const preview = [
      ...byDue.slice(0, 3),
      ...[...items]
        .filter((i) => i.status === 'paid')
        .sort((a, b) => b.payable_id - a.payable_id)
        .slice(0, 3),
    ]
    const overdue = open.filter((i) => derivedStatus(i) === 'overdue').length
    return { paid, open: open.length, nextDue: byDue[0], preview, overdue }
  }, [items])

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
        ) : view.preview.length === 0 ? (
          <EmptyState
            title="No invoices on the registry yet"
            action={
              <ButtonLink to="/app/pay" variant="primary">
                Pay a test invoice
              </ButtonLink>
            }
          >
            Register an invoice on the testnet to see it here.
          </EmptyState>
        ) : (
          <InvoiceList items={view.preview} sellers={dir.sellers} />
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
                  <Card as="div" className="flex h-full flex-col gap-3">
                    <div>
                      <h3 className="text-lg font-medium text-po-ink">{sellerName(s.seller, dir.sellers)}</h3>
                      <p className="po-hash mt-1 text-po-grey">{s.seller}</p>
                    </div>
                    <p className="text-[15px] text-po-grey">
                      Agent token {s.agent_token}.{' '}
                      {loading ? '' : `${mine.length} listed, ${mine.filter((i) => i.status === 'paid').length} paid.`}
                    </p>
                    <p className="mt-auto flex flex-wrap gap-x-5 text-[15px]">
                      <a
                        href={s.badge_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-[44px] items-center font-medium text-po-accent-ink underline decoration-po-line-strong"
                      >
                        Badge check
                      </a>
                      <a
                        href={s.agent_card_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-h-[44px] items-center font-medium text-po-accent-ink underline decoration-po-line-strong"
                      >
                        Agent card
                      </a>
                      <Link
                        to={`/app/invoices?seller=${encodeURIComponent(s.seller)}`}
                        className="inline-flex min-h-[44px] items-center font-medium text-po-accent-ink underline decoration-po-line-strong"
                      >
                        Its invoices
                      </Link>
                    </p>
                  </Card>
                </li>
              )
            })}
          </ul>
        )}
      </section>
    </div>
  )
}
