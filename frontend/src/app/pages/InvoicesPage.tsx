// Invoices: every payable on the registry, with filters (seller, status,
// rail), search and CSV. Filters live in the URL query, so a filtered list
// is a link, and changing one never remounts the page.
import { useMemo } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Download } from 'lucide-react'
import { derivedStatus, filterInvoices, invoicesToCsv } from '../../lib/dashboard'
import { InvoiceList } from '../InvoiceList'
import { useAppData, useDocumentTitle, useSellers } from '../hooks'
import { sellerName } from '../keys'
import { recordedLabel } from '../fees'
import { Button, ButtonLink, EmptyState, Notice, PageHeader, Skeleton, SourceTag } from '../ui'

const SELECT = 'po-input'

export function InvoicesPage() {
  useDocumentTitle('Invoices - PayOnce')
  const [params, setParams] = useSearchParams()
  const data = useAppData()
  const dir = useSellers()

  const q = params.get('q') ?? ''
  const seller = params.get('seller') ?? ''
  const status = params.get('status') ?? ''
  const rail = params.get('rail') ?? ''

  const set = (name: string, value: string) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value) next.set(name, value)
        else next.delete(name)
        return next
      },
      { replace: true },
    )

  const shown = useMemo(() => {
    let rows = filterInvoices(data.items, q)
    if (seller) rows = rows.filter((i) => i.seller === seller)
    if (rail) rows = rows.filter((i) => i.asset === rail)
    if (status) rows = rows.filter((i) => derivedStatus(i) === status)
    return [...rows].sort((a, b) => (a.status === b.status ? b.payable_id - a.payable_id : a.status === 'paid' ? 1 : -1))
  }, [data.items, q, seller, rail, status])

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
  const filtered = Boolean(q || seller || status || rail)

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
      {data.source === 'recorded' ? (
        <Notice tone="warn">The live API did not answer. This list is the recorded snapshot ({recordedLabel(data.asOf)}), not live.</Notice>
      ) : null}

      <form role="search" aria-label="Filter invoices" onSubmit={(e) => e.preventDefault()} className="grid gap-3 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_1fr_1fr_1fr]">
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
            <option value="unpaid">Open</option>
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
        {loading ? 'Reading the registry' : `Showing ${shown.length} of ${data.items.length} invoices`}
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
        <InvoiceList items={shown} sellers={dir.sellers} />
      )}
    </div>
  )
}
