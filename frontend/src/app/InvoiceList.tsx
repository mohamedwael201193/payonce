// The invoice list used by Overview (preview) and Invoices (full). One
// responsive list: a header row from 768px, stacked rows below it, so the
// page never scrolls sideways. The row action is a real link: Pay for an
// open invoice, Receipt for a paid one, both carrying (seller, id).
import { Link } from 'react-router-dom'
import { derivedStatus } from '../lib/dashboard'
import type { InvoiceItem } from '../lib/types'
import { itemKey, payPath, receiptPath, sellerName, type SellerInfo } from './keys'
import { formatDay } from './fees'
import { tidyAmount } from './format'
import { StatusPill } from './ui'

export function railName(asset: InvoiceItem['asset']): string {
  return asset === 'ccd' ? 'CCD' : 'EUDemo'
}

const COLS = 'md:grid-cols-[64px_minmax(0,1.1fr)_minmax(0,1.6fr)_132px_120px_100px_104px]'

export function InvoiceList({ items, sellers }: { items: InvoiceItem[]; sellers: SellerInfo[] }) {
  return (
    <div role="table" aria-label="Invoices" className="po-card overflow-hidden">
      <div role="row" className={`hidden gap-4 border-b border-po-line px-5 py-3 text-sm text-po-grey md:grid ${COLS}`}>
        <span role="columnheader">Number</span>
        <span role="columnheader">Seller</span>
        <span role="columnheader">Invoice</span>
        <span role="columnheader">Amount</span>
        <span role="columnheader">Due</span>
        <span role="columnheader">Status</span>
        <span role="columnheader" className="sr-only">
          Action
        </span>
      </div>
      <ul className="divide-y divide-po-line">
        {items.map((i) => {
          const status = derivedStatus(i)
          const paid = status === 'paid'
          const key = itemKey(i)
          return (
            <li
              key={`${i.seller}:${i.payable_id}`}
              role="row"
              data-testid="invoice-row"
              className={`grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-1 px-5 py-4 md:gap-y-0 ${COLS}`}
            >
              <span role="cell" className="po-num order-1 font-medium text-po-ink md:order-none">
                <span className="text-po-grey md:hidden">Payable </span>
                {i.payable_id}
              </span>
              <span role="cell" className="order-3 col-span-2 text-sm text-po-grey md:order-none md:col-span-1 md:text-[15px]">
                {sellerName(i.seller, sellers)}
              </span>
              <span role="cell" className="order-4 col-span-2 min-w-0 truncate text-[15px] text-po-ink md:order-none md:col-span-1" title={i.label}>
                {i.label}
              </span>
              <span role="cell" className="po-num order-5 col-span-2 text-[15px] text-po-ink md:order-none md:col-span-1">
                {tidyAmount(i.amount_display)}
              </span>
              <span role="cell" className="order-6 col-span-2 text-sm text-po-grey md:order-none md:col-span-1 md:text-[15px]">
                <span className="md:hidden">Due </span>
                {formatDay(i.due)}
              </span>
              <span role="cell" className="order-2 justify-self-end md:order-none md:justify-self-start">
                <StatusPill tone={paid ? 'ok' : status === 'overdue' ? 'bad' : 'warn'}>
                  {paid ? 'Paid' : status === 'overdue' ? 'Overdue' : 'Open'}
                </StatusPill>
              </span>
              <span role="cell" className="order-7 col-span-2 mt-2 md:order-none md:col-span-1 md:mt-0 md:justify-self-end">
                <Link
                  to={paid ? receiptPath(key) : payPath(key)}
                  className="inline-flex min-h-[44px] items-center font-medium text-po-accent-ink underline decoration-po-line-strong"
                >
                  {paid ? 'Receipt' : 'Pay'}
                  <span className="sr-only">
                    {' '}
                    for payable {i.payable_id}, {sellerName(i.seller, sellers)}
                  </span>
                </Link>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
