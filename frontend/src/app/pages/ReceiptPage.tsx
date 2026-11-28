// Receipt: a deep link by (seller, id). It works for any paid payable, in any
// browser, whether or not it was paid in this session: the receipt and the
// payable are both read from the API with the seller in the query, and the
// verifier list is re-run live.
import { useEffect } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useReceipt } from '../../hooks/useApi'
import { usePayable } from '../../hooks/useApi'
import { ApiError } from '../../lib/types'
import { ReceiptView } from '../ReceiptView'
import { markMilestone, useDocumentTitle, useSellers } from '../hooks'
import { parseKeyPath, payPath, resolveSeller, sellerName, type PayableKey } from '../keys'
import { ANY_SELLER, AnySeller } from '../AnySeller'
import { receiptPath } from '../keys'
import { ButtonLink, EmptyState, Notice, PageHeader, Skeleton } from '../ui'

export function ReceiptPage() {
  const splat = useParams()['*']
  const dir = useSellers()
  const parsed = parseKeyPath(splat)
  const seller = parsed ? resolveSeller(parsed.sellerParam, dir.sellers) : null
  const key: PayableKey | null = parsed && seller ? { seller, id: parsed.id } : null
  useDocumentTitle(parsed ? `Receipt ${parsed.id} - PayOnce` : 'Receipt - PayOnce')

  const payable = usePayable(key?.id ?? null, key?.seller)
  const receipt = useReceipt(key?.id ?? null, key?.seller)
  const paid = payable.data?.status.kind === 'paid'

  useEffect(() => {
    if (paid && receipt.data) markMilestone('receipt')
  }, [paid, receipt.data])

  const title = parsed ? `Receipt for payable ${parsed.id}` : 'Receipt'
  const sellerLine = key ? sellerName(key.seller, dir.sellers) : undefined

  let body
  if (!parsed) {
    body = (
      <EmptyState
        title="This receipt link is incomplete"
        action={
          <ButtonLink to="/app" variant="primary">
            Open the invoices
          </ButtonLink>
        }
      >
        A receipt link names a seller and a payable number, like /app/receipt/1/10. Pick a paid invoice from the list.
      </EmptyState>
    )
  } else if (parsed.sellerParam === ANY_SELLER) {
    body = <AnySeller id={parsed.id} to={receiptPath} />
  } else if (!seller) {
    body = dir.error ? (
      <Notice tone="error">The seller list could not be loaded, so this link cannot be resolved. Try again in a moment.</Notice>
    ) : dir.ready ? (
      <Notice tone="error">No seller matches &ldquo;{parsed.sellerParam.slice(0, 24)}&rdquo;. Check the receipt link.</Notice>
    ) : (
      <Skeleton className="h-[240px] w-full" />
    )
  } else if (payable.isLoading) {
    body = <Skeleton className="h-[320px] w-full" />
  } else if (payable.isError || !payable.data) {
    body = (
      <Notice tone="error">
        {payable.error instanceof ApiError ? payable.error.body.message : 'No payable with this number is on the test registry.'}
      </Notice>
    )
  } else if (payable.data.seller !== seller) {
    body = (
      <Notice tone="error">
        This payable belongs to a different seller than the link asked for, so it is not shown. Check the receipt link.
      </Notice>
    )
  } else if (!paid) {
    body = (
      <EmptyState
        title="Not paid yet"
        action={
          <ButtonLink to={payPath(key)} variant="primary">
            Pay this invoice
          </ButtonLink>
        }
      >
        Payable {payable.data.payable_id} from {sellerLine} can be paid once. Its receipt appears here after the payment.
      </EmptyState>
    )
  } else if (receipt.isLoading) {
    body = <Skeleton className="h-[320px] w-full" />
  } else if (receipt.isError || !receipt.data) {
    body = (
      <Notice tone="error">
        {receipt.error instanceof ApiError ? receipt.error.body.message : 'The receipt could not be loaded.'} The payment is
        recorded on chain; try again in a moment.
      </Notice>
    )
  } else if (receipt.data.seller && receipt.data.seller !== seller) {
    body = (
      <Notice tone="error">
        This receipt belongs to a different seller than the link asked for, so it is not shown. Check the receipt link.
      </Notice>
    )
  } else {
    body = <ReceiptView keyOf={key!} receipt={receipt.data} facts={payable.data} sellers={dir.sellers} />
  }

  return (
    <div className="flex flex-col gap-6">
      <nav aria-label="Breadcrumb">
        <Link to="/app" className="inline-flex min-h-[44px] items-center text-[15px] text-po-grey underline decoration-po-line-strong">
          All invoices
        </Link>
      </nav>
      <PageHeader title={title} lead={sellerLine ? `${sellerLine}. Read from the testnet.` : undefined} />
      {body}
    </div>
  )
}
