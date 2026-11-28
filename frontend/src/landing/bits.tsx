import { animate, motion, useInView, useReducedMotion } from 'framer-motion'
import { useEffect, useRef, useState, type ReactNode } from 'react'

export const EASE = [0.16, 1, 0.3, 1] as const
export const EASE_INOUT = [0.65, 0, 0.35, 1] as const

/** Source tag: LIVE (fetched this visit), Recorded (committed, dated) or Illustration. */
export function Tag({
  kind,
  children,
  dark,
}: {
  kind: 'live' | 'recorded' | 'illustration'
  children?: ReactNode
  dark?: boolean
}) {
  const label = children ?? (kind === 'live' ? 'Live' : kind === 'recorded' ? 'Recorded' : 'Illustration')
  return (
    <span className={`po-tag po-tag--${kind}${dark ? ' po-tag--dark' : ''}`}>
      {kind === 'live' && <i className="po-dot" aria-hidden />}
      {label}
    </span>
  )
}

/** Counts up once when scrolled into view. Final value under reduced motion. */
export function Count({
  to,
  className,
  format = (n: number) => Math.round(n).toLocaleString('en-US'),
}: {
  to: number
  className?: string
  format?: (n: number) => string
}) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useInView(ref, { once: true, amount: 0.6 })
  const still = useReducedMotion()
  const [val, setVal] = useState(still ? to : 0)
  const first = useRef(true)
  useEffect(() => {
    if (still) {
      setVal(to)
      return
    }
    if (!seen) return
    // Later changes (live data arriving) glide from the shown value.
    const isFirst = first.current
    const from = isFirst ? 0 : val
    first.current = false
    const controls = animate(from, to, { duration: isFirst ? 1.6 : 0.8, ease: EASE, onUpdate: setVal })
    return () => controls.stop()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [seen, to, still])
  return (
    <span ref={ref} className={className}>
      {format(seen || still ? val : 0)}
    </span>
  )
}

/** Word-by-word masked headline rise. "\n" in text starts a new line. The full phrase stays in aria-label. */
export function Rise({
  text,
  as = 'h2',
  className,
  delay = 0,
  onLoad,
  instant,
}: {
  text: string
  as?: 'h1' | 'h2' | 'h3'
  className?: string
  delay?: number
  /** true: play on mount (hero). false: play when scrolled into view. */
  onLoad?: boolean
  /** true: already painted by the first-paint hero, so start in the final state. */
  instant?: boolean
}) {
  const still = useReducedMotion()
  const El = motion[as]
  const lines = text.split('\n')
  let n = 0
  return (
    <El
      className={className}
      initial={still || instant ? 'show' : 'hide'}
      {...(onLoad ? { animate: 'show' } : { whileInView: 'show', viewport: { once: true, amount: 0.15 } })}
      aria-label={text.replace(/\n/g, ' ')}
    >
      {lines.map((line, li) => (
        <span key={li} className="po-rise-line" aria-hidden>
          {line.split(' ').map((word) => {
            const i = n++
            return (
              <span key={`${li}-${i}`} className="po-rise-mask">
                <motion.span
                  className="po-rise-word"
                  variants={{
                    hide: { y: '108%' },
                    show: { y: '0%', transition: { duration: 0.85, ease: EASE, delay: delay + i * 0.05 } },
                  }}
                >
                  {word}
                </motion.span>
              </span>
            )
          })}
        </span>
      ))}
    </El>
  )
}

/** Spring magnetic pull toward the cursor, desktop mouse only. */
export function Magnetic({ children, strength = 0.28 }: { children: ReactNode; strength?: number }) {
  const ref = useRef<HTMLSpanElement>(null)
  const still = useReducedMotion()
  const [pos, setPos] = useState({ x: 0, y: 0 })
  return (
    <motion.span
      ref={ref}
      className="po-magnet"
      animate={pos}
      transition={{ type: 'spring', stiffness: 220, damping: 16, mass: 0.4 }}
      onPointerMove={(e) => {
        if (still || e.pointerType !== 'mouse' || !ref.current) return
        const r = ref.current.getBoundingClientRect()
        setPos({ x: (e.clientX - r.left - r.width / 2) * strength, y: (e.clientY - r.top - r.height / 2) * strength })
      }}
      onPointerLeave={() => setPos({ x: 0, y: 0 })}
    >
      {children}
    </motion.span>
  )
}

const DRAW = { off: { strokeDashoffset: 1 }, on: { strokeDashoffset: 0 } }

/** Self-drawing check mark (pathLength = 1). */
export function SvgCheck({ on, delay = 0 }: { on: boolean; delay?: number }) {
  const still = useReducedMotion()
  const v = on || still
  return (
    <svg viewBox="0 0 40 40" className="po-check" aria-hidden>
      <circle cx="20" cy="20" r="17" className="po-check__track" />
      <motion.circle
        cx="20"
        cy="20"
        r="17"
        className="po-check__ring"
        pathLength={1}
        strokeDasharray="1 1"
        variants={DRAW}
        initial={still ? 'on' : 'off'}
        animate={v ? 'on' : 'off'}
        transition={{ duration: 0.7, ease: EASE_INOUT, delay }}
        style={{ rotate: -90, transformOrigin: '50% 50%' }}
      />
      <motion.path
        d="M12.5 20.5 18 26l10-11"
        className="po-check__tick"
        pathLength={1}
        strokeDasharray="1 1"
        variants={DRAW}
        initial={still ? 'on' : 'off'}
        animate={v ? 'on' : 'off'}
        transition={{ duration: 0.4, delay: v && !still ? delay + 0.55 : 0 }}
      />
    </svg>
  )
}

export function useMedia(query: string, initial = false): boolean {
  const [m, setM] = useState(() =>
    typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(query).matches : initial,
  )
  useEffect(() => {
    if (!window.matchMedia) return
    const mq = window.matchMedia(query)
    const on = () => setM(mq.matches)
    on()
    mq.addEventListener('change', on)
    return () => mq.removeEventListener('change', on)
  }, [query])
  return m
}

/** Copy button that really copies, and says so. */
export function CopyButton({ text, label = 'Copy' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      type="button"
      className="po-copy"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text)
          setDone(true)
          setTimeout(() => setDone(false), 1600)
        } catch {
          setDone(false)
        }
      }}
    >
      {done ? 'Copied' : label}
    </button>
  )
}
