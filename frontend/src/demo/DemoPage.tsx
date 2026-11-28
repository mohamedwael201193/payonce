// /demo: the whole idea in six screens and about a minute. One button per
// screen, a few words each. The run comes from loadDemoRun(): a fresh real
// run when the API has one, otherwise a labelled replay of a recorded run.
import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { VerdictMark } from '../app/run/Visuals'
import { midTruncate } from '../app/Address'
import { useDocumentTitle } from '../app/hooks'
import { RECORDED_RUN, ago, impostorHeadline, loadDemoFeed, txUrl, type DemoProgressStep, type DemoRun } from './demoData'
import { PayeeDiff } from '../dash/motion'
import { eurOfCcd } from '../lib/feeEur'
import { lookalike, sharedEnds } from '../dash/lookalike'
import { OfficialBadges } from '../app/OfficialBadges'
import '../dash/dash.css'
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

/** Poll the API while it produces a fresh run: new hashes appear as they land, then the run itself replaces the older one. */
const POLL_MS = 4_000
const POLL_MAX = 90 // about 6 minutes: a run takes about 3

export function DemoStatus({ run, ready, refreshing, progress }: { run: DemoRun; ready: boolean; refreshing: boolean; progress: DemoProgressStep[] }) {
  if (!ready) return <p className="dm-status dm-status--wait" data-testid="demo-status">Looking for a live run…</p>
  const src = run.source ?? (run.live ? 'live' : 'replay')
  const when = ago(run.ageSecs)
  return (
    <div className={`dm-status dm-status--${src}`} data-testid="demo-status">
      <p className="dm-status__line" role="status">
        <span className="dm-status__dot" aria-hidden />
        {src === 'live' ? <><b>Live</b> · real transactions on the test network, {when}</> : null}
        {src === 'recent' ? <><b>Last run</b> · real transactions on the test network, {when}{refreshing ? '. A fresh run is landing now.' : '.'}</> : null}
        {src === 'replay' ? <><b>Replay</b> · a recording of an earlier run. {refreshing ? 'A live run is being made now.' : 'A live run is not available right now (the API is busy or its daily run limit is reached).'}</> : null}
      </p>
      {refreshing ? (
        <div className="dm-progress" data-testid="demo-progress" aria-label="Transactions of the fresh run">
          <small>Fresh run, hashes as they land</small>
          {progress.length ? (
            <ul>
              {progress.map((t) => (
                <li key={t.key}><a href={txUrl(t.hash)} target="_blank" rel="noreferrer">{t.label} <code>{midTruncate(t.hash, 4, 4)}</code> <i aria-hidden>↗</i></a></li>
              ))}
            </ul>
          ) : <em>Starting… the first transaction lands in about 20 seconds.</em>}
        </div>
      ) : null}
    </div>
  )
}

