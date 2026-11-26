// Receipt page — P3 §11. Loads the invoice from the chain and re-runs the
// after-payment verifier on each visit. If unpaid: "Not paid yet" + link back.
import { useEffect, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { Receipt } from '../lib/types'
import { useConfig, usePayable } from '../hooks/useApi'
import { AppHeader } from '../components/AppHeader'
import { ReceiptCard } from '../components/ReceiptStep'
import { Footer } from '../components/Sections'
import { AlertInline } from '../components/ui'

export function ReceiptPage() {
  const { payableId } = useParams()
  const [searchParams] = useSearchParams()
  // Seller 2's payables share ids with seller 1's (v2 keys by
  // (seller, id)); the seller comes from ?seller=<address> and
  // defaults to seller 1 when absent, so old links keep working.
  const seller = searchParams.get('seller') ?? undefined
  const id = Number.parseInt(payableId ?? '', 10)
  const valid = Number.isFinite(id) && id > 0
  const payable = usePayable(valid ? id : null, seller)
  const config = useConfig()
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!valid) return
    void api
      .getReceipt(id, seller)
      .then(setReceipt)
      .catch(() => setError('The receipt could not be loaded. The transaction links in the dashboard pay flow are still correct.'))
  }, [id, valid, seller])

  const explorerBase = config.data?.explorer.tx ?? 'https://ccdexplorer.io/testnet/transaction/'
  const unpaid = payable.data?.status.kind !== 'paid'
  // The seller is rendered from the RESPONSE, never from the URL
  // (fix-back §4.6): if the receipt's seller differs from the requested
  // one, the link was corrupted — show a mismatch error and never render
  // the receipt under the wrong seller's name.
  const responseSeller = receipt?.seller ?? payable.data?.seller
  const sellerMismatch = Boolean(seller && responseSeller && responseSeller !== seller)
  const shownSeller = responseSeller ?? seller

  return (
    <div className="page-enter min-h-screen bg-paper">
      <div className="bg-sky-0">
        <AppHeader dark />
      </div>
      <main id="main" className="mx-auto max-w-[860px] px-4 py-12 sm:px-6">
        <p>
          <Link to="/" className="font-medium text-brand-700">
            ← Back to home
          </Link>
        </p>
        <h1 className="mt-4 text-[32px] leading-[1.1] font-medium tracking-[-0.02em] text-ink">
          Receipt — payable {valid ? id : '—'}
          {shownSeller ? ` · seller ${shownSeller.slice(0, 8)}…` : ''}
        </h1>
        {!valid ? (
          <AlertInline>No payable with this number is on the test registry.</AlertInline>
        ) : payable.isLoading ? (
          <p className="mt-4 text-muted" role="status">
            Reading the chain…
          </p>
        ) : payable.isError || !payable.data ? (
          <AlertInline>No payable with this number is on the test registry.</AlertInline>
        ) : unpaid ? (
          <div className="mt-4 rounded-none border border-line bg-card p-6">
            <p className="text-[15px] text-ink">Not paid yet. This invoice can be paid once, on the dashboard.</p>
            <p className="mt-3">
              <Link to={`/dashboard/pay?tab=pay&payable=${id}${seller ? `&seller=${encodeURIComponent(seller)}` : ''}`} className="font-medium text-brand-700">
                Go to the invoice →
              </Link>
            </p>
          </div>
        ) : error ? (
          <AlertInline>{error}</AlertInline>
        ) : sellerMismatch ? (
          <AlertInline>
            This receipt belongs to a different seller than the link asked for — it is not shown here. Check the
            receipt link and try again.
          </AlertInline>
        ) : receipt ? (
          <div className="mt-6 rounded-none border border-line bg-card p-6">
            <ReceiptCard receipt={receipt} explorerBase={explorerBase} asset={payable.data?.asset.kind} />
            <p className="mt-4 text-sm text-muted">
              Anyone can check this without us: download the verifier and run it with the transaction hash (For
              judges).
            </p>
          </div>
        ) : (
          <p className="mt-4 text-muted" role="status">
            Loading the receipt…
          </p>
        )}
        <p className="mt-6">
          <Link to="/judges" className="font-medium text-brand-700">
            For judges →
          </Link>
        </p>
      </main>
      <Footer />
    </div>
  )
}
