// Invoices: every payable on the registry, with filters (seller, status,
// rail), search and CSV. Filters live in the URL query, so a filtered list
// is a link, and changing one never remounts the page.
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { ChevronLeft, ChevronRight, Download } from 'lucide-react'
import { defaultOrder, derivedStatus, filterInvoices, inScope, invoicesToCsv, kindSummary, type InvoiceScope } from '../../lib/dashboard'
import { InvoiceList } from '../InvoiceList'
import { DataNotices } from '../DataNotices'
import { useAppData, useDocumentTitle, useSellers } from '../hooks'
import { sellerName } from '../keys'
import { Button, ButtonLink, ButtonRow, EmptyState, PageHeader, Skeleton, SourceTag } from '../ui'

const SELECT = 'po-input'
export const PAGE_SIZE = 25

export function InvoicesPage() {
  useDocumentTitle('Invoices - PayOnce')
  const [params, setParams] = useSearchParams()
  const data = useAppData()
  const dir = useSellers()

  const q = params.get('q') ?? ''
  const seller = params.get('seller') ?? ''
  const status = params.get('status') ?? ''
  const rail = params.get('rail') ?? ''
  const scopeParam = params.get('show')
  const scope: InvoiceScope = scopeParam === 'tests' || scopeParam === 'all' ? scopeParam : 'default'
  const pageParam = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1)

  const set = (name: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) next.set(name, value)
        else next.delete(name)
        if (name !== 'page') next.delete('page')
        return next
      },
      { replace: true },
    )

  const shown = useMemo(() => {
    let rows = filterInvoices(data.items, q).filter((i) => inScope(i, scope))
    if (seller) rows = rows.filter((i) => i.seller === seller)
    if (rail) rows = rows.filter((i) => i.asset === rail)
    if (status) rows = rows.filter((i) => derivedStatus(i) === status)
    return defaultOrder(rows)
  }, [data.items, q, seller, rail, status, scope])
  const pages = Math.max(1, Math.ceil(shown.length / PAGE_SIZE))
  const page = Math.min(pageParam, pages)
  const visible = shown.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE)

  const sellerOptions = useMemo(() => {
    const seen = [...new Set(data.items.map((i) => i.seller))]
    return seen.map((s) => ({ value: s, label: sellerName(s, dir.sellers) }))
  }, [data.items, dir.sellers])

  const exportCsv = () => {
    const blob = new Blob([invoicesToCsv(shown)], { type: 'text/csv' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'payonce-invoices.csv'
    a.click()
    URL.revokeObjectURL(url)
  }

  const loading = data.source === 'loading'
  const filtered = Boolean(q || seller || status || rail || scope !== 'default')
  const kinds = kindSummary(data.stats)
  const inView = useMemo(() => data.items.filter((i) => inScope(i, scope)).length, [data.items, scope])

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Invoices"
        lead="Every payable on the test registry. Open one to pay it, or to read its receipt."
        actions={
          <>
            <SourceTag source={data.source} asOf={data.asOf} />
            <Button onClick={exportCsv} disabled={loading || shown.length === 0} disabledReason={null}>
              <Download className="h-4 w-4" aria-hidden="true" /> Export CSV
            </Button>
          </>
        }
      />
      <DataNotices data={data} subject="rows" />

      <form role="search" aria-label="Filter invoices" onSubmit={(e) => e.preventDefault()} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_1.2fr_1fr_1fr_1.3fr]">
        <label className="flex flex-col gap-1.5 text-sm text-po-grey sm:col-span-2 lg:col-span-1">
          Search
          <input
            type="search"
            value={q}
            onChange={(e) => set('q', e.target.value)}
            placeholder="Number, amount or name"
            className="po-input"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-po-grey">
          Show
          <select value={scope} onChange={(e) => set('show', e.target.value === 'default' ? '' : e.target.value)} className={SELECT}>
            <option value="default">Demo and ready to pay</option>
            <option value="tests">Automated test runs</option>
            <option value="all">Everything on the registry</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-po-grey">
          Seller
          <select value={seller} onChange={(e) => set('seller', e.target.value)} className={SELECT}>
            <option value="">All sellers</option>
            {sellerOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-po-grey">
          Status
          <select value={status} onChange={(e) => set('status', e.target.value)} className={SELECT}>
            <option value="">All statuses</option>
            <option value="paid">Paid</option>
            <option value="unpaid">Ready to pay</option>
            <option value="overdue">Overdue</option>
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-sm text-po-grey">
          Rail
          <select value={rail} onChange={(e) => set('rail', e.target.value)} className={SELECT}>
            <option value="">CCD and EUDemo</option>
            <option value="ccd">CCD</option>
            <option value="eudemo">EUDemo</option>
          </select>
        </label>
      </form>

      <p className="text-sm text-po-grey" aria-live="polite">
        {loading ? 'Reading the registry' : `Showing ${shown.length ? (page - 1) * PAGE_SIZE + 1 : 0} to ${Math.min(page * PAGE_SIZE, shown.length)} of ${shown.length}${shown.length !== inView ? ` matching (${inView} in this view, ${data.items.length} on the registry)` : data.items.length !== inView ? ` (${data.items.length} on the registry)` : ''}. Ready to pay comes first.${scope === 'default' && kinds ? ` This view leaves out paid and overdue rows from the ${kinds.tests.total} automated test runs (they are counted in the totals). Choose "Automated test runs" or "Everything" to see them.` : ''}`}
      </p>

      {loading ? (
        <div className="po-card flex flex-col gap-4 p-5" aria-label="Loading invoices">
          {[0, 1, 2, 3, 4, 5].map((n) => (
            <Skeleton key={n} className="h-8 w-full" />
          ))}
        </div>
      ) : shown.length === 0 ? (
        <EmptyState
          title={filtered ? 'No invoice matches these filters' : 'No invoices on the registry yet'}
          action={
            filtered ? (
              <Button onClick={() => setParams({}, { replace: true })}>Clear the filters</Button>
            ) : (
              <ButtonLink to="/app/pay" variant="primary">
                Pay a test invoice
              </ButtonLink>
            )
          }
        >
          {filtered ? 'Try a different seller, status or search.' : 'Register an invoice on the testnet to see it here.'}
        </EmptyState>
      ) : (
        <>
          <InvoiceList items={visible} sellers={dir.sellers} />
          {pages > 1 ? (
            <nav aria-label="Pages" className="flex flex-wrap items-center justify-between gap-3">
              <p className="po-num text-sm text-po-grey">
                Page {page} of {pages}
              </p>
              <ButtonRow>
                <Button small disabled={page <= 1} onClick={() => set('page', String(page - 1))}>
                  <ChevronLeft className="h-4 w-4" aria-hidden="true" /> Previous
                </Button>
                <Button small disabled={page >= pages} onClick={() => set('page', String(page + 1))}>
                  Next <ChevronRight className="h-4 w-4" aria-hidden="true" />
                </Button>
              </ButtonRow>
            </nav>
          ) : null}
        </>
      )}
    </div>
  )
}
