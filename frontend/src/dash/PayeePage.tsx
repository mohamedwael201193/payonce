// /p/<account>: a payee's public page. Real today: the stored name proof and a live check_payee.
// "Pay with wallet" needs GET /api/p/:account/pay-tx (PLANNED) and sits behind the dashboard flag.
import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { midTruncate } from '../app/Address'
import { useDocumentTitle } from '../app/hooks'
import { dashApi, type CheckPayee } from './contracts'
import { VerdictBlock } from './DashPage'
import { dashEnabled } from './flag'
import './dash.css'

const ACCOUNT = /^[1-9A-HJ-NP-Za-km-z]{50}$/

export function PayeePage() {
  const { account = '' } = useParams()
  const ok = ACCOUNT.test(account)
  useDocumentTitle(ok ? `Payee ${midTruncate(account, 6, 6)}` : 'Payee')
  const cardQ = useQuery({ queryKey: ['payee-card', account], enabled: ok, queryFn: () => dashApi.payeeCard(account) })
  const card = cardQ.data ?? null
  const proof = card?.verified ? card : null
  const [name, setName] = useState('')
  const [draft, setDraft] = useState('')
  const asked = name.trim() || card?.name || ''
  const checkQ = useQuery({
    queryKey: ['check-payee', account, asked],
    enabled: ok && !cardQ.isLoading && asked.length > 0,
    queryFn: () => dashApi.payeeCheck(account, asked),
  })
  const [json, setJson] = useState(false)

  if (!ok) return <div className="po-app ds ds--page"><div className="ds-body"><section className="ds-card"><h1 className="ds-h2">Not a Concordium account</h1><Link to="/app">Back</Link></section></div></div>

  const c: CheckPayee | undefined = checkQ.data
  return (
    <div className="po-app ds ds--page" data-testid="payee-page">
      <header className="ds-hero ds-hero--slim">
        <p className="ds-crumb"><Link to="/">PayOnce</Link> · Payee</p>
        <h1 className="ds-h1">{proof?.name ?? 'Unverified payee'}</h1>
        <p className="ds-lead"><code>{account}</code></p>
      </header>
      <div className="ds-body">
        <section className="ds-card">
          <div className="ds-kv">
            <span>Name proof</span><b>{cardQ.isLoading ? '…' : card?.proof ? `${card.kind === 'business' ? 'Company' : 'Person'} · ${card.proof.version.toUpperCase()}` : 'None'}</b>
            <span>Payee book</span><b>{c ? c.subject.book.status : card?.bound?.status ?? '…'}</b>
          </div>
          <form className="ds-form" onSubmit={(e) => { e.preventDefault(); setName(draft) }}>
            <label className="ds-field"><span>Name on your invoice</span><input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={card?.name ?? 'The name you were told to pay'} /></label>
            <button className="ds-btn" type="submit" disabled={!draft.trim()}>Check</button>
          </form>
          {checkQ.isLoading ? <p className="ds-busy" role="status"><span className="rn-spin" aria-hidden />Checking…</p> : null}
          {checkQ.isError ? <p className="ds-err" role="alert">{checkQ.error instanceof Error ? checkQ.error.message : 'The check did not answer. Try again.'}</p> : null}
          {c ? <VerdictBlock check={c} /> : null}
          {c && c.reasons[0] ? <p className="ds-note">{c.reasons[0]}</p> : null}
          {dashEnabled() && c?.payable ? <Link className="ds-btn" to={`/app?dash=1&payee=${account}`}>Pay with wallet</Link> : null}
          {c ? <button className="ds-btn ds-btn--ghost" onClick={() => setJson((v) => !v)} aria-expanded={json}>{json ? 'Hide' : 'Show'} check_payee JSON</button> : null}
          {json && c ? <pre className="ds-json">{JSON.stringify(c, null, 2)}</pre> : null}
          <p className="ds-note">Testnet. Names are mock identities. The chain enforces the payee’s signature, the hold and pay-once; the name proof is checked by a keyless verifier anyone can re-run.</p>
        </section>
      </div>
    </div>
  )
}
