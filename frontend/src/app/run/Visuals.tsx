// One visual, it explains the mechanism (identity-driven-design §4, stroke-draw technique
// re-implemented from pixel-perfect.space/blocks/svg-animations):
//  - VerdictMark: the Match tick / No-match cross draws itself once when the verdict lands.
import { motion, useReducedMotion } from 'framer-motion'

const DRAW = { duration: 0.6, ease: [0.65, 0, 0.35, 1] as const }

export function VerdictMark({ kind, size = 72 }: { kind: 'match' | 'no_match' | 'paid'; size?: number }) {
  const still = useReducedMotion()
  // 'paid' is drawn complete: it sits next to a spinner-to-result swap and a half-drawn tick read as a bug.
  const init = still || kind === 'paid' ? { strokeDashoffset: 0 } : { strokeDashoffset: 1 }
  const draw = { pathLength: 1, strokeDasharray: '1 1' }
  const good = kind !== 'no_match'
  return (
    <svg width={size} height={size} viewBox="0 0 72 72" aria-hidden className={`rn-mark ${good ? 'rn-mark--ok' : 'rn-mark--bad'}`}>
      <motion.circle {...draw} cx="36" cy="36" r="33" fill="none" strokeWidth="3" initial={init} animate={{ strokeDashoffset: 0 }} transition={DRAW} />
      {good ? (
        <motion.path {...draw} d="M22 37 L32 47 L51 26" fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round"
          initial={init} animate={{ strokeDashoffset: 0 }} transition={{ ...DRAW, delay: still || kind === 'paid' ? 0 : 0.35 }} />
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
