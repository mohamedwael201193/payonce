import { spawn } from 'node:child_process'
import { chromium } from 'playwright-core'
const FRONTEND = '/home/hatch/workspace/payonce-build/frontend'
const CHROME = '/home/hatch/.cache/ms-playwright/chromium-1255/chrome-linux64/chrome'
const stub = spawn('node', ['scripts/dev-api-stub.mjs'], { cwd: FRONTEND, stdio: 'ignore' })
const vite = spawn('npx', ['vite', '--port', '5173', '--strictPort'], { cwd: FRONTEND, stdio: 'ignore' })
async function waitPort(url, tries = 40) {
  for (let i = 0; i < tries; i++) { try { const r = await fetch(url); if (r.ok) return true } catch {} await new Promise(r => setTimeout(r, 250)) }
  return false
}
await waitPort('http://127.0.0.1:7401/api/stats'); await waitPort('http://localhost:5173/')
const browser = await chromium.launch({ executablePath: CHROME, headless: true })
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto('http://localhost:5173/', { waitUntil: 'networkidle' })
const m = await page.evaluate(() => {
  const out = {}
  for (const id of ['invoice', 'check', 'pay']) {
    const el = document.getElementById(id)
    if (el) { const r = el.getBoundingClientRect(); out[id] = { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) } }
  }
  const hero = document.querySelector('section[aria-labelledby="hero-title"]')
  out.hero = hero ? Math.round(hero.getBoundingClientRect().height) : null
  // step card inner heights: each StepCard section
  out.stepCards = [...document.querySelectorAll('#invoice section')].map(s => Math.round(s.getBoundingClientRect().height))
  return out
})
console.log(JSON.stringify(m, null, 2))
await browser.close(); stub.kill(); vite.kill(); process.exit(0)
