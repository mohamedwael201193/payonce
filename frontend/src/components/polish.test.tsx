// polish — CountUp (bug 3: numbers re-rendering), Gauge, useSlowLoad
// (bug 6: stuck loaders). CountUp must animate FROM the previous value on a
// real change — never from 0 after mount (the first mount animates 0 →
// value, hidden behind the loading skeleton) — and must not re-animate when
// the value is unchanged. Gauge renders the live paid-once share. useSlowLoad
// turns true after 15 s of continuous loading.
//
// rAF + performance.now are stubbed the same way HeroDemo.test.tsx does:
// a single-slot rAF queue and a controllable clock, so each animation
// frame is driven deterministically. (Fake timers do NOT work here: the
// faked rAF timestamp starts near 0 while performance.now() stays real,
// so (t - t0) goes hugely negative and the value explodes.)
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CountUp, Gauge, useSlowLoad } from './polish'

describe('CountUp', () => {
  let rafCb: FrameRequestCallback | null
  let now: number

  beforeEach(() => {
    rafCb = null
    now = 1000
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      rafCb = cb
      return 1
    })
    vi.stubGlobal('cancelAnimationFrame', () => {
      rafCb = null
    })
    vi.spyOn(performance, 'now').mockImplementation(() => now)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  /** Advance the rAF clock by ms in 16 ms frames. */
  const advance = (ms: number) => {
    const steps = Math.ceil(ms / 16)
    for (let i = 0; i < steps; i++) {
      now += 16
      const cb = rafCb
      rafCb = null
      act(() => {
        cb?.(now)
      })
    }
  }

  it('animates from the previous value on a change, never from 0 after mount', () => {
    const { rerender } = render(<CountUp value={5} />)
    advance(700)
    expect(screen.getByText('5')).toBeInTheDocument()
    rerender(<CountUp value={7} />)
    // One frame into the 5 → 7 animation the text is still 5 — never 0.
    advance(16)
    expect(screen.queryByText('0')).not.toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
    advance(700)
    expect(screen.getByText('7')).toBeInTheDocument()
  })

  it('does not re-animate from 0 when the value is unchanged', () => {
    const { rerender } = render(<CountUp value={5} />)
    advance(700)
    expect(screen.getByText('5')).toBeInTheDocument()
    rerender(<CountUp value={5} />)
    // A re-animation from 0 would show "0" on its first frame.
    advance(16)
    expect(screen.queryByText('0')).not.toBeInTheDocument()
    expect(screen.getByText('5')).toBeInTheDocument()
  })
})

describe('Gauge', () => {
  it('renders the live paid-once share', () => {
    render(<Gauge pct={60} label="3 of 5 payables paid once" />)
    expect(screen.getByText('60%')).toBeInTheDocument()
    expect(screen.getByText('3 of 5 payables paid once')).toBeInTheDocument()
  })
})

describe('useSlowLoad', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  function SlowProbe({ active }: { active: boolean }) {
    const slow = useSlowLoad(active)
    return <p>{slow ? 'slow' : 'fast'}</p>
  }

  it('turns true after 15 s of continuous loading, false when loading ends', () => {
    const { rerender } = render(<SlowProbe active />)
    expect(screen.getByText('fast')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(14_999)
    })
    expect(screen.getByText('fast')).toBeInTheDocument()
    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(screen.getByText('slow')).toBeInTheDocument()
    rerender(<SlowProbe active={false} />)
    expect(screen.getByText('fast')).toBeInTheDocument()
  })
})
