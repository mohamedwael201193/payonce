// Two gates inside Now-you-pay:
//  HumanGate  the agent stopped (Close match, Not possible, Match not bound yet). A person decides, in writing.
//  AgeGate    the service demands 18+: the visitor's own wallet proves it. Needs WS1's wallet age-proof routes.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useWallet } from '../wallet/WalletContext'
import { walletErrorText } from '../wallet/types'
import { WalletApiError } from '../wallet/api'
import { NotShipped, dashApi, type Outcome } from './contracts'

const TITLE: Record<Exclude<Outcome, 'match' | 'no_match'>, string> = {
  close_match: 'Close match. The agent stopped.',
  not_possible: 'Not possible to verify. The agent stopped.',
}

export function HumanGate({
  outcome, why, facts, confirmLabel, busy, onApprove, onDecline,
}: {
  outcome: 'close_match' | 'not_possible' | 'match_unbound'
  why: string
  facts: { label: string; value: string }[]
  confirmLabel: string
  busy?: boolean
  onApprove: () => void
  onDecline: () => void
}) {
  const [ok, setOk] = useState(false)
  const title = outcome === 'match_unbound' ? 'Match, but not bound yet. The agent stopped.' : TITLE[outcome]
  return (
    <section className="ds-gate" role="group" aria-label="Your decision" data-testid="human-gate" data-outcome={outcome}>
      <h3>{title}</h3>
      <p>{why}</p>
      <dl className="ds-gate__facts">
        {facts.map((f) => (<div key={f.label} style={{ display: 'contents' }}><span>{f.label}</span><b>{f.value}</b></div>))}
      </dl>
      <label>
        <input type="checkbox" checked={ok} onChange={(e) => setOk(e.target.checked)} />
        <span>I decide this payment myself. Nothing here proves the account belongs to that name.</span>
      </label>
      <div className="ds-gate__row">
        <button className="ds-btn" disabled={!ok || busy} onClick={onApprove}>{confirmLabel}</button>
        <button className="ds-btn ds-btn--ghost" disabled={busy} onClick={onDecline}>Don’t pay</button>
      </div>
    </section>
  )
}

export function AgeGate({ sellerId, onVerified }: { sellerId: string; onVerified: () => void }) {
  const w = useWallet()
  const [st, setSt] = useState<{ s: 'idle' } | { s: 'busy'; note: string } | { s: 'error'; msg: string } | { s: 'pending'; route: string }>({ s: 'idle' })
  async function prove() {
    if (!w.session) return setSt({ s: 'error', msg: 'Connect your wallet first.' })
    try {
      setSt({ s: 'busy', note: 'Preparing the 18+ request…' })
      const req = await dashApi.ageRequest(w.session.account, sellerId)
      setSt({ s: 'busy', note: 'Approve in your wallet. Only “18 or older” is shared.' })
      const out = await w.session.requestProof({ v1: req.v1, v0: req.v0 })
      setSt({ s: 'busy', note: 'Checking the proof…' })
      const v = await dashApi.ageVerify(req.request_id, out.version, out.presentation)
      if (!v.verified) return setSt({ s: 'error', msg: 'The 18+ proof did not verify.' })
      onVerified()
    } catch (e) {
      setSt(e instanceof NotShipped ? { s: 'pending', route: e.route } : { s: 'error', msg: e instanceof WalletApiError ? e.message : walletErrorText(e) })
    }
  }
  return (
    <section className="ds-gate ds-gate--ok" role="group" aria-label="18+ proof" data-testid="age-gate">
      <h3>This service needs 18+.</h3>
      <p>Your wallet proves it. Nothing else is shared.</p>
      <div className="ds-gate__row">
        <button className="ds-btn" disabled={st.s === 'busy'} onClick={() => void prove()}>Prove 18+</button>
      </div>
      {st.s === 'busy' ? <p className="ds-busy" role="status"><span className="rn-spin" aria-hidden />{st.note}</p> : null}
      {st.s === 'error' ? <p className="ds-err" role="alert">{st.msg}</p> : null}
      {st.s === 'pending' ? (
        <>
          <p className="ds-pending" data-testid="not-live"><span aria-hidden>◌</span> Not live yet <code>{st.route}</code></p>
          <p className="ds-note">Meanwhile, see how the hosted 18+ check works on <Link to="/app/proof/age">Proof</Link>. It uses one PayOnce testnet credential, not yours.</p>
        </>
      ) : null}
    </section>
  )
}
