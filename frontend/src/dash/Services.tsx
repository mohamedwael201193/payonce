// Now you pay, option (b): live x402 services run by other teams. The verdict shows BEFORE anything is paid.
// The probe is free and never pays. The purchase is made by PayOnce's labelled reference buyer under a cap
// (POST /api/x402/buy); a person decides whether it may when the verdict is not a full Match.
import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { midTruncate } from '../app/Address'
import { WalletApiError } from '../wallet/api'
import { dashApi, type Verdict, type X402Buy, type X402Probe, type X402Seller } from './contracts'
import { AgeGate, HumanGate } from './gates'
import { Stamp } from './motion'

const EXPLORER_TX = 'https://ccdexplorer.io/testnet/transaction/'
const TO_VERDICT: Record<string, Verdict> = { match: 'MATCH', close_match: 'CLOSE_MATCH', no_match: 'NO_MATCH', not_possible: 'UNVERIFIED' }

type Row =
  | { s: 'idle' }
  | { s: 'busy'; note: string }
  | { s: 'probed'; p: X402Probe }
  | { s: 'bought'; b: X402Buy }
  | { s: 'declined'; p: X402Probe }
  | { s: 'error'; msg: string }

function Service({ svc }: { svc: X402Seller }) {
  const [row, setRow] = useState<Row>({ s: 'idle' })
  const [ageOk, setAgeOk] = useState(!svc.needs_age)
  const msg = (e: unknown) => (e instanceof WalletApiError ? e.message : 'The request did not complete.')

  async function probe() {
    try { setRow({ s: 'busy', note: 'Checking who gets paid…' }); setRow({ s: 'probed', p: await dashApi.x402Probe(svc) }) } catch (e) { setRow({ s: 'error', msg: msg(e) }) }
  }
  async function buy(approved: boolean) {
    try { setRow({ s: 'busy', note: 'Paying once and fetching the result…' }); setRow({ s: 'bought', b: await dashApi.x402Buy(svc, approved) }) } catch (e) { setRow({ s: 'error', msg: msg(e) }) }
  }

  const p = row.s === 'probed' || row.s === 'declined' ? row.p : row.s === 'bought' ? row.b : null
  const verdict = p ? (p.check?.verdict ?? TO_VERDICT[p.decision.outcome]) : null
  return (
    <li data-testid="service" data-id={svc.id}>
      <div className="ds-svc__top"><b>{svc.name}</b><span>{svc.team} · {svc.price_ccd} CCD</span></div>
      {row.s === 'idle' ? <button className="ds-btn ds-btn--ghost" onClick={() => void probe()}>Check before paying</button> : null}
      {row.s === 'busy' ? <p className="ds-busy" role="status"><span className="rn-spin" aria-hidden />{row.note}</p> : null}
      {row.s === 'error' ? <p className="ds-err" role="alert">{row.msg}</p> : null}
      {p && verdict ? (
        <div className="ds-mini" data-testid="service-verdict" data-verdict={verdict}>
          <Stamp verdict={verdict} />
          <span className="ds-note">{p.decision.why}</span>
        </div>
      ) : null}
      {p?.selected ? <p className="ds-note">Pays <code>{midTruncate(p.selected.pay_to, 6, 6)}</code> · {p.selected.amount_ccd} CCD</p> : null}
      {row.s === 'probed' && svc.needs_age && !ageOk ? <AgeGate sellerId={svc.id} onVerified={() => setAgeOk(true)} /> : null}
      {row.s === 'probed' && ageOk && row.p.decision.action === 'pay' ? <button className="ds-btn" onClick={() => void buy(false)}>Pay once</button> : null}
      {row.s === 'probed' && ageOk && row.p.decision.action === 'ask_human' ? (
        <HumanGate
          outcome={row.p.decision.outcome === 'close_match' ? 'close_match' : row.p.decision.outcome === 'match' ? 'match_unbound' : 'not_possible'}
          why={row.p.decision.why}
          facts={[
            { label: 'Service', value: svc.name },
            { label: 'Pays', value: row.p.selected ? midTruncate(row.p.selected.pay_to, 8, 8) : 'unknown' },
            { label: 'Amount', value: `${row.p.selected?.amount_ccd ?? svc.price_ccd} CCD, once` },
            { label: 'Paid by', value: 'PayOnce reference buyer' },
          ]}
          confirmLabel="Pay once anyway"
          onApprove={() => void buy(true)}
          onDecline={() => setRow({ s: 'declined', p: row.p })}
        />
      ) : null}
      {row.s === 'probed' && row.p.decision.action === 'refuse' ? <p className="ds-note">The agent pays nothing.</p> : null}
      {row.s === 'declined' ? <p className="ds-note">You decided not to pay. Nothing was sent.</p> : null}
      {row.s === 'bought' ? (
        <>
          {row.b.paid ? <p className="ds-note">Paid once{row.b.tx_hash ? <> · <a className="ds-tx" href={EXPLORER_TX + row.b.tx_hash} target="_blank" rel="noreferrer">tx <code>{midTruncate(row.b.tx_hash, 6, 6)}</code> ↗</a></> : null}</p> : <p className="ds-note">{row.b.note ?? 'Nothing was paid.'}</p>}
          {row.b.response_preview ? <pre className="ds-preview">{row.b.response_preview}</pre> : null}
        </>
      ) : null}
    </li>
  )
}

export function Services() {
  const q = useQuery({ queryKey: ['x402-sellers'], queryFn: dashApi.x402Sellers, staleTime: 60_000 })
  if (q.isLoading) return <p className="ds-busy" role="status"><span className="rn-spin" aria-hidden />Loading services…</p>
  if (q.isError || !q.data) return <p className="ds-err" role="alert">The service list did not load.</p>
  return (
    <>
      <p className="ds-note">Built by other teams. {q.data.policy.payer}. Cap {q.data.policy.max_ccd_per_purchase} CCD per purchase.</p>
      <ul className="ds-svc">{q.data.sellers.map((s) => <Service key={s.id} svc={s} />)}</ul>
    </>
  )
}
