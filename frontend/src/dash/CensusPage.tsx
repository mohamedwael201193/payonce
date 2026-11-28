// /app/proof/census: how many registered Concordium agents meet the PRECONDITIONS of a payee check today.
// Wording follows tools/census/METHOD.md: an upper bound, never "verified/safe"; definitions beside the numbers.
import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { motion, useReducedMotion } from 'framer-motion'
import { useDocumentTitle } from '../app/hooks'
import { dashApi, VERDICT_TEXT, type Census, type CensusNet } from './contracts'
import './dash.css'

const n = (v: number) => v.toLocaleString('en-US')
const METHOD_URL = 'https://github.com/mohamedwael201193/payonce/blob/main/tools/census/METHOD.md'
type Net = 'mainnet' | 'testnet'

/** The headline sentence, exactly as METHOD.md allows it. */
export function headline(net: Net, d: CensusNet): string {
  return `At most ${n(d.agents_that_pass_vop_today)} of ${n(d.agents_total)} registered agents on ${net} meet the preconditions of a Verification-of-Payee check today.`
}

function Funnel({ d }: { d: CensusNet }) {
  const still = useReducedMotion()
  const rows = [
    { k: 'Registered', v: d.agents_total, note: 'tokens listed by the registry' },
    { k: 'Active', v: d.active, note: '' },
    { k: 'Valid badge (registry’s own check)', v: d.badge_valid_official, note: '' },
    { k: 'Payee on a business identity', v: d.agents_that_pass_vop_today, note: 'badge valid AND payee set AND Global FinReg identity' },
  ]
  return (
    <ol className="ds-funnel" aria-label="From registered agents to the preconditions of a payee check">
      {rows.map((r, i) => {
        const w = Math.max(0.8, (r.v / d.agents_total) * 100)
        return (
          <li key={r.k}>
            <div className="ds-funnel__lab"><span>{r.k}</span><b className="tabular">{n(r.v)}</b></div>
            <div className="ds-funnel__bar"><motion.i className={i === rows.length - 1 ? 'is-last' : ''} initial={still ? false : { width: 0 }} animate={{ width: `${w}%` }} transition={{ delay: 0.15 + i * 0.18, duration: 0.8, ease: [0.16, 1, 0.3, 1] }} /></div>
            {r.note ? <small>{r.note}</small> : null}
          </li>
        )
      })}
    </ol>
  )
}

function Definitions({ c, net }: { c: Census; net: Net }) {
  const d = c.networks[net]
  return (
    <section className="ds-card" aria-labelledby="defs">
      <h2 className="ds-h2" id="defs">Definitions</h2>
      <dl className="ds-defs">
        <dt>Preconditions (“pass”)</dt>
        <dd>{c.vop_rule}. It is an <b>upper bound</b>: a real Match also needs the legal name proven or signed by the payee, and equal to the invoice name. Nobody outside PayOnce has that today.</dd>
        <dt>Payee</dt>
        <dd>The registry’s <code>agentWallet</code>, or the owner when none is set. The registry defaults it to the owner at registration, so “payee equals owner” ({n(d.payee_equals_owner_default)}) is mostly the default, not a choice.</dd>
        <dt>Owners</dt>
        <dd>{n(d.distinct_owners)} distinct owner accounts. Accounts, not people or companies: one company can hold many.</dd>
        <dt>Population</dt>
        <dd>The tokens the registry listed for {net} when the census ran ({n(d.agents_total)}). It is not “all Concordium agents”.</dd>
        <dt>x402 mentions</dt>
        <dd>{n(d.cards_mentioning_x402_text)} agent cards contain the text “x402”. A crude text match, an upper bound, not proof of a working payment endpoint.</dd>
        <dt>Identity data</dt>
        <dd>Read from CCDExplorer’s public account pages, not re-verified on chain from this site. {net === 'testnet' ? 'Testnet business identities are weak evidence: the testnet issuer approves automatically.' : 'Mainnet business identities are real company verification.'}</dd>
      </dl>
    </section>
  )
}

