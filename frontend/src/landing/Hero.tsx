import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router-dom'
import { Clouds } from './Clouds'
import { EASE, Magnetic, Rise, Tag } from './bits'
import { formatDay, formatStamp, headline, type LandingData } from './data'
import { inScope } from '../lib/dashboard'
import { goTo } from './scroll'
import { HeroIdentity } from './HeroIdentity'
import { AgentInboxPanel } from './AgentInbox'

export const HERO_H1 = 'The agent pays your inbox.\nSafely, exactly once.'
export const HERO_LEAD = 'Each invoice is checked against the chain before money moves: a changed payee, an edited file or an unknown seller is refused. The rest are paid once.'

function Arrow() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="po-btn__arrow">
      <path d="M3 8h10M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function Gauge({ pct }: { pct: number }) {
  const still = useReducedMotion()
  return (
    <svg viewBox="0 0 120 70" className="po-gauge" role="img" aria-label={`${pct} percent of payables are paid`}>
      <path d="M12 62 A48 48 0 0 1 108 62" className="po-gauge__track" pathLength={100} />
      <motion.path
        d="M12 62 A48 48 0 0 1 108 62"
        className="po-gauge__fill"
        pathLength={100}
        strokeDasharray="100 100"
        initial={{ strokeDashoffset: still ? 100 - pct : 100 }}
        animate={{ strokeDashoffset: 100 - pct }}
        transition={{ duration: 1.4, ease: EASE, delay: 0.9 }}
      />
    </svg>
  )
}

