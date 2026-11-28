// Two visuals, both explain the mechanism (identity-driven-design §4, stroke-draw technique
// re-implemented from pixel-perfect.space/blocks/svg-animations):
//  - VerdictMark: the Match tick / No-match cross draws itself once when the verdict lands.
//  - PaymentPath: payer -> check -> payee. The line fills as the flow advances; on No match
//    the line stops at the check and the payee end stays grey. Transform/opacity/stroke only.
import { motion, useReducedMotion } from 'framer-motion'

const DRAW = { duration: 0.6, ease: [0.65, 0, 0.35, 1] as const }

export function VerdictMark({ kind, size = 72 }: { kind: 'match' | 'no_match' | 'paid'; size?: number }) {
  const still = useReducedMotion()
  const init = still ? { strokeDashoffset: 0 } : { strokeDashoffset: 1 }
  const draw = { pathLength: 1, strokeDasharray: '1 1' }
  const good = kind !== 'no_match'
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" aria-hidden className={`rn-mark ${good ? 'rn-mark--ok' : 'rn-mark--bad'}`}>
      <motion.circle {...draw} cx="36" cy="36" r="33" fill="none" strokeWidth="3" initial={init} animate={{ strokeDashoffset: 0 }} transition={DRAW} />
      {good ? (
        <motion.path {...draw} d="M22 37 L32 47 L51 26" fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"
          initial={init} animate={{ strokeDashoffset: 0 }} transition={{ ...DRAW, delay: still ? 0 : 0.35 }} />
      ) : (
        <>
          <motion.path {...draw} d="M25 25 L47 47" fill="none" strokeWidth="5" strokeLinecap="round"
            initial={init} animate={{ strokeDashoffset: 0 }} transition={{ ...DRAW, delay: still ? 0 : 0.35 }} />
          <motion.path {...draw} d="M47 25 L25 47" fill="none" strokeWidth="5" strokeLinecap="round"
            initial={init} animate={{ strokeDashoffset: 0 }} transition={{ ...DRAW, delay: still ? 0 : 0.55 }} />
        </>
      )}
    </svg>
  )
}

/** progress: 0 payer only, 1 reached the check, 2 paid through to the payee. blocked: stopped at the check. */
export function PaymentPath({ progress, blocked, payer, payee }: { progress: 0 | 1 | 2; blocked: boolean; payer: string; payee: string }) {
  const still = useReducedMotion()
  const first = progress >= 1 ? 1 : 0
  const second = progress >= 2 && !blocked ? 1 : 0
  const t = still ? { duration: 0 } : { duration: 0.8, ease: [0.16, 1, 0.3, 1] as const }
  return (
    <div className="rn-path" role="img" aria-label={`Payment path: ${payer} to the check${blocked ? ', stopped there' : progress >= 2 ? `, then to ${payee}` : ''}`}>
      <svg viewBox="0 0 600 40" preserveAspectRatio="none" className="rn-path__svg" aria-hidden>
        <line x1="20" y1="20" x2="580" y2="20" className="rn-path__track" />
        <motion.line pathLength={1} strokeDasharray="1 1" x1="20" y1="20" x2="300" y2="20" className="rn-path__fill" initial={false} animate={{ strokeDashoffset: 1 - first }} transition={t} />
        <motion.line pathLength={1} strokeDasharray="1 1" x1="300" y1="20" x2="580" y2="20" className="rn-path__fill" initial={false} animate={{ strokeDashoffset: 1 - second }} transition={t} />
      </svg>
      <span className={`rn-path__node rn-path__node--a ${progress >= 0 ? 'is-on' : ''}`} />
      <span className={`rn-path__node rn-path__node--b ${progress >= 1 ? (blocked ? 'is-bad' : 'is-on') : ''}`} />
      <span className={`rn-path__node rn-path__node--c ${second ? 'is-on' : ''}`} />
      <div className="rn-path__labels" aria-hidden>
        <span>{payer}</span>
        <span>Check</span>
        <span>{payee}</span>
      </div>
    </div>
  )
}
