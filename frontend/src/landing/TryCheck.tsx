// The 60-second judge path and the one-click check, right under the hero.
// TryCheck calls the real API (GET /api/p/:account/check): no canned result, and an honest error when it cannot be reached.
import { motion, useInView, useReducedMotion } from 'framer-motion'
import { useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { dashApi, type CheckPayee, type Verdict } from '../dash/contracts'
import { midTruncate } from '../app/Address'
import { EASE } from './bits'

/** The PayOnce demo seller: bound on the v3 demo book, registered name "PayOnce Labs" (a labelled testnet stand-in). */
export const TRY_ACCOUNT = '42jaZZgd69oXcGWPNjCjYfcbe4Z2fyewYAwyfFBHZLqVzmRjNB'
const REGISTERED = 'PayOnce Labs'

const EXAMPLES = [
  { label: 'The registered name', name: REGISTERED },
  { label: 'A near copy', name: 'PayOnce Lab' },
  { label: 'A different company', name: 'Northwind Office Supplies' },
] as const

type Tone = 'ok' | 'warn' | 'bad'
export function stampText(r: Pick<CheckPayee, 'verdict' | 'payable' | 'verified_name'>): { word: string; line: string; tone: Tone; glyph: 'tick' | 'cross' | 'near' | 'ask' } {
  const v: Verdict = r.verdict
  if (v === 'MATCH' && r.payable) return { word: 'Match', line: 'The agent pays once.', tone: 'ok', glyph: 'tick' }
  if (v === 'MATCH') return { word: 'Not payable yet', line: 'The name fits, but the payee is not bound and matured yet. The agent waits.', tone: 'warn', glyph: 'ask' }
  if (v === 'CLOSE_MATCH') return { word: 'Close match', line: r.verified_name ? `Did you mean “${r.verified_name}”? The agent asks you first.` : 'Nearly the same name. The agent asks you first.', tone: 'warn', glyph: 'near' }
  if (v === 'NO_MATCH') return { word: 'No match', line: 'The agent pays nothing.', tone: 'bad', glyph: 'cross' }
  return { word: 'Not possible', line: 'Nothing stands behind this name, so the agent asks you first.', tone: 'warn', glyph: 'ask' }
}

const D = (still: boolean, delay = 0): Record<string, never> => ({ initial: still ? false : { pathLength: 0 }, animate: { pathLength: 1 }, transition: { duration: 0.55, ease: EASE, delay: still ? 0 : delay } }) as never

function Stamp({ tone, glyph }: { tone: Tone; glyph: 'tick' | 'cross' | 'near' | 'ask' }) {
  const still = !!useReducedMotion()
  return (
    <motion.svg className={`po-stamp po-stamp--${tone}`} width="76" height="76" viewBox="0 0 72 72" aria-hidden
      initial={still ? false : { scale: 1.5, rotate: -14, opacity: 0 }} animate={{ scale: 1, rotate: -4, opacity: 1 }} transition={{ type: 'spring', stiffness: 380, damping: 18 }}>
      <motion.circle cx="36" cy="36" r="32" fill="none" strokeWidth="3" {...D(still)} />
      {glyph === 'tick' ? <motion.path d="M22 37 L32 47 L51 26" fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" {...D(still, 0.25)} /> : null}
      {glyph === 'cross' ? <><motion.path d="M25 25 L47 47" fill="none" strokeWidth="5" strokeLinecap="round" {...D(still, 0.25)} /><motion.path d="M47 25 L25 47" fill="none" strokeWidth="5" strokeLinecap="round" {...D(still, 0.4)} /></> : null}
      {glyph === 'near' ? <><motion.path d="M22 30 Q29 24 36 30 T50 30" fill="none" strokeWidth="4.5" strokeLinecap="round" {...D(still, 0.25)} /><motion.path d="M22 42 Q29 36 36 42 T50 42" fill="none" strokeWidth="4.5" strokeLinecap="round" {...D(still, 0.4)} /></> : null}
      {glyph === 'ask' ? <><motion.path d="M28 28 Q28 21 36 21 Q44 21 44 28 Q44 33 36 36 L36 41" fill="none" strokeWidth="4.5" strokeLinecap="round" {...D(still, 0.25)} /><motion.path d="M36 49 L36 50" fill="none" strokeWidth="6" strokeLinecap="round" {...D(still, 0.55)} /></> : null}
    </motion.svg>
  )
}

type State = { s: 'idle' } | { s: 'busy'; name: string } | { s: 'done'; name: string; r: CheckPayee } | { s: 'error'; name: string }

/** One click, one real check: pick a name (or type one) and the agent says what it would do. */
export function TryCheck() {
  const [name, setName] = useState(REGISTERED)
  const [st, setSt] = useState<State>({ s: 'idle' })
  const [slow, setSlow] = useState(false)
  const run = async (n: string) => {
    const asked = n.trim()
    if (!asked) return
    setName(asked)
    setSt({ s: 'busy', name: asked })
    setSlow(false)
    const t = window.setTimeout(() => setSlow(true), 3000)
    try {
      const r = await dashApi.payeeCheck(TRY_ACCOUNT, asked)
      setSt({ s: 'done', name: asked, r })
    } catch {
      setSt({ s: 'error', name: asked })
    } finally {
      window.clearTimeout(t)
    }
  }
  const out = st.s === 'done' ? stampText(st.r) : null
  return (
    <div className="po-try" id="try">
      <div className="po-try__invoice" aria-label="An invoice to check">
        <div className="po-try__top"><b>Invoice</b><span>0.5 CCD · testnet</span></div>
        <div className="po-try__line"><i /><i /></div>
        <label className="po-try__field">
          <small>Name on the invoice</small>
          <input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') void run(name) }} maxLength={80} spellCheck={false} aria-label="Name on the invoice" />
        </label>
        <div className="po-try__pay"><small>Pay to</small><code>{midTruncate(TRY_ACCOUNT, 8, 6)}</code></div>
        <div className="po-try__chips" role="group" aria-label="Examples">
          {EXAMPLES.map((e) => (
            <button key={e.name} type="button" className={name === e.name ? 'is-on' : ''} onClick={() => void run(e.name)}>{e.label}</button>
          ))}
        </div>
        <button className="po-btn po-btn--solid po-try__go" type="button" disabled={st.s === 'busy' || !name.trim()} onClick={() => void run(name)}>
          {st.s === 'busy' ? 'Checking the chain…' : 'Check before paying'}
        </button>
      </div>
      <div className="po-try__result" aria-live="polite">
        {st.s === 'idle' ? <p className="po-try__hint">Pick an example. The agent checks the name against the account on the Concordium test network, then says what it would do.</p> : null}
        {st.s === 'busy' ? <p className="po-try__hint" role="status">{slow ? 'Waking the test-network API. The first check can take up to 20 seconds.' : 'Asking the registry…'}</p> : null}
        {st.s === 'error' ? <p className="po-try__err" role="alert">Could not reach the test-network API just now. No result was invented. Try again in a moment.</p> : null}
        {st.s === 'done' && out ? (
          <motion.div key={`${st.name}-${st.r.checked_at}`} className={`po-try__verdict po-try__verdict--${out.tone}`} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <Stamp tone={out.tone} glyph={out.glyph} />
            <div>
              <h3>{out.word}</h3>
              <p>{out.line}</p>
              <p className="po-try__fine">
                A real check against <code>{midTruncate(TRY_ACCOUNT, 6, 4)}</code> on the test network.
                {st.r.standin ? ' The registered name is a labelled testnet stand-in, not a proven business identity.' : ''}{' '}
                <Link to={`/p/${TRY_ACCOUNT}?name=${encodeURIComponent(st.name)}`}>Open this payee ↗</Link>
              </p>
            </div>
          </motion.div>
        ) : null}
      </div>
    </div>
  )
}

const PATH = [
  { n: 1, title: 'Try a check', time: 'about 10 s', text: 'Pick a name below. Match, Close match or No match, from the chain.', to: '#try', label: 'Try a check' },
  { n: 2, title: 'Watch the live run', time: 'about 40 s', text: 'A real payment, a refused second one, and a lookalike account turned away.', to: '/demo', label: 'Watch the live run' },
  { n: 3, title: 'Re-run the proof', time: 'about 10 s', text: 'One command re-checks the chain. No account, nothing sent.', to: '/app/proof/judges', label: 'Re-run the proof' },
  { n: 4, title: 'Then, with a wallet', time: 'optional, 3 min', text: 'Become a payee and pay 1 CCD from your own Concordium wallet.', to: '/app?dash=1', label: 'Use your wallet' },
] as const

/** Four numbered steps. The path is the same on every device: top to bottom. */
export function JudgePath() {
  const ref = useRef<HTMLOListElement>(null)
  const seen = useInView(ref, { once: true, amount: 0.3 })
  const still = useReducedMotion()
  return (
    <ol className="po-path" ref={ref} aria-label="A 60-second path through PayOnce">
      {PATH.map((p, i) => (
        <motion.li key={p.n} initial={still ? false : { opacity: 0, y: 16 }} animate={seen || still ? { opacity: 1, y: 0 } : undefined} transition={{ duration: 0.5, ease: EASE, delay: i * 0.09 }}>
          <span className="po-path__n" aria-hidden>{p.n}</span>
          <div>
            <h3>{p.title} <em>{p.time}</em></h3>
            <p>{p.text}</p>
            {p.to.startsWith('#')
              ? <a href={p.to} className="po-path__go">{p.label} <i aria-hidden>→</i></a>
              : <Link to={p.to} className="po-path__go">{p.label} <i aria-hidden>→</i></Link>}
          </div>
        </motion.li>
      ))}
    </ol>
  )
}

/** The section under the hero: where to look first. */
export function TrySection() {
  return (
    <section className="po-tryse po-section" id="start" aria-label="Start here">
      <div className="po-wrap">
        <p className="po-eyebrow">Start here</p>
        <h2 className="po-h2">Sixty seconds, no wallet.</h2>
        <JudgePath />
        <TryCheck />
      </div>
    </section>
  )
}
