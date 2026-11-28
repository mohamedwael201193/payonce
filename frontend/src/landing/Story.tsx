import { AnimatePresence, motion, useMotionValueEvent, useReducedMotion, useScroll } from 'framer-motion'
import { useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { EASE, Rise, SvgCheck, Tag, useMedia } from './bits'
import { formatDay, formatStamp, shortHash, txUrl, type Snapshot } from './data'

export const STORY_STEPS: { title: string; body: string }[] = [
  {
    title: 'The seller registers who to pay.',
    body: 'A seller agent on the official Concordium agent registry puts the invoice on chain: payee account, amount, due date and the SHA-256 of the document.',
  },
  {
    title: 'Your agent checks who it’s paying.',
    body: 'Is the seller one you approved? Is the account on the invoice the one the seller registered? Is the document the one on chain? All yes is a Match. Anything else is No match.',
  },
  {
    title: 'No match: nothing moves. Match: paid once.',
    body: 'On no match the agent stops and says why. On a match it pays the exact amount to the registered account, and the contract refuses a second payment.',
  },
  {
    title: 'Anyone can read the receipt.',
    body: 'The receipt links every transaction on the explorer and shows the verifier result for the payment.',
  },
]

function TxLink({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="po-mono po-link" href={txUrl(hash)} target="_blank" rel="noreferrer">
      {label ? `${label} ` : ''}
      {shortHash(hash)}
    </a>
  )
}

function usePicks(s: Snapshot) {
  return useMemo(() => {
    const facts = s.facts
    const ccd = s.receipts.find((r) => /CCD/.test(r.amount_display) && !/EUDemo/.test(r.amount_display))
    const eud = s.receipts.find((r) => /EUDemo/.test(r.amount_display))
    const mine = facts ? s.receipts.find((r) => r.payable_id === facts.payable_id && r.seller === facts.seller) : undefined
    const reg = s.recorded_steps?.steps.find((x) => x.step === 'register')?.txHash ?? null
    const pay = s.recorded_steps?.steps.find((x) => x.step === 'pay')?.txHash ?? null
    return { facts, ccd, eud, mine, reg, pay }
  }, [s])
}

export function StoryPreview({ step, snapshot }: { step: number; snapshot: Snapshot }) {
  const { facts, ccd, eud, mine, reg, pay } = usePicks(snapshot)
  const v = snapshot.verify
  if (step === 0 && facts) {
    return (
      <div className="po-pv">
        <header>
          <strong>Payable {facts.payable_id}</strong>
          <Tag kind="recorded">Recorded run, {formatDay(snapshot.recorded_run_date ?? snapshot.captured_at)}</Tag>
        </header>
        <dl className="po-kv">
          <div>
            <dt>Payee</dt>
            <dd className="po-mono">{facts.payee}</dd>
          </div>
          <div>
            <dt>Amount</dt>
            <dd>{facts.amount_display}</dd>
          </div>
          <div>
            <dt>Due</dt>
            <dd>{formatDay(facts.due)}</dd>
          </div>
          <div>
            <dt>Document SHA-256</dt>
            <dd className="po-mono">{facts.doc_sha256}</dd>
          </div>
          {reg && (
            <div>
              <dt>Register transaction</dt>
              <dd>
                <TxLink hash={reg} />
              </dd>
            </div>
          )}
        </dl>
      </div>
    )
  }
  if (step === 1 && v) {
    return (
      <div className="po-pv">
        <header>
          <strong>Verifier checks</strong>
          <Tag kind="recorded">Recorded {formatStamp(v.checked_at)}</Tag>
        </header>
        <ul className="po-pv__checks">
          {v.checks.slice(0, 7).map((c, i) => (
            <li key={c.id}>
              <SvgCheck on delay={i * 0.12} />
              <span>{c.label}</span>
            </li>
          ))}
        </ul>
        <p className="po-pv__note">
          {v.passed} of {v.total} passed. Run on payable {v.payable_id} after it was paid; the same checks gate a payment before it.
        </p>
      </div>
    )
  }
  if (step === 2) {
    return (
      <div className="po-pv">
        <header>
          <strong>Two rails</strong>
          <Tag kind="recorded">Real testnet transactions</Tag>
        </header>
        <div className="po-rail2">
          <div>
            <h4>CCD rail</h4>
            <p>The contract call carries the CCD to the payee in one transaction.</p>
            {(ccd?.txs ?? []).slice(0, 1).map((t) => (
              <TxLink key={t.tx_hash} hash={t.tx_hash} label={t.label} />
            ))}
            {!ccd && pay && <TxLink hash={pay} label="Payment" />}
          </div>
          <div>
            <h4>EUDemo rail</h4>
            <p>A co-signed transfer of the demo token, after the chain reserved the invoice.</p>
            {(eud?.txs ?? []).slice(0, 3).map((t) => (
              <TxLink key={t.tx_hash} hash={t.tx_hash} label={t.label} />
            ))}
          </div>
        </div>
      </div>
    )
  }
  const r = mine ?? ccd
  if (r) {
    return (
      <div className="po-pv">
        <header>
          <strong>Receipt, payable {r.payable_id}</strong>
          <span className="po-status po-status--paid">Paid once</span>
        </header>
        <dl className="po-kv">
          <div>
            <dt>Amount</dt>
            <dd>{r.amount_display}</dd>
          </div>
          <div>
            <dt>Payee</dt>
            <dd className="po-mono">{r.payee}</dd>
          </div>
          {r.txs.map((t) => (
            <div key={t.tx_hash}>
              <dt>{t.label}</dt>
              <dd>
                <TxLink hash={t.tx_hash} />
              </dd>
            </div>
          ))}
          {r.verifier && (
            <div>
              <dt>Verifier</dt>
              <dd>
                {r.verifier.passed} of {r.verifier.total} checks, {formatStamp(r.verifier.checked_at)}
              </dd>
            </div>
          )}
        </dl>
        <Link className="po-btn po-btn--line po-btn--sm" to={`/app/receipt/${r.seller}/${r.payable_id}`}>
          Open this receipt
        </Link>
      </div>
    )
  }
  return null
}

/** Section 3: pinned scroll story. Pinned on desktop, stacked with inline previews on small screens. */
export function Story({ snapshot }: { snapshot: Snapshot }) {
  const ref = useRef<HTMLElement>(null)
  const wide = useMedia('(min-width: 900px)', true)
  const still = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start start', 'end end'] })
  const [step, setStep] = useState(0)
  useMotionValueEvent(scrollYProgress, 'change', (p) =>
    setStep(Math.min(STORY_STEPS.length - 1, Math.max(0, Math.floor(p * STORY_STEPS.length * 0.999)))),
  )
  const pinned = wide && !still

  const steps = (
    <ol className="po-story__steps">
      {pinned && <motion.span className="po-story__bar" style={{ scaleY: scrollYProgress }} aria-hidden />}
      {STORY_STEPS.map((s, i) => (
        <li key={s.title} className={`po-step${i === step || !pinned ? ' is-on' : ''}`}>
          <span className="po-step__n">{i + 1}</span>
          <div>
            <h3>{s.title}</h3>
            <p>{s.body}</p>
            {!pinned && (
              <div className="po-story__inline">
                <StoryPreview step={i} snapshot={snapshot} />
              </div>
            )}
          </div>
        </li>
      ))}
    </ol>
  )

  return (
    <section ref={ref} className={`po-story${pinned ? ' is-pinned' : ''}`} id="how" aria-label="How it works">
      <div className="po-story__pin">
        <div className="po-wrap po-story__grid">
          <div className="po-story__copy">
            <Rise as="h2" text={'How your agent\nchecks who it pays'} className="po-h2" />
            {steps}
          </div>
          {pinned && (
            <div className="po-story__view">
              <AnimatePresence mode="wait">
                <motion.div
                  key={step}
                  initial={{ opacity: 0, y: 16 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                  transition={{ duration: 0.35, ease: EASE }}
                >
                  <StoryPreview step={step} snapshot={snapshot} />
                </motion.div>
              </AnimatePresence>
            </div>
          )}
        </div>
      </div>
    </section>
  )
}
