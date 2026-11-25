// Design-v2 polish primitives — CountUp, Sparkline, Donut, Reveal.
// All motion respects prefers-reduced-motion (CountUp renders the final
// value at once; Reveal renders visible; the CSS float/shine animations
// are killed by the global reduced-motion rule in index.css).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import type { DerivedStatus } from '../lib/dashboard'

/** Loading skeleton: a pulsing block where a live number will land. The
    hero chip and the dashboard cards render these while stats load, so the
    page never shows a bare "0" or an absent chip for 5–8 s. */
export function Skeleton({ className = '' }: { className?: string }) {
  return <span aria-hidden="true" className={`skeleton ${className}`} />
}

/** Animated number: counts to the value once it scrolls into view, then
    glides from the PREVIOUS value on every real change — never from 0 after
    mount, and never at all when the value is unchanged (bug 3 / numbers
    re-rendering: the old count-up restarted 0 → value on every poll that
    returned a new object, so the numbers visibly re-animated on their own). */
export function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduceMotion = useReducedMotion()
  const [shown, setShown] = useState(reduceMotion ? value : 0)
  const shownRef = useRef(reduceMotion ? value : 0)
  const targetRef = useRef(value)
  const fmt = format ?? ((n: number) => String(Math.round(n)))

  useEffect(() => {
    if (value === targetRef.current && shownRef.current === value) return
    targetRef.current = value
    if (reduceMotion) {
      setShown(value)
      shownRef.current = value
      return
    }
    // No IntersectionObserver (jsdom / old browsers): show the final value.
    if (typeof IntersectionObserver === 'undefined') {
      setShown(value)
      shownRef.current = value
      return
    }
    const el = ref.current
    if (!el) {
      setShown(value)
      shownRef.current = value
      return
    }
    let raf = 0
    let started = false
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || started) return
        started = true
        const from = shownRef.current
        const to = value
        const t0 = performance.now()
        const dur = 600
        const tick = (t: number) => {
          const p = Math.min(1, (t - t0) / dur)
          const eased = 1 - (1 - p) ** 3
          const v = from + (to - from) * eased
          shownRef.current = v
          setShown(v)
          if (p < 1) raf = requestAnimationFrame(tick)
        }
        raf = requestAnimationFrame(tick)
      },
      { threshold: 0.4 },
    )
    io.observe(el)
    return () => {
      io.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [value, reduceMotion])

  return (
    <span ref={ref} className="tabular-nums">
      {fmt(shown)}
    </span>
  )
}

/** True once `active` has held for `ms` without a break — a loader that is
    still loading after 15 s says so ("Still loading — the test API is slow
    right now.") instead of spinning silently (bug 6). */
export function useSlowLoad(active: boolean, ms = 15_000): boolean {
  const [slow, setSlow] = useState(false)
  useEffect(() => {
    if (!active) {
      setSlow(false)
      return
    }
    const t = window.setTimeout(() => setSlow(true), ms)
    return () => window.clearTimeout(t)
  }, [active, ms])
  return slow
}

/** Scroll-reveal wrapper (framer-motion, already in the stack). */
export function Reveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduceMotion = useReducedMotion()
  return (
    <motion.div
      className={className}
      initial={reduceMotion ? undefined : { opacity: 0, y: 24 }}
      whileInView={{ opacity: 1, y: 0 }}
      viewport={{ once: true, amount: 0.2 }}
      transition={{ duration: 0.7, delay, ease: [0.22, 1, 0.36, 1] }}
    >
      {children}
    </motion.div>
  )
}

/** Tiny sparkline from a real number sequence (registry order). */
export function Sparkline({ values, width = 120, height = 36 }: { values: number[]; width?: number; height?: number }) {
  const max = Math.max(...values, 1)
  const min = Math.min(...values, 0)
  const span = max - min || 1
  const pts = values.map((v, i) => {
    const x = values.length === 1 ? width / 2 : (i / (values.length - 1)) * (width - 4) + 2
    const y = height - 4 - ((v - min) / span) * (height - 8)
    return `${x.toFixed(1)},${y.toFixed(1)}`
  })
  const line = pts.join(' ')
  const id = `spark-${values.length}-${values[values.length - 1] ?? 0}`
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label={`Trend: ${values.join(', ')}`}
      className="overflow-visible"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#B4430F" stopOpacity="0.25" />
          <stop offset="100%" stopColor="#B4430F" stopOpacity="0" />
        </linearGradient>
      </defs>
      <polygon points={`2,${height - 2} ${line} ${width - 2},${height - 2}`} fill={`url(#${id})`} />
      <polyline points={line} fill="none" stroke="#B4430F" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
      {pts.length > 0 ? (
        <circle
          cx={Number(pts[pts.length - 1].split(',')[0])}
          cy={Number(pts[pts.length - 1].split(',')[1])}
          r="3"
          fill="#9A3412"
        />
      ) : null}
    </svg>
  )
}

