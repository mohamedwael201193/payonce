// Hero demo — the TOUR cursor over the tall demo dashboard.
// Restored 2026-11-26 (fix-back): the design merge deleted the animated
// mouse (the old looping walkthrough's cursor) and the user noticed —
// "the mouse that was working got removed". The cursor is back, retargeted:
// the tall demo has no steps, no buttons and no pay flow to walk through,
// so the cursor is a tour guide, not a fake hand. It glides between the
// demo's landmarks (sidebar → header strip → chart → gauge → rails →
// insights → next 14 days) on an 18 s loop and DWELLS at each stop — a
// soft highlight behind the arrow while it rests there. It never presses,
// never clicks, never ripples: a click gesture on a span that does nothing
// is a fake hand pressing dead controls, and the demo has nothing to
// press (there is no functional control in it except the real "View the
// real dashboard →" link, which the cursor never targets). Pure logic
// only: the component owns the clock (rAF, paused on hover, frozen for
// reduced motion); this function maps clock → frame so the pacing is
// unit-testable. Nothing here calls the API or mutates state. The demo
// makes ZERO network calls: it only renders props.
// Label rule (user order 2026-11-24 21:49): the word is "Demo" — never
// "Simulation" / "Simulated" anywhere in the demo UI or this module's
// user-facing strings.

export interface TourWaypoint {
  x: number
  y: number
}

export interface TourWaypoints {
  rest: TourWaypoint
  sidebar: TourWaypoint
  strip: TourWaypoint
  chart: TourWaypoint
  gauge: TourWaypoint
  rails: TourWaypoint
  insights: TourWaypoint
  dues: TourWaypoint
}

export interface TourFrame {
  /** Cursor centre, relative to the demo panel. */
  cursor: TourWaypoint
  /** True while the cursor is dwelling at a stop (soft highlight on). */
  dwelling: boolean
  /** Which landmark the cursor is at ('rest' between stops). */
  stop: string
}

export const TOUR_LOOP_MS = 18000

const MOVE_MS = 1000
const DWELL_MS = 700
const REST_MS = 1200

/** The tour order — the landmarks, in the order a reader's eye crosses them. */
export const TOUR_STOPS = ['sidebar', 'strip', 'chart', 'gauge', 'rails', 'insights', 'dues'] as const
export type TourStopKey = (typeof TOUR_STOPS)[number]

const clamp01 = (v: number) => Math.min(1, Math.max(0, v))
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2)

/** Quadratic bezier with a fixed perpendicular bow, so the path curves
// like a human hand instead of a robotic straight line. (Restored from the
// old walkthrough timeline — same curve, new landmarks.) The bow is
// perpendicular to the travel direction, so the curve scales with the
// card (mobile and desktop get the same gesture, smaller). */
export function curvedPoint(from: TourWaypoint, to: TourWaypoint, t: number): TourWaypoint {
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

function move(from: TourWaypoint, to: TourWaypoint, start: number, end: number, clock: number): TourWaypoint {
  return curvedPoint(from, to, easeInOutCubic(clamp01((clock - start) / (end - start))))
}

/** Map clock → tour frame. One loop: rest, then a move + dwell at each
// landmark in tour order, then a drift back to rest and a beat. Dwelling
// is a pause with a soft highlight — never a press, never a click ring. */
export function tourFrameAt(clockMs: number, w: TourWaypoints): TourFrame {
  const clock = ((clockMs % TOUR_LOOP_MS) + TOUR_LOOP_MS) % TOUR_LOOP_MS
  if (clock < REST_MS) return { cursor: w.rest, dwelling: false, stop: 'rest' }
  let t = REST_MS
  let from: TourWaypoint = w.rest
  for (let i = 0; i < TOUR_STOPS.length; i++) {
    const key = TOUR_STOPS[i]
    const to = w[key]
    if (clock < t + MOVE_MS) {
      return { cursor: move(from, to, t, t + MOVE_MS, clock), dwelling: false, stop: key }
    }
    t += MOVE_MS
    if (clock < t + DWELL_MS) {
      return { cursor: to, dwelling: true, stop: key }
    }
    t += DWELL_MS
    from = to
  }
  if (clock < t + MOVE_MS) {
    return { cursor: move(from, w.rest, t, t + MOVE_MS, clock), dwelling: false, stop: 'rest' }
  }
  return { cursor: w.rest, dwelling: false, stop: 'rest' }
}