export function DemoPage() {
  useDocumentTitle('Demo')
  const [i, setI] = useState(0)
  const [run, setRun] = useState<DemoRun>(RECORDED_RUN)
  const [ready, setReady] = useState(false)
  const [refreshing, setRefreshing] = useState(false)
  const [progress, setProgress] = useState<DemoProgressStep[]>([])
  const iRef = useRef(0)
  const [diffAcct, setDiffAcct] = useState<{ asked: string; illustration: boolean } | null>(null)
  const still = useReducedMotion()

  useEffect(() => {
    const ac = new AbortController()
    let timer: number | undefined
    let polls = 0
    let shownAt: string | undefined
    const apply = (f: Awaited<ReturnType<typeof loadDemoFeed>>, first: boolean) => {
      if (ac.signal.aborted) return
      setRefreshing(f.refreshing)
      setProgress(f.progress)
      // Never swap the run under a visitor who has started it; the first screen may change.
      if (first || iRef.current === 0) {
        const key = f.run.source === 'replay' ? 'replay' : `${f.run.source}:${f.run.paid.hash}`
        if (first || key !== shownAt) setRun(f.run)
        shownAt = key
      }
      if (first) setReady(true)
    }
    const poll = () => {
      timer = window.setTimeout(async () => {
        polls += 1
        const f = await loadDemoFeed(ac.signal, 8_000)
        apply(f, false)
        if (f.refreshing && polls < POLL_MAX && !ac.signal.aborted) poll()
      }, POLL_MS)
    }
    void loadDemoFeed(ac.signal).then((f) => {
      apply(f, true)
      if (f.refreshing) poll()
    })
    return () => { ac.abort(); window.clearTimeout(timer) }
  }, [])

  // Lookalike search is a CPU loop: never run it on the first screens or it freezes the "Run it" click.
  useEffect(() => {
    if (i < 3) return
    const e = sharedEnds(run.good.account, run.impostor.account)
    if (e.head + e.tail >= 8) { setDiffAcct({ asked: run.impostor.account, illustration: false }); return }
    const id = window.setTimeout(() => {
      const l = lookalike(run.good.account)
      setDiffAcct(l ? { asked: l, illustration: true } : null)
    }, 0)
    return () => clearTimeout(id)
  }, [i, run.good.account, run.impostor.account])

  useEffect(() => { iRef.current = i }, [i])
  const next = () => setI((n) => Math.min(n + 1, SCREENS.length - 1))
  const imp = run.impostor

  let body: React.ReactNode
  switch (i) {
    case 0:
      body = (
        <>
          <DemoStatus run={run} ready={ready} refreshing={refreshing} progress={progress} />
          <h1 className="dm-h">Same invoice. Different account. Which one should your AI pay?</h1>
          {ready ? (
            <>
              <div className="dm-pair">
                <Invoice account={run.good.account} tone="a" tag={run.invoice.amount} />
                <Invoice account={imp.account} tone="b" tag={run.invoice.amount} />
              </div>
              <button className="dm-btn" type="button" onClick={next}>Run it</button>
            </>
          ) : (
            <p className="dm-busy" role="status" data-testid="demo-loading">Loading the latest run…</p>
          )}
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
          {run.feeCcd ? <p className="dm-fee" data-testid="demo-fee">Network fee {run.feeCcd.toFixed(1)} CCD (about {eurOfCcd(run.feeCcd)}), paid by PayOnce. The buyer sent only the invoice amount.</p> : null}
          <button className="dm-btn" onClick={next}>Now the impostor</button>
        </>
      )
      break
    case 3:
      body = (
        <>
          <p className="dm-mail">“Our bank details changed. Please pay <code>{short(imp.account)}</code> instead.”</p>
          <div className="dm-verdict dm-verdict--bad"><VerdictMark kind="no_match" size={84} /><h2 className="dm-h">No match</h2></div>
          <p className="dm-sub">{impostorHeadline(imp.headline)}</p>
          {diffAcct ? <div className="dm-diff"><PayeeDiff real={run.good.account} asked={diffAcct.asked} realLabel="The real payee" askedLabel={diffAcct.illustration ? 'A lookalike an attacker could make' : 'The account in the email'} illustration={diffAcct.illustration} /></div> : null}
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
          <OfficialBadges title="Four official badges, checked live" />
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
        <span className={`dm-pill ${run.live ? 'is-live' : ''}`}>{ready ? (run.live ? 'Live run' : run.source === 'recent' ? 'Last run' : 'Replay') : 'Loading'}</span>
        {ready
          ? (run.live ? `Real payments on the test network, ${ago(run.ageSecs)}. The name on the invoice is a practice name.`
            : run.source === 'recent' ? `Real payments on the test network, ${ago(run.ageSecs)}. The name on the invoice is a practice name.`
            : 'A recorded payment on the test network. The name on the invoice is a practice name.')
          : 'Looking for a live run. If it takes too long, a recording will play instead.'}
        {ready ? (
          <details className="dm-details">
            <summary>Details</summary>
            <p>{run.source === 'recent' ? run.label.replace(/^Fresh run/, 'Run') : run.label} Testnet names are mock identities.</p>
          </details>
        ) : null}
      </footer>
    </div>
  )
}
