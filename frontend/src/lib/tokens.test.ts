// Contrast — every pair in CONTRAST_PAIRS (P2 §4.3 table) must be WCAG AA
// (>= 4.5:1). Same computation as scripts/check-contrast.mjs, which runs
// without the TS toolchain; both must pass.
import { describe, expect, it } from 'vitest'
import { CONTRAST_PAIRS } from './tokens'

export function luminance(hex: string): number {
  const c = hex.replace('#', '')
  const rgb = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

export function contrastRatio(fg: string, bg: string): number {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

describe('CONTRAST_PAIRS (P2 §4.3 — WCAG AA >= 4.5:1)', () => {
  it('has a pair for every text-on-background combination in the design', () => {
    expect(CONTRAST_PAIRS.length).toBeGreaterThanOrEqual(10)
  })
  for (const p of CONTRAST_PAIRS) {
    it(`${p.name}: ${p.fg} on ${p.bg} >= 4.5:1`, () => {
      expect(contrastRatio(p.fg, p.bg)).toBeGreaterThanOrEqual(4.5)
    })
  }
})
