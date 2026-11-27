// A link that names a payable number but no seller (shared before payables were
// keyed by seller). The number alone can name two invoices, so it is resolved
// against the registry list: one match opens it, several ask which seller.
import { Link, Navigate } from 'react-router-dom'
import { useAppData, useSellers } from './hooks'
import { sellerName, type PayableKey } from './keys'
import { Notice, Skeleton } from './ui'

export const ANY_SELLER = 'any'

export function AnySeller({ id, to }: { id: number; to: (k: PayableKey) => string }) {
  const data = useAppData()
  const dir = useSellers()
  if (data.source === 'loading') return <Skeleton className="h-[160px] w-full" />
  const matches = data.items.filter((i) => i.payable_id === id)
  if (matches.length === 1) return <Navigate to={to({ seller: matches[0].seller, id })} replace />
  if (matches.length === 0) {
    return <Notice tone="error">No invoice number {id} is on the registry list. Check the link, or pick one from the invoices.</Notice>
  }
  return (
    <Notice tone="info">
      <p>Invoice number {id} exists for more than one seller. Which one do you mean?</p>
      <ul className="mt-2 flex flex-col gap-1">
        {matches.map((m) => (
          <li key={m.seller}>
            <Link className="font-medium text-po-accent-ink underline" to={to({ seller: m.seller, id })}>
              {sellerName(m.seller, dir.sellers)}, payable {id}
            </Link>
          </li>
        ))}
      </ul>
    </Notice>
  )
}
