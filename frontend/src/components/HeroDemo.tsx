// HeroDemo — the looping "Demo" walkthrough, the ONLY thing in the hero
// card (user order 2026-11-25 03:40: the real dashboard lives only in
// /dashboard; the landing shows a demo, small and clearly Demo-labeled).
// It mirrors the REAL dashboard (/dashboard) and the REAL flow steps
// (01 Pick → 02 Check → 03 Pay → 04 Receipt) so a viewer who sees the
// demo understands the real flow and is not confused when they open the
// real dashboard. `compact` renders the same content denser for the small
// hero card (~60% width): the 9 check rows become a 2-column label+status
// grid instead of the full list with details; every tested string stays.
// HONESTY: the stat chips and the invoice table are LIVE data (same hooks
// as the hero card). The checks, the payment and the receipt are CANNED
// demo content — the panel is labelled "Demo" (user order 2026-11-24
// 21:49: the word is "Demo", never "Simulation"), the receipt says so,
// and the demo makes ZERO network calls: no fetch, no pay POST, no chain
// call. The demo buttons are inert props (no onClick); only the virtual
// cursor "presses" them.
// Motion: a requestAnimationFrame clock drives the pure timeline in
// lib/heroDemo.ts. The cursor position is written straight to the DOM
// (no React re-render per frame); React state only changes on discrete
// phase changes. Hovering the hero card pauses the clock; the
// prefers-reduced-motion static frame shows the finished demo with no
// cursor and no motion.
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { CheckCircle2, CircleDashed, Info, Loader2 } from 'lucide-react'
import { Link } from 'react-router-dom'
import { InvoiceStatusPill, Skeleton } from './polish'
import { derivedStatus } from '../lib/dashboard'
import { refusedCaption } from '../lib/copy'
import type { InvoiceItem, Stats } from '../lib/types'
import {
  DEMO_CHECK_COUNT,
  DEMO_LOOP_MS,
  demoCheckRows,
  demoFrameAt,
  demoInvoice,
  demoStatChips,
  demoStaticFrame,
  demoTableRows,
  type DemoFrame,
  type DemoWaypoints,
} from '../lib/heroDemo'

type Discrete = Omit<DemoFrame, 'cursor'>
const discreteOf = (f: Omit<DemoFrame, 'cursor'>): Discrete => ({
  phase: f.phase,
  pressed: f.pressed,
  clickKey: f.clickKey,
  picked: f.picked,
  checksShown: f.checksShown,
  verdict: f.verdict,
  payProgress: f.payProgress,
  paid: f.paid,
  receipt: f.receipt,
})
const discreteKey = (d: Discrete) =>
  `${d.phase}|${d.picked}|${d.checksShown}|${d.verdict}|${d.paid}|${d.receipt}|${Math.round(d.payProgress * 20)}|${d.pressed}|${d.clickKey}`

const ZERO_WAYPOINTS: DemoWaypoints = {
  rest: { x: 0, y: 0 },
  invoice: { x: 0, y: 0 },
  check: { x: 0, y: 0 },
  pay: { x: 0, y: 0 },
  receipt: { x: 0, y: 0 },
}

/** Step number the cursor is currently on (1–4, 0 = between loops). */
function activeStep(phase: DemoFrame['phase']): number {
  if (phase === 'rest' || phase === 'beat') return 0
  if (phase === 'pick') return 1
  if (phase === 'checking' || phase === 'checked') return 2
  if (phase === 'paying' || phase === 'paid') return 3
  return 4
}

function StepStatusIcon({ state }: { state: 'done' | 'active' | 'idle' }) {
  if (state === 'done') return <CheckCircle2 className="h-4 w-4 text-verified" aria-label="Done" />
  if (state === 'active')
    return <Loader2 className="h-4 w-4 animate-spin text-brand-600" aria-label="In progress" />
  return <CircleDashed className="h-4 w-4 text-muted" aria-label="Not started" />
}

