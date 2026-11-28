// /demo: the whole idea in six screens and about a minute. One button per
// screen, a few words each. The run comes from loadDemoRun(): a fresh real
// run when the API has one, otherwise a labelled replay of a recorded run.
import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { VerdictMark } from '../app/run/Visuals'
import { midTruncate } from '../app/Address'
import { useDocumentTitle } from '../app/hooks'
import { RECORDED_RUN, loadDemoRun, txUrl, type DemoRun } from './demoData'
import './demo.css'

const SCREENS = ['Which one?', 'Check', 'Pay once', 'Impostor', 'Twice?', 'Next'] as const
const short = (a: string) => midTruncate(a, 6, 6)

function Chip({ hash, label }: { hash: string; label?: string }) {
  return (
    <a className="dm-chip" href={txUrl(hash)} target="_blank" rel="noreferrer">
      {label ?? 'Transaction'} <span>{midTruncate(hash, 6, 6)}</span> <i aria-hidden>↗</i>
    </a>
  )
}

function Invoice({ account, tone, tag }: { account: string; tone: 'a' | 'b'; tag: string }) {
  return (
    <div className={`dm-inv dm-inv--${tone}`}>
      <div className="dm-inv__top"><b>Invoice</b><span>{tag}</span></div>
      <div className="dm-inv__line"><i /><i /></div>
      <div className="dm-inv__pay"><small>Pay to</small><code>{short(account)}</code></div>
    </div>
  )
}

function Ticks({ items, delay = 0.25 }: { items: string[]; delay?: number }) {
  const still = useReducedMotion()
  return (
    <ul className="dm-ticks">
      {items.map((t, i) => (
        <motion.li key={t} initial={still ? false : { opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }} transition={{ delay: delay + i * 0.35, duration: 0.4 }}>
          <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden><path d="M3.5 9.5l3.5 3.5 7.5-8" fill="none" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" /></svg>
          {t}
        </motion.li>
      ))}
    </ul>
  )
}

export function DemoPage() {
  useDocumentTitle('Demo')
  const [i, setI] = useState(0)
  const [run, setRun] = useState<DemoRun>(RECORDED_RUN)
  const still = useReducedMotion()

  useEffect(() => {
    const ac = new AbortController()
    void loadDemoRun(ac.signal).then((r) => setRun(r))
    return () => ac.abort()
  }, [])

  const next = () => setI((n) => Math.min(n + 1, SCREENS.length - 1))
  const imp = run.impostor

  let body: React.ReactNode
  switch (i) {
    case 0:
      body = (
        <>
          <h1 className="dm-h">Same invoice. Different account. Which one should your AI pay?</h1>
          <div className="dm-pair">
            <Invoice account={run.good.account} tone="a" tag={run.invoice.amount} />
            <Invoice account={imp.account} tone="b" tag={run.invoice.amount} />
          </div>
          <button className="dm-btn" onClick={next}>Run it</button>
        </>
      )
      break
    case 1:
      body = (
        <>
          <div className="dm-verdict dm-verdict--ok"><VerdictMark kind="match" size={84} /><h2 className="dm-h">Match</h2></div>
          <p className="dm-sub">The agent checked before paying.</p>
          <Ticks items={run.good.ticks} />
          <button className="dm-btn" onClick={next}>Pay</button>
        </>
      )
      break
    case 2:
      body = (
        <>
          <div className="dm-verdict dm-verdict--ok"><VerdictMark kind="paid" size={84} /><h2 className="dm-h">Paid once.</h2></div>
          <p className="dm-sub">{run.invoice.amount} to <code>{short(run.good.account)}</code>. On chain.</p>
          <Chip hash={run.paid.hash} label="Payment" />
          <button className="dm-btn" onClick={next}>Now the impostor</button>
        </>
      )
      break
    case 3:
      body = (
        <>
          <p className="dm-mail">“Our bank details changed. Please pay <code>{short(imp.account)}</code> instead.”</p>
          <div className="dm-verdict dm-verdict--bad"><VerdictMark kind="no_match" size={84} /><h2 className="dm-h">No match</h2></div>
          <p className="dm-sub">{imp.headline}</p>
          {imp.refusal ? (
            <>
              <p className="dm-sub">Forced anyway, the chain refused: {imp.refusal.name} ({imp.refusal.code}).</p>
              <Chip hash={imp.refusal.hash} label="Refusal" />
            </>
          ) : (
            <p className="dm-note">No transaction was sent. <Link to="/app/proof/break">See attacks the chain refuses</Link></p>
          )}
          <button className="dm-btn" onClick={next}>Pay it again?</button>
        </>
      )
      break
    case 4:
      body = (
        <>
          <div className="dm-verdict dm-verdict--bad"><VerdictMark kind="no_match" size={84} /><h2 className="dm-h">Paid once means once.</h2></div>
          <p className="dm-sub">The second payment was refused on chain: {run.again.name} ({run.again.code}).</p>
          <Chip hash={run.again.hash} label="Refusal" />
          <button className="dm-btn" onClick={next}>What now?</button>
        </>
      )
      break
    default:
      body = (
        <>
          <h1 className="dm-h">Your turn.</h1>
          <div className="dm-cta">
            <Link className="dm-btn" to="/app">Run it with your wallet</Link>
            <Link className="dm-btn dm-btn--ghost" to="/app/proof/agent">Add the check to your agent</Link>
          </div>
          <p className="dm-note"><Link to="/app/proof/judges">Verify it yourself</Link>, no keys needed.</p>
        </>
      )
  }

  return (
    <div className="po-app dm" data-testid="demo">
      <header className="dm-top">
        <Link to="/" className="dm-brand">PayOnce</Link>
        <nav aria-label="Demo progress" className="dm-prog">
          {SCREENS.map((s, n) => (
            <button key={s} className={n === i ? 'is-now' : n < i ? 'is-done' : ''} onClick={() => n <= i && setI(n)} aria-current={n === i ? 'step' : undefined} aria-label={`${n + 1} of ${SCREENS.length}: ${s}`} />
          ))}
        </nav>
        <Link to="/app" className="dm-skip">Open the app</Link>
      </header>
      <main className="dm-stage">
        <AnimatePresence mode="wait">
          <motion.section
            key={i}
            className="dm-screen"
            initial={still ? false : { opacity: 0, y: 18 }}
            animate={{ opacity: 1, y: 0 }}
            exit={still ? undefined : { opacity: 0, y: -12 }}
            transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
            aria-live="polite"
          >
            {body}
          </motion.section>
        </AnimatePresence>
      </main>
      <footer className="dm-foot" data-testid="demo-label">
        <span className={`dm-pill ${run.live ? 'is-live' : ''}`}>{run.live ? 'Live run' : 'Replay'}</span>
        {run.label} Testnet names are mock identities.
      </footer>
    </div>
  )
}
