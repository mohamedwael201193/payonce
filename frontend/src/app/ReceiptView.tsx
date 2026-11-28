// A verified receipt: what was paid, the real transactions, and the
// verifier's check list read from the chain right now. Used inline at the end
// of the pay flow and as the body of /app/receipt/:seller/:id, so both always
// say the same thing.
import { useQuery } from '@tanstack/react-query'
import { RefreshCw } from 'lucide-react'
import { api } from '../lib/api'
import { COPY } from '../lib/copy'
import { formatUtcTime } from '../lib/format'
import { ApiError, type PayableFacts, type Receipt } from '../lib/types'
import { useConfig } from '../hooks/useApi'
import { CheckRows, CheckRowsSkeleton } from './Checks'
import { tidyAmount } from './format'
import { sellerName, type PayableKey, type SellerInfo } from './keys'
import { PUBLIC_API_BASE, receiptCommands } from './verifier'
import { Button, Card, CopyButton, ExplorerTx, KeyValue, Notice, StatusPill, useExplorerBase } from './ui'
import { Address } from './Address'

export function ReceiptView({
  keyOf,
  receipt,
  facts,
  sellers,
}: {
  keyOf: PayableKey
  receipt: Receipt
  facts?: PayableFacts | null
  sellers: SellerInfo[]
}) {
  const explorer = useExplorerBase()
  const config = useConfig()
  const verify = useQuery({
    queryKey: ['verify-after', keyOf.seller, keyOf.id],
    queryFn: () => api.verify(keyOf.id, 'after_pay', undefined, keyOf.seller),
    retry: 1,
    staleTime: 30_000,
    refetchOnMount: 'always',
  })
  const cmd = receiptCommands({
    payableId: receipt.payable_id,
    seller: keyOf.seller,
    sellerOne: sellers[0]?.seller,
    txs: receipt.txs,
    apiBase: PUBLIC_API_BASE,
  })
  const result = verify.data

  return (
    <Card as="article" aria-labelledby={`receipt-${keyOf.id}-title`} className="flex flex-col gap-6" data-testid="receipt-view">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 id={`receipt-${keyOf.id}-title`} className="text-2xl font-medium tracking-[-0.01em] text-po-ink">
          Paid once
        </h2>
        <div className="flex flex-wrap items-center gap-2">
          <StatusPill tone="ok">Testnet receipt</StatusPill>
          <CopyButton value={typeof window !== 'undefined' ? window.location.href : ''} label="link to this receipt" />
        </div>
      </div>

      <dl className="divide-y divide-po-line">
        <KeyValue label="Payable">
          {receipt.payable_id}, {sellerName(keyOf.seller, sellers)}
        </KeyValue>
        <KeyValue label="Amount">{tidyAmount(receipt.amount_display)}</KeyValue>
        <KeyValue label="Payee, from the chain">
          <Address value={receipt.payee} kind="account" label="payee account" expandable />
        </KeyValue>
        <KeyValue label="Paid from">{receipt.payer_label}</KeyValue>
        {facts?.status.kind === 'paid' ? <KeyValue label="Paid at">{formatPaidAt(facts.status.paid_at)}</KeyValue> : null}
      </dl>

      <ol className="flex flex-col gap-0 border-l-2 border-po-line pl-5" aria-label="What happened, in order" data-testid="receipt-timeline">
        <TimelineItem title="Registered on chain" when={null}>
          The seller fixed the payee, the amount and the invoice fingerprint in the contract.
        </TimelineItem>
        <TimelineItem title="Checked before paying" when={null}>
          The agent compared the invoice with the chain: payee, fingerprint, status, due date.
        </TimelineItem>
        <TimelineItem title="Paid once" when={facts?.status.kind === 'paid' ? formatPaidAt(facts.status.paid_at) : null} done>
          {tidyAmount(receipt.amount_display)} went to the registered payee.{' '}
          {receipt.txs[0] ? <ExplorerTx hash={receipt.txs[0].tx_hash} base={explorer} /> : null}
        </TimelineItem>
        <TimelineItem title="Any second payment is refused" when={null} last>
          The contract now marks this invoice Paid, so another payment reverts. The checks below re-read the chain right now.
        </TimelineItem>
      </ol>

      <div>
        <h3 className="text-lg font-medium text-po-ink">Transactions</h3>
        <ul className="mt-2 flex flex-col">
          {receipt.txs.map((t) => (
            <li key={t.tx_hash} className="flex flex-wrap items-center gap-x-3">
              <span className="text-[15px] text-po-grey">{t.label}</span>
              <ExplorerTx hash={t.tx_hash} base={explorer} />
            </li>
          ))}
        </ul>
        {receipt.payment_tx_source === 'server_store' ? (
          <p className="mt-2 text-sm text-po-grey">
            The payment hash comes from our receipt store, because a CCD payment is not recorded on chain with its hash.
            Check the payee's history on the explorer to confirm it.
          </p>
        ) : null}
      </div>

      <div>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="text-lg font-medium text-po-ink">Checked against the chain now</h3>
          <Button small onClick={() => void verify.refetch()} busy={verify.isFetching}>
            <RefreshCw className="h-4 w-4" aria-hidden="true" /> Check again
          </Button>
        </div>
        <div className="mt-3 flex flex-col gap-3" aria-live="polite">
          {verify.isLoading ? (
            <CheckRowsSkeleton />
          ) : verify.isError ? (
            <Notice tone="error">
              {verify.error instanceof ApiError
                ? verify.error.body.message
                : 'The verifier could not finish.'}{' '}
              The transaction links above are still correct.
            </Notice>
          ) : result ? (
            <>
              <p className="text-[15px] text-po-ink" data-testid="verifier-line">
                {COPY.verifierLine(result.passed, result.total, formatUtcTime(result.checked_at))}
              </p>
              <details>
                <summary className="cursor-pointer text-[15px] text-po-grey">Show every check</summary>
                <div className="mt-3"><CheckRows result={result} /></div>
              </details>
            </>
          ) : null}
        </div>
      </div>

      {cmd ? (
        <div>
          <h3 className="text-lg font-medium text-po-ink">Check it without us</h3>
          <p className="mt-1 text-[15px] text-po-grey">
            Run these from the <code className="po-hash">api/</code> folder of the repository (after <code className="po-hash">npm install</code> there and in <code className="po-hash">backend/</code>). The first line downloads the registered invoice text. It reads the chain and needs no keys.
          </p>
          <pre className="mt-3 overflow-x-auto rounded-[10px] bg-po-ink p-4 font-mono text-[13px] text-po-paper" data-testid="verifier-command">
            {cmd}
          </pre>
          <div className="mt-3">
            <CopyButton value={cmd} label="verifier command" />
          </div>
        </div>
      ) : null}

      <p className="border-t border-po-line pt-4 text-sm text-po-grey">
        {COPY.receiptFooter}
        {config.data
          ? ` Registry <${config.data.registry.index},${config.data.registry.subindex}>, verifier ${config.data.verifier.file}.`
          : ''}
      </p>
    </Card>
  )
}

function formatPaidAt(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return iso
  return `${d.toISOString().slice(0, 10)} ${d.toISOString().slice(11, 16)} UTC`
}

function TimelineItem({ title, when, children, done, last }: { title: string; when: string | null; children: React.ReactNode; done?: boolean; last?: boolean }) {
  return (
    <li className={`relative ${last ? '' : 'pb-5'}`}>
      <span aria-hidden className={`absolute -left-[27px] top-1.5 h-3 w-3 rounded-full border-2 ${done ? 'border-po-ok bg-po-ok' : 'border-po-line-strong bg-po-surface'}`} />
      <p className="text-[17px] font-medium text-po-ink">
        {title}
        {when ? <span className="ml-2 text-[15px] font-normal text-po-grey">{when}</span> : null}
      </p>
      <p className="text-[15px] text-po-grey">{children}</p>
    </li>
  )
}
