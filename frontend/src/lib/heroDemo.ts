// Hero demo — the looping "Demo" walkthrough inside the hero card.
// Pure logic only: the demo invoice picker, the canned demo check rows
// (same labels as the real before-pay verifier, api/src/verifier-v2.mjs
// verifyBeforePay), and the timeline that drives the virtual cursor.
// NOTHING here calls the API or mutates state: the checks, the payment and
// the receipt are canned demo content, labelled "Demo" in the UI. The only
// live inputs are the invoice list + stats, passed in as props.
// Label rule (user order 2026-11-24 21:49): the word is "Demo" — never
// "Simulation" / "Simulated" anywhere in the demo UI or this module's
// user-facing strings.
import type { InvoiceItem, Stats } from './types'
import { parseAmount } from './heroOverview'

/** The demo invoice: soonest-due unpaid CCD payable that is not past due.
// Past-due payables are skipped on purpose — the real verifier fails the
// "due" check for them, so a past-due demo would show a blocked verdict
// and the walkthrough could not reach the receipt. Returns null when no
// such payable exists (the demo then shows "unavailable"). */
export function demoInvoice(items: InvoiceItem[], nowMs = Date.now()): InvoiceItem | null {
  const dueMs = (i: InvoiceItem) => new Date(i.due).getTime()
  const candidates = items
    .filter((i) => i.status !== 'paid' && parseAmount(i.amount_display).asset === 'CCD')
    .filter((i) => !Number.isNaN(dueMs(i)) && dueMs(i) > nowMs)
    .sort((a, b) => a.due.localeCompare(b.due))
  return candidates[0] ?? null
}

export type DemoCheckStatus = 'ok' | 'info' | 'not_run'

export interface DemoCheckRow {
  id: string
  label: string
  status: DemoCheckStatus
  detail: string
}

/** The 9 before-pay checks, same labels and verdict rule as the real
// verifier (registered + agent + due + status ok, doc ok-or-not-run →
// ready). Statuses are the ones the real verifier gives for a normal
// unpaid CCD payable: the doc row is "not run" (no document is supplied
// in the demo — exactly like the real flow without a document), identity /
// payee / amount are "info" (never gates), the rest pass. Every detail is
// prefixed "Demo:" so no row can be mistaken for a live verifier result. */
export function demoCheckRows(inv: InvoiceItem): DemoCheckRow[] {
  const dueDay = inv.due.slice(0, 10)
  return [
    {
      id: 'registered',
      label: 'Payable is registered on the test registry',
      status: 'ok',
      detail: `Demo: id=${inv.payable_id}, asset=CCD, amount=${inv.amount_display}`,
    },
    {
      id: 'doc',
      label: 'Invoice document matches the on-chain hash',
      status: 'not_run',
      detail: 'Demo: no invoice document supplied — same as the real flow without a document.',
    },
    {
      id: 'agent',
      label: 'Seller agent is Active on the official CIS-8004 registry',
      status: 'ok',
      detail: 'Demo: seller agent token 1476, Active on <12802,0>.',
    },
    {
      id: 'identity',
      label: 'Seller identity',
      status: 'info',
      detail: 'Demo: no company (LEI) proof attached — same as the real flow.',
    },
    {
      id: 'payee',
      label: 'Payee on the invoice',
      status: 'info',
      detail: 'Demo: payee is the stored payee on chain.',
    },
    {
      id: 'amount',
      label: 'Amount on the invoice',
      status: 'info',
      detail: `Demo: ${inv.amount_display}.`,
    },
    {
      id: 'due',
      label: 'Invoice is not past due',
      status: 'ok',
      detail: `Demo: due ${dueDay}, not past due.`,
    },
    {
      id: 'status',
      label: 'Payable is Unpaid',
      status: 'ok',
      detail: 'Demo: status=Unpaid.',
    },
    {
      id: 'balance',
      label: 'Payer balance covers the payment',
      status: 'ok',
      detail: 'Demo: payer covers the payment (testnet demo payer).',
    },
  ]
}

