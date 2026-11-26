import { describe, expect, it } from 'vitest'
import { PO_CONTRAST_PAIRS } from './tokens'

function lum(hex: string): number {
  const c = hex.replace('#', '')
  const [r, g, b] = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
function ratio(a: string, b: string): number {
  const [hi, lo] = lum(a) >= lum(b) ? [lum(a), lum(b)] : [lum(b), lum(a)]
  return (hi + 0.05) / (lo + 0.05)
}

describe('app tokens', () => {
  it('every app text pair is WCAG AA (4.5:1)', () => {
    for (const p of PO_CONTRAST_PAIRS) {
      expect(ratio(p.fg, p.bg), `${p.name} ${p.fg} on ${p.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })
})
