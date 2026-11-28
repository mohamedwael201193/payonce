import { motion, useInView, useReducedMotion } from 'framer-motion'
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { RECORDED_REFUSALS } from '../lib/recorded'
import { EASE, EASE_INOUT, Rise, Tag } from './bits'
import { formatDay, shortHash, txUrl, type LandingData } from './data'

function Diagram({ code, name, registry }: { code: number; name: string; registry: string }) {
  const ref = useRef<SVGSVGElement>(null)
  const seen = useInView(ref, { once: true, amount: 0.5 })
  const still = useReducedMotion()
  const on = seen || !!still
  const draw = (delay: number, d = 0.8) => ({
    initial: { strokeDashoffset: still ? 0 : 1 },
    animate: { strokeDashoffset: on ? 0 : 1 },
    transition: { duration: d, ease: EASE_INOUT, delay: still ? 0 : delay },
  })
  return (
    <svg
      ref={ref}
      viewBox="0 0 560 250"
      className="po-diagram"
      role="img"
      aria-label={`A second payment request reaches the registry contract and is refused with code ${code}, ${name}. The line to the payee never draws.`}
    >
      <rect x="8" y="88" width="132" height="74" rx="12" className="po-diagram__node" />
      <text x="74" y="121" className="po-diagram__t" textAnchor="middle">
        Second
      </text>
      <text x="74" y="142" className="po-diagram__t" textAnchor="middle">
        payment
      </text>
      <rect x="214" y="88" width="132" height="74" rx="12" className="po-diagram__node po-diagram__node--hot" />
      <text x="280" y="121" className="po-diagram__t" textAnchor="middle">
        Registry
      </text>
      <text x="280" y="142" className="po-diagram__m" textAnchor="middle">
        {registry}
      </text>
      <rect x="420" y="88" width="132" height="74" rx="12" className="po-diagram__node" />
      <text x="486" y="121" className="po-diagram__t" textAnchor="middle">
        Payee
      </text>
      <text x="486" y="142" className="po-diagram__m" textAnchor="middle">
        unchanged
      </text>
      <motion.path d="M142 125 H212" className="po-diagram__line" pathLength={1} strokeDasharray="1 1" {...draw(0.2, 0.7)} />
      <path d="M348 125 H418" className="po-diagram__ghost" />
      <motion.g
        initial={{ opacity: still ? 1 : 0 }}
        animate={{ opacity: on ? 1 : 0 }}
        transition={{ duration: 0.4, delay: still ? 0 : 1 }}
      >
        <path d="M372 112 L394 138 M394 112 L372 138" className="po-diagram__x" />
      </motion.g>
      <motion.path
        d="M280 164 V206"
        className="po-diagram__line po-diagram__line--bad"
        pathLength={1}
        strokeDasharray="1 1"
        {...draw(0.9, 0.5)}
      />
      <motion.text
        x="280"
        y="232"
        textAnchor="middle"
        className="po-diagram__bad"
        initial={{ opacity: still ? 1 : 0 }}
        animate={{ opacity: on ? 1 : 0 }}
        transition={{ duration: 0.5, delay: still ? 0 : 1.3 }}
      >
        {`Refused: ${name} (${code})`}
      </motion.text>
    </svg>
  )
}

/** Section 5: dark stage. A real refused-transaction log, an SVG diagram, and a way in. */
export function Stage({ data }: { data: LandingData }) {
  const { snapshot, stats } = data
  const date = formatDay(snapshot.recorded_run_date ?? snapshot.captured_at)
  const first = RECORDED_REFUSALS[0]
  const reg = snapshot.config ? `<${snapshot.config.registry.index},${snapshot.config.registry.subindex}>` : '<13150,0>'
  return (
    <section className="po-stage po-section" id="break" data-dark aria-label="Try to break it">
      <div className="po-stage__grain" aria-hidden />
      <div className="po-wrap po-stage__grid">
        <div className="po-stage__copy">
          <Rise as="h2" text={'Try to break it.\nThe chain says no.'} className="po-h2" />
          <p className="po-p">
            Pay an invoice twice, change the amount, point it at an invoice that does not exist. In our recorded run the
            registry contract refused all {RECORDED_REFUSALS.length} attempts and nothing moved. Some attacks are stopped
            earlier by the policy gate; the break page says which layer refused each one.
          </p>
          <p className="po-stage__count">
            <span className="po-mono">{stats.refused_on_chain_since_deploy}</span> refusals counted by the API since its
            last deploy, including our own tests.
          </p>
          <Diagram code={first.code} name={first.name} registry={reg} />
          <Link to="/app/break" className="po-btn po-btn--light">
            Try to break it yourself
          </Link>
        </div>
        <div className="po-log" role="group" aria-label={`Refused transactions, recorded run, ${date}`}>
          <header>
            <strong>Refused on chain, testnet</strong>
            <Tag kind="recorded" dark>
              Recorded run, {date}
            </Tag>
          </header>
          <ol>
            {RECORDED_REFUSALS.map((r, i) => (
              <motion.li
                key={r.txHash}
                initial={{ opacity: 0, x: -10 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.8 }}
                transition={{ duration: 0.5, ease: EASE, delay: (i % 4) * 0.06 }}
              >
                <span className="po-log__code po-mono">
                  {r.code} {r.name}
                </span>
                <span className="po-log__plain">{r.plain}</span>
                <a className="po-mono po-log__tx" href={txUrl(r.txHash)} target="_blank" rel="noreferrer">
                  {shortHash(r.txHash)}
                </a>
              </motion.li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  )
}
