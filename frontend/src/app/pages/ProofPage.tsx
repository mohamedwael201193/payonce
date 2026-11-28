// /app/proof: everything that backs the claim, in one place, one line each.
// The main path (/app) never needs any of this; a judge who wants evidence opens one row.
import { Link } from 'react-router-dom'
import { useDocumentTitle } from '../hooks'
import '../run/run.css'

// One story: every row backs one part of "checks who it's paying, then pays exactly once".
const ROWS = [
  { to: '/app/proof/agent', title: 'The agent at work', line: 'Its last run over an inbox: which invoices it stopped, which it paid once, and why. Emails that try to give it orders are refused too: that is its safety layer.' },
  { to: '/app/proof/break', title: 'Try to fool it', line: 'Pay twice, pay the wrong amount, pay a seller nobody approved. Each attempt is refused, most of them by the chain itself.' },
  { to: '/app/proof/age', title: 'One more identity check: 18+', line: 'An age-restricted invoice is only paid after the buyer proves 18+ with a Concordium identity, without revealing a birth date.' },
  { to: '/app/proof/census', title: 'Who could be verified today', line: 'A census of the Concordium agent registry: at most how many registered agents meet the preconditions of a payee check. An upper bound, with the definitions.' },
  { to: '/app/proof/judges#verify-it', title: 'Verify it yourself', line: 'A read-only verifier, no keys and no account: it re-reads any payment from the chain and prints every check.' },
  { to: '/app/proof/x402', title: 'Paid by x402', line: 'One invoice paid through the x402 payment flow, then checked from the chain the same way.' },
  { to: '/app/proof/judges', title: 'For judges', line: 'Contracts, transactions, the trust model and the honest limits in one place.' },
]

export function ProofPage() {
  useDocumentTitle('Proof')
  return (
    <div className="rn">
      <header className="rn-head">
        <h1 className="rn-h1">Proof</h1>
        <p className="rn-lead">Every claim links to a real testnet transaction. Open any row.</p>
      </header>
      <ul className="pf-list">
        {ROWS.map((r) => (
          <li key={r.to}>
            <Link to={r.to} className="pf-row">
              <span className="pf-row__t">{r.title}</span>
              <span className="pf-row__l">{r.line}</span>
              <span className="pf-row__go" aria-hidden>Open</span>
            </Link>
          </li>
        ))}
      </ul>
      <p className="rn-foot">
        Check any payment yourself, no account needed:{' '}
        <span className="rn-mono">cd api &amp;&amp; node src/verify-payable-v2.mjs &lt;payable-id&gt; &lt;payment-tx&gt;</span> in the{' '}
        <a className="rn-a" href="https://github.com/mohamedwael201193/payonce" target="_blank" rel="noreferrer">repository</a>.
      </p>
    </div>
  )
}

export function NotFoundPage() {
  useDocumentTitle('Not found')
  return (
    <div className="rn" data-testid="not-found">
      <h1 className="rn-h1">Nothing here</h1>
      <p className="rn-lead">This page does not exist.</p>
      <div className="rn-actions">
        <Link className="rn-btn" to="/app">Run it</Link>
        <Link className="rn-link" to="/app/proof">Proof</Link>
      </div>
    </div>
  )
}
