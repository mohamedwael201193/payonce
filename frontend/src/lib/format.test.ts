// Formatting helpers — P3 §2 rules 9 and 13.
import { describe, expect, it } from 'vitest'
import { formatAmount, formatCcd, formatCountdown, formatDueIn, formatEudemo, formatUtcTime, truncHash } from './format'

describe('truncHash (P3 §2 rule 13: first 8 + last 6)', () => {
  it('truncates a 64-char hash', () => {
    const h = 'a5ec5e4027523c564d81960cb0ec48b546c270ec5f43256f15cf5d34f98d6848'
    expect(truncHash(h)).toBe('a5ec5e40…8d6848')
  })
  it('returns short values unchanged and "—" for empty', () => {
    expect(truncHash('abc')).toBe('abc')
    expect(truncHash('')).toBe('—')
  })
})

describe('formatAmount / formatCcd / formatEudemo (6 decimals)', () => {
  it('formats base units', () => {
    expect(formatAmount('500000')).toBe('0.5')
    expect(formatAmount('10000')).toBe('0.01')
    expect(formatAmount('1000000')).toBe('1')
  })
  it('labels the asset', () => {
    expect(formatCcd('500000')).toBe('0.5 CCD')
    expect(formatEudemo('10000')).toBe('0.01 EUDemo')
  })
})

describe('formatUtcTime', () => {
  it('renders HH:MM:SS and "—" for garbage', () => {
    expect(formatUtcTime('2026-11-24T10:42:07Z')).toBe('10:42:07')
    expect(formatUtcTime('not-a-date')).toBe('—')
  })
})

describe('formatCountdown', () => {
  it('renders mm:ss and clamps at 0:00', () => {
    expect(formatCountdown(300)).toBe('5:00')
    expect(formatCountdown(61)).toBe('1:01')
    expect(formatCountdown(-5)).toBe('0:00')
  })
})

describe('formatDueIn', () => {
  it('renders a future due date and "past due"', () => {
    const future = new Date(Date.now() + 2 * 60 * 60 * 1000 + 14 * 60 * 1000).toISOString()
    // Minute-boundary tolerant: a few ms may elapse between construction and formatting.
    expect(formatDueIn(future)).toMatch(/^in 2h 1[34]m$/)
    expect(formatDueIn('2020-01-01T00:00:00Z')).toBe('past due')
    expect(formatDueIn('garbage')).toBe('—')
  })
})
