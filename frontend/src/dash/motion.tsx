// The dashboard's visual vocabulary. Each piece shows a real value:
//  Stamp       the verdict, pressed down once when it lands
//  CheckTicks  the check_payee checks, ticking in order
//  PayeeDiff   the account the invoice names vs the one being asked for, changed characters in red
//  ChainBar    a transaction's real status from /api/tx/:hash/status
//  HoldRing    the payee-book hold counting down to hold_ends_at
import { useEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import { walletApi } from '../wallet/api'
import { VERDICT_TEXT, type Verdict } from './contracts'
import { sharedEnds } from './lookalike'

const EASE = [0.16, 1, 0.3, 1] as const

export function Stamp({ verdict, sub }: { verdict: Verdict; sub?: string }) {
  const still = useReducedMotion()
  const v = VERDICT_TEXT[verdict]
  return (
    <motion.div
      className={`ds-stamp ds-stamp--${v.tone}`}
      role="status"
      initial={still ? false : { scale: 2.2, opacity: 0, rotate: -14 }}
      animate={{ scale: 1, opacity: 1, rotate: -6 }}
      transition={still ? { duration: 0 } : { type: 'spring', stiffness: 520, damping: 22, mass: 0.9, delay: 0.15 }}
    >
      <span className="ds-stamp__word">{v.word}</span>
      {sub ? <span className="ds-stamp__sub">{sub}</span> : null}
    </motion.div>
  )
}

export function CheckTicks({ items, step = 0.32 }: { items: { ok: boolean; text: string }[]; step?: number }) {
  const still = useReducedMotion()
  return (
    <ul className="ds-ticks">
      {items.map((c, i) => (
        <motion.li
          key={c.text}
          className={c.ok ? 'is-ok' : 'is-bad'}
          initial={still ? false : { opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ delay: i * step, duration: 0.35, ease: EASE }}
        >
          <svg viewBox="0 0 20 20" width="20" height="20" aria-hidden>
            <motion.circle cx="10" cy="10" r="9" fill="none" strokeWidth="1.6" pathLength={1} strokeDasharray="1 1" initial={still ? false : { strokeDashoffset: 1 }} animate={{ strokeDashoffset: 0 }} transition={{ delay: i * step, duration: 0.4 }} />
            <motion.path
              d={c.ok ? 'M5.5 10.5l3 3 6-7' : 'M6.5 6.5l7 7M13.5 6.5l-7 7'}
              fill="none" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" pathLength={1} strokeDasharray="1 1"
              initial={still ? false : { strokeDashoffset: 1 }} animate={{ strokeDashoffset: 0 }} transition={{ delay: i * step + 0.2, duration: 0.3 }}
            />
          </svg>
          <span>{c.text}</span>
          <span className="sr-only">{c.ok ? ' (passed)' : ' (failed)'}</span>
        </motion.li>
      ))}
    </ul>
  )
}

/** Character positions where b differs from a (same index; extra characters count as different). */
export function diffPositions(a: string, b: string): Set<number> {
  const out = new Set<number>()
  for (let i = 0; i < b.length; i++) if (a[i] !== b[i]) out.add(i)
  return out
}

export function PayeeDiff({ real, asked, realLabel = 'On the invoice', askedLabel = 'Asked to pay', illustration = false }: { real: string; asked: string; realLabel?: string; askedLabel?: string; illustration?: boolean }) {
  const d = diffPositions(real, asked)
  const ends = sharedEnds(real, asked)
  const lookalike = ends.head + ends.tail >= 6 && d.size > 0
  const still = useReducedMotion()
  return (
    <div className="ds-diff" aria-label={`${realLabel} ${real}. ${askedLabel} ${asked}. ${d.size} characters differ.`}>
      <div className="ds-diff__row"><small>{realLabel}</small><code>{real}</code></div>
      <div className="ds-diff__row is-asked">
        <small>{askedLabel}</small>
        <code>
          {[...asked].map((ch, i) =>
            d.has(i) ? (
              <motion.b key={i} initial={still ? false : { backgroundColor: 'rgba(180,35,24,0)' }} animate={{ backgroundColor: 'rgba(180,35,24,0.14)' }} transition={{ delay: 0.3 + (i % 50) * 0.012 }}>{ch}</motion.b>
            ) : (
              <span key={i}>{ch}</span>
            ),
          )}
        </code>
      </div>
      <p className="ds-diff__n">
        {d.size === 0 ? 'Same account' : lookalike ? `Same first ${ends.head} and last ${ends.tail}. ${d.size} in the middle differ.` : `${d.size} of ${asked.length} characters differ`}
      </p>
      {illustration ? <p className="ds-diff__ill"><span>Illustration</span> A lookalike made for this page. It has a valid checksum and is not a real account.</p> : null}
    </div>
  )
}

export type TxPhase = 'signing' | 'sent' | 'committed' | 'finalized' | 'refused' | 'unknown'
const PHASES: TxPhase[] = ['signing', 'sent', 'committed', 'finalized']
const PHASE_TEXT: Record<TxPhase, string> = { signing: 'Sign in your wallet', sent: 'Sent', committed: 'In a block', finalized: 'Final', refused: 'Refused by the chain', unknown: 'Waiting for the node' }

/** Polls the real status of a transaction. */
export function useTxStatus(hash: string | null): { phase: TxPhase; reject: { code: number; name: string } | null } {
  const [st, setSt] = useState<{ phase: TxPhase; reject: { code: number; name: string } | null }>({ phase: hash ? 'sent' : 'signing', reject: null })
  useEffect(() => {
    if (!hash) return
    let alive = true
    setSt({ phase: 'sent', reject: null })
    const tick = async () => {
      while (alive) {
        try {
          const s = await walletApi<{ status: string; reject: { code: number; name: string } | null }>(`/api/tx/${hash}/status`)
          if (!alive) return
          if (s.status === 'finalized') return setSt({ phase: s.reject ? 'refused' : 'finalized', reject: s.reject })
          setSt({ phase: s.status === 'committed' ? 'committed' : 'sent', reject: null })
        } catch { /* not seen yet */ }
        await new Promise((r) => setTimeout(r, 2000))
      }
    }
    void tick()
    return () => { alive = false }
  }, [hash])
  return st
}

/** Real progress for a chain wait: segment per phase, a slow fill inside the current one, elapsed seconds. */
export function ChainBar({ phase, startedAt }: { phase: TxPhase; startedAt: number }) {
  const [now, setNow] = useState(Date.now())
  const done = phase === 'finalized' || phase === 'refused'
  useEffect(() => {
    if (done) return
    const t = setInterval(() => setNow(Date.now()), 250)
    return () => clearInterval(t)
  }, [done])
  const idx = phase === 'refused' ? 3 : Math.max(0, PHASES.indexOf(phase))
  const secs = Math.max(0, Math.round((now - startedAt) / 1000))
  return (
    <div className={`ds-chain ${phase === 'refused' ? 'is-bad' : ''}`} role="progressbar" aria-valuemin={0} aria-valuemax={3} aria-valuenow={idx} aria-valuetext={PHASE_TEXT[phase]}>
      <div className="ds-chain__segs">
        {PHASES.slice(0, 4).map((p, i) => (
          <span key={p} className={i < idx || done ? 'is-full' : i === idx ? 'is-now' : ''}><i /></span>
        ))}
      </div>
      <div className="ds-chain__txt"><b>{PHASE_TEXT[phase]}</b>{done ? null : <span className="tabular">{secs} s</span>}</div>
    </div>
  )
}

export function HoldRing({ endsAt, totalSecs }: { endsAt: string; totalSecs: number }) {
  const end = useRef(Date.parse(endsAt))
  const [left, setLeft] = useState(() => Math.max(0, end.current - Date.now()))
  useEffect(() => {
    end.current = Date.parse(endsAt)
    const t = setInterval(() => setLeft(Math.max(0, end.current - Date.now())), 200)
    return () => clearInterval(t)
  }, [endsAt])
  const frac = totalSecs > 0 ? Math.min(1, left / (totalSecs * 1000)) : 0
  const C = 2 * Math.PI * 52
  return (
    <div className="ds-hold" role="timer" aria-label={`Hold: ${Math.ceil(left / 1000)} seconds left`}>
      <svg viewBox="0 0 120 120" width="132" height="132" aria-hidden>
        <circle cx="60" cy="60" r="52" className="ds-hold__bg" />
        <circle cx="60" cy="60" r="52" className="ds-hold__fg" strokeDasharray={C} strokeDashoffset={C * (1 - frac)} />
      </svg>
      <div className="ds-hold__n"><b className="tabular">{Math.ceil(left / 1000)}</b><small>s hold</small></div>
    </div>
  )
}
