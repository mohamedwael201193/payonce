// Receipt page — P3 §11. Loads the invoice from the chain and re-runs the
// after-payment verifier on each visit. If unpaid: "Not paid yet" + link back.
import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api } from '../lib/api'
import type { Receipt } from '../lib/types'
import { useConfig, usePayable } from '../hooks/useApi'
import { AppHeader } from '../components/AppHeader'
import { ReceiptCard } from '../components/ReceiptStep'
import { Footer } from '../components/Sections'
import { AlertInline } from '../components/ui'

export function ReceiptPage() {
  const { payableId } = useParams()
  const id = Number.parseInt(payableId ?? '', 10)
  const valid = Number.isFinite(id) && id > 0
  const payable = usePayable(valid ? id : null)
  const config = useConfig()
  const [receipt, setReceipt] = useState<Receipt | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!valid) return
    void api
      .getReceipt(id)
      .then(setReceipt)
      .catch(() => setError('The receipt could not be loaded. The transaction links on the home page are still correct.'))
  }, [id, valid])

  const explorerBase = config.data?.explorer.tx ?? 'https://ccdexplorer.io/testnet/transaction/'
  const unpaid = payable.data?.status.kind !== 'paid'

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
            <p className="text-[15px] text-ink">Not paid yet. This invoice can be paid once, on the home page.</p>
            <p className="mt-3">
              <Link to={`/?payable=${id}`} className="font-medium text-brand-700">
                Go to the invoice →
              </Link>
            </p>
          </div>
        ) : error ? (
          <AlertInline>{error}</AlertInline>
        ) : receipt ? (
          <div className="mt-6 rounded-none border border-line bg-card p-6">
            <ReceiptCard receipt={receipt} explorerBase={explorerBase} />
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
