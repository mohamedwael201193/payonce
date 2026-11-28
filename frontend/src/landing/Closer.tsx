import { motion, useReducedMotion, useScroll, useTransform } from 'framer-motion'
import { useRef } from 'react'
import { Link } from 'react-router-dom'
import { RECORDED_FEES } from '../lib/recorded'
import { Magnetic, Rise } from './bits'
import { Mark } from './Nav'
import { formatDay, instanceUrl, type Snapshot } from './data'
import { goTo } from './scroll'

const ccdPay = RECORDED_FEES.find((f) => f.step === 'Pay in CCD' && f.note === 'success')

export function faqItems(s: Snapshot): { q: string; a: string }[] {
  const date = formatDay(s.recorded_run_date ?? s.captured_at)
  const fee = ccdPay ? `${ccdPay.min.toFixed(1)}` : null
  return [
    {
      q: 'Does PayOnce keep my money?',
      a: 'No. The payment goes straight to the registered payee in the same transaction, and the verifier checks that the registry holds nothing afterwards.',
    },
    {
      q: 'What decides Match or No match?',
      a: 'Code, not the language model. The agent may read and plan, but the checks run against the chain: approved seller, registered payee account, document hash, invoice status. Today one server key both checks and signs; a second, independent signer is planned and not live yet.',
    },
    {
      q: 'What if someone edits the invoice?',
      a: 'The SHA-256 of the document is stored on chain. A copy with one changed character hashes differently, the verifier check fails, and no payment is sent. The tamper test above shows it with the real document.',
    },
    {
      q: 'Is any of this real money?',
      a: 'No. Everything runs on the Concordium testnet with demo identities. CCD here is testnet CCD and EUDemo is a testnet demo token with no value. Receipts are not legal invoices or tax documents.',
    },
    {
      q: 'What does one payment cost?',
      a: fee
        ? `In the recorded run of ${date}, a successful CCD payment cost ${fee} testnet CCD in network fees, more than the 0.5 CCD invoice. Fees vary per transaction. They are testnet fees, not an estimate for any other network.`
        : 'Each transaction pays a network fee in testnet CCD. The recorded run lists the fee for every step on the judges page.',
    },
  ]
}

export function Faq({ snapshot }: { snapshot: Snapshot }) {
  const items = faqItems(snapshot)
  return (
    <section className="po-faq po-section" id="faq" aria-label="Questions">
      <div className="po-wrap po-faq__grid">
        <Rise as="h2" text={'Questions a\nsceptic asks'} className="po-h2" />
        <div className="po-faq__list">
          {items.map((it, i) => (
            <details key={it.q} className="po-faq__item" {...(i === 0 ? { open: true } : {})}>
              <summary>
                <span>{it.q}</span>
                <i aria-hidden />
              </summary>
              <p>{it.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  )
}

/** Section 9: inset call to action that opens to full width as it arrives, then the footer. */
export function Closer() {
  const ref = useRef<HTMLElement>(null)
  const still = useReducedMotion()
  const { scrollYProgress } = useScroll({ target: ref, offset: ['start end', 'start 0.35'] })
  const clip = useTransform(scrollYProgress, [0, 1], ['inset(0% 5% round 40px)', 'inset(0% 0% round 0px)'])
  return (
    <>
      <section ref={ref} className="po-final" aria-label="Run it on a real invoice">
        <motion.div className="po-final__card" style={still ? undefined : { clipPath: clip }} data-dark>
          <div className="po-final__in">
            <Rise as="h2" text={'Check who it pays.\nThen pay once.'} className="po-final__h" />
            <p className="po-final__p">Testnet only. Get a real invoice, watch the agent decide Match or No match, and pay it once.</p>
            <div className="po-cta-row">
              <Magnetic>
                <Link to="/app" className="po-btn po-btn--light">
                  Run it on a real invoice
                </Link>
              </Magnetic>
              <Link to="/app/proof/judges" className="po-btn po-btn--ghost">
                Open the judges page
              </Link>
            </div>
          </div>
        </motion.div>
      </section>
    </>
  )
}

export function Footer({ snapshot }: { snapshot: Snapshot }) {
  const reg = snapshot.config?.registry
  return (
    <>
      <footer className="po-foot">
        <div className="po-wrap po-foot__grid">
          <div className="po-foot__brand">
            <a href="#top" onClick={(e) => goTo('#top') && e.preventDefault()} className="po-nav__brand" aria-label="PayOnce, top of page">
              <Mark />
              <span>PayOnce</span>
            </a>
            <p>
              Testnet only. Demo identities and test tokens: CCD here is testnet CCD and EUDemo is a testnet demo token
              with no value. A receipt is not a legal invoice or a tax document. Nothing here is financial advice.
            </p>
          </div>
          <nav aria-label="Product">
            <h3>Product</h3>
            <ul>
              <li>
                <Link to="/app">Run it on a real invoice</Link>
              </li>
              <li>
                <Link to="/app/proof/break">Try to fool it</Link>
              </li>
              <li>
                <Link to="/app/proof/judges">For judges</Link>
              </li>
            </ul>
          </nav>
          <nav aria-label="Sources">
            <h3>Sources</h3>
            <ul>
              <li>
                <a href="https://github.com/mohamedwael201193/payonce" target="_blank" rel="noreferrer">
                  Source code
                </a>
              </li>
              {reg && (
                <li>
                  <a href={instanceUrl(reg.index, reg.subindex)} target="_blank" rel="noreferrer">
                    Registry on the explorer
                  </a>
                </li>
              )}
              <li>
                <a href="/landing/snapshot.json">Recorded snapshot (JSON)</a>
              </li>
            </ul>
          </nav>
        </div>
      </footer>
    </>
  )
}