/** The 4 stat chips mirror the real dashboard's 4 stat cards, from the
// same live inputs (stats + the live invoice list). One source, like the
// dashboard cards: Total/Paid/Unpaid are counted from the LIST itself (the
// stats total can be a different snapshot), and Refused is null until
// /api/stats answers — never a 0 placeholder (bug 4). */
export function demoStatChips(items: InvoiceItem[], stats: Stats | undefined): Array<{ label: string; value: number | null }> {
  const paid = items.filter((i) => i.status === 'paid').length
  return [
    { label: 'Total', value: items.length },
    { label: 'Paid', value: paid },
    { label: 'Unpaid', value: items.length - paid },
    { label: 'Refused', value: stats?.refused_on_chain_since_deploy ?? null },
  ]
}

/** The demo table mirrors the real "Live Invoices" table: the 3
// soonest-due unpaid payables, soonest first. */
export function demoTableRows(items: InvoiceItem[]): InvoiceItem[] {
  return [...items.filter((i) => i.status !== 'paid')].sort((a, b) => a.due.localeCompare(b.due)).slice(0, 3)
}

// ---------------------------------------------------------------------------
// Timeline — one loop, driven by a millisecond clock. The component owns
// the clock (rAF, paused on hover, frozen for reduced motion); this pure
// function maps clock → frame so the pacing is unit-testable.
// ---------------------------------------------------------------------------

export type DemoPhase =
  | 'rest'
  | 'pick'
  | 'checking'
  | 'checked'
  | 'paying'
  | 'paid'
  | 'receipt'
  | 'beat'

export interface DemoWaypoint {
  x: number
  y: number
}

export interface DemoWaypoints {
  rest: DemoWaypoint
  invoice: DemoWaypoint
  check: DemoWaypoint
  pay: DemoWaypoint
  receipt: DemoWaypoint
}

export interface DemoFrame {
  phase: DemoPhase
  /** Cursor centre, relative to the hero section. */
  cursor: DemoWaypoint
  /** True while the cursor is pressing (click). */
  pressed: boolean
  /** Increments on every click — the ripple re-triggers on change. */
  clickKey: number
  picked: boolean
  /** How many of the 9 check rows are revealed. */
  checksShown: number
  verdict: boolean
  /** 0..1 payment progress. */
  payProgress: number
  paid: boolean
  receipt: boolean
}

export const DEMO_LOOP_MS = 24000
export const DEMO_CHECK_COUNT = 9

