// The hero must be on screen on the first frame, before any script has run.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { HERO_H1, HERO_LEAD } from './Hero'

const root = join(__dirname, '..', '..')
const html = readFileSync(join(root, 'index.html'), 'utf8')

describe('hero is visible without scroll or script', () => {
  it('index.html carries the headline, lead and both CTAs as plain HTML', () => {
    const boot = html.slice(html.indexOf('id="po-boot"'), html.indexOf('<div id="root">'))
    for (const line of HERO_H1.split('\n')) expect(boot).toContain(line)
    expect(boot).toContain(HERO_LEAD)
    expect(boot).toContain('href="/app/proof/agent"')
    expect(boot).toContain('href="/app"')
    expect(boot).toContain('href="#how"')
  })

  it('paints a CSS gradient sky with no image, WebGL or opacity-0 start', () => {
    const css = html.slice(html.indexOf('#po-boot{'), html.indexOf('</style>'))
    expect(css).toContain('linear-gradient')
    expect(css).not.toMatch(/opacity:\s*0/)
    expect(css).not.toMatch(/url\(/)
  })

  it('is shown only on the landing path, by an inline script', () => {
    expect(html).toMatch(/location\.pathname==='\/'/)
    expect(html).toMatch(/id="po-boot" hidden/)
  })

  it('the landing hero rises on mount, never on scroll, and the chunk loads eagerly', () => {
    const hero = readFileSync(join(__dirname, 'Hero.tsx'), 'utf8')
    expect(hero).toMatch(/<Rise as="h1"[^>]*\bonLoad\b/)
    const main = readFileSync(join(root, 'src', 'main.tsx'), 'utf8')
    expect(main).toContain("import('./landing/LandingPage')")
  })
})
