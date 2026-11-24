// Design-v2 polish primitives — CountUp, Sparkline, Donut, Reveal.
// All motion respects prefers-reduced-motion (CountUp renders the final
// value at once; Reveal renders visible; the CSS float/shine animations
// are killed by the global reduced-motion rule in index.css).
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import type { DerivedStatus } from '../lib/dashboard'

/** Animated number: counts 0 → value once it scrolls into view. */
export function CountUp({ value, format }: { value: number; format?: (n: number) => string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const reduceMotion = useReducedMotion()
  const [shown, setShown] = useState(reduceMotion ? value : 0)
  const fmt = format ?? ((n: number) => String(Math.round(n)))

  useEffect(() => {
    if (reduceMotion) {
      setShown(value)
      return
    }
    // No IntersectionObserver (jsdom / old browsers): show the final value.
    if (typeof IntersectionObserver === 'undefined') {
      setShown(value)
      return
    }
    const el = ref.current
    if (!el) return
    let raf = 0
    let started = false
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting || started) return
        started = true
        const t0 = performance.now()
        const dur = 1100
        const tick = (t: number) => {
          const p = Math.min(1, (t - t0) / dur)
          const eased = 1 - (1 - p) ** 3
          setShown(value * eased)
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