/** Segment boundaries (ms) — professional pacing, nothing frantic. */
const T = {
  restEnd: 1500,
  pickMoveEnd: 2700,
  pickEnd: 3700,
  checkMoveEnd: 4900,
  checkPressEnd: 5100,
  checkingEnd: 8600,
  checkedEnd: 9600,
  payMoveEnd: 10800,
  payPressEnd: 11000,
  payingEnd: 14500,
  paidEnd: 15500,
  receiptMoveEnd: 16700,
  receiptEnd: 21700,
  driftEnd: 22900,
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Quadratic bezier with a fixed perpendicular bow, so the path curves
// like a human hand instead of a robotic straight line. The bow is
// perpendicular to the travel direction, so the curve scales with the
// card (mobile and desktop get the same gesture, smaller). */
export function curvedPoint(from: DemoWaypoint, to: DemoWaypoint, t: number): DemoWaypoint {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const len = Math.hypot(dx, dy) || 1
  const bow = Math.min(28, len * 0.18)
  const cx = (from.x + to.x) / 2 + (-dy / len) * bow
  const cy = (from.y + to.y) / 2 + (dx / len) * bow
  const u = 1 - t
  return {
    x: u * u * from.x + 2 * u * t * cx + t * t * to.x,
    y: u * u * from.y + 2 * u * t * cy + t * t * to.y,
  }
}

function move(from: DemoWaypoint, to: DemoWaypoint, start: number, end: number, clock: number): DemoWaypoint {
  return curvedPoint(from, to, easeInOutCubic(clamp01((clock - start) / (end - start))))
}

export function demoFrameAt(clockMs: number, w: DemoWaypoints): DemoFrame {
  const clock = ((clockMs % DEMO_LOOP_MS) + DEMO_LOOP_MS) % DEMO_LOOP_MS
  const base = (phase: DemoPhase, cursor: DemoWaypoint, extra: Partial<DemoFrame> = {}): DemoFrame => ({
    phase,
    cursor,
    pressed: false,
    clickKey: 0,
    picked: false,
    checksShown: 0,
    verdict: false,
    payProgress: 0,
    paid: false,
    receipt: false,
    ...extra,
  })

  if (clock < T.restEnd) return base('rest', w.rest)
  if (clock < T.pickMoveEnd) return base('pick', move(w.rest, w.invoice, T.restEnd, T.pickMoveEnd, clock))
  if (clock < T.pickEnd) {
    // Press at +200ms into the pause, then the row is picked.
    const pressed = clock < T.pickMoveEnd + 200
    return base('pick', w.invoice, { pressed, clickKey: 1, picked: clock >= T.pickMoveEnd + 200 })
  }
  if (clock < T.checkMoveEnd)
    return base('pick', move(w.invoice, w.check, T.pickEnd, T.checkMoveEnd, clock), { picked: true, clickKey: 1 })
  if (clock < T.checkPressEnd)
    return base('checking', w.check, {
      picked: true,
      clickKey: 2,
      pressed: clock < T.checkMoveEnd + 200,
    })
  if (clock < T.checkingEnd) {
    const shown = Math.min(DEMO_CHECK_COUNT, Math.floor((clock - T.checkPressEnd) / 380) + 1)
    return base('checking', w.check, { picked: true, clickKey: 2, checksShown: shown })
  }
  if (clock < T.checkedEnd)
    return base('checked', w.check, { picked: true, clickKey: 2, checksShown: DEMO_CHECK_COUNT, verdict: true })
  if (clock < T.payMoveEnd)
    return base(
      'checked',
      move(w.check, w.pay, T.checkedEnd, T.payMoveEnd, clock),
      { picked: true, clickKey: 2, checksShown: DEMO_CHECK_COUNT, verdict: true },
    )
  if (clock < T.payPressEnd)
    return base('paying', w.pay, {
      picked: true,
      clickKey: 3,
      checksShown: DEMO_CHECK_COUNT,
      verdict: true,
      pressed: clock < T.payMoveEnd + 200,
    })
  if (clock < T.payingEnd) {
    const progress = clamp01((clock - T.payPressEnd) / (T.payingEnd - T.payPressEnd))
    return base('paying', w.pay, {
      picked: true,
      clickKey: 3,
      checksShown: DEMO_CHECK_COUNT,
      verdict: true,
      payProgress: progress,
    })
  }
  if (clock < T.paidEnd)
    return base('paid', w.pay, {
      picked: true,
      clickKey: 3,
      checksShown: DEMO_CHECK_COUNT,
      verdict: true,
      payProgress: 1,
      paid: true,
    })
  if (clock < T.receiptMoveEnd)
    return base(
      'paid',
      move(w.pay, w.receipt, T.paidEnd, T.receiptMoveEnd, clock),
      {
        picked: true,
        clickKey: 3,
        checksShown: DEMO_CHECK_COUNT,
        verdict: true,
        payProgress: 1,
        paid: true,
      },
    )
  if (clock < T.receiptEnd)
    return base('receipt', w.receipt, {
      picked: true,
      clickKey: 3,
      checksShown: DEMO_CHECK_COUNT,
      verdict: true,
      payProgress: 1,
      paid: true,
      receipt: true,
    })
  if (clock < T.driftEnd)
    return base(
      'receipt',
      move(w.receipt, w.rest, T.receiptEnd, T.driftEnd, clock),
      {
        picked: true,
        clickKey: 3,
        checksShown: DEMO_CHECK_COUNT,
        verdict: true,
        payProgress: 1,
        paid: true,
        receipt: true,
      },
    )
  return base('beat', w.rest, {
    picked: true,
    clickKey: 3,
    checksShown: DEMO_CHECK_COUNT,
    verdict: true,
    payProgress: 1,
    paid: true,
    receipt: true,
  })
}

/** The static frame for prefers-reduced-motion: the finished demo, no
// cursor, no motion. */
export function demoStaticFrame(): Omit<DemoFrame, 'cursor'> {
  return {
    phase: 'receipt',
    pressed: false,
    clickKey: 0,
    picked: true,
    checksShown: DEMO_CHECK_COUNT,
    verdict: true,
    payProgress: 1,
    paid: true,
    receipt: true,
  }
}