/** The floating product panel: real rows from the registry, tagged with where they came from. */
export function HeroPanel({ data }: { data: LandingData }) {
  const { stats, invoices, source, at } = data
  const h = headline(stats)
  const pct = h.pct
  // Demo invoices and anything ready to pay lead; the automated test runs are counted apart (see the note).
  const shown = useMemo(() => invoices.filter((i) => inScope(i, 'default')), [invoices])
  const rows = useMemo(() => {
    const byId = [...shown].sort((a, b) => b.payable_id - a.payable_id)
    const paid = byId.filter((i) => i.status === 'paid').slice(0, 4)
    const open = byId.filter((i) => i.status === 'unpaid').slice(0, 2)
    return [paid[0], open[0], paid[1], paid[2], open[1], paid[3]].filter(Boolean)
  }, [shown])
  const ccd = shown.filter((i) => i.status === 'paid' && i.asset === 'ccd').length
  const eud = shown.filter((i) => i.status === 'paid' && i.asset === 'eudemo').length
  const railMax = Math.max(1, ccd, eud)

  return (
    <div className="po-panel" data-testid="hero-panel">
      <div className="po-panel__bar">
        <strong>Payables</strong>
        <span className="po-chip">Testnet</span>
        <span className="po-panel__spacer" />
        {source === 'live' ? (
          <Tag kind="live">Live, {formatStamp(at).slice(-9)}</Tag>
        ) : (
          <Tag kind="recorded">Recorded snapshot, {formatStamp(at)}</Tag>
        )}
      </div>
      <div className="po-panel__grid">
        <div className="po-panel__main">
          <dl className="po-metrics">
            <div>
              <dt>{h.split ? 'Demo invoices' : 'Payables'}</dt>
              <dd>{h.total}</dd>
            </div>
            <div>
              <dt>Paid once</dt>
              <dd>
                {h.paid}
                <small>{pct}%</small>
              </dd>
            </div>
            <div>
              <dt>Refused on chain</dt>
              <dd>{stats.refused_on_chain_since_deploy}</dd>
            </div>
          </dl>
          <table className="po-table">
            <thead>
              <tr>
                <th scope="col">Invoice</th>
                <th scope="col" className="po-hide-sm">
                  Due
                </th>
                <th scope="col">Amount</th>
                <th scope="col">Status</th>
                <th scope="col">
                  <span className="po-sr">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={`${r.seller}-${r.payable_id}`}>
                  <td className="po-mono">#{r.payable_id}</td>
                  <td className="po-hide-sm">{formatDay(r.due)}</td>
                  <td>{r.amount_display}</td>
                  <td>
                    <span className={`po-status po-status--${r.status}`}>{r.status === 'paid' ? 'Paid once' : 'Unpaid'}</span>
                  </td>
                  <td className="po-table__act">
                    {r.status === 'unpaid' ? (
                      <Link to={`/app/pay/${r.seller}/${r.payable_id}`}>Pay</Link>
                    ) : (
                      <Link to={`/app/receipt/${r.seller}/${r.payable_id}`}>Receipt</Link>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {h.split ? (
            <p className="po-panel__note" data-testid="hero-scope-note">
              Demo invoices and ready-to-pay ones. {h.testTotal} automated test runs ({h.testPaid} paid) on the same registry are counted apart.
            </p>
          ) : null}
        </div>
        <aside className="po-panel__side" aria-label="Paid share and rails">
          <section className="po-card">
            <h3>Paid once</h3>
            <div className="po-gauge-wrap">
              <Gauge pct={pct} />
              <div className="po-gauge__num">{pct}%</div>
            </div>
            <p>
              {h.paid} of {h.total} {h.split ? 'demo invoices' : 'payables'}
            </p>
          </section>
          <section className="po-card">
            <h3>Paid by rail</h3>
            <ul className="po-rails">
              <li>
                <span>CCD rail</span>
                <b>{ccd}</b>
                <i style={{ transform: `scaleX(${ccd / railMax})` }} />
              </li>
              <li>
                <span>EUDemo rail</span>
                <b>{eud}</b>
                <i style={{ transform: `scaleX(${eud / railMax})` }} />
              </li>
            </ul>
          </section>
        </aside>
      </div>
    </div>
  )
}

export function Hero({ data }: { data: LandingData }) {
  const { scrollY } = useScroll()
  const sink = useTransform(scrollY, [0, 700], [0, 56])
  const reduced = useReducedMotion()
  // The page shell already painted this hero as plain HTML (index.html). Mount
  // in the final state so nothing jumps, then fade the shell away.
  const [booted] = useState(() => typeof document !== 'undefined' && !!document.getElementById('po-boot'))
  const still = reduced || booted
  useEffect(() => {
    const boot = document.getElementById('po-boot')
    if (!boot) return
    let t = 0
    const r = requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        boot.style.opacity = '0'
        boot.style.pointerEvents = 'none'
        t = window.setTimeout(() => boot.remove(), 400)
      }),
    )
    return () => {
      cancelAnimationFrame(r)
      window.clearTimeout(t)
    }
  }, [])
  const { stats, source, at } = data
  const h = headline(stats)
  return (
    <section className="po-hero" id="top" aria-labelledby="po-h1">
      <div className="po-hero__sky">
        <Clouds mode="back" bank={470} className="po-hero__cv" />
      </div>
      <div className="po-hero__copy">
        <Rise as="h1" text={HERO_H1} className="po-h1" onLoad instant={booted} delay={0.15} />
        <motion.p
          className="po-lead"
          initial={still ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE, delay: 0.55 }}
        >
          {HERO_LEAD}
        </motion.p>
        <motion.div
          className="po-cta-row"
          initial={still ? false : { opacity: 0, y: 14 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.8, ease: EASE, delay: 0.7 }}
        >
          <Magnetic>
            <Link to="/app/agent" className="po-btn po-btn--light">
              Watch the agent pay
              <Arrow />
            </Link>
          </Magnetic>
          <Link to="/app/break" className="po-btn po-btn--ghost">
            Try to break it
          </Link>
          <a
            href="#how"
            className="po-hero__how"
            onClick={(e) => {
              if (goTo('#how')) e.preventDefault()
            }}
          >
            See how it works
          </a>
        </motion.div>
        <motion.p
          className="po-status-line"
          initial={still ? false : { opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.8, delay: 0.95 }}
        >
          {source === 'live' ? <Tag kind="live" dark /> : <Tag kind="recorded" dark>Recorded snapshot</Tag>}
          <span>
            Testnet: {h.paid} of {h.total} {h.split ? 'demo invoices' : 'payables'} paid once
            {h.split ? `, ${h.testTotal} automated test runs counted apart` : ''}
            {source === 'snapshot' ? `, as of ${formatStamp(at)}` : ''}
          </span>
        </motion.p>
      </div>
      <motion.div className="po-hero__panel po-hero__panel--inbox" style={{ y: still ? 0 : sink }}>
        <motion.div
          initial={still ? false : { opacity: 0, y: 48 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 1.1, ease: EASE, delay: 0.55 }}
        >
          <AgentInboxPanel />
          <HeroIdentity />
        </motion.div>
      </motion.div>
      <div className="po-hero__front" aria-hidden>
        <Clouds mode="front" bank={280} className="po-hero__cv" />
      </div>
    </section>
  )
}
