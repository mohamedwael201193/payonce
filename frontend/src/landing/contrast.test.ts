import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(process.cwd() + '/src/landing/landing.css', 'utf8')
const tok = (n: string) => css.match(new RegExp(String.raw`--po-${n}: *(#[0-9a-f]{6})`, 'i'))![1]
const lum = (h: string) => {
  const c = [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
  return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]
}
const ratio = (a: string, b: string) => {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}
const pairs: [string, string, string, number][] = [
  ['grey on paper', 'grey', 'paper', 4.5], ['grey on paper-2', 'grey', 'paper-2', 4.5], ['ink on paper', 'ink', 'paper', 4.5],
  ['accent text on paper', 'accent-text', 'paper', 4.5], ['ok on paper', 'ok', 'paper', 4.5], ['bad on paper', 'bad', 'paper', 4.5],
  ['ok on ok-bg', 'ok', 'ok-bg', 4.5], ['on-dark on ink', 'on-dark', 'ink', 4.5], ['on-dark-grey on ink', 'on-dark-grey', 'ink-2', 4.5],
  ['bad-on-dark on ink-2', 'bad-on-dark', 'ink-2', 4.5], ['ok-on-dark on ink', 'ok-on-dark', 'ink', 4.5],
  ['grey on card', 'grey', 'card', 4.5], ['white on sky-0 (lead text)', 'white', 'sky-0', 4.5], ['white on sky-1 (large)', 'white', 'sky-1', 3],
]
describe('landing contrast', () => {
  for (const [name, a, b, min] of pairs) it(name, () => expect(ratio(tok(a), tok(b))).toBeGreaterThanOrEqual(min))
})