export function CensusPage() {
  useDocumentTitle('Who could be verified today')
  const [net, setNet] = useState<Net>('mainnet')
  const q = useQuery({ queryKey: ['census'], queryFn: dashApi.census, staleTime: 5 * 60_000 })
  const c = q.data
  const d = c?.networks[net]
  const live = net === 'testnet' ? c?.check_payee_live_on_testnet_payees : c?.check_payee_live_on_mainnet_payees
  return (
    <div className="ds ds-census" data-testid="census">
      <header className="ds-hero ds-hero--slim">
        <p className="ds-crumb"><Link to="/app/proof">Proof</Link> · Census</p>
        <h1 className="ds-h1">{d && c ? headline(net, d) : 'Who could be verified today'}</h1>
        <p className="ds-lead">A count of preconditions, not a judgement of any agent.</p>
        <div className="ds-toggle ds-toggle--on-sky" role="radiogroup" aria-label="Network">
          {(['mainnet', 'testnet'] as const).map((k) => (
            <button key={k} role="radio" aria-checked={net === k} className={net === k ? 'is-on' : ''} onClick={() => setNet(k)}>{k === 'mainnet' ? 'Mainnet' : 'Testnet'}</button>
          ))}
        </div>
      </header>
      <div className="ds-body ds-body--stack">
        {q.isLoading ? <section className="ds-card"><p className="ds-busy" role="status"><span className="rn-spin" aria-hidden />Loading the census…</p></section> : null}
        {q.isError ? <section className="ds-card"><p className="ds-err" role="alert">The census did not load. <button className="ds-link-btn" onClick={() => void q.refetch()}>Try again</button></p></section> : null}
        {c && d ? (
          <>
            <section className="ds-card">
              <p className="ds-meta">
                <span className="ds-badge">SNAPSHOT</span>
                Taken {new Date(c.generated_at_utc).toUTCString().replace(' GMT', ' UTC')}
                {c.served.age_hours != null ? `, ${c.served.age_hours < 1 ? 'under an hour' : `${Math.round(c.served.age_hours)} h`} ago` : ''}. Refreshed every 6 hours.
                {c.served.stale ? <b className="ds-stale"> Stale.</b> : null}
              </p>
              <Funnel d={d} />
              <div className="ds-stats">
                <div><b className="tabular">{n(d.valid_badge_but_payee_has_only_personal_identity_or_none)}</b><span>valid badge, but the payee has only a personal identity (or none)</span></div>
                <div><b className="tabular">{n(d.payee_not_set)}</b><span>no payee set</span></div>
                <div><b className="tabular">{n(d.distinct_owners_with_business_id)}</b><span>of {n(d.distinct_owners)} owner accounts hold a business identity</span></div>
              </div>
            </section>

            {live ? (
              <section className="ds-card">
                <h2 className="ds-h2">We ran the check on them</h2>
                <p className="ds-note">PayOnce’s <code>check_payee</code> on {n(live.accounts_checked)} {net} payee accounts, using each agent’s card name as the invoice name.{net === 'mainnet' ? ' Mainnet is identity-only: it can never answer Match.' : ''}</p>
                <ul className="ds-verdicts">
                  {Object.entries(live.verdicts).map(([v, k]) => (
                    <li key={v}><b className="tabular">{n(k)}</b><span>{VERDICT_TEXT[v as keyof typeof VERDICT_TEXT]?.word ?? v}</span></li>
                  ))}
                </ul>
                <p className="ds-note">{live.note}</p>
              </section>
            ) : null}

            <section className="ds-card">
              <h2 className="ds-h2">Paid services found</h2>
              <p className="ds-note">
                {c.x402_sellers.answering_402} of {c.x402_sellers.endpoints_probed} endpoints answered with a payment request; {c.x402_sellers.concordium_endpoints_checked} asked to be paid on Concordium. Never paid. A lower bound: cards that do not advertise an endpoint are missed. Counts, not percentages.
              </p>
              <ul className="ds-rows">
                {c.x402_sellers.rows.map((r) => (
                  <li key={r.endpoint + r.payTo + r.asset}>
                    <span className="ds-rows__host">{new URL(r.endpoint).host}</span>
                    <span>{r.network} · {Number(r.amount) / 1e6} {r.asset}</span>
                    <span className={`ds-pill ds-pill--${VERDICT_TEXT[r.check_payee_verdict]?.tone ?? 'warn'}`}>{VERDICT_TEXT[r.check_payee_verdict]?.word ?? r.check_payee_verdict}</span>
                  </li>
                ))}
              </ul>
              <p className="ds-note">{c.x402_sellers.payTo_with_business_identity} of these receive on a business identity.</p>
            </section>

            <Definitions c={c} net={net} />
            <p className="ds-note ds-foot">
              Method and limits: <a href={METHOD_URL} target="_blank" rel="noreferrer">METHOD.md</a> · Data: <a href="/api/census">/api/census</a> · Read-only, public data, no keys.
            </p>
          </>
        ) : null}
      </div>
    </div>
  )
}
