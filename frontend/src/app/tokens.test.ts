import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PO_CONTRAST_PAIRS, PO_NON_TEXT_PAIRS, PO_TOKENS } from './tokens'

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

const kebab = (k: string) => k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else out.push(p)
  }
  return out
}

describe('app tokens', () => {
  it('every app text pair is WCAG AA (4.5:1)', () => {
    for (const p of PO_CONTRAST_PAIRS) {
      expect(ratio(p.fg, p.bg), `${p.name} ${p.fg} on ${p.bg}`).toBeGreaterThanOrEqual(4.5)
    }
  })

  it('input borders and focus rings clear 3:1 (non-text contrast)', () => {
    for (const p of PO_NON_TEXT_PAIRS) {
      expect(ratio(p.fg, p.bg), `${p.name} ${p.fg} on ${p.bg}`).toBeGreaterThanOrEqual(3)
    }
  })

  it('cards stand out from the ground: white surface on a cool grey paper', () => {
    expect(PO_TOKENS.surface).toBe('#FFFFFF')
    // not the old beige: the ground must be blue-leaning (b >= r) and light
    const [r, , b] = [1, 3, 5].map((i) => parseInt(PO_TOKENS.paper.slice(i, i + 2), 16))
    expect(b).toBeGreaterThanOrEqual(r)
    expect(lum(PO_TOKENS.paper)).toBeGreaterThan(0.88)
  })

  it('tokens.ts mirrors tokens.css exactly', () => {
    const css = readFileSync(join(__dirname, 'tokens.css'), 'utf8')
    for (const [key, hex] of Object.entries(PO_TOKENS)) {
      const m = css.match(new RegExp(`--po-${kebab(key)}:\\s*(#[0-9a-fA-F]{6})\\s*;`))
      expect(m, `--po-${kebab(key)} missing from tokens.css`).not.toBeNull()
      expect(m![1].toLowerCase(), `--po-${kebab(key)}`).toBe(hex.toLowerCase())
    }
  })

  it('no raw colours outside tokens.css in the app shell and its pages', () => {
    const files = [...walk(__dirname)].filter(
      (f) => /\.(tsx?|css)$/.test(f) && !/\.test\./.test(f) && !/tokens\.(ts|css)$/.test(f),
    )
    const raw = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/
    const hits: string[] = []
    for (const f of files) {
      readFileSync(f, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (raw.test(line)) hits.push(`${f.slice(__dirname.length + 1)}:${i + 1}: ${line.trim()}`)
        })
    }
    expect(hits).toEqual([])
  })
})
