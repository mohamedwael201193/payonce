// Contrast check — reads CONTRAST_PAIRS out of src/lib/tokens.ts and verifies
// every pair is WCAG AA (>= 4.5:1). Runs without the TS toolchain (plain node),
// so `npm run check:contrast` works even before a build. The same pairs are
// checked at runtime by src/lib/tokens.test.ts; both must pass.
// Fail-closed: if the pairs cannot be parsed, exit non-zero.
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
// v9: the app palette pairs (src/app/tokens.ts) are checked with the same rule.
const src =
  readFileSync(join(root, 'src/lib/tokens.ts'), 'utf8') + '\n' + readFileSync(join(root, 'src/app/tokens.ts'), 'utf8')

const pairRe = /\{\s*name:\s*'([^']+)'\s*,\s*fg:\s*'(#[0-9A-Fa-f]{6})'\s*,\s*bg:\s*'(#[0-9A-Fa-f]{6})'\s*\}/g
const pairs = [...src.matchAll(pairRe)].map((m) => ({ name: m[1], fg: m[2], bg: m[3] }))

if (pairs.length < 10) {
  console.error(`FAIL: parsed only ${pairs.length} contrast pairs from src/lib/tokens.ts (expected >= 10).`)
  process.exit(1)
}

function luminance(hex) {
  const c = hex.replace('#', '')
  const rgb = [0, 2, 4].map((i) => {
    const v = parseInt(c.slice(i, i + 2), 16) / 255
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)
  })
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]
}

function ratio(fg, bg) {
  const l1 = luminance(fg)
  const l2 = luminance(bg)
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1]
  return (hi + 0.05) / (lo + 0.05)
}

let failed = 0
for (const p of pairs) {
  const r = ratio(p.fg, p.bg)
  const ok = r >= 4.5
  if (!ok) failed++
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${r.toFixed(2)}:1  ${p.name} (${p.fg} on ${p.bg})`)
}
console.log(`${pairs.length - failed}/${pairs.length} pairs pass WCAG AA (>= 4.5:1).`)
if (failed > 0) process.exit(1)