export function HeroDemo({ items, stats, compact = false }: { items: InvoiceItem[]; stats: Stats | undefined; compact?: boolean }) {
  const demo = useMemo(() => demoInvoice(items), [items])
  const checks = useMemo(() => (demo ? demoCheckRows(demo) : []), [demo])
  const chips = useMemo(() => demoStatChips(items, stats), [items, stats])
  const rows = useMemo(() => demoTableRows(items), [items])

  const [reduced, setReduced] = useState(
    () => typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  )
  const [paused, setPaused] = useState(false)
  const [measured, setMeasured] = useState(false)
  const [ripples, setRipples] = useState<Array<{ id: number; x: number; y: number }>>([])
  // Live mode starts at the rest frame (nothing picked yet); the static
  // frame is only used when reduced motion is on or no demo invoice exists.
  const [discrete, setDiscrete] = useState<Discrete>(() => discreteOf(demoFrameAt(0, ZERO_WAYPOINTS)))

  const panelRef = useRef<HTMLDivElement | null>(null)
  const cursorRef = useRef<HTMLDivElement | null>(null)
  const clockRef = useRef(0)
  const waypointsRef = useRef<DemoWaypoints>(ZERO_WAYPOINTS)
  const pausedRef = useRef(false)
  const discreteKeyRef = useRef(discreteKey(discrete))
  const clickKeyRef = useRef(0)
  // Ripple ids must be unique across loops: the timeline's clickKey
  // restarts at 1 every 24 s loop, so using it as the React key rendered
  // two children with the same key `1` (React duplicate-key warning).
  const rippleIdRef = useRef(0)
  const rippleTimersRef = useRef<number[]>([])

  // Reduced-motion preference (live: follows the OS setting).
  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return
    const mq = window.matchMedia('(prefers-reduced-motion: reduce)')
    const onChange = () => setReduced(mq.matches)
    mq.addEventListener('change', onChange)
  return () => mq.removeEventListener('change', onChange)
  }, [])

  // Hovering the hero card pauses the demo (so the user can inspect it).
  // Listeners go on the hero section itself — the demo panel is only the
  // bottom of the card.
  useEffect(() => {
    const section = panelRef.current?.closest('section')
    if (!section) return
    const onEnter = () => {
      pausedRef.current = true
      setPaused(true)
    }
    const onLeave = () => {
      pausedRef.current = false
      setPaused(false)
    }
    section.addEventListener('mouseenter', onEnter)
    section.addEventListener('mouseleave', onLeave)
    return () => {
      section.removeEventListener('mouseenter', onEnter)
      section.removeEventListener('mouseleave', onLeave)
    }
  }, [])

  // Waypoints: centres of the demo targets, relative to the hero section.
  // Re-measured on layout, on resize, and whenever the demo invoice or
  // the table rows change (the panel never shifts mid-loop — every step
  // block is always rendered, and the receipt box reserves its full height
  // via the always-rendered invisible slots below — but the invoice list
  // loads async).
  useLayoutEffect(() => {
    const section = panelRef.current?.closest('section')
    if (!section) return
    const measure = () => {
      const s = section.getBoundingClientRect()
      const at = (target: string): { x: number; y: number } => {
        const el = section.querySelector(`[data-demo-target="${target}"]`)
        if (!el) return waypointsRef.current.invoice
        const r = el.getBoundingClientRect()
        return { x: r.left - s.left + r.width / 2, y: r.top - s.top + r.height / 2 }
      }
      const next: DemoWaypoints = {
        rest: at('rest'),
        invoice: demo ? at(`invoice-${demo.payable_id}`) : at('rest'),
        check: at('check'),
        pay: at('pay'),
        receipt: at('receipt'),
      }
      waypointsRef.current = next
      setMeasured(true)
    }
    measure()
    const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(measure) : null
    if (ro) ro.observe(section)
    return () => ro?.disconnect()
  }, [demo, rows.length])

  // The clock: rAF, paused on hover, frozen for reduced motion.
  // The demo NEVER scrolls the page: an earlier phase-follow
  // scrollIntoView (2026-11-25 tab bug) yanked the viewport back up to the
  // demo targets on every phase change while the panel was in view — so a
  // user who had clicked "Pay an invoice" and was reading the flow below
  // kept getting bounced back to the top. The walkthrough is a visual loop;
  // the user scrolls when they want.
  useEffect(() => {
    if (reduced || !demo) return
    let raf = 0
    let last = typeof performance !== 'undefined' ? performance.now() : 0
    const tick = (now: number) => {
      const dt = Math.min(100, now - last)
      last = now
      if (!pausedRef.current) {
        clockRef.current = (clockRef.current + dt) % DEMO_LOOP_MS
        const f = demoFrameAt(clockRef.current, waypointsRef.current)
        const el = cursorRef.current
        if (el) el.style.transform = `translate(${f.cursor.x}px, ${f.cursor.y}px) scale(${f.pressed ? 0.85 : 1})`
        if (f.clickKey !== clickKeyRef.current) {
          clickKeyRef.current = f.clickKey
          if (f.clickKey > 0) {
            const rippleId = ++rippleIdRef.current
            setRipples((r) => [...r, { id: rippleId, x: f.cursor.x, y: f.cursor.y }])
            const t = window.setTimeout(
              () => setRipples((r) => r.filter((x) => x.id !== rippleId)),
              700,
            )
            rippleTimersRef.current.push(t)
          }
        }
        const d = discreteOf(f)
        const k = discreteKey(d)
        if (k !== discreteKeyRef.current) {
          discreteKeyRef.current = k
          setDiscrete(d)
        }
      }
      raf = requestAnimationFrame(tick)
    }
    raf = requestAnimationFrame(tick)
    return () => {
      cancelAnimationFrame(raf)
      rippleTimersRef.current.forEach((t) => window.clearTimeout(t))
      rippleTimersRef.current = []
    }
  }, [reduced, demo])

  // Reduced motion (or no demo invoice yet): the static frame — finished
  // demo, no cursor, no motion.
  const frame: Discrete = reduced || !demo ? discreteOf(demoStaticFrame()) : discrete
  const step = activeStep(frame.phase)
  const stepState = (n: number): 'done' | 'active' | 'idle' => {
    const done =
      (n === 1 && frame.picked) || (n === 2 && frame.verdict) || (n === 3 && frame.paid) || (n === 4 && frame.receipt)
    if (done) return 'done'
    return step === n ? 'active' : 'idle'
  }

  return (
    <>
      <div
        ref={panelRef}
        data-demo-mode={reduced || !demo ? 'static' : 'live'}
        data-demo-phase={frame.phase}
        data-demo-compact={compact ? 'true' : undefined}
        className={compact ? 'px-4 py-5 sm:px-5' : 'border-t border-line bg-paper/60 px-5 py-6 sm:px-6'}
      >
        <div className="rounded-[12px] border border-dashed border-brand-600/50 bg-card p-4 sm:p-5" data-demo-target="rest">
          {/* Header — mirrors the real dashboard header (title + subtitle +
              link to the real thing), with the Demo badge. */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex flex-wrap items-center gap-2 text-[18px] font-medium text-ink">
                Dashboard
                <span className="rounded-full bg-brand-600 px-2.5 py-0.5 text-[11px] font-semibold text-white">
                  Demo
                </span>
                {paused && !reduced ? (
                  <span className="rounded-full bg-paper-2 px-2.5 py-0.5 text-[11px] font-semibold text-body">
                    Paused — move away to resume
                  </span>
                ) : null}
              </h3>
              <p className="mt-1 text-[13px] leading-relaxed text-muted">
                A walkthrough of the real dashboard — pick, check, pay, receipt. No real payment.
              </p>
            </div>
            <Link to="/dashboard" className="shrink-0 text-[13px] font-medium text-brand-700 hover:underline">
              View the real dashboard →
            </Link>
          </div>

          {!demo ? (
            // Loading skeleton — the SAME slots as the loaded demo, so the
            // card holds its height while the live list loads and the flow
            // section below does not jump (bug 1: an anchor scroll to
            // #invoice landed short because the card grew under it).
            <div role="status">
              <p className="mt-5 text-sm text-muted">Demo unavailable — the live invoice list is still loading.</p>
              <div className="mt-4 flex flex-wrap gap-2" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-[28px] w-[90px] !rounded-full" />
                ))}
              </div>
              <div className="mt-5" aria-hidden="true">
                <Skeleton className="h-[20px] w-[120px]" />
                <div className="mt-2 divide-y divide-line overflow-hidden rounded-[8px] border border-line bg-card">
                  {[0, 1, 2].map((i) => (
                    <div key={i} className="px-3 py-2">
                      <Skeleton className="h-[24px] w-full" />
                    </div>
                  ))}
                </div>
              </div>
              <div className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4" aria-hidden="true">
                {[0, 1, 2, 3].map((i) => (
                  <Skeleton key={i} className="h-[52px] w-full !rounded-[8px]" />
                ))}
              </div>
              <Skeleton className="mt-4 h-[20px] w-2/3" />
              <div className="mt-4" aria-hidden="true">
                <Skeleton className="h-[48px] w-[180px] !rounded-full" />
                <div className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2">
                  {[0, 1, 2, 3, 4, 5, 6, 7, 8].map((i) => (
                    <Skeleton key={i} className="h-[32px] w-full !rounded-[6px]" />
                  ))}
                </div>
              </div>
              <div className="mt-4" aria-hidden="true">
                <Skeleton className="h-[48px] w-[220px] !rounded-full" />
                <Skeleton className="mt-3 h-[6px] w-full !rounded-full" />
              </div>
              <Skeleton className="mt-4 h-[145px] w-full !rounded-[8px]" />
            </div>
          ) : (
            <>
              {/* Stat chips — mirror the real dashboard's 4 stat cards. */}
              <ul className="mt-4 flex flex-wrap gap-2" aria-label="Live totals">
                {chips.map((c) => (
                  <li
                    key={c.label}
                    className="rounded-full border border-line bg-paper px-3 py-1.5 text-xs text-body tabular-nums"
                  >
                    {c.label} <span className="font-semibold text-ink">{c.value ?? '—'}</span>
                  </li>
                ))}
              </ul>
              {/* N1 caption, always visible under the chips: the one refused
                  number and what it counts (same refusedCaption() as the
                  dashboard refused card). */}
              <p className="mt-2 text-xs text-muted">{refusedCaption(stats?.refused_on_chain_since_deploy)}</p>

              {/* Mini invoice table — mirrors "Live Invoices". */}
              <div className="mt-5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <h4 className="text-[15px] font-medium text-ink">Live Invoices</h4>
                  <p className="text-xs text-muted">
                    Showing {rows.length} of {items.length} invoices · Live from the test registry
                  </p>
                </div>
                <ul className="mt-2 divide-y divide-line overflow-hidden rounded-[8px] border border-line bg-card">
                  {rows.map((inv) => {
                    const picked = frame.picked && demo.payable_id === inv.payable_id
                    return (
                      <li
                        key={inv.payable_id}
                        data-demo-target={`invoice-${inv.payable_id}`}
                        className={`grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-3 ${compact ? 'py-2' : 'py-2.5'} sm:grid-cols-[minmax(0,1fr)_auto_auto_auto] sm:items-center ${
                          picked ? 'bg-verified-bg/60 ring-1 ring-inset ring-verified' : ''
                        }`}
                      >
                        <span className="flex min-w-0 items-center gap-2 text-[13px] font-medium text-ink">
                          <span className="truncate">Payable {inv.payable_id}</span>
                          {picked ? (
                            <span className="shrink-0 rounded-full bg-verified-bg px-2 py-0.5 text-[10px] font-semibold text-verified-fg">
                              Demo pick
                            </span>
                          ) : null}
                        </span>
                        <span className="text-[13px] text-body tabular-nums">{inv.amount_display}</span>
                        <span>
                          <InvoiceStatusPill status={derivedStatus(inv)} />
                        </span>
                        <span className="text-xs text-muted">{inv.due.slice(0, 10)}</span>
                      </li>
                    )
                  })}
                </ul>
              </div>

              {/* Step tracker — mirrors the real 01–04 flow steps. */}
              <ol className="mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {[
                  { n: 1, title: 'Pick an invoice' },
                  { n: 2, title: 'Check the invoice' },
                  { n: 3, title: 'Pay once' },
                  { n: 4, title: 'Receipt' },
                ].map((s) => (
                  <li
                    key={s.n}
                    className={`flex items-center gap-2 rounded-[8px] border px-3 py-2 ${
                      stepState(s.n) === 'done'
                        ? 'border-verified/40 bg-verified-bg/50'
                        : step === s.n
                          ? 'border-brand-600/50 bg-paper'
                          : 'border-line bg-card'
                    }`}
                  >
                    <StepStatusIcon state={stepState(s.n)} />
                    <span className="min-w-0">
                      <span className="block text-[11px] text-muted">0{s.n}</span>
                      <span className="block truncate text-[13px] font-medium text-ink">{s.title}</span>
                    </span>
                  </li>
                ))}
              </ol>

              {/* Step 01 — pick. */}
              <div className="mt-4">
                <p className="text-[13px] text-body" aria-live="polite">
                  {frame.picked ? (
                    <>
                      Demo pick: <span className="font-medium text-ink">Payable {demo.payable_id} · {demo.amount_display}</span> —
                      the soonest-due unpaid CCD invoice.
                    </>
                  ) : (
                    'The demo picks the soonest-due unpaid CCD invoice.'
                  )}
                </p>
              </div>

              {/* Step 02 — check. Mirrors CheckStep: button + check list +
                  verdict line. The button is an inert demo prop (no
                  onClick); only the virtual cursor "presses" it. */}
              <div className="mt-4">
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Check invoice (demo)"
                  data-demo-target="check"
                  className={`btn-ember ${step === 2 ? 'ring-2 ring-brand-600 ring-offset-2 ring-offset-card' : ''}`}
                >
                  {frame.verdict ? 'Checked ✓' : 'Check invoice'}
                </button>
                {/* The slot is always reserved: the line appears and
                    disappears with the phase, but the card never changes
                    height for it (bug 1 — layout shift under the anchor). */}
                <div className="mt-3 min-h-[20px]">
                  {frame.phase === 'checking' ? (
                    <p className="inline-flex items-center gap-2 text-sm text-muted" role="status">
                      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      Reading the chain… (check {frame.checksShown} of {DEMO_CHECK_COUNT}) — demo
                    </p>
                  ) : null}
                </div>
                {/* Compact mode (the small hero card): the 9 checks as a
                    tight 2-column grid of label + status — same labels,
                    same status words, no detail paragraphs. The full list
                    with details is the default (non-compact) rendering. */}
                {compact ? (
                  <ul className="mt-3 grid grid-cols-1 gap-1.5 sm:grid-cols-2" aria-label="Demo checks">
                    {checks.map((c, i) => {
                      const shown = i < frame.checksShown
                      const status = shown ? c.status : 'not_run'
                      return (
                        <li
                          key={c.id}
                          className="flex items-center gap-2 rounded-[6px] border border-line bg-card px-2.5 py-1.5"
                        >
                          <span className="shrink-0">
                            {status === 'ok' ? (
                              <CheckCircle2 className="h-3.5 w-3.5 text-verified" aria-label="Passed" />
                            ) : status === 'info' ? (
                              <Info className="h-3.5 w-3.5 text-muted" aria-label="Information" />
                            ) : (
                              <CircleDashed className="h-3.5 w-3.5 text-muted" aria-label="Not run" />
                            )}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-ink">{c.label}</span>
                          <span className="shrink-0 text-[11px] font-medium text-muted">
                            {status === 'ok' ? 'Passed' : status === 'info' ? 'Info' : 'Not run'}
                          </span>
                        </li>
                      )
                    })}
                  </ul>
                ) : (
                <ul className="mt-3 divide-y divide-line overflow-hidden rounded-[8px] border border-line bg-card">
                  {checks.map((c, i) => {
                    const shown = i < frame.checksShown
                    const status = shown ? c.status : 'not_run'
                    return (
                      <li key={c.id} className="flex items-start gap-3 px-3 py-2 sm:px-4">
                        <span className="mt-0.5 shrink-0">
                          {status === 'ok' ? (
                            <CheckCircle2 className="h-4 w-4 text-verified" aria-label="Passed" />
                          ) : status === 'info' ? (
                            <Info className="h-4 w-4 text-muted" aria-label="Information" />
                          ) : (
                            <CircleDashed className="h-4 w-4 text-muted" aria-label="Not run" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-[13px] font-medium text-ink">{c.label}</span>
                          <span className="block text-xs leading-relaxed text-muted">{shown ? c.detail : 'Not run yet — the demo reveals the checks one by one.'}</span>
                        </span>
                        <span className="ml-auto shrink-0 text-xs font-medium text-muted">
                          {status === 'ok' ? 'Passed' : status === 'info' ? 'Info' : 'Not run'}
                        </span>
                      </li>
                    )
                  })}
                </ul>
                )}
                {/* Slot reserved like the checking line above. */}
                <div className="mt-2 min-h-[20px]">
                  {frame.verdict ? (
                    <p className="text-[13px] font-medium text-ink" aria-live="polite">
                      Demo verdict: ready — the 4 gating checks passed (registered, agent, due, status).
                    </p>
                  ) : null}
                </div>
              </div>

              {/* Step 03 — pay. Mirrors PayStep's CCD button. */}
              <div className="mt-4">
                <button
                  type="button"
                  tabIndex={-1}
                  aria-label="Pay on chain (demo)"
                  data-demo-target="pay"
                  className={`btn-ember ${step === 3 ? 'ring-2 ring-brand-600 ring-offset-2 ring-offset-card' : ''}`}
                >
                  {frame.paid ? 'Paid ✓ — demo' : `Pay ${demo.amount_display} on chain`}
                </button>
                <div
                  className="mt-3 h-1.5 overflow-hidden rounded-full bg-paper-2"
                  role="progressbar"
                  aria-valuenow={Math.round(frame.payProgress * 100)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label="Demo payment progress"
                >
                  <div className="h-full rounded-full bg-brand-600 transition-[width] duration-150" style={{ width: `${frame.payProgress * 100}%` }} />
                </div>
                <p className="mt-2 text-[13px] text-body" aria-live="polite">
                  {frame.paid
                    ? 'Paid once — demo.'
                    : frame.phase === 'paying'
                      ? 'Paying on chain… (demo)'
                      : 'Nothing is paid until the demo presses a pay button.'}
                </p>
              </div>

              {/* Step 04 — receipt. Mirrors ReceiptCard's shape; the
                  transactions line says plainly that no hash exists. The
                  heading, the definition list and BOTH paragraph groups are
                  always rendered — the inactive group is `invisible`
                  (kept in layout, hidden from sight and screen readers),
                  stacked in one grid cell so the box height is the taller
                  of the two states at all times. The box therefore holds
                  its height when the receipt arrives and the card does not
                  grow mid-loop (bug 1): the old conditional render grew
                  it ~100 px every 24 s loop and shifted #invoice below. */}
              <div className={`mt-4 rounded-[8px] border border-line bg-card ${compact ? 'p-3' : 'p-4'}`} data-demo-target="receipt">
                <h4 className={`text-[16px] font-medium text-ink ${frame.receipt ? '' : 'invisible'}`} aria-hidden={!frame.receipt}>
                  Paid once.
                </h4>
                <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
                  <div>
                    <dt className="text-muted">Payable</dt>
                    <dd className="font-medium text-ink">{frame.receipt ? demo.payable_id : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Amount</dt>
                    <dd className="font-medium text-ink">{frame.receipt ? demo.amount_display : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Payee (from the chain)</dt>
                    <dd className="text-ink">{frame.receipt ? 'Demo: the stored payee on chain.' : '—'}</dd>
                  </div>
                  <div>
                    <dt className="text-muted">Paid from</dt>
                    <dd className="text-ink">{frame.receipt ? 'Demo payer' : '—'}</dd>
                  </div>
                </dl>
                <div className="grid">
                  <div
                    data-testid="demo-receipt-body"
                    className={`col-start-1 row-start-1 ${frame.receipt ? '' : 'invisible'}`}
                    aria-hidden={!frame.receipt}
                  >
                    <p className="mt-3 text-[13px] text-muted">
                      Transactions: none — demo only. No chain call was made, so no transaction hash exists.
                    </p>
                    <p className="mt-2 text-[13px] text-ink" aria-live="polite">
                      Demo: 9 checks shown, verdict ready — no chain call was made.
                    </p>
                    <p className="mt-3 border-t border-line pt-3 text-xs text-muted">
                      Demo receipt — not a real payment. No money moved.
                    </p>
                  </div>
                  <p
                    data-testid="demo-receipt-empty"
                    className={`col-start-1 row-start-1 mt-3 text-[13px] text-muted ${frame.receipt ? 'invisible' : ''}`}
                    aria-hidden={frame.receipt}
                  >
                    Your receipt appears here after a payment. Nothing is paid until you press a pay button.
                  </p>
                </div>
              </div>

              <p className="mt-4 text-[11px] leading-relaxed text-muted">
                Demo — the walkthrough above is canned: the table and chips show live numbers from the test
                registry, but the checks, the payment and the receipt are a demo. No payment was made and
                the demo made no chain call.
              </p>
            </>
          )}
        </div>
      </div>

      {/* Virtual cursor — absolute over the whole hero section, above the
          content, never intercepting pointer events. Rendered only in live
          mode once the targets are measured. */}
      {!reduced && demo && measured ? (
        <div aria-hidden="true" data-demo-cursor="true" className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
          {ripples.map((r) => (
            <span
              key={r.id}
              className="demo-ripple absolute h-9 w-9 rounded-full border-2 border-brand-600"
              style={{ left: r.x, top: r.y }}
            />
          ))}
          <div
            ref={cursorRef}
            className="absolute top-0 left-0 will-change-transform"
            style={{ transform: 'translate(0px, 0px)' }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" style={{ margin: '-2px 0 0 -2px', filter: 'drop-shadow(0 1px 2px rgba(23,19,16,0.4))' }}>
              <path
                d="M5 3 L5 19 L9.5 14.5 L12.5 21 L15 19.8 L12 13.5 L19 13.5 Z"
                fill="#B4430F"
                stroke="#FFFFFF"
                strokeWidth="1.4"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      ) : null}
    </>
  )
}
