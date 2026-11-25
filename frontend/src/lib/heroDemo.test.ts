// heroDemo — the tour cursor timeline: pure clock → frame, unit-tested.
// One 18 s loop: rest, then a move + dwell (pulse) at each landmark in
// tour order, then a drift back to rest and a beat. The clickKey increments
// once per stop (on dwell entry) so the component's ripple fires exactly
// once per landmark per loop.
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
  it('rests at the rest waypoint with no press and clickKey 0', () => {
    expect(tourFrameAt(0, W)).toEqual({ cursor: { x: 0, y: 0 }, pressed: false, clickKey: 0, stop: 'rest' })
    expect(tourFrameAt(1199, W).stop).toBe('rest')
  })

  it('pulses once at each landmark in tour order, then drifts back to rest', () => {
    // Dwell windows: stop i dwells at 2200 + i*1700 for 700 ms (pressed
    // for the first 200 ms of the dwell).
    TOUR_STOPS.forEach((key, i) => {
      const dwellStart = 2200 + i * 1700
      const atDwell = tourFrameAt(dwellStart + 100, W)
      expect(atDwell.stop).toBe(key)
      expect(atDwell.cursor).toEqual(W[key])
      expect(atDwell.pressed).toBe(true)
      expect(atDwell.clickKey).toBe(i + 1)
      // Press ends 200 ms into the dwell; the cursor stays at the stop.
      const settled = tourFrameAt(dwellStart + 500, W)
      expect(settled.pressed).toBe(false)
      expect(settled.clickKey).toBe(i + 1)
      expect(settled.cursor).toEqual(W[key])
    })
    // Return move + beat: back at rest, clickKey stays 7, no new pulse.
    expect(tourFrameAt(14100, W)).toMatchObject({ stop: 'rest', clickKey: 7 })
    expect(tourFrameAt(TOUR_LOOP_MS - 1, W)).toMatchObject({ cursor: { x: 0, y: 0 }, clickKey: 7, stop: 'rest' })
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
