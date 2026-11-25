// heroDemo — the tour cursor timeline: pure clock → frame, unit-tested.
// One 18 s loop: rest, then a move + dwell at each landmark in tour
// order, then a drift back to rest and a beat. Dwelling is a pause with a
// soft highlight — never a press, never a click, never a ripple (the
// re-review of main 63a7eee rejected the press scale + click ring as a
// fake hand pressing dead controls).
import { describe, expect, it } from 'vitest'
import { curvedPoint, tourFrameAt, TOUR_LOOP_MS, TOUR_STOPS, type TourWaypoints } from './heroDemo'

const W: TourWaypoints = {
  rest: { x: 0, y: 0 },
  sidebar: { x: 100, y: 0 },
  strip: { x: 100, y: 100 },
  chart: { x: 0, y: 100 },
  gauge: { x: 200, y: 200 },
  rails: { x: 300, y: 100 },
  insights: { x: 300, y: 300 },
  dues: { x: 0, y: 300 },
}

describe('tourFrameAt', () => {
  it('rests at the rest waypoint, not dwelling', () => {
    expect(tourFrameAt(0, W)).toEqual({ cursor: { x: 0, y: 0 }, dwelling: false, stop: 'rest' })
    expect(tourFrameAt(1199, W).stop).toBe('rest')
    expect(tourFrameAt(1199, W).dwelling).toBe(false)
  })

  it('dwells once at each landmark in tour order, then drifts back to rest', () => {
    // Dwell windows: stop i dwells at 2200 + i*1700 for 700 ms.
    TOUR_STOPS.forEach((key, i) => {
      const dwellStart = 2200 + i * 1700
      const atDwell = tourFrameAt(dwellStart + 100, W)
      expect(atDwell.stop).toBe(key)
      expect(atDwell.cursor).toEqual(W[key])
      expect(atDwell.dwelling).toBe(true)
      // The cursor stays at the stop for the whole dwell — no press,
      // no click key, no ripple trigger in the frame at all.
      const settled = tourFrameAt(dwellStart + 500, W)
      expect(settled.dwelling).toBe(true)
      expect(settled.cursor).toEqual(W[key])
      expect(settled).not.toHaveProperty('pressed')
      expect(settled).not.toHaveProperty('clickKey')
      // Moving again: dwelling off.
      const moving = tourFrameAt(dwellStart + 700 + 100, W)
      expect(moving.dwelling).toBe(false)
    })
    // Return move + beat: back at rest, not dwelling.
    expect(tourFrameAt(14100, W)).toMatchObject({ stop: 'rest', dwelling: false })
    expect(tourFrameAt(TOUR_LOOP_MS - 1, W)).toMatchObject({ cursor: { x: 0, y: 0 }, dwelling: false, stop: 'rest' })
  })

  it('wraps: one loop later the frame repeats', () => {
    expect(tourFrameAt(TOUR_LOOP_MS + 500, W)).toEqual(tourFrameAt(500, W))
    expect(tourFrameAt(-500, W)).toEqual(tourFrameAt(TOUR_LOOP_MS - 500, W))
  })

  it('moves along a curve, not a straight line', () => {
    const mid = curvedPoint({ x: 0, y: 0 }, { x: 100, y: 0 }, 0.5)
    expect(mid.x).toBe(50)
    expect(mid.y).not.toBe(0)
  })
})