/** Donut chart from real segments (paid / unpaid counts). */
export function Donut({
  segments,
  size = 180,
  thickness = 30,
}: {
  segments: Array<{ label: string; value: number; color: string }>
  size?: number
  thickness?: number
}) {
  const total = segments.reduce((s, x) => s + x.value, 0)
  const r = (size - thickness) / 2
  const c = 2 * Math.PI * r
  let offset = 0
  return (
    <div className="flex items-center gap-6">
      <svg
        width={size}
        height={size}
        viewBox={`0 0 ${size} ${size}`}
        role="img"
        aria-label={total === 0 ? 'No payables yet' : segments.map((s) => `${s.label}: ${s.value}`).join(', ')}
      >
        {total === 0 ? (
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#E7DDCB" strokeWidth={thickness} />
        ) : (
          segments.map((s) => {
            const frac = s.value / total
            const el = (
              <circle
                key={s.label}
                cx={size / 2}
                cy={size / 2}
                r={r}
                fill="none"
                stroke={s.color}
                strokeWidth={thickness}
                strokeDasharray={`${Math.max(0, frac * c - (frac > 0 && frac < 1 ? 2 : 0))} ${c}`}
                strokeDashoffset={-offset * c}
                transform={`rotate(-90 ${size / 2} ${size / 2})`}
                style={{ transition: 'stroke-dasharray 0.6s ease, stroke-dashoffset 0.6s ease' }}
              />
            )
            offset += frac
            return el
          })
        )}
        <text x="50%" y="47%" textAnchor="middle" fontSize="30" fontWeight="600" fill="#171310">
          {total}
        </text>
        <text x="50%" y="62%" textAnchor="middle" fontSize="12" fill="#6B5D4F">
          payables
        </text>
      </svg>
      <ul className="space-y-2 text-sm">
        {segments.map((s) => (
          <li key={s.label} className="flex items-center gap-2">
            <span className="h-3 w-3 rounded-full" style={{ background: s.color }} aria-hidden="true" />
            <span className="text-ink">
              {s.label} · <strong className="tabular-nums">{s.value}</strong>
              {total > 0 ? <span className="text-muted"> ({Math.round((s.value / total) * 100)}%)</span> : null}
            </span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/** Paid-once gauge: a semicircular arc, 0–100%. The arc glides (CSS
    transition on stroke-dashoffset) when the value changes instead of
    jumping — the same glide rule as the donut. */
export function Gauge({ pct, label }: { pct: number; label: string }) {
  const p = Math.min(100, Math.max(0, Math.round(pct)))
  const r = 70
  const half = Math.PI * r
  return (
    <div className="flex flex-col items-center">
      <svg width="180" height="104" viewBox="0 0 180 104" role="img" aria-label={`${label}: ${p}%`}>
        <path d={`M 20 96 A ${r} ${r} 0 0 1 160 96`} fill="none" stroke="#E7DDCB" strokeWidth="14" strokeLinecap="round" />
        <path
          d={`M 20 96 A ${r} ${r} 0 0 1 160 96`}
          fill="none"
          stroke="#B4430F"
          strokeWidth="14"
          strokeLinecap="round"
          strokeDasharray={`${half} ${half}`}
          strokeDashoffset={half * (1 - p / 100)}
          style={{ transition: 'stroke-dashoffset 0.6s ease' }}
        />
        <text x="90" y="82" textAnchor="middle" fontSize="30" fontWeight="600" fill="#171310">
          {p}%
        </text>
      </svg>
      <p className="mt-1 text-sm text-muted">{label}</p>
    </div>
  )
}

/** Invoice status pill — Paid (green), Unpaid (amber), Overdue (red).
    Overdue is derived from the live due date, never invented. */
export function InvoiceStatusPill({ status }: { status: DerivedStatus }) {
  if (status === 'paid')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-verified-bg px-3 py-1 text-xs font-semibold text-verified-fg">
        <span aria-hidden="true">✓</span> Paid
      </span>
    )
  if (status === 'overdue')
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-refused-bg px-3 py-1 text-xs font-semibold text-refused-fg">
        <span aria-hidden="true">!</span> Overdue
      </span>
    )
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-unpaid-bg px-3 py-1 text-xs font-semibold text-unpaid-fg">
      <span aria-hidden="true">◷</span> Unpaid
    </span>
  )
}
